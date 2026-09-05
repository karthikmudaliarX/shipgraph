import { spawn, type ChildProcess } from 'node:child_process';
import { JsonlOutputCollector, type JsonlProtocol, type StructuredOutput } from './structured-output.js';

/** Combined stdout + stderr consumption budget, independent of retained evidence. */
export const AGENT_STREAM_LIMIT_BYTES = 64 * 1024 * 1024;

const TERMINATION_GRACE_MS = 1_000;
const PROCESS_GROUP_POLL_MS = 25;

export type AgentProcessSpec = {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputBytes: number;
  /** May lower, but never raise, the combined stream safety budget. */
  maxStreamBytes?: number;
  jsonlProtocol?: JsonlProtocol;
  signal?: AbortSignal;
  onStarted?: (processId: number) => void | Promise<void>;
};

export type AgentProcessResult = {
  processId?: number;
  exitCode?: number;
  terminationSignal?: string;
  spawnErrorCode?: string;
  startError?: string;
  unexpectedTermination: boolean;
  timedOut: boolean;
  cancelled: boolean;
  /** False when an owned provider process group could not be proven stopped. */
  processGroupStopped?: boolean;
  /** A consumption/record safety budget was exceeded, not merely retained text. */
  outputLimitExceeded: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  /** Bounded evidence computed from the drained JSONL stream, not its retained prefix. */
  structuredOutput?: StructuredOutput;
  retainedOutputBytes?: number;
};

export interface AgentProcessRunner {
  run(spec: AgentProcessSpec): Promise<AgentProcessResult>;
}

class BoundedCapture {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private wasTruncated = false;

  public constructor(private readonly limit: number) {}

  public append(chunk: Buffer | string): void {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.size >= this.limit) {
      this.wasTruncated = true;
      return;
    }
    const remaining = this.limit - this.size;
    if (value.byteLength > remaining) {
      this.chunks.push(value.subarray(0, remaining));
      this.size = this.limit;
      this.wasTruncated = true;
      return;
    }
    this.chunks.push(value);
    this.size += value.byteLength;
  }

  public text(): string {
    // Do not turn an incomplete trailing UTF-8 sequence into a replacement
    // character whose encoding could exceed the retained byte cap.
    const decoded = new TextDecoder('utf-8').decode(Buffer.concat(this.chunks), { stream: this.wasTruncated });
    const bytes = Buffer.from(decoded);
    if (bytes.length <= this.limit) return decoded;
    this.wasTruncated = true;
    return new TextDecoder('utf-8').decode(bytes.subarray(0, this.limit), { stream: true });
  }

  public get truncated(): boolean {
    return this.wasTruncated;
  }
}

type TerminationReason = 'timeout' | 'cancelled' | 'start_error' | 'output_limit';

/**
 * Spawn without a shell, drain both output streams, cap retained bytes, and
 * terminate the whole process group on POSIX. A detached child gets its own
 * process group, making `kill(-pid)` safe for provider-launched descendants.
 */
export const defaultAgentProcessRunner: AgentProcessRunner = {
  run(spec): Promise<AgentProcessResult> {
    for (const [name, value] of Object.entries({ maxOutputBytes: spec.maxOutputBytes,
      maxStreamBytes: spec.maxStreamBytes ?? AGENT_STREAM_LIMIT_BYTES })) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    }
    const startedAt = Date.now();
    if (spec.signal?.aborted) {
      return Promise.resolve({
        unexpectedTermination: false,
        timedOut: false,
        cancelled: true,
        processGroupStopped: true,
        outputLimitExceeded: false,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 0,
      });
    }

    let child: ChildProcess;
    try {
      child = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: { ...spec.env },
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      return Promise.resolve({
        spawnErrorCode: errorCode(error),
        startError: errorMessage(error),
        unexpectedTermination: false,
        timedOut: false,
        cancelled: false,
        processGroupStopped: true,
        outputLimitExceeded: false,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: Date.now() - startedAt,
      });
    }

    const stdout = new BoundedCapture(spec.maxOutputBytes);
    const stderr = new BoundedCapture(spec.maxOutputBytes);
    const structured = spec.jsonlProtocol === undefined ? undefined : new JsonlOutputCollector(spec.jsonlProtocol);
    const streamLimit = Math.min(spec.maxStreamBytes ?? AGENT_STREAM_LIMIT_BYTES, AGENT_STREAM_LIMIT_BYTES);
    let consumedBytes = 0;
    let outputLimitExceeded = false;
    let forceKillHandle: NodeJS.Timeout | undefined;
    let terminationReason: TerminationReason | undefined;
    let spawnErrorCode: string | undefined;
    let startError: string | undefined;
    let settled = false;
    let resolveResult: (result: AgentProcessResult) => void = () => undefined;

    const resultPromise = new Promise<AgentProcessResult>((resolve) => {
      resolveResult = resolve;
    });

    const terminate = (reason: TerminationReason): void => {
      if (settled || terminationReason !== undefined) return;
      terminationReason = reason;
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        if (process.platform === 'win32') {
          child.kill('SIGTERM');
        } else {
          process.kill(-pid, 'SIGTERM');
        }
      } catch {
        // The process may have exited between the state check and the signal.
      }
      forceKillHandle = setTimeout(() => {
        if (settled) return;
        try {
          if (process.platform === 'win32') {
            child.kill('SIGKILL');
          } else {
            process.kill(-pid, 'SIGKILL');
          }
        } catch {
          // The close event will report the final state.
        }
      }, TERMINATION_GRACE_MS);
    };

    const onAbort = (): void => terminate('cancelled');
    spec.signal?.addEventListener('abort', onAbort, { once: true });

    const consume = (chunk: Buffer | string, capture: BoundedCapture, isStdout: boolean): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      capture.append(bytes);
      // Continue draining even after termination has been requested. Never
      // parse or retain an unbounded suffix while waiting for the group to stop.
      if (outputLimitExceeded) return;
      consumedBytes += bytes.byteLength;
      if (consumedBytes > streamLimit || (isStdout && structured?.append(bytes) === false)) {
        outputLimitExceeded = true;
        terminate('output_limit');
      }
    };
    child.stdout?.on('data', (chunk: Buffer | string) => consume(chunk, stdout, true));
    child.stderr?.on('data', (chunk: Buffer | string) => consume(chunk, stderr, false));
    child.once('error', (error: unknown) => {
      spawnErrorCode = errorCode(error);
      startError = errorMessage(error);
    });
    child.once('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
      settled = true;
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (forceKillHandle !== undefined) clearTimeout(forceKillHandle);
      spec.signal?.removeEventListener('abort', onAbort);

      void (async () => {
        const group = await settleProcessGroup(child.pid);
        resolveResult({
          processId: child.pid ?? undefined,
          ...(exitCode === null ? {} : { exitCode }),
          ...(signal === null ? {} : { terminationSignal: signal }),
          ...(spawnErrorCode === undefined ? {} : { spawnErrorCode }),
          ...(startError === undefined ? {} : { startError }),
          // A leader that exits while a descendant remains in the owned group
          // is not a clean provider completion. The descendants are terminated
          // and the result records the abnormal hand-off for the adapter.
          unexpectedTermination:
            (terminationReason === undefined && exitCode === null && signal === null) ||
            group.terminationRequired ||
            !group.stopped,
          timedOut: terminationReason === 'timeout',
          cancelled: terminationReason === 'cancelled',
          processGroupStopped: group.stopped,
          outputLimitExceeded,
          retainedOutputBytes: spec.maxOutputBytes,
          ...(structured === undefined ? {} : { structuredOutput: structured.finish() }),
          stdout: stdout.text(),
          stderr: stderr.text(),
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          durationMs: Date.now() - startedAt,
        });
      })();
    });

    const timeoutHandle = setTimeout(() => terminate('timeout'), spec.timeoutMs);

    const notifyStarted = async (): Promise<void> => {
      if (spec.onStarted === undefined || child.pid === undefined) return;
      try {
        await spec.onStarted(child.pid);
      } catch (error) {
        startError = errorMessage(error);
        terminate('start_error');
      }
    };
    void notifyStarted();

    return resultPromise;
  },
};

export function createAgentProcessRunner(): AgentProcessRunner {
  return defaultAgentProcessRunner;
}

type ProcessGroupSettlement = {
  stopped: boolean;
  terminationRequired: boolean;
};

/**
 * A detached provider owns a process group, not just its direct child. The
 * child `close` event only proves that the group leader exited; a background
 * descendant can otherwise survive and keep modifying the worktree. On POSIX,
 * prove the group is gone, terminate the owned group if necessary, and report
 * failure when the proof still cannot be obtained.
 */
async function settleProcessGroup(pid: number | undefined): Promise<ProcessGroupSettlement> {
  // Node leaves pid undefined when spawn fails before an OS process is
  // created (for example ENOENT or EACCES). There is no owned group to retain.
  if (pid === undefined) return { stopped: true, terminationRequired: false };
  if (process.platform === 'win32') {
    // The Windows runner does not create a process group. Do not claim that a
    // normal leader exit proves descendant termination.
    return { stopped: false, terminationRequired: false };
  }
  if (!(await waitForProcessGroupExit(pid, 0))) {
    const terminationRequired = true;
    signalProcessGroup(pid, 'SIGTERM');
    if (await waitForProcessGroupExit(pid, TERMINATION_GRACE_MS)) {
      return { stopped: true, terminationRequired };
    }
    signalProcessGroup(pid, 'SIGKILL');
    return {
      stopped: await waitForProcessGroupExit(pid, TERMINATION_GRACE_MS),
      terminationRequired,
    };
  }
  return { stopped: true, terminationRequired: false };
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!processGroupExists(pid)) return true;
    if (timeoutMs === 0) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, PROCESS_GROUP_POLL_MS));
  } while (Date.now() <= deadline);
  return !processGroupExists(pid);
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group may have exited between the liveness check and the signal.
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
