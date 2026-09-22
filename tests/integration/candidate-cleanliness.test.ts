import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGitRunner,
  isCandidateClean,
  isStrictlyClean,
} from '../../src/git/service.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const runner = createGitRunner();

function setupRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shipgraph-candidate-clean-'));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'candidate@example.com');
  git(dir, 'config', 'user.name', 'Candidate Cleanliness Test');
  writeFileSync(join(dir, 'tracked.txt'), 'tracked\n');
  writeFileSync(
    join(dir, '.gitignore'),
    ['.next/', 'node_modules/', 'next-env.d.ts', 'coverage/'].join('\n') + '\n'
  );
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'initial');
  return dir;
}

function ignoredArtifacts(dir: string): void {
  writeFileSync(join(dir, 'next-env.d.ts'), '/// <reference types="next" />\n');
  mkdirSync(join(dir, '.next'), { recursive: true });
  writeFileSync(join(dir, '.next', 'build-manifest.json'), '{}\n');
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};\n');
  mkdirSync(join(dir, 'coverage'), { recursive: true });
  writeFileSync(join(dir, 'coverage', 'lcov.info'), 'TN:\n');
}

describe('candidate cleanliness predicate', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('passes a clean committed candidate', async () => {
    dir = setupRepo();
    expect(await isCandidateClean(runner, dir)).toBe(true);
  });

  it('allows genuinely ignored artifacts that destructive strictness rejects', async () => {
    dir = setupRepo();
    ignoredArtifacts(dir);

    // The candidate is committed work; ignored build output must not block it.
    expect(await isCandidateClean(runner, dir)).toBe(true);
    // Destructive removal safety is unchanged: ignored content still blocks.
    expect(await isStrictlyClean(runner, dir)).toBe(false);
  });

  it('fails closed on a modified tracked file', async () => {
    dir = setupRepo();
    writeFileSync(join(dir, 'tracked.txt'), 'modified\n');
    expect(await isCandidateClean(runner, dir)).toBe(false);
  });

  it('fails closed on a staged tracked change', async () => {
    dir = setupRepo();
    writeFileSync(join(dir, 'tracked.txt'), 'staged\n');
    git(dir, 'add', 'tracked.txt');
    expect(await isCandidateClean(runner, dir)).toBe(false);
  });

  it('fails closed on an ordinary non-ignored untracked file', async () => {
    dir = setupRepo();
    writeFileSync(join(dir, 'notes.txt'), 'untracked\n');
    expect(await isCandidateClean(runner, dir)).toBe(false);
  });

  it('fails closed on an assume-unchanged tracked file', async () => {
    dir = setupRepo();
    git(dir, 'update-index', '--assume-unchanged', 'tracked.txt');
    writeFileSync(join(dir, 'tracked.txt'), 'hidden local edit\n');
    expect(await isCandidateClean(runner, dir)).toBe(false);
  });

  it('fails closed on a skip-worktree tracked file', async () => {
    dir = setupRepo();
    git(dir, 'update-index', '--skip-worktree', 'tracked.txt');
    writeFileSync(join(dir, 'tracked.txt'), 'hidden local edit\n');
    expect(await isCandidateClean(runner, dir)).toBe(false);
  });

  it('fails closed when Git inspection fails', async () => {
    const nonRepository = mkdtempSync(join(tmpdir(), 'shipgraph-candidate-nonrepo-'));
    try {
      expect(await isCandidateClean(runner, nonRepository)).toBe(false);
    } finally {
      rmSync(nonRepository, { recursive: true, force: true });
    }
  });
});
