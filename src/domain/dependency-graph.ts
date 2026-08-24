import { compareStableStrings } from '../utils/sorting.js';

/** A directed dependency edge: ticketId depends on dependsOnTicketId. */
export type DependencyEdge = {
  ticketId: string;
  dependsOnTicketId: string;
};

/**
 * Validate a complete dependency graph without touching persistence.
 *
 * The same routine is used by backlog validation and SQLite dependency writes
 * so the approved file graph and persisted graph share one DAG invariant.
 */
export function validateDependencyGraph(
  ticketIds: ReadonlySet<string>,
  edges: readonly DependencyEdge[]
): void {
  const adjacency = new Map<string, Set<string>>();
  const seenEdges = new Set<string>();

  for (const edge of edges) {
    if (!ticketIds.has(edge.ticketId)) {
      throw new Error(
        `Dependency ${edge.ticketId} -> ${edge.dependsOnTicketId} references a missing ticket`
      );
    }
    if (!ticketIds.has(edge.dependsOnTicketId)) {
      throw new Error(
        `Dependency ${edge.ticketId} -> ${edge.dependsOnTicketId} references a missing ticket`
      );
    }
    if (edge.ticketId === edge.dependsOnTicketId) {
      throw new Error(`Ticket ${edge.ticketId} cannot depend on itself`);
    }

    const edgeKey = `${edge.ticketId}\u0000${edge.dependsOnTicketId}`;
    if (seenEdges.has(edgeKey)) {
      throw new Error(
        `Ticket ${edge.ticketId} dependencies must be unique; duplicate ${edge.dependsOnTicketId}`
      );
    }
    seenEdges.add(edgeKey);

    const dependencies = adjacency.get(edge.ticketId) ?? new Set<string>();
    dependencies.add(edge.dependsOnTicketId);
    adjacency.set(edge.ticketId, dependencies);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (ticketId: string): void => {
    if (visited.has(ticketId)) return;
    if (visiting.has(ticketId)) {
      const cycleStart = path.indexOf(ticketId);
      const cycle = [...path.slice(cycleStart), ticketId].join(' -> ');
      throw new Error(`Ticket dependency graph must remain acyclic: ${cycle}`);
    }

    visiting.add(ticketId);
    path.push(ticketId);
    const dependencies = [...(adjacency.get(ticketId) ?? [])].sort(compareStableStrings);
    for (const dependencyId of dependencies) visit(dependencyId);
    path.pop();
    visiting.delete(ticketId);
    visited.add(ticketId);
  };

  for (const ticketId of [...ticketIds].sort(compareStableStrings)) visit(ticketId);
}
