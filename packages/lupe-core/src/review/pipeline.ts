import { Effect } from 'effect';

import { estimateGenerationCostUsd } from '../ai/estimate';
import { AiModel, type AiError } from '../ai/model';
import { computeCost, modelCost, resolvePrice, type ModelPriceOverrides } from '../ai/pricing';
import type { DiffFile } from '../diff';
import { CostLimitError } from '../errors';
import type { Finding } from '../finding';
import { renderSummaryMarkdown } from '../render/markdown';
import type { CostSummary, ReviewTarget, TokenUsage } from '../review';
import { addUsage, EMPTY_USAGE } from '../review';
import { planChunks } from './chunk';
import { generateCandidates, type GenerateCandidatesOptions } from './engine';
import { applyFilters, type FilterOptions } from './filter';
import { buildSystemPrompt } from './prompt';
import { verifyFindings } from './verify';

/** Default bounded concurrency for the fan-out chunk passes. */
const DEFAULT_REVIEW_CONCURRENCY = 3;

export interface RunReviewOptions extends GenerateCandidatesOptions, FilterOptions {
  /** Run the grounding verifier (default true). */
  readonly verify?: boolean;
  readonly verifyConcurrency?: number;
  /** Max serialised-diff tokens per review chunk (large-PR map-reduce). Default 120_000. */
  readonly maxChunkTokens?: number;
  /** Hard ceiling on the number of chunks. Default 8. Overflow is reported, not dropped silently. */
  readonly maxChunks?: number;
  /** Bounded concurrency for the fan-out chunk passes. Default 3. */
  readonly reviewConcurrency?: number;
  /**
   * Hard USD ceiling for the run. Enforced pre-flight and after the priming
   * chunk, including when the diff fits in a single chunk.
   */
  readonly maxCostUsd?: number;
  /** Per-model price overrides used by the cost cap + cost accounting. */
  readonly modelPrices?: ModelPriceOverrides;
  /**
   * Model id the review task will resolve to (e.g. `claude-opus-4-8`). Supplied by
   * the caller so the pre-flight estimate can price the run before any model call.
   * When omitted, only the post-priming actual-cost breaker enforces the cap.
   */
  readonly estimateModelId?: string;
}

export interface ReviewRunResult {
  readonly findings: readonly Finding[];
  readonly candidateCount: number;
  readonly summaryMarkdown: string;
  readonly cost: CostSummary;
  readonly dropped: { readonly verifier: number; readonly filtered: number };
  /** How many model passes the diff was reviewed in (1 unless it was chunked). */
  readonly chunkCount: number;
  /** Files left unreviewed because the chunk ceiling was hit (surfaced, never silent). */
  readonly skippedForSize: readonly string[];
  /** Files individually larger than one pass (reviewed in isolation). */
  readonly oversizedFiles: readonly string[];
}

class CostAccumulator {
  private readonly byModel = new Map<string, TokenUsage>();

  constructor(private readonly overrides?: ModelPriceOverrides) {}

  add(model: string, usage: TokenUsage): void {
    this.byModel.set(model, addUsage(this.byModel.get(model) ?? EMPTY_USAGE, usage));
  }

  summary(): CostSummary {
    const perModel = [...this.byModel.entries()].map(([model, usage]) => modelCost(model, usage, this.overrides));
    const usage = perModel.reduce((acc, m) => addUsage(acc, m.usage), EMPTY_USAGE);
    const costUsd = perModel.reduce((acc, m) => acc + m.costUsd, 0);
    return { usage, costUsd, byModel: perModel };
  }
}

/**
 * The shared review pipeline (stages 4–7 minus transport): generate candidates →
 * grounding verifier → filter chain → render summary + cost. The CLI and the
 * Action both call this; they differ only in ingest (stage 1) and transport
 * (stage 7, posting/printing the result).
 */
export function runReview(
  files: readonly DiffFile[],
  target: ReviewTarget | undefined,
  options: RunReviewOptions = {}
): Effect.Effect<ReviewRunResult, AiError | CostLimitError, AiModel> {
  return Effect.gen(function* () {
    const overrides = options.modelPrices;
    const maxCostUsd = options.maxCostUsd;
    const cost = new CostAccumulator(overrides);

    // Build the frozen, cacheable prefix once and reuse it across every chunk so
    // it stays byte-identical — the Anthropic prompt cache is model-scoped and
    // prefix-keyed, so chunks 2..N read the warm cache the first chunk primed.
    const system = buildSystemPrompt(options);
    const plan = planChunks(files, {
      maxChunkTokens: options.maxChunkTokens,
      maxChunks: options.maxChunks,
    });
    const { chunks } = plan;

    // Pre-flight cost gate: fail BEFORE any model call when the estimate exceeds
    // the cap, or when the cap cannot be enforced (unknown price → fail closed).
    if (maxCostUsd !== undefined && chunks.length > 0 && options.estimateModelId) {
      const est = estimateGenerationCostUsd({ system, chunks, modelId: options.estimateModelId, overrides });
      if (!est.known) {
        return yield* Effect.fail(
          new CostLimitError({
            message: `cannot enforce max-cost-usd $${maxCostUsd}: no known price for model "${options.estimateModelId}" (set modelPrices)`,
            limitUsd: maxCostUsd,
            estimatedUsd: est.estimatedUsd,
          })
        );
      }
      if (est.estimatedUsd > maxCostUsd) {
        return yield* Effect.fail(
          new CostLimitError({
            message: `estimated review cost ~$${est.estimatedUsd.toFixed(2)} exceeds max-cost-usd $${maxCostUsd}`,
            limitUsd: maxCostUsd,
            estimatedUsd: est.estimatedUsd,
          })
        );
      }
    }

    const candidatesAll: Finding[] = [];
    if (chunks.length > 0) {
      // Prime the cache with the first chunk, then fan the rest out concurrently.
      const first = yield* generateCandidates(chunks[0]!, target, { ...options, system });
      cost.add(first.model, first.usage);
      candidatesAll.push(...first.findings);

      // Post-priming breaker. A single chunk has already been spent, so compare
      // that actual cost. Several chunks project the rest from the priming cost
      // and abort before the fan-out. Unknown prices fail closed either way.
      if (maxCostUsd !== undefined) {
        const firstResolved = resolvePrice(first.model, overrides);
        if (!firstResolved.known) {
          return yield* Effect.fail(
            new CostLimitError({
              message: `cannot enforce max-cost-usd $${maxCostUsd}: no known price for model "${first.model}" (set modelPrices)`,
              limitUsd: maxCostUsd,
            })
          );
        }
        const spentUsd = computeCost(first.model, first.usage, overrides);
        const projectedUsd = spentUsd * chunks.length;
        if (projectedUsd > maxCostUsd) {
          const message =
            chunks.length === 1
              ? `review cost ~$${spentUsd.toFixed(2)} exceeds max-cost-usd $${maxCostUsd}`
              : `projected review cost ~$${projectedUsd.toFixed(2)} across ${chunks.length} chunks exceeds max-cost-usd $${maxCostUsd}`;
          return yield* Effect.fail(
            new CostLimitError({
              message,
              limitUsd: maxCostUsd,
              estimatedUsd: projectedUsd,
              spentUsd,
            })
          );
        }
      }

      if (chunks.length > 1) {
        const rest = yield* Effect.forEach(
          chunks.slice(1),
          (chunk) => generateCandidates(chunk, target, { ...options, system }),
          { concurrency: options.reviewConcurrency ?? DEFAULT_REVIEW_CONCURRENCY }
        );
        for (const g of rest) {
          cost.add(g.model, g.usage);
          candidatesAll.push(...g.findings);
        }
      }
    }

    let candidates: readonly Finding[] = candidatesAll;
    let verifierDropped = 0;

    if (options.verify !== false && candidates.length > 0) {
      const verified = yield* verifyFindings(candidates, files, {
        concurrency: options.verifyConcurrency,
      });
      candidates = verified.kept;
      verifierDropped = verified.dropped.length;
      if (verified.model) cost.add(verified.model, verified.usage);
    }

    const { kept, dropped } = applyFilters(candidates, options);
    const summary = cost.summary();
    const summaryMarkdown = renderSummaryMarkdown(kept, {
      cost: summary,
      headSha: target?.headSha,
      chunkCount: chunks.length,
      skippedForSize: plan.skipped,
      oversizedFiles: plan.oversizedFiles,
    });

    return {
      findings: kept,
      candidateCount: candidatesAll.length,
      summaryMarkdown,
      cost: summary,
      dropped: { verifier: verifierDropped, filtered: dropped.length },
      chunkCount: chunks.length,
      skippedForSize: plan.skipped,
      oversizedFiles: plan.oversizedFiles,
    };
  });
}
