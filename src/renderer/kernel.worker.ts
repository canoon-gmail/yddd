/**
 * The background kernel: a second OpenCascade instance in a Web Worker, for the slow operations (a fillet round a
 * gear's 170 edges: ~1.2 s) so the app stays live meanwhile — and they can be stopped (the worker is ended). Shapes
 * come and go as BREP text; edges by their place in the shape's edge list (ids differ between the two kernels).
 * See kernelWorker.ts for the other end.
 */
import { deserialize, errorMessage, initKernel, roundSome, serializeShape, type Solid } from "./kernel";

export type KernelJob = {
  op: "round";
  kind: "fillet" | "chamfer";
  brep: string;
  /** Edges by place in `shape.edges` (null: every real edge). */
  edges: number[] | null;
  size: number;
};

export type KernelJobResult = { op: "round"; brep: string; skipped: number[]; asked: number; largest: number | null };

const ready = initKernel();
ready.then(
  () => postMessage({ ready: true }),
  (e) => postMessage({ ready: false, error: errorMessage(e) }),
);

self.onmessage = async (e: MessageEvent<{ id: number; job: KernelJob }>) => {
  const { id, job } = e.data;
  try {
    await ready;
    postMessage({ id, result: run(job) });
  } catch (err) {
    postMessage({ id, error: errorMessage(err) });
  }
};

function run(job: KernelJob): KernelJobResult {
  const shape = deserialize(job.brep) as Solid;
  const all = shape.edges.map((e) => e.hashCode);
  const r = roundSome(job.kind, shape, job.edges ? new Set(job.edges.map((i) => all[i])) : null, job.size);
  return { op: "round", brep: serializeShape(r.shape), skipped: r.skipped.map((h) => all.indexOf(h)), asked: r.asked, largest: r.largest };
}
