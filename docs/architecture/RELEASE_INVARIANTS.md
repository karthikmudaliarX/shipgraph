# Release Invariants

ShipGraph is built on a small set of invariants that make autonomous releases
safe and auditable. These are established in CORE-001 and enforced by later
tickets.

## Exact-SHA review provenance

A review or approval applies to **exactly one commit SHA**.

If the PR head changes after a review is recorded, that review is **stale** and
must be renewed before the ticket can advance to `RELEASE_READY` or `MERGING`.

This prevents an agent from obtaining approval on one revision and then
silently landing a different one.

## Approved backlog

Agents may discover or suggest new work, but they must **not** autonomously add
new work to the approved executable backlog.

Suggested work lives in a separate non-executable state until it is accepted by
policy or human review. Only approved tickets may enter `ELIGIBLE`.

## Worktree isolation

Each implementation ticket will eventually receive its own isolated git
worktree based on an exact recorded base SHA.

Ticket mutations are never executed directly in the user's normal working
checkout. This keeps the user's default branch clean and makes the base of every
change explicit.

## Safety hard-stops

The following classes of change require human escalation (`NEEDS_HUMAN`) and
will never be performed autonomously:

- secrets / credential changes
- production mutations
- destructive database operations
- DNS / domain changes
- billing / payment changes
- direct default-branch pushes
- force pushes
- autonomous backlog-policy mutation
- release-policy mutation

A dedicated safety-policy ticket (SAFETY-001) will implement the engine that
classifies changes and produces `NEEDS_HUMAN`.
