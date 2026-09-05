import { z } from 'zod';
import { modelProviderIdSchema, modelTaskTypeSchema } from './model-provider.js';

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
  'safety_limit',
  'approval_required',
  'scope_growth',
] as const;

export type AgentFailureCategory = (typeof AGENT_FAILURE_CATEGORIES)[number];

export const agentFailureCategorySchema = z.enum(AGENT_FAILURE_CATEGORIES);

export const REVIEW_TYPES = ['contract', 'engineering'] as const;
export type ReviewType = (typeof REVIEW_TYPES)[number];
export const reviewTypeSchema = z.enum(REVIEW_TYPES);

export const REVIEW_RESULTS = ['PASS', 'FAIL'] as const;
export type ReviewResult = (typeof REVIEW_RESULTS)[number];
export const reviewResultSchema = z.enum(REVIEW_RESULTS);

/** Strict provider-output validation for KAR-9; this is not the KAR-12 Ticket Contract. */
export const reviewOutputSchema = z.object({
  result: reviewResultSchema,
  findings: z.array(z.string().min(1).max(2_048)).max(100),
}).strict().superRefine((report, context) => {
  if (report.result === 'PASS' && report.findings.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['findings'],
      message: 'PASS reports must not contain findings',
    });
  }
});

export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

/**
 * Deliberately small, provider-neutral evidence. Raw provider event streams
 * remain bounded process output and are never persisted as arbitrary JSON.
 */
export const normalizedAgentEvidenceSchema = z.object({
  outputFormat: z.enum(['json', 'jsonl']),
  // The count describes the drained stream, not only the retained prefix.
  eventCount: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  eventTypes: z.array(z.string().min(1).max(80)).max(64),
  summary: z.string().max(4_096).optional(),
}).strict();

export type NormalizedAgentEvidence = z.infer<typeof normalizedAgentEvidenceSchema>;

export const agentExecutionUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cost: z.number().finite().nonnegative().optional(),
}).strict();

export type AgentExecutionUsage = z.infer<typeof agentExecutionUsageSchema>;

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
  /** Concrete command adapters must prove their owned process group stopped. */
  processGroupStopped: z.boolean().optional(),
  stdout: z.string().max(AGENT_OUTPUT_LIMIT_BYTES),
  stderr: z.string().max(AGENT_OUTPUT_LIMIT_BYTES),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
  evidence: normalizedAgentEvidenceSchema.optional(),
  usage: agentExecutionUsageSchema.optional(),
  reviewResult: reviewResultSchema.optional(),
  reviewFindings: z.array(z.string().min(1).max(2_048)).max(100).optional(),
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
  /** The MODEL-001 task this durable run was prepared to perform. */
  task: modelTaskTypeSchema.optional(),
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
  /** Canonical digest of the effective KAR-7 policy bound at preparation. */
  safetyPolicySha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** KAR-9 review axis, present only for a pre-PR review run. */
  reviewType: reviewTypeSchema.optional(),
  /** Exact local commit reviewed by a KAR-9 review run. */
  reviewedSha: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/).optional(),
  /** KAR-11 contract provenance bound to a newly produced KAR-9 review. */
  reviewContractDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  reviewContractSource: z.string().min(1).max(4_096).optional(),
  reviewContractRevision: z.string().min(1).max(256).optional(),
  /** KAR-12 contract provenance shared by every run in one execution. */
  executionId: durableIdentity.optional(),
  contractDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  contractSource: z.string().min(1).max(4_096).optional(),
  contractRevision: z.string().min(1).max(256).optional(),
  reviewResult: reviewResultSchema.optional(),
  reviewFindings: z.array(z.string().min(1).max(2_048)).max(100).optional(),
  timeoutMs: z.number().int().positive().max(MAX_AGENT_TIMEOUT_MS),
}).strict().superRefine((run, context) => {
  const contractFields = [run.executionId, run.contractDigest, run.contractSource, run.contractRevision];
  if (contractFields.some((field) => field !== undefined) && contractFields.some((field) => field === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['executionId'],
      message: 'KAR-12 execution contract provenance must be complete',
    });
  }
});

export type AgentRunRecord = z.infer<typeof agentRunRecordSchema>;
