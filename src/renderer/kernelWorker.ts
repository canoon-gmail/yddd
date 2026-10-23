/**
 * The app's end of the background kernel (kernel.worker.ts): jobs go in, results come back as promises. `cancel`
 * ends the worker — what it was doing stops at once — and starts a fresh one (its OpenCascade loads again, ~1 s).
 */
import type { KernelJob, KernelJobResult } from "./kernel.worker";

/** A job given up on (Esc / Cancel, or the panel closed): not an error to show. */
export class JobCancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

export class KernelWorker {
  private worker!: Worker;
  private next = 1;
  private pending = new Map<number, { resolve: (r: KernelJobResult) => void; reject: (e: Error) => void }>();
  /** Loaded and working (false while loading, or if it failed to start: the caller then works on the main thread). */
  ready = false;

  constructor() {
    this.spawn();
  }

  private spawn(): void {
    this.ready = false;
    const w = new Worker(new URL("./kernel.worker.ts", import.meta.url), { type: "module" });
    this.worker = w;
    w.onmessage = (e: MessageEvent<{ ready?: boolean; error?: string; id?: number; result?: KernelJobResult }>) => {
      if (w !== this.worker) return;
      const m = e.data;
      if (m.ready !== undefined) {
        this.ready = m.ready;
        if (!m.ready) console.warn("background kernel failed to start:", m.error);
        return;
      }
      const p = m.id !== undefined ? this.pending.get(m.id) : undefined;
      if (!p) return;
      this.pending.delete(m.id!);
      if (m.error !== undefined) p.reject(new Error(m.error));
      else p.resolve(m.result!);
    };
    w.onerror = (e) => {
      if (w !== this.worker) return;
      console.warn("background kernel error:", e.message);
      this.ready = false;
      this.failAll(new Error(`the background kernel stopped (${e.message || "crashed"})`));
    };
  }

  run(job: KernelJob): Promise<KernelJobResult> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, job });
    });
  }

  /** Jobs still running or waiting. */
  get busy(): boolean {
    return this.pending.size > 0;
  }

  /** Stop everything it's doing now (the jobs reject with JobCancelled) and start afresh. */
  cancel(): void {
    if (!this.pending.size) return;
    this.worker.terminate();
    this.failAll(new JobCancelled());
    this.spawn();
  }

  private failAll(e: Error): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(e);
  }
}
