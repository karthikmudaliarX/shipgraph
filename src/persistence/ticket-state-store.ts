import { randomUUID } from 'node:crypto';
import type { DbConnection } from './db.js';
import {
  createEventRepository,
  createTicketRepository,
  type TicketRecord,
} from './repositories.js';
import {
  transition,
  type TransitionContext,
} from '../core/state-machine/transitions.js';
import type { TicketStateValue } from '../core/state-machine/state.js';
import {
  EventType,
  type ShipgraphEvent,
  type TicketStateChangedPayload,
} from '../events/event.js';
import { StateTransitionError } from '../utils/errors.js';

export type PersistedTicketTransition = {
  ticket: TicketRecord;
  event: ShipgraphEvent;
};

export type TicketStateStoreOptions = {
  createEventId?: () => string;
  now?: () => string;
};

/**
 * Persist a legal ticket state transition and its audit event atomically.
 *
 * The domain state machine remains the authority for legality. SQLite owns
 * the commit boundary, so neither the state nor the event can exist alone.
 */
export function persistTicketTransition(
  db: DbConnection,
  input: {
    ticketId: string;
    next: TicketStateValue;
    reason?: string;
    context?: TransitionContext;
  },
  options: TicketStateStoreOptions = {}
): PersistedTicketTransition {
  const ticketRepository = createTicketRepository(db);
  const eventRepository = createEventRepository(db);
  const createEventId = options.createEventId ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());

  const persist = db.transaction((): PersistedTicketTransition => {
    const current = ticketRepository.findById(input.ticketId);
    if (!current) {
      throw new StateTransitionError(`Ticket ${input.ticketId} does not exist`);
    }

    const result = transition(current.status, input.next, input.context);
    if (!result.ok) {
      throw new StateTransitionError(result.reason);
    }

    const timestamp = now();
    const updateResult = db
      .prepare(
        'UPDATE tickets SET status = ?, updated_at = ? WHERE id = ? AND status = ?'
      )
      .run(input.next, timestamp, input.ticketId, current.status);
    if (updateResult.changes !== 1) {
      throw new StateTransitionError(
        `Ticket ${input.ticketId} changed concurrently; transition was not persisted`
      );
    }

    const updated = ticketRepository.findById(input.ticketId);
    if (!updated) throw new StateTransitionError(`Ticket ${input.ticketId} disappeared`);

    const payload: TicketStateChangedPayload = {
      ticketId: input.ticketId,
      previous: result.previous,
      next: result.next,
      ...(input.reason ? { reason: input.reason } : {}),
    };

    const event = eventRepository.append({
      id: createEventId(),
      timestamp,
      projectId: current.projectId,
      ticketId: current.id,
      type: EventType.TICKET_STATE_CHANGED,
      payload,
    });

    return { ticket: updated, event };
  }).immediate;

  return persist();
}
