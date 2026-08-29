import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentExecutionRequest } from '../../src/adapters/agent/adapter.js';
import type { AgentProcessResult, AgentProcessSpec, AgentProcessRunner } from '../../src/adapters/agent/process.js';
import { CodexAdapter, GeminiAdapter, GrokAdapter } from '../../src/adapters/agent/providers.js';
import {
  AgentExecutionAdapterRegistry,
  MODEL_PROVIDER_TO_AGENT_PROVIDER,
} from '../../src/adapters/agent/registry.js';

const request: AgentExecutionRequest = {
  runId: 'run-1',
  projectId: 'project-1',
  ticketId: 'KAR-6001',
  workspaceId: 'workspace-1',
  workspacePath: '/tmp/shipgraph-agent-worktree',
  branchName: 'agent/kar-6001',
  baseSha: '0123456789012345678901234567890123456789',
  provider: 'codex',
  model: 'provider/dynamic-model',
  instructions: 'Implement the approved task',
  timeoutMs: 1_000,
  maxOutputBytes: 4_096,
};

function result(overrides: Partial<AgentProcessResult> = {}): AgentProcessResult {
  return {
    exitCode: 0,
    unexpectedTermination: false,
    timedOut: false,
    cancelled: false,
    processGroupStopped: true,
    outputLimitExceeded: false,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
    ...overrides,
  };
}

function scriptedRunner(
  helpOutput: string,
  executionOutput: string,
  calls: AgentProcessSpec[],
  versionOutput = 'provider 1.0.0\n'
): AgentProcessRunner {
  return {
    run: async (spec) => {
      calls.push(spec);
      if (spec.args[0] === '--version') return result({ stdout: versionOutput });
      if (spec.args.includes('--help')) return result({ stdout: helpOutput });
      return result({ stdout: executionOutput });
    },
  };
}

describe('deferred MODEL-001 provider execution adapters', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
    temporaryDirectories.length = 0;
  });

  it('probes and executes Codex through its JSONL exec surface', async () => {
    const calls: AgentProcessSpec[] = [];
    const adapter = new CodexAdapter({
      executable: '/opt/codex',
      cwd: '/tmp/shipgraph-project',
      processRunner: scriptedRunner(
        'exec --json --model --cd --approve-for-me --ephemeral\n',
        '{"type":"result","session_id":"codex-session","text":"done"}\n',
        calls,
        'codex-cli 1.0.0\n'
      ),
    });

    await expect(adapter.probe()).resolves.toMatchObject({ available: true, version: 'codex-cli 1.0.0' });
    const execution = await adapter.execute(request);

    expect(calls.slice(0, 2).map((call) => call.args)).toEqual([
      ['--version'],
      ['exec', '--help'],
    ]);
    expect(calls[2]).toMatchObject({
      command: '/opt/codex',
      cwd: request.workspacePath,
      args: [
        'exec',
        '--json',
        '--ephemeral',
        '--cd',
        request.workspacePath,
        '--model',
        request.model,
        '--approve-for-me',
        request.instructions,
      ],
    });
    expect(execution).toMatchObject({
      outcome: 'SUCCEEDED',
      providerSessionId: 'codex-session',
      evidence: { outputFormat: 'jsonl', eventCount: 1 },
    });
  });

  it('probes and executes Grok through the ACP-bound single-turn JSON surface', async () => {
    const calls: AgentProcessSpec[] = [];
    const adapter = new GrokAdapter({
      executable: '/opt/grok',
      cwd: '/tmp/shipgraph-project',
      processRunner: scriptedRunner(
        '--single --output-format --model --cwd --permission-mode --allow --tools --disallowed-tools --no-subagents --no-plan --no-memory --disable-web-search --sandbox\n',
        '{"type":"result","conversationId":"grok-session","text":"done"}\n',
        calls,
        'grok 1.0.0\n'
      ),
    });

    await expect(adapter.probe()).resolves.toMatchObject({ available: true });
    const execution = await adapter.execute({ ...request, provider: 'acp' });

    expect(calls[2]?.args).toEqual([
      '--single',
      request.instructions,
      '--output-format',
      'json',
      '--model',
      request.model,
      '--cwd',
      request.workspacePath,
      '--permission-mode',
      'dontAsk',
      '--allow',
      'Read',
      '--allow',
      'Grep',
      '--allow',
      'Edit',
      '--allow',
      'Bash',
      '--tools',
      'run_terminal_cmd,grep,read_file,search_replace',
      '--disallowed-tools',
      'web_search,web_fetch,search_tool,use_tool,Agent',
      '--no-subagents',
      '--no-plan',
      '--no-memory',
      '--disable-web-search',
      '--sandbox',
      'workspace',
    ]);
    expect(execution).toMatchObject({
      outcome: 'SUCCEEDED',
      providerSessionId: 'grok-session',
      evidence: { outputFormat: 'json', eventCount: 1 },
    });
  });

  it.each([
    '--single',
    '--output-format',
    '--model',
    '--cwd',
    '--permission-mode',
    '--allow',
    '--tools',
    '--disallowed-tools',
    '--no-subagents',
    '--no-plan',
    '--no-memory',
    '--disable-web-search',
    '--sandbox',
  ])('keeps Grok unavailable when its execution restriction %s is absent', async (missing) => {
    const adapter = new GrokAdapter({
      executable: '/opt/grok',
      processRunner: scriptedRunner(
        [
          '--single',
          '--output-format',
          '--model',
          '--cwd',
          '--permission-mode',
          '--allow',
          '--tools',
          '--disallowed-tools',
          '--no-subagents',
          '--no-plan',
          '--no-memory',
          '--disable-web-search',
          '--sandbox',
        ].filter((token) => token !== missing).join(' '),
        '',
        [],
        'grok 1.0.0\n'
      ),
    });

    await expect(adapter.probe()).resolves.toEqual({
      available: false,
      reason: `Grok execution capability probe did not advertise ${missing}`,
    });
  });

  it('preserves the logged-in Grok home while filtering unrelated credentials', async () => {
    const calls: AgentProcessSpec[] = [];
    const adapter = new GrokAdapter({
      executable: '/opt/grok',
      environment: {
        XAI_API_KEY: 'grok-secret',
        GROK_HOME: '/tmp/grok-user-home',
        OPENAI_API_KEY: 'openai-secret',
      },
      processRunner: scriptedRunner(
        '--single --output-format --model --cwd --permission-mode --allow --tools --disallowed-tools --no-subagents --no-plan --no-memory --disable-web-search --sandbox\n',
        '',
        calls,
        'grok 1.0.0\n'
      ),
    });

    await expect(adapter.probe()).resolves.toMatchObject({ available: true });
    expect(calls[0]?.env.XAI_API_KEY).toBe('grok-secret');
    expect(calls[0]?.env.OPENAI_API_KEY).toBeUndefined();
    expect(calls[0]?.env.GROK_HOME).toBe('/tmp/grok-user-home');
    expect(calls[0]?.env.HOME).toBe(process.env.HOME);
    expect(calls[0]?.env.HOME).not.toMatch(/shipgraph-grok-home-/u);
    expect(calls[0]?.env.GROK_WORKFLOWS).toBeUndefined();
  });

  it('pins the probed executable and refuses a replacement before launch', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'shipgraph-agent-probe-'));
    temporaryDirectories.push(directory);
    const executable = join(directory, 'grok');
    const replacement = join(directory, 'grok-replacement');
    const script = `#!/bin/sh
case "$1" in
  --version) printf 'grok 1.0.0\\n' ;;
  --help) printf '%s\\n' '--single --output-format --model --cwd --permission-mode --allow --tools --disallowed-tools --no-subagents --no-plan --no-memory --disable-web-search --sandbox' ;;
  *) printf '%s\\n' '{"type":"result","text":"done"}' ;;
esac
`;
    writeFileSync(executable, script, { mode: 0o700 });
    writeFileSync(replacement, script, { mode: 0o700 });
    chmodSync(executable, 0o700);

    const adapter = new GrokAdapter({ executable, cwd: process.cwd() });
    await expect(adapter.probe()).resolves.toMatchObject({ available: true });
    renameSync(replacement, executable);

    await expect(adapter.execute({ ...request, provider: 'acp' })).rejects.toThrow(
      /executable provenance changed/
    );
  });

  it('uses Antigravity agy, not Gemini CLI, for the Gemini model provider', async () => {
    const calls: AgentProcessSpec[] = [];
    const adapter = new GeminiAdapter({
      cwd: '/tmp/shipgraph-project',
      processRunner: scriptedRunner(
        '--print --output-format --model --mode --disable-slash-commands --sandbox\n',
        '{"type":"result","conversationId":"agy-session","text":"done"}\n',
        calls,
        '1.0.0\n'
      ),
    });

    await expect(adapter.probe()).resolves.toMatchObject({ available: true });
    const execution = await adapter.execute({ ...request, provider: 'acp' });

    expect(calls[2]).toMatchObject({
      command: 'agy',
      cwd: request.workspacePath,
      args: [
        '--print',
        request.instructions,
        '--output-format',
        'json',
        '--model',
        request.model,
        '--mode',
        'accept-edits',
        '--disable-slash-commands',
        '--sandbox',
      ],
    });
    expect(execution).toMatchObject({
      outcome: 'SUCCEEDED',
      providerSessionId: 'agy-session',
      evidence: { outputFormat: 'json', eventCount: 1 },
    });
  });

  it('rejects an Antigravity executable with an unrecognized version identity', async () => {
    const adapter = new GeminiAdapter({
      executable: '/opt/agy',
      processRunner: scriptedRunner(
        '--print --output-format --model --mode --disable-slash-commands --sandbox\n',
        '',
        [],
        'agy-cli 1.0.0\n'
      ),
    });

    await expect(adapter.probe()).resolves.toEqual({
      available: false,
      reason: 'Gemini version probe did not match the expected identity format',
    });
  });

  it('keeps an executable non-routable when its claimed automation flags are absent', async () => {
    const adapter = new GeminiAdapter({
      executable: '/opt/agy',
      processRunner: scriptedRunner('--help --model\n', '', [], '1.0.0\n'),
    });

    await expect(adapter.probe()).resolves.toEqual({
      available: false,
      reason: 'Gemini execution capability probe did not advertise --print',
    });
  });

  it('keeps the MODEL-to-AGENT identity mapping exhaustive and fail closed', () => {
    expect(MODEL_PROVIDER_TO_AGENT_PROVIDER).toEqual({
      'opencode-go': 'opencode',
      codex: 'codex',
      grok: 'acp',
      gemini: 'acp',
    });
    expect(() => new AgentExecutionAdapterRegistry([{
      modelProviderId: 'codex',
      adapter: new GrokAdapter({ executable: '/opt/grok' }),
    }])).toThrow(/uses acp; expected codex/);
  });

  it('keeps shared ACP adapters bound to their concrete MODEL provider identity', () => {
    const grok = new GrokAdapter({ executable: '/opt/grok' });
    const gemini = new GeminiAdapter({ executable: '/opt/agy' });
    const registry = new AgentExecutionAdapterRegistry([
      { modelProviderId: 'grok', adapter: grok },
      { modelProviderId: 'gemini', adapter: gemini },
    ]);
    const target = registry.resolve({
      providerId: 'gemini',
      modelId: 'google/dynamic-model',
      task: 'implementation',
    });

    expect(target).not.toHaveProperty('adapter');
    expect(target.provider).toBe('acp');
    expect(registry.capabilities(target)).toEqual(['execute', 'review', 'repair']);
    expect(() => registry.capabilities({ ...target, provider: 'codex' }))
      .toThrow(/trustworthy AGENT-001 execution adapter/);
    expect(() => new AgentExecutionAdapterRegistry([
      { modelProviderId: 'gemini', adapter: grok },
    ])).toThrow(/not branded for that MODEL provider/);
  });
});
