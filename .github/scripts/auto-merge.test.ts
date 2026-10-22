import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

/**
 * The auto-merge script talks to `gh`. These tests stub that binary and
 * assert the gate: non-draft PRs into main, including Dependabot, squash-merge
 * only when required checks are green and no blocking review is unresolved.
 */

const SCRIPT = join(import.meta.dirname, 'auto-merge.sh');
const WORKFLOW = join(import.meta.dirname, '..', 'workflows', 'auto-merge.yml');
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REPO = 'owner/repo';

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Sandbox {
  dir: string;
}

interface CheckNode {
  __typename: 'CheckRun' | 'StatusContext';
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
  isRequired: boolean;
  checkSuite?: { workflowRun: { workflow: { name: string } } | null };
}

interface GateOpts {
  state?: string;
  isDraft?: boolean;
  isCrossRepository?: boolean;
  baseRefName?: string;
  headRefName?: string;
  headRefOid?: string;
  mergeStateStatus?: string;
  reviewDecision?: string | null;
  author?: string;
  unresolved?: number;
  threadsTruncated?: boolean;
  checksTruncated?: boolean;
  checks?: CheckNode[];
  noRollup?: boolean;
}

function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'auto-merge-'));
  sandboxes.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), GH_STUB);
  chmodSync(join(bin, 'gh'), 0o755);
  return { dir };
}

function writeJson(sb: Sandbox, name: string, value: unknown) {
  writeFileSync(join(sb.dir, name), JSON.stringify(value));
}

function checkRun(name: string, extra: Partial<CheckNode> = {}): CheckNode {
  return {
    __typename: 'CheckRun',
    name,
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    isRequired: false,
    checkSuite: { workflowRun: null },
    ...extra,
  };
}

function ciCheck(name: string, extra: Partial<CheckNode> = {}): CheckNode {
  return checkRun(name, {
    checkSuite: { workflowRun: { workflow: { name: 'CI' } } },
    ...extra,
  });
}

function graphqlBody(opts: GateOpts = {}) {
  const checks = opts.checks ?? [ciCheck('Format · Lint · Knip'), ciCheck('Build · Typecheck · Test')];
  const unresolved = opts.unresolved ?? 0;
  const nodes = Array.from({ length: unresolved }, () => ({ isResolved: false }));
  return {
    data: {
      repository: {
        pullRequest: {
          state: opts.state ?? 'OPEN',
          isDraft: opts.isDraft ?? false,
          isCrossRepository: opts.isCrossRepository ?? false,
          baseRefName: opts.baseRefName ?? 'main',
          headRefName: opts.headRefName ?? 'dependabot/npm_and_yarn/left-pad-1.2.3',
          headRefOid: opts.headRefOid ?? SHA,
          mergeStateStatus: opts.mergeStateStatus ?? 'CLEAN',
          reviewDecision: opts.reviewDecision ?? null,
          author: { login: opts.author ?? 'app/dependabot' },
          reviewThreads: {
            pageInfo: { hasNextPage: opts.threadsTruncated ?? false },
            nodes,
          },
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: opts.noRollup
                    ? null
                    : {
                        contexts: {
                          pageInfo: { hasNextPage: opts.checksTruncated ?? false },
                          nodes: checks,
                        },
                      },
                },
              },
            ],
          },
        },
      },
    },
  };
}

function seed(sb: Sandbox, pr = 12, opts: GateOpts = {}) {
  writeJson(sb, 'graphql.json', graphqlBody(opts));
  writeJson(sb, 'pr-list-head.json', [{ number: pr }]);
  writeJson(sb, 'pr-list.json', [
    {
      number: pr,
      isDraft: opts.isDraft ?? false,
      baseRefName: opts.baseRefName ?? 'main',
    },
  ]);
  writeJson(sb, 'commit-pulls.json', [
    {
      state: 'open',
      number: pr,
      head: { sha: opts.headRefOid ?? SHA },
      base: { ref: opts.baseRefName ?? 'main' },
    },
  ]);
  writeJson(sb, 'pr-view.json', { state: 'OPEN' });
}

function run(sb: Sandbox, env: Record<string, string> = {}): { status: number | null; out: string; merges: string } {
  const res = spawnSync('bash', [SCRIPT], {
    cwd: sb.dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(sb.dir, 'bin')}:${process.env.PATH ?? ''}`,
      STUB_DIR: sb.dir,
      GH_TOKEN: 'test-token',
      REPO,
      EVENT_NAME: 'workflow_run',
      HEAD_SHA: SHA,
      HEAD_BRANCH: 'dependabot/npm_and_yarn/left-pad-1.2.3',
      POLL_SECONDS: '0',
      MERGE_RETRY_SLEEP: '0',
      ...env,
    },
  });
  return {
    status: res.status,
    out: `${res.stdout ?? ''}${res.stderr ?? ''}`,
    merges: readOptional(join(sb.dir, 'merges.txt')),
  };
}

function readOptional(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function expectMerge(res: { status: number | null; out: string; merges: string }, pr: number) {
  expect(res.status).toBe(0);
  expect(res.merges).toMatch(new RegExp(`pr merge ${pr} `));
  expect(res.merges).toMatch(/--squash/);
  expect(res.merges).toMatch(/--delete-branch/);
}

const GH_STUB = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$STUB_DIR/gh.log"

cmd="$1"
sub="$2"
jq_filter=""
next_jq=0
head_branch=""
next_head=0
endpoint=""
for a in "$@"; do
  if [ "$next_jq" = 1 ]; then jq_filter="$a"; next_jq=0; continue; fi
  if [ "$next_head" = 1 ]; then head_branch="$a"; next_head=0; continue; fi
  case "$a" in
    --jq) next_jq=1 ;;
    --head) next_head=1 ;;
    graphql) endpoint="graphql" ;;
    repos/*) endpoint="$a" ;;
  esac
done

apply_jq() {
  if [ -n "$jq_filter" ]; then
    jq -r "$jq_filter"
  else
    cat
  fi
}

if [ "$cmd" = "pr" ] && [ "$sub" = "merge" ]; then
  n=$(cat "$STUB_DIR/merge-attempts" 2>/dev/null || echo 0)
  n=$((n + 1))
  echo "$n" > "$STUB_DIR/merge-attempts"
  if [ -f "$STUB_DIR/merge-fail-until" ]; then
    limit=$(cat "$STUB_DIR/merge-fail-until")
    if [ "$n" -le "$limit" ]; then
      echo "GraphQL: Base branch was modified. Review and try the merge again." >&2
      exit 1
    fi
  fi
  if [ -f "$STUB_DIR/merge-error.txt" ]; then
    cat "$STUB_DIR/merge-error.txt" >&2
    exit 1
  fi
  printf '%s\\n' "$*" >> "$STUB_DIR/merges.txt"
  exit 0
fi

if [ "$cmd" = "pr" ] && [ "$sub" = "view" ]; then
  apply_jq < "$STUB_DIR/pr-view.json"
  exit 0
fi

if [ "$cmd" = "pr" ] && [ "$sub" = "list" ]; then
  if [ -f "$STUB_DIR/list-fail" ]; then
    echo "HTTP 403" >&2
    exit 1
  fi
  if [ -n "$head_branch" ]; then
    apply_jq < "$STUB_DIR/pr-list-head.json"
  else
    apply_jq < "$STUB_DIR/pr-list.json"
  fi
  exit 0
fi

if [ "$cmd" = "api" ] && [ "$endpoint" = "graphql" ]; then
  if [ -f "$STUB_DIR/graphql-fail" ]; then
    echo "HTTP 403" >&2
    exit 1
  fi
  n=$(cat "$STUB_DIR/graphql-count" 2>/dev/null || echo 0)
  n=$((n + 1))
  echo "$n" > "$STUB_DIR/graphql-count"
  f="$STUB_DIR/graphql-$n.json"
  if [ ! -f "$f" ]; then
    f="$STUB_DIR/graphql.json"
  fi
  cat "$f"
  exit 0
fi

if [ "$cmd" = "api" ] && [[ "$endpoint" == *"/pulls" ]]; then
  cat "$STUB_DIR/commit-pulls.json"
  exit 0
fi

echo "unhandled gh invocation: $*" >&2
exit 1
`;

describe('auto-merge.sh', () => {
  test('exits quietly when there is no candidate PR', () => {
    const sb = makeSandbox();
    writeJson(sb, 'pr-list-head.json', []);
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/No candidate PRs/);
    expect(res.merges).toBe('');
  });

  test('sweeps open non-draft PRs into main, including Dependabot, and skips drafts', () => {
    const sb = makeSandbox();
    writeJson(sb, 'pr-list.json', [
      { number: 4, isDraft: true, baseRefName: 'main' },
      { number: 9, isDraft: false, baseRefName: 'develop' },
      { number: 12, isDraft: false, baseRefName: 'main' },
    ]);
    writeJson(sb, 'graphql.json', graphqlBody({ author: 'app/dependabot' }));
    writeJson(sb, 'pr-view.json', { state: 'OPEN' });
    const res = run(sb, { EVENT_NAME: 'schedule', HEAD_SHA: '', HEAD_BRANCH: '' });
    expectMerge(res, 12);
    expect(res.out).toMatch(/Sweep: considering PR\(s\): 12/);
    expect(res.out).toMatch(/author app\/dependabot/);
    expect(res.out).toMatch(/Gate clear \(fallback\)/);
    expect(res.merges).not.toMatch(/pr merge 4 /);
    expect(res.merges).not.toMatch(/pr merge 9 /);
  });

  test('squash-merges a human PR on the same gate', () => {
    const sb = makeSandbox();
    seed(sb, 30, { author: 'brianlane', headRefName: 'fix-anchor' });
    const res = run(sb, { HEAD_BRANCH: 'fix-anchor' });
    expectMerge(res, 30);
    expect(res.out).toMatch(/author brianlane/);
  });

  test('skips a draft', () => {
    const sb = makeSandbox();
    seed(sb, 10, { isDraft: true });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/PR is a draft/);
    expect(res.merges).toBe('');
  });

  test('skips a fork PR', () => {
    const sb = makeSandbox();
    seed(sb, 11, { isCrossRepository: true });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/from a fork/);
    expect(res.merges).toBe('');
  });

  test('skips a PR that does not target main', () => {
    const sb = makeSandbox();
    seed(sb, 13, { baseRefName: 'release' });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/targets release, not main/);
    expect(res.merges).toBe('');
  });

  test('skips a closed PR', () => {
    const sb = makeSandbox();
    seed(sb, 14, { state: 'MERGED' });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/PR is MERGED/);
    expect(res.merges).toBe('');
  });

  test('skips when mergeStateStatus is BEHIND and nothing is required', () => {
    const sb = makeSandbox();
    seed(sb, 15, { mergeStateStatus: 'BEHIND' });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/mergeStateStatus is BEHIND, not CLEAN/);
    expect(res.merges).toBe('');
  });

  test('skips a CHANGES_REQUESTED review', () => {
    const sb = makeSandbox();
    seed(sb, 16, { reviewDecision: 'CHANGES_REQUESTED' });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/unresolved blocking review \(CHANGES_REQUESTED\)/);
    expect(res.merges).toBe('');
  });

  test('skips when a review is still required', () => {
    const sb = makeSandbox();
    seed(sb, 17, { reviewDecision: 'REVIEW_REQUIRED' });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/blocking review still required/);
    expect(res.merges).toBe('');
  });

  test('skips unresolved review threads', () => {
    const sb = makeSandbox();
    seed(sb, 18, { unresolved: 2 });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/2 unresolved blocking review thread\(s\)/);
    expect(res.merges).toBe('');
  });

  test('skips a stale head SHA', () => {
    const sb = makeSandbox();
    seed(sb, 19, { headRefOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/Stale run/);
    expect(res.merges).toBe('');
  });

  test('does not merge before CI has succeeded when no check is required', () => {
    const sb = makeSandbox();
    seed(sb, 20, {
      checks: [checkRun('CodeQL', { checkSuite: { workflowRun: { workflow: { name: 'CodeQL' } } } })],
    });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/CI has not succeeded/);
    expect(res.merges).toBe('');
  });

  test('waits while CI is still running', () => {
    const sb = makeSandbox();
    seed(sb, 21, {
      checks: [ciCheck('Build · Typecheck · Test', { status: 'IN_PROGRESS', conclusion: null })],
    });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/checks still running/);
    expect(res.merges).toBe('');
  });

  test('does not merge when no checks have been reported', () => {
    const sb = makeSandbox();
    seed(sb, 22, { noRollup: true });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/no checks reported yet/);
    expect(res.merges).toBe('');
  });

  test('a neutral Bugbot check does not block the fallback gate', () => {
    const sb = makeSandbox();
    seed(sb, 23, {
      checks: [ciCheck('Format · Lint · Knip'), checkRun('Cursor Bugbot', { conclusion: 'NEUTRAL' })],
    });
    const res = run(sb);
    expectMerge(res, 23);
  });

  test('a failing check blocks when nothing is required', () => {
    const sb = makeSandbox();
    seed(sb, 24, {
      mergeStateStatus: 'UNSTABLE',
      checks: [ciCheck('Format · Lint · Knip'), checkRun('Cursor Bugbot', { conclusion: 'FAILURE' })],
    });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/not green|not CLEAN/);
    expect(res.merges).toBe('');
  });

  test('an excluded skipped auto-merge check does not block', () => {
    const sb = makeSandbox();
    seed(sb, 25, {
      checks: [
        ciCheck('Format · Lint · Knip'),
        checkRun('auto-merge', { conclusion: 'SKIPPED' }),
        checkRun('label-dependabot', { conclusion: 'FAILURE' }),
      ],
    });
    const res = run(sb);
    expectMerge(res, 25);
  });

  test('required checks green: a failing non-required check does not block', () => {
    const sb = makeSandbox();
    seed(sb, 26, {
      mergeStateStatus: 'UNSTABLE',
      checks: [
        ciCheck('Build · Typecheck · Test', { isRequired: true }),
        checkRun('Cursor Bugbot', { conclusion: 'FAILURE' }),
      ],
    });
    const res = run(sb);
    expectMerge(res, 26);
    expect(res.out).toMatch(/Gate clear \(required\)/);
  });

  test('a pending required check blocks', () => {
    const sb = makeSandbox();
    seed(sb, 27, {
      mergeStateStatus: 'BLOCKED',
      checks: [ciCheck('Build · Typecheck · Test', { isRequired: true, status: 'IN_PROGRESS', conclusion: null })],
    });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/not CLEAN|required checks still running/);
    expect(res.merges).toBe('');
  });

  test('a failing required check blocks even if merge state is UNSTABLE', () => {
    const sb = makeSandbox();
    seed(sb, 28, {
      mergeStateStatus: 'UNSTABLE',
      checks: [ciCheck('Build · Typecheck · Test', { isRequired: true, conclusion: 'FAILURE' })],
    });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/required checks are not green/);
    expect(res.merges).toBe('');
  });

  test('a skipped required check alone is not success', () => {
    const sb = makeSandbox();
    seed(sb, 29, {
      checks: [ciCheck('Build · Typecheck · Test', { isRequired: true, conclusion: 'SKIPPED' })],
    });
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/required checks have not succeeded/);
    expect(res.merges).toBe('');
  });

  test('does not merge when the second read fails', () => {
    const sb = makeSandbox();
    writeJson(sb, 'graphql-1.json', graphqlBody());
    writeJson(sb, 'graphql-2.json', graphqlBody({ mergeStateStatus: 'DIRTY' }));
    writeJson(sb, 'pr-list-head.json', [{ number: 31 }]);
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/Second read failed/);
    expect(res.out).toMatch(/DIRTY/);
    expect(res.merges).toBe('');
    expect(readFileSync(join(sb.dir, 'graphql-count'), 'utf8').trim()).toBe('2');
  });

  test('retries a base-branch race and then squash-merges', () => {
    const sb = makeSandbox();
    seed(sb, 32);
    writeFileSync(join(sb.dir, 'merge-fail-until'), '1');
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/Merge attempt 1\/5/);
    expect(res.out).toMatch(/Merged PR #32 \(attempt 2\/5\)/);
    expect(res.merges).toMatch(/pr merge 32 /);
  });

  test('does not retry a non-retryable merge error', () => {
    const sb = makeSandbox();
    seed(sb, 33);
    writeFileSync(join(sb.dir, 'merge-error.txt'), 'HTTP 403: Resource not accessible by integration\n');
    const res = run(sb);
    expect(res.status).toBe(1);
    expect(res.out).toMatch(/Non-retryable merge error/);
    expect(res.merges).toBe('');
  });

  test('treats an already-merged race as done', () => {
    const sb = makeSandbox();
    seed(sb, 34);
    writeFileSync(join(sb.dir, 'merge-error.txt'), 'GraphQL: Pull Request has already been merged\n');
    const res = run(sb);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/already merged/);
    expect(res.merges).toBe('');
  });

  test('resolves the PR from the commit when the event has no branch', () => {
    const sb = makeSandbox();
    seed(sb, 35);
    const res = run(sb, { EVENT_NAME: 'status', HEAD_BRANCH: '' });
    expectMerge(res, 35);
  });

  test('a commit-pulls error object is not an empty candidate list', () => {
    const sb = makeSandbox();
    writeJson(sb, 'commit-pulls.json', { message: 'Resource not accessible by integration', status: '403' });
    const res = run(sb, { EVENT_NAME: 'status', HEAD_BRANCH: '' });
    expect(res.status).toBe(1);
    expect(res.out).toMatch(/Failed to list pull requests/);
    expect(res.merges).toBe('');
  });

  test('a GraphQL error fails the job', () => {
    const sb = makeSandbox();
    seed(sb, 36);
    writeJson(sb, 'graphql.json', { errors: [{ message: 'something went wrong' }] });
    const res = run(sb);
    expect(res.status).toBe(1);
    expect(res.out).toMatch(/GraphQL error reading PR #36/);
    expect(res.merges).toBe('');
  });

  test('a failed pull request read fails the job', () => {
    const sb = makeSandbox();
    seed(sb, 37);
    writeFileSync(join(sb.dir, 'graphql-fail'), '1');
    const res = run(sb);
    expect(res.status).toBe(1);
    expect(res.out).toMatch(/Failed to read PR #37/);
    expect(res.merges).toBe('');
  });

  test('a truncated review-thread page fails closed', () => {
    const sb = makeSandbox();
    seed(sb, 38, { threadsTruncated: true });
    const res = run(sb);
    expect(res.status).toBe(1);
    expect(res.out).toMatch(/partial read/);
    expect(res.merges).toBe('');
  });

  test('a failed PR list fails the job', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.dir, 'list-fail'), '1');
    const res = run(sb, { EVENT_NAME: 'schedule', HEAD_SHA: '', HEAD_BRANCH: '' });
    expect(res.status).toBe(1);
    expect(res.out).toMatch(/Failed to list/);
    expect(res.merges).toBe('');
  });

  test('does not call the Checks REST API or dispatch another workflow', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).not.toContain('/check-runs');
    expect(src).not.toContain('workflow run');
    expect(src).toContain('Dependabot PRs are included');
    expect(src).toContain('isRequired(pullRequestNumber: $pr)');
  });
});

describe('auto-merge workflow', () => {
  test('uses least privilege and loads the script from the default branch', () => {
    const src = readFileSync(WORKFLOW, 'utf8');
    const permissions = src.match(/permissions:\n(?:  .+\n)+/)?.[0] ?? '';
    expect(permissions).toContain('contents: write');
    expect(permissions).toContain('pull-requests: write');
    expect(permissions).not.toMatch(/checks:/);
    expect(permissions).not.toMatch(/statuses:/);
    expect(permissions).not.toMatch(/actions:/);
    expect(permissions).not.toMatch(/id-token:/);
    expect(src).not.toMatch(/\npull_request:/);
    expect(src).not.toMatch(/\npull_request_target:/);
    expect(src).toContain("github.event.workflow_run.event == 'pull_request'");
    expect(src).toContain('ref: ${{ github.event.repository.default_branch }}');
    expect(src).toContain('persist-credentials: false');
    expect(src).toContain('actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7');
    expect(src).toContain('name: auto-merge');
    expect(src).toContain("workflows: ['CI', 'Dismiss Action-bundle CodeQL alerts']");
    expect(src).toContain('GH_TOKEN: ${{ github.token }}');
    expect(src).not.toContain('request-copilot-review');
  });
});
