import type { DbConnection } from './db.js';
import type { ShipgraphConfig } from '../config/schema.js';
import type { TicketStateValue } from '../core/state-machine/state.js';
import {
  validateTicket,
  type TicketContract,
  type TicketPriority,
  type TicketRisk,
} from '../domain/ticket.js';
import {
  eventSchema,
  type NewShipgraphEvent,
  type ShipgraphEvent,
} from '../events/event.js';

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

  const createTicket = db.transaction((ticket: TicketRecord): TicketRecord => {
    const { projectId, createdAt, updatedAt, ...contract } = ticket;
    const validated = validateTicket(contract);

    if (validated.dependsOn.length > 0) {
      const placeholders = validated.dependsOn.map(() => '?').join(', ');
      const row = db
        .prepare(
          `SELECT COUNT(*) AS count FROM tickets
           WHERE project_id = ? AND id IN (${placeholders})`
        )
        .get(projectId, ...validated.dependsOn) as { count: number };
      if (row.count !== validated.dependsOn.length) {
        throw new Error(
          `Ticket ${validated.id} has dependencies that do not exist in project ${projectId}`
        );
      }
    }

    db.prepare(
      `INSERT INTO tickets (
        id, project_id, title, description, priority, risk, status,
        scope_json, acceptance_criteria_json, verification_json,
        agent_json, release_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      validated.id,
      projectId,
      validated.title,
      validated.description,
      validated.priority,
      validated.risk,
      validated.status,
      JSON.stringify(validated.scope),
      JSON.stringify(validated.acceptanceCriteria),
      JSON.stringify(validated.verification),
      JSON.stringify(validated.agent),
      JSON.stringify(validated.release),
      createdAt,
      updatedAt
    );

    const insertDependency = db.prepare(
      `INSERT INTO ticket_dependencies (ticket_id, depends_on_ticket_id, created_at)
       VALUES (?, ?, ?)`
    );
    for (const dependencyId of validated.dependsOn) {
      insertDependency.run(validated.id, dependencyId, createdAt);
    }

    return { ...validated, projectId, createdAt, updatedAt };
  }).immediate;

  return {
    create(ticket): TicketRecord {
      return createTicket(ticket);
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
      const tickets = rows.map((row) => rowToTicket(row as Record<string, unknown>));
      const dependencies = loadDependenciesForTickets(tickets.map((ticket) => ticket.id));
      return tickets.map((ticket) => ({
        ...ticket,
        dependsOn: dependencies.get(ticket.id) ?? [],
      }));
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
        assertAcyclicDependencies(db, items);
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

function assertAcyclicDependencies(
  db: DbConnection,
  proposed: readonly TicketDependencyRecord[]
): void {
  const existing = db
    .prepare('SELECT ticket_id, depends_on_ticket_id FROM ticket_dependencies')
    .all() as Array<{ ticket_id: string; depends_on_ticket_id: string }>;
  const adjacency = new Map<string, Set<string>>();
  const addEdge = (ticketId: string, dependencyId: string): void => {
    if (ticketId === dependencyId) {
      throw new Error(`Ticket ${ticketId} cannot depend on itself`);
    }
    const dependencies = adjacency.get(ticketId) ?? new Set<string>();
    dependencies.add(dependencyId);
    adjacency.set(ticketId, dependencies);
  };
  for (const edge of existing) addEdge(edge.ticket_id, edge.depends_on_ticket_id);
  for (const edge of proposed) addEdge(edge.ticketId, edge.dependsOnTicketId);

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (ticketId: string): boolean => {
    if (visiting.has(ticketId)) return true;
    if (visited.has(ticketId)) return false;
    visiting.add(ticketId);
    for (const dependencyId of adjacency.get(ticketId) ?? []) {
      if (visit(dependencyId)) return true;
    }
    visiting.delete(ticketId);
    visited.add(ticketId);
    return false;
  };
  for (const ticketId of adjacency.keys()) {
    if (visit(ticketId)) throw new Error('Ticket dependency graph must remain acyclic');
  }
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
