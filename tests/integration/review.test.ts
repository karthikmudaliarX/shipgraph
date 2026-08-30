import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
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
import { createTicketRepository } from '../../src/persistence/repositories.js';
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
          stdout: JSON.stringify({ type: 'text', text: VALID_REVIEW_REPORT }),
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
});
