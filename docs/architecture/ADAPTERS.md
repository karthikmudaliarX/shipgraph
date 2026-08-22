# Adapter Contracts

ShipGraph interacts with external tools through small, capability-oriented
adapters. CORE-001 defines only the interfaces; concrete implementations are
planned in successor tickets.

## AgentAdapter

`AgentAdapter` is designed around capabilities rather than provider names.

```ts
export interface AgentAdapter {
  readonly provider: AgentProvider;
  readonly capabilities: readonly AgentCapability[];
  probe(): Promise<AgentProbeResult> | AgentProbeResult;
}
```

Capabilities:

- `execute` — run an implementation task.
- `review` — review a change for correctness or adversarial concerns.
- `repair` — fix a change after review feedback.

Future providers:

- OpenCode (AGENT-001)
- Codex
- ACP (Agent Client Protocol)

CORE-001 does not implement execution. The probe contract is enough to support
`shipgraph doctor` and future adapter discovery.

## GitHostAdapter

`GitHostAdapter` abstracts the code-hosting platform.

```ts
export interface GitHostAdapter {
  readonly type: GitHostType;
  probe(): Promise<GitHostProbeResult> | GitHostProbeResult;
}
```

The first future implementation will be GitHub (GH-001). It will handle:

- pull-request creation and updates
- CI status monitoring
- review recording
- merge operations

CORE-001 defines the interface only.
