#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runDoctor } from './doctor.js';
import { initProject } from './init.js';
import { showStatus } from './status.js';
import { syncBacklogProject, validateBacklogProject } from './backlog.js';
import { emitReady, showReady } from './ready.js';
import {
  modelServiceOptions,
  parseMode,
  parseRisk,
  parseTask,
  providerIdForCli,
  runProvidersList,
  runProvidersRefresh,
  runProvidersRoute,
  runProvidersUsage,
} from './providers.js';
import {
  createCodexAdapter,
  createGeminiAdapter,
  createGrokAdapter,
} from '../adapters/agent/providers.js';
import { createOpenCodeAdapter } from '../adapters/agent/opencode.js';
import type { AgentExecutionAdapter } from '../adapters/agent/adapter.js';
import { AGENT_PROVIDERS, type AgentProvider } from '../domain/agent-provider.js';
import { DEFAULT_AGENT_TIMEOUT_MS } from '../domain/agent-run.js';
import {
  normalizeModelProviderId,
  type ModelProviderId,
} from '../domain/model-provider.js';
import type {
  ModelProviderAdapterConfiguration,
  ModelProviderConfiguration,
} from '../adapters/model/adapter.js';
import { agentProviderForModelProvider } from '../adapters/agent/registry.js';
import {
  agentServiceOptions,
  runAgentInspect,
  runAgentList,
  runAgentRecover,
  runAgentTask,
} from './agent.js';
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

  const providers = program
    .command('providers')
    .description('Discover provider/model metadata and choose a deterministic route');

  providers
    .command('refresh')
    .description('Probe configured providers and refresh their current model catalogs')
    .option('--provider <provider>', 'refresh one provider')
    .option('--project-dir <path>', 'target project directory', process.cwd())
    .option('--json', 'output structured provider metadata as JSON')
    .action(async (options: { provider?: string; projectDir?: string; json?: boolean }) => {
      let db: DbConnection | undefined;
      try {
        const projectDir = options.projectDir ?? process.cwd();
        db = openInitializedDatabase(projectDir);
        const report = await runProvidersRefresh(
          modelServiceOptions(db, projectDir),
          options.provider
        );
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          for (const provider of report.providers as Array<Record<string, unknown>>) {
            console.log(
              `${String(provider.providerId)}  ${String(provider.availability)}  ` +
                `${String(provider.catalogStatus)}  models=${String(provider.modelCount)}`
            );
          }
        }
      } catch (error) {
        emitCommandError(error, options.json);
      } finally {
        db?.close();
      }
    });

  providers
    .command('list')
    .description('List the persisted provider health and discovered model metadata')
    .option('--project-dir <path>', 'target project directory', process.cwd())
    .option('--json', 'output structured provider metadata as JSON')
    .action((options: { projectDir?: string; json?: boolean }) => {
      let db: DbConnection | undefined;
      try {
        const projectDir = options.projectDir ?? process.cwd();
        db = openInitializedDatabase(projectDir);
        const report = runProvidersList(modelServiceOptions(db, projectDir));
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          for (const provider of report.providers as Array<Record<string, unknown>>) {
            const health = provider.health as Record<string, unknown> | undefined;
            console.log(
              `${String(provider.providerId)}  ${String(provider.availability)}  ` +
                `health=${String(health?.status ?? 'unknown')}  models=${String(provider.modelCount)}`
            );
          }
        }
      } catch (error) {
        emitCommandError(error, options.json);
      } finally {
        db?.close();
      }
    });

  providers
    .command('route <task>')
    .description('Choose one provider/model for an explicitly supplied engineering step')
    .requiredOption('--risk <risk>', 'task risk: low, medium, high, or critical')
    .option('--mode <mode>', 'execution mode: eco, balanced, or max')
    .option('--run-id <run-id>', 'durable execution run to reserve provider capacity for')
    .option('--request-id <request-id>', 'stable routing request id for replay')
    .option('--implementation-provider <provider>', 'provider used for implementation diversity')
    .option('--fallback-from <provider>', 'provider to exclude for a fallback attempt')
    .option('--exclude-provider <provider...>', 'additional providers to exclude')
    .option('--max-concurrent-tickets <count>', 'global execution capacity')
    .option('--active-concurrent-tickets <count>', 'currently active global executions')
    .option('--budget-remaining <value>', 'known budget value or unknown')
    .option('--project-dir <path>', 'target project directory', process.cwd())
    .option('--json', 'output the routing decision as JSON')
    .action(async (
      task: string,
      options: {
        risk: string;
        mode?: string;
        runId?: string;
        requestId?: string;
        implementationProvider?: string;
        fallbackFrom?: string;
        excludeProvider?: string[];
        maxConcurrentTickets?: string;
        activeConcurrentTickets?: string;
        budgetRemaining?: string;
        projectDir?: string;
        json?: boolean;
      }
    ) => {
      let db: DbConnection | undefined;
      try {
        const projectDir = options.projectDir ?? process.cwd();
        db = openInitializedDatabase(projectDir);
        const report = await runProvidersRoute(
          modelServiceOptions(db, projectDir),
          {
            task: parseTask(task),
            risk: parseRisk(options.risk),
            mode: options.mode === undefined ? '' : parseMode(options.mode),
            runId: options.runId,
            requestId: options.requestId,
            ...(options.implementationProvider === undefined
              ? {}
              : { implementationProvider: providerIdForCli(options.implementationProvider) }),
            ...(options.fallbackFrom === undefined
              ? {}
              : { fallbackFromProvider: providerIdForCli(options.fallbackFrom) }),
            ...(options.excludeProvider === undefined
              ? {}
              : { excludeProviders: options.excludeProvider.map(providerIdForCli) }),
            maxConcurrentTickets: options.maxConcurrentTickets,
            activeConcurrentTickets: options.activeConcurrentTickets,
            budgetRemaining: options.budgetRemaining,
          }
        );
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          const decision = report.decision as Record<string, unknown>;
          console.log(`Provider: ${String(decision.providerId)}`);
          console.log(`Model: ${String(decision.modelId)}`);
          console.log(`Reason: ${String(decision.reason)}`);
        }
      } catch (error) {
        emitCommandError(error, options.json);
      } finally {
        db?.close();
      }
    });

  providers
    .command('usage')
    .description('List append-only provider usage telemetry')
    .option('--project-dir <path>', 'target project directory', process.cwd())
    .option('--json', 'output usage telemetry as JSON')
    .action((options: { projectDir?: string; json?: boolean }) => {
      let db: DbConnection | undefined;
      try {
        const projectDir = options.projectDir ?? process.cwd();
        db = openInitializedDatabase(projectDir);
        const report = runProvidersUsage(modelServiceOptions(db, projectDir));
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          for (const entry of report.usage as Array<Record<string, unknown>>) {
            console.log(
              `${String(entry.runId)}  ${String(entry.providerId)}  ${String(entry.modelId)}  ` +
                `${String(entry.outcome)}  elapsed=${String(entry.elapsedMs)}ms`
            );
          }
        }
      } catch (error) {
        emitCommandError(error, options.json);
      } finally {
        db?.close();
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

  const agent = program
    .command('agent')
    .description('Execute an explicitly supplied task in a verified agent workspace');

  agent
    .command('run <ticket-id>')
    .description('Run one provider adapter in the ticket\'s READY workspace')
    .requiredOption('--model <provider/model>', 'explicit provider model identifier')
    .requiredOption('--instructions <text>', 'instructions supplied to the coding agent')
    .option('--provider <provider>', 'AGENT adapter identity (opencode, codex, or acp)', 'opencode')
    .option('--model-provider <provider>', 'MODEL provider identity (needed to distinguish acp adapters)')
    .option('--executable <path>', 'selected provider executable or absolute test double')
    .option('--timeout-ms <milliseconds>', 'execution timeout', String(DEFAULT_AGENT_TIMEOUT_MS))
    .option('--project-dir <path>', 'target project directory', process.cwd())
    .option('--worktree-root <path>', 'ShipGraph worktree root override')
    .option('--json', 'output the durable run as JSON')
    .action(async (
      ticketId: string,
      options: {
        model: string;
        instructions: string;
        provider?: string;
        modelProvider?: string;
        executable?: string;
        timeoutMs?: string;
        projectDir?: string;
        worktreeRoot?: string;
        json?: boolean;
      }
    ) => {
      let db: DbConnection | undefined;
      const abortController = new AbortController();
      const abortExecution = (): void => abortController.abort();
      process.once('SIGINT', abortExecution);
      process.once('SIGTERM', abortExecution);
      try {
        const projectDir = options.projectDir ?? process.cwd();
        const provider = parseAgentProvider(options.provider ?? 'opencode');
        const modelProvider = resolveCliModelProvider(provider, options.modelProvider);
        db = openInitializedDatabase(projectDir);
        const modelOptions = modelServiceOptions(db, projectDir);
        const adapter = createCliAgentAdapter(
          modelProvider,
          options.executable,
          modelOptions.configuration
        );
        const probe = await adapter.probe();
        if (!probe.available) {
          throw new Error(
            `Provider ${modelProvider} has no usable AGENT-001 execution surface: ${probe.reason}`
          );
        }
        const base = workspaceServiceOptions(db, projectDir, options.worktreeRoot);
        const report = await runAgentTask(
          agentServiceOptions(base, adapter),
          {
            ticketId,
            provider,
            modelProviderId: modelProvider,
            model: options.model,
            instructions: options.instructions,
            timeoutMs: parsePositiveInteger(options.timeoutMs, 'timeout-ms'),
            signal: abortController.signal,
          }
        );
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          const run = report.run as Record<string, unknown>;
          console.log(`Agent run ${String(run.id)} ${String(run.status).toLowerCase()}.`);
          console.log(`Provider: ${String(run.provider)}`);
          console.log(`Model: ${String(run.model)}`);
          console.log(`Workspace: ${String(run.workspacePath)}`);
          if (run.failureReason !== undefined) console.log(`Reason: ${String(run.failureReason)}`);
        }
        if ((report.run as Record<string, unknown>).status !== 'SUCCEEDED') {
          process.exitCode = 1;
        }
      } catch (error) {
        emitCommandError(error, options.json);
      } finally {
        process.removeListener('SIGINT', abortExecution);
        process.removeListener('SIGTERM', abortExecution);
        db?.close();
      }
    });

  agent
    .command('inspect <run-id>')
    .description('Inspect one durable agent run')
    .option('--project-dir <path>', 'target project directory', process.cwd())
    .option('--json', 'output the durable run as JSON')
    .action(async (runId: string, options: { projectDir?: string; json?: boolean }) => {
      let db: DbConnection | undefined;
      try {
        const projectDir = options.projectDir ?? process.cwd();
        db = openInitializedDatabase(projectDir);
        const report = await runAgentInspect(workspaceServiceOptions(db, projectDir), runId);
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          const run = report.run as Record<string, unknown>;
          console.log(`Run: ${String(run.id)}`);
          console.log(`State: ${String(run.status)}`);
          console.log(`Ticket: ${String(run.ticketId)}`);
          console.log(`Provider/model: ${String(run.provider)}/${String(run.model)}`);
          console.log(`Workspace: ${String(run.workspacePath)}`);
          if (run.failureReason !== undefined) console.log(`Reason: ${String(run.failureReason)}`);
        }
      } catch (error) {
        emitCommandError(error, options.json);
      } finally {
        db?.close();
      }
    });

  agent
    .command('list')
    .description('List durable agent runs for the current project')
    .option('--project-dir <path>', 'target project directory', process.cwd())
    .option('--json', 'output durable runs as JSON')
    .action(async (options: { projectDir?: string; json?: boolean }) => {
      let db: DbConnection | undefined;
      try {
        const projectDir = options.projectDir ?? process.cwd();
        db = openInitializedDatabase(projectDir);
        const report = await runAgentList(workspaceServiceOptions(db, projectDir));
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          const runs = report.runs as Array<Record<string, unknown>>;
          if (runs.length === 0) {
            console.log('No agent runs for this project.');
            return;
          }
          for (const run of runs) {
            console.log(`${String(run.id)}  ${String(run.status)}  ${String(run.ticketId)}  ${String(run.model)}`);
          }
        }
      } catch (error) {
        emitCommandError(error, options.json);
      } finally {
        db?.close();
      }
    });

  agent
    .command('recover <run-id>')
    .description('Mark an active post-restart run NEEDS_HUMAN without killing unknown processes')
    .option('--project-dir <path>', 'target project directory', process.cwd())
    .option('--json', 'output the recovery result as JSON')
    .action(async (runId: string, options: { projectDir?: string; json?: boolean }) => {
      let db: DbConnection | undefined;
      try {
        const projectDir = options.projectDir ?? process.cwd();
        db = openInitializedDatabase(projectDir);
        const report = await runAgentRecover(workspaceServiceOptions(db, projectDir), runId);
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          const run = report.run as Record<string, unknown>;
          console.log(`Run ${String(run.id)} is ${String(run.status)}.`);
          console.log(report.recovered ? 'Manual recovery recorded.' : 'Run was already terminal.');
        }
        if ((report.run as Record<string, unknown>).status !== 'SUCCEEDED') {
          process.exitCode = 1;
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

function parseAgentProvider(value: string): AgentProvider {
  if (!AGENT_PROVIDERS.includes(value as AgentProvider)) {
    throw new Error(`Unsupported agent provider: ${value}`);
  }
  return value as AgentProvider;
}

function resolveCliModelProvider(
  provider: AgentProvider,
  requested: string | undefined
): ModelProviderId {
  if (requested !== undefined) {
    const modelProvider = normalizeModelProviderId(requested);
    if (agentProviderForModelProvider(modelProvider) !== provider) {
      throw new Error(
        `MODEL provider ${modelProvider} uses AGENT adapter ${agentProviderForModelProvider(modelProvider)}, not ${provider}`
      );
    }
    return modelProvider;
  }
  if (provider === 'opencode') return 'opencode-go';
  if (provider === 'codex') return 'codex';
  throw new Error('AGENT provider acp is ambiguous; supply --model-provider grok or gemini');
}

function createCliAgentAdapter(
  modelProvider: ModelProviderId,
  executable: string | undefined,
  configuration?: ModelProviderConfiguration
): AgentExecutionAdapter {
  const configured = configurationForModelProvider(configuration, modelProvider);
  const options = {
    ...(configured?.enabled === undefined ? {} : { enabled: configured.enabled }),
    ...(executable === undefined
      ? configured?.executable === undefined
        ? {}
        : { executable: configured.executable }
      : { executable }),
  };
  switch (modelProvider) {
    case 'opencode-go':
      return createOpenCodeAdapter(options);
    case 'codex':
      return createCodexAdapter(options);
    case 'grok':
      return createGrokAdapter(options);
    case 'gemini':
      return createGeminiAdapter(options);
  }
}

function configurationForModelProvider(
  configuration: ModelProviderConfiguration | undefined,
  modelProvider: ModelProviderId
): ModelProviderAdapterConfiguration | undefined {
  switch (modelProvider) {
    case 'opencode-go':
      return configuration?.opencodeGo;
    case 'codex':
      return configuration?.codex;
    case 'grok':
      return configuration?.grok;
    case 'gemini':
      return configuration?.gemini;
  }
}

function parsePositiveInteger(value: string | undefined, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${optionName} must be a positive integer`);
  }
  return parsed;
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
