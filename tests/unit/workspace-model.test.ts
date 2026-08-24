import { describe, expect, it } from 'vitest';
import {
  assertSafeTicketId,
  deriveBranchName,
  deriveWorktreePath,
} from '../../src/workspace/model.js';
import {
  eventSchema,
  EventType,
} from '../../src/events/event.js';

describe('WORK-001 workspace model', () => {
  it('derives deterministic, conservative branch names from ticket ids', () => {
    expect(deriveBranchName('TA-1')).toBe('shipgraph/ta-1');
    expect(deriveBranchName('WORK-001')).toBe('shipgraph/work-001');
    expect(deriveBranchName('CORE_002-X')).toBe('shipgraph/core_002-x');
    // Deterministic across calls.
    expect(deriveBranchName('TA-1')).toBe(deriveBranchName('TA-1'));
  });

  it('rejects ticket ids that could control filesystem traversal', () => {
    for (const hostile of ['../evil', 'a/b', '.hidden', '-flag', '', 'x'.repeat(65)]) {
      expect(() => assertSafeTicketId(hostile)).toThrow(/Invalid ticket id/);
    }
    expect(assertSafeTicketId('TA-1')).toBe('TA-1');
    expect(assertSafeTicketId('WORK-001')).toBe('WORK-001');
  });

  it('confines derived worktree paths to the worktree root', () => {
    const root = '/root';
    const path = deriveWorktreePath(root, '0a7a8a8a-1111-2222-3333-444444444444', 'TA-1');
    expect(path.startsWith(`${root}/`)).toBe(true);
    expect(() =>
      deriveWorktreePath(root, 'not-a-uuid', 'TA-1')
    ).toThrow(/Invalid project id/);
    expect(() => deriveWorktreePath(root, '../outside', 'TA-1')).toThrow(/Invalid project id/);
  });

  it('runtime-validates workspace audit event payloads', () => {
    const envelope = {
      id: '0b6b7b7b-2222-3333-4444-555555555555',
      sequence: 1,
      timestamp: new Date().toISOString(),
      projectId: '0a7a8a8a-1111-2222-3333-4444-444444444444',
      ticketId: 'TA-1',
      type: EventType.WORKSPACE_READY,
      payload: {
        workspaceId: 'ws-1',
        ticketId: 'TA-1',
        baseSha: 'a'.repeat(40),
        branchName: 'shipgraph/ta-1',
        worktreePath: '/root/proj/TA-1',
      },
    };
    expect(() => eventSchema.parse(envelope)).not.toThrow();

    // Payload/envelope identity mismatch fails closed.
    expect(() =>
      eventSchema.parse({
        ...envelope,
        payload: { ...envelope.payload, ticketId: 'TB-2' },
      })
    ).toThrow(/payload.ticketId must match/);

    // Unknown fields are rejected.
    expect(() =>
      eventSchema.parse({
        ...envelope,
        payload: { ...envelope.payload, secret: 'value' },
      })
    ).toThrow();
  });
});
