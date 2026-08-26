import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrate, type DbConnection } from '../../src/persistence/db.js';
import { createProjectRepository, createTicketRepository } from '../../src/persistence/repositories.js';
import type { ShipgraphConfig } from '../../src/config/schema.js';
import type {
  ModelProviderAdapter,
  ModelDiscoveryResult,
  ProviderProbeResult,
} from '../../src/adapters/model/adapter.js';
import { ModelRoutingService } from '../../src/model/service.js';

const projectId = 'project-1';
const now = '2026-08-27T00:00:00.000Z';

function createProject(db: DbConnection): void {
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
}

function adapter(
  providerId: 'opencode-go' | 'codex' | 'grok' | 'gemini',
  family: string,
  calls: { probe: number; discover: number }
): ModelProviderAdapter {
  const probeResult: ProviderProbeResult = {
    availability: 'available',
    auth: 'authenticated',
    version: 'test-provider',
    capabilities: ['implementation', 'review', 'repair'],
  };
  const discoveryResult: ModelDiscoveryResult = {
    status: 'known',
    models: [{ modelId: `${providerId}/dynamic`, capabilities: ['implementation', 'review', 'repair'] }],
  };
  return {
    providerId,
    family,
    displayName: providerId,
    probe: async () => {
      calls.probe += 1;
      return probeResult;
    },
    discoverModels: async () => {
      calls.discover += 1;
      return discoveryResult;
    },
  };
}

describe('MODEL-001 service', () => {
  let db: DbConnection;

  beforeEach(() => {
    db = createDatabase(':memory:');
    migrate(db);
    createProject(db);
  });

  afterEach(() => db.close());

  it('refreshes all providers, persists routing reasons, and records unknown usage literally', async () => {
    const calls = { probe: 0, discover: 0 };
    const service = new ModelRoutingService({
      db,
      projectId,
      adapters: [
        adapter('opencode-go', 'opencode', calls),
        adapter('codex', 'openai', calls),
        adapter('grok', 'xai', calls),
        adapter('gemini', 'google', calls),
      ],
      now: () => now,
      createId: (() => {
        let count = 0;
        return () => `id-${++count}`;
      })(),
    });

    await service.refresh();
    const decision = await service.route({
      task: 'implementation',
      risk: 'medium',
      requestId: 'request-1',
      envelope: {
        mode: 'balanced',
        maxConcurrentTickets: 1,
        activeConcurrentTickets: 0,
        budgetRemaining: 'unknown',
      },
    });
    const usage = await service.recordUsage({
      runId: 'run-1',
      providerId: decision.providerId,
      modelId: decision.modelId,
      task: 'implementation',
      retryCount: 0,
      elapsedMs: 200,
      outcome: 'succeeded',
      outcomeQuality: 'unknown',
    });

    expect(calls).toEqual({ probe: 4, discover: 4 });
    expect(service.listRoutingDecisions()[0]?.reason).toBe(decision.reason);
    expect(usage.entry.inputTokens).toBe('unknown');
    expect(usage.entry.outputTokens).toBe('unknown');
    expect(usage.entry.cost).toBe('unknown');
    expect(usage.entry.quotaRemaining).toBe('unknown');
    expect(usage.health.quotaRemaining).toBe('unknown');
  });

  it('refreshes immediately after a provider error while retaining the ledger entry', async () => {
    const calls = { probe: 0, discover: 0 };
    const service = new ModelRoutingService({
      db,
      projectId,
      adapters: [
        adapter('opencode-go', 'opencode', calls),
        adapter('codex', 'openai', calls),
        adapter('grok', 'xai', calls),
        adapter('gemini', 'google', calls),
      ],
      now: () => now,
    });
    await service.refresh();
    const result = await service.recordUsage({
      runId: 'run-1',
      providerId: 'codex',
      modelId: 'codex/dynamic',
      task: 'implementation',
      retryCount: 1,
      elapsedMs: 100,
      outcome: 'failed',
      outcomeQuality: 'poor',
      providerError: 'model_not_found',
    });

    expect(result.refreshed).toBe(true);
    expect(calls.probe).toBe(5);
    expect(calls.discover).toBe(5);
    expect(service.listUsage()).toHaveLength(1);
    expect(service.listHealth().find((health) => health.providerId === 'codex')?.recentFailureCount).toBe(1);
  });

  it('claims known provider capacity atomically across concurrent routes', async () => {
    const calls = { probe: 0, discover: 0 };
    const service = new ModelRoutingService({
      db,
      projectId,
      adapters: [adapter('codex', 'openai', calls)],
      now: () => now,
    });
    await service.refresh();
    const currentHealth = service.listHealth()[0];
    if (currentHealth === undefined) throw new Error('missing provider health fixture');
    service.getRepository().upsertProviderHealth({
      ...currentHealth,
      maxConcurrentRuns: 1,
    });

    const request = {
      task: 'implementation' as const,
      risk: 'medium' as const,
      envelope: {
        mode: 'balanced' as const,
        maxConcurrentTickets: 4,
        activeConcurrentTickets: 0,
        budgetRemaining: 'unknown' as const,
      },
    };
    const attempts = await Promise.allSettled([
      service.route(request),
      service.route(request),
    ]);
    const successful = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<ModelRoutingService['route']>>> =>
        attempt.status === 'fulfilled'
    );
    expect(successful).toHaveLength(1);
    expect(service.listRoutingDecisions()).toHaveLength(1);
    expect(service.listHealth()[0]?.activeRuns).toBe(1);

    const winner = successful[0]?.value;
    if (winner === undefined) throw new Error('missing successful route fixture');
    await service.recordUsage({
      runId: 'run-1',
      providerId: winner.providerId,
      modelId: winner.modelId,
      task: 'implementation',
      retryCount: 0,
      elapsedMs: 10,
      outcome: 'succeeded',
      outcomeQuality: 'good',
      routingDecisionId: winner.id,
    });
    expect(service.listHealth()[0]?.activeRuns).toBe(0);
    await expect(service.route(request)).resolves.toMatchObject({
      providerId: 'codex',
    });
  });

  it('replays a request idempotently without creating another reservation', async () => {
    const calls = { probe: 0, discover: 0 };
    const service = new ModelRoutingService({
      db,
      projectId,
      adapters: [adapter('codex', 'openai', calls)],
      now: () => now,
    });
    await service.refresh();
    const currentHealth = service.listHealth()[0];
    if (currentHealth === undefined) throw new Error('missing provider health fixture');
    service.getRepository().upsertProviderHealth({
      ...currentHealth,
      maxConcurrentRuns: 1,
    });

    const request = {
      requestId: 'stable-route-request',
      task: 'implementation' as const,
      risk: 'medium' as const,
      envelope: {
        mode: 'balanced' as const,
        maxConcurrentTickets: 4,
        activeConcurrentTickets: 0,
        budgetRemaining: 'unknown' as const,
      },
    };
    const first = await service.route(request);
    const replay = await service.route(request);

    expect(replay).toEqual(first);
    expect(service.listRoutingDecisions()).toHaveLength(1);
    expect(service.listHealth()[0]?.activeRuns).toBe(1);

    await service.recordUsage({
      runId: 'run-1',
      providerId: first.providerId,
      modelId: first.modelId,
      task: 'implementation',
      retryCount: 0,
      elapsedMs: 10,
      outcome: 'succeeded',
      outcomeQuality: 'good',
      routingDecisionId: first.id,
    });
    expect(service.listHealth()[0]?.activeRuns).toBe(0);
  });

  it('does not release provider capacity for usage without its routing decision', async () => {
    const calls = { probe: 0, discover: 0 };
    const service = new ModelRoutingService({
      db,
      projectId,
      adapters: [adapter('codex', 'openai', calls)],
      now: () => now,
    });
    await service.refresh();
    const currentHealth = service.listHealth()[0];
    if (currentHealth === undefined) throw new Error('missing provider health fixture');
    service.getRepository().upsertProviderHealth({
      ...currentHealth,
      maxConcurrentRuns: 1,
    });
    const decision = await service.route({
      task: 'implementation',
      risk: 'medium',
      envelope: {
        mode: 'balanced',
        maxConcurrentTickets: 4,
        activeConcurrentTickets: 0,
        budgetRemaining: 'unknown',
      },
    });

    await service.recordUsage({
      runId: 'run-1',
      providerId: decision.providerId,
      modelId: decision.modelId,
      task: 'implementation',
      retryCount: 0,
      elapsedMs: 10,
      outcome: 'succeeded',
      outcomeQuality: 'good',
    });
    expect(service.listHealth()[0]?.activeRuns).toBe(1);
    await expect(service.route({
      task: 'implementation',
      risk: 'medium',
      envelope: {
        mode: 'balanced',
        maxConcurrentTickets: 4,
        activeConcurrentTickets: 0,
        budgetRemaining: 'unknown',
      },
    })).rejects.toThrow(/No usable provider\/model|capacity/);

    await service.recordUsage({
      runId: 'run-1',
      providerId: decision.providerId,
      modelId: decision.modelId,
      task: 'implementation',
      retryCount: 1,
      elapsedMs: 10,
      outcome: 'succeeded',
      outcomeQuality: 'good',
      routingDecisionId: decision.id,
    });
    expect(service.listHealth()[0]?.activeRuns).toBe(0);
  });
});
