import { randomUUID } from 'node:crypto';
import { canTransition } from '../core/state-machine/transitions.js';
import { TicketState } from '../core/state-machine/state.js';
import {
  AGENT_INSTRUCTIONS_LIMIT_BYTES,
  type AgentRunRecord,
} from '../domain/agent-run.js';
import {
  deriveBehavioralContractProvenance,
  behavioralTicketContractSchema,
  executionContractBoundPayloadSchema,
  executionEvidenceSchema,
  executionOutcomeSchema,
  type BehavioralTicketContract,
  type ExecutionContractProvenance,
  type ExecutionEvidence,
  type ExecutionOutcome,
} from '../domain/execution.js';
import type { AgentSafetyPolicy } from './service.js';
import type { ModelRoutingRequest } from '../domain/model-provider.js';
import { EventType, type ShipgraphEvent } from '../events/event.js';
import { createGitHubPullRequest, type GitHubPullRequestResult } from '../github/service.js';
import { ModelRoutingService } from '../model/service.js';
import {
  createEventRepository,
  createRunRepository,
  createTicketRepository,
  type RunRecord,
  type WorkspaceRecord,
} from '../persistence/repositories.js';
import { persistTicketTransition } from '../persistence/ticket-state-store.js';
import { runPrePrRepair } from '../repair/service.js';
import { runPrePrReadiness } from '../readiness/service.js';
import { getCurrentPrePrReadinessEvidence } from '../readiness/service.js';
import type { GitHostAdapter } from '../adapters/git-host/adapter.js';
import {
  createWorkspace,
  getCurrentProjectId,
  getVerifiedWorkspaceForExecution,
  type WorkspaceServiceOptions,
} from '../workspace/service.js';

export type ExecuteTicketInput = {
  issueId: string;
  contract: BehavioralTicketContract;
  contractSource: string;
  contractRevision: string;
  workspace: WorkspaceServiceOptions;
  modelService: ModelRoutingService;
  routing: Omit<ModelRoutingRequest, 'task' | 'runId'>;
  executionPolicy?: AgentSafetyPolicy;
  timeoutMs?: number;
  signal?: AbortSignal;
  gitHost?: GitHostAdapter;
  remote?: string;
  createExecutionId?: () => string;
};

export type ExecuteTicketResult = {
  outcome: ExecutionOutcome;
  evidence: ExecutionEvidence;
  github?: GitHubPullRequestResult;
};

type Binding = {
  executionId: string;
  contract: BehavioralTicketContract;
  provenance: ExecutionContractProvenance;
  conflictReason?: string;
};

/**
 * The single-ticket KAR-12 inner-loop entry point. It composes existing
 * stages and persists only the contract binding, root identity, and terminal
 * evidence needed to make retries converge.
 */
export async function executeTicket(input: ExecuteTicketInput): Promise<ExecuteTicketResult> {
  const contract = validateContract(input.contract);
  const provenance = deriveBehavioralContractProvenance(
    contract,
    input.contractSource,
    input.contractRevision
  );
  const projectId = getCurrentProjectId(input.workspace);
  const ticket = createTicketRepository(input.workspace.db).findById(input.issueId);
  if (ticket === undefined || ticket.projectId !== projectId) {
    throw new Error(`KAR-12 issue ${input.issueId} is not an authorized local project ticket`);
  }

  const binding = bindExecution(input, projectId, contract, provenance);
  if (binding.conflictReason !== undefined) {
    if (terminalFor(input.workspace, input.issueId, binding.executionId) !== undefined) {
      throw new Error(binding.conflictReason);
    }
    return terminalize(input, projectId, binding, 'NEEDS_HUMAN', binding.conflictReason);
  }
  const priorTerminal = terminalFor(input.workspace, input.issueId, binding.executionId);
  if (priorTerminal !== undefined) return priorTerminal;

  if (ticket.status === TicketState.PR_OPEN) {
    return recoverOpenPullRequest(input, projectId, binding);
  }
  const blocked = admissionOutcome(ticket.status);
  if (blocked !== undefined) {
    return terminalize(input, projectId, binding, blocked.outcome, blocked.reason);
  }

  const existingImplementationRun = latestRun(
    input.workspace,
    input.issueId,
    binding.executionId,
    'implementation',
    binding.provenance
  );
  let workspace: WorkspaceRecord;
  try {
    workspace = await acquireWorkspace(
      input,
      ticket.status,
      existingImplementationRun?.status === 'SUCCEEDED'
    );
  } catch (error) {
    const reason = `KAR-12 workspace admission failed: ${errorMessage(error)}`;
    const unsafeRecovery = errorMessage(error).includes('requires human inspection');
    return terminalize(
      input,
      projectId,
      binding,
      unsafeRecovery || ticket.status !== TicketState.ELIGIBLE ? 'NEEDS_HUMAN' : 'BLOCKED',
      reason
    );
  }
  const startedByThisInvocation = appendStarted(input, projectId, binding, workspace);

  // Workspace admission may transition ELIGIBLE to PLANNING. Use the durable
  // post-admission state when deciding which existing stage to resume.
  const executionStatus = currentTicketStatus(input, input.issueId);
  let implementationRun = existingImplementationRun;
  const activeRun = activeExecutionRun(input.workspace, input.issueId, binding.executionId, binding.provenance);
  if (activeRun !== undefined) {
    return terminalize(
      input,
      projectId,
      binding,
      'NEEDS_HUMAN',
      `KAR-12 cannot resume while provider run ${activeRun.id} is active`
    );
  }

  const unrelatedActiveRun = createRunRepository(input.workspace.db).findActiveByTicket(projectId, input.issueId);
  if (unrelatedActiveRun !== undefined && unrelatedActiveRun.executionId !== binding.executionId) {
    return terminalize(
      input,
      projectId,
      binding,
      'NEEDS_HUMAN',
      `KAR-12 cannot start while unrelated provider run ${unrelatedActiveRun.id} is active`,
      workspace
    );
  }
  if (!startedByThisInvocation && implementationRun === undefined) {
    return terminalize(
      input,
      projectId,
      binding,
      'NEEDS_HUMAN',
      'KAR-12 execution was previously started without durable implementation evidence; manual recovery is required',
      workspace
    );
  }

  if (implementationRun === undefined && (executionStatus === TicketState.PLANNING || executionStatus === TicketState.IMPLEMENTING)) {
    const instructions = implementationInstructions(input.issueId, contract);
    if (Buffer.byteLength(instructions, 'utf8') > AGENT_INSTRUCTIONS_LIMIT_BYTES) {
      return terminalize(
        input,
        projectId,
        binding,
        'NEEDS_HUMAN',
        `KAR-12 behavioral contract cannot fit within the ${AGENT_INSTRUCTIONS_LIMIT_BYTES}-byte agent instruction limit`
      );
    }
    try {
      const routed = await input.modelService.executeRoutedAgentTask(
        input.workspace,
        { ...input.routing, requestId: stageRequestId(binding.executionId, 'implementation'), task: 'implementation' },
        {
          ticketId: input.issueId,
          instructions,
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          ...(input.executionPolicy === undefined ? {} : { safety: input.executionPolicy }),
          executionId: binding.executionId,
          ...provenance,
        }
      );
      implementationRun = routed.run;
    } catch (error) {
      const activeAfterFailure = activeExecutionRun(input.workspace, input.issueId, binding.executionId, binding.provenance);
      return terminalize(
        input,
        projectId,
        binding,
        activeAfterFailure === undefined ? errorOutcome(input, error) : 'NEEDS_HUMAN',
        `KAR-12 implementation execution failed: ${errorMessage(error)}`,
        workspace
      );
    }
  }

  if (implementationRun !== undefined && implementationRun.status !== 'SUCCEEDED') {
    return terminalize(
      input,
      projectId,
      binding,
      runOutcome(implementationRun),
      implementationRun.failureReason ?? `implementation run ended in ${implementationRun.status}`,
      workspace,
      implementationRun
    );
  }
  if (implementationRun === undefined) {
    return terminalize(
      input,
      projectId,
      binding,
      'NEEDS_HUMAN',
      'KAR-12 cannot continue because durable implementation evidence is missing',
      workspace
    );
  }
  const terminalAfterImplementation = terminalFor(input.workspace, input.issueId, binding.executionId);
  if (terminalAfterImplementation !== undefined) return terminalAfterImplementation;
  if (currentTicketStatus(input, input.issueId) === TicketState.IMPLEMENTING) {
    persistTicketTransition(input.workspace.db, {
      ticketId: input.issueId,
      projectId,
      next: TicketState.VERIFYING,
      reason: `KAR-12 implementation run ${implementationRun.id} completed`,
    });
  }

  let repair;
  try {
    const terminalBeforeRepair = terminalFor(input.workspace, input.issueId, binding.executionId);
    if (terminalBeforeRepair !== undefined) return terminalBeforeRepair;
    repair = await runPrePrRepair({
      ticketId: input.issueId,
      modelService: input.modelService,
      workspace: input.workspace,
      routing: { ...input.routing, requestId: stageRequestId(binding.executionId, 'repair') },
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.executionPolicy === undefined ? {} : { safety: input.executionPolicy }),
      contract,
      contractProvenance: provenance,
      executionId: binding.executionId,
    });
  } catch (error) {
    return terminalize(input, projectId, binding, 'FAILED', `KAR-12 pre-PR verification failed: ${errorMessage(error)}`, workspace);
  }
  if (repair.status !== 'PASSED') {
    const reason = repair.reason ?? 'KAR-10 did not produce a passing pre-PR candidate';
    return terminalize(input, projectId, binding, repairOutcome(input, binding.executionId), reason, workspace);
  }
  const terminalAfterRepair = terminalFor(input.workspace, input.issueId, binding.executionId);
  if (terminalAfterRepair !== undefined) return terminalAfterRepair;

  let readiness;
  try {
    readiness = await runPrePrReadiness({
      ticketId: input.issueId,
      workspace: input.workspace,
      contractProvenance: provenance,
      executionId: binding.executionId,
    });
  } catch (error) {
    return terminalize(input, projectId, binding, 'FAILED', `KAR-11 readiness evaluation failed: ${errorMessage(error)}`, workspace);
  }
  if (readiness.result !== 'PASS' || readiness.evidence === undefined) {
    return terminalize(input, projectId, binding, 'NEEDS_HUMAN', readiness.reason ?? 'KAR-11 readiness did not pass', workspace);
  }
  const terminalAfterReadiness = terminalFor(input.workspace, input.issueId, binding.executionId);
  if (terminalAfterReadiness !== undefined) return terminalAfterReadiness;
  const currentReadiness = await getCurrentPrePrReadinessEvidence(
    input.workspace,
    input.issueId,
    { contractProvenance: provenance, executionId: binding.executionId }
  );
  if (currentReadiness === undefined) {
    return terminalize(input, projectId, binding, 'NEEDS_HUMAN', 'KAR-11 readiness PASS could not be revalidated', workspace);
  }

  let github: GitHubPullRequestResult;
  try {
    const terminalBeforeGitHub = terminalFor(input.workspace, input.issueId, binding.executionId);
    if (terminalBeforeGitHub !== undefined) return terminalBeforeGitHub;
    github = await createGitHubPullRequest({
      ticketId: input.issueId,
      workspace: input.workspace,
      ...(input.gitHost === undefined ? {} : { gitHost: input.gitHost }),
      ...(input.remote === undefined ? {} : { remote: input.remote }),
      contractProvenance: provenance,
      executionId: binding.executionId,
    });
  } catch (error) {
    const hasPartialPullRequestEvidence = createEventRepository(input.workspace.db)
      .findByTicketId(input.issueId)
      .some((event) =>
        event.type === EventType.GITHUB_PR_RECORDED &&
        event.payload.submittedHeadSha !== undefined &&
        event.payload.contractDigest === binding.provenance.contractDigest &&
        event.payload.contractSource === binding.provenance.contractSource &&
        event.payload.contractRevision === binding.provenance.contractRevision
      );
    if (hasPartialPullRequestEvidence) {
      return recoverOpenPullRequest(input, projectId, binding);
    }
    return terminalize(input, projectId, binding, 'NEEDS_HUMAN', `KAR-8 PR handoff failed: ${errorMessage(error)}`, workspace, implementationRun);
  }

  const evidence = appendTerminal(input, projectId, binding, 'PR_RAISED', {
    workspaceId: workspace.id,
    workspacePath: workspace.worktreePath,
    implementationRunId: implementationRun.id,
    finalVerificationEventId: currentReadiness.verificationEventId,
    contractReviewRunId: currentReadiness.contractReviewRunId,
    engineeringReviewRunId: currentReadiness.engineeringReviewRunId,
    readinessEventId: currentReadiness.eventId,
    githubPrEvidenceEventId: github.prEvidenceEventId,
    githubUsageReceiptEvidenceEventId: github.receiptEvidenceEventId,
    prNumber: github.pullRequest.number,
    prUrl: github.pullRequest.url,
    submittedHeadSha: github.readiness.readySha,
    attempts: repair.attempts,
    usageRunIds: createRunRepository(input.workspace.db)
      .findByTicketId(input.issueId)
      .filter((run) => run.executionId === binding.executionId)
      .map((run) => run.id),
  });
  return evidence.outcome === 'PR_RAISED'
    ? { outcome: 'PR_RAISED', evidence, github }
    : { outcome: evidence.outcome, evidence };
}

async function recoverOpenPullRequest(
  input: ExecuteTicketInput,
  projectId: string,
  binding: Binding
): Promise<ExecuteTicketResult> {
  try {
    const workspace = await getVerifiedWorkspaceForExecution(input.workspace, input.issueId, 'changed');
    const implementationRun = latestRun(
      input.workspace,
      input.issueId,
      binding.executionId,
      'implementation',
      binding.provenance
    );
    if (implementationRun === undefined || implementationRun.status !== 'SUCCEEDED') {
      throw new Error('durable implementation evidence is missing while recovering PR_OPEN');
    }
    const github = await createGitHubPullRequest({
      ticketId: input.issueId,
      workspace: input.workspace,
      ...(input.gitHost === undefined ? {} : { gitHost: input.gitHost }),
      ...(input.remote === undefined ? {} : { remote: input.remote }),
      contractProvenance: binding.provenance,
      executionId: binding.executionId,
    });
    const evidence = appendTerminal(input, projectId, binding, 'PR_RAISED', {
      workspaceId: workspace.id,
      workspacePath: workspace.worktreePath,
      implementationRunId: implementationRun.id,
      ...(github.readiness.verificationEventId === undefined
        ? {}
        : { finalVerificationEventId: github.readiness.verificationEventId }),
      ...(github.readiness.contractReviewRunId === undefined
        ? {}
        : { contractReviewRunId: github.readiness.contractReviewRunId }),
      ...(github.readiness.engineeringReviewRunId === undefined
        ? {}
        : { engineeringReviewRunId: github.readiness.engineeringReviewRunId }),
      readinessEventId: github.readiness.eventId,
      githubPrEvidenceEventId: github.prEvidenceEventId,
      githubUsageReceiptEvidenceEventId: github.receiptEvidenceEventId,
      prNumber: github.pullRequest.number,
      prUrl: github.pullRequest.url,
      submittedHeadSha: github.readiness.readySha,
      attempts: repairAttemptsFor(input.workspace, input.issueId, binding.executionId),
      usageRunIds: executionRunIds(input.workspace, input.issueId, binding.executionId),
    });
    return evidence.outcome === 'PR_RAISED'
      ? { outcome: 'PR_RAISED', evidence, github }
      : { outcome: evidence.outcome, evidence };
  } catch (error) {
    return terminalize(
      input,
      projectId,
      binding,
      'NEEDS_HUMAN',
      `KAR-12 could not reconcile the existing PR_OPEN handoff: ${errorMessage(error)}`
    );
  }
}

function validateContract(contract: BehavioralTicketContract): BehavioralTicketContract {
  const parsed = behavioralTicketContractSchema.parse(contract);
  return {
    ...parsed,
    acceptanceCriteria: [...parsed.acceptanceCriteria],
    outOfScope: [...parsed.outOfScope],
    ...(parsed.keyInterfaces === undefined ? {} : { keyInterfaces: [...parsed.keyInterfaces] }),
  };
}

function bindExecution(
  input: ExecuteTicketInput,
  projectId: string,
  contract: BehavioralTicketContract,
  provenance: ExecutionContractProvenance
): Binding {
  const claim = input.workspace.db.transaction((): Binding => {
    const events = createEventRepository(input.workspace.db).findByProjectId(projectId);
    const bindings = events.filter(
      (event): event is Extract<ShipgraphEvent, { type: typeof EventType.EXECUTION_CONTRACT_BOUND }> =>
        event.type === EventType.EXECUTION_CONTRACT_BOUND && event.ticketId === input.issueId
    );
    const matchingRevision = bindings.find(
      (event) =>
        event.payload.contractSource === provenance.contractSource &&
        event.payload.contractRevision === provenance.contractRevision
    );
    if (matchingRevision !== undefined) {
      if (matchingRevision.payload.contractDigest !== provenance.contractDigest) {
        return {
          executionId: matchingRevision.payload.executionId,
          contract: matchingRevision.payload.contract,
          provenance: {
            contractDigest: matchingRevision.payload.contractDigest,
            contractSource: matchingRevision.payload.contractSource,
            contractRevision: matchingRevision.payload.contractRevision,
          },
          conflictReason: 'KAR-12 execution contract is immutable once bound; the supplied source/revision conflicts with durable contract content',
        };
      }
      return {
        executionId: matchingRevision.payload.executionId,
        contract: matchingRevision.payload.contract,
        provenance: {
          contractDigest: matchingRevision.payload.contractDigest,
          contractSource: matchingRevision.payload.contractSource,
          contractRevision: matchingRevision.payload.contractRevision,
        },
      };
    }
    const executionId = input.createExecutionId?.() ?? randomUUID().replaceAll('-', '');
    const payload = executionContractBoundPayloadSchema.parse({
      executionId,
      ticketId: input.issueId,
      contract,
      ...provenance,
      recordedAt: timestamp(input.workspace),
    });
    createEventRepository(input.workspace.db).append({
      id: input.workspace.createEventId?.() ?? randomUUID(),
      timestamp: payload.recordedAt,
      projectId,
      ticketId: input.issueId,
      type: EventType.EXECUTION_CONTRACT_BOUND,
      payload,
    });
    return { executionId, contract, provenance };
  }).immediate;
  return claim();
}

function appendStarted(
  input: ExecuteTicketInput,
  projectId: string,
  binding: Binding,
  workspace: WorkspaceRecord
): boolean {
  const claim = input.workspace.db.transaction((): boolean => {
    const events = createEventRepository(input.workspace.db).findByTicketId(input.issueId);
    if (events.some((event) => event.type === EventType.EXECUTION_STARTED && event.payload.executionId === binding.executionId)) return false;
    const recordedAt = timestamp(input.workspace);
    createEventRepository(input.workspace.db).append({
      id: input.workspace.createEventId?.() ?? randomUUID(),
      timestamp: recordedAt,
      projectId,
      ticketId: input.issueId,
      type: EventType.EXECUTION_STARTED,
      payload: {
        executionId: binding.executionId,
        ticketId: input.issueId,
        ...binding.provenance,
        workspaceId: workspace.id,
        recordedAt,
      },
    });
    return true;
  }).immediate;
  return claim();
}

function terminalFor(
  workspace: WorkspaceServiceOptions,
  ticketId: string,
  executionId: string
): ExecuteTicketResult | undefined {
  const events = createEventRepository(workspace.db).findByTicketId(ticketId).filter(
    (event): event is Extract<ShipgraphEvent, { type: typeof EventType.EXECUTION_TERMINAL }> =>
      event.type === EventType.EXECUTION_TERMINAL && event.payload.executionId === executionId
  );
  if (events.length === 0) return undefined;
  const first = events[0].payload;
  if (events.some((event) => JSON.stringify(event.payload) !== JSON.stringify(first))) {
    throw new Error(`KAR-12 execution ${executionId} has conflicting terminal evidence`);
  }
  return { outcome: first.outcome, evidence: first };
}

function appendTerminal(
  input: ExecuteTicketInput,
  projectId: string,
  binding: Binding,
  outcome: ExecutionOutcome,
  fields: Omit<Partial<ExecutionEvidence>, 'executionId' | 'ticketId' | 'outcome' | 'contractDigest' | 'contractSource' | 'contractRevision' | 'recordedAt'>
): ExecutionEvidence {
  const persist = input.workspace.db.transaction((): ExecutionEvidence => {
    const existing = terminalFor(input.workspace, input.issueId, binding.executionId);
    if (existing !== undefined) return existing.evidence;
    const evidence = executionEvidenceSchema.parse({
      executionId: binding.executionId,
      ticketId: input.issueId,
      outcome: executionOutcomeSchema.parse(outcome),
      ...binding.provenance,
      recordedAt: timestamp(input.workspace),
      ...fields,
    });
    createEventRepository(input.workspace.db).append({
      id: input.workspace.createEventId?.() ?? randomUUID(),
      timestamp: evidence.recordedAt,
      projectId,
      ticketId: input.issueId,
      type: EventType.EXECUTION_TERMINAL,
      payload: evidence,
    });
    return evidence;
  }).immediate;
  return persist();
}

function terminalize(
  input: ExecuteTicketInput,
  projectId: string,
  binding: Binding,
  outcome: ExecutionOutcome,
  reason: string,
  workspace?: WorkspaceRecord,
  implementationRun?: RunRecord
): ExecuteTicketResult {
  const evidence = appendTerminal(input, projectId, binding, outcome, {
    ...(workspace === undefined ? {} : { workspaceId: workspace.id, workspacePath: workspace.worktreePath }),
    ...(implementationRun === undefined ? {} : { implementationRunId: implementationRun.id }),
    reason,
  });
  const ticket = createTicketRepository(input.workspace.db).findById(input.issueId);
  const next = evidence.outcome === 'BLOCKED'
    ? TicketState.BLOCKED
    : evidence.outcome === 'FAILED'
      ? TicketState.FAILED
      : TicketState.NEEDS_HUMAN;
  if (ticket !== undefined && canTransition(ticket.status, next)) {
    persistTicketTransition(input.workspace.db, {
      ticketId: input.issueId,
      projectId,
      next,
      reason,
    });
  } else if (
    ticket !== undefined &&
    ticket.status === TicketState.ELIGIBLE &&
    canTransition(ticket.status, TicketState.PAUSED)
  ) {
    // Some admission failures occur while the ticket is still ELIGIBLE, and
    // the existing state machine intentionally routes that state through
    // PAUSED for human recovery rather than inventing a new transition.
    persistTicketTransition(input.workspace.db, {
      ticketId: input.issueId,
      projectId,
      next: TicketState.PAUSED,
      reason,
    });
  }
  return { outcome: evidence.outcome, evidence };
}

async function acquireWorkspace(
  input: ExecuteTicketInput,
  status: string,
  completedImplementation: boolean
): Promise<WorkspaceRecord> {
  if (status === TicketState.ELIGIBLE) {
    return (await createWorkspace(input.workspace, input.issueId)).workspace;
  }
  return getVerifiedWorkspaceForExecution(
    input.workspace,
    input.issueId,
    !completedImplementation && (status === TicketState.PLANNING || status === TicketState.IMPLEMENTING)
      ? 'ready'
      : 'changed'
  );
}

function admissionOutcome(status: string): { outcome: ExecutionOutcome; reason: string } | undefined {
  if (status === TicketState.QUEUED) return { outcome: 'BLOCKED', reason: 'KAR-12 only executes an explicitly admitted ELIGIBLE issue' };
  if (status === TicketState.BLOCKED) return { outcome: 'BLOCKED', reason: 'The supplied issue is durably BLOCKED' };
  if (status === TicketState.NEEDS_HUMAN || status === TicketState.PAUSED || status === TicketState.CANCELLED) {
    return { outcome: 'NEEDS_HUMAN', reason: `The supplied issue is ${status}` };
  }
  if (status === TicketState.FAILED) return { outcome: 'FAILED', reason: 'The supplied issue has a prior terminal execution failure' };
  if (status === TicketState.PR_OPEN || status === TicketState.COMPLETE || status === TicketState.MERGED) {
    return { outcome: 'NEEDS_HUMAN', reason: `KAR-12 cannot start or reconstruct an execution from ticket state ${status}` };
  }
  const executableStatuses: readonly string[] = [
    TicketState.ELIGIBLE,
    TicketState.PLANNING,
    TicketState.IMPLEMENTING,
    TicketState.VERIFYING,
    TicketState.REPAIRING,
  ];
  if (!executableStatuses.includes(status)) {
    return {
      outcome: 'NEEDS_HUMAN',
      reason: `KAR-12 cannot start or reconstruct an execution from ticket state ${status}`,
    };
  }
  return undefined;
}

function activeExecutionRun(
  workspace: WorkspaceServiceOptions,
  ticketId: string,
  executionId: string,
  provenance: ExecutionContractProvenance
): AgentRunRecord | undefined {
  return createRunRepository(workspace.db)
    .findByTicketId(ticketId)
    .find((run) =>
      run.executionId === executionId &&
      run.contractDigest === provenance.contractDigest &&
      run.contractSource === provenance.contractSource &&
      run.contractRevision === provenance.contractRevision &&
      ['CREATED', 'STARTING', 'RUNNING'].includes(run.status)
    ) as AgentRunRecord | undefined;
}

function latestRun(
  workspace: WorkspaceServiceOptions,
  ticketId: string,
  executionId: string,
  task: 'implementation' | 'review' | 'repair',
  provenance: ExecutionContractProvenance
): AgentRunRecord | undefined {
  return createRunRepository(workspace.db)
    .findByTicketId(ticketId)
    .filter((run) =>
      run.executionId === executionId &&
      run.contractDigest === provenance.contractDigest &&
      run.contractSource === provenance.contractSource &&
      run.contractRevision === provenance.contractRevision &&
      run.task === task
    )
    .at(-1) as AgentRunRecord | undefined;
}

function repairAttemptsFor(
  workspace: WorkspaceServiceOptions,
  ticketId: string,
  executionId: string
): number {
  return createEventRepository(workspace.db)
    .findByTicketId(ticketId)
    .filter((event): event is Extract<ShipgraphEvent, { type: typeof EventType.REPAIR_ATTEMPT_RECORDED }> =>
      event.type === EventType.REPAIR_ATTEMPT_RECORDED && event.payload.executionId === executionId
    )
    .reduce((maximum, event) => Math.max(maximum, event.payload.attempt), 0);
}

function executionRunIds(
  workspace: WorkspaceServiceOptions,
  ticketId: string,
  executionId: string
): string[] {
  return createRunRepository(workspace.db)
    .findByTicketId(ticketId)
    .filter((run) => run.executionId === executionId)
    .map((run) => run.id);
}

function currentTicketStatus(input: ExecuteTicketInput, ticketId: string): string {
  return createTicketRepository(input.workspace.db).findById(ticketId)?.status ?? '';
}

function runOutcome(run: RunRecord): ExecutionOutcome {
  if (
    run.failureCategory === 'safety_limit' &&
    /(?:execution envelope budget is exhausted|(?:token|cost) budget exhausted)/iu.test(run.failureReason ?? '')
  ) {
    return 'BUDGET_EXHAUSTED';
  }
  if (run.status === 'NEEDS_HUMAN') return 'NEEDS_HUMAN';
  return 'FAILED';
}

function errorOutcome(input: ExecuteTicketInput, error: unknown): ExecutionOutcome {
  const budgetRemaining = input.routing.envelope.budgetRemaining;
  return error instanceof Error &&
    error.message === 'execution envelope budget is exhausted' &&
    budgetRemaining !== 'unknown' &&
    budgetRemaining <= 0
    ? 'BUDGET_EXHAUSTED'
    : 'FAILED';
}

function repairOutcome(input: ExecuteTicketInput, executionId: string): ExecutionOutcome {
  const repairRuns = createRunRepository(input.workspace.db)
    .findByTicketId(input.issueId)
    .filter((run) =>
      run.executionId !== undefined &&
      run.executionId === executionId &&
      (run.task === 'review' || run.task === 'repair')
    );
  if (repairRuns.some((run) => run.task === 'repair' && runOutcome(run) === 'BUDGET_EXHAUSTED')) {
    return 'BUDGET_EXHAUSTED';
  }

  // remainingStageSafety can exhaust a durable budget before a new repair
  // run exists. A measured UsageLedger total reaching the ceiling is the
  // only proof used here; unknown telemetry is never treated as zero.
  const runIds = new Set(repairRuns.map((run) => run.id));
  const usage = input.modelService.listUsage().filter((entry) => runIds.has(entry.runId));
  if (input.executionPolicy?.maxTokens !== undefined) {
    const knownTokens = usage.reduce((total, entry) =>
      typeof entry.inputTokens === 'number' && typeof entry.outputTokens === 'number'
        ? total + entry.inputTokens + entry.outputTokens
        : total,
      0
    );
    if (knownTokens >= input.executionPolicy.maxTokens) return 'BUDGET_EXHAUSTED';
  }
  if (input.executionPolicy?.maxCost !== undefined) {
    const knownCost = usage.reduce((total, entry) =>
      typeof entry.cost === 'number' ? total + entry.cost : total,
      0
    );
    if (knownCost >= input.executionPolicy.maxCost) return 'BUDGET_EXHAUSTED';
  }
  return 'NEEDS_HUMAN';
}

function stageRequestId(executionId: string, stage: string): string {
  const value = `${executionId}:${stage}`;
  return value.length <= 256 ? value : value.slice(0, 256);
}

function implementationInstructions(issueId: string, contract: BehavioralTicketContract): string {
  const serialized = JSON.stringify({
    summary: contract.summary,
    currentBehavior: contract.currentBehavior,
    desiredBehavior: contract.desiredBehavior,
    acceptanceCriteria: [...contract.acceptanceCriteria],
    outOfScope: [...contract.outOfScope],
    ...(contract.keyInterfaces === undefined ? {} : { keyInterfaces: [...contract.keyInterfaces] }),
  });
  return [
    'Implement one explicitly authorized ShipGraph issue.',
    `Issue identity: ${issueId}`,
    'Inspect the real repository and make the smallest safe change that satisfies the behavioral contract.',
    'Do not add implementation recipes, adjacent product work, or unrelated refactors.',
    'Leave the worktree with a committed functional change and do not include implementation reasoning in the result.',
    `Behavioral Ticket Contract: ${serialized}`,
  ].join('\n\n');
}

function timestamp(input: ExecuteTicketInput | WorkspaceServiceOptions): string {
  const workspace = 'workspace' in input ? input.workspace : input;
  return workspace.now?.() ?? new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
