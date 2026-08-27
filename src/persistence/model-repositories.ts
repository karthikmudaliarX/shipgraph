import type { DbConnection } from './db.js';
import {
  modelRoutingDecisionSchema,
  MODEL_PROVIDER_TO_AGENT_PROVIDER,
  modelProviderIdSchema,
  UNKNOWN_PROVIDER_CONCURRENCY_LIMIT,
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

export type RoutingReservationLookup = {
  decision: ModelRoutingDecision;
  hasReservation: boolean;
  reservationStatus?: 'active' | 'released';
  runId?: string;
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
    decision: ModelRoutingDecision,
    runId: string
  ): ModelRoutingDecision | undefined;
  findRoutingDecisionByRequest(
    projectId: string,
    requestId: string
  ): RoutingReservationLookup | undefined;
  findRoutingDecisionById(
    projectId: string,
    routingDecisionId: string
  ): RoutingReservationLookup | undefined;
  findActiveRoutingDecisionByRun(
    projectId: string,
    runId: string
  ): RoutingReservationLookup | undefined;
  releaseProviderCapacity(
    projectId: string,
    runId: string,
    routingDecisionId: string,
    providerId: ModelProviderId,
    modelId: string,
    releasedAt: string,
    executionStopped?: boolean
  ): boolean;
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
      if (existing && isAtOrAfterTimestamp(existing.checked_at, provider.checkedAt)) return;

      const existingHealthRow = db
        .prepare(
          `SELECT * FROM provider_health
           WHERE project_id = ? AND provider_id = ?`
        )
        .get(provider.projectId, provider.providerId) as Record<string, unknown> | undefined;
      const currentHealth = existingHealthRow === undefined
        ? undefined
        : rowToHealth(existingHealthRow);
      const healthToPersist = currentHealth === undefined
        ? health
        : isAtOrAfterTimestamp(currentHealth.updatedAt, health.updatedAt)
          ? currentHealth
          : {
              ...health,
              // Probe snapshots do not own provider concurrency. Preserve the
              // reservation-maintained count even when a delayed refresh is
              // newer than the snapshot that was read before a reservation.
              activeRuns: currentHealth.activeRuns,
            };

      db.prepare(
        `INSERT INTO provider_registry (
          project_id, provider_id, family, display_name, configured, availability,
          execution_status, execution_provider, execution_reason,
          version, capabilities_json, catalog_status, catalog_reason, checked_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, provider_id) DO UPDATE SET
          family = excluded.family,
          display_name = excluded.display_name,
          configured = excluded.configured,
          availability = excluded.availability,
          execution_status = excluded.execution_status,
          execution_provider = excluded.execution_provider,
          execution_reason = excluded.execution_reason,
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
        provider.executionStatus,
        provider.executionProvider ?? null,
        provider.executionReason ?? null,
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
      if (parsed.routingDecisionId !== undefined) {
        const reservation = db
          .prepare(
            `SELECT reservations.project_id, reservations.run_id, reservations.provider_id,
                    reservations.model_id, decisions.task
             FROM provider_capacity_reservations AS reservations
             INNER JOIN routing_decisions AS decisions
               ON decisions.id = reservations.routing_decision_id
             WHERE reservations.routing_decision_id = ?`
          )
          .get(parsed.routingDecisionId) as {
            project_id: string;
            run_id: string | null;
            provider_id: string;
            model_id: string;
            task: string;
          } | undefined;
        if (
          reservation === undefined ||
          reservation.project_id !== parsed.projectId ||
          reservation.run_id !== parsed.runId ||
          reservation.provider_id !== parsed.providerId ||
          reservation.model_id !== parsed.modelId ||
          reservation.task !== parsed.task
        ) {
          throw new Error(
            `Usage ledger routing decision ${parsed.routingDecisionId} does not belong to run ${parsed.runId}`
          );
        }
        const existingUsage = db
          .prepare(
            `SELECT id FROM usage_ledger
             WHERE routing_decision_id = ?`
          )
          .get(parsed.routingDecisionId) as { id: string } | undefined;
        if (existingUsage !== undefined) {
          throw new Error(
            `Usage ledger routing decision ${parsed.routingDecisionId} was already finalized`
          );
        }
      }
      db.prepare(
        `INSERT INTO usage_ledger (
          id, project_id, run_id, routing_decision_id, provider_id, model_id, task, retry_count, elapsed_ms,
          outcome, outcome_quality, input_tokens_json, output_tokens_json, cost_json,
          quota_remaining_json, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        parsed.id,
        parsed.projectId,
        parsed.runId,
        parsed.routingDecisionId ?? null,
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
    findRoutingDecisionByRequest,
    findRoutingDecisionById,
    findActiveRoutingDecisionByRun,
    releaseProviderCapacity,
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
        model_id, reason, candidates_considered, request_fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      parsed.requestFingerprint ?? null,
      parsed.createdAt
    );
    return parsed;
  }

  function reserveProviderCapacityAndAppendRoutingDecision(
    decision: ModelRoutingDecision,
    runId: string
  ): ModelRoutingDecision | undefined {
    const reserve = db.transaction(
      (decision: ModelRoutingDecision, runId: string): ModelRoutingDecision | undefined => {
        const parsed = modelRoutingDecisionSchema.parse(decision);
        const parsedRunId = validateRunId(runId);
        const durableRun = db
          .prepare('SELECT project_id, provider, model, model_provider_id, status FROM runs WHERE id = ?')
          .get(parsedRunId) as {
            project_id: string | null;
            provider: string | null;
            model: string | null;
            model_provider_id: string | null;
            status: string;
          } | undefined;
        if (durableRun === undefined || durableRun.project_id !== parsed.projectId) {
          throw new Error(
            `Routing run ${parsedRunId} is not a durable run in project ${parsed.projectId}`
          );
        }
        if (durableRun.status !== 'CREATED') {
          throw new Error(
            `Routing run ${parsedRunId} is ${durableRun.status}; routing requires a CREATED run`
          );
        }
        const expectedAgentProvider = MODEL_PROVIDER_TO_AGENT_PROVIDER[parsed.providerId];
        if (
          durableRun.provider !== expectedAgentProvider ||
          durableRun.model !== parsed.modelId ||
          durableRun.model_provider_id !== parsed.providerId
        ) {
          throw new Error(
            `Routing run ${parsedRunId} does not identify ${parsed.providerId}/${parsed.modelId}`
          );
        }
        const existingReservationRow = db
          .prepare(
            `SELECT routing_decision_id, run_id, status FROM provider_capacity_reservations
             WHERE project_id = ? AND request_id = ?`
          )
          .get(parsed.projectId, parsed.requestId) as {
            routing_decision_id: string;
            run_id: string | null;
            status: 'active' | 'released';
          } | undefined;
        if (existingReservationRow !== undefined) {
          if (existingReservationRow.run_id !== parsedRunId) {
            throw new Error(
              `Routing request ${parsed.requestId} is already reserved by another durable run`
            );
          }
          if (existingReservationRow.status !== 'active') {
            throw new Error(
              `Routing request ${parsed.requestId} has a released capacity reservation; use a new request ID to retry`
            );
          }
          const existingDecisionRow = db
            .prepare('SELECT * FROM routing_decisions WHERE id = ?')
            .get(existingReservationRow.routing_decision_id) as Record<string, unknown> | undefined;
          if (existingDecisionRow === undefined) {
            throw new Error(
              `Routing request ${parsed.requestId} has a reservation without its decision`
            );
          }
          const existingDecision = rowToRoutingDecision(existingDecisionRow);
          if (
            existingDecision.task !== parsed.task ||
            existingDecision.risk !== parsed.risk ||
            existingDecision.mode !== parsed.mode ||
            existingDecision.providerId !== parsed.providerId ||
            existingDecision.providerFamily !== parsed.providerFamily ||
            existingDecision.modelId !== parsed.modelId
          ) {
            throw new Error(`Routing request ${parsed.requestId} was reused for a different route`);
          }
          if (
            existingDecision.requestFingerprint === undefined ||
            parsed.requestFingerprint === undefined ||
            existingDecision.requestFingerprint !== parsed.requestFingerprint
          ) {
            throw new Error(
              `Routing request ${parsed.requestId} was reused with different routing constraints`
            );
          }
          return existingDecision;
        }
        const activeRunReservation = db
          .prepare(
            `SELECT routing_decision_id
             FROM provider_capacity_reservations
             WHERE project_id = ? AND run_id = ? AND status = 'active'`
          )
          .get(parsed.projectId, parsedRunId) as { routing_decision_id: string } | undefined;
        if (activeRunReservation !== undefined) {
          throw new Error(
            `Durable run ${parsedRunId} already owns provider capacity reservation ${activeRunReservation.routing_decision_id}`
          );
        }
        const historicalDecision = db
          .prepare(
            `SELECT id FROM routing_decisions
             WHERE project_id = ? AND request_id = ? LIMIT 1`
          )
          .get(parsed.projectId, parsed.requestId) as { id: string } | undefined;
        if (historicalDecision !== undefined) {
          throw new Error(
            `Routing request ${parsed.requestId} has no recoverable capacity reservation`
          );
        }
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
          provider.executionStatus !== 'available' ||
          provider.executionProvider === undefined ||
          provider.executionProvider !== MODEL_PROVIDER_TO_AGENT_PROVIDER[provider.providerId] ||
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
          health.activeRuns >= (
            typeof health.maxConcurrentRuns === 'number'
              ? health.maxConcurrentRuns
              : UNKNOWN_PROVIDER_CONCURRENCY_LIMIT
          ) ||
          health.activeRuns >= 1_000_000
        ) {
          return undefined;
        }

        upsertHealth({
          ...health,
          activeRuns: health.activeRuns + 1,
          updatedAt: parsed.createdAt,
        });
        const persisted = insertRoutingDecision(parsed);
        db.prepare(
          `INSERT INTO provider_capacity_reservations (
            routing_decision_id, project_id, request_id, provider_id, model_id,
            run_id, status, reserved_at, released_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL)`
        ).run(
          persisted.id,
          persisted.projectId,
          persisted.requestId,
          persisted.providerId,
          persisted.modelId,
          parsedRunId,
          persisted.createdAt
        );
        return persisted;
      }
    ).immediate;
    return reserve(decision, runId);
  }

  function appendRoutingDecision(decision: ModelRoutingDecision): ModelRoutingDecision {
    return insertRoutingDecision(decision);
  }

  function findRoutingDecisionByRequest(
    projectId: string,
    requestId: string
  ): RoutingReservationLookup | undefined {
    const rows = db
      .prepare(
        `SELECT decisions.*,
                reservations.run_id,
                reservations.routing_decision_id AS reservation_id,
                reservations.status AS reservation_status
         FROM routing_decisions AS decisions
         LEFT JOIN provider_capacity_reservations AS reservations
           ON reservations.routing_decision_id = decisions.id
          AND reservations.project_id = decisions.project_id
          AND reservations.provider_id = decisions.provider_id
          AND reservations.model_id = decisions.model_id
         WHERE decisions.project_id = ? AND decisions.request_id = ?
         ORDER BY decisions.created_at, decisions.id`
      )
      .all(projectId, requestId) as Array<Record<string, unknown>>;
    if (rows.length > 1) {
      throw new Error(
        `Routing request ${requestId} has multiple persisted decisions; refusing replay`
      );
    }
    const row = rows[0];
    if (row === undefined) return undefined;
    return rowToRoutingReservationLookup(row);
  }

  function findRoutingDecisionById(
    projectId: string,
    routingDecisionId: string
  ): RoutingReservationLookup | undefined {
    const row = db
      .prepare(
        `SELECT decisions.*,
                reservations.run_id,
                reservations.routing_decision_id AS reservation_id,
                reservations.status AS reservation_status
         FROM routing_decisions AS decisions
         LEFT JOIN provider_capacity_reservations AS reservations
           ON reservations.routing_decision_id = decisions.id
          AND reservations.project_id = decisions.project_id
          AND reservations.provider_id = decisions.provider_id
          AND reservations.model_id = decisions.model_id
         WHERE decisions.project_id = ? AND decisions.id = ?`
      )
      .get(projectId, routingDecisionId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowToRoutingReservationLookup(row);
  }

  function findActiveRoutingDecisionByRun(
    projectId: string,
    runId: string
  ): RoutingReservationLookup | undefined {
    const parsedRunId = validateRunId(runId);
    const rows = db
      .prepare(
        `SELECT decisions.*,
                reservations.run_id,
                reservations.routing_decision_id AS reservation_id,
                reservations.status AS reservation_status
         FROM routing_decisions AS decisions
         INNER JOIN provider_capacity_reservations AS reservations
           ON reservations.routing_decision_id = decisions.id
         WHERE decisions.project_id = ?
           AND reservations.project_id = ?
           AND reservations.run_id = ?
           AND reservations.status = 'active'
         ORDER BY decisions.created_at, decisions.id`
      )
      .all(projectId, projectId, parsedRunId) as Array<Record<string, unknown>>;
    if (rows.length > 1) {
      throw new Error(
        `Durable run ${parsedRunId} has multiple active routing decisions; refusing replay`
      );
    }
    const row = rows[0];
    return row === undefined ? undefined : rowToRoutingReservationLookup(row);
  }

  function rowToRoutingReservationLookup(
    row: Record<string, unknown>
  ): RoutingReservationLookup {
    return {
      decision: rowToRoutingDecision(row),
      hasReservation: row.reservation_id !== null && row.reservation_id !== undefined,
      ...(row.reservation_status === null || row.reservation_status === undefined
        ? {}
        : { reservationStatus: parseReservationStatus(row.reservation_status) }),
      ...(row.run_id === null || row.run_id === undefined
        ? {}
        : { runId: validateRunId(row.run_id) }),
    };
  }

  /** Called by the service's enclosing transaction after usage is appended. */
  function releaseProviderCapacity(
    projectId: string,
    runId: string,
    routingDecisionId: string,
    providerId: ModelProviderId,
    modelId: string,
    releasedAt: string,
    executionStopped = false
  ): boolean {
    const parsedRunId = validateRunId(runId);
    const reservation = db
      .prepare(
        `SELECT project_id, run_id, provider_id, model_id, status
         FROM provider_capacity_reservations
         WHERE routing_decision_id = ?`
      )
      .get(routingDecisionId) as {
        project_id: string;
        run_id: string | null;
        provider_id: string;
        model_id: string;
        status: string;
      } | undefined;
    if (
      reservation === undefined ||
      reservation.project_id !== projectId ||
      reservation.run_id !== parsedRunId ||
      reservation.provider_id !== providerId ||
      reservation.model_id !== modelId
    ) {
      throw new Error(
        `Routing decision ${routingDecisionId} does not belong to run ${parsedRunId}`
      );
    }
    if (reservation.status === 'released') return false;
    if (reservation.status !== 'active') {
      throw new Error(`Routing decision ${routingDecisionId} has an invalid reservation state`);
    }

    // Telemetry may be recorded while a durable run is still active, but it
    // cannot release the provider slot until the AGENT-001 attempt is known to
    // have stopped. This keeps a premature usage report from admitting a
    // second process alongside the first one.
    const run = db
      .prepare('SELECT status FROM runs WHERE id = ? AND project_id = ?')
      .get(parsedRunId, projectId) as { status: string } | undefined;
    if (run === undefined) {
      throw new Error(`Routing decision ${routingDecisionId} has no owning run`);
    }
    if (!TERMINAL_RUN_STATUSES.has(run.status)) return false;
    // NEEDS_HUMAN is also the explicit post-restart recovery state. In that
    // case ShipGraph deliberately cannot prove that a provider process stopped;
    // only the execution service, which has just observed the owned attempt
    // stop, may release that terminal state.
    if (run.status === 'NEEDS_HUMAN' && !executionStopped) return false;

    const healthRow = db
      .prepare(
        `SELECT * FROM provider_health
         WHERE project_id = ? AND provider_id = ?`
      )
      .get(projectId, providerId) as Record<string, unknown> | undefined;
    if (healthRow === undefined) {
      throw new Error(`Provider health is missing for reservation ${routingDecisionId}`);
    }
    const health = rowToHealth(healthRow);
    if (health.activeRuns <= 0) {
      throw new Error(`Provider capacity is inconsistent for reservation ${routingDecisionId}`);
    }
    const updated = db
      .prepare(
        `UPDATE provider_capacity_reservations
         SET status = 'released', released_at = ?
         WHERE routing_decision_id = ? AND status = 'active'`
      )
      .run(releasedAt, routingDecisionId);
    if (updated.changes === 0) return false;
    upsertHealth({
      ...health,
      activeRuns: health.activeRuns - 1,
      updatedAt: releasedAt,
    });
    return true;
  }

  function rowToProvider(row: Record<string, unknown>): ProviderRegistryRecord {
    return providerRegistryRecordSchema.parse({
      projectId: requiredText(row.project_id),
      providerId: modelProviderIdSchema.parse(requiredText(row.provider_id)),
      family: requiredText(row.family),
      displayName: requiredText(row.display_name),
      configured: requiredBoolean(row.configured),
      availability: row.availability,
      executionStatus: row.execution_status,
      ...(row.execution_provider === null || row.execution_provider === undefined
        ? {}
        : { executionProvider: row.execution_provider }),
      ...(row.execution_reason === null || row.execution_reason === undefined
        ? {}
        : { executionReason: requiredText(row.execution_reason) }),
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
      ...(row.routing_decision_id === null || row.routing_decision_id === undefined
        ? {}
        : { routingDecisionId: requiredText(row.routing_decision_id) }),
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
      ...(row.request_fingerprint === null || row.request_fingerprint === undefined
        ? {}
        : { requestFingerprint: requiredText(row.request_fingerprint) }),
      createdAt: requiredText(row.created_at),
    });
  }

  function validateRunId(runId: unknown): string {
    if (typeof runId !== 'string' || runId.length === 0 || runId.length > 256 || runId.includes('\0')) {
      throw new Error('Routing run ID is invalid');
    }
    return runId;
  }

  function parseReservationStatus(value: unknown): 'active' | 'released' {
    if (value !== 'active' && value !== 'released') {
      throw new Error('Routing reservation has an invalid status');
    }
    return value;
  }
}

const TERMINAL_RUN_STATUSES = new Set([
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'CANCELLED',
  'NEEDS_HUMAN',
]);

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

function isAtOrAfterTimestamp(first: string, second: string): boolean {
  const firstMs = Date.parse(first);
  const secondMs = Date.parse(second);
  return Number.isFinite(firstMs) && Number.isFinite(secondMs) && firstMs >= secondMs;
}
