import { describe, expect, it } from 'vitest';
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
  calls: AgentProcessSpec[]
): AgentProcessRunner {
  return {
    run: async (spec) => {
      calls.push(spec);
      if (spec.args[0] === '--version') return result({ stdout: 'provider 1.0.0\n' });
      if (spec.args.includes('--help')) return result({ stdout: helpOutput });
      return result({ stdout: executionOutput });
    },
  };
}

describe('deferred MODEL-001 provider execution adapters', () => {
  it('probes and executes Codex through its JSONL exec surface', async () => {
    const calls: AgentProcessSpec[] = [];
    const adapter = new CodexAdapter({
      executable: '/opt/codex',
      cwd: '/tmp/shipgraph-project',
      processRunner: scriptedRunner(
        'exec --json --model --cd --sandbox --approve-for-me --ephemeral\n',
        '{"type":"result","session_id":"codex-session","text":"done"}\n',
        calls
      ),
    });

    await expect(adapter.probe()).resolves.toMatchObject({ available: true, version: 'provider 1.0.0' });
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
        '--sandbox',
        'workspace-write',
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
        '--single --output-format --model --cwd --always-approve --sandbox\n',
        '{"type":"result","conversationId":"grok-session","text":"done"}\n',
        calls
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
      '--always-approve',
      '--no-subagents',
      '--no-plan',
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

  it('uses Antigravity agy, not Gemini CLI, for the Gemini model provider', async () => {
    const calls: AgentProcessSpec[] = [];
    const adapter = new GeminiAdapter({
      cwd: '/tmp/shipgraph-project',
      processRunner: scriptedRunner(
        '--print --output-format --model --mode --disable-slash-commands --sandbox\n',
        '{"type":"result","conversationId":"agy-session","text":"done"}\n',
        calls
      ),
    });

    await expect(adapter.probe()).resolves.toMatchObject({ available: true });
    const execution = await adapter.execute({ ...request, provider: 'acp' });

    expect(calls[2]).toMatchObject({
      command: 'agy',
      cwd: request.workspacePath,
      args: [
        '--print',
        '--output-format',
        'json',
        '--model',
        request.model,
        '--mode',
        'accept-edits',
        '--disable-slash-commands',
        '--sandbox',
        request.instructions,
      ],
    });
    expect(execution).toMatchObject({
      outcome: 'SUCCEEDED',
      providerSessionId: 'agy-session',
      evidence: { outputFormat: 'json', eventCount: 1 },
    });
  });

  it('keeps an executable non-routable when its claimed automation flags are absent', async () => {
    const adapter = new GeminiAdapter({
      executable: '/opt/not-agy',
      processRunner: scriptedRunner('--help --model\n', '', []),
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
});
