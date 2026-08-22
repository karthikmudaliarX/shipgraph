import { z } from 'zod';
import {
  TicketState,
  type TicketStateValue,
} from '../core/state-machine/state.js';

/** Core event types for the append-only audit log. */
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
}).strict();

export const runCompletedPayloadSchema = z.object({
  runId: identitySchema,
  ticketId: identitySchema,
  status: z.string().min(1),
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

export function isValidStateValue(value: string): value is TicketStateValue {
  return ticketStateSchema.safeParse(value).success;
}
