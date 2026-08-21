import { mkdirSync, writeFileSync, statSync, accessSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getShipgraphPaths } from '../utils/paths.js';
import { openAndMigrate } from '../persistence/db.js';
import {
  createProjectRepository,
  createEventRepository,
} from '../persistence/repositories.js';
import { validateConfig, type ShipgraphConfig } from '../config/schema.js';
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
 * CORE-001 scope: creates safe configuration/state directories only.
 * No agent execution.
 */
export function initProject(
  projectDir: string,
  options: {
    config?: ShipgraphConfig;
    skipConfig?: boolean;
  } = {}
): InitResult {
  const paths = getShipgraphPaths(projectDir);
  const config = options.config ?? DEFAULT_CONFIG;

  validateConfig(config);

  let createdStateDir = false;
  if (!directoryExists(paths.stateDir)) {
    mkdirSync(paths.stateDir, { recursive: true });
    createdStateDir = true;
  }

  let createdGlobalDir = false;
  if (!directoryExists(paths.globalDir)) {
    mkdirSync(paths.globalDir, { recursive: true });
    createdGlobalDir = true;
  }

  let wroteExampleConfig = false;
  if (!options.skipConfig && !fileExists(paths.configPath)) {
    writeFileSync(paths.configPath, renderConfigYaml(config));
    wroteExampleConfig = true;
  }

  const db = openAndMigrate(paths.dbPath);
  const projectRepo = createProjectRepository(db);
  const eventRepo = createEventRepository(db);

  const projectId = randomUUID();
  const now = new Date().toISOString();

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
    sequence: 1,
    timestamp: now,
    projectId,
    type: EventType.PROJECT_INITIALIZED,
    payload,
  });

  db.close();

  return {
    projectId,
    createdStateDir,
    createdGlobalDir,
    wroteExampleConfig,
    initializedDb: true,
  };
}

function directoryExists(path: string): boolean {
  try {
    const stats = statSync(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

function fileExists(path: string): boolean {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
}

function renderConfigYaml(config: ShipgraphConfig): string {
  return `version: ${config.version}

project:
  name: ${config.project.name}
  repository: ${config.project.repository}
  defaultBranch: ${config.project.defaultBranch}

execution:
  maxConcurrentTickets: ${config.execution.maxConcurrentTickets}
  maxRepairIterations: ${config.execution.maxRepairIterations}

release:
  requireHumanApproval: ${config.release.requireHumanApproval}
  requireCleanCI: ${config.release.requireCleanCI}
  requireExactShaReviews: ${config.release.requireExactShaReviews}

agents:
  implementer: ${config.agents.implementer}
  reviewers:
${config.agents.reviewers.map((r) => `    - ${r}`).join('\n')}
`;
}
