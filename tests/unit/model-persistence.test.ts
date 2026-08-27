import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrate, type DbConnection } from '../../src/persistence/db.js';
import {
  createModelRepository,
  type ModelRepository,
} from '../../src/persistence/model-repositories.js';
import { createProjectRepository, createTicketRepository } from '../../src/persistence/repositories.js';
import type { ShipgraphConfig } from '../../src/config/schema.js';
import type {
  ModelCatalogRecord,
  ModelRoutingDecision,
  ProviderHealthRecord,
  ProviderRegistryRecord,
  UsageLedgerRecord,
} from '../../src/domain/model-provider.js';

const projectId = 'project-1';
const now = '2026-08-27T00:00:00.000Z';

function provider(overrides: Partial<ProviderRegistryRecord> = {}): ProviderRegistryRecord {
  return {
    projectId,
    providerId: 'codex',
    family: 'openai',
    displayName: 'Codex',
    configured: true,
    availability: 'available',
    executionStatus: 'available',
    executionProvider: 'codex',
    capabilities: ['implementation', 'review', 'repair'],
    catalogStatus: 'known',
    checkedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function health(overrides: Partial<ProviderHealthRecord> = {}): ProviderHealthRecord {
  return {
    projectId,
    providerId: 'codex',
    status: 'healthy',
    auth: 'unknown',
    quotaPressure: 'unknown',
    quotaRemaining: 'unknown',
    quotaResetAt: 'unknown',
    recentFailureCount: 0,
    activeRuns: 0,
    maxConcurrentRuns: 'unknown',
    checkedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function model(): ModelCatalogRecord {
  return {
    projectId,
    providerId: 'codex',
    modelId: 'provider/dynamic-model',
    capabilities: ['implementation', 'review'],
    discoveredAt: now,
  };
}

function usage(overrides: Partial<UsageLedgerRecord> = {}): UsageLedgerRecord {
  return {
    id: randomUUID(),
    projectId,
    runId: 'run-1',
    providerId: 'codex',
    modelId: 'provider/dynamic-model',
    task: 'implementation',
    retryCount: 0,
    elapsedMs: 123,
    outcome: 'succeeded',
    outcomeQuality: 'good',
    inputTokens: 'unknown',
    outputTokens: 'unknown',
    cost: 'unknown',
    quotaRemaining: 'unknown',
    recordedAt: now,
    ...overrides,
  };
}

function decision(overrides: Partial<ModelRoutingDecision> = {}): ModelRoutingDecision {
  return {
    id: randomUUID(),
    projectId,
    requestId: 'request-1',
    task: 'implementation',
    risk: 'medium',
    mode: 'balanced',
    providerId: 'codex',
    providerFamily: 'openai',
    modelId: 'provider/dynamic-model',
    reason: 'selected using healthy provider and discovered model',
    candidatesConsidered: 1,
    createdAt: now,
    ...overrides,
  };
}

describe('MODEL-001 persistence', () => {
  let db: DbConnection;
  let repository: ModelRepository;

  beforeEach(() => {
    db = createDatabase(':memory:');
    migrate(db);
    const config: ShipgraphConfig = {
      version: 1,
      project: { name: 'project', repository: 'owner/repo', defaultBranch: 'main' },
      execution: { maxConcurrentTickets: 1, maxRepairIterations: 6 },
      release: { requireHumanApproval: true, requireCleanCI: true, requireExactShaReviews: true },
      agents: { implementer: 'opencode', reviewers: ['correctness'] },
    };
    createProjectRepository(db).create({
      id: projectId,
      name: config.project.name,
      repository: config.project.repository,
      defaultBranch: config.project.defaultBranch,
      config,
      createdAt: now,
      updatedAt: now,
    });
    createTicketRepository(db).create({
      id: 'KAR-1',
      projectId,
      title: 'Model telemetry fixture',
      description: 'Fixture for the append-only usage ledger.',
      priority: 'medium',
      dependsOn: [],
      scope: { allowedPaths: [], forbiddenPaths: [] },
      acceptanceCriteria: [],
      verification: { commands: [] },
      risk: 'medium',
      agent: {},
      release: {},
      status: 'QUEUED',
      createdAt: now,
      updatedAt: now,
    });
    db.prepare(
      `INSERT INTO runs (
        id, ticket_id, base_sha, branch_name, status, started_at, project_id,
        provider, model, model_provider_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'run-1',
      'KAR-1',
      '0'.repeat(40),
      'agent/model-telemetry',
      'CREATED',
      now,
      projectId,
      'codex',
      'provider/dynamic-model',
      'codex',
      now,
      now
    );
    db.prepare(
      `INSERT INTO runs (
        id, ticket_id, base_sha, branch_name, status, started_at, project_id,
        provider, model, model_provider_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'run-2',
      'KAR-1',
      '0'.repeat(40),
      'agent/model-telemetry-2',
      'SUCCEEDED',
      now,
      projectId,
      'codex',
      'provider/dynamic-model',
      'codex',
      now,
      now
    );
    repository = createModelRepository(db);
  });

  afterEach(() => db.close());

  it('stores provider, health and discovered model metadata', () => {
    repository.replaceProviderSnapshot({
      provider: provider(),
      health: health(),
      models: [model()],
      catalogStatus: 'known',
    });

    expect(repository.listProviders(projectId)).toHaveLength(1);
    expect(repository.listHealth(projectId)[0]?.quotaRemaining).toBe('unknown');
    expect(repository.listModels(projectId)).toEqual([model()]);
  });

  it('rejects a persisted MODEL-to-AGENT identity mismatch', () => {
    expect(() => repository.replaceProviderSnapshot({
      provider: provider({ executionProvider: 'acp' }),
      health: health(),
      models: [model()],
      catalogStatus: 'known',
    })).toThrow(/canonical MODEL-001 mapping/);
  });

  it('preserves the previous model catalog when discovery is unknown', () => {
    repository.replaceProviderSnapshot({
      provider: provider(),
      health: health(),
      models: [model()],
      catalogStatus: 'known',
    });
    repository.replaceProviderSnapshot({
      provider: provider({ catalogStatus: 'unknown', catalogReason: 'surface unavailable', checkedAt: '2026-08-27T00:01:00.000Z', updatedAt: '2026-08-27T00:01:00.000Z' }),
      health: health({ checkedAt: '2026-08-27T00:01:00.000Z', updatedAt: '2026-08-27T00:01:00.000Z' }),
      models: [],
      catalogStatus: 'unknown',
    });

    expect(repository.listModels(projectId)).toEqual([model()]);
  });

  it('preserves reservation-maintained active runs across a later provider refresh', () => {
    repository.replaceProviderSnapshot({
      provider: provider(),
      health: health(),
      models: [model()],
      catalogStatus: 'known',
    });
    repository.upsertProviderHealth(health({ activeRuns: 1, updatedAt: '2026-08-27T00:01:00.000Z' }));
    repository.replaceProviderSnapshot({
      provider: provider({ checkedAt: '2026-08-27T00:02:00.000Z', updatedAt: '2026-08-27T00:02:00.000Z' }),
      health: health({ checkedAt: '2026-08-27T00:02:00.000Z', updatedAt: '2026-08-27T00:02:00.000Z' }),
      models: [model()],
      catalogStatus: 'known',
    });

    expect(repository.listHealth(projectId)[0]?.activeRuns).toBe(1);
  });

  it('keeps the first provider snapshot when a concurrent refresh has the same timestamp', () => {
    repository.replaceProviderSnapshot({
      provider: provider(),
      health: health(),
      models: [model()],
      catalogStatus: 'known',
    });
    repository.replaceProviderSnapshot({
      provider: provider({ displayName: 'stale concurrent snapshot' }),
      health: health(),
      models: [{ ...model(), modelId: 'provider/stale-model' }],
      catalogStatus: 'known',
    });

    expect(repository.listProviders(projectId)[0]?.displayName).toBe('Codex');
    expect(repository.listModels(projectId)[0]?.modelId).toBe('provider/dynamic-model');
  });

  it('enforces append-only usage and routing decision records', () => {
    const entry = usage();
    repository.appendUsage(entry);
    const routed = decision();
    repository.appendRoutingDecision(routed);

    expect(repository.listUsage(projectId)).toEqual([entry]);
    expect(repository.listRoutingDecisions(projectId)).toEqual([routed]);
    expect(() => db.prepare('UPDATE usage_ledger SET retry_count = 2 WHERE id = ?').run(entry.id)).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM routing_decisions WHERE id = ?').run(routed.id)).toThrow(/append-only/);
  });

  it('rejects usage that is not linked to a durable run in the same project', () => {
    expect(() => repository.appendUsage(usage({ runId: 'missing-run' }))).toThrow(
      /not a durable run in project/
    );
  });

  it('binds provider capacity and usage release to the owning durable run', () => {
    repository.replaceProviderSnapshot({
      provider: provider(),
      health: health({ maxConcurrentRuns: 1 }),
      models: [model()],
      catalogStatus: 'known',
    });
    const routed = repository.reserveProviderCapacityAndAppendRoutingDecision(
      decision(),
      'run-1'
    );
    if (routed === undefined) throw new Error('missing provider reservation fixture');

    expect(db.prepare(
      'SELECT run_id, status FROM provider_capacity_reservations WHERE routing_decision_id = ?'
    ).get(routed.id)).toEqual({ run_id: 'run-1', status: 'active' });
    expect(() => repository.appendUsage(usage({
      runId: 'run-2',
      routingDecisionId: routed.id,
    }))).toThrow(/does not belong to run/);
    expect(() => repository.releaseProviderCapacity(
      projectId,
      'run-2',
      routed.id,
      routed.providerId,
      routed.modelId,
      now
    )).toThrow(/does not belong to run/);

    repository.appendUsage(usage({ routingDecisionId: routed.id }));
    expect(repository.releaseProviderCapacity(
      projectId,
      'run-1',
      routed.id,
      routed.providerId,
      routed.modelId,
      now
    )).toBe(false);
    expect(repository.listHealth(projectId)[0]?.activeRuns).toBe(1);
    db.prepare('UPDATE runs SET status = ? WHERE id = ?').run('SUCCEEDED', 'run-1');
    expect(repository.releaseProviderCapacity(
      projectId,
      'run-1',
      routed.id,
      routed.providerId,
      routed.modelId,
      now
    )).toBe(true);
    expect(repository.listHealth(projectId)[0]?.activeRuns).toBe(0);
  });

  it('refuses to reserve provider capacity for a non-CREATED run', () => {
    repository.replaceProviderSnapshot({
      provider: provider(),
      health: health({ maxConcurrentRuns: 1 }),
      models: [model()],
      catalogStatus: 'known',
    });
    db.prepare('UPDATE runs SET status = ? WHERE id = ?').run('SUCCEEDED', 'run-1');

    expect(() => repository.reserveProviderCapacityAndAppendRoutingDecision(
      decision(),
      'run-1'
    )).toThrow(/routing requires a CREATED run/);
    expect(db.prepare('SELECT COUNT(*) AS count FROM provider_capacity_reservations').get())
      .toEqual({ count: 0 });
  });

  it('does not replay an existing reservation with a different request fingerprint', () => {
    repository.replaceProviderSnapshot({
      provider: provider(),
      health: health({ maxConcurrentRuns: 1 }),
      models: [model()],
      catalogStatus: 'known',
    });
    const first = repository.reserveProviderCapacityAndAppendRoutingDecision(
      decision({ requestFingerprint: 'a'.repeat(64) }),
      'run-1'
    );
    if (first === undefined) throw new Error('missing provider reservation fixture');

    expect(() => repository.reserveProviderCapacityAndAppendRoutingDecision(
      decision({ requestFingerprint: 'b'.repeat(64) }),
      'run-1'
    )).toThrow(/different routing constraints/);
    expect(repository.listRoutingDecisions(projectId)).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM provider_capacity_reservations').get())
      .toEqual({ count: 1 });
  });
});
