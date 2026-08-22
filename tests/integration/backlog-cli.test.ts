import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import { initProject } from '../../src/cli/init.js';
import { createProgram } from '../../src/cli/index.js';
import { validateBacklogProject } from '../../src/cli/backlog.js';
import { showReady } from '../../src/cli/ready.js';
import { showStatus } from '../../src/cli/status.js';
import { openAndMigrate } from '../../src/persistence/db.js';
import type { ShipgraphConfig } from '../../src/config/schema.js';

const config: ShipgraphConfig = {
  version: 1,
  project: { name: 'backlog-cli', repository: 'owner/backlog-cli', defaultBranch: 'main' },
  execution: { maxConcurrentTickets: 2, maxRepairIterations: 6 },
  release: { requireHumanApproval: true, requireCleanCI: true, requireExactShaReviews: true },
  agents: { implementer: 'opencode', reviewers: ['correctness'] },
};

const backlog = {
  version: 1,
  tickets: [
    {
      id: 'CORE-002',
      title: 'Backlog scheduler',
      description: 'Persist approved work.',
      priority: 'high',
      dependsOn: [],
      scope: { allowedPaths: ['src/**'], forbiddenPaths: [] },
      acceptanceCriteria: [],
      verification: { commands: ['pnpm test'] },
      risk: 'medium',
      agent: {},
      release: {},
    },
    {
      id: 'WORK-001',
      title: 'Dependent work',
      description: 'Wait for the scheduler.',
      priority: 'low',
      dependsOn: ['CORE-002'],
      scope: { allowedPaths: ['src/**'], forbiddenPaths: [] },
      acceptanceCriteria: [],
      verification: { commands: ['pnpm test'] },
      risk: 'medium',
      agent: {},
      release: {},
    },
  ],
};

describe('backlog and ready CLI', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'shipgraph-backlog-cli-'));
    initProject(projectDir, { config });
    writeFileSync(join(projectDir, 'shipgraph.backlog.yml'), stringify(backlog));
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('validates without mutating SQLite, then syncs and reports ready JSON', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createProgram().parseAsync(
      ['backlog', 'validate', '--project-dir', projectDir, '--json'],
      { from: 'user' }
    );
    expect(process.exitCode).toBeUndefined();
    expect(readFileSync(join(projectDir, '.shipgraph', 'shipgraph.db'))).toBeDefined();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"tickets": 2'));

    await createProgram().parseAsync(
      ['backlog', 'sync', '--project-dir', projectDir, '--json'],
      { from: 'user' }
    );
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"new": 2'));

    await createProgram().parseAsync(
      ['ready', '--project-dir', projectDir, '--json'],
      { from: 'user' }
    );
    const readyOutput = String(consoleSpy.mock.calls.at(-1)?.[0]);
    expect(JSON.parse(readyOutput)).toMatchObject({
      capacity: { active: 0, available: 2 },
      dispatchable: [{ ticket: 'CORE-002' }],
      waiting: [{ ticket: 'WORK-001', blockers: [{ dependency: 'CORE-002', state: 'ELIGIBLE' }] }],
    });
    consoleSpy.mockRestore();
  });

  it('returns structured validation errors and nonzero exit', async () => {
    writeFileSync(join(projectDir, 'shipgraph.backlog.yml'), 'version: 1\ntickets: []\nextra: true\n');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createProgram().parseAsync(
      ['backlog', 'validate', '--project-dir', projectDir, '--json'],
      { from: 'user' }
    );
    expect(process.exitCode).toBe(1);
    expect(() => JSON.parse(String(consoleSpy.mock.calls[0]?.[0]))).not.toThrow();
    expect(String(consoleSpy.mock.calls[0]?.[0])).toContain('error');
    consoleSpy.mockRestore();
  });

  it('fails read-only commands closed on an unknown future migration', () => {
    const db = openAndMigrate(join(projectDir, '.shipgraph', 'shipgraph.db'));
    db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
    ).run(999, 'future_schema', new Date().toISOString());
    db.close();

    expect(showStatus(projectDir, { json: true }).error).toMatch(/not supported/);
    expect(() => showReady(projectDir)).toThrow(/not supported/);
  });

  it('rejects a hard-linked explicit backlog path', () => {
    const externalDir = mkdtempSync(join(tmpdir(), 'shipgraph-external-backlog-'));
    const externalPath = join(externalDir, 'shipgraph.backlog.yml');
    writeFileSync(externalPath, stringify(backlog));
    const linkedPath = join(projectDir, 'linked.backlog.yml');
    linkSync(externalPath, linkedPath);

    expect(() => validateBacklogProject(projectDir, linkedPath)).toThrow(/regular, unlinked/);
    rmSync(externalDir, { recursive: true, force: true });
  });
});
