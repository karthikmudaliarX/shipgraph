# WORK-001: Isolated Git Worktree Lifecycle

## The core safety principle

ShipGraph never performs ticket implementation inside the user's normal
working checkout. Every ticket receives its own isolated Git worktree under a
ShipGraph-owned root outside the repository:

```
~/.shipgraph/worktrees/<project-id>/<ticket-id>/
```

The source checkout may contain unrelated uncommitted work. ShipGraph never
modifies, stages, resets, cleans, checks out, or stashes those files. Allowed
operations against the source repository are limited to what is required to
manage the dedicated worktree (`git worktree add/remove`, read-only
inspection). ShipGraph never deletes a branch automatically because Git ref
deletion cannot be atomic with the worktree registry. `git reset --hard`,
`git clean -fd`,
`git stash`, and force-deletion of user changes are never executed.

## Pipeline

```
eligible ticket
      ↓
persistent reservation (CREATING)
      ↓
exact base SHA (resolved from the local default branch)
      ↓
dedicated branch   shipgraph/<ticket-id>
      ↓
isolated worktree  ~/.shipgraph/worktrees/<project-id>/<ticket-id>
      ↓
validation         HEAD == baseSha, branch matches, clean, registered
      ↓
READY              (+ ELIGIBLE → PLANNING in the same DB commit)
```

## Base SHA invariant

Branches move; commits do not. WORK-001 resolves the configured local default
branch to an exact commit SHA at creation time and persists that SHA. Before a
workspace may be marked READY, the live worktree HEAD must equal the recorded
base SHA. No remote synchronization happens in WORK-001 — no fetch, no pull.
GH-001 will later own remote policy.

## Branch ownership

One dedicated branch per ticket, derived deterministically from the ticket id
(`TA-1` → `shipgraph/ta-1`) and validated with
`git check-ref-format --branch`. A pre-existing branch is never reused, reset,
or deleted. Only an active persisted reservation can claim a branch; anything
else fails closed.

## Persistence model

Workspaces live in the `workspaces` table (migration v4) with statuses
`CREATING`, `READY`, `REMOVED`, `FAILED`, `NEEDS_HUMAN`. Uniqueness is
enforced by partial unique indexes **in the schema**, not only application
logic:

- one active workspace per `(project_id, ticket_id)`
- one active branch per `(source_repository_path, branch_name)`
- one active workspace per `worktree_path`

Audit events are appended for `workspace.creating`, `workspace.ready`,
`workspace.removed`, and `workspace.failed`. Payloads carry identity only
(workspaceId, ticketId, baseSha, branchName, worktreePath) and are runtime
validated by the typed event schema. No secrets or environment dumps.

## Filesystem + SQLite are not globally atomic

Git operations and database writes cannot share one transaction. WORK-001 is
explicit about this:

1. validate project/repository/ticket
2. prove dispatchability (CORE-002 scheduler logic)
3. resolve exact base SHA
4. derive branch/path deterministically
5. reserve persistently as `CREATING` (+ audit event, single commit)
6. create branch/worktree via git
7. verify every READY invariant
8. finalize `READY` **and** transition `ELIGIBLE → PLANNING` **and** append
   audit metadata inside one SQLite commit
9. on failure before READY: compensate or escalate

### Recovery (restart safety)

If ShipGraph crashes after the reservation but before finalization, the next
invocation finds the persisted `CREATING` row and inspects it. If the
recorded path exists as a plain directory, is a registered worktree of the
expected repository bound to its git common dir, has the expected branch
checked out at exactly the recorded base SHA, and is strictly clean, the
reservation is safely finalized. Anything else fails closed into
`NEEDS_HUMAN`. Ambiguous state is never deleted automatically.

Adoption note: recovery deliberately adopts any state that provably matches
the reservation. Such state is indistinguishable from — and equivalent to —
what ShipGraph itself would have created; constructing it deliberately
yields an equally valid workspace for that ticket at that base.

### Compensation

When a failure happens inside the same controlled process, ShipGraph removes
the newly created worktree only when it can *prove* it belongs to this
reservation (registered, correct branch, `HEAD == baseSha`, clean). The
dedicated branch is always retained for human cleanup because ref deletion
cannot be atomic with Git's worktree registry. Otherwise everything is
preserved and the workspace is marked `NEEDS_HUMAN`.

### Removal residual window

`workspace remove` performs the git removal first and records `REMOVED`
second. A crash between the two leaves a REMOVED-on-disk/READY-in-db state,
which `workspace inspect` surfaces as `MISSING`; nothing is auto-repaired.

## Dirty worktrees are preserved

A dirty ticket worktree is never removed; there is deliberately no
`--force`. Removal requires a clean, registered, correctly-bound `READY`
workspace whose recorded path exactly equals the deterministic location. The
dedicated branch is retained on every removal so a concurrent checkout can
never lose its branch or make a unique commit unreachable.

## Ambiguity fails closed

Symlinks anywhere in the worktree chain (root, project segment), malicious
ticket ids, pre-existing paths, tampered branches, wrong HEADs, dirty trees,
and metadata copied into a different repository all fail closed. Once a
project has recorded any workspace, its source repository binding is
enforced; copied metadata in another checkout is refused.

## Known residual windows

Some races cannot be eliminated by userspace pathname tools; ShipGraph keeps
them narrow and documented instead of pretending they are atomic:

- **Symlink swaps between check and use.** Path components are validated with
  `lstat`/`realpath` immediately before each git operation, but a concurrent
  swap inside that window could redirect an operation. Deletion is bounded:
  removal only ever targets the exact recorded path, requires the recorded
  branch to be checked out, and `git worktree remove` itself refuses dirty
  or foreign worktrees.
- **READY records a verified instant.** Invariants (HEAD, branch, clean) are
  verified before READY is committed, but the worktree is a normal user-owned
  directory afterwards. Later drift is reported by `workspace inspect` as
  `DRIFTED`; nothing auto-repairs.
- **Repository provenance is persisted.** The first workspace reservation binds
  the canonical source path, source checkout directory, Git common directory,
  primary object directory, and their device/inode identities. A repository or
  checkout replacement at the same project path, or a `.git` redirection, is
  refused; a pristine metadata set establishes its binding on first use.
- **Repository-local Git config is trusted for that repository.** System and
  global configuration are pinned to /dev/null (no aliases, no global
  filters), but repository-local config — including smudge/clean filters and
  aliases defined in `.git/config` — executes with user privileges as it
  would for any git operation in that repository.
- **Checkout filters run with user privileges.** `git worktree add` performs a
  normal checkout: repository-defined smudge/clean filters (e.g. Git LFS)
  execute as they would for any git operation in that repository. ShipGraph
  disables hooks and strips environment overrides but does not alter filter
  configuration.
- **Removal leaves the ticket PLANNING.** Removing a workspace does not roll
  back the ticket state machine; capacity stays consumed until an operator or
  a later ticket explicitly resolves the state. Its dedicated branch is
  retained for the same operator-controlled cleanup boundary.
- **Submodule worktrees are refused.** Removal requires no `.gitmodules` in
  the workspace: nested submodule contents are outside the superproject's
  cleanliness proof, so WORK-001 declines rather than risk deleting them.

## CLI

```
shipgraph workspace create <ticket-id> [--json]
shipgraph workspace inspect <ticket-id> [--json]   # read-only health report
shipgraph workspace list [--json]                  # current project only
shipgraph workspace remove <ticket-id> [--json]    # conservative, no force
```

Health values reported by `inspect`: `HEALTHY | DRIFTED | MISSING |
NEEDS_HUMAN`.
