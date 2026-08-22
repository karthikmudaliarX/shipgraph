import { describe, it, expect } from 'vitest';
import { validateConfig, parseConfig } from '../../src/config/loader.js';

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
        version: 0,
        project: { name: 'bad', repository: 'owner/repo' },
      })
    ).toThrow();
  });
});
