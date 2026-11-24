import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';

import * as core from '@actions/core';
import * as github from '@actions/github';
import { Effect, Layer } from 'effect';
import { parse as parseYaml } from 'yaml';

import {
  AiSdkLive,
  buildReviewState,
  findingContentKey,
  findingsForInlineComment,
  GitHubClient,
  mergeIncrementalFindings,
  normalizeConfig,
  renderSummaryMarkdown,
  resolveTaskModelId,
  runReview,
  SEVERITY_RANK,
  type ApiProviderId,
  type LupeConfig,
  type ReviewProfile,
  type ReviewTarget,
  type ReviewTask,
  type Severity,
} from '@gigadrive/lupe-core';
import { compressDiff, discoverCodingStandards, redactSecrets, RepoSourceLive } from '@gigadrive/lupe-git';
import { anchorFindings, GitHubClientLive } from '@gigadrive/lupe-github';

import { formatDiffSelectionLog, type DiffSelection } from './diff-selection';

const FAIL_NONE = 'none';

function intInput(name: string): number | undefined {
  const raw = core.getInput(name);
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

function numInput(name: string): number | undefined {
  const raw = core.getInput(name);
  if (!raw) return undefined;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : undefined;
}

function boolInput(name: string): boolean | undefined {
  const raw = core.getInput(name).trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

function severityInput(name: string): Severity | undefined {
  const raw = core.getInput(name).trim().toLowerCase();
  return raw && raw in SEVERITY_RANK ? (raw as Severity) : undefined;
}

function parseProfile(raw: string): ReviewProfile | undefined {
  return raw === 'assertive' ? 'assertive' : raw === 'chill' ? 'chill' : undefined;
}

function parseModels(raw: string): Record<string, string> | undefined {
  if (!raw.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : undefined;
  } catch {
    core.warning(`lupe: could not parse "models" input as JSON; ignoring.`);
    return undefined;
  }
}

/** Read a repo-committed `.lupe.yaml` from the checkout; Action inputs override it. */
function loadActionConfig(workspace: string): LupeConfig {
  for (const name of ['.lupe.yaml', '.lupe.yml']) {
    const file = nodePath.join(workspace, name);
    if (!existsSync(file)) continue;
    try {
      const parsed = parseYaml(readFileSync(file, 'utf8'));
      return normalizeConfig((parsed as Record<string, unknown> | null) ?? {});
    } catch (error) {
      core.warning(`lupe: failed to parse ${name}; ignoring. ${error instanceof Error ? error.message : ''}`);
      return normalizeConfig({});
    }
  }
  return normalizeConfig({});
}

const program = Effect.gen(function* () {
  const ctx = github.context;
  const pr = ctx.payload.pull_request;
  if (!pr) {
    core.info('lupe: no pull_request in the event payload; skipping.');
    return;
  }
  // pull_request_target runs with a writable token + repo secrets. If the job also
  // checks out the PR head, the agent's tools + the diff are an RCE/secret-exfil
  // vector. Refuse by default; the explicit opt-in still runs tool-less (below).
  const untrusted = ctx.eventName === 'pull_request_target';
  const allowUntrusted = core.getInput('allow-untrusted-checkout').trim().toLowerCase() === 'true';
  if (untrusted && !allowUntrusted) {
    core.setFailed(
      'lupe: refusing to run on pull_request_target (RCE/secret-exfil risk). Use the `pull_request` trigger, ' +
        'or set allow-untrusted-checkout: true only if this job does NOT check out untrusted PR code.'
    );
    return;
  }
  if (untrusted) {
    core.warning('lupe: pull_request_target with allow-untrusted-checkout — running tool-less (no repo file access).');
  }

  const owner = ctx.repo.owner;
  const repo = ctx.repo.repo;
  const number = pr.number as number;
  const headSha = (pr.head?.sha as string | undefined) ?? ctx.sha;
  const baseSha = pr.base?.sha as string | undefined;
  const isDraft = Boolean(pr.draft);

  if (isDraft && core.getInput('skip-draft') !== 'false') {
    core.info('lupe: draft PR; skipping (set skip-draft: false to review drafts).');
    return;
  }

  const token = core.getInput('github-token') || process.env.GITHUB_TOKEN || '';
  if (!token) {
    core.setFailed('lupe: no github-token available.');
    return;
  }

  const prRef = { owner, repo, number };
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();

  // `.lupe.yaml` from the checked-out repo is the base; explicit Action inputs win.
  const config = loadActionConfig(workspace);

  const provider = (core.getInput('provider') || config.provider || 'anthropic') as ApiProviderId;
  const profile: ReviewProfile | undefined = parseProfile(core.getInput('profile')) ?? config.profile;
  const models = parseModels(core.getInput('models')) ?? config.models;
  const baseURL = core.getInput('base-url') || config.baseURL || undefined;
  const maxFiles = intInput('max-files') ?? config.maxFiles;
  const maxFindings = intInput('max-findings') ?? config.maxFindings;
  const confidenceThreshold = numInput('confidence-threshold') ?? config.confidenceThreshold;
  const suppressAdvisory = boolInput('suppress-advisory') ?? config.suppressAdvisory;
  const minSeverityToComment = severityInput('min-severity-to-comment') ?? config.minSeverityToComment;
  const maxChunkTokens = intInput('max-chunk-tokens') ?? config.maxChunkTokens;
  const maxChunks = intInput('max-chunks') ?? config.maxChunks;
  const reviewConcurrency = intInput('review-concurrency') ?? config.reviewConcurrency;
  const maxCostUsd = numInput('max-cost-usd') ?? config.maxCostUsd;
  const thorough = (core.getInput('thorough') || 'false') === 'true';
  const task: ReviewTask = thorough ? 'deep' : 'review';
  // Resolve the review-task model up front so the cost cap can price the run
  // pre-flight. Non-Anthropic providers without a configured model throw here;
  // fall back to the post-priming breaker and let the real call surface the error.
  let estimateModelId: string | undefined;
  try {
    estimateModelId = resolveTaskModelId({ provider, models }, task);
  } catch {
    estimateModelId = undefined;
  }
  const failOn = (core.getInput('fail-on-severity') || FAIL_NONE).toLowerCase();
  const codingStandards = discoverCodingStandards({ rootDir: workspace, explicit: config.codingStandards });

  const repoLayer = RepoSourceLive({ rootDir: workspace });
  const aiLayer = AiSdkLive({ provider, models, baseURL, disableTools: untrusted }).pipe(Layer.provide(repoLayer));
  const githubLayer = GitHubClientLive({ token });
  const layer = Layer.mergeAll(repoLayer, aiLayer, githubLayer);

  const run = Effect.gen(function* () {
    const gh = yield* GitHubClient;
    const prior = yield* gh.getReviewState(prRef);
    const lastReviewedSha = prior?.lastReviewedSha;
    // Incremental: only review commits since the last reviewed SHA. Fall back to
    // the full diff on the first review or any non-fast-forward (rebase/force-push).
    const incremental = lastReviewedSha !== undefined && lastReviewedSha !== headSha;
    const { files, selection } = incremental
      ? yield* gh.listDiffSince(prRef, lastReviewedSha, headSha).pipe(
          Effect.map((diffFiles) => ({
            files: diffFiles,
            selection: {
              kind: 'incremental',
              sinceSha: lastReviewedSha,
              fileCount: diffFiles.length,
            } satisfies DiffSelection,
          })),
          Effect.catchAll((error) =>
            Effect.map(gh.listDiff(prRef), (diffFiles) => ({
              files: diffFiles,
              selection: {
                kind: 'full',
                reason: error.message,
                fileCount: diffFiles.length,
              } satisfies DiffSelection,
            }))
          )
        )
      : yield* Effect.map(gh.listDiff(prRef), (diffFiles) => ({
          files: diffFiles,
          selection: { kind: 'full', reason: undefined, fileCount: diffFiles.length } satisfies DiffSelection,
        }));
    // The log names the diff actually reviewed: "incremental review since X"
    // only when the incremental diff was really used, otherwise the fallback
    // reason (a non-fast-forward compare status, or the 300-file compare limit).
    const selectionLog = formatDiffSelectionLog(selection);
    if (selectionLog !== undefined) core.info(selectionLog);
    const compressed = compressDiff(files, {
      pathFilters: config.pathFilters,
      maxFilesReviewed: maxFiles,
      chunk: true,
    });
    if (compressed.files.length === 0) {
      core.info('lupe: no reviewable changes.');
      return;
    }

    // Strip likely secrets from the diff before it reaches the model (BYO-token hygiene).
    const redacted = redactSecrets(compressed.files);
    if (redacted.redactions > 0) {
      core.info(`lupe: redacted ${redacted.redactions} line(s) with likely secrets before review.`);
    }

    const target: ReviewTarget = {
      kind: 'pull_request',
      repo: { owner, repo },
      pullNumber: number,
      headSha,
      baseSha,
      title: pr.title as string | undefined,
      body: (pr.body as string | null | undefined) ?? undefined,
      lastReviewedSha,
      isDraft,
    };

    const result = yield* runReview(redacted.files, target, {
      profile,
      hasTools: !untrusted,
      codingStandards,
      pathInstructions: config.pathInstructions,
      confidenceThreshold,
      categoryThresholds: config.categoryThresholds,
      pathThresholds: config.pathThresholds,
      suppressAdvisory,
      maxFindings,
      maxChunkTokens,
      maxChunks,
      reviewConcurrency,
      maxCostUsd,
      modelPrices: config.modelPrices,
      estimateModelId,
      verify: true,
      task,
    });

    // Carry forward findings on files not reviewed this run so the sticky summary
    // stays cumulative instead of reflecting only the latest slice.
    const reviewedPaths = compressed.files.map((f) => f.path);
    const merged = incremental
      ? mergeIncrementalFindings(prior?.findings ?? [], result.findings, new Set(reviewedPaths))
      : result.findings;

    // Only post inline for findings not already shown in a prior run (cross-run dedupe,
    // so a force-push full-diff fallback doesn't re-post). Only this run's findings anchor.
    const priorKeys = new Set(prior?.postedKeys ?? []);
    const freshForInline = result.findings.filter((f) => !priorKeys.has(findingContentKey(f)));
    const inline = findingsForInlineComment(freshForInline, minSeverityToComment);
    const { comments, unanchored } = anchorFindings(inline, compressed.files);
    const postedKeys = [...priorKeys, ...inline.map((f) => findingContentKey(f))];

    const summaryBody = renderSummaryMarkdown(merged, {
      cost: result.cost,
      chunkCount: result.chunkCount,
      skippedForSize: result.skippedForSize,
      oversizedFiles: result.oversizedFiles,
      state: buildReviewState({ headSha, findings: merged, postedKeys }),
    });

    yield* gh.postReview({
      pr: prRef,
      headSha,
      comments,
      summaryBody,
      resolveStaleThreads: true,
      reviewedPaths,
    });

    core.setOutput('findings', String(merged.length));
    core.setOutput('cost-usd', result.cost.costUsd.toFixed(4));
    core.setOutput('skipped', String(result.skippedForSize.length));
    const passes = result.chunkCount > 1 ? ` · ${result.chunkCount} passes` : '';
    core.info(
      `lupe: ${merged.length} findings (${comments.length} new inline, ${unanchored.length} summary-only) · ~$${result.cost.costUsd.toFixed(
        4
      )}${passes}`
    );
    if (result.skippedForSize.length > 0) {
      core.warning(
        `lupe: ${result.skippedForSize.length} changed file(s) NOT reviewed (size budget): ` +
          `${result.skippedForSize.join(', ')}. Raise max-chunks, narrow the diff, or split the PR.`
      );
    }

    if (failOn !== FAIL_NONE) {
      const threshold = SEVERITY_RANK[failOn as Severity];
      if (threshold !== undefined) {
        const blocking = merged.filter((f) => SEVERITY_RANK[f.severity] <= threshold);
        if (blocking.length > 0) {
          core.setFailed(`lupe: ${blocking.length} finding(s) at or above severity "${failOn}".`);
        }
      }
    }
  });

  yield* run.pipe(Effect.provide(layer));
});

Effect.runPromise(
  program.pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => core.setFailed(`lupe failed: ${(error as { message?: string }).message ?? String(error)}`))
    )
  )
).catch((error) => core.setFailed(`lupe crashed: ${error instanceof Error ? error.message : String(error)}`));
