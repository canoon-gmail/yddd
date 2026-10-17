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
import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
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
  makeSolid,
  makeVertex,
  measureDistanceBetween,
  basicFaceExtrusion,
  deserializeShape,
  exportSTEP,
  importSTEP,
  makeCompound,
  makePolygon,
  iterTopo,
  cast,
  Face,
  Wire,
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
export type BodyKind = "solid" | "face";

export function isFaceShape(shape: Shape): shape is Face {
  return shape instanceof Face;
}

export function kindOf(shape: Shape): BodyKind {
  return isFaceShape(shape) ? "face" : "solid";
}
export type V3 = [number, number, number];
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
function boolean(kind: "fuse" | "cut" | "common", a: Shape3D, b: Shape3D): Shape3D {
  const builder =
    kind === "fuse" ? new oc.BRepAlgoAPI_Fuse() : kind === "cut" ? new oc.BRepAlgoAPI_Cut() : new oc.BRepAlgoAPI_Common();
  const args = new oc.NCollection_List_TopoDS_Shape();
  const tools = new oc.NCollection_List_TopoDS_Shape();
  try {
    args.Append(a.wrapped);
    tools.Append(b.wrapped);
    builder.SetArguments(args);
    builder.SetTools(tools);
    builder.SetNonDestructive(true);
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

export function tessellate(shape: Shape): Tessellation {
  const [[x0, y0, z0], [x1, y1, z1]] = shape.boundingBox.bounds;
  const diag = Math.hypot(x1 - x0, y1 - y0, z1 - z0) || 1;
  const tolerance = Math.min(0.1, Math.max(0.001, diag * 2e-4));
  const opts = { tolerance, angularTolerance: 0.15 };
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
  const n = face.normalAt(face.center).normalized().toTuple();
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
  const center = face.center.toTuple() as V3;
  return { center, normal: face.normalAt(face.center).normalized().toTuple() as V3 };
}

// ---------------------------------------------------------------- modeling ops

/** Fillet the given edges, or (null) every real edge — seams are never filleted. */
export function filletEdges(shape: Solid, edgeIds: Set<number> | null, radius: number): Solid {
  const seams = seamEdgeIds(shape);
  return shape.fillet((e) => (!seams.has(e.hashCode) && (!edgeIds || edgeIds.has(e.hashCode)) ? radius : null));
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
          if (dot3(f.normalAt(p).normalized().toTuple() as V3, g.normalAt(p).normalized().toTuple() as V3) < 0.999) continue;
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

/** Fuse (pull) or cut (push) prisms of `faces` swept by `distance` along `n`. */
function sweepFaces(shape: Solid, faces: { face: Face; n: V3 }[], distance: number): Solid {
  let result: Shape3D = shape;
  for (const { face, n } of faces) {
    const tool = basicFaceExtrusion(face, new Vector([n[0] * distance, n[1] * distance, n[2] * distance]));
    result = boolean(distance > 0 ? "fuse" : "cut", result, tool);
  }
  return result.simplify();
}

/**
 * Push/pull faces with their tangent fillet chains; if that fails or gives an
 * invalid solid, fall back to moving just the faces themselves.
 */
function pushPullFaces(shape: Solid, faces: { face: Face; n: V3 }[], distance: number): Solid {
  // A fillet between two selected faces would be swept twice in different directions: leave it.
  const owner = new Map<number, number>();
  const chains = faces.map(({ face, n }, i) => {
    const chain = tangentChain(shape, face, n);
    for (const g of chain) owner.set(g.hashCode, owner.has(g.hashCode) && owner.get(g.hashCode) !== i ? -1 : i);
    return chain;
  });
  const withChains = faces.flatMap((f, i) => [f, ...chains[i].filter((g) => owner.get(g.hashCode) === i).map((g) => ({ face: g, n: f.n }))]);
  if (withChains.length > faces.length) {
    try {
      const r = sweepFaces(shape, withChains, distance);
      if (isValidShape(r)) return r;
    } catch {
      // fall through to the plain push/pull
    }
  }
  return sweepFaces(shape, faces, distance);
}

function faceWithNormal(shape: Solid, faceId: number): { face: Face; n: V3 } {
  const face = findFace(shape, faceId);
  if (!face) throw new Error("face not found");
  return { face, n: face.normalAt(face.center).normalized().toTuple() as V3 };
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

/** True if every face is flat and every edge straight (the shapes `moveEdges` can reshape). */
export function isPolyhedral(shape: Shape): boolean {
  return shape.faces.every((f) => f.geomType === "PLANE") && shape.edges.every((e) => e.geomType === "LINE");
}

const add3 = (p: V3, q: V3): V3 => [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
const ptKey = (p: V3) => p.map((x) => Math.round(x * 1e5)).join();

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
 * Move the given straight edges of a flat-faced solid by `v`, reshaping the
 * faces around them. Faces that stay flat stay single faces; faces that bend
 * are split into triangles. Coplanar neighbours are merged again afterwards.
 */
export function moveEdges(shape: Solid, edgeIds: Set<number>, v: V3): Solid {
  if (!isPolyhedral(shape)) throw new Error("Move edge works on solids with only flat faces and straight edges (no curves or fillets)");
  const moved = new Set<string>();
  for (const e of shape.edges) {
    if (!edgeIds.has(e.hashCode)) continue;
    moved.add(ptKey(e.startPoint.toTuple() as V3));
    moved.add(ptKey(e.endPoint.toTuple() as V3));
  }
  if (!moved.size) throw new Error("Move edge: edge not found on this solid");
  const mv = (p: V3): V3 => (moved.has(ptKey(p)) ? add3(p, v) : p);
  // Drop corners that collapse onto their neighbour.
  const clean = (pts: V3[]) => pts.filter((p, i) => ptKey(p) !== ptKey(pts[(i + 1) % pts.length]));

  const [lo, hi] = shape.boundingBox.bounds;
  const tol = 1e-6 * Math.max(1, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + Math.hypot(...v));
  const faces: Face[] = [];
  for (const f of shape.faces) {
    // outerWire / innerWires delete the face they are called on.
    const loops = [f.clone().outerWire(), ...f.clone().innerWires()].map((w) => loopPoints(w.edges));
    if (!loops.some((l) => l.some((p) => moved.has(ptKey(p))))) {
      faces.push(f);
      continue;
    }
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

// ---------------------------------------------------------------- line tool (split face by a line)

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
  if (len < tol * 10) throw new Error("Line: the two points are the same");
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
  if (!face) throw new Error("Line: start and end on the edges of the same flat face (corners, midpoints or anywhere along an edge)");
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
    throw new Error("Line: the geometry kernel could not split this face");
  }
  const solids = [...iterTopo(builder.Shape(), "solid")].map((x) => cast(x) as Solid);
  builder.delete();
  if (solids.length !== 1 || !isValidShape(solids[0])) throw new Error("Line: splitting this face did not give a valid solid");
  return solids[0];
}

/** Hollow the solid inward, removing the given (open) faces, walls of `thickness`. */
export function shellSolid(shape: Solid, faceIds: Set<number>, thickness: number): Solid {
  return shape.shell(thickness, (f) => f.when(({ element }) => faceIds.has(element.hashCode)));
}

/**
 * New flat face on the same plane as a planar face, its outline offset by `distance`
 * (positive = larger, holes shrink; negative = smaller). Corners stay sharp.
 * The source shape is not modified.
 */
export function offsetFace(shape: Shape, faceId: number, distance: number): Face {
  const face = findFace(shape, faceId);
  if (!face) throw new Error("face not found");
  if (face.geomType !== "PLANE") throw new Error("Offset works on flat faces only");
  if (Math.abs(distance) < 1e-9) throw new Error("distance must not be 0");
  const mk = new oc.BRepOffsetAPI_MakeOffset(face.wrapped, oc.GeomAbs_JoinType.GeomAbs_Intersection, false);
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

export type BooleanOp = "union" | "subtract" | "intersect";

export function booleanOp(op: BooleanOp, target: Solid, tools: Solid[]): Solid {
  let result = target;
  for (const tool of tools) {
    result = boolean(op === "union" ? "fuse" : op === "subtract" ? "cut" : "common", result, tool);
  }
  return result.simplify();
}

export function translateShape<T extends Shape>(shape: T, v: V3): T {
  return shape.clone().translate(v) as T;
}

export function rotateShape<T extends Shape>(shape: T, angleDeg: number, center: V3, axis: V3): T {
  return shape.clone().rotate(angleDeg, center, axis) as T;
}

export function cloneShape<T extends Shape>(shape: T): T {
  return shape.clone() as T;
}

// ---------------------------------------------------------------- persistence / exchange

export function serializeShape(shape: Shape): string {
  return shape.serialize();
}

export function deserialize(data: string): Shape {
  return deserializeShape(data) as Shape;
}

export function exportStep(items: { shape: Shape; name: string }[]): Promise<ArrayBuffer> {
  return exportSTEP(items.map(({ shape, name }) => ({ shape, name }))).arrayBuffer();
}

export function exportStl(shapes: Solid[]): Promise<ArrayBuffer> {
  const compound = makeCompound(shapes) as Solid;
  return compound.blobSTL({ binary: true, tolerance: 0.01, angularTolerance: 0.1 }).arrayBuffer();
}

/** Import a STEP file, returning one shape per solid found. */
export async function importStep(data: Uint8Array): Promise<Solid[]> {
  const shape: AnyShape = await importSTEP(new Blob([data as BlobPart]));
  const solids = shape.solids;
  if (solids.length > 0) return solids.map((s) => s as Solid);
  return [shape as Solid];
}

export function boundingSize(shape: Shape): V3 {
  const [[x0, y0, z0], [x1, y1, z1]] = shape.boundingBox.bounds;
  return [x1 - x0, y1 - y0, z1 - z0];
}
