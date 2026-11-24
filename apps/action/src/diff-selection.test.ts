import { describe, expect, test } from 'vitest';

import { formatDiffSelectionLog, type DiffSelection } from './diff-selection';

describe('formatDiffSelectionLog (the run log names the diff actually reviewed)', () => {
  test('incremental: the since sha and the file count', () => {
    const selection: DiffSelection = { kind: 'incremental', sinceSha: 'abc1234567890', fileCount: 3 };
    expect(formatDiffSelectionLog(selection)).toBe('lupe: incremental review since abc1234 (3 files).');
  });

  test('full diff fallback: the reason and the file count', () => {
    const selection: DiffSelection = {
      kind: 'full',
      reason: 'incremental compare not fast-forward (status: diverged)',
      fileCount: 12,
    };
    expect(formatDiffSelectionLog(selection)).toBe(
      'lupe: full diff review (12 files): incremental compare not fast-forward (status: diverged).'
    );
  });

  test('never prints "incremental review since" for a full diff fallback', () => {
    const selection: DiffSelection = {
      kind: 'full',
      reason: 'incremental compare exceeds the 300-file compare limit; falling back to the full diff',
      fileCount: 301,
    };
    const log = formatDiffSelectionLog(selection);
    expect(log).toContain('300-file compare limit');
    expect(log).toContain('301 files');
    expect(log).not.toContain('incremental review since');
  });

  test('first review stays silent', () => {
    const selection: DiffSelection = { kind: 'full', reason: undefined, fileCount: 5 };
    expect(formatDiffSelectionLog(selection)).toBeUndefined();
  });
});
