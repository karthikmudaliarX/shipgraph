import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, isAbsolute, resolve } from 'node:path';
import type {
  AgentExecutionAdapter,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentProbeResult,
  AgentProvider,
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

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_OUTPUT_BYTES = 16 * 1024;
const MAX_EVENT_TYPES = 64;
const MAX_SUMMARY_LENGTH = 4_096;

export type CommandAgentOutputFormat = 'json' | 'jsonl';

export type CommandAgentAdapterOptions = {
  provider: AgentProvider;
  displayName: string;
  enabled?: boolean;
  executable?: string;
  probeArgs: readonly string[];
  requiredProbeTokens: readonly string[];
  /** Tokens that identify the vendor's version output, when available. */
  requiredVersionTokens?: readonly string[];
  /** Optional provider-specific format check for the first version line. */
  versionPattern?: RegExp;
  /** Name the configured command must have before it is considered this adapter. */
  expectedExecutableName?: string;
  /** Credentials/configuration allowed to cross this provider's process boundary. */
  credentialEnvironmentKeys?: readonly string[];
  outputFormat: CommandAgentOutputFormat;
  buildArgs: (request: AgentExecutionRequest) => readonly string[];
  processRunner?: AgentProcessRunner;
  /** Override only when a provider wrapper still preserves production provenance checks. */
  enforceExecutableProvenance?: boolean;
  cwd?: string;
  environment?: Readonly<Record<string, string>>;
};

export type CommandSurfaceProbeOptions = {
  displayName: string;
  enabled?: boolean;
  executable?: string;
  probeArgs: readonly string[];
  requiredProbeTokens: readonly string[];
  requiredVersionTokens?: readonly string[];
  /** Optional provider-specific format check for the first version line. */
  versionPattern?: RegExp;
  expectedExecutableName?: string;
  /** Original configured name, kept separate from the canonical pinned path. */
  configuredExecutable?: string;
  processRunner: AgentProcessRunner;
  cwd: string;
  environment: Readonly<Record<string, string>>;
};

/** Probe an installed command and the exact headless flags an adapter uses. */
export async function probeCommandSurface(
  options: CommandSurfaceProbeOptions
): Promise<AgentProbeResult> {
  if (options.enabled === false) {
    return {
      available: false,
      reason: `${options.displayName} execution is disabled by configuration`,
    };
  }
  if (options.executable === undefined) {
    return {
      available: false,
      reason: `${options.displayName} execution executable is not configured`,
    };
  }

  const executableName = options.configuredExecutable ?? options.executable;
  if (
    options.expectedExecutableName !== undefined &&
    basename(executableName) !== options.expectedExecutableName
  ) {
    return {
      available: false,
      reason:
        `${options.displayName} executable name ${basename(executableName)} ` +
        `does not match ${options.expectedExecutableName}`,
    };
  }

  const run = (args: readonly string[]): Promise<AgentProcessResult> =>
    options.processRunner.run({
      command: options.executable as string,
      args,
      cwd: options.cwd,
      env: options.environment,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: PROBE_OUTPUT_BYTES,
    });
  const version = await run(['--version']);
  const versionFailure = probeFailure(version, `${options.displayName} version probe`);
  if (versionFailure !== undefined) return { available: false, reason: versionFailure };
  const versionOutput = `${version.stdout}\n${version.stderr}`;
  const missingVersionToken = (options.requiredVersionTokens ?? []).find(
    (token) => !versionOutput.includes(token)
  );
  if (missingVersionToken !== undefined) {
    return {
      available: false,
      reason:
        `${options.displayName} version probe did not identify the expected executable ` +
        `(missing ${missingVersionToken})`,
    };
  }

  const capability = await run(options.probeArgs);
  const capabilityFailure = probeFailure(
    capability,
    `${options.displayName} execution capability probe`
  );
  if (capabilityFailure !== undefined) return { available: false, reason: capabilityFailure };

  const output = `${capability.stdout}\n${capability.stderr}`;
  const missing = options.requiredProbeTokens.find((token) => !output.includes(token));
  if (missing !== undefined) {
    return {
      available: false,
      reason: `${options.displayName} execution capability probe did not advertise ${missing}`,
    };
  }
  const firstLine = firstOutputLine(version.stdout || version.stderr);
  if (options.versionPattern !== undefined &&
      (firstLine === undefined || !options.versionPattern.test(firstLine))) {
    return {
      available: false,
      reason: `${options.displayName} version probe did not match the expected identity format`,
    };
  }
  return firstLine === undefined
    ? { available: true }
    : { available: true, version: firstLine };
}

/**
 * Safe command-backed implementation for providers with a documented
 * headless CLI. It proves the executable and the exact automation flags with
 * --help before a provider can be marked execution-available. It never uses a
 * shell and never persists the supplied prompt or environment.
 */
export class CommandAgentExecutionAdapter implements AgentExecutionAdapter {
  public readonly provider: AgentProvider;
  public readonly capabilities = ['execute'] as const;

  private readonly displayName: string;
  private readonly enabled: boolean;
  private readonly executable: string | undefined;
  private readonly probeArgs: readonly string[];
  private readonly requiredProbeTokens: readonly string[];
  private readonly requiredVersionTokens: readonly string[];
  private readonly versionPattern: RegExp | undefined;
  private readonly expectedExecutableName: string | undefined;
  private readonly credentialEnvironmentKeys: readonly string[];
  private readonly outputFormat: CommandAgentOutputFormat;
  private readonly buildArgs: (request: AgentExecutionRequest) => readonly string[];
  private readonly processRunner: AgentProcessRunner;
  private readonly cwd: string;
  private readonly environment: Readonly<Record<string, string>>;
  private readonly enforceExecutableProvenance: boolean;
  private resolvedExecutable: ResolvedExecutable | undefined;

  public constructor(options: CommandAgentAdapterOptions) {
    this.provider = options.provider;
    this.displayName = validateText(options.displayName, 'agent display name', 128);
    this.enabled = options.enabled ?? true;
    this.executable = validateExecutable(options.executable);
    this.probeArgs = options.probeArgs.map((arg) => validateArgument(arg));
    this.requiredProbeTokens = options.requiredProbeTokens.map((token) =>
      validateText(token, 'agent capability token', 256)
    );
    this.requiredVersionTokens = (options.requiredVersionTokens ?? []).map((token) =>
      validateText(token, 'agent version identity token', 256)
    );
    this.versionPattern = options.versionPattern === undefined
      ? undefined
      : new RegExp(options.versionPattern.source, options.versionPattern.flags.replace('g', ''));
    this.expectedExecutableName = options.expectedExecutableName === undefined
      ? undefined
      : validateText(options.expectedExecutableName, 'agent executable name', 256);
    this.credentialEnvironmentKeys = (options.credentialEnvironmentKeys ?? []).map((key) =>
      validateEnvironmentKey(key)
    );
    if (this.probeArgs.length === 0 || this.requiredProbeTokens.length === 0) {
      throw new Error('agent capability probe must define command arguments and required tokens');
    }
    this.outputFormat = options.outputFormat;
    this.buildArgs = options.buildArgs;
    this.processRunner = options.processRunner ?? createAgentProcessRunner();
    this.cwd = options.cwd ?? process.cwd();
    if (!isAbsolute(this.cwd)) throw new Error('Agent probes require an absolute cwd');
    this.environment = buildEnvironment(options.environment, this.credentialEnvironmentKeys);
    // A custom runner is a deliberate dependency-injection boundary used by
    // tests and embedding applications. The production runner resolves and
    // pins the executable below before it can launch a provider.
    this.enforceExecutableProvenance = options.enforceExecutableProvenance ??
      options.processRunner === undefined;
  }

  public async probe(): Promise<AgentProbeResult> {
    const resolved = this.enforceExecutableProvenance && this.enabled
      ? this.resolveExecutable()
      : undefined;
    if (this.enforceExecutableProvenance && this.enabled && resolved === undefined) {
      return {
        available: false,
        reason: `${this.displayName} executable was not found or is not executable`,
      };
    }
    const result = await probeCommandSurface({
      displayName: this.displayName,
      enabled: this.enabled,
      executable: resolved?.path ?? this.executable,
      configuredExecutable: this.executable,
      probeArgs: this.probeArgs,
      requiredProbeTokens: this.requiredProbeTokens,
      requiredVersionTokens: this.requiredVersionTokens,
      versionPattern: this.versionPattern,
      expectedExecutableName: this.expectedExecutableName,
      processRunner: this.processRunner,
      cwd: this.cwd,
      environment: this.environment,
    });
    this.resolvedExecutable = result.available ? resolved : undefined;
    return result;
  }

  public async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    if (request.provider !== this.provider) {
      throw new Error(
        `${this.displayName} adapter cannot execute provider ${request.provider}; expected ${this.provider}`
      );
    }
    if (!isAbsolute(request.workspacePath)) {
      throw new Error(`${this.displayName} execution requires an absolute verified workspace path`);
    }
    if (request.model.length === 0 || request.model.includes('\0')) {
      throw new Error(`${this.displayName} execution requires a valid model identifier`);
    }
    if (request.instructions.length === 0 || request.instructions.includes('\0')) {
      throw new Error(`${this.displayName} execution requires valid instructions`);
    }

    const processResult = await this.processRunner.run({
      command: this.executableForExecution(),
      args: [...this.buildArgs(request)],
      cwd: request.workspacePath,
      env: this.environment,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: Math.min(request.maxOutputBytes, AGENT_OUTPUT_LIMIT_BYTES),
      signal: request.signal,
      onStarted: request.onProcessStarted,
    });

    return normalizeCommandResult(processResult, this.displayName, this.outputFormat);
  }

  private executableForExecution(): string {
    if (this.executable === undefined) {
      throw new Error(`${this.displayName} execution executable is not configured`);
    }
    if (!this.enforceExecutableProvenance) return this.executable;
    if (this.resolvedExecutable === undefined) {
      throw new Error(`${this.displayName} execution requires a successful capability probe`);
    }
    const current = this.resolveExecutable();
    if (current === undefined || !sameExecutable(current, this.resolvedExecutable)) {
      throw new Error(
        `${this.displayName} executable provenance changed after capability probing; refusing launch`
      );
    }
    return current.path;
  }

  private resolveExecutable(): ResolvedExecutable | undefined {
    if (this.executable === undefined) return undefined;
    return resolveExecutable(this.executable, this.cwd, this.environment.PATH);
  }

}

export function normalizeCommandResult(
  result: AgentProcessResult,
  displayName: string,
  outputFormat: CommandAgentOutputFormat
): AgentExecutionResult {
  const parsed = parseCommandOutput(result.stdout, result.stdoutTruncated, outputFormat);
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
      failureReason: `The configured ${displayName} executable was not found`,
    };
  }
  if (result.spawnErrorCode === 'EACCES') {
    return {
      ...common,
      outcome: 'FAILED',
      failureCategory: 'executable_unavailable',
      failureReason: `The configured ${displayName} executable could not be executed`,
    };
  }
  if (result.startError !== undefined) {
    return {
      ...common,
      outcome: 'NEEDS_HUMAN',
      failureCategory: 'adapter_error',
      failureReason: `${displayName} process startup bookkeeping failed`,
    };
  }
  if (result.timedOut) {
    return {
      ...common,
      outcome: 'TIMED_OUT',
      failureCategory: 'timeout',
      failureReason: `${displayName} exceeded the configured execution timeout`,
    };
  }
  if (result.cancelled) {
    return {
      ...common,
      outcome: 'CANCELLED',
      failureCategory: 'cancelled',
      failureReason: `${displayName} execution was cancelled`,
    };
  }
  if (result.unexpectedTermination) {
    return {
      ...common,
      outcome: 'FAILED',
      failureCategory: 'unexpected_termination',
      failureReason: `${displayName} terminated without an exit code or signal`,
    };
  }
  if (result.outputLimitExceeded) {
    return {
      ...common,
      outcome: 'FAILED',
      failureCategory: 'output_limit',
      failureReason: `${displayName} output exceeded ShipGraph’s retained-output limit`,
      ...parsedEvidence(parsed),
    };
  }
  if (result.terminationSignal !== undefined) {
    return {
      ...common,
      outcome: 'FAILED',
      failureCategory: 'unexpected_termination',
      failureReason: `${displayName} was terminated by ${result.terminationSignal}`,
      ...parsedEvidence(parsed),
    };
  }
  if (result.exitCode !== 0) {
    return {
      ...common,
      outcome: 'FAILED',
      failureCategory: 'non_zero_exit',
      failureReason:
        result.exitCode === undefined
          ? `${displayName} did not report a successful exit code`
          : `${displayName} exited with code ${result.exitCode}`,
      ...parsedEvidence(parsed),
    };
  }
  if (!parsed.valid) {
    return {
      ...common,
      outcome: 'FAILED',
      failureCategory: parsed.reason === `${displayName} produced no structured output`
        ? 'missing_output'
        : 'malformed_output',
      failureReason: parsed.reason ?? `${displayName} output was not valid structured JSON`,
    };
  }

  return {
    ...common,
    outcome: 'SUCCEEDED',
    ...parsedEvidence(parsed),
  };
}

type ParsedCommandOutput = {
  valid: boolean;
  reason?: string;
  sessionId?: string;
  evidence?: NormalizedAgentEvidence;
};

function parseCommandOutput(
  stdout: string,
  truncated: boolean,
  outputFormat: CommandAgentOutputFormat
): ParsedCommandOutput {
  if (truncated) {
    return { valid: false, reason: 'provider structured output was truncated before it could be verified' };
  }
  const output = redactSensitiveText(stdout).trim();
  if (output.length === 0) return { valid: false, reason: 'provider produced no structured output' };

  let parsed: unknown;
  try {
    parsed = outputFormat === 'jsonl'
      ? parseJsonLines(output)
      : JSON.parse(output) as unknown;
  } catch {
    return { valid: false, reason: 'provider emitted malformed structured JSON' };
  }

  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (entries.length === 0 || entries.some((entry) => !isObject(entry))) {
    return { valid: false, reason: 'provider emitted a non-object structured event' };
  }
  if (entries.some((entry) => hasErrorPayload(entry))) {
    return { valid: false, reason: 'provider returned an error payload' };
  }

  const eventTypes: string[] = [];
  const eventTypeSet = new Set<string>();
  let sessionId: string | undefined;
  let summary: string | undefined;
  for (const entry of entries) {
    const type = firstString(entry, ['type', 'event', 'eventType', 'event_type']);
    if (type !== undefined && !eventTypeSet.has(type)) {
      eventTypeSet.add(type);
      if (eventTypes.length < MAX_EVENT_TYPES) eventTypes.push(type);
    }
    sessionId ??= findString(entry, ['sessionID', 'sessionId', 'session_id', 'conversationId']);
    const eventText = extractEventText(entry);
    if (eventText !== undefined) {
      summary = boundText(eventText, MAX_SUMMARY_LENGTH);
    }
  }

  return {
    valid: true,
    ...(sessionId === undefined ? {} : { sessionId }),
    evidence: {
      outputFormat,
      eventCount: entries.length,
      eventTypes,
      ...(summary === undefined ? {} : { summary }),
    },
  };
}

function parseJsonLines(output: string): readonly unknown[] {
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error('empty JSONL');
  return lines.map((line) => JSON.parse(line) as unknown);
}

function hasErrorPayload(entry: Record<string, unknown>): boolean {
  const error = entry.error;
  return (typeof error === 'string' && error.length > 0) || isObject(error);
}

function extractEventText(entry: Record<string, unknown>): string | undefined {
  const direct = firstString(entry, ['text', 'summary', 'message', 'result', 'response', 'content']);
  if (direct !== undefined) return direct;
  for (const key of ['part', 'data', 'payload', 'msg', 'message']) {
    const nested = entry[key];
    if (isObject(nested)) {
      const value = firstString(nested, ['text', 'summary', 'message', 'result', 'response', 'content']);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function findString(entry: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const direct = firstString(entry, keys);
  if (direct !== undefined) return direct;
  for (const value of Object.values(entry)) {
    if (isObject(value)) {
      const nested = firstString(value, keys);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function firstString(entry: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function parsedEvidence(parsed: ParsedCommandOutput): Record<string, unknown> {
  return {
    ...(parsed.evidence === undefined ? {} : { evidence: parsed.evidence }),
    ...(parsed.sessionId === undefined ? {} : { providerSessionId: parsed.sessionId }),
  };
}

function probeFailure(result: AgentProcessResult, label: string): string | undefined {
  if (result.spawnErrorCode === 'ENOENT') return `${label} executable was not found`;
  if (result.spawnErrorCode === 'EACCES') return `${label} executable could not be executed`;
  if (result.startError !== undefined) return `${label} could not be started`;
  if (result.timedOut) return `${label} timed out`;
  if (result.cancelled || result.unexpectedTermination) return `${label} terminated unexpectedly`;
  if (result.outputLimitExceeded || result.stdoutTruncated || result.stderrTruncated) {
    return `${label} output exceeded the safety limit`;
  }
  if (result.exitCode !== 0) return `${label} failed`;
  return undefined;
}

function firstOutputLine(value: string): string | undefined {
  const firstLine = redactSensitiveText(value).split(/\r?\n/u)[0];
  if (firstLine === undefined) return undefined;
  const sanitized = firstLine
    .split('')
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .trim();
  return sanitized.length === 0 ? undefined : sanitized.slice(0, 256);
}

function buildEnvironment(
  additions: Readonly<Record<string, string>> | undefined,
  credentialEnvironmentKeys: readonly string[]
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  const allowedCredentials = new Set(credentialEnvironmentKeys);
  for (const key of SAFE_INHERITED_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  for (const key of allowedCredentials) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(additions ?? {})) {
    if (BLOCKED_ENVIRONMENT_KEYS.test(key)) {
      throw new Error(`Refusing unsafe agent environment variable: ${key}`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || value.includes('\0')) {
      throw new Error(`Invalid agent environment variable: ${key}`);
    }
    if (PROVIDER_CREDENTIAL_ENVIRONMENT_KEYS.has(key) && !allowedCredentials.has(key)) {
      // The adapter factory shares explicit additions among providers. Known
      // credentials are filtered so one provider's secret cannot cross into
      // another provider's process boundary.
      continue;
    }
    environment[key] = value;
  }
  return environment;
}

const SAFE_INHERITED_ENVIRONMENT_KEYS = [
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
] as const;

const PROVIDER_CREDENTIAL_ENVIRONMENT_KEYS = new Set([
  'CODEX_HOME',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'XAI_API_KEY',
  'OPENAI_API_KEY',
  'OPENCODE_API_KEY',
]);

const BLOCKED_ENVIRONMENT_KEYS = /^(?:GIT_|NODE_OPTIONS$|BASH_ENV$|ENV$|CDPATH$|LD_PRELOAD$|DYLD_)/u;

function validateExecutable(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return validateText(value, 'agent executable', 4_096);
}

function validateEnvironmentKey(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new Error(`Invalid agent credential environment variable: ${value}`);
  }
  return value;
}

function validateArgument(value: string): string {
  return validateText(value, 'agent command argument', 4_096);
}

function validateText(value: string, label: string, maxLength: number): string {
  if (value.length === 0 || value.length > maxLength || value.includes('\0')) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export type ResolvedExecutable = {
  path: string;
  device: string;
  inode: string;
};

export function resolveExecutable(
  executable: string,
  cwd: string,
  pathValue: string | undefined
): ResolvedExecutable | undefined {
  const candidates = executable.includes('/')
    ? [isAbsolute(executable) ? executable : resolve(cwd, executable)]
    : (pathValue ?? '').split(delimiter)
        .filter((directory) => directory.length > 0)
        .map((directory) => resolve(directory, executable));
  for (const candidate of candidates) {
    try {
      const path = realpathSync(candidate);
      const stats = statSync(path, { bigint: true });
      accessSync(path, constants.X_OK);
      if (!stats.isFile()) continue;
      return { path, device: stats.dev.toString(), inode: stats.ino.toString() };
    } catch {
      // Failure to resolve is unavailable, not a reason to invoke a fallback.
    }
  }
  return undefined;
}

export function sameExecutable(left: ResolvedExecutable, right: ResolvedExecutable): boolean {
  return left.path === right.path && left.device === right.device && left.inode === right.inode;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}
