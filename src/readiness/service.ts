import { createHash, randomUUID } from 'node:crypto';
import {
  createGitRunner,
  inspectWorktreeState,
  isStrictlyClean,
  resolveCommitSha,
} from '../git/service.js';
import { TicketState } from '../core/state-machine/state.js';
import { loadBacklog } from '../backlog/schema.js';
import { assertSafeBacklogPath } from '../utils/paths.js';
import type { AgentRunRecord } from '../domain/agent-run.js';
import type { ShipgraphEvent } from '../events/event.js';
import { EventType } from '../events/event.js';
import {
  readinessEvidenceSchema,
  type ReadinessEvidence,
} from '../domain/readiness.js';
import {
  deriveTicketContractProvenance,
  type TicketContractProvenance,
} from '../domain/ticket.js';
import {
  createEventRepository,
  createRunRepository,
  createTicketRepository,
  type TicketRecord,
  type RunRecord,
} from '../persistence/repositories.js';
import {
  getCurrentProjectId,
  getVerifiedWorkspaceForExecution,
  type WorkspaceServiceOptions,
} from '../workspace/service.js';

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/u;

export type PrePrReadinessInput = {
  ticketId: string;
  workspace: WorkspaceServiceOptions;
};

export type PrePrReadinessResult = {
  result: 'PASS' | 'FAIL';
  readySha?: string;
  reason?: string;
  evidence?: ReadinessEvidence;
};

export type CurrentPrePrReadinessEvidence = ReadinessEvidence & {
  eventId: string;
  sequence: number;
  timestamp: string;
};

type Candidate = {
  sha: string;
};

type CurrentRepairEvidence = {
  event: Extract<ShipgraphEvent, { type: typeof EventType.REPAIR_ATTEMPT_RECORDED }>;
  occurred: boolean;
};

type ReadinessAssessment = {
  failures: readonly string[];
  repair: CurrentRepairEvidence | undefined;
  currentReviews: readonly AgentRunRecord[];
  safetyStatus: ReturnType<typeof safetyStatusFor>;
  redStatus: ReturnType<typeof redEvidenceStatus>;
};

/** Evaluate existing evidence for one exact, clean pre-PR candidate. */
export async function runPrePrReadiness(
  input: PrePrReadinessInput
): Promise<PrePrReadinessResult> {
  const projectId = getCurrentProjectId(input.workspace);
  const ticket = createTicketRepository(input.workspace.db).findById(input.ticketId);
  if (ticket === undefined || ticket.projectId !== projectId) {
    throw new Error(`Ticket ${input.ticketId} does not belong to the current project`);
  }

  let candidate: Candidate | undefined;
  let provenance: TicketContractProvenance | undefined;
  let setupReason: string | undefined;
  try {
    candidate = await currentCandidate(input.workspace, input.ticketId);
  } catch (error) {
    setupReason = errorMessage(error);
  }
  try {
    provenance = contractProvenance(input.workspace.projectDir, input.workspace.db, ticket);
  } catch (error) {
    setupReason = setupReason ?? errorMessage(error);
  }

  if (candidate === undefined || provenance === undefined) {
    return {
      result: 'FAIL',
      ...(candidate === undefined ? {} : { readySha: candidate.sha }),
      ...(setupReason === undefined ? {} : { reason: setupReason }),
    };
  }

  const events = createEventRepository(input.workspace.db).findByTicketId(input.ticketId);
  const runs = createRunRepository(input.workspace.db).findByTicketId(input.ticketId);
  const assessment = readinessAssessment(ticket, candidate.sha, provenance, events, runs);
  const { repair, currentReviews, safetyStatus, redStatus } = assessment;
  const failures = assessment.failures;
  const result = failures.length === 0 ? 'PASS' : 'FAIL';
  const contractReview = currentReviews.find((run) => run.reviewType === 'contract');
  const engineeringReview = currentReviews.find((run) => run.reviewType === 'engineering');
  const safetyRunIds = safetyStatus.runIds;
  const evidence = readinessEvidenceSchema.parse({
    ticketId: input.ticketId,
    readySha: candidate.sha,
    result,
    ...provenance,
    ...(repair === undefined ? {} : { verificationEventId: repair.event.id }),
    ...(contractReview === undefined ? {} : { contractReviewRunId: contractReview.id }),
    ...(engineeringReview === undefined ? {} : { engineeringReviewRunId: engineeringReview.id }),
    ...(repair?.occurred === true ? { repairEvidenceEventId: repair.event.id } : {}),
    repairOccurred: repair?.occurred === true,
    redEvidenceStatus: redStatus.status,
    ...(redStatus.infeasibilityReason === undefined
      ? {}
      : { redInfeasibilityReason: redStatus.infeasibilityReason }),
    safetyGateStatus: safetyStatus.status,
    safetyRunIds,
    ...(failures.length === 0 ? {} : { reason: failures.join('; ') }),
  });
  const stored = createEventRepository(input.workspace.db).append({
    id: input.workspace.createEventId?.() ?? randomUUID(),
    timestamp: input.workspace.now?.() ?? new Date().toISOString(),
    projectId,
    ticketId: input.ticketId,
    type: EventType.PRE_PR_READINESS_RECORDED,
    payload: evidence,
  });
  if (stored.type !== EventType.PRE_PR_READINESS_RECORDED) {
    throw new Error('KAR-11 readiness evidence was recorded with the wrong event type');
  }
  return {
    result,
    readySha: candidate.sha,
    ...(failures.length === 0 ? {} : { reason: failures.join('; ') }),
    evidence,
  };
}

/** Return a PASS record only when it matches the current clean HEAD and contract. */
export async function getCurrentPrePrReadinessEvidence(
  workspace: WorkspaceServiceOptions,
  ticketId: string
): Promise<CurrentPrePrReadinessEvidence | undefined> {
  let candidate: Candidate;
  try {
    candidate = await currentCandidate(workspace, ticketId);
  } catch {
    return undefined;
  }
  const projectId = getCurrentProjectId(workspace);
  const ticket = createTicketRepository(workspace.db).findById(ticketId);
  if (ticket === undefined || ticket.projectId !== projectId) return undefined;
  let provenance: TicketContractProvenance;
  try {
    provenance = contractProvenance(workspace.projectDir, workspace.db, ticket);
  } catch {
    return undefined;
  }
  const eventsForAssessment = createEventRepository(workspace.db).findByTicketId(ticketId);
  const runsForAssessment = createRunRepository(workspace.db).findByTicketId(ticketId);
  if (readinessAssessment(ticket, candidate.sha, provenance, eventsForAssessment, runsForAssessment).failures.length > 0) {
    return undefined;
  }
  const events = createEventRepository(workspace.db)
    .findByTicketId(ticketId)
    .filter((event): event is Extract<ShipgraphEvent, { type: typeof EventType.PRE_PR_READINESS_RECORDED }> =>
      event.type === EventType.PRE_PR_READINESS_RECORDED &&
      event.payload.result === 'PASS' &&
      event.payload.readySha === candidate.sha &&
      event.payload.contractDigest === provenance.contractDigest &&
      event.payload.contractSource === provenance.contractSource &&
      event.payload.contractRevision === provenance.contractRevision
    );
  const event = events.at(-1);
  if (event === undefined) return undefined;
  return {
    ...event.payload,
    eventId: event.id,
    sequence: event.sequence,
    timestamp: event.timestamp,
  };
}

async function currentCandidate(
  workspace: WorkspaceServiceOptions,
  ticketId: string
): Promise<Candidate> {
  const verified = await getVerifiedWorkspaceForExecution(workspace, ticketId, 'changed');
  const runner = workspace.gitRunner ?? createGitRunner();
  const sha = await resolveCommitSha(runner, verified.worktreePath, 'HEAD');
  const live = await inspectWorktreeState(runner, verified.sourceRepositoryPath, verified.worktreePath);
  if (
    sha === undefined ||
    !FULL_SHA_PATTERN.test(sha) ||
    !live.registered ||
    live.head !== sha ||
    live.clean !== true ||
    !(await isStrictlyClean(runner, verified.worktreePath))
  ) {
    throw new Error('KAR-11 requires a clean committed candidate with a known exact HEAD SHA');
  }
  return { sha };
}

function contractProvenance(
  projectDir: string,
  db: WorkspaceServiceOptions['db'],
  ticket: TicketRecord
): TicketContractProvenance {
  const sync = db
    .prepare('SELECT version, content_hash, source_path FROM backlog_syncs WHERE project_id = ?')
    .get(ticket.projectId) as { version: number; content_hash: string; source_path: string } | undefined;
  if (sync === undefined || sync.source_path.length === 0 || sync.content_hash.length === 0) {
    throw new Error('Authoritative backlog contract provenance is unavailable');
  }
  const validated = assertSafeBacklogPath(projectDir, sync.source_path);
  const backlog = loadBacklog(projectDir, validated.path, validated.identity);
  const currentHash = createHash('sha256')
    .update(JSON.stringify(backlog))
    .digest('hex');
  if (backlog.version !== sync.version || currentHash !== sync.content_hash) {
    throw new Error('Authoritative backlog contract changed since the last sync');
  }
  const definition = backlog.tickets.find((candidate) => candidate.id === ticket.id);
  if (definition === undefined) {
    throw new Error(`Authoritative backlog contract is missing ticket ${ticket.id}`);
  }
  const persisted = deriveTicketContractProvenance(ticket, sync.source_path, String(sync.version));
  const authoritative = deriveTicketContractProvenance(definition, sync.source_path, String(sync.version));
  if (persisted.contractDigest !== authoritative.contractDigest) {
    throw new Error(`Persisted ticket ${ticket.id} does not match the authoritative backlog contract`);
  }
  return authoritative;
}

function readinessAssessment(
  ticket: TicketRecord,
  sha: string,
  provenance: TicketContractProvenance,
  events: readonly ShipgraphEvent[],
  runs: readonly RunRecord[]
): ReadinessAssessment {
  const repair = currentRepairEvidence(events, sha);
  const verification = repair === undefined
    ? { passed: false, reason: 'No KAR-10 final verification evidence applies to the current SHA' }
    : verificationStatus(ticket.verification.commands, repair.event.payload.finalVerification, sha);
  const currentReviews = currentReviewRuns(runs, sha, provenance);
  const reviewStatus = reviewStatusFor(currentReviews);
  const safetyStatus = safetyStatusFor(ticket.status, runs, currentReviews, repair, events, sha);
  const redStatus = redEvidenceStatus(repair);
  return {
    repair,
    currentReviews,
    safetyStatus,
    redStatus,
    failures: [
      ticket.status === TicketState.VERIFYING || ticket.status === TicketState.REVIEWING
        ? undefined
        : `KAR-11 is pre-PR only; ticket is ${ticket.status}`,
      verification.passed ? undefined : verification.reason,
      reviewStatus.reason,
      safetyStatus.reason,
      redStatus.reason,
    ].filter((reason): reason is string => reason !== undefined),
  };
}

function currentRepairEvidence(
  events: readonly ShipgraphEvent[],
  sha: string
): CurrentRepairEvidence | undefined {
  const repairEvents = events.filter(
    (event): event is Extract<ShipgraphEvent, { type: typeof EventType.REPAIR_ATTEMPT_RECORDED }> =>
      event.type === EventType.REPAIR_ATTEMPT_RECORDED
  );
  const applicableEvents = repairEvents.filter((candidate) => {
    return candidate.payload.candidateSha === sha || candidate.payload.resultingSha === sha;
  });
  const occurred = applicableEvents.some((event) => event.payload.attempt > 0);
  const event = applicableEvents.at(-1);
  if (event === undefined || event.payload.outcome !== 'PASSED') return undefined;
  if (occurred && (event.payload.attempt === 0 || event.payload.resultingSha !== sha)) return undefined;
  return { event, occurred };
}

function verificationStatus(
  commands: readonly string[],
  observations: ReadonlyArray<{ command: string; sha: string; exitCode: number }> | undefined,
  sha: string
): { passed: boolean; reason?: string } {
  if (commands.length === 0) return { passed: false, reason: 'No deterministic verification commands are configured' };
  if (observations === undefined) return { passed: false, reason: 'KAR-10 final verification evidence is missing' };
  if (new Set(commands).size !== commands.length || observations.length !== commands.length) {
    return { passed: false, reason: 'Final verification does not contain exactly one observation per configured command' };
  }
  const unexpected = observations.find((observation) => observation.sha !== sha || !commands.includes(observation.command));
  if (unexpected !== undefined) {
    return { passed: false, reason: 'Final verification contains an observation for the wrong SHA or an unconfigured command' };
  }
  const missing = commands.filter((command) => !observations.some((observation) => observation.command === command));
  if (missing.length > 0) {
    return { passed: false, reason: `Final verification is missing configured command(s): ${missing.join(', ')}` };
  }
  if (observations.some((observation) => observation.exitCode !== 0)) {
    return { passed: false, reason: 'Final deterministic verification contains a failing result' };
  }
  return { passed: true };
}

function currentReviewRuns(
  runs: readonly RunRecord[],
  sha: string,
  provenance: TicketContractProvenance
): AgentRunRecord[] {
  return runs.filter((run): run is AgentRunRecord =>
    run.task === 'review' &&
    run.status === 'SUCCEEDED' &&
    run.reviewType !== undefined &&
    run.reviewedSha === sha &&
    run.reviewContractDigest === provenance.contractDigest &&
    run.reviewContractSource === provenance.contractSource &&
    run.reviewContractRevision === provenance.contractRevision &&
    run.reviewResult !== undefined
  ) as AgentRunRecord[];
}

function reviewStatusFor(runs: readonly AgentRunRecord[]): { reason?: string } {
  const latest = new Map<string, AgentRunRecord>();
  for (const run of [...runs].sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id)
  )) {
    if (run.reviewType !== undefined) latest.set(run.reviewType, run);
  }
  for (const reviewType of ['contract', 'engineering'] as const) {
    const run = latest.get(reviewType);
    if (run === undefined) return { reason: `Current ${reviewType} review evidence is missing` };
    if (run.reviewResult !== 'PASS') return { reason: `Current ${reviewType} review is ${run.reviewResult}` };
    if ((run.reviewFindings?.length ?? 0) > 0) return { reason: `Current ${reviewType} review has contradictory findings` };
  }
  return {};
}

function safetyStatusFor(
  ticketStatus: string,
  runs: readonly RunRecord[],
  currentReviews: readonly AgentRunRecord[],
  repair: CurrentRepairEvidence | undefined,
  events: readonly ShipgraphEvent[],
  sha: string
): { status: 'satisfied' | 'blocked' | 'unknown'; runIds: string[]; reason?: string } {
  if (ticketStatus === TicketState.NEEDS_HUMAN) {
    return { status: 'blocked', runIds: [], reason: 'Ticket has an unresolved NEEDS_HUMAN safety condition' };
  }
  const currentRepairEvents = events.filter(
    (event): event is Extract<ShipgraphEvent, { type: typeof EventType.REPAIR_ATTEMPT_RECORDED }> =>
      event.type === EventType.REPAIR_ATTEMPT_RECORDED &&
      (event.payload.candidateSha === sha || event.payload.resultingSha === sha)
  );
  const latestRepairEvent = currentRepairEvents.at(-1);
  if (latestRepairEvent?.payload.outcome === 'NEEDS_HUMAN') {
    return { status: 'blocked', runIds: [], reason: 'Unresolved KAR-10 NEEDS_HUMAN safety evidence exists' };
  }
  const runIds = currentReviews.map((run) => run.id);
  if (currentReviews.some((run) => run.safetyPolicySha256 === undefined)) {
    return { status: 'unknown', runIds, reason: 'Current review evidence does not prove KAR-7 policy satisfaction' };
  }
  if (repair?.occurred === true) {
    const repairRunId = repair.event.payload.repairRunId;
    const repairRun = repairRunId === undefined
      ? undefined
      : runs.find((run) => run.id === repairRunId && run.task === 'repair' && run.status === 'SUCCEEDED');
    if (repairRun === undefined || repairRun.safetyPolicySha256 === undefined) {
      return { status: 'unknown', runIds, reason: `KAR-10 repair safety evidence for ${sha} is missing` };
    }
    runIds.push(repairRun.id);
  }
  return { status: 'satisfied', runIds: [...new Set(runIds)] };
}

function redEvidenceStatus(
  repair: CurrentRepairEvidence | undefined
): {
  status: 'not_applicable' | 'present' | 'infeasible' | 'missing';
  infeasibilityReason?: string;
  reason?: string;
} {
  if (repair?.occurred !== true) return { status: 'not_applicable' };
  const blockers = repair.event.payload.blockers;
  const bugRepair = blockers.some((blocker) => blocker.source === 'verification');
  if (!bugRepair) return { status: 'not_applicable' };
  if (repair.event.payload.redCapableEvidence.length > 0) return { status: 'present' };
  if (repair.event.payload.redInfeasibilityReason !== undefined) {
    return {
      status: 'infeasible',
      infeasibilityReason: repair.event.payload.redInfeasibilityReason,
    };
  }
  return { status: 'missing', reason: 'Bug repair has no red-capable evidence or explicit infeasibility reason' };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
