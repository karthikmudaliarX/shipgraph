import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  AgentExecutionAdapter,
  AgentExecutionRequest,
  AgentExecutionResult,
} from '../adapters/agent/adapter.js';
import {
  AGENT_PROVIDERS,
  type AgentProvider,
} from '../domain/agent-provider.js';
import {
  ACTIVE_AGENT_RUN_STATES,
  AGENT_INSTRUCTIONS_LIMIT_BYTES,
  AGENT_OUTPUT_LIMIT_BYTES,
  AGENT_RUN_STATES,
  DEFAULT_AGENT_TIMEOUT_MS,
  MAX_AGENT_TIMEOUT_MS,
  agentExecutionResultSchema,
  agentRunRecordSchema,
  type AgentFailureCategory,
  type AgentRunRecord,
  type AgentRunState,
} from '../domain/agent-run.js';
import { TicketState } from '../core/state-machine/state.js';
import { EventType } from '../events/event.js';
import {
  createEventRepository,
  createRunRepository,
  createTicketRepository,
  createWorkspaceRepository,
  type RunRecord,
  type RunUpdate,
} from '../persistence/repositories.js';
import { persistTicketTransition } from '../persistence/ticket-state-store.js';
import {
  getCurrentProjectId,
  getVerifiedWorkspaceForExecution,
  listWorkspacesForProject,
  type WorkspaceServiceOptions,
} from '../workspace/service.js';
import { redactSensitiveText } from '../adapters/agent/safety.js';

const agentProviderSchema = z.enum(AGENT_PROVIDERS);
const modelSchema = z.string().min(1).max(256);

export type AgentExecutionServiceOptions = WorkspaceServiceOptions & {
  adapter: AgentExecutionAdapter;
  createRunId?: () => string;
  maxOutputBytes?: number;
};

export type AgentTaskInput = {
  ticketId: string;
  model: string;
  instructions: string;
  provider?: AgentProvider;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type AgentTaskResult = {
  created: true;
  run: AgentRunRecord;
};

export type AgentRunRecoveryResult = {
  recovered: boolean;
  run: AgentRunRecord;
};

/**
 * Execute exactly one explicitly supplied ticket in its existing READY
 * workspace. The durable CREATED row is committed before the adapter is
 * allowed to spawn a provider process.
 */
export async function executeAgentTask(
  options: AgentExecutionServiceOptions,
  input: AgentTaskInput
): Promise<AgentTaskResult> {
  const normalized = validateTaskInput(options, input);
  const workspace = await getVerifiedWorkspaceForExecution(options, input.ticketId);
  const ticket = createTicketRepository(options.db).findById(input.ticketId);
  if (!ticket || ticket.projectId !== workspace.projectId) {
    throw new Error(`Ticket ${input.ticketId} does not belong to the verified workspace project`);
  }
  if (ticket.status !== TicketState.PLANNING) {
    throw new Error(
      `Ticket ${input.ticketId} has state ${ticket.status}; agent execution requires PLANNING`
    );
  }

  const now = options.now ?? (() => new Date().toISOString());
  const createEventId = options.createEventId ?? randomUUID;
  const createRunId = options.createRunId ?? randomUUID;
  const createdAt = now();
  const run: AgentRunRecord = {
    id: createRunId(),
    projectId: workspace.projectId,
    ticketId: workspace.ticketId,
    workspaceId: workspace.id,
    workspacePath: workspace.worktreePath,
    baseSha: workspace.baseSha,
    branchName: workspace.branchName,
    status: 'CREATED',
    provider: options.adapter.provider,
    model: normalized.model,
    createdAt,
    // The legacy schema requires started_at to be non-null. It is replaced by
    // the actual start timestamp when CREATED advances to RUNNING.
    startedAt: createdAt,
    updatedAt: createdAt,
    timedOut: false,
    cancelled: false,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    instructionsSha256: createHash('sha256').update(normalized.instructions).digest('hex'),
    timeoutMs: normalized.timeoutMs,
  };

  const persisted = persistCreatedRun(options, run, createEventId);
  let started: AgentRunRecord;
  try {
    started = startRun(options, persisted, createEventId, now);
  } catch (error) {
    const recovered = markRunNeedsHuman(
      options,
      persisted.id,
      `Run could not enter execution safely: ${safeErrorMessage(error)}`,
      createEventId,
      now,
      'persistence_error'
    );
    if (!recovered) {
      throw new Error(
        `Run ${persisted.id} could not be started and could not be marked NEEDS_HUMAN`
      );
    }
    throw error;
  }

  // The workspace can be changed by an external process during the durable
  // reservation/start window. Re-prove the hand-off immediately before the
  // provider boundary; a persisted RUNNING row with no provider process is
  // safer than launching against drifted or substituted data.
  try {
    const verifiedAgain = await getVerifiedWorkspaceForExecution(options, input.ticketId);
    if (
      verifiedAgain.id !== started.workspaceId ||
      verifiedAgain.worktreePath !== started.workspacePath ||
      verifiedAgain.baseSha !== started.baseSha ||
      verifiedAgain.branchName !== started.branchName
    ) {
      throw new Error('verified workspace identity changed before provider launch');
    }
  } catch (error) {
    const recovered = markRunNeedsHuman(
      options,
      started.id,
      `Workspace could not be re-verified before provider launch: ${safeErrorMessage(error)}`,
      createEventId,
      now,
      'workspace_invalid'
    );
    if (recovered) return { created: true, run: recovered };
    throw new Error(`Run ${started.id} changed while workspace re-verification was recorded`);
  }

  let adapterResult: AgentExecutionResult;
  try {
    const request: AgentExecutionRequest = {
      runId: started.id,
      projectId: started.projectId,
      ticketId: started.ticketId,
      workspaceId: started.workspaceId,
      workspacePath: started.workspacePath,
      branchName: started.branchName,
      baseSha: started.baseSha,
      provider: started.provider as AgentProvider,
      model: started.model,
      instructions: normalized.instructions,
      timeoutMs: started.timeoutMs,
      maxOutputBytes: normalized.maxOutputBytes,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      onProcessStarted: (processId) => {
        const updated = createRunRepository(options.db).updateStatus(
          started.id,
          'RUNNING',
          now(),
          { providerProcessId: processId },
          ['RUNNING']
        );
        if (!updated) throw new Error(`Run ${started.id} changed before process identity was recorded`);
      },
    };
    adapterResult = await options.adapter.execute(request);
  } catch (error) {
    adapterResult = {
      outcome: 'NEEDS_HUMAN',
      timedOut: false,
      cancelled: false,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      failureCategory: 'adapter_error',
      failureReason: `Agent adapter failed before returning a normalized result: ${safeErrorMessage(error)}`,
    };
  }

  const normalizedResult = normalizeAdapterResult(adapterResult, normalized.maxOutputBytes);
  try {
    const finalRun = finalizeRun(options, started, normalizedResult, createEventId, now);
    return { created: true, run: finalRun };
  } catch (error) {
    const recovered = markRunNeedsHuman(
      options,
      started.id,
      'Provider output was obtained but its terminal result could not be durably recorded; manual reconciliation is required',
      createEventId,
      now,
      'persistence_error'
    );
    if (recovered) return { created: true, run: recovered };
    throw new Error(
      `Run ${started.id} terminal result could not be persisted and the run could not be marked NEEDS_HUMAN: ${safeErrorMessage(error)}`
    );
  }
}

/** Read one durable run after validating current-project ownership. */
export async function inspectAgentRun(
  options: WorkspaceServiceOptions,
  runId: string
): Promise<AgentRunRecord> {
  return (await loadCurrentDurableRun(options, runId)).run;
}

/** List only durable runs belonging to the current repository/project. */
export async function listAgentRuns(
  options: WorkspaceServiceOptions
): Promise<readonly AgentRunRecord[]> {
  const projectId = await validateCurrentProjectForRunQueries(options);
  const rows = createRunRepository(options.db).findByProjectId(projectId);
  return rows.map((row) => requireDurableRun(row));
}

/** Explicit operator recovery for a process that may have survived a restart. */
export async function recoverAgentRun(
  options: WorkspaceServiceOptions,
  runId: string
): Promise<AgentRunRecoveryResult> {
  const { run } = await loadCurrentDurableRun(options, runId);
  if (!isActiveRunState(run.status)) return { recovered: false, run };
  const now = options.now ?? (() => new Date().toISOString());
  const updated = markRunNeedsHuman(
    options,
    run.id,
    'Run was explicitly recovered after restart; ShipGraph could not prove that its provider process is still owned',
    options.createEventId ?? randomUUID,
    now
  );
  if (!updated) {
    throw new Error(`Run ${run.id} changed while recovery was being recorded`);
  }
  return { recovered: true, run: updated };
}

function validateTaskInput(
  options: AgentExecutionServiceOptions,
  input: AgentTaskInput
): { instructions: string; model: string; timeoutMs: number; maxOutputBytes: number } {
  if (!agentProviderSchema.safeParse(options.adapter.provider).success) {
    throw new Error(`Unsupported agent adapter provider: ${options.adapter.provider}`);
  }
  if (input.provider !== undefined && input.provider !== options.adapter.provider) {
    throw new Error(
      `Requested provider ${input.provider} is not served by the ${options.adapter.provider} adapter`
    );
  }
  const model = modelSchema.safeParse(input.model);
  if (!model.success || input.model.includes('\0')) {
    throw new Error('Agent model must be a non-empty string without NUL characters');
  }
  if (typeof input.instructions !== 'string' || input.instructions.trim().length === 0) {
    throw new Error('Agent instructions must be non-empty');
  }
  if (input.instructions.includes('\0')) throw new Error('Agent instructions cannot contain NUL characters');
  const instructionBytes = Buffer.byteLength(input.instructions, 'utf8');
  if (instructionBytes > AGENT_INSTRUCTIONS_LIMIT_BYTES) {
    throw new Error(`Agent instructions exceed the ${AGENT_INSTRUCTIONS_LIMIT_BYTES}-byte limit`);
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_AGENT_TIMEOUT_MS) {
    throw new Error(`Agent timeout must be an integer between 1 and ${MAX_AGENT_TIMEOUT_MS} ms`);
  }
  const maxOutputBytes = options.maxOutputBytes ?? AGENT_OUTPUT_LIMIT_BYTES;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > AGENT_OUTPUT_LIMIT_BYTES) {
    throw new Error(`Agent output limit must be an integer between 1 and ${AGENT_OUTPUT_LIMIT_BYTES} bytes`);
  }
  return { instructions: input.instructions, model: input.model, timeoutMs, maxOutputBytes };
}

function persistCreatedRun(
  options: AgentExecutionServiceOptions,
  run: AgentRunRecord,
  createEventId: () => string
): AgentRunRecord {
  const persist = options.db.transaction((): AgentRunRecord => {
    const ticket = createTicketRepository(options.db).findById(run.ticketId);
    if (!ticket || ticket.projectId !== run.projectId || ticket.status !== TicketState.PLANNING) {
      throw new Error(`Ticket ${run.ticketId} changed before the agent run was persisted`);
    }
    const existing = createRunRepository(options.db).findByTicketId(run.ticketId);
    if (existing.length > 0) {
      throw new Error(
        `Ticket ${run.ticketId} already has an agent run; refusing duplicate execution`
      );
    }
    createRunRepository(options.db).create(run);
    createEventRepository(options.db).append({
      id: createEventId(),
      timestamp: run.createdAt,
      projectId: run.projectId,
      ticketId: run.ticketId,
      runId: run.id,
      type: EventType.RUN_CREATED,
      payload: {
        runId: run.id,
        ticketId: run.ticketId,
        baseSha: run.baseSha,
        state: run.status,
        workspaceId: run.workspaceId,
        workspacePath: run.workspacePath,
        branchName: run.branchName,
        provider: run.provider,
        model: run.model,
        createdAt: run.createdAt,
        timeoutMs: run.timeoutMs,
        instructionsSha256: run.instructionsSha256,
      },
    });
    return requireDurableRun(createRunRepository(options.db).findById(run.id));
  }).immediate;
  return persist();
}

function startRun(
  options: AgentExecutionServiceOptions,
  run: AgentRunRecord,
  createEventId: () => string,
  now: () => string
): AgentRunRecord {
  const start = options.db.transaction((): AgentRunRecord => {
    const repository = createRunRepository(options.db);
    const starting = repository.updateStatus(
      run.id,
      'STARTING',
      now(),
      undefined,
      ['CREATED']
    );
    if (!starting) throw new Error(`Run ${run.id} is no longer CREATED`);
    appendRunStateChange(options, starting, 'CREATED', 'STARTING', createEventId, now());

    const running = repository.updateStatus(
      run.id,
      'RUNNING',
      now(),
      { startedAt: now() },
      ['STARTING']
    );
    if (!running) throw new Error(`Run ${run.id} could not enter RUNNING state`);
    appendRunStateChange(options, running, 'STARTING', 'RUNNING', createEventId, now());
    persistTicketTransition(
      options.db,
      {
        ticketId: running.ticketId,
        projectId: running.projectId,
        next: TicketState.IMPLEMENTING,
        reason: `agent run ${running.id} started in workspace ${running.workspaceId}`,
      },
      { createEventId, now }
    );
    return requireDurableRun(repository.findById(run.id));
  }).immediate;
  return start();
}

function finalizeRun(
  options: AgentExecutionServiceOptions,
  run: AgentRunRecord,
  result: AgentExecutionResult,
  createEventId: () => string,
  now: () => string
): AgentRunRecord {
  const completedAt = now();
  const finalize = options.db.transaction((): AgentRunRecord => {
    const repository = createRunRepository(options.db);
    const update: RunUpdate = {
      completedAt,
      updatedAt: completedAt,
      ...(result.providerSessionId === undefined ? {} : { providerSessionId: result.providerSessionId }),
      ...(result.providerProcessId === undefined ? {} : { providerProcessId: result.providerProcessId }),
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(result.terminationSignal === undefined ? {} : { terminationSignal: result.terminationSignal }),
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      failureCategory: result.failureCategory ?? null,
      failureReason: result.failureReason ?? null,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      evidence: result.evidence ?? null,
    };
    const updated = repository.updateStatus(
      run.id,
      result.outcome,
      completedAt,
      update,
      ['RUNNING', 'STARTING']
    );
    if (!updated) throw new Error(`Run ${run.id} changed before terminal persistence`);
    const durableUpdated = requireDurableRun(updated);
    appendRunStateChange(options, durableUpdated, run.status, result.outcome, createEventId, completedAt, result.failureReason);
    createEventRepository(options.db).append({
      id: createEventId(),
      timestamp: completedAt,
      projectId: durableUpdated.projectId,
      ticketId: durableUpdated.ticketId,
      runId: durableUpdated.id,
      type: EventType.RUN_COMPLETED,
      payload: {
        runId: durableUpdated.id,
        ticketId: durableUpdated.ticketId,
        status: durableUpdated.status,
        completedAt,
        ...(durableUpdated.providerSessionId === undefined ? {} : { providerSessionId: durableUpdated.providerSessionId }),
        ...(durableUpdated.providerProcessId === undefined ? {} : { providerProcessId: durableUpdated.providerProcessId }),
        ...(durableUpdated.exitCode === undefined ? {} : { exitCode: durableUpdated.exitCode }),
        ...(durableUpdated.terminationSignal === undefined ? {} : { terminationSignal: durableUpdated.terminationSignal }),
        timedOut: durableUpdated.timedOut,
        cancelled: durableUpdated.cancelled,
        ...(durableUpdated.failureCategory === undefined ? {} : { failureCategory: durableUpdated.failureCategory }),
        ...(durableUpdated.failureReason === undefined ? {} : { failureReason: durableUpdated.failureReason }),
        ...(durableUpdated.evidence === undefined ? {} : { evidence: durableUpdated.evidence }),
      },
    });
    return requireDurableRun(repository.findById(run.id));
  }).immediate;
  return finalize();
}

function markRunNeedsHuman(
  options: WorkspaceServiceOptions,
  runId: string,
  reason: string,
  createEventId: () => string,
  now: () => string,
  category: AgentFailureCategory = 'stale_run'
): AgentRunRecord | undefined {
  const timestamp = now();
  const apply = options.db.transaction((): AgentRunRecord | undefined => {
    const repository = createRunRepository(options.db);
    const current = repository.findById(runId);
    if (!current || !current.projectId || !current.workspaceId || !current.workspacePath) return undefined;
    if (!isActiveRunState(current.status)) return requireDurableRun(current);
    const updated = repository.updateStatus(
      runId,
      'NEEDS_HUMAN',
      timestamp,
      {
        completedAt: timestamp,
        failureCategory: category,
        failureReason: boundFailureReason(reason),
        timedOut: false,
        cancelled: false,
      },
      [...ACTIVE_AGENT_RUN_STATES]
    );
    if (!updated) return undefined;
    const durableUpdated = requireDurableRun(updated);
    appendRunStateChange(options, durableUpdated, current.status as AgentRunState, 'NEEDS_HUMAN', createEventId, timestamp, reason);
    createEventRepository(options.db).append({
      id: createEventId(),
      timestamp,
      projectId: durableUpdated.projectId,
      ticketId: durableUpdated.ticketId,
      runId: durableUpdated.id,
      type: EventType.RUN_COMPLETED,
      payload: {
        runId: durableUpdated.id,
        ticketId: durableUpdated.ticketId,
        status: durableUpdated.status,
        completedAt: timestamp,
        timedOut: false,
        cancelled: false,
        failureCategory: durableUpdated.failureCategory,
        failureReason: durableUpdated.failureReason,
      },
    });
    return requireDurableRun(repository.findById(runId));
  }).immediate;
  return apply();
}

function appendRunStateChange(
  options: WorkspaceServiceOptions,
  run: RunRecord,
  previous: AgentRunState | string,
  next: AgentRunState,
  createEventId: () => string,
  timestamp: string,
  reason?: string
): void {
  createEventRepository(options.db).append({
    id: createEventId(),
    timestamp,
    projectId: run.projectId as string,
    ticketId: run.ticketId,
    runId: run.id,
    type: EventType.RUN_STATE_CHANGED,
    payload: {
      runId: run.id,
      ticketId: run.ticketId,
      ...(AGENT_RUN_STATES.includes(previous as AgentRunState) ? { previous: previous as AgentRunState } : {}),
      next,
      ...(reason === undefined ? {} : { reason: boundFailureReason(reason) }),
    },
  });
}

function normalizeAdapterResult(result: AgentExecutionResult, maxOutputBytes: number): AgentExecutionResult {
  const parsed = agentExecutionResultSchema.safeParse(result);
  if (!parsed.success) {
    return malformedAdapterResult();
  }
  const value = parsed.data;
  const contradiction = normalizedResultContradiction(value);
  if (contradiction !== undefined) {
    return {
      ...malformedAdapterResult(),
      failureReason: `Agent adapter returned an inconsistent normalized result: ${contradiction}`,
    };
  }
  const stdout = boundOutput(value.stdout, maxOutputBytes);
  const stderr = boundOutput(value.stderr, maxOutputBytes);
  const evidence = value.evidence === undefined
    ? undefined
    : {
        ...value.evidence,
        ...(value.evidence.summary === undefined
          ? {}
          : { summary: boundText(redactSensitiveText(value.evidence.summary), 4_096) }),
      };
  return {
    ...value,
    stdout: stdout.value,
    stderr: stderr.value,
    stdoutTruncated: value.stdoutTruncated || stdout.truncated,
    stderrTruncated: value.stderrTruncated || stderr.truncated,
    ...(value.failureReason === undefined
      ? {}
      : { failureReason: boundFailureReason(value.failureReason) }),
    ...(evidence === undefined ? {} : { evidence }),
  };
}

function malformedAdapterResult(): AgentExecutionResult {
  return {
    outcome: 'NEEDS_HUMAN',
    timedOut: false,
    cancelled: false,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    failureCategory: 'adapter_error',
    failureReason: 'Agent adapter returned a malformed normalized result',
  };
}

function normalizedResultContradiction(
  result: z.infer<typeof agentExecutionResultSchema>
): string | undefined {
  if (result.timedOut && result.cancelled) return 'timeout and cancellation are both set';
  if (result.timedOut && result.outcome !== 'TIMED_OUT') {
    return 'timedOut requires TIMED_OUT outcome';
  }
  if (result.cancelled && result.outcome !== 'CANCELLED') {
    return 'cancelled requires CANCELLED outcome';
  }
  if (result.outcome === 'TIMED_OUT' && !result.timedOut) {
    return 'TIMED_OUT outcome requires timedOut';
  }
  if (result.outcome === 'CANCELLED' && !result.cancelled) {
    return 'CANCELLED outcome requires cancelled';
  }
  if (result.outcome === 'SUCCEEDED') {
    if (result.failureCategory !== undefined || result.failureReason !== undefined) {
      return 'SUCCEEDED cannot carry failure metadata';
    }
    if (result.exitCode !== undefined && result.exitCode !== 0) {
      return 'SUCCEEDED requires exitCode 0 when exitCode is supplied';
    }
    if (result.terminationSignal !== undefined) return 'SUCCEEDED cannot carry a termination signal';
  } else if (result.failureCategory === undefined || result.failureReason === undefined) {
    return 'non-success outcomes require a failure category and reason';
  }
  return undefined;
}

function boundOutput(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const redacted = redactSensitiveText(value);
  const bytes = Buffer.from(redacted, 'utf8');
  if (bytes.byteLength <= maxBytes) return { value: redacted, truncated: false };
  return { value: bytes.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

function boundFailureReason(reason: string): string {
  return redactSensitiveText(reason).slice(0, 2_048);
}

function boundText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

async function validateCurrentProjectForRunQueries(options: WorkspaceServiceOptions): Promise<string> {
  const projectId = getCurrentProjectId(options);
  await listWorkspacesForProject(options);
  return projectId;
}

async function loadCurrentDurableRun(
  options: WorkspaceServiceOptions,
  runId: string
): Promise<{ run: AgentRunRecord; projectId: string }> {
  const projectId = await validateCurrentProjectForRunQueries(options);
  const run = requireDurableRun(createRunRepository(options.db).findById(runId));
  if (run.projectId !== projectId) {
    throw new Error(`Run ${runId} does not belong to the current ShipGraph project`);
  }
  const workspace = createWorkspaceRepository(options.db).findById(run.workspaceId);
  if (!workspace || workspace.projectId !== projectId || workspace.ticketId !== run.ticketId) {
    throw new Error(`Run ${runId} references a missing or cross-project workspace; refusing inspection`);
  }
  return { run, projectId };
}

function requireDurableRun(row: RunRecord | undefined): AgentRunRecord {
  if (!row) throw new Error('Agent run was not found');
  const parsed = agentRunRecordSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error(`Persisted agent run ${row.id} is malformed; refusing to operate on it`);
  }
  return parsed.data;
}

function isActiveRunState(value: string): value is AgentRunState {
  return ACTIVE_AGENT_RUN_STATES.includes(value as AgentRunState);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? boundFailureReason(error.message) : 'unknown execution error';
}
