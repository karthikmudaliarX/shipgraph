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

function decision(): ModelRoutingDecision {
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
        id, ticket_id, base_sha, branch_name, status, started_at, project_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('run-1', 'KAR-1', '0'.repeat(40), 'agent/model-telemetry', 'SUCCEEDED', now, projectId, now, now);
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
});
