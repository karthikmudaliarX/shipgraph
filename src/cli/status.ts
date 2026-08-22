import { assertSafeShipgraphPaths } from '../utils/paths.js';
import { openReadonlyDatabase, type DbConnection } from '../persistence/db.js';
import {
  createProjectRepository,
  createTicketRepository,
  createEventRepository,
} from '../persistence/repositories.js';
import { loadConfig } from '../config/loader.js';
import {
  persistedProjectMatchesConfig,
  type ShipgraphConfig,
} from '../config/schema.js';
import { existsSync } from 'node:fs';

export type ProjectStatus = {
  projectId: string;
  name: string;
  repository: string;
  defaultBranch: string;
  ticketCount: number;
  eventCount: number;
};

export type StatusReport = {
  project?: ProjectStatus;
  error?: string;
};

/** Show project metadata and ticket counts from persistence. */
export function showStatus(
  projectDir: string,
  options: { json?: boolean } = {}
): StatusReport {
  let paths: ReturnType<typeof assertSafeShipgraphPaths>;
  let config: ShipgraphConfig;

  try {
    paths = assertSafeShipgraphPaths(projectDir);
    config = loadConfig(projectDir);
  } catch (error) {
    return emitStatus(
      {
        error: `Failed to load shipgraph.yml: ${error instanceof Error ? error.message : String(error)}`,
      },
      options
    );
  }

  if (!existsSync(paths.dbPath)) {
    return emitStatus(
      { error: 'No initialized ShipGraph project found. Run `shipgraph init` first.' },
      options
    );
  }

  let db: DbConnection | undefined;
  try {
    db = openReadonlyDatabase(paths.dbPath);
    const projectRepo = createProjectRepository(db);
    const ticketRepo = createTicketRepository(db);
    const eventRepo = createEventRepository(db);
    const projects = projectRepo.findAll();

    if (projects.length !== 1) {
      return emitStatus(
        {
          error:
            projects.length === 0
              ? 'No initialized ShipGraph project found. Run `shipgraph init` first.'
              : 'ShipGraph project database must contain exactly one project',
        },
        options
      );
    }

    const project = projects[0];
    if (!persistedProjectMatchesConfig(project, config)) {
      return emitStatus(
        {
          error:
            'shipgraph.yml does not match the project identity/config stored in .shipgraph/shipgraph.db',
        },
        options
      );
    }

    return emitStatus(
      {
        project: {
          projectId: project.id,
          name: project.name,
          repository: project.repository,
          defaultBranch: project.defaultBranch,
          ticketCount: ticketRepo.countByProjectId(project.id),
          eventCount: eventRepo.countByProjectId(project.id),
        },
      },
      options
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const missingDatabase = code === 'SQLITE_CANTOPEN' || code === 'ENOENT';
    return emitStatus(
      {
        error: missingDatabase
          ? 'No initialized ShipGraph project found. Run `shipgraph init` first.'
          : `Failed to read ShipGraph status: ${error instanceof Error ? error.message : String(error)}`,
      },
      options
    );
  } finally {
    db?.close();
  }
}

function emitStatus(
  report: StatusReport,
  options: { json?: boolean }
): StatusReport {
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.error) {
    console.error(report.error);
  } else if (report.project) {
    console.log(`Project: ${report.project.name} (${report.project.repository})`);
    console.log(`Default branch: ${report.project.defaultBranch}`);
    console.log(`Tickets: ${report.project.ticketCount}`);
    console.log(`Events: ${report.project.eventCount}`);
  }
  return report;
}
