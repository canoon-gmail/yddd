/**
 * Document model: an ordered list of immutable bodies plus undo/redo history.
 * Every edit produces a new snapshot (array of Body); bodies and their shapes
 * are never mutated, so snapshots can share them.
 */
import { isMesh, type Geom, type Shape, type TriMesh, type V3, type Wire } from "./kernel";

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
  /** Group it was added in (more than 4 guides from one Guide tool run): listed together in the Bodies panel. */
  readonly group?: string;
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

/**
 * How a Text tool letter was made, so its text can be edited again (T with the text selected): the settings and
 * the plane it was written on (`origin` on the first line's baseline). Each letter of the text carries the same one.
 */
export interface TextRecord {
  readonly text: string;
  /** A built-in font's key or a system font's file; "" = Noto Sans. */
  readonly font: string;
  readonly height: number;
  readonly align: "left" | "center" | "right";
  readonly letterSpacing: number;
  readonly lineSpacing: number;
  readonly frame: { readonly origin: V3; readonly x: V3; readonly y: V3; readonly z: V3 };
}

/** How a body looks on screen (the swatch in the Bodies panel). Unset = its group's, else the default. */
export interface Look {
  /** "#rrggbb". */
  readonly color?: string;
  /** 0.1..1 (1 = solid). */
  readonly opacity?: number;
}

/** Group looks by group name (members without a look of their own take the group's). */
export type GroupLooks = Readonly<Record<string, Look>>;

interface BodyBase {
  readonly id: number;
  readonly name: string;
  /** Group it belongs to (by name; one level, shown together in the Bodies panel). */
  readonly group?: string;
  /** Its own colour / opacity (each one unset = the group's, see GroupLooks). */
  readonly look?: Look;
  /** A Text tool letter (flat, or pushed into a solid): how it was made. */
  readonly text?: TextRecord;
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

/** An open path (lines / arcs end to end, from a sketch): moved, rotated, scaled, copied — Sweep runs a face along it. */
export interface PathBody extends BodyBase {
  readonly kind: "path";
  readonly shape: Wire;
}

export type Body = ShapeBody | MeshBody | PathBody;

/** A solid or flat face: exact B-rep geometry that the modelling operations work on. */
export const isBrep = (b: Body): b is ShapeBody => b.kind === "solid" || b.kind === "face";

/** A body's content without its id / name (what makeBody and reset take). */
export type BodyGeom = { kind: "solid" | "face"; shape: Shape } | { kind: "mesh"; shape: TriMesh } | { kind: "path"; shape: Wire };

/**
 * How an Array copy was made, so it can be changed later (select the group, Array copy): `copies`
 * row by row (row k = 1..n, one per source), `offsets` along the direction's axis for the sources
 * (k = 0) and each row, `span` the edge / path it was spread along (if any).
 */
export interface ArrayRecord {
  readonly group: string;
  readonly sources: readonly number[];
  readonly copies: readonly number[];
  readonly n: number;
  readonly gap: number;
  readonly total: number;
  readonly dir: number;
  readonly centre: number;
  readonly offsets: readonly number[];
  readonly span?: { readonly axis: number; readonly a: number; readonly b: number };
  /**
   * Made by Circular copy instead (gap / total / dir / centre / offsets unused): round `axis`
   * (`name` as it was picked), `angle` in all, copies turned or not; `boxes` = each source's as it
   * was made (to tell how far the group moved since; older files: each copy's too, after them).
   */
  readonly circular?: {
    readonly axis: { readonly origin: V3; readonly dir: V3 };
    readonly name: string;
    readonly angle: number;
    readonly turn: number;
    readonly boxes: readonly (readonly [V3, V3])[];
    /** The sources' centre it went round from (copies not turned move by where it went); older files: from `boxes`. */
    readonly centre?: V3;
  };
}

type Snapshot = readonly Body[];
export interface HistoryEntry {
  bodies: Snapshot;
  guides: readonly Guide[];
  dims: readonly Dimension[];
  arrays: readonly ArrayRecord[];
  looks: GroupLooks;
  label: string;
}

const MAX_HISTORY = 200;

export class Doc {
  private snapshot: Snapshot = [];
  private guideList: readonly Guide[] = [];
  private dimList: readonly Dimension[] = [];
  private arrayList: readonly ArrayRecord[] = [];
  private lookMap: GroupLooks = {};
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

  /** Array copies that can still be changed (see ArrayRecord); records whose sources are gone are dropped. */
  get arrays(): readonly ArrayRecord[] {
    return this.arrayList;
  }

  /** Group colours / opacities (see GroupLooks); groups no object is in any more are dropped. */
  get groupLooks(): GroupLooks {
    return this.lookMap;
  }

  /** What a body looks like (see lookOf). */
  lookOf(b: Body): Look {
    return lookOf(b, this.lookMap);
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
  makeBody(shape: Wire, baseName: string, kind: "path"): PathBody;
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

  /**
   * Linked copies (set by the app; it needs the kernel): one object of an array / circular copy
   * changed (fillet, push/pull, scale...) → every copy in its group changes the same way. Applied in
   * the same step as the change; null = nothing to follow.
   */
  linkCopies: ((prev: Snapshot, next: Snapshot, arrays: readonly ArrayRecord[], label: string) => { bodies: Snapshot; arrays: readonly ArrayRecord[] } | null) | null = null;

  commit(next: Snapshot, label: string, guides: readonly Guide[] = this.guideList, dims: readonly Dimension[] = this.dimList, arrays: readonly ArrayRecord[] = this.arrayList, looks: GroupLooks = this.lookMap): void {
    const linked = this.linkCopies && next !== this.snapshot && arrays.length ? this.linkCopies(this.snapshot, next, arrays, label) : null;
    if (linked) ({ bodies: next, arrays } = linked);
    dims = this.relinked(dims, next);
    this.undoStack.push(this.entry(label));
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.snapshot = next;
    this.guideList = guides;
    this.dimList = dims;
    this.arrayList = liveArrays(arrays, next);
    this.lookMap = liveLooks(looks, next);
    this.dirty = true;
    this.version++;
    this.emit();
  }

  /** Fold a change into the last undo step (e.g. placing a fresh copy right after Duplicate). */
  amend(next: Snapshot): void {
    if (!this.undoStack.length) return this.commit(next, "Edit");
    this.redoStack = [];
    this.dimList = this.relinked(this.dimList, next);
    this.arrayList = liveArrays(this.arrayList, next);
    this.lookMap = liveLooks(this.lookMap, next);
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

  /** The current state as a history entry. */
  private entry(label: string): HistoryEntry {
    return { bodies: this.snapshot, guides: this.guideList, dims: this.dimList, arrays: this.arrayList, looks: this.lookMap, label };
  }

  private restoreEntry(e: HistoryEntry): void {
    this.snapshot = e.bodies;
    this.guideList = e.guides;
    this.dimList = e.dims;
    this.arrayList = e.arrays;
    this.lookMap = e.looks;
  }

  /** The step Undo / Redo would go to (its bodies and label), without going. */
  peek(which: "undo" | "redo"): HistoryEntry | null {
    return (which === "undo" ? this.undoStack : this.redoStack).at(-1) ?? null;
  }

  undo(): string | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push(this.entry(entry.label));
    this.restoreEntry(entry);
    this.dirty = true;
    this.version++;
    this.emit();
    return entry.label;
  }

  redo(): string | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push(this.entry(entry.label));
    this.restoreEntry(entry);
    this.dirty = true;
    this.version++;
    this.emit();
    return entry.label;
  }

  /**
   * Start over with the given bodies (used by New / Open). Clears history. A dimension's `body` here
   * is an index into `bodies` (as saved in a file), turned into that body's new id.
   */
  reset(bodies: (BodyGeom & { name: string; group?: string; text?: TextRecord; look?: Look })[] = [], filePath: string | null = null, guides: readonly Guide[] = [], dims: readonly Dimension[] = [], arrays: readonly ArrayRecord[] = [], looks: GroupLooks = {}): void {
    this.guideList = guides;
    this.counters.clear();
    this.nextId = 1;
    this.snapshot = bodies.map((b) => ({ ...b, id: this.nextId++ }));
    const idOf = (i: number) => this.snapshot[i]?.id ?? -1;
    this.dimList = dims.map(({ body, ...d }) => (body !== undefined && this.snapshot[body] ? { ...d, body: this.snapshot[body].id } : d));
    this.arrayList = liveArrays(arrays.map((r) => ({ ...r, sources: r.sources.map(idOf), copies: r.copies.map(idOf) })), this.snapshot);
    this.lookMap = liveLooks(looks, this.snapshot);
    this.undoStack = [];
    this.redoStack = [];
    this.filePath = filePath;
    this.dirty = false;
    this.version++;
    this.emit();
  }

  /** Undo / redo history (oldest first), the naming counters and the next id: what a file saves to keep undo working. */
  history(): { undo: readonly HistoryEntry[]; redo: readonly HistoryEntry[]; counters: [string, number][]; nextId: number } {
    return { undo: this.undoStack, redo: this.redoStack, counters: [...this.counters], nextId: this.nextId };
  }

  /**
   * Open a saved state with its history (ids as saved, so the steps fit together). Like `reset`, it
   * counts as unchanged.
   */
  restore(current: HistoryEntry, h: { undo: HistoryEntry[]; redo: HistoryEntry[]; counters: [string, number][]; nextId: number }, filePath: string | null): void {
    this.restoreEntry(current);
    this.undoStack = h.undo;
    this.redoStack = h.redo;
    this.counters = new Map(h.counters);
    const ids = [current, ...h.undo, ...h.redo].flatMap((e) => e.bodies.map((b) => b.id));
    this.nextId = Math.max(h.nextId, ...ids.map((id) => id + 1), 1);
    this.filePath = filePath;
    this.dirty = false;
    this.version++;
    this.emit();
  }
}

/** Array records whose sources are all still there (the copies may be gone: then it can't be changed, see main). */
function liveArrays(arrays: readonly ArrayRecord[], bodies: Snapshot): readonly ArrayRecord[] {
  if (!arrays.length) return arrays;
  const ids = new Set(bodies.map((b) => b.id));
  const live = arrays.filter((r) => r.sources.every((id) => ids.has(id)));
  return live.length === arrays.length ? arrays : live;
}

/** What a body looks like: its own colour / opacity, each one unset → its group's. */
export function lookOf(b: Body, looks: GroupLooks): Look {
  const g = b.group ? looks[b.group] : undefined;
  if (!g) return b.look ?? {};
  return { color: b.look?.color ?? g.color, opacity: b.look?.opacity ?? g.opacity };
}

/** Group looks of groups that still have members. */
function liveLooks(looks: GroupLooks, bodies: Snapshot): GroupLooks {
  const names = Object.keys(looks);
  if (!names.length) return looks;
  const used = new Set(bodies.map((b) => b.group));
  return names.every((g) => used.has(g)) ? looks : Object.fromEntries(names.filter((g) => used.has(g)).map((g) => [g, looks[g]]));
}

/** `b` with new geometry (same id / name). A face body may become a solid (push/pull); a mesh stays a mesh. */
export function withShape(b: Body, shape: Geom): Body {
  if ((b.kind === "mesh") !== isMesh(shape)) throw new Error(`${b.name}: a mesh and a solid cannot replace each other`);
  return { ...b, shape } as Body;
}
