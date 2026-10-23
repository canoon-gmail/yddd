/**
 * The app's end of the background kernel (kernel.worker.ts): jobs go in, results come back as promises. `cancel`
 * ends the worker — what it was doing stops at once — and starts a fresh one (its OpenCascade loads again, ~1 s).
 */
import { deserialize, takeMesh, type Solid } from "./kernel";
import type { JobSolid, KernelJob, KernelJobResult } from "./kernel.worker";

export type { JobShape, KernelJob } from "./kernel.worker";

/** What a job gives back: a file's bytes for the exports, its own result for the others. */
export type ResultOf<J extends KernelJob> = J extends { op: "exportStep" | "exportStl" | "export3mf" } ? Extract<KernelJobResult, { op: "file" }> : Extract<KernelJobResult, { op: J["op"] }>;

/** A shape the background kernel made, read here — with the display mesh it made (no meshing again here). */
export function solidFrom(made: JobSolid): Solid {
  const shape = deserialize(made.brep) as Solid;
  takeMesh(shape, made.mesh);
  return shape;
}

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

  run<J extends KernelJob>(job: J): Promise<ResultOf<J>> {
    const id = this.next++;
    return new Promise<KernelJobResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, job });
    }) as Promise<ResultOf<J>>;
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
