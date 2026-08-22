import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, migrate } from '../../src/persistence/db.js';
import type { DbConnection } from '../../src/persistence/db.js';
import {
  createProjectRepository,
  createTicketRepository,
  createEventRepository,
} from '../../src/persistence/repositories.js';
import type { ProjectRecord, TicketRecord } from '../../src/persistence/repositories.js';
import { persistTicketTransition } from '../../src/persistence/ticket-state-store.js';
import { TicketState } from '../../src/core/state-machine/state.js';
import { EventType, type ProjectInitializedPayload } from '../../src/events/event.js';
import type { ShipgraphConfig } from '../../src/config/schema.js';

const TEST_CONFIG: ShipgraphConfig = {
  version: 1,
  project: { name: 'test', repository: 'owner/repo', defaultBranch: 'main' },
  execution: { maxConcurrentTickets: 1, maxRepairIterations: 6 },
  release: { requireHumanApproval: true, requireCleanCI: true, requireExactShaReviews: true },
  agents: { implementer: 'opencode', reviewers: ['correctness'] },
};

describe('append-only event log', () => {
  let db: DbConnection;
  let databaseDir: string;

  beforeEach(() => {
    databaseDir = mkdtempSync(join(tmpdir(), 'shipgraph-events-'));
    db = createDatabase(join(databaseDir, 'shipgraph.db'));
    migrate(db);
  });

  afterEach(() => {
    db.close();
    rmSync(databaseDir, { recursive: true, force: true });
  });

  function createProject(): ProjectRecord {
    const repo = createProjectRepository(db);
    const project: ProjectRecord = {
      id: randomUUID(),
      name: 'test',
      repository: 'owner/repo',
      defaultBranch: 'main',
      config: TEST_CONFIG,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    repo.create(project);
    return project;
  }

  function createTicket(projectId: string): TicketRecord {
    const repo = createTicketRepository(db);
    const ticket: TicketRecord = {
      id: 'CORE-001',
      projectId,
      title: 'Ticket',
      description: 'A ticket.',
      priority: 'high',
      risk: 'medium',
      status: TicketState.QUEUED,
      scope: { allowedPaths: [], forbiddenPaths: [] },
      acceptanceCriteria: [],
      verification: { commands: [] },
      agent: {},
      release: {},
      dependsOn: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    repo.create(ticket);
    return ticket;
  }

  it('sequences events monotonically within a project', () => {
    const project = createProject();
    const eventRepo = createEventRepository(db);

    const payload: ProjectInitializedPayload = {
      projectId: project.id,
      name: project.name,
      repository: project.repository,
      defaultBranch: project.defaultBranch,
    };

    const e1 = eventRepo.append({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      projectId: project.id,
      type: EventType.PROJECT_INITIALIZED,
      payload,
    });

    const e2 = eventRepo.append({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      projectId: project.id,
      type: EventType.TICKET_CREATED,
      payload: { ticketId: 'CORE-001' },
    });

    expect(e1.sequence).toBe(1);
    expect(e2.sequence).toBe(2);

    const events = eventRepo.findByProjectId(project.id);
    expect(events).toHaveLength(2);
    expect(events[0].sequence).toBeLessThan(events[1].sequence);
  });

  it('atomically updates ticket status and appends a state_changed event', () => {
    const project = createProject();
    const ticket = createTicket(project.id);
    const ticketRepo = createTicketRepository(db);
    const result = persistTicketTransition(db, {
      ticketId: ticket.id,
      next: TicketState.ELIGIBLE,
      reason: 'dependencies satisfied',
    });

    const updated = ticketRepo.findById(ticket.id);
    expect(updated?.status).toBe(TicketState.ELIGIBLE);
    expect(result.event.sequence).toBe(1);

    const events = createEventRepository(db).findByTicketId(ticket.id);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(EventType.TICKET_STATE_CHANGED);
    expect(events[0].payload.next).toBe(TicketState.ELIGIBLE);
  });

  it('rolls back the state update when event persistence fails', () => {
    const project = createProject();
    const ticket = createTicket(project.id);
    const duplicateEventId = randomUUID();
    const eventRepo = createEventRepository(db);

    eventRepo.append({
      id: duplicateEventId,
      timestamp: new Date().toISOString(),
      projectId: project.id,
      type: EventType.PROJECT_INITIALIZED,
      payload: { projectId: project.id },
    });

    expect(() =>
      persistTicketTransition(
        db,
        { ticketId: ticket.id, next: TicketState.ELIGIBLE },
        { createEventId: () => duplicateEventId }
      )
    ).toThrow();

    expect(createTicketRepository(db).findById(ticket.id)?.status).toBe(
      TicketState.QUEUED
    );
    expect(eventRepo.findByTicketId(ticket.id)).toHaveLength(0);
  });

  it('rejects illegal transitions before writing state or events', () => {
    const project = createProject();
    const ticket = createTicket(project.id);

    expect(() =>
      persistTicketTransition(db, {
        ticketId: ticket.id,
        next: TicketState.MERGED,
      })
    ).toThrow(/not allowed/);

    expect(createTicketRepository(db).findById(ticket.id)?.status).toBe(
      TicketState.QUEUED
    );
    expect(createEventRepository(db).findByTicketId(ticket.id)).toHaveLength(0);
  });

  it('rejects transitions for missing tickets without creating events', () => {
    const project = createProject();
    expect(() =>
      persistTicketTransition(db, {
        ticketId: 'CORE-999',
        next: TicketState.ELIGIBLE,
      })
    ).toThrow(/does not exist/);
    expect(createEventRepository(db).findByProjectId(project.id)).toHaveLength(0);
  });

  it('enforces merge policy through the persistence boundary', () => {
    const project = createProject();
    const ticket = createTicket(project.id);
    db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run(
      TicketState.RELEASE_READY,
      ticket.id
    );

    expect(() =>
      persistTicketTransition(db, {
        ticketId: ticket.id,
        next: TicketState.MERGING,
      })
    ).toThrow(/human approval/);

    const result = persistTicketTransition(db, {
      ticketId: ticket.id,
      next: TicketState.MERGING,
      context: { releasePolicy: { requireHumanApproval: false } },
    });
    expect(result.ticket.status).toBe(TicketState.MERGING);
  });

  it('maintains independent event sequences for separate projects', () => {
    const first = createProject();
    const second = createProject();
    const eventRepo = createEventRepository(db);
    const append = (projectId: string) =>
      eventRepo.append({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        projectId,
        type: EventType.PROJECT_INITIALIZED,
        payload: { projectId },
      });

    expect(append(first.id).sequence).toBe(1);
    expect(append(first.id).sequence).toBe(2);
    expect(append(second.id).sequence).toBe(1);
  });

  it('does not provide update or delete APIs', () => {
    const repo = createEventRepository(db);
    expect(typeof repo.append).toBe('function');
    expect(typeof (repo as Record<string, unknown>).update).toBe('undefined');
    expect(typeof (repo as Record<string, unknown>).delete).toBe('undefined');
  });
});
