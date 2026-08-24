import { createHash, randomUUID } from 'node:crypto';
import type { ApprovedBacklog } from '../backlog/schema.js';
import {
  validateBacklog,
} from '../backlog/schema.js';
import { TicketState } from '../core/state-machine/state.js';
import { EventType, type TicketCreatedPayload } from '../events/event.js';
import { createEventRepository, createTicketRepository, type TicketRecord } from './repositories.js';
import type { DbConnection } from './db.js';
import { reconcileEligibility } from '../scheduler/eligibility.js';
import { validateTicket, type TicketDefinition } from '../domain/ticket.js';
import { compareStableStrings } from '../utils/sorting.js';

export type BacklogSyncReport = {
  new: number;
  unchanged: number;
  eligible: number;
  queued: number;
};

export type BacklogSyncOptions = {
  sourcePath?: string;
  createEventId?: () => string;
  now?: () => string;
};

/**
 * Atomically synchronize one validated approved backlog into one project.
 * Static ticket definitions are compared without ever overwriting runtime state.
 */
export function syncApprovedBacklog(
  db: DbConnection,
  projectId: string,
  input: ApprovedBacklog,
  options: BacklogSyncOptions = {}
): BacklogSyncReport {
  const backlog = validateBacklog(input);
  const ticketRepository = createTicketRepository(db);
  const eventRepository = createEventRepository(db);
  const createEventId = options.createEventId ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());
  const sourcePath = options.sourcePath ?? 'shipgraph.backlog.yml';
  const backlogById = new Map(backlog.tickets.map((ticket) => [ticket.id, ticket]));
  const timestamp = now();
  const contentHash = createHash('sha256')
    .update(JSON.stringify(backlog))
    .digest('hex');

  const sync = db.transaction((): BacklogSyncReport => {
    // Take the complete persisted snapshot after acquiring the write lock so
    // concurrent suggestions/syncs cannot invalidate drift or removal checks.
    const project = db
      .prepare('SELECT id FROM projects WHERE id = ?')
      .get(projectId) as { id: string } | undefined;
    if (!project) throw new Error(`Project ${projectId} does not exist`);
    const allExisting = ticketRepository.findByProjectId(projectId);
    const approvedExisting = ticketRepository.findApprovedByProjectId(projectId);
    const existingById = new Map(allExisting.map((ticket) => [ticket.id, ticket]));

    const removed = approvedExisting.filter((ticket) => !backlogById.has(ticket.id));
    if (removed.length > 0) {
      throw new Error(
        `Approved backlog is missing persisted ticket(s): ${removed
          .map((ticket) => ticket.id)
          .sort(compareStableStrings)
          .join(', ')}. Persisted work is never removed by YAML edits.`
      );
    }

    const newDefinitions: TicketDefinition[] = [];
    let unchanged = 0;
    for (const definition of backlog.tickets) {
      const persisted = existingById.get(definition.id);
      if (!persisted) {
        newDefinitions.push(definition);
        continue;
      }
      if (!staticContractsMatch(persisted, definition)) {
        throw new Error(
          `Approved ticket ${definition.id} static contract drifted; amend through an authorized workflow`
        );
      }
      unchanged += 1;
    }

    const created = ticketRepository.createMany(
      newDefinitions.map((definition) => ({
        ...definition,
        status: TicketState.QUEUED,
        projectId,
        createdAt: timestamp,
        updatedAt: timestamp,
      }))
    );

    for (const ticket of created) {
      const payload: TicketCreatedPayload = {
        ticketId: ticket.id,
        title: ticket.title,
        priority: ticket.priority,
        dependsOn: [...ticket.dependsOn],
      };
      eventRepository.append({
        id: createEventId(),
        timestamp,
        projectId,
        ticketId: ticket.id,
        type: EventType.TICKET_CREATED,
        payload,
      });
    }

    db.prepare(
      `INSERT INTO backlog_syncs (project_id, version, content_hash, source_path, synced_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         version = excluded.version,
         content_hash = excluded.content_hash,
         source_path = excluded.source_path,
         synced_at = excluded.synced_at`
    ).run(projectId, backlog.version, contentHash, sourcePath, timestamp);

    const markApproved = db.prepare(
      `INSERT INTO approved_backlog_tickets (project_id, ticket_id, content_hash, approved_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, ticket_id) DO UPDATE SET
         content_hash = excluded.content_hash,
         approved_at = excluded.approved_at`
    );
    for (const ticket of backlog.tickets) {
      markApproved.run(projectId, ticket.id, contentHash, timestamp);
    }

    reconcileEligibility(db, projectId, {
      createEventId,
      now,
    });
    const finalTickets = ticketRepository.findApprovedByProjectId(projectId);
    return {
      new: created.length,
      unchanged,
      eligible: finalTickets.filter((ticket) => ticket.status === TicketState.ELIGIBLE).length,
      queued: finalTickets.filter((ticket) => ticket.status === TicketState.QUEUED).length,
    };
  }).immediate;

  return sync();
}

function staticContractsMatch(
  persisted: TicketRecord,
  definition: TicketDefinition
): boolean {
  const persistedDefinition = validateTicket({
    id: persisted.id,
    title: persisted.title,
    description: persisted.description,
    priority: persisted.priority,
    dependsOn: persisted.dependsOn,
    scope: persisted.scope,
    acceptanceCriteria: persisted.acceptanceCriteria,
    verification: persisted.verification,
    risk: persisted.risk,
    agent: persisted.agent,
    release: persisted.release,
    status: persisted.status,
  });
  const persistedStatic = {
    ...persistedDefinition,
    dependsOn: [...persistedDefinition.dependsOn].sort(compareStableStrings),
  };
  const proposedStatic = {
    ...definition,
    dependsOn: [...definition.dependsOn].sort(compareStableStrings),
  };
  delete (persistedStatic as Partial<typeof persistedStatic>).status;
  return JSON.stringify(persistedStatic) === JSON.stringify(proposedStatic);
}
