import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createDatabase, migrate, type DbConnection } from '../../src/persistence/db.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { AgentProcessResult, AgentProcessRunner, AgentProcessSpec } from '../../src/adapters/agent/process.js';
import type { AgentExecutionAdapter } from '../../src/adapters/agent/adapter.js';
import { CodexAdapter, GeminiAdapter } from '../../src/adapters/agent/providers.js';
import type {
  ModelDiscoveryResult,
  ModelProviderAdapter,
  ProviderProbeResult,
} from '../../src/adapters/model/adapter.js';
import { createModelRepository } from '../../src/persistence/model-repositories.js';
import { createProjectRepository } from '../../src/persistence/repositories.js';
import type { ShipgraphConfig } from '../../src/config/schema.js';
import { ModelRoutingService } from '../../src/model/service.js';
import { registerModelProviderAdapter } from '../../src/adapters/agent/registry.js';
import { initProject } from '../../src/cli/init.js';
import { syncBacklogProject } from '../../src/cli/backlog.js';
import { createWorkspace } from '../../src/workspace/service.js';
import {
  prepareAgentTaskRun,
} from '../../src/execution/service.js';

const projectId = 'model-execution-project';
const now = '2026-08-27T00:00:00.000Z';
const temporaryDirectories: string[] = [];

function result(overrides: Partial<AgentProcessResult> = {}): AgentProcessResult {
  return {
    exitCode: 0,
    unexpectedTermination: false,
    timedOut: false,
    cancelled: false,
    outputLimitExceeded: false,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
    ...overrides,
  };
}

function providerAdapter(
  providerId: 'codex' | 'gemini',
  family: string,
  modelCapabilities: ModelDiscoveryResult['models'][number]['capabilities'] = ['implementation']
): ModelProviderAdapter {
  const probe: ProviderProbeResult = {
    availability: 'available',
    auth: 'authenticated',
    version: 'metadata-provider 1.0.0',
    capabilities: ['implementation', 'review', 'repair'],
  };
  const discovery: ModelDiscoveryResult = {
    status: 'known',
    models: [{ modelId: `${providerId}/dynamic-model`, capabilities: modelCapabilities }],
  };
  return {
    providerId,
    family,
    displayName: providerId,
    probe: async () => probe,
    discoverModels: async () => discovery,
  };
}

function executionTestAdapter(
  provider: 'codex' | 'acp',
  capabilities: AgentExecutionAdapter['capabilities']
): AgentExecutionAdapter {
  const adapter: AgentExecutionAdapter = {
    provider,
    capabilities,
    probe: async () => ({ available: true as const, version: 'test-agent 1.0.0' }),
    execute: async () => ({
      outcome: 'SUCCEEDED' as const,
      timedOut: false,
      cancelled: false,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
  };
  registerModelProviderAdapter(adapter, provider === 'codex' ? 'codex' : 'gemini');
  return adapter;
}

function createProject(db: DbConnection): void {
  const config: ShipgraphConfig = {
    version: 1,
    project: { name: 'model-execution', repository: 'owner/model-execution', defaultBranch: 'main' },
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
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function bridgeTicket() {
  return {
    id: 'KAR-6001',
    title: 'Route to adapter',
    description: 'Exercise the MODEL-001 to AGENT-001 hand-off.',
    priority: 'high',
    dependsOn: [],
    scope: { allowedPaths: ['src/**'], forbiddenPaths: [] },
    acceptanceCriteria: [{ id: 'AC-1', description: 'The selected adapter is executed.' }],
    verification: { commands: ['pnpm test'] },
    risk: 'medium',
    agent: {},
    release: {},
  };
}

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

describe('MODEL-001 route-to-AGENT-001 execution integration', () => {
  let db: DbConnection | undefined;

  afterEach(() => db?.close());

  it('resolves a routed Codex model without exposing a raw adapter', async () => {
    db = createDatabase(':memory:');
    migrate(db);
    createProject(db);
    const processRunner: AgentProcessRunner = {
      run: async (spec) => {
        if (spec.args[0] === '--version') return result({ stdout: 'codex-cli 1.0.0\n' });
        if (spec.args[0] === 'exec' && spec.args[1] === '--help') {
          return result({
            stdout: 'exec --json --model --cd --sandbox --approve-for-me --ephemeral\n',
          });
        }
        return result({ stdout: '{"type":"result","session_id":"codex-session"}\n' });
      },
    };
    const executionAdapter = new CodexAdapter({
      executable: '/opt/codex',
      processRunner,
    });
    const service = new ModelRoutingService({
      db,
      projectId,
      adapters: [providerAdapter('codex', 'openai')],
      executionAdapters: [{ modelProviderId: 'codex', adapter: executionAdapter }],
      now: () => now,
    });

    await service.refresh();
    const decision = await service.route({
      task: 'implementation',
      risk: 'medium',
      envelope: {
        mode: 'balanced',
        maxConcurrentTickets: 1,
        activeConcurrentTickets: 0,
        budgetRemaining: 'unknown',
      },
    });
    const target = service.resolveExecutionTarget(decision);

    expect(target.modelProviderId).toBe('codex');
    expect(target.provider).toBe('codex');
    expect(target).not.toHaveProperty('adapter');
  });

  it('routes review around an available adapter without the requested AGENT capability', async () => {
    db = createDatabase(':memory:');
    migrate(db);
    createProject(db);
    const codexAdapter = executionTestAdapter('codex', ['execute']);
    const geminiAdapter = executionTestAdapter('acp', ['execute', 'review']);
    const service = new ModelRoutingService({
      db,
      projectId,
      adapters: [
        providerAdapter('codex', 'openai', ['review']),
        providerAdapter('gemini', 'google', ['review']),
      ],
      executionAdapters: [
        { modelProviderId: 'codex', adapter: codexAdapter },
        { modelProviderId: 'gemini', adapter: geminiAdapter },
      ],
      now: () => now,
    });

    await service.refresh();
    const decision = await service.route({
      task: 'review',
      risk: 'medium',
      envelope: {
        mode: 'balanced',
        maxConcurrentTickets: 1,
        activeConcurrentTickets: 0,
        budgetRemaining: 'unknown',
      },
    });
    const target = service.resolveExecutionTarget(decision);

    expect(decision.providerId).toBe('gemini');
    expect(target).not.toHaveProperty('adapter');
    expect(target.provider).toBe('acp');
  });

  it('rejects a metadata-visible Gemini provider when Antigravity cannot be probed', async () => {
    db = createDatabase(':memory:');
    migrate(db);
    createProject(db);
    const executionAdapter = new GeminiAdapter({
      executable: '/opt/agy',
      processRunner: {
        run: async (spec) => spec.args[0] === '--version'
          ? result({ stdout: 'agy 1.0.0\n' })
          : result({ stdout: '--help --model\n' }),
      },
    });
    const service = new ModelRoutingService({
      db,
      projectId,
      adapters: [providerAdapter('gemini', 'google')],
      executionAdapters: [{ modelProviderId: 'gemini', adapter: executionAdapter }],
      now: () => now,
    });

    const refreshed = await service.refresh();
    expect(refreshed[0]?.provider).toMatchObject({
      executionStatus: 'unknown',
      executionReason: 'Gemini execution capability probe did not advertise --print',
    });
    await expect(service.route({
      task: 'implementation',
      risk: 'low',
      envelope: {
        mode: 'eco',
        maxConcurrentTickets: 1,
        activeConcurrentTickets: 0,
        budgetRemaining: 'unknown',
      },
    })).rejects.toThrow(/No usable provider\/model/);
    expect(() => service.resolveExecutionTarget({
      providerId: 'gemini',
      modelId: 'gemini/dynamic-model',
      task: 'implementation',
    })).toThrow(/no capability-probed AGENT-001 execution surface/);
  });

  it('passes a routed target through the durable AGENT-001 execution service', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'shipgraph-model-bridge-src-'));
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'shipgraph-model-bridge-root-'));
    temporaryDirectories.push(projectDir, worktreeRoot);
    git(projectDir, 'init', '-b', 'main');
    git(projectDir, 'config', 'user.email', 'shipgraph-model@example.com');
    git(projectDir, 'config', 'user.name', 'ShipGraph Model Test');
    writeFileSync(join(projectDir, 'README.md'), '# model bridge\n');
    git(projectDir, 'add', '.');
    git(projectDir, 'commit', '-m', 'initial');
    const config: ShipgraphConfig = {
      version: 1,
      project: { name: 'model-bridge', repository: 'owner/model-bridge', defaultBranch: 'main' },
      execution: { maxConcurrentTickets: 1, maxRepairIterations: 6 },
      release: { requireHumanApproval: true, requireCleanCI: true, requireExactShaReviews: true },
      agents: { implementer: 'opencode', reviewers: ['correctness'] },
    };
    initProject(projectDir, { config });
    writeFileSync(
      join(projectDir, 'shipgraph.backlog.yml'),
      stringify({ version: 1, tickets: [bridgeTicket()] })
    );
    syncBacklogProject(projectDir);
    db = createDatabase(join(projectDir, '.shipgraph', 'shipgraph.db'));
    migrate(db);
    const project = createProjectRepository(db).findAll()[0];
    if (project === undefined) throw new Error('missing model bridge project');
    const calls: AgentProcessSpec[] = [];
    const executionAdapter = new CodexAdapter({
      executable: '/opt/codex',
      processRunner: {
        run: async (spec) => {
          calls.push(spec);
          if (spec.args[0] === '--version') return result({ stdout: 'codex-cli 1.0.0\n' });
          if (spec.args[0] === 'exec' && spec.args[1] === '--help') {
            return result({
              stdout: 'exec --json --model --cd --sandbox --approve-for-me --ephemeral\n',
            });
          }
          await spec.onStarted?.(4242);
          return result({ stdout: '{"type":"result","session_id":"bridge-session"}\n' });
        },
      },
    });
    const workspace = await createWorkspace({ db, projectDir, worktreeRoot }, 'KAR-6001');
    const modelService = new ModelRoutingService({
      db,
      projectId: project.id,
      adapters: [providerAdapter('codex', 'openai')],
      executionAdapters: [{ modelProviderId: 'codex', adapter: executionAdapter }],
      now: () => now,
    });
    await modelService.refresh();
    const decision = await modelService.route({
      task: 'implementation',
      risk: 'medium',
      envelope: {
        mode: 'balanced',
        maxConcurrentTickets: 1,
        activeConcurrentTickets: 0,
        budgetRemaining: 'unknown',
      },
    });
    const target = modelService.resolveExecutionTarget(decision);
    expect(target.executionBound).toBe(false);
    await expect(
      modelService.executeSelectedAgentTask(
        { db, projectDir, worktreeRoot },
        target,
        { ticketId: workspace.workspace.ticketId, instructions: 'must be bound first' }
      )
    ).rejects.toThrow(/not execution-bound/);

    const prepared = await prepareAgentTaskRun(
      {
        db,
        projectDir,
        worktreeRoot,
        adapter: executionAdapter,
        now: () => now,
        createRunId: () => 'run-model-bridge',
      },
      {
        ticketId: workspace.workspace.ticketId,
        provider: target.provider,
        modelProviderId: target.modelProviderId,
        model: target.modelId,
        instructions: 'Implement through the selected route',
        timeoutMs: 1_000,
      }
    );
    const boundDecision = await modelService.route({
      requestId: decision.requestId,
      runId: prepared.run.id,
      task: 'implementation',
      risk: 'medium',
      envelope: {
        mode: 'balanced',
        maxConcurrentTickets: 1,
        activeConcurrentTickets: 0,
        budgetRemaining: 'unknown',
      },
    });
    const boundTarget = modelService.resolveExecutionTarget(boundDecision);
    expect(boundTarget.executionBound).toBe(true);
    expect(boundTarget.routingDecisionId).toBe(boundDecision.id);
    expect(boundTarget.runId).toBe(prepared.run.id);
    db.prepare('UPDATE runs SET model_provider_id = ? WHERE id = ?').run('gemini', prepared.run.id);
    await expect(
      modelService.executeSelectedAgentTask(
        { db, projectDir, worktreeRoot, now: () => now },
        boundTarget,
        { ticketId: workspace.workspace.ticketId, instructions: 'must reject substituted provider', timeoutMs: 1_000 }
      )
    ).rejects.toThrow(/not a current execution binding/);
    db.prepare('UPDATE runs SET model_provider_id = ? WHERE id = ?').run('codex', prepared.run.id);
    const execution = await modelService.executeSelectedAgentTask(
      { db, projectDir, worktreeRoot, now: () => now },
      boundTarget,
      { ticketId: workspace.workspace.ticketId, instructions: 'Implement through the selected route', timeoutMs: 1_000 }
    );

    expect(execution.run.status).toBe('SUCCEEDED');
    expect(execution.run.provider).toBe('codex');
    expect(execution.run.model).toBe(boundTarget.modelId);
    expect(execution.run.workspaceId).toBe(workspace.workspace.id);
    const executionCall = calls.find((call) => call.args.includes(boundTarget.modelId));
    expect(executionCall?.cwd).toBe(workspace.workspace.worktreePath);
    expect(modelService.listHealth()[0]?.activeRuns).toBe(0);

    await modelService.recordUsage({
      runId: prepared.run.id,
      routingDecisionId: boundDecision.id,
      providerId: boundDecision.providerId,
      modelId: boundDecision.modelId,
      task: boundDecision.task,
      retryCount: 0,
      elapsedMs: 1,
      outcome: 'succeeded',
      outcomeQuality: 'good',
    });
    expect(modelService.listHealth()[0]?.activeRuns).toBe(0);
  });

  it('retains provider capacity after normalization discovers truncated output', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'shipgraph-model-timeout-src-'));
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'shipgraph-model-timeout-root-'));
    temporaryDirectories.push(projectDir, worktreeRoot);
    git(projectDir, 'init', '-b', 'main');
    git(projectDir, 'config', 'user.email', 'shipgraph-model@example.com');
    git(projectDir, 'config', 'user.name', 'ShipGraph Model Test');
    writeFileSync(join(projectDir, 'README.md'), '# timeout bridge\n');
    git(projectDir, 'add', '.');
    git(projectDir, 'commit', '-m', 'initial');
    const config: ShipgraphConfig = {
      version: 1,
      project: { name: 'model-timeout', repository: 'owner/model-timeout', defaultBranch: 'main' },
      execution: { maxConcurrentTickets: 1, maxRepairIterations: 6 },
      release: { requireHumanApproval: true, requireCleanCI: true, requireExactShaReviews: true },
      agents: { implementer: 'opencode', reviewers: ['correctness'] },
    };
    initProject(projectDir, { config });
    writeFileSync(
      join(projectDir, 'shipgraph.backlog.yml'),
      stringify({ version: 1, tickets: [bridgeTicket()] })
    );
    syncBacklogProject(projectDir);
    db = createDatabase(join(projectDir, '.shipgraph', 'shipgraph.db'));
    migrate(db);
    const project = createProjectRepository(db).findAll()[0];
    if (project === undefined) throw new Error('missing timeout bridge project');

    const executionAdapter: AgentExecutionAdapter = {
      provider: 'codex',
      capabilities: ['execute'],
      probe: async () => ({ available: true as const, version: 'test-codex' }),
      execute: async (request) => {
        await request.onProcessStarted?.(4343);
        return {
          outcome: 'FAILED' as const,
          timedOut: false,
          cancelled: false,
          stdout: 'x'.repeat(256),
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          failureCategory: 'non_zero_exit' as const,
          failureReason: 'test oversized output',
        };
      },
    };
    registerModelProviderAdapter(executionAdapter, 'codex');
    const workspace = await createWorkspace({ db, projectDir, worktreeRoot }, 'KAR-6001');
    const modelService = new ModelRoutingService({
      db,
      projectId: project.id,
      adapters: [providerAdapter('codex', 'openai')],
      executionAdapters: [{ modelProviderId: 'codex', adapter: executionAdapter }],
      now: () => now,
    });
    await modelService.refresh();
    const prepared = await prepareAgentTaskRun(
      {
        db,
        projectDir,
        worktreeRoot,
        adapter: executionAdapter,
        now: () => now,
        createRunId: () => 'run-model-timeout',
      },
      {
        ticketId: workspace.workspace.ticketId,
        provider: 'codex',
        modelProviderId: 'codex',
        model: 'codex/dynamic-model',
        instructions: 'exercise normalized output reservation retention',
        timeoutMs: 1_000,
      }
    );
    const decision = await modelService.route({
      runId: prepared.run.id,
      task: 'implementation',
      risk: 'medium',
      envelope: {
        mode: 'balanced',
        maxConcurrentTickets: 1,
        activeConcurrentTickets: 0,
        budgetRemaining: 'unknown',
      },
    });
    const result = await modelService.executeSelectedAgentTask(
      { db, projectDir, worktreeRoot, now: () => now, maxOutputBytes: 128 },
      modelService.resolveExecutionTarget(decision),
      {
        ticketId: workspace.workspace.ticketId,
        instructions: 'exercise normalized output reservation retention',
        timeoutMs: 1_000,
      }
    );

    expect(result.run.status).toBe('FAILED');
    expect(result.run.stdoutTruncated).toBe(true);
    expect(modelService.listHealth()[0]?.activeRuns).toBe(1);
    expect(createModelRepository(db).findActiveRoutingDecisionByRun(project.id, prepared.run.id))
      .toMatchObject({ reservationStatus: 'active', runId: prepared.run.id });
    await modelService.recordUsage({
      runId: prepared.run.id,
      routingDecisionId: decision.id,
      providerId: decision.providerId,
      modelId: decision.modelId,
      task: decision.task,
      retryCount: 0,
      elapsedMs: 0,
      outcome: 'unknown',
      outcomeQuality: 'unknown',
    });
    expect(modelService.listHealth()[0]?.activeRuns).toBe(1);
  });

  it('retains provider capacity when a selected adapter throws after starting', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'shipgraph-model-ambiguous-src-'));
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'shipgraph-model-ambiguous-root-'));
    temporaryDirectories.push(projectDir, worktreeRoot);
    git(projectDir, 'init', '-b', 'main');
    git(projectDir, 'config', 'user.email', 'shipgraph-model@example.com');
    git(projectDir, 'config', 'user.name', 'ShipGraph Model Test');
    writeFileSync(join(projectDir, 'README.md'), '# ambiguous adapter\n');
    git(projectDir, 'add', '.');
    git(projectDir, 'commit', '-m', 'initial');
    const config: ShipgraphConfig = {
      version: 1,
      project: { name: 'model-ambiguous', repository: 'owner/model-ambiguous', defaultBranch: 'main' },
      execution: { maxConcurrentTickets: 1, maxRepairIterations: 6 },
      release: { requireHumanApproval: true, requireCleanCI: true, requireExactShaReviews: true },
      agents: { implementer: 'opencode', reviewers: ['correctness'] },
    };
    initProject(projectDir, { config });
    writeFileSync(
      join(projectDir, 'shipgraph.backlog.yml'),
      stringify({ version: 1, tickets: [bridgeTicket()] })
    );
    syncBacklogProject(projectDir);
    db = createDatabase(join(projectDir, '.shipgraph', 'shipgraph.db'));
    migrate(db);
    const project = createProjectRepository(db).findAll()[0];
    if (project === undefined) throw new Error('missing ambiguous adapter project');

    const calls: AgentProcessSpec[] = [];
    const executionAdapter = new CodexAdapter({
      executable: '/opt/codex',
      processRunner: {
        run: async (spec) => {
          calls.push(spec);
          if (spec.args[0] === '--version') return result({ stdout: 'codex-cli 1.0.0\n' });
          if (spec.args[0] === 'exec' && spec.args[1] === '--help') {
            return result({
              stdout: 'exec --json --model --cd --sandbox --approve-for-me --ephemeral\n',
            });
          }
          await spec.onStarted?.(4242);
          throw new Error('provider bookkeeping channel lost after spawn');
        },
      },
    });
    const workspace = await createWorkspace({ db, projectDir, worktreeRoot }, 'KAR-6001');
    const modelService = new ModelRoutingService({
      db,
      projectId: project.id,
      adapters: [providerAdapter('codex', 'openai')],
      executionAdapters: [{ modelProviderId: 'codex', adapter: executionAdapter }],
      now: () => now,
    });
    await modelService.refresh();
    const prepared = await prepareAgentTaskRun(
      {
        db,
        projectDir,
        worktreeRoot,
        adapter: executionAdapter,
        now: () => now,
        createRunId: () => 'run-ambiguous-adapter',
      },
      {
        ticketId: workspace.workspace.ticketId,
        provider: 'codex',
        modelProviderId: 'codex',
        model: 'codex/dynamic-model',
        instructions: 'exercise ambiguous provider ownership',
        timeoutMs: 1_000,
      }
    );
    const decision = await modelService.route({
      runId: prepared.run.id,
      task: 'implementation',
      risk: 'medium',
      envelope: {
        mode: 'balanced',
        maxConcurrentTickets: 1,
        activeConcurrentTickets: 0,
        budgetRemaining: 'unknown',
      },
    });
    const target = modelService.resolveExecutionTarget(decision);
    const execution = await modelService.executeSelectedAgentTask(
      { db, projectDir, worktreeRoot, now: () => now },
      target,
      { ticketId: workspace.workspace.ticketId, instructions: 'exercise ambiguous provider ownership', timeoutMs: 1_000 }
    );

    expect(execution.run.status).toBe('NEEDS_HUMAN');
    expect(execution.run.failureCategory).toBe('adapter_error');
    expect(calls.filter((call) => call.args[0] === 'exec' && call.args[1] !== '--help')).toHaveLength(1);
    expect(modelService.listHealth()[0]?.activeRuns).toBe(1);
    expect(createModelRepository(db).findActiveRoutingDecisionByRun(project.id, prepared.run.id))
      .toMatchObject({ reservationStatus: 'active', runId: prepared.run.id });
    await modelService.recordUsage({
      runId: prepared.run.id,
      routingDecisionId: decision.id,
      providerId: decision.providerId,
      modelId: decision.modelId,
      task: decision.task,
      retryCount: 0,
      elapsedMs: 0,
      outcome: 'unknown',
      outcomeQuality: 'unknown',
    });
    expect(modelService.listHealth()[0]?.activeRuns).toBe(1);
  });
});
