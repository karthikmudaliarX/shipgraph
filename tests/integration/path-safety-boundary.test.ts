import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import { initProject } from '../../src/cli/init.js';
import { validateBacklogProject, syncBacklogProject } from '../../src/cli/backlog.js';
import { showReady } from '../../src/cli/ready.js';
import { showStatus } from '../../src/cli/status.js';
import type { ShipgraphConfig } from '../../src/config/schema.js';

const config: ShipgraphConfig = {
  version: 1,
  project: { name: 'path-safety', repository: 'owner/path-safety', defaultBranch: 'main' },
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
  ],
};

/**
 * CORE-002 path-safety boundary matrix.
 *
 * The common validator (assertSafeShipgraphPaths) must only cover the shared
 * ShipGraph state boundary. Backlog safety is resource-specific and must be
 * enforced on the exact backlog file a command consumes.
 */
describe('CORE-002 path-safety boundary', () => {
  let projectDir: string;
  let externalDir: string;
  let externalBacklogPath: string;

  /** Replace shipgraph.backlog.yml with a symlink escaping the repository. */
  function makeDefaultBacklogUnsafe(): void {
    const linkPath = join(projectDir, 'shipgraph.backlog.yml');
    rmSync(linkPath, { force: true });
    symlinkSync(relative(projectDir, externalBacklogPath), linkPath);
  }

  function sha256(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  }

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'shipgraph-path-safety-'));
    externalDir = mkdtempSync(join(tmpdir(), 'shipgraph-path-safety-ext-'));
    externalBacklogPath = join(externalDir, 'outside.backlog.yml');
    writeFileSync(externalBacklogPath, stringify(backlog));
    process.exitCode = undefined;
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(externalDir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('lets `status` operate normally despite an unsafe default backlog symlink', () => {
    initProject(projectDir, { config });
    writeFileSync(join(projectDir, 'shipgraph.backlog.yml'), stringify(backlog));
    syncBacklogProject(projectDir);
    makeDefaultBacklogUnsafe();

    const before = sha256(join(projectDir, '.shipgraph', 'shipgraph.db'));
    const report = showStatus(projectDir, { json: true });
    expect(report.error).toBeUndefined();
    expect(report.project).toMatchObject({ name: 'path-safety', ticketCount: 1 });
    expect(sha256(join(projectDir, '.shipgraph', 'shipgraph.db'))).toBe(before);
    expect(readFileSync(externalBacklogPath, 'utf8')).toBe(stringify(backlog));
  });

  it('lets `ready` use persisted approved state despite an unsafe default backlog symlink', () => {
    initProject(projectDir, { config });
    writeFileSync(join(projectDir, 'shipgraph.backlog.yml'), stringify(backlog));
    syncBacklogProject(projectDir);
    makeDefaultBacklogUnsafe();

    const dbPath = join(projectDir, '.shipgraph', 'shipgraph.db');
    const before = sha256(dbPath);
    const report = showReady(projectDir);
    expect(report.dispatchable.map((entry) => entry.ticket)).toEqual(['CORE-002']);
    expect(sha256(dbPath)).toBe(before);
    expect(readFileSync(externalBacklogPath, 'utf8')).toBe(stringify(backlog));
  });

  it('does not reject `init` solely because of an unused backlog symlink', () => {
    makeDefaultBacklogUnsafe();

    const result = initProject(projectDir, { config });
    expect(result.configurationRequired).toBe(false);
    expect(result.initializedDb).toBe(true);
    expect(readFileSync(externalBacklogPath, 'utf8')).toBe(stringify(backlog));
  });

  it('fails `backlog validate` closed on an unsafe default backlog symlink', () => {
    initProject(projectDir, { config });
    makeDefaultBacklogUnsafe();

    expect(() => validateBacklogProject(projectDir)).toThrow(/symbolic link/);
  });

  it('fails `backlog sync` closed on an unsafe default backlog symlink', () => {
    initProject(projectDir, { config });
    makeDefaultBacklogUnsafe();

    expect(() => syncBacklogProject(projectDir)).toThrow(/symbolic link/);
  });

  it('succeeds `backlog validate --file safe-alternate.yml` while the default backlog is unsafe', () => {
    writeFileSync(join(projectDir, 'safe-alternate.yml'), stringify(backlog));
    makeDefaultBacklogUnsafe();

    const report = validateBacklogProject(projectDir, 'safe-alternate.yml');
    expect(report.tickets).toBe(1);
    expect(report.ticketIds).toEqual(['CORE-002']);
  });

  it('succeeds `backlog sync --file safe-alternate.yml` while the default backlog is unsafe', () => {
    initProject(projectDir, { config });
    writeFileSync(join(projectDir, 'safe-alternate.yml'), stringify(backlog));
    makeDefaultBacklogUnsafe();

    const report = syncBacklogProject(projectDir, 'safe-alternate.yml');
    expect(report.new).toBe(1);
  });

  it('fails closed when the explicit alternate backlog itself is an unsafe symlink', () => {
    initProject(projectDir, { config });
    symlinkSync(
      relative(projectDir, externalBacklogPath),
      join(projectDir, 'alternate.yml')
    );

    expect(() => validateBacklogProject(projectDir, 'alternate.yml')).toThrow(/symbolic link/);
    expect(() => syncBacklogProject(projectDir, 'alternate.yml')).toThrow(/symbolic link/);
    // Fail-closed means fail-closed: nothing was synced into SQLite.
    expect(showStatus(projectDir, { json: true }).project?.ticketCount ?? 0).toBe(0);
    expect(readFileSync(externalBacklogPath, 'utf8')).toBe(stringify(backlog));
  });

  it('keeps database symlink protection intact for unrelated commands', () => {
    initProject(projectDir, { config });
    const target = join(externalDir, 'external.db');
    writeFileSync(target, 'unchanged');
    rmSync(join(projectDir, '.shipgraph', 'shipgraph.db'));
    symlinkSync(target, join(projectDir, '.shipgraph', 'shipgraph.db'));

    expect(showStatus(projectDir, { json: true }).error).toMatch(/symbolic link/);
    expect(() => showReady(projectDir)).toThrow(/symbolic link/);
    expect(readFileSync(target, 'utf8')).toBe('unchanged');
  });
});
