import { closeSync, constants, lstatSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { assertSafeShipgraphPaths } from '../utils/paths.js';
import { openAndMigrate } from '../persistence/db.js';
import {
  createProjectRepository,
  createEventRepository,
} from '../persistence/repositories.js';
import { validateConfig, type ShipgraphConfig } from '../config/schema.js';
import { loadConfig } from '../config/loader.js';
import { EventType, type ProjectInitializedPayload } from '../events/event.js';

export type InitResult = {
  projectId: string;
  createdStateDir: boolean;
  createdGlobalDir: boolean;
  wroteExampleConfig: boolean;
  initializedDb: boolean;
};

const DEFAULT_CONFIG: ShipgraphConfig = {
  version: 1,
  project: {
    name: 'example',
    repository: 'owner/repo',
    defaultBranch: 'main',
  },
  execution: {
    maxConcurrentTickets: 1,
    maxRepairIterations: 6,
  },
  release: {
    requireHumanApproval: true,
    requireCleanCI: true,
    requireExactShaReviews: true,
  },
  agents: {
    implementer: 'opencode',
    reviewers: ['correctness'],
  },
};

/**
 * Initialize ShipGraph metadata for a target project.
 *
 * CORE-001 scope: creates safe configuration/state directories, migrates the
 * local database, and atomically records initialization. No agent execution.
 */
export function initProject(
  projectDir: string,
  options: {
    config?: ShipgraphConfig;
    skipConfig?: boolean;
  } = {}
): InitResult {
  const paths = assertSafeShipgraphPaths(projectDir);
  const configAlreadyExists = pathExists(paths.configPath);
  const config = options.config ?? (configAlreadyExists ? loadConfig(projectDir) : DEFAULT_CONFIG);

  validateConfig(config);

  let createdStateDir = false;
  if (!pathExists(paths.stateDir)) {
    mkdirSync(paths.stateDir);
    createdStateDir = true;
  }

  let createdGlobalDir = false;
  if (!pathExists(paths.globalDir)) {
    mkdirSync(paths.globalDir, { recursive: true });
    createdGlobalDir = true;
  }

  let wroteExampleConfig = false;
  if (!options.skipConfig && !configAlreadyExists) {
    writeFileSync(paths.configPath, renderConfigYaml(config), { flag: 'wx', mode: 0o600 });
    wroteExampleConfig = true;
  }

  if (!pathExists(paths.dbPath)) {
    const fd = openSync(
      paths.dbPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600
    );
    closeSync(fd);
  }

  const db = openAndMigrate(paths.dbPath);
  const projectRepo = createProjectRepository(db);
  const eventRepo = createEventRepository(db);

  const existingProject = projectRepo.findAll()[0];
  if (existingProject) {
    const identityMatches =
      existingProject.name === config.project.name &&
      existingProject.repository === config.project.repository &&
      existingProject.defaultBranch === config.project.defaultBranch &&
      JSON.stringify(existingProject.config) === JSON.stringify(config);
    db.close();
    if (!identityMatches) {
      throw new Error(
        'shipgraph.yml does not match the project identity already stored in .shipgraph/shipgraph.db'
      );
    }
    return {
      projectId: existingProject.id,
      createdStateDir,
      createdGlobalDir,
      wroteExampleConfig,
      initializedDb: true,
    };
  }

  const projectId = randomUUID();
  const now = new Date().toISOString();

  const initialize = db.transaction(() => {
    projectRepo.create({
      id: projectId,
      name: config.project.name,
      repository: config.project.repository,
      defaultBranch: config.project.defaultBranch,
      config,
      createdAt: now,
      updatedAt: now,
    });

    const payload: ProjectInitializedPayload = {
      projectId,
      name: config.project.name,
      repository: config.project.repository,
      defaultBranch: config.project.defaultBranch,
    };

    eventRepo.append({
      id: randomUUID(),
      timestamp: now,
      projectId,
      type: EventType.PROJECT_INITIALIZED,
      payload,
    });
  });

  initialize();

  db.close();

  return {
    projectId,
    createdStateDir,
    createdGlobalDir,
    wroteExampleConfig,
    initializedDb: true,
  };
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  }
}

function renderConfigYaml(config: ShipgraphConfig): string {
  return stringify(config);
}
