import type { DbConnection } from './db.js';
import type { ShipgraphConfig } from '../config/schema.js';
import type { TicketContract, TicketPriority, TicketRisk } from '../domain/ticket.js';
import type { ShipgraphEvent } from '../events/event.js';

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
};

export interface ProjectRepository {
  create(project: ProjectRecord): ProjectRecord;
  findById(id: string): ProjectRecord | undefined;
  findAll(): readonly ProjectRecord[];
}

export interface TicketRepository {
  create(ticket: TicketRecord): TicketRecord;
  findById(id: string): TicketRecord | undefined;
  findByProjectId(projectId: string): readonly TicketRecord[];
  updateStatus(id: string, status: string): TicketRecord | undefined;
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
}

export interface EventRepository {
  append(event: ShipgraphEvent): ShipgraphEvent;
  findByProjectId(projectId: string): readonly ShipgraphEvent[];
  findByTicketId(ticketId: string): readonly ShipgraphEvent[];
  nextSequence(projectId: string): number;
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

  return {
    create(ticket): TicketRecord {
      db.prepare(
        `INSERT INTO tickets (
          id, project_id, title, description, priority, risk, status,
          scope_json, acceptance_criteria_json, verification_json,
          agent_json, release_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
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
      return ticket;
    },
    findById(id): TicketRecord | undefined {
      const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
      if (!row) return undefined;
      return { ...rowToTicket(row), dependsOn: loadDependencies(id) };
    },
    findByProjectId(projectId): readonly TicketRecord[] {
      const rows = db
        .prepare('SELECT * FROM tickets WHERE project_id = ? ORDER BY created_at')
        .all(projectId);
      return rows.map((row) => {
        const ticket = rowToTicket(row as Record<string, unknown>);
        return { ...ticket, dependsOn: loadDependencies(ticket.id) };
      });
    },
    updateStatus(id, status): TicketRecord | undefined {
      const now = new Date().toISOString();
      const result = db
        .prepare('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, now, id);
      if (result.changes === 0) return undefined;
      return this.findById(id);
    },
    countByProjectId(projectId): number {
      const row = db
        .prepare('SELECT COUNT(*) as count FROM tickets WHERE project_id = ?')
        .get(projectId) as { count: number };
      return row.count;
    },
  };
}

export function createTicketDependencyRepository(
  db: DbConnection
): TicketDependencyRepository {
  return {
    createMany(dependencies): void {
      const insert = db.prepare(
        `INSERT INTO ticket_dependencies (ticket_id, depends_on_ticket_id, created_at)
         VALUES (?, ?, ?)`
      );
      const insertMany = db.transaction((items: readonly TicketDependencyRecord[]) => {
        for (const item of items) {
          insert.run(item.ticketId, item.dependsOnTicketId, item.createdAt);
        }
      });
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
  return {
    create(run): RunRecord {
      db.prepare(
        `INSERT INTO runs (id, ticket_id, base_sha, branch_name, status, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        run.id,
        run.ticketId,
        run.baseSha,
        run.branchName,
        run.status,
        run.startedAt,
        run.completedAt ?? null
      );
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
  };
}

export function createEventRepository(db: DbConnection): EventRepository {
  return {
    append(event): ShipgraphEvent {
      db.prepare(
        `INSERT INTO events (id, sequence, timestamp, project_id, ticket_id, run_id, type, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        event.id,
        event.sequence,
        event.timestamp,
        event.projectId,
        event.ticketId ?? null,
        event.runId ?? null,
        event.type,
        JSON.stringify(event.payload)
      );
      return event;
    },
    findByProjectId(projectId): readonly ShipgraphEvent[] {
      const rows = db
        .prepare(
          'SELECT * FROM events WHERE project_id = ? ORDER BY sequence ASC'
        )
        .all(projectId);
      return rows.map((row) => rowToEvent(row as Record<string, unknown>));
    },
    findByTicketId(ticketId): readonly ShipgraphEvent[] {
      const rows = db
        .prepare('SELECT * FROM events WHERE ticket_id = ? ORDER BY sequence ASC')
        .all(ticketId);
      return rows.map((row) => rowToEvent(row as Record<string, unknown>));
    },
    nextSequence(projectId): number {
      const row = db
        .prepare('SELECT MAX(sequence) as max_sequence FROM events WHERE project_id = ?')
        .get(projectId) as { max_sequence: number | null };
      return (row.max_sequence ?? 0) + 1;
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
    status: String(row.status),
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
  return {
    id: String(row.id),
    ticketId: String(row.ticket_id),
    baseSha: String(row.base_sha),
    branchName: String(row.branch_name),
    status: String(row.status),
    startedAt: String(row.started_at),
    completedAt: row.completed_at ? String(row.completed_at) : undefined,
  };
}

function rowToEvent(row: Record<string, unknown>): ShipgraphEvent {
  return {
    id: String(row.id),
    sequence: Number(row.sequence),
    timestamp: String(row.timestamp),
    projectId: String(row.project_id),
    ticketId: row.ticket_id ? String(row.ticket_id) : undefined,
    runId: row.run_id ? String(row.run_id) : undefined,
    type: String(row.type),
    payload: JSON.parse(String(row.payload_json)),
  };
}
