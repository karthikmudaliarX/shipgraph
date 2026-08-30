import Database from 'better-sqlite3';

export type DbConnection = Database.Database;

export type Migration = {
  version: number;
  name: string;
  up: string;
};

/**
 * Versioned schema migrations.
 *
 * Migrations are explicit and ordered. The migrations table tracks applied
 * versions so an empty database can be brought up to the latest schema.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'create_initial_tables',
    up: `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repository TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        priority TEXT NOT NULL,
        risk TEXT NOT NULL,
        status TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        acceptance_criteria_json TEXT NOT NULL,
        verification_json TEXT NOT NULL,
        agent_json TEXT NOT NULL,
        release_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );

      CREATE TABLE IF NOT EXISTS ticket_dependencies (
        ticket_id TEXT NOT NULL,
        depends_on_ticket_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (ticket_id, depends_on_ticket_id),
        FOREIGN KEY (ticket_id) REFERENCES tickets(id),
        FOREIGN KEY (depends_on_ticket_id) REFERENCES tickets(id)
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id)
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        project_id TEXT NOT NULL,
        ticket_id TEXT,
        run_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE (project_id, sequence),
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (ticket_id) REFERENCES tickets(id),
        FOREIGN KEY (run_id) REFERENCES runs(id)
      );

      CREATE INDEX IF NOT EXISTS idx_tickets_project_id
        ON tickets(project_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_ticket_dependencies_depends_on
        ON ticket_dependencies(depends_on_ticket_id);
      CREATE INDEX IF NOT EXISTS idx_runs_ticket_id
        ON runs(ticket_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_events_ticket_sequence
        ON events(ticket_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_events_run_sequence
        ON events(run_id, sequence);

      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TRIGGER IF NOT EXISTS events_are_append_only_update
      BEFORE UPDATE ON events
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS events_are_append_only_delete
      BEFORE DELETE ON events
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END;
    `,
  },
  {
    version: 2,
    name: 'create_backlog_sync_metadata',
    up: `
      CREATE TABLE IF NOT EXISTS backlog_syncs (
        project_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        source_path TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );
    `,
  },
  {
    version: 3,
    name: 'create_approved_backlog_ticket_markers',
    up: `
      CREATE TABLE IF NOT EXISTS approved_backlog_tickets (
        project_id TEXT NOT NULL,
        ticket_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        PRIMARY KEY (project_id, ticket_id),
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (ticket_id) REFERENCES tickets(id)
      );
    `,
  },
  {
    version: 4,
    name: 'create_ticket_workspaces',
    up: `
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        ticket_id TEXT NOT NULL,
        source_repository_path TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('CREATING','READY','REMOVED','FAILED','NEEDS_HUMAN')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (ticket_id) REFERENCES tickets(id)
      );

      CREATE INDEX IF NOT EXISTS idx_workspaces_project_ticket
        ON workspaces(project_id, ticket_id);

      -- Persistence-level invariant: a ticket has at most one active
      -- ShipGraph workspace. Uniqueness lives in the schema, not only in
      -- application logic.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_single_active_per_ticket
        ON workspaces(project_id, ticket_id)
        WHERE status IN ('CREATING', 'READY', 'NEEDS_HUMAN');

      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_single_active_branch
        ON workspaces(source_repository_path, branch_name)
        WHERE status IN ('CREATING', 'READY', 'NEEDS_HUMAN');

      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_single_active_path
        ON workspaces(worktree_path)
        WHERE status IN ('CREATING', 'READY', 'NEEDS_HUMAN');
    `,
  },
  {
    version: 5,
    name: 'bind_workspace_repository_identity',
    up: `
      CREATE TABLE IF NOT EXISTS workspace_repository_bindings (
        project_id TEXT PRIMARY KEY,
        source_repository_path TEXT NOT NULL,
        source_directory_device TEXT NOT NULL,
        source_directory_inode TEXT NOT NULL,
        git_common_dir TEXT NOT NULL,
        git_object_dir TEXT NOT NULL,
        git_common_device TEXT NOT NULL,
        git_common_inode TEXT NOT NULL,
        git_object_device TEXT NOT NULL,
        git_object_inode TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );
    `,
  },
  {
    version: 6,
    name: 'persist_agent_execution_runs',
    up: `
      -- The original runs table is retained for CORE-001 compatibility. These
      -- nullable additions let old rows remain readable while every new
      -- AGENT-001 execution is written with a complete durable record.
      ALTER TABLE runs ADD COLUMN project_id TEXT;
      ALTER TABLE runs ADD COLUMN workspace_id TEXT;
      ALTER TABLE runs ADD COLUMN workspace_path TEXT;
      ALTER TABLE runs ADD COLUMN provider TEXT;
      ALTER TABLE runs ADD COLUMN model TEXT;
      ALTER TABLE runs ADD COLUMN created_at TEXT;
      ALTER TABLE runs ADD COLUMN updated_at TEXT;
      ALTER TABLE runs ADD COLUMN provider_session_id TEXT;
      ALTER TABLE runs ADD COLUMN provider_process_id INTEGER;
      ALTER TABLE runs ADD COLUMN exit_code INTEGER;
      ALTER TABLE runs ADD COLUMN termination_signal TEXT;
      ALTER TABLE runs ADD COLUMN timed_out INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE runs ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE runs ADD COLUMN failure_category TEXT;
      ALTER TABLE runs ADD COLUMN failure_reason TEXT;
      ALTER TABLE runs ADD COLUMN stdout TEXT NOT NULL DEFAULT '';
      ALTER TABLE runs ADD COLUMN stderr TEXT NOT NULL DEFAULT '';
      ALTER TABLE runs ADD COLUMN stdout_truncated INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE runs ADD COLUMN stderr_truncated INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE runs ADD COLUMN evidence_json TEXT;
      ALTER TABLE runs ADD COLUMN instructions_sha256 TEXT;
      ALTER TABLE runs ADD COLUMN timeout_ms INTEGER;

      UPDATE runs
         SET created_at = started_at
       WHERE created_at IS NULL;
      UPDATE runs
         SET updated_at = COALESCE(completed_at, started_at)
       WHERE updated_at IS NULL;

      CREATE INDEX IF NOT EXISTS idx_runs_project_ticket
        ON runs(project_id, ticket_id, started_at);

      -- A ticket may have history, but it can never have two live provider
      -- executions. This is a database invariant, not a process-local lock.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_single_active_ticket
        ON runs(ticket_id)
        WHERE status IN ('CREATED', 'STARTING', 'RUNNING');
    `,
  },
  {
    version: 7,
    name: 'persist_model_provider_control_plane',
    up: `
      CREATE TABLE IF NOT EXISTS provider_registry (
        project_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        family TEXT NOT NULL,
        display_name TEXT NOT NULL,
        configured INTEGER NOT NULL CHECK (configured IN (0, 1)),
        availability TEXT NOT NULL,
        version TEXT,
        capabilities_json TEXT NOT NULL,
        catalog_status TEXT NOT NULL CHECK (catalog_status IN ('known', 'unknown')),
        catalog_reason TEXT,
        checked_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, provider_id),
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );

      CREATE TABLE IF NOT EXISTS model_catalog (
        project_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        context_window INTEGER,
        discovered_at TEXT NOT NULL,
        PRIMARY KEY (project_id, provider_id, model_id),
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );

      CREATE INDEX IF NOT EXISTS idx_model_catalog_provider
        ON model_catalog(project_id, provider_id, model_id);

      CREATE TABLE IF NOT EXISTS provider_health (
        project_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        status TEXT NOT NULL,
        auth TEXT NOT NULL,
        quota_pressure TEXT NOT NULL,
        quota_remaining_json TEXT NOT NULL,
        quota_reset_at_json TEXT NOT NULL,
        recent_failure_count INTEGER NOT NULL,
        active_runs INTEGER NOT NULL,
        max_concurrent_runs_json TEXT NOT NULL,
        last_failure_at TEXT,
        last_success_at TEXT,
        checked_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, provider_id),
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );

      CREATE TABLE IF NOT EXISTS usage_ledger (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        task TEXT NOT NULL,
        retry_count INTEGER NOT NULL,
        elapsed_ms INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        outcome_quality TEXT NOT NULL,
        input_tokens_json TEXT NOT NULL,
        output_tokens_json TEXT NOT NULL,
        cost_json TEXT NOT NULL,
        quota_remaining_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (run_id) REFERENCES runs(id)
      );

      CREATE INDEX IF NOT EXISTS idx_usage_ledger_project_time
        ON usage_ledger(project_id, recorded_at, id);
      CREATE INDEX IF NOT EXISTS idx_usage_ledger_provider_model
        ON usage_ledger(project_id, provider_id, model_id, recorded_at);

      CREATE TRIGGER IF NOT EXISTS usage_ledger_are_append_only_update
      BEFORE UPDATE ON usage_ledger
      BEGIN
        SELECT RAISE(ABORT, 'usage ledger is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS usage_ledger_are_append_only_delete
      BEFORE DELETE ON usage_ledger
      BEGIN
        SELECT RAISE(ABORT, 'usage ledger is append-only');
      END;

      CREATE TABLE IF NOT EXISTS routing_decisions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        task TEXT NOT NULL,
        risk TEXT NOT NULL,
        mode TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        provider_family TEXT NOT NULL,
        model_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        candidates_considered INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );

      CREATE INDEX IF NOT EXISTS idx_routing_decisions_project_time
        ON routing_decisions(project_id, created_at, id);

      CREATE TRIGGER IF NOT EXISTS routing_decisions_are_append_only_update
      BEFORE UPDATE ON routing_decisions
      BEGIN
        SELECT RAISE(ABORT, 'routing decisions are append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS routing_decisions_are_append_only_delete
      BEFORE DELETE ON routing_decisions
      BEGIN
        SELECT RAISE(ABORT, 'routing decisions are append-only');
      END;
    `,
  },
  {
    version: 8,
    name: 'bind_model_capacity_reservations',
    up: `
      ALTER TABLE usage_ledger ADD COLUMN routing_decision_id TEXT
        REFERENCES routing_decisions(id);

      CREATE TABLE IF NOT EXISTS provider_capacity_reservations (
        routing_decision_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'released')),
        reserved_at TEXT NOT NULL,
        released_at TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (routing_decision_id) REFERENCES routing_decisions(id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_capacity_request
        ON provider_capacity_reservations(project_id, request_id);
      CREATE INDEX IF NOT EXISTS idx_provider_capacity_provider_status
        ON provider_capacity_reservations(project_id, provider_id, status);
    `,
  },
  {
    version: 9,
    name: 'bind_model_capacity_to_runs',
    up: `
      ALTER TABLE provider_capacity_reservations ADD COLUMN run_id TEXT
        REFERENCES runs(id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_capacity_run
        ON provider_capacity_reservations(project_id, run_id)
        WHERE run_id IS NOT NULL AND status = 'active';
    `,
  },
  {
    version: 10,
    name: 'guard_model_usage_finalization',
    up: `
      -- Do not rewrite or reject legacy duplicate telemetry during upgrade.
      -- New finalization attempts are rejected by this append-only guard.
      CREATE TRIGGER IF NOT EXISTS usage_ledger_one_finalization_per_route
      BEFORE INSERT ON usage_ledger
      WHEN NEW.routing_decision_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM usage_ledger
          WHERE routing_decision_id = NEW.routing_decision_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'usage ledger routing decision was already finalized');
      END;
    `,
  },
  {
    version: 11,
    name: 'persist_provider_execution_capability',
    up: `
      -- Metadata availability is not execution availability. Keep the
      -- capability-probed AGENT-001 surface explicit and fail closed for old
      -- provider rows until a current execution probe succeeds.
      ALTER TABLE provider_registry ADD COLUMN execution_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (execution_status IN ('available', 'unavailable', 'unknown'));
      ALTER TABLE provider_registry ADD COLUMN execution_provider TEXT;
      ALTER TABLE provider_registry ADD COLUMN execution_reason TEXT;
    `,
  },
  {
    version: 12,
    name: 'persist_model_routing_request_fingerprint',
    up: `
      -- Older persisted decisions have no safe record of their selection
      -- constraints; new durable routes carry a canonical request fingerprint
      -- and refuse replay when it is absent.
      ALTER TABLE routing_decisions ADD COLUMN request_fingerprint TEXT;
    `,
  },
  {
    version: 13,
    name: 'persist_model_provider_identity_on_runs',
    up: `
      -- AGENT-001 keeps its provider-neutral adapter identity in provider;
      -- routed MODEL-001 runs also retain the concrete model-provider identity
      -- so ACP-backed Grok and Antigravity runs cannot be substituted.
      ALTER TABLE runs ADD COLUMN model_provider_id TEXT;
    `,
  },
  {
    version: 14,
    name: 'persist_model_task_on_runs',
    up: `
      -- A prepared AGENT-001 run is an execution contract for one MODEL-001
      -- task. Legacy rows may remain NULL, but new route reservations must
      -- match this value exactly before they can start.
      ALTER TABLE runs ADD COLUMN task TEXT
        CHECK (task IS NULL OR task IN ('implementation', 'review', 'repair'));
    `,
  },
  {
    version: 15,
    name: 'bind_agent_safety_policy_to_runs',
    up: `
      -- New prepared AGENT-001 runs must retain the exact effective KAR-7
      -- policy that was validated before routing and provider launch.
      ALTER TABLE runs ADD COLUMN safety_policy_sha256 TEXT;
    `,
  },
  {
    version: 16,
    name: 'persist_pre_pr_review_provenance',
    up: `
      -- KAR-9 review evidence is stored with the existing durable AGENT run.
      -- The exact reviewed commit and axis are immutable run provenance.
      ALTER TABLE runs ADD COLUMN review_type TEXT
        CHECK (review_type IS NULL OR review_type IN ('contract', 'engineering'));
      ALTER TABLE runs ADD COLUMN reviewed_sha TEXT;
      ALTER TABLE runs ADD COLUMN review_result TEXT
        CHECK (review_result IS NULL OR review_result IN ('PASS', 'FAIL'));
      ALTER TABLE runs ADD COLUMN review_findings_json TEXT;
    `,
  },
];

export function createDatabase(path: string): DbConnection {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function createInMemoryDatabase(): DbConnection {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * Apply pending migrations in order inside a transaction.
 */
export function migrate(db: DbConnection): void {
  const applyPending = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const appliedVersions = assertMigrationRowsCompatible(db);
    for (const migration of MIGRATIONS) {
      if (appliedVersions.has(migration.version)) continue;
      db.exec(migration.up);
      db
        .prepare(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
        )
        .run(migration.version, migration.name, new Date().toISOString());
    }
  }).immediate;

  applyPending();
}

/** Validate migration names/versions without mutating a read-only database. */
export function assertMigrationsCompatible(db: DbConnection): void {
  const appliedVersions = assertMigrationRowsCompatible(db);
  const pending = MIGRATIONS.filter((migration) => !appliedVersions.has(migration.version));
  if (pending.length > 0) {
    throw new Error(
      `ShipGraph database is missing migration(s): ${pending
        .map((migration) => `${migration.version} (${migration.name})`)
        .join(', ')}. Run shipgraph init to upgrade it.`
    );
  }
}

function assertMigrationRowsCompatible(db: DbConnection): ReadonlySet<number> {
  let appliedRows: Array<{ version: number; name: string }>;
  try {
    appliedRows = db
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number; name: string }>;
  } catch (error) {
    throw new Error(
      `ShipGraph database migration metadata is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const knownMigrations = new Map(
    MIGRATIONS.map((migration) => [migration.version, migration.name])
  );
  for (const applied of appliedRows) {
    const expectedName = knownMigrations.get(applied.version);
    if (expectedName === undefined || expectedName !== applied.name) {
      throw new Error(
        `Database migration ${applied.version} (${applied.name}) is not supported by this ShipGraph binary`
      );
    }
  }
  return new Set(appliedRows.map((row) => row.version));
}

/**
 * Open a database at the given path and migrate to the latest version.
 */
export function openAndMigrate(path: string): DbConnection {
  const db = createDatabase(path);
  try {
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Open an initialized database without allowing status checks to mutate it. */
export function openReadonlyDatabase(path: string): DbConnection {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma('foreign_keys = ON');
  return db;
}
