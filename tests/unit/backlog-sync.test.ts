import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase, migrate, openAndMigrate } from '../../src/persistence/db.js';
import type { DbConnection } from '../../src/persistence/db.js';
import {
  createEventRepository,
  createProjectRepository,
  createTicketRepository,
  type ProjectRecord,
} from '../../src/persistence/repositories.js';
import { syncApprovedBacklog } from '../../src/persistence/backlog-sync.js';
import { reconcileEligibility } from '../../src/scheduler/eligibility.js';
import { calculateReady } from '../../src/scheduler/ready.js';
import { TicketState } from '../../src/core/state-machine/state.js';
import { EventType } from '../../src/events/event.js';
import type { ShipgraphConfig } from '../../src/config/schema.js';
import { validateBacklog } from '../../src/backlog/schema.js';

const config = (name: string, maxConcurrentTickets = 2): ShipgraphConfig => ({
  version: 1,
  project: { name, repository: `owner/${name}`, defaultBranch: 'main' },
  execution: { maxConcurrentTickets, maxRepairIterations: 6 },
  release: { requireHumanApproval: true, requireCleanCI: true, requireExactShaReviews: true },
  agents: { implementer: 'opencode', reviewers: ['correctness'] },
});

const definition = (id: string, dependsOn: string[] = [], priority: 'critical' | 'high' | 'medium' | 'low' = 'medium') => ({
  id,
  title: `Ticket ${id}`,
  description: `Description for ${id}`,
  priority,
  dependsOn,
  scope: { allowedPaths: [], forbiddenPaths: [] },
  acceptanceCriteria: [],
  verification: { commands: [] },
  risk: 'medium',
  agent: {},
  release: {},
});

describe('persistent approved backlog synchronization', () => {
  let db: DbConnection;
  let databaseDir: string;

  beforeEach(() => {
    databaseDir = mkdtempSync(join(tmpdir(), 'shipgraph-backlog-sync-'));
    db = createDatabase(join(databaseDir, 'shipgraph.db'));
    migrate(db);
  });

  afterEach(() => {
    db.close();
    rmSync(databaseDir, { recursive: true, force: true });
  });

  function createProject(name = 'scheduler', maxConcurrentTickets = 2): ProjectRecord {
    const project: ProjectRecord = {
      id: randomUUID(),
      name,
      repository: `owner/${name}`,
      defaultBranch: 'main',
      config: config(name, maxConcurrentTickets),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    createProjectRepository(db).create(project);
    return project;
  }

  it('imports a forward-referenced chain, reconciles roots, and is idempotent', () => {
    const project = createProject();
    const backlog = validateBacklog({
      version: 1,
      tickets: [
        definition('WORK-001', ['CORE-002']),
        definition('CORE-002', ['CORE-001'], 'high'),
        definition('CORE-001', [], 'critical'),
      ],
    });

    const first = syncApprovedBacklog(db, project.id, backlog);
    expect(first).toEqual({ new: 3, unchanged: 0, eligible: 1, queued: 2 });
    expect(createTicketRepository(db).findById('CORE-001')?.status).toBe(TicketState.ELIGIBLE);
    expect(createEventRepository(db).findByProjectId(project.id)).toHaveLength(4);

    const second = syncApprovedBacklog(db, project.id, backlog);
    expect(second).toEqual({ new: 0, unchanged: 3, eligible: 1, queued: 2 });
    expect(createEventRepository(db).findByProjectId(project.id)).toHaveLength(4);
  });

  it('never resets runtime state and rejects static drift or removals', () => {
    const project = createProject();
    const backlog = validateBacklog({ version: 1, tickets: [definition('CORE-001')] });
    syncApprovedBacklog(db, project.id, backlog);

    db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run(TicketState.IMPLEMENTING, 'CORE-001');
    expect(() =>
      syncApprovedBacklog(db, project.id, validateBacklog({
        version: 1,
        tickets: [{ ...definition('CORE-001'), title: 'Changed' }],
      }))
    ).toThrow(/static contract drifted/);

    syncApprovedBacklog(db, project.id, backlog);
    expect(createTicketRepository(db).findById('CORE-001')?.status).toBe(TicketState.IMPLEMENTING);
    expect(() => syncApprovedBacklog(db, project.id, validateBacklog({ version: 1, tickets: [] }))).toThrow(/missing persisted/);
  });

  it('keeps unapproved persisted suggestions out of the executable backlog', () => {
    const project = createProject();
    createTicketRepository(db).create({
      id: 'SUGGEST-001',
      projectId: project.id,
      title: 'Unapproved suggestion',
      description: 'Not yet accepted into the approved backlog.',
      priority: 'high',
      risk: 'low',
      status: TicketState.QUEUED,
      scope: { allowedPaths: [], forbiddenPaths: [] },
      acceptanceCriteria: [],
      verification: { commands: [] },
      agent: {},
      release: {},
      dependsOn: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const report = syncApprovedBacklog(
      db,
      project.id,
      validateBacklog({ version: 1, tickets: [definition('CORE-001')] })
    );
    expect(report).toMatchObject({ new: 1, unchanged: 0, eligible: 1 });
    expect(createTicketRepository(db).findByProjectId(project.id)).toHaveLength(2);
    expect(createTicketRepository(db).findApprovedByProjectId(project.id).map((ticket) => ticket.id)).toEqual(['CORE-001']);
  });

  it('rolls back rows, dependencies, events, and metadata when event creation fails', () => {
    const project = createProject();
    const eventId = randomUUID();
    createEventRepository(db).append({
      id: eventId,
      timestamp: new Date().toISOString(),
      projectId: project.id,
      type: EventType.PROJECT_INITIALIZED,
      payload: {
        projectId: project.id,
        name: project.name,
        repository: project.repository,
        defaultBranch: project.defaultBranch,
      },
    });

    expect(() =>
      syncApprovedBacklog(
        db,
        project.id,
        validateBacklog({
          version: 1,
          tickets: [definition('CORE-001'), definition('CORE-002', ['CORE-001'])],
        }),
        {
          createEventId: (() => {
            let calls = 0;
            return () => (calls++ === 0 ? randomUUID() : eventId);
          })(),
        }
      )
    ).toThrow();
    expect(createTicketRepository(db).findByProjectId(project.id)).toHaveLength(0);
    expect(createEventRepository(db).findByProjectId(project.id)).toHaveLength(1);
    expect(db.prepare('SELECT * FROM backlog_syncs WHERE project_id = ?').get(project.id)).toBeUndefined();
  });

  it('unlocks successors after persisted completion and survives reopening', () => {
    const project = createProject();
    const backlog = validateBacklog({
      version: 1,
      tickets: [definition('A-001'), definition('B-001', ['A-001']), definition('C-001', ['A-001'])],
    });
    syncApprovedBacklog(db, project.id, backlog);
    db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run(TicketState.COMPLETE, 'A-001');

    db.close();
    db = openAndMigrate(join(databaseDir, 'shipgraph.db'));
    const reconciliation = reconcileEligibility(db, project.id);
    expect(reconciliation.promoted).toEqual(['B-001', 'C-001']);
    const eventCount = createEventRepository(db).findByProjectId(project.id).length;
    expect(eventCount).toBe(6);

    const secondReconciliation = reconcileEligibility(db, project.id);
    expect(secondReconciliation.promoted).toEqual([]);
    expect(createEventRepository(db).findByProjectId(project.id)).toHaveLength(eventCount);
    expect(calculateReady(createTicketRepository(db).findByProjectId(project.id), 2).eligible.map((entry) => entry.ticket)).toEqual(['B-001', 'C-001']);
    expect(calculateReady(createTicketRepository(db).findByProjectId(project.id), 2).dispatchable.map((entry) => entry.ticket)).toEqual(['B-001', 'C-001']);
  });

  it('rolls back every eligibility promotion when one audit event fails', () => {
    const project = createProject();
    const backlog = validateBacklog({
      version: 1,
      tickets: [definition('A-001'), definition('B-001', ['A-001']), definition('C-001', ['A-001'])],
    });
    syncApprovedBacklog(db, project.id, backlog);
    db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run(TicketState.COMPLETE, 'A-001');
    const existingEventId = createEventRepository(db).findByProjectId(project.id)[0]?.id;
    expect(existingEventId).toBeDefined();

    let eventCalls = 0;
    expect(() =>
      reconcileEligibility(db, project.id, {
        createEventId: () => (eventCalls++ === 0 ? randomUUID() : existingEventId as string),
      })
    ).toThrow();
    expect(createTicketRepository(db).findById('B-001')?.status).toBe(TicketState.QUEUED);
    expect(createTicketRepository(db).findById('C-001')?.status).toBe(TicketState.QUEUED);
    expect(createEventRepository(db).findByProjectId(project.id)).toHaveLength(4);
  });

  it('keeps projects isolated during sync and ready calculation', () => {
    const first = createProject('first', 1);
    const second = createProject('second', 1);
    syncApprovedBacklog(db, first.id, validateBacklog({ version: 1, tickets: [definition('FIRST-001', [], 'high')] }));
    syncApprovedBacklog(db, second.id, validateBacklog({ version: 1, tickets: [definition('SECOND-001', [], 'high')] }));

    const firstReady = calculateReady(createTicketRepository(db).findByProjectId(first.id), 1);
    expect(firstReady.eligible.map((entry) => entry.ticket)).toEqual(['FIRST-001']);
    expect(firstReady.eligible.some((entry) => entry.ticket === 'SECOND-001')).toBe(false);
    expect(createEventRepository(db).findByProjectId(first.id)).toHaveLength(2);
    expect(createEventRepository(db).findByProjectId(second.id)).toHaveLength(2);
  });
});
