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

Current execution surfaces:

- OpenCode Go → the OpenCode AGENT-001 adapter
- Codex → the Codex AGENT-001 adapter
- Grok → a Grok command adapter bound to the shared ACP identity
- Gemini → an Antigravity (`agy`) command adapter bound to the shared ACP identity

The MODEL-001 provider identity is intentionally kept separate from the
provider-neutral AGENT-001 identity. The exhaustive mapping is
`opencode-go → opencode`, `codex → codex`, and `grok`/`gemini → acp`; the two
ACP-bound providers still have distinct, immutably MODEL-branded adapter
instances. A provider is
execution-available only after its adapter proves the exact installed
headless command surface. In particular, Gemini execution uses Antigravity
(`agy`), not Gemini CLI. Missing or unsupported automation evidence remains
unknown and cannot be routed.

Command execution also uses each supported surface's workspace restriction:
Grok is launched with its `workspace` sandbox profile and Antigravity with its
`--sandbox` mode. CWD alone is not treated as isolation.
Codex, Grok and Antigravity probes also require the adapter-specific executable
name/version identity and every security-relevant flag used at launch; a
replacement executable after probing invalidates the launch. Provider
credentials are filtered to the adapter that owns them. Grok additionally
requires a private ephemeral home/config, no memory, no subagents, no plan
mode, disabled web/MCP tools, and a deny-by-default permission mode with only
the local coding tools explicitly allowed. If the installed Grok surface does
not expose those controls, it remains unavailable rather than being routed.

The configured provider executable and the user's local CLI configuration are
an explicit trusted-host seam. ShipGraph prevents accidental cross-provider
environment-variable leakage, but OpenCode, Codex and Antigravity may read the
user HOME/XDG stores needed for an existing CLI login. ShipGraph does not claim
credential-store or host-filesystem isolation. Only trusted local configuration
may select executable paths or provider command arguments.

MODEL-001 adds a separate metadata boundary for the paid engineering pools:
OpenCode Go, Codex, Grok and Gemini. `ModelProviderAdapter` implementations
capability-probe their local/provider surface and may expose a current model
catalog. Catalog discovery uses provider commands or machine-readable output;
it never asks a model to describe itself and never embeds a list of unstable
model names. A missing quota, token count or cost is stored as `unknown`, not
estimated.

Provider configurations may supply a machine-readable `capabilityArgs` surface;
invalid or unavailable capability evidence makes that probe unknown. When a
provider has no such surface, its adapter-level task contract is the stable
capability boundary and explicit model capabilities from the catalog may narrow
it. Model identifiers never imply capabilities. A provider-documented login
status command may be supplied through `authArgs` with explicit authenticated
and unauthenticated output markers. Version/help/catalog output alone never
upgrades authentication; missing or ambiguous auth evidence remains `unknown`.

`ProviderRegistry` persists the latest provider/model metadata,
capability-probed execution status and `ProviderHealth` state. `ModelRouter`
receives only an explicit execution envelope (Eco, Balanced or Max plus the
caller's budget/concurrency values), selects a discovered usable model for
implementation, review or repair only when its AGENT-001 adapter is available
and the provider has positively authenticated,
persists its reason, and atomically reserves the selected provider's capacity
when the caller supplies a durable execution run whose provider/model
identity matches the selected target. The production routed-run operation owns
preview, binding, reservation and execution so callers cannot create a
provider/model mismatch; a changed-capacity candidate is safely abandoned and
excluded before retry. Known limits are enforced directly; an
unknown provider limit uses a conservative one-at-a-time local admission
bound, not a quota estimate. A route without a run ID is a
non-persistent decision preview and does not claim provider capacity.
`ModelRoutingService.resolveExecutionTarget()` returns an opaque route target,
not a concrete adapter. Only `ModelRoutingService.executeSelectedAgentTask()`
can turn an active, run-bound target into the provider-neutral AGENT-001
execution call, so a preview cannot bypass capacity or workspace validation.
When no separate request ID is supplied, the durable run ID is the stable
replay key for that reservation until it is finalized; a new attempt after
finalization must use a new request ID.
The global ticket count in that envelope is a Scheduler-owned snapshot; MODEL-001
does not claim or mutate global ticket capacity.
Review routing prefers a different provider family from the implementation when
one is available. `UsageLedger` is append-only, accepts only durable run IDs
from the current project, records per-run/provider/model telemetry without raw
provider output or credentials. A normal terminal result releases its
execution-bound provider reservation only when the adapter proves that its
owned provider process group stopped. Timeout, cancellation, output-limit
termination, an abnormal surviving descendant and explicit recovery retain
the slot when provider-process ownership cannot be proven; usage finalization
alone cannot release it. An operator may release retained capacity only through
explicit reconciliation after independently proving execution stopped. Each
durable AGENT run owns one provider attempt; a later attempt requires a new
CREATED run and request ID.

The AGENT-001 execution command accepts an explicit provider/model and can use
the bounded Codex, Grok or Antigravity adapters as well as OpenCode. MODEL-001
does not dispatch Linear work or turn these adapters into post-KAR-6 PR, CI,
merge or scheduler automation.

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
