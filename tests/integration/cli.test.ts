import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { initProject } from '../../src/cli/init.js';
import { showStatus } from '../../src/cli/status.js';
import { createProgram } from '../../src/cli/index.js';
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

    const secondInit = initProject(projectDir, { config });
    expect(secondInit.projectId).toBe(initResult.projectId);

    const secondStatus = showStatus(projectDir, { json: true });
    expect(secondStatus.project?.eventCount).toBe(1);
  });

  it('status reports an error when config is missing', () => {
    const status = showStatus(projectDir, { json: true });
    expect(status.error).toMatch(/shipgraph.yml/);
    expect(status.project).toBeUndefined();
  });

  it('supports init without writing a config when skipConfig is explicit', () => {
    const result = initProject(projectDir, { skipConfig: true });
    expect(result.wroteExampleConfig).toBe(false);
    expect(existsSync(join(projectDir, 'shipgraph.yml'))).toBe(false);
    expect(existsSync(join(projectDir, '.shipgraph', 'shipgraph.db'))).toBe(true);
  });

  it('rejects invalid existing config before creating state', () => {
    writeFileSync(join(projectDir, 'shipgraph.yml'), 'version: 999\nproject: {}\n');
    expect(() => initProject(projectDir)).toThrow();
    expect(existsSync(join(projectDir, '.shipgraph'))).toBe(false);
  });

  it('reads CLI version from package metadata and exposes help', () => {
    const program = createProgram();
    expect(program.version()).toBe('0.1.0');
    expect(program.commands.map((command) => command.name())).toEqual([
      'doctor',
      'init',
      'status',
    ]);
  });

  it('renders human-readable status output', () => {
    initProject(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const report = showStatus(projectDir);

    expect(report.error).toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith('Project: example (owner/repo)');
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
    initProject(projectDir);
    writeFileSync(
      join(projectDir, 'shipgraph.yml'),
      `version: 1\nproject:\n  name: changed\n  repository: other/repo\n  defaultBranch: main\nexecution:\n  maxConcurrentTickets: 1\n  maxRepairIterations: 6\nrelease:\n  requireHumanApproval: true\n  requireCleanCI: true\n  requireExactShaReviews: true\nagents:\n  implementer: opencode\n  reviewers:\n    - correctness\n`
    );

    expect(() => initProject(projectDir)).toThrow(/does not match/);
  });

  it('parses and executes init and status commands', async () => {
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
    initProject(projectDir);
    const externalDir = mkdtempSync(join(tmpdir(), 'shipgraph-external-'));
    const target = join(externalDir, 'external.db');
    writeFileSync(target, 'unchanged');
    rmSync(join(projectDir, '.shipgraph', 'shipgraph.db'));
    symlinkSync(target, join(projectDir, '.shipgraph', 'shipgraph.db'));

    expect(() => showStatus(projectDir, { json: true })).toThrow(/symbolic link/);
    expect(existsSync(target)).toBe(true);
    rmSync(externalDir, { recursive: true, force: true });
  });
});
