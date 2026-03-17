import { createSupabaseClient } from './db.js';
import type { Env } from './env.js';
import { type InFlightTaskMeta, triggerSummarization } from './summarization.js';

export class TaskTimeout implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/set-timeout') {
      return this.handleSetTimeout(request);
    }

    return new Response('Not found', { status: 404 });
  }

  private async handleSetTimeout(request: Request): Promise<Response> {
    const { taskId, timeoutMs, reviewCount, installationId, owner, repo, prNumber, prompt } =
      (await request.json()) as {
        taskId: string;
        timeoutMs: number;
        reviewCount: number;
        installationId?: number;
        owner?: string;
        repo?: string;
        prNumber?: number;
        prompt?: string;
      };

    await this.state.storage.put('taskId', taskId);
    await this.state.storage.put('reviewCount', reviewCount);

    // Store task meta for summarization dispatch
    if (installationId !== undefined) {
      const meta: InFlightTaskMeta = {
        reviewCount,
        installationId,
        owner: owner ?? '',
        repo: repo ?? '',
        prNumber: prNumber ?? 0,
        prompt: prompt ?? '',
      };
      await this.state.storage.put('taskMeta', meta);
    }

    await this.state.storage.setAlarm(Date.now() + timeoutMs);

    return new Response('OK', { status: 200 });
  }

  async alarm(): Promise<void> {
    const taskId = await this.state.storage.get<string>('taskId');
    const reviewCount = (await this.state.storage.get<number>('reviewCount')) ?? 1;

    if (!taskId) return;

    const supabase = createSupabaseClient(this.env);

    // Check current task status
    const { data: task } = await supabase
      .from('review_tasks')
      .select('status')
      .eq('id', taskId)
      .single();

    if (!task || (task.status !== 'reviewing' && task.status !== 'pending')) return;

    if (task.status === 'pending') {
      // No agent ever picked it up — timeout
      await supabase.from('review_tasks').update({ status: 'timeout' }).eq('id', taskId);
      console.log(`Task ${taskId} timed out while pending (no agents available)`);
      return;
    }

    // Count completed results
    const { count } = await supabase
      .from('review_results')
      .select('id', { count: 'exact', head: true })
      .eq('review_task_id', taskId)
      .eq('status', 'completed');

    const completedCount = count ?? 0;

    if (completedCount === 0) {
      // No results at all — timeout
      await supabase.from('review_tasks').update({ status: 'timeout' }).eq('id', taskId);
      console.log(`Task ${taskId} timed out with no results`);
    } else {
      // Has results — move to summarizing and dispatch
      await supabase.from('review_tasks').update({ status: 'summarizing' }).eq('id', taskId);
      console.log(
        `Task ${taskId} has ${completedCount}/${reviewCount} results at timeout, moving to summarizing`,
      );

      // Dispatch summarization if we have task meta
      const meta = await this.state.storage.get<InFlightTaskMeta>('taskMeta');
      if (meta) {
        await triggerSummarization(this.env, supabase, taskId, meta);
      }
    }
  }
}
