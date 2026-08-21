import { describe, it, expect } from 'vitest';
import { TicketState } from '../../src/core/state-machine/state.js';
import { canTransition, transition, legalNextStates } from '../../src/core/state-machine/transitions.js';

describe('state machine', () => {
  it('allows legal normal transitions', () => {
    expect(canTransition(TicketState.QUEUED, TicketState.ELIGIBLE)).toBe(true);
    expect(canTransition(TicketState.REVIEWING, TicketState.CHANGES_REQUIRED)).toBe(true);
    expect(canTransition(TicketState.REVIEWING, TicketState.RELEASE_READY)).toBe(true);
    expect(canTransition(TicketState.MERGED, TicketState.COMPLETE)).toBe(true);
  });

  it('disallows illegal shortcuts', () => {
    expect(canTransition(TicketState.QUEUED, TicketState.MERGED)).toBe(false);
    expect(canTransition(TicketState.IMPLEMENTING, TicketState.COMPLETE)).toBe(false);
  });

  it('disallows self-transitions', () => {
    expect(canTransition(TicketState.VERIFYING, TicketState.VERIFYING)).toBe(false);
  });

  it('returns success for legal transitions', () => {
    const result = transition(TicketState.REVIEWING, TicketState.RELEASE_READY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.previous).toBe(TicketState.REVIEWING);
      expect(result.next).toBe(TicketState.RELEASE_READY);
    }
  });

  it('returns failure for illegal transitions', () => {
    const result = transition(TicketState.QUEUED, TicketState.MERGED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not allowed/);
    }
  });

  it('blocks MERGING without explicit human-approval override', () => {
    const result = transition(TicketState.AWAITING_APPROVAL, TicketState.MERGING);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/human approval/);
    }
  });

  it('allows MERGING when human approval requirement is explicitly disabled', () => {
    const result = transition(TicketState.AWAITING_APPROVAL, TicketState.MERGING, {
      releasePolicy: { requireHumanApproval: false },
    });
    expect(result.ok).toBe(true);
  });

  it('lists legal next states', () => {
    const next = legalNextStates(TicketState.FAILED);
    expect(next).toContain(TicketState.REPAIRING);
    expect(next).toContain(TicketState.NEEDS_HUMAN);
  });
});
