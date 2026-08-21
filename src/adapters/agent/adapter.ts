/**
 * Capability-oriented contract for agent adapters.
 *
 * Implementations may include OpenCode, Codex, and ACP in future tickets.
 * The contract is intentionally minimal for CORE-001.
 */
export type AgentCapability = 'execute' | 'review' | 'repair';

export type AgentProvider = 'opencode' | 'codex' | 'acp';

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

/**
 * Factory to create an agent adapter by provider name.
 */
export function createAgentAdapter(_provider: AgentProvider): AgentAdapter {
  // Placeholder: real adapters are implemented in AGENT-001.
  throw new Error('Agent adapters are not implemented in CORE-001');
}
