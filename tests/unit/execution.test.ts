import { describe, expect, it } from 'vitest';
import {
  behavioralTicketContractSchema,
  deriveBehavioralContractProvenance,
  executionEvidenceSchema,
} from '../../src/domain/execution.js';

const contract = {
  summary: 'Keep one supplied ticket execution bounded.',
  currentBehavior: 'The inner stages are callable independently.',
  desiredBehavior: 'One entry point composes them for one supplied ticket.',
  acceptanceCriteria: ['The contract is strict.', 'The digest is deterministic.'],
  outOfScope: ['Scheduler selection', 'Post-PR lifecycle'],
  keyInterfaces: ['AGENT-001', 'MODEL-001'],
};

describe('KAR-12 behavioral execution contract', () => {
  it('accepts the bounded behavioral shape and rejects recipe fields', () => {
    expect(behavioralTicketContractSchema.parse(contract)).toEqual(contract);
    expect(behavioralTicketContractSchema.safeParse({
      ...contract,
      filesToEdit: ['src/example.ts'],
    }).success).toBe(false);
  });

  it('requires the behavioral fields', () => {
    const missingSummary = { ...contract };
    Reflect.deleteProperty(missingSummary, 'summary');
    expect(behavioralTicketContractSchema.safeParse(missingSummary).success).toBe(false);
  });

  it('derives deterministic provenance that changes with behavioral content', () => {
    const first = deriveBehavioralContractProvenance(contract, 'linear:KAR-12', 'v1');
    const replay = deriveBehavioralContractProvenance({ ...contract }, 'linear:KAR-12', 'v1');
    const changed = deriveBehavioralContractProvenance(
      { ...contract, desiredBehavior: 'A materially different bounded entry point.' },
      'linear:KAR-12',
      'v1'
    );

    expect(replay).toEqual(first);
    expect(changed.contractDigest).not.toBe(first.contractDigest);
    expect(executionEvidenceSchema.safeParse({
      executionId: 'execution-1',
      ticketId: 'KAR-12',
      outcome: 'NEEDS_HUMAN',
      ...first,
      reason: 'bounded test outcome',
      recordedAt: '2026-01-01T00:00:00.000Z',
    }).success).toBe(true);
  });
});
