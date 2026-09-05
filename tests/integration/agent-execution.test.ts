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
import { UsageLedger } from '../../src/model/ledger.js';
import {
  executeAgentTask,
  prepareAgentTaskRun,
  preparePrePrReviewTask,
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
    supportsTokenLimit: true,
    supportsCostLimit: true,
    reportsUsage: true,
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

  it('persists successful streamed evidence beyond the retained prefix and keeps durable UTF-8 bounded', async () => {
    harness = await createHarness();
    const adapter = fakeAdapter({
      stdout: 'a' + '😀'.repeat(32768), stdoutTruncated: true,
      evidence: { outputFormat: 'jsonl', eventCount: 11001, eventTypes: ['text', 'step_finish'], summary: 'completed after retention' },
    });
    const result = await executeAgentTask({ ...harness.options, adapter }, {
      ticketId: 'AG-001', model: 'test', instructions: 'exercise persisted streaming evidence',
    });
    expect(result.run.status).toBe('SUCCEEDED');
    const persisted = createRunRepository(harness.db).findById(result.run.id);
    expect(persisted?.evidence).toMatchObject({ eventCount: 11001, summary: 'completed after retention' });
    expect(persisted?.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(persisted?.stdout ?? '')).toBeLessThanOrEqual(131072);
  });

  it('does not persist unbound adapter review fields as KAR-9 evidence', async () => {
    harness = await createHarness();
    const adapter = fakeAdapter({ reviewResult: 'PASS', reviewFindings: [] });
    const result = await executeAgentTask(
      { ...harness.options, adapter },
      {
        ticketId: 'AG-001',
        model: 'openai/gpt-5',
        instructions: 'Execute the generic AGENT-001 task.',
      }
    );

    expect(result.run.status).toBe('SUCCEEDED');
    expect(result.run.reviewType).toBeUndefined();
    expect(result.run.reviewedSha).toBeUndefined();
    expect(result.run.reviewResult).toBeUndefined();
    expect(result.run.reviewFindings).toBeUndefined();
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
      safety: { maxTokens: 0 },
      modelProviderId: 'opencode-go' as const,
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
  ])('fails closed before launch for $name', async ({ timeoutMs, modelProviderId, safety, category, reason }) => {
    harness = await createHarness();
    const result = await executeAgentTask(harness.options, {
      ticketId: 'AG-001',
      ...(modelProviderId === undefined ? {} : { modelProviderId }),
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

  it('binds the effective safety policy to the durable prepared run', async () => {
    harness = await createHarness();
    const prepared = await prepareAgentTaskRun(
      { ...harness.options, createRunId: () => 'policy-bound-run' },
      {
        ticketId: 'AG-001',
        provider: 'opencode',
        modelProviderId: 'opencode-go',
        model: 'openai/gpt-5',
        instructions: 'prepare this run with its safety policy',
        timeoutMs: 1_000,
        safety: {
          maxAttempts: 2,
          maxTokens: 10,
          maxCost: 1,
          maxTimeoutMs: 1_000,
          approvalRequired: true,
          approvalGranted: true,
          scopeGrowth: false,
        },
      }
    );

    expect(prepared.run.safetyPolicySha256).toMatch(/^[0-9a-f]{64}$/);
    const handoffAdapter = fakeAdapter();
    await expect(executeAgentTask(
      { ...harness.options, adapter: handoffAdapter },
      {
        ticketId: 'AG-001',
        provider: 'opencode',
        modelProviderId: 'opencode-go',
        model: 'openai/gpt-5',
        instructions: 'prepare this run with its safety policy',
        runId: prepared.run.id,
        timeoutMs: 1_000,
      }
    )).rejects.toThrow(/does not match the durable safety policy/);
    expect(handoffAdapter.requests).toHaveLength(0);
    expect(createRunRepository(harness.db).findById(prepared.run.id)?.status).toBe('CREATED');
  });

  it('uses durable usage-ledger totals and passes remaining limits to the adapter', async () => {
    harness = await createHarness();
    const prepared = await prepareAgentTaskRun(
      { ...harness.options, createRunId: () => 'usage-bound-run' },
      {
        ticketId: 'AG-001',
        provider: 'opencode',
        modelProviderId: 'opencode-go',
        model: 'openai/gpt-5',
        instructions: 'continue within the durable usage budget',
        safety: { maxTokens: 10, maxCost: 1 },
      }
    );
    const projectId = (await inspectAgentProjectId(harness)).projectId;
    new UsageLedger(createModelRepository(harness.db), projectId).append({
      runId: prepared.run.id,
      providerId: 'opencode-go',
      modelId: 'openai/gpt-5',
      task: 'implementation',
      retryCount: 0,
      elapsedMs: 1,
      outcome: 'succeeded',
      outcomeQuality: 'good',
      inputTokens: 6,
      outputTokens: 3,
      cost: 0.8,
    });
    const adapter = fakeAdapter({ usage: { inputTokens: 0, outputTokens: 1, cost: 0.2 } });
    const result = await executeAgentTask(
      { ...harness.options, adapter },
      {
        ticketId: 'AG-001',
        provider: 'opencode',
        modelProviderId: 'opencode-go',
        model: 'openai/gpt-5',
        instructions: 'continue within the durable usage budget',
        runId: prepared.run.id,
        safety: { maxTokens: 10, maxCost: 1 },
      }
    );

    expect(adapter.requests[0]?.remainingTokens).toBe(1);
    expect(adapter.requests[0]?.remainingCost).toBeCloseTo(0.2);
    expect(result.run.status).toBe('SUCCEEDED');
    expect(createModelRepository(harness.db).listUsage(projectId)
      .filter((entry) => entry.runId === prepared.run.id)).toHaveLength(2);
  });

  it.each([
    {
      name: 'timed out',
      result: { outcome: 'TIMED_OUT' as const, timedOut: true, cancelled: false, failureCategory: 'timeout' as const },
    },
    {
      name: 'cancelled',
      result: { outcome: 'CANCELLED' as const, timedOut: false, cancelled: true, failureCategory: 'cancelled' as const },
    },
  ])('clears terminal flags when a $name result is safety-escalated', async ({ result }) => {
    harness = await createHarness();
    const options: AgentExecutionServiceOptions = {
      ...harness.options,
      adapter: fakeAdapter({ ...result, usage: { inputTokens: 1, outputTokens: 1, cost: 0 } }),
    };
    const execution = await executeAgentTask(options, {
      ticketId: 'AG-001',
      provider: 'opencode',
      modelProviderId: 'opencode-go',
      model: 'openai/gpt-5',
      instructions: 'preserve normalized terminal outcome invariants',
      safety: { maxTokens: 1 },
    });

    expect(execution.run.status).toBe('NEEDS_HUMAN');
    expect(execution.run.failureCategory).toBe('safety_limit');
    expect(execution.run.timedOut).toBe(false);
    expect(execution.run.cancelled).toBe(false);
  });

  it('fails closed after a successful provider result exceeds a configured token budget', async () => {
    harness = await createHarness();
    const options: AgentExecutionServiceOptions = {
      ...harness.options,
      adapter: fakeAdapter({ usage: { inputTokens: 2, outputTokens: 3, cost: 0 } }),
    };

    const result = await executeAgentTask(options, {
      ticketId: 'AG-001',
      modelProviderId: 'opencode-go',
      model: 'openai/gpt-5',
      instructions: 'enforce the token budget after normalized provider usage',
      safety: { maxTokens: 4 },
    });

    expect(result.run.status).toBe('NEEDS_HUMAN');
    expect(result.run.failureCategory).toBe('safety_limit');
    expect(result.run.failureReason).toMatch(/token budget exceeded/);
    expect((options.adapter as FakeAdapter).requests).toHaveLength(1);
  });

  it('fails closed when a failed provider result reports usage over the token budget', async () => {
    harness = await createHarness();
    const options: AgentExecutionServiceOptions = {
      ...harness.options,
      adapter: fakeAdapter({
        outcome: 'FAILED',
        failureCategory: 'non_zero_exit',
        failureReason: 'provider failed after consuming the request',
        usage: { inputTokens: 3, outputTokens: 2, cost: 0 },
      }),
    };

    const result = await executeAgentTask(options, {
      ticketId: 'AG-001',
      modelProviderId: 'opencode-go',
      model: 'openai/gpt-5',
      instructions: 'enforce the token budget for failed provider results too',
      safety: { maxTokens: 4 },
    });

    expect(result.run.status).toBe('NEEDS_HUMAN');
    expect(result.run.failureCategory).toBe('safety_limit');
    expect(result.run.failureReason).toMatch(/token budget exceeded/);
  });

  it('requires measurable usage when a cost budget is configured', async () => {
    harness = await createHarness();
    const projectId = (await inspectAgentProjectId(harness)).projectId;
    const result = await executeAgentTask(harness.options, {
      ticketId: 'AG-001',
      modelProviderId: 'opencode-go',
      model: 'openai/gpt-5',
      instructions: 'do not treat missing cost telemetry as safe',
      safety: { maxCost: 1 },
    });

    expect(result.run.status).toBe('NEEDS_HUMAN');
    expect(result.run.failureCategory).toBe('safety_limit');
    expect(result.run.failureReason).toMatch(/did not report cost/);
    expect(createModelRepository(harness.db).listUsage(projectId)
      .filter((entry) => entry.runId === result.run.id)).toMatchObject([
        { inputTokens: 'unknown', outputTokens: 'unknown', cost: 'unknown' },
      ]);
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

    const adapter = fakeAdapter(
      task === 'review'
        ? {
            stdout: JSON.stringify({ result: 'PASS', findings: [] }),
            evidence: {
              outputFormat: 'jsonl',
              eventCount: 1,
              eventTypes: ['review'],
              summary: JSON.stringify({ result: 'PASS', findings: [] }),
            },
          }
        : {},
      ['execute', task]
    );
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
    const reviewProvenance = task === 'review'
      ? { reviewType: 'contract' as const, reviewedSha: git(harness.workspacePath, 'rev-parse', 'HEAD') }
      : undefined;
    const preparationInput = {
      ticketId: 'AG-001',
      provider: 'opencode' as const,
      modelProviderId: 'opencode-go' as const,
      model: `opencode/${task}-model`,
      task,
      instructions: `run the ${task} task through the selected route`,
    };
    const prepared = reviewProvenance === undefined
      ? await prepareAgentTaskRun(
          { ...harness.options, adapter, createRunId: () => `model-${task}-run` },
          preparationInput
        )
      : await preparePrePrReviewTask(
          { ...harness.options, adapter, createRunId: () => `model-${task}-run` },
          preparationInput,
          reviewProvenance
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
    const execution = reviewProvenance === undefined
      ? await modelService.executeSelectedAgentTask(
          { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
          target,
          { ticketId: 'AG-001', instructions: `run the ${task} task through the selected route` }
        )
      : await modelService.executeSelectedPrePrReviewTask(
          { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
          target,
          { ticketId: 'AG-001', instructions: `run the ${task} task through the selected route` },
          reviewProvenance
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

  it('falls back after a final-probe race while retaining the failed run and one active reservation', async () => {
    harness = await createHarness();
    const projectId = (await inspectAgentProjectId(harness)).projectId;
    const provider = (providerId: 'codex' | 'opencode-go', modelId: string): ModelProviderAdapter => ({
      providerId,
      family: providerId === 'codex' ? 'openai' : 'opencode',
      displayName: providerId,
      probe: async () => ({
        availability: 'available', auth: 'authenticated', version: 'test',
        capabilities: ['implementation'],
      }),
      discoverModels: async () => ({
        status: 'known', models: [{ modelId, capabilities: ['implementation'] }],
      }),
    });
    let codexProbeCount = 0;
    const codexRequests: AgentExecutionRequest[] = [];
    const codexExecution: AgentExecutionAdapter = {
      provider: 'codex', capabilities: ['execute'],
      probe: () => {
        codexProbeCount += 1;
        return codexProbeCount === 1
          ? { available: true, version: 'test' }
          : { available: false, reason: 'executable disappeared before spawn' };
      },
      execute: async (request) => {
        codexRequests.push(request);
        throw new Error('final-probe failure must prevent execution');
      },
    };
    registerModelProviderAdapter(codexExecution, 'codex');
    const fallbackExecution = fakeAdapter();
    fallbackExecution.execute = async (request) => {
      fallbackExecution.requests.push(request);
      const active = createRunRepository(harness?.db as DbConnection).findActiveByTicket(projectId, 'AG-001');
      expect(active?.id).toBe(request.runId);
      expect(modelService.listHealth().reduce((sum, health) => sum + health.activeRuns, 0)).toBe(1);
      if (request.onProcessStarted !== undefined) await request.onProcessStarted(4242);
      return {
        outcome: 'SUCCEEDED', providerSessionId: 'fallback-session', providerProcessId: 4242,
        exitCode: 0, timedOut: false, cancelled: false, processGroupStopped: true,
        stdout: '{"type":"text","text":"done"}', stderr: '',
        stdoutTruncated: false, stderrTruncated: false,
      };
    };
    const modelService = new ModelRoutingService({
      db: harness.db,
      projectId,
      adapters: [provider('codex', 'codex/primary'), provider('opencode-go', 'opencode/fallback')],
      executionAdapters: [
        { modelProviderId: 'codex', adapter: codexExecution },
        { modelProviderId: 'opencode-go', adapter: fallbackExecution },
      ],
    });
    const contractDigest = 'a'.repeat(64);

    const result = await modelService.executeRoutedAgentTask(
      { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      {
        requestId: 'kar-17-final-probe-stage', task: 'implementation', risk: 'medium',
        envelope: {
          mode: 'balanced', maxConcurrentTickets: 1,
          activeConcurrentTickets: 0, budgetRemaining: 'unknown',
        },
      },
      {
        ticketId: 'AG-001', instructions: 'fall back after the final probe',
        executionId: 'execution-kar-17', contractDigest,
        contractSource: 'linear://KAR-17', contractRevision: 'revision-1',
      }
    );

    const runs = createRunRepository(harness.db).findByTicketId('AG-001');
    expect(result.decision.providerId).toBe('opencode-go');
    expect(result.run.status).toBe('SUCCEEDED');
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      status: 'NEEDS_HUMAN', failureCategory: 'executable_unavailable',
    });
    expect(runs[0]?.providerProcessId).toBeUndefined();
    expect(runs[0]?.providerSessionId).toBeUndefined();
    expect(createEventRepository(harness.db).findByTicketId('AG-001').some((event) =>
      'runId' in event && event.runId === runs[0]?.id &&
      event.type === 'run.state_changed' &&
      (event.payload as { next?: string }).next === 'RUNNING'
    )).toBe(false);
    expect(runs.map((run) => run.executionId)).toEqual(['execution-kar-17', 'execution-kar-17']);
    expect(runs.map((run) => run.contractDigest)).toEqual([contractDigest, contractDigest]);
    expect(new Set(runs.map((run) => run.workspaceId)).size).toBe(1);
    expect(codexRequests).toHaveLength(0);
    expect(fallbackExecution.requests).toHaveLength(1);
    const primaryDecision = modelService.listRoutingDecisions()
      .find((entry) => entry.providerId === 'codex');
    expect(primaryDecision).toBeDefined();
    expect(createModelRepository(harness.db).findRoutingDecisionById(projectId, primaryDecision?.id ?? ''))
      .toMatchObject({ reservationStatus: 'released', runId: runs[0]?.id });
    expect(modelService.listHealth().every((health) => health.activeRuns === 0)).toBe(true);
  });

  it('returns the durable final-probe failure when refresh leaves no safe alternative', async () => {
    harness = await createHarness();
    const projectId = (await inspectAgentProjectId(harness)).projectId;
    const metadata = (providerId: 'codex' | 'opencode-go', modelId: string): ModelProviderAdapter => ({
      providerId, family: providerId === 'codex' ? 'openai' : 'opencode', displayName: providerId,
      probe: async () => ({
        availability: 'available', auth: 'authenticated', version: 'test',
        capabilities: ['implementation'],
      }),
      discoverModels: async () => ({ status: 'known', models: [{ modelId, capabilities: ['implementation'] }] }),
    });
    let primaryProbeCount = 0;
    const primary: AgentExecutionAdapter = {
      provider: 'codex', capabilities: ['execute'],
      probe: () => (++primaryProbeCount === 1
        ? { available: true, version: 'test' }
        : { available: false, reason: 'primary disappeared before launch' }),
      execute: async () => { throw new Error('final probe must prevent launch'); },
    };
    let fallbackProbeCount = 0;
    const fallback = fakeAdapter();
    fallback.probe = () => (++fallbackProbeCount === 1
      ? { available: true, version: 'test' }
      : { available: false, reason: 'fallback is unavailable after refresh' });
    registerModelProviderAdapter(primary, 'codex');
    const modelService = new ModelRoutingService({
      db: harness.db, projectId,
      adapters: [metadata('codex', 'codex/primary'), metadata('opencode-go', 'opencode/fallback')],
      executionAdapters: [
        { modelProviderId: 'codex', adapter: primary },
        { modelProviderId: 'opencode-go', adapter: fallback },
      ],
    });

    const result = await modelService.executeRoutedAgentTask(
      { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      {
        requestId: 'kar-17-no-final-fallback', task: 'implementation', risk: 'medium',
        envelope: {
          mode: 'balanced', maxConcurrentTickets: 1,
          activeConcurrentTickets: 0, budgetRemaining: 'unknown',
        },
      },
      { ticketId: 'AG-001', instructions: 'return the durable pre-launch failure' }
    );

    expect(result.decision.providerId).toBe('codex');
    expect(result.run).toMatchObject({
      status: 'NEEDS_HUMAN', failureCategory: 'executable_unavailable',
    });
    expect(createEventRepository(harness.db).findByTicketId('AG-001').some((event) =>
      'runId' in event && event.runId === result.run.id &&
      event.type === 'run.state_changed' &&
      (event.payload as { next?: string }).next === 'RUNNING'
    )).toBe(false);
    expect(fallback.requests).toHaveLength(0);
    expect(createRunRepository(harness.db).findByTicketId('AG-001')).toHaveLength(1);
    expect(createTicketRepository(harness.db).findById('AG-001')?.status).toBe('PLANNING');
    expect(modelService.listHealth().every((health) => health.activeRuns === 0)).toBe(true);
  });

  it('fails closed while refreshed durable provider evidence keeps unknown alternatives non-routable', async () => {
    harness = await createHarness();
    const projectId = (await inspectAgentProjectId(harness)).projectId;
    const requests: AgentExecutionRequest[] = [];
    let codexProbeCount = 0;
    const execution = (
      modelProviderId: 'codex' | 'gemini' | 'grok' | 'opencode-go',
      provider: AgentExecutionAdapter['provider'],
      probe: AgentExecutionAdapter['probe']
    ): AgentExecutionAdapter => {
      const adapter: AgentExecutionAdapter = {
        provider, capabilities: ['execute'], probe,
        execute: async (request) => {
          requests.push(request);
          throw new Error('unknown provider state must not be launched');
        },
      };
      registerModelProviderAdapter(adapter, modelProviderId);
      return adapter;
    };
    const metadata: ModelProviderAdapter[] = [
      {
        providerId: 'codex', family: 'openai', displayName: 'Codex',
        probe: async () => ({
          availability: 'available', auth: 'authenticated', version: 'test',
          capabilities: ['implementation'],
        }),
        discoverModels: async () => ({
          status: 'known', models: [{ modelId: 'codex/primary', capabilities: ['implementation'] }],
        }),
      },
      {
        providerId: 'gemini', family: 'google', displayName: 'Gemini',
        probe: async () => ({
          availability: 'available', auth: 'unknown', version: 'test',
          capabilities: ['implementation'], reason: 'authentication is not proven',
        }),
        discoverModels: async () => ({
          status: 'known', models: [{ modelId: 'gemini/unknown-auth', capabilities: ['implementation'] }],
        }),
      },
      {
        providerId: 'grok', family: 'xai', displayName: 'Grok',
        probe: async () => ({
          availability: 'available', auth: 'authenticated', version: 'test',
          capabilities: ['implementation'],
        }),
        discoverModels: async () => ({
          status: 'known', models: [{ modelId: 'grok/unknown-execution', capabilities: ['implementation'] }],
        }),
      },
      {
        providerId: 'opencode-go', family: 'opencode', displayName: 'OpenCode Go',
        probe: async () => ({
          availability: 'available', auth: 'authenticated', version: 'test',
          capabilities: ['implementation'],
        }),
        discoverModels: async () => ({ status: 'unknown', reason: 'catalog is not proven' }),
      },
    ];
    const modelService = new ModelRoutingService({
      db: harness.db,
      projectId,
      adapters: metadata,
      executionAdapters: [
        {
          modelProviderId: 'codex',
          adapter: execution('codex', 'codex', () => {
            codexProbeCount += 1;
            return codexProbeCount === 1
              ? { available: true, version: 'test' }
              : { available: false, reason: 'executable unavailable' };
          }),
        },
        { modelProviderId: 'gemini', adapter: execution('gemini', 'acp', () => ({ available: true })) },
        { modelProviderId: 'grok', adapter: execution('grok', 'acp', () => ({ available: false, reason: 'probe unavailable' })) },
        { modelProviderId: 'opencode-go', adapter: execution('opencode-go', 'opencode', () => ({ available: true })) },
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
      { ticketId: 'AG-001', instructions: 'fail closed when no fallback is proven' }
    );

    expect(result.run.status).toBe('NEEDS_HUMAN');
    expect(result.run.failureCategory).toBe('executable_unavailable');
    expect(result.run.failureReason?.length).toBeLessThanOrEqual(2_048);
    expect(modelService.listHealth().find((entry) => entry.providerId === 'gemini')?.auth)
      .toBe('unknown');
    expect(modelService.listProviders().find((entry) => entry.providerId === 'grok')?.executionStatus)
      .toBe('unknown');
    expect(modelService.listProviders().find((entry) => entry.providerId === 'opencode-go')?.catalogStatus)
      .toBe('unknown');
    expect(requests).toHaveLength(0);
    expect(createRunRepository(harness.db).findByTicketId('AG-001')).toHaveLength(1);
    expect(modelService.listHealth().every((health) => health.activeRuns === 0)).toBe(true);
  });

  it('does not launch a fallback beyond the configured attempt ceiling', async () => {
    harness = await createHarness();
    const projectId = (await inspectAgentProjectId(harness)).projectId;
    const metadata = (providerId: 'codex' | 'opencode-go', modelId: string): ModelProviderAdapter => ({
      providerId, family: providerId === 'codex' ? 'openai' : 'opencode', displayName: providerId,
      probe: async () => ({
        availability: 'available', auth: 'authenticated', version: 'test',
        capabilities: ['implementation'],
      }),
      discoverModels: async () => ({ status: 'known', models: [{ modelId, capabilities: ['implementation'] }] }),
    });
    let codexProbeCount = 0;
    const codexExecution: AgentExecutionAdapter = {
      provider: 'codex', capabilities: ['execute'],
      probe: () => (++codexProbeCount === 1
        ? { available: true, version: 'test' }
        : { available: false, reason: 'executable unavailable' }),
      execute: async () => { throw new Error('unlaunchable provider must not execute'); },
    };
    registerModelProviderAdapter(codexExecution, 'codex');
    const fallbackExecution = fakeAdapter();
    const modelService = new ModelRoutingService({
      db: harness.db, projectId,
      adapters: [metadata('codex', 'codex/primary'), metadata('opencode-go', 'opencode/fallback')],
      executionAdapters: [
        { modelProviderId: 'codex', adapter: codexExecution },
        { modelProviderId: 'opencode-go', adapter: fallbackExecution },
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
      {
        ticketId: 'AG-001', instructions: 'respect the attempt ceiling',
        safety: { maxAttempts: 1 },
      }
    );

    expect(result.run.status).toBe('NEEDS_HUMAN');
    expect(fallbackExecution.requests).toHaveLength(0);
    expect(createRunRepository(harness.db).findByTicketId('AG-001')).toHaveLength(1);
  });

  it.each([
    { name: 'a launched task failure', outcome: 'failed' as const },
    { name: 'ambiguous provider process ownership', outcome: 'ambiguous' as const },
    { name: 'an adapter result that omits process identity', outcome: 'identity-omitted' as const },
  ])('does not fall back after $name', async ({ outcome }) => {
    harness = await createHarness();
    const projectId = (await inspectAgentProjectId(harness)).projectId;
    const metadata = (providerId: 'codex' | 'opencode-go', modelId: string): ModelProviderAdapter => ({
      providerId, family: providerId === 'codex' ? 'openai' : 'opencode', displayName: providerId,
      probe: async () => ({
        availability: 'available', auth: 'authenticated', version: 'test',
        capabilities: ['implementation'],
      }),
      discoverModels: async () => ({ status: 'known', models: [{ modelId, capabilities: ['implementation'] }] }),
    });
    const primaryRequests: AgentExecutionRequest[] = [];
    const primaryExecution: AgentExecutionAdapter = {
      provider: 'codex', capabilities: ['execute'],
      probe: () => ({ available: true, version: 'test' }),
      execute: async (request) => {
        primaryRequests.push(request);
        if (outcome === 'identity-omitted') {
          return {
            outcome: 'NEEDS_HUMAN', timedOut: false, cancelled: false,
            processGroupStopped: true, stdout: '', stderr: '',
            stdoutTruncated: false, stderrTruncated: false,
            failureCategory: 'adapter_error',
            failureReason: 'adapter returned no process identity',
          };
        }
        if (request.onProcessStarted !== undefined) await request.onProcessStarted(7331);
        if (outcome === 'ambiguous') {
          throw new Error('provider bookkeeping channel was lost after spawn');
        }
        return {
          outcome: 'FAILED', providerProcessId: 7331, exitCode: 1,
          timedOut: false, cancelled: false, processGroupStopped: true,
          stdout: '', stderr: 'implementation failed',
          stdoutTruncated: false, stderrTruncated: false,
          failureCategory: 'non_zero_exit', failureReason: 'implementation failed',
        };
      },
    };
    registerModelProviderAdapter(primaryExecution, 'codex');
    const fallbackExecution = fakeAdapter();
    const modelService = new ModelRoutingService({
      db: harness.db, projectId,
      adapters: [metadata('codex', 'codex/primary'), metadata('opencode-go', 'opencode/fallback')],
      executionAdapters: [
        { modelProviderId: 'codex', adapter: primaryExecution },
        { modelProviderId: 'opencode-go', adapter: fallbackExecution },
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
      { ticketId: 'AG-001', instructions: 'do not retry after process launch' }
    );

    expect(result.decision.providerId).toBe('codex');
    expect(result.run.status).toBe(outcome === 'failed' ? 'FAILED' : 'NEEDS_HUMAN');
    expect(result.run.failureCategory).toBe(outcome === 'failed' ? 'non_zero_exit' : 'adapter_error');
    expect(result.run.startedAt).toBeDefined();
    expect(primaryRequests).toHaveLength(1);
    expect(fallbackExecution.requests).toHaveLength(0);
    expect(createRunRepository(harness.db).findByTicketId('AG-001')).toHaveLength(1);
    expect(modelService.listHealth().find((health) => health.providerId === 'codex')?.activeRuns)
      .toBe(outcome === 'ambiguous' ? 1 : 0);
  });

  it('persists a durable safety outcome when maxAttempts is zero', async () => {
    harness = await createHarness();
    const projectId = (await inspectAgentProjectId(harness)).projectId;
    const provider = (providerId: 'codex' | 'opencode-go', modelId: string): ModelProviderAdapter => ({
      providerId,
      family: providerId === 'codex' ? 'openai' : 'opencode',
      displayName: providerId,
      probe: async () => ({
        availability: 'available', auth: 'authenticated', version: 'test',
        capabilities: ['implementation'],
      }),
      discoverModels: async () => ({
        status: 'known',
        models: [{ modelId, capabilities: ['implementation'] }],
      }),
    });
    let primaryProbeCount = 0;
    const primaryExecution: AgentExecutionAdapter = {
      provider: 'codex', capabilities: ['execute'],
      probe: () => (++primaryProbeCount === 1
        ? { available: true, version: 'test' }
        : { available: false, reason: 'selected provider became unavailable' }),
      execute: async () => { throw new Error('exhausted safety gate must prevent launch'); },
    };
    registerModelProviderAdapter(primaryExecution, 'codex');
    const fallbackExecution = fakeAdapter();
    const modelService = new ModelRoutingService({
      db: harness.db,
      projectId,
      adapters: [provider('codex', 'codex/attempt-zero'), provider('opencode-go', 'opencode/fallback')],
      executionAdapters: [
        { modelProviderId: 'codex', adapter: primaryExecution },
        { modelProviderId: 'opencode-go', adapter: fallbackExecution },
      ],
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
      { ticketId: 'AG-001', instructions: 'do not launch with an exhausted attempt budget', safety: { maxAttempts: 0 } }
    );

    expect(result.run.status).toBe('NEEDS_HUMAN');
    expect(result.run.failureCategory).toBe('safety_limit');
    expect(result.run.failureReason).toMatch(/attempt budget exhausted/);
    expect(createRunRepository(harness.db).findById(result.run.id)?.status).toBe('NEEDS_HUMAN');
    expect(primaryProbeCount).toBe(1);
    expect(fallbackExecution.requests).toHaveLength(0);
    expect(createRunRepository(harness.db).findByTicketId('AG-001')).toHaveLength(1);
  });

  it('preserves approval refusal ahead of provider unavailability and fallback', async () => {
    harness = await createHarness();
    const projectId = (await inspectAgentProjectId(harness)).projectId;
    const provider = (providerId: 'codex' | 'opencode-go', modelId: string): ModelProviderAdapter => ({
      providerId,
      family: providerId === 'codex' ? 'openai' : 'opencode',
      displayName: providerId,
      probe: async () => ({
        availability: 'available', auth: 'authenticated', version: 'test',
        capabilities: ['implementation'],
      }),
      discoverModels: async () => ({
        status: 'known', models: [{ modelId, capabilities: ['implementation'] }],
      }),
    });
    let primaryProbeCount = 0;
    const primaryExecution: AgentExecutionAdapter = {
      provider: 'codex', capabilities: ['execute'],
      probe: () => (++primaryProbeCount === 1
        ? { available: true, version: 'test' }
        : { available: false, reason: 'selected provider became unavailable' }),
      execute: async () => { throw new Error('approval gate must prevent launch'); },
    };
    registerModelProviderAdapter(primaryExecution, 'codex');
    const fallbackExecution = fakeAdapter();
    const modelService = new ModelRoutingService({
      db: harness.db,
      projectId,
      adapters: [provider('codex', 'codex/approval'), provider('opencode-go', 'opencode/fallback')],
      executionAdapters: [
        { modelProviderId: 'codex', adapter: primaryExecution },
        { modelProviderId: 'opencode-go', adapter: fallbackExecution },
      ],
    });

    const result = await modelService.executeRoutedAgentTask(
      { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      {
        task: 'implementation', risk: 'high',
        envelope: {
          mode: 'balanced', maxConcurrentTickets: 1,
          activeConcurrentTickets: 0, budgetRemaining: 'unknown',
        },
      },
      { ticketId: 'AG-001', instructions: 'require approval before provider launch' }
    );

    expect(result.run.status).toBe('NEEDS_HUMAN');
    expect(result.run.failureCategory).toBe('approval_required');
    expect(result.run.failureReason).toMatch(/explicit human approval/);
    expect(primaryProbeCount).toBe(1);
    expect(fallbackExecution.requests).toHaveLength(0);
    expect(createRunRepository(harness.db).findByTicketId('AG-001')).toHaveLength(1);
  });

  it('persists a durable safety outcome when the final route reservation fails', async () => {
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
        models: [{ modelId: 'opencode/reservation-failure', capabilities: ['implementation'] }],
      }),
    };
    const modelService = new ModelRoutingService({
      db: harness.db,
      projectId,
      adapters: [providerAdapter],
      executionAdapters: [{ modelProviderId: 'opencode-go', adapter: harness.options.adapter }],
    });
    let runId: string | undefined;
    const createRunId = () => {
      runId = 'final-reservation-failure-run';
      harness?.db.prepare(
        'UPDATE provider_health SET active_runs = ? WHERE project_id = ? AND provider_id = ?'
      ).run(1_000_000, projectId, 'opencode-go');
      return runId;
    };

    const result = await modelService.executeRoutedAgentTask(
      { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot, createRunId },
      {
        task: 'implementation',
        risk: 'medium',
        envelope: {
          mode: 'balanced', maxConcurrentTickets: 1,
          activeConcurrentTickets: 0, budgetRemaining: 'unknown',
        },
      },
      { ticketId: 'AG-001', instructions: 'audit the final reservation failure' }
    );

    expect(result.run.id).toBe(runId);
    expect(result.run.status).toBe('NEEDS_HUMAN');
    expect(result.run.failureCategory).toBe('safety_limit');
    expect(result.run.failureReason).toMatch(/safety limit is exhausted/);
    expect((harness.options.adapter as FakeAdapter).requests).toHaveLength(0);
  });

  it('persists a safety-limit outcome when no registered fallback is usable', async () => {
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
        models: [{ modelId: 'opencode/no-fallback', capabilities: ['implementation'] }],
      }),
    };
    const unavailableFallback: ModelProviderAdapter = {
      providerId: 'codex',
      family: 'openai',
      displayName: 'Codex',
      probe: async () => ({
        availability: 'unavailable', auth: 'unknown', version: 'test',
        capabilities: [], reason: 'test fallback unavailable',
      }),
      discoverModels: async () => ({ status: 'unknown', reason: 'provider unavailable' }),
    };
    const modelService = new ModelRoutingService({
      db: harness.db,
      projectId,
      adapters: [providerAdapter, unavailableFallback],
      executionAdapters: [{ modelProviderId: 'opencode-go', adapter: harness.options.adapter }],
    });
    const createRunId = () => {
      harness?.db.prepare(
        'UPDATE provider_health SET active_runs = ? WHERE project_id = ? AND provider_id = ?'
      ).run(1_000_000, projectId, 'opencode-go');
      return 'no-usable-fallback-run';
    };

    const result = await modelService.executeRoutedAgentTask(
      { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot, createRunId },
      {
        task: 'implementation',
        risk: 'medium',
        envelope: {
          mode: 'balanced', maxConcurrentTickets: 1,
          activeConcurrentTickets: 0, budgetRemaining: 'unknown',
        },
      },
      { ticketId: 'AG-001', instructions: 'record no-fallback reservation exhaustion' }
    );

    expect(result.run.status).toBe('NEEDS_HUMAN');
    expect(result.run.failureCategory).toBe('safety_limit');
    expect(result.run.failureReason).toMatch(/No fallback provider could be reserved/);
    expect((harness.options.adapter as FakeAdapter).requests).toHaveLength(0);
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
