import { randomUUID } from 'node:crypto';
import {
  UNKNOWN,
  usageLedgerRecordSchema,
  type UsageLedgerRecord,
} from '../domain/model-provider.js';
import type { ModelRepository } from '../persistence/model-repositories.js';

export type UsageLedgerInput = Omit<
  UsageLedgerRecord,
  'id' | 'projectId' | 'recordedAt' | 'inputTokens' | 'outputTokens' | 'cost' | 'quotaRemaining'
> &
  Partial<Pick<UsageLedgerRecord, 'inputTokens' | 'outputTokens' | 'cost' | 'quotaRemaining'>> & {
  id?: string;
  recordedAt?: string;
};

/** Append-only run telemetry. Missing provider usage remains the literal unknown value. */
export class UsageLedger {
  public constructor(
    private readonly repository: ModelRepository,
    private readonly projectId: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: () => string = randomUUID
  ) {}

  public append(input: UsageLedgerInput): UsageLedgerRecord {
    const entry = usageLedgerRecordSchema.parse({
      ...input,
      id: input.id ?? this.createId(),
      projectId: this.projectId,
      recordedAt: input.recordedAt ?? this.now(),
      inputTokens: input.inputTokens ?? UNKNOWN,
      outputTokens: input.outputTokens ?? UNKNOWN,
      cost: input.cost ?? UNKNOWN,
      quotaRemaining: input.quotaRemaining ?? UNKNOWN,
    });
    return this.repository.appendUsage(entry);
  }

  public list(): readonly UsageLedgerRecord[] {
    return this.repository.listUsage(this.projectId);
  }
}
