import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Compute ShipGraph metadata paths for a target project.
 */
export function getShipgraphPaths(projectDir: string) {
  const canonicalProjectDir = realpathSync(projectDir);
  const globalDir = resolve(homedir(), '.shipgraph');
  const configPath = resolve(canonicalProjectDir, 'shipgraph.yml');
  const stateDir = resolve(canonicalProjectDir, '.shipgraph');
  const dbPath = resolve(stateDir, 'shipgraph.db');

  return {
    globalDir,
    configPath,
    stateDir,
    dbPath,
  };
}

/** Reject repository-controlled symlinks before reading or writing state. */
export function assertSafeShipgraphPaths(projectDir: string): ReturnType<typeof getShipgraphPaths> {
  const canonicalProjectDir = realpathSync(projectDir);
  const paths = getShipgraphPaths(canonicalProjectDir);

  for (const path of [paths.configPath, paths.stateDir, paths.dbPath]) {
    assertWithinProject(canonicalProjectDir, path);
    if (tryLstat(path)?.isSymbolicLink()) {
      throw new Error(`Refusing to use symbolic link for ShipGraph path: ${path}`);
    }
  }

  const stateStats = tryLstat(paths.stateDir);
  if (stateStats && !stateStats.isDirectory()) {
    throw new Error(`ShipGraph state path is not a directory: ${paths.stateDir}`);
  }
  if (stateStats) assertWithinProject(canonicalProjectDir, realpathSync(paths.stateDir));

  return paths;
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
