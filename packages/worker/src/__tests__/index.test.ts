import { describe, it, expect } from 'vitest';
import worker from '../index.js';

describe('worker', () => {
  it('responds with 200 OK', async () => {
    const response = await worker.fetch(new Request('http://localhost'));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('OK');
  });
});
