import { createHash, randomUUID } from 'node:crypto';
import {
  UNKNOWN,
  MODEL_PROVIDER_TO_AGENT_PROVIDER,
  modelRoutingRequestSchema,
  type ModelProviderId,
  type ModelRoutingDecision,
  type ModelRoutingSelection,
  type ModelRoutingRequest,
  type ProviderHealthRecord,
  type ProviderRegistryRecord,
  type ModelRoutingSnapshot,
} from '../domain/model-provider.js';
import type { ModelProviderAdapter, ModelProviderConfiguration } from '../adapters/model/adapter.js';
import type {
  ModelExecutionAdapterBinding,
  ModelExecutionTarget,
} from '../adapters/agent/registry.js';
import type { AgentExecutionAdapter } from '../adapters/agent/adapter.js';
import type { DbConnection } from '../persistence/db.js';
import { createModelRepository, type ModelRepository } from '../persistence/model-repositories.js';
import { createRunRepository } from '../persistence/repositories.js';
import { UsageLedger, type UsageLedgerInput } from './ledger.js';
import {
  ProviderRegistry,
  type ProviderRefreshResult,
} from './registry.js';
import { ModelRouter } from './router.js';
import {
  executeAgentTask,
  type AgentExecutionServiceOptions,
  type AgentTaskResult,
  type SelectedAgentTaskInput,
} from '../execution/service.js';
import { getCurrentProjectId } from '../workspace/service.js';

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
  executionAdapters?: readonly ModelExecutionAdapterBinding[];
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
    // Routing is an execution admission decision. Re-probe the configured
    // execution surfaces on every route so an executable removed or changed
    // since the last metadata refresh cannot remain routable from a warm DB.
    await this.registry.refresh();
    const fingerprint = routingRequestFingerprint(request);
    const existing = request.requestId === undefined
      ? request.runId === undefined
        ? undefined
        : this.repository.findActiveRoutingDecisionByRun(this.options.projectId, request.runId)
      : this.repository.findRoutingDecisionByRequest(this.options.projectId, request.requestId);
    if (existing !== undefined) {
      const requestKey = request.requestId ?? request.runId ?? existing.decision.requestId;
      if (existing.reservationStatus === 'released') {
        throw new Error(
          `Routing request ${requestKey} has a released capacity reservation; use a new request ID to retry`
        );
      }
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
      if (
        existing.decision.requestFingerprint === undefined ||
        existing.decision.requestFingerprint !== fingerprint
      ) {
        throw new Error(
          `Routing request ${requestKey} was reused with different routing constraints`
        );
      }
      const target = this.resolveExecutionTarget(existing.decision);
      if (existing.hasReservation && !target.executionBound) {
        throw new Error(
          `Routing request ${requestKey} has no trustworthy execution binding; refusing replay`
        );
      }
      return existing.decision;
    }
    // A durable run is the stable idempotency key when the caller does not
    // provide a separate request ID. This makes CLI retries recover a lost
    // response without stranding the provider reservation.
    const requestId = request.requestId ?? request.runId ?? this.createId();
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
        requestFingerprint: fingerprint,
        createdAt: this.now(),
      };
      // Do not persist a route that cannot be consumed by the concrete
      // provider-neutral AGENT-001 capability for this task. This check is
      // deliberately before reservation so unsupported review/repair routes
      // cannot strand capacity.
      this.resolveExecutionTarget(decision);
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

  /**
   * Resolve a routed MODEL-001 selection to an opaque target for the exact
   * provider-neutral AGENT-001 adapter capability-probed during refresh.
   */
  public resolveExecutionTarget(
    selection: Pick<ModelRoutingSelection, 'providerId' | 'modelId' | 'task'> & {
      id?: string;
      projectId?: string;
    }
  ): ModelExecutionTarget {
    if (selection.projectId !== undefined && selection.projectId !== this.options.projectId) {
      throw new Error(
        `Routing selection belongs to project ${selection.projectId}, not ${this.options.projectId}`
      );
    }
    const target = this.registry.resolveExecutionTarget(selection);
    if (selection.id === undefined) return target;

    const persisted = this.repository.findRoutingDecisionById(
      this.options.projectId,
      selection.id
    );
    if (persisted === undefined) {
      // A route preview carries a locally useful decision ID but is not a
      // durable execution reservation. Keep the target explicitly unbound.
      return target;
    }
    if (
      persisted.decision.providerId !== selection.providerId ||
      persisted.decision.modelId !== selection.modelId ||
      persisted.decision.task !== selection.task
    ) {
      throw new Error(
        `Routing decision ${selection.id} does not match the requested execution target`
      );
    }
    if (
      !persisted.hasReservation ||
      persisted.reservationStatus !== 'active' ||
      persisted.runId === undefined ||
      persisted.decision.requestFingerprint === undefined
    ) {
      return target;
    }
    return Object.freeze({
      ...target,
      executionBound: true,
      routingDecisionId: selection.id,
      runId: persisted.runId,
    });
  }

  /**
   * Execute a durable MODEL-001 route through the provider-neutral AGENT-001
   * lifecycle. The target is intentionally opaque: callers cannot obtain a
   * concrete adapter and launch it against an arbitrary path. This service
   * re-checks the persisted reservation and creates a private adapter facade
   * whose only implementation is the registry's exact target dispatch.
   */
  public async executeSelectedAgentTask(
    options: Omit<AgentExecutionServiceOptions, 'adapter'>,
    target: ModelExecutionTarget,
    input: SelectedAgentTaskInput
  ): Promise<AgentTaskResult> {
    if (
      !target.executionBound ||
      target.routingDecisionId === undefined ||
      target.runId === undefined
    ) {
      throw new Error(
        'MODEL-001 route is not execution-bound; durable agent execution requires an active run reservation'
      );
    }
    this.verifyExecutionBinding(options, target);
    return executeAgentTask(
      { ...options, adapter: this.createExecutionAdapter(target) },
      {
        ...input,
        task: target.task,
        runId: target.runId,
        provider: target.provider,
        modelProviderId: target.modelProviderId,
        model: target.modelId,
      }
    );
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
        // Finalize this specific model route, not an unrelated durable run.
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

  private createExecutionAdapter(target: ModelExecutionTarget): AgentExecutionAdapter {
    return {
      provider: target.provider,
      capabilities: this.registry.executionCapabilitiesFor(target),
      probe: () => this.registry.probeExecution(target),
      execute: (request) => this.registry.executeExecution(target, request),
    };
  }

  private verifyExecutionBinding(
    options: Omit<AgentExecutionServiceOptions, 'adapter'>,
    target: ModelExecutionTarget
  ): void {
    const projectId = getCurrentProjectId(options);
    const persisted = this.repository.findRoutingDecisionById(
      projectId,
      target.routingDecisionId as string
    );
    const run = createRunRepository(options.db).findById(target.runId as string);
    // The repository owns routing decisions, while durable AGENT runs remain
    // in the general repository. Keep both identities in the same project.
    if (
      projectId !== this.options.projectId ||
      persisted === undefined ||
      !persisted.hasReservation ||
      persisted.reservationStatus !== 'active' ||
      persisted.runId !== target.runId ||
      persisted.decision.providerId !== target.modelProviderId ||
      persisted.decision.modelId !== target.modelId ||
      persisted.decision.task !== target.task ||
      persisted.decision.requestFingerprint === undefined ||
      run === undefined ||
      run.projectId !== projectId ||
      run.task !== target.task ||
      run.modelProviderId !== target.modelProviderId ||
      run.provider !== target.provider ||
      run.model !== target.modelId ||
      target.provider !== MODEL_PROVIDER_TO_AGENT_PROVIDER[target.modelProviderId]
    ) {
      throw new Error(
        `MODEL-001 route ${target.routingDecisionId} is not a current execution binding`
      );
    }
    // Resolving capabilities is also the final in-memory binding check. It
    // fails closed if a caller supplies a target with a substituted provider
    // identity or task that this registry did not bind.
    this.registry.executionCapabilitiesFor(target);
  }

  private snapshot(): ModelRoutingSnapshot {
    return {
      providers: this.registry.list(),
      models: this.registry.models(),
      health: this.registry.health(),
      usage: this.repository.listUsage(this.options.projectId),
      executionCapabilities: this.registry.executionCapabilities(),
    };
  }
}

/**
 * Stable idempotency material for a route. Runtime ownership identifiers and
 * the injected clock are intentionally excluded; changing any caller-owned
 * constraint that can affect selection must invalidate a replay.
 */
function routingRequestFingerprint(request: ModelRoutingRequest): string {
  const canonical = JSON.stringify({
    task: request.task,
    risk: request.risk,
    envelope: {
      mode: request.envelope.mode,
      maxConcurrentTickets: request.envelope.maxConcurrentTickets,
      activeConcurrentTickets: request.envelope.activeConcurrentTickets,
      budgetRemaining: request.envelope.budgetRemaining,
    },
    implementationProvider: request.implementationProvider ?? null,
    fallbackFromProvider: request.fallbackFromProvider ?? null,
    excludeProviders: [...(request.excludeProviders ?? [])].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex');
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
