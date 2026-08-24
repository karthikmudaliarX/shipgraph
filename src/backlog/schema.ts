import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import {
  ticketDefinitionSchema,
  type TicketDefinition,
} from '../domain/ticket.js';
import { validateDependencyGraph } from '../domain/dependency-graph.js';
import { compareStableStrings } from '../utils/sorting.js';
import { isWithinProject } from '../utils/paths.js';

export const SUPPORTED_BACKLOG_MAJOR_VERSIONS = [1] as const;

const backlogVersionSchema = z.number().int().positive();

/** Strict static contract for shipgraph.backlog.yml. */
export const backlogSchema = z
  .object({
    version: backlogVersionSchema,
    tickets: z.array(ticketDefinitionSchema),
  })
  .strict();

export type ApprovedBacklog = {
  version: 1;
  tickets: readonly TicketDefinition[];
};

/**
 * Parse and validate the entire approved backlog, including its dependency DAG.
 * This function is pure: it performs no filesystem or database mutation.
 */
export function validateBacklog(value: unknown): ApprovedBacklog {
  const parsed = backlogSchema.parse(value);
  if (
    !(SUPPORTED_BACKLOG_MAJOR_VERSIONS as readonly number[]).includes(parsed.version)
  ) {
    throw new Error(
      `Unsupported shipgraph.backlog.yml major version: ${parsed.version}. ` +
        `Supported versions: ${SUPPORTED_BACKLOG_MAJOR_VERSIONS.join(', ')}.`
    );
  }

  const ids = new Set<string>();
  for (const ticket of parsed.tickets) {
    if (ids.has(ticket.id)) {
      throw new Error(`Backlog contains duplicate ticket ID: ${ticket.id}`);
    }
    ids.add(ticket.id);
  }

  const edges = parsed.tickets.flatMap((ticket) =>
    ticket.dependsOn.map((dependsOnTicketId) => ({
      ticketId: ticket.id,
      dependsOnTicketId,
    }))
  );
  validateDependencyGraph(ids, edges);

  // Dependency order and YAML ticket order are presentation details. Canonical
  // ordering keeps persistence, hashing and repeat syncs deterministic.
  const tickets = [...parsed.tickets]
    .map((ticket) => ({
      ...ticket,
      dependsOn: [...ticket.dependsOn].sort(compareStableStrings),
    }))
    .sort((first, second) => compareStableStrings(first.id, second.id));

  return { version: 1, tickets };
}

export function parseBacklog(raw: string): ApprovedBacklog {
  return validateBacklog(YAML.parse(raw));
}

export function loadBacklog(
  projectDir: string,
  path: string,
  validatedIdentity: { dev: number; ino: number }
): ApprovedBacklog {
  // Re-verify confinement at consumption time: a validated inode that has
  // been relocated outside the project (or reached through a swapped parent)
  // must never be parsed.
  const canonicalProjectDir = realpathSync(projectDir);
  const resolvedPath = realpathSync(path);
  if (!isWithinProject(canonicalProjectDir, resolvedPath)) {
    throw new Error(`ShipGraph backlog escapes the project directory: ${path}`);
  }

  const fileDescriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(fileDescriptor);
    if (!stats.isFile() || stats.nlink !== 1) {
      throw new Error(`ShipGraph backlog must be a regular, unlinked file: ${path}`);
    }
    if (
      Number(stats.dev) !== validatedIdentity.dev ||
      Number(stats.ino) !== validatedIdentity.ino
    ) {
      throw new Error(`ShipGraph backlog changed between validation and read: ${path}`);
    }
    return parseBacklog(readFileSync(fileDescriptor, 'utf8'));
  } finally {
    closeSync(fileDescriptor);
  }
}
