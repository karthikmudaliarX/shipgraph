import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { initProject } from '../../src/cli/init.js';
import { syncBacklogProject } from '../../src/cli/backlog.js';
import { createWorkspace } from '../../src/workspace/service.js';
import { TicketState } from '../../src/core/state-machine/state.js';
import { persistTicketTransition } from '../../src/persistence/ticket-state-store.js';
import { openAndMigrate, type DbConnection } from '../../src/persistence/db.js';
import {
  createEventRepository,
  createRunRepository,
  createTicketRepository,
} from '../../src/persistence/repositories.js';
import { createModelRepository } from '../../src/persistence/model-repositories.js';
import { ModelRoutingService } from '../../src/model/service.js';
import {
  executeAgentTask,
  prepareAgentTaskRun,
  reconcileAgentRun,
  recoverAgentRun,
  type AgentExecutionServiceOptions,
} from '../../src/execution/service.js';
import type {
  AgentExecutionAdapter,
  AgentExecutionRequest,
  AgentExecutionResult,
} from '../../src/adapters/agent/adapter.js';
import { OpenCodeAdapter } from '../../src/adapters/agent/opencode.js';
import { registerModelProviderAdapter } from '../../src/adapters/agent/registry.js';
import type { ModelProviderAdapter } from '../../src/adapters/model/adapter.js';

const BASE_CONFIG = {
  version: 1 as const,
  project: { name: 'agent-001', repository: 'owner/agent-001', defaultBranch: 'main' },
  execution: { maxConcurrentTickets: 2, maxRepairIterations: 6 },
  release: { requireHumanApproval: true, requireCleanCI: true, requireExactShaReviews: true },
  agents: { implementer: 'opencode' as const, reviewers: ['correctness'] as const },
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function ticket(id = 'AG-001') {
  return {
    id,
    title: `Ticket ${id}`,
    description: `Work for ${id}`,
    priority: 'high',
    dependsOn: [],
    scope: { allowedPaths: ['src/**'], forbiddenPaths: [] },
    acceptanceCriteria: [{ id: 'AC-1', description: 'The agent boundary is exercised' }],
    verification: { commands: ['pnpm test'] },
    risk: 'medium',
    agent: {},
    release: {},
  };
}

type Harness = {
  projectDir: string;
  worktreeRoot: string;
  db: DbConnection;
  baseSha: string;
  options: AgentExecutionServiceOptions;
  workspacePath: string;
};

type FakeAdapter = AgentExecutionAdapter & { requests: AgentExecutionRequest[] };

function fakeAdapter(
  result: Partial<AgentExecutionResult> = {},
  capabilities: AgentExecutionAdapter['capabilities'] = ['execute']
): FakeAdapter {
  const requests: AgentExecutionRequest[] = [];
  const adapter: FakeAdapter = {
    provider: 'opencode',
    capabilities,
    requests,
    probe: () => ({ available: true, version: 'test' }),
    execute: async (request) => {
      requests.push(request);
      if (request.onProcessStarted !== undefined) await request.onProcessStarted(4242);
      return {
        outcome: 'SUCCEEDED',
        providerSessionId: 'session-test',
        providerProcessId: 4242,
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        processGroupStopped: true,
        stdout: JSON.stringify({ type: 'text', sessionID: 'session-test', text: 'done' }),
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        evidence: { outputFormat: 'jsonl', eventCount: 1, eventTypes: ['text'], summary: 'done' },
        ...result,
      };
    },
  };
  registerModelProviderAdapter(adapter, 'opencode-go');
  return adapter;
}

async function createHarness(): Promise<Harness> {
  const projectDir = mkdtempSync(join(tmpdir(), 'shipgraph-agent-src-'));
  git(projectDir, 'init', '-b', 'main');
  git(projectDir, 'config', 'user.email', 'shipgraph-agent@example.com');
  git(projectDir, 'config', 'user.name', 'ShipGraph Agent Test');
  writeFileSync(join(projectDir, 'README.md'), '# source\n');
  git(projectDir, 'add', '.');
  git(projectDir, 'commit', '-m', 'initial');
  const baseSha = git(projectDir, 'rev-parse', 'HEAD');
  initProject(projectDir, { config: BASE_CONFIG });
  writeFileSync(join(projectDir, 'shipgraph.backlog.yml'), stringify({ version: 1, tickets: [ticket()] }));
  syncBacklogProject(projectDir);
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'shipgraph-agent-root-'));
  const db = openAndMigrate(join(projectDir, '.shipgraph', 'shipgraph.db'));
  const adapter = fakeAdapter();
  const options: AgentExecutionServiceOptions = { db, projectDir, worktreeRoot, adapter };
  const workspace = await createWorkspace(options, 'AG-001');
  return {
    projectDir,
    worktreeRoot,
    db,
    baseSha,
    options,
    workspacePath: workspace.workspace.worktreePath,
  };
}

function cleanup(harness: Harness | undefined): void {
  if (!harness) return;
  harness.db.close();
  rmSync(harness.projectDir, { recursive: true, force: true });
  rmSync(harness.worktreeRoot, { recursive: true, force: true });
}

function providerScript(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'shipgraph-provider-'));
  providerScriptDirectories.push(directory);
  const script = join(directory, 'opencode');
  writeFileSync(script, `#!/bin/sh\n${contents}\n`);
  chmodSync(script, 0o700);
  return script;
}

const providerScriptDirectories: string[] = [];

afterAll(() => {
  for (const directory of providerScriptDirectories) rmSync(directory, { recursive: true, force: true });
});

describe('AGENT-001 durable execution', () => {
  let harness: Harness | undefined;

  afterEach(() => {
    cleanup(harness);
    harness = undefined;
  });

  it('persists the run before launch, verifies the exact workspace, and leaves the source checkout alone', async () => {
    harness = await createHarness();
    const result = await executeAgentTask(harness.options, {
      ticketId: 'AG-001',
      model: 'openai/gpt-5',
      instructions: 'Implement this ticket without leaving the workspace.',
    });

    expect(result.run.status).toBe('SUCCEEDED');
    expect(result.run.workspacePath).toBe(harness.workspacePath);
    expect(result.run.baseSha).toBe(harness.baseSha);
    expect(result.run.provider).toBe('opencode');
    expect(result.run.model).toBe('openai/gpt-5');
    expect(result.run.providerProcessId).toBe(4242);
    expect(result.run.providerSessionId).toBe('session-test');
    expect(result.run.instructionsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.run.stdout).not.toContain('Implement this ticket');
    expect(createTicketRepository(harness.db).findById('AG-001')?.status).toBe('IMPLEMENTING');
    expect(git(harness.projectDir, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(readFileSync(join(harness.projectDir, 'README.md'), 'utf8')).toBe('# source\n');
    expect(git(harness.workspacePath, 'symbolic-ref', '--short', 'HEAD')).toBe('shipgraph/ag-001');
    expect(git(harness.workspacePath, 'rev-parse', 'HEAD')).toBe(harness.baseSha);

    const eventTypes = createEventRepository(harness.db)
      .findByTicketId('AG-001')
      .map((event) => event.type);
    expect(eventTypes).toContain('run.created');
    expect(eventTypes).toContain('run.state_changed');
    expect(eventTypes).toContain('run.completed');
    const persisted = harness.db.prepare('SELECT * FROM runs WHERE id = ?').get(result.run.id) as Record<string, unknown>;
    expect(persisted.instructions).toBeUndefined();
    expect(persisted.workspace_path).toBe(harness.workspacePath);
  });

  it('refuses execution before the adapter when the READY workspace is detached or on another branch', async () => {
    harness = await createHarness();
    git(harness.workspacePath, 'checkout', '--detach');
    await expect(
      executeAgentTask(harness.options, { ticketId: 'AG-001', model: 'openai/gpt-5', instructions: 'run' })
    ).rejects.toThrow(/Checked-out branch|requires the recorded branch/);
    expect((harness.options.adapter as FakeAdapter).requests).toHaveLength(0);
    expect(createRunRepository(harness.db).findByTicketId('AG-001')).toHaveLength(0);

    git(harness.workspacePath, 'checkout', '-b', 'user/alternate');
    await expect(
      executeAgentTask(harness.options, { ticketId: 'AG-001', model: 'openai/gpt-5', instructions: 'run' })
    ).rejects.toThrow(/Checked-out branch|requires the recorded branch/);
    expect(createRunRepository(harness.db).findByTicketId('AG-001')).toHaveLength(0);
  });

  it('refuses a workspace record copied or redirected to another repository', async () => {
    harness = await createHarness();
    const foreignRepository = mkdtempSync(join(tmpdir(), 'shipgraph-agent-foreign-'));
    git(foreignRepository, 'init', '-b', 'main');
    git(foreignRepository, 'config', 'user.email', 'shipgraph-agent@example.com');
    git(foreignRepository, 'config', 'user.name', 'ShipGraph Agent Test');
    writeFileSync(join(foreignRepository, 'README.md'), '# foreign\n');
    git(foreignRepository, 'add', '.');
    git(foreignRepository, 'commit', '-m', 'foreign');

    harness.db
      .prepare('UPDATE workspaces SET source_repository_path = ? WHERE ticket_id = ?')
      .run(foreignRepository, 'AG-001');

    await expect(
      executeAgentTask(harness.options, {
        ticketId: 'AG-001',
        model: 'openai/gpt-5',
        instructions: 'must not run from a copied database',
      })
    ).rejects.toThrow(/not the current project directory/);
    expect((harness.options.adapter as FakeAdapter).requests).toHaveLength(0);
    expect(createRunRepository(harness.db).findByTicketId('AG-001')).toHaveLength(0);
    rmSync(foreignRepository, { recursive: true, force: true });
  });

  it('refuses dirty tracked and untracked workspaces without persisting a run', async () => {
    harness = await createHarness();
    writeFileSync(join(harness.workspacePath, 'README.md'), '# user change\n');
    writeFileSync(join(harness.workspacePath, 'notes.txt'), 'user data\n');
    await expect(
      executeAgentTask(harness.options, { ticketId: 'AG-001', model: 'openai/gpt-5', instructions: 'run' })
    ).rejects.toThrow(/not clean|dirty|untracked/);
    expect(readFileSync(join(harness.workspacePath, 'README.md'), 'utf8')).toBe('# user change\n');
    expect(existsSync(join(harness.workspacePath, 'notes.txt'))).toBe(true);
    expect(createRunRepository(harness.db).findByTicketId('AG-001')).toHaveLength(0);
  });

  it('allows only one durable run and does not launch a duplicate after a completed attempt', async () => {
    harness = await createHarness();
    await executeAgentTask(harness.options, {
      ticketId: 'AG-001',
      model: 'openai/gpt-5',
      instructions: 'first attempt',
    });
    await expect(
      executeAgentTask(harness.options, {
        ticketId: 'AG-001',
        model: 'openai/gpt-5',
        instructions: 'duplicate attempt',
      })
    ).rejects.toThrow(/already has an agent run|requires PLANNING/);
    expect((harness.options.adapter as FakeAdapter).requests).toHaveLength(1);
    expect(createRunRepository(harness.db).findByTicketId('AG-001')).toHaveLength(1);
  });

  it('allows a new durable attempt after terminal run history while retaining the active-run guard', async () => {
    harness = await createHarness();
    await executeAgentTask(harness.options, {
      ticketId: 'AG-001',
      model: 'openai/gpt-5',
      instructions: 'first terminal attempt',
    });

    // The lifecycle owner would normally move the ticket back to PLANNING
    // before a new implementation attempt. This fixture only supplies that
    // already-authorized state so the run-history invariant is isolated.
    harness.db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run('PLANNING', 'AG-001');
    await executeAgentTask(harness.options, {
      ticketId: 'AG-001',
      model: 'openai/gpt-5',
      instructions: 'second terminal attempt',
    });

    expect((harness.options.adapter as FakeAdapter).requests).toHaveLength(2);
    expect(createRunRepository(harness.db).findByTicketId('AG-001')).toHaveLength(2);
  });

  it.each([
    {
      name: 'an exhausted attempt budget',
      safety: { maxAttempts: 1, attempt: 2 },
      category: 'safety_limit',
      reason: /attempt budget exhausted/,
    },
    {
      name: 'a timeout above its per-run ceiling',
      timeoutMs: 2_000,
      safety: { maxTimeoutMs: 1_000 },
      category: 'safety_limit',
      reason: /timeout exceeds the per-run ceiling/,
    },
    {
      name: 'an exhausted token budget',
      safety: { maxTokens: 10, tokensUsed: 10 },
      category: 'safety_limit',
      reason: /token budget exhausted/,
    },
    {
      name: 'an unapproved destructive operation',
      safety: { destructive: true },
      category: 'approval_required',
      reason: /explicit human approval/,
    },
    {
      name: 'material scope growth',
      safety: { scopeGrowth: true },
      category: 'scope_growth',
      reason: /authorized scope boundary/,
    },
  ])('fails closed before launch for $name', async ({ timeoutMs, safety, category, reason }) => {
    harness = await createHarness();
    const result = await executeAgentTask(harness.options, {
      ticketId: 'AG-001',
      model: 'openai/gpt-5',
      instructions: 'must not launch when the safety policy blocks the run',
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      safety,
    });

    expect(result.run.status).toBe('NEEDS_HUMAN');
    expect(result.run.failureCategory).toBe(category);
    expect(result.run.failureReason).toMatch(reason);
    expect((harness.options.adapter as FakeAdapter).requests).toHaveLength(0);
  });

  it('fails closed after a successful provider result exceeds a configured token budget', async () => {
    harness = await createHarness();
    const options: AgentExecutionServiceOptions = {
      ...harness.options,
      adapter: fakeAdapter({ usage: { inputTokens: 2, outputTokens: 3, cost: 0 } }),
    };

    const result = await executeAgentTask(options, {
      ticketId: 'AG-001',
      model: 'openai/gpt-5',
      instructions: 'enforce the token budget after normalized provider usage',
      safety: { maxTokens: 4 },
    });

    expect(result.run.status).toBe('NEEDS_HUMAN');
    expect(result.run.failureCategory).toBe('safety_limit');
    expect(result.run.failureReason).toMatch(/token budget exceeded/);
    expect((options.adapter as FakeAdapter).requests).toHaveLength(1);
  });

  it('requires measurable usage when a cost budget is configured', async () => {
    harness = await createHarness();
    const result = await executeAgentTask(harness.options, {
      ticketId: 'AG-001',
      model: 'openai/gpt-5',
      instructions: 'do not treat missing cost telemetry as safe',
      safety: { maxCost: 1 },
    });

    expect(result.run.status).toBe('NEEDS_HUMAN');
    expect(result.run.failureCategory).toBe('safety_limit');
    expect(result.run.failureReason).toMatch(/did not report cost/);
  });

  it('allows a high-risk run only when explicit approval is present', async () => {
    harness = await createHarness();
    const result = await executeAgentTask(harness.options, {
      ticketId: 'AG-001',
      model: 'openai/gpt-5',
      instructions: 'execute the explicitly approved high-risk step',
      safety: { risk: 'high', approvalGranted: true },
    });

    expect(result.run.status).toBe('SUCCEEDED');
    expect((harness.options.adapter as FakeAdapter).requests).toHaveLength(1);
  });

  it('derives the approval gate from the durable ticket risk', async () => {
    harness = await createHarness();
    harness.db.prepare('UPDATE tickets SET risk = ? WHERE id = ?').run('critical', 'AG-001');

    const result = await executeAgentTask(harness.options, {
      ticketId: 'AG-001',
      model: 'openai/gpt-5',
      instructions: 'must not bypass the durable ticket risk gate',
    });

    expect(result.run.status).toBe('NEEDS_HUMAN');
    expect(result.run.failureCategory).toBe('approval_required');
    expect((harness.options.adapter as FakeAdapter).requests).toHaveLength(0);
  });

  it.each([
    ['missing executable', '/definitely/not/opencode', undefined, 'executable_unavailable', 'NEEDS_HUMAN'],
    [
      'malformed output',
      providerScript('if [ "$1" = "--version" ]; then printf -- "1.0.0\\n"; exit 0; fi; if [ "$1" = "run" ] && [ "$2" = "--help" ]; then printf -- "--format --dir --model --auto\\n"; exit 0; fi; printf "not-json\\n"'),
      undefined,
      'malformed_output',
      'FAILED',
    ],
    [
      'non-zero exit',
      providerScript('if [ "$1" = "--version" ]; then printf -- "1.0.0\\n"; exit 0; fi; if [ "$1" = "run" ] && [ "$2" = "--help" ]; then printf -- "--format --dir --model --auto\\n"; exit 0; fi; printf \'{"type":"text"}\\n\'; exit 7'),
      undefined,
      'non_zero_exit',
      'FAILED',
    ],
    [
      'timeout',
      providerScript('if [ "$1" = "--version" ]; then printf -- "1.0.0\\n"; exit 0; fi; if [ "$1" = "run" ] && [ "$2" = "--help" ]; then printf -- "--format --dir --model --auto\\n"; exit 0; fi; while true; do sleep 1; done'),
      100,
      'timeout',
      'TIMED_OUT',
    ],
  ])('persists %s as a bounded terminal outcome', async (_name, executable, timeoutMs, category, state) => {
    harness = await createHarness();
    const options: AgentExecutionServiceOptions = {
      ...harness.options,
      adapter: new OpenCodeAdapter({ executable }),
    };
    const result = await executeAgentTask(options, {
      ticketId: 'AG-001',
      model: 'openai/gpt-5',
      instructions: 'exercise failure handling',
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    expect(result.run.status).toBe(state);
    expect(result.run.failureCategory).toBe(category);
    expect(result.run.stdout.length).toBeLessThanOrEqual(128 * 1024);
  });

  it('turns contradictory adapter evidence into NEEDS_HUMAN', async () => {
    harness = await createHarness();
    const options: AgentExecutionServiceOptions = {
      ...harness.options,
      adapter: fakeAdapter({ outcome: 'SUCCEEDED', exitCode: 9 }),
    };
    const result = await executeAgentTask(options, {
      ticketId: 'AG-001',
      model: 'openai/gpt-5',
      instructions: 'return a self-contradictory result',
    });
    expect(result.run.status).toBe('NEEDS_HUMAN');
    expect(result.run.failureCategory).toBe('adapter_error');
    expect(result.run.failureReason).toMatch(/inconsistent normalized result/);
  });

  it('records cancellation and never persists the instructions or environment', async () => {
    harness = await createHarness();
    const script = providerScript('if [ "$1" = "--version" ]; then printf -- "1.0.0\\n"; exit 0; fi; if [ "$1" = "run" ] && [ "$2" = "--help" ]; then printf -- "--format --dir --model --auto\\n"; exit 0; fi; sleep 30');
    const options: AgentExecutionServiceOptions = {
      ...harness.options,
      adapter: new OpenCodeAdapter({ executable: script, environment: { TEST_SECRET: 'do-not-persist' } }),
    };
    const controller = new AbortController();
    const execution = executeAgentTask(options, {
      ticketId: 'AG-001',
      model: 'openai/gpt-5',
      instructions: 'cancel this safely',
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const result = await execution;
    expect(result.run.status).toBe('CANCELLED');
    expect(result.run.failureCategory).toBe('cancelled');
    expect(result.run.stdout).not.toContain('do-not-persist');
    expect(JSON.stringify(result.run)).not.toContain('cancel this safely');
  });

  it('redacts credential-shaped normalized evidence before durable persistence', async () => {
    harness = await createHarness();
    const options: AgentExecutionServiceOptions = {
      ...harness.options,
      adapter: fakeAdapter({
        providerSessionId: 'sk-12345678901234567890',
        evidence: {
          outputFormat: 'jsonl',
          eventCount: 1,
          eventTypes: ['token=secret-value'],
          summary: 'ordinary completion',
        },
      }),
    };
    const result = await executeAgentTask(options, {
      ticketId: 'AG-001',
      model: 'openai/gpt-5',
      instructions: 'redact normalized evidence',
    });
    expect(result.run.providerSessionId).toBeUndefined();
    expect(result.run.evidence?.eventTypes).toEqual(['token=[REDACTED_SECRET]']);
    expect(JSON.stringify(result.run)).not.toContain('secret-value');
  });

  it('surfaces an active post-restart run as NEEDS_HUMAN only through explicit recovery', async () => {
    harness = await createHarness();
    const now = new Date().toISOString();
    const stale = {
      id: 'stale-run-1',
      projectId: (await inspectAgentProjectId(harness)).projectId,
      ticketId: 'AG-001',
      workspaceId: findWorkspaceId(harness),
      workspacePath: harness.workspacePath,
      baseSha: harness.baseSha,
      branchName: 'shipgraph/ag-001',
      status: 'RUNNING' as const,
      provider: 'opencode',
      model: 'openai/gpt-5',
      createdAt: now,
      startedAt: now,
      updatedAt: now,
      timedOut: false,
      cancelled: false,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      instructionsSha256: '0'.repeat(64),
      timeoutMs: 1_000,
    };
    createRunRepository(harness.db).create(stale);
    const result = await recoverAgentRun({
      db: harness.db,
      projectDir: harness.projectDir,
      worktreeRoot: harness.worktreeRoot,
    }, stale.id);
    expect(result.recovered).toBe(true);
    expect(result.run.status).toBe('NEEDS_HUMAN');
    expect(result.run.failureCategory).toBe('stale_run');
  });

  it('retains a routed provider reservation when recovery cannot prove process ownership', async () => {
    harness = await createHarness();
    const projectId = (await inspectAgentProjectId(harness)).projectId;
    const prepared = await prepareAgentTaskRun(
      {
        ...harness.options,
        createRunId: () => 'model-recovery-run',
      },
      {
        ticketId: 'AG-001',
        provider: 'opencode',
        modelProviderId: 'opencode-go',
        model: 'opencode/dynamic-model',
        instructions: 'prepare a recoverable routed run',
      }
    );
    const providerAdapter: ModelProviderAdapter = {
      providerId: 'opencode-go',
      family: 'opencode',
      displayName: 'OpenCode Go',
      probe: async () => ({
        availability: 'available',
        auth: 'authenticated',
        version: 'test',
        capabilities: ['implementation'],
      }),
      discoverModels: async () => ({
        status: 'known',
        models: [{ modelId: 'opencode/dynamic-model', capabilities: ['implementation'] }],
      }),
    };
    const modelService = new ModelRoutingService({
      db: harness.db,
      projectId,
      adapters: [providerAdapter],
      executionAdapters: [{ modelProviderId: 'opencode-go', adapter: harness.options.adapter }],
    });
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
    expect(modelService.listHealth()[0]?.activeRuns).toBe(1);

    const recovered = await recoverAgentRun({
      db: harness.db,
      projectDir: harness.projectDir,
      worktreeRoot: harness.worktreeRoot,
    }, prepared.run.id);

    expect(recovered.run.status).toBe('NEEDS_HUMAN');
    expect(modelService.listHealth()[0]?.activeRuns).toBe(1);
    expect(createModelRepository(harness.db).findActiveRoutingDecisionByRun(projectId, prepared.run.id))
      .toMatchObject({ reservationStatus: 'active' });
    await modelService.recordUsage({
      runId: prepared.run.id,
      providerId: 'opencode-go',
      modelId: 'opencode/dynamic-model',
      task: 'implementation',
      retryCount: 0,
      elapsedMs: 0,
      outcome: 'unknown',
      outcomeQuality: 'unknown',
      routingDecisionId: decision.id,
    });
    expect(modelService.listHealth()[0]?.activeRuns).toBe(1);

    const reconciled = await reconcileAgentRun(
      {
        db: harness.db,
        projectDir: harness.projectDir,
        worktreeRoot: harness.worktreeRoot,
      },
      prepared.run.id,
      { executionStopped: true }
    );
    expect(reconciled.released).toBe(true);
    expect(modelService.listHealth()[0]?.activeRuns).toBe(0);
    expect(createModelRepository(harness.db).findActiveRoutingDecisionByRun(projectId, prepared.run.id))
      .toBeUndefined();
  });

  it.each([
    {
      task: 'review' as const,
      states: [
        TicketState.IMPLEMENTING,
        TicketState.VERIFYING,
        TicketState.PR_OPEN,
        TicketState.CI_WAIT,
        TicketState.REVIEWING,
      ],
    },
    {
      task: 'repair' as const,
      states: [TicketState.IMPLEMENTING, TicketState.VERIFYING, TicketState.REPAIRING],
    },
  ])('executes a routed $task through its task-capable AGENT adapter after implementation changes', async ({ task, states }) => {
    harness = await createHarness();
    const projectId = (await inspectAgentProjectId(harness)).projectId;
    for (const next of states) {
      persistTicketTransition(harness.db, {
        ticketId: 'AG-001',
        projectId,
        next,
        reason: `prepare ${task} execution test`,
      });
    }
    if (task === 'review') {
      // A reviewer must receive the implementation's committed change, not
      // the original READY/base-SHA-only workspace proof.
      writeFileSync(join(harness.workspacePath, 'README.md'), '# reviewed implementation\n');
      git(harness.workspacePath, 'add', 'README.md');
      git(harness.workspacePath, 'commit', '-m', 'implementation change for review');
    } else {
      // A repair agent may need to inspect an implementation's still-dirty
      // edits. The changed-workspace proof preserves them for the adapter.
      writeFileSync(join(harness.workspacePath, 'README.md'), '# dirty implementation\n');
    }

    const adapter = fakeAdapter({}, ['execute', task]);
    const providerAdapter: ModelProviderAdapter = {
      providerId: 'opencode-go',
      family: 'opencode',
      displayName: 'OpenCode Go',
      probe: async () => ({
        availability: 'available',
        auth: 'authenticated',
        version: 'test-provider',
        capabilities: [task],
      }),
      discoverModels: async () => ({
        status: 'known',
        models: [{ modelId: `opencode/${task}-model`, capabilities: [task] }],
      }),
    };
    const modelService = new ModelRoutingService({
      db: harness.db,
      projectId,
      adapters: [providerAdapter],
      executionAdapters: [{ modelProviderId: 'opencode-go', adapter }],
    });
    const prepared = await prepareAgentTaskRun(
      {
        ...harness.options,
        adapter,
        createRunId: () => `model-${task}-run`,
      },
      {
        ticketId: 'AG-001',
        provider: 'opencode',
        modelProviderId: 'opencode-go',
        model: `opencode/${task}-model`,
        task,
        instructions: `run the ${task} task through the selected route`,
      }
    );
    const decision = await modelService.route({
      runId: prepared.run.id,
      task,
      risk: 'medium',
      envelope: {
        mode: 'balanced',
        maxConcurrentTickets: 2,
        activeConcurrentTickets: 0,
        budgetRemaining: 'unknown',
      },
    });
    const target = modelService.resolveExecutionTarget(decision);
    const execution = await modelService.executeSelectedAgentTask(
      { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      target,
      { ticketId: 'AG-001', instructions: `run the ${task} task through the selected route` }
    );

    expect(target).not.toHaveProperty('adapter');
    expect(target.task).toBe(task);
    expect(execution.run.status).toBe('SUCCEEDED');
    expect(execution.run.modelProviderId).toBe('opencode-go');
    expect(createTicketRepository(harness.db).findById('AG-001')?.status).toBe(states.at(-1));
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]?.model).toBe(`opencode/${task}-model`);
    expect(modelService.listHealth()[0]?.activeRuns).toBe(0);
  });

  it('routes, binds, and executes a task through one public operation', async () => {
    harness = await createHarness();
    const projectId = (await inspectAgentProjectId(harness)).projectId;
    const providerAdapter: ModelProviderAdapter = {
      providerId: 'opencode-go',
      family: 'opencode',
      displayName: 'OpenCode Go',
      probe: async () => ({
        availability: 'available', auth: 'authenticated', version: 'test',
        capabilities: ['implementation'],
      }),
      discoverModels: async () => ({
        status: 'known',
        models: [{ modelId: 'opencode/routed', capabilities: ['implementation'] }],
      }),
    };
    const modelService = new ModelRoutingService({
      db: harness.db,
      projectId,
      adapters: [providerAdapter],
      executionAdapters: [{ modelProviderId: 'opencode-go', adapter: harness.options.adapter }],
    });

    const result = await modelService.executeRoutedAgentTask(
      { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      {
        task: 'implementation',
        risk: 'medium',
        envelope: {
          mode: 'balanced', maxConcurrentTickets: 1,
          activeConcurrentTickets: 0, budgetRemaining: 'unknown',
        },
      },
      { ticketId: 'AG-001', instructions: 'execute the selected route' }
    );

    expect(result.decision.providerId).toBe('opencode-go');
    expect(result.run.status).toBe('SUCCEEDED');
    expect(result.run.model).toBe('opencode/routed');
    expect((harness.options.adapter as FakeAdapter).requests).toHaveLength(1);
    expect(modelService.listHealth()[0]?.activeRuns).toBe(0);
  });

  it('releases a bound route when the prepared workspace becomes invalid before launch', async () => {
    harness = await createHarness();
    const projectId = (await inspectAgentProjectId(harness)).projectId;
    const providerAdapter: ModelProviderAdapter = {
      providerId: 'opencode-go',
      family: 'opencode',
      displayName: 'OpenCode Go',
      probe: async () => ({
        availability: 'available', auth: 'authenticated', version: 'test',
        capabilities: ['implementation'],
      }),
      discoverModels: async () => ({
        status: 'known',
        models: [{ modelId: 'opencode/routed', capabilities: ['implementation'] }],
      }),
    };
    const modelService = new ModelRoutingService({
      db: harness.db,
      projectId,
      adapters: [providerAdapter],
      executionAdapters: [{ modelProviderId: 'opencode-go', adapter: harness.options.adapter }],
    });
    const prepared = await prepareAgentTaskRun(
      harness.options,
      {
        ticketId: 'AG-001',
        provider: 'opencode',
        modelProviderId: 'opencode-go',
        model: 'opencode/routed',
        instructions: 'must not launch after workspace drift',
      }
    );
    const decision = await modelService.route({
      runId: prepared.run.id,
      task: 'implementation',
      risk: 'medium',
      envelope: {
        mode: 'balanced', maxConcurrentTickets: 1,
        activeConcurrentTickets: 0, budgetRemaining: 'unknown',
      },
    });
    writeFileSync(join(harness.workspacePath, 'README.md'), '# drifted after binding\n');

    await expect(modelService.executeSelectedAgentTask(
      { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      modelService.resolveExecutionTarget(decision),
      { ticketId: 'AG-001', instructions: 'a mismatched request must not release the route' }
    )).rejects.toThrow(/does not match the execution request/);
    expect(createRunRepository(harness.db).findById(prepared.run.id)?.status).toBe('CREATED');
    expect(modelService.listHealth()[0]?.activeRuns).toBe(1);
    expect(createModelRepository(harness.db).findActiveRoutingDecisionByRun(projectId, prepared.run.id))
      .toMatchObject({ reservationStatus: 'active', runId: prepared.run.id });

    const result = await modelService.executeSelectedAgentTask(
      { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      modelService.resolveExecutionTarget(decision),
      { ticketId: 'AG-001', instructions: 'must not launch after workspace drift' }
    );

    expect(result.run.status).toBe('NEEDS_HUMAN');
    expect(result.run.failureCategory).toBe('workspace_invalid');
    expect((harness.options.adapter as FakeAdapter).requests).toHaveLength(0);
    expect(modelService.listHealth()[0]?.activeRuns).toBe(0);
    expect(createModelRepository(harness.db).findActiveRoutingDecisionByRun(projectId, prepared.run.id))
      .toBeUndefined();
    expect(createModelRepository(harness.db).findRoutingDecisionById(projectId, decision.id))
      .toMatchObject({ reservationStatus: 'released', runId: prepared.run.id });
  });

  it('refreshes providers once before routing and proves the selected adapter before launch', async () => {
    harness = await createHarness();
    const projectId = (await inspectAgentProjectId(harness)).projectId;
    let codexProbeCount = 0;
    const codexProvider: ModelProviderAdapter = {
      providerId: 'codex', family: 'openai', displayName: 'Codex',
      probe: async () => {
        codexProbeCount += 1;
        return {
          availability: 'available' as const,
          auth: 'authenticated' as const,
          version: 'test', capabilities: ['implementation'] as const,
        };
      },
      discoverModels: async () => ({
        status: 'known', models: [{ modelId: 'codex/routed', capabilities: ['implementation'] }],
      }),
    };
    const openCodeProvider: ModelProviderAdapter = {
      providerId: 'opencode-go', family: 'opencode', displayName: 'OpenCode Go',
      probe: async () => ({
        availability: 'available', auth: 'authenticated', version: 'test',
        capabilities: ['implementation'],
      }),
      discoverModels: async () => ({
        status: 'known', models: [{ modelId: 'opencode/fallback', capabilities: ['implementation'] }],
      }),
    };
    const codexRequests: AgentExecutionRequest[] = [];
    const codexExecution: AgentExecutionAdapter = {
      provider: 'codex', capabilities: ['execute'],
      probe: () => ({ available: true, version: 'test' }),
      execute: async (request) => {
        codexRequests.push(request);
        if (request.onProcessStarted !== undefined) await request.onProcessStarted(4243);
        return {
          outcome: 'SUCCEEDED',
          providerSessionId: 'codex-session',
          providerProcessId: 4243,
          exitCode: 0,
          timedOut: false,
          cancelled: false,
          processGroupStopped: true,
          stdout: '{"type":"result","text":"done"}',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          evidence: {
            outputFormat: 'jsonl' as const,
            eventCount: 1,
            eventTypes: ['result'],
            summary: 'done',
          },
        };
      },
    };
    registerModelProviderAdapter(codexExecution, 'codex');
    const modelService = new ModelRoutingService({
      db: harness.db, projectId,
      adapters: [codexProvider, openCodeProvider],
      executionAdapters: [
        { modelProviderId: 'codex', adapter: codexExecution },
        { modelProviderId: 'opencode-go', adapter: harness.options.adapter },
      ],
    });

    const result = await modelService.executeRoutedAgentTask(
      { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      {
        task: 'implementation', risk: 'medium',
        envelope: {
          mode: 'balanced', maxConcurrentTickets: 1,
          activeConcurrentTickets: 0, budgetRemaining: 'unknown',
        },
      },
      { ticketId: 'AG-001', instructions: 'use the selected provider' }
    );

    expect(codexProbeCount).toBe(1);
    expect(result.decision.providerId).toBe('codex');
    expect(result.run.status).toBe('SUCCEEDED');
    expect(codexRequests).toHaveLength(1);
    expect((harness.options.adapter as FakeAdapter).requests).toHaveLength(0);
  });

  it('durably recovers and releases a route when capability probing fails before launch', async () => {
    harness = await createHarness();
    const projectId = (await inspectAgentProjectId(harness)).projectId;
    const prepared = await prepareAgentTaskRun(
      {
        ...harness.options,
        createRunId: () => 'capability-drift-run',
      },
      {
        ticketId: 'AG-001',
        provider: 'opencode',
        modelProviderId: 'opencode-go',
        model: 'opencode/dynamic-model',
        instructions: 'must not launch after capability drift',
      }
    );
    const providerAdapter: ModelProviderAdapter = {
      providerId: 'opencode-go',
      family: 'opencode',
      displayName: 'OpenCode Go',
      probe: async () => ({
        availability: 'available',
        auth: 'authenticated',
        version: 'test',
        capabilities: ['implementation'],
      }),
      discoverModels: async () => ({
        status: 'known',
        models: [{ modelId: 'opencode/dynamic-model', capabilities: ['implementation'] }],
      }),
    };
    const modelService = new ModelRoutingService({
      db: harness.db,
      projectId,
      adapters: [providerAdapter],
      executionAdapters: [{ modelProviderId: 'opencode-go', adapter: harness.options.adapter }],
    });
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
    harness.options.adapter.probe = () => ({
      available: false,
      reason: 'test executable disappeared',
    });

    const result = await modelService.executeSelectedAgentTask(
      { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      target,
      { ticketId: 'AG-001', instructions: 'must not launch after capability drift' }
    );

    expect(result.run.status).toBe('NEEDS_HUMAN');
    expect(result.run.failureCategory).toBe('executable_unavailable');
    expect((harness.options.adapter as FakeAdapter).requests).toHaveLength(0);
    expect(modelService.listHealth()[0]?.activeRuns).toBe(0);
    expect(createModelRepository(harness.db).findActiveRoutingDecisionByRun(projectId, prepared.run.id))
      .toBeUndefined();
  });
});

async function inspectAgentProjectId(harness: Harness): Promise<{ projectId: string }> {
  const row = harness.db.prepare('SELECT id AS project_id FROM projects LIMIT 1').get() as { project_id: string };
  return { projectId: row.project_id };
}

function findWorkspaceId(harness: Harness): string {
  const row = harness.db.prepare('SELECT id FROM workspaces WHERE ticket_id = ?').get('AG-001') as { id: string };
  return row.id;
}
