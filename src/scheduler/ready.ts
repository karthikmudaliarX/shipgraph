import { TicketState, type TicketStateValue } from '../core/state-machine/state.js';
import type { TicketPriority } from '../domain/ticket.js';
import type { TicketRecord } from '../persistence/repositories.js';
import {
  evaluateEligibility,
  type EligibilityBlocker,
} from './eligibility.js';
import { compareStableStrings } from '../utils/sorting.js';

/** States that represent active build/release work and consume capacity. */
export const ACTIVE_CAPACITY_STATES: readonly TicketStateValue[] = [
  TicketState.PLANNING,
  TicketState.IMPLEMENTING,
  TicketState.VERIFYING,
  TicketState.PR_OPEN,
  TicketState.CI_WAIT,
  TicketState.REVIEWING,
  TicketState.CHANGES_REQUIRED,
  TicketState.REPAIRING,
  TicketState.RELEASE_READY,
  TicketState.AWAITING_APPROVAL,
  TicketState.MERGING,
  TicketState.MERGED,
];

export type ReadyTicket = {
  ticket: string;
  title: string;
  priority: TicketPriority;
  state: TicketStateValue;
};

export type ReadyWaitingTicket = {
  ticket: string;
  title: string;
  state: TicketStateValue;
  eligible: false;
  blockers: readonly EligibilityBlocker[];
};

export type ReadyReport = {
  capacity: {
    active: number;
    maxConcurrentTickets: number;
    available: number;
  };
  eligible: readonly ReadyTicket[];
  dispatchable: readonly ReadyTicket[];
  waiting: readonly ReadyWaitingTicket[];
};

const PRIORITY_ORDER: readonly TicketPriority[] = [
  'critical',
  'high',
  'medium',
  'low',
];

/** Pure, deterministic ready-queue calculation. It never mutates persistence. */
export function calculateReady(
  tickets: readonly TicketRecord[],
  maxConcurrentTickets: number
): ReadyReport {
  if (!Number.isInteger(maxConcurrentTickets) || maxConcurrentTickets < 1) {
    throw new Error('maxConcurrentTickets must be a positive integer');
  }

  const active = tickets.filter((ticket) =>
    ACTIVE_CAPACITY_STATES.includes(ticket.status)
  ).length;
  const available = Math.max(0, maxConcurrentTickets - active);
  const priorityRank = new Map(PRIORITY_ORDER.map((priority, index) => [priority, index]));
  const sortReady = (first: ReadyTicket, second: ReadyTicket): number => {
    const priorityDifference =
      (priorityRank.get(first.priority) ?? Number.MAX_SAFE_INTEGER) -
      (priorityRank.get(second.priority) ?? Number.MAX_SAFE_INTEGER);
    return priorityDifference || compareStableStrings(first.ticket, second.ticket);
  };

  const eligible = tickets
    .filter((ticket) => ticket.status === TicketState.ELIGIBLE)
    .map((ticket) => ({
      ticket: ticket.id,
      title: ticket.title,
      priority: ticket.priority,
      state: ticket.status,
    }))
    .sort(sortReady);

  const evaluations = evaluateEligibility(tickets);
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const waiting = evaluations
    .filter((evaluation) => evaluation.blockers.length > 0)
    .map((evaluation) => {
      const ticket = byId.get(evaluation.ticket);
      if (!ticket) throw new Error(`Eligibility references missing ticket ${evaluation.ticket}`);
      return {
        ticket: ticket.id,
        title: ticket.title,
        state: ticket.status,
        eligible: false as const,
        blockers: evaluation.blockers,
      };
    })
    .sort((first, second) => compareStableStrings(first.ticket, second.ticket));

  return {
    capacity: { active, maxConcurrentTickets, available },
    eligible,
    dispatchable: eligible.slice(0, available),
    waiting,
  };
}
