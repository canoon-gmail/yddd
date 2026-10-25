/**
 * Geometry kernel facade. All B-rep modeling goes through this module so the
 * rest of the app never touches OpenCascade / replicad directly.
 *
 * Body geometry is either a 3D solid (`Solid`) or a flat planar face
 * (`Face`, made by the Rectangle / Circle / Polygon tools). `Shape` covers
 * both; solid-only operations (booleans, fillet, shell...) take `Solid`.
 *
 * Ownership rule: replicad's translate/rotate consume `this`, so every
 * transform here clones first. Shapes stored in the document are therefore
 * immutable and may be shared safely between undo snapshots.
 */
import opencascade from "../../vendor/occt/y3d_occt.js";
import wasmUrl from "../../vendor/occt/y3d_occt.wasm?url";
import notoSans from "../../vendor/fonts/NotoSans-Regular.ttf?url";
import notoSansBold from "../../vendor/fonts/NotoSans-Bold.ttf?url";
import notoSerif from "../../vendor/fonts/NotoSerif-Regular.ttf?url";
import notoSerifBold from "../../vendor/fonts/NotoSerif-Bold.ttf?url";
import notoThai from "../../vendor/fonts/NotoSansThai-Regular.ttf?url";
import notoThaiBold from "../../vendor/fonts/NotoSansThai-Bold.ttf?url";
import {
  setOC,
  Plane,
  Vector,
  drawRoundedRectangle,
  drawPolysides,
  loadFont,
  getFont,
  textBlueprints,
  makeSphere,
  makeCylinder as occCylinder,
  makeCircle,
  assembleWire,
  makeFace,
  makeLine,
  makeThreePointArc,
  makeSolid,
  makeVertex,
  measureArea,
  measureDistanceBetween,
  measureLength,
  measureVolume,
  basicFaceExtrusion,
  revolution,
  genericSweep,
  makeHelix,
  deserializeShape,
  exportSTEP,
  importSTEP,
  makeCompound,
  makePolygon,
  iterTopo,
  cast,
  Shape as OcShape,
  Face,
  Wire,
  Edge,
  type AnyShape,
  type Sketch,
  type Shape3D,
  type ShapeEdgeMesh,
  type ShapeMesh,
} from "replicad";

/** A closed 3D solid. */
export type Solid = Shape3D;
/** Any body geometry: a solid or a flat face. */
export type Shape = Shape3D | Face;
export type BodyKind = "solid" | "face" | "mesh" | "path";
/** An open path: lines / arcs end to end. */
export type { Wire };

export function isFaceShape(shape: Shape): shape is Face {
  return shape instanceof Face;
}

export function kindOf(shape: Shape): "solid" | "face" {
  return isFaceShape(shape) ? "face" : "solid";
}
export type V3 = [number, number, number];

/**
 * A triangle mesh (from STL): shown, moved, rotated, scaled, copied and exported, but not edited —
 * it has no faces or edges. Immutable, like shapes: transforms return a new mesh.
 */
export class TriMesh {
  private box: [V3, V3] | null = null;
  private b64: string | null = null;
  /** 9 floats per triangle (its 3 corners, counter-clockwise seen from outside), in mm. */
  constructor(readonly positions: Float32Array) {}

  get triangleCount(): number {
    return this.positions.length / 9;
  }

  /** Same shape as a B-rep's `boundingBox.bounds`, so sizes and pivots work the same for both. */
  get boundingBox(): { bounds: [V3, V3] } {
    if (!this.box) {
      const P = this.positions, lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < P.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          if (P[i + k] < lo[k]) lo[k] = P[i + k];
          if (P[i + k] > hi[k]) hi[k] = P[i + k];
        }
      }
      this.box = P.length ? [lo, hi] : [[0, 0, 0], [0, 0, 0]];
    }
    return { bounds: this.box };
  }

  /** p ↦ M·p + t, with M row-major 3×3. A mirroring M would turn the triangles inside out, so it flips their winding. */
  transformed(M: number[], t: V3): TriMesh {
    const P = this.positions, out = new Float32Array(P.length);
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      out[i] = M[0] * x + M[1] * y + M[2] * z + t[0];
      out[i + 1] = M[3] * x + M[4] * y + M[5] * z + t[1];
      out[i + 2] = M[6] * x + M[7] * y + M[8] * z + t[2];
    }
    const det = M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]);
    if (det < 0) {
      for (let i = 0; i < out.length; i += 9) {
        for (let k = 3; k < 6; k++) [out[i + k], out[i + k + 3]] = [out[i + k + 3], out[i + k]];
      }
    }
    return new TriMesh(out);
  }

  /** Positions as base64 (little-endian float32) for the .yddd file; cached, the mesh never changes. */
  toBase64(): string {
    if (this.b64 === null) {
      const bytes = new Uint8Array(this.positions.buffer, this.positions.byteOffset, this.positions.byteLength);
      const parts: string[] = [];
      for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
      this.b64 = btoa(parts.join(""));
    }
    return this.b64;
  }

  static fromBase64(text: string): TriMesh {
    const bin = atob(text), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const m = new TriMesh(new Float32Array(bytes.buffer));
    m.b64 = text;
    return m;
  }
}

/** Body geometry: a B-rep shape, or an imported triangle mesh. */
export type Geom = Shape | TriMesh | Wire;

export function isMesh(g: Geom): g is TriMesh {
  return g instanceof TriMesh;
}

/** Orthonormal frame describing a sketch plane. */
export interface Frame {
  origin: V3;
  x: V3;
  y: V3;
  z: V3;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let oc: any;

export async function initKernel(): Promise<void> {
  oc = await opencascade({ locateFile: () => wasmUrl });
  setOC(oc);
  fastSubShapes();
}

/**
 * replicad's `shape.edges` / `shape.faces` skip repeats by comparing each one found with every one
 * before it: n² calls into the kernel (~40 ms for the ~450 edges of a plate with 36 holes, on every
 * Properties refresh and tessellation). Bucketed by hash code, only same-hash ones are compared —
 * same items, same order.
 */
function fastSubShapes(): void {
  type Topo = { IsSame(o: unknown): boolean; delete(): void };
  const unique = <T>(shape: unknown, kind: "TopAbs_EDGE" | "TopAbs_FACE", wrap: (s: Topo) => T): T[] => {
    const ex = new oc.TopExp_Explorer(shape as never, oc.TopAbs_ShapeEnum[kind], oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    const seen = new Map<number, Topo[]>();
    const out: T[] = [];
    try {
      for (; ex.More(); ex.Next()) {
        const item = ex.Current() as unknown as Topo;
        const h = oc.ReplicadShapeHasher.HashCode(item as never, 2147483647); // (replicad's bound: same codes as .hashCode)
        const bucket = seen.get(h);
        if (bucket?.some((s) => s.IsSame(item))) {
          item.delete();
          continue;
        }
        if (bucket) bucket.push(item);
        else seen.set(h, [item]);
        out.push(wrap(item));
      }
    } finally {
      ex.delete();
    }
    return out;
  };
  Object.defineProperties(OcShape.prototype, {
    edges: { configurable: true, get(this: OcShape<never>) { return unique(this.wrapped, "TopAbs_EDGE", (e) => new Edge(oc.TopoDS.Edge(e as never))); } },
    faces: { configurable: true, get(this: OcShape<never>) { return unique(this.wrapped, "TopAbs_FACE", (f) => new Face(oc.TopoDS.Face(f as never))); } },
  });
}

/**
 * Boolean fuse / cut / common. Unlike replicad's fuse/cut/intersect this runs in
 * non-destructive mode: by default OpenCascade's boolean edits its arguments in
 * place (e.g. the document solid during a live push/pull preview), which leaves
 * them invalid so the next operation on them fails.
 */
function boolean(kind: "fuse" | "cut" | "common", a: Shape3D, b: Shape3D | Shape3D[]): Shape3D {
  const tools = Array.isArray(b) ? b : [b];
  if (previewing) {
    try {
      // Glue edits its arguments in place even in non-destructive mode: give it deep copies,
      // never the document's own solid.
      const r = booleanOnce(kind, deepCopy(a), tools.map(deepCopy), true);
      if (isValidShape(r as Shape)) return r;
    } catch {
      // glue not applicable: the normal boolean below
    }
  }
  return booleanOnce(kind, a, tools, false);
}

/**
 * While a preview is computed: booleans use OpenCascade's "glue" mode, many times faster when
 * the arguments share coinciding faces (as push/pull blocks do — notably on B-spline faces after
 * a per-axis scale). Glue assumes faces otherwise don't cross, so the result applied to the
 * document is always computed again without it.
 */
let previewing = false;

/** A copy that shares no geometry or topology with `s` (identity transform with copying on). */
function deepCopy(s: Shape3D): Shape3D {
  const t = new oc.gp_Trsf();
  const mk = new oc.BRepBuilderAPI_Transform(s.wrapped, t, true);
  try {
    return cast(mk.Shape()) as Shape3D;
  } finally {
    mk.delete();
    t.delete();
  }
}

export function asPreview<T>(fn: () => T): T {
  previewing = true;
  try {
    return fn();
  } finally {
    previewing = false;
  }
}

/** Distance (mm) below which booleans treat faces and edges as coinciding. */
const BOOLEAN_FUZZ = 1e-5;

function booleanOnce(kind: "fuse" | "cut" | "common", a: Shape3D, b: Shape3D[], glue: boolean): Shape3D {
  const builder =
    kind === "fuse" ? new oc.BRepAlgoAPI_Fuse() : kind === "cut" ? new oc.BRepAlgoAPI_Cut() : new oc.BRepAlgoAPI_Common();
  const args = new oc.NCollection_List_TopoDS_Shape();
  const tools = new oc.NCollection_List_TopoDS_Shape();
  try {
    args.Append(a.wrapped);
    for (const t of b) tools.Append(t.wrapped);
    builder.SetArguments(args);
    builder.SetTools(tools);
    builder.SetNonDestructive(true);
    // Faces / edges this close count as touching: e.g. a face pushed up to another's height
    // through a display-mesh (float32) point is off by ~1e-6 mm, which would leave a hairline step.
    builder.SetFuzzyValue(BOOLEAN_FUZZ);
    // Oriented bounding boxes to rule out face pairs that can't touch: axis-aligned ones of solids
    // turned off X / Y / Z (e.g. a circular copy's sweeps round a cylinder) all overlap — 7 s → 1 s.
    builder.SetUseOBB(true);
    if (glue) builder.SetGlue(oc.BOPAlgo_GlueEnum.BOPAlgo_GlueShift);
    builder.Build();
    if (builder.HasErrors()) throw new Error(`boolean ${kind} failed`);
    builder.SimplifyResult(true, true, 1e-3);
    return cast(builder.Shape()) as Shape3D;
  } finally {
    args.delete();
    tools.delete();
    builder.delete();
  }
}

/** OpenCascade's BRepCheck: false if the shape is broken (bad topology / geometry). */
export function isValidShape(shape: Shape): boolean {
  const check = new oc.BRepCheck_Analyzer(shape.wrapped, true, false);
  const ok = check.IsValid();
  check.delete();
  return ok;
}

/** Human-readable message for errors thrown by JS or by the wasm kernel. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  const kernel = "geometry kernel could not compute this";
  if (typeof e === "number") return `${kernel} (OpenCascade exception)`;
  if (typeof WebAssembly !== "undefined" && e instanceof WebAssembly.Exception) {
    // (OpenCascade's C++ exception: its type and message, e.g. "StdFail_NotDone: BRep_API: command not done")
    let what = "";
    try {
      const [type, msg] = oc.getExceptionMessage(e) as [string, string | undefined];
      what = [type, msg].filter(Boolean).join(": ");
    } catch {
      // (no details available)
    }
    return `${kernel} (OpenCascade${what ? ": " + what : " exception"})`;
  }
  return String(e);
}

// ---------------------------------------------------------------- tessellation

export interface Tessellation {
  faces: ShapeMesh;
  edges: ShapeEdgeMesh;
}

/** Above this many faces a shape is drawn with coarser round edges (see `tessellate`). */
export const BUSY_FACES = 30;

export function tessellate(shape: Shape | Wire, preview = false): Tessellation {
  const given = meshedElsewhere.get(shape);
  if (given) return given;
  // Size from points along the edges (a bounding box of B-spline faces is slow to compute — tens
  // of ms); midpoints too, for a whole circle whose one edge starts and ends at the same point.
  const ends = shape.edges.flatMap((e) => [0, 0.5, 1].map((t) => e.pointAt(t).toTuple() as V3));
  const span = (k: number) => Math.max(...ends.map((p) => p[k])) - Math.min(...ends.map((p) => p[k]));
  const diag = (ends.length ? Math.hypot(span(0), span(1), span(2)) : 0) || 1;
  const tolerance = Math.min(0.1, Math.max(0.001, diag * 2e-4));
  // A live preview is redrawn on every change: 4x coarser (about a quarter of the triangles,
  // several times faster to mesh), still smooth on screen. Bodies get the full quality — except
  // busy ones (e.g. a plate with 36 round holes): a coarser angle, so small round edges (radius
  // under ~10 mm) get about a third fewer segments; larger curves are set by `tolerance` anyway.
  // (~2.5× faster to mesh)
  const angle = !(shape instanceof Wire) && shape.faces.length > BUSY_FACES ? 0.3 : 0.15;
  const opts = preview ? { tolerance: tolerance * 4, angularTolerance: 0.3 } : { tolerance, angularTolerance: angle };
  if (shape instanceof Wire) return { faces: shape.mesh(opts), edges: shape.meshEdges(opts) }; // a path: lines only
  const { mesh, whole } = meshFaces(shape, opts);
  // Edge lines come from the shape's triangulation; meshed in parts it has none as a whole
  // (OpenCascade would mesh it all again, stand-ins' faces too): from the edges alone then.
  const edgeLines = whole ? shape.meshEdges(opts) : (makeCompound(shape.edges) as unknown as Shape).meshEdges(opts);
  return { faces: mesh, edges: withoutSeams(edgeLines, seamEdgeIds(shape)) };
}

/** Display meshes made in the background kernel for shapes read back here (see takeMesh): tessellate uses them. */
const meshedElsewhere = new WeakMap<object, Tessellation>();

/**
 * The display mesh (full quality) with its faces and edges by place in `shape.faces` / `shape.edges` instead of by
 * id — ids differ between the two kernels; places don't for a shape read from the same BREP text.
 */
export function meshByPlace(shape: Shape): Tessellation {
  const t = tessellate(shape);
  const fi = new Map(shape.faces.map((f, i) => [f.hashCode, i])), ei = new Map(shape.edges.map((e, i) => [e.hashCode, i]));
  return {
    faces: { ...t.faces, faceGroups: t.faces.faceGroups.map((g) => ({ ...g, faceId: fi.get(g.faceId) ?? -1 })) },
    edges: { ...t.edges, edgeGroups: t.edges.edgeGroups.map((g) => ({ ...g, edgeId: ei.get(g.edgeId) ?? -1 })) },
  };
}

/** Give `shape` (read here from the background kernel's BREP text) the display mesh it made (meshByPlace). */
export function takeMesh(shape: Shape, byPlace: Tessellation): void {
  const faces = shape.faces, edges = shape.edges;
  meshedElsewhere.set(shape, {
    faces: { ...byPlace.faces, faceGroups: byPlace.faces.faceGroups.map((g) => ({ ...g, faceId: faces[g.faceId]?.hashCode ?? -1 })) },
    edges: { ...byPlace.edges, edgeGroups: byPlace.edges.edgeGroups.map((g) => ({ ...g, edgeId: edges[g.edgeId]?.hashCode ?? -1 })) },
  });
}

/**
 * Triangles of a shape's faces. A linear-extrusion face (the side of a pushed free-form or
 * stretched outline) is meshed as its exact B-spline instead: OpenCascade meshes the extrusion
 * form ~60× finer than it needs (24,600 triangles for the side of a pushed stretched circle,
 * against 400 — 170 ms, against 10), just as close. Display only: the face keeps its id. A
 * trimmed one (e.g. with a hole) is meshed as it is. `whole` false: meshed in parts.
 */
/** A B-spline face with more control points than this is heavy to mesh (see heavyMeshOpts). */
const HEAVY_POLES = 400;

/**
 * Coarser display-mesh settings for a heavy B-spline face — e.g. a profile swept along a long freeform path
 * (degree 6 × 9, 217 × 6 control points: 410 000 triangles, 6 s, at the usual settings for a 3 × 25 mm tube) —
 * to 0.8% of its size (that tube: 12 000 triangles, 0.12 s); null for any other face. Only what is drawn: the
 * solid, STEP and the STL / 3MF quality stay as they are.
 */
function heavyMeshOpts(f: Face, opts: { tolerance: number; angularTolerance: number }): { tolerance: number; angularTolerance: number } | null {
  if (f.geomType !== "BSPLINE_SURFACE") return null;
  let poles = 0;
  const ad = new oc.BRepAdaptor_Surface(f.wrapped, true);
  try {
    const bs = ad.BSpline();
    poles = bs.NbUPoles() * bs.NbVPoles();
    bs.delete();
  } catch {
    return null;
  } finally {
    ad.delete();
  }
  if (poles <= HEAVY_POLES) return null;
  const ends = f.edges.flatMap((e) => [0, 0.5, 1].map((t) => e.pointAt(t).toTuple() as V3));
  const span = (k: number) => Math.max(...ends.map((p) => p[k])) - Math.min(...ends.map((p) => p[k]));
  const size = Math.hypot(span(0), span(1), span(2)) || 1;
  const tolerance = Math.max(opts.tolerance, size * 8e-3);
  return tolerance > opts.tolerance ? { tolerance, angularTolerance: Math.max(opts.angularTolerance, 0.5) } : null;
}

function meshFaces(shape: Shape, opts: { tolerance: number; angularTolerance: number }): { mesh: ShapeMesh; whole: boolean } {
  const faces = shape.faces;
  const stand = faces.map((f) => (f.geomType === "EXTRUSION_SURFACE" ? extrusionStandIn(f) : null));
  const heavy = faces.map((f, i) => (stand[i] ? null : heavyMeshOpts(f, opts)));
  if (!stand.some(Boolean) && !heavy.some(Boolean)) return { mesh: extractMesh(shape.wrapped, opts), whole: true };
  const rest = faces.filter((_, i) => !stand[i] && !heavy[i]);
  const parts: { mesh: ShapeMesh; id?: number }[] = rest.length ? [{ mesh: extractMesh((makeCompound(rest) as unknown as Shape).wrapped, opts) }] : [];
  stand.forEach((f, i) => f && parts.push({ mesh: extractMesh(f.wrapped, opts), id: faces[i].hashCode }));
  heavy.forEach((o, i) => o && parts.push({ mesh: extractMesh(faces[i].wrapped, o), id: faces[i].hashCode }));
  const out: ShapeMesh = { vertices: [], normals: [], triangles: [], faceGroups: [] };
  for (const { mesh, id } of parts) {
    const v0 = out.vertices.length / 3, t0 = out.triangles.length;
    for (const x of mesh.vertices) out.vertices.push(x);
    for (const x of mesh.normals) out.normals.push(x);
    for (const x of mesh.triangles) out.triangles.push(x + v0);
    for (const g of mesh.faceGroups) out.faceGroups.push({ start: g.start + t0, count: g.count, faceId: id ?? g.faceId });
  }
  return { mesh: out, whole: false };
}

/**
 * The exact B-spline stand-in of a linear-extrusion face, facing the same way — only for a face
 * that is the whole of its parameter rectangle (same area: not trimmed or holed); null otherwise.
 */
function extrusionStandIn(face: Face): Face | null {
  const tmp: { delete(): void }[] = [];
  const keep = <T>(o: T): T => (tmp.push(o as unknown as { delete(): void }), o);
  try {
    const bs = extrudedSurface(face, keep);
    if (!bs) return null;
    const ad = keep(new oc.BRepAdaptor_Surface(face.wrapped, true));
    const mk = keep(new oc.BRepBuilderAPI_MakeFace(bs as never, ad.FirstUParameter(), ad.LastUParameter(), ad.FirstVParameter(), ad.LastVParameter(), 1e-7));
    if (!mk.IsDone()) return null;
    const made = mk.Face();
    const out = new Face(face.wrapped.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED ? oc.TopoDS.Face(made.Reversed()) : made);
    const a = measureArea(face);
    return Math.abs(measureArea(out) - a) <= 1e-6 * Math.max(1, a) ? out : null;
  } catch {
    return null;
  } finally {
    for (const o of tmp) {
      try {
        o.delete();
      } catch {
        // already owned by OpenCascade
      }
    }
  }
}

/**
 * BRepMesh options for display meshes (flags of yddd's ReplicadMeshExtractor.extractWith): its
 * defaults — surface control on (refine inside curved faces until within the tolerance), internal
 * vertices on. (Surface control off looks cheap but isn't close: 2.5 mm off on a pushed oval's
 * side, 6 mm on a stretched dome.)
 */
const MESH_FLAGS = 5;

/** Mesh `shape` (MESH_FLAGS) and read the triangles out. */
function extractMesh(shape: unknown, opts: { tolerance: number; angularTolerance: number }): ShapeMesh {
  const raw = oc.ReplicadMeshExtractor.extractWith(shape, opts.tolerance, opts.angularTolerance, -1, -1, 0, MESH_FLAGS, false);
  try {
    // (read after meshing: the wasm memory may have grown)
    const buf = oc.wasmMemory.buffer;
    const read = <A extends Float32Array | Uint32Array | Int32Array>(Kind: new (b: ArrayBuffer, o: number, n: number) => A, ptr: number, n: number) => Array.from(new Kind(buf, ptr >>> 0, n));
    const groups = read(Int32Array, raw.getFaceGroupsPtr(), raw.getFaceGroupsSize());
    const faceGroups: ShapeMesh["faceGroups"] = [];
    for (let i = 0; i < groups.length; i += 3) faceGroups.push({ start: groups[i], count: groups[i + 1], faceId: groups[i + 2] });
    return {
      vertices: read(Float32Array, raw.getVerticesPtr(), raw.getVerticesSize()),
      normals: read(Float32Array, raw.getNormalsPtr(), raw.getNormalsSize()),
      triangles: read(Uint32Array, raw.getTrianglesPtr(), raw.getTrianglesSize()),
      faceGroups,
    };
  } finally {
    raw.delete();
  }
}

/**
 * Seam edges of a solid: edges used by only ONE face. On a closed solid every
 * real edge separates two faces; an edge with a single face is either the seam
 * where a periodic surface (sphere, cylinder, torus...) wraps onto itself, or a
 * zero-length "degenerate" edge at a pole. Also an edge where two curved faces meet
 * smoothly (e.g. the rings between the arc pieces of a tube swept along a Spline, or two
 * half cylinders). None is a visible crease, so they are not drawn, not pickable and
 * skipped by "fillet all edges". (A flat face meeting a curved one smoothly — a fillet's
 * edge — stays: it shows where the rounding starts.)
 * Flat face bodies have no seams (their single-face edges are the real outline).
 */
export function seamEdgeIds(shape: Shape): Set<number> {
  if (isFaceShape(shape)) return new Set();
  const facesOf = new Map<number, Face[]>();
  for (const face of shape.faces) {
    // A seam appears twice in its face (once per orientation): count each face once.
    for (const id of new Set(face.edges.map((e) => e.hashCode))) {
      const list = facesOf.get(id);
      if (list) list.push(face);
      else facesOf.set(id, [face]);
    }
  }
  const seams = new Set<number>();
  let edges: Map<number, Edge> | null = null;
  for (const [id, faces] of facesOf) {
    if (faces.length === 1) seams.add(id);
    else if (faces.length === 2 && faces.every((f) => f.geomType !== "PLANE")) {
      edges ??= new Map(shape.edges.map((e) => [e.hashCode, e]));
      const e = edges.get(id);
      if (e && smoothJoin(e, faces[0], faces[1])) seams.add(id);
    }
  }
  return seams;
}

/**
 * Faces of a tube-like surface made of smoothly joined pieces — a profile swept along a Spline (its arc pieces) or
 * revolved: a chain of curved faces meeting smoothly (hidden joins, see seamEdgeIds) with a torus in it and running
 * smoothly into no flat face (that would be a fillet: a rounded box, a cylinder's rounded top). A click on one picks
 * the whole solid — one slice of a tube is no use on its own. Cached per shape.
 */
export function smoothSurfaceFaces(shape: Shape): Set<number> {
  const known = smoothSurfaceCache.get(shape);
  if (known) return known;
  const out = new Set<number>();
  smoothSurfaceCache.set(shape, out);
  if (isFaceShape(shape)) return out;
  const seams = seamEdgeIds(shape);
  const faces = shape.faces, edges = new Map(shape.edges.map((e) => [e.hashCode, e]));
  const facesOf = new Map<number, Face[]>();
  for (const f of faces) for (const id of new Set(f.edges.map((e) => e.hashCode))) facesOf.set(id, [...(facesOf.get(id) ?? []), f]);
  const seen = new Set<number>();
  for (const start of faces) {
    if (seen.has(start.hashCode) || start.geomType === "PLANE") continue;
    // The chain: curved faces reached across hidden joins
    const chain: Face[] = [start];
    seen.add(start.hashCode);
    let tangentFlat = false;
    for (let i = 0; i < chain.length; i++) {
      for (const id of new Set(chain[i].edges.map((e) => e.hashCode))) {
        const two = facesOf.get(id);
        if (!two || two.length !== 2) continue;
        const other = two[0].hashCode === chain[i].hashCode ? two[1] : two[0];
        if (other.geomType === "PLANE") {
          const e = edges.get(id);
          if (!tangentFlat && e && smoothJoin(e, chain[i], other)) tangentFlat = true;
        } else if (seams.has(id) && !seen.has(other.hashCode)) {
          seen.add(other.hashCode);
          chain.push(other);
        }
      }
    }
    if (chain.length > 1 && !tangentFlat && chain.some((f) => f.geomType === "TORUS")) for (const f of chain) out.add(f.hashCode);
  }
  return out;
}

const smoothSurfaceCache = new WeakMap<object, Set<number>>();

/** Whether two faces meet smoothly along `e` (the same outward normal at a few points along it). */
function smoothJoin(e: Edge, a: Face, b: Face): boolean {
  try {
    return [0.2, 0.5, 0.8].every((t) => {
      const p = e.pointAt(t).toTuple() as V3;
      return dot3(normalOnEdge(e, a, t) ?? normalNear(a, p), normalOnEdge(e, b, t) ?? normalNear(b, p)) > 1 - 1e-6;
    });
  } catch {
    return false;
  }
}

/**
 * A face's unit normal at a point of one of its edges (`t`: 0…1 along the edge), from the edge's own place on the face
 * (its pcurve) — exact and quick, unlike searching the surface for the point (normalNear: a grid of samples on an
 * extruded Bézier, e.g. a letter's sides — ~1 ms each); null if the edge has none on it.
 */
function normalOnEdge(e: Edge, face: Face, t: number): V3 | null {
  let c: InstanceType<typeof oc.BRepAdaptor_Curve2d> | null = null, uv: { X(): number; Y(): number; delete(): void } | null = null;
  try {
    c = new oc.BRepAdaptor_Curve2d(e.wrapped, face.wrapped);
    const u0 = c.FirstParameter(), u1 = c.LastParameter();
    if (!Number.isFinite(u0) || !Number.isFinite(u1)) return null;
    const at = c.Value(u0 + (u1 - u0) * t);
    uv = at;
    return normalAtParams(face, at.X(), at.Y());
  } catch {
    return null;
  } finally {
    uv?.delete();
    c?.delete();
  }
}

/** Drop the given edges from an edge mesh, re-packing the line buffer. */
function withoutSeams(mesh: ShapeEdgeMesh, seams: Set<number>): ShapeEdgeMesh {
  if (seams.size === 0) return mesh;
  const lines: number[] = [];
  const edgeGroups: ShapeEdgeMesh["edgeGroups"] = [];
  for (const g of mesh.edgeGroups) {
    if (seams.has(g.edgeId)) continue;
    const start = lines.length / 3;
    for (let k = g.start * 3; k < (g.start + g.count) * 3; k++) lines.push(mesh.lines[k]);
    edgeGroups.push({ start, count: g.count, edgeId: g.edgeId });
  }
  return { lines, edgeGroups };
}

// ---------------------------------------------------------------- primitives

const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]];

/** Rectangle of size w×d centered at `center` on the frame's plane, extruded by signed `h`. */
export function makeBox(frame: Frame, center: V3, w: number, d: number, h: number): Solid {
  const plane = new Plane(center, frame.x, h >= 0 ? frame.z : neg(frame.z));
  return drawRoundedRectangle(w, d).sketchOnPlane(plane).extrude(Math.abs(h)) as Solid;
}

export function makeCylinder(frame: Frame, center: V3, r: number, h: number): Solid {
  // Built from one full circle (drawCircle uses two half-arcs, which would split the
  // side into two half-cylinder faces with extra edges).
  return occCylinder(r, Math.abs(h), center, h >= 0 ? frame.z : neg(frame.z));
}

export function makeSphereAt(center: V3, r: number): Solid {
  return makeSphere(r).translate(center);
}

/**
 * Cone on the frame's plane: base radius `r1` at `center`, top radius `r2` (0: a sharp tip; > 0: a cut-off
 * cone) at signed height `h`. (No cone primitive in the wasm build: its side profile, revolved a full turn.)
 */
export function makeCone(frame: Frame, center: V3, r1: number, r2: number, h: number): Solid {
  if (!(r1 > 0) || r2 < 0 || Math.abs(h) < 1e-9) throw new Error("Cone: radius must be > 0 and height not 0");
  const up = h >= 0 ? frame.z : neg(frame.z), H = Math.abs(h);
  const at = (rad: number, ax: number): V3 => [0, 1, 2].map((k) => center[k] + rad * frame.x[k] + ax * up[k]) as V3;
  const profile = r2 > 1e-9 ? [at(0, 0), at(r1, 0), at(r2, H), at(0, H)] : [at(0, 0), at(r1, 0), at(0, H)];
  return revolution(makePolygon(profile), center, up, 360) as Solid;
}

/**
 * Regular polygon prism: `sides` corners on a circle of radius `r` (circumradius)
 * centered at `center`, first corner at `angleDeg` measured in the frame's
 * plane from frame.x toward frame.y, extruded by signed `h`.
 */
export function makePolygonPrism(frame: Frame, center: V3, r: number, sides: number, angleDeg: number, h: number): Solid {
  const flipped = h < 0;
  const plane = new Plane(center, frame.x, flipped ? neg(frame.z) : frame.z);
  // drawPolysides puts its first corner at +90°; a flipped plane mirrors local Y.
  const localAngle = flipped ? -angleDeg : angleDeg;
  return drawPolysides(r, sides).rotate(localAngle - 90, [0, 0]).sketchOnPlane(plane).extrude(Math.abs(h)) as Solid;
}

// ---------------------------------------------------------------- flat faces (regions)

const facePlane = (frame: Frame, center: V3) => new Plane(center, frame.x, frame.z);

/**
 * Make the face normal point along the frame normal (the side it was drawn on).
 * replicad is not consistent here (e.g. circles come out reversed), and Push/Pull
 * uses the face normal as its positive direction.
 */
function orientFace(face: Face, frame: Frame): Face {
  const n = face.normalAt(face.center).toTuple();
  const dot = n[0] * frame.z[0] + n[1] * frame.z[1] + n[2] * frame.z[2];
  return dot < 0 ? face.flipOrientation() : face;
}

/**
 * A closed sketch outline on a plane: straight lines / arcs (through `m`) / freeform curves end to
 * end, or a full circle. A freeform curve: rational quadratic pieces — `pts` 2n+1 control points
 * (the first / last are its ends), `w` their weights.
 */
export type SketchLoop =
  | { kind: "path"; segs: ({ kind: "line"; a: V3; b: V3 } | { kind: "arc"; a: V3; m: V3; b: V3 } | { kind: "spline"; pts: V3[]; w: number[] })[] }
  | { kind: "circle"; c: V3; r: number };
export type SketchSeg = Extract<SketchLoop, { kind: "path" }>["segs"][number];

/** A sketch freeform curve as one B-spline edge (degree 2, rational). */
function sketchSplineEdge(pts: V3[], w: number[]): Edge {
  const tmp: { delete(): void }[] = [];
  const keep = <T>(o: T): T => (tmp.push(o as unknown as { delete(): void }), o);
  try {
    const n = (pts.length - 1) / 2;
    const poles = keep(new oc.NCollection_Array1_gp_Pnt(1, pts.length)), weights = keep(new oc.NCollection_Array1_double(1, pts.length));
    pts.forEach((p, i) => {
      poles.SetValue(i + 1, keep(new oc.gp_Pnt(...p)));
      weights.SetValue(i + 1, w[i]);
    });
    const knots = keep(new oc.NCollection_Array1_double(1, n + 1)), mults = keep(new oc.NCollection_Array1_int(1, n + 1));
    for (let i = 0; i <= n; i++) {
      knots.SetValue(i + 1, i);
      mults.SetValue(i + 1, i === 0 || i === n ? 3 : 2);
    }
    const bs = new oc.Geom_BSplineCurve(poles, weights, knots, mults, 2, false, true);
    const mk = keep(new oc.BRepBuilderAPI_MakeEdge(bs as never));
    return cast(mk.Edge()) as Edge;
  } finally {
    tmp.forEach((o) => o.delete());
  }
}

const sketchEdge = (g: SketchSeg): Edge => (g.kind === "line" ? makeLine(g.a, g.b) : g.kind === "arc" ? makeThreePointArc(g.a, g.m, g.b) : sketchSplineEdge(g.pts, g.w));

/** An open sketch path (lines / arcs / freeform curves end to end) as a wire. */
export function sketchPath(segs: SketchSeg[]): Wire {
  return assembleWire(segs.map(sketchEdge));
}

/**
 * Back into the sketch (select face objects / paths, K): a face's outlines (outer and holes) or a path's
 * edges as sketch outlines / open paths, in 3D — lines, arcs, whole circles, and freeform curves as the
 * sketch's degree-2 rational pieces. Throws on a curve the sketch can't hold (e.g. a degree-3 spline).
 */
export function sketchOfShape(shape: Shape | Wire, name: string): { loops: SketchLoop[]; opens: SketchSeg[][] } {
  const loops: SketchLoop[] = [], opens: SketchSeg[][] = [];
  const wires = shape instanceof Wire ? [shape] : (shape as Shape).wires;
  for (const w of wires) {
    const edges = w.edges;
    // A whole circle: one closed circle edge.
    if (edges.length === 1 && edges[0].geomType === "CIRCLE" && near3(edges[0].startPoint.toTuple() as V3, edges[0].endPoint.toTuple() as V3)) {
      const e = edges[0], [p0, p1, p2] = [0, 1 / 3, 2 / 3].map((t) => e.pointAt(t).toTuple() as V3);
      const c = circumcentre(p0, p1, p2);
      loops.push({ kind: "circle", c, r: Math.hypot(...sub3(p0, c)) });
      continue;
    }
    // Edges end to end (in wire order or not), each turned to run on from the last.
    const segs: SketchSeg[] = [];
    const left = edges.map((e) => sketchSegsOfEdge(e, name));
    let end: V3 | null = null;
    while (left.length) {
      let i = end ? left.findIndex((g) => near3(segStart(g[0]), end!) || near3(segEnd(g[g.length - 1]), end!)) : 0;
      if (i < 0) i = 0; // (not connected: start a new run — shouldn't happen in one wire)
      let g = left.splice(i, 1)[0];
      if (end && !near3(segStart(g[0]), end)) g = g.map(revSketchSeg).reverse();
      segs.push(...g);
      end = segEnd(g[g.length - 1]);
    }
    const closed = segs.length > 0 && near3(segStart(segs[0]), segEnd(segs[segs.length - 1]));
    if (closed) loops.push({ kind: "path", segs });
    else opens.push(segs);
  }
  return { loops, opens };
}

const near3 = (a: V3, b: V3) => Math.hypot(...sub3(a, b)) < 1e-6;
const segStart = (g: SketchSeg): V3 => (g.kind === "spline" ? g.pts[0] : g.a);
const segEnd = (g: SketchSeg): V3 => (g.kind === "spline" ? g.pts[g.pts.length - 1] : g.b);
const revSketchSeg = (g: SketchSeg): SketchSeg =>
  g.kind === "line" ? { kind: "line", a: g.b, b: g.a } : g.kind === "arc" ? { kind: "arc", a: g.b, m: g.m, b: g.a } : { kind: "spline", pts: [...g.pts].reverse(), w: [...g.w].reverse() };

/** Centre of the circle through three points. */
function circumcentre(a: V3, b: V3, c: V3): V3 {
  const ab = sub3(b, a), ac = sub3(c, a), n = cross3(ab, ac), n2 = dot3(n, n);
  const t = add3(cross3(n, ab).map((k) => k * dot3(ac, ac)) as V3, cross3(ac, n).map((k) => k * dot3(ab, ab)) as V3);
  return add3(a, t.map((k) => k / (2 * n2)) as V3);
}

/** One edge as sketch segments (a degree-1 spline: its straight pieces). */
function sketchSegsOfEdge(e: Edge, name: string): SketchSeg[] {
  const a = e.startPoint.toTuple() as V3, b = e.endPoint.toTuple() as V3;
  if (e.geomType === "LINE") return [{ kind: "line", a, b }];
  if (e.geomType === "CIRCLE") return [{ kind: "arc", a, m: e.pointAt(0.5).toTuple() as V3, b }];
  const tmp: { delete(): void }[] = [];
  const keep = <T>(o: T): T => (tmp.push(o as unknown as { delete(): void }), o);
  try {
    const c = oc.BRep_Tool.Curve(e.wrapped, 0, 0);
    const bs = keep(oc.GeomConvert.CurveToBSplineCurve(keep(new oc.Geom_TrimmedCurve(c.returnValue, c.First, c.Last, true, true)) as never));
    if (bs.IsPeriodic()) bs.SetNotPeriodic();
    const pole = (i: number): V3 => {
      const p = keep(bs.Pole(i));
      return [p.X(), p.Y(), p.Z()];
    };
    const deg = bs.Degree();
    if (deg === 1) return Array.from({ length: bs.NbPoles() - 1 }, (_, i) => ({ kind: "line", a: pole(i + 1), b: pole(i + 2) }) as SketchSeg);
    if (deg !== 2) throw new Error(`Sketch: "${name}" has a freeform curve the sketch can't edit (degree ${deg})`);
    // Pieces end to end: every inside knot twice (2n + 1 control points, every 2nd one on the curve).
    for (let i = 2; i < bs.NbKnots(); i++) if (bs.Multiplicity(i) < 2) bs.IncreaseMultiplicity(i, 2);
    const n = bs.NbPoles();
    const pts = Array.from({ length: n }, (_, i) => pole(i + 1));
    const w = Array.from({ length: n }, (_, i) => bs.Weight(i + 1));
    return [{ kind: "spline", pts, w }];
  } finally {
    tmp.forEach((o) => o.delete());
  }
}

/**
 * Flat face(s) of a sketch outline with the outlines inside it cut out as holes, facing `normal`.
 * Usually one face; a hole touching the outline can split it into several.
 */
export function sketchFaces(outer: SketchLoop, holes: SketchLoop[], normal: V3): Face[] {
  const face = (loop: SketchLoop): Face => {
    const wire = loop.kind === "circle"
      ? assembleWire([makeCircle(loop.r, loop.c, normal)])
      : assembleWire(loop.segs.map(sketchEdge));
    let f = makeFace(wire);
    if (dot3(f.normalAt().toTuple() as V3, normal) < 0) f = f.flipOrientation();
    if (!isValidShape(f)) throw new Error("Sketch: an outline crosses itself");
    return f;
  };
  const f = face(outer);
  if (!holes.length) return [f];
  const faces = boolean("cut", f as unknown as Shape3D, holes.map((h) => face(h) as unknown as Shape3D)).faces;
  if (!faces.length || faces.some((x) => !isValidShape(x))) throw new Error("Sketch: could not cut the inner outlines out");
  return faces.map((x) => (dot3(x.normalAt().toTuple() as V3, normal) < 0 ? x.flipOrientation() : x));
}

/** Flat faces on one plane joined into one (where they touch or overlap), facing `normal`. */
export function joinFlatFaces(faces: Face[], normal: V3): Face[] {
  if (faces.length < 2) return faces;
  const joined = boolean("fuse", faces[0] as unknown as Shape3D, faces.slice(1) as unknown as Shape3D[]).simplify().faces;
  if (!joined.length || joined.some((f) => !isValidShape(f))) throw new Error("Sketch: could not join the outlines");
  return joined.map((f) => (dot3(f.normalAt().toTuple() as V3, normal) < 0 ? f.flipOrientation() : f));
}

/** Flat w×d rectangle face centered at `center` on the frame's plane. */
export function makeRectFace(frame: Frame, center: V3, w: number, d: number): Face {
  return orientFace((drawRoundedRectangle(w, d).sketchOnPlane(facePlane(frame, center)) as Sketch).face(), frame);
}

export function makeCircleFace(frame: Frame, center: V3, r: number): Face {
  // One full circle edge (not drawCircle's two half-arcs) → clean 1-edge face.
  return orientFace(makeFace(assembleWire([makeCircle(r, center, frame.z)])), frame);
}

/** Flat regular polygon face; first corner at `angleDeg` (from frame.x toward frame.y). */
export function makePolygonFace(frame: Frame, center: V3, r: number, sides: number, angleDeg: number): Face {
  // drawPolysides puts its first corner at +90°.
  return orientFace((drawPolysides(r, sides).rotate(angleDeg - 90, [0, 0]).sketchOnPlane(facePlane(frame, center)) as Sketch).face(), frame);
}

// ---------------------------------------------------------------- text

export type TextAlign = "left" | "center" | "right";

export interface TextOptions {
  /** Height of a capital letter (H), mm. */
  height: number;
  align: TextAlign;
  /** Line spacing, × the font's own line height. */
  lineSpacing: number;
  /** Extra space between letters, mm (negative: closer). */
  letterSpacing?: number;
  /** A font loaded with loadTextFont (its name: a built-in one's key or a font file); "" / none: Noto Sans. */
  font?: string;
}

/** The fonts that come with YDDD (vendor/fonts): `key` is the name they're loaded under ("" = the default). */
export const BUILT_IN_FONTS: { family: string; style: string; key: string; url: string }[] = [
  { family: "Noto Sans", style: "Regular", key: "", url: notoSans },
  { family: "Noto Sans", style: "Bold", key: "builtin:NotoSans-Bold", url: notoSansBold },
  { family: "Noto Serif", style: "Regular", key: "builtin:NotoSerif-Regular", url: notoSerif },
  { family: "Noto Serif", style: "Bold", key: "builtin:NotoSerif-Bold", url: notoSerifBold },
  { family: "Noto Sans Thai", style: "Regular", key: "builtin:NotoSansThai-Regular", url: notoThai },
  { family: "Noto Sans Thai", style: "Bold", key: "builtin:NotoSansThai-Bold", url: notoThaiBold },
];

/**
 * Load a font for Text under `name` — a font file's contents, or a built-in one's key. The built-in fonts
 * (the default, and the fallbacks for letters a font hasn't got) are all loaded first.
 */
export async function loadTextFont(name?: string, data?: Uint8Array): Promise<void> {
  if (!getFont()) await loadFont(notoSans);
  for (const f of BUILT_IN_FONTS) if (f.key && !getFont(f.key)) await loadFont(f.url, f.key);
  if (name && data && !getFont(name)) await loadFont(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, name);
}

export function textFontReady(name?: string): boolean {
  return !!getFont(name || "default") && BUILT_IN_FONTS.every((f) => !!getFont(f.key || "default"));
}

type OtFont = NonNullable<ReturnType<typeof getFont>>;

/**
 * Split a line into runs, each in one font: the chosen one, or — for letters it hasn't got — the built-in
 * Noto Sans, then Noto Sans Thai (bold ones for a bold font). So Thai shows in any font, and Latin in the Thai one.
 */
function fontRuns(line: string, family: string, font: OtFont): { text: string; family: string }[] {
  const os2 = font.tables.os2 as { usWeightClass?: number } | undefined;
  const bold = (os2?.usWeightClass ?? 400) >= 600;
  const fallbacks = [bold ? "builtin:NotoSans-Bold" : "default", bold ? "builtin:NotoSansThai-Bold" : "builtin:NotoSansThai-Regular"];
  const runs: { text: string; family: string }[] = [];
  for (const ch of line) {
    const has = (f: string) => {
      const ft = getFont(f);
      return !!ft && ft.charToGlyph(ch).index > 0;
    };
    const fam = /\s/.test(ch) || has(family) ? family : (fallbacks.find(has) ?? family);
    const last = runs[runs.length - 1];
    if (last && last.family === fam) last.text += ch;
    else runs.push({ text: ch, family: fam });
  }
  return runs;
}

/**
 * Flat faces of `text` (one per letter outline, with its holes: o, A, B...) on the frame's plane. `anchor` is
 * on the first line's baseline — its start (left), middle (center) or end (right); more lines go down frame.y.
 * Empty / spaces only → [].
 */
export function makeTextFaces(frame: Frame, anchor: V3, text: string, o: TextOptions): Face[] {
  const family = o.font || "default";
  const font = getFont(family);
  if (!font) throw new Error("the text font isn't loaded yet");
  if (!(o.height > 0)) throw new Error("text height must be > 0");
  const em = font.unitsPerEm;
  // Capital height: the font's own H (not every font states it — older OS/2 tables have no sCapHeight)
  const h = font.charToGlyph("H"), hTop = h.index ? h.getBoundingBox().y2 : 0;
  const cap = hTop > 0 ? hTop : (font.tables.os2 as { sCapHeight?: number } | undefined)?.sCapHeight || em * 0.7;
  // (one size for every run: a fallback font's letters keep their own proportions to its em)
  const size = (o.height * em) / cap;
  const lineH = ((font.ascender - font.descender) / em) * size * (o.lineSpacing || 1);
  const plane = facePlane(frame, anchor);
  const gap = o.letterSpacing || 0;
  const opts = { kerning: true, letterSpacing: gap / size }; // (opentype.js: a fraction of the font size)
  // textBlueprints draws with font.getPath(text, x, y, size) — no options: these are passed in for these calls.
  type GetPath = (t: string, x: number, y: number, s: number, op?: object) => unknown;
  const patched: { getPath: GetPath }[] = [];
  const patch = (f: OtFont) => {
    const own = f as unknown as { getPath: GetPath };
    if (patched.includes(own)) return;
    const proto = own.getPath;
    own.getPath = (t, x, y, s) => proto.call(f, t, x, y, s, opts);
    patched.push(own);
  };
  const faces: Face[] = [];
  try {
    text.split(/\r?\n/).forEach((line, k) => {
      if (!line.trim()) return;
      const runs = fontRuns(line, family, font).map((r) => ({ ...r, w: getFont(r.family)!.getAdvanceWidth(r.text, size, opts) }));
      const w = runs.reduce((a, r) => a + r.w, 0) - gap; // (no gap after the last letter)
      let x = o.align === "center" ? -w / 2 : o.align === "right" ? -w : 0;
      for (const r of runs) {
        if (r.text.trim()) {
          patch(getFont(r.family)!);
          const bp = textBlueprints(r.text, { fontSize: size, fontFamily: r.family }).translate(x, -k * lineH);
          for (const sk of bp.sketchOnPlane(plane).sketches) faces.push(orientFace(sk.face(), frame));
        }
        x += r.w;
      }
    });
  } finally {
    for (const own of patched) delete (own as Partial<typeof own>).getPath; // (back to the prototype's)
  }
  return faces;
}

/** A text as the Text tool made it: its settings, and the plane it was written on (`origin` on the first baseline). */
export interface TextSource extends TextOptions {
  text: string;
  frame: Frame;
}

/** Where a text's letters are now (see textPlacement). */
export interface TextPlacement {
  /** The plane they're on now (origin on the first baseline; x along it, y up the letters). */
  frame: Frame;
  /** How much bigger than they were made. */
  scale: number;
  /** Pushed into solids: how far, along frame.z (negative: the other way); flat letters: null. */
  push: number | null;
  /** Flat letters facing −frame.z (turned over by a mirror). */
  flip: boolean;
}

/**
 * Where the letters of a text are now — moved, turned, scaled evenly, mirrored or pushed into solids (all
 * the same way) since `src` made them: its letters made again, and the move that puts each one's edges on the
 * current ones' (edges keep their order through those). Null if they don't line up: letters deleted, cut,
 * filleted... or the font is missing.
 */
export function textPlacement(src: TextSource, letters: Shape[]): TextPlacement | null {
  if (!letters.length) return null;
  const flat = letters.every(isFaceShape), solid = letters.every((l) => !isFaceShape(l));
  if (!flat && !solid) return null;
  let made: Face[];
  try {
    made = makeTextFaces(src.frame, src.frame.origin, src.text, src);
  } catch {
    return null;
  }
  if (made.length !== letters.length) return null;
  // Pushed letters: compared with the made ones pushed 1 mm (the fit then finds how far they really went).
  const refs: Shape[] = solid ? made.map((f) => extrudeFace(f, f.hashCode, 1)) : made;
  const P: V3[] = [], Q: V3[] = [];
  const mids = (sh: Shape) => sh.edges.map((e) => e.pointAt(0.5).toTuple() as V3);
  for (let i = 0; i < refs.length; i++) {
    const p = mids(refs[i]), q = mids(letters[i]);
    if (p.length !== q.length) return null;
    P.push(...p);
    Q.push(...q);
  }
  if (flat) {
    // Flat letters lie in one plane: points off it (along the normals, scaled alike) fix the rest of the move.
    const areaOf = (fs: Shape[]) => fs.reduce((a, f) => a + measureArea(f), 0);
    const s = Math.sqrt(areaOf(letters) / areaOf(refs));
    const nNow = norm3((letters[0] as Face).normalAt().toTuple() as V3), n0 = src.frame.z, L = src.height;
    const k = P.length;
    for (let i = 0; i < k; i++) {
      P.push([P[i][0] + n0[0] * L, P[i][1] + n0[1] * L, P[i][2] + n0[2] * L]);
      Q.push([Q[i][0] + nNow[0] * L * s, Q[i][1] + nNow[1] * L * s, Q[i][2] + nNow[2] * L * s]);
    }
  }
  const fit = fitAffine(P, Q);
  if (!fit) return null;
  const { A, t } = fit;
  const map = (p: V3): V3 => [0, 1, 2].map((i) => A[i * 3] * p[0] + A[i * 3 + 1] * p[1] + A[i * 3 + 2] * p[2] + t[i]) as V3;
  const lin = (v: V3): V3 => [0, 1, 2].map((i) => A[i * 3] * v[0] + A[i * 3 + 1] * v[1] + A[i * 3 + 2] * v[2]) as V3;
  const size = Math.max(...[0, 1, 2].map((k) => Math.max(...Q.map((q) => q[k])) - Math.min(...Q.map((q) => q[k]))));
  if (P.some((p, i) => Math.hypot(...map(p).map((x, k) => x - Q[i][k])) > 1e-4 + 1e-5 * size)) return null;
  const ax = lin(src.frame.x), ay = lin(src.frame.y);
  const x = norm3(ax), yRaw = [0, 1, 2].map((k) => ay[k] - dot3(ay, x) * x[k]) as V3, y = norm3(yRaw), z = cross3(x, y);
  const scale = (Math.hypot(...ax) + Math.hypot(...ay)) / 2;
  const frame: Frame = { origin: map(src.frame.origin), x, y, z };
  if (solid) return { frame, scale, push: dot3(lin(src.frame.z), z), flip: false };
  return { frame, scale, push: null, flip: dot3(norm3((letters[0] as Face).normalAt().toTuple() as V3), z) < 0 };
}

/** The affine map q ≈ A·p + t (A row by row) that fits the point pairs best (least squares); null if they're too few / flat. */
function fitAffine(P: V3[], Q: V3[]): { A: number[]; t: V3 } | null {
  const n = P.length;
  if (n < 4) return null;
  const mean = (X: V3[]) => [0, 1, 2].map((k) => X.reduce((a, p) => a + p[k], 0) / n) as V3;
  const pm = mean(P), qm = mean(Q);
  // C = Σ dp·dpᵀ, B = Σ dq·dpᵀ; A = B·C⁻¹
  const C = new Array(9).fill(0), B = new Array(9).fill(0);
  for (let i = 0; i < n; i++) {
    const dp = [0, 1, 2].map((k) => P[i][k] - pm[k]), dq = [0, 1, 2].map((k) => Q[i][k] - qm[k]);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      C[r * 3 + c] += dp[r] * dp[c];
      B[r * 3 + c] += dq[r] * dp[c];
    }
  }
  const det = C[0] * (C[4] * C[8] - C[5] * C[7]) - C[1] * (C[3] * C[8] - C[5] * C[6]) + C[2] * (C[3] * C[7] - C[4] * C[6]);
  const tr = C[0] + C[4] + C[8];
  if (!(Math.abs(det) > 1e-12 * tr * tr * tr)) return null;
  const inv = [
    C[4] * C[8] - C[5] * C[7], C[2] * C[7] - C[1] * C[8], C[1] * C[5] - C[2] * C[4],
    C[5] * C[6] - C[3] * C[8], C[0] * C[8] - C[2] * C[6], C[2] * C[3] - C[0] * C[5],
    C[3] * C[7] - C[4] * C[6], C[1] * C[6] - C[0] * C[7], C[0] * C[4] - C[1] * C[3],
  ].map((v) => v / det);
  const A = [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => B[r * 3] * inv[c] + B[r * 3 + 1] * inv[3 + c] + B[r * 3 + 2] * inv[6 + c]));
  const t = [0, 1, 2].map((r) => qm[r] - (A[r * 3] * pm[0] + A[r * 3 + 1] * pm[1] + A[r * 3 + 2] * pm[2])) as V3;
  return { A, t };
}

/** A text's letters as textPlacement found them: flat (turned over if `flip`), or pushed `push` along frame.z. */
export function textLetters(src: TextSource, push: number | null, flip: boolean): Shape[] {
  const faces = makeTextFaces(src.frame, src.frame.origin, src.text, src).map((f) => (flip ? f.flipOrientation() : f));
  return push === null ? faces : faces.map((f) => extrudeFace(f, f.hashCode, push));
}

/**
 * Extrude one face (of a flat face body or of a solid) into a NEW solid,
 * `distance` along the face normal (negative = opposite side).
 * The source shape is not modified.
 */
export function extrudeFace(shape: Shape, faceId: number, distance: number): Solid {
  const face = findFace(shape, faceId);
  if (!face) throw new Error("face not found");
  if (Math.abs(distance) < 1e-9) throw new Error("distance must not be 0");
  const n = face.geomType === "PLANE" ? norm3(face.normalAt().toTuple() as V3) : normalAtUV(face, 0.5, 0.5);
  const along = (d: number) => new Vector([n[0] * d, n[1] * d, n[2] * d]);
  if (distance > 0) return basicFaceExtrusion(face, along(distance)).simplify();
  // Extrude the other way by moving a copy back first and prisming along the normal,
  // which keeps the solid's orientation (positive volume).
  const moved = face.clone().translate([n[0] * distance, n[1] * distance, n[2] * distance]);
  return basicFaceExtrusion(moved, along(-distance)).simplify();
}

// ---------------------------------------------------------------- topology lookup

export function findFace(shape: Shape, faceId: number): Face | undefined {
  return shape.faces.find((f) => f.hashCode === faceId);
}

/** Ids of the edges bounding a face (empty if the face is not found). */
export function faceEdgeIds(shape: Shape, faceId: number): Set<number> {
  const face = findFace(shape, faceId);
  return new Set(face ? face.edges.map((e) => e.hashCode) : []);
}

/**
 * If the face is planar, return a sketch frame on it. The origin is the
 * projection of the world origin so grid snapping stays world-aligned.
 */
export function planarFaceFrame(shape: Shape, faceId: number): Frame | null {
  const face = findFace(shape, faceId);
  if (!face || face.geomType !== "PLANE") return null;
  return frameOnPlane(face.center.toTuple() as V3, face.normalAt(face.center).normalized().toTuple() as V3);
}

/**
 * A sketch frame on the plane touching a curved face — at `near` (a point on the face, e.g. under
 * the cursor) or else its middle — facing out. Anything drawn on it is flat: it touches the face
 * there, it doesn't follow the curve.
 */
export function tangentFaceFrame(shape: Shape, faceId: number, near?: V3): { frame: Frame; at: V3 } | null {
  const face = findFace(shape, faceId);
  if (!face) return null;
  const at = near ?? (pointOnFace(face).toTuple() as V3);
  return { frame: frameOnPlane(at, near ? normalNear(face, near) : normalAtUV(face, 0.5, 0.5)), at };
}

/** A frame on the plane through `c` with normal `z`: x level (world X on top / bottom faces), origin the world origin's projection. */
function frameOnPlane(c: V3, z: V3): Frame {
  const ref: V3 = Math.abs(z[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  // x = normalize(ref - (ref·z) z)  (for top/bottom faces this is world X)
  const rd = ref[0] * z[0] + ref[1] * z[1] + ref[2] * z[2];
  let x: V3 = [ref[0] - rd * z[0], ref[1] - rd * z[1], ref[2] - rd * z[2]];
  const xl = Math.hypot(...x);
  x = [x[0] / xl, x[1] / xl, x[2] / xl];
  const y: V3 = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const dist = c[0] * z[0] + c[1] * z[1] + c[2] * z[2];
  return { origin: [z[0] * dist, z[1] * dist, z[2] * dist], x, y, z };
}

/** Centre point and (outward) normal of a face, e.g. as a drag axis for push/pull. */
export function faceAxis(shape: Shape, faceId: number): { center: V3; normal: V3 } | null {
  const face = findFace(shape, faceId);
  if (!face) return null;
  const p = pointOnFace(face);
  return { center: p.toTuple() as V3, normal: face.geomType === "PLANE" ? norm3(face.normalAt().toTuple() as V3) : normalAtUV(face, 0.5, 0.5) };
}

/** The point of edge `edgeId` of `shape` nearest `p` (exact B-rep curve), or null. */
/**
 * Where the line through `origin` along world axis k (0 = X, 1 = Y, 2 = Z) meets an edge: the
 * point on the edge nearest that line, or null if the line passes it by (more than 1e-6 mm).
 */
export function axisCrossEdge(shape: Shape, edgeId: number, origin: V3, k: number): V3 | null {
  const edge = shape.edges.find((e) => e.hashCode === edgeId);
  if (!edge) return null;
  const a: V3 = [...origin], b: V3 = [...origin];
  a[k] -= 1e5;
  b[k] += 1e5;
  const line = makeLine(a, b);
  const d = new oc.BRepExtrema_DistShapeShape(line.wrapped, edge.wrapped);
  try {
    if (!d.IsDone() || d.NbSolution() < 1 || d.Value() > 1e-6) return null;
    const q = d.PointOnShape2(1);
    const out: V3 = [q.X(), q.Y(), q.Z()];
    q.delete();
    return out;
  } catch {
    return null;
  } finally {
    d.delete();
    line.delete();
  }
}

export function nearestOnEdge(shape: Shape | Wire, edgeId: number, p: V3): V3 | null {
  const edge = shape.edges.find((e) => e.hashCode === edgeId);
  if (!edge) return null;
  const v = makeVertex(p);
  const d = new oc.BRepExtrema_DistShapeShape(v.wrapped, edge.wrapped);
  try {
    if (!d.IsDone() || d.NbSolution() < 1) return null;
    const q = d.PointOnShape2(1);
    const out: V3 = [q.X(), q.Y(), q.Z()];
    q.delete();
    return out;
  } catch {
    return null;
  } finally {
    d.delete();
    v.delete();
  }
}

/**
 * The cone of a CONE face, placed where the face is. Not `BRepAdaptor_Surface.Cone()`: gp_Cone isn't
 * in this wasm build — the face's Geom_ConicalSurface (under any trimming) has the same Position /
 * RefRadius / SemiAngle.
 */
function coneOf(face: Face): { Position(): any; RefRadius(): number; SemiAngle(): number; delete(): void } {
  let s = oc.BRep_Tool.Surface(face.wrapped); // (with the face's location applied)
  while (typeof s.SemiAngle !== "function" && typeof s.BasisSurface === "function") {
    const basis = s.BasisSurface();
    s.delete();
    s = basis;
  }
  if (typeof s.SemiAngle !== "function") {
    s.delete();
    throw new Error("not a cone");
  }
  return s;
}

/**
 * A middle point of a face, on the face: its centre if flat; for a curved face the middle of its
 * (u, v) range — its centre of mass can be off the surface, even on the axis of a cylinder,
 * where the normal is undefined.
 */
function pointOnFace(face: Face): Vector {
  return face.geomType === "PLANE" ? face.center : face.pointOnSurface(0.5, 0.5);
}

/** Unit normal of a face (facing the way the face does) at surface parameters (u, v). */
function normalAtParams(face: Face, u: number, v: number): V3 {
  const g = new oc.BRepGProp_Face(face.wrapped, false), p = new oc.gp_Pnt(), n = new oc.gp_Vec();
  try {
    g.Normal(u, v, p, n);
    return norm3([n.X(), n.Y(), n.Z()]);
  } finally {
    g.delete();
    p.delete();
    n.delete();
  }
}

/** Unit normal of a face at (s, t), each 0..1 across its parameter range — no point projection involved. */
function normalAtUV(face: Face, s: number, t: number): V3 {
  const ad = new oc.BRepAdaptor_Surface(face.wrapped, true);
  try {
    const u0 = ad.FirstUParameter(), u1 = ad.LastUParameter(), v0 = ad.FirstVParameter(), v1 = ad.LastVParameter();
    return normalAtParams(face, u0 + (u1 - u0) * s, v0 + (v1 - v0) * t);
  } finally {
    ad.delete();
  }
}

/**
 * Unit normal of a face at the point of it nearest `p`. Instead of replicad's normalAt(p): that
 * projects `p` with OpenCascade's point-on-surface search, which reads out of bounds on a
 * linear-extrusion surface and can crash the whole renderer. So a flat face uses its one normal,
 * an extrusion is searched on its exact B-spline (same parameters), anything else as usual.
 */
function normalNear(face: Face, p: V3): V3 {
  if (face.geomType === "PLANE") return norm3(face.normalAt().toTuple() as V3);
  if (face.geomType !== "EXTRUSION_SURFACE") return norm3(face.normalAt(p).toTuple() as V3);
  const tmp: { delete(): void }[] = [];
  const keep = <T>(o: T): T => (tmp.push(o as unknown as { delete(): void }), o);
  try {
    const bs = extrudedSurface(face, keep);
    if (bs) {
      const pr = keep(new oc.GeomAPI_ProjectPointOnSurf(keep(new oc.gp_Pnt(...p)), bs as never));
      if (pr.IsDone() && pr.NbPoints() > 0) {
        const { U, V } = pr.LowerDistanceParameters(0, 0);
        return normalAtParams(face, U, V);
      }
    }
    // Not a B-spline sweep: the nearest of a grid of parameter samples.
    let best = { d: Infinity, s: 0.5, t: 0.5 };
    for (let i = 0; i <= 16; i++) for (let j = 0; j <= 16; j++) {
      const q = face.pointOnSurface(i / 16, j / 16).toTuple() as V3, d = Math.hypot(...sub3(q, p));
      if (d < best.d) best = { d, s: i / 16, t: j / 16 };
    }
    return normalAtUV(face, best.s, best.t);
  } finally {
    for (const o of tmp) {
      try {
        o.delete();
      } catch {
        // already owned by OpenCascade
      }
    }
  }
}

// ---------------------------------------------------------------- modeling ops

/**
 * Edges of a solid running in one direction: "vertical" = straight edges along Z;
 * "horizontal" = edges lying at one height (straight or curved, e.g. a rounded rim).
 */
export function edgesAlong(shape: Shape, which: "vertical" | "horizontal"): Set<number> {
  const out = new Set<number>();
  const [lo, hi] = shape.boundingBox.bounds;
  const tol = 1e-6 * Math.max(1, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]));
  for (const e of shape.edges) {
    const a = e.startPoint.toTuple(), b = e.endPoint.toTuple();
    if (which === "vertical") {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      if (e.geomType === "LINE" && len > tol && Math.abs(b[2] - a[2]) / len > 1 - 1e-9) out.add(e.hashCode);
    } else if ([0.25, 0.5, 0.75, 1].every((t) => Math.abs(e.pointAt(t).toTuple()[2] - a[2]) < tol)) {
      out.add(e.hashCode);
    }
  }
  return out;
}

/** Fillet the given edges, or (null) every real edge — seams are never filleted. */
export function filletEdges(shape: Solid, edgeIds: Set<number> | null, radius: number): Solid {
  const seams = seamEdgeIds(shape);
  return shape.fillet((e) => (!seams.has(e.hashCode) && (!edgeIds || edgeIds.has(e.hashCode)) ? radius : null));
}

/** A fillet / chamfer that could only round some of the edges asked for (see roundSome). */
export interface RoundResult {
  shape: Solid;
  /** Edges (ids on the input) left sharp: they can't be done at this size. Empty: all done. */
  skipped: number[];
  /** Asked for, all told. */
  asked: number;
  /** When not all could be done: about the largest size that does them all (null: none found in time / not tried). */
  largest: number | null;
}

/**
 * Fillet (or chamfer) `edgeIds` (null: every real edge) at `size` — and when OpenCascade can't do them all, the most
 * it can: the edges halved again and again, what works in each half put together (each try a real fillet, kept only
 * if the solid comes out valid). Then, time allowing, the largest size that does them all (halving the size range).
 * Throws only if none of them can be done. `budgetMs` caps the tries (a fillet round a gear takes ~1 s).
 */
export function roundSome(kind: "fillet" | "chamfer", shape: Solid, edgeIds: Set<number> | null, size: number, budgetMs = 2500): RoundResult {
  const seams = seamEdgeIds(shape);
  const ids = shape.edges.map((e) => e.hashCode).filter((id) => !seams.has(id) && (!edgeIds || edgeIds.has(id)));
  const run = (set: Set<number>, r: number) => (kind === "fillet" ? filletEdges(shape, set, r) : chamferEdges(shape, set, r));
  const attempt = (set: Set<number>, r: number): Solid | null => {
    try {
      const out = run(set, r);
      return isValidShape(out) && solidVolume(out) > 1e-9 ? out : null;
    } catch {
      return null;
    }
  };
  const start = performance.now();
  const whole = attempt(new Set(ids), size);
  if (whole) return { shape: whole, skipped: [], asked: ids.length, largest: null };
  // How many more tries fit in the budget, at what the first one took (a failed fillet round a gear's 170 edges:
  // ~2 s — then hardly any: an answer soon rather than a long freeze)
  const each = Math.max(20, performance.now() - start);
  let tries = Math.floor((budgetMs - each) / each);
  // (some kept for the largest size that does them all: up to 7, a third at most)
  let keep = Math.min(7, Math.floor(tries / 3));
  const late = () => tries <= keep || performance.now() - start > budgetMs;
  const tried = (set: Set<number>, r: number) => (tries--, attempt(set, r));
  // The most edges that work together: each half's, then both halves' together if that works too
  const best = (list: number[]): { set: number[]; shape: Solid | null } => {
    if (late()) return { set: [], shape: null };
    if (list.length === 1) {
      const one = tried(new Set(list), size);
      return one ? { set: list, shape: one } : { set: [], shape: null };
    }
    const mid = list.length >> 1;
    const a = best(list.slice(0, mid)), b = best(list.slice(mid));
    if (!a.set.length || !b.set.length) return a.set.length >= b.set.length ? a : b;
    const both = [...a.set, ...b.set], joint = late() ? null : tried(new Set(both), size);
    return joint ? { set: both, shape: joint } : a.set.length >= b.set.length ? a : b;
  };
  const got = best(ids);
  // The largest size that does them all: halve the range (7 tries: within 1/128 of the size asked)
  let largest: number | null = null;
  keep = 0;
  let lo = 0, hi = size;
  for (let k = 0; k < 7 && !late(); k++) {
    const mid = (lo + hi) / 2;
    if (tried(new Set(ids), mid)) [lo, largest] = [mid, mid];
    else hi = mid;
  }
  if (!got.shape) {
    const what = kind === "fillet" ? "round" : "chamfer";
    throw new Error(`can't ${what} ${ids.length > 1 ? "these edges" : "this edge"} at ${+size.toFixed(3)} mm${largest ? ` — the largest that works is about ${floorNice(largest)} mm` : " — try a smaller size"}`);
  }
  const done = new Set(got.set);
  return { shape: got.shape, skipped: ids.filter((id) => !done.has(id)), asked: ids.length, largest: largest && floorNice(largest) };
}

/** A size rounded down to a tidy step (2 significant figures): 2.734 → 2.7, 0.4689 → 0.46. */
function floorNice(v: number): number {
  const step = 10 ** (Math.floor(Math.log10(v)) - 1);
  return +(Math.floor(v / step) * step).toFixed(6);
}

/**
 * Drag axis for Fillet / Chamfer: from the middle of an edge (the given ones, or the highest real
 * edge of the solid), across an adjacent face — flat and most upward-facing first — away from the
 * edge. The handle at distance r then sits where a fillet of radius r (or chamfer r) meets that face.
 */
export function filletDragAxis(shape: Shape, edgeIds: Set<number> | null): { origin: V3; dir: V3 } | null {
  const seams = seamEdgeIds(shape);
  const edges = shape.edges.filter((e) => !seams.has(e.hashCode) && (!edgeIds || edgeIds.has(e.hashCode)));
  if (!edgeIds) edges.sort((a, b) => b.pointAt(0.5).z - a.pointAt(0.5).z);
  const edge = edges[0];
  if (!edge) return null;
  const P = edge.pointAt(0.5).toTuple() as V3, T = norm3(edge.tangentAt(0.5).toTuple() as V3);
  const faces = shape.faces.filter((f) => f.edges.some((e) => e.hashCode === edge.hashCode));
  const rank = (f: Face) => (f.geomType === "PLANE" ? 2 : 0) + normalNear(f, P)[2];
  faces.sort((a, b) => rank(b) - rank(a));
  const [lo, hi] = shape.boundingBox.bounds;
  const eps = 1e-3 * Math.max(1, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]));
  for (const face of faces) {
    const d = cross3(T, normalNear(face, P));
    if (Math.hypot(...d) < 1e-9) continue;
    const dir = norm3(d);
    // Into the face: the side where a point just off the edge is still on it.
    const probe = makeVertex(add3(P, [dir[0] * eps, dir[1] * eps, dir[2] * eps]));
    const into = measureDistanceBetween(face, probe) < eps / 10;
    return { origin: P, dir: into ? dir : [-dir[0], -dir[1], -dir[2]] };
  }
  return null;
}

/** Chamfer the given edges, or (null) every real edge — seams are never chamfered. */
export function chamferEdges(shape: Solid, edgeIds: Set<number> | null, distance: number): Solid {
  const seams = seamEdgeIds(shape);
  return shape.chamfer((e) => (!seams.has(e.hashCode) && (!edgeIds || edgeIds.has(e.hashCode)) ? distance : null));
}

/**
 * Curved faces that blend smoothly into `face` (fillets around its rim), found
 * across tangent edges. Push/Pull moves them with the face so a filleted corner
 * stays rounded instead of leaving a step. Faces whose normal runs across `n`
 * (side walls, fillets along the push direction) or away from it are not taken.
 */
function tangentChain(shape: Solid, face: Face, n: V3): Face[] {
  const faces = shape.faces;
  const seen = new Set([face.hashCode]);
  const chain: Face[] = [];
  const queue = [face];
  while (queue.length) {
    const f = queue.shift()!;
    for (const e of f.edges) {
      for (const g of faces) {
        if (seen.has(g.hashCode) || g.geomType === "PLANE") continue;
        if (!g.edges.some((x) => x.isSame(e))) continue;
        try {
          // UV-centre normal: `center` of a revolved face lies on its axis, off the surface.
          if (dot3(g.normalAt().normalized().toTuple() as V3, n) < 0.01) continue;
          const p = e.pointAt(0.5);
          const q = p.toTuple() as V3;
          if (dot3(normalNear(f, q), normalNear(g, q)) < 0.999) continue;
        } catch {
          continue;
        }
        seen.add(g.hashCode);
        chain.push(g);
        queue.push(g);
      }
    }
  }
  return chain;
}

/**
 * Fuse (pull) or cut (push) prisms of `faces` swept by `distance` along `n`.
 * `radial` faces that are cylinders sweep along their own normals instead (a fillet stays round).
 */
function sweepFaces(shape: Solid, faces: { face: Face; n: V3; radial?: boolean }[], distance: number): Solid {
  let result: Shape3D = shape;
  const tools = [
    ...faces.map(({ face, n, radial }) =>
      (radial && (cylinderSweep(face, distance) || wallSweep(face, distance))) ||
      basicFaceExtrusion(face, new Vector([n[0] * distance, n[1] * distance, n[2] * distance]))),
    ...cornerFills(faces, distance),
  ];
  const kind = distance > 0 ? "fuse" : "cut";
  // All blocks in one boolean (much faster than one by one); one by one if that fails.
  if (tools.length > 1) {
    try {
      const r = boolean(kind, shape, tools);
      if (isValidShape(r as Shape)) return r.simplify();
    } catch {
      // fall back below
    }
  }
  for (const tool of tools) result = boolean(kind, result, tool);
  result = result.simplify();
  // OpenCascade gives up on some booleans by returning nothing: never pass that on as a solid.
  if (!result.faces.length) throw new Error("Push/Pull: the geometry kernel could not compute this — try a smaller distance");
  return result;
}

/**
 * Push/pull as a stretch, without sweeping the faces: where everything beyond a plane just inside
 * the moved faces is those faces plus walls running straight along `n`, cut the solid there, shift
 * the outer piece by `distance` and (pulling) fill the gap with the cut section extruded. The
 * pieces only meet on flat faces, so joining them is quick — sweeping blocks that start exactly
 * on B-spline faces (stretched fillets) makes OpenCascade's boolean take seconds. Null if the
 * solid isn't like that there (then the caller sweeps the faces as usual).
 */
function stretchPushPull(shape: Solid, moved: Face[], n: V3, distance: number): Solid | null {
  const tmp: { delete(): void }[] = [];
  const keep = <T>(o: T): T => (tmp.push(o as unknown as { delete(): void }), o);
  try {
    const h = (p: { x: number; y: number; z: number }) => p.x * n[0] + p.y * n[1] + p.z * n[2];
    const heights = (f: Face) => [
      ...f.edges.flatMap((e) => [0, 0.25, 0.5, 0.75, 1].map((t) => h(e.pointAt(t)))),
      ...[0, 0.5, 1].flatMap((u) => [0, 0.5, 1].map((v) => h(f.pointOnSurface(u, v)))),
    ];
    const capLow = Math.min(...moved.flatMap(heights));
    const solidLow = Math.min(...shape.edges.flatMap((e) => [h(e.startPoint), h(e.endPoint)]));
    const depth = capLow - solidLow;
    if (!(depth > 1e-6)) return null;
    // Cut just inside the moved faces (pushing: also |distance| further in — that slab goes).
    const top = capLow - Math.min(0.1 * depth, 1);
    const bottom = distance < 0 ? top + distance : top;
    if (bottom <= solidLow + 1e-6) return null;
    // Plane size from the edge ends (a bounding box of B-spline faces is slow to compute).
    const ends = shape.edges.flatMap((e) => [e.startPoint.toTuple() as V3, e.endPoint.toTuple() as V3]);
    const lo = [0, 1, 2].map((k) => Math.min(...ends.map((p) => p[k]))), hi = [0, 1, 2].map((k) => Math.max(...ends.map((p) => p[k])));
    const R = 2 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + 10;
    const c: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    const planeAt = (k: number) => {
      const o = add3(c, [n[0] * (k - dot3(c, n)), n[1] * (k - dot3(c, n)), n[2] * (k - dot3(c, n))]);
      const pln = keep(new oc.gp_Pln(keep(new oc.gp_Pnt(...o)), keep(new oc.gp_Dir(...n))));
      return keep(new oc.BRepBuilderAPI_MakeFace(pln, -R, R, -R, R)).Face();
    };
    const split = keep(new oc.BRepAlgoAPI_Splitter());
    const args = keep(new oc.NCollection_List_TopoDS_Shape()), tools = keep(new oc.NCollection_List_TopoDS_Shape());
    args.Append(shape.wrapped);
    tools.Append(planeAt(top));
    if (bottom < top) tools.Append(planeAt(bottom));
    split.SetArguments(args);
    split.SetTools(tools);
    split.SetNonDestructive(true);
    split.Build(keep(new oc.Message_ProgressRange()));
    if (split.HasErrors()) return null;
    const pieces = [...iterTopo(split.Shape(), "solid")].map((x) => cast(x) as Solid);
    // Which side of the cuts a piece is: the middle of its edge ends' heights.
    const mid = (p: Solid) => { const hs = p.edges.flatMap((e) => [h(e.startPoint), h(e.endPoint)]); return (Math.min(...hs) + Math.max(...hs)) / 2; };
    const outer = pieces.filter((p) => mid(p) > top), inner = pieces.filter((p) => mid(p) < bottom), slab = pieces.filter((p) => mid(p) > bottom && mid(p) < top);
    if (outer.length !== 1 || !inner.length) return null;
    const tol = 1e-6 * Math.max(1, R);
    const flatAt = (f: Face, k: number) => f.geomType === "PLANE" && heights(f).every((x) => Math.abs(x - k) < tol);
    const straight = (f: Face) =>
      f.geomType === "PLANE"
        ? Math.abs(dot3(norm3(f.normalAt().toTuple() as V3), n)) < 1e-9
        : [0, 0.5, 1].every((u) => [0, 0.5, 1].every((v) => Math.abs(dot3(normalAtUV(f, u, v), n)) < 1e-7));
    // A moved face lies wholly beyond the cut, so the split leaves it as it was (the same face).
    const matches = (f: Face) => moved.findIndex((m) => m.isSame(f));
    // The outer piece: the moved faces, walls straight along n, and the cut — nothing else moves.
    const found = new Set<number>();
    for (const f of outer[0].faces) {
      if (straight(f) || flatAt(f, top)) continue;
      const i = matches(f);
      if (i < 0) return null;
      found.add(i);
    }
    if (found.size !== moved.length) return null;
    // Pushing: the slab removed must be straight walls only, or the stretch is not the push/pull.
    if (slab.some((p) => !p.faces.every((f) => flatAt(f, top) || flatAt(f, bottom) || straight(f)))) return null;
    const shift: V3 = [n[0] * distance, n[1] * distance, n[2] * distance];
    const parts: Shape3D[] = [...inner.slice(1), translateShape(outer[0], shift)];
    if (distance > 0) for (const f of outer[0].faces.filter((g) => flatAt(g, top))) parts.push(basicFaceExtrusion(f, new Vector(shift)));
    let joined: Shape3D | null = null;
    try {
      // Glue edits its arguments in place, and the split pieces share faces with `shape`: copies.
      joined = booleanOnce("fuse", deepCopy(inner[0]), parts.map(deepCopy), true);
      if (!isValidShape(joined as Shape)) joined = null;
    } catch {
      joined = null;
    }
    if (!joined) joined = booleanOnce("fuse", inner[0], parts, false);
    const out = joined.simplify();
    return isValidShape(out) && [...iterTopo(out.wrapped, "solid")].length === 1 ? out : null;
  } catch {
    return null;
  } finally {
    for (const o of tmp) {
      try {
        o.delete();
      } catch {
        // already owned by OpenCascade
      }
    }
  }
}

/**
 * A curved wall: a face swept straight along an axis `Z` (all its normals square to it). Its
 * section is measured in the frame (X, Y, Z): `edge` is the end edge at height z0 (along Z), the
 * wall runs to z1, and that edge lies on the ellipse with centre (cx, cy), axis angle th and
 * semi-axes a, b (in X, Y coordinates).
 */
type WallSection = { edge: Face["edges"][number]; X: V3; Y: V3; Z: V3; z0: number; z1: number; cx: number; cy: number; th: number; a: number; b: number };

/**
 * The section of a curved wall whose end edge is an ellipse arc (or a whole ellipse) — e.g. a
 * stretched circle or cylinder, standing or tilted any way. `axis`: the wall's direction if known
 * (to measure a neighbouring piece in the same frame). Null for any other face.
 */
function wallSection(face: Face, axis?: V3): WallSection | null {
  if (face.geomType === "PLANE") return null;
  try {
    const ns: V3[] = [];
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) ns.push(normalAtUV(face, i / 4, j / 4));
    // The wall's axis: square to two normals that differ most (the normals of a wall turn about it).
    let Z = axis;
    if (!Z) {
      const c = ns.map((n) => cross3(ns[0], n)).reduce((best, v) => (Math.hypot(...v) > Math.hypot(...best) ? v : best));
      const len = Math.hypot(...c);
      if (len < 1e-3) return null; // (nearly) flat
      Z = [c[0] / len, c[1] / len, c[2] / len];
      // Same frame for the same axis either way round, and +Z for an upright wall.
      if (Z[2] < -1e-9 || (Math.abs(Z[2]) <= 1e-9 && (Z[1] < -1e-9 || (Math.abs(Z[1]) <= 1e-9 && Z[0] < 0)))) Z = [-Z[0], -Z[1], -Z[2]];
    }
    if (ns.some((n) => Math.abs(dot3(n, Z!)) > 1e-6)) return null;
    const ref: V3 = Math.abs(Z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const x0 = cross3(ref, Z), xl = Math.hypot(...x0);
    const X: V3 = Math.abs(Z[2]) > 1 - 1e-12 ? [1, 0, 0] : [x0[0] / xl, x0[1] / xl, x0[2] / xl];
    const Y = cross3(Z, X);
    const loc = (p: { x: number; y: number; z: number }): V3 => { const v: V3 = [p.x, p.y, p.z]; return [dot3(v, X), dot3(v, Y), dot3(v, Z!)]; };
    // Exact heights from the edge ends (the bounding box is padded a little).
    const zs = face.edges.flatMap((e) => [loc(e.startPoint)[2], loc(e.endPoint)[2]]);
    const z0 = Math.min(...zs), z1 = Math.max(...zs);
    if (z1 - z0 < 1e-6) return null;
    const bottom = face.edges.filter((e) => !oc.BRep_Tool.Degenerated(e.wrapped) && [0, 0.25, 0.5, 0.75, 1].every((t) => Math.abs(loc(e.pointAt(t))[2] - z0) < 1e-7));
    if (bottom.length !== 1) return null;
    const edge = bottom[0];
    // Fit a conic A x² + B xy + C y² + D x + E y + F = 0 (A + C = 1, fine for an ellipse) to the section.
    const pts = Array.from({ length: 17 }, (_, i) => loc(edge.pointAt(i / 16)));
    const rows = pts.map(([x, y]) => [y * y - x * x, x * y, x, y, 1, -x * x]);
    const M = [0, 1, 2, 3, 4].map((r) => [0, 1, 2, 3, 4, 5].map((c) => rows.reduce((sum, row) => sum + row[r] * row[c], 0)));
    for (let c = 0; c < 5; c++) {
      const piv = M.slice(c).reduce((best, row, k) => (Math.abs(row[c]) > Math.abs(M[best][c]) ? c + k : best), c);
      [M[c], M[piv]] = [M[piv], M[c]];
      if (Math.abs(M[c][c]) < 1e-300) return null;
      for (let r = 0; r < 5; r++) if (r !== c) { const k = M[r][c] / M[c][c]; for (let q = c; q < 6; q++) M[r][q] -= k * M[c][q]; }
    }
    const [C, B, D, E, F] = M.map((row, i) => row[5] / row[i]);
    const A = 1 - C;
    if (B * B - 4 * A * C >= 0) return null; // not an ellipse
    const cx = (B * E - 2 * C * D) / (4 * A * C - B * B), cy = (B * D - 2 * A * E) / (4 * A * C - B * B);
    const th = 0.5 * Math.atan2(B, A - C), co = Math.cos(th), si = Math.sin(th);
    const Ar = A * co * co + B * co * si + C * si * si, Cr = A * si * si - B * co * si + C * co * co;
    const Fc = A * cx * cx + B * cx * cy + C * cy * cy + D * cx + E * cy + F;
    const a = Math.sqrt(-Fc / Ar), b = Math.sqrt(-Fc / Cr);
    if (!(a > 0 && b > 0)) return null;
    // The section really is that ellipse (not some other curve the fit only approximates).
    const w = { edge, X, Y, Z, z0, z1, cx, cy, th, a, b };
    return Array.from({ length: 41 }, (_, i) => edge.pointAt(i / 40)).every((p) => onEllipse(w, p)) ? w : null;
  } catch {
    return null;
  }
}

/** True if point `p` lies on the section's ellipse (seen along the wall's axis). */
function onEllipse(w: WallSection, p: { x: number; y: number; z: number }): boolean {
  const v: V3 = [p.x, p.y, p.z], x = dot3(v, w.X), y = dot3(v, w.Y);
  const co = Math.cos(w.th), si = Math.sin(w.th);
  const u = (x - w.cx) * co + (y - w.cy) * si, t = -(x - w.cx) * si + (y - w.cy) * co;
  return Math.abs(Math.hypot(u / w.a, t / w.b) - 1) < 1e-7;
}

/**
 * The other walls on the same ellipse and height, connected to `face` (e.g. the second half of a
 * stretched cylinder's side, which is split in two): pushed/pulled with it so no step is left.
 */
function sameWallFaces(shape: Solid, face: Face): Face[] {
  const w = wallSection(face);
  if (!w) return [];
  const seen = new Set([face.hashCode]);
  const out: Face[] = [];
  const queue = [face];
  while (queue.length) {
    const f = queue.shift()!;
    for (const g of shape.faces) {
      if (seen.has(g.hashCode) || g.geomType === "PLANE" || !g.edges.some((e) => f.edges.some((x) => x.isSame(e)))) continue;
      const v = wallSection(g, w.Z);
      if (!v || Math.abs(v.z0 - w.z0) > 1e-7 || Math.abs(v.z1 - w.z1) > 1e-7) continue;
      if (![0, 0.5, 1].every((t) => onEllipse(w, v.edge.pointAt(t)))) continue;
      seen.add(g.hashCode);
      out.push(g);
      queue.push(g);
    }
  }
  return out;
}

/**
 * A curved wall (e.g. half an elliptic cylinder from a stretched circle) pushed/pulled so it keeps
 * its shape: its section across the wall's axis — an ellipse — scaled about its centre so
 * each semi-axis grows by `distance` (exact for a circle), the strip between old and new section
 * swept along the wall. Null if the face is not such a wall (then the caller sweeps it straight).
 */
function wallSweep(face: Face, distance: number): Shape3D | null {
  const w = wallSection(face);
  if (!w) return null;
  const { edge, X, Y, Z, z0, z1, cx, cy, th, a, b } = w;
  const co = Math.cos(th), si = Math.sin(th);
  const tmp: { delete(): void }[] = [];
  const keep = <T>(o: T): T => (tmp.push(o as unknown as { delete(): void }), o);
  try {
    // Which way is out: the wall's normal points away from the centre where it is convex.
    const q = face.pointOnSurface(0.5, 0.5).toTuple() as V3, n = normalAtUV(face, 0.5, 0.5);
    const qx = dot3(q, X) - cx, qy = dot3(q, Y) - cy;
    const d = dot3(n, [X[0] * qx + Y[0] * qy, X[1] * qx + Y[1] * qy, X[2] * qx + Y[2] * qy]) > 0 ? distance : -distance;
    const fa = (a + d) / a, fb = (b + d) / b;
    if (!(fa > 1e-6 && fb > 1e-6)) return null;
    // Scale the section about its centre along its own axes, keeping the height along the wall.
    const map = (p: V3): V3 => {
      const x = dot3(p, X) - cx, y = dot3(p, Y) - cy, h = dot3(p, Z);
      const u = (x * co + y * si) * fa, v = (-x * si + y * co) * fb;
      const x2 = cx + u * co - v * si, y2 = cy + u * si + v * co;
      return [X[0] * x2 + Y[0] * y2 + Z[0] * h, X[1] * x2 + Y[1] * y2 + Z[1] * h, X[2] * x2 + Y[2] * y2 + Z[2] * h];
    };
    // The scaled section: the edge's B-spline with its control points mapped (exact: the map is affine).
    const c = oc.BRep_Tool.Curve(edge.wrapped, 0, 0);
    const bs = oc.GeomConvert.CurveToBSplineCurve(keep(new oc.Geom_TrimmedCurve(c.returnValue, c.First, c.Last, true, true)) as never);
    for (let i = 1; i <= bs.NbPoles(); i++) {
      const pole = keep(bs.Pole(i));
      bs.SetPole(i, keep(new oc.gp_Pnt(...map([pole.X(), pole.Y(), pole.Z()]))));
    }
    const scaled = cast(keep(new oc.BRepBuilderAPI_MakeEdge(bs as never)).Edge()) as unknown as typeof edge;
    const prism = (wire: Wire) => basicFaceExtrusion(makeFace(wire), new Vector([Z[0] * (z1 - z0), Z[1] * (z1 - z0), Z[2] * (z1 - z0)]));
    let tool: Shape3D;
    if (Math.hypot(...sub3(edge.startPoint.toTuple() as V3, edge.endPoint.toTuple() as V3)) < 1e-7) {
      // A whole ellipse: the ring between the two.
      const [outer, inner] = d > 0 ? [scaled, edge] : [edge, scaled];
      tool = boolean("cut", prism(assembleWire([outer])), prism(assembleWire([inner])));
    } else {
      // An arc: the strip between it, its scaled copy and the two straight ends.
      const s0 = edge.startPoint.toTuple() as V3, s1 = edge.endPoint.toTuple() as V3;
      const t0 = scaled.startPoint.toTuple() as V3, t1 = scaled.endPoint.toTuple() as V3;
      tool = prism(assembleWire([edge, makeLine(s1, t1), scaled, makeLine(t0, s0)]));
    }
    return isValidShape(tool as Shape) ? tool : null;
  } catch {
    return null;
  } finally {
    for (const o of tmp) {
      try {
        o.delete();
      } catch {
        // already owned by OpenCascade
      }
    }
  }
}

/**
 * A cylindrical face swept along its own normals by `distance`: the ring sector between radius
 * r and r ± distance over the face's angle and height, so a fillet stays a concentric fillet.
 * Null if the face is not a whole rectangle of its cylinder (e.g. trimmed by another fillet).
 */
function cylinderSweep(face: Face, distance: number): Shape3D | null {
  if (face.geomType !== "CYLINDRE") return null; // (replicad's spelling)
  const ad = new oc.BRepAdaptor_Surface(face.wrapped, true);
  const tmp: { delete(): void }[] = [ad];
  const keep = <T extends { delete(): void }>(o: T) => (tmp.push(o), o);
  const v3 = (d: { X(): number; Y(): number; Z(): number }): V3 => [d.X(), d.Y(), d.Z()];
  try {
    const cyl = keep(ad.Cylinder()), ax = keep(cyl.Position());
    const r = cyl.Radius();
    const O = v3(keep(ax.Location())), N = v3(keep(ax.Direction())), X = v3(keep(ax.XDirection())), Y = v3(keep(ax.YDirection()));
    const u0 = ad.FirstUParameter(), u1 = ad.LastUParameter(), v0 = ad.FirstVParameter(), v1 = ad.LastVParameter();
    const full = r * (u1 - u0) * (v1 - v0);
    if (!(full > 1e-9) || Math.abs(measureArea(face) - full) > 1e-4 * full) return null;
    const radial = (u: number): V3 => [X[0] * Math.cos(u) + Y[0] * Math.sin(u), X[1] * Math.cos(u) + Y[1] * Math.sin(u), X[2] * Math.cos(u) + Y[2] * Math.sin(u)];
    // Normal away from the axis (convex fillet) → pulling grows the radius; toward it (concave) → shrinks it.
    const s = dot3(face.normalAt().toTuple() as V3, radial((u0 + u1) / 2)) > 0 ? 1 : -1;
    const lo = Math.min(r, r + s * distance), hi = Math.max(r, r + s * distance);
    if (hi < 1e-9) return null;
    // MakeCylinder sweeps counter-clockwise about its axis: flip the axis for a left-handed frame.
    const right = dot3(cross3(X, Y), N) > 0;
    const axis: V3 = right ? N : [-N[0], -N[1], -N[2]];
    const v = right ? v0 : v1;
    const base: V3 = [O[0] + N[0] * v, O[1] + N[1] * v, O[2] + N[2] * v];
    const sector = (R: number) => {
      const a2 = keep(new oc.gp_Ax2(keep(new oc.gp_Pnt(...base)), keep(new oc.gp_Dir(...axis)), keep(new oc.gp_Dir(...radial(u0)))));
      const mk = keep(new oc.BRepPrimAPI_MakeCylinder(a2, R, v1 - v0, u1 - u0));
      return cast(mk.Shape()) as Shape3D;
    };
    return lo > 1e-9 ? boolean("cut", sector(hi), sector(lo)) : sector(hi);
  } catch {
    return null;
  } finally {
    for (const o of tmp) o.delete();
  }
}

// ---------------------------------------------------------------- measure (hover info)

/** What the Measure tool shows for an edge: its length, and for a circle / arc its radius, centre and angle. */
export interface EdgeInfo {
  type: "line" | "circle" | "arc" | "curve";
  length: number;
  radius?: number;
  center?: V3;
  /** Arc angle in degrees. */
  angle?: number;
}

/** Bounding box [lo, hi] of one edge, or with no `edgeId` of the whole shape (e.g. a path). */
export function curveBounds(shape: Shape | Wire, edgeId?: number): [V3, V3] | null {
  const e = edgeId === undefined ? shape : shape.edges.find((x) => x.hashCode === edgeId);
  return e ? (e.boundingBox.bounds as [V3, V3]) : null;
}

export function edgeInfo(shape: Shape, edgeId: number): EdgeInfo | null {
  const e = shape.edges.find((x) => x.hashCode === edgeId);
  if (!e) return null;
  const length = measureLength(e);
  if (e.geomType === "LINE") return { type: "line", length };
  if (e.geomType !== "CIRCLE") return { type: "curve", length };
  const ad = new oc.BRepAdaptor_Curve(e.wrapped);
  try {
    const c = ad.Circle(), loc = c.Location();
    const radius = c.Radius(), center: V3 = [loc.X(), loc.Y(), loc.Z()];
    const angle = ((ad.LastParameter() - ad.FirstParameter()) * 180) / Math.PI;
    c.delete();
    loc.delete();
    return angle > 359.999 ? { type: "circle", length, radius, center } : { type: "arc", length, radius, center, angle };
  } finally {
    ad.delete();
  }
}

/**
 * The straight edge of `shape` that an edge a–b of `old` (the same body before an edit) became, as
 * [new a, new b] with a's end first; null if none fits. In order: the same edge; the edge moved with
 * the whole body (same size, shifted); the edge on the same line sharing an end (an end face was
 * pushed / pulled); the nearest parallel edge within the body's size (a side face moved, scaling).
 */
export function matchStraightEdge(shape: Shape, old: Shape, a: V3, b: V3): [V3, V3] | null {
  const [lo, hi] = shape.boundingBox.bounds, [olo, ohi] = old.boundingBox.bounds;
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const tol = 1e-6 * Math.max(1, diag);
  const same = (p: V3, q: V3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < tol;
  const u = norm3(sub3(b, a)), len = Math.hypot(...sub3(b, a));
  const lines = shape.edges.filter((e) => e.geomType === "LINE").map((e) => [e.startPoint.toTuple() as V3, e.endPoint.toTuple() as V3] as [V3, V3]);
  /** The edge as [a-side, b-side] (oriented like a→b), if it runs between p and q. */
  const between = (p: V3, q: V3) => {
    const e = lines.find(([s, t]) => (same(s, p) && same(t, q)) || (same(s, q) && same(t, p)));
    return e ? ([p, q] as [V3, V3]) : null;
  };
  const exact = between(a, b);
  if (exact) return exact;
  // Moved as a whole (G / G G / Tab move): same size, shifted bounding box.
  const size = (l: number[], h: number[]) => [0, 1, 2].map((k) => h[k] - l[k]);
  if (size(lo, hi).every((v, k) => Math.abs(v - size(olo, ohi)[k]) < tol)) {
    const v: V3 = [lo[0] - olo[0], lo[1] - olo[1], lo[2] - olo[2]];
    const moved = between([a[0] + v[0], a[1] + v[1], a[2] + v[2]], [b[0] + v[0], b[1] + v[1], b[2] + v[2]]);
    if (moved) return moved;
  }
  const parallel = lines
    .map(([s, t]): [V3, V3] => (dot3(sub3(t, s), u) >= 0 ? [s, t] : [t, s]))
    .filter(([s, t]) => {
      const l = Math.hypot(...sub3(t, s));
      return l > tol && Math.abs(dot3(sub3(t, s), u) / l) > 1 - 1e-9;
    });
  const onLine = (p: V3) => {
    const d = sub3(p, a), along = dot3(d, u);
    return Math.hypot(d[0] - u[0] * along, d[1] - u[1] * along, d[2] - u[2] * along) < tol;
  };
  // Longer / shorter along its own line, one end kept.
  const stretched = parallel.find(([s, t]) => onLine(s) && onLine(t) && (same(s, a) || same(t, b)));
  if (stretched) return stretched;
  // Nearest parallel edge (prefer one of the old length), not further away than the body is big.
  const mid = (s: V3, t: V3): V3 => [(s[0] + t[0]) / 2, (s[1] + t[1]) / 2, (s[2] + t[2]) / 2];
  const m0 = mid(a, b);
  let best: { e: [V3, V3]; score: number } | null = null;
  for (const e of parallel) {
    const d = Math.hypot(...sub3(mid(...e), m0));
    if (d > diag) continue;
    const score = d + Math.abs(Math.hypot(...sub3(e[1], e[0])) - len);
    if (!best || score < best.score) best = { e, score };
  }
  return best?.e ?? null;
}

/** A circle or arc edge's centre, unit normal (its axis) and radius; null for other edges. */
export function circleOf(shape: Shape, edgeId: number): { center: V3; normal: V3; radius: number } | null {
  const e = shape.edges.find((x) => x.hashCode === edgeId);
  if (!e || e.geomType !== "CIRCLE") return null;
  const ad = new oc.BRepAdaptor_Curve(e.wrapped);
  const c = ad.Circle(), loc = c.Location(), ax = c.Axis(), dir = ax.Direction();
  try {
    return { center: [loc.X(), loc.Y(), loc.Z()], normal: [dir.X(), dir.Y(), dir.Z()], radius: c.Radius() };
  } finally {
    for (const o of [dir, ax, loc, c, ad]) o.delete();
  }
}

/**
 * A round hole or pin of a solid, found from a rim edge (a circle edge of its round wall): its
 * diameter, axis (`center` on the rim's plane, unit `axis`) and a point on the rim. `key`: the same
 * for every rim of one hole (top, bottom, a wall split in halves).
 */
export interface RoundRim {
  kind: "hole" | "pin";
  diameter: number;
  center: V3;
  axis: V3;
  rim: V3;
  key: string;
}

/**
 * The round hole or pin whose wall edge `edgeId` is a rim of; null if it isn't one (not a circle,
 * no round wall on it, or the rim doesn't go all the way round — a slot's round end).
 */
export function roundRim(shape: Shape, edgeId: number): RoundRim | null {
  const c = circleOf(shape, edgeId);
  if (!c) return slantedRim(shape, edgeId);
  const edge = shape.edges.find((e) => e.hashCode === edgeId)!;
  // All the way round: the arcs of this circle (a rim can be in pieces) add up to a full turn.
  const tol = 1e-6 * Math.max(1, c.radius);
  let turn = 0;
  for (const e of shape.edges) {
    if (e.geomType !== "CIRCLE") continue;
    const o = circleOf(shape, e.hashCode)!;
    if (Math.abs(o.radius - c.radius) > tol || Math.hypot(...sub3(o.center, c.center)) > tol || Math.hypot(...cross3(o.normal, c.normal)) > 1e-7) continue;
    const ad = new oc.BRepAdaptor_Curve(e.wrapped);
    turn += Math.abs(ad.LastParameter() - ad.FirstParameter());
    ad.delete();
  }
  if (turn < 2 * Math.PI - 1e-6) return null;
  for (const f of shape.faces) {
    if (f.geomType !== "CYLINDRE" || !f.edges.some((e) => e.isSame(edge))) continue;
    const w = cylinderOf(f);
    if (!w || !sameRound(w, c.center, c.normal, c.radius)) continue;
    return { kind: w.hole ? "hole" : "pin", diameter: 2 * w.radius, center: c.center, axis: w.axis, rim: edge.pointAt(0).toTuple() as V3, key: roundKey(w) };
  }
  return null;
}

/**
 * A rim that isn't a circle — a hole drilled at a slant (an ellipse on a flat face) or coming out
 * through a curved face — of a round wall that goes all the way round; `center`: the rim's start
 * point brought onto the axis.
 */
function slantedRim(shape: Shape, edgeId: number): RoundRim | null {
  const edge = shape.edges.find((e) => e.hashCode === edgeId);
  if (!edge || edge.geomType === "LINE") return null;
  for (const f of shape.faces) {
    if (f.geomType !== "CYLINDRE" || !f.edges.some((e) => e.isSame(edge))) continue;
    const w = cylinderOf(f);
    if (!w) continue;
    const p = edge.pointAt(0).toTuple() as V3, h = dot3(sub3(p, w.origin), w.axis);
    const center: V3 = [w.origin[0] + h * w.axis[0], w.origin[1] + h * w.axis[1], w.origin[2] + h * w.axis[2]];
    // All the way round: the round wall's faces (it can be in pieces) add up to a full turn.
    let turn = 0;
    for (const g of shape.faces) {
      const o = cylinderOf(g);
      if (!o || o.hole !== w.hole || !sameRound(o, center, w.axis, w.radius)) continue;
      const ad = new oc.BRepAdaptor_Surface(g.wrapped, true);
      turn += ad.LastUParameter() - ad.FirstUParameter();
      ad.delete();
    }
    if (turn < 2 * Math.PI - 1e-6) continue;
    return { kind: w.hole ? "hole" : "pin", diameter: 2 * w.radius, center, axis: w.axis, rim: p, key: roundKey(w) };
  }
  return null;
}

/** A cylinder face's axis (through `origin`, unit `axis`, one way round for either), radius, and whether it is a hole's wall (its normal toward the axis). */
function cylinderOf(face: Face): { origin: V3; axis: V3; radius: number; hole: boolean } | null {
  if (face.geomType !== "CYLINDRE") return null;
  const ad = new oc.BRepAdaptor_Surface(face.wrapped, true);
  const tmp: { delete(): void }[] = [ad];
  const keep = <T extends { delete(): void }>(o: T) => (tmp.push(o), o);
  const v3 = (d: { X(): number; Y(): number; Z(): number }): V3 => [d.X(), d.Y(), d.Z()];
  try {
    const cyl = keep(ad.Cylinder()), ax = keep(cyl.Position());
    let axis = v3(keep(ax.Direction()));
    if (axis[2] < -1e-9 || (Math.abs(axis[2]) <= 1e-9 && (axis[1] < -1e-9 || (Math.abs(axis[1]) <= 1e-9 && axis[0] < 0)))) axis = [-axis[0], -axis[1], -axis[2]];
    const origin = v3(keep(ax.Location()));
    const p = face.pointOnSurface(0.5, 0.5).toTuple() as V3, n = normalAtUV(face, 0.5, 0.5);
    const rel = sub3(p, origin), h = dot3(rel, axis);
    const radial: V3 = [rel[0] - h * axis[0], rel[1] - h * axis[1], rel[2] - h * axis[2]];
    return { origin, axis, radius: cyl.Radius(), hole: dot3(n, radial) < 0 };
  } catch {
    return null;
  } finally {
    for (const o of tmp) o.delete();
  }
}

/** A cylinder on the line through `center` along `axis`, of `radius`? */
function sameRound(w: { origin: V3; axis: V3; radius: number }, center: V3, axis: V3, radius: number): boolean {
  const tol = 1e-6 * Math.max(1, radius);
  if (Math.abs(w.radius - radius) > tol || Math.hypot(...cross3(w.axis, norm3(axis))) > 1e-7) return false;
  const rel = sub3(center, w.origin), h = dot3(rel, w.axis);
  return Math.hypot(rel[0] - h * w.axis[0], rel[1] - h * w.axis[1], rel[2] - h * w.axis[2]) < tol;
}

/** One key per round wall: its axis line (where it crosses the plane through the origin) and radius. */
function roundKey(w: { origin: V3; axis: V3; radius: number }): string {
  const h = dot3(w.origin, w.axis), foot = [0, 1, 2].map((i) => w.origin[i] - h * w.axis[i]);
  const r = (x: number) => (Math.abs(x) < 5e-7 ? 0 : +x.toFixed(6));
  return [...foot, ...w.axis, w.radius].map(r).join(",");
}

/**
 * Resize round holes / pins of a solid: each diameter `change` mm bigger (smaller if negative) —
 * its wall pushed / pulled round its axis (walls found afresh on the shape as it is, so a hole and
 * a pin can both change). Throws if a hole would close, or the kernel can't do it.
 */
export function resizeRounds(shape: Solid, rims: RoundRim[], change: number): Solid {
  if (Math.abs(change) < 1e-9) return shape;
  let out = shape;
  for (const kind of ["hole", "pin"] as const) {
    const these = rims.filter((r) => r.kind === kind);
    if (!these.length) continue;
    if (these.some((r) => r.diameter + change < 1e-3)) throw new Error(`Resize: that would close the ${kind === "hole" ? "hole" : "pin"} (Ø ${+these[0].diameter.toFixed(3)} mm ${change < 0 ? "−" : "+"} ${+Math.abs(change).toFixed(3)} mm)`);
    const faces = out.faces.filter((f) => {
      const w = cylinderOf(f);
      return !!w && w.hole === (kind === "hole") && these.some((r) => sameRound(w, r.center, r.axis, r.diameter / 2));
    });
    if (!faces.length) throw new Error("Resize: the round wall was not found");
    // (pulling a hole's wall — along its normal, toward the axis — makes it smaller)
    // A hole at a slant through a curved face can come back unchanged or wrong: then a hole that goes
    // right through is filled and drilled again at its new size (remembered for the next drag step).
    const memo = kind === "hole" && redrillMemo?.shape === out && redrillMemo.key === roundsKey(these) ? redrillMemo : null;
    let moved: Solid | null = null;
    if (!memo) {
      try {
        moved = pushPullMany(out, faces.map((f) => f.hashCode), kind === "hole" ? -change / 2 : change / 2);
      } catch (e) {
        if (kind === "pin") throw e;
      }
    }
    if (kind === "hole" && (!moved || !roundsMoved(out, moved, faces, change))) out = redrill(out, these, change);
    else out = moved!;
  }
  return out;
}

/** The volume a resize took away (a hole) as it should, to within half: the walls' area × how far they moved. */
function roundsMoved(before: Solid, after: Solid, walls: Face[], change: number): boolean {
  if (!isValidShape(after)) return false;
  const want = walls.reduce((a, f) => a + measureArea(f), 0) * change / 2, got = measureVolume(before) - measureVolume(after);
  return got / want > 0.5 && got / want < 2;
}

/** The last holes redrilled: on that shape, push/pull doesn't do; `filled`: the shape with them filled. */
let redrillMemo: { shape: Solid; key: string; filled: Solid } | null = null;

const roundsKey = (rims: RoundRim[]) => [...new Set(rims.map((r) => r.key))].sort().join(";");

/** Round holes that go right through filled and drilled again, each `change` mm bigger across. */
function redrill(shape: Solid, rims: RoundRim[], change: number): Solid {
  const key = roundsKey(rims);
  let filled: Solid;
  if (redrillMemo?.shape === shape && redrillMemo.key === key) filled = redrillMemo.filled;
  else {
    const faces = roundFaces(shape, rims);
    if (faces.some((f) => f.geomType !== "CYLINDRE")) throw new Error("Resize: the geometry kernel could not compute this");
    filled = defeature(shape, faces, rims.length === 1 ? "fill the hole" : "fill the holes");
    redrillMemo = { shape, key, filled };
  }
  // Drills longer than the whole solid, centred where each hole's axis passes nearest the solid's middle.
  const [lo, hi] = shape.boundingBox.bounds, len = 2 * Math.hypot(...sub3(hi, lo)) + 1;
  const mid: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const seen = new Set<string>();
  const drills = rims.filter((r) => !seen.has(r.key) && seen.add(r.key)).map((r) => {
    const h = dot3(sub3(mid, r.center), r.axis) - len / 2;
    return occCylinder((r.diameter + change) / 2, len, [r.center[0] + h * r.axis[0], r.center[1] + h * r.axis[1], r.center[2] + h * r.axis[2]], r.axis) as Solid;
  });
  // (never as a preview: glue assumes faces don't cross, and a drill crosses them)
  const was0 = previewing;
  previewing = false;
  let out: Solid;
  try {
    out = booleanOp("subtract", filled, drills);
  } finally {
    previewing = was0;
  }
  if (!isValidShape(out)) throw new Error("Resize: the result is not a valid solid");
  // The drill only took the holes' place (it didn't run on into another part of the solid): the
  // volume taken away grew with the area across, give or take the rims' slant.
  const d = rims[0].diameter, was = measureVolume(filled) - measureVolume(shape), now = measureVolume(filled) - measureVolume(out);
  const k = now / (was * ((d + change) / d) ** 2);
  if (!(k > 0.8 && k < 1.25)) throw new Error("Resize: the geometry kernel could not compute this");
  return out;
}

/**
 * Fill round holes / take off round pins (Delete with their rims selected): their walls, and the
 * faces inside them (a blind hole's bottom, a drill tip, a pin's top), removed and the gap closed
 * by the faces around (OpenCascade's defeaturing). Throws if it can't (e.g. a hole running into another).
 */
export function fillRounds(shape: Solid, rims: RoundRim[]): Solid {
  const what = rims.every((r) => r.kind === "hole") ? "fill the hole" : rims.every((r) => r.kind === "pin") ? "take off the pin" : "fill the hole / take off the pin";
  return defeature(shape, roundFaces(shape, rims), what);
}

/** The faces of round holes / pins: their walls, and the faces inside them (a blind hole's bottom, a drill tip, a pin's top). */
function roundFaces(shape: Solid, rims: RoundRim[]): Face[] {
  const [lo, hi] = shape.boundingBox.bounds;
  const tol = 1e-6 * Math.max(1, Math.hypot(...sub3(hi, lo)));
  const remove: Face[] = [];
  const has = (f: Face) => remove.some((g) => g.isSame(f));
  for (const r of rims) {
    const walls = shape.faces.filter((f) => {
      const w = cylinderOf(f);
      return !!w && w.hole === (r.kind === "hole") && sameRound(w, r.center, r.axis, r.diameter / 2);
    });
    if (!walls.length) throw new Error("Delete: the round wall was not found");
    // Inside the round: every edge point within its radius of the axis (not the face it opens into).
    const inside = (f: Face) =>
      f.edges.every((e) => [0, 0.25, 0.5, 0.75, 1].every((t) => {
        const rel = sub3(e.pointAt(t).toTuple() as V3, r.center), h = dot3(rel, r.axis);
        return Math.hypot(rel[0] - h * r.axis[0], rel[1] - h * r.axis[1], rel[2] - h * r.axis[2]) <= r.diameter / 2 + tol;
      }));
    const queue = [...walls];
    for (const w of walls) if (!has(w)) remove.push(w);
    while (queue.length) {
      const f = queue.shift()!;
      for (const g of shape.faces) {
        if (has(g) || !g.edges.some((e) => f.edges.some((x) => x.isSame(e))) || !inside(g)) continue;
        remove.push(g);
        queue.push(g);
      }
    }
  }
  return remove;
}

/** `faces` of a solid taken away and the gap closed by the faces around (OpenCascade's defeaturing); `what` for the error. */
function defeature(shape: Solid, faces: Face[], what: string): Solid {
  const tmp: { delete(): void }[] = [];
  const keep = <T>(o: T): T => (tmp.push(o as unknown as { delete(): void }), o);
  try {
    const df = keep(new oc.BRepAlgoAPI_Defeaturing());
    df.SetShape(shape.wrapped);
    for (const f of faces) df.AddFaceToRemove(f.wrapped);
    df.SetRunParallel(false);
    df.Build(keep(new oc.Message_ProgressRange()));
    if (!df.IsDone() || df.HasErrors()) throw new Error(`Delete: the geometry kernel could not ${what} (does it run into another one?)`);
    const solids = [...iterTopo(df.Shape(), "solid")].map((x) => cast(x) as Solid);
    if (solids.length !== 1) throw new Error(`Delete: the geometry kernel could not ${what}`);
    const out = solids[0].simplify() as Solid;
    if (!isValidShape(out)) throw new Error(`Delete: the result is not a valid solid`);
    return out;
  } finally {
    for (const o of tmp) {
      try {
        o.delete();
      } catch {
        // already owned by OpenCascade
      }
    }
  }
}

/**
 * A hole of any shape (rectangle, slot, a sketched outline...) found from an edge of its rim: the
 * rim is an inner outline of a face (a notch at its border is not a hole). `faces`: all of the
 * hole — its walls, a pocket's floor, fillets in it; `walls`: the ones that meet a face it opens
 * into (moved to resize it); `key`: the same for any edge of one hole.
 */
export interface HoleLoop {
  faces: number[];
  walls: number[];
  key: string;
  /** The edges of the rim the edge is on (that inner outline). */
  rim: number[];
}

export function holeAt(shape: Shape, edgeId: number): HoleLoop | null {
  const edge = shape.edges.find((e) => e.hashCode === edgeId);
  if (!edge) return null;
  const all = shape.faces;
  const innerLoops = new Map<Face, Edge[][]>();
  const inner = (f: Face) => {
    if (!innerLoops.has(f)) innerLoops.set(f, f.clone().innerWires().map((w) => w.edges));
    return innerLoops.get(f)!;
  };
  const on = (es: Edge[], e: Edge) => es.some((x) => x.isSame(e));
  const host = all.find((f) => inner(f).some((es) => on(es, edge)));
  if (!host) return null;
  const loop = inner(host).find((es) => on(es, edge))!;
  const shares = (f: Face, es: Edge[]) => f.edges.some((e) => on(es, e));
  const feature = all.filter((f) => !f.isSame(host) && shares(f, loop));
  if (!feature.length) return null;
  const has = (f: Face) => feature.some((x) => x.isSame(f));
  // Spread through the hole; stop at faces it opens into (its edges there are an inner outline of them).
  const opens: Edge[][] = [loop];
  for (let i = 0; i < feature.length; i++) {
    const f = feature[i];
    for (const g of all) {
      if (g.isSame(host) || has(g)) continue;
      const shared = g.edges.filter((e) => on(f.edges, e));
      if (!shared.length) continue;
      const far = inner(g).find((es) => shared.every((e) => on(es, e)));
      if (far) {
        opens.push(far);
        continue;
      }
      feature.push(g);
    }
  }
  const border = host.clone().outerWire().edges;
  if (feature.some((f) => shares(f, border)) || feature.length >= all.length - 1) return null;
  const walls = feature.filter((f) => opens.some((es) => shares(f, es)));
  return { faces: feature.map((f) => f.hashCode), walls: walls.map((f) => f.hashCode), key: feature.map((f) => f.hashCode).sort((a, b) => a - b).join(","), rim: loop.map((e) => e.hashCode) };
}

/** Fill holes of any shape (Delete with an edge of each rim selected). Throws if it can't. */
export function fillHoles(shape: Solid, holes: HoleLoop[]): Solid {
  const ids = new Set(holes.flatMap((h) => h.faces));
  return defeature(shape, shape.faces.filter((f) => ids.has(f.hashCode)), holes.length === 1 ? "fill the hole" : "fill the holes");
}

/**
 * Holes of any shape `change` mm wider (narrower if negative) across, all round: each wall moved
 * out by half of it — straight walls along their normals (corners stay sharp), round ones round
 * their axis. Throws if the kernel can't, or the result isn't a valid solid.
 */
export function resizeHoles(shape: Solid, holes: HoleLoop[], change: number): Solid {
  if (Math.abs(change) < 1e-9) return shape;
  // (a hole's walls face into it: pulling them in, along their normals, makes it smaller)
  const out = pushPullMany(shape, holes.flatMap((h) => h.walls), -change / 2);
  if (!previewing && !isValidShape(out)) throw new Error("Resize: the result is not a valid solid — try a smaller change");
  return out;
}

/**
 * The circle / arc of `shape` that a circle edge of `old` (centre `center`, through `rim`, axis
 * `normal`) became, as [new centre, new rim point] — the rim kept in the same direction from the
 * centre (on an arc: the nearest point of it). In order: the same circle; moved with the whole body
 * (same size, shifted); the nearest circle on a parallel axis (pushed / pulled, resized, scaled).
 */
export function matchCircleEdge(shape: Shape, old: Shape, center: V3, rim: V3, normal: V3): [V3, V3] | null {
  const [lo, hi] = shape.boundingBox.bounds, [olo, ohi] = old.boundingBox.bounds;
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const tol = 1e-6 * Math.max(1, diag);
  const r0 = Math.hypot(...sub3(rim, center)), dir = norm3(sub3(rim, center));
  const circles = shape.edges.flatMap((e) => {
    const c = e.geomType === "CIRCLE" ? circleOf(shape, e.hashCode) : null;
    return c && Math.abs(dot3(c.normal, normal)) > 1 - 1e-9 ? [{ id: e.hashCode, ...c }] : [];
  });
  const at = (c: (typeof circles)[number]): [V3, V3] => {
    const p = add3(c.center, [dir[0] * c.radius, dir[1] * c.radius, dir[2] * c.radius]);
    return [c.center, nearestOnEdge(shape, c.id, p) ?? p];
  };
  const find = (p: V3, r: number) => circles.find((c) => Math.hypot(...sub3(c.center, p)) < tol && Math.abs(c.radius - r) < tol);
  const exact = find(center, r0);
  if (exact) return at(exact);
  const size = (l: number[], h: number[]) => [0, 1, 2].map((k) => h[k] - l[k]);
  if (size(lo, hi).every((v, k) => Math.abs(v - size(olo, ohi)[k]) < tol)) {
    const moved = find(add3(center, sub3(lo as V3, olo as V3)), r0);
    if (moved) return at(moved);
  }
  let best: { c: (typeof circles)[number]; score: number } | null = null;
  for (const c of circles) {
    const d = Math.hypot(...sub3(c.center, center));
    if (d > diag) continue;
    const score = d + Math.abs(c.radius - r0);
    if (!best || score < best.score) best = { c, score };
  }
  return best ? at(best.c) : null;
}

/** What the Measure tool shows for a face: its area, plus the sizes that describe its kind. */
export interface FaceInfo {
  type: "flat" | "cylinder" | "cone" | "sphere" | "torus" | "curved";
  area: number;
  /** Flat rectangle: its two side lengths. */
  rect?: [number, number];
  radius?: number;
  /** Torus: the tube radius. */
  minorRadius?: number;
  /** Cylinder: length along the axis. */
  height?: number;
  /** Cylinder / cone part of a turn (fillets), in degrees; absent for a full turn. */
  angle?: number;
  /** Cone: half-angle in degrees. */
  halfAngle?: number;
}

export function faceInfo(shape: Shape, faceId: number): FaceInfo | null {
  const f = findFace(shape, faceId);
  if (!f) return null;
  const area = measureArea(f);
  if (f.geomType === "PLANE") {
    const edges = f.edges;
    if (edges.length === 4 && edges.every((e) => e.geomType === "LINE")) {
      const len = edges.map((e) => measureLength(e)).sort((a, b) => a - b);
      const tol = 1e-6 * Math.max(1, len[3]);
      // Two pairs of equal sides with area = side × side: a rectangle (not a rhombus / parallelogram).
      if (Math.abs(len[0] - len[1]) < tol && Math.abs(len[2] - len[3]) < tol && Math.abs(len[0] * len[2] - area) < 1e-6 * Math.max(1, area)) {
        return { type: "flat", area, rect: [len[3], len[0]] };
      }
    }
    return { type: "flat", area };
  }
  const ad = new oc.BRepAdaptor_Surface(f.wrapped, true);
  const tmp: { delete(): void }[] = [ad];
  const keep = <T extends { delete(): void }>(o: T) => (tmp.push(o), o);
  try {
    const turn = ((ad.LastUParameter() - ad.FirstUParameter()) * 180) / Math.PI;
    const angle = turn < 359.999 ? turn : undefined;
    switch (f.geomType) {
      case "CYLINDRE":
        return { type: "cylinder", area, radius: keep(ad.Cylinder()).Radius(), height: ad.LastVParameter() - ad.FirstVParameter(), angle };
      case "CONE": {
        const cone = keep(coneOf(f));
        return { type: "cone", area, radius: cone.RefRadius(), halfAngle: (Math.abs(cone.SemiAngle()) * 180) / Math.PI, angle };
      }
      case "SPHERE":
        return { type: "sphere", area, radius: keep(ad.Sphere()).Radius() };
      case "TORUS": {
        const t = keep(ad.Torus());
        return { type: "torus", area, radius: t.MajorRadius(), minorRadius: t.MinorRadius() };
      }
      default:
        return { type: "curved", area };
    }
  } catch {
    return { type: "curved", area };
  } finally {
    for (const o of tmp) o.delete();
  }
}

/** Centre of a spherical or toroidal face (inside the solid, so it has no edge or flat face to snap to), else null. */
export function curvedFaceCenter(face: Face): V3 | null {
  if (face.geomType !== "SPHERE" && face.geomType !== "TORUS") return null;
  const ad = new oc.BRepAdaptor_Surface(face.wrapped, true);
  try {
    const surf = face.geomType === "SPHERE" ? ad.Sphere() : ad.Torus();
    const loc = surf.Location();
    const c: V3 = [loc.X(), loc.Y(), loc.Z()];
    loc.delete();
    surf.delete();
    return c;
  } catch {
    return null;
  } finally {
    ad.delete();
  }
}

/** Flat polygon `base` swept along `v`. */
function prism(base: V3[], v: V3): Shape3D {
  let f = makeFace(polyWire(base));
  if (dot3(f.normalAt().toTuple() as V3, v) < 0) f = f.flipOrientation();
  return basicFaceExtrusion(f, new Vector(v));
}

/**
 * Where two swept flat faces meet at a straight edge, their prisms leave a wedge between them
 * (a notch when pulling an outside corner, a leftover post when pushing an inside one).
 * These pieces fill it: the mitred wedge along each shared edge, and the corner block where
 * three mutually square faces meet. Where the prisms already overlap they change nothing.
 */
function cornerFills(faces: { face: Face; n: V3 }[], distance: number): Shape3D[] {
  const flat = faces.filter(({ face }) => face.geomType === "PLANE");
  const at = (p: V3, ...vs: V3[]) => vs.reduce((q, v) => add3(q, [v[0] * distance, v[1] * distance, v[2] * distance]), p);
  const fills: Shape3D[] = [];
  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      const n1 = flat[i].n, n2 = flat[j].n;
      const c = 1 + dot3(n1, n2);
      if (c < 1e-3 || c > 2 - 1e-3) continue; // opposite or coplanar faces
      const m: V3 = [(n1[0] + n2[0]) / c, (n1[1] + n2[1]) / c, (n1[2] + n2[2]) / c]; // mitre: m·n1 = m·n2 = 1
      for (const e of flat[i].face.edges) {
        if (e.geomType !== "LINE" || !flat[j].face.edges.some((x) => x.isSame(e))) continue;
        const p = e.startPoint.toTuple() as V3;
        try {
          fills.push(prism([p, at(p, n1), at(p, m), at(p, n2)], sub3(e.endPoint.toTuple() as V3, p)));
        } catch {
          // degenerate wedge: skip it
        }
      }
    }
  }
  // Corners shared by three square-on faces (e.g. the top and two sides of a box).
  const corners = new Map<string, { p: V3; ns: V3[] }>();
  for (const { face, n } of flat) {
    const seen = new Set<string>();
    for (const e of face.edges) {
      for (const p of [e.startPoint.toTuple() as V3, e.endPoint.toTuple() as V3]) {
        const k = ptKey(p);
        if (seen.has(k)) continue;
        seen.add(k);
        const entry = corners.get(k) ?? { p, ns: [] };
        entry.ns.push(n);
        corners.set(k, entry);
      }
    }
  }
  for (const { p, ns } of corners.values()) {
    if (ns.length !== 3) continue;
    const [a, b, c] = ns;
    if (Math.abs(dot3(a, b)) > 1e-6 || Math.abs(dot3(b, c)) > 1e-6 || Math.abs(dot3(a, c)) > 1e-6) continue;
    try {
      fills.push(prism([p, at(p, a), at(p, a, b), at(p, b)], [c[0] * distance, c[1] * distance, c[2] * distance]));
    } catch {
      // degenerate corner: skip it
    }
  }
  return fills;
}

/**
 * Push/pull faces with their tangent fillet chains; if that fails or gives an
 * invalid solid, fall back to moving just the faces themselves.
 */
function pushPullFaces(shape: Solid, picked: { face: Face; n: V3 }[], distance: number): Solid {
  // A curved wall split in pieces (a stretched cylinder's side) moves as a whole.
  const walls = picked.flatMap(({ face, n }) => sameWallFaces(shape, face).map((g) => ({ face: g, n })));
  const extra = walls.filter((w, i) => !picked.some((p) => p.face.isSame(w.face)) && walls.findIndex((x) => x.face.isSame(w.face)) === i);
  const faces = [...picked, ...extra].map((f) => ({ ...f, radial: true }));
  const selected = new Set(faces.map(({ face }) => face.hashCode));
  // A fillet between two selected faces would be swept twice in different directions: leave it.
  // A selected fillet sweeps on its own (radially), so it is not part of any face's chain.
  const owner = new Map<number, number>();
  const chains = faces.map(({ face, n }, i) => {
    // Only flat faces carry their rim fillets along; a selected curved face moves on its own.
    const chain = face.geomType === "PLANE" ? tangentChain(shape, face, n).filter((g) => !selected.has(g.hashCode)) : [];
    for (const g of chain) owner.set(g.hashCode, owner.has(g.hashCode) && owner.get(g.hashCode) !== i ? -1 : i);
    return chain;
  });
  const withChains = faces.flatMap((f, i) => [f, ...chains[i].filter((g) => owner.get(g.hashCode) === i).map((g) => ({ face: g, n: f.n }))]);
  // Flat faces all moving one way on a solid with free-form faces (where sweeping them makes the
  // boolean slow): try it as a stretch first.
  if (shape.faces.some((f) => !ANALYTIC.has(f.geomType)) && faces.every(({ face, n }) => face.geomType === "PLANE" && dot3(n, faces[0].n) > 1 - 1e-9)) {
    const r = stretchPushPull(shape, withChains.map(({ face }) => face), faces[0].n, distance);
    if (r) return mergeCoincidentFaces(r);
  }
  if (withChains.length > faces.length) {
    try {
      const r = sweepFaces(shape, withChains, distance);
      if (isValidShape(r)) return mergeCoincidentFaces(r);
    } catch {
      // fall through to the plain push/pull
    }
  }
  return mergeCoincidentFaces(sweepFaces(shape, faces, distance));
}

/** Surfaces simplify() already merges by their parameters (it only merges others if they are the same object). */
const ANALYTIC = new Set(["PLANE", "CYLINDRE", "CONE", "SPHERE", "TORUS"]);

/**
 * Neighbouring faces that lie on one free-form surface but carry different copies of it — e.g. a
 * stretched (B-spline) fillet and the piece a push/pull extruded from its end — stay separate after
 * simplify(), leaving a seam. Rebuild each such group on one surface object so they merge.
 * Returns `shape` unchanged if nothing matches or the merge does not give a valid solid.
 */
function mergeCoincidentFaces(shape: Solid): Solid {
  if (previewing) return shape; // seams don't matter in a drag preview: keep it fast
  const faces = shape.faces.filter((f) => !ANALYTIC.has(f.geomType));
  if (faces.length < 2) return shape;
  const tmp: { delete(): void }[] = [];
  const keep = <T>(o: T): T => (tmp.push(o as unknown as { delete(): void }), o);
  try {
    // Does face `b` lie on the surface of face `a`? (A grid of points over b's (u, v) bounds.)
    // Points are projected onto B-splines only: OpenCascade's projection onto a linear extrusion
    // can crash, so an extrusion is projected onto its exact B-spline, long enough to reach b.
    const known = new Map<string, boolean>();
    const liesOn = (b: Face, a: Face): boolean => {
      const k = `${faces.indexOf(b)}:${faces.indexOf(a)}`;
      if (!known.has(k)) known.set(k, liesOnUncached(b, a));
      return known.get(k)!;
    };
    const liesOnUncached = (b: Face, a: Face): boolean => {
      let s: unknown;
      if (a.geomType === "BSPLINE_SURFACE") s = keep(oc.BRep_Tool.Surface(a.wrapped));
      else if (a.geomType === "EXTRUSION_SURFACE") {
        const fa = keep(new oc.BRepAdaptor_Surface(a.wrapped, true));
        const [[x0, y0, z0], [x1, y1, z1]] = a.boundingBox.bounds, [[X0, Y0, Z0], [X1, Y1, Z1]] = b.boundingBox.bounds;
        const reach = Math.hypot(Math.max(x1, X1) - Math.min(x0, X0), Math.max(y1, Y1) - Math.min(y0, Y0), Math.max(z1, Z1) - Math.min(z0, Z0));
        s = extrudedSurface(a, keep, [fa.FirstVParameter() - reach, fa.LastVParameter() + reach]);
      }
      if (!s) return false;
      const ad = keep(new oc.BRepAdaptor_Surface(b.wrapped, true));
      const u0 = ad.FirstUParameter(), u1 = ad.LastUParameter(), v0 = ad.FirstVParameter(), v1 = ad.LastVParameter();
      for (let i = 0; i <= 4; i++) {
        for (let j = 0; j <= 4; j++) {
          const p = keep(ad.Value(u0 + ((u1 - u0) * i) / 4, v0 + ((v1 - v0) * j) / 4));
          const pr = keep(new oc.GeomAPI_ProjectPointOnSurf(p, s));
          if (!pr.IsDone() || pr.NbPoints() < 1 || pr.LowerDistance() > 1e-6) return false;
        }
      }
      return true;
    };
    // Groups of neighbours on a common surface (union-find).
    const parent = faces.map((_, i) => i);
    const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
    for (let i = 0; i < faces.length; i++) {
      for (let j = i + 1; j < faces.length; j++) {
        if (!faces[i].edges.some((e) => faces[j].edges.some((x) => x.isSame(e)))) continue;
        try {
          if (liesOn(faces[j], faces[i]) || liesOn(faces[i], faces[j])) parent[root(j)] = root(i);
        } catch {
          // projection failed: leave them apart
        }
      }
    }
    const groups = new Map<number, Face[]>();
    faces.forEach((f, i) => groups.set(root(i), [...(groups.get(root(i)) ?? []), f]));
    const replaced = new Map<Face, unknown>();
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      // The host: a face whose surface carries the whole group (an unbounded extrusion over a bounded patch).
      const host = group.find((h) => (h.wrapped as unknown as { Location(): { IsIdentity(): boolean } }).Location().IsIdentity() && group.every((f) => f === h || liesOn(f, h)));
      if (!host) continue;
      const s = keep(oc.BRep_Tool.Surface(host.wrapped));
      for (const f of group) {
        if (f === host) continue;
        const nf = rebuildOnSurface(f, s, keep);
        if (!nf) return shape;
        replaced.set(f, nf);
      }
    }
    if (!replaced.size) return shape;
    // Reassemble the solid: the rebuilt faces keep their neighbours' edges, so it closes up as before.
    const b = keep(new oc.TopoDS_Builder());
    const shell = keep(new oc.TopoDS_Shell());
    b.MakeShell(shell);
    for (const f of shape.faces) b.Add(shell, [...replaced].find(([g]) => g.isSame(f))?.[1] ?? f.wrapped);
    const solid = keep(new oc.TopoDS_Solid());
    b.MakeSolid(solid);
    b.Add(solid, shell);
    const assembled = cast(solid) as Solid;
    if (!isValidShape(assembled)) return shape;
    const merged = assembled.simplify();
    return isValidShape(merged) && merged.faces.length < shape.faces.length ? merged : shape;
  } catch {
    return shape;
  } finally {
    for (const o of tmp) {
      try {
        o.delete();
      } catch {
        // already owned by OpenCascade
      }
    }
  }
}

/**
 * `face` with its own outlines (same edges) on surface `s`, facing the same way; null if it fails.
 * The edges get trimming curves on `s` (ShapeFix_Wire); `s` must contain the whole face.
 */
function rebuildOnSurface(face: Face, s: unknown, keep: <T>(o: T) => T): unknown {
  const fwd = (face.wrapped as unknown as { Oriented(o: unknown): unknown }).Oriented(oc.TopAbs_Orientation.TopAbs_FORWARD);
  const wires: unknown[] = [];
  const ex = keep(new oc.TopExp_Explorer(fwd as never, oc.TopAbs_ShapeEnum.TopAbs_WIRE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
  for (; ex.More(); ex.Next()) wires.push(oc.TopoDS.Wire(ex.Current()));
  // The outer outline first (OpenCascade's own pick), the holes after it.
  const outer = oc.BRepTools.OuterWire(oc.TopoDS.Face(fwd));
  const holes = wires.filter((w) => !(w as { IsSame(o: unknown): boolean }).IsSame(outer));
  let mk = keep(new oc.BRepBuilderAPI_MakeFace(s as never, outer, true));
  for (const h of holes) mk.Add(h);
  if (!mk.IsDone()) return null;
  const raw = mk.Face();
  const fixed = [outer, ...holes].map((w) => {
    const sfw = keep(new oc.ShapeFix_Wire(w, raw, 1e-6));
    sfw.FixEdgeCurves();
    return sfw.Wire();
  });
  mk = keep(new oc.BRepBuilderAPI_MakeFace(s as never, fixed[0], true));
  for (const w of fixed.slice(1)) mk.Add(w);
  if (!mk.IsDone()) return null;
  let nf = mk.Face();
  // Face the same way as the original (its surface may be parameterised the other way round):
  // then each edge runs the same way round it. (Compared on the edges, not by normals at a
  // point — finding that point on `s` can crash OpenCascade if `s` is a linear extrusion.)
  const use = (f: unknown) => {
    const ex = new oc.TopExp_Explorer(f as never, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    const out: { IsSame(o: unknown): boolean; Orientation(): unknown }[] = [];
    for (; ex.More(); ex.Next()) out.push(ex.Current());
    ex.delete();
    return out;
  };
  const before = use(face.wrapped), after = use(nf);
  const e = before.find((x) => after.some((y) => y.IsSame(x)));
  if (!e) return null;
  if (after.find((y) => y.IsSame(e))!.Orientation() !== e.Orientation()) nf = oc.TopoDS.Face(nf.Reversed());
  return nf;
}

function faceWithNormal(shape: Solid, faceId: number): { face: Face; n: V3 } {
  const face = findFace(shape, faceId);
  if (!face) throw new Error("face not found");
  return { face, n: face.geomType === "PLANE" ? norm3(face.normalAt().toTuple() as V3) : normalAtUV(face, 0.5, 0.5) };
}

/**
 * The faces a push/pull of `faceIds` moves, each with its direction: the faces themselves and,
 * for flat ones, the fillets they carry along. Used for an instant (mesh) preview while dragging;
 * throws for a curved wall, which doesn't move that way (the real preview is shown instead).
 */
export function pushPullMoves(shape: Solid, faceIds: number[]): Map<number, V3> {
  const out = new Map<number, V3>();
  const selected = new Set(faceIds);
  for (const id of faceIds) {
    const { face, n } = faceWithNormal(shape, id);
    // A curved wall grows round its section rather than sliding one way: no instant preview.
    if (wallSection(face)) throw new Error("curved wall: no instant preview");
    out.set(id, n);
    if (face.geomType === "PLANE") for (const g of tangentChain(shape, face, n)) if (!selected.has(g.hashCode) && !out.has(g.hashCode)) out.set(g.hashCode, n);
  }
  return out;
}

/** Push (negative) or pull (positive) a face of a solid along its normal, modifying that solid. */
export function pushPull(shape: Solid, faceId: number, distance: number): Solid {
  const f = faceWithNormal(shape, faceId);
  if (distance === 0) return shape;
  return pushPullFaces(shape, [f], distance);
}

/** Push/pull several faces of one solid by the same distance (each along its own normal). */
export function pushPullMany(shape: Solid, faceIds: number[], distance: number): Solid {
  // Faces are all looked up on the original shape so face ids stay valid.
  const faces = faceIds.map((id) => faceWithNormal(shape, id));
  if (distance === 0) return shape;
  return pushPullFaces(shape, faces, distance);
}

// ---------------------------------------------------------------- split face

/** A straight edge of a planar face usable as a reference for a guide line. */
export interface RefEdge {
  id: number;
  a: V3;
  b: V3;
  /** Unit direction inside the face plane, perpendicular to the edge, pointing into the face. */
  inward: V3;
  /** Extent of the face measured from this edge along `inward`. */
  width: number;
}

const sub3 = (p: V3, q: V3): V3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const dot3 = (p: V3, q: V3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const cross3 = (p: V3, q: V3): V3 => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
const norm3 = (p: V3): V3 => {
  const l = Math.hypot(...p) || 1;
  return [p[0] / l, p[1] / l, p[2] / l];
};

/** Straight edges of a planar face (with the face normal), or null if the face is not planar. */
export function faceRefEdges(shape: Shape, faceId: number): { normal: V3; edges: RefEdge[] } | null {
  const face = findFace(shape, faceId);
  if (!face || face.geomType !== "PLANE") return null;
  const n = face.normalAt(face.center).normalized().toTuple() as V3;
  const c = face.center.toTuple() as V3;
  const pts = face.edges.flatMap((e) => [e.startPoint.toTuple() as V3, e.endPoint.toTuple() as V3]);
  const edges: RefEdge[] = [];
  for (const e of face.edges) {
    if (e.geomType !== "LINE") continue;
    const a = e.startPoint.toTuple() as V3;
    const b = e.endPoint.toTuple() as V3;
    let p = norm3(cross3(n, norm3(sub3(b, a))));
    if (dot3(sub3(c, a), p) < 0) p = [-p[0], -p[1], -p[2]];
    const width = Math.max(...pts.map((q) => dot3(sub3(q, a), p)));
    edges.push({ id: e.hashCode, a, b, inward: p, width });
  }
  return { normal: n, edges };
}

// ---------------------------------------------------------------- move edges

/** End points of an edge, or null if there is no such edge. */
export function edgeEnds(shape: Shape, edgeId: number): [V3, V3] | null {
  const e = shape.edges.find((x) => x.hashCode === edgeId);
  return e ? [e.startPoint.toTuple() as V3, e.endPoint.toTuple() as V3] : null;
}

/** End points of a straight edge; null for any other edge. */
export function lineOfEdge(shape: Shape, edgeId: number): [V3, V3] | null {
  const e = shape.edges.find((x) => x.hashCode === edgeId);
  return e && e.geomType === "LINE" ? [e.startPoint.toTuple() as V3, e.endPoint.toTuple() as V3] : null;
}

/** Centre, axis (unit, either way round) and radius of a circle / arc edge; null for any other edge. */
export function circleOfEdge(shape: Shape, edgeId: number): { center: V3; normal: V3; r: number } | null {
  const e = shape.edges.find((x) => x.hashCode === edgeId);
  if (!e || e.geomType !== "CIRCLE") return null;
  // (three points on it: the centre of the circle through them, exact for a circle)
  const [p, q, s] = [0, 1 / 3, 2 / 3].map((t) => e.pointAt(t).toTuple() as V3);
  const a = sub3(q, p), b = sub3(s, p), n = cross3(a, b), nn = dot3(n, n);
  if (nn < 1e-18) return null;
  const k1 = cross3(n, a), k2 = cross3(b, n), aa = dot3(a, a), bb = dot3(b, b);
  const center: V3 = [0, 1, 2].map((i) => p[i] + (bb * k1[i] + aa * k2[i]) / (2 * nn)) as V3;
  const len = Math.sqrt(nn);
  return { center, normal: n.map((x) => x / len) as V3, r: Math.hypot(...sub3(p, center)) };
}

/** Id of the edge running between `a` and `b` (either direction), if any. */
export function edgeBetween(shape: Shape, a: V3, b: V3, tol = 1e-5): number | null {
  const near = (p: V3, q: V3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < tol;
  for (const e of shape.edges) {
    const s = e.startPoint.toTuple() as V3, t = e.endPoint.toTuple() as V3;
    if ((near(s, a) && near(t, b)) || (near(s, b) && near(t, a))) return e.hashCode;
  }
  return null;
}

export const MOVE_EDGE_REFUSED = "Move edge: the edge must be straight, and the faces at its ends flat with straight edges meeting its ends (no curves or fillets there)";

/**
 * Whether these edges of a shape form one closed loop (a single closed edge — a circle — or edges
 * end to end back to the start): each corner shared by exactly two of them, all connected.
 */
export function isEdgeLoop(shape: Shape, edgeIds: number[]): boolean {
  const edges = shape.edges.filter((e) => edgeIds.includes(e.hashCode));
  if (!edges.length || edges.length !== new Set(edgeIds).size) return false;
  const count = new Map<string, number>();
  for (const e of edges) for (const p of [e.startPoint, e.endPoint]) count.set(ptKey(p.toTuple() as V3), (count.get(ptKey(p.toTuple() as V3)) ?? 0) + 1);
  if ([...count.values()].some((n) => n !== 2)) return false;
  try {
    return chainEdges(edges).length === edges.length;
  } catch {
    return false; // (two separate loops)
  }
}

/** A flat face filling a closed loop of a shape's edges (see isEdgeLoop); throws if the loop isn't flat. */
export function edgeLoopFace(shape: Shape, edgeIds: number[]): Face {
  const edges = chainEdges(shape.edges.filter((e) => edgeIds.includes(e.hashCode))).map((e) => e.clone());
  let face: Face;
  try {
    face = makeFace(assembleWire(edges));
  } catch {
    throw new Error("Duplicate: the loop isn't flat — only a flat loop becomes a face");
  }
  if (face.geomType !== "PLANE" || !isValidShape(face)) throw new Error("Duplicate: the loop isn't flat — only a flat loop becomes a face");
  return face;
}

/** True if every face is flat and every edge straight. */
export function isPolyhedral(shape: Shape): boolean {
  return shape.faces.every((f) => f.geomType === "PLANE") && shape.edges.every((e) => e.geomType === "LINE");
}

const add3 = (p: V3, q: V3): V3 => [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
const ptKey = (p: V3) => p.map((x) => Math.round(x * 1e5)).join();

/** The corners (point keys) moved with the given edges; null unless they're all straight. */
function movedCorners(shape: Shape, edgeIds: Set<number>): Set<string> | null {
  const moved = new Set<string>();
  for (const e of shape.edges) {
    if (!edgeIds.has(e.hashCode)) continue;
    if (e.geomType !== "LINE") return null;
    moved.add(ptKey(e.startPoint.toTuple() as V3));
    moved.add(ptKey(e.endPoint.toTuple() as V3));
  }
  return moved.size ? moved : null;
}

/** Whether a face has one of these corners. */
const hasCorner = (f: Face, moved: Set<string>) => f.edges.some((e) => moved.has(ptKey(e.startPoint.toTuple() as V3)) || moved.has(ptKey(e.endPoint.toTuple() as V3)));

/** Whether an edge starts or ends at one of these corners. */
const edgeAtCorner = (e: Face["edges"][number], moved: Set<string>) => moved.has(ptKey(e.startPoint.toTuple() as V3)) || moved.has(ptKey(e.endPoint.toTuple() as V3));

/**
 * Whether `moveEdges` can move these edges: they're straight, the faces round their corners are flat
 * and the edges meeting those corners straight (curved edges elsewhere on those faces, and curved
 * faces elsewhere on the solid, stay as they are).
 */
export function canMoveEdges(shape: Shape, edgeIds: Set<number>): boolean {
  const moved = movedCorners(shape, edgeIds);
  return !!moved && shape.faces.filter((f) => hasCorner(f, moved)).every((f) => f.geomType === "PLANE" && f.edges.every((e) => e.geomType === "LINE" || !edgeAtCorner(e, moved)));
}

/** Edges put in order end to end (for a wire). */
function chainEdges<E extends { startPoint: { toTuple(): number[] }; endPoint: { toTuple(): number[] } }>(edges: E[]): E[] {
  const ends = (e: E) => [ptKey(e.startPoint.toTuple() as V3), ptKey(e.endPoint.toTuple() as V3)];
  const left = [...edges], out = [left.shift()!];
  let [head, tail] = ends(out[0]);
  while (left.length) {
    const i = left.findIndex((e) => ends(e).includes(tail));
    if (i >= 0) {
      const [a, b] = ends(left[i]);
      tail = a === tail ? b : a;
      out.push(left.splice(i, 1)[0]);
      continue;
    }
    const j = left.findIndex((e) => ends(e).includes(head));
    if (j < 0) throw new Error("Move edge: a face boundary is not a closed loop");
    const [a, b] = ends(left[j]);
    head = a === head ? b : a;
    out.unshift(left.splice(j, 1)[0]);
  }
  return out;
}

/** Wire edges chained into an ordered loop of corner points. */
function loopPoints(edges: { startPoint: { toTuple(): number[] }; endPoint: { toTuple(): number[] } }[]): V3[] {
  const segs = edges.map((e) => [e.startPoint.toTuple() as V3, e.endPoint.toTuple() as V3]);
  const pts: V3[] = [segs[0][0], segs[0][1]];
  segs.splice(0, 1);
  while (segs.length) {
    const end = ptKey(pts[pts.length - 1]);
    const i = segs.findIndex((sg) => ptKey(sg[0]) === end || ptKey(sg[1]) === end);
    if (i < 0) throw new Error("Move edge: a face boundary is not a closed loop");
    const [a, b] = segs.splice(i, 1)[0];
    pts.push(ptKey(a) === end ? b : a);
  }
  if (ptKey(pts[0]) === ptKey(pts[pts.length - 1])) pts.pop();
  return pts;
}

/** Newell normal of a polygon (not normalised; zero for degenerate loops). */
function newell(pts: V3[]): V3 {
  const n: V3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    n[0] += (p[1] - q[1]) * (p[2] + q[2]);
    n[1] += (p[2] - q[2]) * (p[0] + q[0]);
    n[2] += (p[0] - q[0]) * (p[1] + q[1]);
  }
  return n;
}

/** Ear-clipping triangulation of a simple polygon; returns index triples. */
function triangulate(pts: V3[], normal: V3): [number, number, number][] {
  // Project onto the polygon plane.
  const n = norm3(normal);
  const u = norm3(Math.abs(n[0]) < 0.9 ? cross3(n, [1, 0, 0]) : cross3(n, [0, 1, 0]));
  const w = cross3(n, u);
  const p2 = pts.map((p) => [dot3(p, u), dot3(p, w)]);
  const area = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const idx = pts.map((_, i) => i);
  const tris: [number, number, number][] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
      const a = p2[i0], b = p2[i1], c = p2[i2];
      if (area(a, b, c) <= 1e-12) continue; // reflex or flat corner
      const inside = idx.some((j) => j !== i0 && j !== i1 && j !== i2 &&
        area(a, b, p2[j]) >= 0 && area(b, c, p2[j]) >= 0 && area(c, a, p2[j]) >= 0);
      if (inside) continue;
      tris.push([i0, i1, i2]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) throw new Error("Move edge: could not split a bent face into triangles");
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

function polyWire(pts: V3[]) {
  return assembleWire(pts.map((p, i) => makeLine(p, pts[(i + 1) % pts.length])));
}

/**
 * Move the given straight edges of a solid by `v`, reshaping the faces around them (those must be
 * flat with straight edges; the rest — curved faces too — stay as they are). Faces that stay flat
 * stay single faces; faces that bend are split into triangles. Coplanar neighbours are merged again afterwards.
 */
export function moveEdges(shape: Solid, edgeIds: Set<number>, v: V3): Solid {
  if (!canMoveEdges(shape, edgeIds)) throw new Error(MOVE_EDGE_REFUSED);
  const moved = movedCorners(shape, edgeIds)!;
  const mv = (p: V3): V3 => (moved.has(ptKey(p)) ? add3(p, v) : p);
  // Drop corners that collapse onto their neighbour.
  const clean = (pts: V3[]) => pts.filter((p, i) => ptKey(p) !== ptKey(pts[(i + 1) % pts.length]));

  const [lo, hi] = shape.boundingBox.bounds;
  const tol = 1e-6 * Math.max(1, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + Math.hypot(...v));
  const faces: Face[] = [];
  for (const f of shape.faces) {
    if (!hasCorner(f, moved)) {
      faces.push(f);
      continue;
    }
    if (f.edges.some((e) => e.geomType !== "LINE")) {
      // A face with curved edges (away from the moved corners): rebuilt with its straight edges
      // moved and the curved ones as they are — it must stay flat.
      const n = norm3(f.normalAt().toTuple() as V3), c = f.center.toTuple() as V3;
      if (f.edges.some((e) => [e.startPoint, e.endPoint].some((q) => Math.abs(dot3(sub3(mv(q.toTuple() as V3), c), n)) > tol)))
        throw new Error("Move edge: this would bend a face that has curved edges (move the edge along that face instead)");
      const wire = (w: Wire) =>
        assembleWire(chainEdges(w.edges.flatMap((e) => {
          if (e.geomType !== "LINE") return [e];
          const a = mv(e.startPoint.toTuple() as V3), b = mv(e.endPoint.toTuple() as V3);
          return ptKey(a) === ptKey(b) ? [] : [makeLine(a, b)];
        })));
      faces.push(makeFace(wire(f.clone().outerWire()), f.clone().innerWires().map(wire)));
      continue;
    }
    // outerWire / innerWires delete the face they are called on.
    const loops = [f.clone().outerWire(), ...f.clone().innerWires()].map((w) => loopPoints(w.edges));
    const outer0 = loops[0];
    const outer = clean(outer0.map(mv));
    const holes = loops.slice(1).map((l) => clean(l.map(mv)));
    if (outer.length < 3) continue; // face collapsed to a line
    const n = norm3(newell(outer));
    const flat = Math.hypot(...newell(outer)) > 1e-12 &&
      [outer, ...holes].every((l) => l.every((p) => Math.abs(dot3(sub3(p, outer[0]), n)) < tol));
    if (flat) {
      faces.push(makeFace(polyWire(outer), holes.filter((h) => h.length >= 3).map(polyWire)));
      continue;
    }
    if (holes.length) throw new Error("Move edge: this would bend a face that has a hole");
    // Split along the original (flat) layout so the triangles never overlap.
    for (const [a, b, c] of triangulate(outer0, newell(outer0))) {
      const t = [mv(outer0[a]), mv(outer0[b]), mv(outer0[c])];
      if (Math.hypot(...cross3(sub3(t[1], t[0]), sub3(t[2], t[0]))) < 1e-12) continue;
      faces.push(makeFace(polyWire(t)));
    }
  }
  const solid = makeSolid(faces).simplify();
  if (!isValidShape(solid)) throw new Error("Move edge: the result is not a valid solid (faces would cross)");
  return solid;
}

// ---------------------------------------------------------------- divide face (split a face by a line)

/** Distance from `p` to the segment a–b. */
function segDist(p: V3, a: V3, b: V3): number {
  const ab = sub3(b, a);
  const len2 = dot3(ab, ab);
  const t = len2 > 0 ? Math.min(1, Math.max(0, dot3(sub3(p, a), ab) / len2)) : 0;
  return Math.hypot(...sub3(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]));
}

/**
 * Split a flat face of a solid along the straight line a–b. Both points must lie
 * on the face's (straight) boundary edges; the face is found from them. The
 * neighbouring faces gain the new corner points, so the new edge can be moved.
 */
export function splitFaceByLine(shape: Solid, a: V3, b: V3): Solid {
  const [lo, hi] = shape.boundingBox.bounds;
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const tol = Math.max(1e-5, diag * 1e-7);
  const len = Math.hypot(...sub3(b, a));
  if (len < tol * 10) throw new Error("Draw line on face: the two points are the same");
  const onBoundary = (f: Face, p: V3) =>
    f.edges.some((e) => e.geomType === "LINE" && segDist(p, e.startPoint.toTuple() as V3, e.endPoint.toTuple() as V3) < tol * 10);
  const face = shape.faces.find((f) => {
    if (f.geomType !== "PLANE") return false;
    const n = f.normalAt(f.center).normalized().toTuple() as V3;
    const c = f.center.toTuple() as V3;
    if (Math.abs(dot3(sub3(a, c), n)) > tol * 10 || Math.abs(dot3(sub3(b, c), n)) > tol * 10) return false;
    if (!onBoundary(f, a) || !onBoundary(f, b)) return false;
    // A line along an existing edge splits nothing.
    const m: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    return !onBoundary(f, m);
  });
  if (!face) throw new Error("Draw line on face: start and end on the edges of the same flat face (corners, midpoints or anywhere along an edge)");
  // Clicked points carry float32 snap error: make them exact corners / midpoints / points on the edge.
  const exact = (p: V3): V3 => {
    let best: V3 = p, bestD = Infinity;
    for (const e of face.edges) {
      if (e.geomType !== "LINE") continue;
      const s = e.startPoint.toTuple() as V3, f = e.endPoint.toTuple() as V3;
      if (segDist(p, s, f) >= tol * 10) continue;
      const m: V3 = [(s[0] + f[0]) / 2, (s[1] + f[1]) / 2, (s[2] + f[2]) / 2];
      for (const q of [s, f, m]) {
        const d = Math.hypot(...sub3(p, q));
        if (d < tol * 100 && d < bestD) { best = q; bestD = d; }
      }
      if (bestD === Infinity) {
        const ab = sub3(f, s);
        const k = dot3(sub3(p, s), ab) / dot3(ab, ab);
        best = [s[0] + ab[0] * k, s[1] + ab[1] * k, s[2] + ab[2] * k];
      }
    }
    return best;
  };
  a = exact(a);
  b = exact(b);
  const n = face.normalAt(face.center).normalized().toTuple() as V3;
  const t = norm3(sub3(b, a));
  const at = (o: V3, v: V3, k: number): V3 => [o[0] + v[0] * k, o[1] + v[1] * k, o[2] + v[2] * k];
  // A thin wall standing on the face (outside the solid), meeting it exactly on the line;
  // a little longer than a–b so it cleanly crosses the boundary edges.
  const ext = Math.max(tol * 100, len * 1e-3);
  const h = Math.max(1e-3, diag * 1e-3);
  const s0 = at(a, t, -ext), s1 = at(b, t, ext);
  const args = new oc.NCollection_List_TopoDS_Shape();
  args.Append(shape.wrapped);
  const tools = new oc.NCollection_List_TopoDS_Shape();
  tools.Append(makePolygon([s0, s1, at(s1, n, h), at(s0, n, h)]).wrapped);
  const builder = new oc.BRepAlgoAPI_Splitter();
  builder.SetArguments(args);
  builder.SetTools(tools);
  builder.Build(new oc.Message_ProgressRange());
  if (builder.HasErrors()) {
    builder.delete();
    throw new Error("Draw line on face: the geometry kernel could not divide this face");
  }
  const solids = [...iterTopo(builder.Shape(), "solid")].map((x) => cast(x) as Solid);
  builder.delete();
  if (solids.length !== 1 || !isValidShape(solids[0])) throw new Error("Draw line on face: dividing this face did not give a valid solid");
  return solids[0];
}

/** Hollow the solid inward, removing the given (open) faces, walls of `thickness`. */
export function shellSolid(shape: Solid, faceIds: Set<number>, thickness: number): Solid {
  // OpenCascade's shell offsets every wall surface. It fails on some walls (e.g. a stretched cylinder's
  // B-splines) — and on others (a cylinder cut by a plane) it "succeeds" giving the solid back
  // unchanged. A straight extrusion can be hollowed without it; otherwise its intersection mode, slower
  // but it copes with more.
  let first: unknown = null;
  try {
    const r = thickSolid(shape, faceIds, thickness, false);
    if (r) return r;
  } catch (e) {
    first = e;
  }
  const r = prismShell(shape, faceIds, thickness) ?? thickSolid(shape, faceIds, thickness, true);
  if (r) return r;
  throw first ?? new Error("Shell: the geometry kernel could not hollow this solid (try a smaller thickness)");
}

/**
 * OpenCascade's shell (walls offset inward by `thickness`, the given faces removed), or null when it
 * doesn't hollow anything: not done, not a valid solid, or no new faces / no volume taken away.
 */
function thickSolid(shape: Solid, faceIds: Set<number>, thickness: number, intersection: boolean): Solid | null {
  const faces = new oc.NCollection_List_TopoDS_Shape();
  const builder = new oc.BRepOffsetAPI_MakeThickSolid();
  try {
    for (const f of shape.faces) if (faceIds.has(f.hashCode)) faces.Append(f.wrapped);
    builder.MakeThickSolidByJoin(shape.wrapped, faces, -thickness, 1e-3, oc.BRepOffset_Mode.BRepOffset_Skin, intersection, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false, new oc.Message_ProgressRange());
    if (!builder.IsDone()) return null;
    const solids = [...iterTopo(builder.Shape(), "solid")];
    if (solids.length !== 1) return null;
    const r = cast(solids[0]) as Solid;
    if (!isValidShape(r) || r.faces.length <= shape.faces.length) return null;
    const v = solidVolume(r);
    return v > 1e-9 && v < solidVolume(shape) - 1e-9 ? r : null;
  } finally {
    faces.delete();
    builder.delete();
  }
}

/**
 * A flat face with every outline edge turned into a B-spline curve. A 2D offset of free-form
 * curves gives "offset curves", and a solid extruded from those fails OpenCascade's check.
 */
function asBSplineOutline(face: Face): Face {
  if (face.edges.every((e) => e.geomType !== "OFFSET_CURVE")) return face;
  const wireOf = (w: Wire) =>
    assembleWire(
      w.edges.map((e) => {
        if (e.geomType !== "OFFSET_CURVE") return e;
        const c = oc.BRep_Tool.Curve(e.wrapped, 0, 0);
        const bs = oc.GeomConvert.CurveToBSplineCurve(new oc.Geom_TrimmedCurve(c.returnValue, c.First, c.Last, true, true) as never);
        const mk = new oc.BRepBuilderAPI_MakeEdge(bs as never);
        try {
          return cast(mk.Edge()) as typeof e;
        } finally {
          mk.delete();
        }
      }),
    );
  const [outer, ...holes] = [face.clone().outerWire(), ...face.clone().innerWires()];
  let out = makeFace(wireOf(outer), holes.map(wireOf));
  if (dot3(out.normalAt().toTuple() as V3, face.normalAt().toTuple() as V3) < 0) out = out.flipOrientation();
  return out;
}

/**
 * Shell of a straight extrusion (flat caps, walls running straight between them) with one or
 * both caps removed: the cap's outline offset inward by `thickness` (a flat 2D offset — exact,
 * and reliable on any curve), extruded from `thickness` above the kept cap out through the open
 * one(s), and cut away. Null if the solid isn't such an extrusion.
 */
function prismShell(shape: Solid, faceIds: Set<number>, thickness: number): Solid | null {
  if (!(thickness > 0)) return null;
  try {
    const open = shape.faces.filter((f) => faceIds.has(f.hashCode));
    if (!open.length || open.some((f) => f.geomType !== "PLANE")) return null;
    const Z = norm3(open[0].normalAt().toTuple() as V3);
    const h = (p: { x: number; y: number; z: number }) => p.x * Z[0] + p.y * Z[1] + p.z * Z[2];
    // Every face: a cap square to Z, or a wall along it.
    const caps: Face[] = [];
    for (const f of shape.faces) {
      if (f.geomType === "PLANE") {
        const c = dot3(norm3(f.normalAt().toTuple() as V3), Z);
        if (Math.abs(Math.abs(c) - 1) < 1e-9) caps.push(f);
        else if (Math.abs(c) > 1e-9) return null;
      } else if (![0, 0.5, 1].every((u) => [0, 0.5, 1].every((v) => Math.abs(dot3(normalAtUV(f, u, v), Z)) < 1e-7))) return null;
    }
    const level = (f: Face) => h(f.edges[0].startPoint);
    const levels = [...new Set(caps.map((f) => level(f).toFixed(6)))];
    if (levels.length !== 2 || open.some((f) => !caps.includes(caps.find((c) => c.isSame(f))!))) return null;
    const top = Math.max(...caps.map(level)), bottom = Math.min(...caps.map(level));
    const openTop = open.some((f) => Math.abs(level(f) - top) < 1e-6), openBottom = open.some((f) => Math.abs(level(f) - bottom) < 1e-6);
    // Every cap at an open end must be open (else part of that end would be cut through).
    if (caps.some((f) => !open.some((o) => o.isSame(f)) && ((openTop && Math.abs(level(f) - top) < 1e-6) || (openBottom && Math.abs(level(f) - bottom) < 1e-6)))) return null;
    if (top - bottom <= (openTop && openBottom ? 0 : thickness)) return null;
    // The inside: the open cap's outline moved in by the thickness (one face per cap piece).
    const margin = Math.max(1, thickness);
    const from = openBottom ? bottom - margin : bottom + thickness, to = openTop ? top + margin : top - thickness;
    let result: Shape3D = shape;
    for (const cap of open.filter((f) => Math.abs(level(f) - (openTop ? top : bottom)) < 1e-6)) {
      let inner = asBSplineOutline(offsetPlanar(cap, -thickness, false));
      inner = inner.clone().translate([Z[0] * (from - level(cap)), Z[1] * (from - level(cap)), Z[2] * (from - level(cap))]) as Face;
      if (dot3(inner.normalAt().toTuple() as V3, Z) < 0) inner = inner.flipOrientation();
      result = boolean("cut", result, basicFaceExtrusion(inner, new Vector([Z[0] * (to - from), Z[1] * (to - from), Z[2] * (to - from)])));
    }
    const out = result.simplify();
    return isValidShape(out) && out.faces.length > shape.faces.length ? out : null;
  } catch {
    return null;
  }
}

/**
 * New flat face on the same plane as a planar face, its outline offset by `distance`
 * (positive = larger, holes shrink; negative = smaller). Corners stay sharp, or with `round`
 * the outline's corners are rounded with radius |distance|.
 * The source shape is not modified.
 */
export function offsetFace(shape: Shape, faceId: number, distance: number, round = false): Face {
  const face = findFace(shape, faceId);
  if (!face) throw new Error("face not found");
  if (face.geomType !== "PLANE") throw new Error("Offset works on flat faces only");
  if (Math.abs(distance) < 1e-9) throw new Error("distance must not be 0");
  // Arc joins only round the corners that open up; to shrink with round corners, shrink twice as far, then grow back round.
  return round && distance < 0 ? offsetPlanar(offsetPlanar(face, 2 * distance, false), -distance, true) : offsetPlanar(face, distance, round);
}

/** Box from Face (Macro menu): wall and bottom thickness, inside depth, the face's corners rounded (radius; 0 = sharp). */
export interface BoxFromFace {
  wall: number;
  bottom: number;
  height: number;
  radius: number;
}

/**
 * An open-top box round a flat face: the face is its inside — floor and inner outline (any shape: a rectangle
 * makes a tray, a circle a cup) — so the inside stays that size whatever the walls. Walls `wall` thick grow out
 * from the outline, the bottom `bottom` thick down under the face; `height` is the inside depth, up along the
 * face's normal. `radius`: the face's outward corners rounded first (the vertical edges), the outside following.
 */
export function boxFromFace(shape: Shape, faceId: number, o: BoxFromFace): Solid {
  const face = findFace(shape, faceId);
  if (!face) throw new Error("face not found");
  if (face.geomType !== "PLANE") throw new Error("Box from Face works on flat faces only");
  if (!(o.wall > 0)) throw new Error("the wall must be thicker than 0");
  if (!(o.bottom > 0)) throw new Error("the bottom must be thicker than 0");
  if (!(o.height > 0)) throw new Error("the height must be more than 0");
  if (o.radius < 0) throw new Error("the radius can't be below 0");
  // Round corners keeping the size: in by the radius, then out again with arcs at the corners
  let inner = face;
  if (o.radius > 1e-9) {
    try {
      inner = asBSplineOutline(offsetPlanar(offsetPlanar(face, -o.radius, false), o.radius, true));
    } catch {
      throw new Error("the radius is too big for this face");
    }
  }
  // (round: the outside's corners follow the inside's, radius + wall; sharp stays sharp. A freeform outline — an
  // oval — offsets into "offset curves": made B-splines, or the extruded solid fails OpenCascade's check)
  const outer = asBSplineOutline(offsetPlanar(inner, o.wall, o.radius > 1e-9));
  const n = norm3(face.normalAt().toTuple() as V3);
  const along = (d: number) => new Vector([n[0] * d, n[1] * d, n[2] * d]);
  const base = outer.clone().translate([-n[0] * o.bottom, -n[1] * o.bottom, -n[2] * o.bottom]) as Face;
  const body = basicFaceExtrusion(base, along(o.bottom + o.height)) as Shape3D;
  // The inside: from the face (the floor) up, a little past the top (a clean cut through it)
  const hollow = basicFaceExtrusion(inner, along(o.height + Math.max(1, o.height))) as Shape3D;
  const out = booleanOp("subtract", body, [hollow]);
  if (!isValidShape(out)) throw new Error("Box from Face: the result is not a valid solid");
  return out;
}

/**
 * Box Lid (Macro menu): plate thickness; `over` false: a lip under it that fits in the opening (depth 0: none; wall
 * 0: a solid plug); true: a cap — a skirt down round the box's outside (wall > 0). `clearance`: the gap to the box.
 */
export interface BoxLid {
  over: boolean;
  thickness: number;
  lipDepth: number;
  lipWall: number;
  clearance: number;
}

/**
 * An open-top box's rim: the flat ring at its open top (a flat face with a hole — the opening — lying on the very top
 * of the solid along its own normal; the largest if several). Null if the solid hasn't one.
 */
function boxRim(box: Solid): Face | null {
  const pts = box.edges.flatMap((e) => [0, 0.5, 1].map((t) => e.pointAt(t).toTuple() as V3));
  let best: Face | null = null, bestArea = 0;
  for (const f of box.faces) {
    if (f.geomType !== "PLANE" || f.clone().innerWires().length < 1) continue;
    const n = norm3(f.normalAt().toTuple() as V3), at = dot3(f.center.toTuple() as V3, n);
    if (pts.some((p) => dot3(p, n) > at + 1e-6)) continue; // (something sticks out past it: not the top)
    const a = measureArea(f);
    if (a > bestArea) [best, bestArea] = [f, a];
  }
  return best;
}

/** Is `box` an open-top box a lid can be made for (it has a rim, see boxRim)? (Asked on hover: kept per shape.) */
export function hasBoxRim(box: Solid): boolean {
  let has = rimKnown.get(box);
  if (has === undefined) rimKnown.set(box, (has = boxRim(box) !== null));
  return has;
}
const rimKnown = new WeakMap<object, boolean>();

/**
 * A lid for an open-top box, closed on it. Inside lip: a plate the rim's outside outline, `thickness` thick, lying on
 * the rim; under it a lip `lipDepth` deep that fits in the opening — `clearance` smaller all round, a ring `lipWall`
 * thick (0: a solid plug). Over the box (`over`): a cap — the plate bigger, a skirt `lipWall` thick and `lipDepth`
 * deep round the box's outside, `clearance` away from it.
 */
export function boxLid(box: Solid, o: BoxLid): Solid {
  const rim = boxRim(box);
  if (!rim) throw new Error("this solid has no open top (a flat rim round an opening) — make it with Box from Face or Shell");
  if (!(o.thickness > 0)) throw new Error("the lid must be thicker than 0");
  if (o.lipDepth < 0 || o.lipWall < 0 || o.clearance < 0) throw new Error("lip depth, lip wall and clearance can't be below 0");
  const n = norm3(rim.normalAt().toTuple() as V3);
  const along = (d: number) => new Vector([n[0] * d, n[1] * d, n[2] * d]);
  // Down into / round the box from the rim: moved down first, then extruded up to it (keeps the solid the right way out)
  const down = (f: Face) => basicFaceExtrusion(f.clone().translate([-n[0] * o.lipDepth, -n[1] * o.lipDepth, -n[2] * o.lipDepth]) as Face, along(o.lipDepth)) as Shape3D;
  const outside = makeFace(rim.clone().outerWire());
  if (o.over) {
    if (!(o.lipWall > 1e-9)) throw new Error("a lid over the box needs a wall thicker than 0 (its skirt)");
    const skirtIn = o.clearance > 1e-9 ? asBSplineOutline(offsetPlanar(outside, o.clearance, false)) : outside;
    const skirtOut = asBSplineOutline(offsetPlanar(skirtIn, o.lipWall, false));
    if (o.lipDepth <= 1e-9) return basicFaceExtrusion(skirtOut, along(o.thickness)) as Shape3D;
    // One block from the skirt's foot to the plate's top, the room for the box cut out under the plate (no union along
    // the curved outline of an oval: that one fails OpenCascade's check)
    const block = basicFaceExtrusion(skirtOut.clone().translate([-n[0] * o.lipDepth, -n[1] * o.lipDepth, -n[2] * o.lipDepth]) as Face, along(o.lipDepth + o.thickness)) as Shape3D;
    const out = booleanOp("subtract", block, [down(skirtIn)]);
    if (!isValidShape(out)) throw new Error("Box Lid: the result is not a valid solid");
    return out;
  }
  const holes = rim.clone().innerWires().map((w) => makeFace(w));
  const opening = holes.reduce((a, f) => (measureArea(f) > measureArea(a) ? f : a));
  const plate = basicFaceExtrusion(outside, along(o.thickness)) as Shape3D;
  if (o.lipDepth <= 1e-9) return plate;
  let lipOuter: Face;
  try {
    lipOuter = o.clearance > 1e-9 ? asBSplineOutline(offsetPlanar(opening, -o.clearance, false)) : opening;
  } catch {
    throw new Error("the clearance is too big for the opening");
  }
  let lip = down(lipOuter);
  if (o.lipWall > 1e-9) {
    let lipInner: Face;
    try {
      lipInner = asBSplineOutline(offsetPlanar(lipOuter, -o.lipWall, false));
    } catch {
      throw new Error("the lip wall is too thick for the opening (set it to 0 for a solid plug)");
    }
    lip = booleanOp("subtract", lip, [down(lipInner)]);
  }
  const out = booleanOp("union", plate, [lip]);
  if (!isValidShape(out)) throw new Error("Box Lid: the result is not a valid solid");
  return out;
}

/**
 * Dividers (Macro menu): `columns` compartments along the opening's long side, `rows` across it (1: no walls that
 * way), walls `wall` thick, their tops `topGap` below the rim (room for a lid's lip).
 */
export interface BoxDividers {
  columns: number;
  rows: number;
  wall: number;
  topGap: number;
}

/**
 * An open-top box (see boxRim) with divider walls in it: a grid of equal compartments across the opening, the walls
 * from the floor up to `topGap` below the rim, following the inside's outline (round corners, an oval) — one solid.
 * The grid lines up with the opening's longest straight edge (none: the world X axis).
 */
export function boxDividers(box: Solid, o: BoxDividers): Solid {
  const rim = boxRim(box);
  if (!rim) throw new Error("this solid has no open top (a flat rim round an opening) — make it with Box from Face or Shell");
  const columns = Math.round(o.columns), rows = Math.round(o.rows);
  if (!(columns >= 1 && rows >= 1)) throw new Error("columns and rows must be 1 or more");
  if (columns === 1 && rows === 1) throw new Error("1 × 1 is no dividers: set columns or rows to 2 or more");
  if (!(o.wall > 0)) throw new Error("the wall must be thicker than 0");
  if (o.topGap < 0) throw new Error("the top gap can't be below 0");
  const n = norm3(rim.normalAt().toTuple() as V3), top = dot3(rim.center.toTuple() as V3, n);
  const holes = rim.clone().innerWires().map((w) => makeFace(w));
  const opening = holes.reduce((a, f) => (measureArea(f) > measureArea(a) ? f : a));
  // In-plane axes: along the longest straight edge of the opening, else the world X (Y if X is along the normal)
  const lines = opening.edges.filter((e) => e.geomType === "LINE").map((e) => sub3(e.endPoint.toTuple() as V3, e.startPoint.toTuple() as V3));
  const longest = lines.reduce<V3 | null>((a, d) => (!a || dot3(d, d) > dot3(a, a) ? d : a), null);
  const flat = (d: V3): V3 => {
    const k = dot3(d, n);
    return [d[0] - k * n[0], d[1] - k * n[1], d[2] - k * n[2]];
  };
  const dir = longest ?? (Math.abs(n[0]) < 0.9 ? ([1, 0, 0] as V3) : ([0, 1, 0] as V3));
  let u = norm3(flat(dir)), v = norm3(cross3(n, u));
  // Extents of the opening (and the box's depth) in that frame
  const pts = opening.edges.flatMap((e) => [0, 0.25, 0.5, 0.75, 1].map((t) => e.pointAt(t).toTuple() as V3));
  const span = (d: V3, ps: V3[]) => [Math.min(...ps.map((p) => dot3(p, d))), Math.max(...ps.map((p) => dot3(p, d)))];
  let [u0, u1] = span(u, pts), [v0, v1] = span(v, pts);
  if (v1 - v0 > u1 - u0 + 1e-6) [u, v, u0, u1, v0, v1] = [v, neg(u), v0, v1, ...span(neg(u), pts)]; // (columns along the long side)
  const [bottom] = span(n, box.edges.flatMap((e) => [0, 0.5, 1].map((t) => e.pointAt(t).toTuple() as V3)));
  const height = top - o.topGap - bottom;
  if (height <= 1e-6) throw new Error("the top gap is deeper than the box");
  const cellU = (u1 - u0 - (columns - 1) * o.wall) / columns, cellV = (v1 - v0 - (rows - 1) * o.wall) / rows;
  if (cellU <= 1e-6 || cellV <= 1e-6) throw new Error("no room: fewer compartments or thinner walls");
  // A wall: a slab across the whole opening (a little past it), from the box's very bottom up to its top
  const at = (cu: number, cv: number): V3 => [0, 1, 2].map((k) => cu * u[k] + cv * v[k] + bottom * n[k]) as V3;
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2, lenU = u1 - u0 + 2, lenV = v1 - v0 + 2;
  const frame: Frame = { origin: [0, 0, 0], x: u, y: v, z: n };
  const slabs: Solid[] = [];
  for (let i = 1; i < columns; i++) slabs.push(makeBox(frame, at(u0 + i * cellU + (i - 0.5) * o.wall, cv), o.wall, lenV, height));
  for (let j = 1; j < rows; j++) slabs.push(makeBox(frame, at(cu, v0 + j * cellV + (j - 0.5) * o.wall), lenU, o.wall, height));
  // Clipped to the box's empty inside: the opening from the box's bottom to past its rim (no face of it on the rim:
  // the walls' tops would coincide with its top), the box taken out
  const shaft = basicFaceExtrusion(opening.clone().translate([0, 1, 2].map((k) => (bottom - top) * n[k]) as V3) as Face, new Vector([0, 1, 2].map((k) => (top + 1 - bottom) * n[k]) as V3)) as Shape3D;
  const inside = booleanOp("subtract", shaft, [box]);
  const grid = slabs.length > 1 ? booleanOp("union", slabs[0], slabs.slice(1)) : slabs[0];
  // (OpenCascade fails some of these on a scaled oval's inside — the walls up to the rim, or meeting its seam — or
  // returns a wrong solid: checked by its volume)
  const fail = "Dividers: OpenCascade can't join the walls to this box's curved inside — try a gap below the rim, or other columns / rows";
  let out: Solid;
  try {
    const walls = booleanOp("intersect", grid, [inside]);
    out = booleanOp("union", box, [walls]);
    if (Math.abs(measureVolume(out) - measureVolume(box) - measureVolume(walls)) > 1e-4 * Math.max(1, measureVolume(walls))) throw new Error(fail);
  } catch {
    throw new Error(fail);
  }
  if (!isValidShape(out)) throw new Error("Dividers: the result is not a valid solid");
  return out;
}

/**
 * The band between a flat face's outline and its offset outline (see offsetFace): the larger
 * face with the smaller cut out. Holes get their own bands, so the result can be several faces.
 */
export function offsetRing(shape: Shape, faceId: number, distance: number, round = false): Face[] {
  const face = findFace(shape, faceId)!;
  const offset = offsetFace(shape, faceId, distance, round);
  const [big, small] = distance > 0 ? [offset, face] : [face, offset];
  const faces = boolean("cut", big as unknown as Shape3D, small as unknown as Shape3D).faces;
  if (!faces.length) throw new Error("Offset: the ring is empty at this distance");
  if (faces.some((f) => !isValidShape(f))) throw new Error("Offset: the ring is not a valid face");
  return faces;
}

function offsetPlanar(face: Face, distance: number, round: boolean): Face {
  const join = round ? oc.GeomAbs_JoinType.GeomAbs_Arc : oc.GeomAbs_JoinType.GeomAbs_Intersection;
  const mk = new oc.BRepOffsetAPI_MakeOffset(face.wrapped, join, false);
  mk.Perform(distance, 0);
  const done = mk.IsDone();
  const result = done ? mk.Shape() : null;
  mk.delete();
  const wires = result ? [...iterTopo(result, "wire")].map((w) => cast(w) as Wire) : [];
  if (!wires.length) throw new Error("Offset: the face vanishes at this distance");
  // Outer boundary = the wire with the largest bounding box; the rest are holes.
  const size = (w: Wire) => {
    const b = w.boundingBox;
    return b.width * b.height + b.height * b.depth + b.depth * b.width;
  };
  wires.sort((a, b) => size(b) - size(a));
  let out = makeFace(wires[0], wires.slice(1));
  const n0 = face.normalAt(face.center).toTuple();
  const n1 = out.normalAt(out.center).toTuple();
  if (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] < 0) out = out.flipOrientation();
  if (!isValidShape(out)) throw new Error("Offset: the result is not a valid face");
  return out;
}

/** Flat faces that contain every one of the given edges (candidate planes for an edge offset). */
export function edgeOffsetFaces(shape: Shape, edgeIds: number[]): number[] {
  return shape.faces
    .filter((f) => f.geomType === "PLANE" && edgeIds.every((id) => f.edges.some((e) => e.hashCode === id)))
    .map((f) => f.hashCode);
}

/**
 * One chain of straight edges on a face: its points and per-segment outward (away from the face)
 * directions. A closed chain has as many segments as points (the last one wraps to the first).
 */
interface EdgeChain {
  pts: V3[];
  outs: V3[];
  closed: boolean;
}

function edgeChains(shape: Shape, edgeIds: number[], faceId: number): EdgeChain[] {
  const face = findFace(shape, faceId);
  if (!face || face.geomType !== "PLANE") throw new Error("Offset: the edges must lie on a flat face");
  const n = norm3(face.normalAt(face.center).toTuple() as V3);
  const edges = face.edges.filter((e) => edgeIds.includes(e.hashCode));
  if (edges.length !== edgeIds.length) throw new Error("Offset: the edges must lie on one flat face");
  if (edges.some((e) => e.geomType !== "LINE")) throw new Error("Offset: select straight edges (lines) only");
  const bb = face.boundingBox;
  const eps = 1e-3 * Math.max(bb.width, bb.height, bb.depth, 1);
  // Outward = in the face plane, perpendicular to the segment, on the side where the face is not.
  const outward = (a: V3, b: V3): V3 => {
    const o = norm3(cross3(sub3(b, a), n));
    const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const probe = makeVertex(add3(mid, [o[0] * eps, o[1] * eps, o[2] * eps]));
    return measureDistanceBetween(face, probe) < eps / 10 ? [-o[0], -o[1], -o[2]] : o;
  };
  // Chain the segments end to end.
  const segs = edges.map((e) => [e.startPoint.toTuple() as V3, e.endPoint.toTuple() as V3]);
  const count = new Map<string, number>();
  for (const [a, b] of segs) for (const p of [a, b]) count.set(ptKey(p), (count.get(ptKey(p)) ?? 0) + 1);
  if ([...count.values()].some((c) => c > 2)) throw new Error("Offset: the edges branch — select a simple chain");
  const chains: EdgeChain[] = [];
  while (segs.length) {
    // Start from a free end so an open chain is walked in one direction; no free end = closed loop.
    let i = segs.findIndex(([a, b]) => count.get(ptKey(a)) === 1 || count.get(ptKey(b)) === 1);
    if (i < 0) i = 0;
    const [s0, s1] = segs.splice(i, 1)[0];
    const pts: V3[] = count.get(ptKey(s0)) === 1 ? [s0, s1] : [s1, s0];
    for (;;) {
      const end = ptKey(pts[pts.length - 1]);
      i = segs.findIndex(([a, b]) => ptKey(a) === end || ptKey(b) === end);
      if (i < 0) break;
      const [a, b] = segs.splice(i, 1)[0];
      pts.push(ptKey(a) === end ? b : a);
    }
    const closed = pts.length > 3 && ptKey(pts[0]) === ptKey(pts[pts.length - 1]);
    if (closed) pts.pop();
    const segCount = closed ? pts.length : pts.length - 1;
    chains.push({ pts, closed, outs: Array.from({ length: segCount }, (_, k) => outward(pts[k], pts[(k + 1) % pts.length])) });
  }
  return chains;
}

/**
 * New flat strips in the plane of `faceId`, centred on the selected straight edges and
 * reaching `distance` to each side. Connected edges give one strip with mitred corners;
 * a closed loop gives a ring (a face with a hole).
 */
export function offsetEdges(shape: Shape, edgeIds: number[], faceId: number, distance: number): Face[] {
  if (distance <= 1e-9) throw new Error("distance must be greater than 0");
  const n = norm3(findFace(shape, faceId)!.normalAt().toTuple() as V3);
  return edgeChains(shape, edgeIds, faceId).map(({ pts, outs, closed }) => {
    const shift = (d: number) => pts.map((p, k) => {
      let m: V3;
      if (!closed && k === 0) m = outs[0];
      else if (!closed && k === pts.length - 1) m = outs[outs.length - 1];
      else {
        const a = outs[(k - 1 + outs.length) % outs.length], b = outs[k];
        const c = 1 + dot3(a, b);
        if (c < 1e-6) throw new Error("Offset: the edges fold back on themselves");
        m = [(a[0] + b[0]) / c, (a[1] + b[1]) / c, (a[2] + b[2]) / c]; // mitre: m·a = m·b = 1
      }
      return add3(p, [m[0] * d, m[1] * d, m[2] * d]);
    });
    let f: Face;
    if (closed) {
      // Ring: the larger offset loop is the outline, the smaller one the hole.
      let [outer, inner] = [shift(distance), shift(-distance)];
      // Too large a distance turns segments of the hole around (or squashes them to nothing).
      const keepsDirection = (q: V3[]) => q.every((p, k) => dot3(sub3(q[(k + 1) % q.length], p), sub3(pts[(k + 1) % pts.length], pts[k])) > 1e-9);
      if (!keepsDirection(outer) || !keepsDirection(inner)) throw new Error("Offset: the distance is too large — the ring's hole vanishes");
      if (Math.hypot(...newell(inner)) > Math.hypot(...newell(outer))) [outer, inner] = [inner, outer];
      if (dot3(newell(inner), newell(outer)) > 0) inner.reverse(); // hole wire runs opposite to the outline
      f = makeFace(polyWire(outer), [polyWire(inner)]);
    } else {
      f = makeFace(polyWire([...shift(distance), ...shift(-distance).reverse()]));
    }
    if (dot3(f.normalAt().toTuple() as V3, n) < 0) f = f.flipOrientation();
    if (!isValidShape(f)) throw new Error("Offset: the result is not a valid face (distance too large?)");
    return f;
  });
}

/** Drag axis for an edge offset: from the middle of the first selected edge, outward. */
export function offsetEdgesAxis(shape: Shape, edgeIds: number[], faceId: number): { origin: V3; dir: V3 } | null {
  try {
    const { pts, outs } = edgeChains(shape, edgeIds, faceId)[0];
    const [a, b] = pts;
    return { origin: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], dir: outs[0] };
  } catch {
    return null;
  }
}

/** Drag axis for Offset: from the face's outline (on the +x side of its frame) outward along x. */
export function offsetDragAxis(shape: Shape, faceId: number): { origin: V3; dir: V3 } | null {
  const face = findFace(shape, faceId);
  const frame = planarFaceFrame(shape, faceId);
  if (!face || !frame) return null;
  const c = face.center.toTuple() as V3;
  let reach = 0;
  for (const e of face.edges) {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const p = e.pointAt(t).toTuple();
      reach = Math.max(reach, (p[0] - c[0]) * frame.x[0] + (p[1] - c[1]) * frame.x[1] + (p[2] - c[2]) * frame.x[2]);
    }
  }
  const x = frame.x;
  return { origin: [c[0] + x[0] * reach, c[1] + x[1] * reach, c[2] + x[2] * reach], dir: x };
}

// ---------------------------------------------------------------- revolve / sweep

/** A line in space (e.g. a revolve axis): through `origin` along `dir`. */
export interface Axis {
  origin: V3;
  dir: V3;
}

/** Points along a face's outline (each edge sampled), for side tests. */
function outlinePoints(face: Face): V3[] {
  return face.edges.flatMap((e) => [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1].map((t) => e.pointAt(t).toTuple() as V3));
}

/**
 * A flat face that can be pulled to a point (cone / pyramid): a full circle, or straight edges only, with no
 * holes. Its centre (the circle's, else the area's middle), outward normal and outline: the circle, or the
 * corners in order round the face. Null for any other face.
 */
export function pointCenter(shape: Shape, faceId: number): { center: V3; normal: V3; circle?: number; corners?: V3[] } | null {
  const face = findFace(shape, faceId);
  if (!face || face.geomType !== "PLANE" || face.clone().innerWires().length) return null;
  const normal = norm3(face.normalAt().toTuple() as V3), edges = face.clone().outerWire().edges;
  if (edges.length === 1 && edges[0].geomType === "CIRCLE") {
    const c = circleOfEdge(shape, edges[0].hashCode);
    return c && Math.hypot(...sub3(edges[0].startPoint.toTuple() as V3, edges[0].endPoint.toTuple() as V3)) < 1e-7 ? { center: c.center, normal, circle: c.r } : null;
  }
  if (edges.length < 3 || edges.some((e) => e.geomType !== "LINE")) return null;
  // (the corners in order: each edge starts where the last one ended)
  const near = (p: V3, q: V3) => Math.hypot(...sub3(p, q)) < 1e-6;
  const ends = edges.map((e) => [e.startPoint.toTuple() as V3, e.endPoint.toTuple() as V3]);
  const corners: V3[] = [ends[0][0]];
  let at = ends[0][1];
  const left = ends.slice(1);
  while (left.length) {
    const k = left.findIndex(([a, b]) => near(a, at) || near(b, at));
    if (k < 0) return null;
    const [a, b] = left.splice(k, 1)[0];
    corners.push(at);
    at = near(a, at) ? b : a;
  }
  return { center: face.center.toTuple() as V3, normal, corners };
}

/**
 * The solid between a flat face (see pointCenter) and a point `h` out along its normal from its centre: a cone
 * (a circle) or a pyramid (straight edges). `top` > 0 (× the face's size) ends it there in a flat top instead —
 * over 1 it widens (e.g. a planter flaring out).
 */
export function pullToPoint(shape: Shape, faceId: number, h: number, top = 0): Solid {
  const p = pointCenter(shape, faceId);
  if (!p) throw new Error("Pull to a point: only a flat circle or a flat face with straight edges (no holes)");
  if (Math.abs(h) < 1e-9) throw new Error("height must not be 0");
  if (!(top >= 0)) throw new Error("top size must be 0 or more");
  if (p.circle) {
    const z = p.normal, ref: V3 = Math.abs(z[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
    return makeCone({ origin: p.center, x: norm3(cross3(ref, z)), y: [0, 0, 0], z }, p.center, p.circle, p.circle * top, h);
  }
  const P = p.corners!, n = P.length;
  const T = P.map((q) => [0, 1, 2].map((k) => p.center[k] + h * p.normal[k] + top * (q[k] - p.center[k])) as V3);
  const faces = [makeFace(polyWire(P))];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push(makeFace(polyWire(top > 0 ? [P[i], P[j], T[j], T[i]] : [P[i], P[j], T[i]])));
  }
  if (top > 0) faces.push(makeFace(polyWire(T)));
  const solid = makeSolid(faces).simplify() as Solid;
  if (!isValidShape(solid) || Math.abs(solidVolume(solid)) < 1e-9) throw new Error("Pull to a point: the result is not a valid solid");
  return solid;
}

/**
 * A sharp tip of a solid, to round: a cone's apex, or a corner where flat faces meet at less than 90° each (a
 * pyramid's point — not a box corner). `axis`: unit, from the tip into the solid; `half`: the angle (radians) from it
 * to the widest edge / the cone's side; `reach`: how far (along the axis) the tip's faces go before anything else.
 */
export interface Tip {
  at: V3;
  axis: V3;
  half: number;
  reach: number;
  cone: boolean;
}

const tipCache = new WeakMap<object, Tip[]>();

/** The solid's sharp tips (outward ones only: a pocket's deepest point isn't one), see Tip. */
export function solidTips(shape: Shape): Tip[] {
  const cached = tipCache.get(shape);
  if (cached) return cached;
  const tips: Tip[] = [];
  const near = (p: V3, q: V3) => Math.hypot(...sub3(p, q)) < 1e-6;
  const ends = shape.edges.map((e) => ({ e, a: e.startPoint.toTuple() as V3, b: e.endPoint.toTuple() as V3 }));
  // Cone apexes: a CONE face whose apex is one of the solid's corners, the solid inside it
  for (const f of shape.faces) {
    if (f.geomType !== "CONE") continue;
    let apex: V3, dir: V3, semi: number;
    const s = coneOf(f), ax = s.Position(), loc = ax.Location(), d = ax.Direction();
    try {
      semi = Math.abs(s.SemiAngle());
      dir = [d.X(), d.Y(), d.Z()];
      const R = s.RefRadius(), t = R / Math.tan(s.SemiAngle());
      apex = [loc.X() - t * dir[0], loc.Y() - t * dir[1], loc.Z() - t * dir[2]];
    } finally {
      for (const o of [d, loc, ax, s]) o.delete();
    }
    if (!ends.some(({ a, b }) => near(a, apex) || near(b, apex))) continue;
    const q = f.pointOnSurface(0.5, 0.5).toTuple() as V3, along = dot3(sub3(q, apex), dir);
    const axis: V3 = along >= 0 ? dir : neg(dir);
    const radial = sub3(sub3(q, apex), axis.map((v) => v * Math.abs(along)) as V3);
    if (dot3(normalAtUV(f, 0.5, 0.5), radial) <= 0) continue; // (a cone-shaped hole's bottom)
    const reach = Math.max(...outlinePoints(f).map((p) => dot3(sub3(p, apex), axis))); // (where the cone's side ends)
    if (reach > 1e-6 && !tips.some((t) => near(t.at, apex))) tips.push({ at: apex, axis, half: semi, reach, cone: true });
  }
  // Pointed corners where flat faces meet
  const corners: V3[] = [];
  for (const { a, b } of ends) for (const p of [a, b]) if (!corners.some((c) => near(c, p))) corners.push(p);
  const faceEdges = shape.faces.map((f) => ({ f, ids: new Set(f.edges.map((e) => e.hashCode)) }));
  for (const P of corners) {
    if (tips.some((t) => near(t.at, P))) continue;
    const at = ends.filter(({ a, b }) => near(a, P) || near(b, P));
    if (at.length < 3 || at.some(({ e }) => e.geomType !== "LINE")) continue;
    const dirs = at.map(({ a, b }) => norm3(near(a, P) ? sub3(b, P) : sub3(a, P)));
    const faces = faceEdges.filter(({ ids }) => at.some((x) => ids.has(x.e.hashCode)));
    if (faces.some(({ f }) => f.geomType !== "PLANE")) continue;
    // Each face's angle at the corner under 90° (not a box corner), and every edge behind every face (pointing out)
    let sharp = true;
    for (const { f, ids } of faces) {
      const mine = at.filter((x) => ids.has(x.e.hashCode)).map((x) => dirs[at.indexOf(x)]);
      const n = norm3(f.normalAt().toTuple() as V3);
      if (mine.length !== 2 || dot3(mine[0], mine[1]) < Math.cos((89 * Math.PI) / 180) || dirs.some((d) => dot3(n, d) > 1e-7)) sharp = false;
    }
    if (!sharp) continue;
    const axis = norm3(dirs.reduce((s, d) => [s[0] + d[0], s[1] + d[1], s[2] + d[2]] as V3, [0, 0, 0] as V3));
    const half = Math.max(...dirs.map((d) => Math.acos(Math.min(1, dot3(d, axis)))));
    const reach = Math.min(...at.map(({ a, b }) => dot3(sub3(near(a, P) ? b : a, P), axis)));
    if (half < (80 * Math.PI) / 180 && reach > 1e-6) tips.push({ at: P, axis, half, reach, cone: false });
  }
  tipCache.set(shape, tips);
  return tips;
}

/** The largest radius roundTip takes for this tip (its ball must end before the tip's faces do). */
export function tipRadiusMax(tip: Tip): number {
  return (tip.reach * Math.sin(tip.half)) / Math.cos(tip.half) ** 2;
}

/**
 * Round a tip (see solidTips) with a ball of radius `r`: for a cone, a sphere cap meeting the side smoothly; for a
 * pyramid, the tip cut down to a sphere touching its edges (smooth along the edges, a slight crease on the faces).
 */
export function roundTip(shape: Solid, tip: Tip, r: number): Solid {
  if (!(r > 0)) throw new Error("radius must be > 0");
  const max = tipRadiusMax(tip);
  if (r >= max * (1 - 1e-6)) throw new Error(`Round tip: ${+r.toFixed(3)} mm is too big for this tip — under ${+max.toFixed(2)} mm`);
  const { at: A, axis: u, half: g } = tip;
  const D = r / Math.sin(g), xt = (r * Math.cos(g) ** 2) / Math.sin(g), rt = r * Math.cos(g);
  const along = (x: number): V3 => [A[0] + x * u[0], A[1] + x * u[1], A[2] + x * u[2]];
  // The tip's end up to where the ball touches its side / edges (a little wider, from a little beyond the point)
  const tool = occCylinder(rt * 1.05 + 1e-3, xt + r, along(-r), u) as Solid;
  const cap = boolean("common", makeSphereAt(along(D), r), tool);
  const rest = boolean("cut", shape, tool);
  const out = boolean("fuse", rest, tip.cone ? cap : boolean("common", shape, cap)).simplify() as Solid;
  if (!isValidShape(out) || solidVolume(out) <= 1e-9) throw new Error("Round tip: the result is not a valid solid");
  return out;
}

/** The straight edges of a flat face (their ends), e.g. as revolve axes. */
export function faceLineEdges(shape: Shape, faceId: number): [V3, V3][] {
  const face = findFace(shape, faceId);
  return face ? face.edges.filter((e) => e.geomType === "LINE").map((e) => [e.startPoint.toTuple() as V3, e.endPoint.toTuple() as V3]) : [];
}

/**
 * Why a flat face cannot turn about `axis`, or null if it can: the axis must not be square to the
 * face, and if it runs along the face's plane it must keep to one side of it (along an edge is fine).
 */
export function revolveRefusal(shape: Shape, faceId: number, axis: Axis): string | null {
  const face = findFace(shape, faceId);
  if (!face || face.geomType !== "PLANE") return "Revolve works on flat faces only";
  const n = norm3(face.normalAt().toTuple() as V3), d = norm3(axis.dir);
  if (Math.abs(dot3(n, d)) > 1 - 1e-6) return "Revolve: the axis is square to the face — pick one along it";
  if (Math.abs(dot3(n, d)) < 1e-6) {
    const pts = outlinePoints(face), side = norm3(cross3(n, d));
    const s = pts.map((p) => dot3(sub3(p, axis.origin), side));
    const tol = 1e-6 * Math.max(1, ...s.map(Math.abs));
    if (Math.min(...s) < -tol && Math.max(...s) > tol) return "Revolve: the axis runs through the face — pick one beside it (or along an edge)";
  }
  return null;
}

/** A flat face turned `angleDeg` (360 = a full turn; negative = the other way) about `axis` into a new solid. */
export function revolveFace(shape: Shape, faceId: number, axis: Axis, angleDeg: number): Solid {
  const why = revolveRefusal(shape, faceId, axis);
  if (why) throw new Error(why);
  if (Math.abs(angleDeg) < 1e-6) throw new Error("angle must not be 0");
  const solid = revolution(findFace(shape, faceId)!, axis.origin, norm3(axis.dir), Math.max(-360, Math.min(360, angleDeg)));
  if (!isValidShape(solid) || solidVolume(solid) <= 1e-9) throw new Error("Revolve: the result is not a valid solid");
  return solid;
}

/** The ends of an open path: each end point with the path's direction there, pointing into the path. Empty if closed. */
export function pathEnds(path: Wire): { point: V3; dir: V3 }[] {
  const ends = path.edges.flatMap((e) => [
    { point: e.startPoint.toTuple() as V3, dir: norm3(e.tangentAt(0).toTuple() as V3) },
    { point: e.endPoint.toTuple() as V3, dir: norm3(e.tangentAt(1).toTuple().map((v) => -v) as V3) },
  ]);
  const near = (p: V3, q: V3) => Math.hypot(...sub3(p, q)) < 1e-6;
  return ends.filter((a) => ends.filter((b) => near(a.point, b.point)).length === 1);
}

/** The end of `path` nearest the centre of a flat face, or null for a closed path. */
function nearestEnd(face: Face, path: Wire): { point: V3; dir: V3 } | null {
  const c = face.center.toTuple() as V3;
  const dist = (e: { point: V3 }) => Math.hypot(...sub3(e.point, c));
  return pathEnds(path).sort((a, b) => dist(a) - dist(b))[0] ?? null;
}

/**
 * Whether a flat face already sits at an end of the path, as a profile to sweep where it is: that
 * end lies on the face's plane, within its outline's reach, and the path leaves the plane there.
 */
export function profileOnPath(shape: Shape, faceId: number, path: Wire): boolean {
  const face = findFace(shape, faceId);
  const end = face && nearestEnd(face, path);
  if (!face || !end) return false;
  const n = norm3(face.normalAt().toTuple() as V3), c = face.center.toTuple() as V3;
  const reach = Math.max(...outlinePoints(face).map((p) => Math.hypot(...sub3(p, c))));
  return Math.abs(dot3(n, sub3(end.point, c))) < 1e-4 && Math.hypot(...sub3(end.point, c)) <= reach + 1e-6 && Math.abs(dot3(n, end.dir)) > 0.2;
}

/** Sweep a closed outline with its holes along `path` (holes swept the same way and cut out). */
/** How far (mm) the arcs a sweep runs along may stray from a freeform path (see arcSpine). */
const ARC_SPINE_TOL = 0.01;

/**
 * A path for sweeping along: its freeform curves (a sketch Spline, a stretched arc…) as arcs end to end that meet
 * smoothly (pairs of arcs fitted between points on the curve, halved until within ARC_SPINE_TOL of it); lines and
 * circle arcs stay. Swept along arcs / lines, a profile gives exact tori / cylinders / planes — light to mesh and to
 * read for a slicer — where along the curve itself OpenCascade builds one dense approximated surface (a 3 mm tube
 * along a 24-piece Spline: 400 000+ triangles to show, a STEP file that freezes Bambu Studio at its best quality).
 * The path as it is when a curve isn't flat (no plane to fit arcs in).
 */
function arcSpine(path: Wire): Wire {
  if (path.edges.every((e) => e.geomType === "LINE" || e.geomType === "CIRCLE")) return path;
  const edges: Edge[] = [];
  for (const e of path.edges) {
    if (e.geomType === "LINE" || e.geomType === "CIRCLE") {
      edges.push(e);
      continue;
    }
    const arcs = biarcs(e);
    if (!arcs) return path;
    edges.push(...arcs);
  }
  return assembleWire(edges);
}

/** A flat freeform edge as arcs / lines end to end (see arcSpine); null if it isn't flat or won't fit. */
function biarcs(e: Edge): Edge[] | null {
  const at = (t: number) => e.pointAt(t).toTuple() as V3, tan = (t: number) => norm3(e.tangentAt(t).toTuple() as V3);
  // Its plane: the normal from the turning of its tangent (a straight edge would be a LINE already)
  const samples = Array.from({ length: 33 }, (_, i) => i / 32);
  const pts = samples.map(at);
  let nrm: V3 | null = null;
  for (let i = 1; i < pts.length - 1 && !nrm; i++) {
    const c = cross3(sub3(pts[i], pts[0]), sub3(pts[pts.length - 1], pts[0]));
    if (Math.hypot(...c) > 1e-9) nrm = norm3(c);
  }
  if (!nrm || pts.some((p) => Math.abs(dot3(sub3(p, pts[0]), nrm!)) > 1e-6)) return null;
  const N = nrm;
  const out: Edge[] = [];
  /** An arc from A leaving along T, to B (a line when B is straight ahead), and how far `q` lies off it. */
  const arc = (A: V3, T: V3, B: V3): { edge: () => Edge; off: (q: V3) => number } => {
    const d = sub3(B, A), side = cross3(N, T), k = dot3(d, side), L2 = dot3(d, d);
    if (Math.abs(k) < 1e-9 * Math.sqrt(L2)) {
      const u = norm3(d);
      return { edge: () => makeLine(A, B), off: (q) => Math.hypot(...cross3(sub3(q, A), u)) };
    }
    const r = L2 / (2 * k), C: V3 = [0, 1, 2].map((i) => A[i] + side[i] * r) as V3, R = Math.abs(r);
    // (its middle: on the side of the chord the arc bulges to — beyond it for more than a half turn)
    const mid: V3 = [0, 1, 2].map((i) => (A[i] + B[i]) / 2) as V3, toMid = sub3(mid, C), lm = Math.hypot(...toMid);
    const dir = lm > 1e-12 ? norm3(toMid) : norm3(cross3(N, d));
    const M: V3 = [0, 1, 2].map((i) => C[i] + dir[i] * R * (dot3(d, T) >= 0 ? 1 : -1)) as V3;
    return { edge: () => makeThreePointArc(A, M, B), off: (q) => Math.abs(Math.hypot(...sub3(q, C)) - R) };
  };
  const fit = (t0: number, t1: number, depth: number): boolean => {
    const P0 = at(t0), P1 = at(t1), T0 = tan(t0), T1 = tan(t1);
    const v = sub3(P1, P0), t = [T0[0] + T1[0], T0[1] + T1[1], T0[2] + T1[2]] as V3, kk = dot3(T0, T1), vt = dot3(v, t), vv = dot3(v, v);
    // Two arcs, as long as each other's tangent run d: P0 → J → P1 (J halfway between P0 + d·T0 and P1 − d·T1)
    const d = 1 - kk < 1e-12 ? vv / (2 * vt) : (-vt + Math.sqrt(vt * vt + 2 * (1 - kk) * vv)) / (2 * (1 - kk));
    if (Number.isFinite(d) && d > 0) {
      const J: V3 = [0, 1, 2].map((i) => (P0[i] + d * T0[i] + P1[i] - d * T1[i]) / 2) as V3;
      const a1 = arc(P0, T0, J), a2 = arc(P1, [-T1[0], -T1[1], -T1[2]], J);
      // (the curve's points between: each against the arc on its side of J)
      const ok = Array.from({ length: 9 }, (_, i) => t0 + ((t1 - t0) * (i + 1)) / 10).every((tm) => {
        const q = at(tm);
        return Math.min(a1.off(q), a2.off(q)) <= ARC_SPINE_TOL;
      });
      if (ok || depth >= 12) {
        out.push(a1.edge(), a2.edge()); // (the 2nd runs P1 → J: the wire takes edges either way round)
        return true;
      }
    } else if (depth >= 12) return false;
    const tm = (t0 + t1) / 2;
    return fit(t0, tm, depth + 1) && fit(tm, t1, depth + 1);
  };
  return fit(0, 1, 0) ? out : null;
}

function sweepLoops(outer: Wire, holes: Wire[], spine: Wire, round: boolean): Solid {
  const path = arcSpine(spine);
  const sweep = (w: Wire) => genericSweep(w, path, { transitionMode: round ? "round" : "right" });
  let solid = sweep(outer);
  if (holes.length) solid = boolean("cut", solid, holes.map(sweep));
  if (!isValidShape(solid) || solidVolume(solid) <= 1e-9) throw new Error("Sweep: the result is not a valid solid — the profile may be too big for the path's bends");
  return solid;
}

/**
 * A flat face swept along an open path into a new solid. `toPath`: the face is first moved so its
 * centre sits on the path's end nearest it, turned square to the path there and then `turnDeg` about
 * the path; otherwise it is swept where it is. `round`: round corners where the path turns sharply (else mitred).
 * `scale`: the profile's size (1 = as drawn), about the path's end it starts from. A straight path only:
 * `twistDeg` turns the profile that much about the path by its far end (+ = the way `turnDeg` turns it), `endScale`
 * its size there (× scale) — both evenly along the way.
 */
export function sweepFace(shape: Shape, faceId: number, path: Wire, toPath: boolean, round: boolean, turnDeg = 0, scale = 1, twistDeg = 0, endScale = 1): Solid {
  let face = findFace(shape, faceId);
  if (!face || face.geomType !== "PLANE") throw new Error("Sweep: the profile must be a flat face");
  if (!pathEnds(path).length) throw new Error("Sweep: the path must be open (it has no ends)");
  if (toPath) {
    const end = nearestEnd(face, path)!, c = face.center.toTuple() as V3, n = norm3(face.normalAt().toTuple() as V3);
    const ax = cross3(n, end.dir), s = Math.hypot(...ax);
    if (s > 1e-9) face = rotateShape(face, (Math.atan2(s, dot3(n, end.dir)) * 180) / Math.PI, c, ax);
    face = translateShape(face, sub3(end.point, c));
    if (Math.abs(turnDeg) > 1e-9) face = rotateShape(face, turnDeg, end.point, end.dir);
  }
  if (!(scale > 0)) throw new Error("Sweep: Profile size must be more than 0%");
  if (Math.abs(scale - 1) > 1e-9) face = scaleShape(face, [scale, scale, scale], nearestEnd(face, path)!.point);
  if (!(endScale > 0)) throw new Error("Sweep: End size must be more than 0%");
  if (Math.abs(twistDeg) > 1e-9 || Math.abs(endScale - 1) > 1e-9) {
    const start = nearestEnd(face, path)!, end = pathEnds(path).find((e) => Math.hypot(...sub3(e.point, start.point)) > 1e-6);
    const len = end ? Math.hypot(...sub3(end.point, start.point)) : 0;
    if (!end || Math.abs(measureLength(path) - len) > 1e-6 * Math.max(1, len)) throw new Error("Sweep: Twist and End size need a straight path (a line or guide line)");
    return twistedSweep(face.clone().outerWire(), face.clone().innerWires(), start.point, end.point, twistDeg, endScale);
  }
  // outerWire / innerWires delete the face they are called on.
  return sweepLoops(face.clone().outerWire(), face.clone().innerWires(), path, round);
}

/**
 * Loops swept straight from a to b, turning evenly by twistDeg about the line (a helix round it steers the
 * profile, as a twisted extrusion) and growing / shrinking evenly to endScale — exact, one surface per edge.
 */
function twistedSweep(outer: Wire, holes: Wire[], a: V3, b: V3, twistDeg: number, endScale: number): Solid {
  const d = sub3(b, a), len = Math.hypot(...d);
  const sweep = (w: Wire) => {
    const spine = assembleWire([makeLine(a, b)]);
    const aux = Math.abs(twistDeg) > 1e-9 ? makeHelix((360 / twistDeg) * len, len, 1, a, d) : undefined;
    let law: unknown = null;
    if (Math.abs(endScale - 1) > 1e-9) {
      const lin = new oc.Law_Linear();
      lin.Set(0, 1, len, endScale);
      law = lin.Trim(0, len, 1e-6);
    }
    return genericSweep(w, spine, { auxiliarySpine: aux, law: law as never }) as Solid;
  };
  let solid = sweep(outer);
  if (holes.length) solid = boolean("cut", solid, holes.map(sweep));
  if (!isValidShape(solid) || solidVolume(solid) <= 1e-9) throw new Error("Sweep: the twisted result is not a valid solid");
  return solid;
}

/** A straight path from `a` to `b` (e.g. a guide line to sweep along). */
export function lineWire(a: V3, b: V3): Wire {
  return assembleWire([makeLine(a, b)]);
}

/**
 * Normal of the cut plane for a guide line a–b. The plane holds the guide and runs straight
 * across a flat face (of `shapes`) that the guide lies on (touching it, not just in its plane), so a
 * diagonal guide on a side face slices straight across. A guide on no flat face (e.g. across a
 * sphere) keeps its `stored` normal, else gives the plane through the guide and the viewing
 * direction `view`, i.e. along the line as seen on screen; without a usable view direction,
 * through the guide and the vertical. A `stored` normal also wins when it runs straight across
 * one of the faces the guide lies on (a guide along an edge between two faces keeps its choice);
 * otherwise the face does, so a guide drawn in space and moved onto a face cuts straight across it.
 * Off any flat face, a guide along X / Y / Z cuts on the nearest world plane (the camera angle it was
 * drawn at is noise: a Z guide drawn in the iso view would otherwise cut the corner off a box).
 * The normal is oriented upward (or toward +x / +y for vertical planes).
 */
export function guidePlaneNormal(shapes: Shape[], a: V3, b: V3, view?: V3, stored?: V3): V3 {
  const dir = sub3(b, a);
  if (Math.hypot(...dir) < 1e-9) throw new Error("Cut: the guide line has no length");
  const u = norm3(dir);
  const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const planeNormal = (across: V3): V3 => {
    // Drop float noise (e.g. from the camera direction) so square-on cuts are exactly level / upright.
    const normal = norm3(norm3(cross3(u, across)).map((k) => (Math.abs(k) < 1e-9 ? 0 : k)) as V3);
    const up = Math.abs(normal[2]) > 1e-9 ? normal[2] : Math.abs(normal[0]) > 1e-9 ? normal[0] : normal[1];
    return up < 0 ? [-normal[0], -normal[1], -normal[2]] : normal;
  };
  // Flat faces the guide lies on, nearest first.
  const onFaces: { n: V3; d: number }[] = [];
  for (const shape of shapes) {
    const [lo, hi] = shape.boundingBox.bounds;
    const tol = 1e-6 * Math.max(1, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]));
    for (const f of shape.faces) {
      if (f.geomType !== "PLANE") continue;
      const n = norm3(f.normalAt().toTuple() as V3);
      const c = f.center.toTuple() as V3;
      if (Math.abs(dot3(sub3(a, c), n)) > tol || Math.abs(dot3(sub3(b, c), n)) > tol) continue;
      if (Math.abs(dot3(n, u)) > 1e-9) continue;
      // On the face itself, not just in its plane (another solid's face far away can share the plane).
      const d = Math.min(...[a, mid, b].map((p) => measureDistanceBetween(f, makeVertex(p))));
      if (d > tol * 100) continue;
      onFaces.push({ n: planeNormal(n), d });
    }
  }
  onFaces.sort((x, y) => x.d - y.d);
  if (stored && onFaces.length) {
    const s = norm3(stored);
    if (onFaces.some(({ n }) => Math.abs(dot3(n, s)) > 1 - 1e-6)) return s;
  }
  if (onFaces.length) return onFaces[0].n;
  const v = view && norm3(view);
  const n = stored ? norm3(stored) : planeNormal(v && Math.abs(dot3(v, u)) < 0.999 ? v : Math.abs(u[2]) > 0.999 ? [1, 0, 0] : [0, 0, 1]);
  const axis = u.findIndex((k) => Math.abs(k) > 1 - 1e-9);
  if (axis < 0) return n;
  // The larger of the normal's two components across the guide picks the world plane.
  const [i, j] = [0, 1, 2].filter((k) => k !== axis);
  const snapped: V3 = [0, 0, 0];
  snapped[Math.abs(n[i]) >= Math.abs(n[j]) ? i : j] = 1;
  return planeNormal(cross3(snapped, u));
}

/** Split a solid by a plane: the part on the `normal` side (above) and the rest (below); null = empty. */
/**
 * A flat face (a drawn rectangle, circle...) cut where a plane crosses it — e.g. the plane through
 * a guide line — into separate faces, largest first. Throws if the plane doesn't cross it.
 */
export function cutFaceByPlane(face: Face, point: V3, normal: V3): Face[] {
  const tmp: { delete(): void }[] = [];
  const keep = <T>(o: T): T => (tmp.push(o as unknown as { delete(): void }), o);
  try {
    const pts = face.edges.flatMap((e) => [0, 0.5, 1].map((t) => e.pointAt(t).toTuple() as V3));
    const R = 2 * Math.max(...pts.map((p) => Math.hypot(...sub3(p, point)))) + 10;
    const pln = keep(new oc.gp_Pln(keep(new oc.gp_Pnt(...point)), keep(new oc.gp_Dir(...norm3(normal)))));
    const sheet = keep(new oc.BRepBuilderAPI_MakeFace(pln, -R, R, -R, R)).Face();
    const split = keep(new oc.BRepAlgoAPI_Splitter());
    const args = keep(new oc.NCollection_List_TopoDS_Shape()), tools = keep(new oc.NCollection_List_TopoDS_Shape());
    args.Append(face.wrapped);
    tools.Append(sheet);
    split.SetArguments(args);
    split.SetTools(tools);
    split.SetNonDestructive(true);
    split.SetFuzzyValue(BOOLEAN_FUZZ);
    split.Build(keep(new oc.Message_ProgressRange()));
    if (split.HasErrors()) throw new Error("Cut: the geometry kernel could not cut the face");
    const pieces = [...iterTopo(split.Shape(), "face")].map((f) => cast(f) as Face);
    if (pieces.length < 2) throw new Error("Cut: the guide's cut plane does not cross the face");
    return pieces.map((f) => ({ f, a: measureArea(f) })).sort((x, y) => y.a - x.a).map(({ f }) => f);
  } finally {
    for (const o of tmp) {
      try {
        o.delete();
      } catch {
        // already owned by OpenCascade
      }
    }
  }
}

/**
 * Split faces of a solid where a plane crosses them (e.g. the plane through a guide line), the
 * solid staying one piece: each face is intersected with the plane and the solid split along those
 * section edges. Works on curved faces too. Returns the solid and the ids of the faces' pieces.
 */
export function splitFacesByPlane(shape: Solid, faceIds: number[], point: V3, normal: V3): { shape: Solid; faces: number[] } {
  const faces = faceIds.map((id) => findFace(shape, id));
  if (faces.some((f) => !f)) throw new Error("face not found");
  const tmp: { delete(): void }[] = [];
  const keep = <T>(o: T): T => (tmp.push(o as unknown as { delete(): void }), o);
  try {
    // A plane face big enough to cross the whole solid.
    const pts = shape.edges.flatMap((e) => [0, 0.5, 1].map((t) => e.pointAt(t).toTuple() as V3));
    const R = 2 * Math.max(...pts.map((p) => Math.hypot(...sub3(p, point)))) + 10;
    const pln = keep(new oc.gp_Pln(keep(new oc.gp_Pnt(...point)), keep(new oc.gp_Dir(...norm3(normal)))));
    const sheet = keep(new oc.BRepBuilderAPI_MakeFace(pln, -R, R, -R, R)).Face();
    const cuts = keep(new oc.NCollection_List_TopoDS_Shape());
    let count = 0;
    for (const f of faces as Face[]) {
      const sec = keep(new oc.BRepAlgoAPI_Section(f.wrapped, sheet, false));
      sec.Approximation(true);
      sec.ComputePCurveOn1(true);
      sec.Build(keep(new oc.Message_ProgressRange()));
      if (!sec.IsDone()) continue;
      for (const e of iterTopo(sec.Shape(), "edge")) {
        cuts.Append(e);
        count++;
      }
    }
    if (!count) throw new Error("Split face: the guide's plane does not cross the selected face(s)");
    const split = keep(new oc.BRepAlgoAPI_Splitter());
    const args = keep(new oc.NCollection_List_TopoDS_Shape());
    args.Append(shape.wrapped);
    split.SetArguments(args);
    split.SetTools(cuts);
    split.SetNonDestructive(true);
    split.SetFuzzyValue(BOOLEAN_FUZZ);
    split.Build(keep(new oc.Message_ProgressRange()));
    if (split.HasErrors()) throw new Error("Split face: the geometry kernel could not split the face(s)");
    const solids = [...iterTopo(split.Shape(), "solid")].map((x) => cast(x) as Solid);
    if (solids.length !== 1) throw new Error("Split face: the geometry kernel could not split the face(s)");
    const out = solids[0];
    if (!isValidShape(out)) throw new Error("Split face: the result is not a valid solid");
    if (out.faces.length <= shape.faces.length) throw new Error("Split face: the guide's plane only touches the selected face(s) — nothing to split");
    // The pieces of the split faces: new faces, except neighbours that only gained a corner point
    // (same kind, area and centre as an untouched original face).
    const sig = (f: Face) => ({ type: f.geomType, area: measureArea(f), c: f.center.toTuple() as V3 });
    const others = shape.faces.filter((g) => !(faces as Face[]).some((f) => f.isSame(g))).map(sig);
    const pieces = out.faces.filter((f) => {
      if (shape.faces.some((g) => g.isSame(f))) return false;
      const a = sig(f);
      return !others.some((o) => o.type === a.type && Math.abs(o.area - a.area) < 1e-6 * Math.max(1, o.area) && Math.hypot(...sub3(o.c, a.c)) < 1e-6 * R);
    });
    return { shape: out, faces: pieces.map((f) => f.hashCode) };
  } finally {
    for (const o of tmp) {
      try {
        o.delete();
      } catch {
        // already owned by OpenCascade
      }
    }
  }
}

export function splitByPlane(shape: Solid, point: V3, normal: V3): { above: Solid | null; below: Solid | null } {
  // One split by the plane, its pieces sorted by side (half the work of the two booleans below:
  // 17 sweeps cut at once took ~2 s); the booleans if the split fails.
  const fast = splitByPlaneOnce(shape, point, normal);
  if (fast) return fast;
  const [lo, hi] = shape.boundingBox.bounds;
  const c: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const R = 2 * (Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + Math.hypot(...sub3(c, point))) + 10;
  const z = norm3(normal);
  const x = norm3(cross3(Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], z));
  const half = makeBox({ origin: point, x, y: cross3(z, x), z }, point, 2 * R, 2 * R, R);
  // (one solid: that solid, not the boolean's compound round it — some operations, e.g. shell, need a solid)
  const part = (s: Shape3D) => {
    const solids = [...iterTopo(s.wrapped, "solid")];
    return solids.length === 1 ? (cast(solids[0]) as Solid) : solids.length ? s : null;
  };
  return { above: part(boolean("common", shape, half)), below: part(boolean("cut", shape, half)) };
}

/** splitByPlane in one Splitter pass; null if the kernel fails (or a piece straddles the plane). */
function splitByPlaneOnce(shape: Solid, point: V3, normal: V3): { above: Solid | null; below: Solid | null } | null {
  const tmp: { delete(): void }[] = [];
  const keep = <T>(o: T): T => (tmp.push(o as unknown as { delete(): void }), o);
  try {
    const [lo, hi] = shape.boundingBox.bounds;
    const c: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    const R = 2 * (Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + Math.hypot(...sub3(c, point))) + 10;
    const n = norm3(normal);
    const pln = keep(new oc.gp_Pln(keep(new oc.gp_Pnt(...point)), keep(new oc.gp_Dir(...n))));
    const sheet = keep(new oc.BRepBuilderAPI_MakeFace(pln, -R, R, -R, R)).Face();
    const split = keep(new oc.BRepAlgoAPI_Splitter());
    const args = keep(new oc.NCollection_List_TopoDS_Shape()), tools = keep(new oc.NCollection_List_TopoDS_Shape());
    args.Append(shape.wrapped);
    tools.Append(sheet);
    split.SetArguments(args);
    split.SetTools(tools);
    split.SetNonDestructive(true);
    split.SetFuzzyValue(BOOLEAN_FUZZ);
    split.Build(keep(new oc.Message_ProgressRange()));
    if (split.HasErrors()) return null;
    // Which side a piece is on: its edge point farthest from the plane (each piece lies on one side;
    // edge middles too — a half cylinder's corners all lie on the plane).
    const tol = 1e-7 * R;
    const above: Solid[] = [], below: Solid[] = [];
    for (const x of iterTopo(split.Shape(), "solid")) {
      const p = cast(x) as Solid;
      const ds = p.edges.flatMap((e) => [0, 0.5, 1].map((t) => dot3(sub3(e.pointAt(t).toTuple() as V3, point), n)));
      const top = Math.max(...ds), bottom = Math.min(...ds);
      if (top > tol && bottom < -tol) return null;
      if (top > tol) above.push(p);
      else if (bottom < -tol) below.push(p);
      else return null;
    }
    const one = (ps: Solid[]) => (ps.length === 1 ? ps[0] : ps.length ? (makeCompound(ps) as unknown as Solid) : null);
    return { above: one(above), below: one(below) };
  } catch {
    return null;
  } finally {
    for (const o of tmp) {
      try {
        o.delete();
      } catch {
        // already owned by OpenCascade
      }
    }
  }
}

/** The separate solids a shape is made of (a union of solids that don't touch has more than one). */
export function solidPieces(shape: Shape): Solid[] {
  return [...iterTopo(shape.wrapped, "solid")].map((s) => cast(s) as Solid);
}

/** Volume of a solid (mm³). */
export function solidVolume(shape: Solid): number {
  return measureVolume(shape);
}

/** True if two shapes touch or overlap (no gap between them). */
export function shapesTouch(a: Shape, b: Shape): boolean {
  return measureDistanceBetween(a, b) < BOOLEAN_FUZZ;
}

export type BooleanOp = "union" | "subtract" | "intersect";

export function booleanOp(op: BooleanOp, target: Solid, tools: Solid[]): Solid {
  // Cut / fuse with all the tools at once: one pass instead of one per tool on an ever more complex
  // result (36 array copies: ~5× faster). Common with several tools would mean "∩ their union", so it
  // stays one at a time, as does anything the single pass fails on.
  if (op !== "intersect" && tools.length > 1) {
    try {
      return boolean(op === "union" ? "fuse" : "cut", target, tools).simplify() as Solid;
    } catch {
      // one tool at a time below
    }
  }
  let result = target;
  for (const tool of tools) {
    result = boolean(op === "union" ? "fuse" : op === "subtract" ? "cut" : "common", result, tool);
  }
  return result.simplify();
}

export function translateShape<T extends Geom>(shape: T, v: V3): T {
  if (isMesh(shape)) return shape.transformed([1, 0, 0, 0, 1, 0, 0, 0, 1], v) as T;
  return noteRigid(shape.clone().translate(v) as T, shape, [1, 0, 0, 0, 1, 0, 0, 0, 1], v);
}

/**
 * Shapes that are another one moved / turned / copied — p ↦ R·p + t (R row-major 3×3): the
 * display reuses that one's triangles instead of meshing again (moving 25 heavy solids would
 * otherwise mesh each one again, seconds per step).
 */
const rigid = new WeakMap<object, { from: Geom; R: number[]; t: V3 }>();

function noteRigid<T extends Geom>(out: T, from: Geom, R: number[], t: V3): T {
  rigid.set(out, { from, R, t });
  return out;
}

/**
 * The shape `shape` is a rigid move of, back along copies / moves to the first one `shown` accepts
 * (one on screen), with the whole move from it to `shape`; null if none.
 */
export function rigidSource(shape: Geom, shown: (s: Geom) => boolean): { from: Geom; R: number[]; t: V3 } | null {
  let R = [1, 0, 0, 0, 1, 0, 0, 0, 1], t: V3 = [0, 0, 0];
  for (let s = shape, k = 0; k < 50; k++) {
    const r = rigid.get(s);
    if (!r) return null;
    // whole = (this step's whole so far) ∘ r: p ↦ R·(r.R·p + r.t) + t
    const M = [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => R[i * 3] * r.R[j] + R[i * 3 + 1] * r.R[3 + j] + R[i * 3 + 2] * r.R[6 + j]));
    t = [0, 1, 2].map((i) => R[i * 3] * r.t[0] + R[i * 3 + 1] * r.t[1] + R[i * 3 + 2] * r.t[2] + t[i]) as V3;
    R = M;
    if (shown(r.from)) return { from: r.from, R, t };
    s = r.from;
  }
  return null;
}

/**
 * Note that `copy` is `from` moved (p ↦ R·p + t), unless it is noted already — e.g. an array's copies read back
 * from a file (checked in place first): they then reuse `from`'s triangles and bounding box.
 */
export function noteMoved(copy: Geom, from: Geom, R: number[], t: V3): void {
  if (copy !== from && !rigid.has(copy)) noteRigid(copy, from, R, t);
}

const boxCache = new WeakMap<object, [V3, V3]>();

/**
 * A shape's bounding box, remembered — a moved copy's from the one it was moved from (`boundingBox` on a curved
 * shape can take tens of ms: an array of 84 swept tubes, seconds).
 */
export function boundsOf(shape: Geom): [V3, V3] {
  const known = boxCache.get(shape);
  if (known) return known;
  const r = rigid.get(shape);
  let box: [V3, V3];
  if (r && !isMesh(r.from) && r.R.every((v, i) => Math.abs(v - (i % 4 === 0 ? 1 : 0)) < 1e-12)) {
    const [a, b] = boundsOf(r.from);
    box = [[a[0] + r.t[0], a[1] + r.t[1], a[2] + r.t[2]], [b[0] + r.t[0], b[1] + r.t[1], b[2] + r.t[2]]];
  } else box = shape.boundingBox.bounds as [V3, V3];
  boxCache.set(shape, box);
  return box;
}

/** Faces' and edges' ids of `from` → those of `to`, a moved copy of it (same order); null if they don't line up. */
export function movedIds(from: Geom, to: Geom): { faces: Map<number, number>; edges: Map<number, number> } | null {
  if (isMesh(from) || isMesh(to)) return null;
  const pair = (a: { hashCode: number }[], b: { hashCode: number }[]) => (a.length === b.length ? new Map(a.map((x, i) => [x.hashCode, b[i].hashCode])) : null);
  const faces = pair(from.faces, to.faces), edges = pair(from.edges, to.edges);
  return faces && edges ? { faces, edges } : null;
}

/**
 * Up to `max` corner points of a shape: its first vertices, in its own order — a moved / turned copy
 * lists the same ones, moved (a mesh: its first triangle corners). Cheap, unlike `boundingBox` on a
 * curved shape (tens of ms the first time); e.g. to check copies are still where an array put them.
 */
export function probePoints(shape: Geom, max = 8): V3[] {
  const out: V3[] = [];
  if (isMesh(shape)) {
    const P = shape.positions;
    for (let i = 0; i + 2 < P.length && out.length < max; i += 3) out.push([P[i], P[i + 1], P[i + 2]]);
    return out;
  }
  const ex = new oc.TopExp_Explorer(shape.wrapped as never, oc.TopAbs_ShapeEnum.TopAbs_VERTEX, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  try {
    for (; ex.More() && out.length < max; ex.Next()) {
      const p = oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(ex.Current()));
      out.push([p.X(), p.Y(), p.Z()]);
      p.delete();
    }
  } finally {
    ex.delete();
  }
  return out;
}

export function rotateShape<T extends Geom>(shape: T, angleDeg: number, center: V3, axis: V3): T {
  if (isMesh(shape)) {
    // Rodrigues' rotation about the axis through `center` (right-handed, like OpenCascade's).
    const [x, y, z] = norm3(axis), a = (angleDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), k = 1 - c;
    const M = [c + x * x * k, x * y * k - z * s, x * z * k + y * s, y * x * k + z * s, c + y * y * k, y * z * k - x * s, z * x * k - y * s, z * y * k + x * s, c + z * z * k];
    const mc = [0, 1, 2].map((r) => M[r * 3] * center[0] + M[r * 3 + 1] * center[1] + M[r * 3 + 2] * center[2]);
    return shape.transformed(M, [center[0] - mc[0], center[1] - mc[1], center[2] - mc[2]]) as T;
  }
  const [x, y, z] = norm3(axis), a = (angleDeg * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a), k = 1 - c;
  const R = [c + x * x * k, x * y * k - z * sn, x * z * k + y * sn, y * x * k + z * sn, c + y * y * k, y * z * k - x * sn, z * x * k - y * sn, z * y * k + x * sn, c + z * z * k];
  const rc = [0, 1, 2].map((r) => R[r * 3] * center[0] + R[r * 3 + 1] * center[1] + R[r * 3 + 2] * center[2]);
  return noteRigid(shape.clone().rotate(angleDeg, center, axis) as T, shape, R, [center[0] - rc[0], center[1] - rc[1], center[2] - rc[2]]);
}

/**
 * Mirror image across the plane through `point` with normal `normal`. Not noted as a rigid move:
 * the display meshes it again (reusing the original's triangles would show them inside out).
 */
export function mirrorShape<T extends Geom>(shape: T, point: V3, normal: V3): T {
  const n = norm3(normal);
  if (isMesh(shape)) {
    // p ↦ (I − 2nnᵀ)·p + 2(n·point)n
    const M = [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => (i === j ? 1 : 0) - 2 * n[i] * n[j]));
    const d = 2 * dot3(n, point);
    return shape.transformed(M, [d * n[0], d * n[1], d * n[2]]) as T;
  }
  return shape.clone().mirror(n, point) as T;
}

/**
 * Scale about `center` by per-axis factors. Equal factors work on any shape; different
 * ones rebuild the shape from its scaled corners, so they need flat faces and straight edges.
 */
/**
 * Per-axis scale of a shape with curved faces. OpenCascade's general-transform builder is not
 * in this build, so each face is rebuilt: flat faces from their stretched outlines; cylinders and
 * cones as exact rational B-splines (arcs around, straight along the axis); spheres, tori and
 * free-form faces converted to B-splines. Stretching B-spline control points along the axes is
 * exact. Edges are stretched the same way and shared between faces, then the faces are repaired
 * (trimming curves, seams, poles) and sewn back into a solid.
 */
function stretchCurved(shape: Shape, f: V3, center: V3, depth = 0): Shape {
  // A face that wraps all the way round its axis (it has a seam) can't be rebuilt reliably
  // (edges lying on the seam are ambiguous): halve the solid through that axis — away from the
  // seam — stretch each half, and fuse them back.
  const wrap = !isFaceShape(shape) && shape.faces.length > 1 ? wrappingAxis(shape) : null;
  let halves: { above: Solid | null; below: Solid | null } | null = null;
  if (wrap && depth < 4) {
    // Cut through the axis, well away from the seam (u = 0); OpenCascade's boolean can fail at
    // particular angles on free-form surfaces, so try a few (none working: rebuild it whole).
    for (const a of [Math.PI / 2 + 0.31, Math.PI / 2, Math.PI / 2 - 0.45, Math.PI / 2 + 0.8, 1.1]) {
      const d: V3 = [0, 1, 2].map((k) => wrap.X[k] * Math.cos(a) + wrap.Y[k] * Math.sin(a)) as V3;
      try {
        halves = splitByPlane(shape as Solid, wrap.O, cross3(wrap.N, d));
        break;
      } catch {
        // try the next angle
      }
    }
  }
  if (wrap && depth < 4 && halves) {
    const { above, below } = halves;
    const parts = [above, below].filter((p): p is Solid => !!p).map((p) => stretchCurved(p, f, center, depth + 1));
    if (parts.length === 1) return parts[0];
    const fused = boolean("fuse", parts[0] as Shape3D, parts[1] as Shape3D);
    if (!isValidShape(fused as Shape)) throw new Error("Per-axis scale: the stretched halves did not join — use the same % for X, Y and Z");
    return fused as Shape;
  }
  const tmp: { delete(): void }[] = [];
  const keep = <T>(o: T): T => (tmp.push(o as unknown as { delete(): void }), o);
  const map = (p: { X(): number; Y(): number; Z(): number }) =>
    keep(new oc.gp_Pnt(center[0] + (p.X() - center[0]) * f[0], center[1] + (p.Y() - center[1]) * f[1], center[2] + (p.Z() - center[2]) * f[2]));
  const fail = (why: string) => new Error(`Per-axis scale: ${why} — use the same % for X, Y and Z`);
  try {
    // Shared vertices / edges, so neighbouring faces stay connected.
    const vertices = new Map<string, unknown>();
    const vertexAt = (p: { X(): number; Y(): number; Z(): number }) => {
      const k = ptKey([p.X(), p.Y(), p.Z()]);
      if (!vertices.has(k)) vertices.set(k, keep(new oc.BRepBuilderAPI_MakeVertex(p as never)).Vertex());
      return { v: vertices.get(k), k };
    };
    // Bucketed by hash, matched with IsSame (hashes can collide).
    type Built = { edge: { Reversed(): never }; a: string; b: string } | null;
    const edges = new Map<number, { src: { IsSame(o: unknown): boolean }; out: Built }[]>();
    const stretchedEdge = (e: { hashCode: number; wrapped: unknown }): Built => {
      const src = e.wrapped as { IsSame(o: unknown): boolean };
      const bucket = edges.get(e.hashCode) ?? [];
      edges.set(e.hashCode, bucket);
      const hit = bucket.find((b) => b.src.IsSame(src));
      if (hit) return hit.out;
      const out = buildEdge(e);
      bucket.push({ src, out });
      return out;
    };
    const buildEdge = (e: { wrapped: unknown }): Built => {
      const c = oc.BRep_Tool.Curve(e.wrapped as never, 0, 0);
      if (!c.returnValue || (c.returnValue as unknown as { IsNull?: () => boolean }).IsNull?.()) return null; // degenerate (a pole): rebuilt by the face repair
      // (Geometry that ends up in the new shape is not freed here.)
      const bs = oc.GeomConvert.CurveToBSplineCurve(keep(new oc.Geom_TrimmedCurve(c.returnValue, c.First, c.Last, true, true)) as never);
      for (let i = 1; i <= bs.NbPoles(); i++) bs.SetPole(i, map(keep(bs.Pole(i))));
      const p0 = vertexAt(keep(bs.Pole(1))), p1 = vertexAt(keep(bs.Pole(bs.NbPoles())));
      // Explicit end parameters: on a closed curve (a full circle) both ends are the same vertex.
      const mk = keep(new oc.BRepBuilderAPI_MakeEdge(bs as never, p0.v as never, p1.v as never, bs.FirstParameter(), bs.LastParameter()));
      if (!mk.IsDone()) throw fail("an edge could not be rebuilt");
      return { edge: mk.Edge() as { Reversed(): never }, a: p0.k, b: p1.k };
    };
    const REVERSED = oc.TopAbs_Orientation.TopAbs_REVERSED;
    // INTERNAL / EXTERNAL wires and edges (leftovers embedded in a face) are not boundaries.
    const bounding = (s: { Orientation(): unknown }) => s.Orientation() === REVERSED || s.Orientation() === oc.TopAbs_Orientation.TopAbs_FORWARD;
    // Every edge use in order (a seam is used twice, once each way), with its orientation.
    const explore = (shape: unknown, kind: "TopAbs_WIRE" | "TopAbs_EDGE") => {
      const out: { Orientation(): unknown; Reversed(): unknown }[] = [];
      const ex = keep(new oc.TopExp_Explorer(shape as never, oc.TopAbs_ShapeEnum[kind], oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
      for (; ex.More(); ex.Next()) out.push(ex.Current() as never);
      return out;
    };
    const wireOf = (w: unknown) => {
      // Oriented edge uses with their start / end vertices, chained end to end (MakeWire only
      // accepts an edge that connects to what it has so far).
      const uses = explore(w, "TopAbs_EDGE").filter(bounding).flatMap((use) => {
        const ne = stretchedEdge(cast(use as never) as unknown as { hashCode: number; wrapped: unknown });
        if (!ne) return [];
        const rev = use.Orientation() === REVERSED;
        return [{ edge: rev ? oc.TopoDS.Edge(ne.edge.Reversed()) : ne.edge, from: rev ? ne.b : ne.a, to: rev ? ne.a : ne.b }];
      });
      if (!uses.length) return null; // only internal edges: not an outline
      const mk = keep(new oc.BRepBuilderAPI_MakeWire());
      let end: string | null = null;
      while (uses.length) {
        let i: number = end === null ? 0 : uses.findIndex((u) => u.from === end);
        if (i < 0) i = 0;
        const u: (typeof uses)[number] = uses.splice(i, 1)[0];
        mk.Add(u.edge as never);
        if (!mk.IsDone()) throw fail("a face outline could not be rebuilt");
        end = u.to;
      }
      return mk.Wire();
    };
    const sewing = keep(new oc.BRepBuilderAPI_Sewing(1e-4, true, true, true, false));
    let lastSurface: unknown = null;
    for (const face of shape.faces) {
      // Outlines as seen on the face's surface (unflipped face); the flip is put back at the end.
      const flipped = (face.wrapped as unknown as { Orientation(): unknown }).Orientation() === REVERSED;
      const fwd = (face.wrapped as unknown as { Oriented(o: unknown): unknown }).Oriented(oc.TopAbs_Orientation.TopAbs_FORWARD);
      const [outer, ...holes] = explore(fwd, "TopAbs_WIRE").filter(bounding).map(wireOf).filter((w) => w !== null);
      let mk;
      if (face.geomType === "PLANE") {
        // The stretched plane: through the stretched origin, normal scaled by 1 / f.
        const ad = keep(new oc.BRepAdaptor_Surface(face.wrapped, true));
        const pos = keep(keep(ad.Plane()).Position());
        const n = keep(pos.Direction());
        const pln = keep(new oc.gp_Pln(map(keep(pos.Location())) as never, keep(new oc.gp_Dir(n.X() / f[0], n.Y() / f[1], n.Z() / f[2]))));
        mk = keep(new oc.BRepBuilderAPI_MakeFace(pln, outer, true));
      } else {
        const surf = stretchedSurface(face, keep, map, shape.faces.length === 1);
        if (!surf) throw fail(`${face.geomType.toLowerCase().replace("cylindre", "cylinder")} faces are not supported`);
        lastSurface = surf;
        if (shape.faces.length > 1 && coversItsRectangle(face)) {
          // The face is its surface's whole (u, v) rectangle (e.g. the wrap-around side of an
          // extruded closed curve): build it from the new surface's own bounds — seam included —
          // with no outline repair; sewing joins it to its neighbours.
          const b = (surf as { Bounds(a: number, b: number, c: number, d: number): { U1: number; U2: number; V1: number; V2: number } }).Bounds(0, 0, 0, 0);
          const nat = keep(new oc.BRepBuilderAPI_MakeFace(surf as never, b.U1, b.U2, b.V1, b.V2, 1e-7));
          if (nat.IsDone()) {
            const nf = nat.Face();
            sewing.Add(flipped ? oc.TopoDS.Face(nf.Reversed()) : nf);
            continue;
          }
        }
        mk = keep(new oc.BRepBuilderAPI_MakeFace(surf as never, outer, true));
      }
      for (const h of holes) mk.Add(h);
      if (!mk.IsDone()) throw fail("a face could not be rebuilt");
      if (face.geomType !== "PLANE") {
        // Trimming curves on the new surface, pole edges, connections — per outline. (ShapeFix_Face
        // would also "fix" outline directions, which are already right here, and flips some wrongly.)
        const raw = mk.Face();
        const fixed = explore(raw, "TopAbs_WIRE").map((w) => {
          const sfw = keep(new oc.ShapeFix_Wire(oc.TopoDS.Wire(w as never), raw, 1e-6));
          sfw.Perform();
          // Perform() skips these when the outline looks unordered in (u, v) — which a missing
          // pole edge makes it — so run them explicitly: shift trimming curves across the seam,
          // add degenerate pole edges, close the remaining gaps.
          sfw.FixShifted();
          sfw.FixDegenerated();
          sfw.FixLacking(true);
          sfw.FixClosed();
          return sfw.Wire();
        });
        mk = keep(new oc.BRepBuilderAPI_MakeFace(lastSurface as never, fixed[0], true));
        for (const w of fixed.slice(1)) mk.Add(w);
        if (!mk.IsDone()) throw fail("a face could not be rebuilt");
      }
      const nf = mk.Face();
      sewing.Add(flipped ? oc.TopoDS.Face(nf.Reversed()) : nf);
    }
    sewing.Perform(keep(new oc.Message_ProgressRange()));
    const sewn = sewing.SewedShape();
    let result: Shape;
    if (isFaceShape(shape)) {
      result = cast(sewn) as Shape;
    } else {
      // A single closed face (whole sphere / torus) sews to a face, not a shell: shell its surface.
      const shells = shape.faces.length === 1 && lastSurface ? [keep(new oc.BRepBuilderAPI_MakeShell(lastSurface as never, false)).Shell()] : [...iterTopo(sewn, "shell")];
      if (shells.length !== 1) throw fail("the stretched faces did not close up");
      const solid = keep(new oc.BRepBuilderAPI_MakeSolid(oc.TopoDS.Shell(shells[0] as never))).Solid();
      oc.BRepLib.OrientClosedSolid(solid);
      result = cast(solid) as Shape;
    }
    if (!isValidShape(result)) throw fail("the stretched result is not a valid shape");
    return result;
  } finally {
    for (const o of tmp) {
      try {
        o.delete();
      } catch {
        // already owned by OpenCascade
      }
    }
  }
}

/**
 * True if a face is its surface's whole (u, v) rectangle (no trimming beyond its parameter bounds)
 * and has no collapsed (pole) edges — those still go through the outline repair.
 */
function coversItsRectangle(face: Face): boolean {
  if (face.edges.some((e) => oc.BRep_Tool.Degenerated(e.wrapped))) return false;
  const ad = new oc.BRepAdaptor_Surface(face.wrapped, true);
  try {
    const mk = new oc.BRepBuilderAPI_MakeFace(oc.BRep_Tool.Surface(face.wrapped), ad.FirstUParameter(), ad.LastUParameter(), ad.FirstVParameter(), ad.LastVParameter(), 1e-7);
    try {
      if (!mk.IsDone()) return false;
      const full = measureArea(cast(mk.Face()) as Face), area = Math.abs(measureArea(face));
      return area > 1e-9 && Math.abs(full - area) < 1e-6 * area;
    } finally {
      mk.delete();
    }
  } catch {
    return false;
  } finally {
    ad.delete();
  }
}

/** Axis of the first curved face of `shape` that wraps all the way round (has a seam edge), or null. */
function wrappingAxis(shape: Shape): { O: V3; N: V3; X: V3; Y: V3 } | null {
  for (const face of shape.faces) {
    const kind = face.geomType;
    if (kind !== "SPHERE" && kind !== "CYLINDRE" && kind !== "CONE" && kind !== "TORUS") continue;
    const seam = face.edges.find((e) => oc.BRep_Tool.IsClosed(e.wrapped, face.wrapped));
    if (!seam) continue;
    const ad = new oc.BRepAdaptor_Surface(face.wrapped, true);
    try {
      const g = kind === "SPHERE" ? ad.Sphere() : kind === "CYLINDRE" ? ad.Cylinder() : kind === "CONE" ? coneOf(face) : ad.Torus();
      const ax = g.Position();
      const v3 = (d: { X(): number; Y(): number; Z(): number }): V3 => [d.X(), d.Y(), d.Z()];
      const out = { O: v3(ax.Location()), N: v3(ax.Direction()), X: v3(ax.XDirection()), Y: v3(ax.YDirection()) };
      ax.delete();
      g.delete();
      return out;
    } finally {
      ad.delete();
    }
  }
  return null;
}

/** A face's surface as a B-spline with its control points stretched by `map`; null if unsupported. */
function stretchedSurface(face: Face, keep: <T>(o: T) => T, map: (p: { X(): number; Y(): number; Z(): number }) => unknown, whole = false): unknown {
  let bs;
  if (face.geomType === "CYLINDRE" || face.geomType === "CONE") {
    bs = ruledCircularSurface(face, keep);
  } else if (face.geomType === "EXTRUSION_SURFACE") {
    bs = extrudedSurface(face, keep);
  } else {
    try {
      bs = oc.GeomConvert.SurfaceToBSplineSurface(oc.BRep_Tool.Surface(face.wrapped));
    } catch {
      return null;
    }
    // Only the part the face covers: no wrap-around, so edges on the old seam are unambiguous.
    // (A lone closed face — a whole sphere / torus — keeps its whole, closed surface.)
    const ad = keep(new oc.BRepAdaptor_Surface(face.wrapped, true));
    if (!whole) {
      try {
        bs.Segment(ad.FirstUParameter(), ad.LastUParameter(), ad.FirstVParameter(), ad.LastVParameter());
      } catch {
        // keep the whole surface
      }
    }
  }
  if (!bs) return null;
  for (let u = 1; u <= bs.NbUPoles(); u++) for (let v = 1; v <= bs.NbVPoles(); v++) bs.SetPole(u, v, map(keep(bs.Pole(u, v))) as never);
  return bs;
}

/**
 * Exact B-spline of the part of a linear-extrusion surface (a B-spline curve swept along a
 * direction, e.g. the side of a pushed/pulled free-form face) a face spans: the curve's control
 * points at the face's two ends along the sweep (or at `along`, a range of the sweep parameter).
 * Null for other base curves.
 */
function extrudedSurface(face: Face, keep: <T>(o: T) => T, along?: [number, number]) {
  const ad = keep(new oc.BRepAdaptor_Surface(face.wrapped, true));
  const basis = keep(ad.BasisCurve());
  if (basis.GetType() !== oc.GeomAbs_CurveType.GeomAbs_BSplineCurve) return null;
  const c = keep(new oc.Geom_BSplineCurve(keep(basis.BSpline()))); // a copy: never edit the shape's own curve
  const u0 = ad.FirstUParameter(), u1 = ad.LastUParameter(), v0 = ad.FirstVParameter(), v1 = ad.LastVParameter();
  if (![u0, u1, v0, v1].every(Number.isFinite) || u1 - u0 < 1e-12 || v1 - v0 < 1e-9) return null;
  // A face that wraps all the way round (seam) keeps the whole closed curve, made periodic so the
  // seam repairs cleanly; otherwise just the part the face covers.
  const wraps = face.edges.some((e) => oc.BRep_Tool.IsClosed(e.wrapped, face.wrapped));
  if (c.IsPeriodic()) c.SetNotPeriodic();
  if (!wraps) {
    try {
      c.Segment(u0, u1);
    } catch {
      // the face spans the whole curve
    }
  }
  const d = keep(ad.Direction());
  const D: V3 = [d.X(), d.Y(), d.Z()];
  const n = c.NbPoles(), nk = c.NbKnots();
  const poles = keep(new oc.NCollection_Array2_gp_Pnt(1, n, 1, 2));
  const weights = keep(new oc.NCollection_Array2_double(1, n, 1, 2));
  const [w0, w1] = along ?? [v0, v1];
  [w0, w1].forEach((v, j) => {
    for (let i = 1; i <= n; i++) {
      const p = keep(c.Pole(i));
      poles.SetValue(i, j + 1, keep(new oc.gp_Pnt(p.X() + D[0] * v, p.Y() + D[1] * v, p.Z() + D[2] * v)));
      weights.SetValue(i, j + 1, c.Weight(i));
    }
  });
  const uk = keep(new oc.NCollection_Array1_double(1, nk)), um = keep(new oc.NCollection_Array1_int(1, nk));
  for (let i = 1; i <= nk; i++) {
    uk.SetValue(i, c.Knot(i));
    um.SetValue(i, c.Multiplicity(i));
  }
  const vk = keep(new oc.NCollection_Array1_double(1, 2)), vm = keep(new oc.NCollection_Array1_int(1, 2));
  vk.SetValue(1, w0);
  vk.SetValue(2, w1);
  vm.SetValue(1, 2);
  vm.SetValue(2, 2);
  const surf = new oc.Geom_BSplineSurface(poles, weights, uk, vk, um, vm, c.Degree(), 1, false, false);
  if (wraps) {
    try {
      surf.SetUPeriodic();
    } catch {
      // not closed smoothly: leave it clamped
    }
  }
  // The adaptor's basis curve / direction may be in the face's local frame: check against the
  // real surface and apply the face's placement if needed.
  const um0 = (u0 + u1) / 2, vm0 = (v0 + v1) / 2;
  const at = (s: { Value(u: number, v: number): { X(): number; Y(): number; Z(): number } }) => {
    const p = keep(s.Value(um0, vm0));
    return [p.X(), p.Y(), p.Z()];
  };
  const want = at(ad as never), got = () => at(surf as never);
  const close = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6 * Math.max(1, Math.hypot(...a));
  if (!close(got(), want)) {
    surf.Transform(keep(ad.Trsf()));
    if (!close(got(), want)) return null;
  }
  return surf;
}

/**
 * Exact rational B-spline of the part of a cylinder / cone a face spans: quadratic arcs (at most
 * 90° each) around the axis, straight between the face's two end circles.
 */
function ruledCircularSurface(face: Face, keep: <T>(o: T) => T) {
  const ad = keep(new oc.BRepAdaptor_Surface(face.wrapped, true));
  const cone = face.geomType === "CONE";
  const g = keep(cone ? coneOf(face) : ad.Cylinder());
  const ax = keep(g.Position());
  const v3 = (d: { X(): number; Y(): number; Z(): number }): V3 => [d.X(), d.Y(), d.Z()];
  const O = v3(keep(ax.Location())), N = v3(keep(ax.Direction())), X = v3(keep(ax.XDirection())), Y = v3(keep(ax.YDirection()));
  const u0 = ad.FirstUParameter(), u1 = ad.LastUParameter(), v0 = ad.FirstVParameter(), v1 = ad.LastVParameter();
  if (![u0, u1, v0, v1].every(Number.isFinite) || u1 - u0 < 1e-9 || v1 - v0 < 1e-9) return null;
  // Point on the surface at angle u, radius r, height h along the axis.
  const R = cone ? (g as { RefRadius(): number }).RefRadius() : (g as { Radius(): number }).Radius();
  const ang = cone ? (g as { SemiAngle(): number }).SemiAngle() : 0;
  const ring = (v: number) => ({ r: R + v * Math.sin(ang), h: v * Math.cos(ang) });
  const at = (u: number, r: number, h: number, scale = 1): V3 =>
    [0, 1, 2].map((k) => O[k] + N[k] * h + (X[k] * Math.cos(u) + Y[k] * Math.sin(u)) * r * scale) as V3;
  const segs = Math.max(1, Math.ceil((u1 - u0) / (Math.PI / 2) - 1e-9));
  const du = (u1 - u0) / segs, w = Math.cos(du / 2);
  const nu = 2 * segs + 1;
  const poles = keep(new oc.NCollection_Array2_gp_Pnt(1, nu, 1, 2));
  const weights = keep(new oc.NCollection_Array2_double(1, nu, 1, 2));
  [v0, v1].forEach((v, j) => {
    const { r, h } = ring(v);
    for (let i = 0; i < nu; i++) {
      const mid = i % 2 === 1;
      const p = at(u0 + (i * du) / 2, r, h, mid ? 1 / w : 1);
      poles.SetValue(i + 1, j + 1, keep(new oc.gp_Pnt(...p)));
      weights.SetValue(i + 1, j + 1, mid ? w : 1);
    }
  });
  const uk = keep(new oc.NCollection_Array1_double(1, segs + 1)), um = keep(new oc.NCollection_Array1_int(1, segs + 1));
  for (let i = 0; i <= segs; i++) {
    uk.SetValue(i + 1, u0 + i * du);
    um.SetValue(i + 1, i === 0 || i === segs ? 3 : 2);
  }
  const vk = keep(new oc.NCollection_Array1_double(1, 2)), vm = keep(new oc.NCollection_Array1_int(1, 2));
  vk.SetValue(1, v0);
  vk.SetValue(2, v1);
  vm.SetValue(1, 2);
  vm.SetValue(2, 2);
  return new oc.Geom_BSplineSurface(poles, weights, uk, vk, um, vm, 2, 1, false, false);
}

export function scaleShape<T extends Geom>(shape: T, f: V3, center: V3): T;
export function scaleShape(shape: Geom, f: V3, center: V3): Geom {
  if (f.some((k) => !(k > 1e-6))) throw new Error("Scale must be greater than 0");
  if (isMesh(shape)) return shape.transformed([f[0], 0, 0, 0, f[1], 0, 0, 0, f[2]], [center[0] * (1 - f[0]), center[1] * (1 - f[1]), center[2] * (1 - f[2])]);
  if (Math.abs(f[0] - f[1]) < 1e-9 && Math.abs(f[1] - f[2]) < 1e-9) return shape.clone().scale(f[0], center) as Shape;
  if (shape instanceof Wire) {
    // A path of straight lines stretches point by point; arcs would turn into ellipses.
    if (shape.edges.some((e) => e.geomType !== "LINE")) throw new Error("Scale: a path with arcs can only be scaled evenly (the same % in X, Y and Z)");
    const map = (p: V3): V3 => [center[0] + (p[0] - center[0]) * f[0], center[1] + (p[1] - center[1]) * f[1], center[2] + (p[2] - center[2]) * f[2]];
    return assembleWire(shape.edges.map((e) => makeLine(map(e.startPoint.toTuple() as V3), map(e.endPoint.toTuple() as V3))));
  }
  if (!isPolyhedral(shape)) return stretchCurved(shape, f, center);
  const map = (p: V3): V3 => [center[0] + (p[0] - center[0]) * f[0], center[1] + (p[1] - center[1]) * f[1], center[2] + (p[2] - center[2]) * f[2]];
  const faces = shape.faces.map((src) => {
    // outerWire / innerWires delete the face they are called on.
    const [outer, ...holes] = [src.clone().outerWire(), ...src.clone().innerWires()].map((w) => loopPoints(w.edges).map(map));
    let out = makeFace(polyWire(outer), holes.map(polyWire));
    // Normals transform by the inverse scale; keep the face facing the same way.
    const n = src.normalAt().toTuple();
    if (dot3(out.normalAt().toTuple() as V3, [n[0] / f[0], n[1] / f[1], n[2] / f[2]]) < 0) out = out.flipOrientation();
    return out;
  });
  const result: Shape = isFaceShape(shape) ? faces[0] : makeSolid(faces).simplify();
  if (!isValidShape(result)) throw new Error("Scale: the result is not a valid shape");
  return result;
}

export function cloneShape<T extends Geom>(shape: T): T {
  return isMesh(shape) ? shape : noteRigid(shape.clone() as T, shape, [1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0]); // a mesh is immutable: copies can share it
}

// ---------------------------------------------------------------- persistence / exchange

/**
 * B-rep text for saving. Written from a copy without the display meshes (triangulations) OpenCascade
 * keeps on the shape — they are rebuilt on load anyway and can be most of the file (megabytes).
 */
export function serializeShape(shape: Shape | Wire): string {
  const t = new oc.gp_Trsf();
  const mk = new oc.BRepBuilderAPI_Transform(shape.wrapped, t, true, false);
  try {
    return (cast(mk.Shape()) as Shape).serialize();
  } catch {
    return shape.serialize();
  } finally {
    mk.delete();
    t.delete();
  }
}

export function deserialize(data: string): Shape {
  const shape = deserializeShape(data) as Shape;
  // A compound round one solid (older files: Cut by guide kept the boolean's compound) → the solid.
  if (shape.wrapped.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_COMPOUND) return shape;
  const solids = [...iterTopo(shape.wrapped, "solid")];
  return solids.length === 1 && [...iterTopo(shape.wrapped, "face")].length === (cast(solids[0]) as Solid).faces.length ? (cast(solids[0]) as Solid) : shape;
}

export function exportStep(items: { shape: Shape; name: string }[]): Promise<ArrayBuffer> {
  return exportSTEP(items.map(({ shape, name }) => ({ shape, name }))).arrayBuffer();
}

/** STL mesh quality: max distance of a triangle from the true surface (mm), max angle between neighbours (°). */
export interface StlQuality {
  tolerance: number;
  angle: number;
}

/**
 * Binary STL of the solids at the given quality. Meshed on copies: OpenCascade keeps a finer mesh
 * already on a shape (the display mesh) rather than coarsen it, so a Draft export would otherwise
 * come out at display quality — and a Fine one would replace the shapes' display meshes.
 */
export async function exportStl(shapes: (Solid | TriMesh)[], quality: StlQuality = { tolerance: 0.02, angle: 8 }): Promise<ArrayBuffer> {
  const solids = shapes.filter((s): s is Solid => !isMesh(s)), meshes = shapes.filter(isMesh);
  const solidStl = solids.length
    ? new Uint8Array(await (makeCompound(solids.map(deepCopy)) as Solid).blobSTL({ binary: true, tolerance: quality.tolerance, angularTolerance: (quality.angle * Math.PI) / 180 }).arrayBuffer())
    : null;
  if (!meshes.length) return solidStl!.buffer as ArrayBuffer;
  // Meshes are appended as they are: one file, so a slicer gets the solids and the meshes together.
  const nSolid = solidStl ? new DataView(solidStl.buffer).getUint32(80, true) : 0;
  const n = nSolid + meshes.reduce((k, m) => k + m.triangleCount, 0);
  const out = new Uint8Array(84 + 50 * n), dv = new DataView(out.buffer);
  out.set(new TextEncoder().encode("YDDD binary STL"));
  dv.setUint32(80, n, true);
  if (solidStl) out.set(solidStl.subarray(84, 84 + 50 * nSolid), 84);
  let o = 84 + 50 * nSolid;
  for (const m of meshes) {
    const P = m.positions;
    for (let i = 0; i < P.length; i += 9, o += 50) {
      const ux = P[i + 3] - P[i], uy = P[i + 4] - P[i + 1], uz = P[i + 5] - P[i + 2];
      const vx = P[i + 6] - P[i], vy = P[i + 7] - P[i + 1], vz = P[i + 8] - P[i + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1;
      dv.setFloat32(o, nx / l, true);
      dv.setFloat32(o + 4, ny / l, true);
      dv.setFloat32(o + 8, nz / l, true);
      for (let k = 0; k < 9; k++) dv.setFloat32(o + 12 + 4 * k, P[i + k], true);
    }
  }
  return out.buffer;
}

/**
 * A body as one indexed triangle mesh for 3MF: `positions` 3 floats per vertex, `triangles` 3 indices each,
 * counter-clockwise seen from outside. Corners shared by neighbouring faces are merged (same point to 1e-6 mm),
 * so a solid's mesh is closed — slicers check that ("non-manifold edges"); triangles squashed to a line are dropped.
 */
export interface IndexedMesh {
  positions: Float32Array;
  triangles: Uint32Array;
}

export function meshForExport(shape: Solid | TriMesh, quality: StlQuality): IndexedMesh {
  let P: ArrayLike<number>, T: ArrayLike<number> | null;
  if (isMesh(shape)) [P, T] = [shape.positions, null];
  else {
    const m = deepCopy(shape).mesh({ tolerance: quality.tolerance, angularTolerance: (quality.angle * Math.PI) / 180 });
    [P, T] = [m.vertices, m.triangles];
  }
  const corners = T ? T.length : P.length / 3;
  const at = (k: number) => (T ? T[k] : k); // (the k-th triangle corner's vertex in P)
  const index = new Map<string, number>(), pos: number[] = [], tri: number[] = [];
  const key = (v: number) => Math.round(v * 1e6);
  const vertex = (i: number): number => {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], k = `${key(x)},${key(y)},${key(z)}`;
    let n = index.get(k);
    if (n === undefined) {
      index.set(k, (n = pos.length / 3));
      pos.push(x, y, z);
    }
    return n;
  };
  for (let c = 0; c < corners; c += 3) {
    const a = vertex(at(c)), b = vertex(at(c + 1)), d = vertex(at(c + 2));
    if (a !== b && b !== d && a !== d) tri.push(a, b, d);
  }
  return { positions: Float32Array.from(pos), triangles: Uint32Array.from(tri) };
}

/** Edges of a welded mesh not shared by exactly two triangles: 0 for a closed (watertight) mesh, else its gaps. */
export function openEdgeCount(m: IndexedMesh): number {
  const uses = new Map<number, number>(), n = m.positions.length / 3, T = m.triangles;
  for (let t = 0; t < T.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = T[t + k], b = T[t + ((k + 1) % 3)], key = Math.min(a, b) * n + Math.max(a, b);
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  let open = 0;
  for (const c of uses.values()) if (c !== 2) open++;
  return open;
}

/** Number of triangles an STL export at this quality would have (meshes count as they are). */
export function stlTriangleCount(shapes: (Solid | TriMesh)[], quality: StlQuality): number {
  let n = 0;
  for (const s of shapes) n += isMesh(s) ? s.triangleCount : deepCopy(s).mesh({ tolerance: quality.tolerance, angularTolerance: (quality.angle * Math.PI) / 180 }).triangles.length / 3;
  return n;
}

/** The triangles of an STL file, binary or ASCII (read here: no B-rep, so even big meshes load fast). */
export function parseStl(data: Uint8Array): TriMesh {
  // Binary: the size fits the triangle count (some exporters append a few bytes, or start the header with "solid").
  const count = data.length >= 84 ? new DataView(data.buffer, data.byteOffset).getUint32(80, true) : -1;
  const ascii = /^\s*solid[^\n]*\n\s*(facet|endsolid)/.test(new TextDecoder("latin1").decode(data.subarray(0, 512)));
  const isBinary = count >= 0 && (data.length === 84 + 50 * count || (!ascii && count > 0 && data.length > 84 + 50 * count));
  if (isBinary) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength), n = dv.getUint32(80, true);
    const P = new Float32Array(n * 9);
    for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) P[i * 9 + k] = dv.getFloat32(84 + 50 * i + 12 + 4 * k, true);
    return new TriMesh(P);
  }
  const text = new TextDecoder("latin1").decode(data);
  if (!/^\s*solid/.test(text)) throw new Error("Not an STL file");
  const nums: number[] = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  for (let m; (m = re.exec(text)); ) nums.push(+m[1], +m[2], +m[3]);
  if (!nums.length || nums.length % 9 || nums.some((x) => !Number.isFinite(x))) throw new Error("The STL file has no readable triangles");
  return new TriMesh(Float32Array.from(nums));
}

/** Import a STEP file, returning one shape per solid found. */
export async function importStep(data: Uint8Array): Promise<Solid[]> {
  const shape: AnyShape = await importSTEP(new Blob([data as BlobPart]));
  const solids = shape.solids;
  if (solids.length > 0) return solids.map((s) => s as Solid);
  return [shape as Solid];
}

/**
 * Import an STL mesh (binary or ASCII), returning one solid per closed piece. OpenCascade turns each
 * triangle into a planar face; they are sewn together, and coplanar triangles merged back into single
 * faces, so a mesh of a CAD part comes back with its flat faces whole. Curved surfaces stay faceted.
 * Open pieces (holes in the mesh) are skipped; `open` counts them.
 */
export function importStl(data: Uint8Array): { solids: Solid[]; open: number } {
  const tmp: { delete(): void }[] = [];
  const keep = <T>(o: T): T => (tmp.push(o as unknown as { delete(): void }), o);
  // OpenCascade takes a file for ASCII when its first bytes are all printable, which a binary STL
  // with a blank header and round coordinates can be. The binary header is free text: mark it non-ASCII.
  const binary = data.length >= 84 && data.length === 84 + 50 * new DataView(data.buffer, data.byteOffset).getUint32(80, true) &&
    !new TextDecoder("latin1").decode(data.subarray(0, 400)).includes("facet");
  if (binary) (data = data.slice())[0] = 0xff;
  const file = `/yddd-import-${Date.now()}.stl`;
  oc.FS.writeFile(file, data);
  try {
    const read = keep(new oc.TopoDS_Shape());
    if (!keep(new oc.StlAPI_Reader()).Read(read, file) || read.IsNull()) throw new Error("Could not read the STL file");
    // The reader gives loose triangles: sew them into shells (shared vertices are bit-identical floats).
    const sew = keep(new oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false));
    sew.Load(read);
    sew.Perform(keep(new oc.Message_ProgressRange()));
    const sewn = keep(sew.SewedShape());
    const solids: Solid[] = [];
    const shells = [...iterTopo(sewn, "shell")];
    let open = [...iterTopo(sewn, "face")].length > shells.reduce((n, sh) => n + [...iterTopo(sh, "face")].length, 0) ? 1 : 0; // stray triangles
    for (const sh of shells) {
      const unify = keep(new oc.ShapeUpgrade_UnifySameDomain(sh, true, true, false));
      unify.Build();
      const shell = keep(oc.TopoDS.Shell(keep(unify.Shape())));
      if (!oc.BRep_Tool.IsClosed(shell)) {
        open++;
        continue;
      }
      const solid = keep(keep(new oc.BRepBuilderAPI_MakeSolid(shell)).Solid());
      oc.BRepLib.OrientClosedSolid(solid); // STL winding may be inside out
      const s = cast(solid) as Solid;
      if (isValidShape(s)) solids.push(s);
      else open++;
    }
    if (!solids.length) throw new Error(open ? "The STL mesh is not closed (it has holes), so it does not bound a solid" : "The STL file has no triangles");
    return { solids, open };
  } finally {
    oc.FS.unlink(file);
    for (const o of tmp) o.delete();
  }
}

export function boundingSize(shape: Geom): V3 {
  const [[x0, y0, z0], [x1, y1, z1]] = shape.boundingBox.bounds;
  return [x1 - x0, y1 - y0, z1 - z0];
}


/** Battery case (Macro menu): a block with a grid of round holes, `columns` × `rows`, the batteries standing in them. */
export interface BatteryCase {
  /** The battery's diameter and length (mm). */
  diameter: number;
  length: number;
  columns: number;
  rows: number;
  /** How deep the holes are, % of the battery's length (the rest sticks out, to grab it). */
  depth: number;
  /** Added to the hole's diameter (mm), so a printed hole fits. */
  clearance: number;
  /** Between holes and round them (mm). */
  wall: number;
  /** Under the holes (mm). */
  floor: number;
}

/** A battery case, its bottom centred on `at` (one solid, round outer corners). */
export function batteryCase(o: BatteryCase, at: V3 = [0, 0, 0]): Solid {
  const columns = Math.round(o.columns), rows = Math.round(o.rows);
  if (!(columns >= 1 && rows >= 1)) throw new Error("Battery case: columns and rows must be 1 or more");
  if (!(o.diameter > 0 && o.length > 0)) throw new Error("Battery case: the battery needs a diameter and a length");
  if (!(o.depth > 0)) throw new Error("Battery case: the holes need a depth above 0 %");
  if (!(o.wall > 0 && o.floor > 0)) throw new Error("Battery case: wall and floor must be more than 0 mm");
  if (!(o.clearance >= 0)) throw new Error("Battery case: clearance can't be below 0 mm");
  const hole = o.diameter + o.clearance, step = hole + o.wall;
  const w = columns * step + o.wall, d = rows * step + o.wall, h = o.floor + (o.length * o.depth) / 100;
  const r = Math.min(o.wall + hole / 2, w / 2, d / 2) * 0.9;
  const block = drawRoundedRectangle(w, d, r).sketchOnPlane(new Plane(at, [1, 0, 0], [0, 0, 1])).extrude(h) as Solid;
  const holes: Solid[] = [];
  for (let i = 0; i < columns; i++) {
    for (let j = 0; j < rows; j++) {
      const c: V3 = [at[0] - w / 2 + o.wall + hole / 2 + i * step, at[1] - d / 2 + o.wall + hole / 2 + j * step, at[2] + o.floor];
      holes.push(occCylinder(hole / 2, h - o.floor + 1, c, [0, 0, 1]));
    }
  }
  const out = booleanOp("subtract", block, holes);
  if (!isValidShape(out)) throw new Error("Battery case: the result is not a valid solid");
  return out;
}

/** Gridfinity (Macro menu): the standard's fixed sizes (mm) — a grid square, a height unit, the gap round a bin. */
export const GRIDFINITY = { grid: 42, unit: 7, gap: 0.5, radius: 3.75, foot: 4.75, lip: 4.4, magnet: { d: 6.5, depth: 2.4, from: 13 } } as const;

/** A Gridfinity bin (Macro menu): `width` × `depth` grid squares, `height` units tall (the lip on top of that). */
export interface GridfinityBin {
  width: number;
  depth: number;
  height: number;
  /** Compartments: columns along the width × rows along the depth (1 × 1: none). */
  columns: number;
  rows: number;
  /** The stacking lip: the next bin's feet sit in it. */
  lip: boolean;
  /** Round holes under each grid square's corners for 6 × 2 mm magnets. */
  magnets: boolean;
  /** Walls and dividers (mm); the floor is as thick, above the feet. */
  wall: number;
}

/**
 * The inside sizes of a Gridfinity bin: its outside (W × D, height H not counting the lip), where its floor is, and a
 * compartment's size (for the panel's measurements — the same numbers gridfinityBin builds from).
 */
export function gridfinitySizes(o: GridfinityBin): { w: number; d: number; h: number; floor: number; cellW: number; cellD: number } {
  const g = GRIDFINITY, w = Math.round(o.width) * g.grid - g.gap, d = Math.round(o.depth) * g.grid - g.gap, h = Math.round(o.height) * g.unit;
  const columns = Math.round(o.columns), rows = Math.round(o.rows);
  const inW = w - 2 * o.wall, inD = d - 2 * o.wall;
  return { w, d, h, floor: g.foot + o.wall, cellW: (inW - (columns - 1) * o.wall) / columns, cellD: (inD - (rows - 1) * o.wall) / rows };
}

/**
 * A Gridfinity bin, its bottom centred on `at`: a foot under each grid square (sloped 0.8, straight 1.8, sloped 2.15 mm
 * — it drops into a baseplate), a rounded body over them, the inside cut out above a floor, divider walls, the
 * stacking lip (the feet's shape turned inside out, a 45° slope under it so it prints without supports) and magnet
 * holes. One solid.
 */
export function gridfinityBin(o: GridfinityBin, at: V3 = [0, 0, 0]): Solid {
  const g = GRIDFINITY;
  const nx = Math.round(o.width), ny = Math.round(o.depth), nz = Math.round(o.height), columns = Math.round(o.columns), rows = Math.round(o.rows);
  if (!(nx >= 1 && ny >= 1)) throw new Error("Gridfinity bin: width and depth must be 1 grid square or more");
  if (!(nz >= 2)) throw new Error("Gridfinity bin: the height must be 2 units (14 mm) or more");
  if (!(columns >= 1 && rows >= 1)) throw new Error("Gridfinity bin: compartments must be 1 or more each way");
  if (!(o.wall >= 0.4 && o.wall <= 2.5)) throw new Error("Gridfinity bin: the wall must be 0.4 to 2.5 mm");
  const { w, d, h, floor, cellW, cellD } = gridfinitySizes(o);
  if (cellW < 3 || cellD < 3) throw new Error("Gridfinity bin: no room for that many compartments — fewer, or a bigger bin");
  // A rounded rectangle `inset` in from a W × D outline (its corners following the outer 3.75 mm round), at height z
  const ring = (cx: number, cy: number, W: number, D: number, inset: number, z: number) =>
    drawRoundedRectangle(W - 2 * inset, D - 2 * inset, g.radius - inset).sketchOnPlane(new Plane([at[0] + cx, at[1] + cy, at[2] + z], [1, 0, 0], [0, 0, 1])) as Sketch;
  const loft = (cx: number, cy: number, W: number, D: number, steps: [number, number][]) => {
    const [first, ...rest] = steps.map(([inset, z]) => ring(cx, cy, W, D, inset, z));
    return first.loftWith(rest, { ruled: true }) as Solid;
  };
  // The feet: one per grid square
  const sq = g.grid - g.gap, x0 = -w / 2 + sq / 2, y0 = -d / 2 + sq / 2;
  const feet: Solid[] = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) feet.push(loft(x0 + i * g.grid, y0 + j * g.grid, sq, sq, [[2.95, 0], [2.15, 0.8], [2.15, 2.6], [0, g.foot]]));
  }
  // The body: from the feet's top to the bin's height (with the lip a little past its top: the lip's slope cuts
  // through the outside at the lip's height, a sharp edge — the body's top face is cut away whole)
  const top = o.lip ? h + g.lip + 0.3 : h;
  const body = ring(0, 0, w, d, 0, g.foot).extrude(top - g.foot) as Solid;
  // The inside: straight walls up from the floor; with the lip, a 45° slope in under it, then the lip's shape (0.7
  // sloped, 1.8 straight, 1.9 sloped out to the outside at the lip's top)
  const t = o.wall, inside = o.lip
    ? loft(0, 0, w, d, [[t, floor], [t, h - (2.6 - t)], [2.6, h], [1.9, h + 0.7], [1.9, h + 2.5], [-0.5, h + g.lip + 0.5]])
    : loft(0, 0, w, d, [[t, floor], [t, h + 1]]);
  let bin = booleanOp("union", body, feet);
  // Dividers: slabs across the inside, clipped to it (round corners), joined before the inside is cut out; with the
  // lip they stop 1 mm below the bin's height (the next bin's feet come down to 0.35 mm below it)
  const walls: Solid[] = [];
  const wallTop = o.lip ? h - 1 : h, X = (x: number): V3 => [at[0] + x, at[1], at[2] + floor - 1];
  const frame: Frame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  for (let i = 1; i < columns; i++) walls.push(makeBox(frame, X(-w / 2 + t + i * cellW + (i - 0.5) * t), t, d, wallTop - floor + 1));
  for (let j = 1; j < rows; j++) {
    const y = -d / 2 + t + j * cellD + (j - 0.5) * t;
    walls.push(makeBox(frame, [at[0], at[1] + y, at[2] + floor - 1], w, t, wallTop - floor + 1));
  }
  bin = booleanOp("subtract", bin, [inside]);
  if (walls.length) {
    const grid = walls.length > 1 ? booleanOp("union", walls[0], walls.slice(1)) : walls[0];
    bin = booleanOp("union", bin, [booleanOp("intersect", grid, [inside])]);
  }
  // Magnet holes: 4 under each grid square, 13 mm from its centre each way
  if (o.magnets) {
    const m = g.magnet, holes: Solid[] = [];
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) holes.push(occCylinder(m.d / 2, m.depth + 1, [at[0] + x0 + i * g.grid + sx * m.from, at[1] + y0 + j * g.grid + sy * m.from, at[2] - 1], [0, 0, 1]));
      }
    }
    bin = booleanOp("subtract", bin, holes);
  }
  if (!isValidShape(bin)) throw new Error("Gridfinity bin: the result is not a valid solid");
  return bin;
}

/** A Gridfinity baseplate (Macro menu): `width` × `depth` grid squares, bins drop into its pockets. */
export interface GridfinityBaseplate {
  width: number;
  depth: number;
  /** Fill a drawer (mm, 0 = off): the plate this size less 0.5 mm all round, as many squares as fit, the rest a border. */
  drawerWidth: number;
  drawerDepth: number;
  /** A floor under the pockets with round holes for 6 × 2 mm magnets (4 per square); off: an open frame. */
  magnets: boolean;
}

/** Sizes of a baseplate: its outside, the grid's squares and size, the border round the grid each way, its height. */
export function gridfinityBaseplateSizes(o: GridfinityBaseplate): { w: number; d: number; nx: number; ny: number; gridW: number; gridD: number; padX: number; padY: number; h: number; floor: number } {
  const g = GRIDFINITY;
  const fit = (drawer: number, squares: number) => {
    if (!(drawer > 0)) return { size: Math.round(squares) * g.grid, n: Math.round(squares) };
    const size = drawer - 1;
    return { size, n: Math.floor(size / g.grid + 1e-9) };
  };
  const x = fit(o.drawerWidth, o.width), y = fit(o.drawerDepth, o.depth);
  const floor = o.magnets ? g.magnet.depth + 0.8 : 0;
  return { w: x.size, d: y.size, nx: x.n, ny: y.n, gridW: x.n * g.grid, gridD: y.n * g.grid, padX: (x.size - x.n * g.grid) / 2, padY: (y.size - y.n * g.grid) / 2, h: floor + GRIDFINITY_POCKET, floor };
}

/** A baseplate pocket's depth (sloped 0.7, straight 1.8, sloped 2.15 mm) and its corners' radius at the top. */
const GRIDFINITY_POCKET = 4.65, GRIDFINITY_PLATE_RADIUS = 4;

/**
 * A Gridfinity baseplate, its bottom centred on `at`: a pocket per grid square (a bin's foot drops in), the pockets
 * meeting in sharp ridges; a border to fill a drawer; with magnets a floor under the pockets, 4 holes in each. One solid.
 */
export function gridfinityBaseplate(o: GridfinityBaseplate, at: V3 = [0, 0, 0]): Solid {
  const g = GRIDFINITY, R = GRIDFINITY_PLATE_RADIUS;
  const { w, d, nx, ny, gridW, gridD, h, floor } = gridfinityBaseplateSizes(o);
  if (o.drawerWidth > 0 && nx < 1 || o.drawerDepth > 0 && ny < 1) throw new Error(`Gridfinity baseplate: the drawer is too small for one grid square (${g.grid + 1} mm or more)`);
  if (!(nx >= 1 && ny >= 1)) throw new Error("Gridfinity baseplate: width and depth must be 1 grid square or more");
  const ring = (cx: number, cy: number, W: number, D: number, inset: number, z: number) =>
    drawRoundedRectangle(W - 2 * inset, D - 2 * inset, R - inset).sketchOnPlane(new Plane([at[0] + cx, at[1] + cy, at[2] + z], [1, 0, 0], [0, 0, 1])) as Sketch;
  // The pockets are 0.05 mm in from the grid lines: the ridges between them (and round the grid) have a 0.1 mm flat
  // top — OpenCascade can't cut two pockets meeting in a ridge with no width (bins sit 0.05 mm higher: nothing)
  const top = h, plate = ring(0, 0, w, d, 0, 0).extrude(top) as Solid, e = 0.05;
  const x0 = -gridW / 2 + g.grid / 2, y0 = -gridD / 2 + g.grid / 2;
  const pockets: Solid[] = [], holes: Solid[] = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const cx = x0 + i * g.grid, cy = y0 + j * g.grid;
      const steps: [number, number][] = [[2.85 + e, floor > 0 ? floor : -0.5], [2.85 + e, floor], [2.15 + e, floor + 0.7], [2.15 + e, floor + 2.5], [e, top], [e - 0.5, top + 0.5]];
      const [first, ...rest] = (floor > 0 ? steps.slice(1) : steps).map(([inset, z]) => ring(cx, cy, g.grid, g.grid, inset, z));
      pockets.push(first.loftWith(rest, { ruled: true }) as Solid);
      if (o.magnets) for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) holes.push(occCylinder(g.magnet.d / 2, g.magnet.depth + 0.5, [at[0] + cx + sx * g.magnet.from, at[1] + cy + sy * g.magnet.from, at[2] + floor - g.magnet.depth], [0, 0, 1]));
    }
  }
  let out = booleanOp("subtract", plate, [...pockets, ...holes]);
  if (!isValidShape(out)) {
    // (the pockets all at once can fail where their tops overlap: one at a time)
    out = plate;
    for (const p of [...pockets, ...holes]) out = booleanOp("subtract", out, [p]);
  }
  if (!isValidShape(out)) throw new Error("Gridfinity baseplate: the result is not a valid solid");
  return out;
}

/** The point of `face` nearest `p` and the face's outward normal there. */
function onFace(face: Face, p: V3): { p: V3; n: V3 } {
  const pnt = new oc.gp_Pnt(...p), surface = oc.BRep_Tool.Surface(face.wrapped);
  const proj = new oc.GeomAPI_ProjectPointOnSurf(pnt, surface, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad);
  const near = proj.NearestPoint(), { U, V } = proj.LowerDistanceParameters(0, 0) as { U: number; V: number };
  const at = new oc.gp_Pnt(), nv = new oc.gp_Vec(), props = new oc.BRepGProp_Face(face.wrapped, false);
  props.Normal(U, V, at, nv);
  const out = { p: [near.X(), near.Y(), near.Z()] as V3, n: norm3([nv.X(), nv.Y(), nv.Z()]) };
  for (const x of [pnt, proj, near, at, nv, props]) x.delete();
  return out;
}

/** `shape` moved by the frame (origin; x, y, z its axes): a point (a, b, c) goes to origin + a·x + b·y + c·z. */
function toFrame<T extends OcShape<any>>(shape: T, f: Frame): T {
  const t = new oc.gp_Trsf();
  t.SetValues(f.x[0], f.y[0], f.z[0], f.origin[0], f.x[1], f.y[1], f.z[1], f.origin[1], f.x[2], f.y[2], f.z[2], f.origin[2]);
  const b = new oc.BRepBuilderAPI_Transform(shape.wrapped, t, true);
  const out = cast(b.Shape()) as unknown as T;
  t.delete();
  b.delete();
  return out;
}

/**
 * Text wrapped on a curved face (Text tool, a click on a curved side — a cup, a round box): the text laid out flat,
 * each letter moved and turned to stand on the face at its distance along the surface from `at` (sideways round
 * it, level; upright: the world Z up the face), its centre on the face, facing out. Flat letters (one face per
 * outline), as the Text tool makes — Push/Pull makes them raised; they don't follow the curve within a letter.
 */
export function wrappedTextFaces(shape: Shape, faceId: number, at: V3, text: string, o: TextOptions): Face[] {
  const face = findFace(shape, faceId);
  if (!face) throw new Error("Text: the face isn't there any more");
  const flat = makeTextFaces({ origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }, [0, 0, 0], text, o);
  // Up the face: the world Z laid on it (a face looking up or down: the world Y)
  const frameAt = (n: V3) => {
    const w: V3 = Math.abs(n[2]) > 0.95 ? [0, 1, 0] : [0, 0, 1];
    const k = dot3(w, n), up = norm3([w[0] - k * n[0], w[1] - k * n[1], w[2] - k * n[2]]);
    return { up, right: cross3(up, n) };
  };
  const move = (p: V3, d: V3, k: number): V3 => [p[0] + k * d[0], p[1] + k * d[1], p[2] + k * d[2]];
  const centres = flat.map((f) => {
    const [[x0, y0], [x1, y1]] = f.boundingBox.bounds;
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  });
  // Walk sideways along the face from the click, in small steps, both ways: where each distance along it lands
  const start = onFace(face, at);
  const reach = Math.max(0, ...centres.map((c) => Math.abs(c.x))) + 1;
  const step = Math.min(0.5, o.height / 10);
  const walk = (dir: 1 | -1) => {
    const pts = [start];
    let cur = start;
    for (let s = step; s <= reach + step; s += step) {
      cur = onFace(face, move(cur.p, frameAt(cur.n).right, dir * step));
      pts.push(cur);
    }
    return pts;
  };
  const ahead = walk(1), behind = walk(-1);
  const along = (x: number) => (x >= 0 ? ahead : behind)[Math.min(Math.round(Math.abs(x) / step), ahead.length - 1)];
  return flat.map((f, i) => {
    // The letter's centre: up the face from the line it's on, back onto the face; the letter stood there, facing out
    const c = centres[i], base = along(c.x);
    const q = onFace(face, move(base.p, frameAt(base.n).up, c.y)), { up, right } = frameAt(q.n);
    return toFrame(f.clone().translate([-c.x, -c.y, 0]) as Face, { origin: q.p, x: right, y: up, z: q.n });
  });
}
