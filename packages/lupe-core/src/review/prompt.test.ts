import { describe, expect, test } from 'vitest';

import { buildSystemPrompt } from './prompt';

describe('buildSystemPrompt — coding standards in the cached prefix', () => {
  test('embeds coding standards under a stable heading', () => {
    const out = buildSystemPrompt({ codingStandards: 'Always use tabs.' });
    expect(out).toContain('## Project coding standards');
    expect(out).toContain('Always use tabs.');
  });

  test('is byte-identical for identical options (Anthropic prompt-cache prefix must not drift)', () => {
    const opts = { profile: 'chill' as const, codingStandards: '## From AGENTS.md\nbe precise' };
    expect(buildSystemPrompt(opts)).toBe(buildSystemPrompt(opts));
  });

  test('omits the section entirely when there are no standards (no empty heading)', () => {
    expect(buildSystemPrompt({})).not.toContain('## Project coding standards');
  });

  test('instructs reachability-aware impact calibration and bans no-op suggestions', () => {
    const out = buildSystemPrompt({});
    expect(out).toMatch(/reachable/i);
    expect(out).toMatch(/no-op/i);
  });

  test('instructs that documentation-only findings stay low severity', () => {
    const out = buildSystemPrompt({});
    expect(out).toMatch(/documentation/i);
    expect(out).toMatch(/never medium\+/i);
  });
});

describe('buildSystemPrompt — tool-awareness (hasTools)', () => {
  test('default (API path) keeps the tool-based confirm-before-reporting guidance', () => {
    const out = buildSystemPrompt({});
    expect(out).toContain('Use the read-only tools');
    expect(out).toContain('offset');
    expect(out).toMatch(/truncat/i);
    expect(out).not.toContain('you have NO tools');
  });

  test('hasTools:false (local single-shot backend) switches to a no-tools, recall-biased variant', () => {
    const out = buildSystemPrompt({ hasTools: false });
    expect(out).toContain('you have NO tools');
    expect(out).toMatch(/do not stay silent/i);
    expect(out).not.toContain('Use the read-only tools');
    // It must not tell a tool-less model to downgrade/withhold when it cannot trace a precondition.
    expect(out).not.toMatch(/trace the live caller/i);
    expect(out).toMatch(/do NOT suppress/i);
  });
});
