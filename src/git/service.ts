import { lstatSync, realpathSync } from 'node:fs';
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

/**
 * Stable local identity for the Git repository that owns a worktree.
 *
 * Paths alone are insufficient: a repository can be replaced or redirected
 * while its project directory keeps the same name. The directory device/inode
 * pairs bind the identity to the Git storage currently on disk as well.
 */
export type GitRepositoryIdentity = {
  sourceDirectoryDevice: string;
  sourceDirectoryInode: string;
  commonDir: string;
  objectDir: string;
  commonDirDevice: string;
  commonDirInode: string;
  objectDirDevice: string;
  objectDirInode: string;
};

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

/** Resolve the Git common directory and primary object database identity. */
export async function resolveGitRepositoryIdentity(
  runner: GitRunner,
  repoPath: string
): Promise<GitRepositoryIdentity> {
  const sourceDirectory = inspectDirectory(repoPath, 'source directory');
  const common = await resolveGitDirectory(runner, repoPath, ['--git-common-dir'], 'common directory');
  const objects = await resolveGitDirectory(
    runner,
    repoPath,
    ['--git-path', 'objects'],
    'object database'
  );
  return {
    sourceDirectoryDevice: sourceDirectory.device,
    sourceDirectoryInode: sourceDirectory.inode,
    commonDir: common.path,
    objectDir: objects.path,
    commonDirDevice: common.device,
    commonDirInode: common.inode,
    objectDirDevice: objects.device,
    objectDirInode: objects.inode,
  };
}

export function sameGitRepositoryIdentity(
  left: GitRepositoryIdentity,
  right: GitRepositoryIdentity
): boolean {
  return (
    left.sourceDirectoryDevice === right.sourceDirectoryDevice &&
    left.sourceDirectoryInode === right.sourceDirectoryInode &&
    left.commonDir === right.commonDir &&
    left.objectDir === right.objectDir &&
    left.commonDirDevice === right.commonDirDevice &&
    left.commonDirInode === right.commonDirInode &&
    left.objectDirDevice === right.objectDirDevice &&
    left.objectDirInode === right.objectDirInode
  );
}

async function resolveGitDirectory(
  runner: GitRunner,
  repoPath: string,
  args: readonly string[],
  label: string
): Promise<{ path: string; device: string; inode: string }> {
  const result = await runGit(runner, repoPath, [
    'rev-parse',
    '--path-format=absolute',
    ...args,
  ]);
  const rawPath = result.stdout.trim();
  if (result.exitCode !== 0 || rawPath.length === 0 || rawPath.includes('\n')) {
    throw new Error(`Could not resolve Git ${label} for ${repoPath}`);
  }
  try {
    const path = realpathSync(rawPath);
    return { path, ...inspectDirectory(path, label) };
  } catch (error) {
    throw new Error(
      `Could not inspect Git ${label} at ${rawPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function inspectDirectory(path: string, label: string): {
  device: string;
  inode: string;
} {
  const stats = lstatSync(realpathSync(path), { bigint: true });
  if (!stats.isDirectory()) throw new Error(`${label} is not a directory`);
  return { device: stats.dev.toString(), inode: stats.ino.toString() };
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

/** Resolve a configured remote URL without invoking a shell. */
export async function resolveGitRemoteUrl(
  runner: GitRunner,
  repoPath: string,
  remote = 'origin',
  push = false
): Promise<string> {
  const result = await runGit(runner, repoPath, [
    'remote',
    'get-url',
    ...(push ? ['--push'] : []),
    remote,
  ]);
  const url = result.stdout.trim();
  if (result.exitCode !== 0 || url.length === 0 || url.includes('\n')) {
    throw new Error(`Could not resolve Git ${push ? 'push' : 'fetch'} remote ${remote}`);
  }
  return url;
}

/** Return the exact remote branch object name, or undefined when absent. */
export async function resolveRemoteBranchSha(
  runner: GitRunner,
  repoPath: string,
  remote: string,
  branchName: string
): Promise<string | undefined> {
  if (!(await isBranchNameValid(runner, repoPath, branchName))) {
    throw new Error(`Invalid branch name: ${branchName}`);
  }
  const result = await runGit(runner, repoPath, [
    'ls-remote',
    '--heads',
    remote,
    `refs/heads/${branchName}`,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Could not inspect remote branch ${branchName}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  const lines = result.stdout.trim() === '' ? [] : result.stdout.trim().split(/\r?\n/u);
  if (lines.length === 0) return undefined;
  if (lines.length !== 1) throw new Error(`Remote branch ${branchName} returned an ambiguous ref result`);
  const [sha, ref] = lines[0].trim().split(/\s+/u);
  if (
    ref !== `refs/heads/${branchName}` ||
    sha === undefined ||
    !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u.test(sha)
  ) {
    throw new Error(`Remote branch ${branchName} returned an unsupported ref result`);
  }
  return sha;
}

/** Push one exact commit to one branch; force updates are intentionally impossible. */
export async function pushExactCommit(
  runner: GitRunner,
  repoPath: string,
  remote: string,
  commitSha: string,
  branchName: string
): Promise<void> {
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u.test(commitSha)) {
    throw new Error(`Cannot push an invalid commit SHA: ${commitSha}`);
  }
  if (!(await isBranchNameValid(runner, repoPath, branchName))) {
    throw new Error(`Invalid branch name: ${branchName}`);
  }
  const result = await runGit(runner, repoPath, [
    'push',
    remote,
    `${commitSha}:refs/heads/${branchName}`,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Exact branch push failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

/** Prove that a live worktree commit descends from the recorded base commit. */
export async function isCommitAncestor(
  runner: GitRunner,
  repoPath: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  if (!isObjectName(ancestor) || !isObjectName(descendant)) return false;
  const result = await runGit(runner, repoPath, [
    'merge-base',
    '--is-ancestor',
    ancestor,
    descendant,
  ]);
  return result.exitCode === 0;
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

export type WorktreeLiveState = {
  head?: string;
  branch?: string;
  clean?: boolean;
  /** False when Git could not prove the working-tree/index status. */
  statusKnown?: boolean;
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
    statusKnown: status.exitCode === 0 && ambiguousFlags !== undefined,
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

function isObjectName(value: string): boolean {
  return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(value);
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
  if (status.stdout.trim() !== '' || ambiguousFlags) return false;
  // Git does not report empty untracked directories via status; a clean -n
  // dry run catches them (and anything else removal would destroy).
  const cleanDryRun = await runGit(runner, worktreePath, ['clean', '-ndx']);
  if (cleanDryRun.exitCode !== 0) return false;
  return cleanDryRun.stdout.trim() === '';
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
