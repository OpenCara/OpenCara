import { describe, it, expect } from 'vitest';
import type { RepoFilterMode, RepoConfig, Agent } from './types.js';
import type { AgentPreferencesMessage } from './protocol.js';
import type { AgentResponse, CreateAgentRequest } from './api.js';

describe('RepoConfig types', () => {
  it('RepoFilterMode accepts all valid modes', () => {
    const modes: RepoFilterMode[] = ['all', 'own', 'whitelist', 'blacklist'];
    expect(modes).toHaveLength(4);
  });

  it('RepoConfig with mode only (no list)', () => {
    const config: RepoConfig = { mode: 'all' };
    expect(config.mode).toBe('all');
    expect(config.list).toBeUndefined();
  });

  it('RepoConfig with whitelist mode and list', () => {
    const config: RepoConfig = {
      mode: 'whitelist',
      list: ['OpenCara/OpenCara', 'myorg/my-project'],
    };
    expect(config.mode).toBe('whitelist');
    expect(config.list).toEqual(['OpenCara/OpenCara', 'myorg/my-project']);
  });

  it('RepoConfig with blacklist mode and list', () => {
    const config: RepoConfig = {
      mode: 'blacklist',
      list: ['spam-org/spam-repo'],
    };
    expect(config.mode).toBe('blacklist');
    expect(config.list).toEqual(['spam-org/spam-repo']);
  });

  it('RepoConfig with own mode', () => {
    const config: RepoConfig = { mode: 'own' };
    expect(config.mode).toBe('own');
  });

  it('Agent interface includes repo_config field', () => {
    const agent: Agent = {
      id: 'agent-1',
      user_id: 'user-1',
      model: 'claude-sonnet-4-6',
      tool: 'claude-code',
      reputation_score: 0.5,
      status: 'online',
      last_heartbeat_at: null,
      repo_config: { mode: 'whitelist', list: ['owner/repo'] },
      created_at: '2024-01-01T00:00:00Z',
    };
    expect(agent.repo_config).toEqual({ mode: 'whitelist', list: ['owner/repo'] });
  });

  it('Agent interface allows null repo_config', () => {
    const agent: Agent = {
      id: 'agent-1',
      user_id: 'user-1',
      model: 'claude-sonnet-4-6',
      tool: 'claude-code',
      reputation_score: 0.5,
      status: 'online',
      last_heartbeat_at: null,
      repo_config: null,
      created_at: '2024-01-01T00:00:00Z',
    };
    expect(agent.repo_config).toBeNull();
  });
});

describe('AgentPreferencesMessage protocol type', () => {
  it('creates a valid agent_preferences message', () => {
    const msg: AgentPreferencesMessage = {
      id: 'msg-1',
      timestamp: Date.now(),
      type: 'agent_preferences',
      repoConfig: { mode: 'whitelist', list: ['owner/repo'] },
    };
    expect(msg.type).toBe('agent_preferences');
    expect(msg.repoConfig.mode).toBe('whitelist');
    expect(msg.repoConfig.list).toEqual(['owner/repo']);
  });

  it('creates message with all mode (no list)', () => {
    const msg: AgentPreferencesMessage = {
      id: 'msg-2',
      timestamp: Date.now(),
      type: 'agent_preferences',
      repoConfig: { mode: 'all' },
    };
    expect(msg.type).toBe('agent_preferences');
    expect(msg.repoConfig.mode).toBe('all');
    expect(msg.repoConfig.list).toBeUndefined();
  });
});

describe('API types include repo config', () => {
  it('AgentResponse includes repoConfig field', () => {
    const response: AgentResponse = {
      id: 'agent-1',
      model: 'claude-sonnet-4-6',
      tool: 'claude-code',
      status: 'online',
      repoConfig: { mode: 'own' },
      createdAt: '2024-01-01T00:00:00Z',
    };
    expect(response.repoConfig).toEqual({ mode: 'own' });
  });

  it('AgentResponse allows null repoConfig', () => {
    const response: AgentResponse = {
      id: 'agent-1',
      model: 'claude-sonnet-4-6',
      tool: 'claude-code',
      status: 'online',
      repoConfig: null,
      createdAt: '2024-01-01T00:00:00Z',
    };
    expect(response.repoConfig).toBeNull();
  });

  it('CreateAgentRequest with repoConfig', () => {
    const request: CreateAgentRequest = {
      model: 'claude-sonnet-4-6',
      tool: 'claude-code',
      repoConfig: { mode: 'blacklist', list: ['spam/repo'] },
    };
    expect(request.repoConfig).toEqual({ mode: 'blacklist', list: ['spam/repo'] });
  });

  it('CreateAgentRequest without repoConfig (backward compatible)', () => {
    const request: CreateAgentRequest = {
      model: 'claude-sonnet-4-6',
      tool: 'claude-code',
    };
    expect(request.repoConfig).toBeUndefined();
  });
});
