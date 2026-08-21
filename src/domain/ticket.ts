import { z } from 'zod';

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

export const ticketRiskSchema = z.enum([
  'low',
  'medium',
  'high',
  'critical',
]);

export const ticketScopeSchema = z.object({
  allowedPaths: z.array(z.string().min(1)).default([]).readonly(),
  forbiddenPaths: z.array(z.string().min(1)).default([]).readonly(),
});

export const acceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
});

export const verificationConfigSchema = z.object({
  commands: z.array(z.string().min(1)).default([]).readonly(),
});

export const ticketAgentConfigSchema = z.object({
  preferredProvider: z.enum(['opencode', 'codex', 'acp']).optional(),
});

export const ticketReleaseConfigSchema = z.object({
  humanApprovalRequired: z.boolean().optional(),
});

/**
 * First-class ticket contract.
 *
 * Ticket IDs must be stable. Dependencies must reference ticket IDs.
 * An executing agent must NOT create an APPROVED ticket directly.
 */
export const ticketContractSchema = z.object({
  id: z.string().min(1).regex(/^[A-Z0-9]+-[0-9]+$/, {
    message: 'ticket id must be in PROJECT-123 format',
  }),
  title: z.string().min(1),
  description: z.string().min(1),
  priority: ticketPrioritySchema,
  dependsOn: z.array(z.string().min(1)).default([]).readonly(),
  scope: ticketScopeSchema.default({}),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).default([]).readonly(),
  verification: verificationConfigSchema.default({}),
  risk: ticketRiskSchema,
  agent: ticketAgentConfigSchema.default({}),
  release: ticketReleaseConfigSchema.default({}),
  status: z.string().min(1).default('QUEUED'),
});

export type TicketPriority = z.infer<typeof ticketPrioritySchema>;
export type TicketRisk = z.infer<typeof ticketRiskSchema>;
export type TicketScope = z.infer<typeof ticketScopeSchema>;
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;
export type VerificationConfig = z.infer<typeof verificationConfigSchema>;
export type TicketAgentConfig = z.infer<typeof ticketAgentConfigSchema>;
export type TicketReleaseConfig = z.infer<typeof ticketReleaseConfigSchema>;
export type TicketContract = z.infer<typeof ticketContractSchema>;

export function validateTicket(value: unknown): TicketContract {
  return ticketContractSchema.parse(value);
}

export function validateTicketDependencies(
  ticket: TicketContract,
  knownTicketIds: Set<string>
): void {
  const missing = ticket.dependsOn.filter((id) => !knownTicketIds.has(id));
  if (missing.length > 0) {
    throw new Error(
      `Ticket ${ticket.id} depends on unknown ticket IDs: ${missing.join(', ')}`
    );
  }
}
