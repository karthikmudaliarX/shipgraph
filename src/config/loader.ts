import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { validateConfig, type ShipgraphConfig } from './schema.js';

/**
 * Load and validate shipgraph.yml from the given project directory.
 */
export function loadConfig(projectDir: string): ShipgraphConfig {
  const configPath = resolve(projectDir, 'shipgraph.yml');
  const raw = readFileSync(configPath, 'utf-8');
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
