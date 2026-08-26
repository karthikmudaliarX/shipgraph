import { realpathSync } from 'node:fs';
import type { DbConnection } from '../persistence/db.js';
import { createProjectRepository } from '../persistence/repositories.js';
import {
  persistedProjectMatchesConfig,
} from '../config/schema.js';
import { loadConfig } from '../config/loader.js';
import { assertSafeShipgraphPaths } from '../utils/paths.js';
import {
  MODEL_ROUTING_MODES,
  MODEL_RISK_LEVELS,
  MODEL_TASK_TYPES,
  normalizeModelProviderId,
  type ModelProviderId,
  type ModelRoutingMode,
  type ModelRiskLevel,
  type ModelTaskType,
} from '../domain/model-provider.js';
import {
  ModelRoutingService,
  type ModelServiceOptions,
} from '../model/service.js';

export function modelServiceOptions(
  db: DbConnection,
  projectDir: string
): ModelServiceOptions {
  assertSafeShipgraphPaths(projectDir);
  const config = loadConfig(projectDir);
  const projects = createProjectRepository(db).findAll();
  if (projects.length !== 1 || projects[0] === undefined) {
    throw new Error('ShipGraph database must contain exactly one initialized project');
  }
  if (!persistedProjectMatchesConfig(projects[0], config)) {
    throw new Error(
      'shipgraph.yml does not match the project identity already stored in .shipgraph/shipgraph.db'
    );
  }
  return {
    db,
    projectId: projects[0].id,
    configuration: config.providers,
    cwd: realpathSync(projectDir),
  };
}

export async function runProvidersRefresh(
  options: ModelServiceOptions,
  provider?: string
): Promise<Record<string, unknown>> {
  const service = new ModelRoutingService(options);
  const results = await service.refresh(
    provider === undefined ? undefined : normalizeModelProviderId(provider)
  );
  return {
    providers: results.map((result) => ({
      providerId: result.provider.providerId,
      displayName: result.provider.displayName,
      family: result.provider.family,
      configured: result.provider.configured,
      availability: result.provider.availability,
      version: result.provider.version,
      capabilities: result.provider.capabilities,
      catalogStatus: result.provider.catalogStatus,
      catalogReason: result.provider.catalogReason,
      modelCount: result.modelCount,
      health: result.health,
      checkedAt: result.provider.checkedAt,
    })),
  };
}

export function runProvidersList(options: ModelServiceOptions): Record<string, unknown> {
  const service = new ModelRoutingService(options);
  const healthByProvider = new Map(service.listHealth().map((health) => [health.providerId, health]));
  const models = service.listModels();
  return {
    providers: service.listProviders().map((provider) => ({
      ...provider,
      modelCount: models.filter((model) => model.providerId === provider.providerId).length,
      health: healthByProvider.get(provider.providerId),
    })),
  };
}

export async function runProvidersRoute(
  options: ModelServiceOptions,
  input: {
    task: string;
    risk: string;
    mode: string;
    implementationProvider?: string;
    fallbackFromProvider?: string;
    excludeProviders?: readonly string[];
    maxConcurrentTickets?: string;
    activeConcurrentTickets?: string;
    budgetRemaining?: string;
  }
): Promise<Record<string, unknown>> {
  const service = new ModelRoutingService(options);
  const config = options.cwd === undefined ? undefined : loadConfig(options.cwd);
  const decision = await service.route({
    task: parseTask(input.task),
    risk: parseRisk(input.risk),
    envelope: {
      mode: parseMode(input.mode || config?.routing?.mode || 'balanced'),
      maxConcurrentTickets: parseKnownInteger(
        input.maxConcurrentTickets ?? String(config?.execution.maxConcurrentTickets ?? 'unknown')
      ),
      // Global ticket capacity is owned by Scheduler. An omitted count is not
      // evidence that a global slot is free.
      activeConcurrentTickets: parseKnownInteger(input.activeConcurrentTickets ?? 'unknown'),
      budgetRemaining: parseKnownNumber(input.budgetRemaining ?? 'unknown'),
    },
    ...(input.implementationProvider === undefined
      ? {}
      : { implementationProvider: normalizeModelProviderId(input.implementationProvider) }),
    ...(input.fallbackFromProvider === undefined
      ? {}
      : { fallbackFromProvider: normalizeModelProviderId(input.fallbackFromProvider) }),
    ...(input.excludeProviders === undefined
      ? {}
      : { excludeProviders: input.excludeProviders.map(normalizeModelProviderId) }),
  });
  return { decision };
}

export function runProvidersUsage(options: ModelServiceOptions): Record<string, unknown> {
  const service = new ModelRoutingService(options);
  return { usage: service.listUsage() };
}

export function parseTask(value: string): ModelTaskType {
  const normalized = value.toLowerCase();
  if (!MODEL_TASK_TYPES.includes(normalized as ModelTaskType)) {
    throw new Error(`Unsupported model task: ${value}`);
  }
  return normalized as ModelTaskType;
}

export function parseRisk(value: string): ModelRiskLevel {
  const normalized = value.toLowerCase();
  if (!MODEL_RISK_LEVELS.includes(normalized as ModelRiskLevel)) {
    throw new Error(`Unsupported model risk: ${value}`);
  }
  return normalized as ModelRiskLevel;
}

export function parseMode(value: string): ModelRoutingMode {
  const normalized = value.toLowerCase();
  if (!MODEL_ROUTING_MODES.includes(normalized as ModelRoutingMode)) {
    throw new Error(`Unsupported routing mode: ${value}`);
  }
  return normalized as ModelRoutingMode;
}

function parseKnownNumber(value: string): number | 'unknown' {
  if (value.toLowerCase() === 'unknown') return 'unknown';
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative number or unknown, received: ${value}`);
  }
  return parsed;
}

function parseKnownInteger(value: string): number | 'unknown' {
  const parsed = parseKnownNumber(value);
  if (parsed !== 'unknown' && !Number.isInteger(parsed)) {
    throw new Error(`Expected a non-negative integer or unknown, received: ${value}`);
  }
  return parsed;
}

export function providerIdForCli(value: string): ModelProviderId {
  return normalizeModelProviderId(value);
}
