import { isAbsolute } from 'node:path';
import type {
  AgentExecutionAdapter,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentProbeResult,
} from './adapter.js';
import {
  AGENT_OUTPUT_LIMIT_BYTES,
  type NormalizedAgentEvidence,
} from '../../domain/agent-run.js';
import {
  createAgentProcessRunner,
  type AgentProcessResult,
  type AgentProcessRunner,
} from './process.js';
import { redactSensitiveText } from './safety.js';

export { redactSensitiveText } from './safety.js';

const OPENCODE_PROVIDER = 'opencode' as const;
const PROBE_TIMEOUT_MS = 5_000;
const MAX_EVENT_TYPES = 64;
const MAX_SUMMARY_LENGTH = 4_096;

const SAFE_INHERITED_ENVIRONMENT = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  // OpenCode can use these provider credentials. They are passed to the
  // child only and are never included in a persisted run record.
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'XAI_API_KEY',
  'OPENCODE_API_KEY',
] as const;

const BLOCKED_ENVIRONMENT_KEYS = /^(?:GIT_|NODE_OPTIONS$|BASH_ENV$|ENV$|CDPATH$|LD_PRELOAD$|DYLD_)/;

export type OpenCodeAdapterOptions = {
  executable?: string;
  processRunner?: AgentProcessRunner;
  /** Explicit test/provider environment additions; never persisted. */
  environment?: Readonly<Record<string, string>>;
};

type ParsedOpenCodeOutput = {
  valid: boolean;
  reason?: string;
  sessionId?: string;
  evidence?: NormalizedAgentEvidence;
};

/** First concrete adapter for the provider-neutral AGENT-001 boundary. */
export class OpenCodeAdapter implements AgentExecutionAdapter {
  public readonly provider = OPENCODE_PROVIDER;
  public readonly capabilities = ['execute'] as const;

  private readonly executable: string;
  private readonly processRunner: AgentProcessRunner;
  private readonly environment: Readonly<Record<string, string>>;

  public constructor(options: OpenCodeAdapterOptions = {}) {
    this.executable = options.executable ?? 'opencode';
    this.processRunner = options.processRunner ?? createAgentProcessRunner();
    this.environment = buildEnvironment(options.environment);
  }

  public async probe(): Promise<AgentProbeResult> {
    const result = await this.processRunner.run({
      command: this.executable,
      args: ['--version'],
      cwd: process.cwd(),
      env: this.environment,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: 8_192,
    });
    if (result.spawnErrorCode !== undefined) {
      return {
        available: false,
        reason: `OpenCode could not be started (${result.spawnErrorCode})`,
      };
    }
    if (result.timedOut) return { available: false, reason: 'OpenCode version probe timed out' };
    if (result.exitCode !== 0) {
      return { available: false, reason: 'OpenCode version probe failed' };
    }
    const version = result.stdout.trim().split(/\r?\n/u)[0]?.trim();
    return version ? { available: true, version } : { available: true };
  }

  public async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    if (request.provider !== this.provider) {
      throw new Error(
        `OpenCode adapter cannot execute provider ${request.provider}; expected ${this.provider}`
      );
    }
    if (!isAbsolute(request.workspacePath)) {
      throw new Error('OpenCode execution requires an absolute verified workspace path');
    }

    const processResult = await this.processRunner.run({
      command: this.executable,
      // `--dir` and `cwd` are both pinned to the exact verified worktree. The
      // command is spawned without a shell, so instructions remain one argv
      // value and cannot become shell syntax.
      args: [
        'run',
        '--format',
        'json',
        '--dir',
        request.workspacePath,
        '--model',
        request.model,
        '--auto',
        request.instructions,
      ],
      cwd: request.workspacePath,
      env: this.environment,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: Math.min(request.maxOutputBytes, AGENT_OUTPUT_LIMIT_BYTES),
      signal: request.signal,
      onStarted: request.onProcessStarted,
    });

    return normalizeOpenCodeResult(processResult);
  }
}

export function createOpenCodeAdapter(options: OpenCodeAdapterOptions = {}): OpenCodeAdapter {
  return new OpenCodeAdapter(options);
}

function buildEnvironment(
  additions: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const key of SAFE_INHERITED_ENVIRONMENT) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(additions ?? {})) {
    if (BLOCKED_ENVIRONMENT_KEYS.test(key)) {
      throw new Error(`Refusing unsafe OpenCode environment variable: ${key}`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new Error(`Invalid OpenCode environment variable name: ${key}`);
    }
    environment[key] = value;
  }
  environment.OPENCODE_CLIENT = 'shipgraph';
  return environment;
}

function normalizeOpenCodeResult(result: AgentProcessResult): AgentExecutionResult {
  const parsed = parseJsonLines(result.stdout, result.stdoutTruncated);
  const common = {
    ...(result.processId === undefined ? {} : { providerProcessId: result.processId }),
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ...(result.terminationSignal === undefined
      ? {}
      : { terminationSignal: result.terminationSignal }),
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    stdout: redactSensitiveText(result.stdout),
    stderr: redactSensitiveText(result.stderr),
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
  };

  if (result.spawnErrorCode === 'ENOENT') {
    return {
      ...common,
      outcome: 'FAILED',
      failureCategory: 'executable_missing',
      failureReason: 'The configured OpenCode executable was not found',
    };
  }
  if (result.spawnErrorCode === 'EACCES') {
    return {
      ...common,
      outcome: 'FAILED',
      failureCategory: 'executable_unavailable',
      failureReason: 'The configured OpenCode executable could not be executed',
    };
  }
  if (result.startError !== undefined) {
    return {
      ...common,
      outcome: 'NEEDS_HUMAN',
      failureCategory: 'adapter_error',
      failureReason: 'OpenCode process startup bookkeeping failed',
    };
  }
  if (result.timedOut) {
    return {
      ...common,
      outcome: 'TIMED_OUT',
      failureCategory: 'timeout',
      failureReason: 'OpenCode exceeded the configured execution timeout',
    };
  }
  if (result.cancelled) {
    return {
      ...common,
      outcome: 'CANCELLED',
      failureCategory: 'cancelled',
      failureReason: 'OpenCode execution was cancelled',
    };
  }
  if (result.unexpectedTermination) {
    return {
      ...common,
      outcome: 'FAILED',
      failureCategory: 'unexpected_termination',
      failureReason: 'OpenCode terminated without an exit code or signal',
    };
  }
  if (result.outputLimitExceeded) {
    return {
      ...common,
      outcome: 'FAILED',
      failureCategory: 'output_limit',
      failureReason: 'OpenCode output exceeded ShipGraph’s retained-output limit',
      ...(parsed.evidence === undefined ? {} : { evidence: parsed.evidence }),
      ...(parsed.sessionId === undefined ? {} : { providerSessionId: parsed.sessionId }),
    };
  }
  if (result.terminationSignal !== undefined) {
    return {
      ...common,
      outcome: 'FAILED',
      failureCategory: 'unexpected_termination',
      failureReason: `OpenCode was terminated by ${result.terminationSignal}`,
      ...(parsed.evidence === undefined ? {} : { evidence: parsed.evidence }),
      ...(parsed.sessionId === undefined ? {} : { providerSessionId: parsed.sessionId }),
    };
  }
  if (result.exitCode !== 0) {
    return {
      ...common,
      outcome: 'FAILED',
      failureCategory: 'non_zero_exit',
      failureReason:
        result.exitCode === undefined
          ? 'OpenCode did not report a successful exit code'
          : `OpenCode exited with code ${result.exitCode}`,
      ...(parsed.evidence === undefined ? {} : { evidence: parsed.evidence }),
      ...(parsed.sessionId === undefined ? {} : { providerSessionId: parsed.sessionId }),
    };
  }
  if (!parsed.valid) {
    return {
      ...common,
      outcome: 'FAILED',
      failureCategory: parsed.reason === 'OpenCode produced no JSON events' ? 'missing_output' : 'malformed_output',
      failureReason: parsed.reason ?? 'OpenCode output was not valid JSONL',
    };
  }

  return {
    ...common,
    outcome: 'SUCCEEDED',
    ...(parsed.evidence === undefined ? {} : { evidence: parsed.evidence }),
    ...(parsed.sessionId === undefined ? {} : { providerSessionId: parsed.sessionId }),
  };
}

function parseJsonLines(stdout: string, truncated: boolean): ParsedOpenCodeOutput {
  if (truncated) {
    return { valid: false, reason: 'OpenCode JSONL output was truncated before it could be verified' };
  }
  const lines = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return { valid: false, reason: 'OpenCode produced no JSON events' };

  const eventTypes: string[] = [];
  const eventTypeSet = new Set<string>();
  let sessionId: string | undefined;
  let summary: string | undefined;
  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      return { valid: false, reason: 'OpenCode emitted malformed JSONL output' };
    }
    if (!isObject(event)) return { valid: false, reason: 'OpenCode emitted a non-object JSON event' };

    const type = firstString(event, ['type', 'event', 'eventType']);
    if (type !== undefined && !eventTypeSet.has(type)) {
      eventTypeSet.add(type);
      if (eventTypes.length < MAX_EVENT_TYPES) eventTypes.push(type);
    }
    sessionId ??= firstString(event, ['sessionID', 'sessionId', 'session_id']);
    const eventText = extractEventText(event);
    if (eventText !== undefined) {
      summary = boundText(redactSensitiveText(eventText), MAX_SUMMARY_LENGTH);
    }
  }

  return {
    valid: true,
    ...(sessionId === undefined ? {} : { sessionId }),
    evidence: {
      outputFormat: 'jsonl',
      eventCount: lines.length,
      eventTypes,
      ...(summary === undefined ? {} : { summary }),
    },
  };
}

function extractEventText(event: Record<string, unknown>): string | undefined {
  const direct = firstString(event, ['text', 'summary', 'message', 'result']);
  if (direct !== undefined) return direct;
  for (const key of ['part', 'data', 'payload']) {
    const nested = event[key];
    if (isObject(nested)) {
      const value = firstString(nested, ['text', 'summary', 'message', 'result']);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function firstString(object: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}
