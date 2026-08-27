import { z } from 'zod';
import { modelProviderIdSchema } from './model-provider.js';

/** Durable lifecycle states for one provider execution attempt. */
export const AGENT_RUN_STATES = [
  'CREATED',
  'STARTING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'CANCELLED',
  'NEEDS_HUMAN',
] as const;

export type AgentRunState = (typeof AGENT_RUN_STATES)[number];

export const agentRunStateSchema = z.enum(AGENT_RUN_STATES);

export const ACTIVE_AGENT_RUN_STATES: readonly AgentRunState[] = [
  'CREATED',
  'STARTING',
  'RUNNING',
];

export const TERMINAL_AGENT_RUN_STATES: readonly AgentRunState[] = [
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'CANCELLED',
  'NEEDS_HUMAN',
];

export const AGENT_FAILURE_CATEGORIES = [
  'executable_missing',
  'executable_unavailable',
  'non_zero_exit',
  'malformed_output',
  'missing_output',
  'output_limit',
  'timeout',
  'cancelled',
  'unexpected_termination',
  'adapter_error',
  'stale_run',
  'workspace_invalid',
  'persistence_error',
] as const;

export type AgentFailureCategory = (typeof AGENT_FAILURE_CATEGORIES)[number];

export const agentFailureCategorySchema = z.enum(AGENT_FAILURE_CATEGORIES);

/**
 * Deliberately small, provider-neutral evidence. Raw provider event streams
 * remain bounded process output and are never persisted as arbitrary JSON.
 */
export const normalizedAgentEvidenceSchema = z.object({
  outputFormat: z.enum(['json', 'jsonl']),
  eventCount: z.number().int().min(1).max(10_000),
  eventTypes: z.array(z.string().min(1).max(80)).max(64),
  summary: z.string().max(4_096).optional(),
}).strict();

export type NormalizedAgentEvidence = z.infer<typeof normalizedAgentEvidenceSchema>;

export const AGENT_OUTPUT_LIMIT_BYTES = 128 * 1024;
export const AGENT_INSTRUCTIONS_LIMIT_BYTES = 64 * 1024;
export const DEFAULT_AGENT_TIMEOUT_MS = 15 * 60 * 1000;
export const MAX_AGENT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export const agentExecutionResultSchema = z.object({
  outcome: z.enum(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'NEEDS_HUMAN']),
  providerSessionId: z.string().min(1).max(256).optional(),
  providerProcessId: z.number().int().positive().optional(),
  exitCode: z.number().int().optional(),
  terminationSignal: z.string().min(1).max(32).optional(),
  timedOut: z.boolean(),
  cancelled: z.boolean(),
  stdout: z.string().max(AGENT_OUTPUT_LIMIT_BYTES),
  stderr: z.string().max(AGENT_OUTPUT_LIMIT_BYTES),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
  evidence: normalizedAgentEvidenceSchema.optional(),
  failureCategory: agentFailureCategorySchema.optional(),
  failureReason: z.string().min(1).max(2_048).optional(),
}).strict();

const durableIdentity = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const timestampSchema = z.string().datetime();

/** Strict shape used when a run has the AGENT-001 durable metadata. */
export const agentRunRecordSchema = z.object({
  id: durableIdentity,
  projectId: durableIdentity,
  ticketId: durableIdentity,
  workspaceId: durableIdentity,
  workspacePath: z.string().min(1).max(4_096),
  baseSha: shaSchema,
  branchName: z.string().min(1).max(256),
  status: agentRunStateSchema,
  provider: z.string().min(1).max(64),
  /** MODEL-001 identity when this run came from a routed model selection. */
  modelProviderId: modelProviderIdSchema.optional(),
  model: z.string().min(1).max(256),
  createdAt: timestampSchema,
  startedAt: timestampSchema,
  completedAt: timestampSchema.optional(),
  updatedAt: timestampSchema,
  providerSessionId: durableIdentity.optional(),
  providerProcessId: z.number().int().positive().optional(),
  exitCode: z.number().int().optional(),
  terminationSignal: z.string().min(1).max(32).optional(),
  timedOut: z.boolean(),
  cancelled: z.boolean(),
  failureCategory: agentFailureCategorySchema.optional(),
  failureReason: z.string().min(1).max(2_048).optional(),
  stdout: z.string().max(AGENT_OUTPUT_LIMIT_BYTES),
  stderr: z.string().max(AGENT_OUTPUT_LIMIT_BYTES),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
  evidence: normalizedAgentEvidenceSchema.optional(),
  instructionsSha256: z.string().regex(/^[0-9a-f]{64}$/),
  timeoutMs: z.number().int().positive().max(MAX_AGENT_TIMEOUT_MS),
}).strict();

export type AgentRunRecord = z.infer<typeof agentRunRecordSchema>;
