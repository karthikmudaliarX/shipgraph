import { describe, expect, it } from 'vitest';
import {
  inspectCommittedChange,
  pathInScope,
  type PathScope,
} from '../../src/git/path-authorization.js';
import type { GitCommandResult, GitRunner } from '../../src/git/service.js';

function scope(allowedPaths: readonly string[], forbiddenPaths: readonly string[] = []): PathScope {
  return { allowedPaths, forbiddenPaths };
}

function result(overrides: Partial<GitCommandResult> = {}): GitCommandResult {
  return { exitCode: 0, stdout: '', stderr: '', ...overrides };
}

/**
 * A deterministic Git stub: only `merge-base` and `diff` are exercised by the
 * shared committed-change inspection.
 */
function stubRunner(options: {
  ancestry?: number;
  diff?: GitCommandResult;
}): GitRunner {
  return async (_cwd, args) => {
    if (args[0] === 'merge-base') return result({ exitCode: options.ancestry ?? 0 });
    if (args[0] === 'diff') return options.diff ?? result();
    return result({ exitCode: 1, stderr: `unexpected git command: ${args.join(' ')}` });
  };
}

function changed(...paths: string[]): GitCommandResult {
  return result({ stdout: paths.map((path) => `${path}\0`).join('') });
}

describe('shared path-scope grammar', () => {
  it('matches an exact path only, never as a directory prefix', () => {
    expect(pathInScope('src/index.ts', 'src/index.ts')).toBe(true);
    expect(pathInScope('src/index.ts.bak', 'src/index.ts')).toBe(false);
    expect(pathInScope('src/index.ts/nested', 'src/index.ts')).toBe(false);
  });

  it('matches directory/** as the directory and everything beneath it', () => {
    expect(pathInScope('src', 'src/**')).toBe(true);
    expect(pathInScope('src/index.ts', 'src/**')).toBe(true);
    expect(pathInScope('src/nested/deep.ts', 'src/**')).toBe(true);
    expect(pathInScope('srcother/index.ts', 'src/**')).toBe(false);
  });

  it('fails closed on unsupported wildcard forms', () => {
    expect(pathInScope('src/index.ts', 'src/*.ts')).toBe(false);
    expect(pathInScope('anything', '**')).toBe(false);
  });
});

describe('shared committed-change authorization', () => {
  it('authorizes an exact allowed changed path', async () => {
    const inspection = await inspectCommittedChange(
      stubRunner({ diff: changed('src/index.ts') }),
      '/worktree',
      'a'.repeat(40),
      'b'.repeat(40),
      scope(['src/index.ts'])
    );
    expect(inspection).toEqual({ status: 'authorized', changedPaths: ['src/index.ts'] });
  });

  it('authorizes changed paths under an allowed directory glob', async () => {
    const inspection = await inspectCommittedChange(
      stubRunner({ diff: changed('src/a.ts', 'src/nested/b.ts') }),
      '/worktree',
      'a'.repeat(40),
      'b'.repeat(40),
      scope(['src/**'])
    );
    expect(inspection).toEqual({
      status: 'authorized',
      changedPaths: ['src/a.ts', 'src/nested/b.ts'],
    });
  });

  it('rejects a changed path outside a non-empty allowedPaths', async () => {
    const inspection = await inspectCommittedChange(
      stubRunner({ diff: changed('README.md') }),
      '/worktree',
      'a'.repeat(40),
      'b'.repeat(40),
      scope(['src/**'])
    );
    expect(inspection).toEqual({ status: 'outside', path: 'README.md' });
  });

  it('rejects a forbidden changed path even when it is also allowed', async () => {
    const inspection = await inspectCommittedChange(
      stubRunner({ diff: changed('secrets/token.txt') }),
      '/worktree',
      'a'.repeat(40),
      'b'.repeat(40),
      scope(['secrets/**'], ['secrets/**'])
    );
    expect(inspection).toEqual({ status: 'forbidden', path: 'secrets/token.txt' });
  });

  it('preserves the existing meaning of empty allowedPaths as no allowlist restriction', async () => {
    const inspection = await inspectCommittedChange(
      stubRunner({ diff: changed('anywhere/file.ts') }),
      '/worktree',
      'a'.repeat(40),
      'b'.repeat(40),
      scope([])
    );
    expect(inspection).toEqual({ status: 'authorized', changedPaths: ['anywhere/file.ts'] });
  });

  it('still rejects forbidden paths when allowedPaths is empty', async () => {
    const inspection = await inspectCommittedChange(
      stubRunner({ diff: changed('secrets/token.txt') }),
      '/worktree',
      'a'.repeat(40),
      'b'.repeat(40),
      scope([], ['secrets/**'])
    );
    expect(inspection).toEqual({ status: 'forbidden', path: 'secrets/token.txt' });
  });

  it('fails closed when the candidate does not descend from the base', async () => {
    const inspection = await inspectCommittedChange(
      stubRunner({ ancestry: 1, diff: changed('src/index.ts') }),
      '/worktree',
      'a'.repeat(40),
      'b'.repeat(40),
      scope(['src/**'])
    );
    expect(inspection).toEqual({ status: 'not-descendant' });
  });

  it('fails closed when the committed diff cannot be proven', async () => {
    const inspection = await inspectCommittedChange(
      stubRunner({ diff: result({ exitCode: 128, stderr: 'bad revision' }) }),
      '/worktree',
      'a'.repeat(40),
      'b'.repeat(40),
      scope(['src/**'])
    );
    expect(inspection).toEqual({ status: 'diff-unavailable', detail: 'bad revision' });
  });

  it('reports an empty committed change as authorized with no paths', async () => {
    const inspection = await inspectCommittedChange(
      stubRunner({ diff: result({ stdout: '' }) }),
      '/worktree',
      'a'.repeat(40),
      'b'.repeat(40),
      scope(['src/**'])
    );
    expect(inspection).toEqual({ status: 'authorized', changedPaths: [] });
  });
});
