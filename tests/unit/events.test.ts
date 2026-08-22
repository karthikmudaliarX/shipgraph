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
  createRunRepository,
  createEventRepository,
} from '../../src/persistence/repositories.js';
import type { ProjectRecord, RunRecord, TicketRecord } from '../../src/persistence/repositories.js';
import { persistTicketTransition } from '../../src/persistence/ticket-state-store.js';
import { TicketState } from '../../src/core/state-machine/state.js';
import {
  EventType,
  eventSchema,
  type NewShipgraphEvent,
  type ProjectInitializedPayload,
} from '../../src/events/event.js';
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

  function createTicket(projectId: string, id = 'CORE-001'): TicketRecord {
    const repo = createTicketRepository(db);
    const ticket: TicketRecord = {
      id,
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

  function createRun(ticketId: string): RunRecord {
    const run: RunRecord = {
      id: randomUUID(),
      ticketId,
      baseSha: 'abc123',
      branchName: `agent/${ticketId.toLowerCase()}`,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    createRunRepository(db).create(run);
    return run;
  }

  function initializedPayload(project: ProjectRecord): ProjectInitializedPayload {
    return {
      projectId: project.id,
      name: project.name,
      repository: project.repository,
      defaultBranch: project.defaultBranch,
    };
  }

  it('sequences events monotonically within a project', () => {
    const project = createProject();
    const ticket = createTicket(project.id);
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
      ticketId: ticket.id,
      type: EventType.TICKET_CREATED,
      payload: {
        ticketId: ticket.id,
        title: ticket.title,
        priority: ticket.priority,
        dependsOn: [],
      },
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
      payload: initializedPayload(project),
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
        payload: initializedPayload(projectId === first.id ? first : second),
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

  it('enforces ticket and run project ownership before consuming a sequence', () => {
    const first = createProject();
    const second = createProject();
    const firstTicket = createTicket(first.id, 'CORE-101');
    const secondTicket = createTicket(second.id, 'CORE-201');
    const firstRun = createRun(firstTicket.id);
    const secondRun = createRun(secondTicket.id);
    const eventRepo = createEventRepository(db);

    const success = eventRepo.append({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      projectId: first.id,
      ticketId: firstTicket.id,
      runId: firstRun.id,
      type: EventType.RUN_CREATED,
      payload: { runId: firstRun.id, ticketId: firstTicket.id, baseSha: firstRun.baseSha },
    });
    expect(success.sequence).toBe(1);

    const crossTicket = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      projectId: first.id,
      ticketId: secondTicket.id,
      type: EventType.TICKET_CREATED,
      payload: {
        ticketId: secondTicket.id,
        title: secondTicket.title,
        priority: secondTicket.priority,
        dependsOn: [],
      },
    } as const;
    expect(() => eventRepo.append(crossTicket)).toThrow(/does not belong/);

    const crossRun = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      projectId: first.id,
      ticketId: firstTicket.id,
      runId: secondRun.id,
      type: EventType.RUN_CREATED,
      payload: { runId: secondRun.id, ticketId: firstTicket.id, baseSha: secondRun.baseSha },
    } as const;
    expect(() => eventRepo.append(crossRun)).toThrow(/run .* does not belong/);

    const mismatchedTicketAndRun = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      projectId: first.id,
      ticketId: firstTicket.id,
      runId: secondRun.id,
      type: EventType.RUN_CREATED,
      payload: { runId: secondRun.id, ticketId: firstTicket.id, baseSha: secondRun.baseSha },
    } as const;
    expect(() => eventRepo.append(mismatchedTicketAndRun)).toThrow(/does not belong/);

    expect(eventRepo.countByProjectId(first.id)).toBe(1);
    expect(eventRepo.countByProjectId(second.id)).toBe(0);
    expect(
      eventRepo.append({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        projectId: first.id,
        type: EventType.PROJECT_INITIALIZED,
        payload: initializedPayload(first),
      }).sequence
    ).toBe(2);
  });

  it('rejects mismatched ticket and run identities within one project', () => {
    const project = createProject();
    const firstTicket = createTicket(project.id, 'CORE-101');
    const secondTicket = createTicket(project.id, 'CORE-102');
    const run = createRun(secondTicket.id);

    expect(() =>
      createEventRepository(db).append({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        projectId: project.id,
        ticketId: firstTicket.id,
        runId: run.id,
        type: EventType.RUN_CREATED,
        payload: { runId: run.id, ticketId: firstTicket.id, baseSha: run.baseSha },
      })
    ).toThrow(/belongs to ticket/);
  });

  it('rejects missing ticket and run references without consuming a sequence', () => {
    const project = createProject();
    const ticket = createTicket(project.id);
    const eventRepo = createEventRepository(db);
    const missingRunId = randomUUID();

    expect(() =>
      eventRepo.append({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        projectId: project.id,
        ticketId: 'CORE-999',
        type: EventType.TICKET_CREATED,
        payload: {
          ticketId: 'CORE-999',
          title: 'Missing',
          priority: 'high',
          dependsOn: [],
        },
      })
    ).toThrow(/missing ticket/);
    expect(() =>
      eventRepo.append({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        projectId: project.id,
        ticketId: ticket.id,
        runId: missingRunId,
        type: EventType.RUN_CREATED,
        payload: { runId: missingRunId, ticketId: ticket.id, baseSha: 'abc123' },
      })
    ).toThrow(/missing run/);

    expect(eventRepo.countByProjectId(project.id)).toBe(0);
    expect(
      eventRepo.append({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        projectId: project.id,
        type: EventType.PROJECT_INITIALIZED,
        payload: initializedPayload(project),
      }).sequence
    ).toBe(1);
  });

  it('runtime-validates every event payload and duplicated envelope identity', () => {
    const projectId = randomUUID();
    const ticketId = 'CORE-001';
    const runId = randomUUID();
    const base = {
      id: randomUUID(),
      sequence: 1,
      timestamp: new Date().toISOString(),
      projectId,
    };
    const validEvents = [
      { ...base, type: EventType.PROJECT_INITIALIZED, payload: { projectId, name: 'test', repository: 'owner/repo', defaultBranch: 'main' } },
      { ...base, ticketId, type: EventType.TICKET_CREATED, payload: { ticketId, title: 'Ticket', priority: 'high', dependsOn: [] } },
      { ...base, ticketId, type: EventType.TICKET_STATE_CHANGED, payload: { ticketId, previous: TicketState.QUEUED, next: TicketState.ELIGIBLE } },
      { ...base, type: EventType.TICKET_SUGGESTED, payload: { suggestionId: 'SUGGESTION-001', title: 'Suggestion', reason: 'Follow-up' } },
      { ...base, ticketId, runId, type: EventType.RUN_CREATED, payload: { runId, ticketId, baseSha: 'abc123' } },
      { ...base, ticketId, runId, type: EventType.RUN_COMPLETED, payload: { runId, ticketId, status: 'completed', completedAt: new Date().toISOString() } },
    ];
    for (const event of validEvents) expect(eventSchema.safeParse(event).success).toBe(true);

    const invalidPayloads = [
      { ...base, type: EventType.PROJECT_INITIALIZED, payload: { foo: 'bar' } },
      { ...base, ticketId, type: EventType.TICKET_CREATED, payload: { foo: 'bar' } },
      { ...base, ticketId, type: EventType.TICKET_STATE_CHANGED, payload: { foo: 'bar' } },
      { ...base, type: EventType.TICKET_SUGGESTED, payload: { foo: 'bar' } },
      { ...base, ticketId, runId, type: EventType.RUN_CREATED, payload: { foo: 'bar' } },
      { ...base, ticketId, runId, type: EventType.RUN_COMPLETED, payload: { foo: 'bar' } },
    ];
    for (const event of invalidPayloads) {
      expect(eventSchema.safeParse(event).success).toBe(false);
    }
    const invalidEnvelopes = [
      { ...validEvents[0], ticketId },
      { ...validEvents[1], runId },
      { ...validEvents[3], ticketId },
      { ...base, ticketId, type: EventType.RUN_CREATED, payload: { runId, ticketId, baseSha: 'abc123' } },
    ];
    for (const event of invalidEnvelopes) {
      expect(eventSchema.safeParse(event).success).toBe(false);
    }

    expect(
      eventSchema.safeParse({
        ...base,
        type: EventType.PROJECT_INITIALIZED,
        payload: { projectId: randomUUID(), name: 'test', repository: 'owner/repo', defaultBranch: 'main' },
      }).success
    ).toBe(false);
    expect(
      eventSchema.safeParse({
        ...base,
        ticketId,
        runId,
        type: EventType.RUN_CREATED,
        payload: { runId: randomUUID(), ticketId, baseSha: 'abc123' },
      }).success
    ).toBe(false);

  });

  it('rejects a runtime-mutated payload at append without persisting it', () => {
    const project = createProject();
    const ticket = createTicket(project.id);
    const eventRepo = createEventRepository(db);
    const malformed = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      projectId: project.id,
      ticketId: ticket.id,
      type: EventType.TICKET_STATE_CHANGED,
      payload: { foo: 'bar' },
    } as unknown as NewShipgraphEvent;

    expect(() => eventRepo.append(malformed)).toThrow();
    expect(eventRepo.countByProjectId(project.id)).toBe(0);
    expect(
      eventRepo.append({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        projectId: project.id,
        type: EventType.PROJECT_INITIALIZED,
        payload: initializedPayload(project),
      }).sequence
    ).toBe(1);
  });
});
