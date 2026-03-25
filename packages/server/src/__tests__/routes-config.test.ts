import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDataStore } from '../store/memory.js';
import { createApp } from '../index.js';
import { resetRateLimits } from '../middleware/rate-limit.js';

const mockEnv = {
  GITHUB_WEBHOOK_SECRET: 'test-secret',
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: 'test-key',
  WEB_URL: 'https://test.com',
};

function postValidate(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request(
    '/api/config/validate',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    mockEnv,
  );
}

describe('POST /api/config/validate', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    resetRateLimits();
    app = createApp(new MemoryDataStore());
  });

  it('returns valid config for correct YAML', async () => {
    const yaml = `version: 1\nprompt: "Review this PR"\nagents:\n  review_count: 3`;
    const res = await postValidate(app, { yaml });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.config).toBeDefined();
    expect(body.config.version).toBe(1);
    expect(body.config.prompt).toBe('Review this PR');
    expect(body.config.agents.reviewCount).toBe(3);
  });

  it('returns error for invalid YAML syntax', async () => {
    const yaml = '{{invalid yaml';
    const res = await postValidate(app, { yaml });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.error).toBe('Invalid YAML syntax');
  });

  it('returns error for missing required fields', async () => {
    const yaml = 'version: 1';
    const res = await postValidate(app, { yaml });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.error).toContain('prompt');
  });

  it('returns error when version is missing', async () => {
    const yaml = 'prompt: "hello"';
    const res = await postValidate(app, { yaml });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.error).toContain('version');
  });

  it('returns error when YAML is not an object', async () => {
    const yaml = '- item1\n- item2';
    const res = await postValidate(app, { yaml });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.error).toBe('Configuration must be a YAML object');
  });

  it('returns 400 when yaml field is missing', async () => {
    const res = await postValidate(app, {});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_REQUEST');
    expect(body.error.message).toContain('yaml');
  });

  it('returns 400 when yaml field is not a string', async () => {
    const res = await postValidate(app, { yaml: 123 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_REQUEST');
  });

  it('returns 400 for malformed JSON body', async () => {
    const res = await app.request(
      '/api/config/validate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      },
      mockEnv,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_REQUEST');
    expect(body.error.message).toContain('Malformed');
  });

  it('returns 400 when body is an array', async () => {
    const res = await app.request(
      '/api/config/validate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ yaml: 'test' }]),
      },
      mockEnv,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_REQUEST');
  });

  it('does not require authentication', async () => {
    const yaml = 'version: 1\nprompt: "test"';
    const res = await postValidate(app, { yaml });
    // No Authorization header — should still work
    expect(res.status).toBe(200);
  });

  it('fills in default values for optional fields', async () => {
    const yaml = 'version: 1\nprompt: "Review this"';
    const res = await postValidate(app, { yaml });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.config.trigger.on).toEqual(['opened']);
    expect(body.config.agents.reviewCount).toBe(1);
    expect(body.config.timeout).toBe('10m');
  });

  it('parses full config with all sections', async () => {
    const yaml = [
      'version: 1',
      'prompt: "Full review"',
      'trigger:',
      '  on: [opened, synchronize]',
      '  comment: "/review"',
      '  skip: [draft]',
      'agents:',
      '  review_count: 5',
      '  preferred_models: [claude-opus-4-6]',
      '  preferred_tools: [claude]',
      'reviewer:',
      '  allow_anonymous: false',
      'timeout: 15m',
    ].join('\n');
    const res = await postValidate(app, { yaml });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.config.trigger.on).toEqual(['opened', 'synchronize']);
    expect(body.config.trigger.comment).toBe('/review');
    expect(body.config.agents.reviewCount).toBe(5);
    expect(body.config.agents.preferredModels).toEqual(['claude-opus-4-6']);
    expect(body.config.timeout).toBe('15m');
  });

  it('is rate limited by IP', async () => {
    // Send 60 requests to exhaust the limit
    for (let i = 0; i < 60; i++) {
      await postValidate(app, { yaml: 'version: 1\nprompt: "test"' });
    }
    // 61st should be rate limited
    const res = await postValidate(app, { yaml: 'version: 1\nprompt: "test"' });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('RATE_LIMITED');
  });
});
