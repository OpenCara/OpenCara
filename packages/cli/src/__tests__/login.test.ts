import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockPost = vi.hoisted(() => vi.fn());

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({ apiKey: null, platformUrl: 'https://test.api.dev' })),
  saveConfig: vi.fn(),
}));

vi.mock('../http.js', () => ({
  ApiClient: vi.fn(() => ({ post: mockPost })),
}));

vi.mock('../reconnect.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
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
});
