import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { initProject } from '../../src/cli/init.js';
import { syncBacklogProject } from '../../src/cli/backlog.js';
import type { ShipgraphConfig } from '../../src/config/schema.js';
import { EventType } from '../../src/events/event.js';
import type { ExecuteTicketInput, ExecuteTicketResult } from '../../src/execution/ticket.js';
import { openAndMigrate, type DbConnection } from '../../src/persistence/db.js';
import {
  createEventRepository,
  createProjectRepository,
  createRunRepository,
  createWorkspaceRepository,
} from '../../src/persistence/repositories.js';
import {
  createLinearDispatchService,
  type LinearDispatchService,
} from '../../src/dispatch/service.js';
import { createLinearDispatchServer } from '../../src/dispatch/server.js';
import type { LinearDispatchIssue } from '../../src/dispatch/linear.js';
import type { WorkspaceServiceOptions } from '../../src/workspace/service.js';

const secret = 'dispatch-integration-secret';
const timestamp = 1_700_000_000_000;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

type Harness = {
  projectDir: string;
  db: DbConnection;
  workspace: WorkspaceServiceOptions;
  issues: Map<string, LinearDispatchIssue>;
};

const harnesses: Harness[] = [];

function createHarness(ticketIds = ['DP-1'], maxConcurrentTickets = 1): Harness {
  const projectDir = mkdtempSync(join(tmpdir(), 'shipgraph-dispatch-src-'));
  git(projectDir, 'init', '-b', 'main');
  git(projectDir, 'config', 'user.email', 'shipgraph-dispatch@example.com');
  git(projectDir, 'config', 'user.name', 'ShipGraph Dispatch Test');
  writeFileSync(join(projectDir, 'README.md'), '# dispatch\n');
  git(projectDir, 'add', '.');
  git(projectDir, 'commit', '-m', 'initial');

  const config: ShipgraphConfig = {
    version: 1,
    project: { name: 'dispatch-test', repository: 'owner/dispatch-test', defaultBranch: 'main' },
    execution: { maxConcurrentTickets, maxRepairIterations: 1 },
    release: { requireHumanApproval: true, requireCleanCI: true, requireExactShaReviews: true },
    agents: { implementer: 'opencode', reviewers: ['correctness'] },
    dispatch: {
      enabled: true,
      linearProjectId: 'linear-project',
      queueLabel: 'shipgraph:queued',
      webhookPath: '/webhooks/linear',
      listenHost: '127.0.0.1',
      listenPort: 8080,
    },
  };
  initProject(projectDir, { config });
  writeFileSync(join(projectDir, 'shipgraph.backlog.yml'), stringify({
    version: 1,
    tickets: ticketIds.map((id) => ({
      id,
      title: `Dispatch ${id}`,
      description: 'Dispatch integration test ticket.',
      priority: 'high',
      dependsOn: [],
      scope: { allowedPaths: ['README.md'], forbiddenPaths: [] },
      acceptanceCriteria: [{ id: 'AC-1', description: 'Dispatch safely.' }],
      verification: { commands: ['true'] },
      risk: 'low',
      agent: {},
      release: {},
    })),
  }));
  syncBacklogProject(projectDir);
  const db = openAndMigrate(join(projectDir, '.shipgraph', 'shipgraph.db'));
  const workspace: WorkspaceServiceOptions = { db, projectDir };
  const issues = new Map(ticketIds.map((id, index) => [
    `linear-issue-${index + 1}`,
    {
      id: `linear-issue-${index + 1}`,
      identifier: id,
      projectId: 'linear-project',
      labels: ['shipgraph:queued'],
    },
  ] as const));
  const harness = { projectDir, db, workspace, issues };
  harnesses.push(harness);
  return harness;
}

function webhook(issueId: string, deliveryId: string): { body: Buffer; headers: Record<string, string> } {
  const body = Buffer.from(JSON.stringify({
    type: 'Issue',
    action: 'update',
    data: { id: issueId },
    webhookTimestamp: timestamp,
  }));
  return {
    body,
    headers: {
      'Linear-Signature': createHmac('sha256', secret).update(body).digest('hex'),
      'Linear-Delivery': deliveryId,
      'Linear-Event': 'Issue',
    },
  };
}

function fakeInput(workspace: WorkspaceServiceOptions, issueId: string): ExecuteTicketInput {
  return { issueId, workspace } as unknown as ExecuteTicketInput;
}

function fakeResult(): ExecuteTicketResult {
  return { outcome: 'NEEDS_HUMAN', evidence: {} as ExecuteTicketResult['evidence'] };
}

function serviceFor(
  harness: Harness,
  execute: (input: ExecuteTicketInput) => Promise<ExecuteTicketResult> = async () => fakeResult(),
  resolveAuthorizedExecution: (
    issue: LinearDispatchIssue
  ) => ExecuteTicketInput | undefined = (issue) => fakeInput(harness.workspace, issue.identifier)
): LinearDispatchService {
  return createLinearDispatchService({
    workspace: harness.workspace,
    client: { getIssue: async (id) => harness.issues.get(id) },
    resolveAuthorizedExecution,
    execute,
    webhookSecret: secret,
    nowMs: () => timestamp,
  });
}

function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.db.close();
    rmSync(harness.projectDir, { recursive: true, force: true });
  }
});

describe('Linear dispatch claim bridge', () => {
  it('refetches the live queued issue and claims exactly once for duplicate delivery', async () => {
    const harness = createHarness();
    let calls = 0;
    const executionIds: Array<string | undefined> = [];
    const service = serviceFor(harness, async (input) => {
      calls += 1;
      executionIds.push(input.createExecutionId?.());
      return fakeResult();
    });
    const request = webhook('linear-issue-1', '11111111-1111-4111-8111-111111111111');
    const first = await service.handleWebhook(request.body, request.headers);
    const second = await service.handleWebhook(request.body, request.headers);
    expect(first.outcome).toBe('CLAIMED');
    expect(second.outcome).toBe('ALREADY_CLAIMED');
    expect(calls).toBe(0);
    await flushImmediate();
    expect(calls).toBe(1);
    const claim = createEventRepository(harness.db).findByProjectId(
      createProjectRepository(harness.db).findAll()[0].id
    ).find((event) => event.type === EventType.DISPATCH_CLAIMED);
    if (claim?.type !== EventType.DISPATCH_CLAIMED) throw new Error('dispatch claim evidence missing');
    expect(executionIds).toEqual([claim.payload.executionId]);
    expect(createEventRepository(harness.db).findByProjectId(
      createProjectRepository(harness.db).findAll()[0].id
    ).filter((event) => event.type === EventType.DISPATCH_CLAIMED)).toHaveLength(1);
  });

  it('does not trust stale webhook queue state or unrelated live project data', async () => {
    const harness = createHarness();
    const issue = harness.issues.get('linear-issue-1');
    if (!issue) throw new Error('test issue missing');
    harness.issues.set(issue.id, { ...issue, labels: [] });
    const service = serviceFor(harness);
    const result = await service.handleWebhook(
      webhook(issue.id, '22222222-2222-4222-8222-222222222222').body,
      webhook(issue.id, '22222222-2222-4222-8222-222222222222').headers
    );
    expect(result).toMatchObject({ outcome: 'IGNORED' });
    expect(createEventRepository(harness.db).findByProjectId(
      createProjectRepository(harness.db).findAll()[0].id
    ).some((event) => event.type === EventType.DISPATCH_CLAIMED)).toBe(false);
  });

  it('ignores an authenticated issue outside the configured Linear project', async () => {
    const harness = createHarness();
    const issue = harness.issues.get('linear-issue-1');
    if (!issue) throw new Error('test issue missing');
    harness.issues.set(issue.id, { ...issue, projectId: 'other-project' });
    const result = await serviceFor(harness).handleWebhook(
      webhook(issue.id, '12121212-1212-4121-8121-121212121212').body,
      webhook(issue.id, '12121212-1212-4121-8121-121212121212').headers
    );
    expect(result.outcome).toBe('IGNORED');
  });

  it('ignores an issue without an exact local ticket identifier', async () => {
    const harness = createHarness();
    const issue = harness.issues.get('linear-issue-1');
    if (!issue) throw new Error('test issue missing');
    harness.issues.set(issue.id, { ...issue, identifier: 'DP-404' });
    const result = await serviceFor(harness).handleWebhook(
      webhook(issue.id, '13131313-1313-4131-8131-131313131313').body,
      webhook(issue.id, '13131313-1313-4131-8131-131313131313').headers
    );
    expect(result.outcome).toBe('IGNORED');
  });

  it('does not claim when the trusted EXEC-001 input is unavailable', async () => {
    const harness = createHarness();
    const result = await serviceFor(harness, async () => fakeResult(), () => undefined).handleWebhook(
      webhook('linear-issue-1', '14141414-1414-4141-8141-141414141414').body,
      webhook('linear-issue-1', '14141414-1414-4141-8141-141414141414').headers
    );
    expect(result.outcome).toBe('IGNORED');
    expect(createEventRepository(harness.db).findByProjectId(
      createProjectRepository(harness.db).findAll()[0].id
    ).some((event) => event.type === EventType.DISPATCH_CLAIMED)).toBe(false);
  });

  it('does not claim while an active provider run already owns the ticket', async () => {
    const harness = createHarness();
    const projectId = createProjectRepository(harness.db).findAll()[0].id;
    const now = new Date().toISOString();
    createWorkspaceRepository(harness.db).insert({
      id: 'workspace-active',
      projectId,
      ticketId: 'DP-1',
      sourceRepositoryPath: harness.projectDir,
      worktreePath: harness.projectDir,
      branchName: 'main',
      baseSha: 'a'.repeat(40),
      status: 'READY',
      createdAt: now,
      updatedAt: now,
    });
    createRunRepository(harness.db).create({
      id: 'active-provider-run',
      ticketId: 'DP-1',
      projectId,
      workspaceId: 'workspace-active',
      workspacePath: harness.projectDir,
      baseSha: 'a'.repeat(40),
      branchName: 'main',
      status: 'RUNNING',
      provider: 'test',
      model: 'test-model',
      instructionsSha256: 'a'.repeat(64),
      timeoutMs: 1_000,
      startedAt: now,
    });
    const result = await serviceFor(harness).handleWebhook(
      webhook('linear-issue-1', '15151515-1515-4151-8151-151515151515').body,
      webhook('linear-issue-1', '15151515-1515-4151-8151-151515151515').headers
    );
    expect(result.outcome).toBe('IGNORED');
    expect(createEventRepository(harness.db).findByProjectId(projectId)
      .some((event) => event.type === EventType.DISPATCH_CLAIMED)).toBe(false);
  });

  it('serializes concurrent deliveries and does not exceed local capacity', async () => {
    const harness = createHarness(['DP-1', 'DP-2']);
    let calls = 0;
    const service = serviceFor(harness, async () => {
      calls += 1;
      return fakeResult();
    });
    const one = webhook('linear-issue-1', '33333333-3333-4333-8333-333333333333');
    const two = webhook('linear-issue-2', '44444444-4444-4444-8444-444444444444');
    const results = await Promise.all([
      service.handleWebhook(one.body, one.headers),
      service.handleWebhook(one.body, {
        ...one.headers,
        'Linear-Delivery': '55555555-5555-4555-8555-555555555555',
      }),
      service.handleWebhook(two.body, two.headers),
    ]);
    expect(results.filter((result) => result.outcome === 'CLAIMED')).toHaveLength(1);
    expect(results.filter((result) => result.outcome === 'NO_CAPACITY')).toHaveLength(1);
    await flushImmediate();
    expect(calls).toBe(1);
  });

  it('recovers a durable incomplete claim after a failed handoff', async () => {
    const harness = createHarness();
    let allowExecution = false;
    let calls = 0;
    const service = serviceFor(harness, async () => {
      calls += 1;
      if (!allowExecution) throw new Error('simulated process interruption');
      return fakeResult();
    });
    const request = webhook('linear-issue-1', '66666666-6666-4666-8666-666666666666');
    expect((await service.handleWebhook(request.body, request.headers)).outcome).toBe('CLAIMED');
    await flushImmediate();
    allowExecution = true;
    expect(await service.recoverIncompleteClaims()).toBe(1);
    await flushImmediate();
    expect(calls).toBe(2);
  });

  it('reconciles an unfinished claim from durable EXEC-001 terminal evidence', async () => {
    const harness = createHarness();
    const service = serviceFor(harness, async () => {
      throw new Error('simulated handoff interruption');
    });
    const request = webhook('linear-issue-1', '88888888-8888-4888-8888-888888888888');
    expect((await service.handleWebhook(request.body, request.headers)).outcome).toBe('CLAIMED');
    await flushImmediate();
    const projectId = createProjectRepository(harness.db).findAll()[0].id;
    const claim = createEventRepository(harness.db).findByProjectId(projectId)
      .find((event): event is Extract<typeof event, { type: typeof EventType.DISPATCH_CLAIMED }> =>
        event.type === EventType.DISPATCH_CLAIMED);
    if (claim === undefined) throw new Error('dispatch claim evidence missing');
    createEventRepository(harness.db).append({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      projectId,
      ticketId: 'DP-1',
      type: EventType.EXECUTION_TERMINAL,
      payload: {
        executionId: claim.payload.executionId,
        ticketId: 'DP-1',
        outcome: 'NEEDS_HUMAN',
        contractDigest: 'a'.repeat(64),
        contractSource: 'test',
        contractRevision: '1',
        reason: 'terminal handoff recorded',
        recordedAt: new Date().toISOString(),
      },
    });
    expect(await service.recoverIncompleteClaims()).toBe(0);
    expect(createEventRepository(harness.db).findByProjectId(projectId)
      .filter((event) => event.type === EventType.DISPATCH_COMPLETED)).toHaveLength(1);
  });

  it('does not relaunch a claim when its delivery is repeated after completion', async () => {
    const harness = createHarness();
    let calls = 0;
    const service = serviceFor(harness, async () => {
      calls += 1;
      return fakeResult();
    });
    const request = webhook('linear-issue-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect((await service.handleWebhook(request.body, request.headers)).outcome).toBe('CLAIMED');
    await flushImmediate();
    expect(calls).toBe(1);
    expect((await service.handleWebhook(request.body, request.headers)).outcome).toBe('IGNORED');
    await flushImmediate();
    expect(calls).toBe(1);
  });

  it('does not reconcile a terminal event belonging to another execution', async () => {
    const harness = createHarness();
    let allowExecution = false;
    const service = serviceFor(harness, async () => {
      if (!allowExecution) throw new Error('simulated handoff interruption');
      return fakeResult();
    });
    const request = webhook('linear-issue-1', '99999999-9999-4999-8999-999999999999');
    expect((await service.handleWebhook(request.body, request.headers)).outcome).toBe('CLAIMED');
    await flushImmediate();
    const projectId = createProjectRepository(harness.db).findAll()[0].id;
    createEventRepository(harness.db).append({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      projectId,
      ticketId: 'DP-1',
      type: EventType.EXECUTION_TERMINAL,
      payload: {
        executionId: 'unrelated-execution',
        ticketId: 'DP-1',
        outcome: 'NEEDS_HUMAN',
        contractDigest: 'a'.repeat(64),
        contractSource: 'test',
        contractRevision: '1',
        reason: 'unrelated terminal evidence',
        recordedAt: new Date().toISOString(),
      },
    });
    allowExecution = true;
    expect(await service.recoverIncompleteClaims()).toBe(1);
    await flushImmediate();
  });

  it('exposes only the configured POST webhook and acknowledges before execution work', async () => {
    const harness = createHarness();
    let calls = 0;
    const { server } = createLinearDispatchServer({
      workspace: harness.workspace,
      client: { getIssue: async (id) => harness.issues.get(id) },
      resolveAuthorizedExecution: (issue) => fakeInput(harness.workspace, issue.identifier),
      execute: async () => {
        calls += 1;
        return fakeResult();
      },
      webhookSecret: secret,
      nowMs: () => timestamp,
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('test server did not bind');
    const signed = webhook('linear-issue-1', '77777777-7777-4777-8777-777777777777');
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const clientRequest = request({
        host: '127.0.0.1',
        port: address.port,
        path: '/webhooks/linear',
        method: 'POST',
        headers: { ...signed.headers, 'content-length': signed.body.byteLength },
      }, (clientResponse) => {
        const chunks: Buffer[] = [];
        clientResponse.on('data', (chunk: Buffer) => chunks.push(chunk));
        clientResponse.on('end', () => resolve({
          status: clientResponse.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      clientRequest.on('error', reject);
      clientRequest.end(signed.body);
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ outcome: 'CLAIMED' });
    await flushImmediate();
    expect(calls).toBe(1);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
});
