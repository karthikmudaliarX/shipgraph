import { createHash } from 'node:crypto';
import { z } from 'zod';

const boundedText = z.string().min(1).max(8_192);
const boundedList = z.array(z.string().min(1).max(4_096)).max(100);

/** KAR-12's behavioral contract. Implementation recipes are intentionally not valid. */
export const behavioralTicketContractSchema = z.object({
  summary: boundedText,
  currentBehavior: boundedText,
  desiredBehavior: boundedText,
  acceptanceCriteria: boundedList,
  outOfScope: boundedList,
  keyInterfaces: boundedList.optional(),
}).strict();

export type BehavioralTicketContract = z.infer<typeof behavioralTicketContractSchema>;

export type ExecutionContractProvenance = {
  contractDigest: string;
  contractSource: string;
  contractRevision: string;
};

const provenanceSource = z.string().min(1).max(4_096);
const provenanceRevision = z.string().min(1).max(256);

export const executionContractProvenanceSchema = z.object({
  contractDigest: z.string().regex(/^[0-9a-f]{64}$/),
  contractSource: provenanceSource,
  contractRevision: provenanceRevision,
}).strict();

/** Hash only the behavioral contract, in a fixed-key canonical representation. */
export function deriveBehavioralContractProvenance(
  contractInput: unknown,
  contractSource: string,
  contractRevision: string
): ExecutionContractProvenance {
  const contract = behavioralTicketContractSchema.parse(contractInput);
  if (contractSource.length === 0 || contractRevision.length === 0) {
    throw new Error('Behavioral contract provenance requires a source and revision');
  }
  const canonical = {
    summary: contract.summary,
    currentBehavior: contract.currentBehavior,
    desiredBehavior: contract.desiredBehavior,
    acceptanceCriteria: [...contract.acceptanceCriteria],
    outOfScope: [...contract.outOfScope],
    ...(contract.keyInterfaces === undefined ? {} : { keyInterfaces: [...contract.keyInterfaces] }),
  };
  return {
    contractDigest: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
    contractSource: provenanceSource.parse(contractSource),
    contractRevision: provenanceRevision.parse(contractRevision),
  };
}

export const executionOutcomes = [
  'PR_RAISED',
  'BLOCKED',
  'NEEDS_HUMAN',
  'FAILED',
  'BUDGET_EXHAUSTED',
] as const;
export const executionOutcomeSchema = z.enum(executionOutcomes);
export type ExecutionOutcome = z.infer<typeof executionOutcomeSchema>;

const identity = z.string().min(1).max(256);
const sha = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);

/** Compact durable identity/evidence for one EXEC-001 operation. */
export const executionEvidenceSchema = z.object({
  executionId: identity,
  ticketId: identity,
  outcome: executionOutcomeSchema,
  ...executionContractProvenanceSchema.shape,
  workspaceId: identity.optional(),
  workspacePath: z.string().min(1).max(4_096).optional(),
  implementationRunId: identity.optional(),
  finalVerificationEventId: z.string().uuid().optional(),
  contractReviewRunId: identity.optional(),
  engineeringReviewRunId: identity.optional(),
  readinessEventId: z.string().uuid().optional(),
  githubPrEvidenceEventId: z.string().uuid().optional(),
  githubUsageReceiptEvidenceEventId: z.string().uuid().optional(),
  prNumber: z.number().int().positive().optional(),
  prUrl: z.string().url().max(2_048).optional(),
  submittedHeadSha: sha.optional(),
  attempts: z.number().int().nonnegative().optional(),
  // At most four provider attempts can back each implementation, review, or
  // repair run. This covers the configured 100 logical repair iterations
  // without making the root evidence carry provider telemetry itself.
  usageRunIds: z.array(identity).max(2_048).optional(),
  reason: z.string().min(1).max(2_048).optional(),
  recordedAt: z.string().datetime(),
}).strict().superRefine((evidence, context) => {
  if (evidence.outcome === 'PR_RAISED') {
    for (const field of [
      'workspaceId',
      'workspacePath',
      'implementationRunId',
      'contractReviewRunId',
      'engineeringReviewRunId',
      'readinessEventId',
      'githubPrEvidenceEventId',
      'githubUsageReceiptEvidenceEventId',
      'prNumber',
      'prUrl',
      'submittedHeadSha',
    ] as const) {
      if (evidence[field] === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `PR_RAISED evidence requires ${field}` });
      }
    }
  } else if (evidence.reason === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'non-success evidence requires a reason' });
  }
});

export type ExecutionEvidence = z.infer<typeof executionEvidenceSchema>;

export const executionContractBoundPayloadSchema = z.object({
  executionId: identity,
  ticketId: identity,
  contract: behavioralTicketContractSchema,
  ...executionContractProvenanceSchema.shape,
  recordedAt: z.string().datetime(),
}).strict();

export const executionStartedPayloadSchema = z.object({
  executionId: identity,
  ticketId: identity,
  ...executionContractProvenanceSchema.shape,
  workspaceId: identity.optional(),
  recordedAt: z.string().datetime(),
}).strict();

export const executionTerminalPayloadSchema = executionEvidenceSchema;

export type ExecutionContractBoundPayload = z.infer<typeof executionContractBoundPayloadSchema>;
export type ExecutionStartedPayload = z.infer<typeof executionStartedPayloadSchema>;
export type ExecutionTerminalPayload = z.infer<typeof executionTerminalPayloadSchema>;
