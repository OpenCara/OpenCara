/**
 * Tests for build404Hint — the 404 diff-fetch hint text.
 *
 * Covers the two branches of the hint:
 * - gh CLI authenticated: hint points at PR-not-found / install missing repo /
 *   transient outage, and does NOT suggest installing/authenticating gh.
 * - gh CLI absent or unauthenticated: hint keeps the install/login guidance.
 */
import { describe, it, expect } from 'vitest';

// Must mock tool-executor since agent.ts imports it at module load.
import { vi } from 'vitest';
vi.mock('../tool-executor.js', () => ({
  executeTool: vi.fn(),
  estimateTokens: (text: string) => Math.ceil(text.length / 4),
  validateCommandBinary: vi.fn(() => true),
  parseCommandTemplate: (cmd: string) => cmd.split(' '),
  testCommand: vi.fn(async () => ({ ok: true, elapsedMs: 100 })),
}));

import { build404Hint } from '../commands/agent.js';

describe('build404Hint', () => {
  it('returns the authenticated-branch hint when gh auth passes', () => {
    const hint = build404Hint(true);

    // Leads with a period+space so it appends cleanly to the base error message.
    expect(hint.startsWith('. ')).toBe(true);
    // Authenticated branch must NOT suggest installing or logging into gh —
    // the whole point of this issue is to stop blaming auth when auth is fine.
    expect(hint).not.toMatch(/gh auth login/);
    expect(hint).not.toMatch(/ensure gh CLI is installed/);
    // It should enumerate the real plausible causes.
    expect(hint).toMatch(/PR not found/);
    expect(hint).toMatch(/transient GitHub outage/i);
    // And point operators at the underlying gh-api warning if there was one.
    expect(hint).toMatch(/\[fetchDiffViaGh\]/);
  });

  it('returns the install/login hint when gh auth fails or gh is missing', () => {
    const hint = build404Hint(false);

    expect(hint.startsWith('. ')).toBe(true);
    // Keeps the original actionable guidance for users without gh.
    expect(hint).toMatch(/gh CLI is installed and authenticated/);
    expect(hint).toMatch(/gh auth login/);
  });

  it('produces distinct text for the two branches', () => {
    expect(build404Hint(true)).not.toEqual(build404Hint(false));
  });
});
