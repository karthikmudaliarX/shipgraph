import type { DbConnection } from './db.js';
import type { ShipgraphConfig } from '../config/schema.js';
import type { TicketStateValue } from '../core/state-machine/state.js';
import { TicketState } from '../core/state-machine/state.js';
import {
  validateTicket,
  type TicketContract,
  type TicketPriority,
  type TicketRisk,
} from '../domain/ticket.js';
import { validateDependencyGraph } from '../domain/dependency-graph.js';
import { compareStableStrings } from '../utils/sorting.js';
import {
  eventSchema,
  type NewShipgraphEvent,
  type ShipgraphEvent,
} from '../events/event.js';
import {
  agentFailureCategorySchema,
  agentRunRecordSchema,
  normalizedAgentEvidenceSchema,
  reviewResultSchema,
  reviewTypeSchema,
  type AgentFailureCategory,
  type AgentRunRecord,
  type NormalizedAgentEvidence,
} from '../domain/agent-run.js';
import {
  modelProviderIdSchema,
  modelTaskTypeSchema,
  MODEL_PROVIDER_TO_AGENT_PROVIDER,
  type ModelProviderId,
  type ModelTaskType,
} from '../domain/model-provider.js';

export type ProjectRecord = {
  id: string;
  name: string;
  repository: string;
  defaultBranch: string;
  config: ShipgraphConfig;
  createdAt: string;
  updatedAt: string;
};

export type TicketRecord = TicketContract & {
  projectId: string;
  createdAt: string;
  updatedAt: string;
};

export type TicketDependencyRecord = {
  ticketId: string;
  dependsOnTicketId: string;
  createdAt: string;
};

export type RunRecord = {
  id: string;
  ticketId: string;
  baseSha: string;
  branchName: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  /** AGENT-001 fields are optional only for CORE-001 legacy rows. */
  projectId?: string;
  workspaceId?: string;
  workspacePath?: string;
  provider?: string;
  modelProviderId?: ModelProviderId;
  task?: ModelTaskType;
  model?: string;
  createdAt?: string;
  updatedAt?: string;
  providerSessionId?: string;
  providerProcessId?: number;
  exitCode?: number;
  terminationSignal?: string;
  timedOut?: boolean;
  cancelled?: boolean;
  failureCategory?: AgentFailureCategory;
  failureReason?: string;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  evidence?: NormalizedAgentEvidence;
  instructionsSha256?: string;
  safetyPolicySha256?: string;
  reviewType?: import('../domain/agent-run.js').ReviewType;
  reviewedSha?: string;
  reviewResult?: import('../domain/agent-run.js').ReviewResult;
  reviewFindings?: readonly string[];
  timeoutMs?: number;
};

export type RunUpdate = {
  startedAt?: string;
  completedAt?: string | null;
  updatedAt?: string;
  providerSessionId?: string | null;
  providerProcessId?: number | null;
  exitCode?: number | null;
  terminationSignal?: string | null;
  timedOut?: boolean;
  cancelled?: boolean;
  failureCategory?: AgentFailureCategory | null;
  failureReason?: string | null;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  evidence?: NormalizedAgentEvidence | null;
  reviewResult?: import('../domain/agent-run.js').ReviewResult | null;
  reviewFindings?: readonly string[] | null;
};

export type WorkspaceStatus = 'CREATING' | 'READY' | 'REMOVED' | 'FAILED' | 'NEEDS_HUMAN';

/** Statuses that claim the ticket's single active workspace slot. */
export const ACTIVE_WORKSPACE_STATUSES: readonly WorkspaceStatus[] = [
  'CREATING',
  'READY',
  'NEEDS_HUMAN',
];

export type WorkspaceRecord = {
  id: string;
  projectId: string;
  ticketId: string;
  sourceRepositoryPath: string;
  worktreePath: string;
  branchName: string;
  baseSha: string;
  status: WorkspaceStatus;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceRepositoryBinding = {
  projectId: string;
  sourceRepositoryPath: string;
  sourceDirectoryDevice: string;
  sourceDirectoryInode: string;
  gitCommonDir: string;
  gitObjectDir: string;
  gitCommonDevice: string;
  gitCommonInode: string;
  gitObjectDevice: string;
  gitObjectInode: string;
  createdAt: string;
};

export interface WorkspaceRepository {
  insert(workspace: WorkspaceRecord): WorkspaceRecord;
  findById(id: string): WorkspaceRecord | undefined;
  findActiveByTicket(projectId: string, ticketId: string): WorkspaceRecord | undefined;
  findByTicket(projectId: string, ticketId: string): readonly WorkspaceRecord[];
  listByProject(projectId: string): readonly WorkspaceRecord[];
  updateStatus(
    id: string,
    status: WorkspaceStatus,
    updatedAt: string,
    expectedStatuses?: readonly WorkspaceStatus[]
  ): WorkspaceRecord | undefined;
}

export interface WorkspaceRepositoryBindingRepository {
  findByProjectId(projectId: string): WorkspaceRepositoryBinding | undefined;
  insert(binding: WorkspaceRepositoryBinding): WorkspaceRepositoryBinding;
}

export interface ProjectRepository {
  create(project: ProjectRecord): ProjectRecord;
  findById(id: string): ProjectRecord | undefined;
  findAll(): readonly ProjectRecord[];
}

export interface TicketRepository {
  create(ticket: TicketRecord): TicketRecord;
  createMany(tickets: readonly TicketRecord[]): readonly TicketRecord[];
  findById(id: string): TicketRecord | undefined;
  findByProjectId(projectId: string): readonly TicketRecord[];
  findApprovedByProjectId(projectId: string): readonly TicketRecord[];
  countByProjectId(projectId: string): number;
}

export interface TicketDependencyRepository {
  createMany(dependencies: readonly TicketDependencyRecord[]): void;
  findByTicketId(ticketId: string): readonly TicketDependencyRecord[];
}

export interface RunRepository {
  create(run: RunRecord): RunRecord;
  findById(id: string): RunRecord | undefined;
  findByTicketId(ticketId: string): readonly RunRecord[];
  findActiveByTicket(projectId: string, ticketId: string): RunRecord | undefined;
  findByProjectId(projectId: string): readonly RunRecord[];
  updateStatus(
    id: string,
    status: string,
    updatedAt: string,
    update?: RunUpdate,
    expectedStatuses?: readonly string[]
  ): RunRecord | undefined;
}

export interface EventRepository {
  append(event: NewShipgraphEvent): ShipgraphEvent;
  countByProjectId(projectId: string): number;
  findByProjectId(projectId: string): readonly ShipgraphEvent[];
  findByTicketId(ticketId: string): readonly ShipgraphEvent[];
}

export function createProjectRepository(db: DbConnection): ProjectRepository {
  return {
    create(project): ProjectRecord {
      db.prepare(
        `INSERT INTO projects (id, name, repository, default_branch, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        project.id,
        project.name,
        project.repository,
        project.defaultBranch,
        JSON.stringify(project.config),
        project.createdAt,
        project.updatedAt
      );
      return project;
    },
    findById(id): ProjectRecord | undefined {
      const row = db
        .prepare('SELECT * FROM projects WHERE id = ?')
        .get(id) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      return rowToProject(row);
    },
    findAll(): readonly ProjectRecord[] {
      const rows = db.prepare('SELECT * FROM projects ORDER BY created_at').all();
      return rows.map((row) => rowToProject(row as Record<string, unknown>));
    },
  };
}

export function createTicketRepository(db: DbConnection): TicketRepository {
  const loadDependencies = (ticketId: string): readonly string[] => {
    const deps = db
      .prepare(
        'SELECT depends_on_ticket_id FROM ticket_dependencies WHERE ticket_id = ? ORDER BY depends_on_ticket_id'
      )
      .all(ticketId) as Array<{ depends_on_ticket_id: string }>;
    return deps.map((d) => d.depends_on_ticket_id);
  };

  const loadDependenciesForTickets = (
    ticketIds: readonly string[]
  ): ReadonlyMap<string, readonly string[]> => {
    if (ticketIds.length === 0) return new Map();
    const placeholders = ticketIds.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT ticket_id, depends_on_ticket_id
         FROM ticket_dependencies
         WHERE ticket_id IN (${placeholders})
         ORDER BY ticket_id, depends_on_ticket_id`
      )
      .all(...ticketIds) as Array<{ ticket_id: string; depends_on_ticket_id: string }>;
    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      const dependencies = grouped.get(row.ticket_id) ?? [];
      dependencies.push(row.depends_on_ticket_id);
      grouped.set(row.ticket_id, dependencies);
    }
    return grouped;
  };

  const createMany = db.transaction(
    (tickets: readonly TicketRecord[]): readonly TicketRecord[] => {
      const normalized = tickets.map((ticket) => {
        const { projectId, createdAt, updatedAt, ...contract } = ticket;
        const validated = validateTicket(contract);
        if (validated.status !== TicketState.QUEUED) {
          throw new Error(
            `New ticket ${validated.id} must start in QUEUED until it is imported from the approved backlog`
          );
        }
        return {
          ...validated,
          dependsOn: [...validated.dependsOn].sort(compareStableStrings),
          projectId,
          createdAt,
          updatedAt,
        };
      });

      const inputIds = new Set<string>();
      for (const ticket of normalized) {
        if (inputIds.has(ticket.id)) {
          throw new Error(`Ticket ${ticket.id} is duplicated in the create batch`);
        }
        inputIds.add(ticket.id);
      }

      if (normalized.length === 0) return [];

      const placeholders = normalized.map(() => '?').join(', ');
      const existingRows = db
        .prepare(`SELECT id, project_id FROM tickets WHERE id IN (${placeholders})`)
        .all(...normalized.map((ticket) => ticket.id)) as Array<{
        id: string;
        project_id: string;
      }>;
      if (existingRows.length > 0) {
        throw new Error(
          `Ticket ${existingRows[0].id} already exists and cannot be created again`
        );
      }

      const projectByTicket = new Map<string, string>();
      for (const ticket of normalized) projectByTicket.set(ticket.id, ticket.projectId);

      const existingEdges = db
        .prepare('SELECT ticket_id, depends_on_ticket_id FROM ticket_dependencies')
        .all() as Array<{ ticket_id: string; depends_on_ticket_id: string }>;
      const knownIds = new Set<string>(
        (db.prepare('SELECT id FROM tickets').all() as Array<{ id: string }>).map(
          (row) => row.id
        )
      );
      for (const ticket of normalized) knownIds.add(ticket.id);

      const proposedEdges = normalized.flatMap((ticket) =>
        ticket.dependsOn.map((dependsOnTicketId) => ({
          ticketId: ticket.id,
          dependsOnTicketId,
        }))
      );
      validateDependencyGraph(knownIds, [
        ...existingEdges.map((edge) => ({
          ticketId: edge.ticket_id,
          dependsOnTicketId: edge.depends_on_ticket_id,
        })),
        ...proposedEdges,
      ]);

      for (const edge of proposedEdges) {
        const dependencyProject = projectByTicket.get(edge.dependsOnTicketId);
        if (dependencyProject === undefined) {
          const row = db
            .prepare('SELECT project_id FROM tickets WHERE id = ?')
            .get(edge.dependsOnTicketId) as { project_id: string } | undefined;
          if (row) projectByTicket.set(edge.dependsOnTicketId, row.project_id);
        }
        const sourceProject = projectByTicket.get(edge.ticketId);
        const resolvedDependencyProject = projectByTicket.get(edge.dependsOnTicketId);
        if (
          sourceProject === undefined ||
          resolvedDependencyProject === undefined ||
          sourceProject !== resolvedDependencyProject
        ) {
          throw new Error(
            `Dependency ${edge.ticketId} -> ${edge.dependsOnTicketId} crosses project boundaries`
          );
        }
      }

      const insertTicket = db.prepare(
        `INSERT INTO tickets (
          id, project_id, title, description, priority, risk, status,
          scope_json, acceptance_criteria_json, verification_json,
          agent_json, release_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const ticket of normalized) {
        insertTicket.run(
          ticket.id,
          ticket.projectId,
          ticket.title,
          ticket.description,
          ticket.priority,
          ticket.risk,
          ticket.status,
          JSON.stringify(ticket.scope),
          JSON.stringify(ticket.acceptanceCriteria),
          JSON.stringify(ticket.verification),
          JSON.stringify(ticket.agent),
          JSON.stringify(ticket.release),
          ticket.createdAt,
          ticket.updatedAt
        );
      }

      const insertDependency = db.prepare(
        `INSERT INTO ticket_dependencies (ticket_id, depends_on_ticket_id, created_at)
         VALUES (?, ?, ?)`
      );
      for (const ticket of normalized) {
        for (const dependencyId of ticket.dependsOn) {
          insertDependency.run(ticket.id, dependencyId, ticket.createdAt);
        }
      }

      return normalized;
    }
  ).immediate;

  return {
    create(ticket): TicketRecord {
      const created = createMany([ticket]);
      return created[0];
    },
    createMany(tickets): readonly TicketRecord[] {
      return createMany(tickets);
    },
    findById(id): TicketRecord | undefined {
      const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
      if (!row) return undefined;
      return { ...rowToTicket(row), dependsOn: loadDependencies(id) };
    },
    findByProjectId(projectId): readonly TicketRecord[] {
      return findTicketsByProjectId(projectId, false);
    },
    findApprovedByProjectId(projectId): readonly TicketRecord[] {
      return findTicketsByProjectId(projectId, true);
    },
    countByProjectId(projectId): number {
      const row = db
        .prepare('SELECT COUNT(*) as count FROM tickets WHERE project_id = ?')
        .get(projectId) as { count: number };
      return row.count;
    },
  };

  function findTicketsByProjectId(
    projectId: string,
    approvedOnly: boolean
  ): readonly TicketRecord[] {
    const rows = approvedOnly
      ? db
          .prepare(
            `SELECT tickets.*
             FROM tickets
             INNER JOIN approved_backlog_tickets AS approved
               ON approved.project_id = tickets.project_id
              AND approved.ticket_id = tickets.id
             WHERE tickets.project_id = ?
             ORDER BY tickets.created_at`
          )
          .all(projectId)
      : db
          .prepare('SELECT * FROM tickets WHERE project_id = ? ORDER BY created_at')
          .all(projectId);
      const tickets = rows.map((row) => rowToTicket(row as Record<string, unknown>));
      const dependencies = loadDependenciesForTickets(tickets.map((ticket) => ticket.id));
      return tickets.map((ticket) => ({
        ...ticket,
        dependsOn: dependencies.get(ticket.id) ?? [],
      }));
  }
}

export function createTicketDependencyRepository(
  db: DbConnection
): TicketDependencyRepository {
  const findDependencyProjects = db.prepare(
    `SELECT ticket.project_id AS ticket_project_id,
            dependency.project_id AS dependency_project_id
     FROM tickets AS ticket
     JOIN tickets AS dependency ON dependency.id = ?
     WHERE ticket.id = ?`
  );
  return {
    createMany(dependencies): void {
      const insert = db.prepare(
        `INSERT INTO ticket_dependencies (ticket_id, depends_on_ticket_id, created_at)
         VALUES (?, ?, ?)`
      );
      const insertMany = db.transaction((items: readonly TicketDependencyRecord[]) => {
        for (const item of items) {
          const projects = findDependencyProjects.get(
            item.dependsOnTicketId,
            item.ticketId
          ) as
            | { ticket_project_id: string; dependency_project_id: string }
            | undefined;
          if (!projects) {
            throw new Error(
              `Dependency ${item.ticketId} -> ${item.dependsOnTicketId} references a missing ticket`
            );
          }
          if (projects.ticket_project_id !== projects.dependency_project_id) {
            throw new Error(
              `Dependency ${item.ticketId} -> ${item.dependsOnTicketId} crosses project boundaries`
            );
          }
        }
        const existingEdges = db
          .prepare('SELECT ticket_id, depends_on_ticket_id FROM ticket_dependencies')
          .all() as Array<{ ticket_id: string; depends_on_ticket_id: string }>;
        const knownIds = new Set<string>(
          (db.prepare('SELECT id FROM tickets').all() as Array<{ id: string }>).map(
            (row) => row.id
          )
        );
        validateDependencyGraph(knownIds, [
          ...existingEdges.map((edge) => ({
            ticketId: edge.ticket_id,
            dependsOnTicketId: edge.depends_on_ticket_id,
          })),
          ...items.map((item) => ({
            ticketId: item.ticketId,
            dependsOnTicketId: item.dependsOnTicketId,
          })),
        ]);
        for (const item of items) {
          insert.run(item.ticketId, item.dependsOnTicketId, item.createdAt);
        }
      }).immediate;
      insertMany(dependencies);
    },
    findByTicketId(ticketId): readonly TicketDependencyRecord[] {
      const rows = db
        .prepare(
          'SELECT * FROM ticket_dependencies WHERE ticket_id = ? ORDER BY depends_on_ticket_id'
        )
        .all(ticketId);
      return rows.map((row) => rowToDependency(row as Record<string, unknown>));
    },
  };
}

export function createRunRepository(db: DbConnection): RunRepository {
  const activeStatuses = ['CREATED', 'STARTING', 'RUNNING'] as const;

  return {
    create(run): RunRecord {
      validateRunForPersistence(db, run);
      try {
        db.prepare(
          `INSERT INTO runs (
            id, ticket_id, base_sha, branch_name, status, started_at, completed_at,
            project_id, workspace_id, workspace_path, provider, model, created_at, updated_at,
            model_provider_id, task,
            provider_session_id, provider_process_id, exit_code, termination_signal,
            timed_out, cancelled, failure_category, failure_reason, stdout, stderr,
            stdout_truncated, stderr_truncated, evidence_json, instructions_sha256, timeout_ms,
            safety_policy_sha256, review_type, reviewed_sha, review_result, review_findings_json
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?
          )`
        ).run(
          run.id,
          run.ticketId,
          run.baseSha,
          run.branchName,
          run.status,
          run.startedAt,
          run.completedAt ?? null,
          run.projectId ?? null,
          run.workspaceId ?? null,
          run.workspacePath ?? null,
          run.provider ?? null,
          run.model ?? null,
          run.createdAt ?? run.startedAt,
          run.updatedAt ?? run.startedAt,
          run.modelProviderId ?? null,
          run.task ?? null,
          run.providerSessionId ?? null,
          run.providerProcessId ?? null,
          run.exitCode ?? null,
          run.terminationSignal ?? null,
          run.timedOut === true ? 1 : 0,
          run.cancelled === true ? 1 : 0,
          run.failureCategory ?? null,
          run.failureReason ?? null,
          run.stdout ?? '',
          run.stderr ?? '',
          run.stdoutTruncated === true ? 1 : 0,
          run.stderrTruncated === true ? 1 : 0,
          run.evidence === undefined ? null : JSON.stringify(run.evidence),
          run.instructionsSha256 ?? null,
          run.timeoutMs ?? null,
          run.safetyPolicySha256 ?? null,
          run.reviewType ?? null,
          run.reviewedSha ?? null,
          run.reviewResult ?? null,
          run.reviewFindings === undefined ? null : JSON.stringify(run.reviewFindings)
        );
      } catch (error) {
        if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
          throw new Error(
            `An active agent run already exists for ticket ${run.ticketId}; refusing duplicate execution`
          );
        }
        throw error;
      }
      return run;
    },
    findById(id): RunRecord | undefined {
      const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
      if (!row) return undefined;
      return rowToRun(row);
    },
    findByTicketId(ticketId): readonly RunRecord[] {
      const rows = db
        .prepare('SELECT * FROM runs WHERE ticket_id = ? ORDER BY started_at')
        .all(ticketId);
      return rows.map((row) => rowToRun(row as Record<string, unknown>));
    },
    findActiveByTicket(projectId, ticketId): RunRecord | undefined {
      const placeholders = activeStatuses.map(() => '?').join(', ');
      const row = db
        .prepare(
          `SELECT * FROM runs
           WHERE project_id = ? AND ticket_id = ? AND status IN (${placeholders})
           ORDER BY started_at ASC LIMIT 1`
        )
        .get(projectId, ticketId, ...activeStatuses) as Record<string, unknown> | undefined;
      return row ? rowToRun(row) : undefined;
    },
    findByProjectId(projectId): readonly RunRecord[] {
      const rows = db
        .prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY started_at ASC')
        .all(projectId);
      return rows.map((row) => rowToRun(row as Record<string, unknown>));
    },
    updateStatus(id, status, updatedAt, update = {}, expectedStatuses): RunRecord | undefined {
      const assignments = ['status = ?', 'updated_at = ?'];
      const values: unknown[] = [status, updatedAt];
      const add = (column: string, value: unknown): void => {
        assignments.push(`${column} = ?`);
        values.push(value);
      };
      if (update.startedAt !== undefined) add('started_at', update.startedAt);
      if (update.completedAt !== undefined) add('completed_at', update.completedAt);
      if (update.providerSessionId !== undefined) add('provider_session_id', update.providerSessionId);
      if (update.providerProcessId !== undefined) add('provider_process_id', update.providerProcessId);
      if (update.exitCode !== undefined) add('exit_code', update.exitCode);
      if (update.terminationSignal !== undefined) add('termination_signal', update.terminationSignal);
      if (update.timedOut !== undefined) add('timed_out', update.timedOut ? 1 : 0);
      if (update.cancelled !== undefined) add('cancelled', update.cancelled ? 1 : 0);
      if (update.failureCategory !== undefined) add('failure_category', update.failureCategory);
      if (update.failureReason !== undefined) add('failure_reason', update.failureReason);
      if (update.stdout !== undefined) add('stdout', update.stdout);
      if (update.stderr !== undefined) add('stderr', update.stderr);
      if (update.stdoutTruncated !== undefined) add('stdout_truncated', update.stdoutTruncated ? 1 : 0);
      if (update.stderrTruncated !== undefined) add('stderr_truncated', update.stderrTruncated ? 1 : 0);
      if (update.evidence !== undefined) {
        add('evidence_json', update.evidence === null ? null : JSON.stringify(update.evidence));
      }
      if (update.reviewResult !== undefined) add('review_result', update.reviewResult);
      if (update.reviewFindings !== undefined) {
        add('review_findings_json', update.reviewFindings === null
          ? null
          : JSON.stringify(update.reviewFindings));
      }
      const conditions = ['id = ?'];
      values.push(id);
      if (expectedStatuses !== undefined && expectedStatuses.length > 0) {
        conditions.push(`status IN (${expectedStatuses.map(() => '?').join(', ')})`);
        values.push(...expectedStatuses);
      }
      const result = db
        .prepare(`UPDATE runs SET ${assignments.join(', ')} WHERE ${conditions.join(' AND ')}`)
        .run(...values);
      if (result.changes !== 1) return undefined;
      return this.findById(id);
    },
  };
}

export function createWorkspaceRepository(db: DbConnection): WorkspaceRepository {
  const insert = (workspace: WorkspaceRecord): WorkspaceRecord => {
    try {
      db.prepare(
        `INSERT INTO workspaces (
          id, project_id, ticket_id, source_repository_path, worktree_path,
          branch_name, base_sha, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        workspace.id,
        workspace.projectId,
        workspace.ticketId,
        workspace.sourceRepositoryPath,
        workspace.worktreePath,
        workspace.branchName,
        workspace.baseSha,
        workspace.status,
        workspace.createdAt,
        workspace.updatedAt
      );
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
        throw new Error(
          `Workspace reservation conflict for ticket ${workspace.ticketId}: ${error.message}`
        );
      }
      throw error;
    }
    return workspace;
  };
  return {
    insert,
    findById(id): WorkspaceRecord | undefined {
      const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
      return row ? rowToWorkspace(row) : undefined;
    },
    findActiveByTicket(projectId, ticketId): WorkspaceRecord | undefined {
      const row = db
        .prepare(
          `SELECT * FROM workspaces
           WHERE project_id = ? AND ticket_id = ?
             AND status IN ('CREATING', 'READY', 'NEEDS_HUMAN')`
        )
        .get(projectId, ticketId) as Record<string, unknown> | undefined;
      return row ? rowToWorkspace(row) : undefined;
    },
    findByTicket(projectId, ticketId): readonly WorkspaceRecord[] {
      const rows = db
        .prepare(
          `SELECT * FROM workspaces WHERE project_id = ? AND ticket_id = ?
           ORDER BY created_at ASC`
        )
        .all(projectId, ticketId);
      return rows.map((row) => rowToWorkspace(row as Record<string, unknown>));
    },
    listByProject(projectId): readonly WorkspaceRecord[] {
      const rows = db
        .prepare('SELECT * FROM workspaces WHERE project_id = ? ORDER BY ticket_id ASC')
        .all(projectId);
      return rows.map((row) => rowToWorkspace(row as Record<string, unknown>));
    },
    updateStatus(id, status, updatedAt, expectedStatuses): WorkspaceRecord | undefined {
      if (expectedStatuses !== undefined && expectedStatuses.length > 0) {
        const placeholders = expectedStatuses.map(() => '?').join(', ');
        const result = db
          .prepare(
            `UPDATE workspaces SET status = ?, updated_at = ?
             WHERE id = ? AND status IN (${placeholders})`
          )
          .run(status, updatedAt, id, ...expectedStatuses);
        if (result.changes !== 1) return undefined;
      } else {
        db.prepare('UPDATE workspaces SET status = ?, updated_at = ? WHERE id = ?').run(
          status,
          updatedAt,
          id
        );
      }
      return this.findById(id);
    },
  };
}

export function createWorkspaceRepositoryBindingRepository(
  db: DbConnection
): WorkspaceRepositoryBindingRepository {
  return {
    findByProjectId(projectId): WorkspaceRepositoryBinding | undefined {
      const row = db
        .prepare('SELECT * FROM workspace_repository_bindings WHERE project_id = ?')
        .get(projectId) as Record<string, unknown> | undefined;
      return row ? rowToWorkspaceRepositoryBinding(row) : undefined;
    },
    insert(binding): WorkspaceRepositoryBinding {
      db.prepare(
        `INSERT INTO workspace_repository_bindings (
          project_id, source_repository_path, source_directory_device, source_directory_inode,
          git_common_dir, git_object_dir,
          git_common_device, git_common_inode, git_object_device, git_object_inode, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        binding.projectId,
        binding.sourceRepositoryPath,
        binding.sourceDirectoryDevice,
        binding.sourceDirectoryInode,
        binding.gitCommonDir,
        binding.gitObjectDir,
        binding.gitCommonDevice,
        binding.gitCommonInode,
        binding.gitObjectDevice,
        binding.gitObjectInode,
        binding.createdAt
      );
      return binding;
    },
  };
}

export function createEventRepository(db: DbConnection): EventRepository {
  const nextSequence = (projectId: string): number => {
    const row = db
      .prepare('SELECT MAX(sequence) as max_sequence FROM events WHERE project_id = ?')
      .get(projectId) as { max_sequence: number | null };
    return (row.max_sequence ?? 0) + 1;
  };

  const assertEventOwnership = (event: NewShipgraphEvent): void => {
    let referencedTicketId: string | undefined;
    const ticketId = 'ticketId' in event ? event.ticketId : undefined;
    const runId = 'runId' in event ? event.runId : undefined;

    if (ticketId !== undefined) {
      const ticket = db
        .prepare('SELECT project_id FROM tickets WHERE id = ?')
        .get(ticketId) as { project_id: string } | undefined;
      if (!ticket) throw new Error(`Event references missing ticket ${ticketId}`);
      if (ticket.project_id !== event.projectId) {
        throw new Error(
          `Event ticket ${ticketId} does not belong to project ${event.projectId}`
        );
      }
      referencedTicketId = ticketId;
    }

    if (runId !== undefined) {
      const run = db
        .prepare(
          `SELECT runs.ticket_id, tickets.project_id
           FROM runs
           JOIN tickets ON tickets.id = runs.ticket_id
           WHERE runs.id = ?`
        )
        .get(runId) as { ticket_id: string; project_id: string } | undefined;
      if (!run) throw new Error(`Event references missing run ${runId}`);
      if (run.project_id !== event.projectId) {
        throw new Error(
          `Event run ${runId} does not belong to project ${event.projectId}`
        );
      }
      if (referencedTicketId !== undefined && run.ticket_id !== referencedTicketId) {
        throw new Error(
          `Event run ${runId} belongs to ticket ${run.ticket_id}, not ${referencedTicketId}`
        );
      }
    }
  };

  const appendEvent = db.transaction((event: NewShipgraphEvent): ShipgraphEvent => {
    assertEventOwnership(event);
    const storedEvent = eventSchema.parse({
      ...event,
      sequence: nextSequence(event.projectId),
    });

    db.prepare(
      `INSERT INTO events (id, sequence, timestamp, project_id, ticket_id, run_id, type, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      storedEvent.id,
      storedEvent.sequence,
      storedEvent.timestamp,
      storedEvent.projectId,
      'ticketId' in storedEvent ? storedEvent.ticketId : null,
      'runId' in storedEvent ? storedEvent.runId : null,
      storedEvent.type,
      JSON.stringify(storedEvent.payload)
    );
    return storedEvent;
  }).immediate;

  return {
    append(event): ShipgraphEvent {
      return appendEvent(event);
    },
    findByProjectId(projectId): readonly ShipgraphEvent[] {
      const rows = db
        .prepare(
          'SELECT * FROM events WHERE project_id = ? ORDER BY sequence ASC'
        )
        .all(projectId);
      return rows.map((row) => rowToEvent(row as Record<string, unknown>));
    },
    countByProjectId(projectId): number {
      const row = db
        .prepare('SELECT COUNT(*) AS count FROM events WHERE project_id = ?')
        .get(projectId) as { count: number };
      return row.count;
    },
    findByTicketId(ticketId): readonly ShipgraphEvent[] {
      const rows = db
        .prepare('SELECT * FROM events WHERE ticket_id = ? ORDER BY sequence ASC')
        .all(ticketId);
      return rows.map((row) => rowToEvent(row as Record<string, unknown>));
    },
  };
}

function rowToProject(row: Record<string, unknown>): ProjectRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    repository: String(row.repository),
    defaultBranch: String(row.default_branch),
    config: JSON.parse(String(row.config_json)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToTicket(row: Record<string, unknown>): Omit<TicketRecord, 'dependsOn'> {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    title: String(row.title),
    description: String(row.description),
    priority: String(row.priority) as TicketPriority,
    risk: String(row.risk) as TicketRisk,
    status: String(row.status) as TicketStateValue,
    scope: JSON.parse(String(row.scope_json)),
    acceptanceCriteria: JSON.parse(String(row.acceptance_criteria_json)),
    verification: JSON.parse(String(row.verification_json)),
    agent: JSON.parse(String(row.agent_json)),
    release: JSON.parse(String(row.release_json)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToDependency(row: Record<string, unknown>): TicketDependencyRecord {
  return {
    ticketId: String(row.ticket_id),
    dependsOnTicketId: String(row.depends_on_ticket_id),
    createdAt: String(row.created_at),
  };
}

function rowToRun(row: Record<string, unknown>): RunRecord {
  const legacy: RunRecord = {
    id: requiredString(row, 'id'),
    ticketId: requiredString(row, 'ticket_id'),
    baseSha: requiredString(row, 'base_sha'),
    branchName: requiredString(row, 'branch_name'),
    status: requiredString(row, 'status'),
    startedAt: requiredString(row, 'started_at'),
    ...(row.completed_at === null || row.completed_at === undefined
      ? {}
      : { completedAt: requiredString(row, 'completed_at') }),
  };

  // Databases created before AGENT-001 contain only the original CORE-001
  // run columns. Preserve their public shape, but never silently coerce a
  // partially populated new record into a valid execution record.
  const hasDurableMetadata =
    row.project_id !== null && row.project_id !== undefined;
  if (!hasDurableMetadata) return legacy;

  const durable = agentRunRecordSchema.parse({
    ...legacy,
    projectId: requiredString(row, 'project_id'),
    workspaceId: requiredString(row, 'workspace_id'),
    workspacePath: requiredString(row, 'workspace_path'),
    provider: requiredString(row, 'provider'),
    ...(row.model_provider_id === null || row.model_provider_id === undefined
      ? {}
      : { modelProviderId: modelProviderIdSchema.parse(requiredString(row, 'model_provider_id')) }),
    ...(row.task === null || row.task === undefined
      ? {}
      : { task: modelTaskTypeSchema.parse(requiredString(row, 'task')) }),
    model: requiredString(row, 'model'),
    createdAt: requiredString(row, 'created_at'),
    updatedAt: requiredString(row, 'updated_at'),
    ...(row.provider_session_id === null || row.provider_session_id === undefined
      ? {}
      : { providerSessionId: requiredString(row, 'provider_session_id') }),
    ...(row.provider_process_id === null || row.provider_process_id === undefined
      ? {}
      : { providerProcessId: requiredInteger(row, 'provider_process_id') }),
    ...(row.exit_code === null || row.exit_code === undefined
      ? {}
      : { exitCode: requiredInteger(row, 'exit_code') }),
    ...(row.termination_signal === null || row.termination_signal === undefined
      ? {}
      : { terminationSignal: requiredString(row, 'termination_signal') }),
    timedOut: sqliteBoolean(row.timed_out, 'timed_out'),
    cancelled: sqliteBoolean(row.cancelled, 'cancelled'),
    ...(row.failure_category === null || row.failure_category === undefined
      ? {}
      : { failureCategory: agentFailureCategorySchema.parse(row.failure_category) }),
    ...(row.failure_reason === null || row.failure_reason === undefined
      ? {}
      : { failureReason: requiredString(row, 'failure_reason') }),
    stdout: requiredText(row, 'stdout'),
    stderr: requiredText(row, 'stderr'),
    stdoutTruncated: sqliteBoolean(row.stdout_truncated, 'stdout_truncated'),
    stderrTruncated: sqliteBoolean(row.stderr_truncated, 'stderr_truncated'),
    ...(row.evidence_json === null || row.evidence_json === undefined
      ? {}
      : { evidence: normalizedAgentEvidenceSchema.parse(JSON.parse(requiredString(row, 'evidence_json'))) }),
    instructionsSha256: requiredString(row, 'instructions_sha256'),
    ...(row.safety_policy_sha256 === null || row.safety_policy_sha256 === undefined
      ? {}
      : { safetyPolicySha256: requiredString(row, 'safety_policy_sha256') }),
    ...(row.review_type === null || row.review_type === undefined
      ? {}
      : { reviewType: reviewTypeSchema.parse(requiredString(row, 'review_type')) }),
    ...(row.reviewed_sha === null || row.reviewed_sha === undefined
      ? {}
      : { reviewedSha: requiredString(row, 'reviewed_sha') }),
    ...(row.review_result === null || row.review_result === undefined
      ? {}
      : { reviewResult: reviewResultSchema.parse(requiredString(row, 'review_result')) }),
    ...(row.review_findings_json === null || row.review_findings_json === undefined
      ? {}
      : { reviewFindings: JSON.parse(requiredString(row, 'review_findings_json')) }),
    timeoutMs: requiredInteger(row, 'timeout_ms'),
  }) as AgentRunRecord;
  return durable;
}

function validateRunForPersistence(db: DbConnection, run: RunRecord): void {
  const hasDurableMetadata =
    run.projectId !== undefined ||
    run.workspaceId !== undefined ||
    run.provider !== undefined ||
    run.model !== undefined ||
    run.instructionsSha256 !== undefined;
  if (!hasDurableMetadata) return;
  agentRunRecordSchema.parse({
    ...run,
    projectId: run.projectId,
    workspaceId: run.workspaceId,
    workspacePath: run.workspacePath,
    provider: run.provider,
    ...(run.modelProviderId === undefined ? {} : { modelProviderId: run.modelProviderId }),
    ...(run.task === undefined ? {} : { task: run.task }),
    model: run.model,
    createdAt: run.createdAt ?? run.startedAt,
    updatedAt: run.updatedAt ?? run.startedAt,
    timedOut: run.timedOut ?? false,
    cancelled: run.cancelled ?? false,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
    stdoutTruncated: run.stdoutTruncated ?? false,
    stderrTruncated: run.stderrTruncated ?? false,
    instructionsSha256: run.instructionsSha256,
    safetyPolicySha256: run.safetyPolicySha256,
    timeoutMs: run.timeoutMs,
  });
  if (
    run.modelProviderId !== undefined &&
    MODEL_PROVIDER_TO_AGENT_PROVIDER[run.modelProviderId] !== run.provider
  ) {
    throw new Error(
      `Agent run ${run.id} model provider ${run.modelProviderId} does not use AGENT provider ${run.provider}`
    );
  }
  const ticket = db
    .prepare('SELECT project_id FROM tickets WHERE id = ?')
    .get(run.ticketId) as { project_id: string } | undefined;
  if (!ticket || ticket.project_id !== run.projectId) {
    throw new Error(`Agent run ${run.id} does not match its ticket project`);
  }
  const workspace = db
    .prepare(
      `SELECT project_id, ticket_id, worktree_path, branch_name, base_sha, status
       FROM workspaces WHERE id = ?`
    )
    .get(run.workspaceId) as
    | {
        project_id: string;
        ticket_id: string;
        worktree_path: string;
        branch_name: string;
        base_sha: string;
        status: string;
      }
    | undefined;
  if (
    !workspace ||
    workspace.project_id !== run.projectId ||
    workspace.ticket_id !== run.ticketId ||
    workspace.worktree_path !== run.workspacePath ||
    workspace.branch_name !== run.branchName ||
    workspace.base_sha !== run.baseSha ||
    workspace.status !== 'READY'
  ) {
    throw new Error(`Agent run ${run.id} does not match a READY workspace identity`);
  }
}

function requiredString(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Persisted run column ${column} is invalid`);
  }
  return value;
}

function requiredText(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new Error(`Persisted run column ${column} is invalid`);
  }
  return value;
}

function requiredInteger(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Persisted run column ${column} is invalid`);
  }
  return value;
}

function sqliteBoolean(value: unknown, column: string): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  throw new Error(`Persisted run column ${column} is invalid`);
}

function rowToWorkspace(row: Record<string, unknown>): WorkspaceRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    ticketId: String(row.ticket_id),
    sourceRepositoryPath: String(row.source_repository_path),
    worktreePath: String(row.worktree_path),
    branchName: String(row.branch_name),
    baseSha: String(row.base_sha),
    status: String(row.status) as WorkspaceStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToWorkspaceRepositoryBinding(
  row: Record<string, unknown>
): WorkspaceRepositoryBinding {
  return {
    projectId: String(row.project_id),
    sourceRepositoryPath: String(row.source_repository_path),
    sourceDirectoryDevice: String(row.source_directory_device),
    sourceDirectoryInode: String(row.source_directory_inode),
    gitCommonDir: String(row.git_common_dir),
    gitObjectDir: String(row.git_object_dir),
    gitCommonDevice: String(row.git_common_device),
    gitCommonInode: String(row.git_common_inode),
    gitObjectDevice: String(row.git_object_device),
    gitObjectInode: String(row.git_object_inode),
    createdAt: String(row.created_at),
  };
}

function rowToEvent(row: Record<string, unknown>): ShipgraphEvent {
  return eventSchema.parse({
    id: String(row.id),
    sequence: Number(row.sequence),
    timestamp: String(row.timestamp),
    projectId: String(row.project_id),
    ...(row.ticket_id ? { ticketId: String(row.ticket_id) } : {}),
    ...(row.run_id ? { runId: String(row.run_id) } : {}),
    type: String(row.type),
    payload: JSON.parse(String(row.payload_json)),
  });
}
