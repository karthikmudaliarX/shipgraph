/**
 * Ticket lifecycle states.
 */
export const TicketState = {
  // Normal progression states
  QUEUED: 'QUEUED',
  ELIGIBLE: 'ELIGIBLE',
  PLANNING: 'PLANNING',
  IMPLEMENTING: 'IMPLEMENTING',
  VERIFYING: 'VERIFYING',
  PR_OPEN: 'PR_OPEN',
  CI_WAIT: 'CI_WAIT',
  REVIEWING: 'REVIEWING',
  CHANGES_REQUIRED: 'CHANGES_REQUIRED',
  REPAIRING: 'REPAIRING',
  RELEASE_READY: 'RELEASE_READY',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  MERGING: 'MERGING',
  MERGED: 'MERGED',
  COMPLETE: 'COMPLETE',

  // Exceptional states
  BLOCKED: 'BLOCKED',
  PAUSED: 'PAUSED',
  FAILED: 'FAILED',
  NEEDS_HUMAN: 'NEEDS_HUMAN',
  CANCELLED: 'CANCELLED',
} as const;

export type TicketStateValue = (typeof TicketState)[keyof typeof TicketState];

export const ALL_TICKET_STATES: readonly TicketStateValue[] = Object.values(
  TicketState
) as TicketStateValue[];

export const NORMAL_TICKET_STATES: readonly TicketStateValue[] = [
  TicketState.QUEUED,
  TicketState.ELIGIBLE,
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
  TicketState.COMPLETE,
];

export const EXCEPTIONAL_TICKET_STATES: readonly TicketStateValue[] = [
  TicketState.BLOCKED,
  TicketState.PAUSED,
  TicketState.FAILED,
  TicketState.NEEDS_HUMAN,
  TicketState.CANCELLED,
];
