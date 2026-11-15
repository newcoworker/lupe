const SNIPPET_CHARS = 400;

function snippet(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS)}…` : flat;
}

function chain(error: unknown): unknown[] {
  const out: unknown[] = [];
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object' && !out.includes(current); depth += 1) {
    out.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return out;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}

function readFinish(error: unknown): string | undefined {
  for (const item of chain(error)) {
    if (!item || typeof item !== 'object') continue;
    const finish = (item as { finishReason?: unknown }).finishReason;
    if (typeof finish === 'string' && finish) return finish;
    if (finish && typeof finish === 'object') {
      const unified = (finish as { unified?: unknown }).unified;
      if (typeof unified === 'string' && unified) return unified;
    }
  }
  return undefined;
}

function readSteps(error: unknown): number | undefined {
  for (const item of chain(error)) {
    const steps = numberField(item, 'steps') ?? numberField(item, 'stepCount');
    if (steps !== undefined) return steps;
  }
  return undefined;
}

function readText(error: unknown): string | undefined {
  for (const item of chain(error)) {
    const text = stringField(item, 'text');
    if (text) return text;
  }
  return undefined;
}

function readStatus(error: unknown): number | undefined {
  for (const item of chain(error)) {
    const status = numberField(item, 'statusCode') ?? numberField(item, 'status');
    if (status !== undefined) return status;
  }
  return undefined;
}

function readBody(error: unknown): string | undefined {
  for (const item of chain(error)) {
    const body = stringField(item, 'responseBody');
    if (body) return body;
  }
  return undefined;
}

function readCauseMessage(error: unknown): string | undefined {
  const cause = error && typeof error === 'object' ? (error as { cause?: unknown }).cause : undefined;
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === 'string' && cause) return cause;
  if (cause && typeof cause === 'object') {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return undefined;
}

/**
 * Diagnostic suffix for a model failure: finish reason, step count, provider
 * status/body, the underlying cause, and a short raw-text snippet. The action
 * prints `error.message`, so callers append this there and log it.
 */
export function formatFailureDetail(error: unknown): string {
  const parts: string[] = [];
  const finish = readFinish(error);
  if (finish) parts.push(`finishReason=${finish}`);
  const steps = readSteps(error);
  if (steps !== undefined) parts.push(`steps=${steps}`);
  const status = readStatus(error);
  if (status !== undefined) parts.push(`status=${status}`);
  const own = error instanceof Error ? error.message : undefined;
  const causeMessage = readCauseMessage(error);
  if (causeMessage && causeMessage !== own) parts.push(`cause=${causeMessage}`);
  const text = snippet(readText(error));
  if (text) parts.push(`text=${JSON.stringify(text)}`);
  const body = snippet(readBody(error));
  if (body && body !== text) parts.push(`providerBody=${JSON.stringify(body)}`);
  return parts.join('; ').slice(0, 1500);
}
