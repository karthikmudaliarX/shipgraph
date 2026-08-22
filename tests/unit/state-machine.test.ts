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
    const result = transition(TicketState.RELEASE_READY, TicketState.MERGING);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/human approval/);
    }
    expect(canTransition(TicketState.RELEASE_READY, TicketState.MERGING)).toBe(false);
  });

  it('allows MERGING when human approval requirement is explicitly disabled', () => {
    const result = transition(TicketState.RELEASE_READY, TicketState.MERGING, {
      releasePolicy: { requireHumanApproval: false },
    });
    expect(result.ok).toBe(true);
    expect(
      canTransition(TicketState.RELEASE_READY, TicketState.MERGING, {
        releasePolicy: { requireHumanApproval: false },
      })
    ).toBe(true);
  });

  it('lists legal next states', () => {
    const next = legalNextStates(TicketState.FAILED);
    expect(next).toContain(TicketState.REPAIRING);
    expect(next).toContain(TicketState.NEEDS_HUMAN);
  });

  it('keeps canTransition and transition consistent for every state pair', () => {
    for (const from of Object.values(TicketState)) {
      for (const to of Object.values(TicketState)) {
        const result = transition(from, to, {
          releasePolicy: { requireHumanApproval: false },
        });
        expect(
          canTransition(from, to, {
            releasePolicy: { requireHumanApproval: false },
          })
        ).toBe(result.ok);
      }
    }
  });

  it('matches the complete expected transition graph', () => {
    const expected = new Map([
      [TicketState.QUEUED, [TicketState.ELIGIBLE, TicketState.BLOCKED, TicketState.CANCELLED]],
      [TicketState.ELIGIBLE, [TicketState.PLANNING, TicketState.PAUSED, TicketState.CANCELLED]],
      [TicketState.PLANNING, [TicketState.IMPLEMENTING, TicketState.PAUSED, TicketState.CANCELLED]],
      [TicketState.IMPLEMENTING, [TicketState.VERIFYING, TicketState.PAUSED, TicketState.FAILED]],
      [TicketState.VERIFYING, [TicketState.PR_OPEN, TicketState.REPAIRING, TicketState.FAILED]],
      [TicketState.PR_OPEN, [TicketState.CI_WAIT, TicketState.NEEDS_HUMAN]],
      [TicketState.CI_WAIT, [TicketState.REVIEWING, TicketState.REPAIRING, TicketState.FAILED]],
      [TicketState.REVIEWING, [TicketState.CHANGES_REQUIRED, TicketState.RELEASE_READY, TicketState.NEEDS_HUMAN]],
      [TicketState.CHANGES_REQUIRED, [TicketState.REPAIRING, TicketState.NEEDS_HUMAN]],
      [TicketState.REPAIRING, [TicketState.VERIFYING, TicketState.FAILED]],
      [TicketState.RELEASE_READY, [TicketState.AWAITING_APPROVAL, TicketState.MERGING, TicketState.NEEDS_HUMAN]],
      [TicketState.AWAITING_APPROVAL, [TicketState.MERGING, TicketState.RELEASE_READY]],
      [TicketState.MERGING, [TicketState.MERGED, TicketState.FAILED]],
      [TicketState.MERGED, [TicketState.COMPLETE]],
      [TicketState.COMPLETE, []],
      [TicketState.BLOCKED, [TicketState.QUEUED, TicketState.CANCELLED]],
      [TicketState.PAUSED, [TicketState.ELIGIBLE, TicketState.CANCELLED]],
      [TicketState.FAILED, [TicketState.REPAIRING, TicketState.NEEDS_HUMAN]],
      [TicketState.NEEDS_HUMAN, [TicketState.PAUSED, TicketState.CANCELLED]],
      [TicketState.CANCELLED, []],
    ]);

    for (const state of Object.values(TicketState)) {
      expect(legalNextStates(state)).toEqual(expected.get(state));
    }
  });
});
