import { describe, expect, test } from 'vitest';

import { READ_FILE_MAX_BYTES, READ_FILE_MAX_LINES, windowFileText } from './read-file-window';

describe('windowFileText', () => {
  test('returns a small file unchanged', () => {
    expect(windowFileText('alpha\nbeta\n', 'src/a.ts')).toBe('alpha\nbeta\n');
  });

  test('honors offset and limit and says how to continue', () => {
    const contents = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const text = windowFileText(contents, 'src/a.ts', { offset: 2, limit: 2 });
    expect(text.startsWith('b\nc\n')).toBe(true);
    expect(text).toContain('truncated src/a.ts');
    expect(text).toContain('showed lines 2-3 of 5');
    expect(text).toContain('offset=4');
  });

  test('caps lines and reports the next offset', () => {
    const contents = Array.from({ length: READ_FILE_MAX_LINES + 25 }, (_, i) => `L${i + 1}`).join('\n');
    const text = windowFileText(contents, 'src/big.ts');
    expect(text).toContain(`L${READ_FILE_MAX_LINES}`);
    expect(text).not.toContain(`L${READ_FILE_MAX_LINES + 1}\n`);
    expect(text).toContain(`showed lines 1-${READ_FILE_MAX_LINES} of ${READ_FILE_MAX_LINES + 25}`);
    expect(text).toContain(`offset=${READ_FILE_MAX_LINES + 1}`);
  });

  test('caps bytes on a single oversized line', () => {
    const contents = 'x'.repeat(READ_FILE_MAX_BYTES + 500);
    const text = windowFileText(contents, 'src/wide.ts');
    expect(text).toContain('truncated src/wide.ts');
    expect(text).toContain(`Byte cap is ${READ_FILE_MAX_BYTES}`);
    const body = text.split('\n')[0] ?? '';
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(READ_FILE_MAX_BYTES);
  });

  test('reports an offset past the end', () => {
    expect(windowFileText('only\n', 'src/a.ts', { offset: 9 })).toContain('offset 9 is past the end');
  });
});
