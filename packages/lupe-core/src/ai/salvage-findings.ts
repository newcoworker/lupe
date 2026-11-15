import { Finding, Findings, type Finding as FindingType } from '../finding';

export type SalvageResult =
  | { readonly ok: true; readonly findings: readonly FindingType[] }
  | { readonly ok: false; readonly error: string };

function stripFences(text: string): string {
  const trimmed = text.trim().replace(/^\uFEFF/, '');
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fence?.[1]?.trim() ?? trimmed;
}

/** Take the outermost JSON object or array, ignoring prose around it. */
function extractJson(text: string): string {
  const stripped = stripFences(text);
  const objectAt = stripped.indexOf('{');
  const arrayAt = stripped.indexOf('[');
  const start = objectAt === -1 ? arrayAt : arrayAt === -1 ? objectAt : Math.min(objectAt, arrayAt);
  if (start < 0) return stripped;
  const open = stripped[start];
  const close = open === '{' ? '}' : ']';
  const end = stripped.lastIndexOf(close);
  if (end <= start) return stripped.slice(start);
  return stripped.slice(start, end + 1);
}

function stripTrailingCommas(json: string): string {
  return json.replace(/,\s*([}\]])/g, '$1');
}

function issueText(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => {
      const path = issue.path.map((part) => String(part)).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

function asElementArray(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.elements)) return record.elements;
  if (Array.isArray(record.findings)) return record.findings;
  return undefined;
}

/**
 * Recover a findings array from model text the SDK rejected: markdown fences,
 * trailing commas, a raw array, or `{elements|findings: [...]}`.
 * Returns the validation error when the text still does not match `Finding`.
 */
export function salvageFindings(text: string | undefined): SalvageResult {
  if (!text || !text.trim()) return { ok: false, error: 'model returned no text' };
  const json = stripTrailingCommas(extractJson(text));
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `could not parse JSON: ${message}` };
  }

  const elements = asElementArray(parsed);
  if (elements) {
    const result = Findings.safeParse(elements);
    if (result.success) return { ok: true, findings: result.data };
    return { ok: false, error: issueText(result.error) };
  }

  const single = Finding.safeParse(parsed);
  if (single.success) return { ok: true, findings: [single.data] };
  return { ok: false, error: issueText(single.error) };
}
