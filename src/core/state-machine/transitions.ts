import { TicketState, type TicketStateValue } from './state.js';

export type TransitionContext = {
  releasePolicy?: {
    requireHumanApproval?: boolean;
    requireCleanCI?: boolean;
    requireExactShaReviews?: boolean;
  };
  releaseEvidence?: {
    humanApprovalGranted?: boolean;
  };
};

export type TransitionResult =
  | { ok: true; previous: TicketStateValue; next: TicketStateValue }
  | { ok: false; previous: TicketStateValue; next: TicketStateValue; reason: string };

const allowedTransitions: Record<TicketStateValue, readonly TicketStateValue[]> = {
  [TicketState.QUEUED]: [TicketState.ELIGIBLE, TicketState.BLOCKED, TicketState.CANCELLED],
  [TicketState.ELIGIBLE]: [TicketState.PLANNING, TicketState.PAUSED, TicketState.CANCELLED],
  [TicketState.PLANNING]: [TicketState.IMPLEMENTING, TicketState.PAUSED, TicketState.CANCELLED],
  [TicketState.IMPLEMENTING]: [TicketState.VERIFYING, TicketState.PAUSED, TicketState.FAILED],
  [TicketState.VERIFYING]: [
    TicketState.PR_OPEN,
    TicketState.REPAIRING,
    TicketState.FAILED,
    TicketState.NEEDS_HUMAN,
  ],
  [TicketState.PR_OPEN]: [TicketState.CI_WAIT, TicketState.NEEDS_HUMAN],
  [TicketState.CI_WAIT]: [TicketState.REVIEWING, TicketState.REPAIRING, TicketState.FAILED],
  [TicketState.REVIEWING]: [
    TicketState.CHANGES_REQUIRED,
    TicketState.RELEASE_READY,
    TicketState.NEEDS_HUMAN,
  ],
  [TicketState.CHANGES_REQUIRED]: [TicketState.REPAIRING, TicketState.NEEDS_HUMAN],
  [TicketState.REPAIRING]: [TicketState.VERIFYING, TicketState.FAILED, TicketState.NEEDS_HUMAN],
  [TicketState.RELEASE_READY]: [
    TicketState.AWAITING_APPROVAL,
    TicketState.MERGING,
    TicketState.NEEDS_HUMAN,
  ],
  [TicketState.AWAITING_APPROVAL]: [TicketState.MERGING, TicketState.RELEASE_READY],
  [TicketState.MERGING]: [TicketState.MERGED, TicketState.FAILED],
  [TicketState.MERGED]: [TicketState.COMPLETE],
  [TicketState.COMPLETE]: [],
  [TicketState.BLOCKED]: [TicketState.QUEUED, TicketState.CANCELLED],
  [TicketState.PAUSED]: [TicketState.ELIGIBLE, TicketState.CANCELLED],
  [TicketState.FAILED]: [TicketState.REPAIRING, TicketState.NEEDS_HUMAN],
  [TicketState.NEEDS_HUMAN]: [TicketState.PAUSED, TicketState.CANCELLED],
  [TicketState.CANCELLED]: [],
};

/**
 * Determine whether a state transition is legal.
 */
export function canTransition(
  from: TicketStateValue,
  to: TicketStateValue,
  context?: TransitionContext
): boolean {
  return evaluateTransition(from, to, context).ok;
}

/**
 * Attempt a state transition.
 * Illegal transitions fail closed with a reason.
 */
export function transition(
  from: TicketStateValue,
  to: TicketStateValue,
  context?: TransitionContext
): TransitionResult {
  return evaluateTransition(from, to, context);
}

function evaluateTransition(
  from: TicketStateValue,
  to: TicketStateValue,
  context?: TransitionContext
): TransitionResult {
  if (from === to) {
    return {
      ok: false,
      previous: from,
      next: to,
      reason: 'source and target states are identical',
    };
  }

  if (!allowedTransitions[from]?.includes(to)) {
    return {
      ok: false,
      previous: from,
      next: to,
      reason: `transition from ${from} to ${to} is not allowed`,
    };
  }

  if (
    to === TicketState.MERGING &&
    context?.releasePolicy?.requireHumanApproval !== false &&
    context?.releaseEvidence?.humanApprovalGranted !== true
  ) {
    return {
      ok: false,
      previous: from,
      next: to,
      reason: 'MERGING requires granted human approval evidence or an explicit policy override',
    };
  }

  return { ok: true, previous: from, next: to };
}

/**
 * List all legal next states from a given state.
 */
export function legalNextStates(from: TicketStateValue): readonly TicketStateValue[] {
  return allowedTransitions[from] ?? [];
}
