# Adapter Contracts

ShipGraph interacts with external tools through small, capability-oriented
adapters. The execution core owns durable ShipGraph run state; concrete
providers translate their process and output details at the adapter boundary.

## AgentAdapter

`AgentAdapter` is designed around capabilities rather than provider names.

```ts
export interface AgentAdapter {
  readonly provider: AgentProvider;
  readonly capabilities: readonly AgentCapability[];
  probe(): Promise<AgentProbeResult> | AgentProbeResult;
}
```

AGENT-001 extends that probe-only foundation with a provider-neutral execution
contract:

```ts
export interface AgentExecutionAdapter extends AgentAdapter {
  execute(request: AgentExecutionRequest): Promise<AgentExecutionResult>;
}
```

The request identifies the project, ticket, exact workspace, branch, base SHA,
explicit model, bounded instructions, timeout and cancellation signal. The
result contains only normalized outcome/evidence, bounded output, process
metadata and a failure category. An adapter may expose a provider session ID,
but that ID is not the ShipGraph run identity.

Capabilities:

- `execute` — run an implementation task.
- `review` — review a change for correctness or adversarial concerns.
- `repair` — fix a change after review feedback.

Current provider:

- OpenCode (AGENT-001)

Future providers:

- Codex
- ACP (Agent Client Protocol)

KAR-6 owns provider registries, discovery, health, usage accounting and model
routing. AGENT-001 intentionally accepts an explicit provider/model and does
not select one automatically.

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
