import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProject } from '../../src/cli/init.js';
import { createProgram } from '../../src/cli/index.js';
import type { ShipgraphConfig } from '../../src/config/schema.js';

describe('MODEL-001 CLI', () => {
  let projectDir: string;
  let providerScript: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'shipgraph-model-cli-'));
    providerScript = join(projectDir, 'provider');
    writeFileSync(
      providerScript,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "fake-provider 1.0\\n"; else printf "[{\\"id\\":\\"future/provider-model\\"}]\\n"; fi\n'
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
    consoleSpy.mockRestore();
  });
});
