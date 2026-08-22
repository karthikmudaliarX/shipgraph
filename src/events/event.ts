import { z } from 'zod';
import { TicketState, type TicketStateValue } from '../core/state-machine/state.js';

/**
 * Core event types for the append-only audit log.
 */
export const EVENT_TYPES = [
  'project.initialized',
  'ticket.created',
  'ticket.state_changed',
  'ticket.suggested',
  'run.created',
  'run.completed',
] as const;

export const EventType = {
  PROJECT_INITIALIZED: EVENT_TYPES[0],
  TICKET_CREATED: EVENT_TYPES[1],
  TICKET_STATE_CHANGED: EVENT_TYPES[2],
  TICKET_SUGGESTED: EVENT_TYPES[3],
  RUN_CREATED: EVENT_TYPES[4],
  RUN_COMPLETED: EVENT_TYPES[5],
} as const;

export type EventTypeValue = (typeof EVENT_TYPES)[number];

export const eventPayloadSchema = z.record(z.unknown()).default({});

/**
 * Every event contains identity, sequence, timestamp, context, type, and payload.
 *
 * Sequence must be monotonic within a project.
 * Events are append-only: no update/delete API exists in normal code.
 */
export const eventSchema = z.object({
  id: z.string().uuid(),
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  projectId: z.string().min(1),
  ticketId: z.string().optional(),
  runId: z.string().optional(),
  type: z.enum(EVENT_TYPES),
  payload: eventPayloadSchema,
}).strict();

export type ShipgraphEvent = z.infer<typeof eventSchema>;
export type NewShipgraphEvent = Omit<ShipgraphEvent, 'sequence'>;

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
