import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OpenCodeAdapter,
  redactSensitiveText,
} from '../../src/adapters/agent/opencode.js';
import { normalizeCommandResult } from '../../src/adapters/agent/command.js';
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

  it('does not manufacture a conflicting summary for a complete KAR-9 report', () => {
    const normalized = normalizeCommandResult(
      {
        exitCode: 0,
        unexpectedTermination: false,
        timedOut: false,
        cancelled: false,
        processGroupStopped: true,
        outputLimitExceeded: false,
        stdout: '{"result":"PASS","findings":[]}\n',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 1,
      },
      'review provider',
      'json'
    );

    expect(normalized.evidence?.summary).toBeUndefined();
    expect(normalized.stdout).toContain('"result":"PASS"');
  });

  it('maps provider JSONL into normalized evidence and pins cwd, model, and argv', async () => {
    let captured: AgentProcessSpec | undefined;
    const adapter = new OpenCodeAdapter({
      executable: '/opt/opencode',
      environment: {
        FAKE_PROVIDER_MODE: 'success',
        OPENCODE_API_KEY: 'opencode-secret',
        OPENAI_API_KEY: 'codex-secret',
        XAI_API_KEY: 'grok-secret',
        GOOGLE_GENERATIVE_AI_API_KEY: 'gemini-secret',
      },
      processRunner: {
        run: async (spec) => {
          captured = spec;
          return {
            processId: 41,
            exitCode: 0,
            unexpectedTermination: false,
            timedOut: false,
            cancelled: false,
            processGroupStopped: true,
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
    expect(captured?.env.OPENCODE_API_KEY).toBe('opencode-secret');
    expect(captured?.env.OPENAI_API_KEY).toBeUndefined();
    expect(captured?.env.XAI_API_KEY).toBeUndefined();
    expect(captured?.env.GOOGLE_GENERATIVE_AI_API_KEY).toBeUndefined();
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

  it('pins the OpenCode executable identity between capability probe and launch', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'shipgraph-opencode-probe-'));
    temporaryDirectories.push(directory);
    const executable = join(directory, 'opencode');
    const replacement = join(directory, 'replacement');
    const script = `#!/bin/sh
case "$1 $2" in
  "--version ") printf '1.0.0\\n' ;;
  "run --help") printf '%s\\n' '--format --dir --model --auto' ;;
  *) printf '%s\\n' '${successfulOutput}' ;;
esac
`;
    writeFileSync(executable, script, { mode: 0o700 });
    writeFileSync(replacement, script, { mode: 0o700 });
    chmodSync(executable, 0o700);
    chmodSync(replacement, 0o700);

    const adapter = new OpenCodeAdapter({
      executable,
      cwd: process.cwd(),
      environment: { PATH: directory },
    });
    await expect(adapter.probe()).resolves.toMatchObject({ available: true, version: '1.0.0' });
    renameSync(replacement, executable);

    await expect(adapter.execute({ ...request, workspacePath: process.cwd() })).rejects.toThrow(
      /executable provenance changed/
    );
  });

  it.each([
    ['non-zero exit', { exitCode: 7 }, 'non_zero_exit', 'FAILED'],
    ['malformed output', { exitCode: 0, stdout: '{not-json}\n' }, 'malformed_output', 'FAILED'],
    ['missing output', { exitCode: 0, stdout: '' }, 'missing_output', 'FAILED'],
    ['timeout', { exitCode: undefined, timedOut: true }, 'timeout', 'TIMED_OUT'],
    ['cancel', { exitCode: undefined, cancelled: true }, 'cancelled', 'CANCELLED'],
    ['unexpected death', { exitCode: undefined, unexpectedTermination: true }, 'unexpected_termination', 'FAILED'],
    ['output limit after termination signal', {
      exitCode: undefined,
      terminationSignal: 'SIGTERM',
      outputLimitExceeded: true,
      stdoutTruncated: true,
    }, 'output_limit', 'FAILED'],
  ])('normalizes %s deterministically', async (_name, override, category, outcome) => {
    const adapter = new OpenCodeAdapter({
      processRunner: {
        run: async () => ({
          exitCode: 0,
          unexpectedTermination: false,
          timedOut: false,
          cancelled: false,
          processGroupStopped: true,
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
    const redactedJson = redactSensitiveText(
      '{"client_secret":"json-secret-value","apiKey":"another-json-secret"}'
    );
    expect(redactedJson).toBe(
      '{"client_secret":"[REDACTED_SECRET]","apiKey":"[REDACTED_SECRET]"}'
    );
    expect(redactedJson).not.toContain('json-secret-value');
    expect(redactedJson).not.toContain('another-json-secret');
    expect(redactSensitiveText('Authorization: Basic dXNlcjpzdXBlci1zZWNyZXQ=')).toBe(
      'Authorization: Basic [REDACTED_SECRET]'
    );
    expect(redactSensitiveText('{"secretAccessKey":"aws-secret-value"}')).toBe(
      '{"secretAccessKey":"[REDACTED_SECRET]"}'
    );
    const escapedJson = String.raw`{\"client_secret\":\"escaped-json-secret\"}`;
    expect(redactSensitiveText(escapedJson)).toBe(
      String.raw`{\"client_secret\":\"[REDACTED_SECRET]\"}`
    );
    expect(redactSensitiveText('{"credential":"credential-secret"}')).toBe(
      '{"credential":"[REDACTED_SECRET]"}'
    );
    const punctuationSecret = redactSensitiveText(
      '{"token":"secret,with}json]punctuation"}'
    );
    expect(punctuationSecret).toBe('{"token":"[REDACTED_SECRET]"}');
    expect(punctuationSecret).not.toContain('secret,with}json]punctuation');
    const escapedPunctuationSecret = redactSensitiveText(
      JSON.stringify({ token: 'secret,with}]"quoted' })
    );
    expect(escapedPunctuationSecret).toBe('{"token":"[REDACTED_SECRET]"}');
    expect(redactSensitiveText('ordinary project output')).toBe('ordinary project output');
  });

  it('redacts authorization headers and provider token formats before persistence', () => {
    const redacted = redactSensitiveText(
      'Authorization: Bearer bearer-secret-value-123456 xai-xxxxxxxxxxxxxxxxxxxx '
        + 'AIzaSyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
    );
    expect(redacted).not.toContain('bearer-secret-value-123456');
    expect(redacted).not.toContain('xai-xxxxxxxxxxxxxxxxxxxx');
    expect(redacted).not.toContain('AIzaSyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    expect(redacted.match(/\[REDACTED_SECRET\]/gu)).toHaveLength(3);
  });

  it('redacts credential-shaped provider evidence before it crosses the adapter boundary', async () => {
    const adapter = new OpenCodeAdapter({
      processRunner: {
        run: async () => ({
          exitCode: 0,
          unexpectedTermination: false,
          timedOut: false,
          cancelled: false,
          processGroupStopped: true,
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

  it('does not report a clean result while a normal provider leader leaves a descendant', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'shipgraph-agent-descendant-'));
    temporaryDirectories.push(directory);
    const script = join(directory, 'provider.sh');
    writeFileSync(
      script,
      '#!/bin/sh\n' +
        `sh -c 'echo $$ > "${join(directory, 'descendant.pid')}"; sleep 30' >/dev/null 2>/dev/null &\n` +
        `while [ ! -s "${join(directory, 'descendant.pid')}" ]; do sleep 0.01; done\n` +
        'printf "provider-complete\\n"\n'
    );
    chmodSync(script, 0o700);

    const result = await createAgentProcessRunner().run({
      command: script,
      args: [],
      cwd: directory,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      timeoutMs: 5_000,
      maxOutputBytes: 128,
    });

    expect(result.exitCode).toBe(0);
    expect(result.unexpectedTermination).toBe(true);
    expect(result.processGroupStopped).toBe(true);
    const descendantPid = Number(readFileSync(join(directory, 'descendant.pid'), 'utf8').trim());
    expect(() => process.kill(descendantPid, 0)).toThrow();
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

  it('proves no process group started when spawn fails without assigning a PID', async () => {
    const result = await createAgentProcessRunner().run({
      command: '/definitely/not/a/real/provider',
      args: [],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 1_000,
      maxOutputBytes: 128,
    });

    expect(result.processId).toBeUndefined();
    expect(result.spawnErrorCode).toBe('ENOENT');
    expect(result.processGroupStopped).toBe(true);
  });

  it('rejects unsafe inherited environment controls', () => {
    expect(() => new OpenCodeAdapter({ environment: { NODE_OPTIONS: '--require evil' } })).toThrow(
      /unsafe OpenCode environment variable/
    );
  });
});
