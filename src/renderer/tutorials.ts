/**
 * Help walkthroughs (Bird House, Cable Storage Box...): each step says which keys to press and can
 * also be performed for you (one undo step each), with the same kernel operations the tools use.
 */
import type { Frame, Shape, V3 } from "./kernel";
import type { Body, Doc } from "./document";

/** Bodies made by earlier steps, by role ("base", "house"...). */
export type TutCtx = Map<string, number>;

export interface TutStep {
  title: string;
  /** What to do in y3d (HTML: keys in <kbd>). */
  how: string;
  /** Do the step on `doc` (one commit, named `label`). Throws if the bodies it needs are gone. */
  run(doc: Doc, ctx: TutCtx, label: string): void;
}

export interface Tutorial {
  title: string;
  steps: TutStep[];
}

export const GROUND: Frame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** The body that plays `role`; throws (shown as a toast) if the user deleted or replaced it. */
export function roleBody(doc: Doc, ctx: TutCtx, role: string): Body & { shape: Shape } {
  const b = doc.get(ctx.get(role) ?? -1);
  if (!b || (b.kind !== "solid" && b.kind !== "face")) throw new Error(`The ${role} is missing — go Back or start again`);
  return b;
}

/** Id of the flat face whose normal is `n` (and, if given, whose centre passes `test`). */
export function faceWith(shape: Shape, n: V3, test: (c: V3) => boolean = () => true): number {
  const f = shape.faces.find((f) => {
    if (f.geomType !== "PLANE") return false;
    const m = f.normalAt().normalized().toTuple();
    return m.every((k, i) => Math.abs(k - n[i]) < 1e-6) && test(f.center.toTuple() as V3);
  });
  if (!f) throw new Error("Face not found — go Back or start again");
  return f.hashCode;
}

/** Replace one body's shape (one commit). */
export function replaceShape(doc: Doc, id: number, shape: Shape, label: string): void {
  doc.commit(doc.bodies.map((b) => (b.id === id ? ({ ...b, shape } as Body) : b)), label);
}

/** Add a new solid playing `role` (one commit). */
export function addSolid(doc: Doc, ctx: TutCtx, role: string, shape: Shape, name: string, label: string): void {
  const b = doc.makeBody(shape, name);
  ctx.set(role, b.id);
  doc.commit([...doc.bodies, b], label);
}
