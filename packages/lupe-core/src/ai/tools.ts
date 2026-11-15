import { tool, type ToolSet } from 'ai';
import { Effect } from 'effect';
import { z } from 'zod';

import type { RepoSourceService } from '../ports';
import { READ_FILE_MAX_BYTES, READ_FILE_MAX_LINES, windowFileText } from './read-file-window';

/**
 * Read-only repo tools the review agent may call during generation. Each tool
 * runs the corresponding RepoSource Effect and degrades gracefully (returns a
 * marker string instead of throwing) so a failed read never aborts the loop.
 */
export function buildRepoTools(repo: RepoSourceService): ToolSet {
  return {
    readFile: tool({
      description:
        `Read a file at the head revision. Pass a 1-based offset and limit to read a line range. ` +
        `Each call returns at most ${READ_FILE_MAX_LINES} lines and ${READ_FILE_MAX_BYTES} bytes and says when it truncated.`,
      inputSchema: z.object({
        path: z.string().describe('Repository-relative file path'),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('1-based line to start at. Omit to start at the first line.'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Maximum lines to return (hard cap ${READ_FILE_MAX_LINES}).`),
      }),
      execute: ({ path, offset, limit }) =>
        Effect.runPromise(
          repo.readFile(path).pipe(
            Effect.map((contents) => windowFileText(contents, path, { offset, limit })),
            Effect.catchAll(() => Effect.succeed(`<error: could not read ${path}>`))
          )
        ),
    }),
    listDir: tool({
      description: "List entries of a directory (non-recursive). Directory names end with '/'.",
      inputSchema: z.object({ path: z.string().describe('Repository-relative directory path') }),
      execute: ({ path }) =>
        Effect.runPromise(repo.listDir(path).pipe(Effect.catchAll(() => Effect.succeed<readonly string[]>([])))),
    }),
    grep: tool({
      description:
        "Search the repository for an extended POSIX regex. Returns 'path:line:text' matches. Use to find callers, definitions, and related code outside the diff.",
      inputSchema: z.object({
        pattern: z.string().describe('Extended regex'),
        glob: z.string().optional().describe('Optional pathspec to scope the search'),
        maxResults: z.number().int().positive().max(200).optional(),
      }),
      execute: ({ pattern, glob, maxResults }) =>
        Effect.runPromise(
          repo
            .grep(pattern, { glob, maxResults: maxResults ?? 50 })
            .pipe(Effect.catchAll(() => Effect.succeed<readonly string[]>([])))
        ),
    }),
  };
}
