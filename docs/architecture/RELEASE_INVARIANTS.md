# Execution and Pre-PR Invariants

ShipGraph is built on a small set of invariants that make one authorized
pre-PR execution safe and auditable. Scheduler and the release manager own the
outer progression after ShipGraph raises a PR.

## Project-owned audit history

Every immutable event belongs to one project. Any referenced ticket must belong
to that project; any referenced run inherits its project through its ticket; and
an event that carries both references must name the run's ticket. Dependency
edges are likewise confined to one project. These checks happen before inserts,
while SQLite triggers prevent later event updates or deletes.

## Exact-SHA review provenance

A review or approval applies to **exactly one commit SHA**.

If the candidate HEAD changes after a review is recorded, that review is
**stale** and must be renewed before Pre-PR Readiness or the GitHub handoff can
use it.

This prevents an agent from obtaining approval on one revision and then
silently landing a different one.

## Approved backlog

Agents may discover or suggest new work, but they must **not** autonomously add
new work to the approved executable backlog or select successor work.

Suggested work lives in a separate non-executable state until it is accepted by
policy or human review. Only approved tickets may enter `ELIGIBLE`.

## Worktree isolation

Each implementation ticket receives its own isolated git
worktree based on an exact recorded base SHA.

Ticket mutations are never executed directly in the user's normal working
checkout. This keeps the user's default branch clean and makes the base of every
change explicit.

## Safety hard-stops

Sensitive or destructive work must be classified by the trusted caller or
Scheduler before execution. The classification is represented in KAR-7's
explicit safety policy through signals such as `destructive`,
`policySensitive`, `materiallyAmbiguous`, `scopeGrowth`,
`approvalRequired`/`approvalGranted`, and high or critical risk.

When those supplied signals require approval or escalation, KAR-7 fails closed,
requires approval, or records `NEEDS_HUMAN` as appropriate. KAR-7 does not
inspect arbitrary repository diffs or content and autonomously infer that a
change concerns credentials, production, destructive database operations, DNS,
billing, release policy, or another sensitive category.

The following are examples of work that must be classified before execution:

- secrets / credential changes
- production mutations
- destructive database operations
- DNS / domain changes
- billing / payment changes
- direct default-branch pushes
- force pushes
- autonomous backlog-policy mutation
- release-policy mutation

KAR-7 enforces the supplied execution safety limits and explicit
approval/scope gates. These gates constrain the one authorized execution; they
are not a classifier, a second policy engine, or Scheduler.

## Systems of record

Linear records product intent and authorization/dispatch state. GitHub records
code, commits, pull requests, and CI evidence. GitHub Projects is optional
derived visibility. ShipGraph SQLite records local durable execution and
evidence state. No additional system of record is introduced.

## Trusted root

Ordinary coding and execution agents may operate inside ShipGraph's
authorization, safety, contract-provenance, verification, review-provenance,
and readiness boundaries. They must not silently rewrite, bypass, or weaken the
mechanisms that authorize their work or decide whether it is acceptable.
