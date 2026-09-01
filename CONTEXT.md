# ShipGraph Context

- **Ticket** — One explicitly authorized work item, identified by its Linear issue.
- **Contract** — The behavioral requirements and scope that the ticket authorizes.
- **Eligible** — A ticket whose known dependencies and local admission checks permit execution.
- **Run** — One durable, bounded provider execution recorded by ShipGraph.
- **Workspace** — The isolated Git worktree assigned to one ticket.
- **Verification** — Deterministic local checks applied to the candidate.
- **Contract Review** — An independent review of whether the requested behavior was built.
- **Engineering Review** — An independent review of technical correctness and appropriate scope.
- **Pre-PR Readiness** — The exact-SHA evidence gate for handing a candidate to GitHub PR creation.
- **Head SHA** — The exact commit identifier to which candidate evidence is bound.
