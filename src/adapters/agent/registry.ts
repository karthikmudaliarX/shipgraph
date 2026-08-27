import {
  MODEL_PROVIDER_TO_AGENT_PROVIDER,
  MODEL_PROVIDER_IDS,
  MODEL_TASK_TYPES,
  modelProviderIdSchema,
  type ModelExecutionCapabilitySnapshot,
  type ModelProviderId,
  type ModelTaskType,
  type ModelRoutingSelection,
} from '../../domain/model-provider.js';
import type { AgentProvider } from '../../domain/agent-provider.js';
import type { AgentCapability, AgentExecutionAdapter } from './adapter.js';
import {
  createCodexAdapter,
  createGeminiAdapter,
  createGrokAdapter,
  type ModelExecutionAdapterBinding,
} from './providers.js';
import { createOpenCodeAdapter, type OpenCodeAdapterOptions } from './opencode.js';
import type { AgentProcessRunner } from './process.js';
import type { ModelProviderConfiguration } from '../model/adapter.js';

export type { ModelExecutionAdapterBinding } from './providers.js';

/**
 * MODEL-001 provider identities describe the account/model pool. AGENT-001
 * identities describe the executable automation surface. Keep this mapping
 * exhaustive and explicit: two model providers may use the ACP boundary, but
 * their binding remains distinct and is selected by model provider ID.
 */
export { MODEL_PROVIDER_TO_AGENT_PROVIDER } from '../../domain/model-provider.js';

export type ModelExecutionTarget = {
  modelProviderId: ModelProviderId;
  provider: AgentProvider;
  modelId: string;
  task: ModelTaskType;
  adapter: AgentExecutionAdapter;
  /** True only when MODEL-001 durably reserved this exact target for a run. */
  executionBound: boolean;
  routingDecisionId?: string;
  runId?: string;
};

/** Exhaustive bridge from MODEL-001 task names to AGENT-001 capabilities. */
export const MODEL_TASK_TO_AGENT_CAPABILITY = {
  implementation: 'execute',
  review: 'review',
  repair: 'repair',
} as const satisfies Record<ModelTaskType, AgentCapability>;

export type ModelExecutionAdapterFactoryOptions = {
  configuration?: ModelProviderConfiguration;
  processRunner?: AgentProcessRunner;
  cwd?: string;
  environment?: Readonly<Record<string, string>>;
};

// Keep the MODEL-001 owner of each concrete adapter out-of-band. The
// provider-neutral AGENT-001 interface intentionally has no model-provider
// identity, so the execution bridge must not trust a caller-supplied target
// that swaps one ACP adapter for another.
const adapterModelProviderOwners = new WeakMap<AgentExecutionAdapter, ModelProviderId>();

/**
 * Indexes execution adapters by MODEL-001 identity while preserving the
 * provider-neutral AGENT-001 adapter contract.
 */
export class AgentExecutionAdapterRegistry {
  private readonly bindings: ReadonlyMap<ModelProviderId, ModelExecutionAdapterBinding>;

  public constructor(bindings: readonly ModelExecutionAdapterBinding[]) {
    const indexed = new Map<ModelProviderId, ModelExecutionAdapterBinding>();
    for (const binding of bindings) {
      const modelProviderId = modelProviderIdSchema.parse(binding.modelProviderId);
      if (indexed.has(modelProviderId)) {
        throw new Error(`Duplicate execution adapter binding for ${modelProviderId}`);
      }
      const expected = MODEL_PROVIDER_TO_AGENT_PROVIDER[modelProviderId];
      if (binding.adapter.provider !== expected) {
        throw new Error(
          `Execution adapter for ${modelProviderId} uses ${binding.adapter.provider}; expected ${expected}`
        );
      }
      if (!binding.adapter.capabilities.includes('execute')) {
        throw new Error(`Execution adapter for ${modelProviderId} does not support execute`);
      }
      const existingOwner = adapterModelProviderOwners.get(binding.adapter);
      if (existingOwner !== undefined && existingOwner !== modelProviderId) {
        throw new Error(
          `Execution adapter is already bound to ${existingOwner}; cannot bind it to ${modelProviderId}`
        );
      }
      adapterModelProviderOwners.set(binding.adapter, modelProviderId);
      indexed.set(modelProviderId, { modelProviderId, adapter: binding.adapter });
    }
    this.bindings = indexed;
  }

  public list(): readonly ModelExecutionAdapterBinding[] {
    return MODEL_PROVIDER_IDS
      .map((providerId) => this.bindings.get(providerId))
      .filter((binding): binding is ModelExecutionAdapterBinding => binding !== undefined);
  }

  public get(modelProviderId: ModelProviderId): ModelExecutionAdapterBinding | undefined {
    return this.bindings.get(modelProviderId);
  }

  /**
   * Expose only MODEL task capabilities supported by the bound AGENT adapter.
   * The routing snapshot uses this view to avoid scoring a provider that
   * cannot execute the requested task and then failing before fallback.
   */
  public executionCapabilities(): readonly ModelExecutionCapabilitySnapshot[] {
    return MODEL_PROVIDER_IDS.flatMap((providerId) => {
      const binding = this.bindings.get(providerId);
      if (binding === undefined) return [];
      const capabilities = MODEL_TASK_TYPES.filter((task) =>
        binding.adapter.capabilities.includes(MODEL_TASK_TO_AGENT_CAPABILITY[task])
      );
      return capabilities.length === 0
        ? []
        : [{ providerId, capabilities }];
    });
  }

  public resolve(
    selection: Pick<ModelRoutingSelection, 'providerId' | 'modelId' | 'task'>
  ): ModelExecutionTarget {
    const binding = this.bindings.get(selection.providerId);
    if (binding === undefined) {
      throw new Error(`No AGENT-001 execution adapter is bound to ${selection.providerId}`);
    }
    const requiredCapability = MODEL_TASK_TO_AGENT_CAPABILITY[selection.task];
    if (!binding.adapter.capabilities.includes(requiredCapability)) {
      throw new Error(
        `AGENT-001 adapter for ${selection.providerId} does not support MODEL task ${selection.task}`
      );
    }
    return {
      modelProviderId: selection.providerId,
      provider: binding.adapter.provider,
      modelId: selection.modelId,
      task: selection.task,
      adapter: binding.adapter,
      executionBound: false,
    };
  }
}

/**
 * Verify that a target carries the concrete adapter registered for its
 * MODEL-001 provider identity. This is deliberately fail-closed for targets
 * assembled outside an AgentExecutionAdapterRegistry.
 */
export function isModelExecutionAdapterBound(
  target: Pick<ModelExecutionTarget, 'modelProviderId' | 'provider' | 'task' | 'adapter'>
): boolean {
  return (
    adapterModelProviderOwners.get(target.adapter) === target.modelProviderId &&
    target.provider === MODEL_PROVIDER_TO_AGENT_PROVIDER[target.modelProviderId] &&
    target.adapter.provider === target.provider &&
    target.adapter.capabilities.includes(MODEL_TASK_TO_AGENT_CAPABILITY[target.task])
  );
}

export function createModelExecutionAdapterBindings(
  options: ModelExecutionAdapterFactoryOptions = {}
): readonly ModelExecutionAdapterBinding[] {
  const configuration = options.configuration ?? {};
  const opencode = configuration.opencodeGo;
  const codex = configuration.codex;
  const grok = configuration.grok;
  const gemini = configuration.gemini;
  const shared = {
    ...(options.processRunner === undefined ? {} : { processRunner: options.processRunner }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  };
  const opencodeOptions: OpenCodeAdapterOptions = {
    ...shared,
    ...(opencode?.enabled === undefined ? {} : { enabled: opencode.enabled }),
    ...(opencode?.executable === undefined ? {} : { executable: opencode.executable }),
  };

  return [
    { modelProviderId: 'opencode-go', adapter: createOpenCodeAdapter(opencodeOptions) },
    {
      modelProviderId: 'codex',
      adapter: createCodexAdapter({
        ...shared,
        ...(codex?.enabled === undefined ? {} : { enabled: codex.enabled }),
        ...(codex?.executable === undefined ? {} : { executable: codex.executable }),
      }),
    },
    {
      modelProviderId: 'grok',
      adapter: createGrokAdapter({
        ...shared,
        ...(grok?.enabled === undefined ? {} : { enabled: grok.enabled }),
        ...(grok?.executable === undefined ? {} : { executable: grok.executable }),
      }),
    },
    {
      modelProviderId: 'gemini',
      adapter: createGeminiAdapter({
        ...shared,
        ...(gemini?.enabled === undefined ? {} : { enabled: gemini.enabled }),
        ...(gemini?.executable === undefined ? {} : { executable: gemini.executable }),
      }),
    },
  ];
}

export function agentProviderForModelProvider(modelProviderId: ModelProviderId): AgentProvider {
  return MODEL_PROVIDER_TO_AGENT_PROVIDER[modelProviderId];
}
