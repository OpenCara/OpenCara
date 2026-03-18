import { describe, it, expect } from 'vitest';
import {
  parseTimeoutMs,
  filterByAccessList,
  filterByRepoConfig,
  selectAgents,
  type EligibleAgent,
} from '../task-distribution.js';

function makeAgent(overrides: Partial<EligibleAgent> = {}): EligibleAgent {
  return {
    id: 'agent-1',
    userId: 'user-1',
    userName: 'alice',
    model: 'gpt-4',
    tool: 'cursor',
    reputationScore: 0.8,
    repoConfig: null,
    ...overrides,
  };
}

describe('parseTimeoutMs', () => {
  it('parses "10m" to 600000ms', () => {
    expect(parseTimeoutMs('10m')).toBe(600_000);
  });

  it('parses "5m" to 300000ms', () => {
    expect(parseTimeoutMs('5m')).toBe(300_000);
  });

  it('parses "30m" to 1800000ms', () => {
    expect(parseTimeoutMs('30m')).toBe(1_800_000);
  });

  it('defaults to 10m for invalid input', () => {
    expect(parseTimeoutMs('invalid')).toBe(600_000);
    expect(parseTimeoutMs('')).toBe(600_000);
    expect(parseTimeoutMs('10s')).toBe(600_000);
  });
});

describe('filterByAccessList', () => {
  const agents = [
    makeAgent({ id: 'a1', userName: 'alice' }),
    makeAgent({ id: 'a2', userName: 'bob' }),
    makeAgent({ id: 'a3', userName: 'charlie' }),
  ];

  it('returns all agents when both lists are empty', () => {
    expect(filterByAccessList(agents, [], [])).toEqual(agents);
  });

  it('filters by user whitelist', () => {
    const result = filterByAccessList(agents, [{ user: 'alice' }], []);
    expect(result).toHaveLength(1);
    expect(result[0].userName).toBe('alice');
  });

  it('filters by agent whitelist', () => {
    const result = filterByAccessList(agents, [{ agent: 'a2' }], []);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a2');
  });

  it('filters by user blacklist', () => {
    const result = filterByAccessList(agents, [], [{ user: 'bob' }]);
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.userName)).toEqual(['alice', 'charlie']);
  });

  it('filters by agent blacklist', () => {
    const result = filterByAccessList(agents, [], [{ agent: 'a1' }, { agent: 'a3' }]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a2');
  });

  it('applies both whitelist and blacklist', () => {
    const result = filterByAccessList(
      agents,
      [{ user: 'alice' }, { user: 'bob' }],
      [{ user: 'bob' }],
    );
    expect(result).toHaveLength(1);
    expect(result[0].userName).toBe('alice');
  });

  it('returns empty when whitelist matches no agents', () => {
    const result = filterByAccessList(agents, [{ user: 'nobody' }], []);
    expect(result).toHaveLength(0);
  });
});

describe('selectAgents', () => {
  const agents = [
    makeAgent({ id: 'a1', tool: 'cursor' }),
    makeAgent({ id: 'a2', tool: 'vscode' }),
    makeAgent({ id: 'a3', tool: 'cursor' }),
    makeAgent({ id: 'a4', tool: 'jetbrains' }),
  ];

  it('returns exactly reviewCount agents', () => {
    const result = selectAgents(agents, 2, [], []);
    expect(result).toHaveLength(2);
  });

  it('selects preferred tools first, then by reputation', () => {
    const result = selectAgents(agents, 2, [], ['cursor']);
    expect(result).toHaveLength(2);
    // Both cursor agents selected (preferred)
    expect(result.map((a) => a.id)).toEqual(['a1', 'a3']);
  });

  it('orders by reputation within groups', () => {
    const ranked = [
      makeAgent({ id: 'a1', tool: 'cursor', reputationScore: 0.5 }),
      makeAgent({ id: 'a2', tool: 'vscode', reputationScore: 0.9 }),
      makeAgent({ id: 'a3', tool: 'cursor', reputationScore: 0.7 }),
    ];
    const result = selectAgents(ranked, 2, [], []);
    expect(result.map((a) => a.id)).toEqual(['a2', 'a3']); // highest reputation first
  });

  it('returns available agents when fewer than reviewCount', () => {
    const result = selectAgents([agents[0]], 3, [], []);
    expect(result).toHaveLength(1); // dispatches to what's available
  });

  it('returns empty array for empty agents', () => {
    expect(selectAgents([], 2, [], ['cursor'])).toEqual([]);
  });

  it('caps at reviewCount even with many agents', () => {
    const manyAgents = Array.from({ length: 15 }, (_, i) =>
      makeAgent({ id: `a${i}`, tool: 'cursor' }),
    );
    const result = selectAgents(manyAgents, 3, [], []);
    expect(result).toHaveLength(3);
  });

  it('returns all agents when exactly reviewCount are available', () => {
    const result = selectAgents(agents, 4, [], []);
    expect(result).toHaveLength(4);
  });

  it('prioritizes preferred models over preferred tools', () => {
    const mixed = [
      makeAgent({ id: 'a1', model: 'gpt-4', tool: 'cursor', reputationScore: 0.5 }),
      makeAgent({ id: 'a2', model: 'claude-opus-4-6', tool: 'vscode', reputationScore: 0.9 }),
      makeAgent({ id: 'a3', model: 'glm-5', tool: 'cursor', reputationScore: 0.7 }),
    ];
    const result = selectAgents(mixed, 2, ['claude-opus-4-6'], ['cursor']);
    expect(result.map((a) => a.id)).toEqual(['a2', 'a3']); // model match first, then tool match by reputation
  });

  it('selects by preferred models only', () => {
    const mixed = [
      makeAgent({ id: 'a1', model: 'gpt-4', reputationScore: 0.9 }),
      makeAgent({ id: 'a2', model: 'claude-opus-4-6', reputationScore: 0.5 }),
      makeAgent({ id: 'a3', model: 'glm-5', reputationScore: 0.7 }),
    ];
    const result = selectAgents(mixed, 2, ['claude-opus-4-6', 'glm-5'], []);
    expect(result.map((a) => a.id)).toEqual(['a3', 'a2']); // model matches by reputation
  });
});

describe('filterByRepoConfig', () => {
  it('includes agents with null repoConfig (default = accept all)', () => {
    const agents = [
      makeAgent({ id: 'a1', repoConfig: null }),
      makeAgent({ id: 'a2', repoConfig: null }),
    ];
    const result = filterByRepoConfig(agents, 'OpenCara', 'OpenCara');
    expect(result).toHaveLength(2);
  });

  it('includes agents with mode: all', () => {
    const agents = [makeAgent({ id: 'a1', repoConfig: { mode: 'all' } })];
    const result = filterByRepoConfig(agents, 'OpenCara', 'OpenCara');
    expect(result).toHaveLength(1);
  });

  it('mode: own — includes agent when owner matches userName', () => {
    const agents = [makeAgent({ id: 'a1', userName: 'alice', repoConfig: { mode: 'own' } })];
    const result = filterByRepoConfig(agents, 'alice', 'my-repo');
    expect(result).toHaveLength(1);
  });

  it('mode: own — excludes agent when owner does not match userName', () => {
    const agents = [makeAgent({ id: 'a1', userName: 'alice', repoConfig: { mode: 'own' } })];
    const result = filterByRepoConfig(agents, 'bob', 'some-repo');
    expect(result).toHaveLength(0);
  });

  it('mode: whitelist — includes agent when repo is in list', () => {
    const agents = [
      makeAgent({
        id: 'a1',
        repoConfig: { mode: 'whitelist', list: ['OpenCara/OpenCara', 'myorg/my-project'] },
      }),
    ];
    const result = filterByRepoConfig(agents, 'OpenCara', 'OpenCara');
    expect(result).toHaveLength(1);
  });

  it('mode: whitelist — excludes agent when repo is not in list', () => {
    const agents = [
      makeAgent({
        id: 'a1',
        repoConfig: { mode: 'whitelist', list: ['OpenCara/OpenCara'] },
      }),
    ];
    const result = filterByRepoConfig(agents, 'other-org', 'other-repo');
    expect(result).toHaveLength(0);
  });

  it('mode: whitelist — excludes agent when list is empty', () => {
    const agents = [makeAgent({ id: 'a1', repoConfig: { mode: 'whitelist', list: [] } })];
    const result = filterByRepoConfig(agents, 'OpenCara', 'OpenCara');
    expect(result).toHaveLength(0);
  });

  it('mode: whitelist — excludes agent when list is undefined', () => {
    const agents = [makeAgent({ id: 'a1', repoConfig: { mode: 'whitelist' } })];
    const result = filterByRepoConfig(agents, 'OpenCara', 'OpenCara');
    expect(result).toHaveLength(0);
  });

  it('mode: blacklist — excludes agent when repo is in list', () => {
    const agents = [
      makeAgent({
        id: 'a1',
        repoConfig: { mode: 'blacklist', list: ['spam-org/spam-repo'] },
      }),
    ];
    const result = filterByRepoConfig(agents, 'spam-org', 'spam-repo');
    expect(result).toHaveLength(0);
  });

  it('mode: blacklist — includes agent when repo is not in list', () => {
    const agents = [
      makeAgent({
        id: 'a1',
        repoConfig: { mode: 'blacklist', list: ['spam-org/spam-repo'] },
      }),
    ];
    const result = filterByRepoConfig(agents, 'OpenCara', 'OpenCara');
    expect(result).toHaveLength(1);
  });

  it('mode: blacklist — includes agent when list is empty', () => {
    const agents = [makeAgent({ id: 'a1', repoConfig: { mode: 'blacklist', list: [] } })];
    const result = filterByRepoConfig(agents, 'OpenCara', 'OpenCara');
    expect(result).toHaveLength(1);
  });

  it('mode: blacklist — includes agent when list is undefined', () => {
    const agents = [makeAgent({ id: 'a1', repoConfig: { mode: 'blacklist' } })];
    const result = filterByRepoConfig(agents, 'OpenCara', 'OpenCara');
    expect(result).toHaveLength(1);
  });

  it('mixed modes — filters correctly across multiple agents', () => {
    const agents = [
      makeAgent({ id: 'a1', userName: 'alice', repoConfig: null }), // accept all
      makeAgent({ id: 'a2', userName: 'bob', repoConfig: { mode: 'own' } }), // bob != alice
      makeAgent({
        id: 'a3',
        userName: 'charlie',
        repoConfig: { mode: 'whitelist', list: ['alice/my-repo'] },
      }), // match
      makeAgent({
        id: 'a4',
        userName: 'dave',
        repoConfig: { mode: 'blacklist', list: ['alice/my-repo'] },
      }), // excluded
      makeAgent({ id: 'a5', userName: 'eve', repoConfig: { mode: 'all' } }), // accept all
    ];
    const result = filterByRepoConfig(agents, 'alice', 'my-repo');
    expect(result.map((a) => a.id)).toEqual(['a1', 'a3', 'a5']);
  });

  it('returns empty array when no agents match', () => {
    const agents = [
      makeAgent({ id: 'a1', repoConfig: { mode: 'whitelist', list: ['other/repo'] } }),
      makeAgent({ id: 'a2', repoConfig: { mode: 'own' }, userName: 'bob' }),
    ];
    const result = filterByRepoConfig(agents, 'alice', 'my-repo');
    expect(result).toHaveLength(0);
  });

  it('returns all agents when all have null config', () => {
    const agents = [
      makeAgent({ id: 'a1', repoConfig: null }),
      makeAgent({ id: 'a2', repoConfig: null }),
      makeAgent({ id: 'a3', repoConfig: null }),
    ];
    const result = filterByRepoConfig(agents, 'any', 'repo');
    expect(result).toHaveLength(3);
  });

  it('handles empty agents array', () => {
    const result = filterByRepoConfig([], 'owner', 'repo');
    expect(result).toEqual([]);
  });
});
