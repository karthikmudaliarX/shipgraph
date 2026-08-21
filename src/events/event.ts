import { z } from 'zod';
import { TicketState, type TicketStateValue } from '../core/state-machine/state.js';

/**
 * Core event types for the append-only audit log.
 */
export const EventType = {
  PROJECT_INITIALIZED: 'project.initialized',
  TICKET_CREATED: 'ticket.created',
  TICKET_STATE_CHANGED: 'ticket.state_changed',
  TICKET_SUGGESTED: 'ticket.suggested',
  RUN_CREATED: 'run.created',
  RUN_COMPLETED: 'run.completed',
} as const;

export type EventTypeValue = (typeof EventType)[keyof typeof EventType];

export const eventPayloadSchema = z.record(z.unknown()).default({});

/**
 * Every event contains identity, sequence, timestamp, context, type, and payload.
 *
 * Sequence must be monotonic within a project.
 * Events are append-only: no update/delete API exists in normal code.
 */
export const eventSchema = z.object({
  id: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
  projectId: z.string().min(1),
  ticketId: z.string().optional(),
  runId: z.string().optional(),
  type: z.string().min(1),
  payload: eventPayloadSchema,
});

export type ShipgraphEvent = z.infer<typeof eventSchema>;

export type ProjectInitializedPayload = {
  projectId: string;
  name: string;
  repository: string;
  defaultBranch: string;
};

export type TicketCreatedPayload = {
  ticketId: string;
  title: string;
  priority: string;
  dependsOn: readonly string[];
};

export type TicketStateChangedPayload = {
  ticketId: string;
  previous: TicketStateValue;
  next: TicketStateValue;
  reason?: string;
};

export type RunCreatedPayload = {
  runId: string;
  ticketId: string;
  baseSha: string;
};

export function isValidStateValue(value: string): value is TicketStateValue {
  return Object.values(TicketState).includes(value as TicketStateValue);
}
