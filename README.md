# ShipGraph

> Deterministic engineering execution for one explicitly authorized work item.

ShipGraph is the execution layer between an outer Scheduler and a GitHub pull
request. The Scheduler decides **what** should run. ShipGraph decides **how** to
turn that one authorized ticket into a reviewed, verified PR — then stops.

## What ShipGraph owns

For one explicitly authorized Linear issue, ShipGraph can:

- verify and durably claim the dispatch
- create an isolated Git worktree
- discover and route across configured coding providers
- run bounded implementation with safety and budget limits
- run deterministic local verification
- obtain independent Contract Review and Engineering Review
- perform bounded pre-PR repair when required
- bind readiness evidence to the exact candidate SHA
- publish exactly one GitHub PR with a compact usage/evidence receipt
- stop at `PR_RAISED` / `PR_OPEN`

ShipGraph does **not** own product priority, backlog progression, merge decisions,
post-PR CI supervision, successor-ticket selection, or communication back to
ChatGPT.

## v1 control boundary

```text
ChatGPT Scheduler / human
        │
        │ chooses exactly one eligible Linear issue
        │ applies shipgraph:queued
        ▼
Linear webhook
        │ verified signature + live issue re-check
        ▼
Durable ShipGraph claim
        │
        ▼
isolated workspace
        │
        ▼
provider routing → implementation → verification
        │
        ▼
Contract Review + Engineering Review
        │
        ▼
bounded repair when required
        │
        ▼
exact-SHA Pre-PR Readiness
        │
        ▼
GitHub PR + usage receipt
        │
        ▼
PR_RAISED / PR_OPEN
        │
        ▼
STOP

Later Scheduler wake:
CI / reviews / merge / next work
```

Linear is the v1 durable dispatch signal. ShipGraph does not scan Linear for
work or maintain a second backlog queue. Duplicate webhook deliveries are made
harmless by durable local claim/execution evidence. If local execution capacity
is unavailable, ShipGraph acknowledges the webhook without inventing another
queue; the outer Scheduler owns a later re-drive.

## Important invariants

### One ticket, one active execution

One Linear issue may have at most one active ShipGraph execution. Claims,
execution identity, workspace provenance, contract provenance, provider runs,
and PR handoff evidence are persisted in SQLite.

### Exact-SHA evidence

Verification, reviews, repair evidence, and Pre-PR Readiness apply to an exact
candidate commit. If HEAD changes, stale evidence cannot authorize the PR
handoff.

### Safety before launch

Safety and approval gates run before provider launch. The final provider
capability check also occurs before the durable `RUNNING` transition.

KAR-17 permits provider fallback only when durable evidence proves a selected
provider became locally unlaunchable **before** execution entered `RUNNING` and
before any provider process/session could have acted on the workspace. Launched
or ambiguous attempts remain fail-closed rather than starting another provider
on the same workspace.

### Unknown stays unknown

A provider is not routed merely because a subscription probably exists.
Authentication, execution capability, model catalog/capability, health, quota,
and local capacity are discovered conservatively. Unsupported quota or usage
values remain `unknown` instead of being guessed.

## Current implementation

Delivered:

- **CORE-001 ✅** — CLI/config foundation, state machine, SQLite migrations and audit events
- **CORE-002 ✅** — Approved backlog DAG, eligibility and admission diagnostics
- **WORK-001 ✅** — Provenance-checked isolated Git worktree lifecycle
- **AGENT-001 / KAR-5 ✅** — Provider-neutral bounded agent execution with OpenCode adapter
- **MODEL-001 / KAR-6 ✅** — Provider registry, model discovery/routing, health and usage ledger
- **KAR-7 ✅** — Execution limits, approval and human safety gates
- **KAR-9 ✅** — Independent exact-SHA Contract and Engineering Reviews
- **KAR-10 ✅** — Bounded pre-PR repair
- **KAR-11 ✅** — Exact-SHA Pre-PR Readiness
- **KAR-8 ✅** — GitHub PR + usage receipt handoff
- **KAR-12 ✅** — Single-ticket execution-to-PR composition
- **KAR-13 ✅** — Verified Linear webhook dispatch + idempotent durable claim bridge
- **KAR-14 ✅** — Frozen Scheduler/ShipGraph documentation boundary
- **KAR-17 ✅** — Safe provider fallback for proven pre-launch provider unavailability

**KAR-15 dogfood is in progress** on a real external repository. v1 should not
be treated as proven for general use until that end-to-end dogfood reaches a PR
and the planned recovery/failure cases are exercised.

## Provider model

ShipGraph currently has capability-probed provider surfaces for OpenCode Go,
Codex, Grok/xAI, and Gemini/Antigravity where the corresponding local tools and
authentication are actually available.

Provider settings identify executable and catalog surfaces, not hard-coded model
names. A provider with unknown authentication, execution capability, or model
catalog remains non-routable. OpenCode, Codex, Grok, and Antigravity may use the
current user's existing CLI credential stores; ShipGraph's environment filtering
is not host-filesystem or credential-store isolation.

`shipgraph.yml` provider configuration is trusted local configuration. Do **not**
initialize or run ShipGraph with `providers.*.executable`, probe arguments, or
other provider command settings supplied by an untrusted repository. Provider
refresh and execution may launch those configured commands with access to the
current user's HOME/XDG credential stores.

The outer Scheduler supplies the execution envelope for one ticket. MODEL-001
chooses concrete provider/model attempts within that envelope; it does not own
global ticket scheduling or select subsequent work.

## CLI

Requires Node.js 22+ and pnpm.

```bash
pnpm install
pnpm build
```

Typical operator commands:

```bash
# Environment diagnostics
shipgraph doctor
shipgraph doctor --json

# Initialize / inspect one local project
shipgraph init
shipgraph status
shipgraph status --json

# Validate/sync the approved local backlog and inspect admission
shipgraph backlog validate
shipgraph backlog sync
shipgraph ready
shipgraph ready --json

# Refresh and inspect provider state
shipgraph providers refresh --json
shipgraph providers list --json

# Preview a model route
shipgraph providers route implementation --risk medium --mode balanced --json

# Inspect durable provider runs
shipgraph agent list --json
shipgraph agent inspect <run-id> --json

# Inspect isolated workspaces
shipgraph workspace list
```

Direct agent commands exist for bounded development/debugging, but production
v1 dispatch is the Scheduler-authorized Linear webhook path rather than an
agent autonomously choosing work.

## Operational visibility

ShipGraph's canonical runtime state is durable, so operators can inspect it
without introducing a second control plane:

```bash
shipgraph status
shipgraph agent list
shipgraph agent inspect <run-id>
shipgraph workspace list
shipgraph providers list
```

For a long-running receiver, follow the host service logs alongside those
read-only commands (for example with `journalctl -f` inside `tmux`). There is no
first-class `shipgraph monitor` command yet; do not treat a terminal dashboard
as authoritative state.

## Development

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Repository map

- `CONTEXT.md` — small canonical vocabulary
- `docs/architecture/` — architecture and release invariants
- `src/dispatch/` — Linear webhook/claim bridge
- `src/execution/` — bounded provider execution
- `src/model/` — provider discovery, routing, health and usage
- `src/workspace/` — isolated worktree lifecycle
- `src/review/`, `src/repair/`, `src/readiness/` — pre-PR evidence pipeline

## Philosophy

ShipGraph is not trying to be a better code generator or a second autonomous
project manager. Its job is to make one agent-generated change easier to reason
about: explicit authorization, small scope, durable provenance, isolated state,
bounded execution, independent review, and a hard stop at the PR boundary.

## License

MIT
