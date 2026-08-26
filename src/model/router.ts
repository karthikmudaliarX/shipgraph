import { compareStableStrings } from '../utils/sorting.js';
import {
  modelRoutingRequestSchema,
  providerHealthRecordSchema,
  providerRegistryRecordSchema,
  modelCatalogRecordSchema,
  usageLedgerRecordSchema,
  isKnownNumber,
  isKnownTimestamp,
  type ModelRoutingSelection,
  type ModelRoutingRequest,
  type ModelRoutingSnapshot,
  type ModelProviderId,
  type OutcomeQuality,
  type ProviderHealthRecord,
  type ProviderRegistryRecord,
  type ModelCatalogRecord,
  type UsageLedgerRecord,
  type ModelRoutingMode,
} from '../domain/model-provider.js';

type Candidate = {
  provider: ProviderRegistryRecord;
  health: ProviderHealthRecord;
  model: ModelCatalogRecord;
  score: number;
  reasonFacts: readonly string[];
};

type ObservedStats = {
  quality: OutcomeQuality;
  latencyMs: number | undefined;
  retryCount: number | undefined;
};

/** Pure deterministic provider/model selection. It never calls a provider. */
export class ModelRouter {
  public route(
    input: ModelRoutingRequest,
    snapshot: ModelRoutingSnapshot
  ): ModelRoutingSelection {
    const request = modelRoutingRequestSchema.parse(input);
    const providers = snapshot.providers.map((provider) => providerRegistryRecordSchema.parse(provider));
    const models = snapshot.models.map((model) => modelCatalogRecordSchema.parse(model));
    const health = snapshot.health.map((record) => providerHealthRecordSchema.parse(record));
    const usage = snapshot.usage.map((entry) => usageLedgerRecordSchema.parse(entry));
    assertSnapshotIntegrity(providers, models, health, usage);

    assertEnvelopeAvailable(request);
    const healthByProvider = new Map(health.map((record) => [record.providerId, record]));
    const modelsByProvider = groupModels(models);
    const implementationFamily = request.implementationProvider === undefined
      ? undefined
      : providers.find((provider) => provider.providerId === request.implementationProvider)?.family;
    if (request.implementationProvider !== undefined && implementationFamily === undefined) {
      throw new Error(
        `Implementation provider ${request.implementationProvider} is not present in the routing snapshot`
      );
    }
    const excluded = new Set([
      ...(request.excludeProviders ?? []),
      ...(request.fallbackFromProvider === undefined ? [] : [request.fallbackFromProvider]),
    ]);
    const familyAlternatives = request.task === 'review' && implementationFamily !== undefined
      ? providers.some((provider) => {
          if (provider.family === implementationFamily || excluded.has(provider.providerId)) return false;
          const providerHealth = healthByProvider.get(provider.providerId);
          const providerModels = modelsByProvider.get(provider.providerId) ?? [];
          return (
            isUsableProvider(provider, providerHealth, request.task) &&
            providerHealth !== undefined &&
            !isProviderAtCapacity(providerHealth) &&
            providerModels.some((model) => model.capabilities.includes(request.task))
          );
        })
      : false;

    const candidates: Candidate[] = [];
    for (const provider of [...providers].sort((left, right) =>
      compareStableStrings(left.providerId, right.providerId)
    )) {
      if (excluded.has(provider.providerId)) continue;
      const providerHealth = healthByProvider.get(provider.providerId);
      if (!isUsableProvider(provider, providerHealth, request.task)) continue;
      if (providerHealth === undefined || isProviderAtCapacity(providerHealth)) continue;
      const providerModels = modelsByProvider.get(provider.providerId) ?? [];
      for (const model of providerModels) {
        if (!model.capabilities.includes(request.task)) continue;
        const stats = observedStats(usage, provider.providerId, model.modelId);
        const score = scoreCandidate(
          request,
          provider,
          providerHealth,
          stats,
          implementationFamily,
          familyAlternatives
        );
        candidates.push({
          provider,
          health: providerHealth,
          model,
          score,
          reasonFacts: reasonFacts(
            request,
            provider,
            providerHealth,
            model,
            stats,
            implementationFamily,
            familyAlternatives
          ),
        });
      }
    }

    if (candidates.length === 0) {
      throw new Error(
        `No usable provider/model is available for ${request.task} at ${request.risk} risk`
      );
    }

    candidates.sort((left, right) => {
      const scoreDifference = right.score - left.score;
      if (scoreDifference !== 0) return scoreDifference;
      const providerDifference = compareStableStrings(left.provider.providerId, right.provider.providerId);
      return providerDifference || compareStableStrings(left.model.modelId, right.model.modelId);
    });
    const selected = candidates[0];
    if (selected === undefined) throw new Error('No routing candidate survived selection');

    return {
      task: request.task,
      risk: request.risk,
      mode: request.envelope.mode,
      providerId: selected.provider.providerId,
      providerFamily: selected.provider.family,
      modelId: selected.model.modelId,
      reason: [
        `mode=${request.envelope.mode}`,
        `task=${request.task}`,
        `risk=${request.risk}`,
        `envelope concurrency=${formatNumber(request.envelope.activeConcurrentTickets)}/${formatNumber(request.envelope.maxConcurrentTickets)}`,
        `envelope budget=${formatNumber(request.envelope.budgetRemaining)}`,
        ...selected.reasonFacts,
        `candidates=${candidates.length}`,
      ].join('; '),
      candidatesConsidered: candidates.length,
    };
  }
}

function assertEnvelopeAvailable(request: ModelRoutingRequest): void {
  const { maxConcurrentTickets, activeConcurrentTickets, budgetRemaining } = request.envelope;
  if (
    isKnownNumber(maxConcurrentTickets) &&
    isKnownNumber(activeConcurrentTickets) &&
    activeConcurrentTickets >= maxConcurrentTickets
  ) {
    throw new Error('execution envelope concurrency is full');
  }
  if (isKnownNumber(budgetRemaining) && budgetRemaining <= 0) {
    throw new Error('execution envelope budget is exhausted');
  }
}

function formatNumber(value: number | 'unknown'): string {
  return isKnownNumber(value) ? String(value) : 'unknown';
}

function isUsableProvider(
  provider: ProviderRegistryRecord,
  health: ProviderHealthRecord | undefined,
  task: ModelRoutingRequest['task']
): boolean {
  return (
    provider.configured &&
    provider.availability === 'available' &&
    provider.catalogStatus === 'known' &&
    provider.capabilities.includes(task) &&
    health !== undefined &&
    (health.status === 'healthy' || health.status === 'degraded') &&
    health.auth !== 'unauthenticated' &&
    !(isKnownNumber(health.quotaRemaining) && health.quotaRemaining <= 0)
  );
}

function isProviderAtCapacity(health: ProviderHealthRecord): boolean {
  return isKnownNumber(health.maxConcurrentRuns) && health.activeRuns >= health.maxConcurrentRuns;
}

function groupModels(
  models: readonly ModelCatalogRecord[]
): ReadonlyMap<ModelProviderId, readonly ModelCatalogRecord[]> {
  const grouped = new Map<ModelProviderId, ModelCatalogRecord[]>();
  for (const model of models) {
    const entries = grouped.get(model.providerId) ?? [];
    entries.push(model);
    grouped.set(model.providerId, entries);
  }
  for (const entries of grouped.values()) {
    entries.sort((left, right) => compareStableStrings(left.modelId, right.modelId));
  }
  return grouped;
}

function observedStats(
  usage: readonly UsageLedgerRecord[],
  providerId: ModelProviderId,
  modelId: string
): ObservedStats {
  const relevant = usage
    .filter((entry) => entry.providerId === providerId && entry.modelId === modelId)
    .sort((left, right) =>
      compareStableStrings(`${left.recordedAt}\0${left.id}`, `${right.recordedAt}\0${right.id}`)
    )
    .slice(-20);
  if (relevant.length === 0) {
    return { quality: 'unknown', latencyMs: undefined, retryCount: undefined };
  }
  const qualityScore: Record<OutcomeQuality, number> = {
    excellent: 3,
    good: 2,
    poor: 0,
    unknown: 1,
  };
  const averageQuality = relevant.reduce((sum, entry) => sum + qualityScore[entry.outcomeQuality], 0) / relevant.length;
  const quality: OutcomeQuality = averageQuality >= 2.5
    ? 'excellent'
    : averageQuality >= 1.5
      ? 'good'
      : averageQuality < 1
        ? 'poor'
        : 'unknown';
  const elapsed = relevant.map((entry) => entry.elapsedMs);
  const retries = relevant.map((entry) => entry.retryCount);
  return {
    quality,
    latencyMs: Math.round(elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length),
    retryCount: Math.round(retries.reduce((sum, value) => sum + value, 0) / retries.length),
  };
}

function scoreCandidate(
  request: ModelRoutingRequest,
  provider: ProviderRegistryRecord,
  health: ProviderHealthRecord,
  stats: ObservedStats,
  implementationFamily: string | undefined,
  familyAlternatives: boolean
): number {
  let score = health.status === 'healthy' ? 80 : 50;
  score += health.auth === 'authenticated' ? 20 : 0;
  score += quotaScore(request.envelope.mode, health.quotaPressure);
  score += quotaResetScore(request.envelope.mode, health, request.now);
  score -= Math.min(50, health.recentFailureCount * 5);
  score += qualityScore(stats.quality, request.risk);
  score -= stats.retryCount === undefined ? 0 : Math.min(20, stats.retryCount * 2);
  score += latencyScore(request.envelope.mode, stats.latencyMs);
  score += concurrencyScore(health);
  if (request.task === 'review' && implementationFamily !== undefined) {
    if (provider.family !== implementationFamily) {
      score += familyAlternatives ? 100 : 0;
    } else if (familyAlternatives) {
      score -= 100;
    }
  }
  return score;
}

function quotaScore(mode: ModelRoutingMode, pressure: ProviderHealthRecord['quotaPressure']): number {
  const scores: Record<ModelRoutingMode, Record<ProviderHealthRecord['quotaPressure'], number>> = {
    eco: { low: 45, medium: 20, unknown: 0, high: -50 },
    balanced: { low: 30, medium: 15, unknown: 0, high: -25 },
    max: { low: 10, medium: 5, unknown: 0, high: -5 },
  };
  return scores[mode][pressure];
}

function quotaResetScore(
  mode: ModelRoutingMode,
  health: ProviderHealthRecord,
  now: string | undefined
): number {
  if (
    mode === 'max' ||
    health.quotaPressure !== 'high' ||
    !isKnownTimestamp(health.quotaResetAt) ||
    now === undefined
  ) {
    return 0;
  }
  const resetAt = Date.parse(health.quotaResetAt);
  const current = Date.parse(now);
  if (!Number.isFinite(resetAt) || !Number.isFinite(current)) return 0;
  const untilResetMs = resetAt - current;
  if (untilResetMs < 0) return 0;
  if (untilResetMs <= 60 * 60 * 1_000) return 10;
  if (untilResetMs > 24 * 60 * 60 * 1_000) return -10;
  return 0;
}

function qualityScore(quality: OutcomeQuality, risk: ModelRoutingRequest['risk']): number {
  const base: Record<OutcomeQuality, number> = {
    excellent: 45,
    good: 25,
    unknown: 0,
    poor: -30,
  };
  const riskMultiplier = risk === 'critical' ? 2 : risk === 'high' ? 1.5 : 1;
  return Math.round(base[quality] * riskMultiplier);
}

function latencyScore(mode: ModelRoutingMode, latencyMs: number | undefined): number {
  if (latencyMs === undefined || mode === 'max') return 0;
  return Math.max(-25, 20 - Math.floor(latencyMs / 1_000));
}

function concurrencyScore(health: ProviderHealthRecord): number {
  if (health.activeRuns === 0) return 10;
  return Math.max(-20, 10 - health.activeRuns * 5);
}

function reasonFacts(
  request: ModelRoutingRequest,
  provider: ProviderRegistryRecord,
  health: ProviderHealthRecord,
  model: ModelCatalogRecord,
  stats: ObservedStats,
  implementationFamily: string | undefined,
  familyAlternatives: boolean
): readonly string[] {
  const quota = isKnownNumber(health.quotaRemaining)
    ? String(health.quotaRemaining)
    : 'unknown';
  const latency = stats.latencyMs === undefined ? 'unknown' : `${stats.latencyMs}ms`;
  const concurrency = isKnownNumber(health.maxConcurrentRuns)
    ? `${health.activeRuns}/${health.maxConcurrentRuns}`
    : `${health.activeRuns}/unknown`;
  const facts = [
    `provider=${provider.providerId}`,
    `family=${provider.family}`,
    `model=${model.modelId}`,
    `health=${health.status}`,
    `auth=${health.auth}`,
    `quota pressure=${health.quotaPressure}`,
    `quota remaining=${quota}`,
    `quota reset=${isKnownTimestamp(health.quotaResetAt) ? health.quotaResetAt : 'unknown'}`,
    `observed quality=${stats.quality}`,
    `observed latency=${latency}`,
    `concurrency=${concurrency}`,
  ];
  if (request.task === 'review' && implementationFamily !== undefined) {
    facts.push(
      provider.family !== implementationFamily
        ? 'reviewer-family independence=preferred'
        : familyAlternatives
          ? 'reviewer-family independence=not preferred'
          : 'reviewer-family independence=unavailable'
    );
  }
  if (request.fallbackFromProvider !== undefined) {
    facts.push(`fallback after=${request.fallbackFromProvider}`);
  }
  return facts;
}

function assertSnapshotIntegrity(
  providers: readonly ProviderRegistryRecord[],
  models: readonly ModelCatalogRecord[],
  health: readonly ProviderHealthRecord[],
  usage: readonly UsageLedgerRecord[]
): void {
  const projectIds = new Set([
    ...providers.map((record) => record.projectId),
    ...models.map((record) => record.projectId),
    ...health.map((record) => record.projectId),
    ...usage.map((record) => record.projectId),
  ]);
  if (projectIds.size > 1) throw new Error('Model routing snapshot crosses project boundaries');

  assertUnique(providers.map((record) => record.providerId), 'provider');
  assertUnique(health.map((record) => record.providerId), 'provider health');
  assertUnique(
    models.map((record) => `${record.providerId}\0${record.modelId}`),
    'model catalog entry'
  );
  assertUnique(usage.map((record) => record.id), 'usage ledger entry');
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Model routing snapshot contains duplicate ${label} records`);
  }
}
