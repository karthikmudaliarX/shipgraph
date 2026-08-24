import { realpathSync } from 'node:fs';
import { execa } from 'execa';

/**
 * Narrow Git command boundary for WORK-001.
 *
 * Only deterministic repository/worktree management commands live here.
 * No agent logic, no remote synchronization (no fetch/pull/push), and no
 * destructive operations against the user's normal checkout.
 *
 * Commands are isolated from the surrounding process:
 * - GIT_DIR/GIT_WORK_TREE and related environment overrides are stripped so
 *   the explicit cwd always decides which repository is addressed.
 * - Repository hooks are disabled: ShipGraph management commands must stay
 *   deterministic and must never let a post-checkout hook mutate anything.
 */

export type GitCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type GitRunner = (
  cwd: string,
  args: readonly string[]
) => Promise<GitCommandResult>;

const GIT_TIMEOUT_MS = 30_000;

/**
 * Environment variables that could redirect or observe git behavior and are
 * therefore never inherited. GIT_* variables are stripped wholesale; this
 * denylist additionally covers non-GIT-prefixed process-observation knobs.
 */
const GIT_ENV_OVERRIDES = [
  'XDG_CONFIG_HOME',
  'HOME',
] as const;

function sanitizedEnv(): NodeJS.ProcessEnv {
  // Strip EVERY inherited GIT_* variable: only the explicit cwd decides which
  // repository is addressed, and no trace/config/worktree redirection may
  // survive. Then pin deterministic behavior on top.
  const env: Record<string, string> = {
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_FSMONITOR_DAEMON: '',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      !key.startsWith('GIT_') &&
      !GIT_ENV_OVERRIDES.includes(key as never)
    ) {
      env[key] = value;
    }
  }
  return env;
}

export function createGitRunner(): GitRunner {
  return async (cwd, args) => {
    const result = await execa(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        ...args,
      ],
      {
        cwd,
        reject: false,
        cleanup: true,
        timeout: GIT_TIMEOUT_MS,
        env: sanitizedEnv(),
      }
    );
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };
}

async function runGit(
  runner: GitRunner,
  cwd: string,
  args: readonly string[]
): Promise<GitCommandResult> {
  return runner(cwd, args);
}

/** True when the path is inside a git repository work tree. */
export async function isInsideWorkTree(
  runner: GitRunner,
  cwd: string
): Promise<boolean> {
  const result = await runGit(runner, cwd, ['rev-parse', '--is-inside-work-tree']);
  return result.exitCode === 0 && result.stdout.trim() === 'true';
}

/** Resolve the absolute top-level working directory of the containing repo. */
export async function gitTopLevel(runner: GitRunner, cwd: string): Promise<string | undefined> {
  const result = await runGit(runner, cwd, ['rev-parse', '--show-toplevel']);
  if (result.exitCode !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

/** Resolve an exact commit SHA for a local ref, or undefined when absent. */
export async function resolveCommitSha(
  runner: GitRunner,
  repoPath: string,
  ref: string
): Promise<string | undefined> {
  const result = await runGit(runner, repoPath, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${ref}^{commit}`,
  ]);
  if (result.exitCode !== 0) return undefined;
  const sha = result.stdout.trim();
  // Accept SHA-1 (40) and SHA-256 (64) object names.
  return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(sha) ? sha : undefined;
}

/** Validate a branch name using Git's own reference rules. */
export async function isBranchNameValid(
  runner: GitRunner,
  repoPath: string,
  branchName: string
): Promise<boolean> {
  const result = await runGit(runner, repoPath, ['check-ref-format', '--branch', branchName]);
  return result.exitCode === 0;
}

export type WorktreeEntry = {
  path: string;
  head?: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
};

/** Parse `git worktree list --porcelain` output. */
export async function listWorktrees(
  runner: GitRunner,
  repoPath: string
): Promise<readonly WorktreeEntry[]> {
  const result = await runGit(runner, repoPath, ['worktree', 'list', '--porcelain']);
  if (result.exitCode !== 0) {
    throw new Error(`git worktree list failed: ${result.stderr.trim()}`);
  }
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> & { bare?: boolean; detached?: boolean } = {};
  const flush = (): void => {
    if (current.path !== undefined) {
      entries.push({
        path: current.path,
        head: current.head,
        branch: current.branch,
        bare: current.bare ?? false,
        detached: current.detached ?? false,
      });
    }
    current = {};
  };
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      current.path = line.slice('worktree '.length);
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'detached') {
      current.detached = true;
    }
  }
  flush();
  return entries;
}

/**
 * Create an isolated worktree on a NEW dedicated branch at an exact base SHA.
 *
 * Refuses when the branch already exists (-b fails closed), so a pre-existing
 * branch can never be silently reused or reset.
 */
export async function addWorktreeWithNewBranch(
  runner: GitRunner,
  repoPath: string,
  worktreePath: string,
  branchName: string,
  baseSha: string
): Promise<void> {
  const result = await runGit(runner, repoPath, [
    'worktree',
    'add',
    '-b',
    branchName,
    worktreePath,
    baseSha,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`git worktree add failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

/** Remove a registered worktree. Git itself refuses dirty worktrees. */
export async function removeWorktree(
  runner: GitRunner,
  repoPath: string,
  worktreePath: string
): Promise<void> {
  const result = await runGit(runner, repoPath, ['worktree', 'remove', worktreePath]);
  if (result.exitCode !== 0) {
    throw new Error(
      `git worktree remove refused: ${result.stderr.trim() || result.stdout.trim()}`
    );
  }
}

/** Delete a local branch by exact name. Never uses force. */
export async function deleteBranch(
  runner: GitRunner,
  repoPath: string,
  branchName: string
): Promise<boolean> {
  const result = await runGit(runner, repoPath, ['branch', '-d', branchName]);
  return result.exitCode === 0;
}

/**
 * Atomically delete a branch ONLY while it still points at the expected SHA
 * (`git update-ref -d --no-deref <ref> <old-oid>` is a kernel-side
 * compare-and-delete). --no-deref guarantees a symbolic ref can never pull
 * another branch into the deletion. If the ref moved, the deletion fails and
 * the branch is retained.
 */
export async function deleteBranchIfAt(
  runner: GitRunner,
  repoPath: string,
  branchName: string,
  expectedSha: string
): Promise<boolean> {
  const result = await runGit(runner, repoPath, [
    'update-ref',
    '-d',
    '--no-deref',
    `refs/heads/${branchName}`,
    expectedSha,
  ]);
  return result.exitCode === 0;
}

export type WorktreeLiveState = {
  head?: string;
  branch?: string;
  clean?: boolean;
  registered: boolean;
};

/** Inspect the live state of one recorded worktree without mutating anything.
 * Returns registered=false when the path is not a registered worktree of the
 * expected repository.
 */
export async function inspectWorktreeState(
  runner: GitRunner,
  repoPath: string,
  expectedPath: string
): Promise<WorktreeLiveState> {
  const worktrees = await listWorktrees(runner, repoPath);
  const entry = worktrees.find((candidate) => candidate.path === expectedPath);
  if (!entry) {
    return { registered: false };
  }
  // Bind the directory to the expected repository: its resolved git common
  // dir must equal the source repository's. A swapped .git file pointing at
  // another repository fails closed here.
  const worktreeCommonDir = await runGit(runner, expectedPath, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  const sourceCommonDir = await runGit(runner, repoPath, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  const sameRepository =
    worktreeCommonDir.exitCode === 0 &&
    sourceCommonDir.exitCode === 0 &&
    realpathSyncSafe(worktreeCommonDir.stdout.trim()) ===
      realpathSyncSafe(sourceCommonDir.stdout.trim());
  if (!sameRepository) {
    return { registered: false };
  }
  // The commands below must be inspecting the recorded directory itself:
  // a per-worktree core.worktree redirect would otherwise report on some
  // other clean directory while the recorded path holds user files.
  const toplevel = await runGit(runner, expectedPath, [
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
  ]);
  if (
    toplevel.exitCode !== 0 ||
    realpathSyncSafe(toplevel.stdout.trim()) !== realpathSyncSafe(expectedPath)
  ) {
    return { registered: false };
  }
  const status = await runGit(runner, expectedPath, [
    '-c',
    'status.showUntrackedFiles=all',
    'status',
    '--porcelain',
    '--untracked-files=all',
    '--ignore-submodules=none',
  ]);
  const ambiguousFlags = await hasAmbiguousIndexFlags(runner, expectedPath);
  const symbolicRef = await runGit(runner, expectedPath, [
    'symbolic-ref',
    '--short',
    'HEAD',
  ]);
  return {
    head: entry.head,
    branch:
      symbolicRef.exitCode === 0 ? `refs/heads/${symbolicRef.stdout.trim()}` : undefined,
    // Fail closed: unknown index-flag state (undefined) counts as not clean.
    clean:
      status.exitCode === 0 &&
      status.stdout.trim() === '' &&
      ambiguousFlags === false,
    registered: true,
  };
}

function realpathSyncSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Detect gitlink (submodule, mode 160000) index entries: their nested
 * contents are outside the superproject's cleanliness proof.
 */
export async function hasGitlinkEntries(
  runner: GitRunner,
  worktreePath: string
): Promise<boolean> {
  const result = await runGit(runner, worktreePath, ['ls-files', '-s']);
  if (result.exitCode !== 0) return true; // fail closed
  return result.stdout
    .split('\n')
    .some((line) => line.trimStart().startsWith('160000'));
}

/**
 * List registered worktrees of the source repository that use the given
 * branch, excluding the recorded path itself. A non-empty result means the
 * branch is checked out somewhere else and must never be deleted.
 */
export async function findOtherWorktreesUsingBranch(
  runner: GitRunner,
  repoPath: string,
  branchName: string,
  excludePath: string
): Promise<readonly string[]> {
  const entries = await listWorktrees(runner, repoPath);
  const expected = `refs/heads/${branchName}`;
  return entries
    .filter((entry) => entry.path !== excludePath && entry.branch === expected)
    .map((entry) => entry.path);
}

/**
 * Strict cleanliness for destructive operations: untracked and ignored files
 * are surfaced (defeating status.showUntrackedFiles=no), and any inspection
 * error counts as NOT strictly clean.
 */
export async function isStrictlyClean(
  runner: GitRunner,
  worktreePath: string
): Promise<boolean> {
  const status = await runGit(
    runner,
    worktreePath,
    [
      '-c',
      'status.showUntrackedFiles=all',
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--ignored',
      '--ignore-submodules=none',
    ]
  );
  if (status.exitCode !== 0) return false;
  const ambiguousFlags = await hasAmbiguousIndexFlags(runner, worktreePath);
  if (ambiguousFlags === undefined) return false;
  return status.stdout.trim() === '' && !ambiguousFlags;
}

/**
 * Detect tracked files that hide modifications from status
 * (assume-unchanged / skip-worktree markers) AND gitlink entries
 * (submodules, mode 160000). Both make a worktree unsafe to delete.
 * Returns undefined when inspection fails.
 */
async function hasAmbiguousIndexFlags(
  runner: GitRunner,
  worktreePath: string
): Promise<boolean | undefined> {
  const tagged = await runGit(runner, worktreePath, ['ls-files', '-v']);
  if (tagged.exitCode !== 0) return undefined;
  // Lowercase flag letters mark assume-unchanged variants and uppercase
  // 'S' marks skip-worktree; all of them hide modifications from
  // `git status`.
  const hiddenModification = tagged.stdout
    .split('\n')
    .some(
      (line) =>
        line.length > 0 &&
        ((line[0] >= 'a' && line[0] <= 'z') || line[0] === 'S')
    );

  const staged = await runGit(runner, worktreePath, ['ls-files', '-s']);
  if (staged.exitCode !== 0) return undefined;
  // Gitlink entries (submodules) have index mode 160000; their nested
  // contents are outside every superproject cleanliness proof.
  const hasSubmodule = staged.stdout
    .split('\n')
    .some((line) => line.startsWith('160000 '));

  return hiddenModification || hasSubmodule;
}
