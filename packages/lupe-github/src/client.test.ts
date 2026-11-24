import { describe, expect, test } from 'vitest';

import type { AnchoredComment } from '@gigadrive/lupe-core';
import { INLINE_MARKER, renderInlineComment, SUMMARY_MARKER, type Finding } from '@gigadrive/lupe-core';

import {
  compareToDiffFiles,
  paginateCompare,
  selectBotSticky,
  shouldResolveThread,
  toReviewComment,
  type CompareResult,
  type StickyCandidate,
} from './client';

function page(n: number, status = 'ahead'): CompareResult {
  // n files, each named f{i}.ts
  return { status, files: Array.from({ length: n }, (_, i) => ({ filename: `f${i}.ts`, status: 'modified' })) };
}

describe('toReviewComment', () => {
  test('maps a single-line anchor to line+side (no start_line)', () => {
    const c: AnchoredComment = { anchor: { path: 'a.ts', line: 10, side: 'RIGHT' }, body: 'issue' };
    expect(toReviewComment(c)).toEqual({ path: 'a.ts', body: 'issue', line: 10, side: 'RIGHT' });
  });

  test('maps a multi-line anchor to start_line/start_side + line/side', () => {
    const c: AnchoredComment = {
      anchor: { path: 'a.ts', line: 12, side: 'RIGHT', startLine: 10, startSide: 'RIGHT' },
      body: 'range issue',
    };
    expect(toReviewComment(c)).toEqual({
      path: 'a.ts',
      body: 'range issue',
      line: 12,
      side: 'RIGHT',
      start_line: 10,
      start_side: 'RIGHT',
    });
  });

  test('defaults start_side to side when omitted', () => {
    const c: AnchoredComment = {
      anchor: { path: 'a.ts', line: 5, side: 'LEFT', startLine: 3 },
      body: 'x',
    };
    expect(toReviewComment(c).start_side).toBe('LEFT');
  });
});

describe('compareToDiffFiles (incremental review)', () => {
  test('maps files on a clean fast-forward ("ahead")', () => {
    const files = compareToDiffFiles({
      status: 'ahead',
      files: [{ filename: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }],
    });
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('a.ts');
  });

  test('returns an empty set when ahead with no files', () => {
    expect(compareToDiffFiles({ status: 'ahead', files: [] })).toEqual([]);
  });

  test('throws on a diverged comparison (rebase/force-push) so the caller falls back to the full diff', () => {
    expect(() => compareToDiffFiles({ status: 'diverged', files: [] })).toThrow(/not fast-forward/);
    expect(() => compareToDiffFiles({ status: 'behind', files: [] })).toThrow(/not fast-forward/);
  });

  test('throws when files are absent', () => {
    expect(() => compareToDiffFiles({ status: 'ahead' })).toThrow(/not fast-forward/);
  });
});

describe('paginateCompare (incremental compare pagination)', () => {
  test('stops on the first short page (single page under the limit)', async () => {
    const fetched: number[] = [];
    const data = await paginateCompare((p) => {
      fetched.push(p);
      return Promise.resolve(page(42));
    });
    expect(fetched).toEqual([1]);
    expect(data.files).toHaveLength(42);
    expect(data.status).toBe('ahead');
  });

  test('concatenates a full page + a short page and preserves page-1 status', async () => {
    const pages: Record<number, CompareResult> = { 1: page(100), 2: page(30) };
    const fetched: number[] = [];
    const data = await paginateCompare((p) => {
      fetched.push(p);
      return Promise.resolve(pages[p]!);
    });
    expect(fetched).toEqual([1, 2]);
    expect(data.files).toHaveLength(130);
  });

  test('throws when the 3rd page is still full (>300 files) so the caller falls back to the full diff', async () => {
    await expect(paginateCompare(() => Promise.resolve(page(100)))).rejects.toThrow(/300-file/);
  });
});

describe('selectBotSticky (lupe-state marker is trusted only from the workflow bot)', () => {
  const bot = { login: 'github-actions[bot]', type: 'Bot' };
  const human = { login: 'someone', type: 'User' };
  const stickyBody = (sha: string) => `${SUMMARY_MARKER}\n<!-- lupe-state {"lastReviewedSha":"${sha}"} -->`;

  test('ignores a non-bot comment carrying the marker, even when posted before the bot sticky', () => {
    const comments: StickyCandidate[] = [
      { id: 1, body: stickyBody('aaa1111'), user: human },
      { id: 2, body: stickyBody('bbb2222'), user: bot },
    ];
    expect(selectBotSticky(comments)?.id).toBe(2);
  });

  test('returns undefined when only non-bot comments carry the marker (lupe runs a full review)', () => {
    const comments: StickyCandidate[] = [
      { id: 1, body: stickyBody('aaa1111'), user: human },
      { id: 3, body: stickyBody('ccc3333'), user: { login: 'another-bot', type: 'Bot' } },
    ];
    expect(selectBotSticky(comments)).toBeUndefined();
  });

  test('picks the earliest bot sticky when several exist', () => {
    const comments: StickyCandidate[] = [
      { id: 5, body: stickyBody('eee5555'), user: bot },
      { id: 9, body: stickyBody('9999999'), user: bot },
    ];
    expect(selectBotSticky(comments)?.id).toBe(5);
  });

  test('ignores a bot comment without the marker', () => {
    const comments: StickyCandidate[] = [
      { id: 1, body: 'just a status note', user: bot },
      { id: 2, body: stickyBody('bbb2222'), user: bot },
    ];
    expect(selectBotSticky(comments)?.id).toBe(2);
  });

  test('ignores a github-actions[bot] login whose user type is not Bot', () => {
    const comments: StickyCandidate[] = [
      { id: 1, body: stickyBody('aaa1111'), user: { login: 'github-actions[bot]', type: 'User' } },
      { id: 2, body: stickyBody('bbb2222'), user: bot },
    ];
    expect(selectBotSticky(comments)?.id).toBe(2);
  });

  test('returns undefined when no comment carries the marker', () => {
    expect(selectBotSticky([{ id: 1, body: 'hello', user: bot }])).toBeUndefined();
    expect(selectBotSticky([])).toBeUndefined();
  });
});

describe('shouldResolveThread (scoped resolution)', () => {
  function inlineBody(path: string): string {
    const f: Finding = {
      ruleId: 'lupe/correctness/x',
      title: 't',
      path,
      startLine: 1,
      endLine: 1,
      side: 'RIGHT',
      severity: 'high',
      category: 'correctness',
      message: 'm',
      confidence: 0.9,
      evidence: [],
    };
    return renderInlineComment(f);
  }

  test('ignores non-lupe threads', () => {
    expect(shouldResolveThread('just a human comment')).toBe(false);
    expect(shouldResolveThread('just a human comment', new Set(['a.ts']))).toBe(false);
  });

  test('resolves all lupe threads when no scope is given (full-diff run)', () => {
    expect(shouldResolveThread(inlineBody('a.ts'))).toBe(true);
  });

  test('with a scope, resolves only threads on reviewed files', () => {
    const reviewed = new Set(['a.ts']);
    expect(shouldResolveThread(inlineBody('a.ts'), reviewed)).toBe(true);
    expect(shouldResolveThread(inlineBody('untouched.ts'), reviewed)).toBe(false);
  });

  test('resolves lupe threads with no path marker (older comments) under a scope', () => {
    const legacy = `some finding text\n<sub>${INLINE_MARKER} · \`lupe/x/y\` · confidence 90%</sub>`;
    expect(shouldResolveThread(legacy, new Set(['a.ts']))).toBe(true);
  });
});
