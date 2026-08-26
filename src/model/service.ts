import { randomUUID } from 'node:crypto';
import {
  UNKNOWN,
  modelRoutingRequestSchema,
  type ModelProviderId,
  type ModelRoutingDecision,
  type ModelRoutingRequest,
  type ProviderHealthRecord,
  type ProviderRegistryRecord,
  type ModelRoutingSnapshot,
} from '../domain/model-provider.js';
import type { ModelProviderAdapter, ModelProviderConfiguration } from '../adapters/model/adapter.js';
import type { DbConnection } from '../persistence/db.js';
import { createModelRepository, type ModelRepository } from '../persistence/model-repositories.js';
import { UsageLedger, type UsageLedgerInput } from './ledger.js';
import { ProviderRegistry, type ProviderRefreshResult } from './registry.js';
import { ModelRouter } from './router.js';

export type ProviderErrorKind =
  | 'model_not_found'
  | 'provider_removed'
  | 'authentication'
  | 'quota';

const PROVIDER_ERROR_KINDS: readonly ProviderErrorKind[] = [
  'model_not_found',
  'provider_removed',
  'authentication',
  'quota',
];

export type ModelServiceOptions = {
  db: DbConnection;
  projectId: string;
  adapters?: readonly ModelProviderAdapter[];
  configuration?: ModelProviderConfiguration;
  cwd?: string;
  now?: () => string;
  createId?: () => string;
  staleAfterMs?: number;
};

export type UsageRecordInput = UsageLedgerInput & {
  providerError?: ProviderErrorKind;
};

export type UsageRecordResult = {
  entry: ReturnType<UsageLedger['append']>;
  health: ProviderHealthRecord;
  refreshed: boolean;
};

/** Facade for the bounded MODEL-001 control-plane operations. */
export class ModelRoutingService {
  private readonly repository: ModelRepository;
  private readonly registry: ProviderRegistry;
  private readonly router: ModelRouter;
  private readonly ledger: UsageLedger;
  private readonly now: () => string;
  private readonly createId: () => string;

  public constructor(private readonly options: ModelServiceOptions) {
    this.repository = createModelRepository(options.db);
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? randomUUID;
    this.registry = new ProviderRegistry({
      ...options,
      now: this.now,
    });
    this.router = new ModelRouter();
    this.ledger = new UsageLedger(this.repository, options.projectId, this.now, this.createId);
  }

  public async refresh(providerId?: ModelProviderId): Promise<readonly ProviderRefreshResult[]> {
    return this.registry.refresh(providerId);
  }

  public listProviders(): readonly ProviderRegistryRecord[] {
    return this.registry.list();
  }

  public listModels(providerId?: ModelProviderId) {
    return this.registry.models(providerId);
  }

  public listHealth(): readonly ProviderHealthRecord[] {
    return this.registry.health();
  }

  public async route(input: ModelRoutingRequest): Promise<ModelRoutingDecision> {
    const request = modelRoutingRequestSchema.parse(input);
    const existing = request.requestId === undefined
      ? request.runId === undefined
        ? undefined
        : this.repository.findActiveRoutingDecisionByRun(this.options.projectId, request.runId)
      : this.repository.findRoutingDecisionByRequest(this.options.projectId, request.requestId);
    if (existing !== undefined) {
      const requestKey = request.requestId ?? request.runId ?? existing.decision.requestId;
      if (existing.hasReservation && existing.runId === undefined) {
        throw new Error(
          `Routing request ${requestKey} has an unbound capacity reservation; refusing replay`
        );
      }
      if (existing.runId !== request.runId) {
        throw new Error(`Routing request ${requestKey} is bound to a different durable run`);
      }
      if (
        existing.decision.task !== request.task ||
        existing.decision.risk !== request.risk ||
        existing.decision.mode !== request.envelope.mode
      ) {
        throw new Error(`Routing request ${requestKey} was reused for a different route`);
      }
      return existing.decision;
    }
    // A durable run is the stable idempotency key when the caller does not
    // provide a separate request ID. This makes CLI retries recover a lost
    // response without stranding the provider reservation.
    const requestId = request.requestId ?? request.runId ?? this.createId();
    await this.registry.ensureFresh();
    // Routing decisions that depend on quota reset timing must use the same
    // injected clock as persistence. Callers may still provide an explicit
    // timestamp for deterministic replay/tests.
    const routableRequest = request.now === undefined
      ? { ...request, now: this.now() }
      : request;
    const maxAttempts = this.registry.list().length + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const selection = this.router.route(routableRequest, this.snapshot());
      const decision: ModelRoutingDecision = {
        ...selection,
        id: this.createId(),
        projectId: this.options.projectId,
        requestId,
        createdAt: this.now(),
      };
      if (request.runId === undefined) {
        // A route without a durable execution run is a read-only preview.
        // Only an execution-bound route may persist a decision or claim
        // provider capacity.
        return decision;
      }
      const persisted = this.repository.reserveProviderCapacityAndAppendRoutingDecision(
        decision,
        request.runId
      );
      if (persisted !== undefined) return persisted;
    }
    throw new Error('Provider capacity changed while routing; retry the route request');
  }

  public listUsage() {
    return this.ledger.list();
  }

  public listRoutingDecisions() {
    return this.repository.listRoutingDecisions(this.options.projectId);
  }

  public async recordUsage(input: UsageRecordInput): Promise<UsageRecordResult> {
    if (input.providerError !== undefined && !PROVIDER_ERROR_KINDS.includes(input.providerError)) {
      throw new Error(`Unsupported provider error kind: ${String(input.providerError)}`);
    }
    const provider = this.registry
      .list()
      .find((entry) => entry.providerId === input.providerId);
    if (provider === undefined) {
      throw new Error(`Cannot record usage for an unregistered provider ${input.providerId}`);
    }
    const apply = this.options.db.transaction((): UsageRecordResult => {
      const entry = this.ledger.append({
        id: input.id,
        recordedAt: input.recordedAt,
        runId: input.runId,
        ...(input.routingDecisionId === undefined
          ? {}
          : { routingDecisionId: input.routingDecisionId }),
        providerId: input.providerId,
        modelId: input.modelId,
        task: input.task,
        retryCount: input.retryCount,
        elapsedMs: input.elapsedMs,
        outcome: input.outcome,
        outcomeQuality: input.outcomeQuality,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cost: input.cost,
        quotaRemaining: input.quotaRemaining,
      });
      if (input.routingDecisionId !== undefined) {
        this.repository.releaseProviderCapacity(
          this.options.projectId,
          entry.runId,
          input.routingDecisionId,
          entry.providerId,
          entry.modelId,
          this.now()
        );
      }
      const current = this.repository.findHealth(this.options.projectId, entry.providerId);
      const health = healthAfterUsage(
        current,
        entry,
        input.providerError,
        this.now()
      );
      this.repository.upsertProviderHealth(health);
      return { entry, health, refreshed: false };
    }).immediate;
    const result = apply();
    if (input.providerError !== undefined) {
      // The telemetry is durable even if the immediate probe fails. A failed
      // refresh is surfaced to the caller rather than silently trusted.
      await this.registry.refresh(input.providerId);
      const health = this.repository.findHealth(this.options.projectId, input.providerId);
      if (health === undefined) throw new Error('Provider health disappeared after refresh');
      return { ...result, health, refreshed: true };
    }
    return result;
  }

  public getRepository(): ModelRepository {
    return this.repository;
  }

  private snapshot(): ModelRoutingSnapshot {
    return {
      providers: this.registry.list(),
      models: this.registry.models(),
      health: this.registry.health(),
      usage: this.repository.listUsage(this.options.projectId),
    };
  }
}

function healthAfterUsage(
  current: ProviderHealthRecord | undefined,
  entry: ReturnType<UsageLedger['append']>,
  providerError: ProviderErrorKind | undefined,
  updatedAt: string
): ProviderHealthRecord {
  const base: ProviderHealthRecord = current ?? {
    projectId: entry.projectId,
    providerId: entry.providerId,
    status: 'unknown',
    auth: 'unknown',
    quotaPressure: UNKNOWN,
    quotaRemaining: UNKNOWN,
    quotaResetAt: UNKNOWN,
    recentFailureCount: 0,
    activeRuns: 0,
    maxConcurrentRuns: UNKNOWN,
    checkedAt: updatedAt,
    updatedAt,
  };
  const failed = entry.outcome !== 'succeeded' || entry.outcomeQuality === 'poor';
  const recentFailureCount = failed
    ? Math.min(1_000_000, base.recentFailureCount + 1)
    : Math.max(0, base.recentFailureCount - 1);
  let status: ProviderHealthRecord['status'] = failed
    ? 'degraded' as const
    : base.status === 'unavailable' || base.status === 'unknown'
      ? 'healthy' as const
      : base.status;
  let auth = base.auth;
  let quotaPressure = base.quotaPressure;
  if (providerError === 'authentication') {
    status = 'unavailable';
    auth = 'unauthenticated';
  } else if (providerError === 'provider_removed') {
    status = 'unavailable';
  } else if (providerError === 'model_not_found') {
    status = 'degraded';
  } else if (providerError === 'quota') {
    status = 'degraded';
    quotaPressure = 'high';
  }
  return {
    ...base,
    status,
    auth,
    quotaPressure,
    quotaRemaining: entry.quotaRemaining,
    recentFailureCount,
    activeRuns: base.activeRuns,
    ...(failed ? { lastFailureAt: entry.recordedAt } : { lastSuccessAt: entry.recordedAt }),
    checkedAt: updatedAt,
    updatedAt,
  };
}
