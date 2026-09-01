import { describe, expect, it } from 'vitest';
import {
  createLinearDispatchClient,
  LINEAR_DISPATCH_API_TIMEOUT_MS,
} from '../../src/dispatch/linear.js';

describe('Linear dispatch GraphQL client', () => {
  it('uses the fixed API endpoint contract and parses the live issue shape', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const client = createLinearDispatchClient({
      apiKey: 'linear-test-key',
      fetch: async (url, init) => {
        requestUrl = String(url);
        requestInit = init;
        return new Response(JSON.stringify({
          data: {
            issue: {
              id: 'linear-issue-1',
              identifier: 'DP-1',
              project: { id: 'linear-project' },
              team: { id: 'linear-team' },
              labels: { nodes: [{ name: 'shipgraph:queued' }] },
            },
          },
        }), { status: 200 });
      },
    });

    await expect(client.getIssue('linear-issue-1')).resolves.toEqual({
      id: 'linear-issue-1',
      identifier: 'DP-1',
      projectId: 'linear-project',
      teamId: 'linear-team',
      labels: ['shipgraph:queued'],
    });
    expect(requestUrl).toBe('https://api.linear.app/graphql');
    expect(requestInit?.method).toBe('POST');
    expect(requestInit?.headers).toMatchObject({ authorization: 'linear-test-key' });
    expect(String(requestInit?.body)).toContain('ShipGraphDispatchIssue');
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it('bounds live issue lookup before admission can wait indefinitely', async () => {
    let signal: AbortSignal | null | undefined;
    const client = createLinearDispatchClient({
      apiKey: 'linear-test-key',
      fetch: async (_url, init) => {
        signal = init?.signal;
        return new Response(JSON.stringify({ data: { issue: null } }), { status: 200 });
      },
    });

    await expect(client.getIssue('linear-issue-1')).resolves.toBeUndefined();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(LINEAR_DISPATCH_API_TIMEOUT_MS).toBeLessThan(5_000);
  });

  it('fails closed on malformed provider responses and GraphQL errors', async () => {
    const malformed = createLinearDispatchClient({
      apiKey: 'linear-test-key',
      fetch: async () => new Response(JSON.stringify({ data: { issue: { id: 'only-id' } } }), { status: 200 }),
    });
    await expect(malformed.getIssue('linear-issue-1')).rejects.toThrow(/unsupported response/);

    const graphqlError = createLinearDispatchClient({
      apiKey: 'linear-test-key',
      fetch: async () => new Response(JSON.stringify({
        data: { issue: null },
        errors: [{ message: 'not authorized' }],
      }), { status: 200 }),
    });
    await expect(graphqlError.getIssue('linear-issue-1')).rejects.toThrow(/unsupported response/);
  });
});
