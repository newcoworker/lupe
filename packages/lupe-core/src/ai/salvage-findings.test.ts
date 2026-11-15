import { describe, expect, test } from 'vitest';

import { salvageFindings } from './salvage-findings';

const FINDING = {
  ruleId: 'lupe/correctness/off-by-one',
  title: 'Off by one',
  path: 'a.ts',
  startLine: 1,
  endLine: 1,
  side: 'RIGHT',
  severity: 'high',
  category: 'correctness',
  message: 'The loop bound is exclusive.',
  confidence: 0.9,
  evidence: [],
};

describe('salvageFindings', () => {
  test('repairs fenced JSON with a trailing comma', () => {
    const text = `\`\`\`json\n{"elements":[${JSON.stringify(FINDING)},]}\n\`\`\``;
    const result = salvageFindings(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.findings).toHaveLength(1);
  });

  test('accepts a raw findings array', () => {
    const result = salvageFindings(JSON.stringify([FINDING]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.findings[0]?.ruleId).toBe(FINDING.ruleId);
  });

  test('returns the validation error when fields are missing', () => {
    const result = salvageFindings('{"elements":[{"title":"nope"}]}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/ruleId/);
  });

  test('rejects empty text', () => {
    expect(salvageFindings('  ').ok).toBe(false);
  });
});
