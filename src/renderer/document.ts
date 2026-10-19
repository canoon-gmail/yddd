/**
 * Document model: an ordered list of immutable bodies plus undo/redo history.
 * Every edit produces a new snapshot (array of Body); bodies and their shapes
 * are never mutated, so snapshots can share them.
 */
import { isMesh, type Geom, type Shape, type TriMesh, type V3 } from "./kernel";

/** A construction (guide) line: a snap target only, not geometry. */
export interface Guide {
  readonly a: V3;
  readonly b: V3;
  /**
   * Normal of the plane Cut uses along this guide, fixed when the guide is drawn (the face it
   * lies on, or the view it was drawn in). At cut time a flat face the guide then lies on wins
   * unless this already runs straight across it. Missing in older files: worked out at cut time.
   */
  readonly n?: V3;
}

/**
 * A length dimension: the distance between `a` and `b` (e.g. an edge's ends), drawn along a line
 * shifted from them by `o` (perpendicular to a–b), with extension lines back to `a` and `b`.
 * With `body`, a–b is a straight edge of that body: when the body changes, the dimension follows
 * the edge (see Doc.relinkDims); without it (or once the edge is gone) it stays where it is.
 */
export interface Dimension {
  readonly a: V3;
  readonly b: V3;
  readonly o: V3;
  readonly body?: number;
  /**
   * "radius": a circle's / arc's radius — `a` its centre, `b` a point on it, `n` its axis (`o` unused);
   * with `body` it follows that circle.
   * "angle": the angle at `b` between b→a and b→`c`, drawn as an arc of radius `r` round `b` (`o` unused).
   */
  readonly kind?: "radius" | "angle";
  readonly n?: V3;
  readonly c?: V3;
  readonly r?: number;
}

interface BodyBase {
  readonly id: number;
  readonly name: string;
}

/** "solid" = closed 3D body, "face" = flat planar face (extrude it with Push/Pull). */
export interface ShapeBody extends BodyBase {
  readonly kind: "solid" | "face";
  readonly shape: Shape;
}

/** An imported triangle mesh (STL): moved, rotated, scaled, copied and exported, but not edited. */
export interface MeshBody extends BodyBase {
  readonly kind: "mesh";
  readonly shape: TriMesh;
}

export type Body = ShapeBody | MeshBody;

/** A body's content without its id / name (what makeBody and reset take). */
export type BodyGeom = { kind: "solid" | "face"; shape: Shape } | { kind: "mesh"; shape: TriMesh };

type Snapshot = readonly Body[];
interface HistoryEntry {
  bodies: Snapshot;
  guides: readonly Guide[];
  dims: readonly Dimension[];
  label: string;
}

const MAX_HISTORY = 200;

export class Doc {
  private snapshot: Snapshot = [];
  private guideList: readonly Guide[] = [];
  private dimList: readonly Dimension[] = [];
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private nextId = 1;
  private counters = new Map<string, number>();
  private listeners = new Set<() => void>();

  filePath: string | null = null;
  dirty = false;
  /** Bumped on every change (commit, undo, redo, amend, reset). */
  version = 0;

  get bodies(): Snapshot {
    return this.snapshot;
  }

  get guides(): readonly Guide[] {
    return this.guideList;
  }

  /** Replace the guide lines in one undoable step. */
  setGuides(next: readonly Guide[], label: string): void {
    this.commit(this.snapshot, label, next);
  }

  get dimensions(): readonly Dimension[] {
    return this.dimList;
  }

  /** Replace the dimensions in one undoable step. */
  setDimensions(next: readonly Dimension[], label: string): void {
    this.commit(this.snapshot, label, this.guideList, next);
  }

  get(id: number): Body | undefined {
    return this.snapshot.find((b) => b.id === id);
  }

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Next auto-generated name for `baseName` ("Solid 3"). */
  nextName(baseName: string): string {
    const n = (this.counters.get(baseName) ?? 0) + 1;
    this.counters.set(baseName, n);
    return `${baseName} ${n}`;
  }

  /** Create a new (not yet committed) body with an auto-generated name. */
  makeBody(shape: Shape, baseName: string, kind?: "solid" | "face"): ShapeBody;
  makeBody(shape: TriMesh, baseName: string, kind: "mesh"): MeshBody;
  makeBody(shape: Geom, baseName: string, kind: Body["kind"]): Body;
  makeBody(shape: Geom, baseName: string, kind: Body["kind"] = "solid"): Body {
    const n = (this.counters.get(baseName) ?? 0) + 1;
    this.counters.set(baseName, n);
    return { id: this.nextId++, name: `${baseName} ${n}`, kind, shape } as Body;
  }

  /**
   * Re-find the edges of linked dimensions after bodies change (set by the app; it needs the
   * kernel). Applied in the same step as the change, so undo / redo keep them in step.
   */
  relinkDims: ((dims: readonly Dimension[], prev: Snapshot, next: Snapshot) => readonly Dimension[]) | null = null;

  private relinked(dims: readonly Dimension[], next: Snapshot): readonly Dimension[] {
    return this.relinkDims && next !== this.snapshot && dims.some((d) => d.body !== undefined) ? this.relinkDims(dims, this.snapshot, next) : dims;
  }

  commit(next: Snapshot, label: string, guides: readonly Guide[] = this.guideList, dims: readonly Dimension[] = this.dimList): void {
    dims = this.relinked(dims, next);
    this.undoStack.push({ bodies: this.snapshot, guides: this.guideList, dims: this.dimList, label });
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.snapshot = next;
    this.guideList = guides;
    this.dimList = dims;
    this.dirty = true;
    this.version++;
    this.emit();
  }

  /** Fold a change into the last undo step (e.g. placing a fresh copy right after Duplicate). */
  amend(next: Snapshot): void {
    if (!this.undoStack.length) return this.commit(next, "Edit");
    this.redoStack = [];
    this.dimList = this.relinked(this.dimList, next);
    this.snapshot = next;
    this.dirty = true;
    this.version++;
    this.emit();
  }

  /** Replace some bodies' shapes (keeping id/name) in one undoable step. A mesh body only takes a mesh. */
  replaceShapes(shapes: Map<number, Geom>, label: string): void {
    this.commit(this.snapshot.map((b) => (shapes.has(b.id) ? withShape(b, shapes.get(b.id)!) : b)), label);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Label of the step Undo would take back, if any. */
  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }

  undo(): string | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push({ bodies: this.snapshot, guides: this.guideList, dims: this.dimList, label: entry.label });
    this.snapshot = entry.bodies;
    this.guideList = entry.guides;
    this.dimList = entry.dims;
    this.dirty = true;
    this.version++;
    this.emit();
    return entry.label;
  }

  redo(): string | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push({ bodies: this.snapshot, guides: this.guideList, dims: this.dimList, label: entry.label });
    this.snapshot = entry.bodies;
    this.guideList = entry.guides;
    this.dimList = entry.dims;
    this.dirty = true;
    this.version++;
    this.emit();
    return entry.label;
  }

  /**
   * Start over with the given bodies (used by New / Open). Clears history. A dimension's `body` here
   * is an index into `bodies` (as saved in a file), turned into that body's new id.
   */
  reset(bodies: (BodyGeom & { name: string })[] = [], filePath: string | null = null, guides: readonly Guide[] = [], dims: readonly Dimension[] = []): void {
    this.guideList = guides;
    this.counters.clear();
    this.nextId = 1;
    this.snapshot = bodies.map((b) => ({ ...b, id: this.nextId++ }));
    this.dimList = dims.map(({ body, ...d }) => (body !== undefined && this.snapshot[body] ? { ...d, body: this.snapshot[body].id } : d));
    this.undoStack = [];
    this.redoStack = [];
    this.filePath = filePath;
    this.dirty = false;
    this.version++;
    this.emit();
  }
}

/** `b` with new geometry (same id / name). A face body may become a solid (push/pull); a mesh stays a mesh. */
export function withShape(b: Body, shape: Geom): Body {
  if ((b.kind === "mesh") !== isMesh(shape)) throw new Error(`${b.name}: a mesh and a solid cannot replace each other`);
  return { ...b, shape } as Body;
}
