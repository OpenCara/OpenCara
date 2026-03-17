import { describe, it, expect } from 'vitest';
import {
  parseTimeoutMs,
  filterByAccessList,
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
    const result = selectAgents(agents, 2, []);
    expect(result).toHaveLength(2);
  });

  it('selects preferred tools first, then by reputation', () => {
    const result = selectAgents(agents, 2, ['cursor']);
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
    const result = selectAgents(ranked, 2, []);
    expect(result.map((a) => a.id)).toEqual(['a2', 'a3']); // highest reputation first
  });

  it('returns empty when fewer agents than reviewCount', () => {
    const result = selectAgents([agents[0]], 3, []);
    expect(result).toHaveLength(0);
  });

  it('returns empty array for empty agents', () => {
    expect(selectAgents([], 2, ['cursor'])).toEqual([]);
  });

  it('caps at reviewCount even with many agents', () => {
    const manyAgents = Array.from({ length: 15 }, (_, i) =>
      makeAgent({ id: `a${i}`, tool: 'cursor' }),
    );
    const result = selectAgents(manyAgents, 3, []);
    expect(result).toHaveLength(3);
  });

  it('returns all agents when exactly reviewCount are available', () => {
    const result = selectAgents(agents, 4, []);
    expect(result).toHaveLength(4);
  });
});
