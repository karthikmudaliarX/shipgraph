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
        FOREIGN KEY (ticket_id) REFERENCES tickets(id)
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
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );

      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedVersions = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => (row as { version: number }).version)
  );

  const pending = MIGRATIONS.filter((m) => !appliedVersions.has(m.version));

  if (pending.length === 0) return;

  const applyMigration = db.transaction((migration: Migration) => {
    db.exec(migration.up);
    db
      .prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
      )
      .run(migration.version, migration.name, new Date().toISOString());
  });

  for (const migration of pending) {
    applyMigration(migration);
  }
}

/**
 * Open a database at the given path and migrate to the latest version.
 */
export function openAndMigrate(path: string): DbConnection {
  const db = createDatabase(path);
  migrate(db);
  return db;
}
