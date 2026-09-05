import type { NormalizedAgentEvidence } from '../../domain/agent-run.js';
import { redactSensitiveText } from './safety.js';

/** Individual JSONL records may exceed retention, but cannot grow without bound. */
export const AGENT_JSONL_RECORD_LIMIT_BYTES = 1024 * 1024;
export type JsonlProtocol = 'codex' | 'opencode';
export type StructuredOutput = {
  valid: boolean;
  reason?: string;
  sessionId?: string;
  evidence?: NormalizedAgentEvidence;
};

/**
 * Retains one bounded record and a constant-size evidence summary, never the
 * event history. Every record (including records after completion) is checked.
 * A successful process exit alone cannot turn an incomplete protocol into success.
 */
export class JsonlOutputCollector {
  private readonly record = Buffer.alloc(AGENT_JSONL_RECORD_LIMIT_BYTES);
  private size = 0;
  private count = 0;
  private readonly eventTypes = new Set<string>();
  private sessionId: string | undefined;
  private rawSessionId: string | undefined;
  private summary: string | undefined;
  private reason: string | undefined;
  private complete = false;

  public constructor(private readonly protocol: JsonlProtocol) {}

  /** False means a record exceeded the independent resource safety envelope. */
  public append(chunk: Buffer): boolean {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      const length = end - start;
      if (this.size + length > this.record.length) {
        this.reason = 'provider JSONL record exceeded the stream safety limit';
        return false;
      }
      chunk.copy(this.record, this.size, start, end);
      this.size += length;
      if (newline === -1) break;
      this.consumeRecord();
      this.size = 0;
      start = newline + 1;
    }
    return true;
  }

  public finish(): StructuredOutput {
    // JSONL permits a final record without a newline, but not a partial JSON object.
    if (this.size > 0) this.consumeRecord();
    if (this.reason !== undefined) return { valid: false, reason: this.reason };
    if (this.count === 0) return { valid: false, reason: 'provider produced no structured output' };
    if (!this.complete) return { valid: false, reason: 'provider structured output ended without successful completion' };
    return {
      valid: true,
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
      evidence: {
        outputFormat: 'jsonl',
        eventCount: this.count,
        eventTypes: [...this.eventTypes],
        ...(this.summary === undefined ? {} : { summary: this.summary }),
      },
    };
  }

  private consumeRecord(): void {
    if (this.reason !== undefined) return;
    let event: unknown;
    try {
      const line = new TextDecoder('utf-8', { fatal: true }).decode(this.record.subarray(0, this.size)).trim();
      if (line.length === 0) return;
      event = JSON.parse(line) as unknown;
    } catch {
      this.reason = 'provider emitted malformed structured JSON';
      return;
    }
    if (!isObject(event)) {
      this.reason = 'provider emitted a non-object structured event';
      return;
    }
    this.count += 1;
    const type = firstString(event, ['type', 'event', 'eventType', 'event_type']);
    if (type !== undefined) {
      if (redactSensitiveText(type).length > 80) {
        this.reason = 'provider event type exceeded the evidence limit';
        return;
      }
      if (this.eventTypes.size < 64) this.eventTypes.add(redactSensitiveText(type));
    }
    if ((typeof event.error === 'string' && event.error.length > 0) || isObject(event.error) ||
        type === 'error' || type === 'turn.failed') {
      this.reason = 'provider returned an error payload';
      return;
    }
    const session = findString(event, ['thread_id', 'sessionID', 'sessionId', 'session_id', 'conversationId']);
    if (session !== undefined) {
      if (session.length > 256 || redactSensitiveText(session).length > 256 ||
          (this.rawSessionId !== undefined && this.rawSessionId !== session)) {
        this.reason = 'provider returned invalid or conflicting session identity';
        return;
      }
      this.rawSessionId = session;
      this.sessionId = redactSensitiveText(session);
    }
    const text = findString(event, ['text', 'summary', 'message', 'response', 'content']);
    if (text !== undefined) this.summary = redactSensitiveText(text).slice(0, 4096);
    if (this.protocol === 'codex') {
      if (type === 'turn.started') this.complete = false;
      if (type === 'turn.completed') this.complete = true;
    } else {
      if (type === 'step_start') this.complete = false;
      if (type === 'step_finish') {
        this.complete = isObject(event.part) && event.part.reason === 'stop';
      }
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(event: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = event[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function findString(event: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const direct = firstString(event, keys);
  if (direct !== undefined) return direct;
  for (const key of ['item', 'part', 'data', 'payload', 'msg', 'message']) {
    if (isObject(event[key])) {
      const nested = firstString(event[key], keys);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}
