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
    providerScript = join(projectDir, 'opencode');
    writeFileSync(
      providerScript,
      '#!/bin/sh\n' +
        'if [ "$1" = "--version" ]; then printf "1.0.0\\n"; ' +
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
    expect(process.exitCode).toBe(1);
    const routeError = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0])) as {
      error: string;
    };
    expect(routeError.error).toMatch(/No usable provider\/model/);
    // The fake command only proves its installed surface; it intentionally
    // provides no positive authentication evidence, so CLI routing must fail
    // closed rather than reserve a provider it cannot prove it can execute.
    process.exitCode = undefined;

    await createProgram().parseAsync(
      ['providers', 'list', '--project-dir', projectDir, '--json'],
      { from: 'user' }
    );
    const listed = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0])) as {
      providers: Array<Record<string, unknown>>;
    };
    expect(listed.providers).toHaveLength(4);

    const persisted = openAndMigrate(join(projectDir, '.shipgraph', 'shipgraph.db'));
    expect(persisted.prepare('SELECT COUNT(*) AS count FROM routing_decisions').get()).toEqual({ count: 0 });
    expect(persisted.prepare('SELECT COUNT(*) AS count FROM provider_capacity_reservations').get()).toEqual({ count: 0 });
    persisted.close();
    consoleSpy.mockRestore();
  });
});
