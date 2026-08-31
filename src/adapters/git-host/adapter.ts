/**
 * Contract for git-host adapters.
 *
 * The first future implementation will be GitHub (GH-001).
 * CORE-001 only defines the interface and probe contract.
 */
export type GitHostType = 'github' | 'gitlab';

export type GitHostProbeResult =
  | { available: true; authenticated?: boolean }
  | { available: false; reason: string };

export type GitHostPullRequestState = 'OPEN' | 'CLOSED' | 'MERGED';

export type GitHostPullRequest = {
  number: number;
  url: string;
  repository: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  state: GitHostPullRequestState;
};

export type GitHostComment = {
  id: string;
  url?: string;
  body: string;
};

export type GitHostPullRequestInput = {
  repository: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
};

export interface GitHostAdapter {
  readonly type: GitHostType;

  /**
   * Probe whether the git-host CLI is available and authenticated.
   */
  probe(): Promise<GitHostProbeResult> | GitHostProbeResult;

  findPullRequests(input: Pick<GitHostPullRequestInput, 'repository' | 'headBranch'>):
    Promise<readonly GitHostPullRequest[]>;

  createPullRequest(input: GitHostPullRequestInput): Promise<GitHostPullRequest>;

  inspectPullRequest(input: { repository: string; number: number }):
    Promise<GitHostPullRequest>;

  listComments(input: { repository: string; number: number }):
    Promise<readonly GitHostComment[]>;

  postComment(input: { repository: string; number: number; body: string }):
    Promise<GitHostComment>;
}
