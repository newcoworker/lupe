import { describe, expect, test } from 'vitest';

import { StructuredFindingsFailure } from './collect-findings';
import { formatFailureDetail } from './failure-detail';

describe('formatFailureDetail', () => {
  test('includes finish reason, step count, cause, and a text snippet', () => {
    const cause = Object.assign(new Error('No object generated: could not parse the response.'), {
      text: 'NOT-JSON-SNIPPET trailing garbage',
      finishReason: 'stop',
    });
    const error = new StructuredFindingsFailure('model did not produce valid structured findings', {
      cause,
      finishReason: 'tool-calls',
      steps: 12,
      text: 'NOT-JSON-SNIPPET trailing garbage',
    });
    const detail = formatFailureDetail(error);
    expect(detail).toContain('finishReason=tool-calls');
    expect(detail).toContain('steps=12');
    expect(detail).toContain('could not parse the response');
    expect(detail).toContain('NOT-JSON-SNIPPET');
  });

  test('includes provider status and response body', () => {
    const error = Object.assign(new Error('connection reset by peer'), {
      statusCode: 503,
      responseBody: 'upstream timed out',
    });
    const detail = formatFailureDetail(error);
    expect(detail).toContain('status=503');
    expect(detail).toContain('upstream timed out');
  });
});
