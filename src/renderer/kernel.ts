/**
 * Geometry kernel facade. All B-rep modeling goes through this module so the
 * rest of the app never touches OpenCascade / replicad directly.
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
  drawCircle,
  makeSphere,
  basicFaceExtrusion,
  deserializeShape,
  exportSTEP,
  importSTEP,
  makeCompound,
  type AnyShape,
  type Face,
  type Shape3D,
  type ShapeEdgeMesh,
  type ShapeMesh,
} from "replicad";

export type Shape = Shape3D;
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
  return { faces: shape.mesh(opts), edges: shape.meshEdges(opts) };
}

// ---------------------------------------------------------------- primitives

const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]];

/** Rectangle of size w×d centered at `center` on the frame's plane, extruded by signed `h`. */
export function makeBox(frame: Frame, center: V3, w: number, d: number, h: number): Shape {
  const plane = new Plane(center, frame.x, h >= 0 ? frame.z : neg(frame.z));
  return drawRoundedRectangle(w, d).sketchOnPlane(plane).extrude(Math.abs(h)) as Shape;
}

export function makeCylinder(frame: Frame, center: V3, r: number, h: number): Shape {
  const plane = new Plane(center, frame.x, h >= 0 ? frame.z : neg(frame.z));
  return drawCircle(r).sketchOnPlane(plane).extrude(Math.abs(h)) as Shape;
}

export function makeSphereAt(center: V3, r: number): Shape {
  return makeSphere(r).translate(center);
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

// ---------------------------------------------------------------- modeling ops

export function filletEdges(shape: Shape, edgeIds: Set<number> | null, radius: number): Shape {
  return edgeIds ? shape.fillet((e) => (edgeIds.has(e.hashCode) ? radius : null)) : shape.fillet(radius);
}

export function chamferEdges(shape: Shape, edgeIds: Set<number> | null, distance: number): Shape {
  return edgeIds ? shape.chamfer((e) => (edgeIds.has(e.hashCode) ? distance : null)) : shape.chamfer(distance);
}

/** Push (negative) or pull (positive) a face along its normal. */
export function pushPull(shape: Shape, faceId: number, distance: number): Shape {
  const face = findFace(shape, faceId);
  if (!face) throw new Error("face not found");
  if (distance === 0) return shape;
  const n = face.normalAt(face.center).normalized().toTuple();
  const tool = basicFaceExtrusion(face, new Vector([n[0] * distance, n[1] * distance, n[2] * distance]));
  const result = distance > 0 ? shape.fuse(tool) : shape.cut(tool);
  return result.simplify();
}

/** Hollow the solid inward, removing the given (open) faces, walls of `thickness`. */
export function shellSolid(shape: Shape, faceIds: Set<number>, thickness: number): Shape {
  return shape.shell(thickness, (f) => f.when(({ element }) => faceIds.has(element.hashCode)));
}

export type BooleanOp = "union" | "subtract" | "intersect";

export function booleanOp(op: BooleanOp, target: Shape, tools: Shape[]): Shape {
  let result = target;
  for (const tool of tools) {
    if (op === "union") result = result.fuse(tool);
    else if (op === "subtract") result = result.cut(tool);
    else result = result.intersect(tool);
  }
  return result.simplify();
}

export function translateShape(shape: Shape, v: V3): Shape {
  return shape.clone().translate(v);
}

export function rotateShape(shape: Shape, angleDeg: number, center: V3, axis: V3): Shape {
  return shape.clone().rotate(angleDeg, center, axis);
}

export function cloneShape(shape: Shape): Shape {
  return shape.clone();
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

export function exportStl(shapes: Shape[]): Promise<ArrayBuffer> {
  const compound = makeCompound(shapes) as Shape;
  return compound.blobSTL({ binary: true, tolerance: 0.01, angularTolerance: 0.1 }).arrayBuffer();
}

/** Import a STEP file, returning one shape per solid found. */
export async function importStep(data: Uint8Array): Promise<Shape[]> {
  const shape: AnyShape = await importSTEP(new Blob([data as BlobPart]));
  const solids = shape.solids;
  if (solids.length > 0) return solids.map((s) => s as Shape);
  return [shape as Shape];
}

export function boundingSize(shape: Shape): V3 {
  const [[x0, y0, z0], [x1, y1, z1]] = shape.boundingBox.bounds;
  return [x1 - x0, y1 - y0, z1 - z0];
}
