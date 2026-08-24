import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, basename, dirname, join, relative } from 'node:path';
import { mkdirSync, existsSync, realpathSync } from 'node:fs';
import {
  ensureOwnedDirectoryChain,
  deriveBranchName,
  deriveWorktreePath,
  assertSafeTicketId,
  tryLstatSync,
} from './model.js';

import {
  createGitRunner,
  gitTopLevel,
  isBranchNameValid,
  isInsideWorkTree,
  addWorktreeWithNewBranch,
  removeWorktree,
  inspectWorktreeState,
  isStrictlyClean,
  hasGitlinkEntries,
  findOtherWorktreesUsingBranch,
  resolveCommitSha,
  deleteBranchIfAt,
  type GitRunner,
} from '../git/service.js';
import { assertSafeShipgraphPaths } from '../utils/paths.js';
import { loadConfig } from '../config/loader.js';
import { persistedProjectMatchesConfig } from '../config/schema.js';
import {
  createEventRepository,
  createProjectRepository,
  createTicketRepository,
  createWorkspaceRepository,
  type WorkspaceRecord,
  type WorkspaceStatus,
} from '../persistence/repositories.js';
import { persistTicketTransition } from '../persistence/ticket-state-store.js';
import type { DbConnection } from '../persistence/db.js';
import {
  EventType,
  type WorkspaceCreatingPayload,
  type WorkspaceFailedPayload,
  type WorkspaceReadyPayload,
  type WorkspaceRemovedPayload,
} from '../events/event.js';
import { TicketState, type TicketStateValue } from '../core/state-machine/state.js';
import { calculateReady, ACTIVE_CAPACITY_STATES } from '../scheduler/ready.js';

export type WorkspaceServiceOptions = {
  db: DbConnection;
  projectDir: string;
  /** Injectable ShipGraph worktree root (tests use a temp directory). */
  worktreeRoot?: string;
  gitRunner?: GitRunner;
  now?: () => string;
  createEventId?: () => string;
};

export type WorkspaceCreateResult = {
  created: boolean;
  recovered: boolean;
  workspace: WorkspaceRecord;
  ticketState: TicketStateValue;
};

export type WorkspaceLiveState = {
  exists: boolean;
  repositoryValid: boolean;
  headSha?: string;
  branch?: string;
  clean?: boolean;
};

export type WorkspaceHealth = 'HEALTHY' | 'DRIFTED' | 'MISSING' | 'NEEDS_HUMAN';

export type WorkspaceInspectReport = {
  recorded: Pick<WorkspaceRecord, 'worktreePath' | 'branchName' | 'baseSha' | 'status'>;
  live: WorkspaceLiveState;
  health: WorkspaceHealth;
};

export type WorkspaceRemoveResult = {
  removed: true;
  ticketId: string;
  workspaceId: string;
  branchRetained: boolean;
};

const CONCURRENT_CREATION_POLL_MS = 50;
const CONCURRENT_CREATION_TIMEOUT_MS = 15_000;

function defaults(options: WorkspaceServiceOptions): {
  runner: GitRunner;
  now: () => string;
  createEventId: () => string;
} {
  return {
    runner: options.gitRunner ?? createGitRunner(),
    now: options.now ?? (() => new Date().toISOString()),
    createEventId: options.createEventId ?? randomUUID,
  };
}

/**
 * Canonicalize a worktree-root candidate WITHOUT creating anything: missing
 * tail segments are appended to the deepest existing ancestor's real path.
 * Callers can therefore validate containment before any directory is written.
 */
function canonicalizeRootPath(candidate: string): string {
  const segments: string[] = [];
  let existing = candidate;
  for (;;) {
    if (existsSync(existing)) break;
    const parent = dirname(existing);
    if (parent === existing) break;
    segments.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...segments);
}

/**
 * Resolve the ShipGraph-owned worktree root. The default lives outside any
 * repository at ~/.shipgraph/worktrees. Tests inject a temporary root.
 *
 * When `outsideOf` is provided, containment is enforced against the
 * canonical path BEFORE any directory is created, so a failed attempt can
 * never leave new directories inside the source repository — even when the
 * candidate path travels through symlinks.
 */
export function resolveWorktreeRoot(override?: string, outsideOf?: string): string {
  const candidate = override ?? join(homedir(), '.shipgraph', 'worktrees');
  const existing = tryLstatSync(candidate);
  if (existing?.isSymbolicLink()) {
    throw new Error(`Refusing to use symbolic link for ShipGraph worktree root: ${candidate}`);
  }
  if (existing && !existing.isDirectory()) {
    throw new Error(`ShipGraph worktree root is not a directory: ${candidate}`);
  }
  const canonicalCandidate =
    existing !== undefined ? realpathSync(candidate) : canonicalizeRootPath(candidate);
  if (outsideOf !== undefined) {
    assertRootOutsideProject(canonicalCandidate, outsideOf);
  }
  if (!existsSync(canonicalCandidate)) {
    // Containment was already validated against the canonical path; create
    // the remaining segments recursively.
    mkdirSync(canonicalCandidate, { recursive: true, mode: 0o700 });
  }
  ensureOwnedDirectoryChain(canonicalCandidate);
  return realpathSync(canonicalCandidate);
}

type ProjectContext = {
  projectId: string;
  canonicalProjectDir: string;
  maxConcurrentTickets: number;
};

/**
 * Ticket worktrees must live outside the source repository. Enforce mutual
 * non-containment (including exact equality) so neither a caller-supplied
 * root inside the checkout nor the repository nested under a root is
 * possible.
 */
function assertRootOutsideProject(worktreeRoot: string, canonicalProjectDir: string): void {
  const contained = (parent: string, child: string): boolean => {
    if (parent === child) return true;
    const childFromParent = relative(parent, child);
    return !childFromParent.startsWith('..') && !isAbsolute(childFromParent);
  };
  if (contained(canonicalProjectDir, worktreeRoot) || contained(worktreeRoot, canonicalProjectDir)) {
    throw new Error(
      `ShipGraph worktree root ${worktreeRoot} must be outside the source repository ` +
        `${canonicalProjectDir}`
    );
  }
}

/** Validate the common project/state boundary and the single-project invariant. */
function resolveProjectContext(options: WorkspaceServiceOptions): ProjectContext {
  const canonicalProjectDir = realpathSync(options.projectDir);
  assertSafeShipgraphPaths(canonicalProjectDir);
  const config = loadConfig(canonicalProjectDir);
  const projects = createProjectRepository(options.db).findAll();
  if (projects.length !== 1) {
    throw new Error(
      projects.length === 0
        ? 'No initialized ShipGraph project found. Run `shipgraph init` first.'
        : 'ShipGraph project database must contain exactly one project'
    );
  }
  const project = projects[0];
  if (!persistedProjectMatchesConfig(project, config)) {
    throw new Error(
      'shipgraph.yml does not match the project identity/config stored in .shipgraph/shipgraph.db'
    );
  }
  return {
    projectId: project.id,
    canonicalProjectDir,
    maxConcurrentTickets: config.execution.maxConcurrentTickets,
  };
}

/**
 * Enforce WORK-001 eligibility using CORE-002 scheduler logic only:
 * approved backlog membership + ELIGIBLE state + dependency validity +
 * dispatchability under current capacity.
 */
function assertTicketDispatchable(
  options: WorkspaceServiceOptions,
  context: ProjectContext,
  ticketIdInput: string
): void {
  assertSafeTicketId(ticketIdInput);
  const tickets = createTicketRepository(options.db).findApprovedByProjectId(
    context.projectId
  );
  const ticket = tickets.find((candidate) => candidate.id === ticketIdInput);
  if (!ticket) {
    throw new Error(
      `Ticket ${ticketIdInput} does not belong to the approved backlog of this project`
    );
  }
  if (ticket.status !== TicketState.ELIGIBLE) {
    throw new Error(
      `Ticket ${ticketIdInput} has state ${ticket.status}; workspaces can only be created for ELIGIBLE tickets`
    );
  }
  const ready = calculateReady(tickets, context.maxConcurrentTickets);
  if (!ready.eligible.some((entry) => entry.ticket === ticketIdInput)) {
    throw new Error(`Ticket ${ticketIdInput} is not currently dependency-valid`);
  }
  if (!ready.dispatchable.some((entry) => entry.ticket === ticketIdInput)) {
    throw new Error(
      `Dispatch capacity is full (${ready.capacity.active}/${context.maxConcurrentTickets} active); ` +
        `no workspace was created for ${ticketIdInput}`
    );
  }
}

/**
 * Re-validate dispatchability INSIDE the reservation transaction and claim
 * capacity by counting active workspaces. SQLite serializes immediate
 * transactions, so two concurrent creations of different tickets can never
 * both pass this check when capacity is exhausted.
 */
function assertDispatchableAndClaimCapacityInTx(
  options: WorkspaceServiceOptions,
  context: ProjectContext,
  ticketIdInput: string
): void {
  const tickets = createTicketRepository(options.db).findApprovedByProjectId(
    context.projectId
  );
  const ticket = tickets.find((candidate) => candidate.id === ticketIdInput);
  if (!ticket || ticket.status !== TicketState.ELIGIBLE) {
    throw new Error(
      `Ticket ${ticketIdInput} is no longer ELIGIBLE; workspace was not reserved`
    );
  }
  const ready = calculateReady(tickets, context.maxConcurrentTickets);
  if (!ready.eligible.some((entry) => entry.ticket === ticketIdInput)) {
    throw new Error(
      `Ticket ${ticketIdInput} is not currently dependency-valid; workspace was not reserved`
    );
  }
  // Capacity accounting without double counting:
  // - activeCapacityStates: persisted ticket states that consume CORE-002
  //   capacity (PLANNING and beyond).
  // - claimedNotTransitioned: workspaces reserved (CREATING/READY/NEEDS_HUMAN)
  //   whose tickets have NOT yet transitioned (still ELIGIBLE/QUEUED) — these
  //   are claims held by concurrent or crashed creators.
  const activeCapacityPlaceholders = ACTIVE_CAPACITY_STATES.map(() => '?').join(', ');
  const claimedRow = options.db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM workspaces w
       LEFT JOIN tickets t ON t.id = w.ticket_id
       WHERE w.project_id = ?
         AND w.status IN ('CREATING', 'READY', 'NEEDS_HUMAN')
         AND (t.id IS NULL OR t.status IS NULL OR t.status NOT IN (${activeCapacityPlaceholders}))`
    )
    .get(context.projectId, ...ACTIVE_CAPACITY_STATES) as { n: number };
  const effectiveAvailable =
    context.maxConcurrentTickets - ready.capacity.active - claimedRow.n;
  if (effectiveAvailable <= 0) {
    throw new Error(
      `Dispatch capacity is full (${ready.capacity.active} active + ${claimedRow.n} claimed / ` +
        `${context.maxConcurrentTickets}); no workspace was reserved for ${ticketIdInput}`
    );
  }
}

/** Validate the source repository before anything is reserved or created. */
async function resolveSourceRepository(
  runner: GitRunner,
  context: ProjectContext,
  defaultBranch: string
): Promise<{ sourceRepositoryPath: string; baseSha: string }> {
  if (!(await isInsideWorkTree(runner, context.canonicalProjectDir))) {
    throw new Error(`${context.canonicalProjectDir} is not a Git working tree`);
  }
  const topLevel = await gitTopLevel(runner, context.canonicalProjectDir);
  const canonicalTopLevel = topLevel !== undefined ? realpathSync(topLevel) : undefined;
  if (canonicalTopLevel === undefined) {
    throw new Error('Could not resolve the Git top-level directory');
  }
  if (canonicalTopLevel !== context.canonicalProjectDir) {
    throw new Error(
      `Git top-level ${canonicalTopLevel} does not match the ShipGraph project directory ` +
        `${context.canonicalProjectDir}; refusing to operate against the wrong repository`
    );
  }
  const baseSha = await resolveCommitSha(runner, canonicalTopLevel, defaultBranch);
  if (!baseSha) {
    throw new Error(
      `Configured default branch "${defaultBranch}" does not resolve locally; ` +
        `WORK-001 never fetches remotes`
    );
  }
  return { sourceRepositoryPath: canonicalTopLevel, baseSha };
}

/**
 * Verify repository provenance: once a project has ever recorded a
 * workspace, its source repository is bound. Copied metadata dropped into a
 * different repository fails closed instead of silently operating against
 * the wrong checkout. (A pristine metadata set that has never been used has
 * no binding to compare against; its first workspace creation establishes
 * the binding.)
 */
function assertRepositoryProvenance(
  options: WorkspaceServiceOptions,
  projectId: string,
  canonicalTopLevel: string
): void {
  const rows = options.db
    .prepare(
      'SELECT DISTINCT source_repository_path FROM workspaces WHERE project_id = ?'
    )
    .all(projectId) as Array<{ source_repository_path: string }>;
  if (rows.length === 0) return;
  // Fail closed on ANY non-matching row: mixed-repository metadata must never
  // allow workspace creation against either repository.
  const mismatched = rows.filter(
    (row) => realpathSync(row.source_repository_path) !== canonicalTopLevel
  );
  if (mismatched.length > 0) {
    throw new Error(
      `ShipGraph project has workspace records bound to a different source repository ` +
        `(${mismatched.map((row) => row.source_repository_path).join(', ')}); ` +
        `refusing to operate against ${canonicalTopLevel}`
    );
  }
}

/**
 * Independent immutable validation for destructive operations: the
 * append-only workspace.creating event for THIS workspace records the base
 * SHA at reservation time. A tampered or drifted row.base_sha can never pass
 * as the deletion selector while its creation audit trail disagrees — and a
 * missing/malformed audit trail fails closed rather than open.
 */
function recordedCreationBaseSha(
  options: WorkspaceServiceOptions,
  projectId: string,
  workspaceId: string,
  ticketId: string
): { baseSha?: string; error?: string } {
  const rows = options.db
    .prepare(
      `SELECT payload_json FROM events
       WHERE project_id = ? AND ticket_id = ? AND type = 'workspace.creating'
       ORDER BY sequence ASC`
    )
    .all(projectId, ticketId) as Array<{ payload_json?: string }>;
  if (rows.length === 0) {
    return {
      error:
        'No append-only workspace.creating audit event exists for this ticket; ' +
        'refusing destructive operations without immutable provenance',
    };
  }
  let matched: string | undefined;
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json ?? '') as {
        workspaceId?: unknown;
        baseSha?: unknown;
      };
      if (payload.workspaceId !== workspaceId) continue;
      if (typeof payload.baseSha !== 'string' || payload.baseSha.length === 0) {
        return { error: 'creation audit event is malformed (baseSha missing)' };
      }
      if (matched !== undefined && matched !== payload.baseSha) {
        return { error: 'conflicting creation audit events for this workspace' };
      }
      matched = payload.baseSha;
    } catch {
      return { error: 'creation audit event is malformed (unparsable payload)' };
    }
  }
  if (matched === undefined) {
    return {
      error: 'No workspace.creating audit event references this workspace id; ' +
        'refusing destructive operations without immutable provenance',
    };
  }
  return { baseSha: matched };
}

function workspacePayload(row: WorkspaceRecord) {
  return {
    workspaceId: row.id,
    ticketId: row.ticketId,
    baseSha: row.baseSha,
    branchName: row.branchName,
    worktreePath: row.worktreePath,
  };
}

/** Reserve the workspace as CREATING together with its audit event. */
function reserveWorkspace(
  options: WorkspaceServiceOptions,
  context: ProjectContext,
  row: WorkspaceRecord
): WorkspaceRecord {
  const timestamp = options.now ? options.now() : new Date().toISOString();
  const createEventId = options.createEventId ?? randomUUID;
  const reserve = options.db.transaction((): WorkspaceRecord => {
    // Claim capacity atomically: immediate transactions serialize concurrent
    // creators, so the count below cannot be observed stale.
    assertDispatchableAndClaimCapacityInTx(options, context, row.ticketId);
    const inserted = createWorkspaceRepository(options.db).insert({ ...row });
    const payload: WorkspaceCreatingPayload = workspacePayload(inserted);
    createEventRepository(options.db).append({
      id: createEventId(),
      timestamp,
      projectId: inserted.projectId,
      ticketId: inserted.ticketId,
      type: EventType.WORKSPACE_CREATING,
      payload,
    });
    return inserted;
  }).immediate;
  return reserve();
}

/**
 * Finalize READY + ELIGIBLE→PLANNING + audit metadata inside one database
 * boundary. If the ticket transition cannot be recorded, the workspace is
 * never reported READY.
 */
function finalizeReadyWorkspace(
  options: WorkspaceServiceOptions,
  row: WorkspaceRecord
): { workspace: WorkspaceRecord; ticketState: TicketStateValue } {
  const timestamp = options.now ? options.now() : new Date().toISOString();
  const createEventId = options.createEventId ?? randomUUID;
  const finalize = options.db.transaction(() => {
    const updated = createWorkspaceRepository(options.db).updateStatus(
      row.id,
      'READY',
      timestamp,
      ['CREATING']
    );
    if (!updated) {
      throw new Error(`Workspace ${row.id} could not be finalized: reservation no longer CREATING`);
    }
    const payload: WorkspaceReadyPayload = workspacePayload(updated);
    createEventRepository(options.db).append({
      id: createEventId(),
      timestamp,
      projectId: updated.projectId,
      ticketId: updated.ticketId,
      type: EventType.WORKSPACE_READY,
      payload,
    });
    persistTicketTransition(
      options.db,
      {
        ticketId: updated.ticketId,
        projectId: updated.projectId,
        next: TicketState.PLANNING,
        reason: `workspace ${updated.id} ready at ${updated.worktreePath}`,
      },
      { createEventId, now: options.now }
    );
    return updated;
  }).immediate;
  const workspace = finalize();
  return { workspace, ticketState: TicketState.PLANNING };
}

/** Record a terminal status change with its audit event. */
function markWorkspaceStatus(
  options: WorkspaceServiceOptions,
  row: WorkspaceRecord,
  status: Extract<WorkspaceStatus, 'FAILED' | 'NEEDS_HUMAN' | 'REMOVED'>,
  reason: string,
  extra: Partial<WorkspaceFailedPayload & WorkspaceRemovedPayload> = {}
): WorkspaceRecord | undefined {
  const timestamp = options.now ? options.now() : new Date().toISOString();
  const createEventId = options.createEventId ?? randomUUID;
  const apply = options.db.transaction((): WorkspaceRecord | undefined => {
    const updated = createWorkspaceRepository(options.db).updateStatus(
      row.id,
      status,
      timestamp,
      [status === 'REMOVED' ? 'READY' : 'CREATING']
    );
    if (!updated) return undefined;
    if (status === 'REMOVED') {
      const payload: WorkspaceRemovedPayload = { ...workspacePayload(updated), reason, ...extra };
      createEventRepository(options.db).append({
        id: createEventId(),
        timestamp,
        projectId: updated.projectId,
        ticketId: updated.ticketId,
        type: EventType.WORKSPACE_REMOVED,
        payload,
      });
    } else {
      const payload: WorkspaceFailedPayload = {
        ...workspacePayload(updated),
        reason,
        escalatedToHuman: status === 'NEEDS_HUMAN',
        ...extra,
      };
      createEventRepository(options.db).append({
        id: createEventId(),
        timestamp,
        projectId: updated.projectId,
        ticketId: updated.ticketId,
        type: EventType.WORKSPACE_FAILED,
        payload,
      });
    }
    return updated;
  }).immediate;
  return apply();
}

/**
 * Prove freshly created resources belong to this exact reservation and hold
 * nothing beyond the base commit; then roll them back. Called only while the
 * reservation is still CREATING and only after our own `git worktree add`
 * succeeded, so the resources were provably created by this process.
 */
/**
 * Roll back freshly created resources after a failed creation.
 *
 * Exclusive cleanup rights are claimed with a compare-and-set transition
 * (CREATING → FAILED) inside SQLite. Only the process that wins that CAS may
 * delete: a concurrent invocation that finalized the reservation to READY
 * first makes the CAS fail, so its resources are never touched by the loser.
 * The proof runs BEFORE the claim; deletion follows the winning claim, at
 * which point no other process can finalize anymore.
 */
async function compensateCreation(
  options: WorkspaceServiceOptions,
  runner: GitRunner,
  row: WorkspaceRecord,
  reason: string
): Promise<void> {
  const provablyOurs = await creationBelongsToReservation(runner, row);
  if (!provablyOurs) {
    markWorkspaceStatus(
      options,
      row,
      'NEEDS_HUMAN',
      `${reason}; unproven workspace state was preserved for human inspection`,
      { escalatedToHuman: true }
    );
    return;
  }
  // Claim exclusive cleanup rights; losing means another process owns the
  // reservation now and this process must not delete anything.
  const claimed = markWorkspaceStatus(options, row, 'FAILED', reason);
  if (!claimed) return;
  try {
    await removeWorktree(runner, row.sourceRepositoryPath, row.worktreePath);
    // Compare-and-delete on the ref itself: the deletion only lands while
    // the branch still points exactly at the recorded base SHA, and only
    // when no other worktree is using the branch.
    const otherWorktrees = await findOtherWorktreesUsingBranch(
      runner,
      row.sourceRepositoryPath,
      row.branchName,
      row.worktreePath
    );
    if (otherWorktrees.length === 0) {
      await deleteBranchIfAt(runner, row.sourceRepositoryPath, row.branchName, row.baseSha);
    }
  } catch (cleanupError) {
    // The reservation is already FAILED; preserved leftovers are surfaced as
    // DRIFTED by `workspace inspect` for human resolution.
    void cleanupError;
  }
}

async function creationBelongsToReservation(
  runner: GitRunner,
  row: WorkspaceRecord
): Promise<boolean> {
  try {
    const stats = tryLstatSync(row.worktreePath);
    if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) return false;
    if (realpathSync(row.worktreePath) !== row.worktreePath) return false;
    const live = await inspectWorktreeState(runner, row.sourceRepositoryPath, row.worktreePath);
    if (
      !live.registered ||
      live.head !== row.baseSha ||
      live.branch !== `refs/heads/${row.branchName}` ||
      live.clean !== true
    ) {
      return false;
    }
    // Deletion must never destroy untracked or ignored content either.
    return isStrictlyClean(runner, row.worktreePath);
  } catch {
    return false;
  }
}

/** All READY-validation invariants. Fail closed on any mismatch. */
async function verifyReadyWorkspace(
  runner: GitRunner,
  row: WorkspaceRecord,
  worktreeRoot: string
): Promise<void> {
  // Deterministic derivation must reproduce the recorded identity exactly.
  if (deriveBranchName(row.ticketId) !== row.branchName) {
    throw new Error(`Recorded branch ${row.branchName} is not deterministically derived`);
  }
  if (deriveWorktreePath(worktreeRoot, row.projectId, row.ticketId) !== row.worktreePath) {
    throw new Error(
      `Recorded worktree path ${row.worktreePath} escapes or deviates from the ShipGraph root`
    );
  }
  const stats = tryLstatSync(row.worktreePath);
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Workspace path is missing or not a plain directory: ${row.worktreePath}`);
  }
  if (realpathSync(row.worktreePath) !== row.worktreePath) {
    throw new Error(`Workspace path resolves through a symlink: ${row.worktreePath}`);
  }
  const live = await inspectWorktreeState(runner, row.sourceRepositoryPath, row.worktreePath);
  if (!live.registered) {
    throw new Error(`Path is not a registered Git worktree: ${row.worktreePath}`);
  }
  if (live.head !== row.baseSha) {
    throw new Error(
      `Worktree HEAD ${live.head ?? '<unknown>'} does not equal recorded base SHA ${row.baseSha}`
    );
  }
  if (live.branch !== `refs/heads/${row.branchName}`) {
    throw new Error(
      `Checked-out branch ${live.branch ?? '<detached>'} does not equal ${row.branchName}`
    );
  }
  if (live.clean !== true) {
    throw new Error(`New worktree is not clean: ${row.worktreePath}`);
  }
}

async function waitForActiveResolution(
  repository: ReturnType<typeof createWorkspaceRepository>,
  projectId: string,
  ticketIdInput: string
): Promise<WorkspaceRecord> {
  const timeoutMs = Number(
    process.env.SHIPGRAPH_CREATION_POLL_TIMEOUT_MS ?? CONCURRENT_CREATION_TIMEOUT_MS
  );
  const deadline = Date.now() + timeoutMs;
  let row = repository.findActiveByTicket(projectId, ticketIdInput);
  while (row?.status === 'CREATING' && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, CONCURRENT_CREATION_POLL_MS));
    row = repository.findActiveByTicket(projectId, ticketIdInput);
  }
  if (!row) {
    throw new Error(`Workspace reservation for ${ticketIdInput} disappeared unexpectedly`);
  }
  return row;
}

/**
 * Restart-safe recovery for a persisted CREATING reservation.
 *
 * When the filesystem/git state proves the reservation (exact deterministic
 * path exists as a plain directory, registered worktree of the right
 * repository, matching dedicated branch, HEAD == recorded base SHA, clean)
 * the reservation is safely finalized. Any mismatch fails closed into
 * NEEDS_HUMAN. Ambiguous state is never deleted automatically.
 */
async function recoverCreatingReservation(
  options: WorkspaceServiceOptions,
  row: WorkspaceRecord,
  worktreeRoot: string
): Promise<WorkspaceCreateResult> {
  const { runner } = defaults(options);
  try {
    await verifyReadyWorkspace(runner, row, worktreeRoot);
  } catch (error) {
    markWorkspaceStatus(
      options,
      row,
      'NEEDS_HUMAN',
      `CREATING reservation does not match verified reality: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { escalatedToHuman: true }
    );
    throw new Error(
      `Stale CREATING reservation for ticket ${row.ticketId} requires human inspection ` +
        `(workspace ${row.id}); no automatic cleanup was performed`
    );
  }

  try {
    const result = finalizeReadyWorkspace(options, row);
    return {
      created: false,
      recovered: true,
      workspace: result.workspace,
      ticketState: result.ticketState,
    };
  } catch (error) {
    markWorkspaceStatus(
      options,
      row,
      'NEEDS_HUMAN',
      `Recovery could not finalize the reservation or transition the ticket: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { escalatedToHuman: true }
    );
    throw error;
  }
}

/** Handle a pre-existing active reservation (READY idempotency / recovery). */
async function reconcileWithExistingRow(
  options: WorkspaceServiceOptions,
  row: WorkspaceRecord,
  worktreeRoot: string,
  canonicalProjectDir: string
): Promise<WorkspaceCreateResult> {
  if (row.sourceRepositoryPath !== canonicalProjectDir) {
    throw new Error(
      `Existing workspace ${row.id} belongs to another source repository (${row.sourceRepositoryPath})`
    );
  }
  switch (row.status) {
    case 'READY': {
      const { runner } = defaults(options);
      try {
        await verifyReadyWorkspace(runner, row, worktreeRoot);
      } catch (error) {
        throw new Error(
          `Existing workspace for ticket ${row.ticketId} is not healthy: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      // Report the ticket's actual persisted state rather than assuming.
      const ticket = createTicketRepository(options.db).findById(row.ticketId);
      return {
        created: false,
        recovered: false,
        workspace: row,
        ticketState: ticket?.status ?? TicketState.PLANNING,
      };
    }
    case 'CREATING': {
      // Another process may be mid-creation. Wait for it to reach a terminal
      // status before treating the reservation as stale; only then recover.
      const repository = createWorkspaceRepository(options.db);
      const resolved = await waitForActiveResolution(repository, row.projectId, row.ticketId);
      if (resolved.status === 'READY') {
        return reconcileWithExistingRow(options, resolved, worktreeRoot, canonicalProjectDir);
      }
      if (resolved.status === 'CREATING') {
        return recoverCreatingReservation(options, resolved, worktreeRoot);
      }
      throw new Error(
        `Ticket ${row.ticketId} has a conflicting ${resolved.status} workspace (${resolved.id}); failing closed`
      );
    }
    case 'NEEDS_HUMAN':
    case 'FAILED':
    case 'REMOVED':
    default:
      throw new Error(
        `Ticket ${row.ticketId} has a conflicting ${row.status} workspace (${row.id}); failing closed`
      );
  }
}

/**
 * Create (or idempotently return / safely recover) the isolated workspace of
 * one dispatchable eligible ticket.
 *
 * Sequence: validate → prove dispatchable → resolve exact base SHA → derive
 * branch/path → reserve CREATING → create git resources → verify → finalize
 * READY + PLANNING. Failures inside this process are compensated only when
 * provably safe; otherwise they escalate to NEEDS_HUMAN.
 */
export async function createWorkspace(
  options: WorkspaceServiceOptions,
  ticketIdInput: string,
  internal: { crashAfterReserve?: boolean } = {}
): Promise<WorkspaceCreateResult> {
  const { runner, now } = defaults(options);
  const context = resolveProjectContext(options);
  assertSafeTicketId(ticketIdInput);

  const project = createProjectRepository(options.db).findAll()[0];
  const { sourceRepositoryPath, baseSha } = await resolveSourceRepository(
    runner,
    context,
    project.defaultBranch
  );
  assertRepositoryProvenance(options, context.projectId, sourceRepositoryPath);

  const branchName = deriveBranchName(ticketIdInput);
  if (!(await isBranchNameValid(runner, sourceRepositoryPath, branchName))) {
    throw new Error(`Derived branch name failed git check-ref-format: ${branchName}`);
  }
  // Containment is enforced BEFORE the root is created so a failed attempt
  // can never write inside the source repository — even through symlinks.
  const worktreeRoot = resolveWorktreeRoot(options.worktreeRoot, context.canonicalProjectDir);
  assertRootOutsideProject(worktreeRoot, context.canonicalProjectDir);
  // Verify/create the project segment of the owned chain without ever
  // following symlinks (<root>/<project-id>).
  ensureOwnedDirectoryChain(worktreeRoot, context.projectId);
  const worktreePath = deriveWorktreePath(worktreeRoot, context.projectId, ticketIdInput);

  // An existing active reservation always takes precedence: it enables
  // idempotent returns and restart-safe recovery before any new work.
  const repository = createWorkspaceRepository(options.db);
  const existingRow = repository.findActiveByTicket(context.projectId, ticketIdInput);
  if (existingRow !== undefined) {
    return reconcileWithExistingRow(
      options,
      existingRow,
      worktreeRoot,
      context.canonicalProjectDir
    );
  }

  // Fresh creations require full WORK-001 eligibility.
  assertTicketDispatchable(options, context, ticketIdInput);

  // Pre-flight conflicts at the exact filesystem location can never be adopted.
  const preExisting = tryLstatSync(worktreePath);
  if (preExisting) {
    throw new Error(`Conflicting pre-existing path at the workspace location: ${worktreePath}`);
  }

  // A pre-existing branch without an active ShipGraph claim is never reused,
  // reset or deleted.
  const existingBranchSha = await resolveCommitSha(
    runner,
    sourceRepositoryPath,
    `refs/heads/${branchName}`
  );
  if (existingBranchSha !== undefined) {
    throw new Error(
      `Branch ${branchName} already exists and is not claimed by a ShipGraph workspace; ` +
        `refusing to reuse, reset or delete it`
    );
  }

  let row: WorkspaceRecord;
  try {
    row = reserveWorkspace(options, context, {
      id: randomUUID().replace(/-/g, ''),
      projectId: context.projectId,
      ticketId: ticketIdInput,
      sourceRepositoryPath,
      worktreePath,
      branchName,
      baseSha,
      status: 'CREATING',
      createdAt: now(),
      updatedAt: now(),
    });
  } catch (reservationError) {
    // Lost the race against a concurrent creator: converge on their
    // reservation instead of duplicating any resources.
    const racedRow = repository.findActiveByTicket(context.projectId, ticketIdInput);
    if (racedRow === undefined) throw reservationError;
    return reconcileWithExistingRow(
      options,
      racedRow,
      worktreeRoot,
      context.canonicalProjectDir
    );
  }

  if (internal.crashAfterReserve) {
    // Simulated crash: persisted reservation exists, no git work happened yet.
    throw new Error(`Simulated crash after reserving workspace ${row.id}`);
  }

  // Track whether OUR git command created the resources. Deletion during
  // compensation is only ever applied to resources this process provably
  // created; a failed `git worktree add` leaves nothing of ours behind.
  let gitResourcesCreated = false;
  try {
    // Final pre-flight: the reservation window is the last chance for a
    // concurrent process to plant a conflicting path.
    if (tryLstatSync(worktreePath)) {
      throw new Error(
        `Conflicting path appeared at the workspace location before creation: ${worktreePath}`
      );
    }
    await addWorktreeWithNewBranch(
      runner,
      sourceRepositoryPath,
      worktreePath,
      branchName,
      baseSha
    );
    gitResourcesCreated = true;
    await verifyReadyWorkspace(runner, row, worktreeRoot);
    const result = finalizeReadyWorkspace(options, row);
    return {
      created: true,
      recovered: false,
      workspace: result.workspace,
      ticketState: result.ticketState,
    };
  } catch (creationError) {
    const reason =
      creationError instanceof Error ? creationError.message : String(creationError);
    if (!gitResourcesCreated) {
      // Nothing was created by us; record the failure without deleting
      // anything that could belong to someone else.
      markWorkspaceStatus(options, row, 'FAILED', reason);
      throw creationError;
    }
    await compensateCreation(options, runner, row, reason);
    throw creationError;
  }
}

// ---------------------------------------------------------------------------
// Inspect / list / remove (read-only except remove)
// ---------------------------------------------------------------------------

export async function inspectWorkspace(
  options: WorkspaceServiceOptions,
  ticketIdInput: string
): Promise<WorkspaceInspectReport> {
  const { runner } = defaults(options);
  assertSafeTicketId(ticketIdInput);
  const context = resolveProjectContext(options);
  const repository = createWorkspaceRepository(options.db);
  const history = repository.findByTicket(context.projectId, ticketIdInput);
  const row =
    repository.findActiveByTicket(context.projectId, ticketIdInput) ??
    history[history.length - 1];
  if (!row) {
    throw new Error(`No ShipGraph workspace found for ticket ${ticketIdInput}`);
  }
  // Read-only does not mean cross-repository: refuse to report on workspaces
  // recorded against a different source repository than the invocation's.
  if (row.sourceRepositoryPath !== context.canonicalProjectDir) {
    throw new Error(
      `Workspace ${row.id} belongs to source repository ${row.sourceRepositoryPath}, ` +
        `not the current project directory`
    );
  }
  // Deterministic identity must reproduce the recorded path/branch, so a
  // tampered row cannot redirect inspection at an arbitrary worktree.
  if (deriveBranchName(row.ticketId) !== row.branchName) {
    throw new Error(
      `Recorded branch ${row.branchName} is not the deterministic branch of ticket ${row.ticketId}`
    );
  }
  const expectedInspectPath = deriveWorktreePath(
    resolveWorktreeRoot(options.worktreeRoot, context.canonicalProjectDir),
    context.projectId,
    row.ticketId
  );
  if (expectedInspectPath !== row.worktreePath) {
    throw new Error(
      `Recorded worktree path ${row.worktreePath} is not the deterministic location for ` +
        `ticket ${row.ticketId}; refusing inspection`
    );
  }

  const stats = tryLstatSync(row.worktreePath);
  const exists = stats !== undefined && !stats.isSymbolicLink() && stats.isDirectory();
  let live: WorkspaceLiveState = { exists, repositoryValid: false };
  if (exists) {
    try {
      const state = await inspectWorktreeState(runner, row.sourceRepositoryPath, row.worktreePath);
      live = {
        exists: true,
        repositoryValid: state.registered,
        headSha: state.head,
        branch: state.branch,
        clean: state.clean,
      };
    } catch {
      live = { exists: true, repositoryValid: false };
    }
  }

  return {
    recorded: {
      worktreePath: row.worktreePath,
      branchName: row.branchName,
      baseSha: row.baseSha,
      status: row.status,
    },
    live,
    health: computeHealth(row.status, live, row),
  };
}

function computeHealth(
  status: WorkspaceStatus,
  live: WorkspaceLiveState,
  row: WorkspaceRecord
): WorkspaceHealth {
  if (status === 'CREATING' || status === 'NEEDS_HUMAN') return 'NEEDS_HUMAN';
  if (status === 'REMOVED' || status === 'FAILED') {
    return live.exists ? 'DRIFTED' : 'MISSING';
  }
  // READY
  if (!live.exists) return 'MISSING';
  const healthy =
    live.repositoryValid &&
    live.headSha === row.baseSha &&
    live.branch === `refs/heads/${row.branchName}` &&
    live.clean === true;
  return healthy ? 'HEALTHY' : 'DRIFTED';
}

/** List workspaces of the current project only, ordered by ticket id. */
export function listWorkspacesForProject(
  options: WorkspaceServiceOptions
): readonly WorkspaceRecord[] {
  const context = resolveProjectContext(options);
  // Fail closed when invoked from a checkout that does not match the
  // recorded source repository: listing another repository's workspaces from
  // here would only confuse operators.
  const rows = createWorkspaceRepository(options.db).listByProject(context.projectId);
  for (const row of rows) {
    if (row.sourceRepositoryPath !== context.canonicalProjectDir) {
      throw new Error(
        `Workspace ${row.id} for ticket ${row.ticketId} belongs to source repository ` +
          `${row.sourceRepositoryPath}, not the current project directory`
      );
    }
  }
  return rows;
}

/**
 * Conservatively remove a clean READY workspace. Dirty or ambiguous
 * workspaces are refused; there is deliberately no force option.
 *
 * The dedicated branch is deleted only when it provably still points exactly
 * at the recorded base SHA (no unique work). Otherwise it is retained.
 */
export async function removeWorkspace(
  options: WorkspaceServiceOptions,
  ticketIdInput: string
): Promise<WorkspaceRemoveResult> {
  const { runner } = defaults(options);
  assertSafeTicketId(ticketIdInput);
  const context = resolveProjectContext(options);
  const repository = createWorkspaceRepository(options.db);
  const row = repository.findActiveByTicket(context.projectId, ticketIdInput);
  if (!row) {
    throw new Error(`No active ShipGraph workspace found for ticket ${ticketIdInput}`);
  }
  if (row.status !== 'READY') {
    throw new Error(
      `Workspace ${row.id} for ticket ${ticketIdInput} is ${row.status}; removal requires a READY workspace`
    );
  }
  // Re-derive identity from the ticket id: a tampered row must not redirect
  // destructive operations at an arbitrary branch.
  if (deriveBranchName(row.ticketId) !== row.branchName) {
    throw new Error(
      `Recorded branch ${row.branchName} is not the deterministic branch of ticket ${row.ticketId}; refusing removal`
    );
  }
  if (row.sourceRepositoryPath !== context.canonicalProjectDir) {
    throw new Error(
      `Workspace ${row.id} belongs to source repository ${row.sourceRepositoryPath}, ` +
        `not the current project directory`
    );
  }
  // The recorded path must be exactly the deterministic location under the
  // current ShipGraph worktree root, with no symlink components anywhere.
  const worktreeRoot = resolveWorktreeRoot(options.worktreeRoot, context.canonicalProjectDir);
  assertRootOutsideProject(worktreeRoot, context.canonicalProjectDir);
  const expectedPath = deriveWorktreePath(worktreeRoot, row.projectId, row.ticketId);
  if (row.worktreePath !== expectedPath) {
    throw new Error(
      `Persisted workspace path ${row.worktreePath} does not match the deterministic location ` +
        `${expectedPath}; refusing to remove`
    );
  }
  const stats = tryLstatSync(row.worktreePath);
  if (!stats) {
    throw new Error(`Workspace ${row.worktreePath} is missing on disk; refusing ambiguous removal`);
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Workspace path is a symlink: ${row.worktreePath}`);
  }
  if (realpathSync(row.worktreePath) !== row.worktreePath) {
    throw new Error(`Workspace path resolves through a symlink: ${row.worktreePath}`);
  }
  const live = await inspectWorktreeState(runner, row.sourceRepositoryPath, row.worktreePath);
  if (!live.registered) {
    throw new Error(
      `Workspace ${row.worktreePath} is not a registered Git worktree of the source repository`
    );
  }
  if (live.branch !== `refs/heads/${row.branchName}`) {
    throw new Error(
      `Workspace ${row.worktreePath} does not have the recorded branch ` +
        `${row.branchName} checked out (${live.branch ?? 'detached'}); refusing removal`
    );
  }
  if (live.clean !== true) {
    throw new Error(
      `Workspace ${row.worktreePath} is dirty; dirty worktrees are never removed by WORK-001`
    );
  }

  // Re-prove the invariants immediately before the destructive command so
  // the window for a swap between proof and deletion stays minimal.
  const finalLive = await inspectWorktreeState(runner, row.sourceRepositoryPath, row.worktreePath);
  if (
    !finalLive.registered ||
    finalLive.branch !== `refs/heads/${row.branchName}` ||
    finalLive.clean !== true
  ) {
    throw new Error(
      `Workspace ${row.worktreePath} changed during removal validation; refusing to remove`
    );
  }
  // Strict cleanliness including untracked and ignored files: removal must
  // never destroy anything a user (or a tool) left behind.
  if (!(await isStrictlyClean(runner, row.worktreePath))) {
    throw new Error(
      `Workspace ${row.worktreePath} contains untracked or ignored files; refusing removal`
    );
  }
  // Submodule contents live outside the superproject's cleanliness proof;
  // WORK-001 refuses to remove such worktrees rather than risk deleting
  // nested user data. Gitlinks are detected via the index (mode 160000), so
  // a missing .gitmodules cannot bypass this.
  if (await hasGitlinkEntries(runner, row.worktreePath)) {
    throw new Error(
      `Workspace ${row.worktreePath} contains submodule entries; ` +
        `WORK-001 does not remove submodule worktrees`
    );
  }
  if (existsSync(join(row.worktreePath, '.gitmodules'))) {
    throw new Error(
      `Workspace ${row.worktreePath} contains submodules (.gitmodules present); ` +
        `WORK-001 does not remove submodule worktrees`
    );
  }
  // The recorded base SHA is cross-checked against the append-only creation
  // event: a tampered or missing audit trail refuses destructive operations.
  const audit = recordedCreationBaseSha(options, context.projectId, row.id, ticketIdInput);
  if (audit.error !== undefined) {
    throw new Error(`${audit.error}; refusing removal`);
  }
  if (audit.baseSha !== row.baseSha) {
    throw new Error(
      `Recorded base SHA ${row.baseSha} drifted from the immutable creation event ` +
        `(${audit.baseSha}); refusing removal`
    );
  }

  await removeWorktree(runner, row.sourceRepositoryPath, row.worktreePath);

  // Branch deletion only when provably empty of unique work, enforced by an
  // atomic compare-and-delete: the ref is removed only while it still points
  // exactly at the recorded base SHA. The worktree must be gone first; git
  // refuses to delete a checked-out branch's worktree binding implicitly via
  // the failed update above otherwise.
  let branchRetained = true;
  // The branch must not be checked out in any OTHER registered worktree:
  // deleting a shared ref would corrupt that checkout's branch state.
  const otherWorktrees = await findOtherWorktreesUsingBranch(
    runner,
    row.sourceRepositoryPath,
    row.branchName,
    row.worktreePath
  );
  if (otherWorktrees.length === 0) {
    const deleted = await deleteBranchIfAt(
      runner,
      row.sourceRepositoryPath,
      row.branchName,
      row.baseSha
    );
    if (deleted) branchRetained = false;
  }

  const updated = markWorkspaceStatus(
    options,
    row,
    'REMOVED',
    'workspace removed by operator',
    { branchRetained }
  );
  if (!updated) {
    throw new Error(
      `Workspace removal completed on disk but persistence could not record REMOVED status; ` +
        `inspect the workspace and resolve manually`
    );
  }
  return { removed: true, ticketId: row.ticketId, workspaceId: row.id, branchRetained };
}
