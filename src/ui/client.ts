// Main-thread side of the worker protocol, plus a small pool for batch work.
import type { Report } from '../core/types';
import type { Progress } from '../core/analyze';
import type { Request, Response } from '../worker/protocol';

type Pending = { resolve: (r: Response) => void; reject: (e: Error) => void; onProgress?: (p: Progress) => void };

type Body<T extends Request['type']> = Omit<Extract<Request, { type: T }>, 'id' | 'type'>;

export class WorkerClient {
  private readonly worker: Worker;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  busy = 0;

  constructor() {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<Response>) => {
      const msg = ev.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'progress') { p.onProgress?.(msg.progress); return; }
      this.pending.delete(msg.id);
      this.busy--;
      if (msg.type === 'error') p.reject(new Error(msg.message));
      else p.resolve(msg);
    };
    this.worker.onerror = ev => {
      for (const p of this.pending.values()) p.reject(new Error(ev.message || 'The analysis worker crashed.'));
      this.pending.clear();
      this.busy = 0;
    };
  }

  private send<T extends Request['type']>(type: T, body: Body<T>, onProgress?: (p: Progress) => void): Promise<Response> {
    const id = ++this.seq;
    this.busy++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ id, type, ...body });
    });
  }

  async analyze(file: Blob, name: string, onProgress?: (p: Progress) => void, lastModified?: number): Promise<Report> {
    const r = await this.send('analyze', { file, name, lastModified }, onProgress);
    if (r.type !== 'report') throw new Error('Unexpected response');
    return r.report;
  }

  async sanitize(file: Blob, name: string) {
    const r = await this.send('sanitize', { file, name });
    if (r.type !== 'sanitized') throw new Error('Unexpected response');
    return r;
  }

  async image(type: 'bitplane' | 'ela' | 'thumbnail', body: Record<string, unknown>) {
    const r = await this.send(type, body as never);
    if (r.type !== 'image') throw new Error('Unexpected response');
    return r;
  }

  terminate(): void {
    this.worker.terminate();
  }
}

/** Fixed-size pool used by batch mode. */
export class WorkerPool {
  private readonly workers: WorkerClient[];
  constructor(size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1))) {
    this.workers = Array.from({ length: size }, () => new WorkerClient());
  }
  get size(): number { return this.workers.length; }
  pick(): WorkerClient {
    return this.workers.reduce((a, b) => (b.busy < a.busy ? b : a));
  }
  terminate(): void { this.workers.forEach(w => w.terminate()); }
}
