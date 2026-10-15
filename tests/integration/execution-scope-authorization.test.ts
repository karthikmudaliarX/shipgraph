import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { initProject } from '../../src/cli/init.js';
import { syncBacklogProject } from '../../src/cli/backlog.js';
import { TicketState } from '../../src/core/state-machine/state.js';
import { openAndMigrate, type DbConnection } from '../../src/persistence/db.js';
import { createEventRepository, createTicketRepository } from '../../src/persistence/repositories.js';
import { createGitRunner, type GitCommandResult, type GitRunner } from '../../src/git/service.js';
import { EventType, type ShipgraphEvent } from '../../src/events/event.js';
import { executeTicket } from '../../src/execution/ticket.js';
import { ModelRoutingService } from '../../src/model/service.js';
import type { ModelProviderAdapter } from '../../src/adapters/model/adapter.js';
import type {
  AgentExecutionAdapter,
  AgentExecutionRequest,
  AgentExecutionResult,
} from '../../src/adapters/agent/adapter.js';
import { registerModelProviderAdapter } from '../../src/adapters/agent/registry.js';
import type { GitHostAdapter, GitHostComment } from '../../src/adapters/git-host/adapter.js';

const PASS = JSON.stringify({ result: 'PASS', findings: [] });
const CONTRACT_FAIL = JSON.stringify({ result: 'FAIL', findings: ['scope blocker'] });
const IMPLEMENTATION_MARKER = 'Implement one explicitly authorized ShipGraph issue.';
const REPAIR_MARKER = 'Perform one bounded KAR-10 pre-PR repair attempt.';

const contract = {
  summary: 'Authorize the committed implementation change.',
  currentBehavior: 'Implementation changes are not scope-authorized.',
  desiredBehavior: 'Implementation changes are authorized against ticket scope.',
  acceptanceCriteria: ['Only authorized paths are committed.'],
  outOfScope: ['Unrelated product work'],
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commitFile(workspacePath: string, relativePath: string, contents: string): void {
  const absolute = join(workspacePath, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
  git(workspacePath, 'add', '.');
  git(workspacePath, 'commit', '-m', `change ${relativePath}`);
}

type Scenario = {
  scope: { allowedPaths: string[]; forbiddenPaths: string[] };
  implementation: (workspacePath: string) => void;
  repair?: (workspacePath: string) => void;
  reviewReports?: string[];
  maxRepairIterations?: number;
};

type Fixture = {
  result: Awaited<ReturnType<typeof executeTicket>>;
  reports: AgentExecutionRequest[];
  db: DbConnection;
  projectDir: string;
  worktreeRoot: string;
  events: readonly ShipgraphEvent[];
};

async function runScenario(scenario: Scenario): Promise<Fixture> {
  const projectDir = mkdtempSync(join(tmpdir(), 'shipgraph-scope-src-'));
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'shipgraph-scope-root-'));
  git(projectDir, 'init', '-b', 'main');
  git(projectDir, 'config', 'user.email', 'scope@example.com');
  git(projectDir, 'config', 'user.name', 'Scope Authorization Test');
  git(projectDir, 'remote', 'add', 'origin', 'git@github.com:owner/scope-001.git');
  writeFileSync(join(projectDir, 'README.md'), '# source\n');
  writeFileSync(
    join(projectDir, '.gitignore'),
    ['.next/', 'node_modules/', 'next-env.d.ts'].join('\n') + '\n'
  );
  git(projectDir, 'add', '.');
  git(projectDir, 'commit', '-m', 'initial');
  initProject(projectDir, {
    config: {
      version: 1,
      project: { name: 'scope-001', repository: 'owner/scope-001', defaultBranch: 'main' },
      execution: { maxConcurrentTickets: 1, maxRepairIterations: scenario.maxRepairIterations ?? 1 },
      release: { requireHumanApproval: true, requireCleanCI: true, requireExactShaReviews: true },
      agents: { implementer: 'opencode', reviewers: ['correctness'] },
    },
  });
  writeFileSync(join(projectDir, 'shipgraph.backlog.yml'), stringify({
    version: 1,
    tickets: [{
      id: 'SCOPE-1',
      title: 'Scope authorization',
      description: 'Authorize committed implementation paths.',
      priority: 'high',
      dependsOn: [],
      scope: scenario.scope,
      acceptanceCriteria: [{ id: 'AC-1', description: 'Only authorized paths change.' }],
      verification: { commands: ['true'] },
      risk: 'medium',
      agent: {},
      release: {},
    }],
  }));
  syncBacklogProject(projectDir);
  const db = openAndMigrate(join(projectDir, '.shipgraph', 'shipgraph.db'));
  const projectId = createTicketRepository(db).findById('SCOPE-1')?.projectId;
  if (projectId === undefined) throw new Error('test ticket missing');

  const reports: AgentExecutionRequest[] = [];
  const reviewReports = [...(scenario.reviewReports ?? [])];
  const executionAdapter: AgentExecutionAdapter = {
    provider: 'opencode',
    capabilities: ['execute', 'review', 'repair'],
    supportsTokenLimit: true,
    supportsCostLimit: true,
    reportsUsage: true,
    probe: () => ({ available: true as const, version: 'test-agent' }),
    execute: async (request): Promise<AgentExecutionResult> => {
      reports.push(request);
      if (request.reviewType === undefined) {
        if (request.instructions.includes(IMPLEMENTATION_MARKER)) {
          scenario.implementation(request.workspacePath);
        } else if (scenario.repair !== undefined && request.instructions.includes(REPAIR_MARKER)) {
          scenario.repair(request.workspacePath);
        }
      }
      return {
        outcome: 'SUCCEEDED',
        timedOut: false,
        cancelled: false,
        processGroupStopped: true,
        stdout: request.reviewType === undefined ? 'implementation complete' : (reviewReports.shift() ?? PASS),
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
      };
    },
  };
  registerModelProviderAdapter(executionAdapter, 'opencode-go');
  const providerAdapter: ModelProviderAdapter = {
    providerId: 'opencode-go',
    family: 'opencode',
    displayName: 'OpenCode Go',
    probe: async () => ({
      availability: 'available',
      auth: 'authenticated',
      version: 'test-provider',
      capabilities: ['implementation', 'review', 'repair'],
    }),
    discoverModels: async () => ({
      status: 'known',
      models: [{ modelId: 'opencode/test', capabilities: ['implementation', 'review', 'repair'] }],
    }),
  };
  const modelService = new ModelRoutingService({
    db,
    projectId,
    adapters: [providerAdapter],
    executionAdapters: [{ modelProviderId: 'opencode-go', adapter: executionAdapter }],
  });

  const remote: { sha?: string } = {};
  const realRunner = createGitRunner();
  const gitRunner: GitRunner = async (cwd, args): Promise<GitCommandResult> => {
    if (cwd === projectDir && args[0] === 'remote' && args[1] === 'get-url') {
      return { exitCode: 0, stdout: 'git@github.com:owner/scope-001.git\n', stderr: '' };
    }
    if (cwd === projectDir && args[0] === 'ls-remote') {
      return {
        exitCode: 0,
        stdout: remote.sha === undefined ? '' : `${remote.sha}\trefs/heads/shipgraph/scope-1\n`,
        stderr: '',
      };
    }
    if (cwd === projectDir && args[0] === 'push') {
      remote.sha = args[2]?.split(':', 1)[0];
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return realRunner(cwd, args);
  };
  const host: GitHostAdapter = {
    type: 'github',
    probe: () => ({ available: true as const, authenticated: true as const }),
    findPullRequests: async () => [],
    createPullRequest: async (request) => ({
      number: 21,
      url: 'https://github.com/owner/scope-001/pull/21',
      repository: request.repository,
      baseBranch: request.baseBranch,
      headBranch: request.headBranch,
      headSha: remote.sha ?? '',
      state: 'OPEN',
    }),
    inspectPullRequest: async () => ({
      number: 21,
      url: 'https://github.com/owner/scope-001/pull/21',
      repository: 'owner/scope-001',
      baseBranch: 'main',
      headBranch: 'shipgraph/scope-1',
      headSha: remote.sha ?? '',
      state: 'OPEN',
    }),
    listComments: async (): Promise<readonly GitHostComment[]> => [],
    postComment: async (request) => ({
      id: 'comment-21',
      url: 'https://github.com/owner/scope-001/issues/21#issuecomment-21',
      body: request.body,
    }),
  };

  const result = await executeTicket({
    issueId: 'SCOPE-1',
    contract,
    contractSource: 'linear:SCOPE-1',
    contractRevision: 'v1',
    workspace: { db, projectDir, worktreeRoot, gitRunner },
    modelService,
    routing: {
      risk: 'medium',
      envelope: {
        mode: 'balanced',
        maxConcurrentTickets: 1,
        activeConcurrentTickets: 0,
        budgetRemaining: 'unknown',
      },
    },
    executionPolicy: { maxAttempts: 1, maxTimeoutMs: 60_000, maxTokens: 100, maxCost: 1 },
    timeoutMs: 60_000,
    gitHost: host,
    createExecutionId: () => 'execution-scope',
  });
  return { result, reports, db, projectDir, worktreeRoot, events: createEventRepository(db).findByTicketId('SCOPE-1') };
}

describe('KAR-12 initial implementation scope authorization', () => {
  let fixture: Fixture | undefined;
  afterEach(() => {
    fixture?.db.close();
    if (fixture !== undefined) {
      rmSync(fixture.projectDir, { recursive: true, force: true });
      rmSync(fixture.worktreeRoot, { recursive: true, force: true });
    }
    fixture = undefined;
  });

  it('authorizes an implementation that commits only allowed paths and reaches PR_RAISED', async () => {
    fixture = await runScenario({
      scope: { allowedPaths: ['src/**'], forbiddenPaths: [] },
      implementation: (workspacePath) => commitFile(workspacePath, 'src/nested/fix.ts', 'export const fixed = true;\n'),
    });
    expect(fixture.result.outcome).toBe('PR_RAISED');
    expect(fixture.reports.filter((request) => request.reviewType !== undefined)).toHaveLength(2);
    expect(fixture.events.some((event) => event.type === EventType.PRE_PR_READINESS_RECORDED)).toBe(true);
  }, 30_000);

  it('rejects an out-of-scope implementation before any review or readiness stage runs', async () => {
    fixture = await runScenario({
      scope: { allowedPaths: ['src/**'], forbiddenPaths: [] },
      implementation: (workspacePath) => commitFile(workspacePath, 'OUTSIDE.md', 'out of scope\n'),
    });
    expect(fixture.result.outcome).toBe('NEEDS_HUMAN');
    expect(fixture.result.evidence.reason).toContain('outside the authorized scope');
    expect(fixture.reports.filter((request) => request.reviewType !== undefined)).toHaveLength(0);
    expect(fixture.events.some((event) => event.type === EventType.PRE_PR_READINESS_RECORDED)).toBe(false);
    expect(fixture.events.some((event) => event.type === EventType.GITHUB_PR_RECORDED)).toBe(false);
    // Scope growth during IMPLEMENTING is a human-recoverable safety outcome:
    // NEEDS_HUMAN evidence with the existing PAUSED lifecycle fallback.
    expect(createTicketRepository(fixture.db).findById('SCOPE-1')?.status).toBe(TicketState.PAUSED);
  }, 30_000);

  it('rejects an implementation that commits a forbidden path', async () => {
    fixture = await runScenario({
      scope: { allowedPaths: [], forbiddenPaths: ['secrets/**'] },
      implementation: (workspacePath) => commitFile(workspacePath, 'secrets/token.txt', 'do not commit\n'),
    });
    expect(fixture.result.outcome).toBe('NEEDS_HUMAN');
    expect(fixture.result.evidence.reason).toContain('forbidden path secrets/token.txt');
    expect(fixture.reports.filter((request) => request.reviewType !== undefined)).toHaveLength(0);
  }, 30_000);

  it('preserves the meaning of empty allowedPaths by authorizing any non-forbidden path', async () => {
    fixture = await runScenario({
      scope: { allowedPaths: [], forbiddenPaths: [] },
      implementation: (workspacePath) => commitFile(workspacePath, 'anywhere/file.ts', 'export const value = 1;\n'),
    });
    expect(fixture.result.outcome).toBe('PR_RAISED');
    expect(fixture.reports.filter((request) => request.reviewType !== undefined)).toHaveLength(2);
  }, 30_000);

  it('applies the identical shared grammar to the repair boundary', async () => {
    fixture = await runScenario({
      scope: { allowedPaths: ['src/**'], forbiddenPaths: [] },
      implementation: (workspacePath) => commitFile(workspacePath, 'src/impl.ts', 'export const impl = true;\n'),
      repair: (workspacePath) => commitFile(workspacePath, 'OUTSIDE.md', 'repair escaped scope\n'),
      reviewReports: [CONTRACT_FAIL, PASS],
    });
    expect(fixture.result.outcome).toBe('NEEDS_HUMAN');
    expect(fixture.result.evidence.reason).toContain('outside the authorized scope');
    // The initial implementation was authorized and reviewed; only the repair
    // that escaped the same scope was rejected.
    expect(fixture.reports.filter((request) => request.instructions.includes(REPAIR_MARKER))).toHaveLength(1);
    expect(fixture.events.some((event) => event.type === EventType.PRE_PR_READINESS_RECORDED)).toBe(false);
  }, 30_000);

  it('authorizes a repair that stays inside the same allowed scope', async () => {
    fixture = await runScenario({
      scope: { allowedPaths: ['src/**'], forbiddenPaths: [] },
      implementation: (workspacePath) => commitFile(workspacePath, 'src/impl.ts', 'export const impl = true;\n'),
      repair: (workspacePath) => commitFile(workspacePath, 'src/fix.ts', 'export const fixed = true;\n'),
      reviewReports: [CONTRACT_FAIL, PASS, PASS, PASS],
    });
    expect(fixture.result.outcome).toBe('PR_RAISED');
  }, 30_000);
});
