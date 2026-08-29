import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
    temporaryDirectories.length = 0;
  });

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

  it('parses the current catalog surface for every supported provider', async () => {
    const catalogOutput = new Map<string, string>([
      ['opencode-go', 'opencode-go/provider-future-model\n'],
      ['codex', JSON.stringify({ models: [{ slug: 'gpt-future-model' }] })],
      ['grok', [
        'You are logged in with grok.com.',
        '',
        'Default model: grok-future-default',
        '',
        'Available models:',
        '  - grok-future-model',
        '  * grok-future-default (default)',
      ].join('\n')],
      ['gemini', `Fetching available models...\n${JSON.stringify({
        conversation_id: '',
        status: 'SUCCESS',
        response: 'gemini-future-model\tGemini Future Model\n',
        command: {
          name: 'models',
          data: {
            models: [
              { id: 'gemini-future-model', label: 'Gemini Future Model' },
              { id: 'gemini-future-fast', label: 'Gemini Future Fast' },
            ],
          },
        },
      })}`],
    ]);
    const versionOutput: Record<string, string> = {
      '/tmp/opencode': '1.18.21\n',
      '/tmp/codex': 'codex-cli 0.147.0\n',
      grok: 'grok 1.0.13 (current)\n',
      agy: '1.1.22\n',
    };
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runner: ModelProviderProcessRunner = {
      run: async (spec) => {
        calls.push({ command: spec.command, args: spec.args });
        if (spec.args[0] === '--version') {
          return result({ stdout: versionOutput[spec.command] ?? '' });
        }
        if (spec.command === '/tmp/opencode' && spec.args[0] === 'auth') {
          return result({ stdout: 'OpenCode Go api\n' });
        }
        if (spec.command === '/tmp/codex' && spec.args[0] === 'login') {
          return result({ stdout: 'Logged in using ChatGPT\n' });
        }
        if (spec.command === 'grok' && spec.args[0] === 'models') {
          return result({ stdout: catalogOutput.get('grok') ?? '' });
        }
        const providerId = spec.command === '/tmp/opencode'
          ? 'opencode-go'
          : spec.command === '/tmp/codex'
            ? 'codex'
            : 'gemini';
        return result({ stdout: catalogOutput.get(providerId) ?? '' });
      },
    };
    const adapters = createModelProviderAdapters({
      configuration: {
        opencodeGo: { executable: '/tmp/opencode' },
        codex: { executable: '/tmp/codex' },
      },
      processRunner: runner,
      cwd: '/tmp/project',
    });

    const probes = [];
    for (const adapter of adapters) probes.push(await adapter.probe());
    const discoveries = [];
    for (const adapter of adapters) discoveries.push(await adapter.discoverModels());

    expect(probes.map((probe) => probe.auth)).toEqual([
      'authenticated',
      'authenticated',
      'authenticated',
      'unknown',
    ]);
    expect(discoveries.map((discovery) => discovery.status)).toEqual([
      'known',
      'known',
      'known',
      'known',
    ]);
    expect(discoveries.map((discovery) =>
      discovery.status === 'known' ? discovery.models.map((model) => model.modelId) : []
    )).toEqual([
      ['opencode-go/provider-future-model'],
      ['gpt-future-model'],
      ['grok-future-default', 'grok-future-model'],
      ['gemini-future-fast', 'gemini-future-model'],
    ]);
    expect(calls.map((call) => call.args)).toEqual([
      ['--version'],
      ['auth', 'list', '--pure'],
      ['--version'],
      ['login', 'status'],
      ['--version'],
      ['models'],
      ['--version'],
      ['models', 'opencode-go', '--pure'],
      ['debug', 'models'],
      ['models'],
      ['--output-format', 'json', 'models'],
    ]);
    expect(calls.map((call) => call.command)).toEqual([
      '/tmp/opencode',
      '/tmp/opencode',
      '/tmp/codex',
      '/tmp/codex',
      'grok',
      'grok',
      'agy',
      '/tmp/opencode',
      '/tmp/codex',
      'grok',
      'agy',
    ]);
  });

  it('keeps malformed provider-native catalog surfaces unknown and non-routable', async () => {
    const malformed = [
      createCommandModelProviderAdapter({
        providerId: 'grok',
        family: 'xai',
        displayName: 'Grok',
        executable: '/tmp/grok',
        catalogArgs: ['models'],
        processRunner: { run: async () => result({ stdout: 'Default model: grok-future\n' }) },
        cwd: '/tmp/project',
      }),
      createCommandModelProviderAdapter({
        providerId: 'gemini',
        family: 'google',
        displayName: 'Gemini',
        executable: '/tmp/agy',
        catalogArgs: ['--output-format', 'json', 'models'],
        processRunner: {
          run: async () => result({
            stdout: JSON.stringify({ items: [{ id: 'unsupported-model' }] }),
          }),
        },
        cwd: '/tmp/project',
      }),
    ];

    for (const adapter of malformed) {
      await expect(adapter.discoverModels()).resolves.toEqual({
        status: 'unknown',
        reason: 'provider catalog output was not a supported machine-readable model list',
      });
    }
  });

  it('keeps an unrecognized catalog surface unknown instead of inventing models', () => {
    expect(parseModelCatalog('Models are available after login', ['implementation'])).toEqual({
      status: 'unknown',
      reason: 'provider catalog output was not a supported machine-readable model list',
    });
  });

  it('fails closed on conflicting duplicate model metadata', () => {
    expect(parseModelCatalog(
      JSON.stringify({
        models: [
          { id: 'provider/duplicate', capabilities: ['implementation'] },
          { id: 'provider/duplicate', capabilities: ['review'] },
        ],
      }),
      ['implementation', 'review']
    )).toEqual({
      status: 'unknown',
      reason: 'provider catalog output was not a supported machine-readable model list',
    });
  });

  it('fails closed when model capability metadata has an invalid shape', () => {
    expect(parseModelCatalog(
      JSON.stringify({ models: [{ id: 'provider/malformed', capabilities: 'review' }] }),
      ['implementation', 'review']
    )).toEqual({
      status: 'unknown',
      reason: 'provider catalog contained an invalid model entry',
    });
  });

  it('fails closed when model capability metadata contains an unknown value', () => {
    expect(parseModelCatalog(
      JSON.stringify({
        models: [{ id: 'provider/malformed', capabilities: ['implementation', 'future-task'] }],
      }),
      ['implementation', 'review']
    )).toEqual({
      status: 'unknown',
      reason: 'provider catalog contained an invalid model entry',
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
      providerId: 'codex',
      family: 'openai',
      displayName: 'Codex',
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

  it('marks authentication positive only from a provider status surface', async () => {
    const calls: string[][] = [];
    const runner: ModelProviderProcessRunner = {
      run: async (spec) => {
        calls.push([...spec.args]);
        if (spec.args[0] === '--version') return result({ stdout: 'codex-cli 2.0.0\n' });
        if (spec.args[0] === 'login') return result({ stdout: 'Logged in using ChatGPT\n' });
        return result({ stdout: '[{"id":"provider/discovered"}]\n' });
      },
    };
    const adapter = createCommandModelProviderAdapter({
      providerId: 'codex',
      family: 'openai',
      displayName: 'Codex',
      executable: '/tmp/codex',
      authArgs: ['login', 'status'],
      authenticatedOutputTokens: ['Logged in using ChatGPT'],
      unauthenticatedOutputTokens: ['Not logged in'],
      catalogArgs: ['models'],
      processRunner: runner,
      cwd: '/tmp/project',
    });

    await expect(adapter.probe()).resolves.toMatchObject({
      availability: 'available',
      auth: 'authenticated',
    });
    expect(calls).toEqual([
      ['--version'],
      ['login', 'status'],
    ]);
  });

  it('keeps authentication unknown when a status command is ambiguous', async () => {
    const adapter = createCommandModelProviderAdapter({
      providerId: 'codex',
      family: 'openai',
      displayName: 'Codex',
      executable: '/tmp/codex',
      authArgs: ['login', 'status'],
      authenticatedOutputTokens: ['Logged in'],
      unauthenticatedOutputTokens: ['Not logged in'],
      processRunner: {
        run: async (spec) => spec.args[0] === '--version'
          ? result({ stdout: 'codex-cli 2.0.0\n' })
          : result({ stdout: 'Authentication status unavailable\n' }),
      },
      cwd: '/tmp/project',
    });

    await expect(adapter.probe()).resolves.toMatchObject({
      availability: 'available',
      auth: 'unknown',
      reason: 'provider authentication status did not provide positive evidence',
    });
  });

  it('passes only the selected MODEL provider credentials to metadata probes', async () => {
    const calls: Array<{
      command: string;
      env: Readonly<Record<string, string>>;
    }> = [];
    const runner: ModelProviderProcessRunner = {
      run: async (spec) => {
        calls.push({ command: spec.command, env: spec.env });
        const versionByCommand: Record<string, string> = {
          '/tmp/opencode': '1.0.0',
          '/tmp/codex': 'codex-cli 2.0.0',
          '/tmp/grok': 'grok 2.0.0',
          '/tmp/agy': '1.0.0',
        };
        return result({ stdout: `${versionByCommand[spec.command] ?? '1.0.0'}\n` });
      },
    };
    const adapters = createModelProviderAdapters({
      configuration: {
        opencodeGo: { executable: '/tmp/opencode' },
        codex: { executable: '/tmp/codex' },
        grok: { executable: '/tmp/grok' },
        gemini: { executable: '/tmp/agy' },
      },
      processRunner: runner,
      cwd: '/tmp/project',
      environment: {
        OPENCODE_API_KEY: 'opencode-secret',
        OPENAI_API_KEY: 'openai-secret',
        CODEX_HOME: '/tmp/codex-home',
        XAI_API_KEY: 'grok-secret',
        GROK_HOME: '/tmp/grok-home',
        GEMINI_API_KEY: 'gemini-secret',
        GOOGLE_API_KEY: 'google-secret',
        GOOGLE_GENERATIVE_AI_API_KEY: 'google-generative-secret',
      },
    });

    for (const adapter of adapters) await adapter.probe();
    const envByCommand = new Map(calls.map((call) => [call.command, call.env]));
    expect(envByCommand.get('/tmp/opencode')).toMatchObject({ OPENCODE_API_KEY: 'opencode-secret' });
    expect(envByCommand.get('/tmp/opencode')).not.toHaveProperty('OPENAI_API_KEY');
    expect(envByCommand.get('/tmp/codex')).toMatchObject({
      OPENAI_API_KEY: 'openai-secret',
      CODEX_HOME: '/tmp/codex-home',
    });
    expect(envByCommand.get('/tmp/codex')).not.toHaveProperty('XAI_API_KEY');
    expect(envByCommand.get('/tmp/grok')).toMatchObject({
      XAI_API_KEY: 'grok-secret',
      GROK_HOME: '/tmp/grok-home',
    });
    expect(envByCommand.get('/tmp/grok')).not.toHaveProperty('OPENAI_API_KEY');
    expect(envByCommand.get('/tmp/agy')).toMatchObject({
      GEMINI_API_KEY: 'gemini-secret',
      GOOGLE_API_KEY: 'google-secret',
      GOOGLE_GENERATIVE_AI_API_KEY: 'google-generative-secret',
    });
    expect(envByCommand.get('/tmp/agy')).not.toHaveProperty('XAI_API_KEY');
  });

  it('pins metadata discovery to the identity-checked executable after authentication probing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'shipgraph-model-probe-'));
    temporaryDirectories.push(directory);
    const executable = join(directory, 'opencode');
    const replacement = join(directory, 'opencode-replacement');
    const script = `#!/bin/sh
case "$1 $2" in
  "--version ") printf '1.0.0\\n' ;;
  "auth list") printf 'OpenCode Go\\n' ;;
  "models ") printf '[{"id":"provider/dynamic"}]\\n' ;;
  *) printf 'unexpected\\n' ;;
esac
`;
    writeFileSync(executable, script, { mode: 0o700 });
    writeFileSync(replacement, script, { mode: 0o700 });
    chmodSync(executable, 0o700);
    chmodSync(replacement, 0o700);

    const adapter = createCommandModelProviderAdapter({
      providerId: 'opencode-go',
      family: 'opencode',
      displayName: 'OpenCode Go',
      executable,
      catalogArgs: ['models'],
      authArgs: ['auth', 'list'],
      authenticatedOutputTokens: ['OpenCode Go'],
      expectedExecutableName: 'opencode',
      versionPattern: /^\d+\.\d+\.\d+$/u,
      cwd: process.cwd(),
      environment: { PATH: directory, OPENCODE_API_KEY: 'opencode-secret' },
    });

    await expect(adapter.probe()).resolves.toMatchObject({
      availability: 'available',
      auth: 'authenticated',
      version: '1.0.0',
    });
    renameSync(replacement, executable);

    await expect(adapter.discoverModels()).rejects.toThrow(/executable provenance changed/);
  });

  it('uses an explicit machine-readable capability surface when configured', async () => {
    const runner: ModelProviderProcessRunner = {
      run: async (spec) => {
        if (spec.args[0] === '--version') return result({ stdout: 'provider-cli 2.0.0\n' });
        if (spec.args[0] === 'capabilities') {
          return result({ stdout: '{"capabilities":["implementation","review"]}\n' });
        }
        return result({ stdout: '[{"id":"provider/discovered"}]\n' });
      },
    };
    const adapter = createCommandModelProviderAdapter({
      providerId: 'gemini',
      family: 'google',
      displayName: 'Gemini',
      executable: '/tmp/provider',
      capabilityArgs: ['capabilities', '--json'],
      catalogArgs: ['models', '--json'],
      processRunner: runner,
      cwd: '/tmp/project',
    });

    await expect(adapter.probe()).resolves.toMatchObject({
      availability: 'available',
      capabilities: ['implementation', 'review'],
    });
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
