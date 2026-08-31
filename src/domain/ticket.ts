import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ALL_TICKET_STATES,
  type TicketStateValue,
} from '../core/state-machine/state.js';
import { AGENT_PROVIDERS } from './agent-provider.js';

/**
 * Priority levels for tickets.
 */
export const TicketPriority = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
} as const;

export const ticketPrioritySchema = z.enum([
  TicketPriority.CRITICAL,
  TicketPriority.HIGH,
  TicketPriority.MEDIUM,
  TicketPriority.LOW,
]);

export const ticketIdSchema = z.string().regex(/^[A-Z0-9]+-[0-9]+$/, {
  message: 'ticket id must be in PROJECT-123 format',
});

export const ticketStateSchema = z.enum(
  [...ALL_TICKET_STATES] as [TicketStateValue, ...TicketStateValue[]]
);

export const ticketRiskSchema = z.enum([
  'low',
  'medium',
  'high',
  'critical',
]);

export const ticketScopeSchema = z.object({
  allowedPaths: z.array(z.string().min(1)).default([]).readonly(),
  forbiddenPaths: z.array(z.string().min(1)).default([]).readonly(),
}).strict();

export const acceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
}).strict();

export const verificationConfigSchema = z.object({
  commands: z.array(z.string().min(1)).default([]).readonly(),
}).strict();

export const ticketAgentConfigSchema = z.object({
  preferredProvider: z.enum(AGENT_PROVIDERS).optional(),
}).strict();

export const ticketReleaseConfigSchema = z.object({
  humanApprovalRequired: z.boolean().optional(),
}).strict();

/**
 * First-class ticket contract.
 *
 * Ticket IDs must be stable. Dependencies must reference ticket IDs.
 * An executing agent must NOT create an APPROVED ticket directly.
 */
const ticketDefinitionShape = {
  id: ticketIdSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  priority: ticketPrioritySchema,
  dependsOn: z.array(ticketIdSchema).default([]).readonly(),
  scope: ticketScopeSchema.default({}),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).default([]).readonly(),
  verification: verificationConfigSchema.default({}),
  risk: ticketRiskSchema,
  agent: ticketAgentConfigSchema.default({}),
  release: ticketReleaseConfigSchema.default({}),
} as const;

function addDependencyInvariants(
  ticket: { id: string; dependsOn: readonly string[] },
  context: z.RefinementCtx
): void {
  if (ticket.dependsOn.includes(ticket.id)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dependsOn'],
      message: 'ticket cannot depend on itself',
    });
  }

  if (new Set(ticket.dependsOn).size !== ticket.dependsOn.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dependsOn'],
      message: 'ticket dependencies must be unique',
    });
  }
}

/** Static approved work definition. Runtime state is deliberately absent. */
export const ticketDefinitionSchema = z
  .object(ticketDefinitionShape)
  .strict()
  .superRefine(addDependencyInvariants);

/**
 * First-class ticket contract including persisted runtime state.
 *
 * The backlog uses ticketDefinitionSchema; SQLite owns the status field.
 */
export const ticketContractSchema = z.object({
  ...ticketDefinitionShape,
  status: ticketStateSchema.default('QUEUED'),
}).strict().superRefine(addDependencyInvariants);

export type TicketPriority = z.infer<typeof ticketPrioritySchema>;
export type TicketRisk = z.infer<typeof ticketRiskSchema>;
export type TicketScope = z.infer<typeof ticketScopeSchema>;
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;
export type VerificationConfig = z.infer<typeof verificationConfigSchema>;
export type TicketAgentConfig = z.infer<typeof ticketAgentConfigSchema>;
export type TicketReleaseConfig = z.infer<typeof ticketReleaseConfigSchema>;
export type TicketDefinition = z.infer<typeof ticketDefinitionSchema>;
export type TicketContract = z.infer<typeof ticketContractSchema>;

export type TicketContractProvenance = {
  contractDigest: string;
  contractSource: string;
  contractRevision: string;
};

/**
 * Derive provenance from the existing v1 backlog contract. Runtime state is
 * intentionally excluded so a status transition cannot change the digest.
 */
export function deriveTicketContractProvenance(
  ticket: Pick<
    TicketDefinition,
    | 'id'
    | 'title'
    | 'description'
    | 'priority'
    | 'dependsOn'
    | 'scope'
    | 'acceptanceCriteria'
    | 'verification'
    | 'risk'
    | 'agent'
    | 'release'
  >,
  contractSource: string,
  contractRevision: string
): TicketContractProvenance {
  if (contractSource.length === 0 || contractRevision.length === 0) {
    throw new Error('Ticket contract provenance requires a source and revision');
  }
  const canonicalContract = {
    id: ticket.id,
    title: ticket.title,
    description: ticket.description,
    priority: ticket.priority,
    dependsOn: [...ticket.dependsOn],
    scope: ticket.scope,
    acceptanceCriteria: [...ticket.acceptanceCriteria],
    verification: ticket.verification,
    risk: ticket.risk,
    agent: ticket.agent,
    release: ticket.release,
  };
  return {
    contractDigest: createHash('sha256')
      .update(JSON.stringify(canonicalContract))
      .digest('hex'),
    contractSource,
    contractRevision,
  };
}

export function validateTicket(value: unknown): TicketContract {
  return ticketContractSchema.parse(value);
}

export function validateTicketDefinition(value: unknown): TicketDefinition {
  return ticketDefinitionSchema.parse(value);
}

export function validateTicketDependencies(
  ticket: Pick<TicketContract, 'id' | 'dependsOn'>,
  knownTicketIds: Set<string>
): void {
  const missing = ticket.dependsOn.filter((id) => !knownTicketIds.has(id));
  if (missing.length > 0) {
    throw new Error(
      `Ticket ${ticket.id} depends on unknown ticket IDs: ${missing.join(', ')}`
    );
  }
}
