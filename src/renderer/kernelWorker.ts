/**
 * The app's end of the background kernel (kernel.worker.ts): jobs go in, results come back as promises. It runs in a
 * hidden window of its own (kernel-host.html, a separate process — src/main/kernelHost.ts), so OpenCascade locking up
 * there can't freeze this window; `cancel` (Stop / Esc) and the watchdog have that process ended and a fresh one
 * started (its OpenCascade loads again, ~1–2 s). Outside the app (no main process) a worker here, as before.
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

/** The watchdog: jobs waiting and not a word from the background kernel for this long — it's stuck: restarted. */
const STUCK_MS = 120_000;
/** Jobs that may rightly take longer (a big file read or written): no watchdog while one waits. */
const LONG_JOBS = new Set<KernelJob["op"]>(["importStep", "exportStep", "exportStl", "export3mf"]);

export class KernelWorker {
  /** Its channel (the hidden window's end, or a worker here), null until it comes. */
  private port: MessagePort | Worker | null = null;
  /** Jobs sent before the channel came. */
  private queue: { id: number; job: KernelJob }[] = [];
  /** Channels asked for and not come yet (only the last one asked for is used). */
  private asked = 0;
  private next = 1;
  private pending = new Map<number, { resolve: (r: KernelJobResult) => void; reject: (e: Error) => void; op: KernelJob["op"] }>();
  /** Loaded and working (false while loading, or if it failed to start: the caller then works on the main thread). */
  ready = false;
  /** Loading again after `cancel` (not at start-up): a panel waits for it (whenReady) rather than working on the main thread. */
  restarting = false;
  private readyWaiters: (() => void)[] = [];
  /** OpenCascade threads it works with (1: just its own — see kernel.ts initKernel). */
  threads = 1;
  /** Font files this worker has been sent (the Text tool's job): sent again after a restart. */
  readonly fonts = new Set<string>();
  /** When it last said something (or was given work after being idle): see STUCK_MS. */
  private heard = performance.now();
  /** The watchdog's limit (STUCK_MS; the tests shorten it). */
  stuckMs = STUCK_MS;

  constructor() {
    window.addEventListener("message", (e) => {
      if (e.data !== "yddd-kernel-port" || !e.ports[0]) return;
      // (an older one asked for before the last restart: not used)
      if (--this.asked > 0) return void e.ports[0].close();
      this.attach(e.ports[0]);
    });
    window.yddd?.onKernelGone?.((reason) => this.restart(new Error(`the background kernel stopped (${reason})`)));
    setInterval(() => this.watch(), 5000);
    this.spawn();
  }

  private spawn(): void {
    this.ready = false;
    this.fonts.clear();
    if (this.port) this.port instanceof Worker ? this.port.terminate() : this.port.close();
    this.port = null;
    if (window.yddd?.kernelStart) {
      this.asked++;
      window.yddd.kernelStart();
      return;
    }
    // (no main process to run it in a process of its own: a worker here)
    const threads = new URLSearchParams(location.search).get("threads");
    // (a plain options object: Vite reads its "type" when building)
    this.attach(new Worker(new URL("./kernel.worker.ts", import.meta.url), { type: "module", name: threads ? `threads=${threads}` : "kernel" }));
  }

  private attach(port: MessagePort | Worker): void {
    this.port = port;
    port.onmessage = (e: MessageEvent<{ ready?: boolean; threads?: number; error?: string; id?: number; result?: KernelJobResult; crashed?: string }>) => {
      if (port !== this.port) return;
      this.heard = performance.now();
      const m = e.data;
      if (m.crashed !== undefined) return this.restart(new Error(`the background kernel stopped (${m.crashed})`));
      if (m.ready !== undefined) {
        this.ready = m.ready;
        this.restarting = false;
        this.readyWaiters.splice(0).forEach((f) => f());
        this.threads = m.threads ?? 1;
        if (!m.ready) console.warn("background kernel failed to start:", m.error);
        return;
      }
      const p = m.id !== undefined ? this.pending.get(m.id) : undefined;
      if (!p) return;
      this.pending.delete(m.id!);
      if (m.error !== undefined) p.reject(new Error(m.error));
      else p.resolve(m.result!);
    };
    if (port instanceof Worker) port.onerror = (e) => port === this.port && this.restart(new Error(`the background kernel stopped (${e.message || "crashed"})`));
    else port.start();
    for (const q of this.queue.splice(0)) port.postMessage(q);
  }

  run<J extends KernelJob>(job: J): Promise<ResultOf<J>> {
    const id = this.next++;
    if (!this.pending.size) this.heard = performance.now(); // (idle until now: the watchdog counts from here)
    return new Promise<KernelJobResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, op: job.op });
      if (this.port) this.port.postMessage({ id, job });
      else this.queue.push({ id, job });
    }) as Promise<ResultOf<J>>;
  }

  /** Jobs still running or waiting. */
  get busy(): boolean {
    return this.pending.size > 0;
  }

  /** How many jobs are running or waiting. */
  get jobs(): number {
    return this.pending.size;
  }

  /** Resolves once it has loaded (or failed to): at once if it isn't restarting. */
  whenReady(): Promise<void> {
    return this.restarting ? new Promise((r) => this.readyWaiters.push(r)) : Promise.resolve();
  }

  /** Stop everything it's doing now (the jobs reject with JobCancelled) and start afresh. */
  cancel(): void {
    if (!this.pending.size) return;
    this.restart(new JobCancelled());
  }

  /** Its jobs failed with `e`, the process (or worker) ended and a fresh one started. */
  private restart(e: Error): void {
    this.queue = [];
    this.failAll(e);
    this.restarting = true;
    this.spawn();
  }

  /** Jobs waiting and no answer for STUCK_MS (not while a file is read / written): it's stuck — restarted. */
  private watch(): void {
    if (!this.pending.size || [...this.pending.values()].some((p) => LONG_JOBS.has(p.op))) return;
    if (performance.now() - this.heard < this.stuckMs) return;
    console.warn("background kernel: no answer for", this.stuckMs / 1000, "s — restarted");
    const t = this.stuckMs >= 60_000 ? `${Math.round(this.stuckMs / 60_000)} minutes` : `${Math.round(this.stuckMs / 1000)} s`;
    this.restart(new Error(`it took over ${t} without finishing (OpenCascade got stuck) — stopped, nothing changed`));
  }

  private failAll(e: Error): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(e);
  }
}
