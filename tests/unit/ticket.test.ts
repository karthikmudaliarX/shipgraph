import { describe, it, expect } from 'vitest';
import {
  validateTicket,
  validateTicketDependencies,
  type TicketContract,
} from '../../src/domain/ticket.js';

function makeTicket(overrides: Partial<TicketContract> = {}): TicketContract {
  return {
    id: 'CORE-001',
    title: 'Project foundation',
    description: 'Build the foundation.',
    priority: 'high',
    dependsOn: [],
    scope: { allowedPaths: [], forbiddenPaths: [] },
    acceptanceCriteria: [],
    verification: { commands: [] },
    risk: 'medium',
    agent: {},
    release: {},
    status: 'QUEUED',
    ...overrides,
  };
}

describe('ticket contract', () => {
  it('accepts a valid ticket', () => {
    const ticket = validateTicket(makeTicket());
    expect(ticket.id).toBe('CORE-001');
  });

  it('rejects a ticket with invalid id format', () => {
    expect(() => validateTicket(makeTicket({ id: 'bad-id' }))).toThrow();
  });

  it('rejects a ticket with missing title', () => {
    expect(() => validateTicket(makeTicket({ title: '' }))).toThrow();
  });

  it('rejects an invalid priority', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => validateTicket(makeTicket({ priority: 'urgent' as any }))).toThrow();
  });

  it('rejects an invalid risk', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => validateTicket(makeTicket({ risk: 'extreme' as any }))).toThrow();
  });

  it('validates dependencies against known ticket IDs', () => {
    const ticket = makeTicket({ id: 'CORE-002', dependsOn: ['CORE-001'] });
    expect(() => validateTicketDependencies(ticket, new Set(['CORE-001']))).not.toThrow();
  });

  it('throws when a dependency ID is unknown', () => {
    const ticket = makeTicket({ id: 'CORE-002', dependsOn: ['CORE-001', 'CORE-099'] });
    expect(() => validateTicketDependencies(ticket, new Set(['CORE-001']))).toThrow(
      /CORE-099/
    );
  });
});
