import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const LINEAR_WEBHOOK_MAX_BODY_BYTES = 128 * 1024;
export const LINEAR_WEBHOOK_TIMESTAMP_WINDOW_MS = 60_000;
export const LINEAR_WEBHOOK_REQUEST_TIMEOUT_MS = 5_000;

const linearWebhookSchema = z.object({
  type: z.string().min(1).max(64),
  action: z.string().min(1).max(64).optional(),
  data: z.object({
    id: z.string().min(1).max(256),
  }).passthrough(),
  webhookTimestamp: z.number().int().positive(),
}).passthrough();

export type LinearWebhookPayload = z.infer<typeof linearWebhookSchema>;

export class LinearWebhookError extends Error {
  readonly statusCode: 400 | 401 | 408 | 413;

  constructor(message: string, statusCode: 400 | 401 | 408 | 413 = 400) {
    super(message);
    this.name = 'LinearWebhookError';
    this.statusCode = statusCode;
  }
}
/** Verify the Linear signature over the exact request bytes. */
export function verifyLinearWebhookSignature(
  rawBody: Uint8Array,
  signature: string | undefined,
  secret: string
): boolean {
  if (signature === undefined || !/^[0-9a-f]{64}$/iu.test(signature) || secret.length === 0) {
    return false;
  }
  const supplied = Buffer.from(signature, 'hex');
  const expected = createHmac('sha256', secret).update(Buffer.from(rawBody)).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** Authenticate and parse a Linear webhook without trusting parsed data first. */
export function parseLinearWebhook(
  rawBody: Uint8Array,
  headers: {
    signature?: string;
    delivery?: string;
  },
  secret: string,
  nowMs = Date.now()
): LinearWebhookPayload {
  if (rawBody.byteLength > LINEAR_WEBHOOK_MAX_BODY_BYTES) {
    throw new LinearWebhookError('Linear webhook body exceeds the configured limit', 413);
  }
  if (!verifyLinearWebhookSignature(rawBody, headers.signature, secret)) {
    throw new LinearWebhookError('Linear webhook signature is invalid', 401);
  }
  if (headers.delivery === undefined || !z.string().uuid().safeParse(headers.delivery).success) {
    throw new LinearWebhookError('Linear webhook delivery ID is invalid');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawBody).toString('utf8')) as unknown;
  } catch {
    throw new LinearWebhookError('Linear webhook body is not valid JSON');
  }
  const payload = linearWebhookSchema.safeParse(parsed);
  if (!payload.success) {
    throw new LinearWebhookError('Linear webhook body has an unsupported shape');
  }
  const timestampMs = payload.data.webhookTimestamp;
  if (Math.abs(nowMs - timestampMs) > LINEAR_WEBHOOK_TIMESTAMP_WINDOW_MS) {
    throw new LinearWebhookError('Linear webhook timestamp is outside the allowed window');
  }
  return payload.data;
}
