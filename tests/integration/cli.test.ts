import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../../src/cli/init.js';
import { showStatus } from '../../src/cli/status.js';
import type { ShipgraphConfig } from '../../src/config/schema.js';

describe('CLI smoke tests', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'shipgraph-cli-test-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('init creates metadata and status reports it', () => {
    const config: ShipgraphConfig = {
      version: 1,
      project: { name: 'cli-test', repository: 'owner/repo', defaultBranch: 'main' },
      execution: { maxConcurrentTickets: 1, maxRepairIterations: 6 },
      release: { requireHumanApproval: true, requireCleanCI: true, requireExactShaReviews: true },
      agents: { implementer: 'opencode', reviewers: ['correctness'] },
    };

    const initResult = initProject(projectDir, { config });
    expect(initResult.initializedDb).toBe(true);
    expect(initResult.projectId).toBeDefined();

    const status = showStatus(projectDir, { json: true });
    expect(status.error).toBeUndefined();
    expect(status.project?.name).toBe('cli-test');
    expect(status.project?.ticketCount).toBe(0);
    expect(status.project?.eventCount).toBe(1);
  });

  it('status reports an error when config is missing', () => {
    const status = showStatus(projectDir, { json: true });
    expect(status.error).toMatch(/shipgraph.yml/);
    expect(status.project).toBeUndefined();
  });
});
