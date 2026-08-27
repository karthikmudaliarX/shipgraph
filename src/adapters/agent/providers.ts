import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentExecutionAdapter } from './adapter.js';
import {
  CommandAgentExecutionAdapter,
  type CommandAgentAdapterOptions,
} from './command.js';
import {
  createAgentProcessRunner,
  type AgentProcessRunner,
} from './process.js';
import type { ModelProviderId } from '../../domain/model-provider.js';
import { registerModelProviderAdapter } from './model-provider-owner.js';

type ProviderAgentAdapterOptions = {
  enabled?: boolean;
  executable?: string;
  processRunner?: AgentProcessRunner;
  cwd?: string;
  environment?: Readonly<Record<string, string>>;
};

/** Codex's non-interactive, JSONL-producing execution surface. */
export class CodexAdapter extends CommandAgentExecutionAdapter {
  public constructor(options: ProviderAgentAdapterOptions = {}) {
    super({
      ...options,
      provider: 'codex',
      displayName: 'Codex',
      enabled: options.enabled,
      executable: options.executable ?? 'codex',
      probeArgs: ['exec', '--help'],
      requiredProbeTokens: [
        '--json',
        '--model',
        '--cd',
        '--sandbox',
        '--approve-for-me',
        '--ephemeral',
      ],
      requiredVersionTokens: ['codex-cli'],
      expectedExecutableName: 'codex',
      credentialEnvironmentKeys: ['OPENAI_API_KEY', 'CODEX_HOME'],
      outputFormat: 'jsonl',
      buildArgs: (request) => [
        'exec',
        '--json',
        '--ephemeral',
        '--cd',
        request.workspacePath,
        '--model',
        request.model,
        '--sandbox',
        'workspace-write',
        '--approve-for-me',
        request.instructions,
      ],
    } satisfies CommandAgentAdapterOptions);
    registerModelProviderAdapter(this, 'codex');
  }
}

export function createCodexAdapter(options: ProviderAgentAdapterOptions = {}): CodexAdapter {
  return new CodexAdapter(options);
}

/** Grok's single-turn, structured-output command surface. */
export class GrokAdapter extends CommandAgentExecutionAdapter {
  public constructor(options: ProviderAgentAdapterOptions = {}) {
    super({
      ...options,
      provider: 'acp',
      displayName: 'Grok',
      enabled: options.enabled,
      executable: options.executable ?? 'grok',
      probeArgs: ['--help'],
      requiredProbeTokens: [
        '--single',
        '--output-format',
        '--model',
        '--cwd',
        '--permission-mode',
        '--allow',
        '--tools',
        '--disallowed-tools',
        '--no-subagents',
        '--no-plan',
        '--no-memory',
        '--disable-web-search',
        '--sandbox',
      ],
      requiredVersionTokens: ['grok'],
      expectedExecutableName: 'grok',
      credentialEnvironmentKeys: ['XAI_API_KEY'],
      processRunner: createIsolatedGrokProcessRunner(
        options.processRunner ?? createAgentProcessRunner()
      ),
      enforceExecutableProvenance: options.processRunner === undefined,
      outputFormat: 'json',
      buildArgs: (request) => [
        '--single',
        request.instructions,
        '--output-format',
        'json',
        '--model',
        request.model,
        '--cwd',
        request.workspacePath,
        '--permission-mode',
        'dontAsk',
        '--allow',
        'Read',
        '--allow',
        'Grep',
        '--allow',
        'Edit',
        '--allow',
        'Bash',
        '--tools',
        'Read,Grep,Edit,Bash',
        '--disallowed-tools',
        'MCPTool,WebFetch,WebSearch',
        '--no-subagents',
        '--no-plan',
        '--no-memory',
        '--disable-web-search',
        '--sandbox',
        'workspace',
      ],
    } satisfies CommandAgentAdapterOptions);
    registerModelProviderAdapter(this, 'grok');
  }
}

export function createGrokAdapter(options: ProviderAgentAdapterOptions = {}): GrokAdapter {
  return new GrokAdapter(options);
}

/** Antigravity's (`agy`) documented headless JSON execution surface for Gemini. */
export class GeminiAdapter extends CommandAgentExecutionAdapter {
  public constructor(options: ProviderAgentAdapterOptions = {}) {
    super({
      ...options,
      provider: 'acp',
      displayName: 'Gemini',
      enabled: options.enabled,
      executable: options.executable ?? 'agy',
      probeArgs: ['--help'],
      requiredProbeTokens: [
        '--print',
        '--output-format',
        '--model',
        '--mode',
        '--disable-slash-commands',
        '--sandbox',
      ],
      expectedExecutableName: 'agy',
      credentialEnvironmentKeys: [
        'GEMINI_API_KEY',
        'GOOGLE_API_KEY',
        'GOOGLE_GENERATIVE_AI_API_KEY',
      ],
      outputFormat: 'json',
      buildArgs: (request) => [
        '--print',
        request.instructions,
        '--output-format',
        'json',
        '--model',
        request.model,
        '--mode',
        'accept-edits',
        '--disable-slash-commands',
        '--sandbox',
      ],
    } satisfies CommandAgentAdapterOptions);
    registerModelProviderAdapter(this, 'gemini');
  }
}

export function createGeminiAdapter(options: ProviderAgentAdapterOptions = {}): GeminiAdapter {
  return new GeminiAdapter(options);
}

export type ModelExecutionAdapterBinding = {
  modelProviderId: ModelProviderId;
  adapter: AgentExecutionAdapter;
};

/**
 * Grok reads user-level config, sessions, hooks and compatibility integrations
 * from its home directory. Give every ShipGraph invocation an empty private
 * home, while retaining only the provider credential explicitly allow-listed
 * by the command adapter. The directory is removed after each child exits.
 */
function createIsolatedGrokProcessRunner(runner: AgentProcessRunner): AgentProcessRunner {
  return {
    run: async (spec) => {
      const home = mkdtempSync(join(tmpdir(), 'shipgraph-grok-home-'));
      try {
        return await runner.run({
          ...spec,
          env: {
            ...spec.env,
            HOME: home,
            GROK_HOME: home,
            XDG_CONFIG_HOME: home,
            XDG_DATA_HOME: home,
            XDG_CACHE_HOME: home,
            GROK_WORKFLOWS: '0',
          },
        });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  };
}
