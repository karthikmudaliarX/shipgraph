import { lstatSync, readlinkSync, realpathSync, type BigIntStats } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Compute ShipGraph metadata paths for a target project.
 */
export function getShipgraphPaths(projectDir: string) {
  const canonicalProjectDir = realpathSync(projectDir);
  const globalDir = resolve(homedir(), '.shipgraph');
  const configPath = resolve(canonicalProjectDir, 'shipgraph.yml');
  const backlogPath = resolve(canonicalProjectDir, 'shipgraph.backlog.yml');
  const stateDir = resolve(canonicalProjectDir, '.shipgraph');
  const dbPath = resolve(stateDir, 'shipgraph.db');

  return {
    globalDir,
    configPath,
    backlogPath,
    stateDir,
    dbPath,
  };
}

/**
 * Validate only resources on the common ShipGraph project/state boundary:
 * configuration, state directory, database, and its sidecars.
 *
 * Backlog files are NOT validated here. Backlog safety belongs exclusively
 * to assertSafeBacklogPath(), invoked by commands that actually consume a
 * backlog file. An unused shipgraph.backlog.yml must never block unrelated
 * commands such as `status`, `ready`, or `init`.
 */
export function assertSafeShipgraphPaths(projectDir: string): ReturnType<typeof getShipgraphPaths> {
  const canonicalProjectDir = realpathSync(projectDir);
  const paths = getShipgraphPaths(canonicalProjectDir);

  for (const path of [paths.configPath, paths.stateDir, paths.dbPath]) {
    assertWithinProject(canonicalProjectDir, path);
    if (tryLstat(path)?.isSymbolicLink()) {
      throw new Error(`Refusing to use symbolic link for ShipGraph path: ${path}`);
    }
    assertExistingPathConfinement(canonicalProjectDir, path);
  }

  const stateStats = tryLstat(paths.stateDir);
  if (stateStats && !stateStats.isDirectory()) {
    throw new Error(`ShipGraph state path is not a directory: ${paths.stateDir}`);
  }
  if (stateStats) assertWithinProject(canonicalProjectDir, realpathSync(paths.stateDir));
  if (tryLstat(paths.dbPath)) {
    assertSafeDatabaseFile(paths.dbPath);
    for (const sidecarPath of [
      `${paths.dbPath}-wal`,
      `${paths.dbPath}-shm`,
      `${paths.dbPath}-journal`,
    ]) {
      const sidecarStats = tryLstat(sidecarPath);
      if (!sidecarStats) continue;
      if (sidecarStats.isSymbolicLink()) {
        throw new Error(`Refusing to use symbolic link for ShipGraph database sidecar: ${sidecarPath}`);
      }
      assertWithinProject(canonicalProjectDir, realpathSync(sidecarPath));
      if (!sidecarStats.isFile() || sidecarStats.nlink !== 1) {
        throw new Error(`ShipGraph database sidecar must be a regular, unlinked file: ${sidecarPath}`);
      }
      if (process.getuid !== undefined && sidecarStats.uid !== process.getuid()) {
        throw new Error(`ShipGraph database sidecar must be owned by the current user: ${sidecarPath}`);
      }
    }
  }

  return paths;
}

/**
 * Validate the exact backlog resource a command consumes (default
 * shipgraph.backlog.yml or an explicit --file candidate). Only commands that
 * read or write a backlog file may call this.
 *
 * The backlog must already exist as a regular, unlinked in-project file so a
 * non-optional on-disk identity can be captured at validation time. Consumers
 * must pass that identity (and re-verify confinement) when opening the file,
 * so the descriptor they read is provably the resource that was validated.
 */
export function assertSafeBacklogPath(
  projectDir: string,
  candidate?: string
): { path: string; identity: { dev: bigint; ino: bigint } } {
  const canonicalProjectDir = realpathSync(projectDir);
  const path = resolve(canonicalProjectDir, candidate ?? 'shipgraph.backlog.yml');
  assertWithinProject(canonicalProjectDir, path);
  if (tryLstat(path)?.isSymbolicLink()) {
    throw new Error(`Refusing to use symbolic link for ShipGraph path: ${path}`);
  }
  // Bigint stats keep dev/ino exact on filesystems whose identifiers exceed
  // JavaScript's safe integer range.
  const stats = tryBigLstat(path);
  if (!stats) {
    throw new Error(`Approved backlog file not found: ${path}`);
  }
  assertWithinProject(canonicalProjectDir, realpathSync(path));
  if (!stats.isFile() || stats.nlink !== 1n) {
    throw new Error(`ShipGraph backlog must be a regular, unlinked file: ${path}`);
  }
  const identity = { dev: stats.dev, ino: stats.ino };
  assertExistingPathConfinement(canonicalProjectDir, path);
  return { path, identity };
}

/**
 * Verify confinement of an already-open descriptor via /proc (Linux).
 *
 * This binds the confinement check to the descriptor actually consumed,
 * closing a parent-directory swap between a pre-open realpath check and
 * openSync. On platforms without procfs the pre-open realpath and inode
 * identity checks remain the strongest available binding.
 */
export function assertOpenFileWithinProject(fd: number, canonicalProjectDir: string): void {
  let fdPath: string;
  try {
    fdPath = readlinkSync(`/proc/self/fd/${fd}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!isWithinProject(canonicalProjectDir, fdPath)) {
    throw new Error(`ShipGraph backlog escapes the project directory: ${fdPath}`);
  }
}

/** Reject writable database paths that can alias another inode or user. */
export function assertSafeDatabaseFile(path: string): void {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.nlink !== 1) {
    throw new Error(`ShipGraph database must be a regular, unlinked file: ${path}`);
  }
  if (process.getuid !== undefined && stats.uid !== process.getuid()) {
    throw new Error(`ShipGraph database must be owned by the current user: ${path}`);
  }
}

function assertWithinProject(projectDir: string, candidate: string): void {
  if (!isWithinProject(projectDir, candidate)) {
    throw new Error(`ShipGraph path escapes the project directory: ${candidate}`);
  }
}

/** True when candidate resolves lexically inside projectDir. */
export function isWithinProject(projectDir: string, candidate: string): boolean {
  const pathFromProject = relative(projectDir, candidate);
  return !(
    pathFromProject === '..' ||
    pathFromProject.startsWith(`..${sep}`) ||
    isAbsolute(pathFromProject)
  );
}

function tryLstat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function tryBigLstat(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertExistingPathConfinement(projectDir: string, path: string): void {
  let current = path;
  while (true) {
    const stats = tryLstat(current);
    if (stats) {
      if (stats.isSymbolicLink()) {
        throw new Error(`Refusing to use symbolic link for ShipGraph path: ${current}`);
      }
      assertWithinProject(projectDir, realpathSync(current));
      return;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
