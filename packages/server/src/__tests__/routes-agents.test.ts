import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryDataStore } from '../store/memory.js';
import { createApp } from '../index.js';
import { agentStatus } from '../routes/agents.js';
import type { AgentsResponse } from '@opencara/shared';
import { stubOAuthFetch, OAUTH_HEADERS } from './test-oauth-helper.js';

const mockEnv = {
  GITHUB_WEBHOOK_SECRET: 'test-secret',
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: 'test-key',
  WEB_URL: 'https://test.com',
  GITHUB_CLIENT_ID: 'cid',
  GITHUB_CLIENT_SECRET: 'csecret',
};

describe('Agent Routes', () => {
  beforeEach(() => {
    stubOAuthFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /api/agents — empty state', () => {
    it('returns empty agents array when no heartbeats exist', async () => {
      const store = new MemoryDataStore();
      const app = createApp(store);
      const res = await app.request(
        '/api/agents',
        { method: 'GET', headers: OAUTH_HEADERS },
        mockEnv,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as AgentsResponse;
      expect(body.agents).toEqual([]);
    });
  });

  describe('GET /api/agents — active agents', () => {
    it('returns agents seen within default 24-hour window', async () => {
      const store = new MemoryDataStore();
      const now = Date.now();
      await store.setAgentLastSeen('agent-1', now - 60_000); // 1 min ago
      await store.setAgentLastSeen('agent-2', now - 120_000); // 2 min ago

      const app = createApp(store);
      const res = await app.request(
        '/api/agents',
        { method: 'GET', headers: OAUTH_HEADERS },
        mockEnv,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as AgentsResponse;
      expect(body.agents).toHaveLength(2);
      expect(body.agents.map((a) => a.agent_id).sort()).toEqual(['agent-1', 'agent-2']);
    });

    it('classifies recently-seen agents as active', async () => {
      const store = new MemoryDataStore();
      const now = Date.now();
      await store.setAgentLastSeen('agent-1', now - 60_000); // 1 min ago — active

      const app = createApp(store);
      const res = await app.request(
        '/api/agents',
        { method: 'GET', headers: OAUTH_HEADERS },
        mockEnv,
      );
      const body = (await res.json()) as AgentsResponse;
      expect(body.agents[0].status).toBe('active');
    });
  });

  describe('GET /api/agents — idle and offline agents', () => {
    it('classifies agents seen 10 min ago as idle', async () => {
      const store = new MemoryDataStore();
      const now = Date.now();
      await store.setAgentLastSeen('agent-1', now - 10 * 60_000); // 10 min ago — idle

      const app = createApp(store);
      const res = await app.request(
        '/api/agents',
        { method: 'GET', headers: OAUTH_HEADERS },
        mockEnv,
      );
      const body = (await res.json()) as AgentsResponse;
      expect(body.agents[0].status).toBe('idle');
    });

    it('classifies agents seen 31 min ago as offline', async () => {
      const store = new MemoryDataStore();
      const now = Date.now();
      await store.setAgentLastSeen('agent-1', now - 31 * 60_000); // 31 min ago — offline

      const app = createApp(store);
      const res = await app.request(
        '/api/agents',
        { method: 'GET', headers: OAUTH_HEADERS },
        mockEnv,
      );
      const body = (await res.json()) as AgentsResponse;
      expect(body.agents[0].status).toBe('offline');
    });
  });

  describe('GET /api/agents — claim stats', () => {
    it('returns accurate claim stats per agent', async () => {
      const store = new MemoryDataStore();
      const now = Date.now();
      await store.setAgentLastSeen('agent-1', now);

      // Create claims with various statuses
      await store.createTask({
        id: 'task-1',
        owner: 'org',
        repo: 'repo',
        pr_number: 1,
        pr_url: 'https://github.com/org/repo/pull/1',
        diff_url: 'https://github.com/org/repo/pull/1.diff',
        base_ref: 'main',
        head_ref: 'feat',
        review_count: 3,
        prompt: 'Review',
        timeout_at: now + 600_000,
        status: 'reviewing',
        queue: 'review',
        github_installation_id: 1,
        private: false,
        config: { review_count: 3, trigger: { on: 'pull_request' } },
        created_at: now,
        review_claims: 1,
        completed_reviews: 0,
        task_type: 'review',
        feature: 'review',
        group_id: 'group-1',
      });

      await store.createClaim({
        id: 'claim-1',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'review',
        status: 'completed',
        created_at: now,
      });
      // Use a different task for second claim to avoid UNIQUE(task_id, agent_id, role)
      await store.createTask({
        id: 'task-2',
        owner: 'org',
        repo: 'repo',
        pr_number: 2,
        pr_url: 'https://github.com/org/repo/pull/2',
        diff_url: 'https://github.com/org/repo/pull/2.diff',
        base_ref: 'main',
        head_ref: 'feat2',
        review_count: 3,
        prompt: 'Review',
        timeout_at: now + 600_000,
        status: 'reviewing',
        queue: 'review',
        github_installation_id: 1,
        private: false,
        config: { review_count: 3, trigger: { on: 'pull_request' } },
        created_at: now,
        review_claims: 1,
        completed_reviews: 0,
        task_type: 'review',
        feature: 'review',
        group_id: 'group-2',
      });
      await store.createClaim({
        id: 'claim-2',
        task_id: 'task-2',
        agent_id: 'agent-1',
        role: 'review',
        status: 'pending',
        created_at: now,
      });

      // Summary claim (different role on task-1)
      await store.createClaim({
        id: 'claim-3',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'summary',
        status: 'error',
        created_at: now,
      });

      const app = createApp(store);
      const res = await app.request(
        '/api/agents',
        { method: 'GET', headers: OAUTH_HEADERS },
        mockEnv,
      );
      const body = (await res.json()) as AgentsResponse;
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0].claims).toEqual({
        total: 3,
        completed: 1,
        rejected: 0,
        error: 1,
        pending: 1,
      });
    });

    it('returns zero stats for agent with no claims', async () => {
      const store = new MemoryDataStore();
      await store.setAgentLastSeen('agent-no-claims', Date.now());

      const app = createApp(store);
      const res = await app.request(
        '/api/agents',
        { method: 'GET', headers: OAUTH_HEADERS },
        mockEnv,
      );
      const body = (await res.json()) as AgentsResponse;
      expect(body.agents[0].claims).toEqual({
        total: 0,
        completed: 0,
        rejected: 0,
        error: 0,
        pending: 0,
      });
    });
  });

  describe('GET /api/agents — active_since filter', () => {
    it('filters agents by active_since parameter', async () => {
      const store = new MemoryDataStore();
      const now = Date.now();
      await store.setAgentLastSeen('recent-agent', now - 60_000);
      await store.setAgentLastSeen('old-agent', now - 2 * 60 * 60_000); // 2 hours ago

      const app = createApp(store);
      // Only show agents seen in last hour
      const sinceMs = now - 60 * 60_000;
      const res = await app.request(
        `/api/agents?active_since=${sinceMs}`,
        { method: 'GET', headers: OAUTH_HEADERS },
        mockEnv,
      );
      const body = (await res.json()) as AgentsResponse;
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0].agent_id).toBe('recent-agent');
    });

    it('returns 400 for invalid active_since', async () => {
      const store = new MemoryDataStore();
      const app = createApp(store);
      const res = await app.request(
        '/api/agents?active_since=not-a-number',
        { method: 'GET', headers: OAUTH_HEADERS },
        mockEnv,
      );
      expect(res.status).toBe(400);
    });

    it('returns 400 for negative active_since', async () => {
      const store = new MemoryDataStore();
      const app = createApp(store);
      const res = await app.request(
        '/api/agents?active_since=-1',
        { method: 'GET', headers: OAUTH_HEADERS },
        mockEnv,
      );
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/agents — stale agents excluded', () => {
    it('excludes agents whose last_seen is before the default 24-hour window', async () => {
      const store = new MemoryDataStore();
      const now = Date.now();
      // 25 hours ago — beyond default 24-hour window
      await store.setAgentLastSeen('stale-agent', now - 25 * 60 * 60_000);
      await store.setAgentLastSeen('fresh-agent', now - 60_000);

      const app = createApp(store);
      const res = await app.request(
        '/api/agents',
        { method: 'GET', headers: OAUTH_HEADERS },
        mockEnv,
      );
      const body = (await res.json()) as AgentsResponse;
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0].agent_id).toBe('fresh-agent');
    });
  });

  describe('GET /api/agents — auth', () => {
    it('requires OAuth token', async () => {
      const store = new MemoryDataStore();
      const app = createApp(store);
      const res = await app.request('/api/agents', { method: 'GET' }, mockEnv);
      expect(res.status).toBe(401);
    });

    it('allows access with valid OAuth token', async () => {
      const store = new MemoryDataStore();
      const app = createApp(store);
      const res = await app.request(
        '/api/agents',
        { method: 'GET', headers: OAUTH_HEADERS },
        mockEnv,
      );
      expect(res.status).toBe(200);
    });
  });

  describe('agentStatus', () => {
    it('returns active for agents seen within 5 min', () => {
      const now = Date.now();
      expect(agentStatus(now, now)).toBe('active');
      expect(agentStatus(now - 4 * 60_000, now)).toBe('active');
      expect(agentStatus(now - 5 * 60_000, now)).toBe('active');
    });

    it('returns idle for agents seen between 5-30 min ago', () => {
      const now = Date.now();
      expect(agentStatus(now - 5 * 60_000 - 1, now)).toBe('idle');
      expect(agentStatus(now - 15 * 60_000, now)).toBe('idle');
      expect(agentStatus(now - 30 * 60_000, now)).toBe('idle');
    });

    it('returns offline for agents seen more than 30 min ago', () => {
      const now = Date.now();
      expect(agentStatus(now - 30 * 60_000 - 1, now)).toBe('offline');
      expect(agentStatus(now - 60 * 60_000, now)).toBe('offline');
    });
  });
});
