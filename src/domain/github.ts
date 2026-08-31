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

const usageSchema = z.object({
  runId: identitySchema,
  providerId: identitySchema,
  modelId: identitySchema,
  inputTokens: unknownNumberSchema,
  outputTokens: unknownNumberSchema,
  cost: unknownNumberSchema,
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
  contractRevision: identitySchema,
  executionRunId: identitySchema,
  routingMode: z.union([modelRoutingModeSchema, z.literal('unknown')]),
  implementation: z.array(providerModelSchema).max(32),
  review: z.array(providerModelSchema).max(32),
  repair: z.array(providerModelSchema).max(32),
  fallback: z.array(providerModelSchema).max(32),
  usage: z.array(usageSchema).max(64),
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
  contractRevision: identitySchema,
  executionRunId: identitySchema,
  recordedAt: timestampSchema,
}).strict();
export type GitHubUsageReceiptEvidence = z.infer<typeof githubUsageReceiptEvidenceSchema>;
