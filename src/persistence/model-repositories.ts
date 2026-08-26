import type { DbConnection } from './db.js';
import {
  modelRoutingDecisionSchema,
  modelProviderIdSchema,
  modelCatalogRecordSchema,
  providerHealthRecordSchema,
  providerRegistryRecordSchema,
  usageLedgerRecordSchema,
  type ModelCatalogRecord,
  type ModelProviderId,
  type ModelRoutingDecision,
  type ProviderHealthRecord,
  type ProviderRegistryRecord,
  type UsageLedgerRecord,
} from '../domain/model-provider.js';

export type ProviderSnapshotPersistence = {
  provider: ProviderRegistryRecord;
  health: ProviderHealthRecord;
  models: readonly ModelCatalogRecord[];
  catalogStatus: 'known' | 'unknown';
};

export interface ModelRepository {
  replaceProviderSnapshot(snapshot: ProviderSnapshotPersistence): void;
  listProviders(projectId: string): readonly ProviderRegistryRecord[];
  listModels(projectId: string, providerId?: ModelProviderId): readonly ModelCatalogRecord[];
  findHealth(projectId: string, providerId: ModelProviderId): ProviderHealthRecord | undefined;
  listHealth(projectId: string): readonly ProviderHealthRecord[];
  upsertProviderHealth(health: ProviderHealthRecord): ProviderHealthRecord;
  appendUsage(entry: UsageLedgerRecord): UsageLedgerRecord;
  listUsage(projectId: string): readonly UsageLedgerRecord[];
  appendRoutingDecision(decision: ModelRoutingDecision): ModelRoutingDecision;
  reserveProviderCapacityAndAppendRoutingDecision(
    decision: ModelRoutingDecision
  ): ModelRoutingDecision | undefined;
  listRoutingDecisions(projectId: string): readonly ModelRoutingDecision[];
}

export function createModelRepository(db: DbConnection): ModelRepository {
  const replaceProviderSnapshot = db.transaction(
    (snapshot: ProviderSnapshotPersistence): void => {
      const provider = providerRegistryRecordSchema.parse(snapshot.provider);
      const health = providerHealthRecordSchema.parse(snapshot.health);
      if (provider.projectId !== health.projectId || provider.providerId !== health.providerId) {
        throw new Error('Provider and health snapshots must identify the same project/provider');
      }
      const models = snapshot.models.map((model) => modelCatalogRecordSchema.parse(model));
      if (
        models.some(
          (model) => model.projectId !== provider.projectId || model.providerId !== provider.providerId
        )
      ) {
        throw new Error('Discovered models must identify the same project/provider as the snapshot');
      }

      const existing = db
        .prepare(
          `SELECT checked_at FROM provider_registry
           WHERE project_id = ? AND provider_id = ?`
        )
        .get(provider.projectId, provider.providerId) as { checked_at: string } | undefined;
      // A delayed probe must never overwrite a newer refresh from another
      // ShipGraph process. Compare instants rather than timestamp text so
      // offsets cannot change the ordering.
      if (existing && isLaterTimestamp(existing.checked_at, provider.checkedAt)) return;

      const existingHealthRow = db
        .prepare(
          `SELECT * FROM provider_health
           WHERE project_id = ? AND provider_id = ?`
        )
        .get(provider.projectId, provider.providerId) as Record<string, unknown> | undefined;
      const currentHealth = existingHealthRow === undefined
        ? undefined
        : rowToHealth(existingHealthRow);
      const healthToPersist = currentHealth !== undefined && isLaterTimestamp(currentHealth.updatedAt, health.updatedAt)
        ? currentHealth
        : health;

      db.prepare(
        `INSERT INTO provider_registry (
          project_id, provider_id, family, display_name, configured, availability,
          version, capabilities_json, catalog_status, catalog_reason, checked_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, provider_id) DO UPDATE SET
          family = excluded.family,
          display_name = excluded.display_name,
          configured = excluded.configured,
          availability = excluded.availability,
          version = excluded.version,
          capabilities_json = excluded.capabilities_json,
          catalog_status = excluded.catalog_status,
          catalog_reason = excluded.catalog_reason,
          checked_at = excluded.checked_at,
          updated_at = excluded.updated_at`
      ).run(
        provider.projectId,
        provider.providerId,
        provider.family,
        provider.displayName,
        provider.configured ? 1 : 0,
        provider.availability,
        provider.version ?? null,
        JSON.stringify(provider.capabilities),
        provider.catalogStatus,
        provider.catalogReason ?? null,
        provider.checkedAt,
        provider.updatedAt
      );
      upsertHealth(healthToPersist);

      if (snapshot.catalogStatus === 'known') {
        db.prepare(
          'DELETE FROM model_catalog WHERE project_id = ? AND provider_id = ?'
        ).run(provider.projectId, provider.providerId);
        const insert = db.prepare(
          `INSERT INTO model_catalog (
            project_id, provider_id, model_id, capabilities_json, context_window, discovered_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        );
        for (const model of models) {
          insert.run(
            model.projectId,
            model.providerId,
            model.modelId,
            JSON.stringify(model.capabilities),
            model.contextWindow ?? null,
            model.discoveredAt
          );
        }
      }
    }
  ).immediate;

  const upsertHealth = (health: ProviderHealthRecord): ProviderHealthRecord => {
    const parsed = providerHealthRecordSchema.parse(health);
    db.prepare(
      `INSERT INTO provider_health (
        project_id, provider_id, status, auth, quota_pressure, quota_remaining_json,
        quota_reset_at_json, recent_failure_count, active_runs, max_concurrent_runs_json,
        last_failure_at, last_success_at, checked_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, provider_id) DO UPDATE SET
        status = excluded.status,
        auth = excluded.auth,
        quota_pressure = excluded.quota_pressure,
        quota_remaining_json = excluded.quota_remaining_json,
        quota_reset_at_json = excluded.quota_reset_at_json,
        recent_failure_count = excluded.recent_failure_count,
        active_runs = excluded.active_runs,
        max_concurrent_runs_json = excluded.max_concurrent_runs_json,
        last_failure_at = excluded.last_failure_at,
        last_success_at = excluded.last_success_at,
        checked_at = excluded.checked_at,
        updated_at = excluded.updated_at`
    ).run(
      parsed.projectId,
      parsed.providerId,
      parsed.status,
      parsed.auth,
      parsed.quotaPressure,
      JSON.stringify(parsed.quotaRemaining),
      JSON.stringify(parsed.quotaResetAt),
      parsed.recentFailureCount,
      parsed.activeRuns,
      JSON.stringify(parsed.maxConcurrentRuns),
      parsed.lastFailureAt ?? null,
      parsed.lastSuccessAt ?? null,
      parsed.checkedAt,
      parsed.updatedAt
    );
    return parsed;
  };

  return {
    replaceProviderSnapshot,
    listProviders(projectId): readonly ProviderRegistryRecord[] {
      const rows = db
        .prepare(
          `SELECT * FROM provider_registry
           WHERE project_id = ? ORDER BY provider_id`
        )
        .all(projectId);
      return rows.map((row) => rowToProvider(row as Record<string, unknown>));
    },
    listModels(projectId, providerId): readonly ModelCatalogRecord[] {
      const query = providerId === undefined
        ? `SELECT * FROM model_catalog
           WHERE project_id = ? ORDER BY provider_id, model_id`
        : `SELECT * FROM model_catalog
           WHERE project_id = ? AND provider_id = ? ORDER BY model_id`;
      const rows = providerId === undefined
        ? db.prepare(query).all(projectId)
        : db.prepare(query).all(projectId, modelProviderIdSchema.parse(providerId));
      return rows.map((row) => rowToModel(row as Record<string, unknown>));
    },
    findHealth(projectId, providerId): ProviderHealthRecord | undefined {
      const row = db
        .prepare(
          `SELECT * FROM provider_health
           WHERE project_id = ? AND provider_id = ?`
        )
        .get(projectId, modelProviderIdSchema.parse(providerId)) as Record<string, unknown> | undefined;
      return row ? rowToHealth(row) : undefined;
    },
    listHealth(projectId): readonly ProviderHealthRecord[] {
      const rows = db
        .prepare(
          `SELECT * FROM provider_health
           WHERE project_id = ? ORDER BY provider_id`
        )
        .all(projectId);
      return rows.map((row) => rowToHealth(row as Record<string, unknown>));
    },
    upsertProviderHealth: upsertHealth,
    appendUsage(entry): UsageLedgerRecord {
      const parsed = usageLedgerRecordSchema.parse(entry);
      const run = db
        .prepare('SELECT project_id FROM runs WHERE id = ?')
        .get(parsed.runId) as { project_id: string | null } | undefined;
      if (run === undefined || run.project_id !== parsed.projectId) {
        throw new Error(
          `Usage ledger run ${parsed.runId} is not a durable run in project ${parsed.projectId}`
        );
      }
      db.prepare(
        `INSERT INTO usage_ledger (
          id, project_id, run_id, provider_id, model_id, task, retry_count, elapsed_ms,
          outcome, outcome_quality, input_tokens_json, output_tokens_json, cost_json,
          quota_remaining_json, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        parsed.id,
        parsed.projectId,
        parsed.runId,
        parsed.providerId,
        parsed.modelId,
        parsed.task,
        parsed.retryCount,
        parsed.elapsedMs,
        parsed.outcome,
        parsed.outcomeQuality,
        JSON.stringify(parsed.inputTokens),
        JSON.stringify(parsed.outputTokens),
        JSON.stringify(parsed.cost),
        JSON.stringify(parsed.quotaRemaining),
        parsed.recordedAt
      );
      return parsed;
    },
    listUsage(projectId): readonly UsageLedgerRecord[] {
      const rows = db
        .prepare(
          `SELECT * FROM usage_ledger
           WHERE project_id = ? ORDER BY recorded_at, id`
        )
        .all(projectId);
      return rows.map((row) => rowToUsage(row as Record<string, unknown>));
    },
    appendRoutingDecision,
    reserveProviderCapacityAndAppendRoutingDecision,
    listRoutingDecisions(projectId): readonly ModelRoutingDecision[] {
      const rows = db
        .prepare(
          `SELECT * FROM routing_decisions
           WHERE project_id = ? ORDER BY created_at, id`
        )
        .all(projectId);
      return rows.map((row) => rowToRoutingDecision(row as Record<string, unknown>));
    },
  };

  function insertRoutingDecision(decision: ModelRoutingDecision): ModelRoutingDecision {
    const parsed = modelRoutingDecisionSchema.parse(decision);
    db.prepare(
      `INSERT INTO routing_decisions (
        id, project_id, request_id, task, risk, mode, provider_id, provider_family,
        model_id, reason, candidates_considered, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      parsed.id,
      parsed.projectId,
      parsed.requestId,
      parsed.task,
      parsed.risk,
      parsed.mode,
      parsed.providerId,
      parsed.providerFamily,
      parsed.modelId,
      parsed.reason,
      parsed.candidatesConsidered,
      parsed.createdAt
    );
    return parsed;
  }

  function reserveProviderCapacityAndAppendRoutingDecision(
    decision: ModelRoutingDecision
  ): ModelRoutingDecision | undefined {
    const reserve = db.transaction(
      (decision: ModelRoutingDecision): ModelRoutingDecision | undefined => {
        const parsed = modelRoutingDecisionSchema.parse(decision);
        const providerRow = db
          .prepare(
            `SELECT * FROM provider_registry
             WHERE project_id = ? AND provider_id = ?`
          )
          .get(parsed.projectId, parsed.providerId) as Record<string, unknown> | undefined;
        if (providerRow === undefined) return undefined;
        const provider = rowToProvider(providerRow);
        if (
          !provider.configured ||
          provider.availability !== 'available' ||
          provider.catalogStatus !== 'known' ||
          provider.family !== parsed.providerFamily ||
          !provider.capabilities.includes(parsed.task)
        ) {
          return undefined;
        }

        const modelRow = db
          .prepare(
            `SELECT * FROM model_catalog
             WHERE project_id = ? AND provider_id = ? AND model_id = ?`
          )
          .get(parsed.projectId, parsed.providerId, parsed.modelId) as Record<string, unknown> | undefined;
        if (modelRow === undefined) return undefined;
        const model = rowToModel(modelRow);
        if (!model.capabilities.includes(parsed.task)) return undefined;

        const healthRow = db
          .prepare(
            `SELECT * FROM provider_health
             WHERE project_id = ? AND provider_id = ?`
          )
          .get(parsed.projectId, parsed.providerId) as Record<string, unknown> | undefined;
        if (healthRow === undefined) return undefined;
        const health = rowToHealth(healthRow);
        if (
          (health.status !== 'healthy' && health.status !== 'degraded') ||
          health.auth === 'unauthenticated' ||
          (typeof health.quotaRemaining === 'number' && health.quotaRemaining <= 0) ||
          (typeof health.maxConcurrentRuns === 'number' && health.activeRuns >= health.maxConcurrentRuns) ||
          health.activeRuns >= 1_000_000
        ) {
          return undefined;
        }

        upsertHealth({
          ...health,
          activeRuns: health.activeRuns + 1,
          updatedAt: parsed.createdAt,
        });
        return insertRoutingDecision(parsed);
      }
    ).immediate;
    return reserve(decision);
  }

  function appendRoutingDecision(decision: ModelRoutingDecision): ModelRoutingDecision {
    return insertRoutingDecision(decision);
  }

  function rowToProvider(row: Record<string, unknown>): ProviderRegistryRecord {
    return providerRegistryRecordSchema.parse({
      projectId: requiredText(row.project_id),
      providerId: modelProviderIdSchema.parse(requiredText(row.provider_id)),
      family: requiredText(row.family),
      displayName: requiredText(row.display_name),
      configured: requiredBoolean(row.configured),
      availability: row.availability,
      ...(row.version === null || row.version === undefined ? {} : { version: requiredText(row.version) }),
      capabilities: parseJson(row.capabilities_json),
      catalogStatus: row.catalog_status,
      ...(row.catalog_reason === null || row.catalog_reason === undefined
        ? {}
        : { catalogReason: requiredText(row.catalog_reason) }),
      checkedAt: requiredText(row.checked_at),
      updatedAt: requiredText(row.updated_at),
    });
  }

  function rowToModel(row: Record<string, unknown>): ModelCatalogRecord {
    return modelCatalogRecordSchema.parse({
      projectId: requiredText(row.project_id),
      providerId: modelProviderIdSchema.parse(requiredText(row.provider_id)),
      modelId: requiredText(row.model_id),
      capabilities: parseJson(row.capabilities_json),
      ...(row.context_window === null || row.context_window === undefined
        ? {}
        : { contextWindow: requiredNumber(row.context_window) }),
      discoveredAt: requiredText(row.discovered_at),
    });
  }

  function rowToHealth(row: Record<string, unknown>): ProviderHealthRecord {
    return providerHealthRecordSchema.parse({
      projectId: requiredText(row.project_id),
      providerId: modelProviderIdSchema.parse(requiredText(row.provider_id)),
      status: row.status,
      auth: row.auth,
      quotaPressure: row.quota_pressure,
      quotaRemaining: parseJson(row.quota_remaining_json),
      quotaResetAt: parseJson(row.quota_reset_at_json),
      recentFailureCount: requiredNumber(row.recent_failure_count),
      activeRuns: requiredNumber(row.active_runs),
      maxConcurrentRuns: parseJson(row.max_concurrent_runs_json),
      ...(row.last_failure_at === null || row.last_failure_at === undefined
        ? {}
        : { lastFailureAt: requiredText(row.last_failure_at) }),
      ...(row.last_success_at === null || row.last_success_at === undefined
        ? {}
        : { lastSuccessAt: requiredText(row.last_success_at) }),
      checkedAt: requiredText(row.checked_at),
      updatedAt: requiredText(row.updated_at),
    });
  }

  function rowToUsage(row: Record<string, unknown>): UsageLedgerRecord {
    return usageLedgerRecordSchema.parse({
      id: requiredText(row.id),
      projectId: requiredText(row.project_id),
      runId: requiredText(row.run_id),
      providerId: modelProviderIdSchema.parse(requiredText(row.provider_id)),
      modelId: requiredText(row.model_id),
      task: row.task,
      retryCount: requiredNumber(row.retry_count),
      elapsedMs: requiredNumber(row.elapsed_ms),
      outcome: row.outcome,
      outcomeQuality: row.outcome_quality,
      inputTokens: parseJson(row.input_tokens_json),
      outputTokens: parseJson(row.output_tokens_json),
      cost: parseJson(row.cost_json),
      quotaRemaining: parseJson(row.quota_remaining_json),
      recordedAt: requiredText(row.recorded_at),
    });
  }

  function rowToRoutingDecision(row: Record<string, unknown>): ModelRoutingDecision {
    return modelRoutingDecisionSchema.parse({
      id: requiredText(row.id),
      projectId: requiredText(row.project_id),
      requestId: requiredText(row.request_id),
      task: row.task,
      risk: row.risk,
      mode: row.mode,
      providerId: modelProviderIdSchema.parse(requiredText(row.provider_id)),
      providerFamily: requiredText(row.provider_family),
      modelId: requiredText(row.model_id),
      reason: requiredText(row.reason),
      candidatesConsidered: requiredNumber(row.candidates_considered),
      createdAt: requiredText(row.created_at),
    });
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') throw new Error('Persisted model metadata is not JSON text');
  return JSON.parse(value) as unknown;
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Persisted model text is invalid');
  return value;
}

function requiredNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Persisted model number is invalid');
  return value;
}

function requiredBoolean(value: unknown): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  throw new Error('Persisted model boolean is invalid');
}

function isLaterTimestamp(first: string, second: string): boolean {
  const firstMs = Date.parse(first);
  const secondMs = Date.parse(second);
  return Number.isFinite(firstMs) && Number.isFinite(secondMs) && firstMs > secondMs;
}
