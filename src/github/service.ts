import { randomUUID } from 'node:crypto';
import type {
  GitHostAdapter,
  GitHostComment,
  GitHostPullRequest,
} from '../adapters/git-host/adapter.js';
import { GitHubAdapter } from '../adapters/git-host/github.js';
import { TicketState } from '../core/state-machine/state.js';
import {
  githubUsageReceiptSchema,
  type GitHubPrEvidence,
  type GitHubUsageReceipt,
  type GitHubUsageReceiptEvidence,
} from '../domain/github.js';
import { UNKNOWN, type ModelRoutingMode } from '../domain/model-provider.js';
import { EventType, type ShipgraphEvent } from '../events/event.js';
import {
  createGitRunner,
  inspectWorktreeState,
  isStrictlyClean,
  pushExactCommit,
  resolveCommitSha,
  resolveGitRemoteUrl,
  resolveRemoteBranchSha,
  type GitRunner,
} from '../git/service.js';
import { getCurrentPrePrReadinessEvidence, type CurrentPrePrReadinessEvidence } from '../readiness/service.js';
import { createModelRepository } from '../persistence/model-repositories.js';
import {
  createEventRepository,
  createProjectRepository,
  createRunRepository,
  createTicketRepository,
  type ProjectRecord,
  type RunRecord,
  type WorkspaceRecord,
} from '../persistence/repositories.js';
import { persistTicketTransition } from '../persistence/ticket-state-store.js';
import type { WorkspaceServiceOptions } from '../workspace/service.js';
import { getCurrentProjectId, getVerifiedWorkspaceForExecution } from '../workspace/service.js';

const RECEIPT_MARKER_PATTERN = /<!-- shipgraph-usage-receipt:v1\n([\s\S]*?)\n-->/gu;

export type GitHubPullRequestInput = {
  ticketId: string;
  workspace: WorkspaceServiceOptions;
  gitHost?: GitHostAdapter;
  remote?: string;
};

export type GitHubPullRequestResult = {
  pullRequest: GitHostPullRequest;
  readiness: CurrentPrePrReadinessEvidence;
  prEvidence: GitHubPrEvidence;
  receipt: GitHubUsageReceipt;
  receiptEvidence: GitHubUsageReceiptEvidence;
};

type VerifiedReadiness = CurrentPrePrReadinessEvidence & {
  readySha: string;
  contractDigest: string;
  contractSource: string;
  contractRevision: string;
};

/**
 * KAR-8's complete GitHub handoff. Every external write is preceded by the
 * current readiness and identity checks, and the operation is recoverable by
 * looking up the deterministic branch/receipt instead of creating duplicates.
 */
export async function createGitHubPullRequest(
  input: GitHubPullRequestInput
): Promise<GitHubPullRequestResult> {
  const { workspace } = input;
  const projectId = getCurrentProjectId(workspace);
  const project = createProjectRepository(workspace.db).findById(projectId);
  const ticket = createTicketRepository(workspace.db).findById(input.ticketId);
  if (project === undefined || ticket === undefined || ticket.projectId !== projectId) {
    throw new Error(`KAR-8 fail closed: ticket ${input.ticketId} is not in the current project`);
  }
  if (ticket.status !== TicketState.VERIFYING && ticket.status !== TicketState.PR_OPEN) {
    throw new Error(`KAR-8 fail closed: ticket must be VERIFYING or PR_OPEN, not ${ticket.status}`);
  }

  const verifiedWorkspace = await getVerifiedWorkspaceForExecution(
    workspace,
    input.ticketId,
    'changed'
  );
  const runner = workspace.gitRunner ?? createGitRunner();
  const repository = assertGitHubRepository(project, await resolveGitRemoteUrl(
    runner,
    verifiedWorkspace.sourceRepositoryPath,
    input.remote ?? 'origin'
  ), await resolveGitRemoteUrl(
    runner,
    verifiedWorkspace.sourceRepositoryPath,
    input.remote ?? 'origin',
    true
  ));
  const githubProject = project.repository === repository
    ? project
    : { ...project, repository };
  const adapter = input.gitHost ?? new GitHubAdapter();
  if (adapter.type !== 'github') throw new Error('KAR-8 fail closed: only GitHub is supported by GH-001');
  const probe = await adapter.probe();
  if (probe.available !== true || probe.authenticated !== true) {
    const reason = probe.available === false ? probe.reason : 'not authenticated';
    throw new Error(`KAR-8 fail closed: GitHub authentication is unavailable (${reason})`);
  }

  let readiness = await assertCurrentReadyCandidate(workspace, input.ticketId, verifiedWorkspace, runner);
  // Build the compact local receipt before publishing the branch. Missing or
  // ambiguous execution telemetry must not leave a remote handoff behind.
  buildUsageReceipt(workspace, projectId, input.ticketId, verifiedWorkspace, readiness);
  let remoteSha = await resolveRemoteBranchSha(
    runner,
    verifiedWorkspace.sourceRepositoryPath,
    input.remote ?? 'origin',
    verifiedWorkspace.branchName
  );
  if (remoteSha !== undefined && remoteSha !== readiness.readySha) {
    throw new Error(
      `KAR-8 fail closed: remote branch ${verifiedWorkspace.branchName} points to ${remoteSha}, not ${readiness.readySha}`
    );
  }
  if (remoteSha === undefined) {
    await pushExactCommit(
      runner,
      verifiedWorkspace.sourceRepositoryPath,
      input.remote ?? 'origin',
      readiness.readySha,
      verifiedWorkspace.branchName
    );
    remoteSha = await resolveRemoteBranchSha(
      runner,
      verifiedWorkspace.sourceRepositoryPath,
      input.remote ?? 'origin',
      verifiedWorkspace.branchName
    );
    if (remoteSha !== readiness.readySha) {
      throw new Error('KAR-8 fail closed: pushed branch could not be proved at the readiness SHA');
    }
  }

  // Re-read readiness at the final branch/PR write boundary. This is not a
  // lock; it is the required fail-closed proof immediately before GitHub use.
  readiness = await assertCurrentReadyCandidate(workspace, input.ticketId, verifiedWorkspace, runner);
  if (readiness.readySha !== remoteSha) {
    throw new Error('KAR-8 fail closed: readiness changed after branch publication');
  }
  const receipt = buildUsageReceipt(workspace, projectId, input.ticketId, verifiedWorkspace, readiness);

  const prInput = {
    repository,
    baseBranch: githubProject.defaultBranch,
    headBranch: verifiedWorkspace.branchName,
    title: pullRequestTitle(ticket.id, ticket.title),
    body: pullRequestBody(ticket.id, readiness),
  } as const;
  const pullRequest = await findOrCreatePullRequest(adapter, prInput, readiness.readySha);
  const prEvidenceEvent = persistPrEvidence(
    workspace,
    githubProject,
    input.ticketId,
    pullRequest,
    readiness,
    verifiedWorkspace
  );

  const receiptEvidenceEvent = await ensureUsageReceipt(
    workspace,
    githubProject,
    input.ticketId,
    pullRequest,
    receipt,
    readiness,
    adapter
  );

  const currentTicket = createTicketRepository(workspace.db).findById(input.ticketId);
  if (currentTicket?.status !== TicketState.PR_OPEN) {
    persistTicketTransition(workspace.db, {
      ticketId: input.ticketId,
      projectId,
      next: TicketState.PR_OPEN,
      reason: `KAR-8 GitHub PR ${pullRequest.number} is open at ${readiness.readySha}`,
    });
  }
  return {
    pullRequest,
    readiness,
    prEvidence: prEvidenceEvent.payload,
    receipt,
    receiptEvidence: receiptEvidenceEvent.payload,
  };
}

/** KAR-8 stage spelling used by callers that treat the handoff as an operation. */
export const runGitHubPullRequest = createGitHubPullRequest;

async function assertCurrentReadyCandidate(
  workspace: WorkspaceServiceOptions,
  ticketId: string,
  expectedWorkspace: WorkspaceRecord,
  runner: GitRunner
): Promise<VerifiedReadiness> {
  const currentTicket = createTicketRepository(workspace.db).findById(ticketId);
  const readiness = await getCurrentPrePrReadinessEvidence(
    workspace,
    ticketId,
    { allowPrOpen: currentTicket?.status === TicketState.PR_OPEN }
  );
  if (readiness === undefined || readiness.result !== 'PASS' || readiness.readySha === undefined) {
    throw new Error('KAR-8 fail closed: current exact-SHA Pre-PR Readiness PASS is unavailable');
  }
  const liveWorkspace = await getVerifiedWorkspaceForExecution(
    workspace,
    ticketId,
    'changed',
    readiness.readySha
  );
  if (
    liveWorkspace.id !== expectedWorkspace.id ||
    liveWorkspace.sourceRepositoryPath !== expectedWorkspace.sourceRepositoryPath ||
    liveWorkspace.worktreePath !== expectedWorkspace.worktreePath ||
    liveWorkspace.branchName !== expectedWorkspace.branchName ||
    (await resolveCommitSha(runner, liveWorkspace.worktreePath, 'HEAD')) !== readiness.readySha ||
    !(await isStrictlyClean(runner, liveWorkspace.worktreePath))
  ) {
    throw new Error('KAR-8 fail closed: current workspace is not the clean readiness candidate');
  }
  const live = await inspectWorktreeState(
    runner,
    liveWorkspace.sourceRepositoryPath,
    liveWorkspace.worktreePath
  );
  if (!live.registered || live.head !== readiness.readySha || live.clean !== true) {
    throw new Error('KAR-8 fail closed: live worktree no longer proves the readiness candidate');
  }
  return readiness as VerifiedReadiness;
}

function assertGitHubRepository(project: ProjectRecord, fetchUrl: string, pushUrl: string): string {
  const configured = parseRepository(project.repository)?.toLowerCase();
  const fetchRepository = parseRemoteRepository(fetchUrl);
  const pushRepository = parseRemoteRepository(pushUrl);
  if (
    configured === undefined ||
    fetchRepository === undefined ||
    pushRepository === undefined ||
    configured !== fetchRepository ||
    configured !== pushRepository
  ) {
    throw new Error('KAR-8 fail closed: configured project repository and Git remotes do not match GitHub');
  }
  return configured;
}

function parseRepository(value: string): string | undefined {
  const match = /^([^/\s]+)\/([^/\s]+)$/u.exec(value.trim());
  return match === null ? undefined : `${match[1]}/${match[2]}`;
}

function parseRemoteRepository(value: string): string | undefined {
  const trimmed = value.trim();
  let host: string;
  let path: string;
  const scp = /^git@([^:]+):(.+)$/u.exec(trimmed);
  if (scp !== null) {
    host = scp[1];
    path = scp[2];
  } else {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'ssh:') return undefined;
    host = url.hostname;
    path = url.pathname.slice(1);
  }
  if (host.toLowerCase() !== 'github.com') return undefined;
  const repository = parseRepository(path.replace(/\.git$/u, ''));
  return repository === undefined ? undefined : repository.toLowerCase();
}

function pullRequestTitle(ticketId: string, title: string): string {
  const value = `${ticketId}: ${title}`;
  if (value.length > 256 || /[\r\n]/u.test(value)) {
    throw new Error('KAR-8 fail closed: deterministic PR title is invalid for GitHub');
  }
  return value;
}

function pullRequestBody(ticketId: string, readiness: CurrentPrePrReadinessEvidence): string {
  return [
    'ShipGraph pre-PR submission',
    '',
    `Ticket: ${ticketId}`,
    `Submitted SHA: ${readiness.readySha}`,
    `Contract digest: ${readiness.contractDigest}`,
    `Contract revision: ${readiness.contractRevision}`,
    'Local verification: PASS',
    'Contract Review: PASS',
    'Engineering Review: PASS',
    'Pre-PR Readiness: PASS',
  ].join('\n');
}

async function findOrCreatePullRequest(
  adapter: GitHostAdapter,
  input: {
    repository: string;
    baseBranch: string;
    headBranch: string;
    title: string;
    body: string;
  },
  readySha: string
): Promise<GitHostPullRequest> {
  const existing = await adapter.findPullRequests({
    repository: input.repository,
    headBranch: input.headBranch,
  });
  if (existing.length > 1) {
    throw new Error('KAR-8 fail closed: multiple GitHub PRs exist for the ShipGraph branch');
  }
  if (existing.length === 1) {
    const candidate = existing[0];
    if (
      candidate.repository !== input.repository ||
      candidate.baseBranch !== input.baseBranch ||
      candidate.headBranch !== input.headBranch ||
      candidate.headSha !== readySha
    ) {
      throw new Error('KAR-8 fail closed: existing GitHub PR identity conflicts with the ready candidate');
    }
    if (candidate.state !== 'OPEN') {
      throw new Error(`KAR-8 fail closed: existing GitHub PR is ${candidate.state}; no replacement is allowed`);
    }
    return await proveOpenPullRequest(adapter, input.repository, candidate.number, input, readySha);
  }
  const created = await adapter.createPullRequest(input);
  return proveOpenPullRequest(adapter, input.repository, created.number, input, readySha);
}

async function proveOpenPullRequest(
  adapter: GitHostAdapter,
  repository: string,
  number: number,
  input: { baseBranch: string; headBranch: string },
  readySha: string
): Promise<GitHostPullRequest> {
  const inspected = await adapter.inspectPullRequest({ repository, number });
  if (
    inspected.state !== 'OPEN' ||
    inspected.repository !== repository ||
    inspected.baseBranch !== input.baseBranch ||
    inspected.headBranch !== input.headBranch ||
    inspected.headSha !== readySha
  ) {
    throw new Error('KAR-8 fail closed: GitHub PR could not be proved open at the exact ready SHA');
  }
  return inspected;
}

function persistPrEvidence(
  workspace: WorkspaceServiceOptions,
  project: ProjectRecord,
  ticketId: string,
  pullRequest: GitHostPullRequest,
  readiness: VerifiedReadiness,
  verifiedWorkspace: WorkspaceRecord
): Extract<ShipgraphEvent, { type: typeof EventType.GITHUB_PR_RECORDED }> {
  const events = createEventRepository(workspace.db).findByTicketId(ticketId);
  const prior = events.filter(
    (event): event is Extract<ShipgraphEvent, { type: typeof EventType.GITHUB_PR_RECORDED }> =>
      event.type === EventType.GITHUB_PR_RECORDED
  );
  const matching = prior.filter((event) =>
    event.payload.prNumber === pullRequest.number &&
    event.payload.repository === project.repository &&
    event.payload.baseBranch === project.defaultBranch &&
    event.payload.headBranch === verifiedWorkspace.branchName &&
    event.payload.submittedHeadSha === readiness.readySha &&
    event.payload.contractDigest === readiness.contractDigest
  );
  if (prior.some((event) => !matching.includes(event))) {
    throw new Error('KAR-8 fail closed: durable GitHub PR evidence conflicts with the current submission');
  }
  if (matching.length > 1) throw new Error('KAR-8 fail closed: duplicate GitHub PR evidence exists');
  if (matching.length === 1) return matching[0];
  const eventRepository = createEventRepository(workspace.db);
  return eventRepository.append({
    id: workspace.createEventId?.() ?? randomUUID(),
    timestamp: workspace.now?.() ?? new Date().toISOString(),
    projectId: project.id,
    ticketId,
    type: EventType.GITHUB_PR_RECORDED,
    payload: {
      ticketId,
      prNumber: pullRequest.number,
      prUrl: pullRequest.url,
      repository: project.repository,
      baseBranch: project.defaultBranch,
      headBranch: verifiedWorkspace.branchName,
      submittedHeadSha: readiness.readySha,
      readinessEventId: readiness.eventId,
      contractDigest: readiness.contractDigest,
      contractSource: readiness.contractSource,
      contractRevision: readiness.contractRevision,
      recordedAt: workspace.now?.() ?? new Date().toISOString(),
    },
  }) as Extract<ShipgraphEvent, { type: typeof EventType.GITHUB_PR_RECORDED }>;
}

async function ensureUsageReceipt(
  workspace: WorkspaceServiceOptions,
  project: ProjectRecord,
  ticketId: string,
  pullRequest: GitHostPullRequest,
  receipt: GitHubUsageReceipt,
  readiness: CurrentPrePrReadinessEvidence,
  adapter: GitHostAdapter
): Promise<Extract<ShipgraphEvent, { type: typeof EventType.GITHUB_USAGE_RECEIPT_RECORDED }>> {
  const events = createEventRepository(workspace.db).findByTicketId(ticketId);
  const prior = events.filter(
    (event): event is Extract<ShipgraphEvent, { type: typeof EventType.GITHUB_USAGE_RECEIPT_RECORDED }> =>
      event.type === EventType.GITHUB_USAGE_RECEIPT_RECORDED
  );
  const matching = prior.filter((event) =>
    event.payload.prNumber === pullRequest.number &&
    event.payload.submittedHeadSha === readiness.readySha &&
    event.payload.contractDigest === readiness.contractDigest &&
    event.payload.contractRevision === receipt.contractRevision &&
    event.payload.executionRunId === receipt.executionRunId
  );
  if (prior.some((event) => !matching.includes(event))) {
    throw new Error('KAR-8 fail closed: durable usage receipt evidence conflicts with the current submission');
  }
  if (matching.length > 1) throw new Error('KAR-8 fail closed: duplicate usage receipt evidence exists');
  const body = usageReceiptBody(receipt);
  const comments = await adapter.listComments({ repository: project.repository, number: pullRequest.number });
  const current = findCurrentReceipt(comments, receipt);
  if (matching.length === 1) {
    const persisted = matching[0];
    if (current === undefined || current.id !== persisted.payload.commentId) {
      throw new Error('KAR-8 fail closed: durable receipt evidence is not confirmed by the current GitHub marker');
    }
    return persisted;
  }
  const comment = current ?? await adapter.postComment({
    repository: project.repository,
    number: pullRequest.number,
    body,
  });
  if (current === undefined && comment.body !== body) {
    throw new Error('KAR-8 fail closed: GitHub usage receipt response does not match the deterministic receipt');
  }
  const eventRepository = createEventRepository(workspace.db);
  return eventRepository.append({
    id: workspace.createEventId?.() ?? randomUUID(),
    timestamp: workspace.now?.() ?? new Date().toISOString(),
    projectId: project.id,
    ticketId,
    type: EventType.GITHUB_USAGE_RECEIPT_RECORDED,
    payload: {
      ticketId,
      prNumber: pullRequest.number,
      receiptVersion: receipt.version,
      submittedHeadSha: receipt.headSha,
      commentId: comment.id,
      ...(comment.url === undefined ? {} : { commentUrl: comment.url }),
      contractDigest: receipt.contractDigest,
      contractRevision: receipt.contractRevision,
      executionRunId: receipt.executionRunId,
      recordedAt: workspace.now?.() ?? new Date().toISOString(),
    },
  }) as Extract<ShipgraphEvent, { type: typeof EventType.GITHUB_USAGE_RECEIPT_RECORDED }>;
}

function findCurrentReceipt(comments: readonly GitHostComment[], expected: GitHubUsageReceipt): GitHostComment | undefined {
  const matches: GitHostComment[] = [];
  for (const comment of comments) {
    RECEIPT_MARKER_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RECEIPT_MARKER_PATTERN.exec(comment.body)) !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(match[1]);
      } catch {
        throw new Error('KAR-8 fail closed: a ShipGraph usage receipt marker is malformed');
      }
      const validated = githubUsageReceiptSchema.safeParse(parsed);
      if (!validated.success) {
        throw new Error('KAR-8 fail closed: a ShipGraph usage receipt has an unsupported schema');
      }
      if (validated.data.ticketId !== expected.ticketId) continue;
      if (JSON.stringify(validated.data) !== JSON.stringify(expected)) {
        throw new Error('KAR-8 fail closed: a conflicting ShipGraph usage receipt already exists');
      }
      matches.push(comment);
    }
  }
  if (matches.length > 1) throw new Error('KAR-8 fail closed: duplicate ShipGraph usage receipts exist');
  return matches[0];
}

function usageReceiptBody(receipt: GitHubUsageReceipt): string {
  return [
    'ShipGraph usage receipt',
    `Ticket: ${receipt.ticketId}`,
    `Submitted SHA: ${receipt.headSha}`,
    `Execution run: ${receipt.executionRunId}`,
    `Routing mode: ${receipt.routingMode}`,
    `<!-- shipgraph-usage-receipt:v1`,
    JSON.stringify(receipt),
    '-->',
  ].join('\n');
}

function buildUsageReceipt(
  workspace: WorkspaceServiceOptions,
  projectId: string,
  ticketId: string,
  verifiedWorkspace: WorkspaceRecord,
  readiness: CurrentPrePrReadinessEvidence
): GitHubUsageReceipt {
  const runs = createRunRepository(workspace.db)
    .findByTicketId(ticketId)
    .filter((run) =>
      run.projectId === projectId &&
      run.workspaceId === verifiedWorkspace.id &&
      run.workspacePath === verifiedWorkspace.worktreePath &&
      (run.task === 'implementation' || run.task === 'review' || run.task === 'repair')
    )
    .sort((left, right) =>
      (left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id))
    );
  const implementationRuns = runs.filter((run) => run.task === 'implementation');
  const executionRunId = implementationRuns[0]?.id;
  if (executionRunId === undefined) {
    throw new Error('KAR-8 fail closed: no trustworthy implementation run exists for the current workspace');
  }
  const receiptRuns = {
    implementation: implementationRuns,
    review: runs.filter((run) => run.task === 'review'),
    repair: runs.filter((run) => run.task === 'repair'),
  };
  const fallbackRuns = runs.filter((run) => isFallbackRun(run, runs));
  const modelRepository = createModelRepository(workspace.db);
  const usageEntries = modelRepository.listUsage(projectId).filter((entry) =>
    runs.some((run) => run.id === entry.runId)
  );
  const healthRecords = modelRepository.listHealth(projectId);
  const knownProviderIds = new Set([
    ...runs.map((run) => run.modelProviderId ?? run.provider ?? UNKNOWN),
  ]);
  const health = [...knownProviderIds].sort().map((providerId) => {
    const entry = healthRecords.find((candidate) => candidate.providerId === providerId);
    return {
      providerId,
      status: entry?.status ?? 'unknown' as const,
      auth: entry?.auth ?? 'unknown' as const,
      quotaPressure: entry?.quotaPressure ?? 'unknown' as const,
    };
  });
  const decisions = modelRepository.listRoutingDecisions(projectId);
  const routingMode = routingModeFor(usageEntries, decisions);
  const receipt = githubUsageReceiptSchema.parse({
    version: 1,
    ticketId,
    headSha: readiness.readySha,
    contractDigest: readiness.contractDigest,
    contractRevision: readiness.contractRevision,
    executionRunId,
    routingMode,
    implementation: receiptRuns.implementation.map(providerModel),
    review: receiptRuns.review.map(providerModel),
    repair: receiptRuns.repair.map(providerModel),
    fallback: fallbackRuns.map(providerModel),
    usage: runs.map((run) => {
      const entry = usageEntries.find((candidate) => candidate.runId === run.id);
      return {
        runId: run.id,
        providerId: run.modelProviderId ?? run.provider ?? UNKNOWN,
        modelId: run.model ?? UNKNOWN,
        inputTokens: entry?.inputTokens ?? UNKNOWN,
        outputTokens: entry?.outputTokens ?? UNKNOWN,
        cost: entry?.cost ?? UNKNOWN,
      };
    }),
    providerHealth: health,
  });
  return receipt;
}

function providerModel(run: RunRecord): { providerId: string; modelId: string } {
  return {
    providerId: run.modelProviderId ?? run.provider ?? UNKNOWN,
    modelId: run.model ?? UNKNOWN,
  };
}

function isFallbackRun(run: RunRecord, runs: readonly RunRecord[]): boolean {
  const sameAxis = runs.filter((candidate) =>
    candidate.task === run.task &&
    (run.task !== 'review' || candidate.reviewType === run.reviewType)
  );
  const position = sameAxis.indexOf(run);
  if (position <= 0) return false;
  return sameAxis.slice(0, position).some((candidate) =>
    candidate.status === 'NEEDS_HUMAN' &&
    candidate.failureCategory === 'persistence_error' &&
    candidate.failureReason === 'Selected provider could not be reserved before the next fallback was prepared'
  );
}

function routingModeFor(
  usageEntries: ReturnType<ReturnType<typeof createModelRepository>['listUsage']>,
  decisions: ReturnType<ReturnType<typeof createModelRepository>['listRoutingDecisions']>
): ModelRoutingMode | 'unknown' {
  const decisionIds = new Set(
    usageEntries
      .map((entry) => entry.routingDecisionId)
      .filter((id): id is string => id !== undefined)
  );
  const durableDecisions = decisions.filter((decision) => decisionIds.has(decision.id));
  const durableModes = new Set(durableDecisions.map((decision) => decision.mode));
  if (durableModes.size === 1) return durableDecisions[0].mode;
  return 'unknown';
}
