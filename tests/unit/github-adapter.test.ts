import { describe, expect, it } from 'vitest';
import { GitHubAdapter } from '../../src/adapters/git-host/github.js';
import type { ProcessResult, ProcessRunner } from '../../src/utils/process-runner.js';

function scripted(results: readonly ProcessResult[]): { runner: ProcessRunner; calls: string[][] } {
  const calls: string[][] = [];
  let index = 0;
  return {
    calls,
    runner: {
      run: async (_command, args = []) => {
        calls.push([...args]);
        return results[index++] ?? { command: 'gh', exitCode: 1, stdout: '', stderr: 'missing scripted result' };
      },
    },
  };
}

const pullRequest = {
  number: 7,
  url: 'https://github.com/owner/repo/pull/7',
  baseRefName: 'main',
  headRefName: 'shipgraph/kar-8',
  headRefOid: 'a'.repeat(40),
  state: 'OPEN',
  headRepository: { nameWithOwner: 'owner/repo' },
};

describe('GitHub git-host adapter', () => {
  it('scopes the auth probe to github.com and uses current gh CLI contracts', async () => {
    const scriptedCalls = scripted([
      { command: 'gh', exitCode: 0, stdout: 'logged in\n', stderr: '' },
      { command: 'gh', exitCode: 0, stdout: JSON.stringify([pullRequest]), stderr: '' },
      { command: 'gh', exitCode: 0, stdout: JSON.stringify(pullRequest), stderr: '' },
      { command: 'gh', exitCode: 0, stdout: JSON.stringify({ comments: [] }), stderr: '' },
      {
        command: 'gh',
        exitCode: 0,
        stdout: JSON.stringify({ id: 11, html_url: 'https://github.com/owner/repo/issues/7#issuecomment-11', body: 'receipt' }),
        stderr: '',
      },
    ]);
    const adapter = new GitHubAdapter({ processRunner: scriptedCalls.runner });

    await expect(adapter.probe()).resolves.toEqual({ available: true, authenticated: true });
    await expect(adapter.findPullRequests({ repository: 'owner/repo', headBranch: 'shipgraph/kar-8' }))
      .resolves.toHaveLength(1);
    await expect(adapter.inspectPullRequest({ repository: 'owner/repo', number: 7 }))
      .resolves.toMatchObject({ number: 7, headSha: 'a'.repeat(40) });
    await expect(adapter.listComments({ repository: 'owner/repo', number: 7 })).resolves.toEqual([]);
    await expect(adapter.postComment({ repository: 'owner/repo', number: 7, body: 'receipt' }))
      .resolves.toMatchObject({ id: '11', body: 'receipt' });

    expect(scriptedCalls.calls).toEqual([
      ['auth', 'status', '--active', '--hostname', 'github.com'],
      [
        'pr', 'list', '--repo', 'owner/repo', '--head', 'shipgraph/kar-8', '--state', 'all', '--limit', '100',
        '--json', 'number,url,baseRefName,headRefName,headRefOid,state,headRepository',
      ],
      [
        'pr', 'view', '7', '--repo', 'owner/repo',
        '--json', 'number,url,baseRefName,headRefName,headRefOid,state,headRepository',
      ],
      ['pr', 'view', '7', '--repo', 'owner/repo', '--json', 'comments'],
      [
        'api', 'repos/owner/repo/issues/7/comments', '--method', 'POST', '--raw-field', 'body=receipt',
      ],
    ]);
  });

  it('fails closed on unsupported PR identity output', async () => {
    const scriptedCalls = scripted([
      { command: 'gh', exitCode: 0, stdout: JSON.stringify([{ number: 7, state: 'OPEN' }]), stderr: '' },
    ]);
    const adapter = new GitHubAdapter({ processRunner: scriptedCalls.runner });
    await expect(adapter.findPullRequests({ repository: 'owner/repo', headBranch: 'shipgraph/kar-8' }))
      .rejects.toThrow(/unsupported identity fields/);
  });
});
