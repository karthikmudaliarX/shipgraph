import { isAbsolute } from 'node:path';
import type { AgentProcessResult, AgentProcessRunner } from '../agent/process.js';
import { createAgentProcessRunner } from '../agent/process.js';
import { redactSensitiveText } from '../agent/safety.js';
import { compareStableStrings } from '../../utils/sorting.js';
import {
  MODEL_CAPABILITIES,
  MODEL_PROVIDER_DEFINITIONS,
  modelProviderIdSchema,
  type ModelCapability,
  type ModelProviderId,
  type ProviderAuthStatus,
  type ProviderAvailability,
  type KnownNumber,
  type KnownTimestamp,
  type QuotaPressure,
} from '../../domain/model-provider.js';

const PROBE_TIMEOUT_MS = 5_000;
const CATALOG_TIMEOUT_MS = 15_000;
const PROBE_OUTPUT_BYTES = 8 * 1024;
const CAPABILITY_OUTPUT_BYTES = 8 * 1024;
const CATALOG_OUTPUT_BYTES = 256 * 1024;
const MAX_CATALOG_MODELS = 10_000;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u;

export type ModelProviderProcessRunner = Pick<AgentProcessRunner, 'run'>;

export type ProviderProbeResult = {
  availability: ProviderAvailability;
  auth: ProviderAuthStatus;
  version?: string;
  capabilities: readonly ModelCapability[];
  quotaPressure?: QuotaPressure;
  quotaRemaining?: KnownNumber;
  quotaResetAt?: KnownTimestamp;
  reason?: string;
};

type CapabilityProbeResult =
  | { status: 'known'; capabilities: readonly ModelCapability[] }
  | { status: 'unknown'; reason: string };

export type DiscoveredModel = {
  modelId: string;
  capabilities: readonly ModelCapability[];
  contextWindow?: number;
};

export type ModelDiscoveryResult =
  | { status: 'known'; models: readonly DiscoveredModel[] }
  | { status: 'unknown'; reason: string };

export interface ModelProviderAdapter {
  readonly providerId: ModelProviderId;
  readonly family: string;
  readonly displayName: string;
  probe(): Promise<ProviderProbeResult>;
  discoverModels(): Promise<ModelDiscoveryResult>;
}

export type CommandModelProviderAdapterOptions = {
  providerId: ModelProviderId;
  family: string;
  displayName: string;
  enabled?: boolean;
  executable?: string;
  capabilityArgs?: readonly string[];
  catalogArgs?: readonly string[];
  processRunner?: ModelProviderProcessRunner;
  cwd?: string;
  environment?: Readonly<Record<string, string>>;
  capabilities?: readonly ModelCapability[];
};

export type ModelProviderAdapterConfiguration = {
  enabled?: boolean;
  executable?: string;
  capabilityArgs?: readonly string[];
  catalogArgs?: readonly string[];
};

export type ModelProviderConfiguration = Partial<{
  opencodeGo: ModelProviderAdapterConfiguration;
  codex: ModelProviderAdapterConfiguration;
  grok: ModelProviderAdapterConfiguration;
  gemini: ModelProviderAdapterConfiguration;
}>;

/**
 * A small command-backed adapter for provider metadata only. It never invokes
 * a model and never asks an LLM to discover a catalog.
 */
export class CommandModelProviderAdapter implements ModelProviderAdapter {
  public readonly providerId: ModelProviderId;
  public readonly family: string;
  public readonly displayName: string;

  private readonly enabled: boolean;
  private readonly executable: string | undefined;
  private readonly capabilityArgs: readonly string[] | undefined;
  private readonly catalogArgs: readonly string[] | undefined;
  private readonly processRunner: ModelProviderProcessRunner;
  private readonly cwd: string;
  private readonly environment: Readonly<Record<string, string>>;
  private readonly capabilities: readonly ModelCapability[];

  public constructor(options: CommandModelProviderAdapterOptions) {
    this.providerId = modelProviderIdSchema.parse(options.providerId);
    this.family = validateText(options.family, 'provider family', 128);
    this.displayName = validateText(options.displayName, 'provider display name', 128);
    this.enabled = options.enabled ?? true;
    this.executable = validateExecutable(options.executable);
    this.capabilityArgs = options.capabilityArgs?.map((arg) => validateArgument(arg));
    this.catalogArgs = options.catalogArgs?.map((arg) => validateArgument(arg));
    this.processRunner = options.processRunner ?? createAgentProcessRunner();
    this.cwd = options.cwd ?? process.cwd();
    if (!isAbsolute(this.cwd)) throw new Error('Provider metadata probes require an absolute cwd');
    this.environment = buildEnvironment(options.environment);
    this.capabilities = normalizeCapabilities(options.capabilities ?? MODEL_CAPABILITIES);
  }

  public async probe(): Promise<ProviderProbeResult> {
    if (!this.enabled) {
      return {
        availability: 'disabled',
        auth: 'unknown',
        capabilities: [],
        reason: 'provider is disabled by configuration',
      };
    }
    if (this.executable === undefined) {
      return {
        availability: 'unknown',
        auth: 'unknown',
        capabilities: [],
        reason: 'provider executable is not configured',
      };
    }

    const result = await this.run(['--version'], PROBE_TIMEOUT_MS, PROBE_OUTPUT_BYTES);
    if (result.spawnErrorCode === 'ENOENT') {
      return {
        availability: 'unavailable',
        auth: 'unknown',
        capabilities: [],
        reason: 'provider executable was not found',
      };
    }
    if (result.spawnErrorCode === 'EACCES') {
      return {
        availability: 'unavailable',
        auth: 'unknown',
        capabilities: [],
        reason: 'provider executable could not be executed',
      };
    }
    if (result.timedOut || result.cancelled || result.unexpectedTermination) {
      return {
        availability: 'unknown',
        auth: 'unknown',
        capabilities: [],
        reason: result.timedOut
          ? 'provider version probe timed out'
          : 'provider version probe terminated unexpectedly',
      };
    }
    if (result.outputLimitExceeded || result.stdoutTruncated || result.stderrTruncated) {
      return {
        availability: 'unknown',
        auth: 'unknown',
        capabilities: [],
        reason: 'provider version output exceeded the safety limit',
      };
    }
    if (result.exitCode !== 0 || result.startError !== undefined) {
      return {
        availability: 'unavailable',
        auth: 'unknown',
        capabilities: [],
        reason: 'provider version probe failed',
      };
    }

    const version = firstOutputLine(result.stdout);
    const capabilities = this.capabilityArgs === undefined
      ? { status: 'known' as const, capabilities: this.capabilities }
      : await this.probeCapabilities();
    if (capabilities.status === 'unknown') {
      return {
        availability: 'unknown',
        auth: 'unknown',
        capabilities: [],
        reason: capabilities.reason,
      };
    }
    return {
      availability: 'available',
      // A version command proves an installed surface, not login state.
      auth: 'unknown',
      ...(version === undefined ? {} : { version }),
      capabilities: capabilities.capabilities,
    };
  }

  public async discoverModels(): Promise<ModelDiscoveryResult> {
    if (!this.enabled) return { status: 'unknown', reason: 'provider is disabled by configuration' };
    if (this.executable === undefined) {
      return { status: 'unknown', reason: 'provider executable is not configured' };
    }
    if (this.catalogArgs === undefined) {
      return { status: 'unknown', reason: 'provider does not expose a configured catalog surface' };
    }

    const result = await this.run(this.catalogArgs, CATALOG_TIMEOUT_MS, CATALOG_OUTPUT_BYTES);
    if (result.spawnErrorCode !== undefined || result.startError !== undefined) {
      return { status: 'unknown', reason: 'provider catalog surface could not be started' };
    }
    if (result.timedOut) return { status: 'unknown', reason: 'provider catalog surface timed out' };
    if (result.cancelled || result.unexpectedTermination) {
      return { status: 'unknown', reason: 'provider catalog surface terminated unexpectedly' };
    }
    if (result.outputLimitExceeded || result.stdoutTruncated || result.stderrTruncated) {
      return { status: 'unknown', reason: 'provider catalog output exceeded the safety limit' };
    }
    if (result.exitCode !== 0) {
      return { status: 'unknown', reason: 'provider catalog surface failed' };
    }
    return parseModelCatalog(result.stdout, this.capabilities);
  }

  private run(
    args: readonly string[],
    timeoutMs: number,
    maxOutputBytes: number
  ): Promise<AgentProcessResult> {
    return this.processRunner.run({
      command: this.executable as string,
      args,
      cwd: this.cwd,
      env: this.environment,
      timeoutMs,
      maxOutputBytes,
    });
  }

  private async probeCapabilities(): Promise<CapabilityProbeResult> {
    const result = await this.run(
      this.capabilityArgs ?? [],
      PROBE_TIMEOUT_MS,
      CAPABILITY_OUTPUT_BYTES
    );
    if (result.spawnErrorCode !== undefined || result.startError !== undefined) {
      return { status: 'unknown', reason: 'provider capability surface could not be started' };
    }
    if (result.timedOut) return { status: 'unknown', reason: 'provider capability surface timed out' };
    if (result.cancelled || result.unexpectedTermination) {
      return { status: 'unknown', reason: 'provider capability surface terminated unexpectedly' };
    }
    if (result.outputLimitExceeded || result.stdoutTruncated || result.stderrTruncated) {
      return { status: 'unknown', reason: 'provider capability output exceeded the safety limit' };
    }
    if (result.exitCode !== 0) {
      return { status: 'unknown', reason: 'provider capability surface failed' };
    }
    return parseCapabilities(result.stdout);
  }
}

export function createCommandModelProviderAdapter(
  options: CommandModelProviderAdapterOptions
): CommandModelProviderAdapter {
  return new CommandModelProviderAdapter(options);
}

export function createModelProviderAdapters(options: {
  configuration?: ModelProviderConfiguration;
  processRunner?: ModelProviderProcessRunner;
  cwd?: string;
  environment?: Readonly<Record<string, string>>;
} = {}): readonly ModelProviderAdapter[] {
  const defaults: Record<ModelProviderId, {
    executable?: string;
    catalogArgs?: readonly string[];
  }> = {
    'opencode-go': { executable: 'opencode', catalogArgs: ['models'] },
    codex: { executable: 'codex' },
    grok: {},
    gemini: {},
  };
  const configuration = options.configuration ?? {};
  const configurationByProvider: Record<ModelProviderId, ModelProviderAdapterConfiguration | undefined> = {
    'opencode-go': configuration.opencodeGo,
    codex: configuration.codex,
    grok: configuration.grok,
    gemini: configuration.gemini,
  };

  return MODEL_PROVIDER_DEFINITIONS.map((definition) => {
    const configured = configurationByProvider[definition.providerId];
    const defaultsForProvider = defaults[definition.providerId];
    return new CommandModelProviderAdapter({
      ...definition,
      enabled: configured?.enabled ?? true,
      executable: configured?.executable ?? defaultsForProvider.executable,
      capabilityArgs: configured?.capabilityArgs,
      catalogArgs: configured?.catalogArgs ?? defaultsForProvider.catalogArgs,
      ...(options.processRunner === undefined ? {} : { processRunner: options.processRunner }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
    });
  });
}

/** Parse only provider output; model IDs are never selected from a local list. */
export function parseModelCatalog(
  raw: string,
  fallbackCapabilities: readonly ModelCapability[]
): ModelDiscoveryResult {
  if (Buffer.byteLength(raw, 'utf8') > CATALOG_OUTPUT_BYTES) {
    return { status: 'unknown', reason: 'provider catalog output exceeded the safety limit' };
  }
  const output = redactSensitiveText(raw).trim();
  if (output.length === 0) {
    return { status: 'unknown', reason: 'provider catalog output was empty' };
  }

  try {
    const parsed: unknown = JSON.parse(output);
    const entries = extractModelEntries(parsed);
    if (entries === undefined) throw new Error('unsupported JSON shape');
    const models = entries.map((entry) => parseModelEntry(entry, fallbackCapabilities));
    if (models.some((model) => model === undefined)) {
      return { status: 'unknown', reason: 'provider catalog contained an invalid model entry' };
    }
    return { status: 'known', models: uniqueSortedModels(models as DiscoveredModel[]) };
  } catch {
    const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0 || lines.some((line) => !isValidModelId(line))) {
      return {
        status: 'unknown',
        reason: 'provider catalog output was not a supported machine-readable model list',
      };
    }
    const models = lines.map((modelId) => ({
      modelId,
      capabilities: normalizeCapabilities(fallbackCapabilities),
    }));
    return { status: 'known', models: uniqueSortedModels(models) };
  }
}

function parseCapabilities(raw: string): CapabilityProbeResult {
  if (Buffer.byteLength(raw, 'utf8') > CAPABILITY_OUTPUT_BYTES) {
    return { status: 'unknown', reason: 'provider capability output exceeded the safety limit' };
  }
  const output = redactSensitiveText(raw).trim();
  if (output.length === 0) {
    return { status: 'unknown', reason: 'provider capability output was empty' };
  }
  try {
    const parsed: unknown = JSON.parse(output);
    const values = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'object' && parsed !== null &&
          Array.isArray((parsed as Record<string, unknown>).capabilities)
        ? (parsed as { capabilities: readonly unknown[] }).capabilities
        : undefined;
    if (
      values === undefined ||
      values.some(
        (value) =>
          typeof value !== 'string' ||
          !MODEL_CAPABILITIES.includes(value as ModelCapability)
      )
    ) {
      return {
        status: 'unknown',
        reason: 'provider capability output was not a supported machine-readable capability list',
      };
    }
    return {
      status: 'known',
      capabilities: normalizeCapabilities(values as ModelCapability[]),
    };
  } catch {
    return {
      status: 'unknown',
      reason: 'provider capability output was not a supported machine-readable capability list',
    };
  }
}

function extractModelEntries(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['models', 'data', 'items']) {
    if (Array.isArray(record[key])) return record[key];
  }
  return undefined;
}

function parseModelEntry(
  value: unknown,
  fallbackCapabilities: readonly ModelCapability[]
): DiscoveredModel | undefined {
  if (typeof value === 'string') {
    return isValidModelId(value)
      ? { modelId: value, capabilities: normalizeCapabilities(fallbackCapabilities) }
      : undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const rawId = record.id ?? record.modelId ?? record.name ?? record.model;
  if (typeof rawId !== 'string' || !isValidModelId(rawId)) return undefined;

  const hasCapabilities = Object.prototype.hasOwnProperty.call(record, 'capabilities');
  const rawCapabilities = record.capabilities;
  let capabilities = normalizeCapabilities(fallbackCapabilities);
  if (hasCapabilities) {
    if (!Array.isArray(rawCapabilities)) return undefined;
    if (!rawCapabilities.every(
      (candidate: unknown): candidate is ModelCapability =>
        typeof candidate === 'string' && MODEL_CAPABILITIES.includes(candidate as ModelCapability)
    )) return undefined;
    capabilities = normalizeCapabilities(rawCapabilities);
  }
  const contextWindow = record.contextWindow ?? record.context_window;
  if (contextWindow === undefined) return { modelId: rawId, capabilities };
  if (
    typeof contextWindow !== 'number' ||
    !Number.isInteger(contextWindow) ||
    contextWindow <= 0 ||
    contextWindow > 10_000_000
  ) {
    return undefined;
  }
  return { modelId: rawId, capabilities, contextWindow };
}

function uniqueSortedModels(models: readonly DiscoveredModel[]): readonly DiscoveredModel[] {
  const byId = new Map<string, DiscoveredModel>();
  for (const model of models) {
    const existing = byId.get(model.modelId);
    if (existing !== undefined) {
      const sameCapabilities = existing.capabilities.length === model.capabilities.length &&
        existing.capabilities.every((capability, index) => capability === model.capabilities[index]);
      if (!sameCapabilities || existing.contextWindow !== model.contextWindow) {
        throw new Error(`provider catalog contained conflicting metadata for ${model.modelId}`);
      }
      continue;
    }
    byId.set(model.modelId, model);
    if (byId.size > MAX_CATALOG_MODELS) {
      throw new Error('provider catalog exceeds the model limit');
    }
  }
  return [...byId.values()].sort((left, right) => compareStableStrings(left.modelId, right.modelId));
}

function normalizeCapabilities(
  capabilities: readonly ModelCapability[]
): readonly ModelCapability[] {
  const supplied = new Set(capabilities);
  return MODEL_CAPABILITIES.filter((capability) => supplied.has(capability));
}

function firstOutputLine(value: string): string | undefined {
  const firstLine = redactSensitiveText(value).split(/\r?\n/u)[0];
  if (firstLine === undefined) return undefined;
  const line = firstLine
    .split('')
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .trim();
  return line.length === 0 ? undefined : line.slice(0, 256);
}

function isValidModelId(value: string): boolean {
  return value.length <= 256 && MODEL_ID_PATTERN.test(value);
}

function validateExecutable(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return validateText(value, 'provider executable', 4_096);
}

function validateArgument(value: string): string {
  return validateText(value, 'provider command argument', 1_024);
}

function validateText(value: string, label: string, maxLength: number): string {
  if (value.length === 0 || value.length > maxLength || value.includes('\0')) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

const SAFE_ENVIRONMENT_KEYS = [
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
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GEMINI_API_KEY',
  'XAI_API_KEY',
  'OPENCODE_API_KEY',
] as const;
const BLOCKED_ENVIRONMENT_KEYS = /^(?:GIT_|NODE_OPTIONS$|BASH_ENV$|ENV$|CDPATH$|LD_PRELOAD$|DYLD_)/u;

function buildEnvironment(
  additions: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(additions ?? {})) {
    if (BLOCKED_ENVIRONMENT_KEYS.test(key)) {
      throw new Error(`Refusing unsafe provider environment variable: ${key}`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || value.includes('\0')) {
      throw new Error(`Invalid provider environment variable: ${key}`);
    }
    environment[key] = value;
  }
  return environment;
}
