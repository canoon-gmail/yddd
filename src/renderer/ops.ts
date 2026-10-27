/** The operation panel's types: an op's fields, drag handles, choices and what its preview / commit give. */
import type * as THREE from "three";
import type { Shape, V3 } from "./kernel";
import type { ShownDimension } from "./viewport";

export interface OpField {
  key: string;
  label: string;
  /** Number value, or 0/1 for checkboxes. */
  value: number;
  step?: number;
  min?: number;
  /** "select": `value` is the index into `options`. */
  type?: "number" | "checkbox" | "select";
  /** Greyed out (can't be changed) while this is true of the panel's values — e.g. a field another one overrides. */
  off?: (values: Record<string, number>) => boolean;
  options?: string[];
  /**
   * A % field that also takes sizes: the size (mm) at 100 % — then "+10mm" / "-10mm" (that much
   * bigger / smaller), "60mm" (that size) and "+10%" / "-10%" work besides a plain %.
   */
  mm?: number;
}

/** A % field's text (see OpField.mm) as a %; NaN if it isn't one of the forms. */
export function parsePercent(text: string, mm?: number): number {
  const m = /^([+-]?)(\d*\.?\d+)(mm|%)?$/.exec(text.trim().toLowerCase().replace(/\s+/g, ""));
  if (!m) return NaN;
  const [, sign, num, unit] = m, n = Number(num) * (sign === "-" ? -1 : 1);
  if (unit === "mm") return mm && mm > 1e-9 ? ((sign ? mm + n : n) / mm) * 100 : NaN;
  return unit === "%" && sign ? 100 + n : n;
}

export type OpInput = HTMLInputElement | HTMLSelectElement;

/** Result of a parametric operation: what to preview and how to commit it. */
export interface OpOutcome {
  /** Shapes to preview, keyed by the body they replace (unknown/negative keys = new bodies). */
  ghost: Map<number, Shape>;
  /** Measurements on the preview (what the panel's numbers come to), shown while it is. */
  dims?: ShownDimension[];
  /**
   * Instead of `ghost`: preview these bodies' current meshes through a transform (instant);
   * the exact result is then only built by `commit`, which may throw.
   */
  xform?: { ids: number[]; matrix: THREE.Matrix4 };
  /**
   * Instead of `ghost`: bodies on screen drawn through a matrix each (copies — an id may come several times;
   * `replaces`: the body itself, moved), see Viewport.showGhostPlaced. Instant; `commit` builds the real ones.
   */
  placed?: { id: number; matrix: THREE.Matrix4; replaces?: boolean }[];
  /** Bodies the result removes: hidden while it is previewed. */
  hide?: number[];
  /** Hide the selected edges' highlight while previewed (they change with it, e.g. a resized hole's rim). */
  hideSelection?: boolean;
  /** It worked, but not quite as asked (e.g. some edges left sharp): shown in the panel (Apply still works), with a button to set fields. */
  warn?: { text: string; action?: { label: string; set: Record<string, number> } };
  /** Apply to the document. Returns the body ids to select afterwards (`then`: run once the panel has closed). */
  commit(): { select: number[]; solidMode?: boolean; then?: () => void };
}

/**
 * Mouse-drag control: moving the mouse along `dir` (through `origin`) changes field `key`.
 * `unit` = world mm per unit of the field (default 1), e.g. for a percentage; `mul` names a
 * percentage field that also stretches the handle's distance (e.g. overall scale for an axis handle).
 * `look`/`color` style the handle; `line` draws a line from `origin` to it.
 */
export interface OpDrag {
  origin: V3;
  dir: V3;
  key: string;
  /** Smallest value the drag gives (e.g. a fillet radius can't reach 0). */
  min?: number;
  unit?: number;
  /** Shown with the value while dragging (default: % with a `unit`, else mm). */
  units?: string;
  mul?: string;
  look?: "arrow" | "box" | "ring";
  color?: string;
  line?: boolean;
  title?: string;
  /**
   * Shift while dragging sets the checkbox field `key` (off without Shift); while it's on, the
   * handle runs from `origin` along `dir` with `unit` instead (e.g. Scale about the centre, not the base).
   */
  shift?: { key: string; origin: V3; dir: V3; unit: number };
}

export interface OpSpec {
  title: string;
  label: string;
  fields: OpField[];
  compute(values: Record<string, number>): OpOutcome;
  /**
   * The same worked out in the background kernel (kernelWorker.ts), used once it has loaded: the app stays live
   * meanwhile and Esc stops it at once. `compute` stays for before that (and if it can't start).
   */
  computeAsync?(values: Record<string, number>): Promise<OpOutcome>;
  remember?(values: Record<string, number>): void;
  /** One or more drag handles (see OpDrag). */
  drag?: OpDrag | OpDrag[];
  /**
   * Instant approximate preview used while dragging when `compute` is slow (returns false if it
   * can't help for these values); the real preview follows once the drag pauses.
   */
  fastDrag?(values: Record<string, number>): boolean;
  /** Shown above the fields (HTML), e.g. what has been picked. */
  note?: string;
  /** Status bar hint instead of the usual one. */
  hint?: string;
  /** The op picks things in the viewport: a click there goes here (not to selection or Apply). */
  pick?(e: PointerEvent): void;
  /** With `pick`: the pointer moved over the viewport (e.g. light up what a click would pick). */
  hover?(e: PointerEvent): void;
  /** Its preview takes a while (e.g. a fillet round a gear's 171 edges: ~1 s): the panel shows first, "Working…", then the preview. */
  slow?: boolean;
  /** The op picks objects: a click on a row in the Bodies panel goes here (not to selection). */
  pickBody?(id: number): void;
  /** Labelled marks in the view to click (e.g. Array copy's ±X / ±Y / ±Z): see OpChoice. */
  choices?: OpChoice[];
  /** Caption of the apply button (default "Apply ⏎"). */
  applyLabel?: string;
}

/** A labelled mark at `at` (a faint line to it from `from`): a click sets field `key` to `value`; lit while it has it. */
export interface OpChoice {
  at: V3;
  from?: V3;
  key: string;
  value: number;
  label: string;
  color: string;
  title?: string;
}
/** Thrown by an op's compute while it waits for a pick (not a mistake): shown as a prompt, not in red. */
export class OpWaiting extends Error {}
export const dragsOf = (spec: OpSpec): OpDrag[] => (!spec.drag ? [] : Array.isArray(spec.drag) ? spec.drag : [spec.drag]);
