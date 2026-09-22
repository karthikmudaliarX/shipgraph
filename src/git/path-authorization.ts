import type { GitRunner } from './service.js';

/**
 * Ticket path scope shared by initial implementation (KAR-12) and pre-PR
 * repair (KAR-10). Both stages must use the exact same grammar and matching
 * behavior so a path cannot be authorized by one boundary and rejected by
 * the other.
 */
export type PathScope = {
  allowedPaths: readonly string[];
  forbiddenPaths: readonly string[];
};

/**
 * The single deterministic path-scope grammar.
 *
 * - `path/to/file` matches that exact repository-relative path only; an
 *   allowed file is never treated as a directory prefix.
 * - `directory/**` matches the directory itself and everything beneath it.
 * - A wildcard anywhere else matches nothing, so unsupported patterns fail
 *   closed rather than silently widening scope.
 */
export function pathInScope(path: string, configuredPath: string): boolean {
  const normalized = configuredPath.replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (normalized.endsWith('/**')) {
    const directory = normalized.slice(0, -3).replace(/\/+$/u, '');
    return directory.length > 0 && (path === directory || path.startsWith(`${directory}/`));
  }
  if (normalized.includes('*')) return false;
  return normalized.length > 0 && path === normalized;
}

export type CommittedChangeInspection =
  | { status: 'authorized'; changedPaths: readonly string[] }
  | { status: 'not-descendant' }
  | { status: 'diff-unavailable'; detail: string }
  | { status: 'forbidden'; path: string }
  | { status: 'outside'; path: string };

/**
 * Deterministically inspect the committed change between an exact base and an
 * exact candidate, then authorize every changed path against the scope.
 *
 * Ancestry and diff inspection failures are reported as distinct non-authorized
 * statuses so callers fail closed rather than treating an unprovable diff as an
 * empty (therefore authorized) change. The candidate SHA is the decision input,
 * so the result is bound to that exact commit.
 */
export async function inspectCommittedChange(
  runner: GitRunner,
  worktreePath: string,
  baseSha: string,
  candidateSha: string,
  scope: PathScope
): Promise<CommittedChangeInspection> {
  const ancestry = await runner(worktreePath, [
    'merge-base',
    '--is-ancestor',
    baseSha,
    candidateSha,
  ]);
  if (ancestry.exitCode !== 0) return { status: 'not-descendant' };

  const changed = await runner(worktreePath, [
    'diff',
    '--no-renames',
    '--name-only',
    '-z',
    baseSha,
    candidateSha,
    '--',
  ]);
  if (changed.exitCode !== 0) {
    return { status: 'diff-unavailable', detail: changed.stderr.trim() || 'git diff failed' };
  }
  const changedPaths = changed.stdout.split('\0').filter((path) => path.length > 0);

  const forbidden = changedPaths.find((path) =>
    scope.forbiddenPaths.some((entry) => pathInScope(path, entry))
  );
  if (forbidden !== undefined) return { status: 'forbidden', path: forbidden };

  if (scope.allowedPaths.length > 0) {
    const outside = changedPaths.find((path) =>
      !scope.allowedPaths.some((entry) => pathInScope(path, entry))
    );
    if (outside !== undefined) return { status: 'outside', path: outside };
  }

  return { status: 'authorized', changedPaths };
}
