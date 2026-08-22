import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, migrate, MIGRATIONS } from '../../src/persistence/db.js';
import type { DbConnection } from '../../src/persistence/db.js';
import {
  createProjectRepository,
  createTicketRepository,
  createTicketDependencyRepository,
  createRunRepository,
  createEventRepository,
} from '../../src/persistence/repositories.js';
import type { ProjectRecord, TicketRecord, RunRecord } from '../../src/persistence/repositories.js';

import type { ShipgraphConfig } from '../../src/config/schema.js';
import { EventType } from '../../src/events/event.js';

const TEST_CONFIG: ShipgraphConfig = {
  version: 1,
  project: { name: 'test', repository: 'owner/repo', defaultBranch: 'main' },
  execution: { maxConcurrentTickets: 1, maxRepairIterations: 6 },
  release: { requireHumanApproval: true, requireCleanCI: true, requireExactShaReviews: true },
  agents: { implementer: 'opencode', reviewers: ['correctness'] },
};

describe('SQLite persistence', () => {
  let db: DbConnection;
  let databaseDir: string;

  beforeEach(() => {
    databaseDir = mkdtempSync(join(tmpdir(), 'shipgraph-persistence-'));
    db = createDatabase(join(databaseDir, 'shipgraph.db'));
    migrate(db);
  });

  afterEach(() => {
    db.close();
    rmSync(databaseDir, { recursive: true, force: true });
  });

  it('applies migrations to an empty database', () => {
    const applied = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number }>;
    expect(applied.map((m) => m.version)).toEqual(MIGRATIONS.map((m) => m.version));
  });

  it('fails closed when the database contains an unknown migration', () => {
    db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
    ).run(999, 'future_schema', new Date().toISOString());

    expect(() => migrate(db)).toThrow(/not supported/);
  });

  it('enforces append-only events at the database boundary', () => {
    const projectId = randomUUID();
    createProjectRepository(db).create({
      id: projectId,
      name: 'test',
      repository: 'owner/repo',
      defaultBranch: 'main',
      config: TEST_CONFIG,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const event = createEventRepository(db).append({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      projectId,
      type: EventType.PROJECT_INITIALIZED,
      payload: { projectId },
    });

    expect(() =>
      db.prepare('UPDATE events SET type = ? WHERE id = ?').run('changed', event.id)
    ).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM events WHERE id = ?').run(event.id)).toThrow(
      /append-only/
    );
  });

  it('stores and retrieves a project', () => {
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
    const found = repo.findById(project.id);
    expect(found).toBeDefined();
    expect(found?.name).toBe('test');
    expect(found?.config.project.repository).toBe('owner/repo');
  });

  it('stores and retrieves tickets with dependencies', () => {
    const projectRepo = createProjectRepository(db);
    const ticketRepo = createTicketRepository(db);
    const depRepo = createTicketDependencyRepository(db);

    const projectId = randomUUID();
    projectRepo.create({
      id: projectId,
      name: 'test',
      repository: 'owner/repo',
      defaultBranch: 'main',
      config: TEST_CONFIG,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const base: TicketRecord = {
      id: 'CORE-001',
      projectId,
      title: 'Base',
      description: 'Base ticket.',
      priority: 'high',
      risk: 'medium',
      status: 'QUEUED',
      scope: { allowedPaths: [], forbiddenPaths: [] },
      acceptanceCriteria: [],
      verification: { commands: [] },
      agent: {},
      release: {},
      dependsOn: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const dependent: TicketRecord = {
      ...base,
      id: 'CORE-002',
      title: 'Dependent',
      dependsOn: ['CORE-001'],
    };

    ticketRepo.create(base);
    ticketRepo.create(dependent);
    const found = ticketRepo.findById('CORE-002');
    expect(found?.dependsOn).toEqual(['CORE-001']);

    const projectTickets = ticketRepo.findByProjectId(projectId);
    expect(projectTickets).toHaveLength(2);

    expect(() =>
      ticketRepo.create({ ...base, id: 'CORE-003', dependsOn: ['CORE-999'] })
    ).toThrow();

    expect(ticketRepo.findById('CORE-003')).toBeUndefined();

    expect(() =>
      depRepo.createMany([
        {
          ticketId: 'CORE-002',
          dependsOnTicketId: 'CORE-999',
          createdAt: new Date().toISOString(),
        },
      ])
    ).toThrow();
  });

  it('counts tickets by project', () => {
    const projectRepo = createProjectRepository(db);
    const ticketRepo = createTicketRepository(db);

    const projectId = randomUUID();
    projectRepo.create({
      id: projectId,
      name: 'test',
      repository: 'owner/repo',
      defaultBranch: 'main',
      config: TEST_CONFIG,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    ticketRepo.create({
      id: 'CORE-001',
      projectId,
      title: 'One',
      description: 'First.',
      priority: 'high',
      risk: 'medium',
      status: 'QUEUED',
      scope: { allowedPaths: [], forbiddenPaths: [] },
      acceptanceCriteria: [],
      verification: { commands: [] },
      agent: {},
      release: {},
      dependsOn: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(ticketRepo.countByProjectId(projectId)).toBe(1);
  });

  it('stores and retrieves runs', () => {
    const projectRepo = createProjectRepository(db);
    const ticketRepo = createTicketRepository(db);
    const runRepo = createRunRepository(db);

    const projectId = randomUUID();
    projectRepo.create({
      id: projectId,
      name: 'test',
      repository: 'owner/repo',
      defaultBranch: 'main',
      config: TEST_CONFIG,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    ticketRepo.create({
      id: 'CORE-001',
      projectId,
      title: 'Ticket',
      description: 'A ticket.',
      priority: 'high',
      risk: 'medium',
      status: 'QUEUED',
      scope: { allowedPaths: [], forbiddenPaths: [] },
      acceptanceCriteria: [],
      verification: { commands: [] },
      agent: {},
      release: {},
      dependsOn: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const run: RunRecord = {
      id: randomUUID(),
      ticketId: 'CORE-001',
      baseSha: 'abc123',
      branchName: 'agent/core-001',
      status: 'running',
      startedAt: new Date().toISOString(),
    };

    runRepo.create(run);
    const found = runRepo.findById(run.id);
    expect(found?.baseSha).toBe('abc123');
  });
});
