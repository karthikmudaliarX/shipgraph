import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Compute ShipGraph metadata paths for a target project.
 */
export function getShipgraphPaths(projectDir: string) {
  const globalDir = resolve(homedir(), '.shipgraph');
  const configPath = resolve(projectDir, 'shipgraph.yml');
  const stateDir = resolve(projectDir, '.shipgraph');
  const dbPath = resolve(stateDir, 'shipgraph.db');

  return {
    globalDir,
    configPath,
    stateDir,
    dbPath,
  };
}
