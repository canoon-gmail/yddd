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
  basicFaceExtrusion,
  deserializeShape,
  exportSTEP,
  importSTEP,
  makeCompound,
  Face,
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

export async function initKernel(): Promise<void> {
  const oc = await opencascade({ locateFile: () => wasmUrl });
  setOC(oc);
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

/** Push (negative) or pull (positive) a face of a solid along its normal, modifying that solid. */
export function pushPull(shape: Solid, faceId: number, distance: number): Solid {
  const face = findFace(shape, faceId);
  if (!face) throw new Error("face not found");
  if (distance === 0) return shape;
  const n = face.normalAt(face.center).normalized().toTuple();
  const tool = basicFaceExtrusion(face, new Vector([n[0] * distance, n[1] * distance, n[2] * distance]));
  const result = distance > 0 ? shape.fuse(tool) : shape.cut(tool);
  return result.simplify();
}

/** Push/pull several faces of one solid by the same distance (each along its own normal). */
export function pushPullMany(shape: Solid, faceIds: number[], distance: number): Solid {
  if (faceIds.length === 1) return pushPull(shape, faceIds[0], distance);
  if (distance === 0) return shape;
  let result: Shape3D = shape;
  // Tools are all built from the original faces so face ids stay valid.
  const tools = faceIds.map((id) => {
    const face = findFace(shape, id);
    if (!face) throw new Error("face not found");
    const n = face.normalAt(face.center).normalized().toTuple();
    return basicFaceExtrusion(face, new Vector([n[0] * distance, n[1] * distance, n[2] * distance]));
  });
  for (const t of tools) result = distance > 0 ? result.fuse(t) : result.cut(t);
  return result.simplify();
}

/** Hollow the solid inward, removing the given (open) faces, walls of `thickness`. */
export function shellSolid(shape: Solid, faceIds: Set<number>, thickness: number): Solid {
  return shape.shell(thickness, (f) => f.when(({ element }) => faceIds.has(element.hashCode)));
}

export type BooleanOp = "union" | "subtract" | "intersect";

export function booleanOp(op: BooleanOp, target: Solid, tools: Solid[]): Solid {
  let result = target;
  for (const tool of tools) {
    if (op === "union") result = result.fuse(tool);
    else if (op === "subtract") result = result.cut(tool);
    else result = result.intersect(tool);
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
