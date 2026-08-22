export class ShipgraphError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'ShipgraphError';
  }
}

export class ConfigValidationError extends ShipgraphError {
  constructor(message: string) {
    super(message, 'CONFIG_VALIDATION_ERROR');
    this.name = 'ConfigValidationError';
  }
}

export class StateTransitionError extends ShipgraphError {
  constructor(message: string) {
    super(message, 'STATE_TRANSITION_ERROR');
    this.name = 'StateTransitionError';
  }
}

export class TicketValidationError extends ShipgraphError {
  constructor(message: string) {
    super(message, 'TICKET_VALIDATION_ERROR');
    this.name = 'TicketValidationError';
  }
}
