/** Bodies made from other bodies: what they keep of them (look, text, gear, group, name), and dimensions that follow them. */
import { isMesh, matchCircleEdge, matchStraightEdge, type Geom, type Shape, type V3 } from "./kernel";
import { isBrep, type Body, type Dimension, type Look } from "./document";
import * as THREE from "three";

/** Linked dimensions follow their edge / circle into the bodies' new shapes (unlinked if it can't be found). */
export function relinkDimensions(dims: readonly Dimension[], prev: readonly Body[], next: readonly Body[]): readonly Dimension[] {
  return dims.map((d) => {
    if (d.body === undefined) return d;
    const before = prev.find((b) => b.id === d.body), after = next.find((b) => b.id === d.body);
    if (before && after && before.shape === after.shape) return d;
    const { body: _, ...unlinked } = d;
    if (!before || !after || !isBrep(before) || !isBrep(after)) return unlinked;
    try {
      const e = d.kind === "radius" ? matchCircleEdge(after.shape, before.shape, d.a, d.b, d.n!) : matchStraightEdge(after.shape, before.shape, d.a, d.b);
      return e ? { ...d, a: e[0], b: e[1] } : unlinked;
    } catch {
      return unlinked;
    }
  });
}

/**
 * How a preview (or the change it previews) moves a body, for its linked dimensions: through a matrix (Move, Rotate,
 * Scale), or each point by its own shift (Push/Pull: the points on the pushed face).
 */
export type DimMove = { matrix: THREE.Matrix4 } | { shift: (p: V3) => V3 };

/** Linked dimensions of the bodies in `moves` moved with them (the rest as they are; same order). */
export function movedDims(dims: readonly Dimension[], moves: ReadonlyMap<number, DimMove>): readonly Dimension[] {
  return dims.map((d) => {
    const m = d.body === undefined ? undefined : moves.get(d.body);
    if (!m) return d;
    const add = (p: V3, v: V3): V3 => [p[0] + v[0], p[1] + v[1], p[2] + v[2]];
    if ("shift" in m) {
      // (a circle moves whole: its centre may be on no face — over a hole —, it goes with its rim)
      const sb = m.shift(d.b);
      return { ...d, a: add(d.a, d.kind === "radius" ? sb : m.shift(d.a)), b: add(d.b, sb), ...(d.c ? { c: add(d.c, m.shift(d.c)) } : {}) };
    }
    const pt = (p: V3): V3 => new THREE.Vector3(...p).applyMatrix4(m.matrix).toArray() as V3;
    const lin = new THREE.Matrix3().setFromMatrix4(m.matrix);
    const a = pt(d.a), b = pt(d.b);
    // The offset turned with it, square to the dimension and as far out as before
    const o = new THREE.Vector3(...d.o).applyMatrix3(lin), u = new THREE.Vector3(...b).sub(new THREE.Vector3(...a));
    if (u.lengthSq() > 1e-18) o.addScaledVector(u, -o.dot(u) / u.lengthSq());
    const off: V3 = o.lengthSq() > 1e-18 ? (o.setLength(Math.hypot(...d.o)).toArray() as V3) : d.o;
    const n = d.n && new THREE.Vector3(...d.n).applyMatrix3(lin).normalize();
    return { ...d, a, b, o: off, ...(d.c ? { c: pt(d.c) } : {}), ...(n ? { n: n.toArray() as V3 } : {}) };
  });
}

/** Why an editing command can't run on a mesh body (an imported STL). */
export const meshOnly = (action: string, name: string) => `${action}: "${name}" is a mesh (imported STL) — it can be moved, rotated, scaled, copied and exported, not edited`;
/** Why an editing command can't run on a mesh or a path. */
export const notEditable = (action: string, b: Body) =>
  b.kind === "path" ? `${action}: "${b.name}" is a path (open lines from a sketch) — it can be moved, rotated, scaled, copied and deleted, not edited` : meshOnly(action, b.name);

export const notMesh = (g: Geom): g is Shape => !isMesh(g);
/** Colour presets in the colour pop-up (common filament colours). */
export const LOOK_PRESETS = ["#f2f2f2", "#2b2b2b", "#9aa5b1", "#d93b3b", "#f4a259", "#e9c46a", "#4caf50", "#3b82f6", "#8e5bd8", "#ec6fb0"];

/** A Bodies panel swatch's inline style for a look (nothing = the CSS default for its kind). */
export function swatchStyle(l: Look): string {
  return (l.color ? `--sw: ${l.color};` : "") + (l.opacity !== undefined && l.opacity < 1 ? `opacity: ${Math.max(0.25, l.opacity)};` : "");
}

/** A body made from `from` (a copy, extruded, split off...) has its colour / opacity. */
export function withLookOf<T extends Body>(made: T, from: Body): T {
  return from.look ? { ...made, look: from.look } : made;
}

/** A copy of a Text tool letter is one too (its text can be edited, see TextRecord); of a gear, a gear (see GearRecord); it keeps its look. */
export function withTextOf<T extends Body>(made: T, from: Body): T {
  const gear = from.gear ? { ...made, gear: from.gear } : made;
  const pic = from.picture ? { ...gear, picture: from.picture } : gear; // (a copy of a picture shows it too)
  return withLookOf(from.text ? { ...pic, text: from.text } : pic, from);
}

/** A new body made from `from` (extruded, cut off, split off...) goes in the same group, with the same look. */
export function inGroupOf<T extends Body>(made: T, from: Body): T {
  return withLookOf(from.group ? { ...made, group: from.group } : made, from);
}

/** Names flat faces get automatically ("Circle 3", "Face 1"...): a solid pushed from one is called "Solid N" instead. */
export const AUTO_FACE_NAME = /^(Rectangle|Circle|Polygon|Text|Face|Sketch|Ring)( \d+)?$/;

/** The solid a flat face object was pushed / pulled into: its group, and the name the user gave it. */
export function extrudedFrom<T extends Body>(made: T, face: Body): T {
  const named = AUTO_FACE_NAME.test(face.name) ? made : { ...made, name: face.name };
  const { picture: _, ...solid } = withTextOf(inGroupOf(named, face), face); // (a picture stays on its face)
  return solid as T;
}
