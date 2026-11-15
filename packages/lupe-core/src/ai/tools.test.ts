import { Effect } from 'effect';
import { describe, expect, test } from 'vitest';

import type { RepoSourceService } from '../ports';
import { READ_FILE_MAX_LINES } from './read-file-window';
import { buildRepoTools } from './tools';

function repoReturning(contents: string): RepoSourceService {
  return {
    acquireDiff: () => Effect.succeed([]),
    readFile: () => Effect.succeed(contents),
    listDir: () => Effect.succeed([]),
    grep: () => Effect.succeed([]),
  };
}

async function readFile(contents: string, input: { path: string; offset?: number; limit?: number }): Promise<string> {
  const execute = buildRepoTools(repoReturning(contents)).readFile?.execute;
  if (!execute) throw new Error('readFile tool has no execute');
  const text = await execute(input, {
    toolCallId: 'call',
    messages: [],
    abortSignal: new AbortController().signal,
  });
  return typeof text === 'string' ? text : String(text);
}

describe('readFile tool', () => {
  test('truncates a large file and tells the model the next offset', async () => {
    const contents = Array.from({ length: READ_FILE_MAX_LINES + 10 }, (_, i) => `row ${i + 1}`).join('\n');
    const text = await readFile(contents, { path: 'src/huge.ts' });
    expect(text).toContain('truncated src/huge.ts');
    expect(text).toContain(`offset=${READ_FILE_MAX_LINES + 1}`);
    expect(text).not.toContain(`row ${READ_FILE_MAX_LINES + 2}`);
  });

  test('passes offset and limit through to the window', async () => {
    const contents = ['one', 'two', 'three', 'four'].join('\n');
    const text = await readFile(contents, { path: 'src/a.ts', offset: 2, limit: 1 });
    expect(text.startsWith('two\n')).toBe(true);
    expect(text).toContain('showed lines 2-2 of 4');
    expect(text).toContain('offset=3');
  });
});
