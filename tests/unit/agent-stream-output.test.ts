import { describe, expect, it } from 'vitest';
import { createAgentProcessRunner, type AgentProcessResult, type AgentProcessSpec } from '../../src/adapters/agent/process.js';
import { CodexAdapter } from '../../src/adapters/agent/providers.js';
import { OpenCodeAdapter } from '../../src/adapters/agent/opencode.js';
import { JsonlOutputCollector, AGENT_JSONL_RECORD_LIMIT_BYTES } from '../../src/adapters/agent/structured-output.js';
import { normalizedAgentEvidenceSchema, AGENT_OUTPUT_LIMIT_BYTES } from '../../src/domain/agent-run.js';
import type { AgentExecutionRequest } from '../../src/adapters/agent/adapter.js';
import { normalizeCommandResult } from '../../src/adapters/agent/command.js';

const request: AgentExecutionRequest = {
  runId: 'run-stream', projectId: 'project', ticketId: 'KAR-19', workspaceId: 'workspace',
  workspacePath: process.cwd(), branchName: 'agent/kar-19', baseSha: 'a'.repeat(40),
  provider: 'codex', model: 'test', instructions: 'test', timeoutMs: 5_000,
  maxOutputBytes: AGENT_OUTPUT_LIMIT_BYTES,
};

function runScript(script: string, options: Partial<AgentProcessSpec> = {}): Promise<AgentProcessResult> {
  return createAgentProcessRunner().run({
    command: process.execPath, args: ['-e', script], cwd: process.cwd(), env: {},
    timeoutMs: 5_000, maxOutputBytes: AGENT_OUTPUT_LIMIT_BYTES, ...options,
  });
}

function collect(parts: readonly (string | Buffer)[], protocol: 'codex' | 'opencode' = 'codex') {
  const collector = new JsonlOutputCollector(protocol);
  for (const part of parts) expect(collector.append(Buffer.from(part))).toBe(true);
  return collector.finish();
}

const complete = '{"type":"turn.completed"}\n';

describe('independent retained output and stream safety boundaries', () => {
  it.each(['codex', 'opencode'] as const)('lets %s complete beyond 128 KiB and validates evidence beyond 10,000 events', async (provider) => {
    let raw: AgentProcessResult | undefined;
    const last = provider === 'codex'
      ? { type: 'turn.completed', thread_id: 'session-after-retention', text: 'done token=secret-value' }
      : { type: 'step_finish', sessionID: 'session-after-retention', part: { reason: 'stop', text: 'done token=secret-value' } };
    const script = `
      const { once } = require('node:events');
      async function write(stream, data) { if (!stream.write(data)) await once(stream, 'drain'); }
      (async () => {
        for (let i = 0; i < 11000; i++) await write(process.stdout, JSON.stringify({type:'text', text:'progress '.repeat(4)})+'\\n');
        await write(process.stderr, 'diagnostic '.repeat(20000));
        await new Promise(resolve => setTimeout(resolve, 30));
        await write(process.stdout, ${JSON.stringify(JSON.stringify(last))});
      })().catch(() => process.exitCode = 1);
    `;
    const processRunner = { run: async (spec: AgentProcessSpec) => {
      raw = await runScript(script, { ...spec, command: process.execPath, args: ['-e', script] });
      return raw;
    } };
    const adapter = provider === 'codex' ? new CodexAdapter({ processRunner }) : new OpenCodeAdapter({ processRunner });
    const result = await adapter.execute({ ...request, provider });
    expect(raw).toMatchObject({ exitCode: 0, outputLimitExceeded: false, processGroupStopped: true,
      stdoutTruncated: true, stderrTruncated: true, unexpectedTermination: false });
    expect(raw?.terminationSignal).toBeUndefined();
    expect(result).toMatchObject({ outcome: 'SUCCEEDED', providerSessionId: 'session-after-retention',
      evidence: { eventCount: 11001, summary: 'done token=[REDACTED_SECRET]' } });
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(AGENT_OUTPUT_LIMIT_BYTES);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(AGENT_OUTPUT_LIMIT_BYTES);
    expect(normalizedAgentEvidenceSchema.safeParse(result.evidence).success).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it('terminates at the combined stdout/stderr consumption budget, not either retention cap', async () => {
    const result = await runScript("process.stdout.write('x'.repeat(600)); process.stderr.write('y'.repeat(600)); setInterval(()=>{},1000)",
      { maxOutputBytes: 100, maxStreamBytes: 1000 });
    expect(result).toMatchObject({ outputLimitExceeded: true, timedOut: false, stdoutTruncated: true,
      stderrTruncated: true, processGroupStopped: true });
    expect(result.terminationSignal).toBe('SIGTERM');
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(100);
  });

  it('terminates an oversized unterminated JSONL record with the independent record budget', async () => {
    const result = await runScript(`process.stdout.write('x'.repeat(${AGENT_JSONL_RECORD_LIMIT_BYTES + 1})); setInterval(()=>{},1000)`,
      { jsonlProtocol: 'codex' });
    expect(result).toMatchObject({ outputLimitExceeded: true, timedOut: false, processGroupStopped: true });
    expect(result.structuredOutput?.valid).toBe(false);
  });

  it.each(['timeout', 'cancel'] as const)('preserves %s after retained output fills', async (mode) => {
    const controller = new AbortController();
    let abortTimer: NodeJS.Timeout | undefined;
    try {
      const result = await runScript("process.stdout.write('x'.repeat(10000)); setInterval(()=>{},1000)", {
        maxOutputBytes: 128, timeoutMs: mode === 'timeout' ? 500 : 5000,
        signal: controller.signal,
        onStarted: () => { if (mode === 'cancel') abortTimer = setTimeout(() => controller.abort(), 500); },
      });
      expect(result).toMatchObject({ timedOut: mode === 'timeout', cancelled: mode === 'cancel',
        stdoutTruncated: true, outputLimitExceeded: false, processGroupStopped: true });
    } finally { if (abortTimer !== undefined) clearTimeout(abortTimer); }
  });

  it('keeps retained UTF-8 output inside its byte cap even at multibyte/invalid boundaries', async () => {
    const result = await runScript("process.stdout.write('😀'.repeat(100)); process.stderr.write(Buffer.alloc(100,255))", { maxOutputBytes: 5 });
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(5);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(5);
    expect(result.stdout).toBe('😀');
    expect(result.outputLimitExceeded).toBe(false);
  });

  it('bounds redaction expansion as well as raw retained bytes', async () => {
    const result = await runScript("process.stdout.write('token=x')", { maxOutputBytes: 8 });
    const normalized = normalizeCommandResult(result, 'test', 'json');
    expect(Buffer.byteLength(normalized.stdout)).toBeLessThanOrEqual(8);
    expect(normalized.stdout).not.toContain('=x');
    expect(normalized.stdoutTruncated).toBe(true);
  });

  it('does not leak a credential cut in the middle of a quoted JSON value', async () => {
    const result = await runScript("process.stdout.write(JSON.stringify({token:'sensitive-value'.repeat(100)}))", { maxOutputBytes: 64 });
    const normalized = normalizeCommandResult(result, 'test', 'json');
    expect(normalized.stdout).not.toContain('sensitive');
    expect(normalized.stdoutTruncated).toBe(true);
  });

  it('keeps non-streaming JSON adapters fail-closed when their document is truncated', async () => {
    const result = await runScript("process.stdout.write(JSON.stringify({text:'x'.repeat(1000)}))", { maxOutputBytes: 128 });
    expect(result.exitCode).toBe(0);
    expect(result.outputLimitExceeded).toBe(false);
    expect(normalizeCommandResult(result, 'JSON provider', 'json').failureCategory).toBe('malformed_output');
  });
});

describe('bounded incremental structured evidence', () => {
  it('decodes split UTF-8 and accepts a complete final record without newline', () => {
    const bytes = Buffer.from('{"type":"turn.completed","text":"😀"}');
    const boundary = bytes.indexOf(Buffer.from('😀')) + 1;
    expect(collect([bytes.subarray(0, boundary), bytes.subarray(boundary)])).toMatchObject({
      valid: true, evidence: { summary: '😀', eventCount: 1 },
    });
  });

  it.each([
    ['malformed suffix', [complete, '{bad}\n']],
    ['partial suffix', [complete, '{"type":']],
    ['missing terminal', ['{"type":"turn.started"}\n']],
    ['provider failure after success', [complete, '{"type":"turn.failed","error":{"message":"failure"}}\n']],
    ['provider error after success', [complete, '{"type":"error"}\n']],
    ['session conflict', ['{"type":"thread.started","thread_id":"a"}\n', '{"type":"turn.completed","thread_id":"b"}\n']],
    ['redacted session collision', ['{"type":"thread.started","thread_id":"sk-aaaaaaaaaaaaaaaa"}\n', '{"type":"turn.completed","thread_id":"sk-bbbbbbbbbbbbbbbb"}\n']],
    ['non-object', [complete, '[]\n']],
    ['new unfinished turn', [complete, '{"type":"turn.started"}\n']],
  ])('fails closed for %s', (_name, parts) => {
    expect(collect(parts).valid).toBe(false);
  });

  it('rejects invalid UTF-8 rather than silently repairing structured data', () => {
    expect(collect([Buffer.concat([Buffer.from('{"text":"'), Buffer.from([255]), Buffer.from('"}\n')]), complete]).valid).toBe(false);
  });

  it('does not mistake an OpenCode tool-call step for final completion', () => {
    expect(collect(['{"type":"step_finish","part":{"reason":"tool-calls"}}\n'], 'opencode').valid).toBe(false);
  });

  it('bounds event type cardinality while keeping the total count truthful', () => {
    const events = Array.from({ length: 100 }, (_, i) => JSON.stringify({ type: `event-${i}` }) + '\n');
    const result = collect([...events, complete]);
    expect(result.evidence?.eventTypes).toHaveLength(64);
    expect(result.evidence?.eventCount).toBe(101);
  });

  it('redacts session identity, event types and bounded summary', () => {
    const result = collect([JSON.stringify({type:'token=short-secret',thread_id:'token=short-secret',text:'token=short-secret'})+'\n',complete]);
    expect(result.valid).toBe(true);
    expect(JSON.stringify(result)).not.toContain('short-secret');
  });
});
