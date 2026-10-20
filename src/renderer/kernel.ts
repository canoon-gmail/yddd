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
import {
  setOC,
  Plane,
  Vector,
  drawRoundedRectangle,
  drawPolysides,
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
  deserializeShape,
  exportSTEP,
  importSTEP,
  makeCompound,
  makePolygon,
  iterTopo,
  cast,
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

  /** Positions as base64 (little-endian float32) for the .y3d file; cached, the mesh never changes. */
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
  if (typeof e === "number") return "geometry kernel could not compute this (OpenCascade exception)";
  return String(e);
}

// ---------------------------------------------------------------- tessellation

export interface Tessellation {
  faces: ShapeMesh;
  edges: ShapeEdgeMesh;
}

export function tessellate(shape: Shape | Wire, preview = false): Tessellation {
  // Size from points along the edges (a bounding box of B-spline faces is slow to compute — tens
  // of ms); midpoints too, for a whole circle whose one edge starts and ends at the same point.
  const ends = shape.edges.flatMap((e) => [0, 0.5, 1].map((t) => e.pointAt(t).toTuple() as V3));
  const span = (k: number) => Math.max(...ends.map((p) => p[k])) - Math.min(...ends.map((p) => p[k]));
  const diag = (ends.length ? Math.hypot(span(0), span(1), span(2)) : 0) || 1;
  const tolerance = Math.min(0.1, Math.max(0.001, diag * 2e-4));
  // A live preview is redrawn on every change: 4x coarser (about a quarter of the triangles,
  // several times faster to mesh), still smooth on screen. Bodies get the full quality.
  const opts = preview ? { tolerance: tolerance * 4, angularTolerance: 0.3 } : { tolerance, angularTolerance: 0.15 };
  if (shape instanceof Wire) return { faces: shape.mesh(opts), edges: shape.meshEdges(opts) }; // a path: lines only
  return { faces: shape.mesh(opts), edges: withoutSeams(shape.meshEdges(opts), seamEdgeIds(shape)) };
}

/**
 * Seam edges of a solid: edges used by only ONE face. On a closed solid every
 * real edge separates two faces; an edge with a single face is either the seam
 * where a periodic surface (sphere, cylinder, torus...) wraps onto itself, or a
 * zero-length "degenerate" edge at a pole. Neither is a visible crease, so they
 * are not drawn, not pickable and skipped by "fillet all edges".
 * Flat face bodies have no seams (their single-face edges are the real outline).
 */
export function seamEdgeIds(shape: Shape): Set<number> {
  if (isFaceShape(shape)) return new Set();
  const faceCount = new Map<number, number>();
  for (const face of shape.faces) {
    // A seam appears twice in its face (once per orientation): count each face once.
    for (const id of new Set(face.edges.map((e) => e.hashCode))) faceCount.set(id, (faceCount.get(id) ?? 0) + 1);
  }
  const seams = new Set<number>();
  for (const [id, n] of faceCount) if (n === 1) seams.add(id);
  return seams;
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
type SketchSeg = Extract<SketchLoop, { kind: "path" }>["segs"][number];

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
  const c = face.center.toTuple();
  const z = face.normalAt(face.center).normalized().toTuple();
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
 * A curved wall (e.g. half an elliptic cylinder from a stretched circle) pushed/pulled the way
 * Plasticity does: its section across the wall's axis — an ellipse — scaled about its centre so
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
  // Moved as a whole (G / Shift+G / Tab move): same size, shifted bounding box.
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
        const cone = keep(ad.Cone());
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
  if (len < tol * 10) throw new Error("Divide face: the two points are the same");
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
  if (!face) throw new Error("Divide face: start and end on the edges of the same flat face (corners, midpoints or anywhere along an edge)");
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
    throw new Error("Divide face: the geometry kernel could not divide this face");
  }
  const solids = [...iterTopo(builder.Shape(), "solid")].map((x) => cast(x) as Solid);
  builder.delete();
  if (solids.length !== 1 || !isValidShape(solids[0])) throw new Error("Divide face: dividing this face did not give a valid solid");
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
function sweepLoops(outer: Wire, holes: Wire[], path: Wire, round: boolean): Solid {
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
 */
export function sweepFace(shape: Shape, faceId: number, path: Wire, toPath: boolean, round: boolean, turnDeg = 0): Solid {
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
  // outerWire / innerWires delete the face they are called on.
  return sweepLoops(face.clone().outerWire(), face.clone().innerWires(), path, round);
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
  let result = target;
  for (const tool of tools) {
    result = boolean(op === "union" ? "fuse" : op === "subtract" ? "cut" : "common", result, tool);
  }
  return result.simplify();
}

export function translateShape<T extends Geom>(shape: T, v: V3): T {
  if (isMesh(shape)) return shape.transformed([1, 0, 0, 0, 1, 0, 0, 0, 1], v) as T;
  return shape.clone().translate(v) as T;
}

export function rotateShape<T extends Geom>(shape: T, angleDeg: number, center: V3, axis: V3): T {
  if (isMesh(shape)) {
    // Rodrigues' rotation about the axis through `center` (right-handed, like OpenCascade's).
    const [x, y, z] = norm3(axis), a = (angleDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), k = 1 - c;
    const M = [c + x * x * k, x * y * k - z * s, x * z * k + y * s, y * x * k + z * s, c + y * y * k, y * z * k - x * s, z * x * k - y * s, z * y * k + x * s, c + z * z * k];
    const mc = [0, 1, 2].map((r) => M[r * 3] * center[0] + M[r * 3 + 1] * center[1] + M[r * 3 + 2] * center[2]);
    return shape.transformed(M, [center[0] - mc[0], center[1] - mc[1], center[2] - mc[2]]) as T;
  }
  return shape.clone().rotate(angleDeg, center, axis) as T;
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
      const g = kind === "SPHERE" ? ad.Sphere() : kind === "CYLINDRE" ? ad.Cylinder() : kind === "CONE" ? ad.Cone() : ad.Torus();
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
  const g = keep(cone ? ad.Cone() : ad.Cylinder());
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
  return isMesh(shape) ? shape : (shape.clone() as T); // a mesh is immutable: copies can share it
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
  out.set(new TextEncoder().encode("Y3D binary STL"));
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
  const file = `/y3d-import-${Date.now()}.stl`;
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
