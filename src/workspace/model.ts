import { basename, join, relative, sep } from 'node:path';
import { lstatSync, mkdirSync } from 'node:fs';
import type { WorkspaceStatus } from '../persistence/repositories.js';

export const WORKSPACE_STATUSES: readonly WorkspaceStatus[] = [
  'CREATING',
  'READY',
  'REMOVED',
  'FAILED',
  'NEEDS_HUMAN',
];

/**
 * Ticket IDs are strict identifiers. They must never be able to influence
 * filesystem traversal: no separators, no leading dots, bounded length.
 */
const TICKET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Project IDs are ShipGraph-generated UUIDs. */
const PROJECT_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function assertSafeTicketId(ticketId: string): string {
  if (!TICKET_ID_PATTERN.test(ticketId)) {
    throw new Error(
      `Invalid ticket id "${ticketId}": must match ${TICKET_ID_PATTERN.source} (no path traversal)`
    );
  }
  return ticketId;
}

function assertSafeProjectId(projectId: string): string {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error(`Invalid project id: refusing to derive a workspace path`);
  }
  return projectId;
}

/**
 * Deterministic dedicated branch name derived from the ticket id.
 * The result is additionally validated with `git check-ref-format --branch`
 * by the workspace service before any Git command runs.
 */
export function deriveBranchName(ticketId: string): string {
  assertSafeTicketId(ticketId);
  const slug = ticketId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  if (slug.length === 0) {
    throw new Error(`Cannot derive a safe branch name from ticket id "${ticketId}"`);
  }
  return `shipgraph/${slug}`;
}

/**
 * Deterministic ShipGraph-owned worktree path:
 *   <root>/<project-id>/<ticket-id>
 *
 * Both segments are strictly validated so a hostile identifier can never
 * escape the worktree root.
 */
export function deriveWorktreePath(root: string, projectId: string, ticketId: string): string {
  assertSafeProjectId(projectId);
  assertSafeTicketId(ticketId);
  const path = join(root, projectId, ticketId);
  const pathFromRoot = relative(root, path);
  if (pathFromRoot.startsWith('..') || pathFromRoot === '') {
    throw new Error(`Workspace path escapes the ShipGraph worktree root: ${path}`);
  }
  return path;
}

/**
 * Create or verify a ShipGraph-owned directory chain without ever following
 * symlinks. Every segment is validated to be a bare name (no separators, no
 * traversal) and every resulting component is checked with lstat: symlinks
 * and non-directories fail closed. Missing components are created with
 * restrictive permissions.
 */
export function ensureOwnedDirectoryChain(base: string, ...segments: readonly string[]): string {
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment !== basename(segment) ||
      segment === '.' ||
      segment === '..' ||
      segment.includes(sep)
    ) {
      throw new Error(`Invalid ShipGraph workspace path segment: "${segment}"`);
    }
  }
  let current = base;
  for (const segment of segments) {
    current = join(current, segment);
    const stats = tryLstatSync(current);
    if (stats) {
      if (stats.isSymbolicLink()) {
        throw new Error(`Refusing to use symbolic link for ShipGraph workspace path: ${current}`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`ShipGraph workspace path component is not a directory: ${current}`);
      }
    } else {
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        // Another ShipGraph process may have created this exact component
        // after our lstat. Revalidate the winner instead of leaking EEXIST,
        // while still rejecting a raced symlink or non-directory.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const raced = tryLstatSync(current);
        if (!raced) throw error;
        if (raced.isSymbolicLink()) {
          throw new Error(`Refusing to use symbolic link for ShipGraph workspace path: ${current}`);
        }
        if (!raced.isDirectory()) {
          throw new Error(`ShipGraph workspace path component is not a directory: ${current}`);
        }
      }
    }
  }
  return current;
}

export function tryLstatSync(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
