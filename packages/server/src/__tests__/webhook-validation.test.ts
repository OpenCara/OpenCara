/**
 * Tests for webhook validation — prompt length limits.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_REVIEW_CONFIG } from '@opencara/shared';
import type { ReviewConfig } from '@opencara/shared';
import { MemoryDataStore } from '../store/memory.js';
import { createTaskForPR, MAX_PROMPT_LENGTH } from '../routes/webhook.js';
import { Logger } from '../logger.js';

describe('createTaskForPR — prompt length validation', () => {
  let store: MemoryDataStore;
  let logger: Logger;

  const baseArgs = {
    installationId: 999,
    owner: 'test-org',
    repo: 'test-repo',
    prNumber: 1,
    prUrl: 'https://github.com/test-org/test-repo/pull/1',
    diffUrl: 'https://github.com/test-org/test-repo/pull/1.diff',
    baseRef: 'main',
    headRef: 'feat/test',
    isPrivate: false,
  };

  function configWithPrompt(prompt: string): ReviewConfig {
    return { ...DEFAULT_REVIEW_CONFIG, prompt };
  }

  beforeEach(() => {
    store = new MemoryDataStore();
    logger = new Logger('test');
  });

  it('accepts a prompt within the limit', async () => {
    const config = configWithPrompt('Review this PR');
    const taskId = await createTaskForPR(
      store,
      baseArgs.installationId,
      baseArgs.owner,
      baseArgs.repo,
      baseArgs.prNumber,
      baseArgs.prUrl,
      baseArgs.diffUrl,
      baseArgs.baseRef,
      baseArgs.headRef,
      config,
      baseArgs.isPrivate,
      logger,
    );
    expect(taskId).not.toBeNull();
  });

  it('accepts a prompt at exactly MAX_PROMPT_LENGTH', async () => {
    const config = configWithPrompt('x'.repeat(MAX_PROMPT_LENGTH));
    const taskId = await createTaskForPR(
      store,
      baseArgs.installationId,
      baseArgs.owner,
      baseArgs.repo,
      baseArgs.prNumber,
      baseArgs.prUrl,
      baseArgs.diffUrl,
      baseArgs.baseRef,
      baseArgs.headRef,
      config,
      baseArgs.isPrivate,
      logger,
    );
    expect(taskId).not.toBeNull();
  });

  it('rejects a prompt exceeding MAX_PROMPT_LENGTH', async () => {
    const config = configWithPrompt('x'.repeat(MAX_PROMPT_LENGTH + 1));
    const taskId = await createTaskForPR(
      store,
      baseArgs.installationId,
      baseArgs.owner,
      baseArgs.repo,
      baseArgs.prNumber,
      baseArgs.prUrl,
      baseArgs.diffUrl,
      baseArgs.baseRef,
      baseArgs.headRef,
      config,
      baseArgs.isPrivate,
      logger,
    );
    expect(taskId).toBeNull();

    // Verify no task was created in the store
    const tasks = await store.listTasks();
    expect(tasks).toHaveLength(0);
  });

  it('MAX_PROMPT_LENGTH is 10_000', () => {
    expect(MAX_PROMPT_LENGTH).toBe(10_000);
  });
});
