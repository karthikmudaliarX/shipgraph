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
import type {
  AgentCapability,
  AgentExecutionAdapter,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentProbeResult,
} from './adapter.js';
import {
  createCodexAdapter,
  createGeminiAdapter,
  createGrokAdapter,
  type ModelExecutionAdapterBinding,
} from './providers.js';
import { createOpenCodeAdapter, type OpenCodeAdapterOptions } from './opencode.js';
import type { AgentProcessRunner } from './process.js';
import type { ModelProviderConfiguration } from '../model/adapter.js';
import {
  modelProviderOwner,
} from './model-provider-owner.js';

export type { ModelExecutionAdapterBinding } from './providers.js';

/**
 * MODEL-001 provider identities describe the account/model pool. AGENT-001
 * identities describe the executable automation surface. Keep this mapping
 * exhaustive and explicit: two model providers may use the ACP boundary, but
 * their binding remains distinct and is selected by model provider ID.
 */
export { MODEL_PROVIDER_TO_AGENT_PROVIDER } from '../../domain/model-provider.js';
export { registerModelProviderAdapter } from './model-provider-owner.js';

export type ModelExecutionTarget = Readonly<{
  modelProviderId: ModelProviderId;
  provider: AgentProvider;
  modelId: string;
  task: ModelTaskType;
  /** True only when MODEL-001 durably reserved this exact target for a run. */
  executionBound: boolean;
  routingDecisionId?: string;
  runId?: string;
}>;

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
      const owner = modelProviderOwner(binding.adapter);
      if (owner !== modelProviderId) {
        throw new Error(
          `Execution adapter for ${modelProviderId} is not branded for that MODEL provider ` +
            `(owner=${owner ?? 'unknown'})`
        );
      }
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
    this.adapterForTarget({
      modelProviderId: selection.providerId,
      provider: MODEL_PROVIDER_TO_AGENT_PROVIDER[selection.providerId],
      modelId: selection.modelId,
      task: selection.task,
      executionBound: false,
    });
    return Object.freeze({
      modelProviderId: selection.providerId,
      provider: MODEL_PROVIDER_TO_AGENT_PROVIDER[selection.providerId],
      modelId: selection.modelId,
      task: selection.task,
      executionBound: false,
    });
  }

  /** Probe the concrete AGENT-001 surface without exposing the adapter. */
  public probe(target: ModelExecutionTarget): Promise<AgentProbeResult> | AgentProbeResult {
    return this.adapterForTarget(target).probe();
  }

  /**
   * Execute only through a target issued by this registry. The concrete
   * adapter remains private to the registry; callers must use the
   * ModelRoutingService execution bridge, which performs durable route and
   * workspace validation before calling this method.
   */
  public execute(
    target: ModelExecutionTarget,
    request: AgentExecutionRequest
  ): Promise<AgentExecutionResult> {
    if (request.provider !== target.provider || request.model !== target.modelId) {
      throw new Error(
        `AGENT-001 request does not match routed target ${target.modelProviderId}/${target.modelId}`
      );
    }
    return this.adapterForTarget(target).execute(request);
  }

  /** Return the target's capabilities without returning its concrete adapter. */
  public capabilities(target: ModelExecutionTarget): readonly AgentCapability[] {
    return [...this.adapterForTarget(target).capabilities];
  }

  private adapterForTarget(target: ModelExecutionTarget): AgentExecutionAdapter {
    const binding = this.bindings.get(target.modelProviderId);
    const expectedProvider = MODEL_PROVIDER_TO_AGENT_PROVIDER[target.modelProviderId];
    if (
      binding === undefined ||
      target.provider !== expectedProvider ||
      binding.adapter.provider !== expectedProvider
    ) {
      throw new Error(
        `No trustworthy AGENT-001 execution adapter is bound to ${target.modelProviderId}`
      );
    }
    const requiredCapability = MODEL_TASK_TO_AGENT_CAPABILITY[target.task];
    if (!binding.adapter.capabilities.includes(requiredCapability)) {
      throw new Error(
        `AGENT-001 adapter for ${target.modelProviderId} does not support MODEL task ${target.task}`
      );
    }
    return binding.adapter;
  }
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
