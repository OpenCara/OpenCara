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

  it('selects up to minCount agents when no preferred tools', () => {
    const result = selectAgents(agents, 2, []);
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.id)).toEqual(['a1', 'a2']);
  });

  it('prefers agents with matching tools', () => {
    const result = selectAgents(agents, 2, ['cursor']);
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.id)).toEqual(['a1', 'a3']);
  });

  it('fills remainder from non-preferred when not enough matches', () => {
    const result = selectAgents(agents, 3, ['jetbrains']);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('a4'); // preferred
    expect(result[1].id).toBe('a1'); // fill
    expect(result[2].id).toBe('a2'); // fill
  });

  it('returns all agents if fewer than minCount', () => {
    const result = selectAgents([agents[0]], 3, []);
    expect(result).toHaveLength(1);
  });

  it('returns empty array for empty agents', () => {
    expect(selectAgents([], 2, ['cursor'])).toEqual([]);
  });
});
