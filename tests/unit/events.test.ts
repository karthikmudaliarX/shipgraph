import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createInMemoryDatabase, migrate } from '../../src/persistence/db.js';
import type { DbConnection } from '../../src/persistence/db.js';
import {
  createProjectRepository,
  createTicketRepository,
  createEventRepository,
} from '../../src/persistence/repositories.js';
import type { ProjectRecord, TicketRecord } from '../../src/persistence/repositories.js';
import { TicketState, type TicketStateValue } from '../../src/core/state-machine/state.js';
import { EventType, type ProjectInitializedPayload, type TicketStateChangedPayload } from '../../src/events/event.js';
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

  beforeEach(() => {
    db = createInMemoryDatabase();
    migrate(db);
  });

  afterEach(() => {
    db.close();
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
      sequence: eventRepo.nextSequence(project.id),
      timestamp: new Date().toISOString(),
      projectId: project.id,
      type: EventType.PROJECT_INITIALIZED,
      payload,
    });

    const e2 = eventRepo.append({
      id: randomUUID(),
      sequence: eventRepo.nextSequence(project.id),
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
    const eventRepo = createEventRepository(db);

    const update = db.transaction((ticketId: string, nextStatus: string) => {
      ticketRepo.updateStatus(ticketId, nextStatus);
      const payload: TicketStateChangedPayload = {
        ticketId,
        previous: ticket.status as TicketStateValue,
        next: nextStatus as TicketStateValue,
      };
      eventRepo.append({
        id: randomUUID(),
        sequence: eventRepo.nextSequence(project.id),
        timestamp: new Date().toISOString(),
        projectId: project.id,
        ticketId,
        type: EventType.TICKET_STATE_CHANGED,
        payload,
      });
    });

    update(ticket.id, TicketState.ELIGIBLE);

    const updated = ticketRepo.findById(ticket.id);
    expect(updated?.status).toBe(TicketState.ELIGIBLE);

    const events = eventRepo.findByTicketId(ticket.id);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(EventType.TICKET_STATE_CHANGED);
    expect(events[0].payload.next).toBe(TicketState.ELIGIBLE);
  });

  it('does not provide update or delete APIs', () => {
    const repo = createEventRepository(db);
    expect(typeof repo.append).toBe('function');
    expect(typeof (repo as Record<string, unknown>).update).toBe('undefined');
    expect(typeof (repo as Record<string, unknown>).delete).toBe('undefined');
  });
});
