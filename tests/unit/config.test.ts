import { describe, it, expect } from 'vitest';
import { parseConfig } from '../../src/config/loader.js';
import { validateConfig } from '../../src/config/schema.js';

describe('config validation', () => {
  it('accepts a valid config', () => {
    const raw = `
version: 1
project:
  name: example
  repository: owner/repo
  defaultBranch: main
execution:
  maxConcurrentTickets: 2
  maxRepairIterations: 3
release:
  requireHumanApproval: true
  requireCleanCI: true
  requireExactShaReviews: true
agents:
  implementer: codex
  reviewers:
    - correctness
    - adversarial
`;
    const config = parseConfig(raw);
    expect(config.version).toBe(1);
    expect(config.project.name).toBe('example');
    expect(config.execution.maxConcurrentTickets).toBe(2);
    expect(config.agents.implementer).toBe('codex');
    expect(config.agents.reviewers).toEqual(['correctness', 'adversarial']);
  });

  it('applies defaults for optional sections', () => {
    const raw = `
version: 1
project:
  name: minimal
  repository: owner/repo
`;
    const config = parseConfig(raw);
    expect(config.project.defaultBranch).toBe('main');
    expect(config.execution.maxConcurrentTickets).toBe(1);
    expect(config.execution.maxRepairIterations).toBe(6);
    expect(config.release.requireHumanApproval).toBe(true);
    expect(config.agents.implementer).toBe('opencode');
    expect(config.routing?.mode).toBeUndefined();
  });

  it('accepts routing mode and provider catalog configuration without model names', () => {
    const config = parseConfig(`
version: 1
project:
  name: providers
  repository: owner/providers
routing:
  mode: eco
providers:
  opencodeGo:
    executable: /usr/local/bin/opencode
    catalogArgs:
      - models
    authArgs:
      - auth
      - list
    authenticatedOutputTokens:
      - OpenCode Go
`);

    expect(config.routing?.mode).toBe('eco');
    expect(config.providers?.opencodeGo?.executable).toBe('/usr/local/bin/opencode');
    expect(config.providers?.opencodeGo?.catalogArgs).toEqual(['models']);
    expect(config.providers?.opencodeGo?.authArgs).toEqual(['auth', 'list']);
    expect(config.providers?.opencodeGo?.authenticatedOutputTokens).toEqual(['OpenCode Go']);
  });

  it('rejects authentication configuration without positive evidence', () => {
    expect(() => validateConfig({
      version: 1,
      project: { name: 'providers', repository: 'owner/providers' },
      providers: { codex: { authArgs: ['login', 'status'] } },
    })).toThrow(/authentication probes require command arguments and positive output evidence/);
  });

  it('rejects NUL characters in provider command configuration', () => {
    expect(() => validateConfig({
      version: 1,
      project: { name: 'providers', repository: 'owner/providers' },
      providers: { codex: { executable: 'codex\0unsafe' } },
    })).toThrow();
  });

  it('rejects an invalid config shape', () => {
    const raw = `
version: 1
project:
  name: ""
  repository: not-valid
`;
    expect(() => parseConfig(raw)).toThrow();
  });

  it('rejects an unsupported major version', () => {
    const raw = `
version: 99
project:
  name: future
  repository: owner/repo
`;
    expect(() => parseConfig(raw)).toThrow(/Unsupported shipgraph.yml major version/);
  });

  it('rejects unknown configuration keys', () => {
    const raw = `
version: 1
project:
  name: strict
  repository: owner/repo
  unexpected: true
`;
    expect(() => parseConfig(raw)).toThrow();
  });

  it('rejects unknown major version via validateConfig', () => {
    expect(() =>
      validateConfig({
        version: 99,
        project: { name: 'bad', repository: 'owner/repo' },
      })
    ).toThrow(/Unsupported shipgraph.yml major version: 99/);
  });
});
