import { z } from 'zod';

const shaSchema = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);

export const repairVerificationObservationSchema = z.object({
  command: z.string().min(1).max(4_096),
  sha: shaSchema,
  exitCode: z.number().int(),
  stdout: z.string().max(4_096),
  stderr: z.string().max(4_096),
}).strict();

export const repairBlockerSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('verification'),
    command: z.string().min(1).max(4_096),
    expected: z.string().min(1).max(2_048),
    actual: z.string().min(1).max(4_096),
  }).strict(),
  z.object({
    source: z.literal('contract_review'),
    findings: z.array(z.string().min(1).max(2_048)).min(1).max(100),
  }).strict(),
  z.object({
    source: z.literal('engineering_review'),
    findings: z.array(z.string().min(1).max(2_048)).min(1).max(100),
  }).strict(),
]);

export const redCapableEvidenceSchema = z.object({
  command: z.string().min(1).max(4_096),
  expectedSymptom: z.string().min(1).max(2_048),
  before: repairVerificationObservationSchema,
  after: repairVerificationObservationSchema.optional(),
}).strict();

export const REPAIR_ATTEMPT_OUTCOMES = ['PASSED', 'REPAIRED', 'BLOCKED', 'NEEDS_HUMAN'] as const;
export const repairAttemptOutcomeSchema = z.enum(REPAIR_ATTEMPT_OUTCOMES);

export const repairReviewEvidenceSchema = z.object({
  reviewedSha: shaSchema,
  contract: z.enum(['PASS', 'FAIL']),
  engineering: z.enum(['PASS', 'FAIL']),
}).strict();

export const repairAttemptEvidenceSchema = z.object({
  ticketId: z.string().min(1),
  executionId: z.string().min(1).max(256).optional(),
  contractDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  contractSource: z.string().min(1).max(4_096).optional(),
  contractRevision: z.string().min(1).max(256).optional(),
  attempt: z.number().int().nonnegative().max(100),
  candidateSha: shaSchema,
  resultingSha: shaSchema.optional(),
  repairRunId: z.string().min(1).max(256).optional(),
  // A verification command and each review finding may be retained as a
  // separate durable blocker. The producer bounds each source at 100.
  blockers: z.array(repairBlockerSchema).max(302),
  targetedVerification: z.array(repairVerificationObservationSchema).max(100),
  finalVerification: z.array(repairVerificationObservationSchema).max(100).optional(),
  reviews: repairReviewEvidenceSchema.optional(),
  redCapableEvidence: z.array(redCapableEvidenceSchema).max(100),
  redInfeasibilityReason: z.string().min(1).max(2_048).optional(),
  outcome: repairAttemptOutcomeSchema,
  reason: z.string().min(1).max(2_048).optional(),
}).strict().superRefine((evidence, context) => {
  const fields = [evidence.executionId, evidence.contractDigest, evidence.contractSource, evidence.contractRevision];
  if (fields.some((field) => field !== undefined) && fields.some((field) => field === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['executionId'], message: 'execution contract provenance must be complete' });
  }
});

export type RepairVerificationObservation = z.infer<typeof repairVerificationObservationSchema>;
export type RepairBlocker = z.infer<typeof repairBlockerSchema>;
export type RedCapableEvidence = z.infer<typeof redCapableEvidenceSchema>;
export type RepairAttemptEvidence = z.infer<typeof repairAttemptEvidenceSchema>;
