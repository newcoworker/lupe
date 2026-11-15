import type { DiffFile } from '../diff';
import { renderDiffPrompt } from '../render/diff-prompt';
import type { ReviewTarget } from '../review';

export type ReviewProfile = 'chill' | 'assertive';

export interface PathInstruction {
  readonly path: string;
  readonly instructions: string;
}

export interface PromptOptions {
  readonly profile?: ReviewProfile;
  /** Repo coding standards / conventions (CLAUDE.md, style guide, etc.). */
  readonly codingStandards?: string;
  readonly pathInstructions?: readonly PathInstruction[];
  /** Suppressed patterns learned from prior dismissed comments. */
  readonly learnings?: readonly string[];
  /**
   * Whether the generation backend has read-only repo tools (readFile/grep/etc).
   * The AI-SDK agent loop does; the opt-in local single-shot backends
   * (`claude-cli`/`codex-cli`) do NOT. When false, the prompt drops the
   * "use tools to confirm before reporting" guidance and restores a recall
   * bias (report from the shown diff, lower confidence instead of staying
   * silent) — otherwise a tool-less model reads "confirm first" as "report
   * nothing". Defaults to true (the API path). Publication is still gated by
   * the verifier + filter chain.
   */
  readonly hasTools?: boolean;
}

/** Work-method + calibration bullets that differ by whether the backend has repo tools. */
const WORK_METHOD_TOOLS = `- Use the read-only tools (readFile, listDir, grep) to gather surrounding context and confirm a problem before reporting it. Prefer to verify over to speculate. readFile takes a 1-based offset and a limit; each call is capped and says when it truncated, so request the next range instead of re-reading the whole file.`;
const WORK_METHOD_NOTOOLS = `- You are reviewing the diff AS SHOWN; you have NO tools to open other files. Read every changed hunk carefully and report each issue you can ground in the visible code. Do NOT stay silent merely because you cannot open another file to fully confirm something — report it and set confidence to reflect that uncertainty. A separate verification stage filters false positives, so favour surfacing a real risk over withholding it.`;

const CALIBRATE_TOOLS = `- Calibrate impact to reality: before asserting a runtime consequence (crash, OOM, data loss, overbooking, corruption, or a security breach), establish that the bad path is actually reachable AND that any precondition it depends on actually holds — trace the live caller and the data source / auth/validation boundary; do not assume them. A precondition is the "if" your impact rests on: an input being attacker- or tenant-controllable, a value being null, a branch being taken. If you cannot establish reachability or the precondition from the code, do NOT raise it as a medium-or-higher (or security-category) finding: downgrade to low/info as a hardening note and lower confidence. Conditional phrasing ("if X were controllable …") is NOT a substitute for verifying X — verify it or downgrade. When quantifying impact, reason from realistic/default configured values, not theoretical maximums; cite hard caps as upper bounds, never as the expected cost.`;
const CALIBRATE_NOTOOLS = `- Calibrate severity to the real consequence, but do NOT suppress: when a finding's impact depends on a precondition you cannot see in the shown diff (an off-file caller, an external contract, an input's controllability, a value being null), still REPORT it — lower its confidence and keep its severity modest (a separate verifier caps or drops over-reach) rather than staying silent or asserting the worst case. When quantifying impact, reason from realistic/default configured values, not theoretical maximums.`;

function baseSystem(hasTools: boolean): string {
  return `You are lupe, a precise senior code reviewer. You review a pull-request diff and report only real, defensible problems in the CHANGED code.

What to look for (in priority order):
1. correctness — logic errors, off-by-one, wrong conditionals, broken control flow, incorrect API usage.
2. security — injection, auth/authz gaps, unsafe deserialization, secret leakage, SSRF, path traversal, exposing credentials/tokens to the client, trusting client-supplied flags the server should decide.
3. data-loss / resource-leak — unclosed handles, dropped errors, unbounded growth, race conditions, concurrency hazards.
4. error-handling — swallowed exceptions, missing failure paths, unhandled rejections.
5. performance — N+1 queries, unbounded queries (missing LIMIT), accidental quadratic work, needless allocations in hot paths.
6. api-misuse / maintainability — contract violations, footguns. (advisory)

How to work:
- The user message contains the diff with head line numbers. ONLY comment on lines that appear in the diff.
${hasTools ? WORK_METHOD_TOOLS : WORK_METHOD_NOTOOLS}
- Detect broadly (favor recall), but each reported finding must be something you can defend with concrete evidence from the code. A separate verifier will drop ungrounded findings, so include real "evidence" entries (path + line range) for every finding.
${hasTools ? CALIBRATE_TOOLS : CALIBRATE_NOTOOLS}
- Severity reflects the real consequence: a finding whose only effect is inaccurate or misleading documentation/comments (the code itself behaves correctly and consistently), or a trivial style/hygiene nit, is maintainability at low/info — never medium+. Reserve medium+ for a real behavioural consequence, and remember an impact that depends on a component outside this repo (an external loader/runtime/service) is unproven — keep it low.
- Do NOT report: style nits unless they cause bugs, things already handled nearby, hypotheticals not reachable in this code, or pre-existing issues outside the diff.

For each finding set:
- ruleId: "lupe/<category>/<slug>" (e.g. "lupe/security/sql-injection").
- path/startLine/endLine/side: anchor to exact diff lines. side=RIGHT for added/context lines, LEFT for deleted lines.
- severity: critical|high|medium|low|info. category: one of the taxonomy values.
- message: a concise explanation of the problem and the fix, in markdown.
- suggestion: ONLY when you can give a correct, complete drop-in replacement (no diff markers) that actually fixes the problem and changes behavior. It must be valid code for the file's language — never a no-op, a placeholder, or an edit that leaves the bug in place (e.g. an expression that always evaluates to the same value). If you cannot produce a fix you are confident is correct, omit suggestion and describe the fix in the message instead.
- confidence: 0..1, honestly calibrated. Reserve >0.8 for problems you have verified.
- evidence: the code locations that justify the finding.

If the diff has no real problems, return an empty list.`;
}

const PROFILE_NOTE: Record<ReviewProfile, string> = {
  chill: '\n\nProfile: CHILL. Report only medium+ severity, high-confidence problems. Suppress nitpicks entirely.',
  assertive:
    '\n\nProfile: ASSERTIVE. Surface lower-severity and lower-confidence issues too, clearly marked, but never fabricate.',
};

/** Build the frozen, cacheable system prefix (system + standards + path rules + learnings). */
export function buildSystemPrompt(options: PromptOptions = {}): string {
  let out = baseSystem(options.hasTools ?? true) + PROFILE_NOTE[options.profile ?? 'chill'];

  if (options.codingStandards && options.codingStandards.trim()) {
    out += `\n\n## Project coding standards\n${options.codingStandards.trim()}`;
  }
  if (options.pathInstructions && options.pathInstructions.length > 0) {
    out += `\n\n## Path-specific instructions`;
    for (const pi of options.pathInstructions) {
      out += `\n- For files matching \`${pi.path}\`: ${pi.instructions}`;
    }
  }
  if (options.learnings && options.learnings.length > 0) {
    out += `\n\n## Learned suppressions (do NOT report these; they were dismissed before)`;
    for (const l of options.learnings) out += `\n- ${l}`;
  }
  return out;
}

/** Build the volatile per-PR user prompt (placed after the cache breakpoint). */
export function buildReviewPrompt(files: readonly DiffFile[], target?: ReviewTarget): string {
  const parts: string[] = [];
  if (target?.title) parts.push(`PR title: ${target.title}`);
  if (target?.body) parts.push(`PR description:\n${target.body}`);
  parts.push(
    `Review the following diff (${files.length} ${files.length === 1 ? 'file' : 'files'}). ` +
      `Anchor every finding to a line shown below.`
  );
  parts.push(renderDiffPrompt(files));
  return parts.join('\n\n');
}
