import { Effect, Layer } from 'effect';

import {
  GitHubClient,
  GitHubError,
  INLINE_MARKER,
  parseInlinePath,
  parseState,
  SUMMARY_MARKER,
  type AnchoredComment,
  type DiffFile,
  type GitHubClientService,
  type LinkedIssue,
  type LupeReviewState,
  type PostReviewInput,
  type PullRequestRef,
} from '@gigadrive/lupe-core';
import { buildDiffFile } from '@gigadrive/lupe-git';

import { createOctokit, type LupeOctokit, type OctokitConfig } from './octokit';

/** Map an anchored comment to a GitHub review-comment payload (line/side/start_line). */
export function toReviewComment(c: AnchoredComment): {
  path: string;
  body: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
} {
  return {
    path: c.anchor.path,
    body: c.body,
    line: c.anchor.line,
    side: c.anchor.side,
    ...(c.anchor.startLine !== undefined
      ? { start_line: c.anchor.startLine, start_side: c.anchor.startSide ?? c.anchor.side }
      : {}),
  };
}

function toGitHubError(cause: unknown): GitHubError {
  const status = (cause as { status?: number } | null)?.status;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new GitHubError({ message, status, cause });
}

/** The `compareCommitsWithBasehead` fields we depend on (narrowed for testability). */
export interface CompareResult {
  readonly status: string;
  readonly files?: ReadonlyArray<{
    readonly filename: string;
    readonly previous_filename?: string | null;
    readonly status: string;
    readonly patch?: string;
  }>;
}

/**
 * Walk the paginated compare endpoint, accumulating `files` across pages until a
 * short page (fewer than `per_page`). Status is taken from page 1. GitHub caps
 * the compare endpoint at 300 files over 3 pages — if the 3rd page is still full,
 * more files exist than the compare API can return, so we throw and let the
 * caller fall back to the fully-paginated `listFiles`. (The single-call version
 * silently saw only the first 100 files.)
 */
export async function paginateCompare(fetchPage: (page: number) => Promise<CompareResult>): Promise<CompareResult> {
  const PER_PAGE = 100;
  const MAX_PAGES = 3;
  const files: Array<NonNullable<CompareResult['files']>[number]> = [];
  let status = '';
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await fetchPage(page);
    if (page === 1) status = data.status;
    const pageFiles = data.files ?? [];
    files.push(...pageFiles);
    if (pageFiles.length < PER_PAGE) return { status, files };
  }
  throw new Error('incremental compare exceeds the 300-file compare limit; falling back to the full diff');
}

/**
 * Map a compare result to DiffFiles, trusting it ONLY when it is a clean
 * fast-forward ("ahead"). Throws otherwise so the incremental caller falls back
 * to the full diff — a rebase/force-push yields "diverged"/"behind".
 */
export function compareToDiffFiles(data: CompareResult): DiffFile[] {
  if (data.status !== 'ahead' || !data.files) {
    throw new Error(`incremental compare not fast-forward (status: ${data.status})`);
  }
  return data.files.map((f) =>
    buildDiffFile({
      filename: f.filename,
      previousFilename: f.previous_filename ?? undefined,
      status: f.status,
      patch: f.patch,
    })
  );
}

const THREADS_QUERY = `query($owner:String!,$repo:String!,$num:Int!,$cursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$num){
      reviewThreads(first:100, after:$cursor){
        nodes{ id isResolved comments(first:1){ nodes{ body } } }
        pageInfo{ hasNextPage endCursor }
      }
    }
  }
}`;

const RESOLVE_MUTATION = `mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ id } } }`;

interface ThreadsResponse {
  readonly repository: {
    readonly pullRequest: {
      readonly reviewThreads: {
        readonly nodes: ReadonlyArray<{
          readonly id: string;
          readonly isResolved: boolean;
          readonly comments: { readonly nodes: ReadonlyArray<{ readonly body: string }> };
        }>;
        readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
      };
    };
  };
}

/**
 * Whether a lupe-authored thread (identified by its first comment `body`) should
 * be resolved on this run. With `reviewedPaths`, only threads on a reviewed file
 * are resolved; threads whose path can't be determined (older comments) resolve
 * as before. Without `reviewedPaths`, every lupe thread resolves (full-diff run).
 */
export function shouldResolveThread(body: string, reviewedPaths?: ReadonlySet<string>): boolean {
  if (!body.includes(INLINE_MARKER)) return false;
  if (!reviewedPaths) return true;
  const path = parseInlinePath(body);
  return path === undefined || reviewedPaths.has(path);
}

async function resolveLupeThreads(
  octokit: LupeOctokit,
  pr: PullRequestRef,
  reviewedPaths?: ReadonlySet<string>
): Promise<void> {
  let cursor: string | null = null;
  for (;;) {
    const data = (await octokit.graphql(THREADS_QUERY, {
      owner: pr.owner,
      repo: pr.repo,
      num: pr.number,
      cursor,
    })) as ThreadsResponse;
    const threads = data.repository.pullRequest.reviewThreads;
    for (const thread of threads.nodes) {
      const body = thread.comments.nodes[0]?.body ?? '';
      if (thread.isResolved || !shouldResolveThread(body, reviewedPaths)) continue;
      await octokit.graphql(RESOLVE_MUTATION, { id: thread.id }).catch(() => undefined);
    }
    if (!threads.pageInfo.hasNextPage || !threads.pageInfo.endCursor) break;
    cursor = threads.pageInfo.endCursor;
  }
}

/** Minimal shape of an issue comment for sticky selection (narrowed for testability). */
export interface StickyCandidate {
  readonly id: number;
  readonly body?: string | null;
  readonly user?: { readonly login?: string; readonly type?: string } | null;
}

/**
 * Pick lupe's sticky summary from the PR comments: the earliest comment carrying
 * the summary marker from the workflow's bot account (github-actions[bot], user
 * type Bot). Comments from any other author are ignored, so a hand-typed comment
 * carrying the marker can never supply lupe's review state.
 */
export function selectBotSticky(comments: readonly StickyCandidate[]): { id: number; body: string } | undefined {
  const sticky = comments.find(
    (c) => (c.body ?? '').includes(SUMMARY_MARKER) && c.user?.login === 'github-actions[bot]' && c.user?.type === 'Bot'
  );
  return sticky ? { id: sticky.id, body: sticky.body ?? '' } : undefined;
}

async function findSticky(octokit: LupeOctokit, pr: PullRequestRef): Promise<{ id: number; body: string } | undefined> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: pr.owner,
    repo: pr.repo,
    issue_number: pr.number,
    per_page: 100,
  });
  return selectBotSticky(comments);
}

export function makeGitHubClient(config: OctokitConfig): GitHubClientService {
  const octokit = createOctokit(config);

  const listDiff = (pr: PullRequestRef): Effect.Effect<readonly DiffFile[], GitHubError> =>
    Effect.tryPromise({
      try: async () => {
        const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
          owner: pr.owner,
          repo: pr.repo,
          pull_number: pr.number,
          per_page: 100,
        });
        return files.map((f) =>
          buildDiffFile({
            filename: f.filename,
            previousFilename: f.previous_filename ?? undefined,
            status: f.status,
            patch: f.patch,
          })
        );
      },
      catch: toGitHubError,
    });

  const listDiffSince = (
    pr: PullRequestRef,
    baseSha: string,
    headSha: string
  ): Effect.Effect<readonly DiffFile[], GitHubError> =>
    Effect.tryPromise({
      try: async () => {
        const data = await paginateCompare((page) =>
          octokit.rest.repos
            .compareCommitsWithBasehead({
              owner: pr.owner,
              repo: pr.repo,
              basehead: `${baseSha}...${headSha}`,
              per_page: 100,
              page,
            })
            .then((r) => r.data)
        );
        return compareToDiffFiles(data);
      },
      catch: toGitHubError,
    });

  const getLastReviewedSha = (pr: PullRequestRef): Effect.Effect<string | undefined, GitHubError> =>
    Effect.tryPromise({
      try: async () => {
        const sticky = await findSticky(octokit, pr);
        return sticky ? parseState(sticky.body)?.lastReviewedSha : undefined;
      },
      catch: toGitHubError,
    });

  const getReviewState = (pr: PullRequestRef): Effect.Effect<LupeReviewState | undefined, GitHubError> =>
    Effect.tryPromise({
      try: async () => {
        const sticky = await findSticky(octokit, pr);
        return sticky ? parseState(sticky.body) : undefined;
      },
      catch: toGitHubError,
    });

  const postReview = (input: PostReviewInput): Effect.Effect<void, GitHubError> =>
    Effect.tryPromise({
      try: async () => {
        if (input.resolveStaleThreads) {
          const scope = input.reviewedPaths ? new Set(input.reviewedPaths) : undefined;
          await resolveLupeThreads(octokit, input.pr, scope).catch(() => undefined);
        }

        if (input.comments.length > 0) {
          await octokit.rest.pulls.createReview({
            owner: input.pr.owner,
            repo: input.pr.repo,
            pull_number: input.pr.number,
            commit_id: input.headSha,
            event: 'COMMENT',
            body: `${INLINE_MARKER} left ${input.comments.length} inline comment(s). See the summary below.`,
            comments: input.comments.map(toReviewComment),
          });
        }

        const sticky = await findSticky(octokit, input.pr);
        if (sticky) {
          await octokit.rest.issues.updateComment({
            owner: input.pr.owner,
            repo: input.pr.repo,
            comment_id: sticky.id,
            body: input.summaryBody,
          });
        } else {
          await octokit.rest.issues.createComment({
            owner: input.pr.owner,
            repo: input.pr.repo,
            issue_number: input.pr.number,
            body: input.summaryBody,
          });
        }
      },
      catch: toGitHubError,
    });

  const getRelatedIssues = (pr: PullRequestRef): Effect.Effect<readonly LinkedIssue[], GitHubError> =>
    Effect.tryPromise({
      try: async () => {
        // Fetch the PR details to get the body.
        const { data: prData } = await octokit.rest.pulls.get({
          owner: pr.owner,
          repo: pr.repo,
          pull_number: pr.number,
        });
        const body = prData.body ?? '';

        // Parse issue references from the PR body.
        const issuePattern = /(?:fixes|closes|resolves|references|see(?:s| also)?)\s+#(\d+)/gi;
        const matched = new Set<number>();
        let m: RegExpExecArray | null;
        while ((m = issuePattern.exec(body)) !== null) {
          matched.add(Number.parseInt(m[1]!, 10));
        }

        if (matched.size === 0) return [];

        // Fetch each issue in parallel (up to 20).
        const nums = [...matched].slice(0, 20);
        const results = await Promise.allSettled(
          nums.map((num) =>
            octokit.rest.issues.get({ owner: pr.owner, repo: pr.repo, issue_number: num }).then((r) => r.data)
          )
        );

        const issues: LinkedIssue[] = [];
        for (const result of results) {
          if (result.status === 'fulfilled') {
            const issue = result.value;
            if (!issue.pull_request) {
              // Only include actual issues, not PRs (GitHub issues API returns PRs too).
              issues.push({
                number: issue.number,
                title: issue.title,
                state: issue.state as 'open' | 'closed',
                body: issue.body ?? '',
              });
            }
          }
        }
        return issues;
      },
      catch: toGitHubError,
    });

  return { listDiff, listDiffSince, getLastReviewedSha, getReviewState, postReview, getRelatedIssues };
}

/** Effect Layer providing the GitHub transport for a token. */
export function GitHubClientLive(config: OctokitConfig): Layer.Layer<GitHubClient> {
  return Layer.sync(GitHubClient, () => makeGitHubClient(config));
}
