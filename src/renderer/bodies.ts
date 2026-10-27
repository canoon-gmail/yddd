/** Bodies made from other bodies: what they keep of them (look, text, group, name), and dimensions that follow them. */
import { isMesh, matchCircleEdge, matchStraightEdge, type Geom, type Shape } from "./kernel";
import { isBrep, type Body, type Dimension, type Look } from "./document";

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

/** A copy of a Text tool letter is one too (its text can be edited, see TextRecord); it keeps its look. */
export function withTextOf<T extends Body>(made: T, from: Body): T {
  return withLookOf(from.text ? { ...made, text: from.text } : made, from);
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
  return withTextOf(inGroupOf(named, face), face);
}
