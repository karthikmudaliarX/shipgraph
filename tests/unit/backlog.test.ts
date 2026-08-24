import { describe, expect, it } from 'vitest';
import { parseBacklog, validateBacklog } from '../../src/backlog/schema.js';

const ticket = (id: string, dependsOn: string[] = []) => ({
  id,
  title: `Ticket ${id}`,
  description: `Description for ${id}`,
  priority: 'medium',
  dependsOn,
  scope: { allowedPaths: ['src/**'], forbiddenPaths: [] },
  acceptanceCriteria: [{ id: 'AC-1', description: 'Works.' }],
  verification: { commands: ['pnpm test'] },
  risk: 'medium',
  agent: {},
  release: { humanApprovalRequired: true },
});
describe('approved backlog contract and DAG validation', () => {
  it('accepts forward references and canonicalizes ordering', () => {
    const backlog = validateBacklog({
      version: 1,
      tickets: [ticket('A-001', ['B-001']), ticket('B-001')],
    });

    expect(backlog.tickets.map((entry) => entry.id)).toEqual(['A-001', 'B-001']);
    expect(backlog.tickets[0]?.dependsOn).toEqual(['B-001']);
  });

  it.each([
    ['duplicate ticket IDs', [ticket('A-001'), ticket('A-001')], /duplicate ticket ID/],
    ['duplicate dependencies', [ticket('A-001', ['B-001', 'B-001']), ticket('B-001')], /unique/],
    ['missing dependency', [ticket('A-001', ['B-001'])], /missing ticket/],
    ['self dependency', [ticket('A-001', ['A-001'])], /itself/],
    [
      'two-node cycle',
      [ticket('A-001', ['B-001']), ticket('B-001', ['A-001'])],
      /acyclic/,
    ],
    [
      'larger cycle hidden by order',
      [ticket('C-001', ['A-001']), ticket('A-001', ['B-001']), ticket('B-001', ['C-001'])],
      /acyclic/,
    ],
  ])('rejects %s', (_name, tickets, message) => {
    expect(() => validateBacklog({ version: 1, tickets })).toThrow(message);
  });

  it('fails closed for unsupported versions and unknown keys', () => {
    expect(() => validateBacklog({ version: 2, tickets: [] })).toThrow(/Unsupported/);
    expect(() => validateBacklog({ version: 1, tickets: [], extra: true })).toThrow();
    expect(() => validateBacklog({ version: 1, tickets: [{ ...ticket('A-001'), status: 'QUEUED' }] })).toThrow();
  });

  it('parses YAML without mutating persistence', () => {
    const backlog = parseBacklog(`
version: 1
tickets:
  - id: A-001
    title: Independent
    description: A ticket.
    priority: high
    dependsOn: []
    scope:
      allowedPaths: []
      forbiddenPaths: []
    acceptanceCriteria: []
    verification:
      commands: []
    risk: low
    agent: {}
    release: {}
`);

    expect(backlog.tickets[0]?.id).toBe('A-001');
  });
});
