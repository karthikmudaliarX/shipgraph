import type { ProcessRunner } from '../../utils/process-runner.js';
import { createProcessRunner } from '../../utils/process-runner.js';
import type {
  GitHostAdapter,
  GitHostComment,
  GitHostProbeResult,
  GitHostPullRequest,
  GitHostPullRequestInput,
} from './adapter.js';

export type GitHubAdapterOptions = {
  processRunner?: ProcessRunner;
  executable?: string;
};

/** GitHub implementation of the narrow KAR-8 git-host surface. */
export class GitHubAdapter implements GitHostAdapter {
  public readonly type = 'github' as const;
  private readonly runner: ProcessRunner;
  private readonly executable: string;

  public constructor(options: GitHubAdapterOptions = {}) {
    this.runner = options.processRunner ?? createProcessRunner();
    this.executable = options.executable ?? 'gh';
  }

  public async probe(): Promise<GitHostProbeResult> {
    const result = await this.runner.run(this.executable, ['auth', 'status', '--active', '--hostname', 'github.com']);
    if (result.exitCode !== 0) {
      return {
        available: false,
        reason: result.stderr.trim() || result.stdout.trim() || 'GitHub CLI is not authenticated',
      };
    }
    return { available: true, authenticated: true };
  }

  public async findPullRequests(
    input: Pick<GitHostPullRequestInput, 'repository' | 'headBranch'>
  ): Promise<readonly GitHostPullRequest[]> {
    const output = await this.runJson<unknown>([
      'pr',
      'list',
      '--repo',
      input.repository,
      '--head',
      input.headBranch,
      '--state',
      'all',
      '--limit',
      '100',
      '--json',
      'number,url,baseRefName,headRefName,headRefOid,state,headRepository',
    ]);
    if (!Array.isArray(output)) throw new Error('GitHub PR list returned a non-array response');
    return output.map((value) => this.parsePullRequest(value));
  }

  public async createPullRequest(input: GitHostPullRequestInput): Promise<GitHostPullRequest> {
    const result = await this.runner.run(this.executable, [
      'pr',
      'create',
      '--repo',
      input.repository,
      '--base',
      input.baseBranch,
      '--head',
      input.headBranch,
      '--title',
      input.title,
      '--body',
      input.body,
      '--no-maintainer-edit',
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`GitHub PR creation failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    const url = result.stdout.trim().split(/\s+/u).at(-1);
    if (url === undefined || !/^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/\d+$/u.test(url)) {
      throw new Error('GitHub PR creation did not return a recognizable PR URL');
    }
    const number = Number(url.split('/').at(-1));
    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new Error('GitHub PR creation returned an invalid PR number');
    }
    return this.inspectPullRequest({ repository: input.repository, number });
  }

  public async inspectPullRequest(input: { repository: string; number: number }): Promise<GitHostPullRequest> {
    const output = await this.runJson<unknown>([
      'pr',
      'view',
      String(input.number),
      '--repo',
      input.repository,
      '--json',
      'number,url,baseRefName,headRefName,headRefOid,state,headRepository',
    ]);
    return this.parsePullRequest(output);
  }

  public async listComments(input: { repository: string; number: number }): Promise<readonly GitHostComment[]> {
    const output = await this.runJson<unknown>([
      'pr',
      'view',
      String(input.number),
      '--repo',
      input.repository,
      '--json',
      'comments',
    ]);
    const comments = isRecord(output) ? output.comments : output;
    if (!Array.isArray(comments)) throw new Error('GitHub PR comments returned a non-array response');
    return comments.map((value) => {
      if (!isRecord(value) || typeof value.body !== 'string') {
        throw new Error('GitHub PR comments contain an unsupported comment shape');
      }
      const id = typeof value.databaseId === 'number'
        ? String(value.databaseId)
        : typeof value.id === 'string'
          ? value.id
          : undefined;
      if (id === undefined || id.length === 0) {
        throw new Error('GitHub PR comment is missing a stable identity');
      }
      return {
        id,
        ...(typeof value.url === 'string' ? { url: value.url } : {}),
        body: value.body,
      } satisfies GitHostComment;
    });
  }

  public async postComment(input: { repository: string; number: number; body: string }): Promise<GitHostComment> {
    const output = await this.runJson<unknown>([
      'api',
      `repos/${input.repository}/issues/${input.number}/comments`,
      '--method',
      'POST',
      '--raw-field',
      `body=${input.body}`,
    ]);
    if (!isRecord(output) || typeof output.body !== 'string') {
      throw new Error('GitHub comment creation returned an unsupported response');
    }
    const id = typeof output.id === 'number'
      ? String(output.id)
      : typeof output.node_id === 'string'
        ? output.node_id
        : undefined;
    if (id === undefined || id.length === 0) {
      throw new Error('GitHub comment creation returned no stable identity');
    }
    return {
      id,
      ...(typeof output.html_url === 'string' ? { url: output.html_url } : {}),
      body: output.body,
    } satisfies GitHostComment;
  }

  private async runJson<T>(args: readonly string[]): Promise<T> {
    const result = await this.runner.run(this.executable, args);
    if (result.exitCode !== 0) {
      throw new Error(`GitHub CLI command failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    try {
      return JSON.parse(result.stdout) as T;
    } catch (error) {
      throw new Error(`GitHub CLI returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private parsePullRequest(value: unknown): GitHostPullRequest {
    if (!isRecord(value)) throw new Error('GitHub PR response contains a non-object');
    const repositoryValue = value.headRepository;
    const repository = isRecord(repositoryValue) && typeof repositoryValue.nameWithOwner === 'string'
      ? repositoryValue.nameWithOwner
      : undefined;
    if (
      repository === undefined ||
      typeof value.number !== 'number' || !Number.isSafeInteger(value.number) || value.number <= 0 ||
      typeof value.url !== 'string' ||
      typeof value.baseRefName !== 'string' ||
      typeof value.headRefName !== 'string' ||
      typeof value.headRefOid !== 'string' || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u.test(value.headRefOid) ||
      (value.state !== 'OPEN' && value.state !== 'CLOSED' && value.state !== 'MERGED')
    ) {
      throw new Error('GitHub PR response contains unsupported identity fields');
    }
    return {
      number: value.number,
      url: value.url,
      repository,
      baseBranch: value.baseRefName,
      headBranch: value.headRefName,
      headSha: value.headRefOid,
      state: value.state,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
