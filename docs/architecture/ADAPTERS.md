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

Current execution provider:

- OpenCode (AGENT-001)

Future execution providers:

- Codex
- ACP (Agent Client Protocol)

MODEL-001 adds a separate metadata boundary for the paid engineering pools:
OpenCode Go, Codex, Grok and Gemini. `ModelProviderAdapter` implementations
capability-probe their local/provider surface and may expose a current model
catalog. Catalog discovery uses provider commands or machine-readable output;
it never asks a model to describe itself and never embeds a list of unstable
model names. A missing quota, token count or cost is stored as `unknown`, not
estimated.

`ProviderRegistry` persists the latest probe/catalog snapshot and
`ProviderHealth` state. `ModelRouter` receives only an explicit execution
envelope (Eco, Balanced or Max plus the caller's budget/concurrency values),
selects a discovered usable model for implementation, review or repair, and
persists its reason. Review routing prefers a different provider family from
the implementation when one is available. `UsageLedger` is append-only, accepts
only durable run IDs from the current project, and records
per-run/provider/model telemetry without raw provider output or credentials.

The existing AGENT-001 execution command still accepts an explicit provider and
model. MODEL-001 does not dispatch Linear work or turn the metadata adapters
into post-KAR-6 PR, CI, merge or scheduler automation.

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
