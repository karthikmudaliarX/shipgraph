import { existsSync } from 'node:fs';
import {
  assertSafeBacklogPath,
  assertSafeDatabaseFile,
  assertSafeShipgraphPaths,
} from '../utils/paths.js';
import { loadBacklog, type ApprovedBacklog } from '../backlog/schema.js';
import { loadConfig } from '../config/loader.js';
import { openAndMigrate, type DbConnection } from '../persistence/db.js';
import {
  createProjectRepository,
} from '../persistence/repositories.js';
import { persistedProjectMatchesConfig } from '../config/schema.js';
import { syncApprovedBacklog, type BacklogSyncReport } from '../persistence/backlog-sync.js';

export type BacklogValidationReport = {
  version: number;
  tickets: number;
  ticketIds: readonly string[];
};

export function validateBacklogProject(
  projectDir: string,
  backlogFile?: string
): BacklogValidationReport {
  const validated = assertSafeBacklogPath(projectDir, backlogFile);
  const backlog = loadBacklog(projectDir, validated.path, validated.identity);
  return {
    version: backlog.version,
    tickets: backlog.tickets.length,
    ticketIds: backlog.tickets.map((ticket) => ticket.id),
  };
}

export function syncBacklogProject(
  projectDir: string,
  backlogFile?: string
): BacklogSyncReport {
  const paths = assertSafeShipgraphPaths(projectDir);
  const validated = assertSafeBacklogPath(projectDir, backlogFile);
  const backlogPath = validated.path;
  // Validate before opening the database so malformed input cannot mutate state.
  const backlog = loadBacklog(projectDir, backlogPath, validated.identity);
  const config = loadConfig(projectDir);
  if (!existsSync(paths.dbPath)) {
    throw new Error('No initialized ShipGraph project found. Run `shipgraph init` first.');
  }
  assertSafeDatabaseFile(paths.dbPath);

  let db: DbConnection | undefined;
  try {
    db = openAndMigrate(paths.dbPath);
    const projects = createProjectRepository(db).findAll();
    if (projects.length !== 1) {
      throw new Error(
        projects.length === 0
          ? 'No initialized ShipGraph project found. Run `shipgraph init` first.'
          : 'ShipGraph project database must contain exactly one project'
      );
    }
    const project = projects[0];
    if (!persistedProjectMatchesConfig(project, config)) {
      throw new Error(
        'shipgraph.yml does not match the project identity/config stored in .shipgraph/shipgraph.db'
      );
    }
    return syncApprovedBacklog(db, project.id, backlog, { sourcePath: backlogPath });
  } finally {
    db?.close();
  }
}

export type { ApprovedBacklog };
