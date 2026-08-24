import { lstatSync, realpathSync } from 'node:fs';
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
 */
export function assertSafeBacklogPath(
  projectDir: string,
  candidate?: string
): string {
  const canonicalProjectDir = realpathSync(projectDir);
  const path = resolve(canonicalProjectDir, candidate ?? 'shipgraph.backlog.yml');
  assertWithinProject(canonicalProjectDir, path);
  if (tryLstat(path)?.isSymbolicLink()) {
    throw new Error(`Refusing to use symbolic link for ShipGraph path: ${path}`);
  }
  const stats = tryLstat(path);
  if (stats) {
    assertWithinProject(canonicalProjectDir, realpathSync(path));
    if (!stats.isFile() || stats.nlink !== 1) {
      throw new Error(`ShipGraph backlog must be a regular, unlinked file: ${path}`);
    }
  }
  assertExistingPathConfinement(canonicalProjectDir, path);
  return path;
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
  const pathFromProject = relative(projectDir, candidate);
  if (pathFromProject === '..' || pathFromProject.startsWith(`..${sep}`) || isAbsolute(pathFromProject)) {
    throw new Error(`ShipGraph path escapes the project directory: ${candidate}`);
  }
}

function tryLstat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
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
