import { z } from 'zod';
import {
  modelRoutingModeSchema,
  providerAuthStatusSchema,
  providerHealthStatusSchema,
  quotaPressureSchema,
  unknownNumberSchema,
} from './model-provider.js';

const shaSchema = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);
const identitySchema = z.string().min(1).max(256);
const repositorySchema = z.string().regex(/^[^/\s]+\/[^/\s]+$/);
const timestampSchema = z.string().datetime();

export const githubPrEvidenceSchema = z.object({
  ticketId: identitySchema,
  prNumber: z.number().int().positive(),
  prUrl: z.string().url().max(2_048),
  repository: repositorySchema,
  baseBranch: identitySchema,
  headBranch: identitySchema,
  submittedHeadSha: shaSchema,
  readinessEventId: z.string().uuid(),
  contractDigest: z.string().regex(/^[0-9a-f]{64}$/),
  contractSource: z.string().min(1).max(4_096),
  contractRevision: z.string().min(1).max(256),
  recordedAt: timestampSchema,
}).strict();
export type GitHubPrEvidence = z.infer<typeof githubPrEvidenceSchema>;

const providerModelSchema = z.object({
  providerId: identitySchema,
  modelId: identitySchema,
}).strict();

// One implementation plus two review axes per initial/repair cycle plus the
// repair runs, with at most four current MODEL-001 providers per route.
const MAX_PROVIDER_MODEL_IDENTITIES = (1 + (2 * (100 + 1)) + 100) * 4;

const providerModelSummarySchema = z.object({
  distinctCount: z.number().int().nonnegative(),
  identities: z.array(providerModelSchema).max(MAX_PROVIDER_MODEL_IDENTITIES),
  omittedCount: z.number().int().nonnegative(),
  identitiesDigest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict().superRefine((summary, context) => {
  if (summary.identities.length + summary.omittedCount !== summary.distinctCount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'provider/model summary counts do not match its identities',
    });
  }
});

const providerModelSectionSchema = z.union([
  z.array(providerModelSchema).max(MAX_PROVIDER_MODEL_IDENTITIES),
  providerModelSummarySchema,
]);

const usageMetricSchema = z.object({
  knownTotal: unknownNumberSchema,
  unknownRuns: z.number().int().nonnegative(),
}).strict();

const usageSummarySchema = z.object({
  runCount: z.number().int().nonnegative(),
  measuredRunCount: z.number().int().nonnegative(),
  unknownRunCount: z.number().int().nonnegative(),
  inputTokens: usageMetricSchema,
  outputTokens: usageMetricSchema,
  cost: usageMetricSchema,
}).strict();

const providerHealthSchema = z.object({
  providerId: identitySchema,
  status: providerHealthStatusSchema,
  auth: providerAuthStatusSchema,
  quotaPressure: quotaPressureSchema,
}).strict();

export const githubUsageReceiptSchema = z.object({
  version: z.literal(1),
  ticketId: identitySchema,
  headSha: shaSchema,
  contractDigest: z.string().regex(/^[0-9a-f]{64}$/),
  // Added by KAR-12; optional here so older durable receipt evidence remains
  // readable. New evidence includes the source.
  contractSource: z.string().min(1).max(4_096).optional(),
  contractRevision: identitySchema,
  executionRunId: identitySchema,
  routingMode: z.union([modelRoutingModeSchema, z.literal('unknown')]),
  implementation: providerModelSectionSchema,
  review: providerModelSectionSchema,
  repair: providerModelSectionSchema,
  fallback: providerModelSectionSchema,
  usage: usageSummarySchema,
  providerHealth: z.array(providerHealthSchema).max(32),
}).strict();
export type GitHubUsageReceipt = z.infer<typeof githubUsageReceiptSchema>;

export const githubUsageReceiptEvidenceSchema = z.object({
  ticketId: identitySchema,
  prNumber: z.number().int().positive(),
  receiptVersion: z.literal(1),
  submittedHeadSha: shaSchema,
  commentId: identitySchema,
  commentUrl: z.string().url().max(2_048).optional(),
  contractDigest: z.string().regex(/^[0-9a-f]{64}$/),
  // Added by KAR-12; optional here so older durable receipt evidence remains
  // readable. New evidence includes the source.
  contractSource: z.string().min(1).max(4_096).optional(),
  contractRevision: identitySchema,
  executionRunId: identitySchema,
  recordedAt: timestampSchema,
}).strict();
export type GitHubUsageReceiptEvidence = z.infer<typeof githubUsageReceiptEvidenceSchema>;
