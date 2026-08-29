import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrate, type DbConnection } from '../../src/persistence/db.js';
import { createProjectRepository, createTicketRepository } from '../../src/persistence/repositories.js';
import type { ShipgraphConfig } from '../../src/config/schema.js';
import type {
  ModelProviderAdapter,
  ModelDiscoveryResult,
  ProviderProbeResult,
} from '../../src/adapters/model/adapter.js';
import type { AgentCapability, AgentProvider } from '../../src/domain/agent-provider.js';
import {
  registerModelProviderAdapter,
  type ModelExecutionAdapterBinding,
} from '../../src/adapters/agent/registry.js';
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
  createTicketRepository(db).create({
    id: 'KAR-2',
    projectId,
    title: 'Model telemetry fixture 2',
    description: 'Second fixture for concurrent provider reservations.',
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
        provider, model, model_provider_id, task, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'run-1',
      'KAR-1',
      '0'.repeat(40),
      'agent/model-telemetry',
      'CREATED',
      now,
      projectId,
      'codex',
      'codex/dynamic',
      'codex',
      'implementation',
      now,
      now
    );
    db.prepare(
      `INSERT INTO runs (
        id, ticket_id, base_sha, branch_name, status, started_at, project_id,
        provider, model, model_provider_id, task, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'run-2',
      'KAR-2',
      '0'.repeat(40),
      'agent/model-telemetry-2',
      'CREATED',
      now,
      projectId,
      'codex',
      'codex/dynamic',
      'codex',
      'implementation',
      now,
      now
    );
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

function executionBinding(
  modelProviderId: ModelExecutionAdapterBinding['modelProviderId'],
  capabilities: readonly AgentCapability[] = ['execute']
): ModelExecutionAdapterBinding {
  const provider: AgentProvider = modelProviderId === 'opencode-go'
    ? 'opencode'
    : modelProviderId === 'codex'
      ? 'codex'
      : 'acp';
  const adapter = {
    modelProviderId,
    adapter: {
      provider,
      capabilities,
      probe: async () => ({ available: true as const, version: 'test-agent' }),
      execute: async () => {
        throw new Error('test execution adapter is only used for capability selection');
      },
    },
  };
  registerModelProviderAdapter(adapter.adapter, modelProviderId);
  return adapter;
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
      executionAdapters: [
        executionBinding('opencode-go'),
        executionBinding('codex'),
        executionBinding('grok'),
        executionBinding('gemini'),
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
    expect(decision.reason).toContain('candidates=');
    expect(service.listRoutingDecisions()).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM provider_capacity_reservations').get()).toEqual({ count: 0 });
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
      executionAdapters: [
        executionBinding('opencode-go'),
        executionBinding('codex'),
        executionBinding('grok'),
        executionBinding('gemini'),
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

  it('rejects unbound usage that does not match the durable run task', async () => {
    const calls = { probe: 0, discover: 0 };
    const service = new ModelRoutingService({
      db,
      projectId,
      adapters: [adapter('codex', 'openai', calls)],
      executionAdapters: [executionBinding('codex')],
      now: () => now,
    });
    await service.refresh();

    await expect(service.recordUsage({
      runId: 'run-1',
      providerId: 'codex',
      modelId: 'codex/dynamic',
      task: 'review',
      retryCount: 0,
      elapsedMs: 1,
      outcome: 'succeeded',
      outcomeQuality: 'good',
    })).rejects.toThrow(/does not match its durable provider\/model\/task/);
    expect(service.listUsage()).toHaveLength(0);
  });

  it('does not carry stale numeric quota through a refresh without quota evidence', async () => {
    let probeCount = 0;
    let clock = now;
    const changingAdapter: ModelProviderAdapter = {
      providerId: 'codex',
      family: 'openai',
      displayName: 'Codex',
      probe: async () => {
        probeCount += 1;
        return {
          availability: 'available' as const,
          auth: 'authenticated' as const,
          version: 'test-provider',
          capabilities: ['implementation', 'review', 'repair'] as const,
          ...(probeCount === 1 ? { quotaRemaining: 3 } : {}),
        };
      },
      discoverModels: async () => ({
        status: 'known' as const,
        models: [{ modelId: 'codex/dynamic', capabilities: ['implementation', 'review', 'repair'] as const }],
      }),
    };
    const service = new ModelRoutingService({
      db,
      projectId,
      adapters: [changingAdapter],
      executionAdapters: [executionBinding('codex')],
      now: () => clock,
    });

    await service.refresh();
    expect(service.listHealth()[0]?.quotaRemaining).toBe(3);
    clock = '2026-08-27T00:01:00.000Z';
    await service.refresh();
    expect(service.listHealth()[0]?.quotaRemaining).toBe('unknown');
  });

  it('revokes a previously authenticated provider when a fresh auth probe is unknown', async () => {
    let probeCount = 0;
    const authUnknownAdapter: ModelProviderAdapter = {
      providerId: 'codex',
      family: 'openai',
      displayName: 'Codex',
      probe: async () => ({
        availability: 'available' as const,
        auth: probeCount++ === 0 ? 'authenticated' : 'unknown',
        version: 'test-provider',
        capabilities: ['implementation', 'review', 'repair'] as const,
      }),
      discoverModels: async () => ({
        status: 'known' as const,
        models: [{ modelId: 'codex/dynamic', capabilities: ['implementation', 'review', 'repair'] as const }],
      }),
    };
    const service = new ModelRoutingService({
      db,
      projectId,
      adapters: [authUnknownAdapter],
      executionAdapters: [executionBinding('codex')],
      now: () => now,
    });

    await service.refresh();
    expect(service.listHealth()[0]?.auth).toBe('authenticated');
    await service.refresh();
    expect(service.listHealth()[0]?.auth).toBe('unknown');
    await expect(service.route({
      task: 'implementation',
      risk: 'medium',
      envelope: {
        mode: 'balanced',
        maxConcurrentTickets: 4,
        activeConcurrentTickets: 'unknown',
        budgetRemaining: 'unknown',
      },
    })).rejects.toThrow(/No usable provider\/model/);
  });

  it('rejects a routed target when a refreshed provider loses its task capability', async () => {
    let supportsReview = true;
    const changingAdapter: ModelProviderAdapter = {
      providerId: 'codex',
      family: 'openai',
      displayName: 'Codex',
      probe: async () => ({
        availability: 'available' as const,
        auth: 'authenticated' as const,
        version: 'test-provider',
        capabilities: supportsReview
          ? (['implementation', 'review'] as const)
          : (['implementation'] as const),
      }),
      discoverModels: async () => ({
        status: 'known' as const,
        models: [{ modelId: 'codex/dynamic', capabilities: ['implementation', 'review'] as const }],
      }),
    };
    const service = new ModelRoutingService({
      db,
      projectId,
      adapters: [changingAdapter],
      executionAdapters: [executionBinding('codex', ['execute', 'review'])],
      now: () => now,
    });

    const decision = await service.route({
      task: 'review',
      risk: 'medium',
      envelope: {
        mode: 'balanced',
        maxConcurrentTickets: 4,
        activeConcurrentTickets: 'unknown',
        budgetRemaining: 'unknown',
      },
    });
    supportsReview = false;
    await service.refresh();

    expect(() => service.resolveExecutionTarget(decision)).toThrow(
      /no longer advertises MODEL task review/
    );
  });

  it('claims known provider capacity atomically across concurrent routes', async () => {
    const calls = { probe: 0, discover: 0 };
    const service = new ModelRoutingService({
      db,
      projectId,
      adapters: [adapter('codex', 'openai', calls)],
      executionAdapters: [executionBinding('codex')],
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
      service.route({ ...request, requestId: 'request-a', runId: 'run-1' }),
      service.route({ ...request, requestId: 'request-b', runId: 'run-2' }),
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
    const reservation = db
      .prepare(
        'SELECT run_id FROM provider_capacity_reservations WHERE routing_decision_id = ?'
      )
      .get(winner.id) as { run_id: string } | undefined;
    if (reservation === undefined) throw new Error('missing provider reservation fixture');
    db.prepare('UPDATE runs SET status = ? WHERE id = ?').run('SUCCEEDED', reservation.run_id);
    await service.recordUsage({
      runId: reservation.run_id,
      providerId: winner.providerId,
      modelId: winner.modelId,
      task: 'implementation',
      retryCount: 0,
      elapsedMs: 10,
      outcome: 'succeeded',
      outcomeQuality: 'good',
      routingDecisionId: winner.id,
    });
    service.getRepository().releaseProviderCapacity(
      projectId, reservation.run_id, winner.id, winner.providerId, winner.modelId,
      new Date().toISOString(), true
    );
    expect(service.listHealth()[0]?.activeRuns).toBe(0);
    const retryRunId = reservation.run_id === 'run-1' ? 'run-2' : 'run-1';
    const retry = await service.route({
      ...request,
      requestId: 'request-retry',
      runId: retryRunId,
    });
    expect(retry).toMatchObject({
      providerId: 'codex',
    });
    db.prepare('UPDATE runs SET status = ? WHERE id = ?').run('SUCCEEDED', retryRunId);
    await service.recordUsage({
      runId: retryRunId,
      providerId: retry.providerId,
      modelId: retry.modelId,
      task: 'implementation',
      retryCount: 0,
      elapsedMs: 10,
      outcome: 'succeeded',
      outcomeQuality: 'good',
      routingDecisionId: retry.id,
    });
    service.getRepository().releaseProviderCapacity(
      projectId, retryRunId, retry.id, retry.providerId, retry.modelId,
      new Date().toISOString(), true
    );
    expect(service.listHealth()[0]?.activeRuns).toBe(0);
  });

  it('does not persist a route when execution capability disappears before reservation', async () => {
    const calls = { probe: 0, discover: 0 };
    let idCalls = 0;
    const service = new ModelRoutingService({
      db,
      projectId,
      adapters: [adapter('codex', 'openai', calls)],
      executionAdapters: [executionBinding('codex')],
      now: () => now,
      createId: () => {
        idCalls += 1;
        if (idCalls === 1) {
          db.prepare(
            `UPDATE provider_registry
             SET execution_status = 'unknown', execution_provider = NULL
             WHERE project_id = ? AND provider_id = 'codex'`
          ).run(projectId);
        }
        return `route-${idCalls}`;
      },
    });
    await service.refresh();

    await expect(service.route({
      runId: 'run-1',
      task: 'implementation',
      risk: 'medium',
      envelope: {
        mode: 'balanced',
        maxConcurrentTickets: 4,
        activeConcurrentTickets: 0,
        budgetRemaining: 'unknown',
      },
    })).rejects.toThrow(/No usable provider\/model|capacity changed|capability-probed AGENT-001/);
    expect(service.listRoutingDecisions()).toHaveLength(0);
    expect(service.listHealth()[0]?.activeRuns).toBe(0);
  });

  it('fails closed when a selected MODEL task has no matching AGENT capability', async () => {
    const calls = { probe: 0, discover: 0 };
    const service = new ModelRoutingService({
      db,
      projectId,
      adapters: [adapter('codex', 'openai', calls)],
      executionAdapters: [executionBinding('codex')],
      now: () => now,
    });
    await service.refresh();

    await expect(service.route({
      task: 'review',
      risk: 'medium',
      envelope: {
        mode: 'balanced',
        maxConcurrentTickets: 4,
        activeConcurrentTickets: 0,
        budgetRemaining: 'unknown',
      },
    })).rejects.toThrow(/No usable provider\/model/);
    expect(service.listRoutingDecisions()).toHaveLength(0);
  });

  it('does not bind a route for a different task than the prepared run', async () => {
    const calls = { probe: 0, discover: 0 };
    const service = new ModelRoutingService({
      db,
      projectId,
      adapters: [adapter('codex', 'openai', calls)],
      executionAdapters: [executionBinding('codex', ['execute', 'review'])],
      now: () => now,
    });
    await service.refresh();

    await expect(service.route({
      runId: 'run-1',
      task: 'review',
      risk: 'medium',
      envelope: {
        mode: 'balanced',
        maxConcurrentTickets: 4,
        activeConcurrentTickets: 0,
        budgetRemaining: 'unknown',
      },
    })).rejects.toThrow(/does not identify codex\/codex\/dynamic/);
    expect(service.listRoutingDecisions()).toHaveLength(0);
    expect(service.listHealth()[0]?.activeRuns).toBe(0);
  });

  it('replays a request idempotently without creating another reservation', async () => {
    const calls = { probe: 0, discover: 0 };
    const service = new ModelRoutingService({
      db,
      projectId,
      adapters: [adapter('codex', 'openai', calls)],
      executionAdapters: [executionBinding('codex')],
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
      runId: 'run-1',
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
    await expect(service.route({ ...request, runId: 'run-2' })).rejects.toThrow(
      /different durable run/
    );

    db.prepare('UPDATE runs SET status = ? WHERE id = ?').run('SUCCEEDED', 'run-1');
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
    service.getRepository().releaseProviderCapacity(
      projectId, 'run-1', first.id, first.providerId, first.modelId,
      new Date().toISOString(), true
    );
    expect(service.listHealth()[0]?.activeRuns).toBe(0);
    await expect(service.route(request)).rejects.toThrow(/released capacity reservation/);
    expect(service.listRoutingDecisions()).toHaveLength(1);
    expect(service.listHealth()[0]?.activeRuns).toBe(0);
  });

  it('reuses a fresh snapshot until execution capability is explicitly refreshed', async () => {
    let executionAvailable = true;
    const service = new ModelRoutingService({
      db,
      projectId,
      adapters: [adapter('codex', 'openai', { probe: 0, discover: 0 })],
      executionAdapters: [{
        modelProviderId: 'codex',
        adapter: (() => {
          const adapter = {
          provider: 'codex',
          capabilities: ['execute'],
          probe: () => executionAvailable
            ? { available: true as const, version: 'test-agent' }
            : { available: false as const, reason: 'test executable disappeared' },
          execute: async () => {
            throw new Error('test execution adapter is not invoked here');
          },
          } satisfies ModelExecutionAdapterBinding['adapter'];
          registerModelProviderAdapter(adapter, 'codex');
          return adapter;
        })(),
      }],
      now: () => now,
    });
    const request = {
      requestId: 'replay-capability-request',
      runId: 'run-1',
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
    await expect(service.route({
      ...request,
      envelope: { ...request.envelope, budgetRemaining: 1 },
    })).rejects.toThrow(/different routing constraints/);

    executionAvailable = false;
    await expect(service.route(request)).resolves.toEqual(first);
    await service.refresh();
    await expect(service.route(request)).rejects.toThrow(
      /no capability-probed AGENT-001 execution surface/
    );
    expect(service.listRoutingDecisions()).toHaveLength(1);
    expect(service.listHealth()[0]?.activeRuns).toBe(1);
    expect(first.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps previews non-persistent so the same request can become execution-bound', async () => {
    const calls = { probe: 0, discover: 0 };
    const service = new ModelRoutingService({
      db,
      projectId,
      adapters: [adapter('codex', 'openai', calls)],
      executionAdapters: [executionBinding('codex')],
      now: () => now,
    });
    await service.refresh();

    const preview = await service.route({
      requestId: 'preview-then-run',
      task: 'implementation',
      risk: 'medium',
      envelope: {
        mode: 'balanced',
        maxConcurrentTickets: 4,
        activeConcurrentTickets: 0,
        budgetRemaining: 'unknown',
      },
    });
    expect(preview.providerId).toBe('codex');
    expect(service.listRoutingDecisions()).toHaveLength(0);

    const bound = await service.route({
      requestId: 'preview-then-run',
      runId: 'run-1',
      task: 'implementation',
      risk: 'medium',
      envelope: {
        mode: 'balanced',
        maxConcurrentTickets: 4,
        activeConcurrentTickets: 0,
        budgetRemaining: 'unknown',
      },
    });
    expect(bound.providerId).toBe('codex');
    expect(service.listRoutingDecisions()).toHaveLength(1);
    expect(service.listHealth()[0]?.activeRuns).toBe(1);
  });

  it('refuses to replay a legacy capacity reservation without durable-run provenance', async () => {
    const calls = { probe: 0, discover: 0 };
    const service = new ModelRoutingService({
      db,
      projectId,
      adapters: [adapter('codex', 'openai', calls)],
      executionAdapters: [executionBinding('codex')],
      now: () => now,
    });
    await service.refresh();
    const preview = await service.route({
      requestId: 'legacy-route-request',
      task: 'implementation',
      risk: 'medium',
      envelope: {
        mode: 'balanced',
        maxConcurrentTickets: 4,
        activeConcurrentTickets: 0,
        budgetRemaining: 'unknown',
      },
    });
    service.getRepository().appendRoutingDecision(preview);
    db.prepare(
      `INSERT INTO provider_capacity_reservations (
        routing_decision_id, project_id, request_id, provider_id, model_id,
        status, reserved_at, released_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL)`
    ).run(
      preview.id,
      projectId,
      preview.requestId,
      preview.providerId,
      preview.modelId,
      now
    );
    await expect(service.route({
      requestId: 'legacy-route-request',
      task: 'implementation',
      risk: 'medium',
      envelope: {
        mode: 'balanced',
        maxConcurrentTickets: 4,
        activeConcurrentTickets: 0,
        budgetRemaining: 'unknown',
      },
    })).rejects.toThrow(/unbound capacity reservation/);
  });

  it('does not release provider capacity for usage without its routing decision', async () => {
    const calls = { probe: 0, discover: 0 };
    const service = new ModelRoutingService({
      db,
      projectId,
      adapters: [adapter('codex', 'openai', calls)],
      executionAdapters: [executionBinding('codex')],
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
      requestId: 'bound-request',
      runId: 'run-1',
      envelope: {
        mode: 'balanced',
        maxConcurrentTickets: 4,
        activeConcurrentTickets: 0,
        budgetRemaining: 'unknown',
      },
    });

    await service.recordUsage({
      runId: 'run-2',
      providerId: decision.providerId,
      modelId: decision.modelId,
      task: 'implementation',
      retryCount: 0,
      elapsedMs: 10,
      outcome: 'succeeded',
      outcomeQuality: 'good',
    });
    expect(service.listHealth()[0]?.activeRuns).toBe(1);
    await expect(service.recordUsage({
      runId: 'run-2',
      providerId: decision.providerId,
      modelId: decision.modelId,
      task: 'implementation',
      retryCount: 1,
      elapsedMs: 10,
      outcome: 'succeeded',
      outcomeQuality: 'good',
      routingDecisionId: decision.id,
    })).rejects.toThrow(/does not belong to run/);
    expect(service.listUsage()).toHaveLength(1);
    await expect(service.route({
      task: 'implementation',
      risk: 'medium',
      runId: 'run-2',
      envelope: {
        mode: 'balanced',
        maxConcurrentTickets: 4,
        activeConcurrentTickets: 0,
        budgetRemaining: 'unknown',
      },
    })).rejects.toThrow(/No usable provider\/model|capacity/);

    db.prepare('UPDATE runs SET status = ? WHERE id = ?').run('SUCCEEDED', 'run-1');
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
    service.getRepository().releaseProviderCapacity(
      projectId, 'run-1', decision.id, decision.providerId, decision.modelId,
      new Date().toISOString(), true
    );
    expect(service.listHealth()[0]?.activeRuns).toBe(0);
    await expect(service.recordUsage({
      runId: 'run-1',
      providerId: decision.providerId,
      modelId: decision.modelId,
      task: 'implementation',
      retryCount: 1,
      elapsedMs: 10,
      outcome: 'failed',
      outcomeQuality: 'poor',
      quotaRemaining: 0,
      providerError: 'quota',
      routingDecisionId: decision.id,
    })).rejects.toThrow(/already finalized/);
    expect(service.listUsage()).toHaveLength(2);
    expect(service.listHealth()[0]?.activeRuns).toBe(0);
    expect(service.listHealth()[0]?.quotaRemaining).toBe('unknown');
  });
});
