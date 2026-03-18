import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockPost = vi.hoisted(() => vi.fn());

const mockLoadConfig = vi.hoisted(() =>
  vi.fn(() => ({
    apiKey: null,
    platformUrl: 'https://test.api.dev',
    anonymousAgents: [] as Array<{
      agentId: string;
      apiKey: string;
      model: string;
      tool: string;
    }>,
  })),
);

const mockRlQuestion = vi.hoisted(() => vi.fn());

vi.mock('../config.js', () => ({
  loadConfig: mockLoadConfig,
  saveConfig: vi.fn(),
  removeAnonymousAgent: vi.fn(
    (config: { anonymousAgents: Array<{ agentId: string }> }, agentId: string) => {
      config.anonymousAgents = config.anonymousAgents.filter(
        (a: { agentId: string }) => a.agentId !== agentId,
      );
    },
  ),
}));

vi.mock('../http.js', () => ({
  ApiClient: vi.fn(() => ({ post: mockPost })),
}));

vi.mock('../reconnect.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => ({
    question: mockRlQuestion,
    close: vi.fn(),
  })),
}));

import { loginCommand } from '../commands/login.js';
import { saveConfig } from '../config.js';

describe('login command', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  function mockDeviceFlow() {
    return {
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5,
      deviceCode: 'dc_test',
    };
  }

  it('completes successful login flow', async () => {
    mockPost
      .mockResolvedValueOnce(mockDeviceFlow())
      .mockResolvedValueOnce({ status: 'complete', apiKey: 'cr_newkey123' });

    await loginCommand.parseAsync([], { from: 'user' });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ABCD-1234'));
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'cr_newkey123' }));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Logged in successfully'));
  });

  it('handles pending status then complete', async () => {
    mockPost
      .mockResolvedValueOnce(mockDeviceFlow())
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'complete', apiKey: 'cr_key' });

    await loginCommand.parseAsync([], { from: 'user' });

    expect(stdoutSpy).toHaveBeenCalledWith('.');
    expect(saveConfig).toHaveBeenCalled();
  });

  it('exits on expired token', async () => {
    mockPost.mockResolvedValueOnce(mockDeviceFlow()).mockResolvedValueOnce({ status: 'expired' });

    await expect(loginCommand.parseAsync([], { from: 'user' })).rejects.toThrow('process.exit');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('expired'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits when device flow request fails with Error', async () => {
    mockPost.mockRejectedValueOnce(new Error('Network error'));

    await expect(loginCommand.parseAsync([], { from: 'user' })).rejects.toThrow('process.exit');

    expect(errorSpy).toHaveBeenCalledWith('Failed to start device flow:', 'Network error');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits when device flow request fails with non-Error', async () => {
    mockPost.mockRejectedValueOnce('string error');

    await expect(loginCommand.parseAsync([], { from: 'user' })).rejects.toThrow('process.exit');

    expect(errorSpy).toHaveBeenCalledWith('Failed to start device flow:', 'string error');
  });

  it('continues polling on network error then completes', async () => {
    mockPost
      .mockResolvedValueOnce(mockDeviceFlow())
      .mockRejectedValueOnce(new Error('Network'))
      .mockResolvedValueOnce({ status: 'complete', apiKey: 'cr_key' });

    await loginCommand.parseAsync([], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith('Polling error:', 'Network');
    expect(saveConfig).toHaveBeenCalled();
  });

  it('continues polling on non-Error failure', async () => {
    mockPost
      .mockResolvedValueOnce(mockDeviceFlow())
      .mockRejectedValueOnce('raw error')
      .mockResolvedValueOnce({ status: 'complete', apiKey: 'cr_key' });

    await loginCommand.parseAsync([], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith('Polling error:', 'raw error');
  });

  it('exits when deadline is reached', async () => {
    mockPost.mockResolvedValueOnce({
      ...mockDeviceFlow(),
      expiresIn: 0, // immediate expiry — while loop never enters
    });

    await expect(loginCommand.parseAsync([], { from: 'user' })).rejects.toThrow('process.exit');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('expired'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  describe('account linking', () => {
    let originalIsTTY: boolean | undefined;

    beforeEach(() => {
      originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true });
    });

    afterEach(() => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalIsTTY,
        writable: true,
      });
    });

    it('prompts to link anonymous agents after login', async () => {
      mockLoadConfig.mockReturnValue({
        apiKey: null,
        platformUrl: 'https://test.api.dev',
        anonymousAgents: [
          { agentId: 'anon-1', apiKey: 'cr_anon', model: 'claude-sonnet-4-6', tool: 'claude' },
        ],
      });

      // Simulate user pressing Enter (default Y)
      mockRlQuestion.mockImplementation((_q: string, cb: (answer: string) => void) => cb(''));

      mockPost
        .mockResolvedValueOnce(mockDeviceFlow())
        .mockResolvedValueOnce({ status: 'complete', apiKey: 'cr_newkey' })
        .mockResolvedValueOnce({ linked: true, agentIds: ['anon-1'] }); // link response

      await loginCommand.parseAsync([], { from: 'user' });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Found 1 anonymous agent'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Linked 1 agent'));
      // saveConfig called twice: once for apiKey, once after linking
      expect(saveConfig).toHaveBeenCalledTimes(2);
    });

    it('skips linking when user declines', async () => {
      mockLoadConfig.mockReturnValue({
        apiKey: null,
        platformUrl: 'https://test.api.dev',
        anonymousAgents: [
          { agentId: 'anon-1', apiKey: 'cr_anon', model: 'claude-sonnet-4-6', tool: 'claude' },
        ],
      });

      // Simulate user typing "n"
      mockRlQuestion.mockImplementation((_q: string, cb: (answer: string) => void) => cb('n'));

      mockPost
        .mockResolvedValueOnce(mockDeviceFlow())
        .mockResolvedValueOnce({ status: 'complete', apiKey: 'cr_newkey' });

      await loginCommand.parseAsync([], { from: 'user' });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Found 1 anonymous agent'));
      // Only one saveConfig call (for apiKey)
      expect(saveConfig).toHaveBeenCalledTimes(1);
    });

    it('handles link API failure gracefully', async () => {
      mockLoadConfig.mockReturnValue({
        apiKey: null,
        platformUrl: 'https://test.api.dev',
        anonymousAgents: [{ agentId: 'anon-1', apiKey: 'cr_anon', model: 'm', tool: 't' }],
      });

      mockRlQuestion.mockImplementation((_q: string, cb: (answer: string) => void) => cb(''));

      mockPost
        .mockResolvedValueOnce(mockDeviceFlow())
        .mockResolvedValueOnce({ status: 'complete', apiKey: 'cr_newkey' })
        .mockRejectedValueOnce(new Error('Link failed')); // link API fails

      await loginCommand.parseAsync([], { from: 'user' });

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to link agent'),
        'Link failed',
      );
      // saveConfig still called twice (apiKey save + after link attempts)
      expect(saveConfig).toHaveBeenCalledTimes(2);
    });

    it('does not prompt when no anonymous agents', async () => {
      mockLoadConfig.mockReturnValue({
        apiKey: null,
        platformUrl: 'https://test.api.dev',
        anonymousAgents: [],
      });

      mockPost
        .mockResolvedValueOnce(mockDeviceFlow())
        .mockResolvedValueOnce({ status: 'complete', apiKey: 'cr_newkey' });

      await loginCommand.parseAsync([], { from: 'user' });

      // Should not see "Found N anonymous agent(s)" message
      const logCalls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(logCalls.some((c: string) => c.includes('anonymous agent'))).toBe(false);
      expect(saveConfig).toHaveBeenCalledTimes(1);
    });

    it('skips linking prompt in non-TTY environment', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: undefined, writable: true });

      mockLoadConfig.mockReturnValue({
        apiKey: null,
        platformUrl: 'https://test.api.dev',
        anonymousAgents: [
          { agentId: 'anon-1', apiKey: 'cr_anon', model: 'claude-sonnet-4-6', tool: 'claude' },
        ],
      });

      mockPost
        .mockResolvedValueOnce(mockDeviceFlow())
        .mockResolvedValueOnce({ status: 'complete', apiKey: 'cr_newkey' });

      await loginCommand.parseAsync([], { from: 'user' });

      // Should not prompt or attempt linking
      const logCalls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(logCalls.some((c: string) => c.includes('anonymous agent'))).toBe(false);
      expect(saveConfig).toHaveBeenCalledTimes(1);
    });
  });
});
