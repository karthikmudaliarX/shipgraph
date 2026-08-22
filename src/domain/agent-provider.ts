export const AGENT_PROVIDERS = ['opencode', 'codex', 'acp'] as const;

export type AgentProvider = (typeof AGENT_PROVIDERS)[number];
