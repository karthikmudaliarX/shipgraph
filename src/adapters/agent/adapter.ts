/**
 * Capability-oriented contract for agent adapters.
 *
 * The execution contract deliberately describes a verified ShipGraph
 * workspace, not an OpenCode session. Provider-specific command lines and
 * output formats belong in the concrete adapter.
 */
import type {
  AgentFailureCategory,
  AgentExecutionUsage,
  AgentRunState,
  NormalizedAgentEvidence,
} from '../../domain/agent-run.js';

export type AgentCapability = 'execute' | 'review' | 'repair';

export type { AgentProvider } from '../../domain/agent-provider.js';
import type { AgentProvider } from '../../domain/agent-provider.js';

export type AgentProbeResult =
  | { available: true; version?: string }
  | { available: false; reason: string };

export interface AgentAdapter {
  readonly provider: AgentProvider;
  readonly capabilities: readonly AgentCapability[];

  /**
   * Probe whether the adapter is installed and usable in the current environment.
   */
  probe(): Promise<AgentProbeResult> | AgentProbeResult;
}

/** One explicitly authorized execution request. Instructions are not persisted. */
export type AgentExecutionRequest = {
  runId: string;
  projectId: string;
  ticketId: string;
  workspaceId: string;
  workspacePath: string;
  branchName: string;
  baseSha: string;
  provider: AgentProvider;
  model: string;
  instructions: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  /** Persist a provider process identifier as soon as the child is spawned. */
  onProcessStarted?: (processId: number) => void | Promise<void>;
};

export type AgentExecutionOutcome = Extract<
  AgentRunState,
  'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED' | 'NEEDS_HUMAN'
>;

/** Normalized adapter result; no provider-specific event object crosses this boundary. */
export type AgentExecutionResult = {
  outcome: AgentExecutionOutcome;
  providerSessionId?: string;
  providerProcessId?: number;
  exitCode?: number;
  terminationSignal?: string;
  timedOut: boolean;
  cancelled: boolean;
  /** True only when the process runner proved the owned provider group stopped. */
  processGroupStopped?: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  evidence?: NormalizedAgentEvidence;
  /** Provider-reported usage, when the execution surface exposes it. */
  usage?: AgentExecutionUsage;
  failureCategory?: AgentFailureCategory;
  failureReason?: string;
};

export interface AgentExecutionAdapter extends AgentAdapter {
  execute(request: AgentExecutionRequest): Promise<AgentExecutionResult>;
}
