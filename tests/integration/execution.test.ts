import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { initProject } from '../../src/cli/init.js';
import { syncBacklogProject } from '../../src/cli/backlog.js';
import { TicketState } from '../../src/core/state-machine/state.js';
import { openAndMigrate, type DbConnection } from '../../src/persistence/db.js';
import { createEventRepository, createRunRepository, createTicketRepository } from '../../src/persistence/repositories.js';
import { createGitRunner, type GitCommandResult, type GitRunner } from '../../src/git/service.js';
import type { GitHostAdapter, GitHostComment } from '../../src/adapters/git-host/adapter.js';
import { EventType } from '../../src/events/event.js';
import { executeTicket } from '../../src/execution/ticket.js';
import { ModelRoutingService } from '../../src/model/service.js';
import type { ModelProviderAdapter } from '../../src/adapters/model/adapter.js';
import type { AgentExecutionAdapter, AgentExecutionRequest, AgentExecutionResult } from '../../src/adapters/agent/adapter.js';
import { registerModelProviderAdapter } from '../../src/adapters/agent/registry.js';
import { createWorkspace } from '../../src/workspace/service.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const contract = {
  summary: 'Bounded execution for one supplied issue.',
  currentBehavior: 'Stages can be invoked separately.',
  desiredBehavior: 'One call composes the existing pre-PR stages.',
  acceptanceCriteria: ['The operation binds one contract revision.'],
  outOfScope: ['Scheduler selection', 'Post-PR lifecycle'],
};

describe('KAR-12 single-ticket execution identity', () => {
  let projectDir: string | undefined;
  let worktreeRoot: string | undefined;
  let db: DbConnection | undefined;

  afterEach(() => {
    db?.close();
    if (projectDir !== undefined) rmSync(projectDir, { recursive: true, force: true });
    if (worktreeRoot !== undefined) rmSync(worktreeRoot, { recursive: true, force: true });
    projectDir = undefined;
    worktreeRoot = undefined;
    db = undefined;
  });

  it('uses only the supplied local issue and durably converges a blocked execution', async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'shipgraph-execution-src-'));
    git(projectDir, 'init', '-b', 'main');
    git(projectDir, 'config', 'user.email', 'shipgraph-execution@example.com');
    git(projectDir, 'config', 'user.name', 'ShipGraph Execution Test');
    writeFileSync(join(projectDir, 'README.md'), '# execution\n');
    git(projectDir, 'add', '.');
    git(projectDir, 'commit', '-m', 'initial');
    initProject(projectDir, {
      config: {
        version: 1,
        project: { name: 'execution-001', repository: 'owner/execution-001', defaultBranch: 'main' },
        execution: { maxConcurrentTickets: 1, maxRepairIterations: 1 },
        release: { requireHumanApproval: true, requireCleanCI: true, requireExactShaReviews: true },
        agents: { implementer: 'opencode', reviewers: ['correctness'] },
      },
    });
    writeFileSync(join(projectDir, 'shipgraph.backlog.yml'), stringify({
      version: 1,
      tickets: [{
        id: 'KAR-12',
        title: 'Execution contract',
        description: 'Test execution identity.',
        priority: 'high',
        dependsOn: [],
        scope: { allowedPaths: ['README.md'], forbiddenPaths: [] },
        acceptanceCriteria: [{ id: 'AC-1', description: 'Bound execution.' }],
        verification: { commands: ['true'] },
        risk: 'medium',
        agent: {},
        release: {},
      }],
    }));
    syncBacklogProject(projectDir);
    worktreeRoot = mkdtempSync(join(tmpdir(), 'shipgraph-execution-root-'));
    db = openAndMigrate(join(projectDir, '.shipgraph', 'shipgraph.db'));
    db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run(TicketState.BLOCKED, 'KAR-12');

    const input = {
      issueId: 'KAR-12',
      contract,
      contractSource: 'linear:KAR-12',
      contractRevision: 'v1',
      workspace: { db, projectDir, worktreeRoot },
      modelService: undefined as unknown as ModelRoutingService,
      routing: {
        risk: 'medium' as const,
        envelope: {
          mode: 'balanced' as const,
          maxConcurrentTickets: 1,
          activeConcurrentTickets: 0,
          budgetRemaining: 'unknown' as const,
        },
      },
      createExecutionId: () => 'execution-1',
    };

    const first = await executeTicket(input);
    const second = await executeTicket(input);

    expect(first.outcome).toBe('BLOCKED');
    expect(second).toEqual(first);
    expect(createTicketRepository(db).findById('KAR-12')?.status).toBe(TicketState.BLOCKED);
    const events = createEventRepository(db).findByTicketId('KAR-12');
    expect(events.filter((event) => event.type === EventType.EXECUTION_CONTRACT_BOUND)).toHaveLength(1);
    expect(events.filter((event) => event.type === EventType.EXECUTION_TERMINAL)).toHaveLength(1);
    expect(events.filter((event) => event.type === EventType.RUN_CREATED)).toHaveLength(0);

    db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run(TicketState.ELIGIBLE, 'KAR-12');
    await expect(
      createWorkspace(input.workspace, 'KAR-12', { crashAfterReserve: true })
    ).rejects.toThrow(/Simulated crash/);
    const revised = await executeTicket({
      ...input,
      contract: { ...contract, desiredBehavior: 'A revised bounded entry point.' },
      contractRevision: 'v2',
      createExecutionId: () => 'execution-2',
    });
    expect(revised.outcome).toBe('NEEDS_HUMAN');
    const revisedEvents = createEventRepository(db).findByTicketId('KAR-12');
    expect(revisedEvents.filter((event) => event.type === EventType.EXECUTION_CONTRACT_BOUND)).toHaveLength(2);
    expect(revisedEvents.filter((event) => event.type === EventType.EXECUTION_TERMINAL)).toHaveLength(2);
    const boundContracts = revisedEvents
      .filter((event) => event.type === EventType.EXECUTION_CONTRACT_BOUND)
      .map((event) => event.payload.contract.desiredBehavior);
    expect(boundContracts).toEqual([contract.desiredBehavior, 'A revised bounded entry point.']);
  });

  it('composes the existing implementation, review, readiness, and GitHub stages to PR_RAISED', async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'shipgraph-execution-success-src-'));
    git(projectDir, 'init', '-b', 'main');
    git(projectDir, 'config', 'user.email', 'shipgraph-execution@example.com');
    git(projectDir, 'config', 'user.name', 'ShipGraph Execution Test');
    git(projectDir, 'remote', 'add', 'origin', 'git@github.com:owner/execution-001.git');
    writeFileSync(join(projectDir, 'README.md'), '# execution\n');
    git(projectDir, 'add', '.');
    git(projectDir, 'commit', '-m', 'initial');
    initProject(projectDir, {
      config: {
        version: 1,
        project: { name: 'execution-001', repository: 'owner/execution-001', defaultBranch: 'main' },
        execution: { maxConcurrentTickets: 1, maxRepairIterations: 1 },
        release: { requireHumanApproval: true, requireCleanCI: true, requireExactShaReviews: true },
        agents: { implementer: 'opencode', reviewers: ['correctness'] },
      },
    });
    writeFileSync(join(projectDir, 'shipgraph.backlog.yml'), stringify({
      version: 1,
      tickets: [{
        id: 'KAR-12',
        title: 'Execution contract',
        description: 'Test the composed execution.',
        priority: 'high',
        dependsOn: [],
        scope: { allowedPaths: ['README.md'], forbiddenPaths: [] },
        acceptanceCriteria: [{ id: 'AC-1', description: 'Raise one pull request.' }],
        verification: { commands: ['true'] },
        risk: 'medium',
        agent: {},
        release: {},
      }],
    }));
    syncBacklogProject(projectDir);
    worktreeRoot = mkdtempSync(join(tmpdir(), 'shipgraph-execution-success-root-'));
    db = openAndMigrate(join(projectDir, '.shipgraph', 'shipgraph.db'));
    const projectId = createTicketRepository(db).findById('KAR-12')?.projectId;
    if (projectId === undefined) throw new Error('test ticket missing');

    const reports: AgentExecutionRequest[] = [];
    const executionAdapter: AgentExecutionAdapter = {
      provider: 'opencode',
      capabilities: ['execute', 'review', 'repair'],
      supportsTokenLimit: true,
      supportsCostLimit: true,
      reportsUsage: true,
      probe: () => ({ available: true as const, version: 'test-agent' }),
      execute: async (request): Promise<AgentExecutionResult> => {
        reports.push(request);
        return {
          outcome: 'SUCCEEDED',
          exitCode: 0,
          timedOut: false,
          cancelled: false,
          processGroupStopped: true,
          stdout: request.reviewType === undefined
            ? 'implementation complete'
            : JSON.stringify({ result: 'PASS', findings: [] }),
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
        };
      },
    };
    registerModelProviderAdapter(executionAdapter, 'opencode-go');
    const providerAdapter: ModelProviderAdapter = {
      providerId: 'opencode-go',
      family: 'opencode',
      displayName: 'OpenCode Go',
      probe: async () => ({
        availability: 'available',
        auth: 'authenticated',
        version: 'test-provider',
        capabilities: ['implementation', 'review', 'repair'],
      }),
      discoverModels: async () => ({
        status: 'known',
        models: [{ modelId: 'opencode/test', capabilities: ['implementation', 'review', 'repair'] }],
      }),
    };
    const modelService = new ModelRoutingService({
      db,
      projectId,
      adapters: [providerAdapter],
      executionAdapters: [{ modelProviderId: 'opencode-go', adapter: executionAdapter }],
    });

    const remote: { sha?: string } = {};
    const realRunner = createGitRunner();
    const gitRunner: GitRunner = async (cwd, args): Promise<GitCommandResult> => {
      if (cwd === projectDir && args[0] === 'remote' && args[1] === 'get-url') {
        return { exitCode: 0, stdout: 'git@github.com:owner/execution-001.git\n', stderr: '' };
      }
      if (cwd === projectDir && args[0] === 'ls-remote') {
        return { exitCode: 0, stdout: remote.sha === undefined ? '' : `${remote.sha}\trefs/heads/shipgraph/kar-12\n`, stderr: '' };
      }
      if (cwd === projectDir && args[0] === 'push') {
        remote.sha = args[2]?.split(':', 1)[0];
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return realRunner(cwd, args);
    };
    const host: GitHostAdapter = {
      type: 'github',
      probe: () => ({ available: true as const, authenticated: true as const }),
      findPullRequests: async () => [],
      createPullRequest: async (request) => ({
        number: 12,
        url: 'https://github.com/owner/execution-001/pull/12',
        repository: request.repository,
        baseBranch: request.baseBranch,
        headBranch: request.headBranch,
        headSha: remote.sha ?? '',
        state: 'OPEN',
      }),
      inspectPullRequest: async () => ({
        number: 12,
        url: 'https://github.com/owner/execution-001/pull/12',
        repository: 'owner/execution-001',
        baseBranch: 'main',
        headBranch: 'shipgraph/kar-12',
        headSha: remote.sha ?? '',
        state: 'OPEN',
      }),
      listComments: async (): Promise<readonly GitHostComment[]> => [],
      postComment: async (request) => ({
        id: 'comment-12',
        url: 'https://github.com/owner/execution-001/issues/12#issuecomment-12',
        body: request.body,
      }),
    };

    const result = await executeTicket({
      issueId: 'KAR-12',
      contract,
      contractSource: 'linear:KAR-12',
      contractRevision: 'v1',
      workspace: { db, projectDir, worktreeRoot, gitRunner },
      modelService,
      routing: {
        risk: 'medium',
        envelope: {
          mode: 'balanced',
          maxConcurrentTickets: 1,
          activeConcurrentTickets: 0,
          budgetRemaining: 'unknown',
        },
      },
      executionPolicy: { maxAttempts: 1, maxTimeoutMs: 60_000 },
      timeoutMs: 60_000,
      gitHost: host,
      createExecutionId: () => 'execution-success',
    });

    expect(result.outcome).toBe('PR_RAISED');
    expect(result.github?.pullRequest.number).toBe(12);
    expect(reports.filter((request) => request.reviewType === undefined)).toHaveLength(1);
    expect(reports.filter((request) => request.reviewType !== undefined)).toHaveLength(2);
    expect(createTicketRepository(db).findById('KAR-12')?.status).toBe(TicketState.PR_OPEN);
    expect(result.evidence.contractDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.evidence.submittedHeadSha).toBe(result.github?.readiness.readySha);
    expect(result.evidence.githubPrEvidenceEventId).toBe(result.github?.prEvidenceEventId);
    expect(result.evidence.githubUsageReceiptEvidenceEventId).toBe(result.github?.receiptEvidenceEventId);
    expect(createRunRepository(db).findByTicketId('KAR-12').every((run) =>
      run.executionId === result.evidence.executionId &&
      run.contractDigest === result.evidence.contractDigest &&
      run.contractSource === result.evidence.contractSource &&
      run.contractRevision === result.evidence.contractRevision
    )).toBe(true);
  }, 20_000);
});
