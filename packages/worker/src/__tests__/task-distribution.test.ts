import { describe, it, expect, vi } from 'vitest';
import {
  parseTimeoutMs,
  filterByAccessList,
  filterByRepoConfig,
  isValidRepoConfig,
  selectAgents,
  agentWeight,
  weightedRandomSelect,
  partitionByLoad,
  MAX_IN_FLIGHT_THRESHOLD,
  type EligibleAgent,
} from '../task-distribution.js';

function makeAgent(
  overrides: Partial<EligibleAgent> & { reputationScore?: number } = {},
): EligibleAgent {
  const { reputationScore: _ignored, ...rest } = overrides;
  return {
    id: 'agent-1',
    userId: 'user-1',
    userName: 'alice',
    model: 'gpt-4',
    tool: 'cursor',
    repoConfig: null,
    ...rest,
  };
}

/**
 * Create a deterministic RNG from a seed (simple LCG).
 * Useful for making weighted random tests reproducible.
 */
function seededRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
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

describe('agentWeight', () => {
  it('returns constant 1 (reputation_score removed from agents table)', () => {
    expect(agentWeight()).toBe(1);
    expect(agentWeight(0.8)).toBe(1);
    expect(agentWeight(-2)).toBe(1);
    expect(agentWeight(0)).toBe(1);
  });
});

describe('weightedRandomSelect', () => {
  it('returns all agents when count >= agents.length', () => {
    const agents = [makeAgent({ id: 'a1' }), makeAgent({ id: 'a2' })];
    const result = weightedRandomSelect(agents, 5);
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.id).sort()).toEqual(['a1', 'a2']);
  });

  it('returns exactly count agents', () => {
    const agents = Array.from({ length: 10 }, (_, i) =>
      makeAgent({ id: `a${i}`, reputationScore: i * 0.1 }),
    );
    const result = weightedRandomSelect(agents, 3, seededRng(42));
    expect(result).toHaveLength(3);
  });

  it('returns empty array for empty input', () => {
    expect(weightedRandomSelect([], 3)).toEqual([]);
  });

  it('is deterministic with seeded RNG', () => {
    const agents = Array.from({ length: 5 }, (_, i) =>
      makeAgent({ id: `a${i}`, reputationScore: i * 0.2 }),
    );
    const result1 = weightedRandomSelect(agents, 2, seededRng(123));
    const result2 = weightedRandomSelect(agents, 2, seededRng(123));
    expect(result1.map((a) => a.id)).toEqual(result2.map((a) => a.id));
  });

  it('all agents have equal selection probability (agentWeight returns constant 1)', () => {
    const agents = [makeAgent({ id: 'a' }), makeAgent({ id: 'b' })];

    const counts: Record<string, number> = { a: 0, b: 0 };
    const N = 1000;

    for (let i = 0; i < N; i++) {
      const result = weightedRandomSelect(agents, 1, seededRng(i));
      counts[result[0].id]++;
    }

    // Both agents should be selected with roughly equal probability
    expect(counts['a']).toBeGreaterThan(0);
    expect(counts['b']).toBeGreaterThan(0);
    // Neither should dominate (max < 3x min)
    const min = Math.min(counts['a'], counts['b']);
    const max = Math.max(counts['a'], counts['b']);
    expect(max).toBeLessThan(min * 3);
  });

  it('all agents get selected regardless of former reputation field', () => {
    const agents = [makeAgent({ id: 'a' }), makeAgent({ id: 'b' }), makeAgent({ id: 'c' })];

    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    const N = 1000;

    for (let i = 0; i < N; i++) {
      const result = weightedRandomSelect(agents, 1, seededRng(i));
      counts[result[0].id]++;
    }

    expect(counts['a']).toBeGreaterThan(0);
    expect(counts['b']).toBeGreaterThan(0);
    expect(counts['c']).toBeGreaterThan(0);
  });

  it('distributes tasks fairly across agents with similar reputation', () => {
    // All agents have the same reputation — should be roughly uniform
    const agents = Array.from({ length: 5 }, (_, i) =>
      makeAgent({ id: `a${i}`, reputationScore: 1.0 }),
    );

    const counts: Record<string, number> = {};
    agents.forEach((a) => (counts[a.id] = 0));
    const N = 2000;

    for (let i = 0; i < N; i++) {
      const result = weightedRandomSelect(agents, 1, seededRng(i));
      counts[result[0].id]++;
    }

    // Each agent should get roughly N/5 = 400 selections
    // With equal weights, no single agent should dominate
    const values = Object.values(counts);
    const min = Math.min(...values);
    const max = Math.max(...values);
    // Allow reasonable variance — max should not exceed 3x min
    expect(max).toBeLessThan(min * 3);
    // All agents should be selected at least once
    expect(min).toBeGreaterThan(0);
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
    const result = selectAgents(agents, 2, [], [], seededRng(1));
    expect(result).toHaveLength(2);
  });

  it('selects preferred tools first', () => {
    // With only 2 cursor agents and reviewCount=2, both must be selected
    const result = selectAgents(agents, 2, [], ['cursor'], seededRng(42));
    expect(result).toHaveLength(2);
    expect(result.every((a) => a.tool === 'cursor')).toBe(true);
  });

  it('returns available agents when fewer than reviewCount', () => {
    const result = selectAgents([agents[0]], 3, [], [], seededRng(1));
    expect(result).toHaveLength(1);
  });

  it('returns empty array for empty agents', () => {
    expect(selectAgents([], 2, [], ['cursor'])).toEqual([]);
  });

  it('caps at reviewCount even with many agents', () => {
    const manyAgents = Array.from({ length: 15 }, (_, i) =>
      makeAgent({ id: `a${i}`, tool: 'cursor' }),
    );
    const result = selectAgents(manyAgents, 3, [], [], seededRng(1));
    expect(result).toHaveLength(3);
  });

  it('returns all agents when exactly reviewCount are available', () => {
    const result = selectAgents(agents, 4, [], [], seededRng(1));
    expect(result).toHaveLength(4);
  });

  it('prioritizes preferred models over preferred tools', () => {
    const mixed = [
      makeAgent({ id: 'a1', model: 'gpt-4', tool: 'cursor', reputationScore: 0.5 }),
      makeAgent({ id: 'a2', model: 'claude-opus-4-6', tool: 'vscode', reputationScore: 0.9 }),
      makeAgent({ id: 'a3', model: 'glm-5', tool: 'cursor', reputationScore: 0.7 }),
    ];
    // With reviewCount=2 and model pref claude-opus-4-6: a2 gets model tier (guaranteed), then tool tier has a1 and a3
    const result = selectAgents(mixed, 2, ['claude-opus-4-6'], ['cursor'], seededRng(42));
    expect(result).toHaveLength(2);
    expect(result.some((a) => a.id === 'a2')).toBe(true); // model match guaranteed
    // Second agent must be one of the cursor agents
    const second = result.find((a) => a.id !== 'a2')!;
    expect(['a1', 'a3']).toContain(second.id);
  });

  it('selects by preferred models only', () => {
    const mixed = [
      makeAgent({ id: 'a1', model: 'gpt-4', reputationScore: 0.9 }),
      makeAgent({ id: 'a2', model: 'claude-opus-4-6', reputationScore: 0.5 }),
      makeAgent({ id: 'a3', model: 'glm-5', reputationScore: 0.7 }),
    ];
    const result = selectAgents(mixed, 2, ['claude-opus-4-6', 'glm-5'], [], seededRng(42));
    // Both model matches should be selected since there are exactly 2
    expect(result).toHaveLength(2);
    const ids = result.map((a) => a.id).sort();
    expect(ids).toEqual(['a2', 'a3']);
  });

  it('distributes across all agents when no preferences given', () => {
    const manyAgents = Array.from({ length: 5 }, (_, i) =>
      makeAgent({ id: `a${i}`, reputationScore: 1.0 }),
    );

    const counts: Record<string, number> = {};
    manyAgents.forEach((a) => (counts[a.id] = 0));
    const N = 1000;

    for (let i = 0; i < N; i++) {
      const result = selectAgents(manyAgents, 1, [], [], seededRng(i));
      counts[result[0].id]++;
    }

    // All agents should be selected at least once (distribution fairness)
    for (const agent of manyAgents) {
      expect(counts[agent.id]).toBeGreaterThan(0);
    }
  });

  it('all agents selected with equal probability (reputation_score removed)', () => {
    const agents = [makeAgent({ id: 'a' }), makeAgent({ id: 'b' }), makeAgent({ id: 'c' })];

    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    const N = 1000;

    for (let i = 0; i < N; i++) {
      const result = selectAgents(agents, 1, [], [], seededRng(i));
      counts[result[0].id]++;
    }

    // All agents should be selected with roughly equal probability
    for (const agent of agents) {
      expect(counts[agent.id]).toBeGreaterThan(0);
    }
    // No agent should dominate
    const values = Object.values(counts);
    const min = Math.min(...values);
    const max = Math.max(...values);
    expect(max).toBeLessThan(min * 3);
  });
});

describe('partitionByLoad', () => {
  function createMockEnv(statusResponses: Record<string, { inFlightTaskIds: string[] }>) {
    return {
      AGENT_CONNECTION: {
        idFromName: vi.fn((id: string) => ({ toString: () => id })),
        get: vi.fn((doId: { toString: () => string }) => ({
          fetch: vi.fn(async () => {
            const agentId = doId.toString();
            const status = statusResponses[agentId] ?? { inFlightTaskIds: [] };
            return new Response(JSON.stringify(status));
          }),
        })),
      },
    };
  }

  it('puts agents with few in-flight tasks in lowLoad', async () => {
    const agents = [makeAgent({ id: 'a1' }), makeAgent({ id: 'a2' })];
    const env = createMockEnv({
      a1: { inFlightTaskIds: [] },
      a2: { inFlightTaskIds: ['task-1'] },
    });

    const { lowLoad, overflow } = await partitionByLoad(env as never, agents);
    expect(lowLoad).toHaveLength(2);
    expect(overflow).toHaveLength(0);
  });

  it('puts agents at threshold in overflow', async () => {
    const agents = [makeAgent({ id: 'a1' }), makeAgent({ id: 'a2' }), makeAgent({ id: 'a3' })];
    const env = createMockEnv({
      a1: { inFlightTaskIds: [] },
      a2: { inFlightTaskIds: ['t1', 't2'] }, // exactly at threshold
      a3: { inFlightTaskIds: ['t1', 't2', 't3'] }, // over threshold
    });

    const { lowLoad, overflow } = await partitionByLoad(env as never, agents);
    expect(lowLoad.map((a) => a.id)).toEqual(['a1']);
    expect(overflow.map((a) => a.id).sort()).toEqual(['a2', 'a3']);
  });

  it('returns empty pools for empty agents', async () => {
    const env = createMockEnv({});
    const { lowLoad, overflow } = await partitionByLoad(env as never, []);
    expect(lowLoad).toHaveLength(0);
    expect(overflow).toHaveLength(0);
  });

  it('places agents in lowLoad when DO query fails (fail-open)', async () => {
    const agents = [makeAgent({ id: 'a1' }), makeAgent({ id: 'a2' })];
    const env = {
      AGENT_CONNECTION: {
        idFromName: vi.fn((id: string) => ({ toString: () => id })),
        get: vi.fn(() => ({
          fetch: vi.fn(async () => {
            throw new Error('DO unavailable');
          }),
        })),
      },
    };

    const { lowLoad, overflow } = await partitionByLoad(env as never, agents);
    expect(lowLoad).toHaveLength(2);
    expect(overflow).toHaveLength(0);
  });

  it('MAX_IN_FLIGHT_THRESHOLD is 2', () => {
    expect(MAX_IN_FLIGHT_THRESHOLD).toBe(2);
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

  it('logs warning for unknown mode values', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const agents = [
      makeAgent({
        id: 'a1',
        repoConfig: { mode: 'unknown' as 'all' },
      }),
    ];
    const result = filterByRepoConfig(agents, 'owner', 'repo');
    expect(result).toHaveLength(1); // default: return true
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown repoConfig mode'));
    warnSpy.mockRestore();
  });
});

describe('isValidRepoConfig', () => {
  it('returns true for valid mode: all', () => {
    expect(isValidRepoConfig({ mode: 'all' })).toBe(true);
  });

  it('returns true for valid mode: own', () => {
    expect(isValidRepoConfig({ mode: 'own' })).toBe(true);
  });

  it('returns true for valid mode: whitelist with list', () => {
    expect(isValidRepoConfig({ mode: 'whitelist', list: ['org/repo'] })).toBe(true);
  });

  it('returns true for valid mode: blacklist with list', () => {
    expect(isValidRepoConfig({ mode: 'blacklist', list: ['org/repo'] })).toBe(true);
  });

  it('returns true for valid mode with undefined list', () => {
    expect(isValidRepoConfig({ mode: 'whitelist' })).toBe(true);
  });

  it('returns true for valid mode with empty list', () => {
    expect(isValidRepoConfig({ mode: 'all', list: [] })).toBe(true);
  });

  it('returns false for null', () => {
    expect(isValidRepoConfig(null)).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(isValidRepoConfig('all')).toBe(false);
    expect(isValidRepoConfig(42)).toBe(false);
    expect(isValidRepoConfig(true)).toBe(false);
  });

  it('returns false for missing mode', () => {
    expect(isValidRepoConfig({})).toBe(false);
    expect(isValidRepoConfig({ list: ['org/repo'] })).toBe(false);
  });

  it('returns false for invalid mode', () => {
    expect(isValidRepoConfig({ mode: 'invalid' })).toBe(false);
    expect(isValidRepoConfig({ mode: 123 })).toBe(false);
  });

  it('returns false for non-array list', () => {
    expect(isValidRepoConfig({ mode: 'whitelist', list: 'org/repo' })).toBe(false);
    expect(isValidRepoConfig({ mode: 'whitelist', list: 42 })).toBe(false);
  });

  it('returns false for list with non-string items', () => {
    expect(isValidRepoConfig({ mode: 'whitelist', list: [42, 'org/repo'] })).toBe(false);
    expect(isValidRepoConfig({ mode: 'whitelist', list: [null] })).toBe(false);
  });
});
