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
  currentReviews: readonly RunRecord[];
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
    const evidence = readinessEvidenceSchema.parse({
      ticketId: input.ticketId,
      result: 'FAIL',
      ...(candidate === undefined ? {} : { readySha: candidate.sha }),
      ...(provenance ?? {}),
      reason: setupReason ?? 'KAR-11 could not establish the current candidate and contract provenance',
    });
    appendReadinessEvidence(input.workspace, projectId, input.ticketId, evidence);
    return {
      result: 'FAIL',
      ...(candidate === undefined ? {} : { readySha: candidate.sha }),
      reason: evidence.reason,
      evidence,
    };
  }

  const events = createEventRepository(input.workspace.db).findByTicketId(input.ticketId);
  const runs = createRunRepository(input.workspace.db).findByTicketId(input.ticketId);
  const assessment = readinessAssessment(ticket, candidate.sha, provenance, events, runs);
  const { repair, currentReviews, safetyStatus, redStatus } = assessment;
  const failures = assessment.failures;
  const result = failures.length === 0 ? 'PASS' : 'FAIL';
  const contractReview = latestReviewRun(currentReviews, 'contract', events).run;
  const engineeringReview = latestReviewRun(currentReviews, 'engineering', events).run;
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
  if (result === 'PASS' && !passReferencesMatch(evidence, candidate.sha, provenance, events, runs)) {
    throw new Error('KAR-11 PASS evidence references are not current durable records');
  }
  appendReadinessEvidence(input.workspace, projectId, input.ticketId, evidence);
  return {
    result,
    readySha: candidate.sha,
    ...(failures.length === 0 ? {} : { reason: failures.join('; ') }),
    evidence,
  };
}

function appendReadinessEvidence(
  workspace: WorkspaceServiceOptions,
  projectId: string,
  ticketId: string,
  evidence: ReadinessEvidence
): void {
  const stored = createEventRepository(workspace.db).append({
    id: workspace.createEventId?.() ?? randomUUID(),
    timestamp: workspace.now?.() ?? new Date().toISOString(),
    projectId,
    ticketId,
    type: EventType.PRE_PR_READINESS_RECORDED,
    payload: evidence,
  });
  if (stored.type !== EventType.PRE_PR_READINESS_RECORDED) {
    throw new Error('KAR-11 readiness evidence was recorded with the wrong event type');
  }
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
  const reviewStatus = reviewStatusFor(currentReviews, events);
  const safetyStatus = safetyStatusFor(ticket.status, runs, currentReviews, repair, events, sha);
  const redStatus = redEvidenceStatus(repair, sha);
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
): RunRecord[] {
  return runs.filter((run) =>
    run.task === 'review' &&
    run.reviewType !== undefined &&
    run.reviewedSha === sha &&
    run.reviewContractDigest === provenance.contractDigest &&
    run.reviewContractSource === provenance.contractSource &&
    run.reviewContractRevision === provenance.contractRevision
  );
}

function reviewStatusFor(runs: readonly RunRecord[], events: readonly ShipgraphEvent[]): { reason?: string } {
  for (const reviewType of ['contract', 'engineering'] as const) {
    const selection = latestReviewRun(runs, reviewType, events);
    if (!selection.orderingKnown) return { reason: `Current ${reviewType} review ordering evidence is missing` };
    const run = selection.run;
    if (run === undefined) return { reason: `Current ${reviewType} review evidence is missing` };
    if (run.status !== 'SUCCEEDED' || run.reviewResult === undefined) {
      return { reason: `Current ${reviewType} review run is ${run.status} without a successful report` };
    }
    if (run.reviewResult !== 'PASS') return { reason: `Current ${reviewType} review is ${run.reviewResult}` };
    if ((run.reviewFindings?.length ?? 0) > 0) return { reason: `Current ${reviewType} review has contradictory findings` };
  }
  return {};
}

function latestReviewRun(
  runs: readonly RunRecord[],
  reviewType: 'contract' | 'engineering',
  events: readonly ShipgraphEvent[]
): { run?: RunRecord; orderingKnown: boolean } {
  const candidates = runs
    .filter((run) => run.reviewType === reviewType)
    .map((run) => ({
      run,
      sequence: events.find(
        (event): event is Extract<ShipgraphEvent, { type: typeof EventType.RUN_CREATED }> =>
          event.type === EventType.RUN_CREATED && event.runId === run.id
      )?.sequence,
    }));
  if (candidates.length === 0) return { orderingKnown: true };
  if (candidates.some((candidate) => candidate.sequence === undefined)) {
    return { orderingKnown: false };
  }
  const latest = candidates.reduce((current, candidate) =>
    (candidate.sequence ?? 0) > (current.sequence ?? 0) ? candidate : current
  );
  return { run: latest.run, orderingKnown: true };
}

function safetyStatusFor(
  ticketStatus: string,
  runs: readonly RunRecord[],
  currentReviews: readonly RunRecord[],
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
  if (currentReviews.some((run) => !hasBoundSafetyPolicy(run, events))) {
    return { status: 'unknown', runIds, reason: 'Current review evidence does not prove KAR-7 policy satisfaction' };
  }
  if (repair?.occurred === true) {
    const repairRunId = repair.event.payload.repairRunId;
    const repairRun = repairRunId === undefined
      ? undefined
      : runs.find((run) => run.id === repairRunId && run.task === 'repair' && run.status === 'SUCCEEDED');
    if (repairRun === undefined || !hasBoundSafetyPolicy(repairRun, events)) {
      return { status: 'unknown', runIds, reason: `KAR-10 repair safety evidence for ${sha} is missing` };
    }
    runIds.push(repairRun.id);
  }
  return { status: 'satisfied', runIds: [...new Set(runIds)] };
}

function hasBoundSafetyPolicy(run: RunRecord, events: readonly ShipgraphEvent[]): boolean {
  if (run.safetyPolicySha256 === undefined) return false;
  const created = events.find(
    (event): event is Extract<ShipgraphEvent, { type: typeof EventType.RUN_CREATED }> =>
      event.type === EventType.RUN_CREATED && event.runId === run.id
  );
  return created?.payload.safetyPolicySha256 === run.safetyPolicySha256;
}

function passReferencesMatch(
  evidence: ReadinessEvidence,
  sha: string,
  provenance: TicketContractProvenance,
  events: readonly ShipgraphEvent[],
  runs: readonly RunRecord[]
): boolean {
  if (
    evidence.readySha !== sha ||
    evidence.contractDigest !== provenance.contractDigest ||
    evidence.contractSource !== provenance.contractSource ||
    evidence.contractRevision !== provenance.contractRevision ||
    evidence.verificationEventId === undefined ||
    evidence.contractReviewRunId === undefined ||
    evidence.engineeringReviewRunId === undefined
  ) return false;
  const contract = runs.find((run) => run.id === evidence.contractReviewRunId);
  const engineering = runs.find((run) => run.id === evidence.engineeringReviewRunId);
  if (
    contract === undefined ||
    engineering === undefined ||
    contract.task !== 'review' ||
    engineering.task !== 'review' ||
    contract.reviewType !== 'contract' ||
    engineering.reviewType !== 'engineering' ||
    contract.status !== 'SUCCEEDED' ||
    engineering.status !== 'SUCCEEDED' ||
    contract.reviewedSha !== sha ||
    engineering.reviewedSha !== sha ||
    contract.reviewContractDigest !== provenance.contractDigest ||
    engineering.reviewContractDigest !== provenance.contractDigest ||
    contract.reviewContractSource !== provenance.contractSource ||
    engineering.reviewContractSource !== provenance.contractSource ||
    contract.reviewContractRevision !== provenance.contractRevision ||
    engineering.reviewContractRevision !== provenance.contractRevision ||
    contract.reviewResult !== 'PASS' ||
    engineering.reviewResult !== 'PASS' ||
    (contract.reviewFindings?.length ?? 0) > 0 ||
    (engineering.reviewFindings?.length ?? 0) > 0
  ) return false;
  const verification = events.find((event) => event.id === evidence.verificationEventId);
  if (
    verification === undefined ||
    verification.type !== EventType.REPAIR_ATTEMPT_RECORDED ||
    verification.payload.outcome !== 'PASSED' ||
    (verification.payload.candidateSha !== sha && verification.payload.resultingSha !== sha) ||
    verification.payload.finalVerification === undefined
  ) return false;
  if (evidence.repairOccurred) {
    return evidence.repairEvidenceEventId === verification.id;
  }
  return evidence.repairEvidenceEventId === undefined;
}

function redEvidenceStatus(
  repair: CurrentRepairEvidence | undefined,
  sha: string
): {
  status: 'not_applicable' | 'present' | 'infeasible' | 'missing';
  infeasibilityReason?: string;
  reason?: string;
} {
  if (repair?.occurred !== true) return { status: 'not_applicable' };
  const blockers = repair.event.payload.blockers;
  const bugRepair = blockers.some((blocker) => blocker.source === 'verification');
  if (!bugRepair) return { status: 'not_applicable' };
  const redEvidence = repair.event.payload.redCapableEvidence;
  if (repair.event.payload.redInfeasibilityReason !== undefined && redEvidence.length > 0) {
    return { status: 'missing', reason: 'Bug repair has contradictory red-capable and infeasibility evidence' };
  }
  if (redEvidence.length > 0) {
    const remaining = [...redEvidence];
    for (const blocker of blockers) {
      if (blocker.source !== 'verification') continue;
      const index = remaining.findIndex((evidence) =>
        evidence.command === blocker.command &&
        evidence.before.command === blocker.command &&
        evidence.before.sha !== sha &&
        evidence.before.exitCode !== 0 &&
        evidence.after !== undefined &&
        evidence.after.command === blocker.command &&
        evidence.after.sha === sha &&
        evidence.after.exitCode === 0
      );
      if (index < 0) {
        return {
          status: 'missing',
          reason: 'Bug repair has no red-capable evidence with a valid before/after reproducer or explicit infeasibility reason',
        };
      }
      remaining.splice(index, 1);
    }
    if (remaining.length > 0) {
      return {
        status: 'missing',
        reason: 'Bug repair contains unrelated or invalid red-capable evidence',
      };
    }
    return { status: 'present' };
  }
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
