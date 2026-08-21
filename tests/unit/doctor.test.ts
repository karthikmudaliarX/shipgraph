import { describe, it, expect, vi } from 'vitest';
import { runDoctor, type DoctorCheckName } from '../../src/cli/doctor.js';
import type { ProcessRunner, ProcessResult } from '../../src/utils/process-runner.js';

function makeRunner(
  responses: Record<string, ProcessResult>
): ProcessRunner {
  return {
    async run(command, args = []): Promise<ProcessResult> {
      const key = [command, ...args].join(' ');
      return (
        responses[key] ?? {
          command: key,
          exitCode: 1,
          stdout: '',
          stderr: 'not configured in mock',
        }
      );
    },
  };
}

describe('doctor', () => {
  it('reports healthy when all required tools are available', async () => {
    const runner = makeRunner({
      'git --version': {
        command: 'git --version',
        exitCode: 0,
        stdout: 'git version 2.46.0',
        stderr: '',
      },
      'gh --version': {
        command: 'gh --version',
        exitCode: 0,
        stdout: 'gh version 2.57.0',
        stderr: '',
      },
      'gh auth status': {
        command: 'gh auth status',
        exitCode: 0,
        stdout: 'Logged in',
        stderr: '',
      },
      'pnpm --version': {
        command: 'pnpm --version',
        exitCode: 0,
        stdout: '9.12.0',
        stderr: '',
      },
      'opencode --version': {
        command: 'opencode --version',
        exitCode: 0,
        stdout: '0.1.0',
        stderr: '',
      },
      'codex --version': {
        command: 'codex --version',
        exitCode: 1,
        stdout: '',
        stderr: 'command not found',
      },
    });

    const report = await runDoctor({ runner, json: true });
    expect(report.healthy).toBe(true);

    const requiredChecks: DoctorCheckName[] = [
      'node_version',
      'git_available',
      'gh_available',
      'gh_authenticated',
      'pnpm_available',
      'sqlite_operational',
    ];

    for (const name of requiredChecks) {
      const check = report.checks.find((c) => c.name === name);
      expect(check?.status).toBe('pass');
    }

    const codex = report.checks.find((c) => c.name === 'codex_installed');
    expect(codex?.status).toBe('info');
  });

  it('reports unhealthy when a required tool is missing', async () => {
    const runner = makeRunner({
      'git --version': {
        command: 'git --version',
        exitCode: 0,
        stdout: 'git version 2.46.0',
        stderr: '',
      },
      'gh --version': {
        command: 'gh --version',
        exitCode: 1,
        stdout: '',
        stderr: 'command not found',
      },
      'gh auth status': {
        command: 'gh auth status',
        exitCode: 1,
        stdout: '',
        stderr: 'command not found',
      },
      'pnpm --version': {
        command: 'pnpm --version',
        exitCode: 0,
        stdout: '9.12.0',
        stderr: '',
      },
      'opencode --version': {
        command: 'opencode --version',
        exitCode: 1,
        stdout: '',
        stderr: 'command not found',
      },
      'codex --version': {
        command: 'codex --version',
        exitCode: 1,
        stdout: '',
        stderr: 'command not found',
      },
    });

    const report = await runDoctor({ runner, json: true });
    expect(report.healthy).toBe(false);

    const ghAvailable = report.checks.find((c) => c.name === 'gh_available');
    expect(ghAvailable?.status).toBe('fail');
  });

  it('returns structured JSON output', async () => {
    const runner = makeRunner({
      'git --version': { command: 'git --version', exitCode: 0, stdout: 'git', stderr: '' },
      'gh --version': { command: 'gh --version', exitCode: 0, stdout: 'gh', stderr: '' },
      'gh auth status': { command: 'gh auth status', exitCode: 0, stdout: '', stderr: '' },
      'pnpm --version': { command: 'pnpm --version', exitCode: 0, stdout: 'pnpm', stderr: '' },
      'opencode --version': {
        command: 'opencode --version',
        exitCode: 1,
        stdout: '',
        stderr: '',
      },
      'codex --version': { command: 'codex --version', exitCode: 1, stdout: '', stderr: '' },
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const report = await runDoctor({ runner, json: true });

    expect(report.checks).toHaveLength(8);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('healthy'));
    consoleSpy.mockRestore();
  });
});
