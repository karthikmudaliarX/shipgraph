import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  LINEAR_WEBHOOK_MAX_BODY_BYTES,
  LINEAR_WEBHOOK_REQUEST_TIMEOUT_MS,
  LinearWebhookError,
  parseLinearWebhook,
  verifyLinearWebhookSignature,
} from '../../src/dispatch/webhook.js';

const secret = 'linear-webhook-test-secret';
const delivery = '11111111-1111-4111-8111-111111111111';

function signature(body: Uint8Array): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function body(timestamp = 1_700_000_000_000): Buffer {
  return Buffer.from(JSON.stringify({
    type: 'Issue',
    action: 'update',
    data: { id: 'linear-issue-1' },
    webhookTimestamp: timestamp,
  }));
}

describe('Linear webhook authentication', () => {
  it('verifies the exact raw body before parsing', () => {
    const raw = body();
    expect(verifyLinearWebhookSignature(raw, signature(raw), secret)).toBe(true);
    expect(verifyLinearWebhookSignature(Buffer.from(`${raw.toString()} `), signature(raw), secret)).toBe(false);
  });

  it('rejects invalid signatures and malformed authenticated bodies', () => {
    const raw = body();
    expect(() => parseLinearWebhook(raw, { signature: 'bad', delivery }, secret, 1_700_000_000_000))
      .toThrow(LinearWebhookError);
    expect(() => parseLinearWebhook(raw, {
      signature: '0'.repeat(64),
      delivery,
    }, secret, 1_700_000_000_000)).toThrow(/signature is invalid/);
    expect(() => parseLinearWebhook(raw, { delivery }, secret, 1_700_000_000_000))
      .toThrow(/signature is invalid/);
    expect(() => parseLinearWebhook(Buffer.from('{'), {
      signature: signature(Buffer.from('{')),
      delivery,
    }, secret, 1_700_000_000_000)).toThrow(/valid JSON/);
  });

  it('rejects stale events and oversized request bodies', () => {
    const stale = body(1_700_000_000_000 - 60_001);
    expect(() => parseLinearWebhook(stale, { signature: signature(stale), delivery }, secret, 1_700_000_000_000))
      .toThrow(/timestamp/);
    const future = body(1_700_000_000_000 + 60_001);
    expect(() => parseLinearWebhook(future, { signature: signature(future), delivery }, secret, 1_700_000_000_000))
      .toThrow(/timestamp/);
    const oversized = Buffer.alloc(LINEAR_WEBHOOK_MAX_BODY_BYTES + 1, 65);
    expect(() => parseLinearWebhook(oversized, {
      signature: signature(oversized),
      delivery,
    }, secret, 1_700_000_000_000)).toThrow(/body exceeds/);
  });

  it('keeps the HTTP body deadline below Linear’s retry horizon', () => {
    expect(LINEAR_WEBHOOK_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});
