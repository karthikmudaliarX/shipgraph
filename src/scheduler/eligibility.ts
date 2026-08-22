import { randomUUID } from 'node:crypto';
import type { DbConnection } from '../persistence/db.js';
import {
  createTicketRepository,
  type TicketRecord,
} from '../persistence/repositories.js';
import { persistTicketTransition } from '../persistence/ticket-state-store.js';
import { TicketState, type TicketStateValue } from '../core/state-machine/state.js';
import { compareStableStrings } from '../utils/sorting.js';

export type EligibilityBlockerReason =
  | 'dependency-not-complete'
  | 'dependency-cancelled'
  | 'dependency-not-found';

export type EligibilityBlocker = {
  dependency: string;
  state: TicketStateValue | 'MISSING';
  reason: EligibilityBlockerReason;
};

export type TicketEligibility = {
  ticket: string;
  eligible: boolean;
  blockers: readonly EligibilityBlocker[];
};

export type EligibilityReconciliation = {
  promoted: readonly string[];
  evaluations: readonly TicketEligibility[];
};

/** Pure eligibility calculation for one persisted project's ticket set. */
export function evaluateEligibility(
  tickets: readonly TicketRecord[]
): readonly TicketEligibility[] {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));

  return [...tickets]
    .sort((first, second) => compareStableStrings(first.id, second.id))
    .map((ticket) => {
      if (ticket.status === TicketState.ELIGIBLE) {
        return { ticket: ticket.id, eligible: true, blockers: [] };
      }
      if (ticket.status !== TicketState.QUEUED) {
        return { ticket: ticket.id, eligible: false, blockers: [] };
      }

      const blockers = ticket.dependsOn
        .slice()
        .sort(compareStableStrings)
        .flatMap((dependencyId): EligibilityBlocker[] => {
          const dependency = byId.get(dependencyId);
          if (!dependency) {
            return [{
              dependency: dependencyId,
              state: 'MISSING',
              reason: 'dependency-not-found',
            }];
          }
          if (dependency.status === TicketState.COMPLETE) return [];
          return [{
            dependency: dependencyId,
            state: dependency.status,
            reason:
              dependency.status === TicketState.CANCELLED
                ? 'dependency-cancelled'
                : 'dependency-not-complete',
          }];
        });

      return {
        ticket: ticket.id,
        eligible: blockers.length === 0,
        blockers,
      };
    });
}

/**
 * Promote only QUEUED tickets whose dependencies are COMPLETE. Every state
 * update and its audit event share the SQLite transaction boundary.
 */
export function reconcileEligibility(
  db: DbConnection,
  projectId: string,
  options: { createEventId?: () => string; now?: () => string } = {}
): EligibilityReconciliation {
  const createEventId = options.createEventId ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());
  const ticketRepository = createTicketRepository(db);

  const reconcile = db.transaction((): EligibilityReconciliation => {
    const project = db
      .prepare('SELECT id FROM projects WHERE id = ?')
      .get(projectId) as { id: string } | undefined;
    if (!project) throw new Error(`Project ${projectId} does not exist`);

    const tickets = ticketRepository.findApprovedByProjectId(projectId);
    const ticketsById = new Map(tickets.map((ticket) => [ticket.id, ticket]));
    const evaluations = evaluateEligibility(tickets);
    const promotable = evaluations
      .filter((evaluation) => evaluation.eligible)
      .map((evaluation) => evaluation.ticket)
      .filter((ticketId) => ticketsById.get(ticketId)?.status === TicketState.QUEUED);

    for (const ticketId of promotable) {
      const ticket = ticketsById.get(ticketId);
      if (!ticket || ticket.projectId !== projectId) {
        throw new Error(`Ticket ${ticketId} does not belong to project ${projectId}`);
      }
      persistTicketTransition(
        db,
        {
          ticketId,
          projectId,
          next: TicketState.ELIGIBLE,
          reason:
            ticket.dependsOn.length === 0
              ? 'ticket has no dependencies'
              : 'all dependencies are COMPLETE',
        },
        { createEventId, now }
      );
    }

    return {
      promoted: promotable,
      evaluations: evaluateEligibility(ticketRepository.findApprovedByProjectId(projectId)),
    };
  }).immediate;

  return reconcile();
}
