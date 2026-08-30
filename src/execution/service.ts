import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  AgentExecutionAdapter,
  AgentExecutionRequest,
  AgentExecutionResult,
} from '../adapters/agent/adapter.js';
import { MODEL_TASK_TO_AGENT_CAPABILITY } from '../adapters/agent/registry.js';
import {
  AGENT_PROVIDERS,
  type AgentProvider,
} from '../domain/agent-provider.js';
import {
  MODEL_PROVIDER_TO_AGENT_PROVIDER,
  modelTaskTypeSchema,
  modelProviderIdSchema,
  type ModelTaskType,
  type ModelProviderId,
} from '../domain/model-provider.js';
import {
  ACTIVE_AGENT_RUN_STATES,
  AGENT_INSTRUCTIONS_LIMIT_BYTES,
  AGENT_OUTPUT_LIMIT_BYTES,
  AGENT_RUN_STATES,
  DEFAULT_AGENT_TIMEOUT_MS,
  MAX_AGENT_TIMEOUT_MS,
  agentExecutionResultSchema,
  agentRunRecordSchema,
  reviewOutputSchema,
  reviewTypeSchema,
  type AgentFailureCategory,
  type AgentRunRecord,
  type AgentRunState,
  type ReviewType,
} from '../domain/agent-run.js';
import { TicketState, type TicketStateValue } from '../core/state-machine/state.js';
import { EventType } from '../events/event.js';
import { createModelRepository } from '../persistence/model-repositories.js';
import {
  createEventRepository,
  createRunRepository,
  createTicketRepository,
  createWorkspaceRepository,
  type RunRecord,
  type RunUpdate,
  type WorkspaceRecord,
} from '../persistence/repositories.js';
import { persistTicketTransition } from '../persistence/ticket-state-store.js';
import { UsageLedger } from '../model/ledger.js';
import {
  getCurrentProjectId,
  getVerifiedWorkspaceForExecution,
  listWorkspacesForProject,
  type WorkspaceServiceOptions,
} from '../workspace/service.js';
import { redactSensitiveText } from '../adapters/agent/safety.js';

const agentProviderSchema = z.enum(AGENT_PROVIDERS);
const modelSchema = z.string().min(1).max(256);

/** Per-run safety input supplied by the caller that owns the execution step. */
export const agentSafetyPolicySchema = z.object({
  maxAttempts: z.number().int().nonnegative().max(1_000_000).optional(),
  attempt: z.number().int().positive().max(1_000_000).optional(),
  maxTokens: z.number().int().nonnegative().max(1_000_000_000).optional(),
  maxCost: z.number().finite().nonnegative().max(1_000_000_000).optional(),
  maxTimeoutMs: z.number().int().positive().max(MAX_AGENT_TIMEOUT_MS).optional(),
  risk: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  approvalRequired: z.boolean().optional(),
  approvalGranted: z.boolean().optional(),
  destructive: z.boolean().optional(),
  materiallyAmbiguous: z.boolean().optional(),
  policySensitive: z.boolean().optional(),
  scopeGrowth: z.boolean().optional(),
}).strict();

export type AgentSafetyPolicy = z.infer<typeof agentSafetyPolicySchema>;

export type AgentExecutionServiceOptions = WorkspaceServiceOptions & {
  adapter: AgentExecutionAdapter;
  createRunId?: () => string;
  maxOutputBytes?: number;
};

export type AgentTaskInput = {
  ticketId: string;
  model: string;
  instructions: string;
  /** MODEL-001 task kind; direct AGENT-001 callers default to implementation. */
  task?: ModelTaskType;
  provider?: AgentProvider;
  /** Concrete MODEL-001 identity when this run is selected by the router. */
  modelProviderId?: ModelProviderId;
  /** KAR-9 review provenance; both fields are required for review runs. */
  reviewType?: ReviewType;
  reviewedSha?: string;
  /** Existing CREATED run to execute after MODEL-001 binds its route. */
  runId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Optional per-run limits and explicit safety signals; no ticket schema is implied. */
  safety?: AgentSafetyPolicy;
};

export type AgentTaskResult = {
  created: true;
  run: AgentRunRecord;
};

export type AgentRunRecoveryResult = {
  recovered: boolean;
  run: AgentRunRecord;
};

export type AgentRunReconciliationResult = {
  released: boolean;
  run: AgentRunRecord;
};

export type AgentTaskPreparationInput = Omit<AgentTaskInput, 'runId'>;

export type SelectedAgentTaskInput = Omit<AgentTaskInput, 'model' | 'provider' | 'runId' | 'task'>;

/**
 * Persist a CREATED AGENT-001 run without launching a provider. MODEL-001 can
 * then bind a route to this run before ModelRoutingService starts it through
 * the provider-neutral execution bridge.
 */
export async function prepareAgentTaskRun(
  options: AgentExecutionServiceOptions,
  input: AgentTaskPreparationInput
): Promise<AgentTaskResult> {
  const normalized = validateTaskInput(options, input);
  const workspace = await getVerifiedExecutionWorkspace(
    options,
    input.ticketId,
    normalized.task,
    false,
    normalized.reviewedSha
  );
  const now = options.now ?? (() => new Date().toISOString());
  const createEventId = options.createEventId ?? randomUUID;
  const createRunId = options.createRunId ?? randomUUID;
  const createdAt = now();
  const run = buildAgentRun(
    workspace,
    options.adapter.provider,
    normalized,
    createRunId(),
    createdAt
  );
  return {
    created: true,
    run: persistCreatedRun(options, run, createEventId, normalized.task),
  };
}

/** Terminalize a CREATED run that never acquired provider capacity. */
export async function abandonPreparedAgentTaskRun(
  options: WorkspaceServiceOptions,
  runId: string,
  reason: string,
  category: AgentFailureCategory = 'persistence_error'
): Promise<AgentRunRecord> {
  const { run } = await loadCurrentDurableRun(options, runId);
  if (run.status !== 'CREATED') {
    throw new Error(`Run ${run.id} is ${run.status}; only CREATED runs can be abandoned`);
  }
  const abandon = options.db.transaction(() => {
    const active = createModelRepository(options.db).findActiveRoutingDecisionByRun(
      run.projectId,
      run.id
    );
    if (active !== undefined) {
      throw new Error(`Run ${run.id} owns provider capacity and cannot be abandoned`);
    }
    return markRunNeedsHuman(
      options,
      run.id,
      reason,
      options.createEventId ?? randomUUID,
      options.now ?? (() => new Date().toISOString()),
      category,
      false
    );
  }).immediate;
  const updated = abandon();
  if (!updated) throw new Error(`Run ${run.id} changed before it could be abandoned`);
  return updated;
}

/**
 * Execute exactly one explicitly supplied ticket in its existing READY
 * workspace. The durable CREATED row is committed before the adapter is
 * allowed to spawn a provider process.
 */
export async function executeAgentTask(
  options: AgentExecutionServiceOptions,
  input: AgentTaskInput
): Promise<AgentTaskResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const createEventId = options.createEventId ?? randomUUID;
  const normalized = validateTaskInput(options, input);
  let workspace: Awaited<ReturnType<typeof getVerifiedExecutionWorkspace>>;
  try {
    workspace = await getVerifiedExecutionWorkspace(
      options,
      input.ticketId,
      normalized.task,
      false,
      normalized.reviewedSha
    );
  } catch (error) {
    // A routed caller may have prepared and capacity-bound a CREATED run before
    // this final workspace proof. No adapter boundary has been reached here, so
    // process ownership is certain and the reservation can be released safely.
    if (input.runId !== undefined) {
      const recovered = markPreparedRunNeedsHumanBeforeLaunch(
        options,
        input.runId,
        input.ticketId,
        normalized,
        `Prepared run could not be validated before provider launch: ${safeErrorMessage(error)}`,
        createEventId,
        now
      );
      if (recovered) return { created: true, run: recovered };
    }
    throw error;
  }

  const createRunId = options.createRunId ?? randomUUID;
  const createdAt = now();
  const persisted = input.runId === undefined
    ? persistCreatedRun(
        options,
        buildAgentRun(
          workspace,
          options.adapter.provider,
          normalized,
          createRunId(),
          createdAt
        ),
        createEventId,
        normalized.task
      )
    : loadPreparedRun(options, input.runId, workspace, normalized);

  const durableUsage = usageTotalsForRun(options, persisted.projectId, persisted.id);
  const safetyGate = findSafetyGate(
    normalized.safety,
    normalized.timeoutMs,
    persisted,
    durableUsage,
    options.adapter
  );
  if (safetyGate !== undefined) {
    const gated = markRunNeedsHuman(
      options,
      persisted.id,
      safetyGate.reason,
      createEventId,
      now,
      safetyGate.category,
      true
    );
    if (gated) return { created: true, run: gated };
    throw new Error(`Run ${persisted.id} could not be marked NEEDS_HUMAN for a safety gate`);
  }

  let started: AgentRunRecord;
  try {
    started = startRun(options, persisted, normalized.task, createEventId, now);
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
    const verifiedAgain = await getVerifiedExecutionWorkspace(
      options,
      input.ticketId,
      normalized.task,
      true,
      normalized.reviewedSha
    );
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

  // Re-probe after the final workspace proof and immediately before the
  // adapter can spawn a provider. The earlier MODEL-001 refresh is only a
  // routing snapshot; it is not launch authority.
  let executionProbe: Awaited<ReturnType<AgentExecutionAdapter['probe']>>;
  try {
    executionProbe = await options.adapter.probe();
  } catch (error) {
    const recovered = markRunNeedsHuman(
      options,
      started.id,
      `Agent execution capability could not be verified before provider launch: ${safeErrorMessage(error)}`,
      createEventId,
      now,
      'adapter_error',
      true
    );
    if (recovered) return { created: true, run: recovered };
    throw new Error(`Run ${started.id} changed while capability recovery was being recorded`);
  }
  if (!executionProbe.available) {
    const recovered = markRunNeedsHuman(
      options,
      started.id,
      `Agent execution surface became unavailable before provider launch: ${executionProbe.reason}`,
      createEventId,
      now,
      'executable_unavailable',
      true
    );
    if (recovered) return { created: true, run: recovered };
    throw new Error(`Run ${started.id} changed while capability recovery was being recorded`);
  }

  let adapterResult: AgentExecutionResult;
  let executionStopped = false;
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
      ...(normalized.reviewType === undefined ? {} : { reviewType: normalized.reviewType }),
      ...(normalized.reviewedSha === undefined ? {} : { reviewedSha: normalized.reviewedSha }),
      timeoutMs: started.timeoutMs,
      maxOutputBytes: normalized.maxOutputBytes,
      ...(remainingTokenBudget(normalized.safety, durableUsage) === undefined
        ? {}
        : { remainingTokens: remainingTokenBudget(normalized.safety, durableUsage) }),
      ...(remainingCostBudget(normalized.safety, durableUsage) === undefined
        ? {}
        : { remainingCost: remainingCostBudget(normalized.safety, durableUsage) }),
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
    // An adapter may have spawned a provider and then lost its bookkeeping
    // channel. Keep the durable reservation until an operator can reconcile
    // process ownership; do not infer termination from a thrown exception.
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

  const normalizedResult = applyReviewResult(
    applySafetyResult(
      normalizeAdapterResult(adapterResult, normalized.maxOutputBytes),
      normalized.safety,
      durableUsage
    ),
    normalized.reviewType
  );
  // Capacity ownership depends only on the normalized process-group proof.
  // Outcome quality, timeout and bounded-output evidence affect the run result,
  // but cannot keep a slot once the owned process group is proven stopped.
  executionStopped = normalizedResult.processGroupStopped === true;
  try {
    const finalRun = finalizeRun(
      options,
      started,
      normalizedResult,
      createEventId,
      now,
      executionStopped,
      normalized.safety
    );
    return { created: true, run: finalRun };
  } catch (error) {
    const recovered = markRunNeedsHuman(
      options,
      started.id,
      'Provider output was obtained but its terminal result could not be durably recorded; manual reconciliation is required',
      createEventId,
      now,
      'persistence_error',
      executionStopped
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
    now,
    'stale_run',
    false
  );
  if (!updated) {
    throw new Error(`Run ${run.id} changed while recovery was being recorded`);
  }
  return { recovered: true, run: updated };
}

/**
 * Release retained MODEL capacity only after an operator has independently
 * established that the provider process is no longer running.
 */
export async function reconcileAgentRun(
  options: WorkspaceServiceOptions,
  runId: string,
  confirmation: { executionStopped: true }
): Promise<AgentRunReconciliationResult> {
  if (confirmation.executionStopped !== true) {
    throw new Error('Agent-run reconciliation requires proof that execution stopped');
  }
  const { run } = await loadCurrentDurableRun(options, runId);
  if (isActiveRunState(run.status)) {
    throw new Error(`Run ${run.id} is still active; recover it before reconciliation`);
  }
  const releasedAt = (options.now ?? (() => new Date().toISOString()))();
  const reconcile = options.db.transaction(() =>
    releaseActiveModelReservation(options, run, releasedAt)
  ).immediate;
  return { released: reconcile(), run };
}

function validateTaskInput(
  options: AgentExecutionServiceOptions,
  input: AgentTaskInput
): {
  instructions: string;
  model: string;
  task: ModelTaskType;
  timeoutMs: number;
  maxOutputBytes: number;
  modelProviderId?: ModelProviderId;
  reviewType?: ReviewType;
  reviewedSha?: string;
  safety: AgentSafetyPolicy;
} {
  if (!agentProviderSchema.safeParse(options.adapter.provider).success) {
    throw new Error(`Unsupported agent adapter provider: ${options.adapter.provider}`);
  }
  if (input.provider !== undefined && input.provider !== options.adapter.provider) {
    throw new Error(
      `Requested provider ${input.provider} is not served by the ${options.adapter.provider} adapter`
    );
  }
  const modelProviderId = input.modelProviderId === undefined
    ? undefined
    : modelProviderIdSchema.parse(input.modelProviderId);
  if (
    modelProviderId !== undefined &&
    MODEL_PROVIDER_TO_AGENT_PROVIDER[modelProviderId] !== options.adapter.provider
  ) {
    throw new Error(
      `Requested MODEL provider ${modelProviderId} is not served by the ${options.adapter.provider} adapter`
    );
  }
  const task = modelTaskTypeSchema.parse(input.task ?? 'implementation');
  const reviewType = input.reviewType === undefined
    ? undefined
    : reviewTypeSchema.parse(input.reviewType);
  // Existing AGENT-001 generic review runs remain compatible. KAR-9 review
  // evidence is created only when this operation supplies both provenance
  // fields below.
  if (reviewType !== undefined && task !== 'review') {
    throw new Error('KAR-9 review provenance requires a review task');
  }
  if (reviewType !== undefined && input.reviewedSha === undefined) {
    throw new Error('KAR-9 review provenance requires the exact reviewed SHA');
  }
  if (input.reviewedSha !== undefined && !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u.test(input.reviewedSha)) {
    throw new Error('KAR-9 reviewed SHA must be a full Git commit SHA');
  }
  if (!options.adapter.capabilities.includes(MODEL_TASK_TO_AGENT_CAPABILITY[task])) {
    throw new Error(
      `AGENT-001 adapter for ${options.adapter.provider} does not support MODEL task ${task}`
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
  return {
    instructions: input.instructions,
    model: input.model,
    task,
    timeoutMs,
    maxOutputBytes,
    ...(modelProviderId === undefined ? {} : { modelProviderId }),
    ...(reviewType === undefined ? {} : { reviewType }),
    ...(input.reviewedSha === undefined ? {} : { reviewedSha: input.reviewedSha }),
    safety: safetyPolicyWithTicketRisk(
      options,
      input.ticketId,
      agentSafetyPolicySchema.parse(input.safety ?? {})
    ),
  };
}

type SafetyGate = {
  category: Extract<AgentFailureCategory, 'safety_limit' | 'approval_required' | 'scope_growth'>;
  reason: string;
};

type DurableUsageTotals = {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cost: number | undefined;
};

function findSafetyGate(
  policy: AgentSafetyPolicy,
  timeoutMs: number,
  run: AgentRunRecord,
  usage: DurableUsageTotals,
  adapter: AgentExecutionAdapter
): SafetyGate | undefined {
  if (policy.scopeGrowth === true) {
    return {
      category: 'scope_growth',
      reason: 'Execution stopped because the requested work crossed the authorized scope boundary',
    };
  }
  if (
    policy.approvalRequired === true ||
    policy.destructive === true ||
    policy.materiallyAmbiguous === true ||
    policy.policySensitive === true ||
    policy.risk === 'high' ||
    policy.risk === 'critical'
  ) {
    if (policy.approvalGranted !== true) {
      return {
        category: 'approval_required',
        reason: 'Execution requires explicit human approval before provider launch',
      };
    }
  }
  const attempt = policy.attempt ?? 1;
  if (policy.maxAttempts !== undefined && attempt > policy.maxAttempts) {
    return {
      category: 'safety_limit',
      reason: `Execution attempt budget exhausted (${attempt} > ${policy.maxAttempts})`,
    };
  }
  if (policy.maxTokens !== undefined) {
    if (
      run.modelProviderId === undefined ||
      run.task === undefined ||
      adapter.supportsTokenLimit !== true ||
      adapter.reportsUsage !== true
    ) {
      return {
        category: 'safety_limit',
        reason: 'Execution token budget cannot be enforced and measured by the selected provider',
      };
    }
    if (usage.inputTokens === undefined || usage.outputTokens === undefined) {
      return {
        category: 'safety_limit',
        reason: 'Execution token budget has unknown durable usage and cannot be safely resumed',
      };
    }
    const tokensUsed = usage.inputTokens + usage.outputTokens;
    if (tokensUsed >= policy.maxTokens) {
      return {
        category: 'safety_limit',
        reason: `Execution token budget exhausted (${tokensUsed} >= ${policy.maxTokens})`,
      };
    }
  }
  if (policy.maxCost !== undefined) {
    if (
      run.modelProviderId === undefined ||
      run.task === undefined ||
      adapter.supportsCostLimit !== true ||
      adapter.reportsUsage !== true
    ) {
      return {
        category: 'safety_limit',
        reason: 'Execution cost budget cannot be enforced and measured by the selected provider',
      };
    }
    if (usage.cost === undefined) {
      return {
        category: 'safety_limit',
        reason: 'Execution cost budget has unknown durable usage and cannot be safely resumed',
      };
    }
    if (usage.cost >= policy.maxCost) {
      return {
        category: 'safety_limit',
        reason: `Execution cost budget exhausted (${usage.cost} >= ${policy.maxCost})`,
      };
    }
  }
  if (policy.maxTimeoutMs !== undefined && timeoutMs > policy.maxTimeoutMs) {
    return {
      category: 'safety_limit',
      reason: `Execution timeout exceeds the per-run ceiling (${timeoutMs} > ${policy.maxTimeoutMs} ms)`,
    };
  }
  return undefined;
}

function remainingTokenBudget(
  policy: AgentSafetyPolicy,
  usage: DurableUsageTotals
): number | undefined {
  if (policy.maxTokens === undefined || usage.inputTokens === undefined || usage.outputTokens === undefined) {
    return undefined;
  }
  return policy.maxTokens - usage.inputTokens - usage.outputTokens;
}

function remainingCostBudget(
  policy: AgentSafetyPolicy,
  usage: DurableUsageTotals
): number | undefined {
  if (policy.maxCost === undefined || usage.cost === undefined) return undefined;
  return policy.maxCost - usage.cost;
}

function usageTotalsForRun(
  options: AgentExecutionServiceOptions,
  projectId: string,
  runId: string
): DurableUsageTotals {
  const entries = createModelRepository(options.db)
    .listUsage(projectId)
    .filter((entry) => entry.runId === runId);
  return {
    inputTokens: sumKnownUsage(entries.map((entry) => entry.inputTokens)),
    outputTokens: sumKnownUsage(entries.map((entry) => entry.outputTokens)),
    cost: sumKnownUsage(entries.map((entry) => entry.cost)),
  };
}

function sumKnownUsage(values: readonly (number | 'unknown')[]): number | undefined {
  let total = 0;
  for (const value of values) {
    if (value === 'unknown') return undefined;
    total += value;
  }
  return total;
}

function safetyPolicyWithTicketRisk(
  options: AgentExecutionServiceOptions,
  ticketId: string,
  policy: AgentSafetyPolicy
): AgentSafetyPolicy {
  if (policy.risk === 'high' || policy.risk === 'critical') return policy;
  const ticket = createTicketRepository(options.db).findById(ticketId);
  return ticket?.risk === 'high' || ticket?.risk === 'critical'
    ? { ...policy, risk: ticket.risk }
    : policy;
}

function safetyPolicyDigest(policy: AgentSafetyPolicy): string {
  const canonical = JSON.stringify({
    maxAttempts: policy.maxAttempts ?? null,
    attempt: policy.attempt ?? 1,
    maxTokens: policy.maxTokens ?? null,
    maxCost: policy.maxCost ?? null,
    maxTimeoutMs: policy.maxTimeoutMs ?? null,
    risk: policy.risk ?? null,
    approvalRequired: policy.approvalRequired ?? false,
    approvalGranted: policy.approvalGranted ?? false,
    destructive: policy.destructive ?? false,
    materiallyAmbiguous: policy.materiallyAmbiguous ?? false,
    policySensitive: policy.policySensitive ?? false,
    scopeGrowth: policy.scopeGrowth ?? false,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function applySafetyResult(
  result: AgentExecutionResult,
  policy: AgentSafetyPolicy,
  durableUsage: DurableUsageTotals
): AgentExecutionResult {
  if (policy.maxTokens !== undefined) {
    if (
      result.usage === undefined ||
      result.usage.inputTokens === undefined ||
      result.usage.outputTokens === undefined
    ) {
      return safetyLimitedResult(result, 'Provider did not report token usage for the configured token budget');
    }
    const totalTokens = (durableUsage.inputTokens ?? 0) +
      (durableUsage.outputTokens ?? 0) +
      result.usage.inputTokens +
      result.usage.outputTokens;
    if (totalTokens > policy.maxTokens) {
      return safetyLimitedResult(
        result,
        `Execution token budget exceeded (${totalTokens} > ${policy.maxTokens})`
      );
    }
  }
  if (policy.maxCost !== undefined) {
    if (result.usage === undefined || result.usage.cost === undefined) {
      return safetyLimitedResult(result, 'Provider did not report cost for the configured cost budget');
    }
    const totalCost = (durableUsage.cost ?? 0) + result.usage.cost;
    if (totalCost > policy.maxCost) {
      return safetyLimitedResult(
        result,
        `Execution cost budget exceeded (${totalCost} > ${policy.maxCost})`
      );
    }
  }
  return result;
}

function safetyLimitedResult(result: AgentExecutionResult, reason: string): AgentExecutionResult {
  return {
    ...result,
    outcome: 'NEEDS_HUMAN',
    timedOut: false,
    cancelled: false,
    failureCategory: 'safety_limit',
    failureReason: reason,
  };
}

/** Require a machine-readable PASS/FAIL report for a KAR-9 review run. */
function applyReviewResult(
  result: AgentExecutionResult,
  reviewType: ReviewType | undefined
): AgentExecutionResult {
  if (reviewType === undefined || result.outcome !== 'SUCCEEDED') return result;

  const reports: Array<ReturnType<typeof reviewOutputSchema.parse>> = [];
  const direct = result.reviewResult === undefined
    ? undefined
    : reviewOutputSchema.safeParse({
        result: result.reviewResult,
        findings: result.reviewFindings ?? [],
      });
  const hasDirectReportFields = result.reviewResult !== undefined || result.reviewFindings !== undefined;
  if (hasDirectReportFields && direct?.success !== true) {
    return malformedReviewResult(result, reviewType);
  }
  if (direct?.success === true) reports.push(direct.data);
  const stdoutReport = parseReviewJson(result.stdout);
  if (stdoutReport !== undefined) reports.push(stdoutReport);
  const summaryReport = result.evidence?.summary === undefined
    ? undefined
    : parseReviewJson(result.evidence.summary);
  if (summaryReport !== undefined) reports.push(summaryReport);
  const report = reports[0];
  if (
    report === undefined ||
    reports.some((candidate) =>
      candidate.result !== report.result ||
      candidate.findings.length !== report.findings.length ||
      candidate.findings.some((finding, index) => finding !== report.findings[index])
    )
  ) {
    return malformedReviewResult(result, reviewType);
  }
  return {
    ...result,
    reviewResult: report.result,
    reviewFindings: report.findings,
  };
}

function malformedReviewResult(
  result: AgentExecutionResult,
  reviewType: ReviewType
): AgentExecutionResult {
  return {
    ...result,
    outcome: 'NEEDS_HUMAN',
    timedOut: false,
    cancelled: false,
    failureCategory: 'malformed_output',
    failureReason: `The ${reviewType} reviewer did not return one consistent PASS/FAIL report`,
    reviewResult: undefined,
    reviewFindings: undefined,
  };
}

/*
 * Keep this helper narrow: it validates a complete provider-output object and
 * does not search arbitrary nested values for a report. Every present channel
 * is compared by the caller before the result is accepted.
 */
function parseReviewJson(value: string): ReturnType<typeof reviewOutputSchema.parse> | undefined {
  const output = redactSensitiveText(value).trim();
  if (output.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(output);
    const report = reviewOutputSchema.safeParse(parsed);
    return report.success ? report.data : undefined;
  } catch {
    return undefined;
  }
}

async function getVerifiedExecutionWorkspace(
  options: AgentExecutionServiceOptions,
  ticketId: string,
  task: ModelTaskType,
  afterStart = false,
  expectedHeadSha?: string
): Promise<WorkspaceRecord> {
  const workspace = await getVerifiedWorkspaceForExecution(
    options,
    ticketId,
    task === 'implementation' ? 'ready' : 'changed',
    expectedHeadSha
  );
  const ticket = createTicketRepository(options.db).findById(ticketId);
  if (!ticket || ticket.projectId !== workspace.projectId) {
    throw new Error(`Ticket ${ticketId} does not belong to the verified workspace project`);
  }
  const requiredStates = task === 'implementation' && afterStart
    ? [TicketState.PLANNING, TicketState.IMPLEMENTING]
    : [requiredTicketState(task)];
  if (!requiredStates.includes(ticket.status)) {
    throw new Error(
      `Ticket ${ticketId} has state ${ticket.status}; ${task} agent execution requires ${requiredStates.join(' or ')}`
    );
  }
  return workspace;
}

/**
 * Keep MODEL-001 task execution aligned with the existing ticket lifecycle.
 * Review and repair adapters use the same provider-neutral run contract, but
 * must not be forced through the implementation-only PLANNING transition.
 */
function requiredTicketState(task: ModelTaskType): TicketStateValue {
  switch (task) {
    case 'implementation':
      return TicketState.PLANNING;
    case 'review':
      return TicketState.REVIEWING;
    case 'repair':
      return TicketState.REPAIRING;
  }
}

function buildAgentRun(
  workspace: WorkspaceRecord,
  provider: AgentProvider,
  normalized: {
    instructions: string;
    model: string;
    task: ModelTaskType;
    timeoutMs: number;
    modelProviderId?: ModelProviderId;
    reviewType?: ReviewType;
    reviewedSha?: string;
    safety: AgentSafetyPolicy;
  },
  runId: string,
  createdAt: string
): AgentRunRecord {
  return {
    id: runId,
    projectId: workspace.projectId,
    ticketId: workspace.ticketId,
    workspaceId: workspace.id,
    workspacePath: workspace.worktreePath,
    baseSha: workspace.baseSha,
    branchName: workspace.branchName,
    status: 'CREATED',
    provider,
    ...(normalized.modelProviderId === undefined
      ? {}
      : { modelProviderId: normalized.modelProviderId }),
    ...(normalized.reviewType === undefined ? {} : { reviewType: normalized.reviewType }),
    ...(normalized.reviewedSha === undefined ? {} : { reviewedSha: normalized.reviewedSha }),
    task: normalized.task,
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
    safetyPolicySha256: safetyPolicyDigest(normalized.safety),
    timeoutMs: normalized.timeoutMs,
  };
}

function loadPreparedRun(
  options: AgentExecutionServiceOptions,
  runId: string,
  workspace: WorkspaceRecord,
  normalized: {
    instructions: string;
    model: string;
    task: ModelTaskType;
    timeoutMs: number;
    modelProviderId?: ModelProviderId;
    reviewType?: ReviewType;
    reviewedSha?: string;
    safety: AgentSafetyPolicy;
  }
): AgentRunRecord {
  const run = requireDurableRun(createRunRepository(options.db).findById(runId));
  assertPreparedRunMatchesRequest(options, run, workspace.ticketId, normalized);
  if (
    run.projectId !== workspace.projectId ||
    run.workspaceId !== workspace.id ||
    run.workspacePath !== workspace.worktreePath ||
    run.baseSha !== workspace.baseSha ||
    run.branchName !== workspace.branchName
  ) {
    throw new Error(`Prepared agent run ${run.id} does not match the verified workspace`);
  }
  return run;
}

function assertPreparedRunMatchesRequest(
  options: AgentExecutionServiceOptions,
  run: AgentRunRecord,
  ticketId: string,
  normalized: {
    instructions: string;
    model: string;
    task: ModelTaskType;
    timeoutMs: number;
    modelProviderId?: ModelProviderId;
    reviewType?: ReviewType;
    reviewedSha?: string;
    safety: AgentSafetyPolicy;
  }
): void {
  const instructionHash = createHash('sha256').update(normalized.instructions).digest('hex');
  if (run.status !== 'CREATED') {
    throw new Error(`Prepared agent run ${run.id} is ${run.status}; execution requires CREATED`);
  }
  if (
    run.projectId !== getCurrentProjectId(options) ||
    run.ticketId !== ticketId
  ) {
    throw new Error(`Prepared agent run ${run.id} does not match the current project/ticket`);
  }
  if (run.provider !== options.adapter.provider || run.model !== normalized.model) {
    throw new Error(`Prepared agent run ${run.id} does not match the selected provider/model`);
  }
  if (run.modelProviderId !== normalized.modelProviderId) {
    throw new Error(`Prepared agent run ${run.id} does not match the selected MODEL provider`);
  }
  if (run.task !== normalized.task) {
    throw new Error(`Prepared agent run ${run.id} does not match the selected MODEL task`);
  }
  if (run.reviewType !== normalized.reviewType || run.reviewedSha !== normalized.reviewedSha) {
    throw new Error(`Prepared agent run ${run.id} does not match the KAR-9 review provenance`);
  }
  if (run.instructionsSha256 !== instructionHash || run.timeoutMs !== normalized.timeoutMs) {
    throw new Error(`Prepared agent run ${run.id} does not match the execution request`);
  }
  if (
    run.safetyPolicySha256 === undefined ||
    run.safetyPolicySha256 !== safetyPolicyDigest(normalized.safety)
  ) {
    throw new Error(`Prepared agent run ${run.id} does not match the durable safety policy`);
  }
}

function markPreparedRunNeedsHumanBeforeLaunch(
  options: AgentExecutionServiceOptions,
  runId: string,
  ticketId: string,
  normalized: Parameters<typeof assertPreparedRunMatchesRequest>[3],
  reason: string,
  createEventId: () => string,
  now: () => string
): AgentRunRecord | undefined {
  const recover = options.db.transaction(() => {
    const run = requireDurableRun(createRunRepository(options.db).findById(runId));
    // Re-prove identity and CREATED state inside the same write transaction
    // that terminalizes the run and releases its never-launched reservation.
    assertPreparedRunMatchesRequest(options, run, ticketId, normalized);
    return markRunNeedsHuman(
      options,
      run.id,
      reason,
      createEventId,
      now,
      'workspace_invalid',
      true
    );
  }).immediate;
  return recover();
}

function persistCreatedRun(
  options: AgentExecutionServiceOptions,
  run: AgentRunRecord,
  createEventId: () => string,
  task: ModelTaskType
): AgentRunRecord {
  const persist = options.db.transaction((): AgentRunRecord => {
    const ticket = createTicketRepository(options.db).findById(run.ticketId);
    if (
      !ticket ||
      ticket.projectId !== run.projectId ||
      ticket.status !== requiredTicketState(task)
    ) {
      throw new Error(
        `Ticket ${run.ticketId} changed before the ${task} agent run was persisted`
      );
    }
    if (run.task !== task) {
      throw new Error(`Agent run ${run.id} does not record the selected MODEL task`);
    }
    const existing = createRunRepository(options.db).findActiveByTicket(run.projectId, run.ticketId);
    if (existing !== undefined) {
      throw new Error(
        `Ticket ${run.ticketId} already has an active agent run; refusing duplicate execution`
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
        ...(run.modelProviderId === undefined ? {} : { modelProviderId: run.modelProviderId }),
        task: run.task,
        model: run.model,
        createdAt: run.createdAt,
        ...(run.reviewType === undefined ? {} : { reviewType: run.reviewType }),
        ...(run.reviewedSha === undefined ? {} : { reviewedSha: run.reviewedSha }),
        safetyPolicySha256: run.safetyPolicySha256,
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
  task: ModelTaskType,
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
    if (task === 'implementation') {
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
    }
    return requireDurableRun(repository.findById(run.id));
  }).immediate;
  return start();
}

function finalizeRun(
  options: AgentExecutionServiceOptions,
  run: AgentRunRecord,
  result: AgentExecutionResult,
  createEventId: () => string,
  now: () => string,
  executionStopped: boolean,
  safety: AgentSafetyPolicy
): AgentRunRecord {
  const completedAt = now();
  const finalize = options.db.transaction((): AgentRunRecord => {
    const repository = createRunRepository(options.db);
    appendExecutionUsage(options, run, result, completedAt, safety);
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
      ...(result.reviewResult === undefined ? {} : { reviewResult: result.reviewResult }),
      ...(result.reviewFindings === undefined ? {} : { reviewFindings: result.reviewFindings }),
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
        ...(durableUpdated.reviewType === undefined ? {} : { reviewType: durableUpdated.reviewType }),
        ...(durableUpdated.reviewedSha === undefined ? {} : { reviewedSha: durableUpdated.reviewedSha }),
        ...(durableUpdated.reviewResult === undefined ? {} : { reviewResult: durableUpdated.reviewResult }),
        ...(durableUpdated.reviewFindings === undefined ? {} : { reviewFindings: durableUpdated.reviewFindings }),
      },
    });
    // Release only when the adapter carried proof that its owned provider
    // process group stopped. A normalized result without that proof, or an
    // adapter exception, leaves ownership ambiguous and retains the
    // reservation for reconciliation.
    if (executionStopped) {
      releaseActiveModelReservation(options, durableUpdated, completedAt);
    }
    return requireDurableRun(repository.findById(run.id));
  }).immediate;
  return finalize();
}

function appendExecutionUsage(
  options: AgentExecutionServiceOptions,
  run: AgentRunRecord,
  result: AgentExecutionResult,
  recordedAt: string,
  safety: AgentSafetyPolicy
): void {
  if (
    (result.usage === undefined && safety.maxTokens === undefined && safety.maxCost === undefined) ||
    run.modelProviderId === undefined ||
    run.task === undefined
  ) {
    return;
  }
  const modelRepository = createModelRepository(options.db);
  const activeReservation = modelRepository.findActiveRoutingDecisionByRun(run.projectId, run.id);
  const completedMs = Date.parse(recordedAt);
  const startedMs = Date.parse(run.startedAt);
  const elapsedMs = Number.isFinite(completedMs) && Number.isFinite(startedMs)
    ? Math.max(0, completedMs - startedMs)
    : 0;
  const ledger = new UsageLedger(modelRepository, run.projectId, () => recordedAt);
  ledger.append({
    runId: run.id,
    ...(activeReservation === undefined ? {} : { routingDecisionId: activeReservation.decision.id }),
    providerId: run.modelProviderId,
    modelId: run.model,
    task: run.task,
    retryCount: 0,
    elapsedMs,
    outcome: usageOutcome(result.outcome),
    outcomeQuality: result.outcome === 'SUCCEEDED' ? 'good' : 'unknown',
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
    cost: result.usage?.cost,
  });
}

function usageOutcome(outcome: AgentExecutionResult['outcome']):
  'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'unknown' {
  switch (outcome) {
    case 'SUCCEEDED':
      return 'succeeded';
    case 'FAILED':
      return 'failed';
    case 'TIMED_OUT':
      return 'timed_out';
    case 'CANCELLED':
      return 'cancelled';
    case 'NEEDS_HUMAN':
      return 'unknown';
  }
}

function markRunNeedsHuman(
  options: WorkspaceServiceOptions,
  runId: string,
  reason: string,
  createEventId: () => string,
  now: () => string,
  category: AgentFailureCategory = 'stale_run',
  releaseCapacity = true
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
    if (releaseCapacity) releaseActiveModelReservation(options, durableUpdated, timestamp);
    return requireDurableRun(repository.findById(runId));
  }).immediate;
  return apply();
}

/**
 * A provider-capacity reservation belongs to the provider execution attempt.
 * Release it in the same transaction that durably terminalizes or recovers the
 * AGENT run, while retaining the append-only routing decision and telemetry.
 */
function releaseActiveModelReservation(
  options: WorkspaceServiceOptions,
  run: AgentRunRecord,
  releasedAt: string
): boolean {
  const modelRepository = createModelRepository(options.db);
  const active = modelRepository.findActiveRoutingDecisionByRun(
    run.projectId,
    run.id
  );
  if (active === undefined) return false;
  if (
    !active.hasReservation ||
    active.reservationStatus !== 'active' ||
    active.runId !== run.id
  ) {
    throw new Error(`Active routing reservation for run ${run.id} is ambiguous; refusing release`);
  }
  const released = modelRepository.releaseProviderCapacity(
    run.projectId,
    run.id,
    active.decision.id,
    active.decision.providerId,
    active.decision.modelId,
    releasedAt,
    true
  );
  if (!released) {
    throw new Error(`Active routing reservation for run ${run.id} changed before release`);
  }
  return true;
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
        eventTypes: value.evidence.eventTypes.map((eventType) =>
          boundText(redactSensitiveText(eventType), 80)
        ),
        ...(value.evidence.summary === undefined
          ? {}
          : { summary: boundText(redactSensitiveText(value.evidence.summary), 4_096) }),
      };
  const providerSessionId = value.providerSessionId === undefined
    ? undefined
    : redactSensitiveText(value.providerSessionId) === value.providerSessionId
      ? value.providerSessionId
      : undefined;
  return {
    ...value,
    ...(providerSessionId === undefined ? {} : { providerSessionId }),
    ...(value.providerSessionId !== undefined && providerSessionId === undefined
      ? { providerSessionId: undefined }
      : {}),
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
