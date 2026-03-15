/**
 * Background Indexing Queue
 *
 * Manages a queue of repo indexing jobs that run without blocking the API.
 * Emits progress events for WebSocket consumers.
 */

import { EventEmitter } from 'events';
import { fork } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import type { PipelineProgress } from '../types/pipeline.js';

export interface IndexJob {
  id: string;
  repoPath: string;
  status: 'queued' | 'running' | 'done' | 'error';
  progress: PipelineProgress | null;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class IndexingQueue extends EventEmitter {
  private queue: IndexJob[] = [];
  private running: IndexJob | null = null;
  private history: IndexJob[] = [];
  private jobCounter = 0;

  /** Enqueue a repo for background indexing. Returns the job id. */
  enqueue(repoPath: string): IndexJob {
    const id = `idx-${++this.jobCounter}-${Date.now()}`;
    const job: IndexJob = { id, repoPath, status: 'queued', progress: null };
    this.queue.push(job);
    this.emit('job:queued', job);
    this.processNext();
    return job;
  }

  /** Get the currently running job (if any) */
  current(): IndexJob | null {
    return this.running;
  }

  /** Get all queued jobs */
  pending(): IndexJob[] {
    return [...this.queue];
  }

  /** Get recent completed/errored jobs (last 20) */
  completed(): IndexJob[] {
    return [...this.history];
  }

  /** Get a specific job by id */
  getJob(id: string): IndexJob | undefined {
    if (this.running?.id === id) return this.running;
    return this.queue.find(j => j.id === id) ?? this.history.find(j => j.id === id);
  }

  private async processNext() {
    if (this.running || this.queue.length === 0) return;

    const job = this.queue.shift()!;
    this.running = job;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    this.emit('job:started', job);

    try {
      await this.runIndexing(job);
      job.status = 'done';
      job.completedAt = new Date().toISOString();
      this.emit('job:done', job);
    } catch (err: any) {
      job.status = 'error';
      job.error = err?.message ?? String(err);
      job.completedAt = new Date().toISOString();
      this.emit('job:error', job);
    } finally {
      this.running = null;
      this.history.unshift(job);
      if (this.history.length > 20) this.history.pop();
      // Process next in queue
      this.processNext();
    }
  }

  private runIndexing(job: IndexJob): Promise<void> {
    return new Promise((resolve, reject) => {
      // Fork a child process that runs the analyze worker
      const workerPath = path.join(__dirname, 'indexing-worker.js');
      const child = fork(workerPath, [job.repoPath], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' },
      });

      child.on('message', (msg: any) => {
        if (msg.type === 'progress') {
          job.progress = msg.data as PipelineProgress;
          this.emit('job:progress', job);
        }
      });

      child.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Indexing process exited with code ${code}`));
        }
      });

      child.on('error', (err) => {
        reject(err);
      });
    });
  }
}

/** Singleton queue instance */
export const indexingQueue = new IndexingQueue();
