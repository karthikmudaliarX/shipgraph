import { z } from 'zod';

const shaSchema = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);

export const READINESS_RESULTS = ['PASS', 'FAIL'] as const;
export const readinessResultSchema = z.enum(READINESS_RESULTS);

export const readinessRedEvidenceStatusSchema = z.enum([
  'not_applicable',
  'present',
  'infeasible',
  'missing',
]);

export const readinessSafetyStatusSchema = z.enum(['satisfied', 'blocked', 'unknown']);

/** Compact append-only evidence for one KAR-11 evaluation. */
export const readinessEvidenceSchema = z.object({
  ticketId: z.string().min(1).max(256),
  readySha: shaSchema.optional(),
  result: readinessResultSchema,
  contractDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  contractSource: z.string().min(1).max(4_096).optional(),
  contractRevision: z.string().min(1).max(256).optional(),
  verificationEventId: z.string().uuid().optional(),
  contractReviewRunId: z.string().min(1).max(256).optional(),
  engineeringReviewRunId: z.string().min(1).max(256).optional(),
  repairEvidenceEventId: z.string().uuid().optional(),
  repairOccurred: z.boolean().optional(),
  redEvidenceStatus: readinessRedEvidenceStatusSchema.optional(),
  redInfeasibilityReason: z.string().min(1).max(2_048).optional(),
  safetyGateStatus: readinessSafetyStatusSchema.optional(),
  safetyRunIds: z.array(z.string().min(1).max(256)).max(100).optional(),
  reason: z.string().min(1).max(2_048).optional(),
}).strict().superRefine((evidence, context) => {
  if (evidence.result === 'FAIL') {
    if (evidence.reason === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'FAIL readiness evidence requires a reason' });
    }
    return;
  }
  for (const field of [
    'readySha',
    'contractDigest',
    'contractSource',
    'contractRevision',
    'repairOccurred',
    'redEvidenceStatus',
    'safetyGateStatus',
    'safetyRunIds',
  ] as const) {
    if (evidence[field] === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `PASS readiness evidence requires ${field}` });
    }
  }
});

export type ReadinessEvidence = z.infer<typeof readinessEvidenceSchema>;
