import { z } from 'zod';

const linearIssueResponseSchema = z.object({
  data: z.object({
    issue: z.object({
      id: z.string().min(1).max(256),
      identifier: z.string().min(1).max(256),
      project: z.object({ id: z.string().min(1).max(256) }).nullable(),
      team: z.object({ id: z.string().min(1).max(256) }).nullable(),
      labels: z.object({
        nodes: z.array(z.object({ name: z.string().min(1).max(256) }).strict()),
      }).strict(),
    }).strict().nullable(),
  }).strict(),
  errors: z.array(z.object({ message: z.string().min(1).max(4_096) }).passthrough()).optional(),
}).passthrough();

export type LinearDispatchIssue = {
  id: string;
  identifier: string;
  projectId?: string;
  teamId?: string;
  labels: readonly string[];
};

export interface LinearDispatchClient {
  getIssue(issueId: string): Promise<LinearDispatchIssue | undefined>;
}
export type LinearDispatchClientOptions = {
  apiKey?: string;
  endpoint?: string;
  fetch?: typeof fetch;
};

const ISSUE_QUERY = `
  query ShipGraphDispatchIssue($id: String!) {
    issue(id: $id) {
      id
      identifier
      project { id }
      team { id }
      labels { nodes { name } }
    }
  }
`;

/** Minimal read-only Linear GraphQL client used after webhook authentication. */
export function createLinearDispatchClient(
  options: LinearDispatchClientOptions = {}
): LinearDispatchClient {
  const apiKey = options.apiKey ?? process.env.LINEAR_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('Linear dispatch requires LINEAR_API_KEY');
  }
  const endpoint = options.endpoint ?? 'https://api.linear.app/graphql';
  const request = options.fetch ?? fetch;

  return {
    async getIssue(issueId): Promise<LinearDispatchIssue | undefined> {
      const response = await request(endpoint, {
        method: 'POST',
        headers: {
          authorization: apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query: ISSUE_QUERY, variables: { id: issueId } }),
      });
      if (!response.ok) {
        throw new Error(`Linear issue lookup failed with HTTP ${response.status}`);
      }

      let json: unknown;
      try {
        json = await response.json() as unknown;
      } catch {
        throw new Error('Linear issue lookup returned invalid JSON');
      }
      const parsed = linearIssueResponseSchema.safeParse(json);
      if (!parsed.success || (parsed.data.errors !== undefined && parsed.data.errors.length > 0)) {
        throw new Error('Linear issue lookup returned an unsupported response');
      }
      const issue = parsed.data.data.issue;
      if (issue === null) return undefined;
      return {
        id: issue.id,
        identifier: issue.identifier,
        ...(issue.project === null ? {} : { projectId: issue.project.id }),
        ...(issue.team === null ? {} : { teamId: issue.team.id }),
        labels: issue.labels.nodes.map((label) => label.name),
      };
    },
  };
}
