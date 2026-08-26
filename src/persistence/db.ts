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
