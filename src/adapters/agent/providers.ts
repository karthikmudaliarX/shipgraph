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

const AGY_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

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
        '--approve-for-me',
        '--ephemeral',
      ],
      requiredVersionTokens: ['codex-cli'],
      expectedExecutableName: 'codex',
      credentialEnvironmentKeys: ['OPENAI_API_KEY', 'CODEX_HOME'],
      outputFormat: 'jsonl',
      buildArgs: (request) => [
        // --approve-for-me supplies Codex's workspace-write sandbox; combining
        // it with --sandbox is rejected by the current CLI.
        'exec',
        '--json',
        '--ephemeral',
        '--cd',
        request.workspacePath,
        '--model',
        request.model,
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
      credentialEnvironmentKeys: ['XAI_API_KEY', 'GROK_HOME'],
      processRunner: options.processRunner ?? createAgentProcessRunner(),
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
        'run_terminal_cmd,grep,read_file,search_replace',
        '--disallowed-tools',
        'web_search,web_fetch,search_tool,use_tool,Agent',
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
      versionPattern: AGY_VERSION_PATTERN,
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
