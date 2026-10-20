/**
 * Y3D application controller: wires the document, viewport, tools,
 * operation panel, outliner, file I/O, keyboard shortcuts and native menu.
 */
import "./style.css";
import * as THREE from "three";
import {
  initKernel,
  curveBounds,
  isValidShape,
  faceEdgeIds,
  moveEdges,
  splitFaceByLine,
  splitFacesByPlane,
  cutFaceByPlane,
  edgeEnds,
  edgeBetween,
  canMoveEdges,
  edgeLoopFace,
  isEdgeLoop,
  MOVE_EDGE_REFUSED,
  errorMessage,
  filletEdges,
  filletDragAxis,
  chamferEdges,
  pushPull,
  pushPullMany,
  shellSolid,
  booleanOp,
  translateShape,
  rotateShape,
  cloneShape,
  serializeShape,
  deserialize,
  exportStep,
  exportStl,
  stlTriangleCount,
  type StlQuality,
  importStep,
  importStl,
  boundingSize,
  findFace,
  extrudeFace,
  seamEdgeIds,
  kindOf,
  faceAxis,
  planarFaceFrame,
  faceInfo,
  faceRefEdges,
  offsetFace,
  offsetRing,
  scaleShape,
  guidePlaneNormal,
  matchStraightEdge,
  matchCircleEdge,
  pushPullMoves,
  edgesAlong,
  asPreview,
  splitByPlane,
  offsetDragAxis,
  offsetEdges,
  offsetEdgesAxis,
  edgeOffsetFaces,
  faceLineEdges,
  revolveFace,
  revolveRefusal,
  sweepFace,
  profileOnPath,
  lineWire,
  type Axis,
  type V3,
  makeBox,
  makeCylinder,
  makeCircleFace,
  makeRectFace,
  sketchPath,
  solidPieces,
  solidVolume,
  shapesTouch,
  type Frame,
  type BodyKind,
  type BooleanOp,
  type Geom,
  type Shape,
  type Solid,
  type Wire,
  TriMesh,
  isMesh,
  parseStl,
} from "./kernel";
import { Doc, isBrep, withShape, type Body, type BodyGeom, type Dimension, type Guide, type ShapeBody } from "./document";
import { Viewport, sameItem, type SelItem, type SelMode, type TransformResult } from "./viewport";
import { BoxTool, CylinderTool, SphereTool, PolygonTool, PointMoveTool, GuideTool, DivideFaceTool, type EdgeSides, type Tool, type ToolHost, type PropField } from "./tools";
import { ICONS } from "./icons";
import { BIRD_HOUSE } from "./birdhouse";
import { CABLE_STORAGE_BOX } from "./cablebox";
import { HOUSE } from "./house";
import { PLANTER } from "./planter";
import { MeasureTool } from "./measure";
import { SketchTool } from "./sketch";
import type { TutCtx, Tutorial } from "./tutorials";

/** Linked dimensions follow their edge / circle into the bodies' new shapes (unlinked if it can't be found). */
function relinkDimensions(dims: readonly Dimension[], prev: readonly Body[], next: readonly Body[]): readonly Dimension[] {
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
const meshOnly = (action: string, name: string) => `${action}: "${name}" is a mesh (imported STL) — it can be moved, rotated, scaled, copied and exported, not edited`;
/** Why an editing command can't run on a mesh or a path. */
const notEditable = (action: string, b: Body) =>
  b.kind === "path" ? `${action}: "${b.name}" is a path (open lines from a sketch) — it can be moved, rotated, scaled, copied and deleted, not edited` : meshOnly(action, b.name);

const notMesh = (g: Geom): g is Shape => !isMesh(g);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number) => String(Math.round(n * 100) / 100);
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface OpField {
  key: string;
  label: string;
  /** Number value, or 0/1 for checkboxes. */
  value: number;
  step?: number;
  min?: number;
  /** "select": `value` is the index into `options`. */
  type?: "number" | "checkbox" | "select";
  options?: string[];
  /**
   * A % field that also takes sizes: the size (mm) at 100 % — then "+10mm" / "-10mm" (that much
   * bigger / smaller), "60mm" (that size) and "+10%" / "-10%" work besides a plain %.
   */
  mm?: number;
}

/** A % field's text (see OpField.mm) as a %; NaN if it isn't one of the forms. */
function parsePercent(text: string, mm?: number): number {
  const m = /^([+-]?)(\d*\.?\d+)(mm|%)?$/.exec(text.trim().toLowerCase().replace(/\s+/g, ""));
  if (!m) return NaN;
  const [, sign, num, unit] = m, n = Number(num) * (sign === "-" ? -1 : 1);
  if (unit === "mm") return mm && mm > 1e-9 ? ((sign ? mm + n : n) / mm) * 100 : NaN;
  return unit === "%" && sign ? 100 + n : n;
}

type OpInput = HTMLInputElement | HTMLSelectElement;

/** Result of a parametric operation: what to preview and how to commit it. */
interface OpOutcome {
  /** Shapes to preview, keyed by the body they replace (unknown/negative keys = new bodies). */
  ghost: Map<number, Shape>;
  /**
   * Instead of `ghost`: preview these bodies' current meshes through a transform (instant);
   * the exact result is then only built by `commit`, which may throw.
   */
  xform?: { ids: number[]; matrix: THREE.Matrix4 };
  /** Apply to the document. Returns the body ids to select afterwards (`then`: run once the panel has closed). */
  commit(): { select: number[]; solidMode?: boolean; then?: () => void };
}

/**
 * Mouse-drag control: moving the mouse along `dir` (through `origin`) changes field `key`.
 * `unit` = world mm per unit of the field (default 1), e.g. for a percentage; `mul` names a
 * percentage field that also stretches the handle's distance (e.g. overall scale for an axis handle).
 * `look`/`color` style the handle; `line` draws a line from `origin` to it.
 */
interface OpDrag {
  origin: V3;
  dir: V3;
  key: string;
  /** Smallest value the drag gives (e.g. a fillet radius can't reach 0). */
  min?: number;
  unit?: number;
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

interface OpSpec {
  title: string;
  label: string;
  fields: OpField[];
  compute(values: Record<string, number>): OpOutcome;
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
}

/** A new body made from `from` (extruded, cut off, split off...) goes in the same group. */
function inGroupOf<T extends Body>(made: T, from: Body): T {
  return from.group ? { ...made, group: from.group } : made;
}

/** Names flat faces get automatically ("Circle 3", "Face 1"...): a solid pushed from one is called "Solid N" instead. */
const AUTO_FACE_NAME = /^(Rectangle|Circle|Polygon|Face|Sketch|Ring)( \d+)?$/;

/** The solid a flat face object was pushed / pulled into: its group, and the name the user gave it. */
function extrudedFrom<T extends Body>(made: T, face: Body): T {
  const named = AUTO_FACE_NAME.test(face.name) ? made : { ...made, name: face.name };
  return inGroupOf(named, face);
}

/** Menu command prefix for File → Open Recent (the file's path follows). */
const OPEN_RECENT = "file.openRecent:";

/** Thrown by an op's compute while it waits for a pick (not a mistake): shown as a prompt, not in red. */
class OpWaiting extends Error {}

/** What Sweep runs along: a path object or a guide line (its index). */
type Spine = { path: number } | { guide: number };

/** Op previews slower than this (ms) are not redone on every drag frame. */
const SLOW_PREVIEW_MS = 60;

const dragsOf = (spec: OpSpec): OpDrag[] => (!spec.drag ? [] : Array.isArray(spec.drag) ? spec.drag : [spec.drag]);

interface ToolbarItem {
  cmd: string;
  icon: string;
  label: string;
  key?: string;
}

const TOOLBAR: { title: string; items: ToolbarItem[]; drawer?: boolean }[] = [
  {
    title: "Select",
    items: [
      { cmd: "mode.body", icon: "solid", label: "Solid", key: "1" },
      { cmd: "mode.face", icon: "face", label: "Face", key: "2" },
      { cmd: "mode.edge", icon: "edge", label: "Edge", key: "3" },
    ],
  },
  {
    title: "Solid",
    drawer: true,
    items: [
      { cmd: "tool.box", icon: "box", label: "Box", key: "B B" },
      { cmd: "tool.cylinder", icon: "cylinder", label: "Cylinder", key: "B C" },
      { cmd: "tool.sphere", icon: "sphere", label: "Sphere", key: "B S" },
    ],
  },
  {
    title: "Face",
    drawer: true,
    items: [
      { cmd: "tool.rectangle", icon: "rectangle", label: "Rectangle", key: "A" },
      { cmd: "tool.circle", icon: "circle", label: "Circle", key: "A C" },
      { cmd: "tool.polygon", icon: "polygon", label: "Polygon", key: "A P" },
      { cmd: "tool.sketch", icon: "sketch", label: "Sketch", key: "K" },
    ],
  },
  {
    title: "Modify",
    drawer: true,
    items: [
      { cmd: "op.pushpull", icon: "pushpull", label: "Push/Pull", key: "P / Space" },
      { cmd: "op.fillet", icon: "fillet", label: "Fillet", key: "F" },
      { cmd: "op.chamfer", icon: "chamfer", label: "Chamfer", key: "Shift+F" },
      { cmd: "op.shell", icon: "shell", label: "Shell", key: "H" },
      { cmd: "op.offset", icon: "offset", label: "Offset", key: "O" },
      { cmd: "op.revolve", icon: "revolve", label: "Revolve", key: "Pro: R E" },
      { cmd: "op.sweep", icon: "sweep", label: "Sweep", key: "Pro: S W" },
      { cmd: "op.cut", icon: "cut", label: "Cut by guide", key: "C" },
      { cmd: "op.splitFace", icon: "cut", label: "Split face by guide", key: "Shift+C" },
      { cmd: "tool.divideFace", icon: "pencil", label: "Divide face", key: "L" },
      { cmd: "tool.guide", icon: "guide", label: "Guide line", key: "Shift+L" },
      { cmd: "edit.clearGuides", icon: "delete", label: "Clear guides", key: "" },
    ],
  },
  {
    title: "Boolean",
    drawer: true,
    items: [
      { cmd: "bool.union", icon: "union", label: "Union", key: "+ / Shift+U" },
      { cmd: "bool.subtract", icon: "subtract", label: "Subtract", key: "− / Shift+S" },
      { cmd: "bool.intersect", icon: "intersect", label: "Intersect", key: "Shift+I" },
    ],
  },
  {
    title: "Transform",
    drawer: true,
    items: [
      { cmd: "xf.move", icon: "move", label: "Move", key: "G" },
      { cmd: "xf.moveFrom", icon: "move", label: "Move from point", key: "Shift+G" },
      { cmd: "xf.rotate", icon: "rotate", label: "Rotate", key: "R" },
      { cmd: "xf.scale", icon: "scale", label: "Scale", key: "S" },
      { cmd: "xf.repeat", icon: "duplicate", label: "Repeat last", key: "Shift+R" },
      { cmd: "edit.duplicate", icon: "duplicate", label: "Duplicate", key: "Shift+D / Ctrl+D" },
    ],
  },
  {
    title: "Measure",
    items: [{ cmd: "tool.measure", icon: "measure", label: "Measure", key: "=" }],
  },
  {
    title: "Delete",
    items: [{ cmd: "edit.delete", icon: "delete", label: "Delete", key: "Del" }],
  },
  {
    title: "History",
    items: [
      { cmd: "edit.undo", icon: "undo", label: "Undo", key: "Ctrl+Z" },
      { cmd: "edit.redo", icon: "redo", label: "Redo", key: "Ctrl+R · Ctrl+Shift+Z" },
    ],
  },
  {
    title: "View",
    drawer: true,
    items: [
      { cmd: "view.fit", icon: "fit", label: "Fit", key: "Home" },
      { cmd: "view.iso", icon: "iso", label: "Iso", key: "5" },
      { cmd: "view.top", icon: "top", label: "Top", key: "7" },
      { cmd: "view.front", icon: "front", label: "Front", key: "Num 1" },
      { cmd: "view.right", icon: "right", label: "Right", key: "Num 3" },
      { cmd: "view.xray", icon: "xray", label: "X-ray", key: "Shift+X" },
    ],
  },
];

/** Commands that work during a sketch (anything else waits for Done / Cancel). */
const SKETCH_COMMANDS = new Set(["view.fit", "view.fitSelection", "view.xray", "view.pro", "help.shortcuts"]);

/** localStorage: Pro layout on ("1"); saves so far; the Pro tip was shown (or not needed). */
const PRO_KEY = "y3d.pro", SAVES_KEY = "y3d.saves", PRO_TIP_KEY = "y3d.proTip";
/** The right panel's width: localStorage key and limits (px). */
const SIDEBAR_KEY = "y3d.sidebarWidth", SIDEBAR_MIN = 180, SIDEBAR_MAX = 600;
/** The Pro layout tip comes with this save. */
const PRO_TIP_SAVES = 20;
const isPro = () => document.body.classList.contains("pro");

const KEYMAP: Record<string, string> = {
  "1": "mode.body",
  "2": "mode.face",
  "3": "mode.edge",
  b: "tool.box",
  a: "tool.rectangle",
  k: "tool.sketch",
  p: "op.pushpull",
  Space: "op.pushpull",
  f: "op.fillet",
  "Shift+F": "op.chamfer",
  h: "op.shell",
  o: "op.offset",
  c: "op.cut",
  g: "xf.move",
  "Shift+G": "xf.moveFrom",
  l: "tool.divideFace",
  "Shift+L": "tool.guide",
  "Shift+C": "op.splitFace",
  "Shift+R": "xf.repeat",
  r: "xf.rotate",
  s: "xf.scale",
  x: "edit.delete",
  Delete: "edit.delete",
  Home: "view.fit",
  "5": "view.iso",
  Numpad5: "view.iso",
  "7": "view.top",
  Numpad7: "view.top",
  Numpad1: "view.front", // top-row "1" stays Solid mode
  Numpad3: "view.right", // top-row "3" stays Edge mode
  ".": "view.fitSelection",
  "Shift+U": "bool.union",
  "Shift+S": "bool.subtract",
  NumpadAdd: "bool.union",
  NumpadSubtract: "bool.subtract",
  "+": "bool.union",
  "=": "tool.measure",
  "-": "bool.subtract",
  "Shift+I": "bool.intersect",
  v: "view.menu",
  "Shift+X": "view.xray",
  "Shift+D": "edit.duplicate",
  "?": "help.shortcuts",
};

/**
 * Two-key chords: the first key starts its tool at once; a second key within CHORD_MS switches tool.
 * B B box · B C cylinder · B S sphere — A rectangle · A C circle · A P polygon.
 */
const CHORDS: Record<string, Record<string, string>> = {
  b: { b: "tool.box", c: "tool.cylinder", s: "tool.sphere" },
  a: { a: "tool.rectangle", r: "tool.rectangle", c: "tool.circle", p: "tool.polygon" },
};
/** Pro layout only: S W sweep (S starts Scale, W switches) · R E revolve (R starts Rotate, E switches). */
const PRO_CHORDS: Record<string, Record<string, string>> = {
  s: { w: "op.sweep" },
  r: { e: "op.revolve" },
};
const CHORD_MS = 1500;

/** Toolbar commands that go into the recent strip (mode switches and undo/redo are always visible). */
const RECENT_ITEMS = new Map(TOOLBAR.filter((g) => g.title !== "Select" && g.title !== "History").flatMap((g) => g.items.map((it) => [it.cmd, it] as const)));
const RECENT_MAX = 10;
/** Face mode: how close (px) a click must be to a selected face's edge to switch to Edge mode. */
const FACE_EDGE_PICK_PX = 14;
/** v2: the strip saved before "tool.line" became "tool.divideFace" is dropped (see loadRecent). */
const RECENT_KEY = "y3d.recentCmds.v2";
const RECENT_KEY_OLD = "y3d.recentCmds";
/** Largest STL (triangles) imported as editable solids; bigger ones stay meshes. */
const STL_SOLID_MAX = 20000;

/** Last STL export quality (localStorage). */
const STL_QUALITY_KEY = "y3d.stlQuality";

function loadRecent(): string[] {
  localStorage.removeItem(RECENT_KEY_OLD);
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((c) => RECENT_ITEMS.has(c)).slice(-RECENT_MAX) : [];
  } catch {
    return [];
  }
}

const MODE_HINTS: Record<SelMode, string> = {
  body: "Solid mode: click to select solids (click again → face / edge), Shift+click to add.  Middle-drag or Alt+drag orbit · Shift+Left-drag pan · Wheel / two-finger slide zoom",
  face: "Face mode: click faces (P push/pull, H shell), click a selected face's edge → Edge mode.  Shift+click to add · Right-click a solid → Solid mode",
  edge: "Edge mode: click edges (F fillet, Shift+F chamfer, Shift+D guide line from edge — a closed loop of edges: a face copy).  Shift+click to add · Right-click a solid → Solid mode",
};

class App implements ToolHost {
  readonly doc = new Doc();
  readonly viewport: Viewport;

  private mode: SelMode = "body";
  private selection: SelItem[] = [];
  private hover: SelItem | null = null;
  private hidden = new Set<number>();
  private tool: Tool | null = null;
  /** Pending two-key chord (see CHORDS): its second-key map and when the first key was pressed. */
  private chord: { keys: Record<string, string>; at: number } | null = null;
  /** Toasts already shown when a chord's first key ran (its own, newer error toasts go if the chord goes on). */
  private chordToasts = new Set<Element>();
  /** An op's hover (see OpSpec.hover): one per frame, with the latest pointer position. */
  private opHoverQueued = false;
  private lastPointer: PointerEvent | null = null;
  private op: {
    spec: OpSpec;
    inputs: OpInput[];
    timer: number;
    result: OpOutcome | null;
    key: string;
    /** Drag reference: line parameter and field value when the mouse first moved. */
    anchor?: { x: number; y: number; v: number };
    /** Full-precision value of a snapped drag; used while the field still shows its rounded text. */
    exact?: { key: string; shown: string; value: number };
    dragQueued?: boolean;
    /** Index (into dragsOf(spec)) of the handle being dragged. */
    active?: number;
    /** How long the last preview took (ms); slow previews are only redone once the drag pauses. */
    previewMs?: number;
    dragTimer?: number;
  } | null = null;
  /** Move/rotate gizmo session; with `edges` it moves those edges (reshaping their solids) instead of whole bodies. */
  private xf: { mode: "translate" | "rotate"; ids: number[]; pivot?: V3; edges?: SelItem[]; guide?: number } | null = null;
  /** Latest edge-move drag offset waiting for its (once per frame) preview. */
  private edgePreview: V3 | null = null;
  /**
   * The last edge / guide move dragged with the gizmo and the document version right after it (and,
   * for edges, where they were and are), so Tab can show and replace it.
   */
  private lastEdgeMove: { v: V3; edges: SelItem[]; after: SelItem[]; version: number } | null = null;
  private lastGuideMove: { v: V3; guide: number; version: number } | null = null;
  private snap = 1;
  private downAt: { x: number; y: number } | null = null;
  private recent: string[] = loadRecent();
  private selEdgeCache: { sel: SelItem[]; edges: Map<number, Set<number>> } | null = null;
  private rightDownAt: { x: number; y: number } | null = null;
  private hoverQueued: PointerEvent | null = null;
  private defaults = { fillet: 1, chamfer: 1, pushpullNew: false, shell: 1, offset: 5, offsetRound: false, offsetRing: false, edgesWhich: 0, revolveAngle: 360, joinNew: false, sweepRound: 0, sweepTurn: 0 };

  private hudEl = $("hud");
  private hudAnchor: THREE.Vector3 | null = null;
  private handlesEl = $("op-handles");
  private linesEl = $("op-lines") as unknown as SVGSVGElement;
  private opPanel = $("op-panel");

  constructor() {
    document.body.classList.toggle("pro", localStorage.getItem(PRO_KEY) === "1");
    this.bindSidebarGrip();
    const container = $("viewport");
    this.viewport = new Viewport(container);
    this.viewport.onDimensionClick = (i) => this.selectDimension(i);
    this.doc.relinkDims = (dims, prev, next) => relinkDimensions(dims, prev, next);
    this.buildToolbar();
    this.buildCornerTools();
    this.renderRecent();
    this.bindViewportEvents();
    this.bindKeys();
    this.bindStatusBar();

    this.doc.onChange(() => this.onDocChange());
    this.doc.onChange(() => this.scheduleAutosave());
    window.y3d?.onMenu((cmd) => (cmd.startsWith(OPEN_RECENT) ? void this.openRecent(cmd.slice(OPEN_RECENT.length)) : this.run(cmd)));
    // Unsaved-changes prompt on close is handled by the main process (see setDirty);
    // a beforeunload handler would silently block closing in Electron.

    this.onDocChange();
    this.viewport.fit();
  }

  // ================================================================ ToolHost

  snapStep(e: { ctrlKey: boolean } | null): number {
    return e?.ctrlKey ? this.snap : 0; // snap only while Ctrl is held
  }

  hint(text: string): void {
    // Pro layout: just the first part of a hint ("Tool: what to do"), not the list of extras after it.
    $("status-hint").textContent = isPro() ? text.split(" · ")[0] : text;
  }

  /** Pro layout (Ctrl+Shift+F1, remembered): less help text — a one-row sketch panel, a small text-only Recent strip, short hints. */
  private togglePro(): void {
    const on = !isPro();
    document.body.classList.toggle("pro", on);
    localStorage.setItem(PRO_KEY, on ? "1" : "0");
    localStorage.setItem(PRO_TIP_KEY, "1"); // found it: no need for the tip
    this.toast(on ? "Pro layout — less text (Ctrl+Shift+F1 switches back)" : "Beginner layout — full help text (Ctrl+Shift+F1: Pro layout)");
    if (this.tool instanceof SketchTool) this.tool.refresh();
    else if (!this.tool && !this.op) this.refreshSelection();
  }

  /** The right panel's left edge: drag to resize it (remembered), double-click for the default width. */
  private bindSidebarGrip(): void {
    const grip = $("sidebar-grip"), side = $("sidebar");
    const set = (w: number) => {
      side.style.width = `${Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)))}px`; // (the viewport follows: it watches its size)
    };
    const saved = Number(localStorage.getItem(SIDEBAR_KEY));
    if (saved) set(saved);
    grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      grip.classList.add("drag");
      const x0 = e.clientX, w0 = side.getBoundingClientRect().width;
      const move = (m: PointerEvent) => set(w0 + x0 - m.clientX);
      const up = () => {
        grip.classList.remove("drag");
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        localStorage.setItem(SIDEBAR_KEY, String(side.getBoundingClientRect().width));
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
    });
    grip.addEventListener("dblclick", () => {
      side.style.width = "";
      localStorage.removeItem(SIDEBAR_KEY);
    });
  }

  /** Count saves; at the 20th, one tip about the Pro layout (once, and only if it's not on already). */
  private noteSaved(): void {
    const n = Number(localStorage.getItem(SAVES_KEY) ?? 0) + 1;
    localStorage.setItem(SAVES_KEY, String(n));
    if (n < PRO_TIP_SAVES || isPro() || localStorage.getItem(PRO_TIP_KEY)) return;
    localStorage.setItem(PRO_TIP_KEY, "1");
    this.toast("Tip: you're getting fast — try the Pro layout (Ctrl+Shift+F1, also in the View menu) for less text on screen", "info", 10000);
  }

  hud(text: string | null, at?: THREE.Vector3): void {
    if (!text || !at) {
      this.hudEl.hidden = true;
      this.hudAnchor = null;
      return;
    }
    this.hudEl.textContent = text;
    this.hudEl.hidden = false;
    this.hudAnchor = at.clone();
    this.positionHud();
  }

  /** World mm per field unit of `drag`, including its `mul` field. */
  private dragUnit(drag: OpDrag): number {
    const m = drag.mul && this.op?.inputs.find((i) => i.dataset.key === drag.mul);
    return ((this.dragShifted(drag) ? drag.shift!.unit : drag.unit) ?? 1) * (m ? (this.opNum(m) || 0) / 100 : 1);
  }

  /** An op field's number (a % field also takes sizes — see OpField.mm). */
  private opNum(i: OpInput): number {
    return i.dataset.mm !== undefined ? parsePercent(i.value, Number(i.dataset.mm)) : Number(i.value);
  }

  /** Whether the drag's Shift checkbox (see OpDrag.shift) is on. */
  private dragShifted(drag: OpDrag): boolean {
    const box = drag.shift && this.op?.inputs.find((i) => i.dataset.key === drag.shift!.key);
    return !!box && (box as HTMLInputElement).checked;
  }

  private dragOrigin(drag: OpDrag): V3 {
    return this.dragShifted(drag) ? drag.shift!.origin : drag.origin;
  }

  private dragDir(drag: OpDrag): V3 {
    return this.dragShifted(drag) ? drag.shift!.dir : drag.dir;
  }

  /** (Re)create one handle element per op drag, wired to start a drag on that handle. */
  private buildHandles(n: number): void {
    const c = this.viewport.canvas;
    this.handlesEl.innerHTML = "";
    for (let i = 0; i < n; i++) {
      const h = document.createElement("div");
      h.className = "op-handle";
      h.hidden = true;
      h.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || !this.op?.spec.drag) return;
        e.preventDefault();
        e.stopPropagation();
        h.setPointerCapture(e.pointerId);
        h.classList.add("dragging");
        this.op.anchor = undefined;
        this.op.active = i;
        this.opDrag(e);
      });
      h.addEventListener("pointermove", (e) => {
        if (h.hasPointerCapture(e.pointerId) && this.op?.spec.drag) {
          this.opDrag(e);
          this.positionHandle();
        }
      });
      const release = (e: PointerEvent) => {
        if (h.hasPointerCapture(e.pointerId)) h.releasePointerCapture(e.pointerId);
        this.viewport.showSnapMarker(null);
        h.classList.remove("dragging");
        if (this.op) this.op.anchor = undefined;
      };
      h.addEventListener("pointerup", release);
      h.addEventListener("pointercancel", release);
      h.addEventListener("wheel", (e) => c.dispatchEvent(new WheelEvent("wheel", e)), { passive: true });
      this.handlesEl.appendChild(h);
    }
  }

  /** Place each op drag handle at origin + dir * value, rotated to the axis' screen direction. */
  private positionHandle(): void {
    const drags = this.op ? dragsOf(this.op.spec) : [];
    if (this.handlesEl.childElementCount !== drags.length) this.buildHandles(drags.length);
    const r = $("viewport").getBoundingClientRect();
    let lines = "";
    drags.forEach((drag, i) => {
      const el = this.handlesEl.children[i] as HTMLElement;
      const input = this.op!.inputs.find((inp) => inp.dataset.key === drag.key);
      if (!input) {
        el.hidden = true;
        return;
      }
      const O = new THREE.Vector3(...this.dragOrigin(drag)), D = new THREE.Vector3(...this.dragDir(drag)).normalize();
      const P = O.clone().addScaledVector(D, (this.opNum(input) || 0) * this.dragUnit(drag));
      const s = this.viewport.toScreen(P), s1 = this.viewport.toScreen(P.clone().add(D));
      const look = drag.look ?? "arrow";
      const ang = Math.atan2(s1.y - s.y, s1.x - s.x) * (180 / Math.PI) + 90;
      el.className = `op-handle ${look}${el.classList.contains("dragging") ? " dragging" : ""}`;
      el.textContent = look === "arrow" ? "\u21D5" : "";
      el.title = drag.title ?? "Drag to change the value";
      el.style.setProperty("--c", drag.color ?? "#1e88ff");
      el.style.left = `${s.x - r.left}px`;
      el.style.top = `${s.y - r.top}px`;
      el.style.transform = look === "arrow" ? `rotate(${ang}deg)` : "";
      el.hidden = false;
      if (drag.line) {
        const o = this.viewport.toScreen(O);
        lines += `<line x1="${o.x - r.left}" y1="${o.y - r.top}" x2="${s.x - r.left}" y2="${s.y - r.top}" stroke="${drag.color ?? "#1e88ff"}" stroke-width="2" stroke-opacity="0.85"/>`;
      }
    });
    this.linesEl.innerHTML = lines;
  }

  private positionHud(): void {
    this.positionHandle();
    if (!this.hudAnchor) return;
    const s = this.viewport.toScreen(this.hudAnchor);
    const r = $("viewport").getBoundingClientRect();
    this.hudEl.style.left = `${s.x - r.left}px`;
    this.hudEl.style.top = `${s.y - r.top}px`;
  }

  finish(shape: Shape, baseName: string, kind: BodyKind): void {
    const body = this.doc.makeBody(shape, baseName, kind);
    this.endTool();
    this.doc.commit([...this.doc.bodies, body], `Create ${baseName}`);
    this.setMode("body");
    this.setSelection([{ kind: "body", body: body.id, id: 0 }]);
    this.toast(kind === "face" ? `${body.name} created — press P to push/pull it into a solid` : `${body.name} created`);
  }

  fail(e: unknown): void {
    this.toast(`Failed: ${errorMessage(e)}`, "error");
  }

  /** The open value dialog (Tab properties, STL quality), if any. */
  private valueDialog(): HTMLElement | null {
    return document.getElementById("props-dlg");
  }

  propsDialog(title: string, fields: PropField[], onOk: (values: number[]) => void, okLabel = "Create"): void {
    document.getElementById("props-dlg")?.remove();
    const dlg = document.createElement("form");
    dlg.id = "props-dlg";
    dlg.noValidate = true; // step is only for arrow keys; any value is allowed
    dlg.innerHTML =
      `<h4>${title}</h4>` +
      fields
        .map((f, i) => `<label><span>${f.label}</span><input type="number" data-i="${i}" value="${f.value}" step="${f.step ?? "any"}"${f.min !== undefined ? ` min="${f.min}"` : ""}></label>`)
        .join("") +
      `<div class="op-buttons"><button type="button" class="btn" data-act="cancel">Cancel</button><button type="submit" class="btn primary">${okLabel}</button></div>`;
    const inputs = [...dlg.querySelectorAll<HTMLInputElement>("input")];
    const close = (): void => {
      dlg.remove();
      $("viewport").focus?.();
    };
    dlg.addEventListener("submit", (e) => {
      e.preventDefault();
      const vals = inputs.map((i) => parseFloat(i.value));
      if (vals.some((v) => !Number.isFinite(v))) return this.toast("Enter a number in every field", "error");
      close();
      onOk(vals);
    });
    dlg.querySelector("[data-act=cancel]")!.addEventListener("click", close);
    dlg.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") close();
    });
    $("viewport").appendChild(dlg);
    inputs[0]?.focus();
    inputs[0]?.select();
  }

  // ================================================================ commands

  run(cmd: string, recordRecent = true): void {
    // While sketching, only the view may change: Ctrl+Z undoes a sketch step, Done / Cancel end it.
    if (this.tool instanceof SketchTool && !SKETCH_COMMANDS.has(cmd)) {
      if (cmd === "edit.undo") return this.tool.undo();
      return this.toast("Sketch: click Done (keep the outlines as faces) or Cancel first", "error");
    }
    try {
      this.dispatch(cmd);
      if (recordRecent) this.pushRecent(cmd);
    } catch (e) {
      this.fail(e);
    }
  }

  /** Rarely used tools (Revolve / Sweep / Array copy) as small buttons in the viewport's bottom-left corner. */
  private buildCornerTools(): void {
    const box = $("corner-tools");
    const items: [string, string, string][] = [
      ["op.revolve", "revolve", "Revolve a flat face about a line or axis (Pro: R E)"],
      ["op.sweep", "sweep", "Sweep a flat face along a path or guide line (Pro: S W)"],
      ["edit.array", "array", "Array copy: several copies in a row — copies, gap between them, direction"],
    ];
    for (const [cmd, icon, title] of items) {
      const b = document.createElement("button");
      b.dataset.cmd = cmd;
      b.title = title;
      b.innerHTML = ICONS[icon];
      b.addEventListener("click", () => {
        b.blur();
        this.run(cmd);
      });
      box.appendChild(b);
    }
  }

  /** Recent-commands strip (left border): newest at the bottom, oldest drops off the top. */
  private pushRecent(cmd: string): void {
    if (!RECENT_ITEMS.has(cmd)) return;
    this.recent = [...this.recent.filter((c) => c !== cmd), cmd].slice(-RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(this.recent));
    this.renderRecent();
  }

  private renderRecent(): void {
    const box = $("recent-list");
    box.innerHTML = "";
    for (const cmd of this.recent) {
      const it = RECENT_ITEMS.get(cmd)!;
      const b = document.createElement("button");
      b.className = "tb-btn";
      b.dataset.cmd = cmd;
      b.title = it.key ? `${it.label} (${it.key})` : it.label;
      b.innerHTML = `${ICONS[it.icon]}<span>${it.label}</span>`;
      b.addEventListener("click", () => {
        b.blur();
        this.run(cmd, false); // picking from the strip keeps its order
      });
      box.appendChild(b);
    }
    this.renderToolbarState();
  }

  private dispatch(cmd: string): void {
    switch (cmd) {
      case "mode.body": return this.setMode("body");
      case "mode.face": return this.setMode("face");
      case "mode.edge": return this.setMode("edge");

      case "tool.box": return this.startTool(new BoxTool(this).start());
      case "tool.cylinder": return this.startTool(new CylinderTool(this).start());
      case "tool.sphere": return this.startTool(new SphereTool(this).start());
      case "tool.rectangle": return this.startTool(new BoxTool(this, true).start());
      case "tool.circle": return this.startTool(new CylinderTool(this, true).start());
      case "tool.polygon": return this.startTool(new PolygonTool(this, true).start());
      case "tool.sketch": return this.startSketch();

      case "op.pushpull": return this.opPushPull();
      case "op.fillet": return this.opEdges("fillet");
      case "op.chamfer": return this.opEdges("chamfer");
      case "op.shell": return this.opShell();
      case "op.offset": return this.opOffset();
      case "op.revolve": return this.opRevolve();
      case "op.sweep": return this.opSweep();
      case "op.cut": return this.startCut();
      case "op.splitFace": return this.startSplitFace();
      case "tool.guide": return this.startGuide();
      case "tool.measure": return this.startMeasure();
      case "tool.divideFace": return this.startTool(new DivideFaceTool(this, (id, a, b) => this.divideFace(id, a, b), (id) => this.divideRefusal(id)).start());
      case "edit.clearGuides":
        if (!this.doc.guides.length) return this.toast("No guide lines");
        this.selGuide = -1;
        return this.doc.setGuides([], "Clear guides");

      case "bool.union": return this.boolean("union");
      case "bool.subtract": return this.boolean("subtract");
      case "bool.intersect": return this.boolean("intersect");

      case "xf.move":
        if (this.selGuide >= 0 && !this.selection.length) return this.startGuideMove();
        return this.mode === "edge" && this.selection.some((s) => s.kind === "edge") ? this.startEdgeMove() : this.startTransform("translate");
      case "xf.rotate": return this.startTransform("rotate");
      case "xf.scale": return this.opScale();
      case "xf.moveFrom": return this.startPointMove();
      case "xf.repeat": return this.repeatLast();

      case "edit.undo": return this.undoRedo("undo");
      case "edit.redo": return this.undoRedo("redo");
      case "edit.delete": return this.deleteSelected();
      case "edit.duplicate": return this.duplicate();
      case "edit.array": return this.arrayCopy();
      case "edit.group": return this.groupSelected();
      case "edit.ungroup": return this.ungroupSelected();
      case "edit.selectAll":
        this.setMode("body");
        return this.setSelection(this.doc.bodies.filter((b) => !this.hidden.has(b.id)).map((b) => ({ kind: "body", body: b.id, id: 0 })));

      case "view.fit": return this.viewport.fit();
      case "view.fitSelection": return this.viewport.fit(this.selectedBodyIds());
      case "view.top": return this.viewport.setView("top");
      case "view.front": return this.viewport.setView("front");
      case "view.right": return this.viewport.setView("right");
      case "view.iso": return this.viewport.setView("iso");
      case "view.flip": return this.viewport.flipView();
      case "view.xray":
        this.viewport.setXray(!this.viewport.xray);
        this.toast(this.viewport.xray ? "X-ray on (semi-transparent solids)" : "X-ray off (opaque solids)");
        return;

      case "file.new": void this.fileNew(); return;
      case "file.open": void this.fileOpen(); return;
      case "file.save": void this.fileSave(false); return;
      case "file.saveAs": void this.fileSave(true); return;
      case "file.saveAndClose":
        void this.fileSave(false).then(() => {
          if (!this.doc.dirty) window.y3d.closeNow();
        });
        return;
      case "file.importStep": void this.fileImportStep(); return;
      case "file.importStl": void this.fileImportStl(); return;
      case "file.exportStep": void this.fileExport("step"); return;
      case "file.exportStl": void this.fileExport("stl"); return;

      case "help.shortcuts": return this.toggleHelp();
      case "help.birdhouse": return this.toggleTutorial(BIRD_HOUSE);
      case "help.cablebox": return this.toggleTutorial(CABLE_STORAGE_BOX);
      case "help.house": return this.toggleTutorial(HOUSE);
      case "help.planter": return this.toggleTutorial(PLANTER);
      case "view.menu": return this.showViewMenu();
      case "view.pro": return this.togglePro();
    }
  }

  /** Leave whatever interactive state we're in (tool, op panel, gizmo). */
  private endInteractions(): void {
    this.endTool();
    this.cancelOp();
    this.stopTransform();
  }

  // ================================================================ selection

  private setMode(mode: SelMode): void {
    if (mode !== this.mode) {
      if (this.xf?.edges) this.stopTransform();
      if (mode === "body") {
        const ids = [...new Set(this.selection.map((s) => s.body))];
        this.selection = ids.map((id) => ({ kind: "body", body: id, id: 0 }));
      } else {
        this.selection = this.selection.filter((s) => s.kind === mode);
      }
      this.mode = mode;
      this.hover = null;
    }
    this.refreshSelection();
  }

  private setSelection(items: SelItem[]): void {
    this.selection = items;
    this.refreshSelection();
    if (this.xf?.guide !== undefined) {
      // Clicking another guide moves the gizmo to it; anything else ends the guide move.
      if (this.selGuide >= 0 && !items.length) this.startGuideMove(true);
      else this.stopTransform();
    } else if (this.xf?.edges) {
      if (items.some((s) => s.kind === "edge")) this.startEdgeMove(true);
      else this.stopTransform();
    } else if (this.xf) {
      const ids = this.selectedBodyIds();
      if (ids.length) this.startTransform(this.xf.mode, true);
      else this.stopTransform();
    }
  }

  private selectedBodyIds(): number[] {
    return [...new Set(this.selection.map((s) => s.body))];
  }

  private click(e: PointerEvent): void {
    if (this.selDim >= 0) {
      this.selDim = -1;
      this.showDimensions();
    }
    const g = this.viewport.guideAt(e.clientX, e.clientY);
    if (g !== this.selGuide) {
      this.selGuide = g;
      this.showGuides();
    }
    if (g >= 0) {
      this.setSelection([]);
      this.hint("Guide line selected · G moves it · Del removes it");
      return;
    }
    const pick = this.viewport.pick(e.clientX, e.clientY, this.mode);
    let item: SelItem | null = pick ? { kind: pick.kind, body: pick.body, id: pick.id } : null;
    // Two solids in the same place (e.g. a copy not moved yet): stay on the selected one instead of flipping to its twin.
    const sel = this.selection.length === 1 && this.selection[0].kind === "body" ? this.selection[0].body : null;
    if (pick && item && this.mode === "body" && sel !== null && item.body !== sel && !e.shiftKey && !e.ctrlKey) {
      const own = this.viewport.pick(e.clientX, e.clientY, "body", sel);
      const tol = 1e-4 * Math.max(1, this.viewport.camera.position.distanceTo(pick.point));
      if (own && own.point.distanceTo(pick.point) < tol) item = { kind: "body", body: sel, id: 0 };
    }
    if (!item) {
      // (on a selected face's edge where it's the solid's outline on screen, the click can just miss the solid)
      const edge = e.shiftKey || e.ctrlKey ? null : this.selectedEdgeHit(e);
      if (edge) {
        this.setMode("edge");
        this.setSelection([edge]);
        return;
      }
      // Face mode, on an edge where it's the outline: the face along it turned most towards the camera.
      const face = this.mode === "face" ? this.outlineFaceAt(e) : null;
      if (face) this.setSelection(e.shiftKey || e.ctrlKey ? [...this.selection.filter((s) => !sameItem(s, face)), face] : [face]);
      else if (!e.shiftKey) this.setSelection([]);
      return;
    }
    if (e.shiftKey || e.ctrlKey) {
      const exists = this.selection.some((s) => sameItem(s, item));
      this.setSelection(exists ? this.selection.filter((s) => !sameItem(s, item)) : [...this.selection, item]);
    } else if (this.mode === "body" && this.selection.length === 1 && sameItem(this.selection[0], item)) {
      // Second click on the selected solid: drill down to the edge (if close to one) or face under the cursor.
      // (Only on that body: another solid in the same place — e.g. a copy — must not get in the way.)
      let sub = this.viewport.pick(e.clientX, e.clientY, "edge", item.body);
      if (!sub) sub = this.viewport.pick(e.clientX, e.clientY, "face", item.body);
      if (sub && sub.body === item.body && sub.kind !== "body") {
        this.setMode(sub.kind === "edge" ? "edge" : "face");
        this.setSelection([{ kind: sub.kind, body: sub.body, id: sub.id }]);
      }
    } else {
      // Face mode: a click near an edge of a selected face switches to Edge mode with that edge.
      const edge = this.mode === "face" ? this.selectedEdgeHit(e) : null;
      if (edge) this.setMode("edge");
      this.setSelection([edge ?? item]);
    }
  }

  /** Smart object select: right-click on a solid switches to Solid mode and selects it (Shift/Ctrl toggles). */
  private rightClick(e: PointerEvent): void {
    const pick = this.viewport.pick(e.clientX, e.clientY, "body");
    if (!pick) {
      // Empty space (no guide either) clears the selection, like a left click.
      if (e.shiftKey || e.ctrlKey || this.viewport.guideAt(e.clientX, e.clientY) >= 0) return;
      if (this.selDim >= 0) {
        this.selDim = -1;
        this.showDimensions();
      }
      if (this.selGuide >= 0) {
        this.selGuide = -1;
        this.showGuides();
      }
      this.setSelection([]);
      return;
    }
    const item: SelItem = { kind: "body", body: pick.body, id: 0 };
    this.setMode("body");
    if (e.shiftKey || e.ctrlKey) {
      const exists = this.selection.some((s) => sameItem(s, item));
      this.setSelection(exists ? this.selection.filter((s) => !sameItem(s, item)) : [...this.selection, item]);
    } else {
      this.setSelection([item]);
    }
  }

  /** In Face mode: the edge near the cursor (generous tolerance) if it bounds one of the selected faces. */
  /** The face along the edge under the cursor that faces the camera most (for clicks just off a solid's outline). */
  private outlineFaceAt(e: PointerEvent): SelItem | null {
    const hit = this.viewport.pick(e.clientX, e.clientY, "edge");
    const body = hit && this.doc.get(hit.body);
    if (!hit || !body || !isBrep(body)) return null;
    const eye = this.viewport.camera.position;
    let best: SelItem | null = null, bestDot = -Infinity;
    for (const f of body.shape.faces) {
      if (!faceEdgeIds(body.shape, f.hashCode).has(hit.id)) continue;
      const c = f.center, n = f.normalAt(c);
      const to = new THREE.Vector3(eye.x - c.x, eye.y - c.y, eye.z - c.z).normalize();
      const d = n.x * to.x + n.y * to.y + n.z * to.z;
      if (d > bestDot) [best, bestDot] = [{ kind: "face", body: hit.body, id: f.hashCode }, d];
    }
    return best;
  }

  private selectedEdgeHit(e: PointerEvent): SelItem | null {
    if (this.mode !== "face" || !this.selection.length) return null;
    if (this.selEdgeCache?.sel !== this.selection) {
      const edges = new Map<number, Set<number>>();
      for (const s of this.selection) {
        const body = this.doc.get(s.body);
        if (s.kind !== "face" || !body || !isBrep(body)) continue;
        const set = edges.get(s.body) ?? new Set<number>();
        for (const id of faceEdgeIds(body.shape, s.id)) set.add(id);
        edges.set(s.body, set);
      }
      this.selEdgeCache = { sel: this.selection, edges };
    }
    const edges = this.selEdgeCache.edges;
    const hit = this.viewport.pickEdgeAmong(e.clientX, e.clientY, FACE_EDGE_PICK_PX, (b, id) => !!edges.get(b)?.has(id));
    return hit ? { kind: "edge", body: hit.body, id: hit.id } : null;
  }

  private refreshSelection(): void {
    this.viewport.setHighlight(this.selection, this.hover);
    this.renderOutliner();
    this.renderProps();
    this.renderToolbarState();
    if (!this.tool && !this.op) this.hint(this.xf ? "Drag the gizmo handles · Esc to finish" : MODE_HINTS[this.mode]);
    $("status-mode").textContent = { body: "Solid", face: "Face", edge: "Edge" }[this.mode] + " mode";
  }

  // ================================================================ viewport input

  private bindViewportEvents(): void {
    window.addEventListener("pointermove", (e) => (this.pointer = { x: e.clientX, y: e.clientY }), true);
    const c = this.viewport.canvas;
    // While a value dialog (Tab) is open the model waits for it: left clicks in the viewport don't
    // reach the tool, the gizmo or picking, and only put the focus back in the dialog. Orbit, pan
    // and zoom still work.
    c.parentElement!.addEventListener("pointerdown", (e) => {
      const dlg = this.valueDialog();
      if (!dlg || e.target !== c || e.button !== 0 || e.shiftKey || e.altKey) return;
      e.preventDefault(); // no mousedown: the dialog keeps the focus
      e.stopPropagation();
      if (!dlg.contains(document.activeElement)) dlg.querySelector<HTMLInputElement>("input")?.focus();
    }, { capture: true });
    c.addEventListener("pointermove", (e) => {
      if (this.valueDialog()) return;
      if (this.tool) {
        this.tool.move(e);
        return;
      }
      this.updateCoords(e);
      if (this.op) {
        const op = this.op;
        if (op.spec.hover && !this.opHoverQueued) {
          this.opHoverQueued = true;
          requestAnimationFrame(() => {
            this.opHoverQueued = false;
            if (this.op === op) op.spec.hover!(this.lastPointer ?? e);
          });
        }
        this.lastPointer = e;
        return;
      }
      // Coalesce hover picking to one per frame.
      if (!this.hoverQueued) requestAnimationFrame(() => this.processHover());
      this.hoverQueued = e;
    });
    c.addEventListener("pointerdown", (e) => {
      if (e.button === 2) {
        const toolTakes = !!this.tool?.rightClick;
        this.rightDownAt = (this.tool && !toolTakes) || this.op || this.viewport.gizmoHot ? null : { x: e.clientX, y: e.clientY };
        return;
      }
      if (e.button !== 0 || e.altKey) return; // Alt + drag orbits the view
      if (this.tool) {
        this.tool.down(e);
        return;
      }
      if (this.op?.spec.pick) {
        this.downAt = { x: e.clientX, y: e.clientY }; // a click picks (see pointerup)
        return;
      }
      if (this.op?.spec.drag && !e.shiftKey) {
        this.applyOp(); // click in the viewport confirms the dragged value
        return;
      }
      if (this.viewport.gizmoHot || this.op) return;
      this.downAt = { x: e.clientX, y: e.clientY };
    });
    c.addEventListener("pointerup", (e) => {
      if (e.button === 2) {
        const d = this.rightDownAt;
        this.rightDownAt = null;
        if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) {
          if (this.tool?.rightClick) this.tool.rightClick(e);
          else this.rightClick(e);
        }
        return;
      }
      if (e.button === 0 && (this.valueDialog() || e.altKey)) return;
      if (e.button === 0 && this.tool?.up) {
        this.tool.up(e);
        return;
      }
      if (e.button !== 0 || !this.downAt) return;
      const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y);
      this.downAt = null;
      if (moved < 5) {
        if (this.op?.spec.pick) this.op.spec.pick(e);
        else this.click(e);
      }
    });
    c.addEventListener("pointerleave", () => {
      if (this.hover) {
        this.hover = null;
        this.viewport.setHighlight(this.selection, null);
      }
    });
    c.addEventListener("wheel", () => requestAnimationFrame(() => this.positionHud()), { passive: true });
    // Tools may consume the wheel (e.g. Shift+wheel = polygon sides) before the camera zooms.
    c.parentElement!.addEventListener("wheel", (e) => {
      if (e.target === c && this.tool && !this.valueDialog() && this.tool.wheel?.(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, { capture: true, passive: false });
    c.addEventListener("pointermove", () => this.positionHud());
  }

  private processHover(): void {
    const e = this.hoverQueued;
    this.hoverQueued = null;
    if (!e || this.tool || this.op || this.viewport.gizmoHot) {
      if (this.hoverGuide >= 0) { this.hoverGuide = -1; this.showGuides(); }
      return;
    }
    const g = this.viewport.guideAt(e.clientX, e.clientY);
    if (g !== this.hoverGuide) {
      if (g < 0) this.viewport.canvas.style.cursor = "default";
      this.hoverGuide = g;
      this.showGuides();
    }
    if (g >= 0) {
      // A guide under the cursor wins over bodies.
      if (this.hover) { this.hover = null; this.viewport.setHighlight(this.selection, null); }
      this.viewport.canvas.style.cursor = "pointer";
      return;
    }
    const pick = this.viewport.pick(e.clientX, e.clientY, this.mode);
    // Face mode: preview the edge a click would switch to.
    const item: SelItem | null = this.selectedEdgeHit(e) ?? (pick ? { kind: pick.kind, body: pick.body, id: pick.id } : null);
    if (!sameItem(item, this.hover) && !(item === null && this.hover === null)) {
      this.hover = item;
      this.viewport.setHighlight(this.selection, this.hover);
      this.viewport.canvas.style.cursor = item ? "pointer" : "default";
    }
  }

  private updateCoords(e: PointerEvent): void {
    const ray = this.viewport.ray(e.clientX, e.clientY);
    const p = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
    $("status-coords").textContent = p ? `X ${fmt(p.x)}  Y ${fmt(p.y)}` : "";
  }

  // ================================================================ keyboard

  private bindKeys(): void {
    window.addEventListener("keydown", (e) => {
      const target = e.target as HTMLElement;
      const typing = target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA";
      // A chord's second key also counts in the op panel its first key opened (S → Scale's field has focus).
      const chordCmd = this.chord && (!typing || !!target.closest("#op-panel")) && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && performance.now() - this.chord.at < CHORD_MS ? this.chord.keys[e.key.toLowerCase()] : undefined;
      if (!["Shift", "Control", "Alt", "Meta"].includes(e.key)) this.chord = null;
      if (chordCmd) {
        e.preventDefault();
        // The first key's tool / op / gizmo goes (and its complaint, e.g. Scale with nothing selected).
        this.endInteractions();
        for (const t of $("toasts").querySelectorAll(".toast.error")) if (!this.chordToasts.has(t)) t.remove();
        this.run(chordCmd);
        return;
      }
      if (typing) return;
      if (!$("help").hidden) {
        if (e.key === "Escape" || e.key === "?" || e.key === "F1") this.toggleHelp();
        return;
      }
      if (this.tool && this.tool.key(e)) {
        e.preventDefault();
        return;
      }
      if (e.key === "Enter" && this.op && !this.tool) {
        e.preventDefault();
        this.applyOp(); // focus may have left the panel (e.g. the op was opened by a viewport click)
        return;
      }
      if (e.key === "Enter" && this.xf && !this.tool) {
        e.preventDefault();
        const done = this.xf.mode === "translate" ? "Move done" : "Rotate done";
        this.stopTransform(); // done moving / rotating
        this.toast(done);
        return;
      }
      if (e.key === "Tab" && this.xf && !this.tool) {
        e.preventDefault();
        this.transformDialog();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (this.tool) this.endTool();
        else if (this.op) this.cancelOp();
        else if (this.xf) this.stopTransform();
        else {
          if (this.selDim >= 0) {
            this.selDim = -1;
            this.showDimensions();
          }
          this.setSelection([]);
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyP") {
        e.preventDefault();
        this.run("view.pro"); // (a second key for Ctrl+Shift+F1)
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyZ") {
        e.preventDefault();
        this.run("edit.redo"); // Redo's second shortcut (the menu shows Ctrl+R)
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return; // handled by native menu accelerators
      const combo = e.shiftKey && e.key.length === 1 && /[a-z]/i.test(e.key) ? `Shift+${e.key.toUpperCase()}` : e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const cmd = KEYMAP[e.code] ?? KEYMAP[combo] ?? KEYMAP[e.key];
      if (cmd) {
        e.preventDefault();
        this.chordToasts = new Set($("toasts").children);
        this.run(cmd);
        const chord = CHORDS[combo] ?? (isPro() ? PRO_CHORDS[combo] : undefined);
        if (chord) this.chord = { keys: chord, at: performance.now() };
      }
    });
  }

  // ================================================================ view menu

  private pointer = { x: innerWidth / 2, y: innerHeight / 2 };

  /** Pop-up at the cursor to pick a standard view (click, or press its number key). */
  private showViewMenu(): void {
    document.getElementById("view-menu")?.remove();
    const items: [string, string, string][] = [
      ["Top", "7", "view.top"],
      ["Front", "1", "view.front"],
      ["Right", "3", "view.right"],
      ["Iso", "5", "view.iso"],
      ["Opposite side", "V", "view.flip"],
    ];
    const menu = document.createElement("div");
    menu.id = "view-menu";
    menu.innerHTML = `<h5>View</h5>` + items.map(([label, k, cmd]) => `<button data-cmd="${cmd}"><span>${label}</span><kbd>${k}</kbd></button>`).join("");
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(this.pointer.x, innerWidth - r.width - 4)}px`;
    menu.style.top = `${Math.min(this.pointer.y, innerHeight - r.height - 4)}px`;
    const close = () => {
      menu.remove();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
    const pick = (cmd: string) => {
      close();
      this.run(cmd);
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const it = items.find(([, k]) => e.key.toUpperCase() === k || e.code === `Numpad${k}`);
      if (it) pick(it[2]);
      else if (e.key !== "Shift") close();
    };
    const onDown = (e: PointerEvent) => {
      const b = (e.target as HTMLElement).closest?.("#view-menu button") as HTMLElement | null;
      if (b) {
        e.preventDefault();
        e.stopPropagation();
        pick(b.dataset.cmd!);
      } else if (!menu.contains(e.target as Node)) close();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
  }

  // ================================================================ tools

  private startTool(tool: Tool): void {
    this.endInteractions();
    this.hover = null;
    this.viewport.setHighlight(this.selection, null);
    this.tool = tool;
    this.viewport.canvas.style.cursor = "crosshair";
    this.renderToolbarState();
  }

  private endTool(): void {
    if (!this.tool) return;
    this.tool.dispose();
    this.tool = null;
    this.viewport.canvas.style.cursor = "default";
    this.refreshSelection();
  }

  // ================================================================ parametric operations (panel + live preview)

  private startOp(spec: OpSpec): void {
    this.endInteractions();
    const panel = this.opPanel;
    panel.innerHTML = `<h4>${spec.title}</h4>${spec.note ? `<div class="op-note">${spec.note}</div>` : ""}`;
    const inputs = spec.fields.map((f): OpInput => {
      const label = document.createElement("label");
      label.textContent = f.label;
      if (f.type === "select") {
        const select = document.createElement("select");
        (f.options ?? []).forEach((o, i) => select.add(new Option(o, String(i))));
        select.value = String(f.value);
        select.dataset.key = f.key;
        label.appendChild(select);
        panel.appendChild(label);
        return select;
      }
      const input = document.createElement("input");
      if (f.type === "checkbox") {
        input.type = "checkbox";
        input.checked = f.value !== 0;
        label.classList.add("check");
      } else if (f.mm !== undefined) {
        // (text: also takes "+10mm", "60mm"... — shown as the % once left)
        input.type = "text";
        input.inputMode = "decimal";
        input.dataset.mm = String(f.mm);
        input.dataset.step = String(f.step ?? 1);
        input.title = "%, or a size: +10mm / -10mm (that much bigger / smaller), 60mm (that size), +10% / -10%";
        input.value = String(f.value);
        input.addEventListener("change", () => {
          const v = this.opNum(input);
          if (Number.isFinite(v) && input.value !== fmt(v)) input.value = fmt(v);
        });
      } else {
        input.type = "number";
        input.step = String(f.step ?? 1);
        if (f.min !== undefined) input.min = String(f.min);
        input.value = String(f.value);
      }
      input.dataset.key = f.key;
      label.appendChild(input);
      panel.appendChild(label);
      return input;
    });
    const err = document.createElement("div");
    err.className = "op-error";
    panel.appendChild(err);
    const buttons = document.createElement("div");
    buttons.className = "op-buttons";
    buttons.innerHTML = `<button class="btn" data-a="cancel">Cancel</button><button class="btn primary" data-a="apply">Apply ⏎</button>`;
    panel.appendChild(buttons);
    panel.hidden = false;

    this.op = { spec, inputs, timer: 0, result: null, key: "" };
    buttons.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).dataset.a;
      if (a === "apply") this.applyOp();
      if (a === "cancel") this.cancelOp();
    });
    for (const input of inputs) {
      input.addEventListener(input.type === "checkbox" || input instanceof HTMLSelectElement ? "change" : "input", () => this.scheduleOpPreview());
      input.addEventListener("keydown", (ev) => {
        const e = ev as KeyboardEvent;
        if (e.key === "Enter") {
          e.preventDefault();
          this.applyOp();
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.cancelOp();
        }
      });
      if (input instanceof HTMLInputElement && (input.type === "number" || input.dataset.mm)) input.addEventListener("wheel", (e) => {
        e.preventDefault();
        const step = Number(input.step || input.dataset.step) * (e.shiftKey ? 10 : 1);
        input.value = fmt((this.opNum(input) || 0) + (e.deltaY < 0 ? step : -step));
        input.dispatchEvent(new Event("input", { bubbles: true })); // (as if typed: previews, and ops listening see it)
      });
    }
    this.hover = null;
    if (spec.pick) this.viewport.canvas.style.cursor = "crosshair";
    const drags = dragsOf(spec);
    this.hint(spec.hint ?? (drags.length
      ? `${spec.title}: drag the ${drags.length > 1 ? "handles" : "blue handle"} to set the ${drags[0].unit ? "scale" : "distance"} (hold Ctrl to snap) · click or Enter apply · Esc cancel`
      : `${spec.title}: adjust values (mouse wheel over a field to scrub) · Enter apply · Esc cancel`));
    this.renderToolbarState();
    this.previewOp();
    this.positionHandle();
    const first = inputs.find((i) => i.type === "number" || i.dataset.mm) ?? inputs[0];
    first?.focus();
    if (first instanceof HTMLInputElement && (first.type === "number" || first.dataset.mm)) first.select();
  }

  /** Map mouse movement along the drag axis to the op's value (relative to where the drag started). */
  private opDrag(e: PointerEvent): void {
    const op = this.op!;
    const drag = dragsOf(op.spec)[op.active ?? 0];
    if (!drag) return;
    const input = op.inputs.find((i) => i.dataset.key === drag.key);
    if (!input) return;
    // Shift: its checkbox follows (e.g. Scale about the centre), the preview with it.
    const box = drag.shift && (op.inputs.find((i) => i.dataset.key === drag.shift!.key) as HTMLInputElement | undefined);
    if (box && box.checked !== e.shiftKey) {
      box.checked = e.shiftKey;
      this.scheduleOpPreview();
      this.positionHandle();
    }
    const O = new THREE.Vector3(...this.dragOrigin(drag)), D = new THREE.Vector3(...this.dragDir(drag)).normalize();
    // Screen-space mapping: mouse movement projected onto the axis' on-screen direction,
    // so the result doesn't depend on where the pointer is (e.g. started from a toolbar icon).
    const s0 = this.viewport.toScreen(O), s1 = this.viewport.toScreen(O.clone().addScaledVector(D, 10));
    const ax = s1.x - s0.x, ay = s1.y - s0.y;
    const pxPer10 = Math.hypot(ax, ay);
    if (pxPer10 < 5) return; // looking straight down the axis
    if (!op.anchor) {
      op.anchor = { x: e.clientX, y: e.clientY, v: this.opNum(input) || 0 };
      return;
    }
    const unit = this.dragUnit(drag);
    const t = (((e.clientX - op.anchor.x) * ax + (e.clientY - op.anchor.y) * ay) / pxPer10) * (10 / pxPer10);
    let v = op.anchor.v + t / unit;
    // Ctrl: level with the object point under the cursor (corner, midpoint, centre, edge, guide, axis), else grid.
    const sp = e.ctrlKey ? this.viewport.snapPoint(e.clientX, e.clientY) : null;
    this.viewport.showSnapMarker(sp);
    if (sp) v = sp.point.clone().sub(O).dot(D) / unit;
    else {
      const step = this.snapStep(e);
      if (step > 0) v = Math.round(v / step) * step;
    }
    if (drag.min !== undefined) v = Math.max(drag.min, v);
    op.exact = sp ? { key: drag.key, shown: fmt(v), value: v } : undefined;
    if (fmt(v) === input.value) return;
    input.value = fmt(v);
    const units = drag.unit ? "%" : "mm";
    this.hud(sp ? `${fmt(v)} ${units} · ${sp.kind}` : `${fmt(v)} ${units}`, O.clone().addScaledVector(D, v * unit));
    if ((op.previewMs ?? 0) > SLOW_PREVIEW_MS) {
      // Heavy geometry: recomputing every frame would keep the CPU pegged. Show the instant
      // approximate preview if the op has one, and the real one once the drag pauses.
      if (op.spec.fastDrag?.(this.opValues().values)) op.key = ""; // the real preview must redraw
      clearTimeout(op.dragTimer);
      op.dragTimer = window.setTimeout(() => this.op === op && this.previewOp(), 150);
    } else if (!op.dragQueued) {
      op.dragQueued = true;
      requestAnimationFrame(() => {
        if (this.op !== op) return;
        op.dragQueued = false;
        this.previewOp();
      });
    }
  }

  private opValues(): { values: Record<string, number>; key: string } {
    const values: Record<string, number> = {};
    const exact = this.op!.exact;
    for (const i of this.op!.inputs) {
      const k = i.dataset.key!;
      values[k] = i instanceof HTMLInputElement && i.type === "checkbox" ? (i.checked ? 1 : 0) : exact?.key === k && i.value === exact.shown ? exact.value : this.opNum(i);
    }
    return { values, key: JSON.stringify(values) };
  }

  private scheduleOpPreview(): void {
    this.positionHandle();
    if (!this.op) return;
    clearTimeout(this.op.timer);
    this.op.timer = window.setTimeout(() => this.previewOp(), 120);
  }

  private previewOp(): OpOutcome | null {
    const op = this.op;
    if (!op) return null;
    const { values, key } = this.opValues();
    if (key === op.key && op.result) return op.result;
    const err = op.inputs[0].closest("#op-panel")!.querySelector(".op-error")!;
    try {
      if (Object.values(values).some((v) => !Number.isFinite(v))) throw new Error("enter a number");
      const t0 = performance.now();
      const result = op.spec.compute(values);
      op.result = result;
      op.key = key;
      err.textContent = "";
      err.classList.remove("waiting");
      if (result.xform) this.viewport.showGhostTransformed(result.xform.ids, result.xform.matrix);
      else this.viewport.showGhost(result.ghost);
      op.previewMs = performance.now() - t0;
      return result;
    } catch (e) {
      op.result = null;
      op.key = "";
      err.textContent = errorMessage(e);
      err.classList.toggle("waiting", e instanceof OpWaiting);
      this.viewport.clearGhost();
      return null;
    }
  }

  private applyOp(): void {
    const op = this.op;
    if (!op) return;
    clearTimeout(op.timer);
    const result = this.previewOp();
    if (!result) return;
    op.spec.remember?.(this.opValues().values);
    let done: { select: number[]; solidMode?: boolean; then?: () => void };
    try {
      done = result.commit(); // a transform preview builds the exact result only now
    } catch (e) {
      const err = this.opPanel.querySelector(".op-error");
      if (err) err.textContent = errorMessage(e);
      this.toast(errorMessage(e), "error");
      return;
    }
    this.closeOpPanel();
    const { select, solidMode, then } = done;
    if (solidMode) this.setMode("body");
    this.setSelection(this.mode === "body" ? select.map((id) => ({ kind: "body", body: id, id: 0 })) : []);
    if (then) return then();
    this.toast(`${op.spec.label} applied`);
  }

  private cancelOp(): void {
    if (!this.op) return;
    clearTimeout(this.op.timer);
    this.closeOpPanel();
    this.refreshSelection();
  }

  private closeOpPanel(): void {
    clearTimeout(this.op?.dragTimer);
    this.op = null;
    this.hud(null);
    this.viewport.showSnapMarker(null);
    this.positionHandle();
    this.opPanel.hidden = true;
    this.opPanel.innerHTML = "";
    this.viewport.clearGhost();
    this.showGuides(); // (Revolve / Sweep show their guide selected)
    this.viewport.canvas.style.cursor = "default";
    this.renderToolbarState();
  }

  /** Outcome that replaces body shapes in place (fillet, shell, join push/pull...). */
  private replaceOutcome(shapes: Map<number, Geom>, label: string): OpOutcome {
    return {
      ghost: new Map([...shapes].filter((e): e is [number, Shape] => !isMesh(e[1]))),
      commit: () => {
        this.doc.replaceShapes(shapes, label);
        return { select: [...shapes.keys()] };
      },
    };
  }

  /** The body's shape as a solid, or a friendly error for flat faces and meshes. */
  private solidOf(id: number, action: string): Solid {
    const b = this.doc.get(id)!;
    if (b.kind === "face") throw new Error(`${action} needs a solid — "${b.name}" is a flat face (Push/Pull it first)`);
    if (!isBrep(b)) throw new Error(notEditable(action, b));
    return b.shape as Solid;
  }

  /** The B-rep of a body picked by face or edge (a mesh never is: it is always picked whole). */
  private brep(id: number): Shape {
    const b = this.doc.get(id)!;
    if (!isBrep(b)) throw new Error(notEditable("Edit", b));
    return b.shape;
  }

  /** The body if it is a solid or flat face; for a mesh or a path, says what it can do and returns null. */
  private shapeBody(id: number, action: string): ShapeBody | null {
    const b = this.doc.get(id);
    if (!b || isBrep(b)) return b ?? null;
    this.toast(notEditable(action, b), "error");
    return null;
  }

  /** Bodies in the selection that are flat faces (for guarding solid-only commands). */
  private faceBodiesIn(ids: number[]): Body[] {
    return ids.map((id) => this.doc.get(id)!).filter((b) => b && b.kind === "face");
  }

  private opPushPull(): void {
    // Target: one selected face, or one selected flat-face body (it has a single face).
    let target: { bodyId: number; faceId: number } | null = null;
    const faces = this.selection.filter((s) => s.kind === "face");
    if (faces.length === 1 && this.selection.length === 1) target = { bodyId: faces[0].body, faceId: faces[0].id };
    else if (this.selection.length === 1 && this.selection[0].kind === "body") {
      const b = this.doc.get(this.selection[0].body);
      if (b?.kind === "face") target = { bodyId: b.id, faceId: b.shape.faces[0].hashCode };
    }
    if (!target && this.selection.length > 1) return this.opPushPullMany();
    if (!target) {
      this.toast("Push/Pull: select one or more faces (Face mode, key 2) or flat face objects", "error");
      return;
    }
    const { bodyId, faceId } = target;
    const body = this.shapeBody(bodyId, "Push/Pull");
    if (!body) return;
    const axis = faceAxis(body.shape, faceId);
    const drag = axis ? { origin: axis.center, dir: axis.normal, key: "d" } : undefined;

    if (body.kind === "face") {
      // Flat face → extrude into a brand-new solid that replaces the face.
      this.startOp({
        title: "Push / Pull → new solid",
        label: "Extrude face",
        fields: [{ key: "d", label: "Distance (mm)", value: 1, step: 1 }],
        compute: ({ d }) => {
          const solid = extrudeFace(body.shape, faceId, d);
          return {
            ghost: new Map([[bodyId, solid]]),
            commit: () => {
              const nb = extrudedFrom(this.doc.makeBody(solid, "Solid"), body);
              this.doc.commit(this.doc.bodies.map((b) => (b.id === bodyId ? nb : b)), "Extrude face");
              return { select: [nb.id], solidMode: true };
            },
          };
        },
        remember: () => {},
        drag,
      });
      return;
    }

    // Face of a solid → modify that solid, or (checkbox) create a separate new solid.
    this.startOp({
      title: "Push / Pull",
      label: "Push/Pull",
      fields: [
        { key: "d", label: "Distance (mm)", value: 1, step: 1 },
        { key: "newBody", label: "New solid", value: this.defaults.pushpullNew ? 1 : 0, type: "checkbox" },
      ],
      compute: ({ d, newBody }) => {
        if (newBody) {
          const solid = extrudeFace(body.shape, faceId, d);
          return {
            ghost: new Map([[-1, solid]]),
            commit: () => {
              const nb = inGroupOf(this.doc.makeBody(solid, "Solid"), body);
              this.doc.commit([...this.doc.bodies, nb], "Extrude face");
              return { select: [nb.id], solidMode: true };
            },
          };
        }
        // Fast preview; the exact result is computed on Apply (see asPreview).
        const solid = this.solidOf(bodyId, "Push/Pull");
        return {
          ghost: new Map([[bodyId, asPreview(() => pushPull(solid, faceId, d))]]),
          commit: () => this.replaceOutcome(new Map([[bodyId, pushPull(solid, faceId, d)]]), "Push/Pull").commit(),
        };
      },
      remember: ({ d, newBody }) => {
        this.defaults.pushpullNew = !!newBody;
      },
      fastDrag: ({ d, newBody }) => !newBody && this.dragPushPull(new Map([[bodyId, [faceId]]]), d),
      drag,
    });
  }

  /** Several faces (on one or more solids) and/or flat face objects, one distance. */
  private opPushPullMany(): void {
    const perSolid = new Map<number, number[]>();
    const flats: ShapeBody[] = [];
    for (const s of this.selection) {
      const b = this.doc.get(s.body);
      if (!b) continue;
      if (b.kind === "face") {
        if (!flats.includes(b)) flats.push(b);
      } else if (s.kind === "face") {
        perSolid.set(b.id, [...(perSolid.get(b.id) ?? []), s.id]);
      } else {
        return this.toast("Push/Pull: select faces only (Face mode, key 2) — not whole solids or edges", "error");
      }
    }
    const n = [...perSolid.values()].reduce((a, f) => a + f.length, 0) + flats.length;
    if (!n) return this.toast("Push/Pull: select one or more faces", "error");
    const first = this.selection[0];
    const fb = this.shapeBody(first.body, "Push/Pull");
    if (!fb) return;
    const axis = faceAxis(fb.shape, fb.kind === "face" ? fb.shape.faces[0].hashCode : first.id);
    const drag = axis ? { origin: axis.center, dir: axis.normal, key: "d" } : undefined;
    this.startOp({
      title: `Push / Pull (${n} faces)`,
      label: "Push/Pull",
      fields: [{ key: "d", label: "Distance (mm)", value: 1, step: 1 }],
      compute: ({ d }) => {
        // Fast preview; the exact solids are computed on Apply (see asPreview).
        const pushed = () => new Map<number, Shape>([...perSolid].map(([id, faces]) => [id, pushPullMany(this.solidOf(id, "Push/Pull"), faces, d)]));
        const preview = asPreview(pushed);
        const extruded = new Map<number, Shape>(flats.map((b) => [b.id, extrudeFace(b.shape, b.shape.faces[0].hashCode, d)]));
        return {
          ghost: new Map([...preview, ...extruded]),
          commit: () => {
            const solids = pushed();
            const made = new Map(flats.map((b) => [b.id, extrudedFrom(this.doc.makeBody(extruded.get(b.id)!, "Solid"), b)]));
            this.doc.commit(
              this.doc.bodies.map((b) => made.get(b.id) ?? (solids.has(b.id) ? withShape(b, solids.get(b.id)!) : b)),
              "Push/Pull",
            );
            return { select: [...solids.keys(), ...[...made.values()].map((b) => b.id)], solidMode: made.size > 0 && !solids.size };
          },
        };
      },
      remember: () => {},
      fastDrag: ({ d }) => !flats.length && this.dragPushPull(perSolid, d),
      drag,
    });
  }

  /** Faces moved by a push/pull, per body (cached per op: the document doesn't change while it is open). */
  private ppMoves = new Map<string, Map<number, V3>>();

  /** Instant push/pull drag preview: shift the faces (and the fillets they carry) in the display meshes. */
  private dragPushPull(perBody: Map<number, number[]>, d: number): boolean {
    const moves = new Map<number, Map<number, V3>>();
    try {
      for (const [id, faces] of perBody) {
        const k = `${this.doc.version}:${id}:${faces.join()}`;
        let m = this.ppMoves.get(k);
        if (!m) {
          if (this.ppMoves.size > 20) this.ppMoves.clear();
          m = pushPullMoves(this.solidOf(id, "Push/Pull"), faces);
          this.ppMoves.set(k, m);
        }
        moves.set(id, new Map([...m].map(([f, n]) => [f, [n[0] * d, n[1] * d, n[2] * d] as V3])));
      }
    } catch {
      return false;
    }
    this.viewport.showGhostDeformed(moves);
    return true;
  }

  private opEdges(kind: "fillet" | "chamfer"): void {
    const isFillet = kind === "fillet";
    const title = isFillet ? "Fillet" : "Chamfer";
    const perBody = new Map<number, Set<number> | null>();
    for (const s of this.selection) {
      if (s.kind === "body") perBody.set(s.body, null);
      else if (s.kind === "edge") {
        const set = perBody.get(s.body);
        if (set === null) continue;
        perBody.set(s.body, (set ?? new Set<number>()).add(s.id));
      }
    }
    if (!perBody.size) {
      this.toast(`${title}: select edges (Edge mode, key 3) or whole solids`, "error");
      return;
    }
    const flat = this.faceBodiesIn([...perBody.keys()]);
    if (flat.length) {
      this.toast(`${title} works on solids — "${flat[0].name}" is a flat face. Push/Pull it first.`, "error");
      return;
    }
    const fields: OpField[] = [{ key: "r", label: isFillet ? "Radius (mm)" : "Distance (mm)", value: isFillet ? this.defaults.fillet : this.defaults.chamfer, step: 0.1, min: 0 }];
    // Whole solids selected: which of their edges (e.g. just the vertical corners of a box).
    const WHICH = ["all", "vertical", "horizontal"] as const;
    const wholeSolids = [...perBody.values()].some((v) => v === null);
    if (wholeSolids) fields.push({ key: "which", label: "Edges", type: "select", options: ["All", "Vertical", "Horizontal"], value: this.defaults.edgesWhich });
    const edgesOf = (id: number, picked: Set<number> | null, which: number | undefined) => {
      const shape = this.solidOf(id, title);
      const w = WHICH[which ?? 0] ?? "all";
      return { shape, w, edges: picked ?? (w === "all" ? null : edgesAlong(shape, w)) };
    };
    // Drag handle on the first selected edge (or the top edge of the first solid), across its face.
    const dragFor = (which: number | undefined): OpDrag | undefined => {
      const [id, picked] = [...perBody][0];
      let axis: { origin: V3; dir: V3 } | null = null;
      try {
        const { shape, edges } = edgesOf(id, picked, which);
        axis = filletDragAxis(shape, edges);
      } catch {
        // not a solid (e.g. a mesh): compute reports it
      }
      return axis ? { origin: axis.origin, dir: axis.dir, key: "r", min: 0.1, title: `Drag to change the ${isFillet ? "radius" : "distance"}` } : undefined;
    };
    const spec: OpSpec = {
      title,
      label: title,
      fields,
      compute: ({ r, which }) => {
        if (wholeSolids) spec.drag = dragFor(which); // "Edges" can move the handle to another edge
        if (r <= 0) throw new Error("value must be greater than 0");
        const out = new Map<number, Shape>();
        for (const [id, picked] of perBody) {
          const { shape, w, edges } = edgesOf(id, picked, which);
          if (edges && !edges.size) throw new Error(`"${this.doc.get(id)!.name}" has no ${w} edges`);
          out.set(id, isFillet ? filletEdges(shape, edges, r) : chamferEdges(shape, edges, r));
        }
        return this.replaceOutcome(out, title);
      },
      remember: ({ r, which }) => {
        if (isFillet) this.defaults.fillet = r;
        else this.defaults.chamfer = r;
        if (which !== undefined) this.defaults.edgesWhich = which;
      },
      drag: dragFor(wholeSolids ? this.defaults.edgesWhich : undefined),
    };
    this.startOp(spec);
  }

  private opShell(): void {
    const faces = this.selection.filter((s) => s.kind === "face");
    const bodies = new Set(faces.map((f) => f.body));
    if (!faces.length || bodies.size !== 1) {
      this.toast("Shell: select the face(s) to open on one solid (Face mode, key 2)", "error");
      return;
    }
    const bodyId = faces[0].body;
    if (this.doc.get(bodyId)?.kind === "face") {
      this.toast("Shell works on solids — Push/Pull the flat face first", "error");
      return;
    }
    const ids = new Set(faces.map((f) => f.id));
    this.startOp({
      title: "Shell",
      label: "Shell",
      fields: [{ key: "t", label: "Thickness (mm)", value: this.defaults.shell, step: 0.5, min: 0 }],
      compute: ({ t }) => {
        if (t <= 0) throw new Error("thickness must be greater than 0");
        return this.replaceOutcome(new Map([[bodyId, shellSolid(this.solidOf(bodyId, "Shell"), ids, t)]]), "Shell");
      },
      remember: ({ t }) => (this.defaults.shell = t),
    });
  }

  /** The one selected face, or the face of the one selected flat face object; null for any other selection. */
  private oneFaceTarget(): { bodyId: number; faceId: number } | null {
    if (this.selection.length !== 1) return null;
    const s = this.selection[0];
    if (s.kind === "face") return { bodyId: s.body, faceId: s.id };
    const b = s.kind === "body" ? this.doc.get(s.body) : undefined;
    return b?.kind === "face" ? { bodyId: b.id, faceId: b.shape.faces[0].hashCode } : null;
  }

  /** Offset: a new flat face on the selected face's plane, its outline grown (or shrunk) by a distance. */
  private opOffset(): void {
    if (this.selection.length && this.selection.every((s) => s.kind === "edge")) return this.opOffsetEdges();
    const target = this.oneFaceTarget();
    if (!target) {
      this.toast("Offset: select one flat face (Face mode, key 2) or one flat face object", "error");
      return;
    }
    const { bodyId, faceId } = target;
    const body = this.shapeBody(bodyId, "Offset");
    if (!body) return;
    if (findFace(body.shape, faceId)?.geomType !== "PLANE") {
      this.toast("Offset works on flat faces only", "error");
      return;
    }
    const axis = offsetDragAxis(body.shape, faceId);
    this.startOp({
      title: "Offset face",
      label: "Offset",
      fields: [
        { key: "d", label: "Distance (mm)", value: this.defaults.offset, step: 1 },
        { key: "round", label: "Round corners", value: this.defaults.offsetRound ? 1 : 0, type: "checkbox" },
        { key: "ring", label: "Make ring", value: this.defaults.offsetRing ? 1 : 0, type: "checkbox" },
      ],
      compute: ({ d, round, ring }) => {
        // Ring: only the band between the face's outline and the offset outline.
        const faces = ring ? offsetRing(body.shape, faceId, d, !!round) : [offsetFace(body.shape, faceId, d, !!round)];
        return {
          ghost: new Map(faces.map((f, i) => [-1 - i, f] as [number, Shape])),
          commit: () => {
            const made = faces.map((f) => this.doc.makeBody(f, ring ? "Ring" : "Face", "face"));
            this.doc.commit([...this.doc.bodies, ...made], ring ? "Offset ring" : "Offset face");
            return { select: made.map((b) => b.id), solidMode: true };
          },
        };
      },
      remember: ({ d, round, ring }) => {
        this.defaults.offset = d;
        this.defaults.offsetRound = !!round;
        this.defaults.offsetRing = !!ring;
      },
      drag: axis ? { origin: axis.origin, dir: axis.dir, key: "d" } : undefined,
    });
  }

  /** Offset edges: new flat strip(s) centred on the selected straight edges, in the plane of an adjacent flat face. */
  private opOffsetEdges(): void {
    const bodyId = this.selection[0].body;
    if (this.selection.some((s) => s.body !== bodyId)) {
      this.toast("Offset: select edges of one object", "error");
      return;
    }
    const body = this.shapeBody(bodyId, "Offset");
    if (!body) return;
    const edgeIds = this.selection.map((s) => s.id);
    // Most horizontal face first, so a top edge extends the top by default (like an eave).
    const tilt = (id: number) => Math.abs(faceAxis(body.shape, id)?.normal[2] ?? 0);
    const faceIds = edgeOffsetFaces(body.shape, edgeIds).sort((a, b) => tilt(b) - tilt(a));
    if (!faceIds.length) {
      this.toast("Offset: the selected edges must all lie on one flat face", "error");
      return;
    }
    try {
      offsetEdges(body.shape, edgeIds, faceIds[0], 1); // reject loops / curves / branches before opening the panel
    } catch (e) {
      this.toast(errorMessage(e), "error");
      return;
    }
    const faceOf = (other: number) => faceIds[other && faceIds.length > 1 ? 1 : 0];
    const fields: OpField[] = [{ key: "d", label: "Each side (mm)", value: Math.abs(this.defaults.offset) || 5, step: 1, min: 0 }];
    if (faceIds.length > 1) fields.push({ key: "other", label: "Other face", value: 0, type: "checkbox" });
    const dragFor = (faceId: number) => {
      const axis = offsetEdgesAxis(body.shape, edgeIds, faceId);
      return axis ? { origin: axis.origin, dir: axis.dir, key: "d" } : undefined;
    };
    const spec: OpSpec = {
      title: "Offset edges",
      label: "Offset",
      fields,
      compute: ({ d, other }) => {
        spec.drag = dragFor(faceOf(other)); // "Other face" flips the drag direction too
        const faces = offsetEdges(body.shape, edgeIds, faceOf(other), d);
        return {
          ghost: new Map(faces.map((f, i) => [-1 - i, f] as [number, Shape])),
          commit: () => {
            const made = faces.map((f) => this.doc.makeBody(f, "Face", "face"));
            this.doc.commit([...this.doc.bodies, ...made], "Offset edges");
            return { select: made.map((b) => b.id), solidMode: true };
          },
        };
      },
      remember: ({ d }) => (this.defaults.offset = d),
      drag: dragFor(faceIds[0]),
    };
    this.startOp(spec);
  }

  /**
   * Outcome for a solid made from a profile face (Revolve, Sweep): a flat face object turns into it
   * (like Push/Pull); made from a solid's face it joins that solid, or with `newBody` stays separate.
   */
  private profileOutcome(body: ShapeBody, solid: Solid, newBody: boolean, label: string): OpOutcome {
    if (body.kind === "solid" && !newBody) {
      return this.replaceOutcome(new Map([[body.id, booleanOp("union", this.solidOf(body.id, label), [solid])]]), label);
    }
    return {
      ghost: new Map([[body.kind === "face" ? body.id : -1, solid]]),
      commit: () => {
        const nb = this.doc.makeBody(solid, label);
        this.doc.commit(body.kind === "face" ? this.doc.bodies.map((b) => (b.id === body.id ? nb : b)) : [...this.doc.bodies, nb], label);
        return { select: [nb.id], solidMode: true };
      },
    };
  }

  /** Revolve: turn a flat face about an axis (a guide line, one of its straight edges or a world axis) into a solid. */
  private opRevolve(): void {
    const target = this.oneFaceTarget();
    if (!target) {
      this.toast("Revolve: select one flat face (Face mode, key 2) or one flat face object", "error");
      return;
    }
    const { bodyId, faceId } = target;
    const body = this.shapeBody(bodyId, "Revolve");
    if (!body) return;
    if (findFace(body.shape, faceId)?.geomType !== "PLANE") {
      this.toast("Revolve works on flat faces only", "error");
      return;
    }
    // Axes to pick from: guide lines (nearest the face first), the face's straight edges, the world axes.
    const c = new THREE.Vector3(...faceAxis(body.shape, faceId)!.center);
    const along = (a: V3, b: V3): Axis => ({ origin: a, dir: [b[0] - a[0], b[1] - a[1], b[2] - a[2]] });
    const away = (g: Guide) => c.clone().sub(new THREE.Vector3(...g.a)).cross(new THREE.Vector3(...g.b).sub(new THREE.Vector3(...g.a)).normalize()).length();
    const guides = this.doc.guides.map((g, i) => ({ i, d: away(g) })).sort((x, y) => x.d - y.d);
    const axes: { name: string; axis: Axis; guide?: number }[] = [
      ...guides.map(({ i, d }, k) => ({ name: `Guide line ${k + 1} (${fmt(d)} mm away)`, axis: along(this.doc.guides[i].a, this.doc.guides[i].b), guide: i })),
      ...faceLineEdges(body.shape, faceId).map(([a, b], k) => ({ name: `Face edge ${k + 1}`, axis: along(a, b) })),
      ...["X", "Y", "Z"].map((n, k) => ({ name: `${n} axis`, axis: { origin: [0, 0, 0] as V3, dir: [0, 1, 2].map((j) => (j === k ? 1 : 0)) as V3 } })),
    ];
    const fields: OpField[] = [
      { key: "axis", label: "Axis", type: "select", options: axes.map((a) => a.name), value: Math.max(0, axes.findIndex((a) => !revolveRefusal(body.shape, faceId, a.axis))) },
      { key: "angle", label: "Angle (°)", value: this.defaults.revolveAngle, step: 15 },
    ];
    if (body.kind === "solid") fields.push({ key: "newBody", label: "New solid", value: this.defaults.joinNew ? 1 : 0, type: "checkbox" });
    // A click in the viewport picks the axis: a guide line, one of the face's straight edges or a world axis line.
    const lineEdges = (findFace(body.shape, faceId)?.edges ?? []).filter((e) => e.geomType === "LINE").map((e) => e.hashCode);
    const firstEdge = guides.length, firstWorld = guides.length + lineEdges.length;
    const axisAt = (e: PointerEvent): { i: number; edge?: number; at?: THREE.Vector3 } | null => {
      const g = this.viewport.guideAt(e.clientX, e.clientY);
      if (g >= 0) return { i: guides.findIndex((x) => x.i === g) };
      const hit = this.viewport.pick(e.clientX, e.clientY, "edge", body.id);
      const k = hit ? lineEdges.indexOf(hit.id) : -1;
      if (k >= 0) return { i: firstEdge + k, edge: hit!.id };
      const w = this.viewport.axisUnder(e.clientX, e.clientY);
      if (w < 0) return null;
      // (the point on that axis line nearest the cursor ray, for its label)
      const ray = this.viewport.ray(e.clientX, e.clientY), dir = new THREE.Vector3().setComponent(w, 1);
      const b = ray.direction.dot(dir), d = ray.direction.dot(ray.origin), f = dir.dot(ray.origin);
      return { i: firstWorld + w, at: dir.multiplyScalar((f - b * d) / (1 - b * b)) };
    };
    this.startOp({
      title: "Revolve",
      label: "Revolve",
      fields,
      hint: "Revolve: click a guide line, a straight edge of the face or the X / Y / Z axis line to turn about it · Enter apply · Esc cancel",
      pick: (e) => {
        const t = axisAt(e);
        const select = this.op?.inputs.find((i) => i.dataset.key === "axis");
        if (!t || !select || select.value === String(t.i)) return;
        select.value = String(t.i);
        this.previewOp();
      },
      hover: (e) => {
        const t = axisAt(e);
        this.viewport.setHighlight(this.selection, t?.edge !== undefined ? { kind: "edge", body: body.id, id: t.edge } : null);
        const shown = Number(this.op?.inputs.find((i) => i.dataset.key === "axis")?.value ?? -1);
        this.viewport.setGuides(this.doc.guides, axes[shown]?.guide ?? -1, t && t.i < firstEdge ? axes[t.i].guide! : -1);
        this.hud(t?.at ? axes[t.i].name : null, t?.at);
        this.viewport.canvas.style.cursor = t ? "pointer" : "crosshair";
      },
      compute: ({ axis, angle, newBody }) => {
        const a = axes[axis];
        this.viewport.setGuides(this.doc.guides, a?.guide ?? -1, -1); // the guide used as the axis shows selected
        if (!a) throw new Error("pick an axis");
        return this.profileOutcome(body, revolveFace(body.shape, faceId, a.axis, angle), !!newBody, "Revolve");
      },
      remember: ({ angle, newBody }) => {
        this.defaults.revolveAngle = angle;
        if (newBody !== undefined) this.defaults.joinNew = !!newBody;
      },
    });
  }

  /**
   * Sweep: a flat face (the profile — a flat ring makes a tube) run along a path or guide line into a
   * solid. Whatever is selected is used; the panel then waits for clicks on what is still missing.
   */
  private opSweep(): void {
    let profile: { bodyId: number; faceId: number } | null = null;
    let spine: Spine | null = this.selGuide >= 0 ? { guide: this.selGuide } : null;
    for (const s of this.selection) {
      const b = this.doc.get(s.body);
      if (b?.kind === "path") spine = { path: b.id };
      else if (s.kind === "face") profile = { bodyId: s.body, faceId: s.id };
      else if (b?.kind === "face") profile = { bodyId: b.id, faceId: b.shape.faces[0].hashCode };
    }
    this.openSweep(profile, spine);
  }

  /** The Sweep panel for the profile / path picked so far; clicks in the viewport pick the others. */
  private openSweep(profile: { bodyId: number; faceId: number } | null, spine: Spine | null): void {
    const pb = profile && this.doc.get(profile.bodyId);
    const body = pb && isBrep(pb) ? pb : null;
    const guide = spine && "guide" in spine ? this.doc.guides[spine.guide] : undefined;
    const pathBody = spine && "path" in spine ? this.doc.get(spine.path) : undefined;
    const wire = guide ? lineWire(guide.a, guide.b) : pathBody?.kind === "path" ? pathBody.shape : null;
    const fields: OpField[] = [{ key: "round", label: "Corners", type: "select", options: ["Sharp", "Round"], value: this.defaults.sweepRound }];
    // A profile away from the path always moves onto it (sweeping it where it is would give a solid off to
    // the side); one already at the path's end stays put unless "Centre" is ticked.
    let onPath = false;
    if (body && wire) {
      try {
        onPath = profileOnPath(body.shape, profile!.faceId, wire);
      } catch {
        // compute reports what is wrong
      }
      if (onPath) fields.push({ key: "toPath", label: "Centre profile on the path", value: 0, type: "checkbox" });
      fields.push({ key: "turn", label: "Turn profile (°)", value: this.defaults.sweepTurn, step: 5 });
    }
    if (body?.kind === "solid") fields.push({ key: "newBody", label: "New solid", value: this.defaults.joinNew ? 1 : 0, type: "checkbox" });
    const todo = !body ? "click a flat face for the profile (a flat ring makes a tube)" : !wire ? "click a path or guide line to sweep along" : "";
    // What a click at the cursor picks: a guide line, a path, a flat face — or something that can't be used.
    type Target = { spine: Spine } | { profile: { bodyId: number; faceId: number } } | "bad" | null;
    const targetAt = (e: PointerEvent): Target => {
      const g = this.viewport.guideAt(e.clientX, e.clientY);
      if (g >= 0) return { spine: { guide: g } };
      const hit = this.viewport.pick(e.clientX, e.clientY, "face");
      const b = hit && this.doc.get(hit.body);
      if (!hit || !b) return null;
      if (b.kind === "path") return { spine: { path: b.id } };
      if (hit.kind === "face" && isBrep(b) && findFace(b.shape, hit.id)?.geomType === "PLANE") return { profile: { bodyId: b.id, faceId: hit.id } };
      return "bad";
    };
    const picked: SelItem[] = [];
    if (body) picked.push(body.kind === "face" ? { kind: "body", body: body.id, id: 0 } : { kind: "face", body: body.id, id: profile!.faceId });
    if (pathBody) picked.push({ kind: "body", body: pathBody.id, id: 0 });
    const pickedGuide = guide ? (spine as { guide: number }).guide : -1;
    const spec: OpSpec = {
      title: "Sweep",
      label: "Sweep",
      fields,
      note: `Profile: ${body ? (body.kind === "face" ? body.name : `a face of ${body.name}`) : "—"}<br>Path: ${guide ? "guide line" : pathBody ? pathBody.name : "—"}`,
      hint: `Sweep: ${todo ? `${todo} · ` : "click another face / path / guide line to change it · Enter apply · "}Esc cancel`,
      compute: ({ round, toPath, turn, newBody }) => {
        if (!body || !wire) throw new OpWaiting(todo);
        return this.profileOutcome(body, sweepFace(body.shape, profile!.faceId, wire, !onPath || !!toPath, !!round, turn), !!newBody, "Sweep");
      },
      remember: ({ round, turn, newBody }) => {
        this.defaults.sweepRound = round;
        if (turn !== undefined) this.defaults.sweepTurn = turn;
        if (newBody !== undefined) this.defaults.joinNew = !!newBody;
      },
      pick: (e) => {
        const t = targetAt(e);
        if (!t) return;
        if (t === "bad") return this.toast("Sweep: the profile must be a flat face — or click a path or guide line to sweep along", "error");
        spec.remember!(this.opValues().values); // (the panel opens again with them)
        if ("spine" in t) this.openSweep(profile, t.spine);
        else this.openSweep(t.profile, spine);
      },
      hover: (e) => {
        // Light up what a click would pick; "not allowed" over what it can't use.
        const t = targetAt(e);
        const item: SelItem | null = t && t !== "bad" && "profile" in t ? { kind: "face", body: t.profile.bodyId, id: t.profile.faceId }
          : t && t !== "bad" && "path" in t.spine ? { kind: "body", body: t.spine.path, id: 0 } : null;
        this.viewport.setHighlight(picked, item);
        this.viewport.setGuides(this.doc.guides, pickedGuide, t && t !== "bad" && "spine" in t && "guide" in t.spine ? t.spine.guide : -1);
        this.viewport.canvas.style.cursor = t === "bad" ? "not-allowed" : t ? "pointer" : "crosshair";
      },
    };
    this.startOp(spec);
    // Show what is picked: the profile face, the path, the guide.
    this.viewport.setHighlight(picked, null);
    this.viewport.setGuides(this.doc.guides, pickedGuide, -1);
  }

  /** Scale the selected objects about the bottom centre of their bounding box (they stay on the ground). */
  private opScale(): void {
    const ids = this.selectedBodyIds();
    if (!ids.length) {
      this.toast("Scale: select one or more objects first", "error");
      return;
    }
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const id of ids) {
      const [a, b] = this.doc.get(id)!.shape.boundingBox.bounds;
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i], a[i]);
        hi[i] = Math.max(hi[i], b[i]);
      }
    }
    const size = [0, 1, 2].map((i) => hi[i] - lo[i]);
    // About the bottom centre (the base stays put); "From the centre" (Shift while dragging the ring): about the middle.
    const base: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]];
    const centre: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    // Gizmo: X / Y / Z boxes on axis lines from the base set the per-axis %; the ring on the
    // top corner (dragged along the diagonal) sets the overall Scale % — with Shift, from the centre.
    const corner: V3 = [hi[0], hi[1], hi[2]];
    const diag: V3 = [corner[0] - base[0], corner[1] - base[1], corner[2] - base[2]];
    const half: V3 = [corner[0] - centre[0], corner[1] - centre[1], corner[2] - centre[2]];
    const len = Math.hypot(...diag);
    const drags: OpDrag[] = [];
    const axes = [["x", "#e5484d"], ["y", "#30a46c"], ["z", "#3e8bff"]] as const;
    axes.forEach(([key, color], i) => {
      const ext = hi[i] - base[i];
      if (ext < 1e-9) return; // flat along this axis
      const dir: V3 = [0, 0, 0];
      dir[i] = 1;
      drags.push({ origin: base, dir, key, unit: ext / 100, mul: "s", look: "box", color, line: true, title: `Drag to scale along ${key.toUpperCase()}` });
    });
    if (len > 1e-9) {
      drags.push({ origin: base, dir: diag, key: "s", unit: len / 100, look: "ring", color: "#ffd84a", line: true, title: "Drag to scale in all directions (Shift: about the centre)",
        shift: { key: "center", origin: centre, dir: half, unit: Math.hypot(...half) / 100 } });
    }
    const pct = (k: number) => k / 100;
    this.startOp({
      title: "Scale",
      label: "Scale",
      fields: [
        // (a typed size: "+10mm" / "60mm"... — X / Y / Z along that axis, Scale on the longest side)
        { key: "s", label: "Scale (% or ±mm)", value: 100, step: 5, min: 0, mm: Math.max(...size) },
        { key: "x", label: "X (% or ±mm)", value: 100, step: 5, min: 0, mm: size[0] },
        { key: "y", label: "Y (% or ±mm)", value: 100, step: 5, min: 0, mm: size[1] },
        { key: "z", label: "Z (% or ±mm)", value: 100, step: 5, min: 0, mm: size[2] },
        { key: "center", label: "From the centre (Shift while dragging the ring)", value: 0, type: "checkbox" },
      ],
      compute: ({ s, x, y, z, center }) => {
        const pivot = center ? centre : base;
        const f: V3 = [pct(s) * pct(x), pct(s) * pct(y), pct(s) * pct(z)];
        if (f.some((k) => !(k > 1e-6))) throw new Error("Scale must be greater than 0");
        // Preview: the current meshes stretched on the GPU (instant); the exact solids are built on Apply.
        const matrix = new THREE.Matrix4()
          .makeTranslation(...pivot)
          .multiply(new THREE.Matrix4().makeScale(...f))
          .multiply(new THREE.Matrix4().makeTranslation(-pivot[0], -pivot[1], -pivot[2]));
        return {
          ghost: new Map(),
          xform: { ids, matrix },
          commit: () => this.replaceOutcome(new Map(ids.map((id) => [id, scaleShape(this.doc.get(id)!.shape, f, pivot)])), "Scale").commit(),
        };
      },
      drag: drags.length ? drags : undefined,
    });
  }

  /** Cut: with solids selected, click a guide line; the solids are cut by the plane through it. */
  private startCut(): void {
    const ids = this.selectedBodyIds();
    if (!ids.length) {
      this.toast("Cut: select the solid(s) or flat face(s) to cut first, then press C and click a guide line", "error");
      return;
    }
    if (!this.doc.guides.length) {
      this.toast("Cut: draw a guide line on the solid first (Shift+L — two points or parallel to an edge)", "error");
      return;
    }
    const hover = (g: number) => {
      if (g === this.hoverGuide) return;
      this.hoverGuide = g;
      this.showGuides();
      this.viewport.canvas.style.cursor = g >= 0 ? "pointer" : "crosshair";
      this.showCutPlane(g >= 0 ? this.cutPlane(g, ids) : null, ids);
    };
    this.startTool({
      name: "Cut",
      move: (e) => hover(this.viewport.guideAt(e.clientX, e.clientY)),
      down: (e) => {
        const g = this.viewport.guideAt(e.clientX, e.clientY);
        if (g < 0) return this.hint("Cut: click a guide line (pink dashed)");
        this.endTool();
        this.opCut(ids, g);
      },
      key: () => false,
      dispose: () => {
        hover(-1);
        this.viewport.setOverlay([]);
      },
    });
    this.hint("Cut: hover a guide line to see its cut plane, click to cut — the plane runs straight across the face the guide was drawn on (off a flat face, e.g. on a sphere: along the line as seen when it was drawn) · Esc cancel");
    this.toast("Cut: select a guide line (click the pink dashed line) · Esc cancel");
  }

  /** Split face: with faces selected, click a guide line; each face is split where the guide's plane crosses it. */
  private startSplitFace(): void {
    const perBody = new Map<number, number[]>();
    for (const s of this.selection) if (s.kind === "face" && this.doc.get(s.body)?.kind === "solid") perBody.set(s.body, [...(perBody.get(s.body) ?? []), s.id]);
    if (!perBody.size) {
      this.toast("Split face: select the face(s) to split first (Face mode, key 2), then press Shift+C and click a guide line", "error");
      return;
    }
    if (!this.doc.guides.length) {
      this.toast("Split face: draw a guide line first (Shift+L — two points or parallel to an edge)", "error");
      return;
    }
    const ids = [...perBody.keys()];
    const hover = (g: number) => {
      if (g === this.hoverGuide) return;
      this.hoverGuide = g;
      this.showGuides();
      this.viewport.canvas.style.cursor = g >= 0 ? "pointer" : "crosshair";
      this.showCutPlane(g >= 0 ? this.cutPlane(g, ids) : null, ids);
    };
    this.startTool({
      name: "Split face",
      move: (e) => hover(this.viewport.guideAt(e.clientX, e.clientY)),
      down: (e) => {
        const g = this.viewport.guideAt(e.clientX, e.clientY);
        if (g < 0) return this.hint("Split face: click a guide line (pink dashed)");
        this.endTool();
        this.opSplitFace(perBody, g);
      },
      key: () => false,
      dispose: () => {
        hover(-1);
        this.viewport.setOverlay([]);
      },
    });
    this.hint("Split face: hover a guide line to see its plane, click to split the selected face(s) along it — the solid stays one piece · Esc cancel");
    this.toast("Split face: select a guide line (click the pink dashed line) · Esc cancel");
  }

  /** Split the faces where the guide's plane crosses them (one undo step); the pieces are selected. */
  private opSplitFace(perBody: Map<number, number[]>, guideIndex: number): void {
    const shapes = new Map<number, Shape>();
    const pieces: SelItem[] = [];
    try {
      const { point, normal } = this.cutPlane(guideIndex, [...perBody.keys()]);
      for (const [id, faces] of perBody) {
        const r = splitFacesByPlane(this.solidOf(id, "Split face"), faces, point, normal);
        shapes.set(id, r.shape);
        for (const f of r.faces) pieces.push({ kind: "face", body: id, id: f });
      }
    } catch (e) {
      this.toast(errorMessage(e), "error");
      return;
    }
    this.doc.commit(this.doc.bodies.map((b) => (shapes.has(b.id) ? withShape(b, shapes.get(b.id)!) : b)), "Split face");
    this.setMode("face");
    this.setSelection(pieces);
    this.toast(`Split into ${pieces.length} faces — they are selected (Push/Pull moves just one part)`);
  }

  /** Current viewing direction (camera forward). */
  private viewDir(): V3 {
    return this.viewport.camera.getWorldDirection(new THREE.Vector3()).toArray() as V3;
  }

  /**
   * The cut plane of a guide: straight across the face of the solids being cut that it lies on
   * (unless its stored direction already is), else its stored direction, else (older files) the view;
   * off a face, guides along X / Y / Z snap to the nearest world plane.
   */
  private cutPlane(guideIndex: number, ids: number[]): { point: V3; normal: V3 } {
    const { a, b, n } = this.doc.guides[guideIndex];
    return { point: a, normal: guidePlaneNormal(ids.map((id) => this.doc.get(id)!.shape).filter(notMesh), a, b, this.viewDir(), n) };
  }

  /** Translucent square of the cut plane across the solids being cut (null hides it). */
  private showCutPlane(plane: { point: V3; normal: V3 } | null, ids: number[]): void {
    if (!plane) return this.viewport.setOverlay([]);
    const box = new THREE.Box3();
    for (const id of ids) {
      const [lo, hi] = this.doc.get(id)!.shape.boundingBox.bounds;
      box.expandByPoint(new THREE.Vector3(...lo)).expandByPoint(new THREE.Vector3(...hi));
    }
    const N = new THREE.Vector3(...plane.normal).normalize(), P = new THREE.Vector3(...plane.point);
    const c = box.getCenter(new THREE.Vector3());
    c.addScaledVector(N, -c.clone().sub(P).dot(N)); // box centre dropped onto the plane
    const size = Math.max(box.getSize(new THREE.Vector3()).length() * 1.15, 1);
    // Square edges along the guide and across it.
    const g = this.doc.guides[this.hoverGuide];
    const u = g ? new THREE.Vector3(...g.b).sub(new THREE.Vector3(...g.a)).normalize() : new THREE.Vector3(1, 0, 0);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, N.clone().cross(u), N));
    const geo = new THREE.PlaneGeometry(size, size);
    const sheet = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xff6fb5, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
    const rim = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0xff6fb5, depthTest: false, transparent: true }));
    for (const o of [sheet, rim]) {
      o.quaternion.copy(q);
      o.position.copy(c);
    }
    this.viewport.setOverlay([sheet, rim]);
  }

  /**
   * Cut the solids by the plane through a guide line; each one becomes two objects (one undo step).
   * Flat faces (a drawn rectangle, circle...) are cut into separate faces the same way.
   */
  private opCut(ids: number[], guideIndex: number): void {
    const kept = new Map<number, Shape>();
    const cutOff: Body[] = [];
    const facePieces: number[] = [];
    try {
      const { point, normal } = this.cutPlane(guideIndex, ids);
      for (const id of ids) {
        const body = this.doc.get(id)!;
        if (body.kind === "face") {
          const [first, ...rest] = cutFaceByPlane(body.shape as Parameters<typeof cutFaceByPlane>[0], point, normal);
          kept.set(id, first);
          const made = rest.map((f) => inGroupOf(this.doc.makeBody(f, "Face", "face"), body));
          cutOff.push(...made);
          facePieces.push(id, ...made.map((b) => b.id));
          continue;
        }
        const { above, below } = splitByPlane(this.solidOf(id, "Cut"), point, normal);
        if (!above || !below) throw new Error(`Cut: the guide's cut plane does not pass through "${body.name}"`);
        kept.set(id, below);
        cutOff.push(inGroupOf(this.doc.makeBody(above, "Solid"), body));
      }
    } catch (e) {
      this.toast(errorMessage(e), "error");
      return;
    }
    this.doc.commit([...this.doc.bodies.map((bd) => (kept.has(bd.id) ? withShape(bd, kept.get(bd.id)!) : bd)), ...cutOff], "Cut");
    const solidPieces = cutOff.filter((b) => b.kind !== "face");
    if (!solidPieces.length) {
      // Only faces: select all the pieces (each can be moved / pushed on its own).
      this.setSelection(facePieces.map((id) => ({ kind: "body", body: id, id: 0 })));
      this.toast(`Cut into ${facePieces.length} separate faces — they are selected`);
      return;
    }
    // Select the upper pieces, so Del removes them straight away.
    this.setSelection(solidPieces.map((bd) => ({ kind: "body", body: bd.id, id: 0 })));
    this.toast(`Cut into ${ids.length * 2} objects — the upper part is selected (Del removes it)`);
  }

  // ================================================================ booleans

  private boolean(op: BooleanOp): void {
    this.endInteractions();
    const ids = this.selectedBodyIds();
    const label = { union: "Union", subtract: "Subtract", intersect: "Intersect" }[op];
    if (ids.length === 1) return this.pickBooleanTool(op, ids[0], label);
    if (ids.length < 2) {
      this.toast("Boolean: select a solid first (then press the key and click the other solid).", "error");
      return;
    }
    const flat = this.faceBodiesIn(ids);
    if (flat.length) {
      this.toast(`Booleans work on solids — "${flat[0].name}" is a flat face. Push/Pull it first.`, "error");
      return;
    }
    const [targetId, ...toolIds] = ids;
    const made = this.applyBoolean(op, targetId, toolIds, label);
    if (!made) return;
    this.setMode("body");
    this.setSelection(made.map((id) => ({ kind: "body", body: id, id: 0 })));
  }

  /**
   * Combine `toolIds` into `targetId` (keeps its id; union/intersect results are renamed "Solid N"); one undo step.
   * A result in separate pieces (e.g. a bar cut through) becomes one body per piece: the largest
   * keeps the target's id. Returns the resulting body ids, or null (with a message, nothing changed)
   * if a union would leave solids that don't touch in one body. Throws on failure.
   */
  private applyBoolean(op: BooleanOp, targetId: number, toolIds: number[], label: string): number[] | null {
    const target = this.doc.get(targetId)!;
    const tools = toolIds.map((id) => this.doc.get(id)!);
    const result = booleanOp(op, this.solidOf(targetId, label), toolIds.map((id) => this.solidOf(id, label)));
    if (result.faces.length === 0) throw new Error("result is empty (the solids do not overlap?)");
    const pieces = solidPieces(result);
    if (op === "union" && pieces.length > 1) {
      // One body must be one solid: solids that don't touch stay separate objects.
      const main = pieces.find((p) => shapesTouch(p, this.solidOf(targetId, label))) ?? pieces[0];
      const apart = tools.filter((b) => !shapesTouch(main, this.solidOf(b.id, label)));
      const names = (apart.length ? apart : tools).map((b) => `"${b.name}"`);
      const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
      this.toast(`"${target.name}" and ${list} don't touch — nothing to join`, "error");
      return null;
    }
    const removed = new Set(toolIds);
    const name = op !== "subtract" && !/^Solid \d+$/.test(target.name) ? this.doc.nextName("Solid") : target.name;
    // One body per piece, largest first (it keeps the target's id and name).
    const parts = pieces.length > 1 ? pieces.map((p) => ({ p, v: solidVolume(p) })).sort((a, b) => b.v - a.v).map(({ p }) => p) : [result];
    const extra = parts.slice(1).map((p) => inGroupOf(this.doc.makeBody(p, name), target));
    const next = this.doc.bodies
      .filter((b) => !removed.has(b.id))
      .flatMap((b) => (b.id === targetId ? [{ ...withShape(b, parts[0]), name }, ...extra] : [b]));
    this.doc.commit(next, label);
    this.toast(extra.length ? `${label}: "${name}" split into ${parts.length} solids` : `${label}: ${name}`);
    return [targetId, ...extra.map((b) => b.id)];
  }

  /** A + key + B (+ C ...): each click on another solid applies the operation to A right away. */
  private pickBooleanTool(op: BooleanOp, targetId: number, label: string): void {
    const target = this.doc.get(targetId);
    if (!target) return;
    const verb = op === "subtract" ? "subtract from" : op === "union" ? "join with" : "intersect with";
    let count = 0;
    const msg = () =>
      `${label}: click a solid to ${verb} "${target.name}" (or a group / object in the Bodies panel)` + (count ? ` (${count} done) · keep clicking for more` : "") +
      " · Esc / Enter / empty click to finish";
    const pickAt = (e: PointerEvent) => {
      const p = this.viewport.pick(e.clientX, e.clientY, "body");
      return p && p.body !== targetId ? p.body : null;
    };
    const show = (hover: number | null) =>
      this.viewport.setHighlight([{ kind: "body", body: targetId, id: 0 }], hover === null ? null : { kind: "body", body: hover, id: 0 });
    const finish = () => {
      this.endTool();
      this.setSelection([{ kind: "body", body: targetId, id: 0 }]);
    };
    /** Apply with these solids (a click in the viewport: one; in the Bodies panel: one, or a whole group). */
    const apply = (ids: number[]) => {
      ids = ids.filter((id) => id !== targetId);
      if (!ids.length) return;
      const face = ids.map((id) => this.doc.get(id)).find((b) => b?.kind === "face");
      if (face) {
        this.toast(`Booleans work on solids — "${face.name}" is a flat face. Push/Pull it first.`, "error");
        return;
      }
      try {
        if (this.applyBoolean(op, targetId, ids, label)) count += ids.length;
      } catch (err) {
        this.fail(err);
      }
      show(null);
      this.hint(msg());
    };
    const tool: Tool = {
      name: label,
      move: (e) => show(pickAt(e)),
      down: (e) => {
        const id = pickAt(e);
        if (id === null) return finish();
        apply([id]);
      },
      key: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          finish();
          return true;
        }
        return false;
      },
      dispose: () => {
        if (this.outlinerPick === apply) this.outlinerPick = null;
      },
    };
    this.setMode("body");
    this.startTool(tool);
    this.outlinerPick = apply;
    this.viewport.canvas.style.cursor = "pointer";
    show(null);
    this.hint(msg());
    this.toast(`${label} tool: click solids to ${verb} "${target.name}" — or a group in the Bodies panel · Esc to finish`);
  }

  // ================================================================ transforms

  private startTransform(mode: "translate" | "rotate", keep = false, pivot?: V3): void {
    pivot ??= keep ? this.xf?.pivot : undefined;
    if (!keep) {
      this.endTool();
      this.cancelOp();
      this.lastXf = null;
      this.repeatOps = [];
      this.placing = null; // a new move session is its own undo step (Duplicate sets it again after this)
    }
    const ids = this.selectedBodyIds();
    if (!ids.length) {
      this.toast(`${mode === "translate" ? "Move" : "Rotate"}: select one or more solids first`, "error");
      return;
    }
    this.xf = { mode, ids, pivot };
    this.viewport.startTransform(mode, ids, this.snap, (r) => this.applyTransform(r), pivot);
    this.renderToolbarState();
    this.hint(`${mode === "translate" ? "Move" : "Rotate"}: drag the gizmo handles (hold Ctrl to snap to grid / 15° / points) · Tab: type exact values · Enter/Esc: done`);
  }

  /** G with edges selected: drag them with the gizmo, reshaping their (flat-faced) solids. */
  private startEdgeMove(keep = false): void {
    if (!keep) {
      this.endTool();
      this.cancelOp();
      this.lastXf = null;
      this.repeatOps = [];
    }
    const edges = this.selection.filter((s) => s.kind === "edge");
    const ok = edges.length > 0 && [...new Set(edges.map((s) => s.body))].every((id) => {
      const b = this.doc.get(id);
      return b?.kind === "solid" && canMoveEdges(b.shape, new Set(edges.filter((s) => s.body === id).map((s) => s.id)));
    });
    const ends = ok ? edgeEnds(this.brep(edges[0].body), edges[0].id) : null;
    if (!ends) {
      this.stopTransform();
      this.toast(MOVE_EDGE_REFUSED, "error");
      return;
    }
    const mid: V3 = [(ends[0][0] + ends[1][0]) / 2, (ends[0][1] + ends[1][1]) / 2, (ends[0][2] + ends[1][2]) / 2];
    this.edgePreview = null;
    this.viewport.clearGhost();
    this.xf = { mode: "translate", ids: [], pivot: mid, edges };
    this.viewport.startTransform("translate", [], this.snap, (r) => r.type === "translate" && this.applyEdgeMove(r.vector, true), mid, (d) => this.previewEdgeMove(d));
    this.renderToolbarState();
    this.hint("Move edge: drag the gizmo (hold Ctrl to snap to grid / points) · Tab: exact offset · Enter/Esc: done");
  }

  /** G with a guide line selected: move it with the gizmo (Ctrl snaps to points, other guides, axes). */
  private startGuideMove(keep = false): void {
    if (!keep) {
      this.endTool();
      this.cancelOp();
      this.lastXf = null;
      this.repeatOps = [];
    }
    const g = this.selGuide;
    const guide = this.doc.guides[g];
    if (!guide) return this.stopTransform();
    const mid: V3 = [(guide.a[0] + guide.b[0]) / 2, (guide.a[1] + guide.b[1]) / 2, (guide.a[2] + guide.b[2]) / 2];
    this.xf = { mode: "translate", ids: [], pivot: mid, guide: g };
    this.viewport.snapSkipGuide = g;
    this.viewport.startTransform("translate", [], this.snap, (r) => r.type === "translate" && this.applyGuideMove(r.vector, true), mid, (d) => this.previewGuideMove(d));
    this.renderToolbarState();
    this.hint("Move guide: drag the gizmo (hold Ctrl to snap to grid / points / other guides) · Tab: exact offset · Enter/Esc: done");
  }

  private movedGuides(v: V3): { a: V3; b: V3 }[] {
    const g = this.xf?.guide ?? -1;
    const add = (p: V3): V3 => [p[0] + v[0], p[1] + v[1], p[2] + v[2]];
    return this.doc.guides.map((gd, i) => (i === g ? { ...gd, a: add(gd.a), b: add(gd.b) } : gd));
  }

  private previewGuideMove(d: V3): void {
    if (this.xf?.guide === undefined) return;
    this.viewport.setGuides(this.movedGuides(d), this.selGuide, -1);
    this.hint(`Move guide: Δ ${d.map((n) => +n.toFixed(2)).join(", ")} · release to apply · Tab: exact offset · Enter/Esc: done`);
  }

  private applyGuideMove(v: V3, dragged = false): void {
    if (this.xf?.guide === undefined) return;
    if (Math.hypot(...v) > 1e-12) {
      this.doc.setGuides(this.movedGuides(v), "Move guide");
      this.lastGuideMove = dragged ? { v, guide: this.xf.guide, version: this.doc.version } : null;
    }
    this.startGuideMove(true); // the gizmo follows the guide for the next drag
  }

  /** The solids reshaped by moving `edges` by `d`, keyed by body id. Throws if a solid can't take it. */
  private edgeMoveShapes(edges: SelItem[], d: V3): Map<number, Shape> {
    const byBody = new Map<number, Set<number>>();
    for (const e of edges) byBody.set(e.body, (byBody.get(e.body) ?? new Set<number>()).add(e.id));
    const out = new Map<number, Shape>();
    for (const [id, ids] of byBody) out.set(id, moveEdges(this.doc.get(id)!.shape as Solid, ids, d));
    return out;
  }

  private previewEdgeMove(d: V3): void {
    const queued = this.edgePreview !== null;
    this.edgePreview = d;
    if (queued) return;
    requestAnimationFrame(() => {
      const v = this.edgePreview;
      this.edgePreview = null;
      if (!v || !this.xf?.edges) return;
      try {
        this.viewport.showGhost(this.edgeMoveShapes(this.xf.edges, v));
        this.hint(`Move edge: Δ ${v.map((n) => +n.toFixed(2)).join(", ")} · release to apply · Tab: exact offset · Enter/Esc: done`);
      } catch (e) {
        this.viewport.clearGhost();
        this.hint(`Move edge: ${errorMessage(e)}`);
      }
    });
  }

  private applyEdgeMove(v: V3, dragged = false): void {
    const edges = this.xf?.edges;
    if (!edges) return;
    this.edgePreview = null;
    this.viewport.clearGhost();
    let shapes: Map<number, Shape>;
    try {
      shapes = this.edgeMoveShapes(edges, v);
    } catch (e) {
      this.toast(errorMessage(e), "error");
      this.startEdgeMove(true); // gizmo back on the unchanged edge
      return;
    }
    const before = edges.map((e) => ({ body: e.body, ends: edgeEnds(this.brep(e.body), e.id) }));
    this.doc.replaceShapes(shapes, edges.length > 1 ? "Move edges" : "Move edge");
    const version = this.doc.version;
    // Keep the moved edges selected (their ids change with the rebuilt solid); the gizmo follows them.
    const add = (p: V3): V3 => [p[0] + v[0], p[1] + v[1], p[2] + v[2]];
    const next = before.flatMap(({ body, ends }): SelItem[] => {
      const b = this.doc.get(body), shape = b && isBrep(b) ? b.shape : null;
      const id = shape && ends ? edgeBetween(shape, add(ends[0]), add(ends[1])) : null;
      return id !== null && id !== undefined ? [{ kind: "edge", body, id }] : [];
    });
    this.lastEdgeMove = dragged ? { v, edges, after: next, version } : null;
    this.setSelection(next);
    if (!next.length) this.toast("Edge moved (it merged into a neighbouring face)");
  }

  /** Why Divide face can't work on this body (shown to the user), or null if it can. */
  private divideRefusal(bodyId: number): string | null {
    const body = this.doc.get(bodyId);
    if (!body) return "Divide face: click an edge of a solid";
    if (body.kind === "face") return `Divide face works on solids only — "${body.name}" is a flat face. Push/Pull it (P) into a solid first.`;
    if (body.kind === "mesh") return `Divide face can't edit "${body.name}" — it's an imported STL mesh`;
    return null;
  }

  /** Divide face (L): split the face under the line a–b; the new edge is left selected (G lifts it, e.g. into a gable). */
  private divideFace(bodyId: number, a: V3, b: V3): void {
    const why = this.divideRefusal(bodyId);
    if (why) return this.toast(why, "error");
    const body = this.doc.get(bodyId)!;
    let shape: Solid;
    try {
      shape = splitFaceByLine(body.shape as Solid, a, b);
    } catch (e) {
      return this.toast(errorMessage(e), "error"); // keep the tool so the user can retry
    }
    this.endTool();
    this.doc.replaceShapes(new Map([[bodyId, shape]]), "Divide face");
    const id = edgeBetween(shape, a, b, 1e-3);
    this.setMode("edge");
    this.setSelection(id === null ? [] : [{ kind: "edge", body: bodyId, id }]);
    this.toast("Face split — G moves the new edge");
  }

  /** Adjacent flat faces of an edge, each with the edge seen from that face. */
  private edgeSides(bodyId: number, edgeId: number): EdgeSides | null {
    const b = this.doc.get(bodyId);
    if (!b || !isBrep(b)) return null;
    const faces = b.shape.faces.flatMap((f) => {
      const ref = faceRefEdges(b.shape, f.hashCode)?.edges.find((e) => e.id === edgeId);
      return ref ? [{ faceId: f.hashCode, ref }] : [];
    });
    return faces.length ? { bodyId, faces } : null;
  }

  /** Measure (=): hover a point, edge or face to see its sizes in the HUD. */
  private startMeasure(): void {
    const shapeOf = (id: number) => {
      const b = this.doc.get(id);
      return b && isBrep(b) ? b.shape : null;
    };
    const dims = {
      preview: (d: Dimension | null) => this.showDimensions(d),
      add: (d: Dimension) => {
        this.doc.setDimensions([...this.doc.dimensions, d], "Add dimension");
        this.toast("Dimension added — click its text to select it, Del removes it");
      },
      count: () => this.doc.dimensions.length,
      clear: () => {
        const n = this.doc.dimensions.length;
        if (!n) return;
        this.selDim = -1;
        this.doc.setDimensions([], "Delete all dimensions");
        this.toast(`Deleted ${n} dimension${n > 1 ? "s" : ""} — Ctrl+Z brings ${n > 1 ? "them" : "it"} back`);
      },
    };
    this.startTool(new MeasureTool(this, shapeOf, (item) => this.viewport.setHighlight(this.selection, item), () => this.endTool(), dims).start());
  }

  /**
   * Sketch (K) on the selected flat face (or flat face object) — or, with nothing like that
   * selected, on the ground. Done adds the closed outlines as flat faces.
   */
  private startSketch(): void {
    let frame = { origin: new THREE.Vector3(), x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
    let center = new THREE.Vector3(), what = "the ground";
    const s = this.selection.length === 1 ? this.selection[0] : null;
    const b = s ? this.doc.get(s.body) : undefined;
    const faceId = s?.kind === "face" ? s.id : s?.kind === "body" && b?.kind === "face" ? b.shape.faces[0].hashCode : null;
    if (b && faceId !== null) {
      const f = isBrep(b) ? planarFaceFrame(b.shape, faceId) : null;
      if (!f || !isBrep(b)) return this.toast("Sketch: select a flat face — or nothing, to sketch on the ground", "error");
      const v = (t: V3) => new THREE.Vector3(...t);
      frame = { origin: v(f.origin), x: v(f.x), y: v(f.y), z: v(f.z) };
      // A side face's frame has x up the wall: turn it a quarter so y is up (the view stays upright, width runs along)
      if (Math.abs(frame.z.z) <= 0.9) frame = { ...frame, x: frame.y.clone().negate(), y: frame.x };
      center = v(faceAxis(b.shape, faceId)?.center ?? f.origin);
      what = b.kind === "face" ? `"${b.name}"` : `a face of "${b.name}"`;
    }
    this.endInteractions();
    this.setSelection([]); // (the face's selection colour would cover the sketch)
    const tool = new SketchTool(this, frame, center, what, (faces, paths) => {
      this.endTool();
      if (!faces.length && !paths.length) return this.toast("Sketch closed — nothing drawn to keep");
      const made = [...faces.map((f) => this.doc.makeBody(f, "Sketch", "face")), ...paths.map((w) => this.doc.makeBody(w, "Path", "path"))];
      this.doc.commit([...this.doc.bodies, ...made], "Sketch");
      this.setMode("body");
      this.setSelection(made.map((m) => ({ kind: "body", body: m.id, id: 0 })));
      const n = (k: number, what: string) => (k ? `${k} ${what}${k > 1 ? "s" : ""}` : "");
      this.toast(`${[n(faces.length, "face"), n(paths.length, "path")].filter(Boolean).join(" and ")} from the sketch${faces.length ? " — press P to push/pull a face" : ""}`);
    }, () => {
      this.endTool();
      this.toast("Sketch cancelled");
    });
    this.startTool(tool.start());
  }

  /** Guide line tool; with an edge given (edge + Shift+D) it starts from that edge. */
  private startGuide(bodyId?: number, edgeId?: number): void {
    if (bodyId !== undefined && edgeId !== undefined && !this.edgeSides(bodyId, edgeId)) {
      return this.toast("Guide line: the edge must be straight and next to a flat face", "error");
    }
    this.endInteractions();
    this.startTool(
      new GuideTool(this, (bid, eid) => this.edgeSides(bid, eid), (lines) => {
        this.endTool();
        // Fix each guide's cut direction now: the face it lies on, or the view it was drawn in.
        const view = this.viewDir();
        const shapes = this.doc.bodies.map((b) => b.shape).filter(notMesh);
        const made = lines.map((l) => ({ ...l, n: guidePlaneNormal(shapes, l.a, l.b, view) }));
        this.doc.setGuides([...this.doc.guides, ...made], lines.length > 1 ? `Add ${lines.length} guides` : "Add guide");
        this.toast(`Added ${lines.length} guide line(s) — hold Ctrl to snap to them`);
      }).start(bodyId, edgeId),
    );
    this.toast(
      bodyId !== undefined && edgeId !== undefined
        ? "Guide line: move across the face, click (or type a distance) to add · Esc cancel"
        : "Guide line: click an edge for a parallel guide, or click two points (locks to X / Y / Z when close) · Esc cancel",
    );
  }

  private selGuide = -1;
  private hoverGuide = -1;
  /** Selected dimension (click its text), -1 = none. */
  private selDim = -1;

  /** Draw the dimensions (and `preview`, one being placed by Measure + Tab). */
  private showDimensions(preview: Dimension | null = null): void {
    if (this.selDim >= this.doc.dimensions.length) this.selDim = -1;
    this.viewport.setDimensions(this.doc.dimensions, this.selDim, preview);
  }

  private selectDimension(i: number): void {
    if (i < 0) return;
    this.selDim = i;
    this.selGuide = -1;
    this.showGuides();
    this.setSelection([]);
    this.showDimensions();
    this.hint("Dimension selected · Del removes it · Esc deselects");
  }

  private showGuides(): void {
    if (this.selGuide >= this.doc.guides.length) this.selGuide = -1;
    if (this.hoverGuide >= this.doc.guides.length) this.hoverGuide = -1;
    this.viewport.setGuides(this.doc.guides, this.selGuide, this.hoverGuide);
  }

  /** Base-point move: pick a point on/near the selection, then a target point. */
  private startPointMove(): void {
    const ids = this.selectedBodyIds();
    if (!ids.length) {
      this.toast("Move from point: select one or more solids first", "error");
      return;
    }
    this.startTool(
      new PointMoveTool(this, ids, (d) => {
        this.endTool();
        this.repeatOps = [{ type: "translate", vector: d }];
        const shapes = new Map<number, Geom>();
        for (const id of ids) {
          const b = this.doc.get(id);
          if (b) shapes.set(id, translateShape(b.shape, d));
        }
        this.doc.replaceShapes(shapes, "Move");
      },
        (p) => {
          this.endTool();
          this.setSelection(ids.map((id) => ({ kind: "body", body: id, id: 0 })));
          this.startTransform("translate", false, [...p] as V3);
          this.hint("Move: drag the gizmo from the picked mark (Ctrl snaps) · Tab: exact values · Enter/Esc: done");
        }).start(),
    );
  }

  /**
   * Copies just made by Shift+D: moving them in that same gizmo session is part of the Duplicate
   * undo step (so Undo removes the copy, not just its move, which would leave it hidden in place).
   */
  private placing: { ids: string; version: number } | null = null;

  /** Commit gizmo / Tab moves of the transformed bodies (folded into Duplicate while placing a copy). */
  private commitTransform(shapes: Map<number, Geom>, label: string): void {
    const p = this.placing;
    if (p && this.xf && p.ids === this.xf.ids.join() && p.version === this.doc.version) {
      this.doc.amend(this.doc.bodies.map((b) => (shapes.has(b.id) ? withShape(b, shapes.get(b.id)!) : b)));
      p.version = this.doc.version;
    } else {
      this.doc.replaceShapes(shapes, label);
    }
  }

  /** Last gizmo drag, so Tab can prefill (and correct) it. */
  private lastXf: { r: TransformResult; ids: string } | null = null;

  private applyTransform(r: TransformResult): void {
    if (!this.xf) return;
    this.lastXf = { r, ids: this.xf.ids.join() };
    this.repeatOps.push(r);
    this.shiftPivot([r]);
    const shapes = new Map<number, Geom>();
    for (const id of this.xf.ids) {
      const b = this.doc.get(id);
      if (!b) continue;
      shapes.set(id, r.type === "translate" ? translateShape(b.shape, r.vector) : rotateShape(b.shape, r.angleDeg, r.center, r.axis));
    }
    const mode = this.xf.mode;
    this.commitTransform(shapes, mode === "translate" ? "Move" : "Rotate");
    this.startTransform(mode, true); // keep the gizmo on the moved bodies
  }

  /** Keep an explicit gizmo pivot (from Shift+G) on the moved bodies. */
  private shiftPivot(rs: TransformResult[]): void {
    const p = this.xf?.pivot;
    if (!p) return;
    for (const r of rs) if (r.type === "translate") for (let k = 0; k < 3; k++) p[k] += r.vector[k];
  }

  /** Move/rotate steps of the current transform session (for Shift+R). */
  private repeatOps: TransformResult[] = [];
  /** Ids of the bodies made by the last duplicate: moving them makes Shift+R copy again. */
  private repeatCopyIds = "";

  /** Shift+R: repeat the last move/rotate on the selection; if it was a copy+move, copy again (array). */
  private repeatLast(): void {
    const ops = [...this.repeatOps];
    if (!ops.length) return this.toast("Repeat: move or rotate something first (e.g. Shift+D then drag)", "error");
    const ids = this.selectedBodyIds();
    if (!ids.length) return this.toast("Repeat: select solids first", "error");
    const xform = (s: Geom): Geom =>
      ops.reduce<Geom>((acc, r) => (r.type === "translate" ? translateShape(acc, r.vector) : rotateShape(acc, r.angleDeg, r.center, r.axis)), s);
    // Rotations pivot on their original centre; moving that centre along with the copy keeps polar arrays working.
    const shiftOps = (): void => {
      let off: V3 = [0, 0, 0];
      for (const r of ops) {
        if (r.type === "translate") off = [off[0] + r.vector[0], off[1] + r.vector[1], off[2] + r.vector[2]];
      }
      this.repeatOps = ops.map((r) => (r.type === "rotate" ? { ...r, center: [r.center[0] + off[0], r.center[1] + off[1], r.center[2] + off[2]] as V3 } : r));
    };
    const mode = this.xf?.mode;
    if (this.repeatCopyIds === ids.join()) {
      const copies = ids.map((id) => {
        const b = this.doc.get(id)!;
        return this.doc.makeBody(xform(cloneShape(b.shape)), b.name.replace(/\s+\d+$/, ""), b.kind);
      });
      this.doc.commit([...this.doc.bodies, ...copies], "Repeat copy");
      this.setSelection(copies.map((b) => ({ kind: "body", body: b.id, id: 0 })));
      this.repeatCopyIds = copies.map((b) => b.id).join();
      this.toast(`Repeated copy (${copies.length})`);
    } else {
      const shapes = new Map<number, Geom>();
      for (const id of ids) {
        const b = this.doc.get(id);
        if (b) shapes.set(id, xform(b.shape));
      }
      this.doc.replaceShapes(shapes, "Repeat");
      this.toast("Repeated move/rotate");
    }
    this.shiftPivot(ops);
    shiftOps();
    if (mode) this.startTransform(mode, true);
  }

  /** Tab during Move/Rotate: exact offset or angles. */
  private transformDialog(): void {
    if (!this.xf) return;
    const r3 = (n: number) => +n.toFixed(3);
    const fields = (v: V3) => [{ label: "ΔX", value: r3(v[0]) }, { label: "ΔY", value: r3(v[1]) }, { label: "ΔZ", value: r3(v[2]) }];
    const same = (a: V3, b: number[]) => a.every((x, k) => Math.abs(x - b[k]) < 1e-9);
    if (this.xf.guide !== undefined) {
      // Just moved (dragged)? Prefilled with that move; OK replaces it (one undo step).
      const last = this.lastGuideMove?.version === this.doc.version && this.lastGuideMove.guide === this.xf.guide ? this.lastGuideMove : null;
      this.propsDialog(last ? "Move guide (last drag)" : "Move guide by", fields(last?.v ?? [0, 0, 0]), ([x, y, z]) => {
        if (last) {
          if (same(last.v, [x, y, z])) return;
          this.doc.undo();
        }
        if (x || y || z || last) this.applyGuideMove([x, y, z]);
      }, "Move");
      return;
    }
    if (this.xf.edges) {
      // Just moved (dragged)? Prefilled with that move; OK replaces it (one undo step).
      // (only while the gizmo is still on the edges that drag left — not after picking others)
      const key = (items: SelItem[]) => items.map((x) => `${x.body}:${x.id}`).sort().join();
      const last = this.lastEdgeMove?.version === this.doc.version && key(this.lastEdgeMove.after) === key(this.xf.edges) ? this.lastEdgeMove : null;
      this.propsDialog(last ? "Move edge (last drag)" : "Move edge by", fields(last?.v ?? [0, 0, 0]), ([x, y, z]) => {
        if (!last) {
          if (x || y || z) this.applyEdgeMove([x, y, z]);
          return;
        }
        if (same(last.v, [x, y, z])) return;
        const moved = this.selection;
        this.doc.undo();
        const version = this.doc.version;
        this.setSelection(last.edges); // (the gizmo back on the edges where they were)
        if (!(x || y || z)) return; // (all 0: the drag is just taken back)
        this.applyEdgeMove([x, y, z]);
        if (this.doc.version === version) {
          // (refused: put the dragged move back)
          this.doc.redo();
          this.setSelection(moved);
        }
      }, "Move");
      return;
    }
    const { mode, ids } = this.xf;
    const apply = (fn: (s: Geom) => Geom, label: string, ...rs: TransformResult[]): void => {
      this.repeatOps.push(...rs);
      this.shiftPivot(rs);
      const shapes = new Map<number, Geom>();
      for (const id of ids) {
        const b = this.doc.get(id);
        if (b) shapes.set(id, fn(b.shape));
      }
      this.commitTransform(shapes, label);
      this.startTransform(mode, true);
    };
    // Just dragged the gizmo? Edit that drag: same axis, prefilled with the dragged amount.
    const last = this.lastXf && this.lastXf.ids === ids.join() ? this.lastXf.r : null;
    if (last?.type === "rotate" && mode === "rotate") {
      const ax = last.axis.map((n) => Math.abs(n));
      const name = ax[0] > 0.999 ? "X" : ax[1] > 0.999 ? "Y" : ax[2] > 0.999 ? "Z" : "gizmo axis";
      this.propsDialog(`Rotate about ${name} (last drag)`, [{ label: "Angle °", value: r3(last.angleDeg), step: 15 }], ([a]) => {
        const extra = a - last.angleDeg;
        if (Math.abs(extra) > 1e-9) apply((s) => rotateShape(s, extra, last.center, last.axis), "Rotate", { ...last, angleDeg: extra });
        this.lastXf = { r: { ...last, angleDeg: a }, ids: ids.join() };
      }, "Rotate");
      return;
    }
    if (last?.type === "translate" && mode === "translate") {
      const v = last.vector;
      this.propsDialog("Move (last drag)", [{ label: "ΔX", value: r3(v[0]) }, { label: "ΔY", value: r3(v[1]) }, { label: "ΔZ", value: r3(v[2]) }], (n) => {
        const d: V3 = [n[0] - v[0], n[1] - v[1], n[2] - v[2]];
        if (d.some((x) => Math.abs(x) > 1e-9)) apply((s) => translateShape(s, d), "Move", { type: "translate", vector: d });
        this.lastXf = { r: { type: "translate", vector: [n[0], n[1], n[2]] }, ids: ids.join() };
      }, "Move");
      return;
    }
    if (mode === "translate") {
      this.propsDialog("Move by", [{ label: "ΔX", value: 0 }, { label: "ΔY", value: 0 }, { label: "ΔZ", value: 0 }], ([x, y, z]) => {
        if (x || y || z) apply((s) => translateShape(s, [x, y, z]), "Move", { type: "translate", vector: [x, y, z] });
      }, "Move");
      return;
    }
    // Rotate about the selection's bounding-box centre, X then Y then Z.
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const id of ids) {
      const bb = this.doc.get(id)?.shape.boundingBox.bounds;
      if (!bb) continue;
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], bb[0][k]);
        hi[k] = Math.max(hi[k], bb[1][k]);
      }
    }
    const c: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    const f = (label: string): PropField => ({ label, value: 0, step: 15 });
    this.propsDialog("Rotate by (about selection centre)", [f("X °"), f("Y °"), f("Z °")], ([ax, ay, az]) => {
      if (!ax && !ay && !az) return;
      apply((s) => {
        let r = s;
        if (ax) r = rotateShape(r, ax, c, [1, 0, 0]);
        if (ay) r = rotateShape(r, ay, c, [0, 1, 0]);
        if (az) r = rotateShape(r, az, c, [0, 0, 1]);
        return r;
      }, "Rotate", ...([[ax, [1, 0, 0]], [ay, [0, 1, 0]], [az, [0, 0, 1]]] as [number, V3][])
        .filter(([a]) => a)
        .map(([a, axis]): TransformResult => ({ type: "rotate", angleDeg: a, axis, center: c })));
    }, "Rotate");
  }

  private stopTransform(): void {
    if (!this.xf) return;
    if (this.xf.edges) {
      this.edgePreview = null;
      this.viewport.clearGhost();
    }
    const wasGuide = this.xf.guide !== undefined;
    this.viewport.snapSkipGuide = -1;
    this.xf = null;
    this.placing = null;
    if (wasGuide) this.showGuides(); // drop any unapplied preview
    this.viewport.stopTransform();
    this.refreshSelection();
  }

  // ================================================================ edit

  private undoRedo(which: "undo" | "redo"): void {
    this.endInteractions();
    const label = which === "undo" ? this.doc.undo() : this.doc.redo();
    if (label) this.toast(`${which === "undo" ? "Undo" : "Redo"}: ${label}`);
  }

  private deleteSelected(): void {
    this.endInteractions();
    if (this.selDim >= 0) {
      const i = this.selDim;
      this.selDim = -1;
      return this.doc.setDimensions(this.doc.dimensions.filter((_, k) => k !== i), "Delete dimension");
    }
    if (this.selGuide >= 0) {
      const i = this.selGuide;
      this.selGuide = -1;
      return this.doc.setGuides(this.doc.guides.filter((_, k) => k !== i), "Delete guide");
    }
    const ids = new Set(this.selection.filter((s) => s.kind === "body").map((s) => s.body));
    if (!ids.size) {
      this.toast("Delete: select objects (Solid mode, key 1)", "error");
      return;
    }
    this.doc.commit(this.doc.bodies.filter((b) => !ids.has(b.id)), ids.size > 1 ? `Delete ${ids.size} objects` : "Delete");
    this.setSelection([]);
  }

  private duplicate(): void {
    this.endInteractions();
    const edgeSel = this.selection.filter((x) => x.kind === "edge");
    // A closed loop of edges (a circle, or edges end to end round a face / a hole): copied as a flat face.
    const loopBody = edgeSel.length === this.selection.length && new Set(edgeSel.map((x) => x.body)).size === 1 ? this.doc.get(edgeSel[0].body) : undefined;
    if (loopBody && isBrep(loopBody) && isEdgeLoop(loopBody.shape, edgeSel.map((x) => x.id))) {
      let face: Shape;
      try {
        face = edgeLoopFace(loopBody.shape, edgeSel.map((x) => x.id));
      } catch (e) {
        return this.toast(errorMessage(e), "error");
      }
      const b = this.doc.makeBody(face, "Face", "face");
      this.doc.commit([...this.doc.bodies, b], "Duplicate loop");
      this.setMode("body");
      this.setSelection([{ kind: "body", body: b.id, id: 0 }]);
      this.toast("Loop copied as a face — move it, then P to push/pull");
      this.startTransform("translate");
      this.placing = this.xf ? { ids: this.xf.ids.join(), version: this.doc.version } : null;
      this.repeatCopyIds = String(b.id);
      return;
    }
    if (edgeSel.length === 1 && this.selection.length === 1) return this.startGuide(edgeSel[0].body, edgeSel[0].id);
    const faceSel = this.selection.filter((x) => x.kind === "face");
    if (faceSel.length && faceSel.length === this.selection.length) {
      const faces = faceSel.flatMap((x) => {
        const b = this.doc.get(x.body);
        const f = b && isBrep(b) && findFace(b.shape, x.id);
        return f ? [this.doc.makeBody(cloneShape(f), "Face", "face")] : [];
      });
      if (!faces.length) return this.toast("Duplicate: could not copy face", "error");
      this.doc.commit([...this.doc.bodies, ...faces], "Duplicate face");
      this.setMode("body");
      this.setSelection(faces.map((b) => ({ kind: "body", body: b.id, id: 0 })));
      this.toast(`${faces.length} face${faces.length > 1 ? "s" : ""} copied — move it, then P to push/pull`);
      this.startTransform("translate");
      this.placing = this.xf ? { ids: this.xf.ids.join(), version: this.doc.version } : null;
      this.repeatCopyIds = faces.map((b) => b.id).join();
      return;
    }
    const ids = this.selectedBodyIds();
    if (!ids.length) {
      this.toast("Duplicate: select solids first", "error");
      return;
    }
    const copies = ids.map((id) => {
      const b = this.doc.get(id)!;
      return this.doc.makeBody(cloneShape(b.shape), b.name.replace(/\s+\d+$/, ""), b.kind);
    });
    this.doc.commit([...this.doc.bodies, ...copies], "Duplicate");
    this.setMode("body");
    this.setSelection(copies.map((b) => ({ kind: "body", body: b.id, id: 0 })));
    this.startTransform("translate");
    this.placing = this.xf ? { ids: this.xf.ids.join(), version: this.doc.version } : null;
    this.repeatCopyIds = copies.map((b) => b.id).join();
  }

  /** Array copy (corner button): a row of copies of the selected objects. */
  private arrayCopy(): void {
    const ids = this.selectedBodyIds();
    if (!ids.length) return this.toast("Array copy: select objects first (Solid mode, key 1)", "error");
    this.opArrayCopy(ids);
  }

  /** Last Array copy gap, direction and "Align centre" (the count starts at 2 each time). */
  private arrayPrefs = { gap: 0, dir: 0, centre: 0 };

  /**
   * Array copy: a row of `n` objects — the original counts, so n − 1 copies — along ±X / ±Y / ±Z,
   * `gap` mm apart (edge to edge), in one undo step.
   * With a total length (typed, or a clicked edge / path) the copies are spread instead:
   * - the original stays put (as engineers expect): the last copy the total away from it — on a clicked
   *   edge, as far from the far end as the original is from the near end (a balanced row);
   * - "Align centre": the original and its copies fill the total, equal gaps between them and at both
   *   ends — centred on the edge; the original moves to the first place.
   */
  private opArrayCopy(ids: number[]): void {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const id of ids) {
      const [a, b] = this.doc.get(id)!.shape.boundingBox.bounds;
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i], a[i]);
        hi[i] = Math.max(hi[i], b[i]);
      }
    }
    const DIRS = ["+X", "−X", "+Y", "−Y", "+Z", "−Z"];
    const along = (axis: number, d: number): V3 => {
      const v: V3 = [0, 0, 0];
      v[axis] = d;
      return v;
    };
    const copyName = (b: Body) => b.name.replace(/\s+\d+$/, "");
    /** The clicked edge / path: where it runs along `axis` (from `a` to `b`). */
    let span: { axis: number; a: number; b: number } | null = null;
    /** The path or edge under the cursor: its extent along its longest axis. */
    const spanAt = (e: PointerEvent): { axis: number; a: number; b: number; what: string; item: SelItem; at: THREE.Vector3 } | null => {
      let hit: { bounds: [V3, V3] | null; what: string; item: SelItem; at: THREE.Vector3 } | null = null;
      const p = this.viewport.pick(e.clientX, e.clientY, "body");
      const pb = p && this.doc.get(p.body);
      if (p && pb?.kind === "path") hit = { bounds: curveBounds(pb.shape), what: "Path", item: { kind: "body", body: pb.id, id: 0 }, at: p.point };
      else {
        const h = this.viewport.pick(e.clientX, e.clientY, "edge");
        const hb = h && this.doc.get(h.body);
        if (h && hb && isBrep(hb)) hit = { bounds: curveBounds(hb.shape, h.id), what: "Edge", item: { kind: "edge", body: h.body, id: h.id }, at: h.point };
      }
      if (!hit?.bounds) return null;
      const [l, u] = hit.bounds;
      const ext = [0, 1, 2].map((k) => u[k] - l[k]);
      const axis = ext.indexOf(Math.max(...ext));
      if (ext[axis] < 1e-6) return null;
      return { axis, a: l[axis], b: u[axis], what: hit.what, item: hit.item, at: hit.at };
    };
    const input = (key: string) => this.op?.inputs.find((i) => i.dataset.key === key);
    this.startOp({
      title: "Array copy",
      label: "Array copy",
      fields: [
        { key: "n", label: "Copies (the original counts)", value: 2, step: 1, min: 2 },
        { key: "gap", label: "Gap between copies (mm)", value: this.arrayPrefs.gap, step: 0.5 },
        { key: "total", label: "Total length (mm, 0: use the gap)", value: 0, step: 1, min: 0 },
        { key: "dir", label: "Direction", value: this.arrayPrefs.dir, type: "select", options: DIRS },
        { key: "centre", label: "Align centre (the original moves too)", value: this.arrayPrefs.centre, type: "checkbox" },
      ],
      hint: "Array copy: copies, gap (edge to edge) and direction — or click an edge or a path: the copies spread to its far end (Align centre: the whole row centred on it) · Enter apply · Esc cancel",
      pick: (e) => {
        const t = spanAt(e);
        const total = input("total"), dir = input("dir");
        if (!t || !total || !dir) return;
        span = { axis: t.axis, a: t.a, b: t.b };
        total.value = fmt(t.b - t.a);
        // Along the edge, toward its far end (from the original).
        const c = (lo[t.axis] + hi[t.axis]) / 2;
        dir.value = String(t.axis * 2 + (t.b - c < c - t.a ? 1 : 0));
        this.previewOp();
        this.toast(`${t.what} (${fmt(t.b - t.a)} mm): the copies spread along it`);
      },
      hover: (e) => {
        const t = spanAt(e);
        this.viewport.setHighlight(this.selection, t?.item ?? null);
        this.hud(t ? `${t.what}: ${fmt(t.b - t.a)} mm along ${"XYZ"[t.axis]}` : null, t?.at);
        this.viewport.canvas.style.cursor = t ? "pointer" : "crosshair";
      },
      compute: ({ n: count, gap, dir, total, centre: alignCentre }) => {
        if (!(count >= 2) || count !== Math.round(count)) throw new Error("Copies must be a whole number, 2 or more (the original counts)");
        if (count > 500) throw new Error("At most 500 copies");
        const n = count - 1; // (new copies)
        const axis = dir >> 1, sign = dir & 1 ? -1 : 1, size = hi[axis] - lo[axis];
        /** Move of the original (k = 0) and of each copy (k = 1..n) along `axis`. */
        let offsets: number[];
        if (total > 0) {
          // Original + copies fill the total: equal gaps between them and at both ends.
          // (the clicked edge's exact length, while the field still shows it — the field rounds to 0.01)
          const s = span && span.axis === axis && fmt(span.b - span.a) === fmt(total) ? span : null;
          if (s) total = s.b - s.a;
          const centre = (lo[axis] + hi[axis]) / 2;
          const gapIn = input("gap");
          let g: number;
          if (alignCentre) {
            const m = count;
            g = (total - m * size) / (m + 1);
            if (g < -1e-9) throw new Error(`${m} × ${fmt(size)} mm don't fit in ${fmt(total)} mm — fewer copies or a longer total`);
            // (no edge picked: from where the original starts, in the direction)
            const [A, B] = s ? [s.a, s.b] : sign > 0 ? [lo[axis], lo[axis] + total] : [hi[axis] - total, hi[axis]];
            offsets = Array.from({ length: m }, (_, k) => (sign > 0 ? A + g + size / 2 + k * (size + g) : B - g - size / 2 - k * (size + g)) - centre);
          } else {
            // The original stays; the last copy `extent` from it: on a clicked edge, as far from the far
            // end as the original is from the near end; typed, the total itself.
            let extent = total;
            if (s) {
              const near = sign > 0 ? centre - s.a : s.b - centre;
              extent = (s.b - s.a) - 2 * near;
              if (extent <= 1e-6) throw new Error("The original is past the middle of the edge: flip the direction");
            }
            const pitch = extent / n;
            g = pitch - size;
            if (g < -1e-9) throw new Error(`${count} × ${fmt(size)} mm don't fit in ${fmt(extent)} mm — fewer copies, or move the original nearer the end`);
            offsets = Array.from({ length: count }, (_, k) => sign * pitch * k);
          }
          if (gapIn && gapIn !== document.activeElement) gapIn.value = fmt(g);
        } else {
          const step = size + gap;
          if (!(step > 1e-6)) throw new Error("Gap too small: the copies would be on top of each other");
          offsets = Array.from({ length: n + 1 }, (_, k) => sign * step * k);
        }
        const moveOrig = Math.abs(offsets[0]) > 1e-9;
        const ghost = new Map<number, Shape>();
        offsets.forEach((d, k) => {
          if (k === 0 && !moveOrig) return;
          ids.forEach((id, j) => {
            const b = this.doc.get(id)!;
            // (the original's preview replaces it; copies are new: negative keys)
            if (b.kind === "solid" || b.kind === "face") ghost.set(k === 0 ? id : -(k * ids.length + j), translateShape(b.shape, along(axis, d)) as Shape);
          });
        });
        return {
          ghost,
          commit: () => {
            const copies: Body[] = [];
            let lastRow: Body[] = [];
            for (let k = 1; k <= n; k++) {
              lastRow = ids.map((id) => {
                const b = this.doc.get(id)!;
                return this.doc.makeBody(translateShape(cloneShape(b.shape), along(axis, offsets[k])), copyName(b), b.kind);
              });
              copies.push(...lastRow);
            }
            // The row is a group: the originals' own group if they share one (a second array → a grid), else a new "Array N".
            const idSet = new Set(ids);
            const groups = new Set(ids.map((id) => this.doc.get(id)!.group));
            const group = groups.size === 1 && [...groups][0] ? [...groups][0]! : this.newGroupName("Array");
            const bodies = this.doc.bodies.map((b) => (idSet.has(b.id) ? { ...(moveOrig ? withShape(b, translateShape(b.shape, along(axis, offsets[0]))) : b), group } : b));
            this.doc.commit([...bodies, ...copies.map((b) => ({ ...b, group }))], `Array copy ×${count}`);
            // The whole row stays selected: Array copy again (e.g. along Y) makes a grid.
            return {
              select: [...ids, ...copies.map((b) => b.id)],
              solidMode: true,
              then: () => {
                // (Shift+R would move the whole selected row — not repeat this array)
                this.repeatOps = [];
                this.repeatCopyIds = "";
                this.toast(`${count} in a row (${n} new) — all selected: Array copy again for a grid`);
              },
            };
          },
        };
      },
      remember: ({ gap, dir, centre }) => {
        this.arrayPrefs = { gap, dir, centre };
      },
    });
    // Typing a gap switches the total length off (back to "use the gap"); typing a total forgets the picked edge.
    const total = input("total");
    input("gap")?.addEventListener("input", () => {
      span = null;
      if (total && total.value !== "0") total.value = "0";
    });
    total?.addEventListener("input", () => (span = null));
  }

  // ================================================================ document changes

  private onDocChange(): void {
    this.viewport.sync(this.doc.bodies);
    this.showGuides();
    this.showDimensions();
    if (this.tool instanceof MeasureTool) this.tool.refresh();
    const live = new Set(this.doc.bodies.map((b) => b.id));
    for (const id of [...this.hidden]) if (!live.has(id)) this.hidden.delete(id);
    this.selection = this.selection.filter((s) => this.viewport.isValid(s));
    if (this.hover && !this.viewport.isValid(this.hover)) this.hover = null;
    this.refreshSelection();
    this.updateTitle();
  }

  private updateTitle(): void {
    const name = this.doc.filePath ? this.doc.filePath.split(/[\\/]/).pop() : "Untitled";
    window.y3d?.setTitle(`${name}${this.doc.dirty ? " •" : ""} — Y3D`);
    window.y3d?.setDirty(this.doc.dirty && (this.doc.bodies.length > 0 || this.doc.filePath !== null));
    document.title = `${name} — Y3D`;
  }

  // ================================================================ UI rendering

  private buildToolbar(): void {
    const bar = $("toolbar");
    const mkBtn = (it: ToolbarItem, cls: string, html: string): HTMLButtonElement => {
      const b = document.createElement("button");
      b.className = cls;
      b.dataset.cmd = it.cmd;
      b.title = it.key ? `${it.label} (${it.key})` : it.label;
      b.innerHTML = html;
      return b;
    };
    for (const group of TOOLBAR) {
      const g = document.createElement("div");
      g.className = "tb-group";
      const btns = document.createElement("div");
      btns.className = "tb-buttons";
      if (!group.drawer) {
        for (const it of group.items) {
          const b = mkBtn(it, "tb-btn", `${ICONS[it.icon]}<span>${it.label}</span>`);
          b.addEventListener("click", () => {
            b.blur();
            this.run(it.cmd);
          });
          btns.appendChild(b);
        }
      } else {
        // Drawer: one button showing the last-used tool; hover opens the full list.
        const drawer = document.createElement("div");
        drawer.className = "tb-drawer";
        const main = mkBtn(group.items[0], "tb-main", "");
        const setMain = (it: ToolbarItem): void => {
          main.dataset.cmd = it.cmd;
          main.title = it.key ? `${it.label} (${it.key})` : it.label;
          main.innerHTML = `${ICONS[it.icon]}<span>${it.label}</span><i class="tb-caret">▾</i>`;
        };
        setMain(group.items[0]);
        main.addEventListener("click", () => {
          main.blur();
          this.run(main.dataset.cmd!);
        });
        const list = document.createElement("div");
        list.className = "tb-flyout";
        for (const it of group.items) {
          const b = mkBtn(it, "tb-btn tb-item", `${ICONS[it.icon]}<span>${it.label}</span>${it.key ? `<kbd>${it.key}</kbd>` : ""}`);
          b.addEventListener("click", () => {
            b.blur();
            setMain(it);
            drawer.classList.remove("open");
            this.run(it.cmd);
          });
          list.appendChild(b);
        }
        let closeT = 0;
        drawer.addEventListener("mouseenter", () => {
          clearTimeout(closeT);
          for (const d of document.querySelectorAll(".tb-drawer.open")) if (d !== drawer) d.classList.remove("open");
          const r = drawer.getBoundingClientRect();
          list.style.left = `${r.left}px`;
          list.style.top = `${r.bottom}px`;
          drawer.classList.add("open");
        });
        drawer.addEventListener("mouseleave", () => {
          closeT = window.setTimeout(() => drawer.classList.remove("open"), 150);
        });
        drawer.append(main, list);
        btns.appendChild(drawer);
      }
      const label = document.createElement("div");
      label.className = "tb-label";
      label.textContent = group.title;
      g.append(btns, label);
      bar.appendChild(g);
    }
  }

  private renderToolbarState(): void {
    const active = new Set<string>([`mode.${this.mode}`]);
    if (this.tool) active.add(`tool.${this.tool.name.toLowerCase()}`);
    if (this.xf) active.add(this.xf.mode === "translate" ? "xf.move" : "xf.rotate");
    if (this.op) {
      const map: Record<string, string> = { "Push/Pull": "op.pushpull", Fillet: "op.fillet", Chamfer: "op.chamfer", Shell: "op.shell", Revolve: "op.revolve", Sweep: "op.sweep", "Array copy": "edit.array" };
      active.add(map[this.op.spec.label]);
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>("#corner-tools button")) b.classList.toggle("active", active.has(b.dataset.cmd!));
    for (const b of document.querySelectorAll<HTMLButtonElement>(".tb-btn")) {
      const cmd = b.dataset.cmd!;
      b.classList.toggle("active", active.has(cmd));
      if (cmd === "edit.undo") b.disabled = !this.doc.canUndo;
      if (cmd === "edit.redo") b.disabled = !this.doc.canRedo;
    }
    for (const d of document.querySelectorAll<HTMLElement>(".tb-drawer")) {
      const items = [...d.querySelectorAll<HTMLButtonElement>(".tb-item")];
      const on = items.find((b) => b.classList.contains("active"));
      const main = d.querySelector<HTMLButtonElement>(".tb-main")!;
      main.classList.toggle("active", !!on);
      if (on && main.dataset.cmd !== on.dataset.cmd) {
        main.dataset.cmd = on.dataset.cmd;
        main.title = on.title;
        main.innerHTML = on.innerHTML.replace(/<kbd>.*<\/kbd>/, "") + `<i class="tb-caret">▾</i>`;
      }
    }
  }

  // ---------------------------------------------------------------- groups

  /** "Group 1", "Group 2"... — the first not in use. */
  private newGroupName(base = "Group"): string {
    const used = new Set(this.doc.bodies.map((b) => b.group));
    let n = 1;
    while (used.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  }

  /** Ctrl+G: the selected objects become one group (leaving any group they were in). */
  private groupSelected(): void {
    const ids = new Set(this.selectedBodyIds());
    if (ids.size < 2) return this.toast("Group: select two or more objects (Shift+click, or in the Bodies panel)", "error");
    const name = this.newGroupName();
    this.doc.commit(this.doc.bodies.map((b) => (ids.has(b.id) ? { ...b, group: name } : b)), "Group");
    this.olCollapsed.delete(name);
    this.toast(`${name}: ${ids.size} objects — double-click its name in the Bodies panel to rename`);
  }

  /** Ctrl+Shift+G: the groups of the selected objects are taken apart (the objects stay). */
  private ungroupSelected(): void {
    const groups = new Set(this.selectedBodyIds().map((id) => this.doc.get(id)?.group).filter((g): g is string => !!g));
    if (!groups.size) return this.toast("Ungroup: select a group (click its name in the Bodies panel)", "error");
    this.doc.commit(this.doc.bodies.map((b) => (b.group && groups.has(b.group) ? (({ group: _g, ...rest }) => rest as Body)(b) : b)), "Ungroup");
    this.toast(groups.size > 1 ? `${groups.size} groups taken apart` : `${[...groups][0]} taken apart`);
  }

  /** Set while Union / Subtract / Intersect waits for solids: a click in the Bodies panel (a row, or a group) goes here. */
  private outlinerPick: ((ids: number[]) => void) | null = null;
  private olRows = new Map<number, { row: HTMLElement; body: Body; hidden: boolean }>();
  /** Group header rows by group name, and the groups folded shut. */
  private olGroups = new Map<string, HTMLElement>();
  private olCollapsed = new Set<string>();
  private olBound = false;

  private renderOutliner(): void {
    const el = $("outliner");
    if (!this.olBound) {
      this.olBound = true;
      // One delegated listener set instead of three listeners per row.
      const bodyOf = (e: Event) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>(".ol-row");
        return row ? this.doc.get(Number(row.dataset.id)) ?? null : null;
      };
      const groupOf = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>(".ol-group")?.dataset.group ?? null;
      const members = (g: string) => this.doc.bodies.filter((b) => b.group === g);
      el.addEventListener("click", (e) => {
        const t = e.target as HTMLElement;
        if (t.closest("input")) return;
        const g = groupOf(e);
        if (g !== null) {
          const ms = members(g);
          if (t.closest(".ol-caret")) {
            if (this.olCollapsed.has(g)) this.olCollapsed.delete(g);
            else this.olCollapsed.add(g);
            return this.renderOutliner();
          }
          if (this.outlinerPick && !t.closest(".ol-eye")) return this.outlinerPick(ms.map((b) => b.id)); // (Union / Subtract... waiting for solids)
          if (t.closest(".ol-eye")) {
            // Any shown → hide them all; all hidden → show them all.
            const hide = ms.some((b) => !this.hidden.has(b.id));
            for (const b of ms) hide ? this.hidden.add(b.id) : this.hidden.delete(b.id);
            this.viewport.setHidden(this.hidden);
            return this.renderOutliner();
          }
          // The whole group (Shift / Ctrl: added to the selection, or taken out if it's all in).
          this.setMode("body");
          const items: SelItem[] = ms.map((b) => ({ kind: "body", body: b.id, id: 0 }));
          if (e.shiftKey || e.ctrlKey) {
            const all = items.every((it) => this.selection.some((s) => sameItem(s, it)));
            const rest = this.selection.filter((s) => !items.some((it) => sameItem(s, it)));
            this.setSelection(all ? rest : [...rest, ...items]);
          } else this.setSelection(items);
          return;
        }
        const b = bodyOf(e);
        if (!b) return;
        if (this.outlinerPick && !t.closest(".ol-eye")) return this.outlinerPick([b.id]);
        if (t.closest(".ol-eye")) {
          if (this.hidden.has(b.id)) this.hidden.delete(b.id);
          else this.hidden.add(b.id);
          this.viewport.setHidden(this.hidden);
          this.renderOutliner();
          return;
        }
        this.setMode("body");
        const item: SelItem = { kind: "body", body: b.id, id: 0 };
        if (e.shiftKey || e.ctrlKey) {
          const exists = this.selection.some((s) => sameItem(s, item));
          this.setSelection(exists ? this.selection.filter((s) => !sameItem(s, item)) : [...this.selection, item]);
        } else this.setSelection([item]);
      });
      el.addEventListener("dblclick", (e) => {
        const cell = (e.target as HTMLElement).closest(".ol-name");
        if (!cell) return;
        const g = groupOf(e);
        if (g !== null) return this.renameGroup(g, cell);
        const b = bodyOf(e);
        if (b) this.rename(b, cell);
      });
    }
    const selected = new Set(this.selection.map((s) => s.body));
    if (!this.doc.bodies.length) {
      this.olRows.clear();
      this.olGroups.clear();
      el.innerHTML = `<div class="ol-empty">No bodies yet.<br>Press <kbd>B</kbd> to draw a box.</div>`;
      return;
    }
    el.querySelector(".ol-empty")?.remove();
    // Rows in document order; a group's header where its first member is, its members right under it.
    const order: HTMLElement[] = [];
    const live = new Set<number>(), liveGroups = new Set<string>();
    const bodyRow = (b: Body): HTMLElement => {
      live.add(b.id);
      const hidden = this.hidden.has(b.id);
      let entry = this.olRows.get(b.id);
      if (!entry || entry.body !== b || entry.hidden !== hidden) {
        const row = entry?.row ?? document.createElement("div");
        row.className = "ol-row";
        row.dataset.id = String(b.id);
        row.innerHTML = `<span class="ol-swatch${b.kind === "solid" ? "" : " " + b.kind}" title="${{ solid: "Solid", face: "Flat face", mesh: "Mesh (STL)", path: "Path (open lines from a sketch)" }[b.kind]}"></span><span class="ol-name">${escapeHtml(b.name)}</span><button class="ol-eye" title="Show/hide">${hidden ? ICONS.eyeOff : ICONS.eye}</button>`;
        entry = { row, body: b, hidden };
        this.olRows.set(b.id, entry);
      }
      const row = entry.row;
      row.classList.toggle("selected", selected.has(b.id));
      row.classList.toggle("hidden", hidden);
      row.classList.toggle("in-group", !!b.group);
      return row;
    };
    for (const b of this.doc.bodies) {
      if (!b.group) {
        order.push(bodyRow(b));
        continue;
      }
      if (liveGroups.has(b.group)) continue; // (listed with its group)
      const g = b.group;
      liveGroups.add(g);
      const ms = this.doc.bodies.filter((x) => x.group === g);
      const open = !this.olCollapsed.has(g);
      const allHidden = ms.every((x) => this.hidden.has(x.id));
      let head = this.olGroups.get(g);
      if (!head) {
        head = document.createElement("div");
        head.className = "ol-group";
        head.dataset.group = g;
        this.olGroups.set(g, head);
      }
      const html = `<button class="ol-caret" title="${open ? "Fold" : "Unfold"}">${open ? "▾" : "▸"}</button><span class="ol-name" title="Click: select the group · double-click: rename">${escapeHtml(g)}</span><span class="ol-count">${ms.length}</span><button class="ol-eye" title="Show/hide the group">${allHidden ? ICONS.eyeOff : ICONS.eye}</button>`;
      if (head.innerHTML !== html && !head.querySelector("input")) head.innerHTML = html;
      head.classList.toggle("selected", ms.every((x) => selected.has(x.id)));
      head.classList.toggle("hidden", allHidden);
      order.push(head);
      if (open) for (const m of ms) order.push(bodyRow(m));
      else for (const m of ms) live.add(m.id); // (kept, just not shown)
    }
    // Keep DOM order in sync (no-op when already correct); folded members leave the DOM.
    let prev: Element | null = null;
    for (const row of order) {
      const want: Element | null = prev ? prev.nextElementSibling : el.firstElementChild;
      if (want !== row) el.insertBefore(row, want);
      prev = row;
    }
    const shown = new Set<Element>(order);
    for (const child of [...el.children]) if (!shown.has(child)) child.remove();
    for (const id of [...this.olRows.keys()]) if (!live.has(id)) this.olRows.delete(id);
    for (const g of [...this.olGroups.keys()]) if (!liveGroups.has(g)) this.olGroups.delete(g);
    for (const g of [...this.olCollapsed]) if (!liveGroups.has(g)) this.olCollapsed.delete(g);
  }

  /** Double-click a group's name: rename it (all its members move to the new name; one undo step). */
  private renameGroup(group: string, cell: Element): void {
    const input = document.createElement("input");
    input.value = group;
    cell.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const commit = (save: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      const taken = name !== group && this.doc.bodies.some((b) => b.group === name);
      if (save && taken) this.toast(`There is already a group called "${name}"`, "error");
      if (save && name && name !== group && !taken) {
        if (this.olCollapsed.delete(group)) this.olCollapsed.add(name);
        this.olGroups.delete(group);
        this.doc.commit(this.doc.bodies.map((b) => (b.group === group ? { ...b, group: name } : b)), "Rename group");
      } else {
        this.olGroups.get(group)?.replaceChildren(); // (redrawn below)
        this.renderOutliner();
      }
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") commit(true);
      if (e.key === "Escape") commit(false);
    });
    input.addEventListener("blur", () => commit(true));
  }

  private rename(body: Body, cell: Element): void {
    const input = document.createElement("input");
    input.value = body.name;
    cell.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const commit = (save: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (save && name && name !== body.name) {
        this.doc.commit(this.doc.bodies.map((b) => (b.id === body.id ? { ...b, name } : b)), "Rename");
      } else {
        const cached = this.olRows.get(body.id);
        if (cached) cached.hidden = !cached.hidden; // mark stale so the row is re-rendered in place
        this.renderOutliner();
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit(true);
      if (e.key === "Escape") commit(false);
    });
    input.addEventListener("blur", () => commit(true));
  }

  private renderProps(): void {
    const el = $("props");
    const sel = this.selection;
    const tip = (html: string) => `<div class="tip">${html}</div>`;
    if (!sel.length) {
      el.innerHTML = `<div class="muted">Nothing selected</div>` +
        tip(`Solids: <kbd>B</kbd> <kbd>B</kbd> box · <kbd>B</kbd> <kbd>C</kbd> cylinder · <kbd>B</kbd> <kbd>S</kbd> sphere<br>Faces: <kbd>A</kbd> <kbd>A</kbd> rectangle · <kbd>A</kbd> <kbd>C</kbd> circle · <kbd>A</kbd> <kbd>P</kbd> polygon → <kbd>P</kbd> push/pull<br><kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> solid / face / edge mode<br><kbd>F1</kbd> all shortcuts`);
      return;
    }
    const kind = sel[0].kind;
    const rows: [string, string][] = [];
    let hints = "";
    if (kind === "body") {
      rows.push(["Objects", String(sel.length)]);
      if (sel.length === 1) {
        const b = this.doc.get(sel[0].body);
        if (b) {
          const [w, d, h] = boundingSize(b.shape);
          rows.unshift(["Name", escapeHtml(b.name)], ["Type", b.kind === "face" ? "Flat face" : b.kind === "mesh" ? "Mesh (STL)" : "Solid"]);
          rows.push(["Size", `${fmt(w)} × ${fmt(d)} × ${fmt(h)}`]);
          if (b.kind === "mesh") rows.push(["Triangles", b.shape.triangleCount.toLocaleString()]);
          else if (b.kind === "path") rows.push(["Lines / arcs", String(b.shape.edges.length)]);
          else rows.push(["Faces", String(b.shape.faces.length)], ["Edges", String(b.shape.edges.length - seamEdgeIds(b.shape).size)]);
        }
        hints = b?.kind === "face"
          ? `<kbd>P</kbd> push/pull into a new solid · <kbd>G</kbd> move · <kbd>R</kbd> rotate · <kbd>S</kbd> scale`
          : b?.kind === "mesh"
          ? `<kbd>G</kbd> move · <kbd>R</kbd> rotate · <kbd>S</kbd> scale · <kbd>Shift+D</kbd> duplicate · File → Export STL (exported with the solids)<br>A mesh can't be edited (no faces or edges)`
          : `<kbd>G</kbd> move · <kbd>R</kbd> rotate · <kbd>S</kbd> scale · <kbd>C</kbd> cut by guide · <kbd>F</kbd> fillet all edges · <kbd>Shift+D</kbd> duplicate`;
      } else {
        hints = `<kbd>+</kbd> union · <kbd>−</kbd> subtract · <kbd>Shift+I</kbd> intersect<br>(first selected = target)`;
      }
    } else if (kind === "face") {
      rows.push(["Faces", String(sel.length)]);
      if (sel.length === 1) {
        const b = this.doc.get(sel[0].body);
        const f = b && isBrep(b) && findFace(b.shape, sel[0].id);
        if (b) rows.push([b.kind === "face" ? "Flat face" : "Solid", escapeHtml(b.name)]);
        if (f) rows.push(["Surface", f.geomType]);
      }
      hints = `<kbd>P</kbd> push/pull (flat face → new solid) · <kbd>H</kbd> shell (opens selected faces) · <kbd>O</kbd> offset`;
    } else {
      rows.push(["Edges", String(sel.length)]);
      hints = `<kbd>F</kbd> fillet · <kbd>Shift+F</kbd> chamfer · <kbd>O</kbd> offset (strip)`;
    }
    el.innerHTML = `<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>` + tip(hints);
  }

  private bindStatusBar(): void {
    const select = $<HTMLSelectElement>("snap-select");
    select.addEventListener("change", () => {
      this.snap = Number(select.value);
      this.viewport.axisSnapStep = this.snap;
      select.blur();
      if (this.xf?.guide !== undefined) this.startGuideMove(true);
      else if (this.xf?.edges) this.startEdgeMove(true);
      else if (this.xf) this.startTransform(this.xf.mode, true);
    });
  }

  toast(msg: string, kind: "info" | "error" = "info", ms = kind === "error" ? 4500 : 2200): void {
    const t = document.createElement("div");
    t.className = `toast ${kind}`;
    t.textContent = msg;
    const box = $("toasts");
    box.appendChild(t);
    while (box.children.length > 4) box.firstElementChild!.remove();
    setTimeout(() => t.remove(), ms);
  }

  /** Help walkthrough (Bird House, Cable Storage Box, House, Planter): which one, its next step (0 = not started) and the bodies it made. */
  private tut: { def: Tutorial; step: number; ctx: TutCtx } | null = null;

  /** Open a walkthrough (another one replaces it), or close it if it is already open. */
  private toggleTutorial(def?: Tutorial): void {
    const panel = $("tutorial");
    const open = !!def && (panel.hidden === true || this.tut?.def !== def);
    if (open && this.tut?.def !== def) this.tut = { def: def!, step: 0, ctx: new Map() };
    panel.hidden = !open;
    document.body.classList.toggle("tutorial-open", open);
    if (open) this.renderTutorial();
  }

  private renderTutorial(): void {
    if (!this.tut) return;
    const panel = $("tutorial"), { def, step: n } = this.tut, total = def.steps.length;
    const steps = def.steps.map((st, i) => `<li class="${i < n ? "done" : i === n ? "current" : ""}"><b>${st.title}</b><div>${st.how}</div></li>`).join("");
    panel.innerHTML = `<div class="head"><h2>${def.title}</h2><button data-act="close" title="Close">×</button></div>
      <p>Follow each step with the keys shown, or press <b>Do step</b> to see y3d do it (<kbd>Ctrl</kbd>+<kbd>Z</kbd> takes it back).</p>
      <ol>${steps}</ol>
      <div class="actions"><button class="btn" data-act="back" ${n ? "" : "disabled"}>◀ Back</button>
      <button class="btn" data-act="all" ${n < total ? "" : "disabled"}>Do all</button>
      <button data-act="do" class="btn primary" ${n < total ? "" : "disabled"}>${n >= total ? "Done ✓" : `${n ? "Do step" : "Start"} ${n + 1}/${total} ▶`}</button></div>`;
    panel.onclick = (e) => {
      const act = (e.target as HTMLElement).closest("button")?.dataset.act;
      if (act === "close") this.toggleTutorial();
      else if (act === "back") this.tutorialBack();
      else if (act === "do") void this.tutorialDo(1);
      else if (act === "all") void this.tutorialDo(total);
    };
    panel.querySelector("li.current")?.scrollIntoView({ block: "nearest" });
  }

  private tutorialLabel(i: number): string {
    return `${this.tut!.def.title}: ${this.tut!.def.steps[i].title}`;
  }

  /** Do the next `count` walkthrough steps; the first one starts a new document. */
  private async tutorialDo(count: number): Promise<void> {
    const tut = this.tut;
    if (!tut) return;
    if (tut.step === 0) {
      if (!(await this.confirmDiscard())) return;
      this.endInteractions();
      this.selection = [];
      this.hidden.clear();
      this.doc.reset();
      tut.ctx = new Map();
      this.viewport.setView("iso"); // (the steps say "back left", "front top edge"... as seen from the start-up view)
    }
    this.endInteractions();
    try {
      for (let k = 0; k < count && tut.step < tut.def.steps.length; k++) {
        tut.def.steps[tut.step].run(this.doc, tut.ctx, this.tutorialLabel(tut.step));
        tut.step++;
      }
    } catch (e) {
      this.toast(errorMessage(e), "error");
    }
    this.setSelection([]);
    this.viewport.fit(undefined, $("tutorial").offsetWidth + 24); // keep the model clear of the panel
    this.renderTutorial();
  }

  /** Back one step: undo it if it is the last thing done. */
  private tutorialBack(): void {
    const tut = this.tut;
    if (!tut?.step) return;
    this.endInteractions();
    if (this.doc.undoLabel === this.tutorialLabel(tut.step - 1)) this.doc.undo();
    tut.step--;
    this.setSelection([]);
    this.renderTutorial();
  }

  private toggleHelp(): void {
    const help = $("help");
    if (!help.hidden) {
      help.hidden = true;
      return;
    }
    const rows: [string, string][] = [
      ["Middle-drag · Alt+Left-drag", "Orbit view"],
      ["Shift + Left-drag · Ctrl + Middle-drag", "Pan view"],
      ["Wheel · two-finger slide (touchpad)", "Zoom to cursor"],
      ["1 · 2 · 3", "Selection mode: Solid · Face · Edge"],
      ["Click / Shift+click", "Select / add to selection"],
      ["B B · B C · B S", "Draw solid Box · Cylinder · Sphere (B alone starts a box; type numbers + Enter for exact sizes)"],
      ["A · A C · A P", "Draw flat Rectangle · Circle · Polygon face (A alone starts a rectangle; then P to push/pull into a solid)"],
      ["K", "Sketch on the selected flat face (or the ground): the view turns square to it with a 3D view in the corner · Tab: exact values (first point X,Y · line length, angle · arc radius, angle · rectangle width, height · circle radius · selection ΔX, ΔY, scale %) · L line · A arc · R rectangle · C circle · click the start point to close (Enter or double-click: done — the lines stay open, a path) · typed length / w,h / radius + Enter (arc: its radius, then click where it ends) · Esc drops the outline being drawn · Ctrl+Z undo · Esc again (nothing being drawn) or a right click (keeps what is being drawn): Select — click / Shift+click outlines and paths, drag to move (or type dx,dy), S scales about the centre — a gizmo: red square X, green Y, yellow ring both (X / Y unevenly: arcs / circles become freeform curves), Ctrl: round steps, Tab: Scale / X / Y %, Enter applies (or type a % + Enter), J joins (outlines into one face, paths end to end), Del deletes · Done keeps the closed outlines as flat faces (inside ones become holes) and open lines as paths, Cancel drops the sketch · bottom-left icons: turn the view a quarter · a picture to trace (only shown while sketching, remembered for the same face): drag moves it, a % + Enter scales it, Match: click 2 points on it, then where they belong on the model · Del removes it"],
      ["Tab (while drawing)", "Property dialog: type exact size, then Create"],
      ["Enter (Move G / Rotate R)", "Done — finish the move and hide the gizmo"],
      ["Shift+R", "Repeat last move/rotate (after Shift+D: copy again → array)"],
      ["Tab (Move G / Rotate R)", "Type exact ΔX,ΔY,ΔZ or X/Y/Z angles"],
      ["L", "Divide face: click two points on the edges of a solid's flat face to split it (corners / midpoints snap); the new edge is selected"],
      ["G with a guide line selected", "Move the guide with the gizmo (Ctrl snaps to points / other guides) · Tab: exact ΔX,ΔY,ΔZ · Enter done"],
      ["G with edges selected", "Move edge: drag the edge, reshaping its flat-faced solid (bent faces split into triangles)"],
      ["Shift+wheel · [ · ] (Polygon tool)", "Fewer / more sides (3–64)"],
      ["Hold Ctrl", "Snap: object points (corners, midpoints, centres, edges, guide lines, axes) or grid while drawing / moving / dragging Push/Pull or Offset; 15° while rotating"],
      ["P / Space", "Push/Pull: flat face → new solid; solid face → modify (or tick “New solid”); Shift-click several faces to push them together"],
      ["F · Shift+F", "Fillet · Chamfer selected edges, or the edges of selected solids — all, just the vertical ones (box corners) or just the horizontal ones (Edges list)"],
      ["H", "Shell / hollow (opens the selected faces)"],
      ["C", "Cut by guide: select solid(s), press C, click a guide line — split into 2 objects by the plane through the guide, straight across the face it lies on (off a flat face, e.g. on a sphere: along the line as seen in the view); the upper part is selected (Del removes it)"],
      ["O", "Offset: new flat face on the selected face's plane, larger by the distance (negative = smaller), optionally with round corners, or Make ring for just the band between the two outlines; then P to push/pull"],
      ["Modify menu · Pro: R E", "Revolve: turn the selected flat face (or flat face object) about an axis into a solid — a guide line (draw one with Shift+L for an exact axis), one of the face's straight edges or the world X / Y / Z axis (pick it in the panel or just click it in the view); 360° = all the way round (a circle beside the axis → a donut)"],
      ["Modify menu · Pro: S W", "Sweep: a flat face (the profile) runs along a path or guide line into a solid — a flat ring (Offset → Make ring) makes a tube. Uses what is selected (a face, a path, a guide line); the panel then waits: click the profile face and the path / guide line (what a click would pick lights up). The profile moves onto the nearest end of the path, square to it (Turn profile: its angle round the path); one already sitting on the path end stays put (tick Centre to centre it). Corners: sharp or round where a path turns"],
      ["O with edges selected", "Offset edges: new flat strip centred on the selected straight edges, the distance to each side, in the plane of the adjacent face (tick “Other face” for the other plane); a closed loop of edges gives a ring"],
      ["Shift+L", "Guide line: click a reference edge, slide across a face (type / Tab: distance, %, count), Enter adds — or click two points (corners / midpoints / centres; Ctrl: edges, guides, axes) for a guide between them — near an X / Y / Z direction it locks on (red / green / blue) · click a guide + Del removes · Ctrl snaps to guides"],
      ["+ · − · Shift+I  (also Shift+U · Shift+S)", "Union · Subtract · Intersect (first selected = target)"],
      ["=", "Measure: click 2 points for the length (ΔX ΔY ΔZ, slope; off a corner or edge the 2nd point locks onto X / Y / Z when moved nearly along it), a 3rd for the angle at the 2nd — shown in the corner panel; Esc clears a result, Esc again (or Cancel) exits · Tab: add a dimension — of the angle (3 points clicked; move to size its arc), of the length between the 2 clicked points, or (none clicked) of the straight edge under the cursor, or the radius of the circle / arc under it (move to set its distance, or where a radius points, click to place; click its text + Del removes it) · hover a point (corner / midpoint / centre: X Y Z), an edge (length; circle / arc: radius, Ø, angle) or a face (area; rectangle sides, cylinder radius / height, sphere radius...) · Esc done"],
      ["G · R", "Move · Rotate gizmo"],
      ["S", "Scale selected objects about their bottom centre: drag the ring for Scale % or the red / green / blue boxes for X / Y / Z % (Ctrl snaps; per-axis works on curved shapes too)"],
      ["Click a selected solid again", "Drill down: selects the edge (near one) or face under the cursor and switches to Edge / Face mode"],
      ["Right-click a solid", "Switches to Solid mode and selects it (Shift+right-click adds)"],
      ["Click an edge of a selected face", "Face mode: selects that edge and switches to Edge mode"],
      ["Shift+G", "Show marks: click one → move gizmo there; or drag a mark to the target"],
      ["Ctrl+G / Ctrl+Shift+G", "Group the selected objects / take their group apart — in the Bodies panel: click a group to select it, ▸ folds it, double-click renames, the eye hides it (Array copy groups its row itself)"],
      ["Shift+D / Ctrl+D", "Duplicate solids, copy selected faces (then move), on a closed loop of edges (a circle, or edges round a face): copy it as a flat face (then move, P), or on a single straight edge: add a guide line (like Shift+L)"],
      ["Del / X", "Delete selected objects"],
      ["Ctrl+Z · Ctrl+R (or Ctrl+Shift+Z)", "Undo · Redo"],
      ["Home · .", "Fit all · Fit selection"],
      ["5 · 7 · Num 1 · Num 3", "Iso · Top · Front · Right view"],
      ["Shift+X", "Toggle x-ray (semi-transparent solids, on by default)"],
      ["V", "View menu at the cursor: Top 7 · Front 1 · Right 3 · Iso 5 · V again = opposite side (e.g. bottom)"],
      ["Enter · Esc", "Apply · Cancel / clear selection"],
      ["Ctrl+Shift+F1", "Pro layout on / off: less text — a one-row sketch panel, a small text-only Recent strip, short hints (also in the View menu)"],
      ["Ctrl+S · Ctrl+O · Ctrl+E", "Save · Open · Export STEP"],
    ];
    help.innerHTML = `<div class="card"><h2>Keyboard &amp; mouse</h2><table>${rows.map(([k, v]) => `<tr><td><kbd>${k}</kbd></td><td>${v}</td></tr>`).join("")}</table></div>`;
    help.hidden = false;
    help.onclick = () => (help.hidden = true);
  }

  // ================================================================ files

  private async confirmDiscard(): Promise<boolean> {
    if (!this.doc.dirty || !this.doc.bodies.length) return true;
    return window.y3d ? window.y3d.confirm("You have unsaved changes. Discard them?") : confirm("Discard unsaved changes?");
  }

  private async fileNew(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.endInteractions();
    this.selection = [];
    this.hidden.clear();
    this.doc.reset();
    this.viewport.fit();
    this.dropRecovery();
  }

  private async fileOpen(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    const file = await window.y3d.openFile({ title: "Open model", filters: [{ name: "Y3D model", extensions: ["y3d"] }], binary: false });
    if (!file) return;
    try {
      this.loadModel(file.data as string, file.path);
      this.toast(`Opened ${file.path.split(/[\\/]/).pop()}`);
      this.dropRecovery();
      void window.y3d.addRecent(file.path);
    } catch (e) {
      this.fail(e);
    }
  }

  /** File → Open Recent: open that model again (a file no longer there is taken off the list). */
  async openRecent(filePath: string): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    const name = filePath.split(/[\\/]/).pop();
    const text = await window.y3d.readFile(filePath);
    if (text === null) {
      void window.y3d.removeRecent(filePath);
      return this.toast(`${name} is no longer there (moved or deleted) — taken off the recent list`, "error");
    }
    try {
      this.loadModel(text, filePath);
      this.toast(`Opened ${name}`);
      this.dropRecovery();
      void window.y3d.addRecent(filePath);
    } catch (e) {
      this.fail(e);
    }
  }

  /** The model as a .y3d file (JSON with one B-rep per body). */
  private modelText(): string {
    return JSON.stringify({
      format: "y3d",
      version: 1,
      units: "mm",
      bodies: this.doc.bodies.map((b) => ({
        ...(b.kind === "mesh" ? { name: b.name, kind: b.kind, mesh: b.shape.toBase64() } : { name: b.name, kind: b.kind, brep: serializeShape(b.shape) }),
        ...(b.group ? { group: b.group } : {}),
      })),
      guides: this.doc.guides,
      // A linked dimension's body as its index in `bodies` (ids are renumbered on open).
      dimensions: this.doc.dimensions.map(({ body, ...d }) => {
        const i = this.doc.bodies.findIndex((b) => b.id === body);
        return i < 0 ? d : { ...d, body: i };
      }),
    });
  }

  /** Replace the document with a .y3d file's contents (throws if it isn't one). */
  private loadModel(text: string, filePath: string | null): void {
    const json = JSON.parse(text) as { format: string; bodies: { name: string; kind?: BodyKind; brep?: string; mesh?: string; group?: string }[]; guides?: Guide[]; dimensions?: Dimension[] };
    if (json.format !== "y3d") throw new Error("not a Y3D file");
    const bodies = json.bodies.map((b): BodyGeom & { name: string; group?: string } => {
      const group = typeof b.group === "string" && b.group ? { group: b.group } : {};
      if (b.kind === "mesh") return { name: b.name, kind: "mesh", shape: TriMesh.fromBase64(b.mesh!), ...group };
      const shape = deserialize(b.brep!);
      if (b.kind === "path") return { name: b.name, kind: "path", shape: shape as unknown as Wire, ...group };
      return { name: b.name, kind: b.kind === "face" || b.kind === "solid" ? b.kind : kindOf(shape), shape, ...group };
    });
    this.endInteractions();
    this.selection = [];
    this.hidden.clear();
    this.doc.reset(bodies, filePath, json.guides ?? [], json.dimensions ?? []);
    this.viewport.fit();
  }

  private async fileSave(saveAs: boolean): Promise<void> {
    const data = this.modelText();
    let path = this.doc.filePath;
    if (saveAs || !path) {
      path = await window.y3d.saveFile({ title: "Save model", defaultPath: "untitled.y3d", filters: [{ name: "Y3D model", extensions: ["y3d"] }], data });
      if (!path) return;
    } else {
      await window.y3d.writeFile(path, data);
    }
    this.doc.filePath = path;
    this.doc.dirty = false;
    this.updateTitle();
    this.toast(`Saved ${path.split(/[\\/]/).pop()}`);
    this.dropRecovery();
    void window.y3d.addRecent(path);
    this.noteSaved();
  }

  // ---------------------------------------------------------------- autosave / crash recovery

  /** Version of the document last autosaved (or known safe on disk). */
  private autosavedVersion = -1;
  private autosaveTimer = 0;
  /** When the oldest change not yet autosaved was made (autosave at most 30 s after it). */
  private unsavedSince = 0;

  /**
   * Unsaved work is written to a recovery file ~5 s after the last change (at most 30 s after the
   * first one), so a crash loses a few seconds at most; it is offered on the next start.
   */
  private scheduleAutosave(): void {
    if (!window.y3d?.writeRecovery) return;
    if (!this.unsavedSince) this.unsavedSince = performance.now();
    clearTimeout(this.autosaveTimer);
    const wait = Math.max(0, Math.min(5000, this.unsavedSince + 30000 - performance.now()));
    this.autosaveTimer = window.setTimeout(() => void this.autosave(), wait);
  }

  private async autosave(): Promise<void> {
    // Not in the middle of an operation or a drag (no hitch there): try again shortly.
    if (this.op || this.tool || this.xf) {
      this.autosaveTimer = window.setTimeout(() => void this.autosave(), 2000);
      return;
    }
    const version = this.doc.version;
    this.unsavedSince = 0;
    if (version === this.autosavedVersion) return;
    if (!this.doc.dirty || (!this.doc.bodies.length && !this.doc.guides.length && !this.doc.dimensions.length)) {
      this.dropRecovery();
      return;
    }
    try {
      await window.y3d.writeRecovery({ savedAt: Date.now(), filePath: this.doc.filePath, data: this.modelText() });
      this.autosavedVersion = version;
    } catch (e) {
      console.warn("autosave failed", e);
    }
  }

  /** The work is safe on disk (saved / opened / new): no recovery needed. */
  private dropRecovery(): void {
    clearTimeout(this.autosaveTimer);
    this.unsavedSince = 0;
    this.autosavedVersion = this.doc.version;
    void window.y3d?.clearRecovery?.();
  }

  /** On start: offer unsaved work autosaved before a crash (or a forced quit). */
  async offerRecovery(): Promise<void> {
    const rec = await window.y3d?.readRecovery?.();
    if (!rec) return;
    const when = new Date(rec.savedAt);
    const time = when.toDateString() === new Date().toDateString() ? when.toLocaleTimeString() : when.toLocaleString();
    const name = rec.filePath ? rec.filePath.split(/[\\/]/).pop() : "an unsaved model";
    const choice = await window.y3d.ask({
      message: "Recover unsaved work?",
      detail: `Y3D closed unexpectedly. Changes to ${name}, autosaved at ${time}, can be recovered.`,
      buttons: ["Recover", "Discard"],
    });
    if (choice !== 0) return this.dropRecovery();
    try {
      this.loadModel(rec.data, rec.filePath);
      // Not saved yet: keep it marked unsaved (and keep the recovery file until it is).
      this.doc.dirty = true;
      this.autosavedVersion = this.doc.version;
      this.updateTitle();
      this.toast(`Recovered work autosaved at ${time} — save it to keep it`);
    } catch (e) {
      this.fail(e);
    }
  }

  /** Stress-test scene: `n` separate solids (alternating boxes / cylinders) on a square grid. */
  loadStressScene(n: number): void {
    const t0 = performance.now();
    const ground: Frame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const cols = Math.ceil(Math.sqrt(n));
    const pitch = 20;
    const bodies: (BodyGeom & { name: string })[] = [];
    for (let i = 0; i < n; i++) {
      const x = (i % cols) * pitch, y = Math.floor(i / cols) * pitch;
      const h = 5 + ((i * 7) % 11);
      const cyl = i % 2 === 1;
      const shape = cyl ? makeCylinder(ground, [x, y, 0], 5, h) : makeBox(ground, [x, y, 0], 10, 10, h);
      bodies.push({ name: `${cyl ? "Cylinder" : "Box"} ${i + 1}`, kind: "solid", shape });
    }
    this.doc.reset(bodies);
    this.viewport.setView("iso");
    this.viewport.fit();
    this.toast(`Stress scene: ${n} solids in ${Math.round(performance.now() - t0)} ms`);
  }

  private async fileImportStep(): Promise<void> {
    const file = await window.y3d.openFile({ title: "Import STEP", filters: [{ name: "STEP", extensions: ["step", "stp"] }], binary: true });
    if (!file) return;
    try {
      const shapes = await importStep(file.data as Uint8Array);
      const base = file.path.split(/[\\/]/).pop()!.replace(/\.(step|stp)$/i, "");
      const bodies = shapes.map((s) => this.doc.makeBody(s, base));
      this.doc.commit([...this.doc.bodies, ...bodies], "Import STEP");
      this.viewport.fit();
      this.toast(`Imported ${bodies.length} solid(s)`);
    } catch (e) {
      this.fail(e);
    }
  }

  /**
   * STL import. A small closed mesh (a CAD part) becomes editable solids; a big one (a scan, a
   * sculpt, a 3D-print model) or one with holes stays a mesh: turning 200k triangles into B-rep
   * faces takes minutes and gives a solid too heavy to edit anyway.
   */
  private async fileImportStl(): Promise<void> {
    const file = await window.y3d.openFile({ title: "Import STL", filters: [{ name: "STL", extensions: ["stl"] }], binary: true });
    if (file) this.importStlData(file.data as Uint8Array, file.path.split(/[\\/]/).pop()!.replace(/\.stl$/i, ""));
  }

  /** Add an STL file's contents to the model (see fileImportStl). Returns the new bodies' ids. */
  importStlData(data: Uint8Array, base: string): number[] {
    try {
      const mesh = parseStl(data);
      if (!mesh.triangleCount) throw new Error("The STL file has no triangles");
      let solids: Solid[] = [];
      let why = `${mesh.triangleCount.toLocaleString()} triangles`;
      if (mesh.triangleCount <= STL_SOLID_MAX) {
        try {
          const r = importStl(data);
          if (r.open) why = "the mesh has holes";
          else solids = r.solids;
        } catch {
          why = "the mesh has holes";
        }
      }
      // Exporters keep their own origin (an assembly position, a print-bed corner), so the model
      // could land far away: centre it on the origin in X/Y with its bottom on the ground.
      const [lo, hi] = mesh.boundingBox.bounds;
      const d: V3 = [-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]];
      const place = <T extends Solid | TriMesh>(g: T): T => (d.some((x) => Math.abs(x) > 1e-9) ? translateShape(g, d) : g);
      const bodies = solids.length ? solids.map((s) => this.doc.makeBody(place(s), base)) : [this.doc.makeBody(place(mesh), base, "mesh")];
      this.doc.commit([...this.doc.bodies, ...bodies], "Import STL");
      this.setMode("body");
      this.setSelection(bodies.map((b) => ({ kind: "body", body: b.id, id: 0 })));
      this.viewport.fit();
      if (solids.length) this.toast(`Imported ${solids.length} solid(s), ${solids.reduce((n, s) => n + s.faces.length, 0)} faces`);
      else this.toast(`Imported as a mesh (${why}): move, rotate, scale, copy and export it with your solids — it can't be edited`);
      return bodies.map((b) => b.id);
    } catch (e) {
      this.fail(e);
      return [];
    }
  }

  /**
   * STL quality before exporting: Draft / Normal / Fine presets or custom values, with the
   * resulting triangle count and file size. Remembers the last choice. Null if cancelled.
   */
  private stlQualityDialog(solids: (Solid | TriMesh)[]): Promise<StlQuality | null> {
    const PRESETS: { name: string; q: StlQuality; hint: string }[] = [
      { name: "Draft", q: { tolerance: 0.1, angle: 15 }, hint: "quick test prints, previews" },
      { name: "Normal", q: { tolerance: 0.02, angle: 8 }, hint: "most 3D printing" },
      { name: "Fine", q: { tolerance: 0.005, angle: 3 }, hint: "resin printers, smooth curves" },
    ];
    let last: StlQuality = PRESETS[1].q;
    try {
      const saved = JSON.parse(localStorage.getItem(STL_QUALITY_KEY) ?? "null") as StlQuality | null;
      if (saved && saved.tolerance > 0 && saved.angle > 0) last = saved;
    } catch {
      // keep Normal
    }
    return new Promise((resolve) => {
      document.getElementById("props-dlg")?.remove();
      const dlg = document.createElement("form");
      dlg.id = "props-dlg";
      dlg.noValidate = true;
      dlg.innerHTML =
        `<h4>Export STL — quality</h4>` +
        `<div class="stl-presets">${PRESETS.map((p, i) => `<label class="stl-preset"><input type="radio" name="preset" value="${i}"><span><b>${p.name}</b> <small>${p.q.tolerance} mm · ${p.q.angle}° — ${p.hint}</small></span></label>`).join("")}` +
        `<label class="stl-preset"><input type="radio" name="preset" value="custom"><span><b>Custom</b></span></label></div>` +
        `<label><span>Surface accuracy (mm)</span><input type="number" data-k="tolerance" step="0.005" min="0.0005"></label>` +
        `<label><span>Angle (°)</span><input type="number" data-k="angle" step="1" min="0.5"></label>` +
        `<div class="stl-estimate">…</div>` +
        `<div class="op-buttons"><button type="button" class="btn" data-act="cancel">Cancel</button><button type="submit" class="btn primary">Export…</button></div>`;
      const radios = [...dlg.querySelectorAll<HTMLInputElement>("input[name=preset]")];
      const tol = dlg.querySelector<HTMLInputElement>("input[data-k=tolerance]")!, ang = dlg.querySelector<HTMLInputElement>("input[data-k=angle]")!;
      const est = dlg.querySelector<HTMLElement>(".stl-estimate")!;
      const read = (): StlQuality | null => {
        const q = { tolerance: parseFloat(tol.value), angle: parseFloat(ang.value) };
        return q.tolerance >= 0.0005 && q.angle >= 0.5 && q.angle <= 60 ? q : null;
      };
      let timer = 0;
      const estimate = () => {
        clearTimeout(timer);
        est.textContent = "…";
        timer = window.setTimeout(() => {
          const q = read();
          if (!q) return void (est.textContent = "Accuracy ≥ 0.0005 mm, angle 0.5–60°");
          try {
            const n = stlTriangleCount(solids, q);
            const mb = (84 + 50 * n) / 1e6;
            est.textContent = `≈ ${n.toLocaleString()} triangles · ${mb < 0.1 ? `${Math.max(1, Math.round(mb * 1000))} KB` : `${mb.toFixed(1)} MB`}`;
          } catch (e) {
            est.textContent = errorMessage(e);
          }
        }, 250);
      };
      const show = (q: StlQuality) => {
        tol.value = String(q.tolerance);
        ang.value = String(q.angle);
        const i = PRESETS.findIndex((p) => p.q.tolerance === q.tolerance && p.q.angle === q.angle);
        radios[i >= 0 ? i : radios.length - 1].checked = true;
        estimate();
      };
      for (const r of radios) r.addEventListener("change", () => (r.value === "custom" ? tol.focus() : show(PRESETS[Number(r.value)].q)));
      for (const i of [tol, ang]) i.addEventListener("input", () => show({ tolerance: parseFloat(tol.value), angle: parseFloat(ang.value) }));
      const close = (q: StlQuality | null) => {
        clearTimeout(timer);
        dlg.remove();
        $("viewport").focus?.();
        resolve(q);
      };
      dlg.addEventListener("submit", (e) => {
        e.preventDefault();
        const q = read();
        if (!q) return this.toast("STL quality: accuracy at least 0.0005 mm, angle 0.5–60°", "error");
        localStorage.setItem(STL_QUALITY_KEY, JSON.stringify(q));
        close(q);
      });
      dlg.querySelector("[data-act=cancel]")!.addEventListener("click", () => close(null));
      dlg.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") close(null);
      });
      $("viewport").appendChild(dlg);
      show(last);
      dlg.querySelector<HTMLButtonElement>("button[type=submit]")!.focus();
    });
  }

  private async fileExport(kind: "step" | "stl"): Promise<void> {
    const ids = this.selectedBodyIds();
    let bodies = ids.length ? this.doc.bodies.filter((b) => ids.includes(b.id)) : this.doc.bodies.filter((b) => !this.hidden.has(b.id));
    if (bodies.some((b) => b.kind === "path")) {
      this.toast(`${kind.toUpperCase()} skips paths (open lines from a sketch) — they have no surface`);
      bodies = bodies.filter((b) => b.kind !== "path");
    }
    if (kind === "stl") {
      // Solids and meshes go into one file (a slicer handles touching / overlapping parts).
      const printable = bodies.filter((b) => b.kind !== "face");
      if (printable.length < bodies.length) this.toast("STL skips flat faces (no volume) — exporting solids and meshes only");
      bodies = printable;
    } else {
      const solids = bodies.filter((b) => b.kind !== "mesh");
      const meshes = bodies.length - solids.length;
      if (meshes) {
        // STEP holds only solids: say so before writing a file that silently lacks the meshes.
        const names = bodies.filter((b) => b.kind === "mesh").map((b) => `"${b.name}"`).join(", ");
        const buttons = solids.length ? ["Export STEP without meshes", "Export STL instead", "Cancel"] : ["Export STL instead", "Cancel"];
        const choice = await window.y3d.ask({
          message: solids.length ? `STEP will not include ${meshes === 1 ? "the STL mesh" : `${meshes} STL meshes`}` : "STEP can't export STL meshes",
          detail: `${names} ${meshes === 1 ? "is a mesh" : "are meshes"} (imported STL). STEP files hold only solids, so ${meshes === 1 ? "it" : "they"} would be left out.\n\nExport STL keeps the solids and the meshes together in one file.`,
          buttons,
        });
        const act = buttons[choice];
        if (act === "Export STL instead") return this.fileExport("stl");
        if (act !== "Export STEP without meshes") return;
      }
      bodies = solids;
    }
    if (!bodies.length) {
      this.toast("Nothing to export", "error");
      return;
    }
    const shapes = bodies.map((b) => b.shape);
    let quality: StlQuality | null = { tolerance: 0.02, angle: 8 };
    if (kind === "stl" && shapes.some(notMesh)) {
      // Only solids are meshed at a chosen quality; meshes are written as they are.
      quality = await this.stlQualityDialog(shapes as (Solid | TriMesh)[]);
      if (!quality) return;
    }
    try {
      const buf = kind === "step" ? await exportStep(shapes.filter(notMesh).map((shape, i) => ({ shape, name: bodies[i].name }))) : await exportStl(shapes as (Solid | TriMesh)[], quality!);
      const base = this.doc.filePath?.split(/[\\/]/).pop()?.replace(/\.y3d$/, "") ?? "model";
      const path = await window.y3d.saveFile({
        title: `Export ${kind.toUpperCase()}`,
        defaultPath: `${base}.${kind}`,
        filters: kind === "step" ? [{ name: "STEP", extensions: ["step", "stp"] }] : [{ name: "STL", extensions: ["stl"] }],
        data: new Uint8Array(buf),
      });
      if (path) this.toast(`Exported ${bodies.length} object(s) to ${path.split(/[\\/]/).pop()}`);
    } catch (e) {
      this.fail(e);
    }
  }
}

// ================================================================ bootstrap

async function boot(): Promise<void> {
  const loading = $("loading");
  try {
    await initKernel();
    const app = new App();
    (window as unknown as { y3dApp: App }).y3dApp = app; // handy for debugging in DevTools
    (window as unknown as { y3dKernel: object }).y3dKernel = { isValidShape, serializeShape, deserialize, rotateShape, translateShape, scaleShape, pushPull, makeCylinder, makeBox, importStl, parseStl, exportStl, importStep, exportStep, solidVolume, faceInfo, booleanOp, splitFaceByLine, makeCircleFace, makeRectFace, sketchPath }; // used by the smoke test
    loading.remove();
    const stress = Number(new URLSearchParams(location.search).get("stress"));
    if (stress > 0) app.loadStressScene(Math.min(stress, 50000));
    else await app.offerRecovery();
  } catch (e) {
    loading.classList.add("error");
    loading.innerHTML = `<div>Failed to start the geometry kernel:</div><div>${escapeHtml(errorMessage(e))}</div>`;
    console.error(e);
  }
}

void boot();
