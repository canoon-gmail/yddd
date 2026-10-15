/**
 * Document model: an ordered list of immutable bodies plus undo/redo history.
 * Every edit produces a new snapshot (array of Body); bodies and their shapes
 * are never mutated, so snapshots can share them.
 */
import type { BodyKind, Shape } from "./kernel";

export interface Body {
  readonly id: number;
  readonly name: string;
  /** "solid" = closed 3D body, "face" = flat planar face (extrude it with Push/Pull). */
  readonly kind: BodyKind;
  readonly shape: Shape;
}

type Snapshot = readonly Body[];
interface HistoryEntry {
  bodies: Snapshot;
  label: string;
}

const MAX_HISTORY = 200;

export class Doc {
  private snapshot: Snapshot = [];
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private nextId = 1;
  private counters = new Map<string, number>();
  private listeners = new Set<() => void>();

  filePath: string | null = null;
  dirty = false;

  get bodies(): Snapshot {
    return this.snapshot;
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

  /** Create a new (not yet committed) body with an auto-generated name. */
  makeBody(shape: Shape, baseName: string, kind: BodyKind = "solid"): Body {
    const n = (this.counters.get(baseName) ?? 0) + 1;
    this.counters.set(baseName, n);
    return { id: this.nextId++, name: `${baseName} ${n}`, kind, shape };
  }

  commit(next: Snapshot, label: string): void {
    this.undoStack.push({ bodies: this.snapshot, label });
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.snapshot = next;
    this.dirty = true;
    this.emit();
  }

  /** Replace some bodies' shapes (keeping id/name) in one undoable step. */
  replaceShapes(shapes: Map<number, Shape>, label: string): void {
    this.commit(
      this.snapshot.map((b) => (shapes.has(b.id) ? { ...b, shape: shapes.get(b.id)! } : b)),
      label,
    );
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): string | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push({ bodies: this.snapshot, label: entry.label });
    this.snapshot = entry.bodies;
    this.dirty = true;
    this.emit();
    return entry.label;
  }

  redo(): string | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push({ bodies: this.snapshot, label: entry.label });
    this.snapshot = entry.bodies;
    this.dirty = true;
    this.emit();
    return entry.label;
  }

  /** Start over with the given bodies (used by New / Open). Clears history. */
  reset(bodies: { name: string; kind: BodyKind; shape: Shape }[] = [], filePath: string | null = null): void {
    this.counters.clear();
    this.nextId = 1;
    this.snapshot = bodies.map((b) => ({ id: this.nextId++, name: b.name, kind: b.kind, shape: b.shape }));
    this.undoStack = [];
    this.redoStack = [];
    this.filePath = filePath;
    this.dirty = false;
    this.emit();
  }
}
