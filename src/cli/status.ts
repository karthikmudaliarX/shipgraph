import { assertSafeShipgraphPaths } from '../utils/paths.js';
import { openReadonlyDatabase } from '../persistence/db.js';
import {
  createProjectRepository,
  createTicketRepository,
  createEventRepository,
} from '../persistence/repositories.js';
import { loadConfig } from '../config/loader.js';

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

/**
 * Show project metadata and ticket counts from persistence.
 */
export function showStatus(
  projectDir: string,
  options: { json?: boolean } = {}
): StatusReport {
  const paths = assertSafeShipgraphPaths(projectDir);

  try {
    loadConfig(projectDir);
  } catch (error) {
    const report: StatusReport = {
      error: `Failed to load shipgraph.yml: ${error instanceof Error ? error.message : String(error)}`,
    };
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.error(report.error);
    }
    return report;
  }

  const db = openReadonlyDatabase(paths.dbPath);
  const projectRepo = createProjectRepository(db);
  const ticketRepo = createTicketRepository(db);
  const eventRepo = createEventRepository(db);

  const projects = projectRepo.findAll();

  if (projects.length === 0) {
    db.close();
    const report: StatusReport = {
      error: 'No initialized ShipGraph project found. Run `shipgraph init` first.',
    };
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.error(report.error);
    }
    return report;
  }

  // For CORE-001, assume one project per directory.
  const project = projects[0];
  const ticketCount = ticketRepo.countByProjectId(project.id);
  const eventCount = eventRepo.countByProjectId(project.id);

  const status: ProjectStatus = {
    projectId: project.id,
    name: project.name,
    repository: project.repository,
    defaultBranch: project.defaultBranch,
    ticketCount,
    eventCount,
  };

  db.close();

  const report: StatusReport = { project: status };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Project: ${status.name} (${status.repository})`);
    console.log(`Default branch: ${status.defaultBranch}`);
    console.log(`Tickets: ${status.ticketCount}`);
    console.log(`Events: ${status.eventCount}`);
  }

  return report;
}
