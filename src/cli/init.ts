import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { assertSafeDatabaseFile, assertSafeShipgraphPaths } from '../utils/paths.js';
import { openAndMigrate } from '../persistence/db.js';
import {
  createProjectRepository,
  createEventRepository,
} from '../persistence/repositories.js';
import {
  persistedProjectMatchesConfig,
  validateConfig,
  type ShipgraphConfig,
} from '../config/schema.js';
import { loadConfig } from '../config/loader.js';
import { EventType, type ProjectInitializedPayload } from '../events/event.js';

export type InitResult = {
  projectId?: string;
  createdStateDir: boolean;
  createdGlobalDir: boolean;
  wroteConfigTemplate: boolean;
  configurationRequired: boolean;
  initializedDb: boolean;
};

const CONFIG_TEMPLATE = `# Fill in the required project identity, then run shipgraph init again.
version: 1
project:
  name: ""
  repository: ""
  defaultBranch: main
execution:
  maxConcurrentTickets: 1
  maxRepairIterations: 6
release:
  requireHumanApproval: true
  requireCleanCI: true
  requireExactShaReviews: true
agents:
  implementer: opencode
  reviewers:
    - correctness
`;

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
  } = {}
): InitResult {
  const paths = assertSafeShipgraphPaths(projectDir);
  const configAlreadyExists = pathExists(paths.configPath);

  if (!configAlreadyExists && options.config === undefined) {
    writeFileSync(paths.configPath, CONFIG_TEMPLATE, { flag: 'wx', mode: 0o600 });
    return configurationRequiredResult(true);
  }

  if (
    configAlreadyExists &&
    options.config === undefined &&
    readFileSync(paths.configPath, 'utf8') === CONFIG_TEMPLATE
  ) {
    return configurationRequiredResult(false);
  }

  const persistedFileConfig = configAlreadyExists ? loadConfig(projectDir) : undefined;
  if (
    persistedFileConfig !== undefined &&
    options.config !== undefined &&
    JSON.stringify(persistedFileConfig) !== JSON.stringify(validateConfig(options.config))
  ) {
    throw new Error('Explicit config does not match the existing shipgraph.yml');
  }
  const configInput = persistedFileConfig ?? options.config;
  if (configInput === undefined) throw new Error('ShipGraph configuration is required');
  const config = validateConfig(configInput);

  let createdStateDir = false;
  if (!pathExists(paths.stateDir)) {
    mkdirSync(paths.stateDir, { mode: 0o700 });
    createdStateDir = true;
  }

  let createdGlobalDir = false;
  if (!pathExists(paths.globalDir)) {
    mkdirSync(paths.globalDir, { recursive: true, mode: 0o700 });
    createdGlobalDir = true;
  }

  const wroteConfigTemplate = false;
  if (!configAlreadyExists) {
    writeFileSync(paths.configPath, renderConfigYaml(config), { flag: 'wx', mode: 0o600 });
  }

  if (!pathExists(paths.dbPath)) {
    const fd = openSync(
      paths.dbPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600
    );
    closeSync(fd);
  }
  assertSafeDatabaseFile(paths.dbPath);

  const db = openAndMigrate(paths.dbPath);
  try {
    const projectRepo = createProjectRepository(db);
    const eventRepo = createEventRepository(db);

    const projects = projectRepo.findAll();
    if (projects.length > 1) {
      throw new Error('ShipGraph project database must contain exactly one project');
    }
    const existingProject = projects[0];
    if (existingProject) {
      if (!persistedProjectMatchesConfig(existingProject, config)) {
        throw new Error(
          'shipgraph.yml does not match the project identity already stored in .shipgraph/shipgraph.db'
        );
      }
      return {
        projectId: existingProject.id,
        createdStateDir,
        createdGlobalDir,
        wroteConfigTemplate,
        configurationRequired: false,
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

    return {
      projectId,
      createdStateDir,
      createdGlobalDir,
      wroteConfigTemplate,
      configurationRequired: false,
      initializedDb: true,
    };
  } finally {
    db.close();
  }
}

function configurationRequiredResult(wroteConfigTemplate: boolean): InitResult {
  return {
    createdStateDir: false,
    createdGlobalDir: false,
    wroteConfigTemplate,
    configurationRequired: true,
    initializedDb: false,
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
