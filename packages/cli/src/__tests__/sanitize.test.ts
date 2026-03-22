import { describe, it, expect } from 'vitest';
import { sanitizeTokens } from '../sanitize.js';

describe('sanitizeTokens', () => {
  it('strips ghp_ tokens', () => {
    expect(sanitizeTokens('token is ghp_abc123DEF456')).toBe('token is ***');
  });

  it('strips gho_ tokens', () => {
    expect(sanitizeTokens('token is gho_abc123DEF456')).toBe('token is ***');
  });

  it('strips ghs_ tokens', () => {
    expect(sanitizeTokens('token is ghs_abc123DEF456')).toBe('token is ***');
  });

  it('strips ghr_ tokens', () => {
    expect(sanitizeTokens('token is ghr_abc123DEF456')).toBe('token is ***');
  });

  it('strips github_pat_ tokens', () => {
    expect(sanitizeTokens('token is github_pat_abc123DEF456_xyz')).toBe('token is ***');
  });

  it('strips x-access-token from URLs', () => {
    expect(sanitizeTokens('https://x-access-token:ghp_secret@github.com/org/repo.git')).toBe(
      'https://x-access-token:***@github.com/org/repo.git',
    );
  });

  it('strips Authorization header values', () => {
    expect(sanitizeTokens('Authorization: token ghp_secret123')).toBe('Authorization: ***');
    expect(sanitizeTokens('Authorization: Bearer ghp_secret123')).toBe('Authorization: ***');
  });

  it('strips non-GitHub tokens from Authorization headers', () => {
    expect(sanitizeTokens('Authorization: token app-generated-secret')).toBe('Authorization: ***');
  });

  it('strips Authorization header case-insensitively', () => {
    expect(sanitizeTokens('authorization: bearer some_secret')).toBe('authorization: ***');
  });

  it('strips multiple tokens from a single string', () => {
    const input = 'token1=ghp_abc token2=ghs_def url=https://x-access-token:secret@github.com';
    const result = sanitizeTokens(input);
    expect(result).not.toContain('ghp_abc');
    expect(result).not.toContain('ghs_def');
    expect(result).not.toContain('secret');
  });

  it('returns input unchanged when no tokens present', () => {
    const input = 'This is a normal log message with no secrets';
    expect(sanitizeTokens(input)).toBe(input);
  });

  it('handles empty string', () => {
    expect(sanitizeTokens('')).toBe('');
  });

  it('strips tokens from git error messages', () => {
    const err =
      'fatal: repository https://x-access-token:ghp_realtoken@github.com/org/repo.git not found';
    const result = sanitizeTokens(err);
    expect(result).not.toContain('ghp_realtoken');
    expect(result).toContain('x-access-token:***@');
  });

  it('strips tokens from review text containing git URLs', () => {
    const review = `## Summary
The code looks good.

## Findings
- **minor** \`config.ts:10\` — Remote URL contains token: https://x-access-token:ghp_test123@github.com/org/repo.git

## Verdict
APPROVE`;
    const result = sanitizeTokens(review);
    expect(result).not.toContain('ghp_test123');
    expect(result).toContain('x-access-token:***@');
  });
});
