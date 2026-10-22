#!/usr/bin/env bash
# Squash-merge a non-draft pull request into main as github-actions[bot].
#
# Gate, both times it is read (POLL_SECONDS apart, default 30):
#   - open, not a draft, base is main, not from a fork
#   - no CHANGES_REQUESTED or REVIEW_REQUIRED decision
#   - no unresolved review thread (a Bugbot or human comment still open)
#   - every check GitHub marks required is green (success, or skipped when
#     it does not apply). Pending or failing required checks block.
#     mergeStateStatus may be CLEAN or UNSTABLE: a failing check that is
#     not required does not block once the required set is green.
#   - when GitHub reports no required checks, do not treat that as
#     vacuously green. Wait until mergeStateStatus is CLEAN, the CI
#     workflow has a successful check, and no other reported check is
#     still running or failing. Neutral and skipped checks do not block.
#   - statusCheckRollup includes superseded runs. CI cancels in progress,
#     so a later green run often sits beside an older CANCELLED or failed
#     run of the same check. Contexts are deduped by name and workflow;
#     only the latest run is judged. A CANCELLED or failed run superseded
#     by a newer one is ignored.
#
# The squash merge is pinned with --match-head-commit to the headRefOid
# from the second gate read. A push after that read is not merged.
#
# Dependabot PRs are included. They use this same gate (dependabot[bot]
# and app/dependabot are ordinary authors). There is no major-update
# label hold. The workflow must run from the default branch: Dependabot's
# pull_request token is read-only, and a pull_request trigger would
# execute the merger from the PR head.
#
# Reads go through the pull request GraphQL object (statusCheckRollup,
# isRequired, review threads). The Checks and Statuses REST APIs are not
# called, so the workflow can stay on contents: write and pull-requests:
# write. A failed read fails the job. A gate miss skips that PR.
#
# POLL_SECONDS defaults to 30. MERGE_RETRY_SLEEP defaults to attempt*5.
# Tests set both to 0.

set -euo pipefail

POLL_SECONDS="${POLL_SECONDS:-30}"
MERGE_RETRY_SLEEP="${MERGE_RETRY_SLEEP:-}"
EXCLUDE_CHECKS="${EXCLUDE_CHECKS:-[\"auto-merge\",\"label-dependabot\",\"cursor-auto-merge\",\"lupe-bugbot-wake\"]}"
CI_WORKFLOW="${CI_WORKFLOW:-CI}"

if [ -z "${REPO:-}" ] || [ -z "${EVENT_NAME:-}" ]; then
  echo "REPO and EVENT_NAME are required." >&2
  exit 1
fi

if ! printf '%s' "$EXCLUDE_CHECKS" | jq -e 'type == "array"' >/dev/null; then
  echo "EXCLUDE_CHECKS must be a JSON array." >&2
  exit 1
fi

QUERY=$(cat <<'EOF'
query($owner:String!, $repo:String!, $pr:Int!) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$pr) {
      state
      isDraft
      isCrossRepository
      baseRefName
      headRefName
      headRefOid
      mergeStateStatus
      reviewDecision
      author { login }
      reviewThreads(first:100) {
        pageInfo { hasNextPage }
        nodes { isResolved }
      }
      commits(last:1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first:100) {
                pageInfo { hasNextPage }
                nodes {
                  __typename
                  ... on CheckRun {
                    name
                    status
                    conclusion
                    startedAt
                    completedAt
                    isRequired(pullRequestNumber: $pr)
                    checkSuite { workflowRun { workflow { name } } }
                  }
                  ... on StatusContext {
                    context
                    state
                    createdAt
                    isRequired(pullRequestNumber: $pr)
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
EOF
)

NORMALIZE_JQ=$(cat <<'EOF'
.data.repository.pullRequest as $pr
| (
    if (($pr.commits.nodes // []) | length) > 0
    then $pr.commits.nodes[0].commit.statusCheckRollup
    else null
    end
  ) as $roll
| {
    state: $pr.state,
    isDraft: $pr.isDraft,
    isCrossRepository: $pr.isCrossRepository,
    baseRefName: $pr.baseRefName,
    headRefName: $pr.headRefName,
    headRefOid: $pr.headRefOid,
    mergeStateStatus: ($pr.mergeStateStatus // ""),
    reviewDecision: $pr.reviewDecision,
    author: (($pr.author // {}) | .login // ""),
    unresolvedThreads: ([(($pr.reviewThreads // {}) | .nodes // [])[] | select(.isResolved == false)] | length),
    threadsTruncated: ((($pr.reviewThreads // {}) | (.pageInfo // {}) | .hasNextPage) // false),
    checksTruncated: (
      if $roll == null then false
      else ((($roll.contexts // {}) | (.pageInfo // {}) | .hasNextPage) // false)
      end
    ),
    checks: (
      if $roll == null or $roll.contexts == null then []
      else
        [
          ($roll.contexts.nodes // [])[] |
          if .__typename == "CheckRun" then {
            kind: "check",
            name: (.name // ""),
            status: (.status // ""),
            conclusion: (.conclusion // ""),
            isRequired: (.isRequired // false),
            workflowName: ((((.checkSuite // {}) | (.workflowRun // {}) | (.workflow // {}) | .name) // "")),
            startedAt: (.startedAt // ""),
            completedAt: (.completedAt // "")
          }
          elif .__typename == "StatusContext" then {
            kind: "status",
            name: (.context // ""),
            status: (.state // ""),
            conclusion: "",
            isRequired: (.isRequired // false),
            workflowName: "",
            startedAt: (.createdAt // ""),
            completedAt: ""
          }
          else empty
          end
        ]
        # CI cancel-in-progress leaves the older CANCELLED or failed run in
        # the rollup next to the rerun. Keep the latest run of each
        # name+workflow. startedAt is the primary order; completedAt and
        # rollup position break ties. A superseded CANCELLED run then drops
        # out of the gate.
        | to_entries
        | group_by([.value.name, .value.workflowName])
        | map(max_by([.value.startedAt, .value.completedAt, .key]) | .value | del(.startedAt, .completedAt))
      end
    )
  }
EOF
)

GATE_JQ=$(cat <<'EOF'
def is_excluded: (.name as $n | $ex | index($n) != null);
def pending:
  if .kind == "check" then .status != "COMPLETED"
  else (.status == "PENDING" or .status == "EXPECTED")
  end;
def success:
  if .kind == "check" then (.status == "COMPLETED" and .conclusion == "SUCCESS")
  else (.status == "SUCCESS")
  end;
def required_ok:
  if .kind == "check" then
    (.status == "COMPLETED" and (.conclusion == "SUCCESS" or .conclusion == "SKIPPED"))
  else (.status == "SUCCESS")
  end;
def allowed_soft:
  if .kind == "check" then
    (.status == "COMPLETED" and (.conclusion == "SUCCESS" or .conclusion == "NEUTRAL" or .conclusion == "SKIPPED"))
  else (.status == "SUCCESS")
  end;
def shown:
  if .kind == "check" then "\(.name): \(.status)/\(.conclusion)"
  else "\(.name): \(.status)"
  end;

if (.threadsTruncated == true or .checksTruncated == true) then
  "ERROR partial read of checks or review threads"
elif .state != "OPEN" then
  "PR is \(.state)"
elif .isDraft != false then
  "PR is a draft"
elif .isCrossRepository != false then
  "PR is from a fork"
elif .baseRefName != "main" then
  "PR targets \(.baseRefName), not main"
elif ($event != "schedule" and $event != "workflow_dispatch" and $head_sha != "" and .headRefOid != $head_sha) then
  "Stale run: head moved (\($head_sha) -> \(.headRefOid))"
elif .reviewDecision == "CHANGES_REQUESTED" then
  "unresolved blocking review (CHANGES_REQUESTED)"
elif .reviewDecision == "REVIEW_REQUIRED" then
  "blocking review still required"
elif (.unresolvedThreads > 0) then
  "\(.unresolvedThreads) unresolved blocking review thread(s)"
else
  ([.checks[] | select(.isRequired == true and (is_excluded | not))]) as $required |
  ([.checks[] | select(is_excluded | not)]) as $relevant |
  if ($required | length) > 0 then
    if .mergeStateStatus != "CLEAN" and .mergeStateStatus != "UNSTABLE" then
      "mergeStateStatus is \(.mergeStateStatus), not CLEAN"
    elif any($required[]; pending) then
      "required checks still running"
    elif any($required[]; required_ok | not) then
      "required checks are not green: " + ([$required[] | select(required_ok | not) | shown] | join(", "))
    elif ([$required[] | select(success)] | length) == 0 then
      "required checks have not succeeded"
    else
      "PASS required"
    end
  else
    if .mergeStateStatus != "CLEAN" then
      "mergeStateStatus is \(.mergeStateStatus), not CLEAN"
    elif ($relevant | length) == 0 then
      "no checks reported yet"
    elif any($relevant[]; pending) then
      "checks still running"
    elif any($relevant[]; allowed_soft | not) then
      "a check is not green: " + ([$relevant[] | select(allowed_soft | not) | shown] | join(", "))
    elif ([$relevant[] | select(.kind == "check" and .workflowName == $ci and success)] | length) == 0 then
      "CI has not succeeded"
    else
      "PASS fallback"
    end
  end
end
EOF
)

merge_with_retry() {
  local pr="$1"
  local sha="$2"
  local attempt=1
  local max=5
  local out state sleep_for

  if [ -z "$sha" ]; then
    echo "Refusing to merge PR #$pr without the verified head SHA."
    return 1
  fi

  while [ "$attempt" -le "$max" ]; do
    # Pin the merge to the commit the gate just accepted. A push after the
    # second read must not be squash-merged.
    if out=$(gh pr merge "$pr" --repo "$REPO" --squash --delete-branch --match-head-commit "$sha" 2>&1); then
      echo "Merged PR #$pr (attempt $attempt/$max) at $sha."
      return 0
    fi

    echo "Merge attempt $attempt/$max for PR #$pr failed: $out"

    case "$out" in
      *[Aa]lready*merged*)
        echo "PR #$pr is already merged."
        return 0
        ;;
      *"head sha"* | *"Head SHA"* | *"expected head"* | *"Expected head"*)
        echo "PR #$pr head moved after the gate read ($sha); leaving it for the next sweep."
        return 1
        ;;
      *"Base branch was modified"* | *"try the merge again"* | *"not mergeable"*)
        ;;
      *)
        echo "Non-retryable merge error; leaving PR #$pr for a human."
        return 1
        ;;
    esac

    state=$(gh pr view "$pr" --repo "$REPO" --json state --jq '.state' 2>/dev/null || echo "UNKNOWN")
    case "$state" in
      MERGED | CLOSED)
        echo "PR #$pr is now $state; nothing left to retry."
        return 0
        ;;
      OPEN)
        ;;
      *)
        echo "Could not read PR #$pr state (got '${state:-<empty>}'); assuming still open and retrying."
        ;;
    esac

    if [ -n "$MERGE_RETRY_SLEEP" ]; then
      sleep_for="$MERGE_RETRY_SLEEP"
    else
      sleep_for=$((attempt * 5))
    fi
    sleep "$sleep_for"
    attempt=$((attempt + 1))
  done

  echo "Exhausted $max merge attempts for PR #$pr; the next sweep will retry."
  return 1
}

fetch_pr() {
  local pr="$1"
  local raw owner name
  owner="${REPO%%/*}"
  name="${REPO#*/}"

  if ! raw=$(gh api graphql -f query="$QUERY" -F owner="$owner" -F repo="$name" -F pr="$pr"); then
    echo "Failed to read PR #$pr." >&2
    if [ -n "${raw:-}" ]; then
      printf '%s\n' "$raw" >&2
    fi
    return 1
  fi

  if printf '%s' "$raw" | jq -e '(.errors // []) | length > 0' >/dev/null; then
    echo "GraphQL error reading PR #$pr." >&2
    printf '%s\n' "$raw" >&2
    return 1
  fi

  if ! printf '%s' "$raw" | jq -e '.data.repository.pullRequest != null' >/dev/null; then
    echo "PR #$pr was not found." >&2
    printf '%s\n' "$raw" >&2
    return 1
  fi

  printf '%s' "$raw" | jq -c "$NORMALIZE_JQ" || return 1
}

decide() {
  local norm="$1"
  printf '%s' "$norm" | jq -r \
    --arg head_sha "${HEAD_SHA:-}" \
    --arg event "$EVENT_NAME" \
    --arg ci "$CI_WORKFLOW" \
    --argjson ex "$EXCLUDE_CHECKS" \
    "$GATE_JQ"
}

evaluate_pr() {
  local pr="$1"
  local norm decision author sha

  echo "Evaluating PR #$pr ..."
  if ! norm=$(fetch_pr "$pr"); then
    echo "Failed to read PR #$pr; refusing to treat a read error as checks still running."
    return 1
  fi

  printf '%s\n' "$norm" | jq -r '.checks[]? | "  - \(.name) required=\(.isRequired) \(.status)/\(.conclusion) \(.workflowName)"' >&2 || true

  if ! decision=$(decide "$norm"); then
    echo "ERROR could not evaluate the merge gate for PR #$pr."
    return 1
  fi
  case "$decision" in
    PASS\ *) ;;
    ERROR\ *)
      echo "$decision"
      return 1
      ;;
    "")
      echo "ERROR empty gate decision for PR #$pr."
      return 1
      ;;
    *)
      echo "$decision; skipping."
      return 0
      ;;
  esac

  if [ "$POLL_SECONDS" -gt 0 ]; then
    echo "First gate passed for PR #$pr; waiting ${POLL_SECONDS}s for a second read."
    sleep "$POLL_SECONDS"
  fi

  if ! norm=$(fetch_pr "$pr"); then
    echo "Failed to read PR #$pr on the second pass; refusing to merge."
    return 1
  fi
  if ! decision=$(decide "$norm"); then
    echo "ERROR could not evaluate the second read for PR #$pr."
    return 1
  fi
  case "$decision" in
    PASS\ *) ;;
    ERROR\ *)
      echo "Second read failed: $decision"
      return 1
      ;;
    "")
      echo "Second read failed: empty gate decision."
      return 1
      ;;
    *)
      echo "Second read failed: $decision; skipping."
      return 0
      ;;
  esac

  author=$(printf '%s' "$norm" | jq -r '.author // ""') || author=""
  sha=$(printf '%s' "$norm" | jq -r '.headRefOid // ""') || sha=""
  echo "Gate clear (${decision#PASS }). Squash-merging PR #$pr (author ${author}) at ${sha}."
  merge_with_retry "$pr" "$sha"
}

list_prs() {
  local raw out

  case "$EVENT_NAME" in
    schedule | workflow_dispatch)
      if ! out=$(gh pr list --repo "$REPO" --state open --base main --limit 100 \
        --json number,isDraft,baseRefName \
        --jq '.[] | select(.isDraft == false and .baseRefName == "main") | .number'); then
        echo "Failed to list open pull requests." >&2
        return 1
      fi
      printf '%s' "$out"
      ;;
    *)
      if [ -n "${HEAD_BRANCH:-}" ]; then
        if ! out=$(gh pr list --repo "$REPO" --head "$HEAD_BRANCH" --state open --base main \
          --json number --jq '.[0].number // empty'); then
          echo "Failed to list pull requests for $HEAD_BRANCH." >&2
          return 1
        fi
        printf '%s' "$out"
      else
        if [ -z "${HEAD_SHA:-}" ]; then
          echo "No head SHA to resolve a pull request from." >&2
          return 1
        fi
        # REST state is lowercase "open". An error body is an object; do not
        # treat that as an empty pull-request list.
        if ! raw=$(gh api "repos/$REPO/commits/$HEAD_SHA/pulls"); then
          echo "Failed to list pull requests for $HEAD_SHA." >&2
          if [ -n "${raw:-}" ]; then
            printf '%s\n' "$raw" >&2
          fi
          return 1
        fi
        if ! printf '%s' "$raw" | jq -e 'type == "array"' >/dev/null; then
          echo "Failed to list pull requests for $HEAD_SHA." >&2
          printf '%s\n' "$raw" >&2
          return 1
        fi
        printf '%s' "$raw" | jq -r --arg sha "$HEAD_SHA" \
          '[.[] | select(.state == "open" and .head.sha == $sha and .base.ref == "main")][0].number // empty'
      fi
      ;;
  esac
}

if ! PR_NUMBERS=$(list_prs); then
  echo "Failed to list candidate pull requests."
  exit 1
fi

if [ "$EVENT_NAME" = "schedule" ] || [ "$EVENT_NAME" = "workflow_dispatch" ]; then
  echo "Sweep: considering PR(s): ${PR_NUMBERS:-<none>}"
fi

if [ -z "$PR_NUMBERS" ]; then
  echo "No candidate PRs for $EVENT_NAME (sha: ${HEAD_SHA:-<none>}, branch: ${HEAD_BRANCH:-<none>}); nothing to do."
  exit 0
fi

FAILED=0
for pr in $PR_NUMBERS; do
  case "$pr" in
    '' | *[!0-9]*)
      echo "Ignoring unexpected pull request id '$pr'."
      continue
      ;;
  esac
  echo "::group::PR #$pr"
  evaluate_pr "$pr" || FAILED=1
  echo "::endgroup::"
done

exit "$FAILED"
