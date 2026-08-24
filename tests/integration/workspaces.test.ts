import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { initProject } from '../../src/cli/init.js';
import { syncBacklogProject } from '../../src/cli/backlog.js';
import {
  createWorkspace,
  inspectWorkspace,
  listWorkspacesForProject,
  removeWorkspace,
} from '../../src/workspace/service.js';
import type { WorkspaceServiceOptions } from '../../src/workspace/service.js';
import { openAndMigrate } from '../../src/persistence/db.js';
import {
  createEventRepository,
  createProjectRepository,
  createTicketRepository,
  createWorkspaceRepository,
} from '../../src/persistence/repositories.js';
import { calculateReady } from '../../src/scheduler/ready.js';
import type { DbConnection } from '../../src/persistence/db.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function gitRaw(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

const BASE_CONFIG = (max: number) => ({
  version: 1 as const,
  project: { name: 'work-001', repository: 'owner/work-001', defaultBranch: 'main' },
  execution: { maxConcurrentTickets: max, maxRepairIterations: 6 },
  release: { requireHumanApproval: true, requireCleanCI: true, requireExactShaReviews: true },
  agents: { implementer: 'opencode', reviewers: ['correctness'] },
});

function ticket(id: string, dependsOn: string[] = []) {
  return {
    id,
    title: `Ticket ${id}`,
    description: `Work for ${id}`,
    priority: 'high',
    dependsOn,
    scope: { allowedPaths: ['src/**'], forbiddenPaths: [] },
    acceptanceCriteria: [],
    verification: { commands: ['pnpm test'] },
    risk: 'medium',
    agent: {},
    release: {},
  };
}

type Harness = {
  projectDir: string;
  worktreeRoot: string;
  dbPath: string;
  baseSha: string;
  options: WorkspaceServiceOptions;
};

function setupProject(maxConcurrent: number, tickets: ReturnType<typeof ticket>[]): Harness {
  const projectDir = mkdtempSync(join(tmpdir(), 'sg-work-src-'));
  git(projectDir, 'init', '-b', 'main');
  git(projectDir, 'config', 'user.email', 'shipgraph-test@example.com');
  git(projectDir, 'config', 'user.name', 'ShipGraph Test');
  writeFileSync(join(projectDir, 'README.md'), '# source\n');
  git(projectDir, 'add', '.');
  git(projectDir, 'commit', '-m', 'initial');
  const baseSha = git(projectDir, 'rev-parse', 'HEAD');

  initProject(projectDir, { config: BASE_CONFIG(maxConcurrent) });
  writeFileSync(join(projectDir, 'shipgraph.backlog.yml'), stringify({ version: 1, tickets }));
  syncBacklogProject(projectDir);

  const worktreeRoot = mkdtempSync(join(tmpdir(), 'sg-work-root-'));
  const dbPath = join(projectDir, '.shipgraph', 'shipgraph.db');
  // Keep concurrent-creation polling fast under test.
  process.env.SHIPGRAPH_CREATION_POLL_TIMEOUT_MS = '500';
  return {
    projectDir,
    worktreeRoot,
    dbPath,
    baseSha,
    options: { db: openAndMigrate(dbPath), projectDir, worktreeRoot },
  };
}

function cleanup(harness: Harness | undefined): void {
  if (!harness) return;
  harness.options.db.close();
  rmSync(harness.projectDir, { recursive: true, force: true });
  rmSync(harness.worktreeRoot, { recursive: true, force: true });
  process.exitCode = undefined;
}

describe('WORK-001 isolated worktree lifecycle', () => {
  let harness: Harness | undefined;

  afterEach(() => {
    cleanup(harness);
    harness = undefined;
  });

  it('creates an isolated workspace for a dispatchable eligible ticket', async () => {
    harness = setupProject(2, [ticket('TA-1'), ticket('TB-1', ['TA-1'])]);
    const result = await createWorkspace(harness.options, 'TA-1');

    expect(result.created).toBe(true);
    expect(result.ticketState).toBe('PLANNING');
    expect(result.workspace.status).toBe('READY');
    expect(result.workspace.branchName).toBe('shipgraph/ta-1');
    expect(result.workspace.baseSha).toBe(harness.baseSha);
    expect(result.workspace.worktreePath).toBe(
      join(harness.worktreeRoot, result.workspace.projectId, 'TA-1')
    );

    // Live invariants
    expect(existsSync(join(result.workspace.worktreePath, 'README.md'))).toBe(true);
    expect(git(result.workspace.worktreePath, 'rev-parse', 'HEAD')).toBe(harness.baseSha);
    expect(git(result.workspace.worktreePath, 'symbolic-ref', '--short', 'HEAD')).toBe(
      'shipgraph/ta-1'
    );
    expect(git(result.workspace.worktreePath, 'status', '--porcelain')).toBe('');
    expect(git(harness.projectDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');

    // Ticket transitioned through the state machine with audit events
    const db = harness.options.db;
    expect(createTicketRepository(db).findById('TA-1')?.status).toBe('PLANNING');
    const eventTypes = createEventRepository(db)
      .findByTicketId('TA-1')
      .map((event) => event.type);
    expect(eventTypes).toContain('workspace.creating');
    expect(eventTypes).toContain('workspace.ready');
    const stateChange = createEventRepository(db)
      .findByTicketId('TA-1')
      .find(
        (event) =>
          event.type === 'ticket.state_changed' &&
          (event.payload as { next?: string }).next === 'PLANNING'
      );
    expect(stateChange?.payload).toMatchObject({
      previous: 'ELIGIBLE',
      next: 'PLANNING',
      ticketId: 'TA-1',
    });
  });

  it('records the exact resolved commit of the local default branch', async () => {
    harness = setupProject(2, [ticket('TA-1')]);
    const result = await createWorkspace(harness.options, 'TA-1');
    expect(result.workspace.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.workspace.baseSha).not.toBe('main');
    expect(result.workspace.baseSha).toBe(harness.baseSha);
  });

  it('leaves an unrelated dirty normal checkout completely untouched', async () => {
    harness = setupProject(2, [ticket('TA-1')]);
    const modified = join(harness.projectDir, 'README.md');
    writeFileSync(modified, '# locally edited\n');
    const untracked = join(harness.projectDir, 'notes.txt');
    writeFileSync(untracked, 'user notes\n');

    await createWorkspace(harness.options, 'TA-1');

    expect(readFileSync(modified, 'utf8')).toBe('# locally edited\n');
    expect(readFileSync(untracked, 'utf8')).toBe('user notes\n');
    const status = gitRaw(harness.projectDir, 'status', '--porcelain');
    expect(status).toMatch(/^ M README\.md$/m);
    expect(status).toContain('?? notes.txt');
  });

  it('returns the same healthy READY workspace idempotently', async () => {
    harness = setupProject(2, [ticket('TA-1')]);
    const first = await createWorkspace(harness.options, 'TA-1');
    const second = await createWorkspace(harness.options, 'TA-1');
    expect(second.created).toBe(false);
    expect(second.recovered).toBe(false);
    expect(second.workspace.id).toBe(first.workspace.id);
    expect(second.ticketState).toBe('PLANNING');
  });

  it('recovers a CREATING reservation after a crash once git state proves it', async () => {
    harness = setupProject(2, [ticket('TA-1')]);
    // Simulate a crash right after the persistent reservation.
    await expect(
      createWorkspace(harness.options, 'TA-1', { crashAfterReserve: true })
    ).rejects.toThrow(/Simulated crash/);

    // Simulate that git worktree add had already succeeded before the crash.
    const repo = createWorkspaceRepository(harness.options.db);
    const row = repo.findActiveByTicket(findProjectId(harness.options.db), 'TA-1');
    expect(row?.status).toBe('CREATING');
    if (!row) throw new Error('reservation missing');
    git(harness.projectDir, 'worktree', 'add', '-b', row.branchName, row.worktreePath, row.baseSha);

    const recovered = await createWorkspace(harness.options, 'TA-1');
    expect(recovered.created).toBe(false);
    expect(recovered.recovered).toBe(true);
    expect(recovered.workspace.id).toBe(row.id);
    expect(recovered.workspace.status).toBe('READY');
    expect(recovered.ticketState).toBe('PLANNING');
    expect(findTicketState(harness.options, 'TA-1')).toBe('PLANNING');
  });

  it('fails closed into NEEDS_HUMAN when a stale CREATING reservation mismatches reality', async () => {
    harness = setupProject(2, [ticket('TA-1')]);
    await expect(
      createWorkspace(harness.options, 'TA-1', { crashAfterReserve: true })
    ).rejects.toThrow(/Simulated crash/);

    // The crash happened before any git work; the recorded path does not exist
    // and cannot be proven to belong to ShipGraph.
    await expect(createWorkspace(harness.options, 'TA-1')).rejects.toThrow(
      /requires human inspection/
    );
    const row = createWorkspaceRepository(harness.options.db).findActiveByTicket(
      findProjectId(harness.options.db),
      'TA-1'
    );
    expect(row?.status).toBe('NEEDS_HUMAN');
    // Ambiguous state was NOT deleted automatically (there is nothing to delete).
    const failedEvents = createEventRepository(harness.options.db)
      .findByTicketId('TA-1')
      .filter((event) => event.type === 'workspace.failed');
    expect(failedEvents.length).toBe(1);
  });

  it('refuses to reuse a pre-existing unowned branch and leaves it intact', async () => {
    harness = setupProject(2, [ticket('TA-1')]);
    git(harness.projectDir, 'branch', 'shipgraph/ta-1', harness.baseSha);

    await expect(createWorkspace(harness.options, 'TA-1')).rejects.toThrow(
      /already exists and is not claimed/
    );
    expect(git(harness.projectDir, 'rev-parse', 'shipgraph/ta-1')).toBe(harness.baseSha);
    const rows = createWorkspaceRepository(harness.options.db).listByProject(
      findProjectId(harness.options.db)
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses a conflicting pre-existing directory at the workspace path', async () => {
    harness = setupProject(2, [ticket('TA-1')]);
    const projectId = findProjectId(harness.options.db);
    const conflict = join(harness.worktreeRoot, projectId, 'TA-1');
    mkdirSync(conflict, { recursive: true });
    writeFileSync(join(conflict, 'precious.txt'), 'user data\n');

    await expect(createWorkspace(harness.options, 'TA-1')).rejects.toThrow(
      /Conflicting pre-existing path/
    );
    expect(readFileSync(join(conflict, 'precious.txt'), 'utf8')).toBe('user data\n');
  });

  it('refuses malicious ticket ids that could control filesystem traversal', async () => {
    harness = setupProject(2, [ticket('TA-1')]);
    await expect(createWorkspace(harness.options, '../evil')).rejects.toThrow(/Invalid ticket id/);
    await expect(createWorkspace(harness.options, 'a/b')).rejects.toThrow(/Invalid ticket id/);
    await expect(inspectWorkspace(harness.options, '../../etc')).rejects.toThrow(
      /Invalid ticket id/
    );
  });

  it('refuses a symlinked project segment inside the worktree root', async () => {
    harness = setupProject(2, [ticket('TA-1')]);
    const projectId = findProjectId(harness.options.db);
    const outside = mkdtempSync(join(tmpdir(), 'sg-work-outside-'));
    const segment = join(harness.worktreeRoot, projectId);
    rmSync(segment, { force: true });
    symlinkSync(outside, segment);

    await expect(createWorkspace(harness.options, 'TA-1')).rejects.toThrow(/symbolic link/);
    rmSync(outside, { recursive: true, force: true });
  });

  it('converges concurrent creates onto exactly one workspace', async () => {
    harness = setupProject(2, [ticket('TA-1')]);
    process.env.SHIPGRAPH_CREATION_POLL_TIMEOUT_MS = '10000';
    try {
      const [first, second] = await Promise.all([
        createWorkspace(harness.options, 'TA-1'),
        createWorkspace(harness.options, 'TA-1'),
      ]);

      const createdCount = [first, second].filter((result) => result.created).length;
      expect(createdCount).toBe(1);
      expect(first.workspace.id).toBe(second.workspace.id);
      expect(first.workspace.worktreePath).toBe(second.workspace.worktreePath);
      expect(first.ticketState).toBe('PLANNING');
      expect(second.ticketState).toBe('PLANNING');

      const projectId = findProjectId(harness.options.db);
      const rows = createWorkspaceRepository(harness.options.db).listByProject(projectId);
      expect(rows).toHaveLength(1);
      expect(git(harness.projectDir, 'branch', '--list', 'shipgraph/ta-1').split('\n')).toHaveLength(1);
      const planningEvents = createEventRepository(harness.options.db)
        .findByTicketId('TA-1')
        .filter(
          (event) =>
            event.type === 'ticket.state_changed' &&
            (event.payload as { next?: string }).next === 'PLANNING'
        );
      expect(planningEvents).toHaveLength(1);
    } finally {
      delete process.env.SHIPGRAPH_CREATION_POLL_TIMEOUT_MS;
    }
  });

  it('never exceeds capacity under concurrent creation of different tickets', async () => {
    harness = setupProject(1, [ticket('CAP-1'), ticket('CAP-2')]);
    process.env.SHIPGRAPH_CREATION_POLL_TIMEOUT_MS = '500';
    try {
      const results = await Promise.allSettled([
        createWorkspace(harness.options, 'CAP-1'),
        createWorkspace(harness.options, 'CAP-2'),
      ]);
      const fulfilled = results.filter(
        (result) => result.status === 'fulfilled'
      ) as PromiseFulfilledResult<Awaited<ReturnType<typeof createWorkspace>>>[];
      // At most one ticket may claim the single capacity slot; the loser
      // either fails closed or is refused by the in-transaction capacity
      // claim — never two PLANNING/CREATING tickets.
      expect(fulfilled.length).toBeLessThanOrEqual(1);

      const tickets = createTicketRepository(harness.options.db).findApprovedByProjectId(
        findProjectId(harness.options.db)
      );
      const planningCount = tickets.filter((ticket) => ticket.status === 'PLANNING').length;
      expect(planningCount).toBeLessThanOrEqual(1);

      const ready = calculateReady(tickets, 1);
      expect(ready.capacity.active).toBeLessThanOrEqual(1);
    } finally {
      delete process.env.SHIPGRAPH_CREATION_POLL_TIMEOUT_MS;
    }
  });

  it('counts un-transitioned CREATING reservations against capacity', async () => {
    harness = setupProject(1, [ticket('CAP-1'), ticket('CAP-2')]);
    // CAP-1's reservation stays CREATING (crash before finalize), so its
    // ticket is still ELIGIBLE — the claimed slot must still count.
    await expect(
      createWorkspace(harness.options, 'CAP-1', { crashAfterReserve: true })
    ).rejects.toThrow(/Simulated crash/);

    await expect(createWorkspace(harness.options, 'CAP-2')).rejects.toThrow(
      /Dispatch capacity is full/
    );
    const projectId = findProjectId(harness.options.db);
    expect(
      createWorkspaceRepository(harness.options.db).findActiveByTicket(projectId, 'CAP-2')
    ).toBeUndefined();
    expect(existsSync(join(harness.worktreeRoot, projectId, 'CAP-2'))).toBe(false);
  });

  it('fails closed on capacity without creating any resources', async () => {
    harness = setupProject(1, [ticket('CAP-1'), ticket('CAP-2')]);
    await createWorkspace(harness.options, 'CAP-1');

    // PLANNING consumes capacity under the existing CORE-002 model.
    const tickets = createTicketRepository(harness.options.db).findApprovedByProjectId(
      findProjectId(harness.options.db)
    );
    const ready = calculateReady(tickets, 1);
    expect(ready.capacity.active).toBe(1);
    expect(ready.dispatchable).toHaveLength(0);

    await expect(createWorkspace(harness.options, 'CAP-2')).rejects.toThrow(
      /Dispatch capacity is full/
    );
    const projectId = findProjectId(harness.options.db);
    expect(
      createWorkspaceRepository(harness.options.db).findActiveByTicket(projectId, 'CAP-2')
    ).toBeUndefined();
    expect(existsSync(join(harness.worktreeRoot, projectId, 'CAP-2'))).toBe(false);
    expect(git(harness.projectDir, 'branch', '--list', 'shipgraph/cap-2')).toBe('');
  });

  it('refuses non-ELIGIBLE tickets and tickets outside the approved backlog', async () => {
    harness = setupProject(2, [ticket('TA-1'), ticket('TB-1', ['TA-1'])]);
    // TB-1 is QUEUED because its dependency is not COMPLETE.
    await expect(createWorkspace(harness.options, 'TB-1')).rejects.toThrow(
      /can only be created for ELIGIBLE tickets/
    );
    await expect(createWorkspace(harness.options, 'GHOST-1')).rejects.toThrow(
      /does not belong to the approved backlog/
    );
  });

  it('reports DRIFTED health for tampered branch state without repairing anything', async () => {
    harness = setupProject(2, [ticket('TA-1')]);
    const created = await createWorkspace(harness.options, 'TA-1');
    const wsPath = created.workspace.worktreePath;

    writeFileSync(join(wsPath, 'committed.txt'), 'agent work\n');
    git(wsPath, 'add', '.');
    git(wsPath, 'commit', '-m', 'wip');

    const report = await inspectWorkspace(harness.options, 'TA-1');
    expect(report.health).toBe('DRIFTED');
    expect(report.live.clean).toBe(true);
    expect(report.live.headSha).not.toBe(created.workspace.baseSha);

    await expect(createWorkspace(harness.options, 'TA-1')).rejects.toThrow(/not healthy/);
    expect(git(wsPath, 'rev-parse', 'HEAD')).not.toBe(created.workspace.baseSha);
  });

  it('reports DRIFTED for a detached HEAD and MISSING after external removal', async () => {
    harness = setupProject(2, [ticket('TA-1')]);
    const created = await createWorkspace(harness.options, 'TA-1');
    const wsPath = created.workspace.worktreePath;

    git(wsPath, 'checkout', '--detach', harness.baseSha);
    expect((await inspectWorkspace(harness.options, 'TA-1')).health).toBe('DRIFTED');
    git(wsPath, 'switch', 'shipgraph/ta-1');

    git(harness.projectDir, 'worktree', 'remove', wsPath);
    const missing = await inspectWorkspace(harness.options, 'TA-1');
    expect(missing.health).toBe('MISSING');
    expect(missing.live.exists).toBe(false);
  });

  it('removes a clean workspace, deletes the provably empty branch, and marks REMOVED', async () => {
    harness = setupProject(2, [ticket('TA-1')]);
    const created = await createWorkspace(harness.options, 'TA-1');

    const removed = await removeWorkspace(harness.options, 'TA-1');
    expect(removed.removed).toBe(true);
    expect(removed.branchRetained).toBe(false);
    expect(existsSync(created.workspace.worktreePath)).toBe(false);
    expect(git(harness.projectDir, 'branch', '--list', 'shipgraph/ta-1')).toBe('');

    const row = createWorkspaceRepository(harness.options.db).findByTicket(
      findProjectId(harness.options.db),
      'TA-1'
    )[0];
    expect(row?.status).toBe('REMOVED');
    const eventTypes = createEventRepository(harness.options.db)
      .findByTicketId('TA-1')
      .map((event) => event.type);
    expect(eventTypes).toContain('workspace.removed');

    // Ticket stays PLANNING; removal does not roll back the state machine here.
    expect(findTicketState(harness.options, 'TA-1')).toBe('PLANNING');
  });

  it('retains the branch on removal when it contains unique work', async () => {
    harness = setupProject(2, [ticket('TA-1')]);
    const created = await createWorkspace(harness.options, 'TA-1');
    const wsPath = created.workspace.worktreePath;
    writeFileSync(join(wsPath, 'work.txt'), 'real work\n');
    git(wsPath, 'add', '.');
    git(wsPath, 'commit', '-m', 'unique work');

    const removed = await removeWorkspace(harness.options, 'TA-1');
    expect(removed.branchRetained).toBe(true);
    expect(git(harness.projectDir, 'rev-parse', 'shipgraph/ta-1')).not.toBe(
      created.workspace.baseSha
    );
  });

  it('refuses removal of a dirty worktree and preserves every file', async () => {
    harness = setupProject(2, [ticket('TA-1')]);
    const created = await createWorkspace(harness.options, 'TA-1');
    writeFileSync(join(created.workspace.worktreePath, 'dirty.txt'), 'in progress\n');

    await expect(removeWorkspace(harness.options, 'TA-1')).rejects.toThrow(/dirty/);
    expect(readFileSync(join(created.workspace.worktreePath, 'dirty.txt'), 'utf8')).toBe(
      'in progress\n'
    );
  });

  it('refuses removal when the recorded branch is no longer checked out', async () => {
    harness = setupProject(2, [ticket('TA-1')]);
    const created = await createWorkspace(harness.options, 'TA-1');
    const wsPath = created.workspace.worktreePath;
    // Clean, but switched to another branch — the checkout no longer matches
    // the ShipGraph reservation.
    git(harness.projectDir, 'branch', 'observer/main', harness.baseSha);
    git(wsPath, 'switch', 'observer/main');

    await expect(removeWorkspace(harness.options, 'TA-1')).rejects.toThrow(
      /recorded branch/
    );
    expect(existsSync(wsPath)).toBe(true);
    expect(git(harness.projectDir, 'rev-parse', '--verify', 'shipgraph/ta-1')).toBe(
      created.workspace.baseSha
    );
  });

  it('refuses removal when the worktree contains ignored or untracked files', async () => {
    harness = setupProject(2, [ticket('TA-1')]);
    const created = await createWorkspace(harness.options, 'TA-1');
    const wsPath = created.workspace.worktreePath;
    // Ignored files never show in plain `git status --porcelain`.
    writeFileSync(join(wsPath, '.gitignore'), 'secret.local\n');
    writeFileSync(join(wsPath, 'secret.local'), 'do not lose me\n');
    git(wsPath, 'add', '.gitignore');
    git(wsPath, 'commit', '-m', 'ignore secrets');

    await expect(removeWorkspace(harness.options, 'TA-1')).rejects.toThrow(
      /untracked or ignored/
    );
    expect(readFileSync(join(wsPath, 'secret.local'), 'utf8')).toBe('do not lose me\n');
  });

  it('treats a worktree whose repository binding was swapped as unregistered', async () => {
    harness = setupProject(2, [ticket('TA-1')]);
    const created = await createWorkspace(harness.options, 'TA-1');
    const wsPath = created.workspace.worktreePath;

    // Point the worktree's .git file at a completely different repository.
    const foreignRepo = mkdtempSync(join(tmpdir(), 'sg-work-foreign-'));
    git(foreignRepo, 'init', '-b', 'main');
    try {
      rmSync(join(wsPath, '.git'));
      symlinkSync(foreignRepo, join(wsPath, '.git'));

      const report = await inspectWorkspace(harness.options, 'TA-1');
      expect(report.health).toBe('DRIFTED');
      await expect(removeWorkspace(harness.options, 'TA-1')).rejects.toThrow();
    } finally {
      rmSync(foreignRepo, { recursive: true, force: true });
    }
  });

  it('refuses removal when a tracked file is marked skip-worktree', async () => {
    harness = setupProject(2, [ticket('TA-1')]);
    const created = await createWorkspace(harness.options, 'TA-1');
    const wsPath = created.workspace.worktreePath;
    writeFileSync(join(wsPath, 'hidden.txt'), 'original\n');
    git(wsPath, 'add', '.');
    git(wsPath, 'commit', '-m', 'tracked file');

    // Hide local modifications from git status via skip-worktree.
    writeFileSync(join(wsPath, 'hidden.txt'), 'secret local edit\n');
    git(wsPath, 'update-index', '--skip-worktree', 'hidden.txt');
    expect(git(wsPath, 'status', '--porcelain')).toBe('');

    await expect(removeWorkspace(harness.options, 'TA-1')).rejects.toThrow();
    expect(readFileSync(join(wsPath, 'hidden.txt'), 'utf8')).toBe('secret local edit\n');
  });

  it('refuses removal of submodule-containing worktrees', async () => {
    harness = setupProject(2, [ticket('TA-1')]);
    const created = await createWorkspace(harness.options, 'TA-1');
    writeFileSync(
      join(created.workspace.worktreePath, '.gitmodules'),
      '[submodule "x"]\n\tpath = x\n\turl = ../x.git\n'
    );
    git(created.workspace.worktreePath, 'add', '.gitmodules');
    git(created.workspace.worktreePath, 'commit', '-m', 'add submodule');

    await expect(removeWorkspace(harness.options, 'TA-1')).rejects.toThrow(
      /submodule/
    );
    expect(existsSync(created.workspace.worktreePath)).toBe(true);
  });

  it('refuses removal when the workspace is missing or ambiguous on disk', async () => {
    harness = setupProject(2, [ticket('TA-1')]);
    const created = await createWorkspace(harness.options, 'TA-1');
    git(harness.projectDir, 'worktree', 'remove', created.workspace.worktreePath);

    await expect(removeWorkspace(harness.options, 'TA-1')).rejects.toThrow(
      /missing on disk|ambiguous/
    );
  });

  it('isolates workspace records across independent projects', async () => {
    harness = setupProject(2, [ticket('TA-1')]);
    const created = await createWorkspace(harness.options, 'TA-1');
    expect(listWorkspacesForProject(harness.options).map((row) => row.id)).toEqual([
      created.workspace.id,
    ]);

    // A completely separate ShipGraph project (own repo + own database) can
    // use the same ticket id and derives the same branch name in ITS OWN
    // repository without any interference.
    const otherDir = mkdtempSync(join(tmpdir(), 'sg-work-other-'));
    git(otherDir, 'init', '-b', 'main');
    git(otherDir, 'config', 'user.email', 'shipgraph-test@example.com');
    git(otherDir, 'config', 'user.name', 'ShipGraph Test');
    writeFileSync(join(otherDir, 'README.md'), '# other\n');
    git(otherDir, 'add', '.');
    git(otherDir, 'commit', '-m', 'initial');

    initProject(otherDir, { config: BASE_CONFIG(2) });
    writeFileSync(
      join(otherDir, 'shipgraph.backlog.yml'),
      stringify({ version: 1, tickets: [ticket('TA-1')] })
    );
    syncBacklogProject(otherDir);
    const otherDbPath = join(otherDir, '.shipgraph', 'shipgraph.db');
    const otherHarness: Harness = {
      ...harness,
      projectDir: otherDir,
      dbPath: otherDbPath,
      options: {
        ...harness.options,
        projectDir: otherDir,
        db: openAndMigrate(otherDbPath),
      },
    };
    try {
      const otherResult = await createWorkspace(otherHarness.options, 'TA-1');
      expect(otherResult.created).toBe(true);
      expect(otherResult.workspace.branchName).toBe(created.workspace.branchName);
      expect(otherResult.workspace.projectId).not.toBe(created.workspace.projectId);
      expect(git(otherDir, 'branch', '--list', 'shipgraph/ta-1')).not.toBe('');
      expect(listWorkspacesForProject(otherHarness.options)).toHaveLength(1);

      // The source project is unaffected and its listing unchanged.
      expect(listWorkspacesForProject(harness.options).map((row) => row.id)).toEqual([
        created.workspace.id,
      ]);
    } finally {
      otherHarness.options.db.close();
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('fails closed when copied metadata is used from a different repository', async () => {
    harness = setupProject(2, [ticket('TA-1')]);
    // Real usage first: the project becomes bound to its source repository.
    await createWorkspace(harness.options, 'TA-1');

    // An attacker (or mistake) copies ShipGraph metadata into another repo.
    const wrongDir = mkdtempSync(join(tmpdir(), 'sg-work-wrong-'));
    git(wrongDir, 'init', '-b', 'main');
    git(wrongDir, 'config', 'user.email', 'shipgraph-test@example.com');
    git(wrongDir, 'config', 'user.name', 'ShipGraph Test');
    writeFileSync(join(wrongDir, 'README.md'), '# wrong\n');
    git(wrongDir, 'add', '.');
    git(wrongDir, 'commit', '-m', 'initial');
    copyFileSync(
      join(harness.projectDir, 'shipgraph.yml'),
      join(wrongDir, 'shipgraph.yml')
    );
    mkdirSync(join(wrongDir, '.shipgraph'));
    copyFileSync(harness.dbPath, join(wrongDir, '.shipgraph', 'shipgraph.db'));

    try {
      await expect(
        createWorkspace({ ...harness.options, projectDir: wrongDir }, 'TA-1')
      ).rejects.toThrow(/bound to a different source repository|is bound to source repository/);

      // The real project is untouched by the failed attempt.
      expect(listWorkspacesForProject(harness.options)).toHaveLength(1);
      expect(git(harness.projectDir, 'branch', '--list', 'shipgraph/ta-1')).not.toBe('');
    } finally {
      rmSync(wrongDir, { recursive: true, force: true });
    }
  });

  it('fails closed when the configured default branch does not exist locally', async () => {
    harness = setupProject(2, [ticket('TA-1')]);
    const drifted = { ...BASE_CONFIG(2) };
    drifted.project.defaultBranch = 'missing-branch';
    // Keep file and database consistent so identity validation passes and
    // the failure comes exactly from local ref resolution.
    writeFileSync(join(harness.projectDir, 'shipgraph.yml'), stringify(drifted));
    harness.options.db
      .prepare("UPDATE projects SET default_branch = 'missing-branch', config_json = ?")
      .run(JSON.stringify(drifted));

    await expect(createWorkspace(harness.options, 'TA-1')).rejects.toThrow(
      /does not resolve locally/
    );
  });
});

function findProjectId(dbPathOrDb: string | DbConnection): string {
  const db =
    typeof dbPathOrDb === 'string' ? openAndMigrate(dbPathOrDb) : dbPathOrDb;
  try {
    return createProjectRepository(db).findAll()[0].id;
  } finally {
    if (typeof dbPathOrDb === 'string') db.close();
  }
}

function findTicketState(options: WorkspaceServiceOptions, ticketId: string): string {
  return createTicketRepository(options.db).findById(ticketId)?.status ?? '<missing>';
}
