import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { validateConfig, type ShipgraphConfig } from './schema.js';
import { assertSafeShipgraphPaths } from '../utils/paths.js';

/**
 * Load and validate shipgraph.yml from the given project directory.
 */
export function loadConfig(projectDir: string): ShipgraphConfig {
  const paths = assertSafeShipgraphPaths(projectDir);
  const raw = readFileSync(paths.configPath, 'utf-8');
  const parsed = YAML.parse(raw);
  return validateConfig(parsed);
}

/**
 * Parse a raw config string (useful for tests).
 */
export function parseConfig(raw: string): ShipgraphConfig {
  const parsed = YAML.parse(raw);
  return validateConfig(parsed);
}
