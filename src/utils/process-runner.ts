import { execa } from 'execa';

const PROCESS_TIMEOUT_MS = 10_000;

export type ProcessResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export interface ProcessRunner {
  run(command: string, args?: readonly string[]): Promise<ProcessResult>;
}

export const defaultProcessRunner: ProcessRunner = {
  async run(command, args = []): Promise<ProcessResult> {
    try {
      const result = await execa(command, args, {
        reject: false,
        cleanup: true,
        timeout: PROCESS_TIMEOUT_MS,
      });
      return {
        command: [command, ...args].join(' '),
        exitCode: result.exitCode ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    } catch (error) {
      return {
        command: [command, ...args].join(' '),
        exitCode: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

export function createProcessRunner(): ProcessRunner {
  return defaultProcessRunner;
}
