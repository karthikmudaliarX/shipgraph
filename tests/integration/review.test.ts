import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { initProject } from '../../src/cli/init.js';
import { syncBacklogProject } from '../../src/cli/backlog.js';
import { createWorkspace } from '../../src/workspace/service.js';
import { TicketState } from '../../src/core/state-machine/state.js';
import { persistTicketTransition } from '../../src/persistence/ticket-state-store.js';
import { openAndMigrate, type DbConnection } from '../../src/persistence/db.js';
import { createRunRepository, createTicketRepository } from '../../src/persistence/repositories.js';
import type { WorkspaceRecord } from '../../src/persistence/repositories.js';
import { createEventRepository } from '../../src/persistence/repositories.js';
import { EventType } from '../../src/events/event.js';
import type {
  AgentExecutionAdapter,
  AgentExecutionRequest,
  AgentExecutionResult,
} from '../../src/adapters/agent/adapter.js';
import type { ModelProviderAdapter } from '../../src/adapters/model/adapter.js';
import { registerModelProviderAdapter } from '../../src/adapters/agent/registry.js';
import { ModelRoutingService } from '../../src/model/service.js';
import { AGENT_INSTRUCTIONS_LIMIT_BYTES } from '../../src/domain/agent-run.js';
import {
  listCurrentPrePrReviewEvidence,
  runPrePrReviews,
} from '../../src/review/service.js';
import {
  getCurrentPrePrReadinessEvidence,
  runPrePrReadiness,
} from '../../src/readiness/service.js';

const CONFIG = {
  version: 1 as const,
  project: { name: 'review-001', repository: 'owner/review-001', defaultBranch: 'main' },
  execution: { maxConcurrentTickets: 1, maxRepairIterations: 0 },
  release: { requireHumanApproval: true, requireCleanCI: true, requireExactShaReviews: true },
  agents: { implementer: 'opencode' as const, reviewers: ['correctness'] as const },
};

const VALID_REVIEW_REPORT = JSON.stringify({ result: 'PASS', findings: [] });
const LONG_REVIEW_REPORT = JSON.stringify({
  result: 'FAIL',
  findings: Array.from({ length: 3 }, (_, index) => `finding-${index}-${'x'.repeat(2_030)}`),
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function ticket() {
  return {
    id: 'REV-001',
    title: 'Review the committed change',
    description: 'The change must be reviewed before a pull request.',
    priority: 'high',
    dependsOn: [],
    scope: { allowedPaths: ['README.md'], forbiddenPaths: [] },
    acceptanceCriteria: [
      { id: 'AC-1', description: 'The committed change is reviewed.' },
      { id: 'AC-2', description: 'Both review axes run independently.' },
    ],
    verification: { commands: ['pnpm test'] },
    risk: 'medium',
    agent: {},
    release: {},
  };
}

type Harness = {
  projectDir: string;
  worktreeRoot: string;
  workspacePath: string;
  workspace: WorkspaceRecord;
  db: DbConnection;
  adapter: ReviewAdapter;
  modelService: ModelRoutingService;
};

type ReviewAdapter = AgentExecutionAdapter & {
  requests: AgentExecutionRequest[];
  results: readonly string[];
};

function reviewAdapter(results: readonly string[]): ReviewAdapter {
  const requests: AgentExecutionRequest[] = [];
  const adapter: ReviewAdapter = {
    provider: 'opencode',
    capabilities: ['execute', 'review'],
    supportsTokenLimit: true,
    supportsCostLimit: true,
    reportsUsage: true,
    requests,
    results,
    probe: () => ({ available: true, version: 'test-agent' }),
    execute: async (request) => {
      requests.push(request);
      const output = results[requests.length - 1] ?? results.at(-1) ?? '{"result":"FAIL","findings":["missing test result"]}';
      if (output === 'direct-contradictory') {
        return {
          outcome: 'SUCCEEDED',
          timedOut: false,
          cancelled: false,
          processGroupStopped: true,
          stdout: JSON.stringify({ result: 'PASS', findings: [] }),
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          reviewResult: 'PASS',
          reviewFindings: ['contradictory finding'],
        } satisfies AgentExecutionResult;
      }
      if (output === 'direct-missing-findings') {
        return {
          outcome: 'SUCCEEDED',
          timedOut: false,
          cancelled: false,
          processGroupStopped: true,
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          reviewResult: 'PASS',
        } satisfies AgentExecutionResult;
      }
      if (output === 'json-envelope') {
        return {
          outcome: 'SUCCEEDED',
          timedOut: false,
          cancelled: false,
          processGroupStopped: true,
          stdout: JSON.stringify({ type: 'text', message: { content: VALID_REVIEW_REPORT } }),
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        } satisfies AgentExecutionResult;
      }
      if (output === 'jsonl-envelope') {
        return {
          outcome: 'SUCCEEDED',
          timedOut: false,
          cancelled: false,
          processGroupStopped: true,
          stdout: `${JSON.stringify({ type: 'text', part: { text: VALID_REVIEW_REPORT } })}\n`,
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          evidence: {
            outputFormat: 'jsonl',
            eventCount: 1,
            eventTypes: ['text'],
          },
        } satisfies AgentExecutionResult;
      }
      if (output === 'jsonl-status-envelope') {
        return {
          outcome: 'SUCCEEDED',
          timedOut: false,
          cancelled: false,
          processGroupStopped: true,
          stdout: [
            JSON.stringify({ type: 'session', session_id: 'review-session' }),
            JSON.stringify({ type: 'status', event: 'complete' }),
            JSON.stringify({ type: 'text', text: VALID_REVIEW_REPORT }),
          ].join('\n'),
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          evidence: {
            outputFormat: 'jsonl',
            eventCount: 3,
            eventTypes: ['session', 'status', 'text'],
          },
        } satisfies AgentExecutionResult;
      }
      if (output === 'jsonl-malformed-metadata-envelope') {
        return {
          outcome: 'SUCCEEDED',
          timedOut: false,
          cancelled: false,
          processGroupStopped: true,
          stdout: [
            JSON.stringify({ type: 42, session_id: null }),
            JSON.stringify({ type: 'text', text: VALID_REVIEW_REPORT }),
          ].join('\n'),
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          evidence: {
            outputFormat: 'jsonl',
            eventCount: 2,
            eventTypes: ['text'],
          },
        } satisfies AgentExecutionResult;
      }
      if (output === 'jsonl-arbitrary-metadata-envelope') {
        return {
          outcome: 'SUCCEEDED',
          timedOut: false,
          cancelled: false,
          processGroupStopped: true,
          stdout: [
            JSON.stringify({ type: 'status', part: false, data: 42, payload: null, msg: ['complete'] }),
            JSON.stringify({ type: 'text', text: VALID_REVIEW_REPORT }),
          ].join('\n'),
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          evidence: {
            outputFormat: 'jsonl',
            eventCount: 2,
            eventTypes: ['status', 'text'],
          },
        } satisfies AgentExecutionResult;
      }
      if (output === 'jsonl-malformed-conversation-envelope') {
        return {
          outcome: 'SUCCEEDED',
          timedOut: false,
          cancelled: false,
          processGroupStopped: true,
          stdout: [
            JSON.stringify({ type: 'status', conversationId: 42 }),
            JSON.stringify({ type: 'text', text: VALID_REVIEW_REPORT }),
          ].join('\n'),
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          evidence: {
            outputFormat: 'jsonl',
            eventCount: 2,
            eventTypes: ['status', 'text'],
          },
        } satisfies AgentExecutionResult;
      }
      if (output === 'jsonl-malformed-report-field-envelope') {
        return {
          outcome: 'SUCCEEDED',
          timedOut: false,
          cancelled: false,
          processGroupStopped: true,
          stdout: [
            JSON.stringify({ type: 'status', result: 'MAYBE' }),
            JSON.stringify({ type: 'text', text: VALID_REVIEW_REPORT }),
          ].join('\n'),
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          evidence: {
            outputFormat: 'jsonl',
            eventCount: 2,
            eventTypes: ['status', 'text'],
          },
        } satisfies AgentExecutionResult;
      }
      if (output === 'message-envelope') {
        return {
          outcome: 'SUCCEEDED',
          timedOut: false,
          cancelled: false,
          processGroupStopped: true,
          stdout: JSON.stringify({ type: 'message', message: VALID_REVIEW_REPORT }),
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        } satisfies AgentExecutionResult;
      }
      if (output === 'content-envelope') {
        return {
          outcome: 'SUCCEEDED',
          timedOut: false,
          cancelled: false,
          processGroupStopped: true,
          stdout: JSON.stringify({ type: 'content', content: VALID_REVIEW_REPORT }),
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        } satisfies AgentExecutionResult;
      }
      if (output === 'long-envelope') {
        return {
          outcome: 'SUCCEEDED',
          timedOut: false,
          cancelled: false,
          processGroupStopped: true,
          stdout: JSON.stringify({ type: 'text', text: LONG_REVIEW_REPORT }),
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          evidence: {
            outputFormat: 'json',
            eventCount: 1,
            eventTypes: ['text'],
            summary: LONG_REVIEW_REPORT.slice(0, 4_096),
          },
        } satisfies AgentExecutionResult;
      }
      if (output === 'malformed-envelope') {
        return {
          outcome: 'SUCCEEDED',
          timedOut: false,
          cancelled: false,
          processGroupStopped: true,
          stdout: JSON.stringify({ type: 'text', text: '{"result":"PASS"}' }),
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        } satisfies AgentExecutionResult;
      }
      if (output === 'envelope-direct-conflict') {
        return {
          outcome: 'SUCCEEDED',
          timedOut: false,
          cancelled: false,
          processGroupStopped: true,
          stdout: JSON.stringify({
            type: 'text',
            text: JSON.stringify({ result: 'FAIL', findings: ['envelope finding'] }),
          }),
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          reviewResult: 'PASS',
          reviewFindings: [],
        } satisfies AgentExecutionResult;
      }
      if (output === 'error-envelope') {
        return {
          outcome: 'SUCCEEDED',
          timedOut: false,
          cancelled: false,
          processGroupStopped: true,
          stdout: JSON.stringify({
            type: 'text',
            text: VALID_REVIEW_REPORT,
            data: { error: { message: 'provider error' } },
          }),
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        } satisfies AgentExecutionResult;
      }
      if (output === 'primitive-error-envelope') {
        return {
          outcome: 'SUCCEEDED',
          timedOut: false,
          cancelled: false,
          processGroupStopped: true,
          stdout: JSON.stringify({ type: 'text', text: VALID_REVIEW_REPORT, error: true }),
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        } satisfies AgentExecutionResult;
      }
      if (output === 'malformed-text-envelope') {
        return {
          outcome: 'SUCCEEDED',
          timedOut: false,
          cancelled: false,
          processGroupStopped: true,
          stdout: JSON.stringify({ type: 'text', text: 42, data: { text: VALID_REVIEW_REPORT } }),
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        } satisfies AgentExecutionResult;
      }
      if (output === 'non-report-envelope') {
        return {
          outcome: 'SUCCEEDED',
          timedOut: false,
          cancelled: false,
          processGroupStopped: true,
          stdout: JSON.stringify({ type: 'status', state: 'complete' }),
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          evidence: {
            outputFormat: 'json',
            eventCount: 1,
            eventTypes: ['status'],
            summary: VALID_REVIEW_REPORT,
          },
        } satisfies AgentExecutionResult;
      }
      if (output === 'cross-channel-conflict') {
        return {
          outcome: 'SUCCEEDED',
          timedOut: false,
          cancelled: false,
          processGroupStopped: true,
          stdout: JSON.stringify({ result: 'FAIL', findings: ['stdout finding'] }),
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          evidence: {
            outputFormat: 'json',
            eventCount: 1,
            eventTypes: ['review'],
            summary: JSON.stringify({ result: 'PASS', findings: [] }),
          },
          reviewResult: 'PASS',
          reviewFindings: [],
        } satisfies AgentExecutionResult;
      }
      if (output === 'malformed-channel') {
        return {
          outcome: 'SUCCEEDED',
          timedOut: false,
          cancelled: false,
          processGroupStopped: true,
          stdout: JSON.stringify({ unexpected: 'value' }),
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          evidence: {
            outputFormat: 'json',
            eventCount: 1,
            eventTypes: ['review'],
            summary: JSON.stringify({ result: 'PASS', findings: [] }),
          },
          reviewResult: 'PASS',
          reviewFindings: [],
        } satisfies AgentExecutionResult;
      }
      return {
        outcome: 'SUCCEEDED',
        timedOut: false,
        cancelled: false,
        processGroupStopped: true,
        stdout: output,
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
      } satisfies AgentExecutionResult;
    },
  };
  registerModelProviderAdapter(adapter, 'opencode-go');
  return adapter;
}

async function createHarness(results: readonly string[]): Promise<Harness> {
  const projectDir = mkdtempSync(join(tmpdir(), 'shipgraph-review-src-'));
  git(projectDir, 'init', '-b', 'main');
  git(projectDir, 'config', 'user.email', 'shipgraph-review@example.com');
  git(projectDir, 'config', 'user.name', 'ShipGraph Review Test');
  writeFileSync(join(projectDir, 'README.md'), '# source\n');
  git(projectDir, 'add', '.');
  git(projectDir, 'commit', '-m', 'initial');
  initProject(projectDir, { config: CONFIG });
  writeFileSync(join(projectDir, 'shipgraph.backlog.yml'), stringify({ version: 1, tickets: [ticket()] }));
  syncBacklogProject(projectDir);
  const db = openAndMigrate(join(projectDir, '.shipgraph', 'shipgraph.db'));
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'shipgraph-review-root-'));
  const adapter = reviewAdapter(results);
  const workspace = await createWorkspace({ db, projectDir, worktreeRoot }, 'REV-001');
  const projectId = workspace.workspace.projectId;
  for (const state of [TicketState.IMPLEMENTING, TicketState.VERIFYING, TicketState.PR_OPEN, TicketState.CI_WAIT, TicketState.REVIEWING]) {
    persistTicketTransition(db, {
      ticketId: 'REV-001',
      projectId,
      next: state,
      reason: `prepare review state ${state}`,
    });
  }
  writeFileSync(join(workspace.workspace.worktreePath, 'README.md'), '# changed\n');
  git(workspace.workspace.worktreePath, 'add', 'README.md');
  git(workspace.workspace.worktreePath, 'commit', '-m', 'implementation change');

  const provider: ModelProviderAdapter = {
    providerId: 'opencode-go',
    family: 'opencode',
    displayName: 'OpenCode Go',
    probe: async () => ({
      availability: 'available',
      auth: 'authenticated',
      version: 'metadata-provider',
      capabilities: ['implementation', 'review', 'repair'],
    }),
    discoverModels: async () => ({
      status: 'known',
      models: [{ modelId: 'opencode/reviewer', capabilities: ['review'] }],
    }),
  };
  const modelService = new ModelRoutingService({
    db,
    projectId,
    adapters: [provider],
    executionAdapters: [{ modelProviderId: 'opencode-go', adapter }],
  });
  return {
    projectDir,
    worktreeRoot,
    workspacePath: workspace.workspace.worktreePath,
    workspace: workspace.workspace,
    db,
    adapter,
    modelService,
  };
}

function cleanup(harness: Harness | undefined): void {
  if (!harness) return;
  harness.db.close();
  rmSync(harness.projectDir, { recursive: true, force: true });
  rmSync(harness.worktreeRoot, { recursive: true, force: true });
}

function routing() {
  return {
    risk: 'medium' as const,
    envelope: {
      mode: 'balanced' as const,
      maxConcurrentTickets: 1,
      activeConcurrentTickets: 0,
      budgetRemaining: 'unknown' as const,
    },
  };
}

function readinessInput(harness: Harness) {
  return {
    ticketId: 'REV-001',
    workspace: {
      db: harness.db,
      projectDir: harness.projectDir,
      worktreeRoot: harness.worktreeRoot,
    },
  };
}

function recordVerificationEvidence(
  harness: Harness,
  options: {
    attempt?: number;
    repairRunId?: string;
    blockers?: readonly Record<string, unknown>[];
    redCapableEvidence?: readonly Record<string, unknown>[];
    redInfeasibilityReason?: string;
    exitCode?: number;
    candidateSha?: string;
    resultingSha?: string;
    finalVerification?: readonly Record<string, unknown>[];
    outcome?: 'PASSED' | 'REPAIRED' | 'BLOCKED' | 'NEEDS_HUMAN';
  } = {}
): string {
  const sha = git(harness.workspacePath, 'rev-parse', 'HEAD');
  const eventId = randomUUID();
  createEventRepository(harness.db).append({
    id: eventId,
    timestamp: new Date().toISOString(),
    projectId: harness.workspace.projectId,
    ticketId: 'REV-001',
    ...(options.repairRunId === undefined ? {} : { runId: options.repairRunId }),
    type: EventType.REPAIR_ATTEMPT_RECORDED,
    payload: {
      ticketId: 'REV-001',
      attempt: options.attempt ?? 0,
      candidateSha: options.candidateSha ?? sha,
      ...(options.repairRunId === undefined ? {} : { repairRunId: options.repairRunId }),
      blockers: options.blockers ?? [],
      targetedVerification: [],
      finalVerification: options.finalVerification ?? [{
        command: 'pnpm test',
        sha,
        exitCode: options.exitCode ?? 0,
        stdout: '',
        stderr: '',
      }],
      reviews: { reviewedSha: sha, contract: 'PASS', engineering: 'PASS' },
      redCapableEvidence: options.redCapableEvidence ?? [],
      ...(options.redInfeasibilityReason === undefined
        ? {}
        : { redInfeasibilityReason: options.redInfeasibilityReason }),
      outcome: options.outcome ?? 'PASSED',
      ...(options.attempt === undefined || options.attempt === 0
        ? {}
        : { resultingSha: options.resultingSha ?? sha }),
    },
  });
  return eventId;
}

function insertRepairRun(harness: Harness, status: 'SUCCEEDED' | 'NEEDS_HUMAN'): string {
  const now = new Date().toISOString();
  const id = randomUUID();
  createRunRepository(harness.db).create({
    id,
    ticketId: 'REV-001',
    projectId: harness.workspace.projectId,
    workspaceId: harness.workspace.id,
    workspacePath: harness.workspace.worktreePath,
    baseSha: harness.workspace.baseSha,
    branchName: harness.workspace.branchName,
    status,
    provider: 'opencode',
    task: 'repair',
    model: 'opencode/reviewer',
    createdAt: now,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
    timedOut: false,
    cancelled: false,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    instructionsSha256: 'a'.repeat(64),
    safetyPolicySha256: 'b'.repeat(64),
    timeoutMs: 1000,
  });
  return id;
}

describe('KAR-9 exact-SHA pre-PR reviews', () => {
  let harness: Harness | undefined;

  afterEach(() => {
    cleanup(harness);
    harness = undefined;
  });

  it('runs both independent axes and requires both PASS results', async () => {
    harness = await createHarness([
      JSON.stringify({ result: 'PASS', findings: [] }),
      JSON.stringify({ result: 'FAIL', findings: ['engineering finding'] }),
    ]);
    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });

    expect(result.passed).toBe(false);
    expect(result.contract).toMatchObject({ reviewType: 'contract', result: 'PASS', findings: [], passed: true });
    expect(result.engineering).toMatchObject({ reviewType: 'engineering', result: 'FAIL', findings: ['engineering finding'], passed: false });
    expect(result.contract.reviewedSha).toBe(result.engineering.reviewedSha);
    expect(harness.adapter.requests).toHaveLength(2);
    expect(harness.adapter.requests[0]?.reviewType).toBe('contract');
    expect(harness.adapter.requests[1]?.reviewType).toBe('engineering');
    expect(harness.adapter.requests[0]?.instructions).toContain('AC-1');
    expect(harness.adapter.requests[0]?.instructions).toContain('read-only repository');
    expect(harness.adapter.requests[0]?.instructions).toContain('untrusted artifact data');
    expect(harness.adapter.requests[0]?.instructions).not.toContain('implementation transcript');
    expect(harness.adapter.requests[0]?.instructions).not.toContain('self-review');

    const runs = createTicketRepository(harness.db).findById('REV-001');
    expect(runs?.status).toBe(TicketState.REVIEWING);
    const durableRuns = harness.db.prepare(
      "SELECT review_type, reviewed_sha, review_result, review_findings_json FROM runs WHERE ticket_id = ? ORDER BY started_at"
    ).all('REV-001') as Array<Record<string, unknown>>;
    expect(durableRuns).toHaveLength(2);
    expect(durableRuns.map((run) => run.review_type)).toEqual(['contract', 'engineering']);
    expect(durableRuns[0]?.reviewed_sha).toBe(result.reviewedSha);
    expect(durableRuns[1]?.review_result).toBe('FAIL');
    expect(JSON.parse(String(durableRuns[1]?.review_findings_json))).toEqual(['engineering finding']);
  }, 15_000);

  it('reports success only when both axes pass and exposes only current-head evidence', async () => {
    harness = await createHarness([
      JSON.stringify({ result: 'PASS', findings: [] }),
      JSON.stringify({ result: 'PASS', findings: [] }),
    ]);
    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });

    expect(result.passed).toBe(true);
    expect(await listCurrentPrePrReviewEvidence(
      { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      'REV-001'
    )).toHaveLength(2);

    writeFileSync(join(harness.workspacePath, 'README.md'), '# changed again\n');
    git(harness.workspacePath, 'add', 'README.md');
    git(harness.workspacePath, 'commit', '-m', 'candidate changed');
    expect(await listCurrentPrePrReviewEvidence(
      { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      'REV-001'
    )).toHaveLength(0);
  });

  it('parses a valid review report inside a JSON provider envelope', async () => {
    harness = await createHarness(['json-envelope', VALID_REVIEW_REPORT]);
    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });

    expect(result.contract.passed).toBe(true);
    expect(result.contract.result).toBe('PASS');
    expect(result.engineering.passed).toBe(true);
  });

  it('parses a valid review report inside a JSONL provider envelope', async () => {
    harness = await createHarness(['jsonl-envelope', VALID_REVIEW_REPORT]);
    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });

    expect(result.contract.passed).toBe(true);
    expect(result.contract.result).toBe('PASS');
    expect(result.engineering.passed).toBe(true);
  });

  it('ignores valid JSONL status events before a valid report event', async () => {
    harness = await createHarness(['jsonl-status-envelope', VALID_REVIEW_REPORT]);
    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });

    expect(result.contract.passed).toBe(true);
    expect(result.contract.result).toBe('PASS');
    expect(result.engineering.passed).toBe(true);
  });

  it('fails closed on malformed JSONL event metadata before a valid report event', async () => {
    harness = await createHarness(['jsonl-malformed-metadata-envelope', VALID_REVIEW_REPORT]);
    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });

    expect(result.contract.passed).toBe(false);
    expect(result.contract.run.status).toBe('NEEDS_HUMAN');
    expect(result.contract.run.failureCategory).toBe('malformed_output');
    expect(result.engineering.passed).toBe(true);
  });

  it('ignores arbitrary non-text provider metadata before a valid report event', async () => {
    harness = await createHarness(['jsonl-arbitrary-metadata-envelope', VALID_REVIEW_REPORT]);
    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });

    expect(result.contract.passed).toBe(true);
    expect(result.contract.result).toBe('PASS');
    expect(result.engineering.passed).toBe(true);
  });

  it('fails closed on a malformed conversation identifier before a valid report event', async () => {
    harness = await createHarness(['jsonl-malformed-conversation-envelope', VALID_REVIEW_REPORT]);
    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });

    expect(result.contract.passed).toBe(false);
    expect(result.contract.run.status).toBe('NEEDS_HUMAN');
    expect(result.contract.run.failureCategory).toBe('malformed_output');
    expect(result.engineering.passed).toBe(true);
  });

  it('fails closed on a malformed report field before a valid report event', async () => {
    harness = await createHarness(['jsonl-malformed-report-field-envelope', VALID_REVIEW_REPORT]);
    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });

    expect(result.contract.passed).toBe(false);
    expect(result.contract.run.status).toBe('NEEDS_HUMAN');
    expect(result.contract.run.failureCategory).toBe('malformed_output');
    expect(result.engineering.passed).toBe(true);
  });

  it('parses a valid review report from a top-level message string', async () => {
    harness = await createHarness(['message-envelope', VALID_REVIEW_REPORT]);
    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });

    expect(result.contract.passed).toBe(true);
    expect(result.contract.result).toBe('PASS');
    expect(result.engineering.passed).toBe(true);
  });

  it('parses a valid review report from a top-level content string', async () => {
    harness = await createHarness(['content-envelope', VALID_REVIEW_REPORT]);
    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });

    expect(result.contract.passed).toBe(true);
    expect(result.contract.result).toBe('PASS');
    expect(result.engineering.passed).toBe(true);
  });

  it('does not accept bounded evidence.summary as the only review report', async () => {
    harness = await createHarness(['non-report-envelope', VALID_REVIEW_REPORT]);
    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });

    expect(result.contract.passed).toBe(false);
    expect(result.contract.run.status).toBe('NEEDS_HUMAN');
    expect(result.contract.run.failureCategory).toBe('malformed_output');
    expect(result.engineering.passed).toBe(true);
  });

  it('parses a long valid embedded report from stdout instead of bounded evidence.summary', async () => {
    harness = await createHarness(['long-envelope', VALID_REVIEW_REPORT]);
    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });

    expect(result.contract.result).toBe('FAIL');
    expect(result.contract.findings).toHaveLength(3);
    expect(result.engineering.passed).toBe(true);
  });

  it('fails closed when a provider envelope contains malformed review JSON', async () => {
    harness = await createHarness(['malformed-envelope', VALID_REVIEW_REPORT]);
    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });

    expect(result.contract.passed).toBe(false);
    expect(result.contract.run.status).toBe('NEEDS_HUMAN');
    expect(result.contract.run.failureCategory).toBe('malformed_output');
    expect(result.engineering.passed).toBe(true);
  });

  it('fails closed when an embedded envelope report conflicts with direct report fields', async () => {
    harness = await createHarness(['envelope-direct-conflict', VALID_REVIEW_REPORT]);
    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });

    expect(result.contract.passed).toBe(false);
    expect(result.contract.run.status).toBe('NEEDS_HUMAN');
    expect(result.contract.run.failureCategory).toBe('malformed_output');
    expect(result.engineering.passed).toBe(true);
  });

  it('fails closed when a provider error accompanies an embedded report', async () => {
    harness = await createHarness(['error-envelope', VALID_REVIEW_REPORT]);
    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });

    expect(result.contract.passed).toBe(false);
    expect(result.contract.run.status).toBe('NEEDS_HUMAN');
    expect(result.contract.run.failureCategory).toBe('malformed_output');
    expect(result.engineering.passed).toBe(true);
  });

  it('fails closed when a primitive provider error accompanies an embedded report', async () => {
    harness = await createHarness(['primitive-error-envelope', VALID_REVIEW_REPORT]);
    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });

    expect(result.contract.passed).toBe(false);
    expect(result.contract.run.status).toBe('NEEDS_HUMAN');
    expect(result.contract.run.failureCategory).toBe('malformed_output');
    expect(result.engineering.passed).toBe(true);
  });

  it('fails closed when a malformed provider text field accompanies a valid report', async () => {
    harness = await createHarness(['malformed-text-envelope', VALID_REVIEW_REPORT]);
    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });

    expect(result.contract.passed).toBe(false);
    expect(result.contract.run.status).toBe('NEEDS_HUMAN');
    expect(result.contract.run.failureCategory).toBe('malformed_output');
    expect(result.engineering.passed).toBe(true);
  });

  it('fails closed on a contradictory PASS report', async () => {
    harness = await createHarness([JSON.stringify({ result: 'PASS', findings: ['contradictory finding'] }), JSON.stringify({ result: 'PASS', findings: [] })]);
    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });

    expect(result.contract.passed).toBe(false);
    expect(result.contract.run.status).toBe('NEEDS_HUMAN');
    expect(result.contract.run.failureCategory).toBe('malformed_output');
    expect(result.engineering.passed).toBe(true);
  });

  it('fails closed when direct adapter report fields contradict stdout', async () => {
    harness = await createHarness(['direct-contradictory', JSON.stringify({ result: 'PASS', findings: [] })]);
    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });

    expect(result.contract.passed).toBe(false);
    expect(result.contract.run.status).toBe('NEEDS_HUMAN');
    expect(result.contract.run.failureCategory).toBe('malformed_output');
    expect(result.engineering.passed).toBe(true);
  });

  it('fails closed when direct adapter report fields omit findings', async () => {
    harness = await createHarness(['direct-missing-findings', JSON.stringify({ result: 'PASS', findings: [] })]);
    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });

    expect(result.contract.passed).toBe(false);
    expect(result.contract.run.status).toBe('NEEDS_HUMAN');
    expect(result.contract.run.failureCategory).toBe('malformed_output');
    expect(result.engineering.passed).toBe(true);
  });

  it('bounds long caller request IDs while keeping review axes distinct', async () => {
    harness = await createHarness([
      JSON.stringify({ result: 'PASS', findings: [] }),
      JSON.stringify({ result: 'PASS', findings: [] }),
    ]);
    const requestId = 'r'.repeat(256);
    await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: { ...routing(), requestId },
    });

    const decisions = harness.db.prepare(
      'SELECT request_id FROM routing_decisions ORDER BY created_at'
    ).all() as Array<{ request_id: string }>;
    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.request_id.length).toBeLessThanOrEqual(256);
    expect(decisions[1]?.request_id.length).toBeLessThanOrEqual(256);
    expect(decisions[0]?.request_id).not.toBe(decisions[1]?.request_id);
  });

  it('fails closed when valid report channels disagree', async () => {
    harness = await createHarness(['cross-channel-conflict', JSON.stringify({ result: 'PASS', findings: [] })]);
    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });

    expect(result.contract.passed).toBe(false);
    expect(result.contract.run.status).toBe('NEEDS_HUMAN');
    expect(result.contract.run.failureCategory).toBe('malformed_output');
    expect(result.engineering.passed).toBe(true);
  });

  it('fails closed on malformed non-empty provider output', async () => {
    harness = await createHarness(['malformed-channel', JSON.stringify({ result: 'PASS', findings: [] })]);
    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });

    expect(result.contract.passed).toBe(false);
    expect(result.contract.run.status).toBe('NEEDS_HUMAN');
    expect(result.contract.run.failureCategory).toBe('malformed_output');
    expect(result.engineering.passed).toBe(true);
  });

  it('does not launch when the existing KAR-7 approval gate applies', async () => {
    harness = await createHarness([
      JSON.stringify({ result: 'PASS', findings: [] }),
      JSON.stringify({ result: 'PASS', findings: [] }),
    ]);
    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
      safety: { approvalRequired: true },
    });

    expect(result.passed).toBe(false);
    expect(harness.adapter.requests).toHaveLength(0);
    expect(result.contract.run.status).toBe('NEEDS_HUMAN');
    expect(result.contract.run.failureCategory).toBe('approval_required');
    expect(result.engineering.run.status).toBe('NEEDS_HUMAN');
  });

  it('keeps a large but reviewable ticket within the complete instruction limit', async () => {
    harness = await createHarness([VALID_REVIEW_REPORT, VALID_REVIEW_REPORT]);
    harness.db.prepare('UPDATE tickets SET description = ? WHERE id = ?').run('x'.repeat(12_000), 'REV-001');
    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });

    expect(result.passed).toBe(true);
    expect(harness.adapter.requests.every((request) =>
      Buffer.byteLength(request.instructions, 'utf8') <= AGENT_INSTRUCTIONS_LIMIT_BYTES
    )).toBe(true);
    expect(harness.adapter.requests[0]?.instructions).toContain('x'.repeat(12_000));
  });

  it('fails closed before provider execution when the complete contract cannot fit', async () => {
    harness = await createHarness([VALID_REVIEW_REPORT, VALID_REVIEW_REPORT]);
    harness.db.prepare('UPDATE tickets SET description = ? WHERE id = ?').run('x'.repeat(70_000), 'REV-001');

    await expect(runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    })).rejects.toMatchObject({
      code: 'KAR9_REVIEW_INPUT_TOO_LARGE',
    });
    expect(harness.adapter.requests).toHaveLength(0);
  });

  it('marks a reduced diff explicitly when the complete review input needs it', async () => {
    harness = await createHarness([VALID_REVIEW_REPORT, VALID_REVIEW_REPORT]);
    harness.db.prepare('UPDATE tickets SET description = ? WHERE id = ?').run('x'.repeat(45_000), 'REV-001');
    writeFileSync(join(harness.workspacePath, 'README.md'), 'x'.repeat(30_000));
    git(harness.workspacePath, 'add', 'README.md');
    git(harness.workspacePath, 'commit', '-m', 'large candidate change');

    const result = await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });

    expect(result.passed).toBe(true);
    expect(harness.adapter.requests[0]?.instructions).toContain('[INCOMPLETE DIFF:');
    expect(harness.adapter.requests.every((request) =>
      Buffer.byteLength(request.instructions, 'utf8') <= AGENT_INSTRUCTIONS_LIMIT_BYTES
    )).toBe(true);
  });

  it('passes readiness only when verification, both current reviews, safety, and provenance agree', async () => {
    harness = await createHarness([VALID_REVIEW_REPORT, VALID_REVIEW_REPORT]);
    await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });
    const verificationEventId = recordVerificationEvidence(harness);

    const result = await runPrePrReadiness(readinessInput(harness));
    expect(result.result).toBe('PASS');
    expect(result.evidence?.verificationEventId).toBe(verificationEventId);
    expect(result.evidence?.contractReviewRunId).toBeDefined();
    expect(result.evidence?.engineeringReviewRunId).toBeDefined();
    expect(await getCurrentPrePrReadinessEvidence(
      { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      'REV-001'
    )).toMatchObject({ result: 'PASS', readySha: result.readySha });
  });

  it('fails readiness when verification evidence is missing or failing', async () => {
    harness = await createHarness([VALID_REVIEW_REPORT, VALID_REVIEW_REPORT]);
    await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });
    expect((await runPrePrReadiness(readinessInput(harness))).result).toBe('FAIL');
    recordVerificationEvidence(harness, { exitCode: 1 });
    const result = await runPrePrReadiness(readinessInput(harness));
    expect(result.result).toBe('FAIL');
    expect(result.reason).toContain('failing result');
  });

  it('requires both review axes and rejects either review FAIL', async () => {
    harness = await createHarness([
      JSON.stringify({ result: 'FAIL', findings: ['contract blocker'] }),
      VALID_REVIEW_REPORT,
    ]);
    await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });
    recordVerificationEvidence(harness);
    const result = await runPrePrReadiness(readinessInput(harness));
    expect(result.result).toBe('FAIL');
    expect(result.reason).toContain('contract review is FAIL');
  });

  it('allows a later current exact-SHA PASS to supersede an earlier FAIL', async () => {
    const failedReview = JSON.stringify({ result: 'FAIL', findings: ['needs repair'] });
    harness = await createHarness([failedReview, failedReview, VALID_REVIEW_REPORT, VALID_REVIEW_REPORT]);
    await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });
    recordVerificationEvidence(harness);
    expect((await runPrePrReadiness(readinessInput(harness))).result).toBe('FAIL');

    await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });
    expect((await runPrePrReadiness(readinessInput(harness))).result).toBe('PASS');
  });

  it('rejects a newer failed review attempt instead of using an older PASS', async () => {
    harness = await createHarness([VALID_REVIEW_REPORT, VALID_REVIEW_REPORT]);
    await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });
    recordVerificationEvidence(harness);
    const currentReview = createRunRepository(harness.db)
      .findByTicketId('REV-001')
      .find((run) => run.task === 'review' && run.reviewType === 'contract');
    expect(currentReview).toBeDefined();
    if (currentReview === undefined) throw new Error('current contract review run is missing');
    const later = new Date(Date.now() + 1_000).toISOString();
    createRunRepository(harness.db).create({
      ...currentReview,
      id: randomUUID(),
      status: 'FAILED',
      startedAt: later,
      createdAt: later,
      updatedAt: later,
      completedAt: later,
      failureCategory: 'adapter_error',
    });

    const result = await runPrePrReadiness(readinessInput(harness));
    expect(result.result).toBe('FAIL');
    expect(result.reason).toContain('Current contract review run is FAILED');
  });

  it('fails readiness when a later repair attempt for the current SHA is blocked', async () => {
    harness = await createHarness([VALID_REVIEW_REPORT, VALID_REVIEW_REPORT]);
    await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });
    const currentSha = git(harness.workspacePath, 'rev-parse', 'HEAD');
    const repairRunId = insertRepairRun(harness, 'SUCCEEDED');
    recordVerificationEvidence(harness, {
      attempt: 1,
      repairRunId,
      candidateSha: 'c'.repeat(40),
      resultingSha: currentSha,
      finalVerification: [{ command: 'pnpm test', sha: currentSha, exitCode: 0, stdout: '', stderr: '' }],
    });
    expect((await runPrePrReadiness(readinessInput(harness))).result).toBe('PASS');

    recordVerificationEvidence(harness, {
      attempt: 2,
      candidateSha: currentSha,
      blockers: [{
        source: 'verification',
        command: 'pnpm test',
        expected: 'command exits with status 0',
        actual: 'exit code 1',
      }],
      outcome: 'BLOCKED',
      reason: 'later repair attempt failed',
    });
    const result = await runPrePrReadiness(readinessInput(harness));
    expect(result.result).toBe('FAIL');
    expect(result.reason).toContain('No KAR-10 final verification evidence');
  });

  it('invalidates readiness after the candidate SHA changes while retaining history', async () => {
    harness = await createHarness([VALID_REVIEW_REPORT, VALID_REVIEW_REPORT]);
    await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });
    recordVerificationEvidence(harness);
    const first = await runPrePrReadiness(readinessInput(harness));
    expect(first.result).toBe('PASS');

    writeFileSync(join(harness.workspacePath, 'README.md'), '# changed again\n');
    git(harness.workspacePath, 'add', 'README.md');
    git(harness.workspacePath, 'commit', '-m', 'new candidate');
    expect(await getCurrentPrePrReadinessEvidence(
      { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      'REV-001'
    )).toBeUndefined();
    expect(createEventRepository(harness.db).findByTicketId('REV-001').some((event) =>
      event.type === EventType.PRE_PR_READINESS_RECORDED && event.payload.readySha === first.readySha
    )).toBe(true);
  });

  it('invalidates old-contract reviews when the authoritative ticket definition changes', async () => {
    harness = await createHarness([VALID_REVIEW_REPORT, VALID_REVIEW_REPORT]);
    await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });
    recordVerificationEvidence(harness);
    harness.db.prepare('UPDATE tickets SET description = ? WHERE id = ?').run(
      'authoritative contract changed',
      'REV-001'
    );
    const result = await runPrePrReadiness(readinessInput(harness));
    expect(result.result).toBe('FAIL');
    expect(result.reason).toContain('does not match the authoritative backlog contract');
  });

  it('fails closed when the authoritative backlog source changed after sync', async () => {
    harness = await createHarness([VALID_REVIEW_REPORT, VALID_REVIEW_REPORT]);
    await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });
    recordVerificationEvidence(harness);
    writeFileSync(join(harness.projectDir, 'shipgraph.backlog.yml'), stringify({
      version: 1,
      tickets: [{ ...ticket(), description: 'authoritative source changed' }],
    }));

    const result = await runPrePrReadiness(readinessInput(harness));
    expect(result.result).toBe('FAIL');
    expect(result.reason).toContain('changed since the last sync');
    expect(result.evidence?.result).toBe('FAIL');
  });

  it('fails closed on duplicate final verification observations', async () => {
    harness = await createHarness([VALID_REVIEW_REPORT, VALID_REVIEW_REPORT]);
    await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });
    const sha = git(harness.workspacePath, 'rev-parse', 'HEAD');
    const observation = { command: 'pnpm test', sha, exitCode: 0, stdout: '', stderr: '' };
    recordVerificationEvidence(harness, { finalVerification: [observation, observation] });

    const result = await runPrePrReadiness(readinessInput(harness));
    expect(result.result).toBe('FAIL');
    expect(result.reason).toContain('exactly one observation per configured command');
  });

  it('requires red-capable evidence or an explicit KAR-10 infeasibility reason for bug repairs', async () => {
    harness = await createHarness([VALID_REVIEW_REPORT, VALID_REVIEW_REPORT]);
    await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });
    const repairRunId = insertRepairRun(harness, 'SUCCEEDED');
    const currentSha = git(harness.workspacePath, 'rev-parse', 'HEAD');
    const blocker = {
      source: 'verification',
      command: 'pnpm test',
      expected: 'command exits with status 0',
      actual: 'exit code 1',
    };
    const red = {
      command: 'pnpm test',
      expectedSymptom: 'exit code 1',
      before: { command: 'pnpm test', sha: 'c'.repeat(40), exitCode: 1, stdout: '', stderr: '' },
      after: { command: 'pnpm test', sha: currentSha, exitCode: 0, stdout: '', stderr: '' },
    };
    recordVerificationEvidence(harness, {
      attempt: 1,
      repairRunId,
      candidateSha: 'c'.repeat(40),
      blockers: [blocker],
      redCapableEvidence: [red],
    });
    expect((await runPrePrReadiness(readinessInput(harness))).result).toBe('PASS');
  });

  it('rejects bug repair evidence without the same-command green after result', async () => {
    harness = await createHarness([VALID_REVIEW_REPORT, VALID_REVIEW_REPORT]);
    await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });
    const currentSha = git(harness.workspacePath, 'rev-parse', 'HEAD');
    recordVerificationEvidence(harness, {
      attempt: 1,
      repairRunId: insertRepairRun(harness, 'SUCCEEDED'),
      candidateSha: 'c'.repeat(40),
      blockers: [{
        source: 'verification',
        command: 'pnpm test',
        expected: 'command exits with status 0',
        actual: 'exit code 1',
      }],
      redCapableEvidence: [{
        command: 'pnpm test',
        expectedSymptom: 'exit code 1',
        before: { command: 'pnpm test', sha: 'c'.repeat(40), exitCode: 1, stdout: '', stderr: '' },
      }],
      resultingSha: currentSha,
    });

    const result = await runPrePrReadiness(readinessInput(harness));
    expect(result.result).toBe('FAIL');
    expect(result.reason).toContain('no red-capable evidence with a valid before/after reproducer');
  });

  it('fails closed on unresolved safety evidence and missing bug red proof', async () => {
    harness = await createHarness([VALID_REVIEW_REPORT, VALID_REVIEW_REPORT]);
    await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });
    const repairRunId = insertRepairRun(harness, 'SUCCEEDED');
    recordVerificationEvidence(harness, {
      attempt: 1,
      repairRunId,
      candidateSha: 'c'.repeat(40),
      blockers: [{
        source: 'verification',
        command: 'pnpm test',
        expected: 'command exits with status 0',
        actual: 'exit code 1',
      }],
    });
    const missingRed = await runPrePrReadiness(readinessInput(harness));
    expect(missingRed.result).toBe('FAIL');
    expect(missingRed.reason).toContain('no red-capable evidence');

    const safetyRunId = insertRepairRun(harness, 'NEEDS_HUMAN');
    recordVerificationEvidence(harness, {
      attempt: 2,
      repairRunId: safetyRunId,
      candidateSha: git(harness.workspacePath, 'rev-parse', 'HEAD'),
      outcome: 'NEEDS_HUMAN',
      reason: 'safety limit exhausted',
    });
    const safetyFailure = await runPrePrReadiness(readinessInput(harness));
    expect(safetyFailure.result).toBe('FAIL');
    expect(safetyFailure.reason).toContain('Unresolved KAR-10 NEEDS_HUMAN safety evidence');
  });

  it('does not let repair or safety evidence for another SHA block the current candidate', async () => {
    harness = await createHarness([VALID_REVIEW_REPORT, VALID_REVIEW_REPORT]);
    await runPrePrReviews({
      ticketId: 'REV-001',
      modelService: harness.modelService,
      workspace: { db: harness.db, projectDir: harness.projectDir, worktreeRoot: harness.worktreeRoot },
      routing: routing(),
    });
    recordVerificationEvidence(harness);
    const historicalRunId = insertRepairRun(harness, 'NEEDS_HUMAN');
    recordVerificationEvidence(harness, {
      attempt: 1,
      repairRunId: historicalRunId,
      candidateSha: 'a'.repeat(40),
      resultingSha: 'b'.repeat(40),
      outcome: 'NEEDS_HUMAN',
      reason: 'historical safety escalation',
    });

    expect((await runPrePrReadiness(readinessInput(harness))).result).toBe('PASS');
  });
});
