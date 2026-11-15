/**
 * Bounds for one `readFile` tool call. A review step that slurps an entire
 * large file blows the context window and burns the step budget; the model
 * asks for the next range instead.
 */
export const READ_FILE_MAX_LINES = 400;
export const READ_FILE_MAX_BYTES = 32_768;

export interface ReadFileRequest {
  /** 1-based starting line. Values below 1 start at line 1. */
  readonly offset?: number;
  /** Maximum lines to return, still subject to {@link READ_FILE_MAX_LINES}. */
  readonly limit?: number;
}

/** Split on `\n`, dropping a trailing empty line from a final newline. `\r` is stripped. */
function fileLines(contents: string): readonly string[] {
  if (contents.length === 0) return [];
  const normalized = contents.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Cut `text` to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function truncateUtf8(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8');
  let end = Math.min(maxBytes, buf.length);
  while (end > 0) {
    const byte = buf[end];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) break;
    end -= 1;
  }
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Return a line window of `contents` for the model. The full original text is
 * returned unchanged when it fits. Otherwise the window is followed by a
 * truncation notice that names the next offset.
 */
export function windowFileText(contents: string, path: string, request: ReadFileRequest = {}): string {
  const lines = fileLines(contents);
  const total = lines.length;
  const start = Math.max(1, Math.floor(request.offset ?? 1));
  const lineCap = Math.max(1, Math.min(request.limit ?? READ_FILE_MAX_LINES, READ_FILE_MAX_LINES));

  if (total === 0) {
    return start > 1 ? `[lupe: ${path} is empty; offset ${start} is past the end.]` : contents;
  }
  if (start > total) {
    return `[lupe: ${path} has ${total} lines; offset ${start} is past the end.]`;
  }

  const selected: string[] = [];
  let bytes = 0;
  let hitByteCap = false;
  for (let i = start - 1; i < total && selected.length < lineCap; i += 1) {
    const line = lines[i] ?? '';
    const lineBytes = byteLength(line) + 1;
    if (selected.length > 0 && bytes + lineBytes > READ_FILE_MAX_BYTES) {
      hitByteCap = true;
      break;
    }
    if (selected.length === 0 && byteLength(line) > READ_FILE_MAX_BYTES) {
      selected.push(truncateUtf8(line, READ_FILE_MAX_BYTES));
      hitByteCap = true;
      break;
    }
    selected.push(line);
    bytes += lineBytes;
  }

  const end = start + selected.length - 1;
  const coversAll = start === 1 && end === total && !hitByteCap;
  if (coversAll) return contents;

  const next = end < total ? ` Call readFile with offset=${end + 1} to continue.` : '';
  const why = hitByteCap ? ` Byte cap is ${READ_FILE_MAX_BYTES}.` : '';
  const notice = `[lupe: truncated ${path}; showed lines ${start}-${end} of ${total}.${why}${next}]`;
  return `${selected.join('\n')}\n${notice}`;
}
