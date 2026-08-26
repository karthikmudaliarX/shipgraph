#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runDoctor } from './doctor.js';
import { initProject } from './init.js';
import { showStatus } from './status.js';
import { syncBacklogProject, validateBacklogProject } from './backlog.js';
import { emitReady, showReady } from './ready.js';
import { assertSafeShipgraphPaths } from '../utils/paths.js';
import { openAndMigrate, type DbConnection } from '../persistence/db.js';
import {
  runWorkspaceCreate,
  runWorkspaceInspect,
  runWorkspaceList,
  runWorkspaceRemove,
  workspaceServiceOptions,
} from './workspace.js';

/** Open the project database for workspace commands (fail closed when absent). */
function openInitializedDatabase(projectDir: string): DbConnection {
  const paths = assertSafeShipgraphPaths(projectDir);
  if (!existsSync(paths.dbPath)) {
    throw new Error('No initialized ShipGraph project found. Run `shipgraph init` first.');
  }
  return openAndMigrate(paths.dbPath);
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name('shipgraph')
    .description('Deterministic release control for autonomous coding agents.')
    .version(readPackageVersion());

  program
    .command('doctor')
    .description('Check the ShipGraph environment')
    .option('--json', 'output structured diagnostics as JSON')
    .action(async (options: { json?: boolean }) => {
      const report = await runDoctor({ json: options.json });
      if (!report.healthy) process.exitCode = 1;
    });

  program
    .command('init')
    .description('Initialize ShipGraph metadata for the current project')
    .option('--project-dir <path>', 'target project directory', process.cwd())
    .action((options: { projectDir?: string }) => {
      const projectDir = options.projectDir ?? process.cwd();
      const result = initProject(projectDir);
      if (result.configurationRequired) {
        console.log(
          result.wroteConfigTemplate
            ? 'ShipGraph configuration template written to shipgraph.yml.'
            : 'ShipGraph is waiting for project identity in shipgraph.yml.'
        );
        console.log('Fill in project.name and project.repository, then run `shipgraph init` again.');
        return;
      }
      console.log('ShipGraph initialized:');
      console.log(`  projectId: ${result.projectId}`);
      console.log(`  state dir: ${result.createdStateDir ? 'created' : 'already exists'}`);
      console.log(`  global dir: ${result.createdGlobalDir ? 'created' : 'already exists'}`);
    });

  program
    .command('status')
    .description('Show project metadata and ticket counts')
    .option('--project-dir <path>', 'target project directory', process.cwd())
    .option('--json', 'output structured status as JSON')
    .action((options: { projectDir?: string; json?: boolean }) => {
      const projectDir = options.projectDir ?? process.cwd();
      const report = showStatus(projectDir, { json: options.json });
      if (report.error) process.exitCode = 1;
    });

  const backlog = program
    .command('backlog')
    .description('Validate and synchronize the approved backlog');

  backlog
    .command('validate')
    .description('Validate shipgraph.backlog.yml without changing SQLite')
    .option('--project-dir <path>', 'target project directory', process.cwd())
    .option('--file <path>', 'approved backlog path')
    .option('--path <path>', 'approved backlog path')
    .option('--json', 'output structured validation as JSON')
    .action((options: {
      projectDir?: string;
      file?: string;
      path?: string;
      json?: boolean;
    }) => {
      try {
        const report = validateBacklogProject(
          options.projectDir ?? process.cwd(),
          options.file ?? options.path
        );
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(
            `Approved backlog is valid: ${report.tickets} ticket(s), version ${report.version}.`
          );
        }
      } catch (error) {
        emitCommandError(error, options.json);
      }
    });

  backlog
    .command('sync')
    .description('Synchronize the approved backlog into SQLite')
    .option('--project-dir <path>', 'target project directory', process.cwd())
    .option('--file <path>', 'approved backlog path')
    .option('--path <path>', 'approved backlog path')
    .option('--json', 'output structured sync results as JSON')
    .action((options: {
      projectDir?: string;
      file?: string;
      path?: string;
      json?: boolean;
    }) => {
      try {
        const report = syncBacklogProject(
          options.projectDir ?? process.cwd(),
          options.file ?? options.path
        );
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log('ShipGraph backlog synchronized:');
          console.log(`  new: ${report.new}`);
          console.log(`  unchanged: ${report.unchanged}`);
          console.log(`  eligible: ${report.eligible}`);
          console.log(`  queued: ${report.queued}`);
        }
      } catch (error) {
        emitCommandError(error, options.json);
      }
    });

  program
    .command('ready')
    .description('Show deterministic tickets that could be dispatched')
    .option('--project-dir <path>', 'target project directory', process.cwd())
    .option('--json', 'output structured ready queue as JSON')
    .action((options: { projectDir?: string; json?: boolean }) => {
      try {
        const report = showReady(options.projectDir ?? process.cwd());
        emitReady(report, options.json);
      } catch (error) {
        emitCommandError(error, options.json);
      }
    });

  const workspace = program
    .command('workspace')
    .description('Manage isolated Git workspaces for eligible tickets');

  workspace
    .command('create <ticket-id>')
    .description('Reserve an isolated worktree for an ELIGIBLE ticket')
    .option('--project-dir <path>', 'target project directory', process.cwd())
    .option('--json', 'output structured result as JSON')
    .action(async (ticketId: string, options: { projectDir?: string; json?: boolean }) => {
      let db: DbConnection | undefined;
      try {
        const projectDir = options.projectDir ?? process.cwd();
        db = openInitializedDatabase(projectDir);
        const report = await runWorkspaceCreate(
          workspaceServiceOptions(db, projectDir),
          ticketId
        );
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(report.created || report.recovered ? 'Workspace ready' : 'Workspace ready');
          console.log('');
          const ws = report.workspace as Record<string, string>;
          console.log(`Ticket: ${ws.ticketId}`);
          console.log(`Branch: ${ws.branchName}`);
          console.log(`Base: ${ws.baseSha}`);
          console.log(`Path: ${ws.worktreePath}`);
          console.log(`State: ${(report.ticket as Record<string, string>).state}`);
        }
      } catch (error) {
        emitCommandError(error, options.json);
      } finally {
        db?.close();
      }
    });

  workspace
    .command('inspect <ticket-id>')
    .description('Show recorded and live state of a ticket workspace (read-only)')
    .option('--project-dir <path>', 'target project directory', process.cwd())
    .option('--json', 'output structured inspection as JSON')
    .action(async (ticketId: string, options: { projectDir?: string; json?: boolean }) => {
      let db: DbConnection | undefined;
      try {
        const projectDir = options.projectDir ?? process.cwd();
        db = openInitializedDatabase(projectDir);
        const report = await runWorkspaceInspect(workspaceServiceOptions(db, projectDir), ticketId);
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          const recorded = report.recorded as Record<string, string>;
          const live = report.live as Record<string, unknown>;
          console.log(`Ticket: ${ticketId}`);
          console.log(`Status: ${recorded.status}`);
          console.log(`Branch: ${recorded.branchName}`);
          console.log(`Base: ${recorded.baseSha}`);
          console.log(`Path: ${recorded.worktreePath}`);
          console.log(`Live HEAD: ${live.headSha ?? '<missing>'}`);
          console.log(`Live branch: ${live.branch ?? '<none>'}`);
          console.log(`Clean: ${live.clean === true ? 'yes' : 'no'}`);
          console.log(`Health: ${report.health}`);
        }
      } catch (error) {
        emitCommandError(error, options.json);
      } finally {
        db?.close();
      }
    });

  workspace
    .command('list')
    .description('List ShipGraph workspaces for the current project')
    .option('--project-dir <path>', 'target project directory', process.cwd())
    .option('--json', 'output structured list as JSON')
    .action(async (options: { projectDir?: string; json?: boolean }) => {
      let db: DbConnection | undefined;
      try {
        const projectDir = options.projectDir ?? process.cwd();
        db = openInitializedDatabase(projectDir);
        const report = await runWorkspaceList(workspaceServiceOptions(db, projectDir));
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          const workspaces = report.workspaces as Array<Record<string, string>>;
          if (workspaces.length === 0) {
            console.log('No ShipGraph workspaces for this project.');
            return;
          }
          for (const entry of workspaces) {
            console.log(`${entry.ticketId}  ${entry.status}  ${entry.branchName}  ${entry.worktreePath}`);
          }
        }
      } catch (error) {
        emitCommandError(error, options.json);
      } finally {
        db?.close();
      }
    });

  workspace
    .command('remove <ticket-id>')
    .description('Remove a clean READY workspace (dirty worktrees are refused)')
    .option('--project-dir <path>', 'target project directory', process.cwd())
    .option('--json', 'output structured result as JSON')
    .action(async (ticketId: string, options: { projectDir?: string; json?: boolean }) => {
      let db: DbConnection | undefined;
      try {
        const projectDir = options.projectDir ?? process.cwd();
        db = openInitializedDatabase(projectDir);
        const report = await runWorkspaceRemove(workspaceServiceOptions(db, projectDir), ticketId);
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(`Workspace removed: ${report.ticketId}`);
          console.log(`Branch ${report.branchRetained ? 'retained' : 'deleted'}`);
        }
      } catch (error) {
        emitCommandError(error, options.json);
      } finally {
        db?.close();
      }
    });

  return program;
}

function emitCommandError(error: unknown, json = false): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    console.log(JSON.stringify({ error: message }, null, 2));
  } else {
    console.error(message);
  }
  process.exitCode = 1;
}

function readPackageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
  ) as { version: string };
  return packageJson.version;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  await createProgram().parseAsync();
}
