import type { ModelProviderId } from '../../domain/model-provider.js';
import type { AgentExecutionAdapter } from './adapter.js';

/**
 * The AGENT-001 adapter contract is intentionally provider-neutral, but the
 * MODEL-001 bridge still needs an immutable association for concrete
 * adapters. Keep that association out-of-band so it cannot be substituted by
 * changing a public adapter field or a binding record.
 */
const owners = new WeakMap<AgentExecutionAdapter, ModelProviderId>();

export function registerModelProviderAdapter(
  adapter: AgentExecutionAdapter,
  modelProviderId: ModelProviderId
): void {
  const existing = owners.get(adapter);
  if (existing !== undefined && existing !== modelProviderId) {
    throw new Error(
      `Execution adapter is already bound to ${existing}; cannot bind it to ${modelProviderId}`
    );
  }
  owners.set(adapter, modelProviderId);
}

export function modelProviderOwner(
  adapter: AgentExecutionAdapter
): ModelProviderId | undefined {
  return owners.get(adapter);
}
