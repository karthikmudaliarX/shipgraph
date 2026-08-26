import { z } from 'zod';

export const MODEL_PROVIDER_IDS = ['opencode-go', 'codex', 'grok', 'gemini'] as const;
export type ModelProviderId = (typeof MODEL_PROVIDER_IDS)[number];
export const modelProviderIdSchema = z.enum(MODEL_PROVIDER_IDS);

export const MODEL_PROVIDER_DEFINITIONS = [
  { providerId: 'opencode-go', family: 'opencode', displayName: 'OpenCode Go' },
  { providerId: 'codex', family: 'openai', displayName: 'Codex' },
  { providerId: 'grok', family: 'xai', displayName: 'Grok' },
  { providerId: 'gemini', family: 'google', displayName: 'Gemini' },
] as const satisfies ReadonlyArray<{
  providerId: ModelProviderId;
  family: string;
  displayName: string;
}>;

export const MODEL_TASK_TYPES = ['implementation', 'review', 'repair'] as const;
export type ModelTaskType = (typeof MODEL_TASK_TYPES)[number];
export const modelTaskTypeSchema = z.enum(MODEL_TASK_TYPES);

export const MODEL_CAPABILITIES = MODEL_TASK_TYPES;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];
export const modelCapabilitySchema = z.enum(MODEL_CAPABILITIES);

export const MODEL_ROUTING_MODES = ['eco', 'balanced', 'max'] as const;
export type ModelRoutingMode = (typeof MODEL_ROUTING_MODES)[number];
export const modelRoutingModeSchema = z.enum(MODEL_ROUTING_MODES);

export const MODEL_RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type ModelRiskLevel = (typeof MODEL_RISK_LEVELS)[number];
export const modelRiskLevelSchema = z.enum(MODEL_RISK_LEVELS);

export const PROVIDER_AVAILABILITIES = [
  'available',
  'unavailable',
  'unknown',
  'disabled',
] as const;
export type ProviderAvailability = (typeof PROVIDER_AVAILABILITIES)[number];
export const providerAvailabilitySchema = z.enum(PROVIDER_AVAILABILITIES);

export const PROVIDER_HEALTH_STATUSES = [
  'healthy',
  'degraded',
  'unavailable',
  'unknown',
] as const;
export type ProviderHealthStatus = (typeof PROVIDER_HEALTH_STATUSES)[number];
export const providerHealthStatusSchema = z.enum(PROVIDER_HEALTH_STATUSES);

export const PROVIDER_AUTH_STATUSES = [
  'authenticated',
  'unauthenticated',
  'unknown',
] as const;
export type ProviderAuthStatus = (typeof PROVIDER_AUTH_STATUSES)[number];
export const providerAuthStatusSchema = z.enum(PROVIDER_AUTH_STATUSES);

export const QUOTA_PRESSURES = ['low', 'medium', 'high', 'unknown'] as const;
export type QuotaPressure = (typeof QUOTA_PRESSURES)[number];
export const quotaPressureSchema = z.enum(QUOTA_PRESSURES);

export const UNKNOWN = 'unknown' as const;
export type UnknownValue = typeof UNKNOWN;
export type KnownNumber = number | UnknownValue;
export type KnownTimestamp = string | UnknownValue;

const identitySchema = z.string().min(1).max(256);
const modelIdentifierSchema = identitySchema.refine((value) => !value.includes('\0'), {
  message: 'model identifiers cannot contain NUL characters',
});
const timestampSchema = z.string().datetime();
export const unknownNumberSchema = z.union([
  z.number().finite().nonnegative(),
  z.literal(UNKNOWN),
]);
export const unknownIntegerSchema = z.union([
  z.number().int().nonnegative(),
  z.literal(UNKNOWN),
]);
export const unknownTimestampSchema = z.union([timestampSchema, z.literal(UNKNOWN)]);

export const providerRegistryRecordSchema = z.object({
  projectId: identitySchema,
  providerId: modelProviderIdSchema,
  family: identitySchema,
  displayName: z.string().min(1).max(128),
  configured: z.boolean(),
  availability: providerAvailabilitySchema,
  version: z.string().min(1).max(256).optional(),
  capabilities: z.array(modelCapabilitySchema).max(16),
  catalogStatus: z.enum(['known', UNKNOWN]),
  catalogReason: z.string().min(1).max(2_048).optional(),
  checkedAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
export type ProviderRegistryRecord = z.infer<typeof providerRegistryRecordSchema>;

export const modelCatalogRecordSchema = z.object({
  projectId: identitySchema,
  providerId: modelProviderIdSchema,
  modelId: modelIdentifierSchema,
  capabilities: z.array(modelCapabilitySchema).max(16),
  contextWindow: z.number().int().positive().max(10_000_000).optional(),
  discoveredAt: timestampSchema,
}).strict();
export type ModelCatalogRecord = z.infer<typeof modelCatalogRecordSchema>;

export const providerHealthRecordSchema = z.object({
  projectId: identitySchema,
  providerId: modelProviderIdSchema,
  status: providerHealthStatusSchema,
  auth: providerAuthStatusSchema,
  quotaPressure: quotaPressureSchema,
  quotaRemaining: unknownNumberSchema,
  quotaResetAt: unknownTimestampSchema,
  recentFailureCount: z.number().int().nonnegative().max(1_000_000),
  activeRuns: z.number().int().nonnegative().max(1_000_000),
  maxConcurrentRuns: unknownIntegerSchema,
  lastFailureAt: timestampSchema.optional(),
  lastSuccessAt: timestampSchema.optional(),
  checkedAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
export type ProviderHealthRecord = z.infer<typeof providerHealthRecordSchema>;

export const OUTCOME_VALUES = [
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  UNKNOWN,
] as const;
export type ModelOutcome = (typeof OUTCOME_VALUES)[number];
export const modelOutcomeSchema = z.enum(OUTCOME_VALUES);

export const OUTCOME_QUALITIES = ['excellent', 'good', 'poor', UNKNOWN] as const;
export type OutcomeQuality = (typeof OUTCOME_QUALITIES)[number];
export const outcomeQualitySchema = z.enum(OUTCOME_QUALITIES);

export const usageLedgerRecordSchema = z.object({
  id: identitySchema,
  projectId: identitySchema,
  runId: identitySchema,
  routingDecisionId: identitySchema.optional(),
  providerId: modelProviderIdSchema,
  modelId: modelIdentifierSchema,
  task: modelTaskTypeSchema,
  retryCount: z.number().int().nonnegative().max(1_000_000),
  elapsedMs: z.number().int().nonnegative().max(31_536_000_000),
  outcome: modelOutcomeSchema,
  outcomeQuality: outcomeQualitySchema,
  inputTokens: unknownIntegerSchema,
  outputTokens: unknownIntegerSchema,
  cost: unknownNumberSchema,
  quotaRemaining: unknownNumberSchema,
  recordedAt: timestampSchema,
}).strict();
export type UsageLedgerRecord = z.infer<typeof usageLedgerRecordSchema>;

/** A scheduler-supplied snapshot; MODEL-001 never claims global ticket slots. */
export const executionEnvelopeSchema = z.object({
  mode: modelRoutingModeSchema,
  maxConcurrentTickets: unknownIntegerSchema,
  activeConcurrentTickets: unknownIntegerSchema,
  budgetRemaining: unknownNumberSchema,
}).strict();
export type ExecutionEnvelope = z.infer<typeof executionEnvelopeSchema>;

export const modelRoutingRequestSchema = z.object({
  requestId: identitySchema.optional(),
  runId: identitySchema.optional(),
  task: modelTaskTypeSchema,
  risk: modelRiskLevelSchema,
  envelope: executionEnvelopeSchema,
  implementationProvider: modelProviderIdSchema.optional(),
  excludeProviders: z.array(modelProviderIdSchema).max(MODEL_PROVIDER_IDS.length).optional(),
  fallbackFromProvider: modelProviderIdSchema.optional(),
  now: timestampSchema.optional(),
}).strict();
export type ModelRoutingRequest = z.infer<typeof modelRoutingRequestSchema>;

export const modelRoutingDecisionSchema = z.object({
  id: identitySchema,
  projectId: identitySchema,
  requestId: identitySchema,
  task: modelTaskTypeSchema,
  risk: modelRiskLevelSchema,
  mode: modelRoutingModeSchema,
  providerId: modelProviderIdSchema,
  providerFamily: identitySchema,
  modelId: modelIdentifierSchema,
  reason: z.string().min(1).max(4_096),
  candidatesConsidered: z.number().int().nonnegative().max(1_000_000),
  createdAt: timestampSchema,
}).strict();
export type ModelRoutingDecision = z.infer<typeof modelRoutingDecisionSchema>;
export type ModelRoutingSelection = Omit<
  ModelRoutingDecision,
  'id' | 'projectId' | 'requestId' | 'createdAt'
>;

export type ModelRoutingSnapshot = {
  providers: readonly ProviderRegistryRecord[];
  models: readonly ModelCatalogRecord[];
  health: readonly ProviderHealthRecord[];
  usage: readonly UsageLedgerRecord[];
};

export type ProviderSnapshot = {
  providerId: ModelProviderId;
  family: string;
  displayName: string;
  configured: boolean;
  availability: ProviderAvailability;
  auth: ProviderAuthStatus;
  version?: string;
  capabilities: readonly ModelCapability[];
  catalogStatus: 'known' | UnknownValue;
  catalogReason?: string;
  checkedAt: string;
  updatedAt: string;
  health: ProviderHealthRecord;
};

export function isKnownNumber(value: KnownNumber): value is number {
  return value !== UNKNOWN;
}

export function isKnownTimestamp(value: KnownTimestamp): value is string {
  return value !== UNKNOWN;
}

export function providerDefinition(providerId: ModelProviderId): (typeof MODEL_PROVIDER_DEFINITIONS)[number] {
  const definition = MODEL_PROVIDER_DEFINITIONS.find((entry) => entry.providerId === providerId);
  if (!definition) throw new Error(`Unknown model provider: ${providerId}`);
  return definition;
}

export function normalizeModelProviderId(value: string): ModelProviderId {
  if (value === 'opencode') return 'opencode-go';
  const parsed = modelProviderIdSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Unsupported model provider: ${value}`);
  return parsed.data;
}
