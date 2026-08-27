import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProject } from '../../src/cli/init.js';
import { createProgram } from '../../src/cli/index.js';
import { openAndMigrate } from '../../src/persistence/db.js';
import { createTicketRepository } from '../../src/persistence/repositories.js';
import type { ShipgraphConfig } from '../../src/config/schema.js';

describe('MODEL-001 CLI', () => {
  let projectDir: string;
  let providerScript: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'shipgraph-model-cli-'));
    providerScript = join(projectDir, 'provider');
    writeFileSync(
      providerScript,
      '#!/bin/sh\n' +
        'if [ "$1" = "--version" ]; then printf "fake-provider 1.0\\n"; ' +
        'elif [ "$1" = "run" ] && [ "$2" = "--help" ]; then ' +
        'printf "run --format --dir --model --auto\\n"; ' +
        'else printf "[{\\"id\\":\\"future/provider-model\\"}]\\n"; fi\n'
    );
    chmodSync(providerScript, 0o700);
    const config: ShipgraphConfig = {
      version: 1,
      project: { name: 'model-cli', repository: 'owner/model-cli', defaultBranch: 'main' },
      execution: { maxConcurrentTickets: 1, maxRepairIterations: 6 },
      release: { requireHumanApproval: true, requireCleanCI: true, requireExactShaReviews: true },
      agents: { implementer: 'opencode', reviewers: ['correctness'] },
      providers: {
        opencodeGo: { executable: providerScript, catalogArgs: ['models'] },
        codex: { enabled: false },
        grok: { enabled: false },
        gemini: { enabled: false },
      },
    };
    initProject(projectDir, { config });
    const db = openAndMigrate(join(projectDir, '.shipgraph', 'shipgraph.db'));
    const project = db.prepare('SELECT id FROM projects').get() as { id: string };
    createTicketRepository(db).create({
      id: 'KAR-6001',
      projectId: project.id,
      title: 'CLI model run',
      description: 'disposable durable run',
      priority: 'medium',
      dependsOn: [],
      scope: { allowedPaths: [], forbiddenPaths: [] },
      acceptanceCriteria: [],
      verification: { commands: [] },
      risk: 'medium',
      agent: {},
      release: {},
      status: 'QUEUED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO runs (
        id, ticket_id, base_sha, branch_name, status, started_at, project_id,
        provider, model, model_provider_id, task, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'run-cli-1',
      'KAR-6001',
      '0'.repeat(40),
      'agent/cli-model',
      'CREATED',
      now,
      project.id,
      'opencode',
      'future/provider-model',
      'opencode-go',
      'implementation',
      now,
      now
    );
    db.close();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('refreshes, lists, and routes through the compiled command contract', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createProgram().parseAsync(
      ['providers', 'refresh', '--project-dir', projectDir, '--json'],
      { from: 'user' }
    );
    expect(process.exitCode).toBeUndefined();
    const refresh = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0])) as {
      providers: Array<Record<string, unknown>>;
    };
    expect(refresh.providers.find((provider) => provider.providerId === 'opencode-go')).toMatchObject({
      availability: 'available',
      executionStatus: 'available',
      executionProvider: 'opencode',
      catalogStatus: 'known',
      modelCount: 1,
    });

    await createProgram().parseAsync(
      ['providers', 'route', 'implementation', '--risk', 'medium', '--project-dir', projectDir, '--json'],
      { from: 'user' }
    );
    const route = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0])) as {
      decision: Record<string, unknown>;
    };
    expect(route.decision).toMatchObject({
      providerId: 'opencode-go',
      modelId: 'future/provider-model',
      mode: 'balanced',
    });

    await createProgram().parseAsync(
      ['providers', 'list', '--project-dir', projectDir, '--json'],
      { from: 'user' }
    );
    const listed = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0])) as {
      providers: Array<Record<string, unknown>>;
    };
    expect(listed.providers).toHaveLength(4);

    consoleSpy.mockClear();
    await createProgram().parseAsync(
      [
        'providers',
        'route',
        'implementation',
        '--risk',
        'medium',
        '--run-id',
        'run-cli-1',
        '--project-dir',
        projectDir,
        '--json',
      ],
      { from: 'user' }
    );
    const boundFirst = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0])) as {
      decision: Record<string, unknown>;
    };
    await createProgram().parseAsync(
      [
        'providers',
        'route',
        'implementation',
        '--risk',
        'medium',
        '--run-id',
        'run-cli-1',
        '--project-dir',
        projectDir,
        '--json',
      ],
      { from: 'user' }
    );
    const boundReplay = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0])) as {
      decision: Record<string, unknown>;
    };
    expect(boundReplay.decision).toEqual(boundFirst.decision);
    const persisted = openAndMigrate(join(projectDir, '.shipgraph', 'shipgraph.db'));
    expect(persisted.prepare('SELECT COUNT(*) AS count FROM routing_decisions').get()).toEqual({ count: 1 });
    expect(persisted.prepare('SELECT COUNT(*) AS count FROM provider_capacity_reservations').get()).toEqual({ count: 1 });
    persisted.close();
    consoleSpy.mockRestore();
  });
});
