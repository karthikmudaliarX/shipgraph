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

export interface GitHostAdapter {
  readonly type: GitHostType;

  /**
   * Probe whether the git-host CLI is available and authenticated.
   */
  probe(): Promise<GitHostProbeResult> | GitHostProbeResult;
}

/**
 * Factory to create a git-host adapter by type.
 */
export function createGitHostAdapter(_type: GitHostType): GitHostAdapter {
  // Placeholder: real adapters are implemented in GH-001.
  throw new Error('Git host adapters are not implemented in CORE-001');
}
