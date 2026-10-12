import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { Effect } from 'effect';
import { simpleGit, type SimpleGit } from 'simple-git';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import type { RepoSourceService } from '@gigadrive/lupe-core';

import { makeRepoSource } from './repo-source';

let dir: string;
let repo: RepoSourceService;

beforeAll(async () => {
  dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'lupe-git-'));
  const git: SimpleGit = simpleGit({ baseDir: dir });
  await git.init();
  await git.addConfig('user.email', 'test@lupe.dev');
  await git.addConfig('user.name', 'lupe test');
  await git.addConfig('commit.gpgsign', 'false');
  await fs.mkdir(nodePath.join(dir, 'src'), { recursive: true });
  await fs.writeFile(nodePath.join(dir, 'src', 'a.ts'), 'export const x = 1\n');
  await git.add('.');
  await git.commit('init');
  // Stage a modification so `git diff HEAD` surfaces it.
  await fs.writeFile(nodePath.join(dir, 'src', 'a.ts'), 'export const x = 2\nexport const y = 3\n');
  await git.add('.');
  repo = makeRepoSource({ rootDir: dir });
}, 30_000);

afterAll(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe('RepoSource against a real git repo', () => {
  test('acquireDiff returns the modified file', async () => {
    const files = await Effect.runPromise(repo.acquireDiff({ kind: 'local' }));
    const a = files.find((f) => f.path === 'src/a.ts');
    expect(a).toBeDefined();
    expect(a!.status).toBe('modified');
    expect(a!.additions).toBeGreaterThan(0);
  });

  test('readFile reads head-checkout contents', async () => {
    const contents = await Effect.runPromise(repo.readFile('src/a.ts'));
    expect(contents).toContain('export const y = 3');
  });

  test('listDir lists entries with directory markers', async () => {
    const entries = await Effect.runPromise(repo.listDir('.'));
    expect(entries).toContain('src/');
  });

  test('grep finds matches and degrades to [] on no match', async () => {
    const hits = await Effect.runPromise(repo.grep('export const y'));
    expect(hits.some((l) => l.includes('src/a.ts'))).toBe(true);
    const none = await Effect.runPromise(repo.grep('zzz_no_such_symbol_zzz'));
    expect(none).toEqual([]);
  });

  test('acquireDiff accepts a three-dot base...head range', async () => {
    const git = simpleGit({ baseDir: dir });
    await git.commit('modify a');
    const base = (await git.revparse(['HEAD~1'])).trim();
    const head = (await git.revparse(['HEAD'])).trim();
    const files = await Effect.runPromise(repo.acquireDiff({ kind: 'local', baseSha: base, headSha: head }));
    const a = files.find((f) => f.path === 'src/a.ts');
    expect(a?.status).toBe('modified');
    expect(a?.additions).toBeGreaterThan(0);
  });
});
