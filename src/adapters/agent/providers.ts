import type { AgentExecutionAdapter } from './adapter.js';
import {
  CommandAgentExecutionAdapter,
  type CommandAgentAdapterOptions,
} from './command.js';
import type { AgentProcessRunner } from './process.js';
import type { ModelProviderId } from '../../domain/model-provider.js';

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
        '--ask-for-approval',
        '--ephemeral',
      ],
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
        '--ask-for-approval',
        'never',
        request.instructions,
      ],
    } satisfies CommandAgentAdapterOptions);
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
        '--always-approve',
      ],
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
        '--always-approve',
        '--no-subagents',
        '--no-plan',
        '--disable-web-search',
      ],
    } satisfies CommandAgentAdapterOptions);
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
      ],
      outputFormat: 'json',
      buildArgs: (request) => [
        '--print',
        '--output-format',
        'json',
        '--model',
        request.model,
        '--mode',
        'accept-edits',
        '--disable-slash-commands',
        request.instructions,
      ],
    } satisfies CommandAgentAdapterOptions);
  }
}

export function createGeminiAdapter(options: ProviderAgentAdapterOptions = {}): GeminiAdapter {
  return new GeminiAdapter(options);
}

export type ModelExecutionAdapterBinding = {
  modelProviderId: ModelProviderId;
  adapter: AgentExecutionAdapter;
};
