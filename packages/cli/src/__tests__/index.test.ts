import { describe, it, expect, vi } from 'vitest';

const mockProgram = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj: Record<string, any> = {};
  obj.name = vi.fn(() => obj);
  obj.description = vi.fn(() => obj);
  obj.version = vi.fn(() => obj);
  obj.addCommand = vi.fn(() => obj);
  obj.parse = vi.fn();
  return obj;
});

vi.mock('commander', () => ({
  Command: vi.fn(() => mockProgram),
}));

vi.mock('../commands/login.js', () => ({
  loginCommand: { _name: 'login' },
}));

vi.mock('../commands/agent.js', () => ({
  agentCommand: { _name: 'agent' },
}));

// Import triggers module-level side effects (Commander setup + parse)
import '../index.js';

describe('CLI entry point', () => {
  it('creates program with correct name', () => {
    expect(mockProgram.name).toHaveBeenCalledWith('opencrust');
  });

  it('sets correct description', () => {
    expect(mockProgram.description).toHaveBeenCalledWith(
      expect.stringContaining('OpenCrust'),
    );
  });

  it('sets version from shared package', () => {
    expect(mockProgram.version).toHaveBeenCalledWith('0.0.1');
  });

  it('registers login and agent commands', () => {
    expect(mockProgram.addCommand).toHaveBeenCalledTimes(2);
    expect(mockProgram.addCommand).toHaveBeenCalledWith({ _name: 'login' });
    expect(mockProgram.addCommand).toHaveBeenCalledWith({ _name: 'agent' });
  });

  it('calls parse', () => {
    expect(mockProgram.parse).toHaveBeenCalled();
  });
});
