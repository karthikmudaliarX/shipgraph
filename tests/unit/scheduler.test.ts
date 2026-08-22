import { describe, expect, it, vi } from 'vitest';
import { TicketState } from '../../src/core/state-machine/state.js';
import { evaluateEligibility } from '../../src/scheduler/eligibility.js';
import { ACTIVE_CAPACITY_STATES, calculateReady } from '../../src/scheduler/ready.js';
import { emitReady } from '../../src/cli/ready.js';
import type { TicketRecord } from '../../src/persistence/repositories.js';

function ticket(
  id: string,
  status: TicketRecord['status'],
  priority: TicketRecord['priority'] = 'medium',
  dependsOn: string[] = []
): TicketRecord {
  return {
    id,
    projectId: 'project',
    title: `Ticket ${id}`,
    description: 'A ticket.',
    priority,
    risk: 'medium',
    status,
    dependsOn,
    scope: { allowedPaths: [], forbiddenPaths: [] },
    acceptanceCriteria: [],
    verification: { commands: [] },
    agent: {},
    release: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('eligibility and deterministic ready selection', () => {
  it('requires COMPLETE dependencies and explains cancelled blockers', () => {
    const results = evaluateEligibility([
      ticket('ROOT-001', TicketState.CANCELLED),
      ticket('WORK-001', TicketState.QUEUED, 'high', ['ROOT-001']),
      ticket('MERGED-001', TicketState.MERGED),
      ticket('WORK-002', TicketState.QUEUED, 'high', ['MERGED-001']),
      ticket('DONE-001', TicketState.COMPLETE),
      ticket('WORK-003', TicketState.QUEUED, 'high', ['DONE-001']),
    ]);

    expect(results.find((entry) => entry.ticket === 'WORK-001')).toMatchObject({
      eligible: false,
      blockers: [{ dependency: 'ROOT-001', state: TicketState.CANCELLED, reason: 'dependency-cancelled' }],
    });
    expect(results.find((entry) => entry.ticket === 'WORK-002')).toMatchObject({
      eligible: false,
      blockers: [{ dependency: 'MERGED-001', state: TicketState.MERGED, reason: 'dependency-not-complete' }],
    });
    expect(results.find((entry) => entry.ticket === 'WORK-003')).toMatchObject({ eligible: true, blockers: [] });
  });

  it('reports missing dependency blockers without promoting the ticket', () => {
    const tickets = [ticket('WORK-004', TicketState.QUEUED, 'high', ['MISSING-001'])];
    expect(evaluateEligibility(tickets)).toEqual([
      {
        ticket: 'WORK-004',
        eligible: false,
        blockers: [{
          dependency: 'MISSING-001',
          state: 'MISSING',
          reason: 'dependency-not-found',
        }],
      },
    ]);
    expect(calculateReady(tickets, 1).waiting[0]?.blockers[0]?.reason).toBe(
      'dependency-not-found'
    );
  });

  it('orders eligible work by priority then ID and applies capacity', () => {
    const tickets = [
      ticket('LOW-001', TicketState.ELIGIBLE, 'low'),
      ticket('HIGH-002', TicketState.ELIGIBLE, 'high'),
      ticket('CRITICAL-003', TicketState.ELIGIBLE, 'critical'),
      ticket('HIGH-001', TicketState.ELIGIBLE, 'high'),
      ticket('ACTIVE-001', TicketState.IMPLEMENTING),
    ];
    const report = calculateReady(tickets, 2);

    expect(report.capacity).toEqual({ active: 1, maxConcurrentTickets: 2, available: 1 });
    expect(report.eligible.map((entry) => entry.ticket)).toEqual([
      'CRITICAL-003',
      'HIGH-001',
      'HIGH-002',
      'LOW-001',
    ]);
    expect(report.dispatchable.map((entry) => entry.ticket)).toEqual(['CRITICAL-003']);
  });

  it('does not count queued, eligible, exceptional, complete, or cancelled states as active', () => {
    const tickets = [
      ticket('QUEUED-001', TicketState.QUEUED),
      ticket('ELIGIBLE-001', TicketState.ELIGIBLE),
      ticket('FAILED-001', TicketState.FAILED),
      ticket('HUMAN-001', TicketState.NEEDS_HUMAN),
      ticket('COMPLETE-001', TicketState.COMPLETE),
      ticket('CANCELLED-001', TicketState.CANCELLED),
    ];
    expect(calculateReady(tickets, 1).capacity.active).toBe(0);
    expect(ACTIVE_CAPACITY_STATES).not.toContain(TicketState.FAILED);
  });

  it('counts every configured active state and rejects invalid capacity', () => {
    for (const state of ACTIVE_CAPACITY_STATES) {
      expect(calculateReady([ticket(`ACTIVE-${state}`, state)], ACTIVE_CAPACITY_STATES.length).capacity.active).toBe(1);
    }
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => calculateReady([], invalid)).toThrow(/positive integer/);
    }
  });

  it('reports zero available slots without selecting work', () => {
    const report = calculateReady([
      ticket('ACTIVE-001', TicketState.IMPLEMENTING),
      ticket('READY-001', TicketState.ELIGIBLE, 'critical'),
    ], 1);
    expect(report.capacity.available).toBe(0);
    expect(report.dispatchable).toEqual([]);
  });

  it('strips terminal control characters from human-readable titles', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    emitReady(
      {
        capacity: { active: 0, maxConcurrentTickets: 1, available: 1 },
        eligible: [{ ticket: 'READY-001', title: 'safe\u001b[31m\nspoof', priority: 'high', state: TicketState.ELIGIBLE }],
        dispatchable: [{ ticket: 'READY-001', title: 'safe\u001b[31m\nspoof', priority: 'high', state: TicketState.ELIGIBLE }],
        waiting: [],
      },
      false
    );
    const rendered = consoleSpy.mock.calls.flat().join('\n');
    expect(rendered).not.toContain('\u001b');
    expect(rendered).not.toContain('\nspoof');
    consoleSpy.mockRestore();
  });
});
