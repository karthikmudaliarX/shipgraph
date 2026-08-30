import { randomUUID } from 'node:crypto';
import {
  createGitRunner,
  inspectWorktreeState,
  isStrictlyClean,
  resolveCommitSha,
} from '../git/service.js';
import { createRunRepository, createTicketRepository, type WorkspaceRecord } from '../persistence/repositories.js';
import {
  getCurrentProjectId,
  getVerifiedWorkspaceForExecution,
  type WorkspaceServiceOptions,
} from '../workspace/service.js';
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  REVIEW_TYPES,
  reviewResultSchema,
  reviewTypeSchema,
  type AgentRunRecord,
  type ReviewResult,
  type ReviewType,
} from '../domain/agent-run.js';
import type { ModelRoutingRequest } from '../domain/model-provider.js';
import { redactSensitiveText } from '../adapters/agent/safety.js';
import { ModelRoutingService, type RoutedAgentTaskResult } from '../model/service.js';
import type { AgentSafetyPolicy } from '../execution/service.js';

const REVIEW_DIFF_LIMIT_BYTES = 32 * 1024;
const REVIEW_VERIFICATION_LIMIT_BYTES = 8 * 1024;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/u;

export type PrePrReviewInput = {
  ticketId: string;
  modelService: ModelRoutingService;
  workspace: WorkspaceServiceOptions;
  routing: Omit<ModelRoutingRequest, 'task' | 'runId'>;
  timeoutMs?: number;
  signal?: AbortSignal;
  safety?: AgentSafetyPolicy;
  /** Read-only verification results supplied by the caller, not transcripts. */
  verificationEvidence?: readonly string[];
};

export type PrePrReviewAxisResult = {
  reviewType: ReviewType;
  reviewedSha: string;
  result?: ReviewResult;
  findings: readonly string[];
  passed: boolean;
  run: AgentRunRecord;
};

export type PrePrReviewResult = {
  reviewedSha: string;
  contract: PrePrReviewAxisResult;
  engineering: PrePrReviewAxisResult;
  passed: boolean;
};

/**
 * Run the two independent KAR-9 review axes against one immutable local HEAD.
 * The axes are sequential only because AGENT-001 permits one active run per
 * ticket; each still receives a separate routed run and request identity.
 */
export async function runPrePrReviews(input: PrePrReviewInput): Promise<PrePrReviewResult> {
  const snapshot = await readReviewSnapshot(input.workspace, input.ticketId, input.verificationEvidence);
  const reviewSafety: AgentSafetyPolicy = {
    ...(input.safety ?? {}),
    maxAttempts: input.safety?.maxAttempts ?? 1,
    maxTimeoutMs: input.safety?.maxTimeoutMs ?? (input.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS),
  };
  const results = [] as PrePrReviewAxisResult[];

  for (const reviewType of REVIEW_TYPES) {
    if (reviewType !== 'contract') {
      await assertCurrentReviewHead(input.workspace, input.ticketId, snapshot.headSha);
    }
    const routed = await input.modelService.executeRoutedAgentTask(
      input.workspace,
      {
        ...input.routing,
        requestId: `${input.routing.requestId ?? randomUUID()}:${reviewType}`,
        task: 'review',
      },
      {
        ticketId: input.ticketId,
        instructions: reviewInstructions(reviewType, snapshot),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        safety: reviewSafety,
        reviewType,
        reviewedSha: snapshot.headSha,
      }
    );
    results.push(axisResult(reviewType, snapshot.headSha, routed));
    await assertCurrentReviewHead(input.workspace, input.ticketId, snapshot.headSha);
  }

  const contract = results.find((result) => result.reviewType === 'contract');
  const engineering = results.find((result) => result.reviewType === 'engineering');
  if (contract === undefined || engineering === undefined) {
    throw new Error('KAR-9 did not produce both independent review axes');
  }
  return {
    reviewedSha: snapshot.headSha,
    contract,
    engineering,
    passed: contract.passed && engineering.passed,
  };
}

/**
 * Return only review runs bound to the current worktree HEAD. A prior HEAD's
 * evidence remains durable for audit, but cannot be mistaken for current
 * review evidence after the candidate changes.
 */
export async function listCurrentPrePrReviewEvidence(
  workspace: WorkspaceServiceOptions,
  ticketId: string
): Promise<readonly AgentRunRecord[]> {
  const snapshot = await readReviewSnapshot(workspace, ticketId);
  const projectId = getCurrentProjectId(workspace);
  return createRunRepository(workspace.db)
    .findByTicketId(ticketId)
    .filter((run): run is AgentRunRecord =>
      run.projectId === projectId &&
      run.task === 'review' &&
      run.reviewType !== undefined &&
      run.reviewedSha === snapshot.headSha &&
      run.status === 'SUCCEEDED' &&
      run.reviewResult !== undefined
    )
    .map((run) => {
      const parsed = run as AgentRunRecord;
      return parsed;
    });
}

async function readReviewSnapshot(
  options: WorkspaceServiceOptions,
  ticketId: string,
  verificationEvidence?: readonly string[]
): Promise<{
  workspace: WorkspaceRecord;
  baseSha: string;
  headSha: string;
  diff: string;
  diffTruncated: boolean;
  contract: Record<string, unknown>;
  verificationEvidence: readonly string[];
}> {
  const workspace = await getVerifiedWorkspaceForExecution(options, ticketId, 'changed');
  const runner = options.gitRunner ?? createGitRunner();
  const headSha = await resolveCommitSha(runner, workspace.worktreePath, 'HEAD');
  if (headSha === undefined || !FULL_SHA_PATTERN.test(headSha)) {
    throw new Error(`Could not resolve a full review HEAD SHA for workspace ${workspace.id}`);
  }
  const live = await inspectWorktreeState(runner, workspace.sourceRepositoryPath, workspace.worktreePath);
  if (!live.registered || live.head !== headSha || live.clean !== true || !(await isStrictlyClean(runner, workspace.worktreePath))) {
    throw new Error(`Workspace HEAD changed while preparing the KAR-9 review snapshot`);
  }
  const diffResult = await runner(workspace.worktreePath, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--binary',
    workspace.baseSha,
    headSha,
    '--',
  ]);
  if (diffResult.exitCode !== 0) {
    throw new Error(`Could not read the review diff: ${diffResult.stderr.trim() || 'git diff failed'}`);
  }
  const boundedDiff = boundedText(redactSensitiveText(diffResult.stdout), REVIEW_DIFF_LIMIT_BYTES);
  const ticket = createTicketRepository(options.db).findById(ticketId);
  if (ticket === undefined || ticket.projectId !== workspace.projectId) {
    throw new Error(`Ticket ${ticketId} is missing or does not belong to the review workspace`);
  }
  const contract = {
    id: ticket.id,
    title: ticket.title,
    description: ticket.description,
    priority: ticket.priority,
    dependsOn: ticket.dependsOn,
    scope: ticket.scope,
    acceptanceCriteria: ticket.acceptanceCriteria,
    verification: ticket.verification,
    risk: ticket.risk,
    agent: ticket.agent,
    release: ticket.release,
  } satisfies Record<string, unknown>;
  const evidence = boundedVerificationEvidence(verificationEvidence);
  return {
    workspace,
    baseSha: workspace.baseSha,
    headSha,
    diff: boundedDiff.value,
    diffTruncated: boundedDiff.truncated,
    contract,
    verificationEvidence: evidence,
  };
}

async function assertCurrentReviewHead(
  options: WorkspaceServiceOptions,
  ticketId: string,
  expectedHeadSha: string
): Promise<void> {
  const workspace = await getVerifiedWorkspaceForExecution(options, ticketId, 'changed', expectedHeadSha);
  const runner = options.gitRunner ?? createGitRunner();
  const live = await inspectWorktreeState(runner, workspace.sourceRepositoryPath, workspace.worktreePath);
  if (
    workspace.ticketId !== ticketId ||
    !live.registered ||
    live.head !== expectedHeadSha ||
    live.clean !== true ||
    !(await isStrictlyClean(runner, workspace.worktreePath))
  ) {
    throw new Error(`Review workspace changed before the next KAR-9 axis`);
  }
}

function reviewInstructions(
  reviewType: ReviewType,
  snapshot: Awaited<ReturnType<typeof readReviewSnapshot>>
): string {
  const axis = reviewType === 'contract'
    ? 'CONTRACT REVIEW: determine whether every requested acceptance criterion is met, whether requested behavior is missing, partial, or incorrect, whether explicit out-of-scope boundaries were respected, and whether scope creep is present.'
    : 'ENGINEERING REVIEW: determine whether the change is correct, appropriately small, maintainable, and consistent with repository standards; inspect coupling, speculative or duplicated mechanisms, failure handling, security/reliability, and apply the deletion test to abstractions.';
  const truncation = snapshot.diffTruncated
    ? '\nThe supplied diff is bounded and marked incomplete; inspect the read-only repository for the complete change before deciding.'
    : '';
  const evidence = snapshot.verificationEvidence.length === 0
    ? ''
    : `\nVerification evidence (read-only results only):\n${JSON.stringify(snapshot.verificationEvidence)}`;
  return [
    'Perform one bounded KAR-9 pre-PR review axis.',
    axis,
    'Evaluate the artifact, not an implementer narrative. Do not modify files, create commits, repair findings, or run another agent.',
    'You may inspect the read-only repository and worktree to understand the diff accurately.',
    'Return exactly one JSON object with this shape: {"result":"PASS"|"FAIL","findings":["concise finding"]}. Use an empty findings array for PASS.',
    `Review axis: ${reviewType}`,
    `Base commit SHA: ${snapshot.baseSha}`,
    `Head commit SHA: ${snapshot.headSha}`,
    `Ticket contract: ${JSON.stringify(snapshot.contract)}`,
    `Diff from base to head:\n${snapshot.diff}${truncation}`,
    evidence,
  ].filter((line) => line.length > 0).join('\n\n');
}

function axisResult(
  reviewType: ReviewType,
  reviewedSha: string,
  routed: RoutedAgentTaskResult
): PrePrReviewAxisResult {
  const run = routed.run;
  const result = run.reviewResult === undefined ? undefined : reviewResultSchema.parse(run.reviewResult);
  const findings = run.reviewFindings ?? [];
  return {
    reviewType: reviewTypeSchema.parse(reviewType),
    reviewedSha,
    ...(result === undefined ? {} : { result }),
    findings,
    passed: run.status === 'SUCCEEDED' && result === 'PASS',
    run,
  };
}

function boundedVerificationEvidence(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) return [];
  const bounded: string[] = [];
  let bytes = 0;
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) continue;
    const redacted = redactSensitiveText(value);
    const remaining = REVIEW_VERIFICATION_LIMIT_BYTES - bytes;
    if (remaining <= 0) break;
    const part = boundedText(redacted, remaining);
    bounded.push(part.value);
    bytes += Buffer.byteLength(part.value, 'utf8');
    if (part.truncated) break;
  }
  return bounded;
}

function boundedText(value: string, limit: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= limit) return { value, truncated: false };
  return { value: bytes.subarray(0, limit).toString('utf8'), truncated: true };
}
