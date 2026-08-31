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
  readySha: shaSchema,
  result: readinessResultSchema,
  contractDigest: z.string().regex(/^[0-9a-f]{64}$/),
  contractSource: z.string().min(1).max(4_096),
  contractRevision: z.string().min(1).max(256),
  verificationEventId: z.string().uuid().optional(),
  contractReviewRunId: z.string().min(1).max(256).optional(),
  engineeringReviewRunId: z.string().min(1).max(256).optional(),
  repairEvidenceEventId: z.string().uuid().optional(),
  repairOccurred: z.boolean(),
  redEvidenceStatus: readinessRedEvidenceStatusSchema,
  redInfeasibilityReason: z.string().min(1).max(2_048).optional(),
  safetyGateStatus: readinessSafetyStatusSchema,
  safetyRunIds: z.array(z.string().min(1).max(256)).max(100),
  reason: z.string().min(1).max(2_048).optional(),
}).strict();

export type ReadinessEvidence = z.infer<typeof readinessEvidenceSchema>;
