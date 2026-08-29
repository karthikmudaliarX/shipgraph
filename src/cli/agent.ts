import type { AgentProvider } from '../domain/agent-provider.js';
import type { ModelProviderId } from '../domain/model-provider.js';
import type { ModelRoutingRequest } from '../domain/model-provider.js';
import { ModelRoutingService, type ModelServiceOptions } from '../model/service.js';
import {
  executeAgentTask,
  inspectAgentRun,
  listAgentRuns,
  reconcileAgentRun,
  recoverAgentRun,
  type AgentExecutionServiceOptions,
} from '../execution/service.js';
import type { WorkspaceServiceOptions } from '../workspace/service.js';

export function agentServiceOptions(
  base: WorkspaceServiceOptions,
  adapter: AgentExecutionServiceOptions['adapter'],
  maxOutputBytes?: number
): AgentExecutionServiceOptions {
  return {
    ...base,
    adapter,
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
  };
}

export async function runAgentTask(
  options: AgentExecutionServiceOptions,
  input: {
    ticketId: string;
    provider?: AgentProvider;
    modelProviderId?: ModelProviderId;
    model: string;
    instructions: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }
): Promise<Record<string, unknown>> {
  const result = await executeAgentTask(options, input);
  return { created: result.created, run: publicRun(result.run) };
}

export async function runRoutedAgentTask(
  modelOptions: ModelServiceOptions,
  workspaceOptions: WorkspaceServiceOptions,
  routing: Omit<ModelRoutingRequest, 'runId'>,
  input: { ticketId: string; instructions: string; timeoutMs?: number; signal?: AbortSignal }
): Promise<Record<string, unknown>> {
  const result = await new ModelRoutingService(modelOptions).executeRoutedAgentTask(
    workspaceOptions,
    routing,
    input
  );
  return { decision: result.decision, created: result.created, run: publicRun(result.run) };
}

export async function runAgentInspect(
  options: WorkspaceServiceOptions,
  runId: string
): Promise<Record<string, unknown>> {
  return { run: publicRun(await inspectAgentRun(options, runId)) };
}

export async function runAgentList(
  options: WorkspaceServiceOptions
): Promise<Record<string, unknown>> {
  return { runs: (await listAgentRuns(options)).map(publicRun) };
}

export async function runAgentRecover(
  options: WorkspaceServiceOptions,
  runId: string
): Promise<Record<string, unknown>> {
  const result = await recoverAgentRun(options, runId);
  return { recovered: result.recovered, run: publicRun(result.run) };
}

export async function runAgentReconcile(
  options: WorkspaceServiceOptions,
  runId: string
): Promise<Record<string, unknown>> {
  const result = await reconcileAgentRun(options, runId, { executionStopped: true });
  return { released: result.released, run: publicRun(result.run) };
}

function publicRun(run: Record<string, unknown>): Record<string, unknown> {
  return { ...run };
}
