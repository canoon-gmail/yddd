/**
 * The hidden kernel window's page (see src/main/kernelHost.ts): the background kernel (kernel.worker.ts) in a worker
 * here, in a process of its own, and its messages passed to and from the app window over the channel the main process
 * set up. Nothing else — if OpenCascade locks up here, only this process is stuck; the app window has it ended.
 */
import type { KernelJob } from "./kernel.worker";

// (the thread count, as the app window's own worker took it: in the worker's name — see kernel.ts initKernel)
const threads = new URLSearchParams(location.search).get("threads");
const worker = new Worker(new URL("./kernel.worker.ts", import.meta.url), { type: "module", name: threads ? `threads=${threads}` : "kernel" });

/** The bytes a message carries (a file to import / an exported file): handed over, not copied. */
const transferOf = (m: unknown): Transferable[] => {
  const data = (m as { job?: { data?: unknown }; result?: { data?: unknown } } | null)?.job?.data ?? (m as { result?: { data?: unknown } } | null)?.result?.data;
  return data instanceof Uint8Array ? [data.buffer as ArrayBuffer] : [];
};

// (what the worker says before the channel is there — "ready", most likely — kept for it)
let port: MessagePort | null = null;
const early: unknown[] = [];
const toApp = (m: unknown) => (port ? port.postMessage(m, transferOf(m)) : early.push(m));
worker.onmessage = (m) => toApp(m.data);
worker.onerror = (m) => toApp({ crashed: m.message || "crashed" });

window.addEventListener("message", (e) => {
  if (e.data !== "yddd-kernel-port" || !e.ports[0] || port) return;
  port = e.ports[0];
  port.onmessage = (m: MessageEvent<{ id: number; job: KernelJob }>) => worker.postMessage(m.data, transferOf(m.data));
  port.start();
  for (const m of early.splice(0)) toApp(m);
});
