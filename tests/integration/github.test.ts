import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { initProject } from '../../src/cli/init.js';
import { syncBacklogProject } from '../../src/cli/backlog.js';
import { createWorkspace } from '../../src/workspace/service.js';
import { createGitRunner, type GitCommandResult, type GitRunner } from '../../src/git/service.js';
import { TicketState } from '../../src/core/state-machine/state.js';
import { persistTicketTransition } from '../../src/persistence/ticket-state-store.js';
import { createDatabase, migrate, type DbConnection } from '../../src/persistence/db.js';
import { createModelRepository } from '../../src/persistence/model-repositories.js';
import {
  createEventRepository,
  createRunRepository,
  createTicketRepository,
  type WorkspaceRecord,
} from '../../src/persistence/repositories.js';
import { EventType } from '../../src/events/event.js';
import type { GitHostAdapter, GitHostComment, GitHostPullRequest } from '../../src/adapters/git-host/adapter.js';
import { createGitHubPullRequest } from '../../src/github/service.js';
import { deriveTicketContractProvenance } from '../../src/domain/ticket.js';
import { runPrePrReadiness } from '../../src/readiness/service.js';

const SHA = 'a'.repeat(40);
const CONFIG = {
  version: 1 as const,
  project: { name: 'github-001', repository: 'owner/github-001', defaultBranch: 'main' },
  execution: { maxConcurrentTickets: 1, maxRepairIterations: 0 },
  release: { requireHumanApproval: true, requireCleanCI: true, requireExactShaReviews: true },
  agents: { implementer: 'opencode' as const, reviewers: ['correctness'] as const },
};

type Harness = {
  projectDir: string;
  worktreeRoot: string;
  workspace: WorkspaceRecord;
  db: DbConnection;
  gitRunner: GitRunner;
  host: FakeGitHub;
  remote: { sha?: string; pushUrls?: readonly string[] };
};

class FakeGitHub implements GitHostAdapter {
  readonly type = 'github' as const;
  readonly calls: string[] = [];
  readonly comments: GitHostComment[] = [];
  pullRequest: GitHostPullRequest | undefined;
  headSha = SHA;
  failAfterPosting = false;

  probe() {
    this.calls.push('probe');
    return { available: true as const, authenticated: true as const };
  }

  findPullRequests() {
    this.calls.push('find');
    return Promise.resolve(this.pullRequest === undefined ? [] : [this.pullRequest]);
  }

  createPullRequest(input: { repository: string; baseBranch: string; headBranch: string; title: string; body: string }) {
    this.calls.push('create');
    this.pullRequest = {
      number: 8,
      url: 'https://github.com/owner/github-001/pull/8',
      repository: input.repository,
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      headSha: this.headSha,
      state: 'OPEN',
    };
    return Promise.resolve(this.pullRequest);
  }

  inspectPullRequest() {
    this.calls.push('inspect');
    if (this.pullRequest === undefined) return Promise.reject(new Error('missing PR'));
    return Promise.resolve(this.pullRequest);
  }

  listComments() {
    this.calls.push('list-comments');
    return Promise.resolve([...this.comments]);
  }

  postComment(input: { repository: string; number: number; body: string }) {
    this.calls.push('post-comment');
    const comment = { id: 'comment-1', url: 'https://github.com/owner/github-001/issues/8#issuecomment-1', body: input.body };
    this.comments.push(comment);
    if (this.failAfterPosting) return Promise.reject(new Error('simulated lost response'));
    return Promise.resolve(comment);
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeGitRunner(
  projectDir: string,
  branch: string,
  remote: { sha?: string; pushUrls?: readonly string[] }
): GitRunner {
  const real = createGitRunner();
  return async (cwd, args): Promise<GitCommandResult> => {
    if (cwd === projectDir && args[0] === 'remote' && args[1] === 'get-url') {
      const urls = args.includes('--push')
        ? (remote.pushUrls ?? ['git@github.com:owner/github-001.git'])
        : ['git@github.com:owner/github-001.git'];
      return { exitCode: 0, stdout: `${urls.join('\n')}\n`, stderr: '' };
    }
    if (cwd === projectDir && args[0] === 'ls-remote') {
      return {
        exitCode: 0,
        stdout: remote.sha === undefined ? '' : `${remote.sha}\trefs/heads/${branch}\n`,
        stderr: '',
      };
    }
    if (cwd === projectDir && args[0] === 'push') {
      remote.sha = args[2]?.split(':', 1)[0];
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return real(cwd, args);
  };
}

async function createHarness(maxRepairIterations = CONFIG.execution.maxRepairIterations): Promise<Harness> {
  const projectDir = mkdtempSync(join(tmpdir(), 'shipgraph-github-src-'));
  git(projectDir, 'init', '-b', 'main');
  git(projectDir, 'config', 'user.email', 'shipgraph-github@example.com');
  git(projectDir, 'config', 'user.name', 'ShipGraph GitHub Test');
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/github-001.git'], { cwd: projectDir });
  writeFileSync(join(projectDir, 'README.md'), '# source\n');
  git(projectDir, 'add', 'README.md');
  git(projectDir, 'commit', '-m', 'initial');
  initProject(projectDir, {
    config: {
      ...CONFIG,
      execution: { ...CONFIG.execution, maxRepairIterations },
    },
  });
  const backlogPath = join(projectDir, 'shipgraph.backlog.yml');
  writeFileSync(backlogPath, stringify({
    version: 1,
    tickets: [{
      id: 'GH-001',
      title: 'Open the pull request',
      description: 'Create one pull request after readiness.',
      priority: 'high',
      dependsOn: [],
      scope: { allowedPaths: ['README.md'], forbiddenPaths: [] },
      acceptanceCriteria: [{ id: 'AC-1', description: 'A pull request is opened.' }],
      verification: { commands: ['pnpm test'] },
      risk: 'medium',
      agent: {},
      release: {},
    }],
  }));
  syncBacklogProject(projectDir);
  const db = createDatabase(join(projectDir, '.shipgraph', 'shipgraph.db'));
  migrate(db);
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'shipgraph-github-root-'));
  const created = await createWorkspace({ db, projectDir, worktreeRoot }, 'GH-001');
  const workspace = created.workspace;
  const projectId = workspace.projectId;
  persistTicketTransition(db, { ticketId: 'GH-001', projectId, next: TicketState.IMPLEMENTING });
  persistTicketTransition(db, { ticketId: 'GH-001', projectId, next: TicketState.VERIFYING });
  writeFileSync(join(workspace.worktreePath, 'README.md'), '# changed\n');
  git(workspace.worktreePath, 'add', 'README.md');
  git(workspace.worktreePath, 'commit', '-m', 'implementation change');
  const head = git(workspace.worktreePath, 'rev-parse', 'HEAD');
  const runRepository = createRunRepository(db);
  const eventRepository = createEventRepository(db);
  const policySha = '1'.repeat(64);
  const now = new Date().toISOString();
  addRun(runRepository, eventRepository, workspace, 'implementation', head, policySha, undefined, now);
  const ticket = createTicketRepository(db).findById('GH-001');
  if (ticket === undefined) throw new Error('test ticket missing');
  const contractDigest = deriveTicketContractProvenance(
    ticket,
    backlogPath,
    '1'
  );
  addRun(runRepository, eventRepository, workspace, 'review', head, policySha, 'contract', now, contractDigest);
  addRun(runRepository, eventRepository, workspace, 'review', head, policySha, 'engineering', now, contractDigest);
  eventRepository.append({
    id: randomUUID(),
    timestamp: now,
    projectId,
    ticketId: 'GH-001',
    type: EventType.REPAIR_ATTEMPT_RECORDED,
    payload: {
      ticketId: 'GH-001',
      attempt: 0,
      candidateSha: head,
      blockers: [],
      targetedVerification: [],
      finalVerification: [{ command: 'pnpm test', sha: head, exitCode: 0, stdout: '', stderr: '' }],
      reviews: { reviewedSha: head, contract: 'PASS', engineering: 'PASS' },
      redCapableEvidence: [],
      outcome: 'PASSED',
    },
  });
  const readiness = await runPrePrReadiness({
    ticketId: 'GH-001',
    workspace: { db, projectDir, worktreeRoot },
  });
  if (readiness.result !== 'PASS') throw new Error(`test readiness failed: ${readiness.reason}`);
  const host = new FakeGitHub();
  host.headSha = head;
  const remote = {};
  const gitRunner = makeGitRunner(projectDir, workspace.branchName, remote);
  return { projectDir, worktreeRoot, workspace, db, gitRunner, host, remote };
}

function addRun(
  runs: ReturnType<typeof createRunRepository>,
  events: ReturnType<typeof createEventRepository>,
  workspace: WorkspaceRecord,
  task: 'implementation' | 'review' | 'repair',
  head: string,
  policySha: string,
  reviewType: 'contract' | 'engineering' | undefined,
  timestamp: string,
  provenance?: { contractDigest: string; contractSource: string; contractRevision: string },
  idSuffix = 'main',
  modelId = 'opencode/model',
): string {
  const id = `${task}-${reviewType ?? idSuffix}`;
  runs.create({
    id,
    ticketId: workspace.ticketId,
    projectId: workspace.projectId,
    workspaceId: workspace.id,
    workspacePath: workspace.worktreePath,
    baseSha: workspace.baseSha,
    branchName: workspace.branchName,
    status: 'SUCCEEDED',
    provider: 'opencode',
    modelProviderId: 'opencode-go',
    task,
    model: modelId,
    createdAt: timestamp,
    startedAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
    instructionsSha256: '2'.repeat(64),
    safetyPolicySha256: policySha,
    ...(reviewType === undefined ? {} : {
      reviewType,
      reviewedSha: head,
      reviewContractDigest: provenance?.contractDigest,
      reviewContractSource: provenance?.contractSource,
      reviewContractRevision: provenance?.contractRevision,
      reviewResult: 'PASS' as const,
      reviewFindings: [],
    }),
    timeoutMs: 1_000,
  });
  events.append({
    id: randomUUID(),
    timestamp,
    projectId: workspace.projectId,
    ticketId: workspace.ticketId,
    runId: id,
    type: EventType.RUN_CREATED,
    payload: {
      runId: id,
      ticketId: workspace.ticketId,
      baseSha: workspace.baseSha,
      workspaceId: workspace.id,
      workspacePath: workspace.worktreePath,
      branchName: workspace.branchName,
      provider: 'opencode',
      modelProviderId: 'opencode-go',
      task,
      model: modelId,
      createdAt: timestamp,
      timeoutMs: 1_000,
      instructionsSha256: '2'.repeat(64),
      safetyPolicySha256: policySha,
      ...(reviewType === undefined ? {} : {
        reviewType,
        reviewedSha: head,
        reviewContractDigest: provenance?.contractDigest,
        reviewContractSource: provenance?.contractSource,
        reviewContractRevision: provenance?.contractRevision,
      }),
    },
  });
  return id;
}

function addReceiptRuns(
  harness: Harness,
  count: number,
  modelForIndex: (index: number) => string = () => 'opencode/model',
  order: readonly number[] = Array.from({ length: count }, (_, index) => index)
): void {
  const runs = createRunRepository(harness.db);
  const events = createEventRepository(harness.db);
  const timestamp = new Date().toISOString();
  for (const index of order) {
    addRun(
      runs,
      events,
      harness.workspace,
      'repair',
      harness.host.headSha,
      '1'.repeat(64),
      undefined,
      timestamp,
      undefined,
      `receipt-${index}`,
      modelForIndex(index)
    );
  }
}

function cleanup(harness: Harness | undefined): void {
  if (harness === undefined) return;
  harness.db.close();
  rmSync(harness.projectDir, { recursive: true, force: true });
  rmSync(harness.worktreeRoot, { recursive: true, force: true });
}

describe('KAR-8 GitHub handoff', () => {
  let harness: Harness | undefined;

  afterEach(() => cleanup(harness));

  it('requires readiness, publishes the exact branch, records one PR and usage receipt, then stops at PR_OPEN', async () => {
    harness = await createHarness();
    const result = await createGitHubPullRequest({
      ticketId: 'GH-001',
      gitHost: harness.host,
      workspace: {
        db: harness.db,
        projectDir: harness.projectDir,
        worktreeRoot: harness.worktreeRoot,
        gitRunner: harness.gitRunner,
      },
    });
    expect(result.pullRequest).toMatchObject({ number: 8, state: 'OPEN', headSha: result.readiness.readySha });
    expect(createTicketRepository(harness.db).findById('GH-001')?.status).toBe(TicketState.PR_OPEN);
    expect(harness.host.calls).toEqual(['probe', 'find', 'create', 'inspect', 'list-comments', 'post-comment']);
    const events = createEventRepository(harness.db).findByTicketId('GH-001');
    expect(events.filter((event) => event.type === EventType.GITHUB_PR_RECORDED)).toHaveLength(1);
    expect(events.filter((event) => event.type === EventType.GITHUB_USAGE_RECEIPT_RECORDED)).toHaveLength(1);
    expect(harness.host.comments[0]?.body).toContain('"knownTotal":"unknown"');
  });

  it('recovers a lost receipt response without creating a duplicate PR or comment', async () => {
    harness = await createHarness();
    harness.host.failAfterPosting = true;
    await expect(createGitHubPullRequest({
      ticketId: 'GH-001',
      gitHost: harness.host,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot, gitRunner: harness.gitRunner },
    })).rejects.toThrow(/lost response/);
    harness.host.failAfterPosting = false;
    const recovered = await createGitHubPullRequest({
      ticketId: 'GH-001',
      gitHost: harness.host,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot, gitRunner: harness.gitRunner },
    });
    expect(recovered.pullRequest.number).toBe(8);
    expect(harness.host.calls.filter((call) => call === 'create')).toHaveLength(1);
    expect(harness.host.calls.filter((call) => call === 'post-comment')).toHaveLength(1);
    expect(createEventRepository(harness.db).findByTicketId('GH-001').filter((event) => event.type === EventType.GITHUB_USAGE_RECEIPT_RECORDED)).toHaveLength(1);
  }, 20_000);

  it('reuses the durable PR and receipt after a completed PR_OPEN handoff is retried', async () => {
    harness = await createHarness();
    const input = {
      ticketId: 'GH-001',
      gitHost: harness.host,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot, gitRunner: harness.gitRunner },
    } as const;
    await createGitHubPullRequest(input);
    const firstReceipt = harness.host.comments[0]?.body;
    await createGitHubPullRequest(input);
    expect(harness.host.calls.filter((call) => call === 'create')).toHaveLength(1);
    expect(harness.host.calls.filter((call) => call === 'post-comment')).toHaveLength(1);
    expect(harness.host.calls.filter((call) => call === 'list-comments')).toHaveLength(2);
    expect(harness.host.comments[0]?.body).toBe(firstReceipt);
    expect(createEventRepository(harness.db).findByTicketId('GH-001').filter((event) => event.type === EventType.GITHUB_PR_RECORDED)).toHaveLength(1);
  }, 20_000);

  it('builds a compact receipt with more than 32 durable repair runs', async () => {
    harness = await createHarness(100);
    addReceiptRuns(harness, 33);
    const result = await createGitHubPullRequest({
      ticketId: 'GH-001',
      gitHost: harness.host,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot, gitRunner: harness.gitRunner },
    });
    expect(result.receipt.repair).toEqual([{ providerId: 'opencode-go', modelId: 'opencode/model' }]);
    expect(result.receipt.usage.runCount).toBe(36);
  }, 20_000);

  it('builds a compact receipt with more than 64 relevant durable runs', async () => {
    harness = await createHarness(100);
    addReceiptRuns(harness, 70);
    const result = await createGitHubPullRequest({
      ticketId: 'GH-001',
      gitHost: harness.host,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot, gitRunner: harness.gitRunner },
    });
    expect(result.receipt.usage.runCount).toBe(73);
    expect(result.receipt.usage.unknownRunCount).toBe(73);
  }, 20_000);

  it('keeps measured usage and unknown telemetry truthful in the compact receipt', async () => {
    harness = await createHarness(100);
    const runId = addRun(
      createRunRepository(harness.db),
      createEventRepository(harness.db),
      harness.workspace,
      'repair',
      harness.host.headSha,
      '1'.repeat(64),
      undefined,
      new Date().toISOString(),
      undefined,
      'measured'
    );
    createModelRepository(harness.db).appendUsage({
      id: 'usage-measured',
      projectId: harness.workspace.projectId,
      runId,
      providerId: 'opencode-go',
      modelId: 'opencode/model',
      task: 'repair',
      retryCount: 0,
      elapsedMs: 1,
      outcome: 'succeeded',
      outcomeQuality: 'good',
      inputTokens: 11,
      outputTokens: 7,
      cost: 0.5,
      quotaRemaining: 'unknown',
      recordedAt: new Date().toISOString(),
    });
    const result = await createGitHubPullRequest({
      ticketId: 'GH-001',
      gitHost: harness.host,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot, gitRunner: harness.gitRunner },
    });
    expect(result.receipt.usage.measuredRunCount).toBe(1);
    expect(result.receipt.usage.unknownRunCount).toBe(3);
    expect(result.receipt.usage.inputTokens).toEqual({ knownTotal: 11, unknownRuns: 3 });
    expect(result.receipt.usage.outputTokens).toEqual({ knownTotal: 7, unknownRuns: 3 });
    expect(result.receipt.usage.cost).toEqual({ knownTotal: 0.5, unknownRuns: 3 });
  }, 20_000);

  it('bounds a maximally varied provider/model history below the GitHub comment limit', async () => {
    harness = await createHarness(100);
    addReceiptRuns(harness, 400, (index) => `model-${'x'.repeat(240)}-${index}`);
    const result = await createGitHubPullRequest({
      ticketId: 'GH-001',
      gitHost: harness.host,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot, gitRunner: harness.gitRunner },
    });
    expect(Array.isArray(result.receipt.repair)).toBe(false);
    if (Array.isArray(result.receipt.repair)) throw new Error('expected a bounded repair summary');
    expect(result.receipt.repair.distinctCount).toBe(400);
    expect(result.receipt.repair.omittedCount).toBeGreaterThan(0);
    expect(result.receipt.repair.identities.length).toBeLessThan(400);
    const completeIdentities = Array.from({ length: 400 }, (_, index) => ({
      providerId: 'opencode-go',
      modelId: `model-${'x'.repeat(240)}-${index}`,
    })).sort((left, right) => left.modelId < right.modelId ? -1 : left.modelId > right.modelId ? 1 : 0);
    const completeDigest = createHash('sha256').update(JSON.stringify(completeIdentities)).digest('hex');
    expect(result.receipt.repair.identitiesDigest).toBe(completeDigest);
    expect(harness.host.comments[0]?.body.length ?? Infinity).toBeLessThan(60_000);
  }, 20_000);

  it('keeps the receipt marker deterministic when durable rows are reordered', async () => {
    harness = await createHarness(100);
    addReceiptRuns(harness, 70, (index) => `model-${index}`);
    await createGitHubPullRequest({
      ticketId: 'GH-001',
      gitHost: harness.host,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot, gitRunner: harness.gitRunner },
    });
    const firstBody = harness.host.comments[0]?.body;
    const runs = createRunRepository(harness.db).findByTicketId('GH-001')
      .filter((run) => run.task === 'repair')
      .sort((left, right) => left.id.localeCompare(right.id));
    const runRepository = createRunRepository(harness.db);
    runs.forEach((run, index) => {
      const updatedAt = new Date(Date.UTC(2000, 0, 1, 0, 0, index)).toISOString();
      const startedAt = new Date(Date.UTC(2000, 0, 1, 0, 1, runs.length - index)).toISOString();
      runRepository.updateStatus(
        run.id,
        run.status,
        updatedAt,
        { startedAt }
      );
    });
    await createGitHubPullRequest({
      ticketId: 'GH-001',
      gitHost: harness.host,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot, gitRunner: harness.gitRunner },
    });
    expect(harness.host.comments[0]?.body).toBe(firstBody);
  }, 20_000);

  it('fails closed before GitHub writes when readiness is unavailable', async () => {
    harness = await createHarness();
    persistTicketTransition(harness.db, { ticketId: 'GH-001', projectId: harness.workspace.projectId, next: TicketState.NEEDS_HUMAN });
    await expect(createGitHubPullRequest({
      ticketId: 'GH-001',
      gitHost: harness.host,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot, gitRunner: harness.gitRunner },
    })).rejects.toThrow(/Readiness|NEEDS_HUMAN/);
    expect(harness.host.calls).toEqual([]);
    expect(harness.host.pullRequest).toBeUndefined();
  });

  it('fails closed when the authorized remote branch already points at another SHA', async () => {
    harness = await createHarness();
    harness.remote.sha = 'b'.repeat(40);
    await expect(createGitHubPullRequest({
      ticketId: 'GH-001',
      gitHost: harness.host,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot, gitRunner: harness.gitRunner },
    })).rejects.toThrow(/remote branch .* not/);
    expect(harness.host.calls).toEqual(['probe']);
    expect(harness.host.pullRequest).toBeUndefined();
  });

  it('does not replace a closed PR for the same authorized branch', async () => {
    harness = await createHarness();
    harness.host.pullRequest = {
      number: 8,
      url: 'https://github.com/owner/github-001/pull/8',
      repository: 'owner/github-001',
      baseBranch: 'main',
      headBranch: harness.workspace.branchName,
      headSha: harness.host.headSha,
      state: 'CLOSED',
    };
    await expect(createGitHubPullRequest({
      ticketId: 'GH-001',
      gitHost: harness.host,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot, gitRunner: harness.gitRunner },
    })).rejects.toThrow(/CLOSED/);
    expect(harness.host.calls).toEqual(['probe', 'find']);
    expect(harness.host.calls).not.toContain('create');
  });

  it('fails closed when the push remote exposes more than one destination', async () => {
    harness = await createHarness();
    harness.remote.pushUrls = [
      'git@github.com:owner/github-001.git',
      'git@github.com:other/not-authorized.git',
    ];
    await expect(createGitHubPullRequest({
      ticketId: 'GH-001',
      gitHost: harness.host,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot, gitRunner: harness.gitRunner },
    })).rejects.toThrow(/fetch|push remote/);
    expect(harness.host.calls).toEqual([]);
  });

  it('fails closed for a non-GitHub transport disguised with a GitHub hostname', async () => {
    harness = await createHarness();
    harness.remote.pushUrls = ['file://github.com/owner/github-001.git'];
    await expect(createGitHubPullRequest({
      ticketId: 'GH-001',
      gitHost: harness.host,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot, gitRunner: harness.gitRunner },
    })).rejects.toThrow(/remotes do not match GitHub/);
    expect(harness.host.calls).toEqual([]);
  });
});
