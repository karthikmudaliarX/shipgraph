import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { initProject } from '../../src/cli/init.js';
import { showStatus } from '../../src/cli/status.js';
import { createProgram } from '../../src/cli/index.js';
import type { ShipgraphConfig } from '../../src/config/schema.js';
import { stringify } from 'yaml';
import { openAndMigrate } from '../../src/persistence/db.js';
import { createProjectRepository } from '../../src/persistence/repositories.js';

const TEST_CONFIG: ShipgraphConfig = {
  version: 1,
  project: { name: 'cli-test', repository: 'owner/repo', defaultBranch: 'main' },
  execution: { maxConcurrentTickets: 1, maxRepairIterations: 6 },
  release: { requireHumanApproval: true, requireCleanCI: true, requireExactShaReviews: true },
  agents: { implementer: 'opencode', reviewers: ['correctness'] },
};

describe('CLI smoke tests', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'shipgraph-cli-test-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('init creates metadata and status reports it', () => {
    const initResult = initProject(projectDir, { config: TEST_CONFIG });
    expect(initResult.initializedDb).toBe(true);
    expect(initResult.projectId).toBeDefined();

    const status = showStatus(projectDir, { json: true });
    expect(status.error).toBeUndefined();
    expect(status.project?.name).toBe('cli-test');
    expect(status.project?.ticketCount).toBe(0);
    expect(status.project?.eventCount).toBe(1);

    const secondInit = initProject(projectDir, { config: TEST_CONFIG });
    expect(secondInit.projectId).toBe(initResult.projectId);

    const secondStatus = showStatus(projectDir, { json: true });
    expect(secondStatus.project?.eventCount).toBe(1);
  });

  it('status reports an error when config is missing', () => {
    const status = showStatus(projectDir, { json: true });
    expect(status.error).toMatch(/shipgraph.yml/);
    expect(status.project).toBeUndefined();
  });

  it('status returns a structured error for invalid config', () => {
    writeFileSync(join(projectDir, 'shipgraph.yml'), 'version: 99\nproject: {}\n');
    const status = showStatus(projectDir, { json: true });
    expect(status.error).toMatch(/Failed to load shipgraph.yml/);
    expect(status.project).toBeUndefined();
  });

  it('rejects invalid existing config before creating state', () => {
    writeFileSync(join(projectDir, 'shipgraph.yml'), 'version: 999\nproject: {}\n');
    expect(() => initProject(projectDir)).toThrow();
    expect(existsSync(join(projectDir, '.shipgraph'))).toBe(false);
  });

  it('does not mistake arbitrary empty-identity config for the generated template', () => {
    writeFileSync(
      join(projectDir, 'shipgraph.yml'),
      'version: 99\nproject:\n  name: ""\n  repository: ""\nunexpected: true\n'
    );
    expect(() => initProject(projectDir)).toThrow();
    expect(existsSync(join(projectDir, '.shipgraph'))).toBe(false);
  });

  it('persists the normalized validated config supplied by an API caller', () => {
    const partial = {
      version: 1,
      project: { name: 'normalized', repository: 'owner/normalized' },
    } as unknown as ShipgraphConfig;
    const result = initProject(projectDir, { config: partial });
    expect(result.initializedDb).toBe(true);
    expect(showStatus(projectDir, { json: true }).project).toMatchObject({
      name: 'normalized',
      defaultBranch: 'main',
    });
  });

  it('does not let an explicit config bypass an existing shipgraph.yml', () => {
    writeFileSync(join(projectDir, 'shipgraph.yml'), stringify(TEST_CONFIG));
    expect(() =>
      initProject(projectDir, {
        config: {
          ...TEST_CONFIG,
          project: { ...TEST_CONFIG.project, repository: 'other/repo' },
        },
      })
    ).toThrow(/does not match the existing shipgraph.yml/);
    expect(existsSync(join(projectDir, '.shipgraph'))).toBe(false);
  });

  it('reads CLI version from package metadata and exposes help', () => {
    const program = createProgram();
    expect(program.version()).toBe('0.1.0');
    expect(program.commands.map((command) => command.name())).toEqual([
      'doctor',
      'init',
      'status',
      'backlog',
      'ready',
    ]);
  });

  it('renders human-readable status output', () => {
    initProject(projectDir, { config: TEST_CONFIG });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const report = showStatus(projectDir);

    expect(report.error).toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith('Project: cli-test (owner/repo)');
    expect(consoleSpy).toHaveBeenCalledWith('Tickets: 0');
    expect(consoleSpy).toHaveBeenCalledWith('Events: 1');
    consoleSpy.mockRestore();
  });

  it('initializes from an existing validated repository config', async () => {
    writeFileSync(
      join(projectDir, 'shipgraph.yml'),
      `version: 1\nproject:\n  name: configured\n  repository: org/production-repo\n  defaultBranch: trunk\nexecution:\n  maxConcurrentTickets: 2\n  maxRepairIterations: 4\nrelease:\n  requireHumanApproval: true\n  requireCleanCI: true\n  requireExactShaReviews: true\nagents:\n  implementer: codex\n  reviewers:\n    - adversarial\n`
    );
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram().parseAsync(['init', '--project-dir', projectDir], { from: 'user' });
    const status = showStatus(projectDir, { json: true });

    expect(status.project).toMatchObject({
      name: 'configured',
      repository: 'org/production-repo',
      defaultBranch: 'trunk',
    });
    consoleSpy.mockRestore();
  });

  it('fails closed when config identity changes after initialization', () => {
    initProject(projectDir, { config: TEST_CONFIG });
    writeFileSync(
      join(projectDir, 'shipgraph.yml'),
      `version: 1\nproject:\n  name: changed\n  repository: other/repo\n  defaultBranch: main\nexecution:\n  maxConcurrentTickets: 1\n  maxRepairIterations: 6\nrelease:\n  requireHumanApproval: true\n  requireCleanCI: true\n  requireExactShaReviews: true\nagents:\n  implementer: opencode\n  reviewers:\n    - correctness\n`
    );

    expect(() => initProject(projectDir)).toThrow(/does not match/);
  });

  it('parses and executes init and status commands', async () => {
    writeFileSync(join(projectDir, 'shipgraph.yml'), stringify(TEST_CONFIG));
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram().parseAsync(
      ['init', '--project-dir', projectDir],
      { from: 'user' }
    );
    await createProgram().parseAsync(
      ['status', '--project-dir', projectDir, '--json'],
      { from: 'user' }
    );

    expect(consoleSpy).toHaveBeenCalledWith('ShipGraph initialized:');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"ticketCount": 0'));
    consoleSpy.mockRestore();
  });

  it('writes an idempotent first-run template without initializing placeholder identity', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram().parseAsync(['init', '--project-dir', projectDir], { from: 'user' });
    expect(consoleSpy).toHaveBeenCalledWith(
      'ShipGraph configuration template written to shipgraph.yml.'
    );
    expect(existsSync(join(projectDir, 'shipgraph.yml'))).toBe(true);
    expect(existsSync(join(projectDir, '.shipgraph', 'shipgraph.db'))).toBe(false);

    const second = initProject(projectDir);
    expect(second.configurationRequired).toBe(true);
    expect(second.wroteConfigTemplate).toBe(false);
    expect(second.initializedDb).toBe(false);

    writeFileSync(join(projectDir, 'shipgraph.yml'), stringify(TEST_CONFIG));
    await createProgram().parseAsync(['init', '--project-dir', projectDir], { from: 'user' });
    expect(consoleSpy).toHaveBeenCalledWith('ShipGraph initialized:');
    expect(existsSync(join(projectDir, '.shipgraph', 'shipgraph.db'))).toBe(true);
    expect(showStatus(projectDir, { json: true }).project?.name).toBe('cli-test');
    consoleSpy.mockRestore();
  });

  it('returns structured missing-database and identity-drift status errors', async () => {
    writeFileSync(join(projectDir, 'shipgraph.yml'), stringify(TEST_CONFIG));
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    process.exitCode = undefined;
    await createProgram().parseAsync(
      ['status', '--project-dir', projectDir, '--json'],
      { from: 'user' }
    );
    expect(process.exitCode).toBe(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('No initialized ShipGraph project found')
    );

    process.exitCode = undefined;
    initProject(projectDir);
    writeFileSync(
      join(projectDir, 'shipgraph.yml'),
      stringify({
        ...TEST_CONFIG,
        project: { ...TEST_CONFIG.project, repository: 'other/repo' },
      })
    );
    const drift = showStatus(projectDir, { json: true });
    expect(drift.error).toMatch(/does not match/);
    process.exitCode = undefined;
    consoleSpy.mockRestore();
  });

  it('returns valid JSON and a nonzero exit for a corrupt database', async () => {
    writeFileSync(join(projectDir, 'shipgraph.yml'), stringify(TEST_CONFIG));
    mkdirSync(join(projectDir, '.shipgraph'));
    writeFileSync(join(projectDir, '.shipgraph', 'shipgraph.db'), 'not sqlite');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    process.exitCode = undefined;
    await createProgram().parseAsync(
      ['status', '--project-dir', projectDir, '--json'],
      { from: 'user' }
    );
    expect(process.exitCode).toBe(1);
    const output = String(consoleSpy.mock.calls[0]?.[0]);
    expect(() => JSON.parse(output)).not.toThrow();
    expect(JSON.parse(output)).toMatchObject({ error: expect.stringContaining('Failed to read') });
    process.exitCode = undefined;
    consoleSpy.mockRestore();
  });

  it('refuses a configuration symlink without writing its target', () => {
    const externalDir = mkdtempSync(join(tmpdir(), 'shipgraph-external-'));
    const target = join(externalDir, 'escaped.yml');
    symlinkSync(relative(projectDir, target), join(projectDir, 'shipgraph.yml'));

    expect(() => initProject(projectDir)).toThrow(/symbolic link/);
    expect(existsSync(target)).toBe(false);
    rmSync(externalDir, { recursive: true, force: true });
  });

  it('refuses a state-directory symlink without creating an external database', () => {
    const externalDir = mkdtempSync(join(tmpdir(), 'shipgraph-external-'));
    symlinkSync(externalDir, join(projectDir, '.shipgraph'));

    expect(() => initProject(projectDir)).toThrow(/symbolic link/);
    expect(existsSync(join(externalDir, 'shipgraph.db'))).toBe(false);
    rmSync(externalDir, { recursive: true, force: true });
  });

  it('refuses a database symlink during status without modifying its target', () => {
    initProject(projectDir, { config: TEST_CONFIG });
    const externalDir = mkdtempSync(join(tmpdir(), 'shipgraph-external-'));
    const target = join(externalDir, 'external.db');
    writeFileSync(target, 'unchanged');
    rmSync(join(projectDir, '.shipgraph', 'shipgraph.db'));
    symlinkSync(target, join(projectDir, '.shipgraph', 'shipgraph.db'));

    expect(showStatus(projectDir, { json: true }).error).toMatch(/symbolic link/);
    expect(existsSync(target)).toBe(true);
    rmSync(externalDir, { recursive: true, force: true });
  });

  it('refuses a hard-linked database before migration can modify its target', () => {
    const externalDir = mkdtempSync(join(tmpdir(), 'shipgraph-external-'));
    const target = join(externalDir, 'external.db');
    writeFileSync(target, 'unchanged');
    mkdirSync(join(projectDir, '.shipgraph'));
    linkSync(target, join(projectDir, '.shipgraph', 'shipgraph.db'));

    expect(() => initProject(projectDir, { config: TEST_CONFIG })).toThrow(/unlinked file/);
    expect(readFileSync(target, 'utf8')).toBe('unchanged');
    rmSync(externalDir, { recursive: true, force: true });
  });

  it('fails closed when a project-local database contains multiple projects', () => {
    initProject(projectDir, { config: TEST_CONFIG });
    const db = openAndMigrate(join(projectDir, '.shipgraph', 'shipgraph.db'));
    const now = new Date().toISOString();
    createProjectRepository(db).create({
      id: 'second-project',
      name: 'second',
      repository: 'owner/second',
      defaultBranch: 'main',
      config: {
        ...TEST_CONFIG,
        project: { name: 'second', repository: 'owner/second', defaultBranch: 'main' },
      },
      createdAt: now,
      updatedAt: now,
    });
    db.close();

    expect(showStatus(projectDir, { json: true }).error).toMatch(/exactly one project/);
    expect(() => initProject(projectDir)).toThrow(/exactly one project/);
  });
});
