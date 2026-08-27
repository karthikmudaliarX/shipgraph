import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createDatabase, migrate, type DbConnection } from '../../src/persistence/db.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { AgentProcessResult, AgentProcessRunner, AgentProcessSpec } from '../../src/adapters/agent/process.js';
import { CodexAdapter, GeminiAdapter } from '../../src/adapters/agent/providers.js';
import type {
  ModelDiscoveryResult,
  ModelProviderAdapter,
  ProviderProbeResult,
} from '../../src/adapters/model/adapter.js';
import { createProjectRepository } from '../../src/persistence/repositories.js';
import type { ShipgraphConfig } from '../../src/config/schema.js';
import { ModelRoutingService } from '../../src/model/service.js';
import { initProject } from '../../src/cli/init.js';
import { syncBacklogProject } from '../../src/cli/backlog.js';
import { createWorkspace } from '../../src/workspace/service.js';
import {
  executeSelectedAgentTask,
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
  family: string
): ModelProviderAdapter {
  const probe: ProviderProbeResult = {
    availability: 'available',
    auth: 'authenticated',
    version: 'metadata-provider 1.0.0',
    capabilities: ['implementation', 'review', 'repair'],
  };
  const discovery: ModelDiscoveryResult = {
    status: 'known',
    models: [{ modelId: `${providerId}/dynamic-model`, capabilities: ['implementation'] }],
  };
  return {
    providerId,
    family,
    displayName: providerId,
    probe: async () => probe,
    discoverModels: async () => discovery,
  };
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

  it('resolves a routed Codex model to the provider-neutral adapter and executes it', async () => {
    db = createDatabase(':memory:');
    migrate(db);
    createProject(db);
    const calls: AgentProcessSpec[] = [];
    const processRunner: AgentProcessRunner = {
      run: async (spec) => {
        calls.push(spec);
        if (spec.args[0] === '--version') return result({ stdout: 'codex 1.0.0\n' });
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
    const execution = await target.adapter.execute({
      runId: 'run-1',
      projectId,
      ticketId: 'KAR-6001',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/shipgraph-model-worktree',
      branchName: 'shipgraph/kar-6001',
      baseSha: '0123456789012345678901234567890123456789',
      provider: target.provider,
      model: target.modelId,
      instructions: 'Implement the approved task',
      timeoutMs: 1_000,
      maxOutputBytes: 4_096,
    });

    expect(target.modelProviderId).toBe('codex');
    expect(target.provider).toBe('codex');
    expect(target.adapter).toBe(executionAdapter);
    expect(execution.outcome).toBe('SUCCEEDED');
    const executionCall = calls.find((call) => call.args.includes(target.modelId));
    expect(executionCall?.cwd).toBe('/tmp/shipgraph-model-worktree');
  });

  it('rejects a metadata-visible Gemini provider when Antigravity cannot be probed', async () => {
    db = createDatabase(':memory:');
    migrate(db);
    createProject(db);
    const executionAdapter = new GeminiAdapter({
      executable: '/opt/unsupported-agy',
      processRunner: {
        run: async (spec) => spec.args[0] === '--version'
          ? result({ stdout: 'not-agy 1.0.0\n' })
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
          if (spec.args[0] === '--version') return result({ stdout: 'codex 1.0.0\n' });
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
      executeSelectedAgentTask(
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
        adapter: target.adapter,
        now: () => now,
        createRunId: () => 'run-model-bridge',
      },
      {
        ticketId: workspace.workspace.ticketId,
        provider: target.provider,
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
    const execution = await executeSelectedAgentTask(
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
});
