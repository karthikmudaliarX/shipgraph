/**
 * Capability-oriented contract for agent adapters.
 *
 * Implementations may include OpenCode, Codex, and ACP in future tickets.
 * The contract is intentionally minimal for CORE-001.
 */
export type AgentCapability = 'execute' | 'review' | 'repair';

export type { AgentProvider } from '../../domain/agent-provider.js';

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
import type { AgentProvider } from '../../domain/agent-provider.js';
