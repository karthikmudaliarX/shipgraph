import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OpenCodeAdapter,
  redactSensitiveText,
} from '../../src/adapters/agent/opencode.js';
import {
  createAgentProcessRunner,
  type AgentProcessSpec,
} from '../../src/adapters/agent/process.js';
import type { AgentExecutionRequest } from '../../src/adapters/agent/adapter.js';

const request: AgentExecutionRequest = {
  runId: 'run-1',
  projectId: 'project-1',
  ticketId: 'AG-001',
  workspaceId: 'workspace-1',
  workspacePath: '/tmp/shipgraph-workspace',
  branchName: 'shipgraph/ag-001',
  baseSha: '0123456789012345678901234567890123456789',
  provider: 'opencode',
  model: 'openai/gpt-5',
  instructions: 'Implement the ticket',
  timeoutMs: 1_000,
  maxOutputBytes: 4_096,
};

const successfulOutput = JSON.stringify({
  type: 'text',
  sessionID: 'ses_123',
  part: { text: 'implemented' },
});

describe('OpenCode adapter and process boundary', () => {
  let temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
    temporaryDirectories = [];
  });

  it('maps provider JSONL into normalized evidence and pins cwd, model, and argv', async () => {
    let captured: AgentProcessSpec | undefined;
    const adapter = new OpenCodeAdapter({
      executable: '/opt/opencode',
      environment: { FAKE_PROVIDER_MODE: 'success' },
      processRunner: {
        run: async (spec) => {
          captured = spec;
          return {
            processId: 41,
            exitCode: 0,
            unexpectedTermination: false,
            timedOut: false,
            cancelled: false,
            outputLimitExceeded: false,
            stdout: `${successfulOutput}\n`,
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: 2,
          };
        },
      },
    });

    const result = await adapter.execute(request);

    expect(captured).toMatchObject({
      command: '/opt/opencode',
      cwd: request.workspacePath,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
    });
    expect(captured?.args).toEqual([
      'run',
      '--format',
      'json',
      '--dir',
      request.workspacePath,
      '--model',
      request.model,
      '--auto',
      request.instructions,
    ]);
    expect(captured?.env.OPENCODE_CLIENT).toBe('shipgraph');
    expect(captured?.env.FAKE_PROVIDER_MODE).toBe('success');
    expect(result).toMatchObject({
      outcome: 'SUCCEEDED',
      providerSessionId: 'ses_123',
      providerProcessId: 41,
      evidence: {
        outputFormat: 'jsonl',
        eventCount: 1,
        eventTypes: ['text'],
        summary: 'implemented',
      },
    });
  });

  it('does not invent a model and rejects a provider mismatch', async () => {
    const adapter = new OpenCodeAdapter({
      processRunner: { run: async () => { throw new Error('must not run'); } },
    });
    await expect(
      adapter.execute({ ...request, provider: 'codex' })
    ).rejects.toThrow(/cannot execute provider codex/);
  });

  it.each([
    ['non-zero exit', { exitCode: 7 }, 'non_zero_exit', 'FAILED'],
    ['malformed output', { exitCode: 0, stdout: '{not-json}\n' }, 'malformed_output', 'FAILED'],
    ['missing output', { exitCode: 0, stdout: '' }, 'missing_output', 'FAILED'],
    ['timeout', { exitCode: undefined, timedOut: true }, 'timeout', 'TIMED_OUT'],
    ['cancel', { exitCode: undefined, cancelled: true }, 'cancelled', 'CANCELLED'],
    ['unexpected death', { exitCode: undefined, unexpectedTermination: true }, 'unexpected_termination', 'FAILED'],
  ])('normalizes %s deterministically', async (_name, override, category, outcome) => {
    const adapter = new OpenCodeAdapter({
      processRunner: {
        run: async () => ({
          exitCode: 0,
          unexpectedTermination: false,
          timedOut: false,
          cancelled: false,
          outputLimitExceeded: false,
          stdout: successfulOutput,
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 1,
          ...override,
        }),
      },
    });
    const result = await adapter.execute(request);
    expect(result.outcome).toBe(outcome);
    expect(result.failureCategory).toBe(category);
  });

  it('maps missing and non-executable providers without throwing', async () => {
    const adapter = new OpenCodeAdapter({
      executable: '/definitely/not/a/real/opencode',
      processRunner: createAgentProcessRunner(),
    });
    const result = await adapter.execute({ ...request, workspacePath: process.cwd() });
    expect(result.outcome).toBe('FAILED');
    expect(result.failureCategory).toBe('executable_missing');
  });

  it('redacts common credential-shaped output before persistence', () => {
    expect(redactSensitiveText('token=super-secret api_key="secret-value" ghp_12345678901234567890')).toContain(
      '[REDACTED_SECRET]'
    );
    expect(redactSensitiveText('ordinary project output')).toBe('ordinary project output');
  });

  it('redacts credential-shaped provider evidence before it crosses the adapter boundary', async () => {
    const adapter = new OpenCodeAdapter({
      processRunner: {
        run: async () => ({
          exitCode: 0,
          unexpectedTermination: false,
          timedOut: false,
          cancelled: false,
          outputLimitExceeded: false,
          stdout: `${JSON.stringify({ type: 'text', text: 'api_key=secret-value' })}\n`,
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 1,
        }),
      },
    });
    const result = await adapter.execute(request);
    expect(result.evidence?.summary).toBe('api_key=[REDACTED_SECRET]');
  });

  it('bounds output and terminates the provider process tree when the limit is exceeded', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'shipgraph-agent-process-'));
    temporaryDirectories.push(directory);
    const script = join(directory, 'provider.sh');
    writeFileSync(
      script,
      '#!/bin/sh\n' +
        'sleep 30 &\n' +
        'printf "0123456789%.0s" $(seq 1 10000)\n' +
        'while true; do sleep 1; done\n'
    );
    chmodSync(script, 0o700);

    const result = await createAgentProcessRunner().run({
      command: script,
      args: [],
      cwd: directory,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      timeoutMs: 100,
      maxOutputBytes: 128,
    });

    expect(result.timedOut).toBe(false);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(128);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.outputLimitExceeded).toBe(true);
  });

  it('terminates the provider process tree on timeout', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'shipgraph-agent-timeout-'));
    temporaryDirectories.push(directory);
    const script = join(directory, 'provider.sh');
    writeFileSync(
      script,
      '#!/bin/sh\n' +
        'sleep 30 &\n' +
        'while true; do sleep 1; done\n'
    );
    chmodSync(script, 0o700);

    const result = await createAgentProcessRunner().run({
      command: script,
      args: [],
      cwd: directory,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      timeoutMs: 100,
      maxOutputBytes: 128,
    });

    expect(result.timedOut).toBe(true);
    expect(result.outputLimitExceeded).toBe(false);
  });

  it('honors cancellation before spawning a process', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await createAgentProcessRunner().run({
      command: '/definitely/not/a/real/provider',
      args: [],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 1_000,
      maxOutputBytes: 128,
      signal: controller.signal,
    });
    expect(result.cancelled).toBe(true);
    expect(result.processId).toBeUndefined();
    expect(result.spawnErrorCode).toBeUndefined();
  });

  it('rejects unsafe inherited environment controls', () => {
    expect(() => new OpenCodeAdapter({ environment: { NODE_OPTIONS: '--require evil' } })).toThrow(
      /unsafe OpenCode environment variable/
    );
  });
});
