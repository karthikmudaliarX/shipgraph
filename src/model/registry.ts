import { compareStableStrings } from '../utils/sorting.js';
import type {
  ModelProviderAdapter,
  ModelProviderConfiguration,
  ProviderProbeResult,
} from '../adapters/model/adapter.js';
import { createModelProviderAdapters } from '../adapters/model/adapter.js';
import {
  MODEL_PROVIDER_DEFINITIONS,
  UNKNOWN,
  type ModelProviderId,
  type ProviderHealthRecord,
  type ProviderRegistryRecord,
} from '../domain/model-provider.js';
import {
  createModelRepository,
  type ModelRepository,
  type ProviderSnapshotPersistence,
} from '../persistence/model-repositories.js';
import type { DbConnection } from '../persistence/db.js';

export type ProviderRegistryOptions = {
  db: DbConnection;
  projectId: string;
  adapters?: readonly ModelProviderAdapter[];
  configuration?: ModelProviderConfiguration;
  cwd?: string;
  now?: () => string;
  staleAfterMs?: number;
};

export type ProviderRefreshResult = {
  provider: ProviderRegistryRecord;
  health: ProviderHealthRecord;
  modelCount: number;
};

const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1_000;

/** Owns current provider/model metadata and its capability-probed refreshes. */
export class ProviderRegistry {
  private readonly repository: ModelRepository;
  private readonly adapters: readonly ModelProviderAdapter[];
  private readonly now: () => string;
  private readonly staleAfterMs: number;

  public constructor(private readonly options: ProviderRegistryOptions) {
    this.repository = createModelRepository(options.db);
    this.adapters = [...(
      options.adapters ?? createModelProviderAdapters({
        configuration: options.configuration,
        cwd: options.cwd,
      })
    )].sort((left, right) => compareStableStrings(left.providerId, right.providerId));
    this.now = options.now ?? (() => new Date().toISOString());
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    if (!Number.isInteger(this.staleAfterMs) || this.staleAfterMs < 0) {
      throw new Error('Provider registry staleAfterMs must be a non-negative integer');
    }
    this.assertAdapterSet();
  }

  public async refresh(providerId?: ModelProviderId): Promise<readonly ProviderRefreshResult[]> {
    const selected = providerId === undefined
      ? this.adapters
      : this.adapters.filter((adapter) => adapter.providerId === providerId);
    if (selected.length === 0) {
      throw new Error(`No adapter is configured for provider ${providerId ?? 'set'}`);
    }

    const results: ProviderRefreshResult[] = [];
    for (const adapter of selected) {
      results.push(await this.refreshAdapter(adapter));
    }
    return results;
  }

  /** Refresh before routing when the persisted probe/catalog is absent or stale. */
  public async ensureFresh(): Promise<void> {
    const providers = this.repository.listProviders(this.options.projectId);
    const health = this.repository.listHealth(this.options.projectId);
    const current = this.now();
    const currentMs = Date.parse(current);
    const stale = providers.length !== this.adapters.length || health.length !== this.adapters.length ||
      this.adapters.some((adapter) =>
        !providers.some((provider) => provider.providerId === adapter.providerId) ||
        !health.some((record) => record.providerId === adapter.providerId)
      ) || providers.some((provider) => {
      const checkedMs = Date.parse(provider.checkedAt);
      return (
        !Number.isFinite(checkedMs) ||
        !Number.isFinite(currentMs) ||
        currentMs < checkedMs ||
        currentMs - checkedMs > this.staleAfterMs
      );
    });
    if (stale) await this.refresh();
  }

  public list(): readonly ProviderRegistryRecord[] {
    const providerIds = new Set(this.adapters.map((adapter) => adapter.providerId));
    return this.repository
      .listProviders(this.options.projectId)
      .filter((provider) => providerIds.has(provider.providerId));
  }

  public models(providerId?: ModelProviderId) {
    if (providerId !== undefined && !this.adapters.some((adapter) => adapter.providerId === providerId)) {
      return [];
    }
    const models = this.repository.listModels(this.options.projectId, providerId);
    if (providerId !== undefined) return models;
    const providerIds = new Set(this.adapters.map((adapter) => adapter.providerId));
    return models.filter((model) => providerIds.has(model.providerId));
  }

  public health(): readonly ProviderHealthRecord[] {
    const providerIds = new Set(this.adapters.map((adapter) => adapter.providerId));
    return this.repository
      .listHealth(this.options.projectId)
      .filter((health) => providerIds.has(health.providerId));
  }

  public getRepository(): ModelRepository {
    return this.repository;
  }

  private async refreshAdapter(adapter: ModelProviderAdapter): Promise<ProviderRefreshResult> {
    const checkedAt = this.now();
    const probe = await safeProbe(adapter);
    const discovery = probe.availability === 'available'
      ? await safeDiscoverModels(adapter)
      : { status: 'unknown' as const, reason: 'provider is not available for catalog discovery' };
    const previousHealth = this.repository.findHealth(this.options.projectId, adapter.providerId);
    const health = buildHealth(
      this.options.projectId,
      adapter.providerId,
      probe,
      previousHealth,
      checkedAt
    );
    const provider: ProviderRegistryRecord = {
      projectId: this.options.projectId,
      providerId: adapter.providerId,
      family: adapter.family,
      displayName: adapter.displayName,
      configured: probe.availability !== 'unknown' || probe.reason !== 'provider executable is not configured',
      availability: probe.availability,
      ...(probe.version === undefined ? {} : { version: probe.version }),
      capabilities: [...probe.capabilities],
      catalogStatus: discovery.status,
      ...(discovery.status === 'unknown' ? { catalogReason: discovery.reason } : {}),
      checkedAt,
      updatedAt: checkedAt,
    };
    const models = discovery.status === 'known'
      ? discovery.models.map((model) => ({
          projectId: this.options.projectId,
          providerId: adapter.providerId,
          modelId: model.modelId,
          capabilities: [...model.capabilities],
          ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
          discoveredAt: checkedAt,
        }))
      : [];
    const snapshot: ProviderSnapshotPersistence = {
      provider,
      health,
      models,
      catalogStatus: discovery.status,
    };
    this.repository.replaceProviderSnapshot(snapshot);
    const persistedProvider = this.repository
      .listProviders(this.options.projectId)
      .find((entry) => entry.providerId === adapter.providerId);
    const persistedHealth = this.repository.findHealth(this.options.projectId, adapter.providerId);
    const persistedModelCount = this.repository
      .listModels(this.options.projectId, adapter.providerId)
      .length;
    return {
      provider: persistedProvider ?? provider,
      health: persistedHealth ?? health,
      modelCount: persistedModelCount,
    };
  }

  private assertAdapterSet(): void {
    const supported = new Set(MODEL_PROVIDER_DEFINITIONS.map((definition) => definition.providerId));
    const actual = new Set<ModelProviderId>();
    for (const adapter of this.adapters) {
      if (!supported.has(adapter.providerId)) {
        throw new Error(`Provider registry received an unsupported adapter: ${adapter.providerId}`);
      }
      if (actual.has(adapter.providerId)) {
        throw new Error(`Provider registry received duplicate adapters for ${adapter.providerId}`);
      }
      actual.add(adapter.providerId);
    }
    if (actual.size === 0) throw new Error('Provider registry requires at least one adapter');
  }
}

async function safeProbe(adapter: ModelProviderAdapter): Promise<ProviderProbeResult> {
  try {
    return await adapter.probe();
  } catch {
    return {
      availability: 'unknown',
      auth: 'unknown',
      capabilities: [],
      reason: 'provider probe failed unexpectedly',
    };
  }
}

async function safeDiscoverModels(adapter: ModelProviderAdapter) {
  try {
    return await adapter.discoverModels();
  } catch {
    return { status: 'unknown' as const, reason: 'provider catalog discovery failed unexpectedly' };
  }
}

function buildHealth(
  projectId: string,
  providerId: ModelProviderId,
  probe: ProviderProbeResult,
  previous: ProviderHealthRecord | undefined,
  checkedAt: string
): ProviderHealthRecord {
  const status = probe.availability === 'available'
    ? previous?.status === 'unavailable'
      ? 'degraded'
      : previous?.status === 'degraded' && (previous.recentFailureCount ?? 0) > 0
        ? 'degraded'
        : 'healthy'
    : probe.availability === 'unavailable'
      ? 'unavailable'
      : 'unknown';
  return {
    projectId,
    providerId,
    status,
    auth: probe.auth === 'unknown' ? previous?.auth ?? UNKNOWN : probe.auth,
    quotaPressure: probe.quotaPressure ?? previous?.quotaPressure ?? UNKNOWN,
    quotaRemaining: probe.quotaRemaining ?? previous?.quotaRemaining ?? UNKNOWN,
    quotaResetAt: probe.quotaResetAt ?? previous?.quotaResetAt ?? UNKNOWN,
    recentFailureCount: previous?.recentFailureCount ?? 0,
    activeRuns: previous?.activeRuns ?? 0,
    maxConcurrentRuns: previous?.maxConcurrentRuns ?? UNKNOWN,
    ...(previous?.lastFailureAt === undefined ? {} : { lastFailureAt: previous.lastFailureAt }),
    ...(previous?.lastSuccessAt === undefined ? {} : { lastSuccessAt: previous.lastSuccessAt }),
    checkedAt,
    updatedAt: checkedAt,
  };
}
