import { z } from 'zod';
import { AGENT_PROVIDERS } from '../domain/agent-provider.js';

/**
 * Supported ShipGraph configuration major versions.
 * Unknown major versions fail closed.
 */
export const SUPPORTED_CONFIG_MAJOR_VERSIONS = [1] as const;

export const configVersionSchema = z.union([
  z.literal(1),
  z.number().int().positive(),
]);

export const projectConfigSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9-]+$/, {
    message: 'project name must be lowercase alphanumeric with hyphens',
  }),
  repository: z.string().regex(/^[^/]+\/[^/]+$/, {
    message: 'repository must be in owner/repo format',
  }),
  defaultBranch: z.string().min(1).default('main'),
}).strict();

export const executionConfigSchema = z.object({
  maxConcurrentTickets: z.number().int().min(1).max(100).default(1),
  maxRepairIterations: z.number().int().min(0).max(100).default(6),
}).strict();

export const releaseConfigSchema = z.object({
  requireHumanApproval: z.boolean().default(true),
  requireCleanCI: z.boolean().default(true),
  requireExactShaReviews: z.boolean().default(true),
}).strict();

export const agentsConfigSchema = z.object({
  implementer: z.enum(AGENT_PROVIDERS).default('opencode'),
  reviewers: z
    .array(z.enum(['correctness', 'adversarial', 'security']))
    .default(['correctness']),
}).strict();

export const shipgraphConfigSchema = z.object({
  version: configVersionSchema,
  project: projectConfigSchema,
  execution: executionConfigSchema.default({}),
  release: releaseConfigSchema.default({}),
  agents: agentsConfigSchema.default({}),
}).strict();

export type ShipgraphConfig = z.infer<typeof shipgraphConfigSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type ExecutionConfig = z.infer<typeof executionConfigSchema>;
export type ReleaseConfig = z.infer<typeof releaseConfigSchema>;
export type AgentsConfig = z.infer<typeof agentsConfigSchema>;

export type PersistedProjectIdentity = {
  name: string;
  repository: string;
  defaultBranch: string;
  config: unknown;
};

/**
 * Validate a parsed config object.
 * Throws if the major version is unsupported or the shape is invalid.
 */
export function validateConfig(value: unknown): ShipgraphConfig {
  const parsed = shipgraphConfigSchema.parse(value);
  if (!(SUPPORTED_CONFIG_MAJOR_VERSIONS as readonly number[]).includes(parsed.version)) {
    throw new Error(
      `Unsupported shipgraph.yml major version: ${parsed.version}. ` +
        `Supported versions: ${SUPPORTED_CONFIG_MAJOR_VERSIONS.join(', ')}.`
    );
  }
  return parsed;
}

/** Compare a persisted project record with a validated configuration. */
export function persistedProjectMatchesConfig(
  project: PersistedProjectIdentity,
  config: ShipgraphConfig
): boolean {
  const persistedConfig = validateConfig(project.config);
  return (
    project.name === config.project.name &&
    project.repository === config.project.repository &&
    project.defaultBranch === config.project.defaultBranch &&
    JSON.stringify(persistedConfig) === JSON.stringify(config)
  );
}
