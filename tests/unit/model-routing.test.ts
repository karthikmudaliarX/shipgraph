import { describe, expect, it } from 'vitest';
import { ModelRouter } from '../../src/model/router.js';
import type {
  ExecutionEnvelope,
  ModelRoutingSnapshot,
  ModelRoutingRequest,
  ModelTaskType,
  ProviderHealthRecord,
  ProviderRegistryRecord,
  ModelCatalogRecord,
  UsageLedgerRecord,
} from '../../src/domain/model-provider.js';

const envelope: ExecutionEnvelope = {
  mode: 'balanced',
  maxConcurrentTickets: 4,
  activeConcurrentTickets: 0,
  budgetRemaining: 'unknown',
};

function provider(
  providerId: ProviderRegistryRecord['providerId'],
  family: string,
  overrides: Partial<ProviderRegistryRecord> = {}
): ProviderRegistryRecord {
  return {
    projectId: 'project-1',
    providerId,
    family,
    displayName: providerId,
    configured: true,
    availability: 'available',
    executionStatus: 'available',
    executionProvider: providerId === 'opencode-go'
      ? 'opencode'
      : providerId === 'codex'
        ? 'codex'
        : 'acp',
    capabilities: ['implementation', 'review', 'repair'],
    catalogStatus: 'known',
    checkedAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    ...overrides,
  };
}

function health(
  providerId: ProviderHealthRecord['providerId'],
  overrides: Partial<ProviderHealthRecord> = {}
): ProviderHealthRecord {
  return {
    projectId: 'project-1',
    providerId,
    status: 'healthy',
    auth: 'authenticated',
    quotaPressure: 'unknown',
    quotaRemaining: 'unknown',
    quotaResetAt: 'unknown',
    recentFailureCount: 0,
    activeRuns: 0,
    maxConcurrentRuns: 'unknown',
    checkedAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    ...overrides,
  };
}

function model(
  providerId: ModelCatalogRecord['providerId'],
  modelId: string,
  capabilities: ModelCatalogRecord['capabilities'] = ['implementation', 'review', 'repair']
): ModelCatalogRecord {
  return {
    projectId: 'project-1',
    providerId,
    modelId,
    capabilities,
    discoveredAt: '2026-08-27T00:00:00.000Z',
  };
}

function snapshot(
  providers: readonly ProviderRegistryRecord[],
  models: readonly ModelCatalogRecord[],
  providerHealth: readonly ProviderHealthRecord[],
  usage: readonly UsageLedgerRecord[] = [],
  executionCapabilities: ModelRoutingSnapshot['executionCapabilities'] = providers.map((entry) => ({
    providerId: entry.providerId,
    capabilities: ['implementation', 'review', 'repair'] as readonly ModelTaskType[],
  }))
): ModelRoutingSnapshot {
  return { providers, models, health: providerHealth, usage, executionCapabilities };
}

describe('MODEL-001 deterministic routing', () => {
  it('selects the same candidate regardless of persistence row order', () => {
    const router = new ModelRouter();
    const request: ModelRoutingRequest = { task: 'implementation', risk: 'medium', envelope };
    const first = router.route(request, snapshot(
      [provider('codex', 'openai'), provider('grok', 'xai')],
      [model('codex', 'future-codex'), model('grok', 'future-grok')],
      [health('codex'), health('grok')]
    ));
    const second = router.route(request, snapshot(
      [provider('grok', 'xai'), provider('codex', 'openai')],
      [model('grok', 'future-grok'), model('codex', 'future-codex')],
      [health('grok'), health('codex')]
    ));

    expect(second.providerId).toBe(first.providerId);
    expect(second.modelId).toBe(first.modelId);
    expect(second.reason).toBe(first.reason);
  });

  it('does not route to an unavailable or unauthenticated provider', () => {
    const router = new ModelRouter();
    const decision = router.route(
      { task: 'implementation', risk: 'low', envelope },
      snapshot(
        [provider('codex', 'openai'), provider('grok', 'xai')],
        [model('codex', 'unavailable-model'), model('grok', 'usable-model')],
        [
          health('codex', { status: 'unavailable' }),
          health('grok', { auth: 'authenticated' }),
        ]
      )
    );

    expect(decision.providerId).toBe('grok');
  });

  it('keeps unknown quota literal and prefers a known low-pressure provider', () => {
    const router = new ModelRouter();
    const decision = router.route(
      { task: 'implementation', risk: 'medium', envelope },
      snapshot(
        [provider('codex', 'openai'), provider('grok', 'xai')],
        [model('codex', 'codex-dynamic'), model('grok', 'grok-dynamic')],
        [
          health('codex', { quotaPressure: 'high', quotaRemaining: 'unknown' }),
          health('grok', { quotaPressure: 'low', quotaRemaining: 12 }),
        ]
      )
    );

    expect(decision.providerId).toBe('grok');
    expect(decision.reason).toContain('quota pressure=low');
    expect(decision.reason).not.toMatch(/estimated|estimate/i);
  });

  it('prefers a different provider family for review when practical', () => {
    const router = new ModelRouter();
    const decision = router.route(
      {
        task: 'review',
        risk: 'high',
        envelope,
        implementationProvider: 'codex',
      },
      snapshot(
        [provider('codex', 'openai'), provider('grok', 'xai')],
        [model('codex', 'codex-review'), model('grok', 'grok-review')],
        [health('codex'), health('grok')]
      )
    );

    expect(decision.providerId).toBe('grok');
    expect(decision.reason).toContain('reviewer-family independence');
  });

  it('refuses a known-exhausted execution envelope', () => {
    const router = new ModelRouter();
    expect(() => router.route(
      {
        task: 'implementation',
        risk: 'low',
        envelope: { ...envelope, maxConcurrentTickets: 1, activeConcurrentTickets: 1 },
      },
      snapshot(
        [provider('codex', 'openai')],
        [model('codex', 'dynamic')],
        [health('codex')]
      )
    )).toThrow(/execution envelope concurrency is full/);
  });

  it('fails closed for a snapshot that mixes project records', () => {
    const router = new ModelRouter();
    expect(() => router.route(
      { task: 'implementation', risk: 'low', envelope },
      snapshot(
        [provider('codex', 'openai')],
        [model('codex', 'dynamic')],
        [health('codex', { projectId: 'different-project' })]
      )
    )).toThrow(/crosses project boundaries/);
  });

  it('considers a known near quota reset with the request clock', () => {
    const router = new ModelRouter();
    const decision = router.route(
      {
        task: 'implementation',
        risk: 'medium',
        now: '2026-08-27T00:00:00.000Z',
        envelope,
      },
      snapshot(
        [provider('codex', 'openai'), provider('grok', 'xai')],
        [model('codex', 'codex-dynamic'), model('grok', 'grok-dynamic')],
        [
          health('codex', {
            quotaPressure: 'high',
            quotaRemaining: 'unknown',
            quotaResetAt: '2026-08-27T00:30:00.000Z',
          }),
          health('grok', {
            quotaPressure: 'high',
            quotaResetAt: '2026-08-29T00:00:00.000Z',
          }),
        ]
      )
    );

    expect(decision.providerId).toBe('codex');
    expect(decision.reason).toContain('quota reset=2026-08-27T00:30:00.000Z');
  });

  it('uses observed telemetry only for the requested task', () => {
    const router = new ModelRouter();
    const usage: UsageLedgerRecord[] = [
      {
        id: 'implementation-outcome',
        projectId: 'project-1',
        runId: 'run-implementation',
        providerId: 'codex',
        modelId: 'codex-dynamic',
        task: 'implementation',
        retryCount: 0,
        elapsedMs: 10,
        outcome: 'succeeded',
        outcomeQuality: 'excellent',
        inputTokens: 'unknown',
        outputTokens: 'unknown',
        cost: 'unknown',
        quotaRemaining: 'unknown',
        recordedAt: '2026-08-27T00:00:00.000Z',
      },
      {
        id: 'review-outcome',
        projectId: 'project-1',
        runId: 'run-review',
        providerId: 'codex',
        modelId: 'codex-dynamic',
        task: 'review',
        retryCount: 0,
        elapsedMs: 20,
        outcome: 'failed',
        outcomeQuality: 'poor',
        inputTokens: 'unknown',
        outputTokens: 'unknown',
        cost: 'unknown',
        quotaRemaining: 'unknown',
        recordedAt: '2026-08-27T00:01:00.000Z',
      },
    ];
    const common = snapshot(
      [provider('codex', 'openai')],
      [model('codex', 'codex-dynamic')],
      [health('codex')],
      usage
    );

    const implementation = router.route(
      { task: 'implementation', risk: 'medium', envelope },
      common
    );
    const review = router.route(
      { task: 'review', risk: 'medium', envelope },
      common
    );

    expect(implementation.reason).toContain('observed quality=excellent');
    expect(review.reason).toContain('observed quality=poor');
  });

  it('skips a metadata candidate whose AGENT adapter lacks the requested task', () => {
    const router = new ModelRouter();
    const decision = router.route(
      { task: 'review', risk: 'medium', envelope },
      snapshot(
        [provider('codex', 'openai'), provider('grok', 'xai')],
        [model('codex', 'codex-review'), model('grok', 'grok-review')],
        [health('codex'), health('grok', { status: 'degraded' })],
        [],
        [
          { providerId: 'codex', capabilities: ['implementation'] },
          { providerId: 'grok', capabilities: ['implementation', 'review'] },
        ]
      )
    );

    expect(decision.providerId).toBe('grok');
    expect(decision.candidatesConsidered).toBe(1);
  });
});
