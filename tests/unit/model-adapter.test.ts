import { describe, expect, it } from 'vitest';
import {
  createCommandModelProviderAdapter,
  createModelProviderAdapters,
  parseModelCatalog,
  type ModelProviderProcessRunner,
} from '../../src/adapters/model/adapter.js';
import type { AgentProcessResult } from '../../src/adapters/agent/process.js';

function result(overrides: Partial<AgentProcessResult> = {}): AgentProcessResult {
  return {
    exitCode: 0,
    unexpectedTermination: false,
    timedOut: false,
    cancelled: false,
    outputLimitExceeded: false,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
    ...overrides,
  };
}

describe('MODEL-001 provider adapters', () => {
  it('parses provider-supplied JSON without embedding a model allowlist', () => {
    const parsed = parseModelCatalog(
      JSON.stringify({
        models: [
          { id: 'provider/future-model', capabilities: ['implementation', 'review'] },
          { name: 'provider/another-model', contextWindow: 128000 },
        ],
      }),
      ['implementation', 'review', 'repair']
    );

    expect(parsed).toEqual({
      status: 'known',
      models: [
        {
          modelId: 'provider/another-model',
          capabilities: ['implementation', 'review', 'repair'],
          contextWindow: 128000,
        },
        {
          modelId: 'provider/future-model',
          capabilities: ['implementation', 'review'],
        },
      ],
    });
  });

  it('keeps an unrecognized catalog surface unknown instead of inventing models', () => {
    expect(parseModelCatalog('Models are available after login', ['implementation'])).toEqual({
      status: 'unknown',
      reason: 'provider catalog output was not a supported machine-readable model list',
    });
  });

  it('keeps truncated catalog output unknown', async () => {
    const adapter = createCommandModelProviderAdapter({
      providerId: 'grok',
      family: 'xai',
      displayName: 'Grok',
      executable: '/tmp/provider',
      catalogArgs: ['models'],
      processRunner: {
        run: async () => result({ outputLimitExceeded: true, stdout: '[{"id":"model"}]' }),
      },
      cwd: '/tmp/project',
    });

    await expect(adapter.discoverModels()).resolves.toEqual({
      status: 'unknown',
      reason: 'provider catalog output exceeded the safety limit',
    });
  });

  it('probes availability and discovers models through argv without a shell', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runner: ModelProviderProcessRunner = {
      run: async (spec) => {
        calls.push({ command: spec.command, args: spec.args });
        return spec.args[0] === '--version'
          ? result({ stdout: 'provider-cli 2.0.0\n' })
          : result({ stdout: '[{"id":"provider/discovered"}]\n' });
      },
    };
    const adapter = createCommandModelProviderAdapter({
      providerId: 'grok',
      family: 'xai',
      displayName: 'Grok',
      executable: '/tmp/provider cli',
      catalogArgs: ['models', '--json'],
      processRunner: runner,
      cwd: '/tmp/project',
    });

    expect(await adapter.probe()).toMatchObject({
      availability: 'available',
      auth: 'unknown',
      version: 'provider-cli 2.0.0',
      capabilities: ['implementation', 'review', 'repair'],
    });
    expect(await adapter.discoverModels()).toEqual({
      status: 'known',
      models: [{ modelId: 'provider/discovered', capabilities: ['implementation', 'review', 'repair'] }],
    });
    expect(calls).toEqual([
      { command: '/tmp/provider cli', args: ['--version'] },
      { command: '/tmp/provider cli', args: ['models', '--json'] },
    ]);
  });

  it('returns the four bounded provider adapters in stable order', () => {
    const adapters = createModelProviderAdapters({
      configuration: {
        grok: { executable: '/tmp/grok' },
        gemini: { executable: '/tmp/gemini' },
      },
      processRunner: { run: async () => result() },
    });

    expect(adapters.map((adapter) => adapter.providerId)).toEqual([
      'opencode-go',
      'codex',
      'grok',
      'gemini',
    ]);
  });
});
