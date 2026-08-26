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

  it('upgrades a version-one database without losing existing data', () => {
    const legacyPath = join(databaseDir, 'legacy.db');
    const legacy = createDatabase(legacyPath);
    legacy.exec(MIGRATIONS[0].up);
    legacy
      .prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
      )
      .run(1, MIGRATIONS[0].name, new Date().toISOString());
    createProjectRepository(legacy).create({
      id: 'legacy-project',
      name: 'test',
      repository: 'owner/repo',
      defaultBranch: 'main',
      config: TEST_CONFIG,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    legacy.close();

    const upgraded = createDatabase(legacyPath);
    migrate(upgraded);
    expect(upgraded.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual(
      MIGRATIONS.map((migration) => ({ version: migration.version }))
    );
    expect(createProjectRepository(upgraded).findById('legacy-project')?.name).toBe('test');
    migrate(upgraded);
    expect(upgraded.prepare('SELECT COUNT(*) AS count FROM backlog_syncs').get()).toEqual({ count: 0 });
    expect(upgraded.prepare('SELECT COUNT(*) AS count FROM approved_backlog_tickets').get()).toEqual({ count: 0 });
    upgraded.close();
  });

  it('upgrades legacy duplicate model finalizations without rejecting historical telemetry', () => {
    const legacyPath = join(databaseDir, 'legacy-model-usage.db');
    const legacy = createDatabase(legacyPath);
    for (const migration of MIGRATIONS.slice(0, 9)) {
      legacy.exec(migration.up);
      legacy
        .prepare(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
        )
        .run(migration.version, migration.name, new Date().toISOString());
    }
    const now = new Date().toISOString();
    legacy.prepare(
      `INSERT INTO projects (
        id, name, repository, default_branch, config_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'legacy-model-project',
      'legacy-model',
      'owner/legacy-model',
      'main',
      JSON.stringify(TEST_CONFIG),
      now,
      now
    );
    legacy.prepare(
      `INSERT INTO tickets (
        id, project_id, title, description, priority, risk, status, scope_json,
        acceptance_criteria_json, verification_json, agent_json, release_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'KAR-9001',
      'legacy-model-project',
      'legacy model usage',
      'legacy fixture',
      'medium',
      'medium',
      'QUEUED',
      '{}',
      '[]',
      '{}',
      '{}',
      '{}',
      now,
      now
    );
    legacy.prepare(
      `INSERT INTO runs (
        id, ticket_id, base_sha, branch_name, status, started_at, project_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'legacy-run',
      'KAR-9001',
      '0'.repeat(40),
      'agent/legacy-model',
      'SUCCEEDED',
      now,
      'legacy-model-project',
      now,
      now
    );
    legacy.prepare(
      `INSERT INTO routing_decisions (
        id, project_id, request_id, task, risk, mode, provider_id, provider_family,
        model_id, reason, candidates_considered, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'legacy-decision',
      'legacy-model-project',
      'legacy-request',
      'implementation',
      'medium',
      'balanced',
      'codex',
      'openai',
      'provider/dynamic',
      'legacy fixture',
      1,
      now
    );
    const insertUsage = legacy.prepare(
      `INSERT INTO usage_ledger (
        id, project_id, run_id, routing_decision_id, provider_id, model_id, task,
        retry_count, elapsed_ms, outcome, outcome_quality, input_tokens_json,
        output_tokens_json, cost_json, quota_remaining_json, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const id of ['legacy-usage-1', 'legacy-usage-2']) {
      insertUsage.run(
        id,
        'legacy-model-project',
        'legacy-run',
        'legacy-decision',
        'codex',
        'provider/dynamic',
        'implementation',
        0,
        1,
        'succeeded',
        'good',
        JSON.stringify('unknown'),
        JSON.stringify('unknown'),
        JSON.stringify('unknown'),
        JSON.stringify('unknown'),
        now
      );
    }
    legacy.close();

    const upgraded = createDatabase(legacyPath);
    expect(() => migrate(upgraded)).not.toThrow();
    expect(upgraded.prepare(
      'SELECT COUNT(*) AS count FROM usage_ledger WHERE routing_decision_id = ?'
    ).get('legacy-decision')).toEqual({ count: 2 });
    const insertUpgradedUsage = upgraded.prepare(
      `INSERT INTO usage_ledger (
        id, project_id, run_id, routing_decision_id, provider_id, model_id, task,
        retry_count, elapsed_ms, outcome, outcome_quality, input_tokens_json,
        output_tokens_json, cost_json, quota_remaining_json, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    expect(() => insertUpgradedUsage.run(
      'legacy-usage-3',
      'legacy-model-project',
      'legacy-run',
      'legacy-decision',
      'codex',
      'provider/dynamic',
      'implementation',
      0,
      1,
      'succeeded',
      'good',
      JSON.stringify('unknown'),
      JSON.stringify('unknown'),
      JSON.stringify('unknown'),
      JSON.stringify('unknown'),
      now
    )).toThrow(/already finalized/);
    upgraded.close();
  });

  it('rejects direct creation of a ticket that skips the queued approval boundary', () => {
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
    expect(() =>
      createTicketRepository(db).create({
        id: 'UNAPPROVED-001',
        projectId,
        title: 'Unapproved',
        description: 'Must not skip approval.',
        priority: 'high',
        risk: 'medium',
        status: 'ELIGIBLE',
        scope: { allowedPaths: [], forbiddenPaths: [] },
        acceptanceCriteria: [],
        verification: { commands: [] },
        agent: {},
        release: {},
        dependsOn: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    ).toThrow(/must start in QUEUED/);

    createTicketRepository(db).create({
      id: 'UNAPPROVED-002',
      projectId,
      title: 'Queued suggestion',
      description: 'Still outside the approved backlog.',
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
    db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run('ELIGIBLE', 'UNAPPROVED-002');
    expect(createTicketRepository(db).findApprovedByProjectId(projectId)).toHaveLength(0);
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
      payload: {
        projectId,
        name: 'test',
        repository: 'owner/repo',
        defaultBranch: 'main',
      },
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

  it('keeps a real two-project database isolated across tickets, dependencies, runs, events, and queries', () => {
    const projectRepo = createProjectRepository(db);
    const ticketRepo = createTicketRepository(db);
    const dependencyRepo = createTicketDependencyRepository(db);
    const runRepo = createRunRepository(db);
    const eventRepo = createEventRepository(db);
    const now = new Date().toISOString();

    const firstProject: ProjectRecord = {
      id: randomUUID(),
      name: 'first',
      repository: 'owner/first',
      defaultBranch: 'main',
      config: {
        ...TEST_CONFIG,
        project: { name: 'first', repository: 'owner/first', defaultBranch: 'main' },
      },
      createdAt: now,
      updatedAt: now,
    };
    const secondProject: ProjectRecord = {
      id: randomUUID(),
      name: 'second',
      repository: 'owner/second',
      defaultBranch: 'trunk',
      config: {
        ...TEST_CONFIG,
        project: { name: 'second', repository: 'owner/second', defaultBranch: 'trunk' },
      },
      createdAt: now,
      updatedAt: now,
    };
    projectRepo.create(firstProject);
    projectRepo.create(secondProject);

    const ticket = (id: string, projectId: string): TicketRecord => ({
      id,
      projectId,
      title: id,
      description: `${id} ticket`,
      priority: 'high',
      risk: 'medium',
      status: 'QUEUED',
      scope: { allowedPaths: [], forbiddenPaths: [] },
      acceptanceCriteria: [],
      verification: { commands: [] },
      agent: {},
      release: {},
      dependsOn: [],
      createdAt: now,
      updatedAt: now,
    });
    const firstTicket = ticket('FIRST-001', firstProject.id);
    const firstDependency = ticket('FIRST-000', firstProject.id);
    const firstDependencyTwo = ticket('FIRST-002', firstProject.id);
    const secondTicket = ticket('SECOND-001', secondProject.id);
    ticketRepo.create(firstTicket);
    ticketRepo.create(firstDependency);
    ticketRepo.create(firstDependencyTwo);
    ticketRepo.create(secondTicket);

    dependencyRepo.createMany([
      { ticketId: firstTicket.id, dependsOnTicketId: firstDependency.id, createdAt: now },
    ]);
    expect(() =>
      dependencyRepo.createMany([
        { ticketId: firstTicket.id, dependsOnTicketId: secondTicket.id, createdAt: now },
      ])
    ).toThrow(/crosses project boundaries/);
    expect(dependencyRepo.findByTicketId(firstTicket.id)).toHaveLength(1);
    expect(() =>
      dependencyRepo.createMany([
        {
          ticketId: firstDependency.id,
          dependsOnTicketId: firstDependencyTwo.id,
          createdAt: now,
        },
        { ticketId: firstTicket.id, dependsOnTicketId: secondTicket.id, createdAt: now },
      ])
    ).toThrow(/crosses project boundaries/);
    expect(dependencyRepo.findByTicketId(firstDependency.id)).toHaveLength(0);
    expect(() =>
      dependencyRepo.createMany([
        { ticketId: firstTicket.id, dependsOnTicketId: firstTicket.id, createdAt: now },
      ])
    ).toThrow(/cannot depend on itself/);
    expect(() =>
      dependencyRepo.createMany([
        { ticketId: firstDependency.id, dependsOnTicketId: firstTicket.id, createdAt: now },
      ])
    ).toThrow(/must remain acyclic/);
    expect(() =>
      dependencyRepo.createMany([
        { ticketId: firstDependency.id, dependsOnTicketId: firstDependencyTwo.id, createdAt: now },
        { ticketId: firstDependencyTwo.id, dependsOnTicketId: firstDependency.id, createdAt: now },
      ])
    ).toThrow(/must remain acyclic/);
    expect(dependencyRepo.findByTicketId(firstDependency.id)).toHaveLength(0);
    expect(dependencyRepo.findByTicketId(firstDependencyTwo.id)).toHaveLength(0);

    const firstRun: RunRecord = {
      id: randomUUID(),
      ticketId: firstTicket.id,
      baseSha: 'first-sha',
      branchName: 'agent/first',
      status: 'running',
      startedAt: now,
    };
    const secondRun: RunRecord = {
      ...firstRun,
      id: randomUUID(),
      ticketId: secondTicket.id,
      baseSha: 'second-sha',
      branchName: 'agent/second',
    };
    runRepo.create(firstRun);
    runRepo.create(secondRun);
    expect(runRepo.findByTicketId(firstTicket.id).map((run) => run.id)).toEqual([
      firstRun.id,
    ]);

    const appendInitialized = (project: ProjectRecord) =>
      eventRepo.append({
        id: randomUUID(),
        timestamp: now,
        projectId: project.id,
        type: EventType.PROJECT_INITIALIZED,
        payload: {
          projectId: project.id,
          name: project.name,
          repository: project.repository,
          defaultBranch: project.defaultBranch,
        },
      });
    expect(appendInitialized(firstProject).sequence).toBe(1);
    expect(appendInitialized(firstProject).sequence).toBe(2);
    expect(appendInitialized(secondProject).sequence).toBe(1);

    expect(() =>
      eventRepo.append({
        id: randomUUID(),
        timestamp: now,
        projectId: firstProject.id,
        ticketId: firstTicket.id,
        runId: secondRun.id,
        type: EventType.RUN_CREATED,
        payload: {
          runId: secondRun.id,
          ticketId: firstTicket.id,
          baseSha: secondRun.baseSha,
        },
      })
    ).toThrow(/run .* does not belong/);

    expect(ticketRepo.findByProjectId(firstProject.id).map((item) => item.id).sort()).toEqual([
      firstDependency.id,
      firstDependencyTwo.id,
      firstTicket.id,
    ].sort());
    expect(ticketRepo.findByProjectId(secondProject.id).map((item) => item.id)).toEqual([
      secondTicket.id,
    ]);
    expect(ticketRepo.countByProjectId(firstProject.id)).toBe(3);
    expect(ticketRepo.countByProjectId(secondProject.id)).toBe(1);
    expect(eventRepo.countByProjectId(firstProject.id)).toBe(2);
    expect(eventRepo.countByProjectId(secondProject.id)).toBe(1);
  });
});
