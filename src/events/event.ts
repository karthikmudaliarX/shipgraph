import { z } from 'zod';
import {
  TicketState,
  type TicketStateValue,
} from '../core/state-machine/state.js';
import {
  agentRunStateSchema,
  normalizedAgentEvidenceSchema,
  reviewResultSchema,
  reviewTypeSchema,
} from '../domain/agent-run.js';
import { modelProviderIdSchema, modelTaskTypeSchema } from '../domain/model-provider.js';
import { repairAttemptEvidenceSchema } from '../domain/repair.js';
import { readinessEvidenceSchema } from '../domain/readiness.js';
import {
  githubPrEvidenceSchema,
  githubUsageReceiptEvidenceSchema,
} from '../domain/github.js';
import {
  executionContractBoundPayloadSchema,
  executionOutcomeSchema,
  executionStartedPayloadSchema,
  executionTerminalPayloadSchema,
} from '../domain/execution.js';

/** Core event types for the append-only audit log. */
export const EVENT_TYPES = [
  'project.initialized',
  'ticket.created',
  'ticket.state_changed',
  'ticket.suggested',
  'run.created',
  'run.completed',
  'workspace.creating',
  'workspace.ready',
  'workspace.removed',
  'workspace.failed',
  'run.state_changed',
  'repair.attempt_recorded',
  'pre_pr_readiness.recorded',
  'github.pr_recorded',
  'github.usage_receipt_recorded',
  'execution.contract_bound',
  'execution.started',
  'execution.terminal',
  'dispatch.claimed',
  'dispatch.completed',
] as const;

export const EventType = {
  PROJECT_INITIALIZED: EVENT_TYPES[0],
  TICKET_CREATED: EVENT_TYPES[1],
  TICKET_STATE_CHANGED: EVENT_TYPES[2],
  TICKET_SUGGESTED: EVENT_TYPES[3],
  RUN_CREATED: EVENT_TYPES[4],
  RUN_COMPLETED: EVENT_TYPES[5],
  WORKSPACE_CREATING: EVENT_TYPES[6],
  WORKSPACE_READY: EVENT_TYPES[7],
  WORKSPACE_REMOVED: EVENT_TYPES[8],
  WORKSPACE_FAILED: EVENT_TYPES[9],
  RUN_STATE_CHANGED: EVENT_TYPES[10],
  REPAIR_ATTEMPT_RECORDED: EVENT_TYPES[11],
  PRE_PR_READINESS_RECORDED: EVENT_TYPES[12],
  GITHUB_PR_RECORDED: EVENT_TYPES[13],
  GITHUB_USAGE_RECEIPT_RECORDED: EVENT_TYPES[14],
  EXECUTION_CONTRACT_BOUND: EVENT_TYPES[15],
  EXECUTION_STARTED: EVENT_TYPES[16],
  EXECUTION_TERMINAL: EVENT_TYPES[17],
  DISPATCH_CLAIMED: EVENT_TYPES[18],
  DISPATCH_COMPLETED: EVENT_TYPES[19],
} as const;

export type EventTypeValue = (typeof EVENT_TYPES)[number];

const identitySchema = z.string().min(1);
const timestampSchema = z.string().datetime();
const ticketStateSchema = z.enum(
  Object.values(TicketState) as [TicketStateValue, ...TicketStateValue[]]
);

export const projectInitializedPayloadSchema = z.object({
  projectId: identitySchema,
  name: z.string().min(1),
  repository: z.string().min(1),
  defaultBranch: z.string().min(1),
}).strict();

export const ticketCreatedPayloadSchema = z.object({
  ticketId: identitySchema,
  title: z.string().min(1),
  priority: z.string().min(1),
  dependsOn: z.array(identitySchema),
}).strict();

export const ticketStateChangedPayloadSchema = z.object({
  ticketId: identitySchema,
  previous: ticketStateSchema,
  next: ticketStateSchema,
  reason: z.string().min(1).optional(),
}).strict();

export const ticketSuggestedPayloadSchema = z.object({
  suggestionId: identitySchema,
  title: z.string().min(1),
  reason: z.string().min(1),
}).strict();

export const runCreatedPayloadSchema = z.object({
  runId: identitySchema,
  ticketId: identitySchema,
  baseSha: z.string().min(1),
  state: agentRunStateSchema.optional(),
  workspaceId: identitySchema.optional(),
  workspacePath: z.string().min(1).optional(),
  branchName: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  modelProviderId: modelProviderIdSchema.optional(),
  task: modelTaskTypeSchema.optional(),
  model: z.string().min(1).optional(),
  createdAt: timestampSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
  instructionsSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  safetyPolicySha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  reviewType: reviewTypeSchema.optional(),
  reviewedSha: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/).optional(),
  reviewContractDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  reviewContractSource: z.string().min(1).max(4_096).optional(),
  reviewContractRevision: z.string().min(1).max(256).optional(),
  executionId: z.string().min(1).max(256).optional(),
  contractDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  contractSource: z.string().min(1).max(4_096).optional(),
  contractRevision: z.string().min(1).max(256).optional(),
}).strict();

export const runCompletedPayloadSchema = z.object({
  runId: identitySchema,
  ticketId: identitySchema,
  status: z.string().min(1),
  completedAt: timestampSchema,
  providerSessionId: identitySchema.optional(),
  providerProcessId: z.number().int().positive().optional(),
  exitCode: z.number().int().optional(),
  terminationSignal: z.string().min(1).optional(),
  timedOut: z.boolean().optional(),
  cancelled: z.boolean().optional(),
  failureCategory: z.string().min(1).optional(),
  failureReason: z.string().min(1).optional(),
  evidence: normalizedAgentEvidenceSchema.optional(),
  reviewType: reviewTypeSchema.optional(),
  reviewedSha: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/).optional(),
  reviewContractDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  reviewContractSource: z.string().min(1).max(4_096).optional(),
  reviewContractRevision: z.string().min(1).max(256).optional(),
  executionId: z.string().min(1).max(256).optional(),
  contractDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  contractSource: z.string().min(1).max(4_096).optional(),
  contractRevision: z.string().min(1).max(256).optional(),
  reviewResult: reviewResultSchema.optional(),
  reviewFindings: z.array(z.string().min(1).max(2_048)).max(100).optional(),
}).strict();

export const runStateChangedPayloadSchema = z.object({
  runId: identitySchema,
  ticketId: identitySchema,
  previous: agentRunStateSchema.optional(),
  next: agentRunStateSchema,
  reason: z.string().min(1).optional(),
}).strict();

const workspaceIdentityShape = {
  workspaceId: identitySchema,
  ticketId: identitySchema,
  baseSha: z.string().min(1),
  branchName: z.string().min(1),
  worktreePath: z.string().min(1),
};

export const workspaceCreatingPayloadSchema = z.object({
  ...workspaceIdentityShape,
}).strict();

export const workspaceReadyPayloadSchema = z.object({
  ...workspaceIdentityShape,
}).strict();

export const workspaceRemovedPayloadSchema = z.object({
  ...workspaceIdentityShape,
  reason: z.string().min(1).optional(),
  branchRetained: z.boolean().optional(),
}).strict();

export const workspaceFailedPayloadSchema = z.object({
  ...workspaceIdentityShape,
  reason: z.string().min(1),
  escalatedToHuman: z.boolean().optional(),
}).strict();

export const dispatchClaimedPayloadSchema = z.object({
  claimId: z.string().uuid(),
  ticketId: identitySchema,
  linearIssueId: identitySchema,
  linearIdentifier: identitySchema,
  linearDeliveryId: z.string().uuid(),
  linearProjectId: identitySchema,
  claimedAt: timestampSchema,
}).strict();

export const dispatchCompletedPayloadSchema = z.object({
  claimId: z.string().uuid(),
  ticketId: identitySchema,
  outcome: executionOutcomeSchema,
  completedAt: timestampSchema,
}).strict();

const baseEnvelopeShape = {
  id: z.string().uuid(),
  sequence: z.number().int().positive(),
  timestamp: timestampSchema,
  projectId: identitySchema,
};

const eventUnionSchema = z.discriminatedUnion('type', [
  z.object({
    ...baseEnvelopeShape,
    type: z.literal(EventType.PROJECT_INITIALIZED),
    payload: projectInitializedPayloadSchema,
  }).strict(),
  z.object({
    ...baseEnvelopeShape,
    ticketId: identitySchema,
    type: z.literal(EventType.TICKET_CREATED),
    payload: ticketCreatedPayloadSchema,
  }).strict(),
  z.object({
    ...baseEnvelopeShape,
    ticketId: identitySchema,
    type: z.literal(EventType.TICKET_STATE_CHANGED),
    payload: ticketStateChangedPayloadSchema,
  }).strict(),
  z.object({
    ...baseEnvelopeShape,
    type: z.literal(EventType.TICKET_SUGGESTED),
    payload: ticketSuggestedPayloadSchema,
  }).strict(),
  z.object({
    ...baseEnvelopeShape,
    ticketId: identitySchema,
    runId: identitySchema,
    type: z.literal(EventType.RUN_CREATED),
    payload: runCreatedPayloadSchema,
  }).strict(),
  z.object({
    ...baseEnvelopeShape,
    ticketId: identitySchema,
    runId: identitySchema,
    type: z.literal(EventType.RUN_COMPLETED),
    payload: runCompletedPayloadSchema,
  }).strict(),
  z.object({
    ...baseEnvelopeShape,
    ticketId: identitySchema,
    type: z.literal(EventType.WORKSPACE_CREATING),
    payload: workspaceCreatingPayloadSchema,
  }).strict(),
  z.object({
    ...baseEnvelopeShape,
    ticketId: identitySchema,
    type: z.literal(EventType.WORKSPACE_READY),
    payload: workspaceReadyPayloadSchema,
  }).strict(),
  z.object({
    ...baseEnvelopeShape,
    ticketId: identitySchema,
    type: z.literal(EventType.WORKSPACE_REMOVED),
    payload: workspaceRemovedPayloadSchema,
  }).strict(),
  z.object({
    ...baseEnvelopeShape,
    ticketId: identitySchema,
    type: z.literal(EventType.WORKSPACE_FAILED),
    payload: workspaceFailedPayloadSchema,
  }).strict(),
  z.object({
    ...baseEnvelopeShape,
    ticketId: identitySchema,
    runId: identitySchema,
    type: z.literal(EventType.RUN_STATE_CHANGED),
    payload: runStateChangedPayloadSchema,
  }).strict(),
  z.object({
    ...baseEnvelopeShape,
    ticketId: identitySchema,
    runId: identitySchema.optional(),
    type: z.literal(EventType.REPAIR_ATTEMPT_RECORDED),
    payload: repairAttemptEvidenceSchema,
  }).strict(),
  z.object({
    ...baseEnvelopeShape,
    ticketId: identitySchema,
    type: z.literal(EventType.PRE_PR_READINESS_RECORDED),
    payload: readinessEvidenceSchema,
  }).strict(),
  z.object({
    ...baseEnvelopeShape,
    ticketId: identitySchema,
    type: z.literal(EventType.GITHUB_PR_RECORDED),
    payload: githubPrEvidenceSchema,
  }).strict(),
  z.object({
    ...baseEnvelopeShape,
    ticketId: identitySchema,
    type: z.literal(EventType.GITHUB_USAGE_RECEIPT_RECORDED),
    payload: githubUsageReceiptEvidenceSchema,
  }).strict(),
  z.object({
    ...baseEnvelopeShape,
    ticketId: identitySchema,
    type: z.literal(EventType.EXECUTION_CONTRACT_BOUND),
    payload: executionContractBoundPayloadSchema,
  }).strict(),
  z.object({
    ...baseEnvelopeShape,
    ticketId: identitySchema,
    type: z.literal(EventType.EXECUTION_STARTED),
    payload: executionStartedPayloadSchema,
  }).strict(),
  z.object({
    ...baseEnvelopeShape,
    ticketId: identitySchema,
    type: z.literal(EventType.EXECUTION_TERMINAL),
    payload: executionTerminalPayloadSchema,
  }).strict(),
  z.object({
    ...baseEnvelopeShape,
    ticketId: identitySchema,
    type: z.literal(EventType.DISPATCH_CLAIMED),
    payload: dispatchClaimedPayloadSchema,
  }).strict(),
  z.object({
    ...baseEnvelopeShape,
    ticketId: identitySchema,
    type: z.literal(EventType.DISPATCH_COMPLETED),
    payload: dispatchCompletedPayloadSchema,
  }).strict(),
]);

/** Runtime-typed event union with duplicated envelope identities kept consistent. */
export const eventSchema = eventUnionSchema.superRefine((event, context) => {
  if (
    event.type === EventType.PROJECT_INITIALIZED &&
    event.payload.projectId !== event.projectId
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['payload', 'projectId'],
      message: 'payload.projectId must match event.projectId',
    });
  }

  if ('ticketId' in event.payload) {
    if (!('ticketId' in event) || event.payload.ticketId !== event.ticketId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'ticketId'],
        message: 'payload.ticketId must match event.ticketId',
      });
    }
  }

  if ('runId' in event.payload) {
    if (!('runId' in event) || event.payload.runId !== event.runId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'runId'],
        message: 'payload.runId must match event.runId',
      });
    }
  }
  if (event.type === EventType.REPAIR_ATTEMPT_RECORDED) {
    if (event.payload.repairRunId !== undefined && event.runId !== event.payload.repairRunId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'repairRunId'],
        message: 'payload.repairRunId must match event.runId',
      });
    }
    if (event.payload.repairRunId === undefined && event.runId !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['runId'],
        message: 'event.runId requires payload.repairRunId',
      });
    }
  }
});

export type ShipgraphEvent = z.infer<typeof eventSchema>;
type WithoutSequence<Event> = Event extends unknown ? Omit<Event, 'sequence'> : never;
export type NewShipgraphEvent = WithoutSequence<ShipgraphEvent>;

export type ProjectInitializedPayload = z.infer<typeof projectInitializedPayloadSchema>;
export type TicketCreatedPayload = z.infer<typeof ticketCreatedPayloadSchema>;
export type TicketStateChangedPayload = z.infer<typeof ticketStateChangedPayloadSchema>;
export type TicketSuggestedPayload = z.infer<typeof ticketSuggestedPayloadSchema>;
export type RunCreatedPayload = z.infer<typeof runCreatedPayloadSchema>;
export type RunCompletedPayload = z.infer<typeof runCompletedPayloadSchema>;
export type RunStateChangedPayload = z.infer<typeof runStateChangedPayloadSchema>;
export type WorkspaceCreatingPayload = z.infer<typeof workspaceCreatingPayloadSchema>;
export type WorkspaceReadyPayload = z.infer<typeof workspaceReadyPayloadSchema>;
export type WorkspaceRemovedPayload = z.infer<typeof workspaceRemovedPayloadSchema>;
export type WorkspaceFailedPayload = z.infer<typeof workspaceFailedPayloadSchema>;
export type RepairAttemptRecordedPayload = z.infer<typeof repairAttemptEvidenceSchema>;
export type PrePrReadinessRecordedPayload = z.infer<typeof readinessEvidenceSchema>;
export type GithubPrRecordedPayload = z.infer<typeof githubPrEvidenceSchema>;
export type GithubUsageReceiptRecordedPayload = z.infer<typeof githubUsageReceiptEvidenceSchema>;
export type ExecutionContractBoundPayload = z.infer<typeof executionContractBoundPayloadSchema>;
export type ExecutionStartedPayload = z.infer<typeof executionStartedPayloadSchema>;
export type ExecutionTerminalPayload = z.infer<typeof executionTerminalPayloadSchema>;
export type DispatchClaimedPayload = z.infer<typeof dispatchClaimedPayloadSchema>;
export type DispatchCompletedPayload = z.infer<typeof dispatchCompletedPayloadSchema>;

export function isValidStateValue(value: string): value is TicketStateValue {
  return ticketStateSchema.safeParse(value).success;
}
