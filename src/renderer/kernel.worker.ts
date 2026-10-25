/**
 * The background kernel: a second OpenCascade instance in a Web Worker, for the slow operations (a fillet round a
 * gear's 170 edges: ~1.2 s) so the app stays live meanwhile — and they can be stopped (the worker is ended). Shapes
 * come and go as BREP text; faces / edges by their place in the shape's lists (ids differ between the two kernels).
 * A result comes with its display mesh, made here too. See kernelWorker.ts for the other end.
 */
import {
  booleanOp,
  deserialize,
  errorMessage,
  exportStep,
  gridfinityBaseplate,
  gridfinityBin,
  type GridfinityBaseplate,
  type GridfinityBin,
  type V3,
  exportStl,
  importStep,
  initKernel,
  meshByPlace,
  meshForExport,
  roundSome,
  serializeShape,
  shellSolid,
  TriMesh,
  type BooleanOp,
  type Solid,
  type StlQuality,
  type Tessellation,
} from "./kernel";
import { write3mf } from "./threemf";

/** A shape for a job: a B-rep as BREP text, or a triangle mesh (an imported STL) as its corners. */
export type JobShape = { brep: string } | { mesh: Float32Array };

export type KernelJob =
  | { op: "round"; kind: "fillet" | "chamfer"; brep: string; /** by place in `shape.edges` (null: every real edge) */ edges: number[] | null; size: number }
  | { op: "shell"; brep: string; /** open faces, by place in `shape.faces` */ faces: number[]; thickness: number }
  | { op: "boolean"; kind: BooleanOp; target: string; tools: string[] }
  | { op: "exportStep"; items: { brep: string; name: string }[] }
  | { op: "exportStl"; items: JobShape[]; quality: StlQuality }
  | { op: "export3mf"; items: (JobShape & { name: string })[]; quality: StlQuality }
  | { op: "importStep"; data: Uint8Array }
  | { op: "gridfinity"; bin?: GridfinityBin; baseplate?: GridfinityBaseplate; at: V3 };

/** A shape made here: BREP text and its display mesh (faces / edges by place: see meshByPlace) — the app needn't mesh it again. */
export type JobSolid = { brep: string; mesh: Tessellation };

export type KernelJobResult =
  | ({ op: "round"; skipped: number[]; asked: number; largest: number | null } & JobSolid)
  | ({ op: "shell" } & JobSolid)
  | ({ op: "boolean" } & JobSolid)
  | { op: "file"; data: Uint8Array }
  | { op: "importStep"; solids: JobSolid[] }
  | ({ op: "gridfinity" } & JobSolid);

const ready = initKernel();
ready.then(
  () => postMessage({ ready: true }),
  (e) => postMessage({ ready: false, error: errorMessage(e) }),
);

self.onmessage = async (e: MessageEvent<{ id: number; job: KernelJob }>) => {
  const { id, job } = e.data;
  try {
    await ready;
    const result = await run(job);
    // (file bytes are handed over, not copied)
    postMessage({ id, result }, { transfer: result.op === "file" ? [result.data.buffer as ArrayBuffer] : [] });
  } catch (err) {
    postMessage({ id, error: errorMessage(err) });
  }
};

const solidOf = (brep: string) => deserialize(brep) as Solid;
const shapeOf = (s: JobShape): Solid | TriMesh => ("brep" in s ? solidOf(s.brep) : new TriMesh(s.mesh));

async function run(job: KernelJob): Promise<KernelJobResult> {
  switch (job.op) {
    case "round": {
      const shape = solidOf(job.brep), all = shape.edges.map((e) => e.hashCode);
      const r = roundSome(job.kind, shape, job.edges ? new Set(job.edges.map((i) => all[i])) : null, job.size);
      return { op: "round", ...made(r.shape), skipped: r.skipped.map((h) => all.indexOf(h)), asked: r.asked, largest: r.largest };
    }
    case "shell": {
      const shape = solidOf(job.brep), all = shape.faces.map((f) => f.hashCode);
      return { op: "shell", ...made(shellSolid(shape, new Set(job.faces.map((i) => all[i])), job.thickness)) };
    }
    case "boolean":
      return { op: "boolean", ...made(booleanOp(job.kind, solidOf(job.target), job.tools.map(solidOf))) };
    case "exportStep":
      return { op: "file", data: new Uint8Array(await exportStep(job.items.map((i) => ({ shape: solidOf(i.brep), name: i.name })))) };
    case "exportStl":
      return { op: "file", data: new Uint8Array(await exportStl(job.items.map(shapeOf), job.quality)) };
    case "export3mf":
      return { op: "file", data: await write3mf(job.items.map((i) => ({ name: i.name, mesh: meshForExport(shapeOf(i), job.quality) }))) };
    case "importStep":
      return { op: "importStep", solids: (await importStep(job.data)).map(made) };
    case "gridfinity":
      return { op: "gridfinity", ...made(job.bin ? gridfinityBin(job.bin, job.at) : gridfinityBaseplate(job.baseplate!, job.at)) };
  }
}

/** A shape made here, as BREP text and its display mesh — made from the shape read back from that text, as the app will have it. */
function made(shape: Solid): JobSolid {
  const brep = serializeShape(shape);
  return { brep, mesh: meshByPlace(deserialize(brep)) };
}
