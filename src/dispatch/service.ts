import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config/loader.js';
import { TicketState } from '../core/state-machine/state.js';
import { executeTicket, type ExecuteTicketInput, type ExecuteTicketResult } from '../execution/ticket.js';
import { EventType, type ShipgraphEvent } from '../events/event.js';
import {
  createEventRepository,
  createRunRepository,
  createTicketRepository,
} from '../persistence/repositories.js';
import { ACTIVE_CAPACITY_STATES } from '../scheduler/ready.js';
import { getCurrentProjectId, type WorkspaceServiceOptions } from '../workspace/service.js';
import {
  parseLinearWebhook,
  type LinearWebhookPayload,
  LinearWebhookError,
} from './webhook.js';
import type { LinearDispatchClient, LinearDispatchIssue } from './linear.js';

const LINEAR_DISPATCH_RESOLUTION_TIMEOUT_MS = 2_000;

export type LinearDispatchHeaders = {
  [name: string]: string | undefined;
};

export type DispatchResult = {
  outcome: 'CLAIMED' | 'RECOVERED' | 'ALREADY_CLAIMED' | 'NO_CAPACITY' | 'IGNORED';
  claimId?: string;
  ticketId?: string;
  reason?: string;
};

export type LinearDispatchServiceOptions = {
  workspace: WorkspaceServiceOptions;
  client: LinearDispatchClient;
  resolveAuthorizedExecution: (
    issue: LinearDispatchIssue
  ) => ExecuteTicketInput | undefined | Promise<ExecuteTicketInput | undefined>;
  execute?: (input: ExecuteTicketInput) => Promise<ExecuteTicketResult>;
  webhookSecret?: string;
  nowMs?: () => number;
};

type DispatchClaim = Extract<
  ShipgraphEvent,
  { type: typeof EventType.DISPATCH_CLAIMED }
>;
type ExecutionTerminal = Extract<
  ShipgraphEvent,
  { type: typeof EventType.EXECUTION_TERMINAL }
>;

type ClaimDecision =
  | { kind: 'claim'; claim: DispatchClaim }
  | { kind: 'existing'; claim: DispatchClaim }
  | { kind: 'noCapacity'; reason: string }
  | { kind: 'ignored'; reason: string };

function headerValue(headers: LinearDispatchHeaders, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName);
  return entry?.[1];
}

function activeClaims(events: readonly ShipgraphEvent[]): readonly DispatchClaim[] {
  const claims = events.filter(
    (event): event is DispatchClaim => event.type === EventType.DISPATCH_CLAIMED
  );
  const completed = new Set(
    events
      .filter((event) => event.type === EventType.DISPATCH_COMPLETED)
      .map((event) => event.payload.claimId)
  );
  return claims.filter((claim) => {
    if (completed.has(claim.payload.claimId)) return false;
    return executionTerminalAfter(events, claim) === undefined;
  });
}

function executionTerminalAfter(
  events: readonly ShipgraphEvent[],
  claim: DispatchClaim
): ExecutionTerminal | undefined {
  return events.find(
    (event): event is ExecutionTerminal =>
      event.type === EventType.EXECUTION_TERMINAL &&
      event.ticketId === claim.ticketId &&
      event.payload.executionId === claim.payload.executionId &&
      event.sequence > claim.sequence
  );
}

function executionInputMatchesWorkspace(
  input: ExecuteTicketInput,
  issue: LinearDispatchIssue,
  projectId: string,
  workspace: WorkspaceServiceOptions
): boolean {
  if (input.issueId !== issue.identifier || input.workspace.db !== workspace.db) return false;
  return getCurrentProjectId(input.workspace) === projectId;
}

function nowIso(workspace: WorkspaceServiceOptions): string {
  return workspace.now?.() ?? new Date().toISOString();
}

function isLocallyEligible(
  ticket: { status: string; dependsOn: readonly string[] },
  projectId: string,
  findTicket: (ticketId: string) => { projectId: string; status: string } | undefined
): boolean {
  if (ticket.status !== TicketState.ELIGIBLE) return false;
  return ticket.dependsOn.every((dependencyId) => {
    const dependency = findTicket(dependencyId);
    return dependency?.projectId === projectId && dependency.status === TicketState.COMPLETE;
  });
}

/**
 * The narrow authenticated Linear wake-up boundary. It never constructs a
 * contract, policy, or execution input from webhook data.
 */
export function createLinearDispatchService(options: LinearDispatchServiceOptions) {
  const config = loadConfig(options.workspace.projectDir);
  const dispatch = config.dispatch;
  if (dispatch?.enabled !== true || dispatch.linearProjectId === undefined) {
    throw new Error('Linear dispatch is not enabled with a project binding');
  }
  const linearProjectId = dispatch.linearProjectId;
  const projectId = getCurrentProjectId(options.workspace);
  const secret = options.webhookSecret ?? process.env.LINEAR_WEBHOOK_SECRET;
  if (secret === undefined || secret.length === 0) {
    throw new Error('Linear dispatch requires LINEAR_WEBHOOK_SECRET');
  }
  const execute = options.execute ?? executeTicket;
  const inFlight = new Set<string>();
  const nowMs = options.nowMs ?? Date.now;

  const validateLiveIssue = (issue: LinearDispatchIssue): string | undefined => {
    if (issue.projectId !== linearProjectId) return 'Linear issue is not in the configured project';
    if (dispatch.linearTeamId !== undefined && issue.teamId !== dispatch.linearTeamId) {
      return 'Linear issue is not in the configured team';
    }
    if (!issue.labels.includes(dispatch.queueLabel)) return 'Linear issue is not currently queued';
    return undefined;
  };

  const resolveExecution = async (
    issue: LinearDispatchIssue
  ): Promise<ExecuteTicketInput | undefined> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const resolution = Promise.resolve(options.resolveAuthorizedExecution(issue));
    const deadline = new Promise<undefined>((resolve) => {
      timeout = setTimeout(() => resolve(undefined), LINEAR_DISPATCH_RESOLUTION_TIMEOUT_MS);
    });
    let input: ExecuteTicketInput | undefined;
    try {
      input = await Promise.race([resolution, deadline]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    if (input === undefined) return undefined;
    if (!executionInputMatchesWorkspace(input, issue, projectId, options.workspace)) {
      throw new Error('trusted execution composition did not bind to the current project and issue');
    }
    return input;
  };

  const decideClaim = (
    issue: LinearDispatchIssue,
    deliveryId: string
  ): ClaimDecision => {
    const decision = options.workspace.db.transaction((): ClaimDecision => {
      const ticketRepository = createTicketRepository(options.workspace.db);
      const ticket = ticketRepository.findById(issue.identifier);
      if (ticket === undefined || ticket.projectId !== projectId) {
        return { kind: 'ignored', reason: 'Linear issue has no matching local ticket' };
      }
      const approved = options.workspace.db.prepare(
        'SELECT 1 AS approved FROM approved_backlog_tickets WHERE project_id = ? AND ticket_id = ?'
      ).get(projectId, ticket.id) as { approved: number } | undefined;
      if (approved === undefined) {
        return { kind: 'ignored', reason: 'local ticket is not approved for execution' };
      }
      const projectEvents = createEventRepository(options.workspace.db).findByProjectId(projectId);
      const claimsForTicket = projectEvents.filter(
        (event): event is DispatchClaim =>
          event.type === EventType.DISPATCH_CLAIMED && event.ticketId === ticket.id
      );
      const duplicate = claimsForTicket.find(
        (claim) => claim.payload.linearDeliveryId === deliveryId
      );
      if (duplicate !== undefined) {
        if (!activeClaims(projectEvents).some(
          (claim) => claim.payload.claimId === duplicate.payload.claimId
        )) {
          return { kind: 'ignored', reason: 'dispatch claim has already completed' };
        }
        return { kind: 'existing', claim: duplicate };
      }
      const activeForTicket = activeClaims(projectEvents).find(
        (claim) => claim.ticketId === ticket.id
      );
      if (activeForTicket !== undefined) {
        if (activeForTicket.payload.linearIssueId !== issue.id) {
          return { kind: 'ignored', reason: 'local ticket is already claimed by another Linear issue' };
        }
        return { kind: 'existing', claim: activeForTicket };
      }
      if (ticket.status !== TicketState.ELIGIBLE) {
        return { kind: 'ignored', reason: 'local ticket is not eligible' };
      }
      if (createRunRepository(options.workspace.db).findActiveByTicket(projectId, ticket.id) !== undefined) {
        return { kind: 'ignored', reason: 'local ticket already has an active execution' };
      }
      if (!isLocallyEligible(ticket, projectId, (ticketId) => {
        const dependency = ticketRepository.findById(ticketId);
        return dependency === undefined
          ? undefined
          : { projectId: dependency.projectId, status: dependency.status };
      })) {
        return { kind: 'ignored', reason: 'local ticket is not dependency-eligible' };
      }
      const activeRow = options.workspace.db.prepare(
        `SELECT COUNT(*) AS count
         FROM tickets
         INNER JOIN approved_backlog_tickets AS approved
           ON approved.project_id = tickets.project_id AND approved.ticket_id = tickets.id
         WHERE tickets.project_id = ? AND tickets.status IN (${ACTIVE_CAPACITY_STATES.map(() => '?').join(', ')})`
      ).get(projectId, ...ACTIVE_CAPACITY_STATES) as { count: number };
      const activeTicketIds = new Set<string>();
      if (activeRow.count >= config.execution.maxConcurrentTickets) {
        return { kind: 'ignored', reason: 'ShipGraph capacity is exhausted' };
      }
      for (const claim of activeClaims(projectEvents)) {
        const claimedTicket = ticketRepository.findById(claim.ticketId);
        if (claimedTicket !== undefined && !ACTIVE_CAPACITY_STATES.includes(claimedTicket.status)) {
          activeTicketIds.add(claimedTicket.id);
        }
      }
      if (activeRow.count + activeTicketIds.size >= config.execution.maxConcurrentTickets) {
        return { kind: 'noCapacity', reason: 'ShipGraph capacity is exhausted' };
      }

      const claimId = randomUUID();
      const executionId = randomUUID().replaceAll('-', '');
      const claimedAt = nowIso(options.workspace);
      const event = createEventRepository(options.workspace.db).append({
        id: options.workspace.createEventId?.() ?? randomUUID(),
        timestamp: claimedAt,
        projectId,
        ticketId: ticket.id,
        type: EventType.DISPATCH_CLAIMED,
        payload: {
          claimId,
          executionId,
          ticketId: ticket.id,
          linearIssueId: issue.id,
          linearIdentifier: issue.identifier,
          linearDeliveryId: deliveryId,
          linearProjectId,
          claimedAt,
        },
      });
      if (event.type !== EventType.DISPATCH_CLAIMED) {
        throw new Error('dispatch claim event was persisted with the wrong type');
      }
      return { kind: 'claim', claim: event };
    }).immediate();
    return decision;
  };

  const completeClaim = (claim: DispatchClaim, outcome: ExecuteTicketResult['outcome']): void => {
    options.workspace.db.transaction(() => {
      const alreadyCompleted = createEventRepository(options.workspace.db)
        .findByTicketId(claim.ticketId)
        .some(
          (event) =>
            event.type === EventType.DISPATCH_COMPLETED &&
            event.payload.claimId === claim.payload.claimId
        );
      if (alreadyCompleted) return;
      const completedAt = nowIso(options.workspace);
      createEventRepository(options.workspace.db).append({
        id: options.workspace.createEventId?.() ?? randomUUID(),
        timestamp: completedAt,
        projectId,
        ticketId: claim.ticketId,
        type: EventType.DISPATCH_COMPLETED,
        payload: {
          claimId: claim.payload.claimId,
          ticketId: claim.ticketId,
          outcome,
          completedAt,
        },
      });
    }).immediate();
  };

  const reconcileCompletedClaims = (): void => {
    options.workspace.db.transaction(() => {
      const events = createEventRepository(options.workspace.db).findByProjectId(projectId);
      const completed = new Set(
        events
          .filter((event) => event.type === EventType.DISPATCH_COMPLETED)
          .map((event) => event.payload.claimId)
      );
      for (const claim of events.filter(
        (event): event is DispatchClaim => event.type === EventType.DISPATCH_CLAIMED
      )) {
        if (completed.has(claim.payload.claimId)) continue;
        const terminal = executionTerminalAfter(events, claim);
        if (terminal !== undefined) {
          completeClaim(claim, terminal.payload.outcome);
          completed.add(claim.payload.claimId);
        }
      }
    }).immediate();
  };

  const scheduleClaim = (claim: DispatchClaim, input: ExecuteTicketInput): boolean => {
    if (inFlight.has(claim.payload.claimId)) return false;
    inFlight.add(claim.payload.claimId);
    const boundInput: ExecuteTicketInput = {
      ...input,
      executionId: claim.payload.executionId,
      createExecutionId: () => claim.payload.executionId,
    };
    setImmediate(() => {
      void execute(boundInput)
        .then((result) => completeClaim(claim, result.outcome))
        .catch(() => {
          // An incomplete claim is intentionally left durable for recovery.
        })
        .finally(() => inFlight.delete(claim.payload.claimId));
    });
    return true;
  };

  const recoverClaim = async (claim: DispatchClaim): Promise<boolean> => {
    const issue = await options.client.getIssue(claim.payload.linearIssueId);
    if (issue === undefined || issue.id !== claim.payload.linearIssueId) return false;
    if (validateLiveIssue(issue) !== undefined || issue.identifier !== claim.payload.linearIdentifier) {
      return false;
    }
    const input = await resolveExecution(issue);
    if (input === undefined) return false;
    if (createRunRepository(options.workspace.db).findActiveByTicket(projectId, issue.identifier) !== undefined) {
      return false;
    }
    return scheduleClaim(claim, input);
  };

  return {
    async handleWebhook(rawBody: Uint8Array, headers: LinearDispatchHeaders): Promise<DispatchResult> {
      const deliveryId = headerValue(headers, 'Linear-Delivery');
      const payload: LinearWebhookPayload = parseLinearWebhook(
        rawBody,
        {
          signature: headerValue(headers, 'Linear-Signature'),
          delivery: deliveryId,
        },
        secret,
        nowMs()
      );
      if (deliveryId === undefined) {
        throw new LinearWebhookError('Linear webhook delivery ID is invalid');
      }
      const eventHeader = headerValue(headers, 'Linear-Event');
      if (eventHeader !== undefined && eventHeader !== payload.type) {
        throw new LinearWebhookError('Linear event header does not match the signed event body');
      }
      if (payload.type !== 'Issue') {
        return { outcome: 'IGNORED', reason: 'event type is not Issue' };
      }
      reconcileCompletedClaims();

      const issue = await options.client.getIssue(payload.data.id);
      if (issue === undefined || issue.id !== payload.data.id) {
        return { outcome: 'IGNORED', reason: 'live Linear issue is unavailable' };
      }
      const issueReason = validateLiveIssue(issue);
      if (issueReason !== undefined) return { outcome: 'IGNORED', reason: issueReason };
      const input = await resolveExecution(issue);
      if (input === undefined) return { outcome: 'IGNORED', reason: 'trusted execution composition is unavailable' };

      const decision = decideClaim(issue, deliveryId);
      if (decision.kind === 'noCapacity') {
        return { outcome: 'NO_CAPACITY', ticketId: issue.identifier, reason: decision.reason };
      }
      if (decision.kind === 'ignored') return { outcome: 'IGNORED', reason: decision.reason };
      if (decision.kind === 'existing') {
        return { outcome: 'ALREADY_CLAIMED', claimId: decision.claim.payload.claimId, ticketId: issue.identifier };
      }
      scheduleClaim(decision.claim, input);
      return { outcome: 'CLAIMED', claimId: decision.claim.payload.claimId, ticketId: issue.identifier };
    },

    async recoverIncompleteClaims(): Promise<number> {
      reconcileCompletedClaims();
      const claims = activeClaims(createEventRepository(options.workspace.db).findByProjectId(projectId));
      let scheduled = 0;
      for (const claim of claims) {
        if (await recoverClaim(claim)) scheduled += 1;
      }
      return scheduled;
    },

    projectId,
    webhookPath: dispatch.webhookPath,
    listenHost: dispatch.listenHost,
    listenPort: dispatch.listenPort,
  };
}

export type LinearDispatchService = ReturnType<typeof createLinearDispatchService>;
