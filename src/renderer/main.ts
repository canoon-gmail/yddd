/**
 * YDDD application controller: wires the document, viewport, tools,
 * operation panel, outliner, file I/O, keyboard shortcuts and native menu.
 */
import "./migrate";
import "./style.css";
import * as THREE from "three";
import {
  initKernel,
  circleOf,
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
  loadTextFont,
  makeTextFaces,
  textPlacement,
  textLetters,
  type TextPlacement,
  BUILT_IN_FONTS,
  textFontReady,
  filletEdges,
  roundSome,
  type RoundResult,
  filletDragAxis,
  chamferEdges,
  pushPull,
  pushPullMany,
  shellSolid,
  booleanOp,
  tessellate,
  translateShape,
  rotateShape,
  mirrorShape,
  cloneShape,
  serializeShape,
  deserialize,
  exportStep,
  exportStl,
  meshForExport,
  stlTriangleCount,
  type StlQuality,
  importStep,
  importStl,
  boundingSize,
  findFace,
  extrudeFace,
  makeSphereAt,
  seamEdgeIds,
  kindOf,
  faceAxis,
  planarFaceFrame,
  sketchOfShape,
  type SketchLoop,
  type SketchSeg,
  tangentFaceFrame,
  faceInfo,
  faceRefEdges,
  offsetFace,
  boxFromFace,
  boxLid,
  hasBoxRim,
  offsetRing,
  scaleShape,
  guidePlaneNormal,
  matchStraightEdge,
  matchCircleEdge,
  pushPullMoves,
  edgesAlong,
  asPreview,
  splitByPlane,
  roundRim,
  resizeRounds,
  fillRounds,
  holeAt,
  circleOfEdge,
  lineOfEdge,
  fillHoles,
  resizeHoles,
  type HoleLoop,
  type RoundRim,
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
  makeCone,
  pointCenter,
  pullToPoint,
  solidTips,
  roundTip,
  tipRadiusMax,
  type Tip,
  makeCircleFace,
  makeRectFace,
  makePolygonFace,
  sketchPath,
  solidPieces,
  solidVolume,
  openEdgeCount,
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
  probePoints,
  movedIds,
  parseStl,
} from "./kernel";
import { Doc, isBrep, withShape, type ArrayRecord, type Body, type BodyGeom, type Dimension, type Guide, type HistoryEntry, type ShapeBody, type TextRecord } from "./document";
import { Viewport, sameItem, type SelItem, type SelMode, type TransformResult, type GizmoFrame } from "./viewport";
import { BoxTool, CylinderTool, SphereTool, ConeTool, PolygonTool, TextTool, PointMoveTool, GuideTool, DivideFaceTool, type EdgeSides, type GuideState, type TextSettings, type Tool, type ToolHost, type PropField } from "./tools";
import { ICONS } from "./icons";
import { BIRD_HOUSE } from "./birdhouse";
import { CABLE_STORAGE_BOX } from "./cablebox";
import { write3mf } from "./threemf";
import { JobCancelled, KernelWorker, solidFrom, type JobShape, type KernelJob } from "./kernelWorker";
import { HOUSE } from "./house";
import { PLANTER } from "./planter";
import { MeasureTool } from "./measure";
import { SketchTool, type SketchFrame } from "./sketch";
import { byDiameter, circleSize, CIRCLE_SIZE_KEY } from "./format";
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
interface OpDrag {
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

interface OpSpec {
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
interface OpChoice {
  at: V3;
  from?: V3;
  key: string;
  value: number;
  label: string;
  color: string;
  title?: string;
}

/** A copy of a Text tool letter is one too (its text can be edited, see TextRecord). */
function withTextOf<T extends Body>(made: T, from: Body): T {
  return from.text ? { ...made, text: from.text } : made;
}

/** A new body made from `from` (extruded, cut off, split off...) goes in the same group. */
function inGroupOf<T extends Body>(made: T, from: Body): T {
  return from.group ? { ...made, group: from.group } : made;
}

/** Names flat faces get automatically ("Circle 3", "Face 1"...): a solid pushed from one is called "Solid N" instead. */
const AUTO_FACE_NAME = /^(Rectangle|Circle|Polygon|Text|Face|Sketch|Ring)( \d+)?$/;

/** The solid a flat face object was pushed / pulled into: its group, and the name the user gave it. */
function extrudedFrom<T extends Body>(made: T, face: Body): T {
  const named = AUTO_FACE_NAME.test(face.name) ? made : { ...made, name: face.name };
  return withTextOf(inGroupOf(named, face), face);
}

/** The Text tool's last font (a built-in one's key or a system font's file; "" = Noto Sans), localStorage. */
const TEXT_FONT_KEY = "yddd.textFont";
/** The fonts that come with YDDD, first in the Text tool's Font list; the first one is the default. */
const BUILT_IN_FAMILY = (family: string) => `${family} (built in)`;

/** Longest text a Text group's name shows (in quotes), the rest cut short with "…". */
const TEXT_NAME_MAX = 16;

/** Undo steps a saved file keeps (and redo steps): reopened, Undo goes back that far. */
const SAVED_HISTORY = 50;
/** ...unless the history's own shapes reach this much text first (e.g. a big STL moved many times). */
const HISTORY_BYTES = 30e6;

/** One undo / redo step in a file: its bodies as references (see modelText). */
interface SavedStep {
  label: string;
  bodies: number[];
  guides?: Guide[];
  dims?: Dimension[];
  arrays?: ArrayRecord[];
}

/** The undo history part of a .yddd file. */
interface SavedHistory {
  ids: number[];
  dims?: Dimension[];
  arrays?: ArrayRecord[];
  bodies: { id: number; name: string; kind: Body["kind"]; group?: string; text?: TextRecord; s: number }[];
  shapes: string[];
  undo: SavedStep[];
  redo: SavedStep[];
  counters?: [string, number][];
  nextId?: number;
}

/** Menu command prefix for File → Open Recent (the file's path follows). */
const OPEN_RECENT = "file.openRecent:";

/** Thrown by an op's compute while it waits for a pick (not a mistake): shown as a prompt, not in red. */
class OpWaiting extends Error {}

/** What Cut cuts along: a guide line (its index), a world axis line (0 = X, 1 = Y, 2 = Z), or a straight path (its body id). */
type CutLine = number | { axis: number } | { path: number };

/** What Sweep runs along: a path object or a guide line (its index). */
type Spine = { path: number } | { guide: number };

/** Fillet / Chamfer on this many edges or more: the panel shows before the (slow) preview. */
const SLOW_EDGES = 60;

/** Cut: more upper pieces than this go in a new group of their own. */
const CUT_GROUP_OVER = 4;

/** Undo / Redo that will take longer than this (ms) to draw shows the busy dialog. */
const BUSY_DRAW_MS = 300;

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
      { cmd: "tool.cone", icon: "cone", label: "Cone", key: "B O" },
    ],
  },
  {
    title: "Face",
    drawer: true,
    items: [
      { cmd: "tool.rectangle", icon: "rectangle", label: "Rectangle", key: "A" },
      { cmd: "tool.circle", icon: "circle", label: "Circle", key: "A C" },
      { cmd: "tool.polygon", icon: "polygon", label: "Polygon", key: "A P" },
      { cmd: "tool.text", icon: "text", label: "Text", key: "T · A T" },
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
      { cmd: "edit.circular", icon: "circular", label: "Circular copy", key: "" },
      { cmd: "edit.mirror", icon: "mirror", label: "Mirror", key: "M" },
      { cmd: "op.sweep", icon: "sweep", label: "Sweep", key: "Pro: S W" },
      { cmd: "op.cut", icon: "cut", label: "Cut by guide or axis", key: "C" },
      { cmd: "op.splitFace", icon: "splitFace", label: "Split face by guide", key: "Shift+C" },
      { cmd: "tool.divideFace", icon: "pencil", label: "Draw line on face", key: "D" },
      { cmd: "tool.guide", icon: "guide", label: "Guide line", key: "Shift+G" },
      { cmd: "edit.clearGuides", icon: "clearGuides", label: "Clear guides", key: "" },
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
      { cmd: "xf.moveFrom", icon: "moveFrom", label: "Move from point", key: "G G" },
      { cmd: "xf.rotate", icon: "rotate", label: "Rotate", key: "R" },
      { cmd: "xf.scale", icon: "scale", label: "Scale", key: "S" },
      { cmd: "xf.repeat", icon: "repeat", label: "Repeat last", key: "Shift+R" },
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
    ],
  },
  {
    title: "X-ray",
    items: [{ cmd: "view.xray", icon: "xray", label: "X-ray", key: "Shift+X" }],
  },
];

/** Commands that work during a sketch (anything else waits for Done / Cancel). */
const SKETCH_COMMANDS = new Set(["view.fit", "view.fitSelection", "view.xray", "view.pro", "help.shortcuts"]);

/** localStorage: Pro layout on ("1"); saves so far; the Pro tip was shown (or not needed). */
const PRO_KEY = "yddd.pro", SAVES_KEY = "yddd.saves", PRO_TIP_KEY = "yddd.proTip";
/** The right panel's width: localStorage key and limits (px). */
const SIDEBAR_KEY = "yddd.sidebarWidth", SIDEBAR_MIN = 180, SIDEBAR_MAX = 600;
/** The Pro layout tip comes with this save. */
const PRO_TIP_SAVES = 20;
/** localStorage: Auto snap off ("0"); on by default. */
const AUTO_SNAP_KEY = "yddd.autoSnap";
/** More guides than this from one Guide tool run are grouped (Bodies panel). */
const GUIDE_GROUP_MIN = 4;

/** The Snap step (status bar), remembered for next time. */
const SNAP_STEP_KEY = "yddd.snapStep";

/** Edge mode's pointer: the arrow with a small "E" by it. */
const EDGE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><path d="M2 2 L2 19 L6.5 15 L9.5 22 L12.5 20.7 L9.6 14 L15.5 14 Z" fill="#fff" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/>` +
    `<text x="16" y="26" font-family="sans-serif" font-size="12" font-weight="bold" fill="#ffe066" stroke="#000" stroke-width="2.5" paint-order="stroke">E</text></svg>`,
)}") 2 2, default`;
const isPro = () => document.body.classList.contains("pro");

const KEYMAP: Record<string, string> = {
  "1": "mode.body",
  "2": "mode.face",
  "3": "mode.edge",
  b: "tool.box",
  a: "tool.rectangle",
  t: "tool.text",
  k: "tool.sketch",
  p: "op.pushpull",
  Space: "op.pushpull",
  f: "op.fillet",
  "Shift+F": "op.chamfer",
  h: "op.shell",
  o: "op.offset",
  c: "op.cut",
  g: "xf.move",
  d: "tool.divideFace",
  "Shift+G": "tool.guide",
  "Shift+C": "op.splitFace",
  "Shift+R": "xf.repeat",
  r: "xf.rotate",
  s: "xf.scale",
  m: "edit.mirror",
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
 * B B box · B C cylinder · B S sphere · B O cone — A rectangle · A C circle · A P polygon · A T text — G G move from point.
 */
const CHORDS: Record<string, Record<string, string>> = {
  b: { b: "tool.box", c: "tool.cylinder", s: "tool.sphere", o: "tool.cone" },
  a: { a: "tool.rectangle", r: "tool.rectangle", c: "tool.circle", p: "tool.polygon", t: "tool.text" },
  g: { g: "xf.moveFrom" },
};
/** Pro layout only: S W sweep (S starts Scale, W switches) · R E revolve (R starts Rotate, E switches). */
const PRO_CHORDS: Record<string, Record<string, string>> = {
  s: { w: "op.sweep" },
  r: { e: "op.revolve" },
};
const CHORD_MS = 1500;

/** Toolbar commands that go into the recent strip (mode switches, undo/redo and views have their own keys / buttons). */
const RECENT_ITEMS = new Map(TOOLBAR.filter((g) => g.title !== "Select" && g.title !== "History" && g.title !== "View").flatMap((g) => g.items.map((it) => [it.cmd, it] as const)));
const RECENT_MAX = 10;
/** Face mode: how close (px) a click must be to a selected face's edge to switch to Edge mode. */
const FACE_EDGE_PICK_PX = 14;
/** v2: the strip saved before "tool.line" became "tool.divideFace" is dropped (see loadRecent). */
const RECENT_KEY = "yddd.recentCmds.v2";
const RECENT_KEY_OLD = "yddd.recentCmds";
/** The strip's commands, least recently used first (which slot a new command takes over). */
const RECENT_USE_KEY = "yddd.recentUse";
/** Largest STL (triangles) imported as editable solids; bigger ones stay meshes. */
const STL_SOLID_MAX = 20000;

/** Last STL export quality (localStorage). */
const STL_QUALITY_KEY = "yddd.stlQuality";

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
  body: "Solid mode: click to select solids (click again → face / edge), Shift+click to add.  Middle-drag or Alt+drag orbit · Shift+drag pan · Wheel / two-finger slide zoom",
  face: "Face mode: click faces (P push/pull, H shell; a flat face's centre dot, then G: a cone / pyramid), click a selected face's edge → Edge mode.  Shift+click to add · Right-click a solid → Solid mode",
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
    /** Its background job (computeAsync) under way, for the values `key`; `wanted`: the values changed meanwhile. */
    job?: { key: string; done: Promise<void> };
    wanted?: boolean;
  } | null = null;
  /** The background kernel (a second OpenCascade in a worker) for slow operations: see kernelWorker.ts. */
  private bgKernel = new KernelWorker();
  /** Move/rotate gizmo session; with `edges` it moves those edges (reshaping their solids) instead of whole bodies. */
  /** The move / rotate gizmo session; `frame`: a move along turned axes (G / G G on a round or slanted edge: Z along its circle's axis / along the edge). */
  private xf: { mode: "translate" | "rotate"; ids: number[]; pivot?: V3; frame?: GizmoFrame; edges?: SelItem[]; guide?: number } | null = null;
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
  /** The strip's commands, least recently used first (older saves: the strip's order). */
  private recentUse: string[] = (() => {
    try {
      const v = JSON.parse(localStorage.getItem(RECENT_USE_KEY) ?? "[]");
      const use = Array.isArray(v) ? v.filter((c) => this.recent.includes(c)) : [];
      return [...this.recent.filter((c) => !use.includes(c)), ...use];
    } catch {
      return [...this.recent];
    }
  })();
  private selEdgeCache: { sel: SelItem[]; edges: Map<number, Set<number>> } | null = null;
  private rightDownAt: { x: number; y: number } | null = null;
  private hoverQueued: PointerEvent | null = null;
  /** Box from Face (Macro menu): the last values. */
  private boxDefaults = { wall: 2, bottom: 2, height: 30, round: 0, radius: 3 };
  /** Box Lid (Macro menu): the last values, per type (inside lip / over the box). */
  private lidDefaults = {
    in: { thickness: 2, depth: 3, wall: 1.5, clearance: 0 },
    over: { thickness: 2, depth: 5, wall: 1.5, clearance: 0 },
  };
  private defaults = { fillet: 1, chamfer: 1, pushpullNew: false, shell: 1, offset: 5, offsetRound: false, offsetRing: false, edgesWhich: 0, revolveAngle: 360, joinNew: false, sweepRound: 0, sweepTurn: 0 };

  private hudEl = $("hud");
  private hudAnchor: THREE.Vector3 | null = null;
  private handlesEl = $("op-handles");
  private choicesEl = $("op-choices");
  /** The op whose choice marks are shown (rebuilt for another one). */
  private choicesOf: OpSpec | null = null;
  private linesEl = $("op-lines") as unknown as SVGSVGElement;
  private opPanel = $("op-panel");

  constructor() {
    document.body.classList.toggle("pro", localStorage.getItem(PRO_KEY) === "1");
    this.bindSidebarGrip();
    const container = $("viewport");
    this.viewport = new Viewport(container);
    this.viewport.onDimensionClick = (i) => this.selectDimension(i);
    this.doc.relinkDims = (dims, prev, next) => relinkDimensions(dims, prev, next);
    this.doc.linkCopies = (prev, next, arrays, label) => this.linkCopies(prev, next, arrays, label);
    this.buildToolbar();
    this.buildCornerTools();
    this.renderRecent();
    $("recent").addEventListener("contextmenu", (e) => this.recentMenu(e));
    this.bindViewportEvents();
    this.bindKeys();
    this.bindStatusBar();

    this.doc.onChange(() => this.onDocChange());
    this.doc.onChange(() => this.scheduleAutosave());
    window.yddd?.onMenu((cmd) => (cmd.startsWith(OPEN_RECENT) ? void this.openRecent(cmd.slice(OPEN_RECENT.length)) : this.run(cmd)));
    // Unsaved-changes prompt on close is handled by the main process (see setDirty);
    // a beforeunload handler would silently block closing in Electron.

    this.onDocChange();
    this.viewport.fit();
  }

  // ================================================================ ToolHost

  snapStep(e: { ctrlKey: boolean } | null): number {
    return this.viewport.snapping(e) ? this.snap : 0; // Auto snap: unless Ctrl is held; else only while it's held
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
    lines += this.positionChoices(r);
    this.linesEl.innerHTML = lines;
  }

  /** Place the op's choice marks (built once per op); returns their lines (SVG) from `from`. */
  private positionChoices(r: DOMRect): string {
    const spec = this.op?.spec ?? null, list = spec?.choices ?? [];
    if (this.choicesOf !== spec) {
      this.choicesOf = spec;
      this.choicesEl.innerHTML = "";
      for (const c of list) {
        const b = document.createElement("button");
        b.className = "op-choice";
        b.textContent = c.label;
        b.title = c.title ?? c.label;
        b.style.setProperty("--c", c.color);
        b.addEventListener("pointerdown", (e) => e.stopPropagation()); // (not a click in the view)
        b.addEventListener("click", () => {
          const input = this.op?.inputs.find((i) => i.dataset.key === c.key);
          if (!input) return;
          input.value = String(c.value);
          input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
          this.positionHandle();
        });
        this.choicesEl.appendChild(b);
      }
    }
    let lines = "";
    list.forEach((c, i) => {
      const el = this.choicesEl.children[i] as HTMLElement;
      const input = this.op!.inputs.find((inp) => inp.dataset.key === c.key);
      el.classList.toggle("on", !!input && Number(input.value) === c.value);
      // (kept inside the view — e.g. +Z above an object filling it — still clickable, its line pointing the way)
      const p = this.viewport.toScreen(new THREE.Vector3(...c.at)), m = 18;
      const s = { x: Math.min(Math.max(p.x, r.left + m), r.right - m), y: Math.min(Math.max(p.y, r.top + m), r.bottom - m) };
      el.style.left = `${s.x - r.left}px`;
      el.style.top = `${s.y - r.top}px`;
      if (c.from) {
        const o = this.viewport.toScreen(new THREE.Vector3(...c.from));
        lines += `<line x1="${o.x - r.left}" y1="${o.y - r.top}" x2="${s.x - r.left}" y2="${s.y - r.top}" stroke="${c.color}" stroke-width="1.5" stroke-opacity="0.45" stroke-dasharray="4 3"/>`;
      }
    });
    return lines;
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
        .map((f, i) => `<label${f.more ? ` class="more" style="display:none"` : ""}><span>${f.label}</span><input type="number" data-i="${i}" value="${f.value}" step="${f.step ?? "any"}"${f.min !== undefined ? ` min="${f.min}"` : ""}></label>`)
        .join("") +
      (fields.some((f) => f.more) ? `<button type="button" class="more-link" data-act="more" style="background:none;border:0;padding:2px 0;color:inherit;opacity:.7;text-decoration:underline;cursor:pointer;font:inherit;font-size:12px">More…</button>` : "") +
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
    dlg.querySelector("[data-act=more]")?.addEventListener("click", (e) => {
      for (const l of dlg.querySelectorAll<HTMLElement>("label.more")) l.style.display = "";
      (e.currentTarget as HTMLElement).remove();
    });
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

  /** Rarely used tools (Revolve / Circular copy / Sweep / Array copy) as small buttons in the viewport's bottom-left corner. */
  private buildCornerTools(): void {
    const box = $("corner-tools");
    const items: [string, string, string][] = [
      ["op.revolve", "revolve", "Revolve a flat face about a line or axis (Pro: R E)"],
      ["edit.circular", "circular", "Circular copy: copies round an axis — the X / Y / Z axis, a guide line or a circle edge"],
      ["op.sweep", "sweep", "Sweep a flat face along a path or guide line (Pro: S W)"],
      ["edit.array", "array", "Array copy: several copies in a row — copies, gap between them, direction (to change an array later: its icon in the Bodies panel)"],
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

  /**
   * Recent-commands strip (left border). Slots stay put, so a command is always found in the same place:
   * a new one goes at the bottom, or — strip full — takes the slot of the least recently used one.
   */
  private pushRecent(cmd: string): void {
    if (!RECENT_ITEMS.has(cmd)) return;
    this.recentUse = [...this.recentUse.filter((c) => c !== cmd && this.recent.includes(c)), cmd];
    localStorage.setItem(RECENT_USE_KEY, JSON.stringify(this.recentUse));
    if (this.recent.includes(cmd)) return;
    if (this.recent.length < RECENT_MAX) this.recent = [...this.recent, cmd];
    else {
      const old = this.recentUse.find((c) => c !== cmd) ?? this.recent[0];
      this.recent = this.recent.map((c) => (c === old ? cmd : c));
      this.recentUse = this.recentUse.filter((c) => c !== old);
    }
    localStorage.setItem(RECENT_KEY, JSON.stringify(this.recent));
    this.renderRecent();
  }

  /** Take one command (or, with none given, all) off the recent strip; saved. */
  private clearRecent(cmd?: string): void {
    if (!cmd && !this.recent.length) return this.toast("The recent tools strip is already empty");
    this.recent = cmd ? this.recent.filter((c) => c !== cmd) : [];
    this.recentUse = this.recentUse.filter((c) => this.recent.includes(c));
    localStorage.setItem(RECENT_KEY, JSON.stringify(this.recent));
    localStorage.setItem(RECENT_USE_KEY, JSON.stringify(this.recentUse));
    this.renderRecent();
  }

  /** Right-click on the recent strip: a menu at the cursor — remove the tool clicked on (if any), clear them all. */
  private recentMenu(e: MouseEvent): void {
    e.preventDefault();
    const cmd = ((e.target as HTMLElement).closest?.("#recent-list .tb-btn") as HTMLElement | null)?.dataset.cmd;
    const items: { label: string; act: () => void }[] = [];
    if (cmd) items.push({ label: `Remove ${RECENT_ITEMS.get(cmd)?.label ?? "it"}`, act: () => this.clearRecent(cmd) });
    items.push({ label: "Clear recent", act: () => this.clearRecent() });
    this.popupMenu("Recent", items, e.clientX, e.clientY);
  }

  /** A small pop-up menu at (x, y) (like the view menu): a click picks an item; a click elsewhere or a key closes it. */
  private popupMenu(title: string, items: { label: string; act: () => void }[], x: number, y: number): void {
    document.getElementById("popup-menu")?.remove();
    const menu = document.createElement("div");
    menu.id = "popup-menu";
    menu.className = "popup-menu";
    menu.innerHTML = `<h5>${title}</h5>` + items.map((it, i) => `<button data-i="${i}"><span>${it.label}</span></button>`).join("");
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, innerWidth - r.width - 4)}px`;
    menu.style.top = `${Math.min(y, innerHeight - r.height - 4)}px`;
    const close = () => {
      menu.remove();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Shift") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    const onDown = (e: PointerEvent) => {
      const b = (e.target as HTMLElement).closest?.("#popup-menu button") as HTMLElement | null;
      if (b && e.button === 0) {
        e.preventDefault();
        e.stopPropagation();
        close();
        items[Number(b.dataset.i)].act();
      } else if (!menu.contains(e.target as Node)) close();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
  }

  /** Put `cmd` just above (or below) `target` in the strip (dragged there); saved. */
  private moveRecent(cmd: string, target: string, after: boolean): void {
    if (cmd === target || !this.recent.includes(cmd) || !this.recent.includes(target)) return;
    const rest = this.recent.filter((c) => c !== cmd);
    rest.splice(rest.indexOf(target) + (after ? 1 : 0), 0, cmd);
    this.recent = rest;
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
      b.title = (it.key ? `${it.label} (${it.key})` : it.label) + " · drag to reorder · right-click: remove / clear";
      b.innerHTML = `${ICONS[it.icon]}<span>${it.label}</span>`;
      b.addEventListener("click", () => {
        b.blur();
        this.run(cmd); // (counts as a use; the slots don't move)
      });
      // Drag onto another button to reorder: drops above or below it (the line shows which).
      b.draggable = true;
      b.addEventListener("dragstart", (e) => {
        e.dataTransfer!.setData("text/yddd-recent", cmd);
        e.dataTransfer!.effectAllowed = "move";
        b.classList.add("dragging");
      });
      b.addEventListener("dragend", () => b.classList.remove("dragging"));
      const below = (e: DragEvent) => {
        const r = b.getBoundingClientRect();
        return e.clientY > r.top + r.height / 2;
      };
      b.addEventListener("dragover", (e) => {
        if (!e.dataTransfer?.types.includes("text/yddd-recent")) return;
        e.preventDefault();
        b.classList.toggle("drop-before", !below(e));
        b.classList.toggle("drop-after", below(e));
      });
      b.addEventListener("dragleave", () => b.classList.remove("drop-before", "drop-after"));
      b.addEventListener("drop", (e) => {
        e.preventDefault();
        b.classList.remove("drop-before", "drop-after");
        const moved = e.dataTransfer!.getData("text/yddd-recent");
        if (moved) this.moveRecent(moved, cmd, below(e));
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
      case "tool.cone": return this.startTool(new ConeTool(this).start());
      case "tool.rectangle": return this.startTool(new BoxTool(this, true).start());
      case "tool.circle": return this.startTool(new CylinderTool(this, true).start());
      case "tool.polygon": return this.startTool(new PolygonTool(this, true).start());
      case "tool.text": return void this.startText();
      case "tool.sketch": return this.startSketch();

      case "op.pushpull": return this.opPushPull();
      case "macro.box": return this.opBoxFromFace();
      case "macro.lidIn": return this.openBoxLid(false, this.selectedLidBox());
      case "macro.lidOver": return this.openBoxLid(true, this.selectedLidBox());
      case "op.fillet": return this.selDot >= 0 ? this.opRoundTip() : this.opEdges("fillet");
      case "op.chamfer": return this.opEdges("chamfer");
      case "op.shell": return this.opShell();
      case "op.offset": return this.opOffset();
      case "op.revolve": return this.opRevolve();
      case "op.sweep": return this.opSweep();
      case "op.cut": return this.startCut();
      case "op.splitFace": return this.startSplitFace();
      case "tool.guide": return this.startGuide();
      case "tool.measure": return this.startMeasure();
      case "tool.divideFace": {
        const shapeOf = (id: number) => {
          const b = this.doc.get(id);
          return b && isBrep(b) ? b.shape : null;
        };
        return this.startTool(new DivideFaceTool(this, (id, a, b) => this.divideFace(id, a, b), (id) => this.divideRefusal(id), shapeOf).start());
      }
      case "edit.clearGuides":
        if (!this.doc.guides.length) return this.toast("No guide lines");
        this.selGuide = -1;
        return this.doc.setGuides([], "Clear guides");

      case "bool.union": return this.boolean("union");
      case "bool.subtract": return this.boolean("subtract");
      case "bool.intersect": return this.boolean("intersect");

      case "xf.move":
        if (this.selDot >= 0) return this.opPullToPoint();
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
      case "edit.circular": return this.circularCopy();
      case "edit.mirror": return this.mirrorCopy();
      case "edit.arrayChange": return this.arrayCopy(true);
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
        this.renderToolbarState();
        return;

      case "file.new": void this.fileNew(); return;
      case "file.open": void this.fileOpen(); return;
      case "file.save": void this.fileSave(false); return;
      case "file.saveAs": void this.fileSave(true); return;
      case "file.saveAndClose":
        void this.fileSave(false).then(() => {
          if (!this.doc.dirty) window.yddd.closeNow();
        });
        return;
      case "file.importStep": void this.fileImportStep(); return;
      case "file.importStl": void this.fileImportStl(); return;
      case "file.exportStep": void this.fileExport("step"); return;
      case "file.exportStl": void this.fileExport("stl"); return;
      case "file.export3mf": void this.fileExport("3mf"); return;
      case "file.settings": return this.settingsDialog();

      case "help.shortcuts": return this.toggleHelp();
      case "help.birdhouse": return this.toggleTutorial(BIRD_HOUSE);
      case "help.cablebox": return this.toggleTutorial(CABLE_STORAGE_BOX);
      case "help.house": return this.toggleTutorial(HOUSE);
      case "help.planter": return this.toggleTutorial(PLANTER);
      case "view.menu": return this.showViewMenu();
      case "view.pro": return this.togglePro();
      case "view.clearRecent": return this.clearRecent();
    }
  }

  /** Leave whatever interactive state we're in (tool, op panel, gizmo). */
  private endInteractions(): void {
    this.endTool();
    this.cancelOp();
    this.stopTransform();
  }

  // ================================================================ selection

  /** The canvas cursor when no tool is picking: in Edge mode, the arrow with an "E". */
  private selCursor(): string {
    return this.mode === "edge" ? EDGE_CURSOR : "default";
  }

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
      if (!this.tool && !this.op) this.viewport.canvas.style.cursor = this.selCursor();
    }
    this.refreshSelection();
  }

  private setSelection(items: SelItem[]): void {
    this.selection = items;
    if (items.length) this.selDot = -1;
    if (items.length) this.clearGuideGroup();
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
    this.clearGuideGroup();
    if (this.selDim >= 0) {
      this.selDim = -1;
      this.showDimensions();
    }
    // The selected flat face's centre dot: select it (G then pulls the face to a point).
    const dot = this.xf || e.shiftKey || e.ctrlKey ? -1 : this.dotAt(e);
    if (dot >= 0) {
      if (this.selGuide >= 0) {
        this.selGuide = -1;
        this.showGuides();
      }
      this.selDot = dot;
      this.setSelection([]);
      this.hint(this.dots[dot].tip ? "Tip selected · F rounds it · Esc deselects" : "Centre point selected · G pulls the face to a point: a cone (a circle) or a pyramid · Esc deselects");
      return;
    }
    this.selDot = -1;
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
    // Moving solids (G): a click on a round / slanted edge turns the gizmo to it — slide along its axis / the edge.
    if (this.xf?.mode === "translate" && this.xf.ids.length && !this.xf.edges && this.xf.guide === undefined && !e.shiftKey && !e.ctrlKey) {
      const round = this.slideEdgeAt(e);
      if (round) return this.startTransform("translate", true, round.point, round.frame);
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
    // Edge mode, on an edge of a hole's rim: the whole rim (Shift: added); a click on an edge of the
    // selected rim: just that edge (e.g. to fillet one side).
    const rim = item.kind === "edge" && this.mode === "edge" ? this.holeRimOf(item) : null;
    if (rim && rim.length > 1) {
      const inSel = (x: SelItem) => this.selection.some((s) => sameItem(s, x));
      const add = e.shiftKey || e.ctrlKey;
      if (!add && this.selection.length === rim.length && rim.every(inSel)) {
        this.setSelection([item]);
        this.hint("One edge of the hole's rim · click another edge of it for the whole rim again");
        return;
      }
      if (!add || !inSel(item)) {
        this.setSelection(add ? [...this.selection.filter((s) => !rim.some((r) => sameItem(r, s))), ...rim] : rim);
        this.hint(`Hole rim (${rim.length} edges) · S resize · Del fill · F fillet the rim · click an edge of it again: just that edge · Shift+click another hole: add it`);
        return;
      }
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

  /** All the edges of the hole's rim that edge `item` is on (any shape of hole), or null if it isn't a hole's rim. */
  private holeRimOf(item: SelItem): SelItem[] | null {
    const b = this.doc.get(item.body);
    if (!b || b.kind !== "solid" || !isBrep(b)) return null;
    const hole = holeAt(b.shape, item.id);
    return hole ? hole.rim.map((id) => ({ kind: "edge" as const, body: item.body, id })) : null;
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
      this.clearGuideGroup();
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
    this.updateDots();
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
    const onDot = this.xf ? -1 : this.dotAt(e);
    if (onDot !== this.hoverDot) {
      this.hoverDot = onDot;
      this.updateDots();
      if (onDot < 0) this.viewport.canvas.style.cursor = this.selCursor();
    }
    if (onDot >= 0) {
      if (this.hover) { this.hover = null; this.viewport.setHighlight(this.selection, null); }
      this.viewport.canvas.style.cursor = "pointer";
      if (onDot !== this.selDot) this.hint(this.dots[onDot].tip ? "Tip: click it, then F rounds it" : "Centre point: click it, then G pulls the face to a point (a cone / pyramid)");
      return;
    }
    const g = this.viewport.guideAt(e.clientX, e.clientY);
    if (g !== this.hoverGuide) {
      if (g < 0) this.viewport.canvas.style.cursor = this.selCursor();
      this.hoverGuide = g;
      this.showGuides();
    }
    if (g >= 0) {
      // A guide under the cursor wins over bodies.
      if (this.hover) { this.hover = null; this.viewport.setHighlight(this.selection, null); }
      this.viewport.canvas.style.cursor = "pointer";
      return;
    }
    // Moving solids (G): a round / slanted edge under the cursor shows a mark — a click turns the gizmo to it.
    if (this.xf?.mode === "translate" && this.xf.ids.length && !this.xf.edges && this.xf.guide === undefined) {
      const round = this.slideEdgeAt(e);
      this.viewport.showSnapMarker(round ? { point: new THREE.Vector3(...round.point), kind: "edge" } : null);
    }
    const pick = this.viewport.pick(e.clientX, e.clientY, this.mode);
    // Face mode: preview the edge a click would switch to.
    const item: SelItem | null = this.selectedEdgeHit(e) ?? (pick ? { kind: pick.kind, body: pick.body, id: pick.id } : null);
    if (!sameItem(item, this.hover) && !(item === null && this.hover === null)) {
      this.hover = item;
      this.viewport.setHighlight(this.selection, this.hover);
      this.viewport.canvas.style.cursor = item && this.mode !== "edge" ? "pointer" : this.selCursor();
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
      if (this.busyNow) {
        if (e.key === "Escape") this.busyStop?.(); // (a background kernel job stops; a main-thread one can't)
        return e.preventDefault(); // (a slow step is about to run: see runBusy)
      }
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
          this.selDot = -1;
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
        // (not while sketching, where the first key was turned down: its second key would end the sketch)
        const blocked = this.tool instanceof SketchTool && !SKETCH_COMMANDS.has(cmd);
        if (chord && !blocked) this.chord = { keys: chord, at: performance.now() };
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
    this.viewport.canvas.style.cursor = this.selCursor();
    this.refreshSelection();
  }

  /**
   * Floating panel of a click-to-pick tool (Booleans, Cut): what to click, and a button to finish.
   * `set` fills its text; `remove` takes it away (call it from the tool's dispose).
   */
  private toolPanel(title: string, button: { label: string; primary?: boolean }, onButton: () => void): { body: HTMLElement; set: (html: string) => void; remove: () => void } {
    const panel = document.createElement("div");
    panel.id = "tool-panel";
    panel.innerHTML = `<h4>${escapeHtml(title)}</h4><div class="tp-body"></div><div class="op-buttons"><button class="btn${button.primary ? " primary" : ""}" data-act="done">${escapeHtml(button.label)}</button></div>`;
    panel.querySelector("button")!.addEventListener("click", () => onButton());
    this.viewport.canvas.parentElement!.appendChild(panel);
    const body = panel.querySelector<HTMLElement>(".tp-body")!;
    return { body, set: (html) => void (body.innerHTML = html), remove: () => panel.remove() };
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
    buttons.innerHTML = `<button class="btn" data-a="cancel">Cancel</button><button class="btn primary" data-a="apply">${spec.applyLabel ?? "Apply ⏎"}</button>`;
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
      ? `${spec.title}: drag the ${drags.length > 1 ? "handles" : "blue handle"} to set the ${drags[0].unit ? "scale" : "distance"} (${this.viewport.snapTip("grid / points")}) · click or Enter apply · Esc cancel`
      : `${spec.title}: adjust values (mouse wheel over a field to scrub) · Enter apply · Esc cancel`));
    this.renderToolbarState();
    if (spec.slow) this.previewAfterPaint();
    else this.previewOp();
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
    // Snapping (see Viewport.snapping): level with the object point under the cursor (corner, midpoint, centre, edge, guide), else grid.
    // The world X / Y / Z lines cross the whole view, so a drag would keep catching them: only with Ctrl.
    const sp = this.viewport.snapping(e) ? this.viewport.snapPoint(e.clientX, e.clientY, undefined, { axes: e.ctrlKey }) : null;
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
    const units = drag.units ?? (drag.unit ? "%" : "mm");
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
    this.op.timer = window.setTimeout(() => (this.op?.spec.slow ? this.previewAfterPaint() : this.previewOp()), 120);
  }

  /** A slow preview: "Working…" in the panel first, painted, then the preview (the app is busy while it's worked out). */
  private previewAfterPaint(): void {
    const op = this.op;
    if (!op || op.key === this.opValues().key) return;
    const err = this.opPanel.querySelector(".op-error");
    if (err) {
      err.textContent = "Working out the preview…";
      err.classList.add("waiting");
    }
    requestAnimationFrame(() => setTimeout(() => this.op === op && this.previewOp(), 0));
  }

  private previewOp(): OpOutcome | null {
    const op = this.op;
    if (!op) return null;
    const { values, key } = this.opValues();
    if (key === op.key && op.result) return op.result;
    const err = op.inputs[0].closest("#op-panel")!.querySelector(".op-error")!;
    try {
      if (Object.values(values).some((v) => !Number.isFinite(v))) throw new Error("enter a number");
      // Worked out in the background kernel: the app stays live; the newest values go next when this one's done
      if (op.spec.computeAsync && this.bgKernel.ready) {
        if (op.job) {
          if (op.job.key !== key) op.wanted = true;
          return null;
        }
        this.startOpJob(op, values, key, err);
        return null;
      }
      const t0 = performance.now();
      const result = op.spec.compute(values);
      this.showOpResult(op, result, key, err);
      op.previewMs = performance.now() - t0;
      return result;
    } catch (e) {
      this.showOpError(op, e, err);
      return null;
    }
  }

  /** Start the op's background job for these values; its result is shown when it comes (if the panel is still open). */
  private startOpJob(op: NonNullable<App["op"]>, values: Record<string, number>, key: string, err: Element): void {
    err.textContent = "Working… (Esc stops it)";
    err.classList.remove("warn");
    err.classList.add("waiting");
    const t0 = performance.now();
    const done: Promise<void> = op.spec.computeAsync!(values)
      .then(
        (result) => {
          if (this.op !== op) return;
          this.showOpResult(op, result, key, err);
          op.previewMs = performance.now() - t0;
        },
        (e) => {
          if (e instanceof JobCancelled || this.op !== op) return;
          this.showOpError(op, e, err);
        },
      )
      .finally(() => {
        if (op.job?.done === done) op.job = undefined;
        if (this.op === op && op.wanted) {
          op.wanted = false;
          this.previewOp();
        }
      });
    op.job = { key, done };
  }

  /** A preview worked out: shown (ghost / transform), with its note if it's not quite as asked (`warn`). */
  private showOpResult(op: NonNullable<App["op"]>, result: OpOutcome, key: string, err: Element): void {
    op.result = result;
    op.key = key;
    err.textContent = "";
    err.classList.remove("waiting");
    err.classList.toggle("warn", !!result.warn);
    if (result.warn) {
      err.textContent = result.warn.text;
      const act = result.warn.action;
      if (act) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "op-warn-act";
        b.textContent = act.label;
        b.addEventListener("click", () => {
          for (const [k, v] of Object.entries(act.set)) {
            const i = this.opPanel.querySelector<HTMLInputElement>(`[data-key="${k}"]`);
            if (!i) continue;
            i.value = fmt(v);
            i.dispatchEvent(new Event("input", { bubbles: true }));
          }
        });
        err.append(" ", b);
      }
    }
    if (result.xform) this.viewport.showGhostTransformed(result.xform.ids, result.xform.matrix);
    else this.viewport.showGhost(result.ghost, result.hide, result.hideSelection);
  }

  private showOpError(op: NonNullable<App["op"]>, e: unknown, err: Element): void {
    op.result = null;
    op.key = "";
    err.textContent = errorMessage(e);
    err.classList.remove("warn");
    err.classList.toggle("waiting", e instanceof OpWaiting);
    this.viewport.clearGhost();
  }

  private applyOp(): void {
    void this.applyOpWhenReady();
  }

  /** Apply: a background op first waits for the preview of the values now in the panel. */
  private async applyOpWhenReady(): Promise<void> {
    const op = this.op;
    if (!op) return;
    clearTimeout(op.timer);
    while (op.spec.computeAsync && this.bgKernel.ready && this.op === op) {
      const { key } = this.opValues();
      if (op.key === key && op.result) break;
      if (!op.job) {
        this.previewOp();
        if (!op.job) break; // (an error, shown in the panel)
      }
      await op.job.done;
    }
    if (this.op !== op) return;
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
    if (this.op?.job) this.bgKernel.cancel(); // (stops what it's working on at once)
    this.op = null;
    this.hud(null);
    this.viewport.showSnapMarker(null);
    this.positionHandle();
    this.opPanel.hidden = true;
    this.opPanel.innerHTML = "";
    this.viewport.clearGhost();
    this.hoverGuide = -1; // (Array copy lights up the guide under the cursor)
    this.showGuides(); // (Revolve / Sweep show their guide selected)
    this.viewport.canvas.style.cursor = this.selCursor();
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
        fastDrag: ({ d }) => !!axis && this.dragPushPull(new Map(), d, new Map([[bodyId, axis.normal]])),
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
    // Which way each flat face object goes (its normal, as extrudeFace): for the instant drag preview
    const flatDirs = new Map<number, V3>();
    for (const b of flats) {
      const a = faceAxis(b.shape, b.shape.faces[0].hashCode);
      if (a) flatDirs.set(b.id, a.normal);
    }
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
      fastDrag: ({ d }) => flatDirs.size === flats.length && this.dragPushPull(perSolid, d, flatDirs),
      drag,
    });
  }

  /** Faces moved by a push/pull, per body (cached per op: the document doesn't change while it is open). */
  private ppMoves = new Map<string, Map<number, V3>>();

  /**
   * Instant push/pull drag preview: shift the faces (and the fillets they carry) in the display meshes; flat face
   * objects (`flats`: id → normal) drawn as the prisms they'd make.
   */
  private dragPushPull(perBody: Map<number, number[]>, d: number, flats: Map<number, V3> = new Map()): boolean {
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
    this.viewport.showGhostDeformed(moves, new Map([...flats].map(([id, n]) => [id, [n[0] * d, n[1] * d, n[2] * d] as V3])));
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
    /** The body's solid and the edges asked for (null: all), or why not. */
    const checked = (id: number, picked: Set<number> | null, which: number | undefined) => {
      const { shape, w, edges } = edgesOf(id, picked, which);
      if (edges && !edges.size) throw new Error(`"${this.doc.get(id)!.name}" has no ${w} edges`);
      return { shape, edges };
    };
    /** The bodies' new shapes as the preview; edges it can't do at this size left sharp — the panel says so, with the largest size that does them all. */
    const outcome = (got: Map<number, Pick<RoundResult, "shape" | "asked" | "largest"> & { skipped: number }>, r: number): OpOutcome => {
      let skipped = 0, asked = 0, largest: number | null = null;
      for (const g of got.values()) {
        skipped += g.skipped;
        asked += g.asked;
        if (g.skipped && g.largest !== null) largest = Math.min(largest ?? Infinity, g.largest);
      }
      const done = this.replaceOutcome(new Map([...got].map(([id, g]) => [id, g.shape])), title);
      if (!skipped) return done;
      const what = isFillet ? "rounded" : "chamfered", unit = isFillet ? "R " : "";
      return {
        ...done,
        warn: {
          text: `${skipped} of ${asked} edge${asked > 1 ? "s" : ""} can't be ${what} at ${unit}${fmt(r)} — left sharp (Apply keeps the rest).${largest !== null ? ` All of them work up to about ${unit}${fmt(largest)}.` : ""}`,
          ...(largest !== null ? { action: { label: `Use ${unit}${fmt(largest)}`, set: { r: largest } } } : {}),
        },
      };
    };
    /** Each body's BREP text, made once per op (sent to the background kernel with every new size). */
    const breps = new WeakMap<object, string>();
    const spec: OpSpec = {
      title,
      label: title,
      fields,
      compute: ({ r, which }) => {
        if (wholeSolids) spec.drag = dragFor(which); // "Edges" can move the handle to another edge
        if (r <= 0) throw new Error("value must be greater than 0");
        const got = new Map<number, Pick<RoundResult, "shape" | "asked" | "largest"> & { skipped: number }>();
        for (const [id, picked] of perBody) {
          const { shape, edges } = checked(id, picked, which);
          const res = roundSome(kind, shape, edges, r);
          got.set(id, { ...res, skipped: res.skipped.length });
        }
        return outcome(got, r);
      },
      // The same in the background kernel: the shape goes as BREP text, its edges by place in the edge list
      computeAsync: async ({ r, which }) => {
        if (wholeSolids) spec.drag = dragFor(which);
        if (r <= 0) throw new Error("value must be greater than 0");
        const got = new Map<number, Pick<RoundResult, "shape" | "asked" | "largest"> & { skipped: number }>();
        for (const [id, picked] of perBody) {
          const { shape, edges } = checked(id, picked, which);
          const all = shape.edges.map((e) => e.hashCode);
          let brep = breps.get(shape);
          if (brep === undefined) breps.set(shape, (brep = serializeShape(shape)));
          const res = await this.bgKernel.run({ op: "round", kind, brep, edges: edges ? [...edges].map((h) => all.indexOf(h)).filter((i) => i >= 0) : null, size: r });
          got.set(id, { shape: solidFrom(res), skipped: res.skipped.length, asked: res.asked, largest: res.largest }); // (meshed there too)
        }
        return outcome(got, r);
      },
      remember: ({ r, which }) => {
        if (isFillet) this.defaults.fillet = r;
        else this.defaults.chamfer = r;
        if (which !== undefined) this.defaults.edgesWhich = which;
      },
      drag: dragFor(wholeSolids ? this.defaults.edgesWhich : undefined),
      // (many edges: OpenCascade takes its time — a 171-edge gear ~1.1 s)
      slow: [...perBody].reduce((n, [id, picked]) => n + (picked?.size ?? (this.doc.get(id)?.shape as Shape | undefined)?.edges?.length ?? 0), 0) >= SLOW_EDGES,
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
    let brep: string | undefined;
    this.startOp({
      title: "Shell",
      label: "Shell",
      fields: [{ key: "t", label: "Thickness (mm)", value: this.defaults.shell, step: 0.5, min: 0 }],
      compute: ({ t }) => {
        if (t <= 0) throw new Error("thickness must be greater than 0");
        return this.replaceOutcome(new Map([[bodyId, shellSolid(this.solidOf(bodyId, "Shell"), ids, t)]]), "Shell");
      },
      // In the background kernel: the solid as BREP text (once), the open faces by place in its face list
      computeAsync: async ({ t }) => {
        if (t <= 0) throw new Error("thickness must be greater than 0");
        const shape = this.solidOf(bodyId, "Shell"), all = shape.faces.map((f) => f.hashCode);
        brep ??= serializeShape(shape);
        const res = await this.bgKernel.run({ op: "shell", brep, faces: [...ids].map((h) => all.indexOf(h)).filter((i) => i >= 0), thickness: t });
        return this.replaceOutcome(new Map([[bodyId, solidFrom(res)]]), "Shell");
      },
      remember: ({ t }) => (this.defaults.shell = t),
    });
  }

  /**
   * Macro → Box from Face: an open-top box round a flat face — the face is its inside (floor and inner outline);
   * walls grow out from it, the bottom down under it (a face object becomes the box; on a solid's face, a new
   * solid) — wall, bottom, inside depth, and optionally round vertical edges. The panel opens at once and
   * waits for the face if none is selected; a click on another flat face (or a face object's row) changes it.
   */
  private opBoxFromFace(): void {
    this.openBoxFromFace(this.oneFaceTarget());
  }

  private openBoxFromFace(target: { bodyId: number; faceId: number } | null): void {
    const tb = target && this.doc.get(target.bodyId);
    const body = tb && isBrep(tb) && findFace(tb.shape, target!.faceId)?.geomType === "PLANE" ? tb : null;
    const faceId = body ? target!.faceId : 0;
    // What a click picks: a flat face (of a face object or a solid), or something it can't use
    type Target = { bodyId: number; faceId: number } | "bad" | null;
    const targetAt = (e: PointerEvent): Target => {
      const hit = this.viewport.pick(e.clientX, e.clientY, "face");
      const b = hit && this.doc.get(hit.body);
      if (!hit || !b) return null;
      return hit.kind === "face" && isBrep(b) && findFace(b.shape, hit.id)?.geomType === "PLANE" ? { bodyId: b.id, faceId: hit.id } : "bad";
    };
    const targetOf = (id: number): Target => {
      const b = this.doc.get(id);
      return b?.kind === "face" && b.shape.faces[0]?.geomType === "PLANE" ? { bodyId: b.id, faceId: b.shape.faces[0].hashCode } : "bad";
    };
    const take = (t: Target) => {
      if (!t) return;
      if (t === "bad") return this.toast("Box from Face: click a flat face — of a face object (Rectangle, Circle, a sketch...) or a solid", "error");
      spec.remember!(this.opValues().values); // (the panel opens again with them)
      this.openBoxFromFace(t);
    };
    const picked: SelItem[] = body ? [body.kind === "face" ? { kind: "body", body: body.id, id: 0 } : { kind: "face", body: body.id, id: faceId }] : [];
    const todo = "click a flat face: it's the box's inside (floor and inner outline)";
    const d = this.boxDefaults;
    const spec: OpSpec = {
      title: "Box from Face",
      label: "Box from Face",
      note: `Face: ${body ? escapeHtml(body.kind === "face" ? body.name : `a face of ${body.name}`) : "—"}`,
      hint: `Box from Face: ${body ? "click another flat face to change it · Enter apply · " : `${todo} · `}Esc cancel`,
      fields: [
        { key: "wall", label: "Wall (mm)", value: d.wall, step: 0.5, min: 0 },
        { key: "bottom", label: "Bottom (mm)", value: d.bottom, step: 0.5, min: 0 },
        { key: "height", label: "Inside depth (mm)", value: d.height, step: 1, min: 0 },
        { key: "round", label: "Round vertical edges", value: d.round, type: "checkbox" },
        { key: "radius", label: "Inside radius (mm)", value: d.radius, step: 0.5, min: 0 },
      ],
      compute: ({ wall, bottom, height, round, radius }) => {
        if (!body) throw new OpWaiting(todo[0].toUpperCase() + todo.slice(1));
        const solid = boxFromFace(body.shape, faceId, { wall, bottom, height, radius: round ? radius : 0 });
        // A face object becomes the box; on a solid's face it's a new solid
        const replace = body.kind === "face";
        return {
          ghost: new Map([[replace ? body.id : -1, solid]]),
          commit: () => {
            const nb = inGroupOf(this.doc.makeBody(solid, "Box"), body);
            this.doc.commit(replace ? this.doc.bodies.map((b) => (b.id === body.id ? nb : b)) : [...this.doc.bodies, nb], "Box from Face");
            return { select: [nb.id], solidMode: true };
          },
        };
      },
      remember: ({ wall, bottom, height, round, radius }) => (this.boxDefaults = { wall, bottom, height, round, radius }),
      pick: (e) => take(targetAt(e)),
      pickBody: (id) => take(targetOf(id)),
      hover: (e) => {
        const t = targetAt(e);
        this.viewport.setHighlight(picked, t && t !== "bad" ? { kind: "face", body: t.bodyId, id: t.faceId } : null);
        this.viewport.canvas.style.cursor = t === "bad" ? "not-allowed" : t ? "pointer" : "crosshair";
      },
    };
    this.startOp(spec);
    this.viewport.setHighlight(picked, null);
  }

  /** The one selected solid (or a face of it), for Box Lid; null for anything else. */
  private selectedLidBox(): number | null {
    const ids = [...new Set(this.selection.map((s) => s.body))];
    return ids.length === 1 && this.doc.get(ids[0])?.kind === "solid" ? ids[0] : null;
  }

  /**
   * Macro → Box Lid: a lid for an open-top box (Box from Face, Shell...), closed on it — `over` false: a plate on the
   * rim with a lip fitting in the opening; true: a cap, bigger, its skirt round the box's outside. The panel waits for
   * the box if none is selected; a click on another one changes it.
   */
  private openBoxLid(over: boolean, boxId: number | null): void {
    const tb = boxId === null ? undefined : this.doc.get(boxId);
    const box = tb?.kind === "solid" ? tb : null;
    const kind = over ? "Lid over the box" : "Lid with inside lip";
    // What a click picks: a solid with an open top, or something it can't use
    const targetOf = (id: number | null | undefined): number | "bad" | null => {
      if (id === null || id === undefined) return null;
      const b = this.doc.get(id);
      return b?.kind === "solid" && hasBoxRim(b.shape as Solid) ? b.id : "bad";
    };
    const take = (t: number | "bad" | null) => {
      if (t === null) return;
      if (t === "bad") return this.toast(`${kind}: click an open-top box — a solid with a flat rim round its opening (Box from Face, Shell...)`, "error");
      spec.remember!(this.opValues().values); // (the panel opens again with them)
      this.openBoxLid(over, t);
    };
    const at = (e: PointerEvent) => targetOf(this.viewport.pick(e.clientX, e.clientY, "body")?.body);
    const d = over ? this.lidDefaults.over : this.lidDefaults.in;
    const part = over ? "Skirt" : "Lip";
    const todo = "click the open-top box to make it for";
    const spec: OpSpec = {
      title: over ? "Box Lid — over the box" : "Box Lid — inside lip",
      label: kind,
      note: `Box: ${box ? escapeHtml(box.name) : "—"}`,
      hint: `${kind}: ${box ? "click another box to change it · Enter apply · " : `${todo} · `}Esc cancel`,
      fields: [
        { key: "thickness", label: "Lid thickness (mm)", value: d.thickness, step: 0.5, min: 0 },
        { key: "depth", label: `${part} depth (mm${over ? "" : ", 0: none"})`, value: d.depth, step: 0.5, min: 0 },
        { key: "wall", label: `${part} wall (mm${over ? "" : ", 0: solid"})`, value: d.wall, step: 0.5, min: 0 },
        { key: "clearance", label: "Clearance (mm)", value: d.clearance, step: 0.1, min: 0 },
      ],
      compute: ({ thickness, depth, wall, clearance }) => {
        if (!box) throw new OpWaiting(todo[0].toUpperCase() + todo.slice(1));
        const lid = boxLid(box.shape as Solid, { over, thickness, lipDepth: depth, lipWall: wall, clearance });
        return {
          ghost: new Map([[-1, lid]]),
          commit: () => {
            const nb = inGroupOf(this.doc.makeBody(lid, "Lid"), box);
            this.doc.commit([...this.doc.bodies, nb], kind);
            return { select: [nb.id], solidMode: true };
          },
        };
      },
      remember: ({ thickness, depth, wall, clearance }) => (this.lidDefaults[over ? "over" : "in"] = { thickness, depth, wall, clearance }),
      pick: (e) => take(at(e)),
      pickBody: (id) => take(targetOf(id)),
      hover: (e) => {
        const t = at(e);
        this.viewport.setHighlight(box ? [{ kind: "body", body: box.id, id: 0 }] : [], typeof t === "number" ? { kind: "body", body: t, id: 0 } : null);
        this.viewport.canvas.style.cursor = t === "bad" ? "not-allowed" : t !== null ? "pointer" : "crosshair";
      },
    };
    this.startOp(spec);
    this.viewport.setHighlight(box ? [{ kind: "body", body: box.id, id: 0 }] : [], null);
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
    // A row in the Bodies panel: a path, or a flat face object (a solid's face has to be clicked in the view).
    const targetOf = (id: number): Target => {
      const b = this.doc.get(id);
      if (b?.kind === "path") return { spine: { path: b.id } };
      if (b?.kind === "face" && b.shape.faces[0]?.geomType === "PLANE") return { profile: { bodyId: b.id, faceId: b.shape.faces[0].hashCode } };
      return "bad";
    };
    const take = (t: Target) => {
      if (!t) return;
      if (t === "bad") return this.toast("Sweep: the profile must be a flat face — or click a path or guide line to sweep along", "error");
      spec.remember!(this.opValues().values); // (the panel opens again with them)
      if ("spine" in t) this.openSweep(profile, t.spine);
      else this.openSweep(t.profile, spine);
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
      pick: (e) => take(targetAt(e)),
      pickBody: (id) => take(targetOf(id)),
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
    const rims = this.selectedRims();
    if (rims) return this.opResizeRounds(rims);
    const holes = this.selectedHoles();
    if (holes) return this.opResizeHoles(holes);
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
    // Text (its letters, flat or pushed) keeps its shape: only the ring, scaling evenly
    const text = ids.every((id) => !!this.doc.get(id)!.text);
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
    if (!text) axes.forEach(([key, color], i) => {
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
      ...(text ? { note: "Text scales evenly — the letters keep their shape" } : {}),
      fields: [
        // (a typed size: "+10mm" / "60mm"... — X / Y / Z along that axis, Scale on the longest side)
        { key: "s", label: "Scale (% or ±mm)", value: 100, step: 5, min: 0, mm: Math.max(...size) },
        ...(text ? [] : [
          { key: "x", label: "X (% or ±mm)", value: 100, step: 5, min: 0, mm: size[0] },
          { key: "y", label: "Y (% or ±mm)", value: 100, step: 5, min: 0, mm: size[1] },
          { key: "z", label: "Z (% or ±mm)", value: 100, step: 5, min: 0, mm: size[2] },
        ]),
        { key: "center", label: "From the centre (Shift while dragging the ring)", value: 0, type: "checkbox" },
      ],
      compute: ({ s, x = 100, y = 100, z = 100, center }) => {
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

  /**
   * The selection is only rims of round holes / pins (Edge mode: circle edges of a solid's round
   * walls): one per hole (its top and bottom rims, or both halves of a split one, count once). Else null.
   */
  private selectedRims(): { body: number; rim: RoundRim }[] | null {
    if (!this.selection.length || this.selection.some((x) => x.kind !== "edge")) return null;
    const out: { body: number; rim: RoundRim }[] = [];
    for (const x of this.selection) {
      const b = this.doc.get(x.body);
      if (!b || b.kind !== "solid" || !isBrep(b)) return null;
      const rim = roundRim(b.shape, x.id);
      if (!rim) return null;
      if (!out.some((o) => o.body === x.body && o.rim.key === rim.key)) out.push({ body: x.body, rim });
    }
    return out;
  }

  /**
   * The selection is only edges of holes' rims, any shape (Edge mode: an edge of an inner outline
   * of a face): one per hole, per solid. Else null.
   */
  private selectedHoles(): Map<number, HoleLoop[]> | null {
    if (!this.selection.length || this.selection.some((x) => x.kind !== "edge")) return null;
    const out = new Map<number, HoleLoop[]>();
    for (const x of this.selection) {
      const b = this.doc.get(x.body);
      if (!b || b.kind !== "solid" || !isBrep(b)) return null;
      const hole = holeAt(b.shape, x.id);
      if (!hole) return null;
      const list = out.get(x.body) ?? [];
      if (!list.some((h) => h.key === hole.key)) out.set(x.body, [...list, hole]);
    }
    return out;
  }

  /**
   * Scale (S) with edges of holes' rims selected (not all round): each hole the same amount wider
   * all round — typed, or dragged on the ring at the first one's wall. One undo step.
   */
  private opResizeHoles(perBody: Map<number, HoleLoop[]>): void {
    const n = [...perBody.values()].reduce((a, hs) => a + hs.length, 0);
    const what = `${n} hole${n === 1 ? "" : "s"}`;
    const [firstBody, [firstHole]] = [...perBody][0];
    const axis = faceAxis(this.doc.get(firstBody)!.shape as Shape, firstHole.walls[0] ?? firstHole.faces[0]);
    // (a wall's normal points into the hole: out of it is the other way)
    const drag = axis ? { origin: axis.center, dir: axis.normal.map((k) => -k) as V3, key: "c", unit: 0.5, look: "ring" as const, units: "mm", title: "Drag to make the hole bigger / smaller" } : undefined;
    this.startOp({
      title: `Resize hole (${what})`,
      label: "Resize hole",
      note: `<div>${what} · every wall moves out (or in) by half the change</div>`,
      fields: [{ key: "c", label: "Bigger by (mm, − smaller)", value: 0, step: 0.1 }],
      compute: ({ c }) => {
        const resized = () => new Map<number, Geom>([...perBody].map(([id, hs]) => [id, resizeHoles(this.solidOf(id, "Resize hole"), hs, c)]));
        const preview = asPreview(resized);
        return { hideSelection: true, ghost: new Map([...preview].filter((e): e is [number, Shape] => !isMesh(e[1]))), commit: () => this.replaceOutcome(resized(), "Resize hole").commit() };
      },
      remember: () => {},
      drag,
      hint: "Resize hole: type how much wider (+0.2: 0.2 mm wider across, each wall 0.1 out) or drag the ring · Enter or Done apply · Esc cancel",
    });
  }

  /** Delete with edges of holes' rims selected: the holes filled (one undo step); the solids are selected. */
  private deleteHoles(perBody: Map<number, HoleLoop[]>): void {
    const n = [...perBody.values()].reduce((a, hs) => a + hs.length, 0);
    const label = `Fill ${n} hole${n === 1 ? "" : "s"}`;
    let shapes: Map<number, Shape>;
    try {
      shapes = new Map([...perBody].map(([id, hs]) => [id, fillHoles(this.solidOf(id, "Delete"), hs)]));
    } catch (e) {
      return this.toast(errorMessage(e), "error");
    }
    this.doc.replaceShapes(shapes, label);
    this.setMode("body");
    this.setSelection([...shapes.keys()].map((id) => ({ kind: "body", body: id, id: 0 })));
    this.toast(`${label} — Ctrl+Z brings ${n === 1 ? "it" : "them"} back`);
  }

  /**
   * Scale (S) with rims of round holes / pins selected: their diameter — typed, or dragged on the
   * ring at the first one's rim. The same size: type the new diameter; different sizes: how much
   * bigger (each grows the same). A hole grows into the solid, a pin out of it; one undo step.
   */
  private opResizeRounds(rims: { body: number; rim: RoundRim }[]): void {
    const holes = rims.filter((r) => r.rim.kind === "hole").length, pins = rims.length - holes;
    const many = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
    const what = [holes ? many(holes, "hole") : "", pins ? many(pins, "pin") : ""].filter(Boolean).join(" + ");
    const sizes = [...new Set(rims.map((r) => fmt(r.rim.diameter)))];
    const same = rims.every((r) => Math.abs(r.rim.diameter - rims[0].rim.diameter) < 1e-6);
    const d0 = rims[0].rim.diameter, first = rims[0].rim;
    const out = new THREE.Vector3(...first.rim).sub(new THREE.Vector3(...first.center)).normalize().toArray() as V3;
    const perBody = new Map<number, RoundRim[]>();
    for (const { body, rim } of rims) perBody.set(body, [...(perBody.get(body) ?? []), rim]);
    const label = holes ? (pins ? "Resize holes / pins" : "Resize hole") : "Resize pin";
    this.startOp({
      title: `${label} (${what})`,
      label,
      note: `<div>${escapeHtml(what)} · Ø ${sizes.join(" / ")} mm</div>`,
      fields: same
        ? [{ key: "d", label: "Diameter (mm)", value: +d0.toFixed(4), step: 0.1, min: 0.001 }]
        : [{ key: "c", label: "Bigger by (mm, − smaller)", value: 0, step: 0.1 }],
      // The ring on the rim: drag it out / in (1 mm out = 2 mm wider).
      drag: same
        ? { origin: first.center, dir: out, key: "d", unit: 0.5, min: 0.001, look: "ring", line: true, units: "mm", title: "Drag to change the diameter" }
        : { origin: first.rim, dir: out, key: "c", unit: 0.5, look: "ring", units: "mm", title: "Drag to make them bigger / smaller" },
      compute: ({ d, c }) => {
        const change = same ? d - d0 : c;
        const resized = () => new Map<number, Geom>([...perBody].map(([id, rs]) => [id, resizeRounds(this.solidOf(id, label), rs, change)]));
        // Fast preview; the exact result is computed on Apply (see asPreview).
        const preview = asPreview(resized);
        return { hideSelection: true, ghost: new Map([...preview].filter((e): e is [number, Shape] => !isMesh(e[1]))), commit: () => this.replaceOutcome(resized(), label).commit() };
      },
      remember: () => {},
      hint: `${label}: type the ${same ? "new diameter" : "change (+0.2: each 0.2 mm wider)"} or drag the ring on the rim · Enter or Done apply · Esc cancel`,
    });
    // Once the panel is up: a first small resize, so a hole push/pull can't do (one at a slant
    // through a curved face) is already filled for the redrill and the drag previews live.
    if (holes) {
      const op = this.op;
      window.setTimeout(() => {
        if (this.op !== op) return;
        for (const [id, rs] of perBody) {
          try {
            asPreview(() => resizeRounds(this.solidOf(id, label), rs.filter((r) => r.kind === "hole"), 0.01));
          } catch {
            // (the dialog shows it when the user changes the size)
          }
        }
      }, 50);
    }
  }

  /**
   * Cut: the panel waits for what to cut (selected first, or clicked: solids / flat faces, in the view
   * or the Bodies panel) and a line (a selected guide, or click a guide / an axis line), either order;
   * once it has both it cuts by the plane through the line.
   */
  private startCut(): void {
    let ids = this.selectedBodyIds().filter((id) => { const b = this.doc.get(id); return !!b && isBrep(b); });
    // (a straight path selected with them: the line)
    const selPath = this.selectedBodyIds().find((id) => this.straightPath(id));
    let line: CutLine | null = this.selGuide >= 0 ? this.selGuide : selPath !== undefined ? { path: selPath } : null;
    const bodyAt = (e: PointerEvent): number | null => this.viewport.pick(e.clientX, e.clientY, "body")?.body ?? null;
    // A guide line under the cursor, else a world axis line (X / Y / Z), else a straight path.
    const lineAt = (e: PointerEvent): CutLine | null => {
      const g = this.viewport.guideAt(e.clientX, e.clientY);
      if (g >= 0) return g;
      const k = this.viewport.axisUnder(e.clientX, e.clientY);
      if (k >= 0) return { axis: k };
      const b = bodyAt(e);
      return b !== null && this.straightPath(b) ? { path: b } : null;
    };
    const lineName = (l: CutLine) => (typeof l === "number" ? `guide line ${l + 1}` : "axis" in l ? `${"XYZ"[l.axis]} axis` : (this.doc.get(l.path)?.name ?? "path"));
    const panel = this.toolPanel("Cut", { label: "Cancel" }, () => this.endTool());
    const showPanel = () => {
      const names = ids.map((id) => this.doc.get(id)?.name ?? "").join(", ");
      // (Pro layout: just what's picked so far — a dash for what's still to click)
      const pro = isPro();
      panel.set(
        `<div>Cutting: ${ids.length ? `<b>${escapeHtml(names)}</b>` : pro ? "—" : "<i>click a solid or flat face (or a row in the Bodies panel)</i>"}</div>` +
          `<div>Along: ${line !== null ? `<b>${lineName(line)}</b>` : pro ? "—" : "<i>click a guide line (pink dashed), an axis line (red X / green Y / blue Z) or a straight path</i>"}</div>` +
          (pro ? "" : `<div class="tp-tip">${line !== null ? "Click a solid to cut it — Shift+click picks more first, Enter cuts." : "Hover a line to see its cut plane, click it to cut."}</div>` +
            `<div class="tp-tip">Cancel or Esc exits.</div>`),
      );
      this.viewport.setHighlight(ids.map((id) => ({ kind: "body", body: id, id: 0 }) as SelItem), null);
    };
    let hovered = "";
    /** Show the cut plane of `l` across `on` (the hovered line over the picked solids, or the picked line over the hovered solid). */
    const hover = (l: CutLine | null, on: number[]) => {
      const key = JSON.stringify([l, on]);
      if (key === hovered) return;
      hovered = key;
      this.hoverGuide = typeof l === "number" ? l : -1;
      this.showGuides();
      this.viewport.canvas.style.cursor = l !== null || on.length ? "pointer" : "crosshair";
      let plane: ReturnType<App["cutPlane"]> | null = null;
      try {
        plane = l !== null && on.length ? this.cutPlane(l, on) : null;
      } catch {
        plane = null;
      }
      this.showCutPlane(plane, on);
    };
    const cut = () => {
      if (!ids.length || line === null) return;
      const [what, along] = [ids, line];
      this.endTool();
      this.opCut(what, along);
    };
    const setLine = (l: CutLine) => {
      line = l;
      hovered = "";
      if (ids.length) return cut();
      showPanel();
      this.hint(`Cut along ${typeof l === "object" && "path" in l ? `"${lineName(l)}"` : `the ${lineName(l)}`}: click the solid(s) or flat face(s) to cut · Esc cancel`);
    };
    /** Add solids / flat faces to the pick (a click on a picked one takes it out); with a line chosen, cut unless `more`. */
    const add = (picked: number[], more: boolean) => {
      if (picked.length === 1 && this.straightPath(picked[0])) return setLine({ path: picked[0] }); // (a path's row in the Bodies panel)
      const bad = picked.map((id) => this.doc.get(id)).find((b) => b && !isBrep(b));
      if (bad?.kind === "path") return this.toast(`Cut: "${bad.name}" isn't one straight line — only a straight path can be the cut line (a path can't be cut)`, "error");
      if (bad) return this.toast(`Cut: "${bad.name}" can't be cut — pick a solid or a flat face`, "error");
      if (picked.length === 1 && ids.includes(picked[0])) ids = ids.filter((id) => id !== picked[0]);
      else ids = [...new Set([...ids, ...picked])];
      hovered = "";
      if (line !== null && !more && ids.length) return cut();
      showPanel();
    };
    this.startTool({
      name: "Cut",
      move: (e) => {
        const l = lineAt(e);
        if (l !== null) return hover(l, ids);
        const b = bodyAt(e);
        hover(line, b !== null ? [...new Set([...ids, b])] : ids);
      },
      down: (e) => {
        const l = lineAt(e);
        if (l !== null) return setLine(l);
        const b = bodyAt(e);
        if (b !== null) return add([b], e.shiftKey);
        this.hint(line === null ? "Cut: click a guide line (pink dashed) or an axis line (red X / green Y / blue Z)" : "Cut: click a solid or flat face to cut");
      },
      key: (e) => {
        if (e.key === "Enter" && ids.length && line !== null) {
          cut();
          return true;
        }
        return false;
      },
      dispose: () => {
        if (this.outlinerPick === pickRows) this.outlinerPick = null;
        hover(null, []);
        this.viewport.setOverlay([]);
        panel.remove();
      },
    });
    const pickRows = (rows: number[]) => add(rows, rows.length > 1);
    this.outlinerPick = pickRows;
    showPanel();
    this.hint("Cut: pick what to cut (solids / flat faces) and a guide line or axis line, in either order — a guide's plane runs straight across the face it was drawn on (off a flat face, e.g. on a sphere: along the line as seen when it was drawn); an axis' plane is the world plane through it that faces you most · Esc cancel");
  }

  /**
   * Split face: the panel waits for the faces (selected first, or clicked: flat or curved faces of
   * solids) and a guide line (selected, or clicked), either order; once it has both, each face is
   * split where the guide's plane crosses it.
   */
  private startSplitFace(): void {
    if (!this.doc.guides.length) {
      this.toast("Split face: draw a guide line first (Shift+G — two points or parallel to an edge)", "error");
      return;
    }
    let faces: SelItem[] = this.selection.filter((s) => s.kind === "face" && this.doc.get(s.body)?.kind === "solid");
    let guide = this.selGuide;
    const faceAt = (e: PointerEvent): SelItem | null => {
      const p = this.viewport.pick(e.clientX, e.clientY, "face");
      return p && p.kind === "face" && this.doc.get(p.body)?.kind === "solid" ? { kind: "face", body: p.body, id: p.id } : null;
    };
    const bodiesOf = (items: SelItem[]) => [...new Set(items.map((s) => s.body))];
    const panel = this.toolPanel("Split face", { label: "Cancel" }, () => this.endTool());
    let hoverFace: SelItem | null = null;
    const showPanel = () => {
      // (Pro layout: just what's picked so far — a dash for what's still to click)
      const pro = isPro();
      const names = bodiesOf(faces).map((id) => this.doc.get(id)?.name ?? "").join(", ");
      const n = faces.length;
      panel.set(
        `<div>Faces: ${n ? `<b>${n} on ${escapeHtml(names)}</b>` : pro ? "—" : "<i>click a face of a solid</i>"}</div>` +
          `<div>Along: ${guide >= 0 ? `<b>guide line ${guide + 1}</b>` : pro ? "—" : "<i>click a guide line (pink dashed)</i>"}</div>` +
          (pro ? "" : `<div class="tp-tip">${guide >= 0 ? "Click a face to split it — Shift+click picks more first, Enter splits." : "Hover a guide line to see its plane, click it to split."} The solid stays one piece.</div>` +
            `<div class="tp-tip">Cancel or Esc exits.</div>`),
      );
      this.viewport.setHighlight(faces, hoverFace);
    };
    let hovered = "";
    /** Show the plane of guide `g` across the solids `on`. */
    const hover = (g: number, on: number[]) => {
      const key = JSON.stringify([g, on]);
      if (key === hovered) return;
      hovered = key;
      this.hoverGuide = g;
      this.showGuides();
      let plane: ReturnType<App["cutPlane"]> | null = null;
      try {
        plane = g >= 0 && on.length ? this.cutPlane(g, on) : null;
      } catch {
        plane = null;
      }
      this.showCutPlane(plane, on);
    };
    const split = () => {
      if (!faces.length || guide < 0) return;
      const perBody = new Map<number, number[]>();
      for (const s of faces) perBody.set(s.body, [...(perBody.get(s.body) ?? []), s.id]);
      const g = guide;
      this.endTool();
      this.opSplitFace(perBody, g);
    };
    this.startTool({
      name: "Split face",
      move: (e) => {
        const g = this.viewport.guideAt(e.clientX, e.clientY);
        const f = g >= 0 ? null : faceAt(e);
        if (!sameItem(f, hoverFace) && (f || hoverFace)) {
          hoverFace = f;
          this.viewport.setHighlight(faces, hoverFace);
        }
        this.viewport.canvas.style.cursor = g >= 0 || f ? "pointer" : "crosshair";
        hover(g >= 0 ? g : guide, bodiesOf(f ? [...faces, f] : faces));
      },
      down: (e) => {
        const g = this.viewport.guideAt(e.clientX, e.clientY);
        if (g >= 0) {
          guide = g;
          hovered = "";
          if (faces.length) return split();
          showPanel();
          return this.hint(`Split face along guide line ${g + 1}: click the face(s) to split · Esc cancel`);
        }
        const f = faceAt(e);
        if (!f) return this.hint(guide < 0 ? "Split face: click a guide line (pink dashed) or a face of a solid" : "Split face: click a face of a solid to split");
        // (a click on a picked face takes it out)
        faces = faces.some((s) => sameItem(s, f)) ? faces.filter((s) => !sameItem(s, f)) : [...faces, f];
        hovered = "";
        if (guide >= 0 && !e.shiftKey && faces.length) return split();
        showPanel();
      },
      key: (e) => {
        if (e.key === "Enter" && faces.length && guide >= 0) {
          split();
          return true;
        }
        return false;
      },
      dispose: () => {
        hover(-1, []);
        this.viewport.setOverlay([]);
        panel.remove();
      },
    });
    showPanel();
    this.hint("Split face: pick the face(s) and a guide line, in either order — each face is split where the guide's plane crosses it, the solid stays one piece · Esc cancel");
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

  /** A path that is one straight line: its ends (Cut can cut along it), else null. */
  private straightPath(id: number): { a: V3; b: V3 } | null {
    const b = this.doc.get(id);
    if (b?.kind !== "path") return null;
    const es = b.shape.edges;
    if (es.length !== 1 || es[0].geomType !== "LINE") return null;
    return { a: es[0].startPoint.toTuple() as V3, b: es[0].endPoint.toTuple() as V3 };
  }

  /**
   * The cut plane of a guide: straight across the face of the solids being cut that it lies on
   * (unless its stored direction already is), else its stored direction, else (older files) the view;
   * off a face, guides along X / Y / Z snap to the nearest world plane.
   */
  private cutPlane(line: CutLine, ids: number[]): { point: V3; normal: V3; along: V3 } {
    if (typeof line === "object" && "path" in line) {
      // A straight path (e.g. a sketch line): the upright plane through it; standing upright itself, the one facing you.
      const { a, b } = this.straightPath(line.path) ?? (() => { throw new Error("Cut: the path is gone"); })();
      const u: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const up = Math.abs(u[2]) < 0.999 * Math.hypot(...u) ? ([u[1], -u[0], 0] as V3) : undefined;
      return { point: a, normal: guidePlaneNormal([], a, b, this.viewDir(), up), along: u };
    }
    if (typeof line !== "number") {
      // A world axis: not drawn on a face, so the world plane through it seen most square-on.
      const u: V3 = [0, 0, 0];
      u[line.axis] = 1;
      return { point: [0, 0, 0], normal: guidePlaneNormal([], [0, 0, 0], u, this.viewDir()), along: u };
    }
    const { a, b, n } = this.doc.guides[line];
    // Only solids the guide passes through (their drawn boxes): it can't lie on a face of the others,
    // and looking through all their faces is slow (17 sweeps: ~0.7 s each hover).
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), len = A.distanceTo(B);
    const ray = new THREE.Ray(A, B.clone().sub(A).normalize()), hit = new THREE.Vector3();
    const near = (id: number) => {
      const box = this.viewport.drawnBox(id);
      if (!box) return true;
      box.expandByScalar(0.02 * box.getSize(new THREE.Vector3()).length() + 1e-3);
      // (starting inside it — e.g. a face's corner-to-corner diagonal — intersectBox gives the way out)
      return box.containsPoint(A) || (!!ray.intersectBox(box, hit) && hit.distanceTo(A) <= len + 1e-6);
    };
    const shapes = ids.filter(near).map((id) => this.doc.get(id)!.shape).filter(notMesh);
    return { point: a, normal: guidePlaneNormal(shapes, a, b, this.viewDir(), n), along: [b[0] - a[0], b[1] - a[1], b[2] - a[2]] };
  }

  /**
   * Cut: the copies among `ids` of an array / circular copy (all of it being cut, still as made)
   * that the plane crosses just as it does their source — it maps onto itself (same side up) when
   * moved like the copy: copy id → its source and how to put the source's pieces in its place;
   * `recs`: the records all of whose copies are cut like that (both halves are still such a copy).
   */
  private cutLikeSource(ids: number[], point: V3, normal: V3): { like: Map<number, { from: number; place: (s: Geom) => Geom }>; recs: ArrayRecord[] } {
    const out = new Map<number, { from: number; place: (s: Geom) => Geom }>(), recs: ArrayRecord[] = [];
    const set = new Set(ids);
    const n = new THREE.Vector3(...normal).normalize(), p = new THREE.Vector3(...point);
    const u = new THREE.Vector3(1, 0, 0).cross(n);
    if (u.lengthSq() < 1e-6) u.set(0, 1, 0).cross(n);
    u.normalize();
    const v = n.clone().cross(u), L = 100;
    const probes = [p, p.clone().addScaledVector(u, L), p.clone().addScaledVector(v, L)].map((q) => q.toArray() as V3);
    const up = p.clone().addScaledVector(n, L).toArray() as V3;
    const off = (q: V3) => new THREE.Vector3(...q).sub(p).dot(n);
    for (const rec of this.doc.arrays) {
      const S = rec.sources.length, members = [...rec.sources, ...rec.copies];
      if (!members.every((id) => set.has(id)) || members.some((id) => this.doc.get(id)?.kind !== "solid")) continue;
      if (this.arrayToChange(members) !== rec) continue;
      const { place, point: at } = this.arrayPlacement(rec, rec.circular ? this.circularShift(rec) ?? [0, 0, 0] : [0, 0, 0]);
      rec.copies.forEach((id, i) => {
        const k = Math.floor(i / S) + 1;
        const tol = 1e-7 * (1 + p.length() + L);
        if (!probes.every((q) => Math.abs(off(at(q, k))) < tol) || off(at(up, k)) < L / 2) return;
        out.set(id, { from: rec.sources[i % S], place: (s) => place(s, k) });
      });
      if (rec.copies.every((id) => out.has(id))) recs.push(rec);
    }
    return { like: out, recs };
  }

  /** Translucent square of the cut plane across the solids being cut (null hides it). */
  private showCutPlane(plane: { point: V3; normal: V3; along?: V3 } | null, ids: number[]): void {
    if (!plane) return this.viewport.setOverlay([]);
    const box = new THREE.Box3();
    for (const id of ids) {
      // (its drawn box: the exact one is slow on curved solids, and this runs on every hover)
      const drawn = this.viewport.drawnBox(id);
      if (drawn) box.union(drawn);
      else {
        const [lo, hi] = this.doc.get(id)!.shape.boundingBox.bounds;
        box.expandByPoint(new THREE.Vector3(...lo)).expandByPoint(new THREE.Vector3(...hi));
      }
    }
    const N = new THREE.Vector3(...plane.normal).normalize(), P = new THREE.Vector3(...plane.point);
    const c = box.getCenter(new THREE.Vector3());
    c.addScaledVector(N, -c.clone().sub(P).dot(N)); // box centre dropped onto the plane
    const size = Math.max(box.getSize(new THREE.Vector3()).length() * 1.15, 1);
    // Square edges along the guide (or axis) and across it.
    const u = plane.along ? new THREE.Vector3(...plane.along).normalize() : new THREE.Vector3(1, 0, 0);
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
  private opCut(ids: number[], line: CutLine): void {
    const bodies = ids.map((id) => this.doc.get(id)!);
    const many = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
    // (many or heavy solids, e.g. a circular copy's 17 sweeps: ~3 s, behind the busy dialog counting them)
    this.runBusy(this.heavy(bodies.filter((b) => b.kind !== "face")), `Cutting ${many(ids.length, "object")}…`, (say) => this.cutBodies(ids, line, say));
  }

  private async cutBodies(ids: number[], line: CutLine, say: ((text: string) => Promise<void>) | null): Promise<void> {
    const kept = new Map<number, Shape>();
    const cutOff: Body[] = [];
    const facePieces: number[] = [];
    const uppers = new Map<number, Body>(); // solid id → its upper piece
    let arrays = this.doc.arrays, newGroup: string | null = null;
    try {
      const { point, normal } = this.cutPlane(line, ids);
      // Copies the plane cuts just like their source (a ring round Z cut level, a row cut along it):
      // its pieces turned / moved into place — one cut, and the display reuses their triangles.
      const { like, recs } = this.cutLikeSource(ids, point, normal);
      const halves = new Map<number, { above: Solid | null; below: Solid | null }>();
      const order = [...ids.filter((id) => !like.has(id)), ...ids.filter((id) => like.has(id))];
      for (const [i, id] of order.entries()) {
        const body = this.doc.get(id)!;
        if (body.kind === "face") continue;
        const same = like.get(id);
        if (!same) {
          if (say && i) await say(`Cutting ${i + 1} of ${ids.length}…`);
          halves.set(id, splitByPlane(this.solidOf(id, "Cut"), point, normal));
          continue;
        }
        const src = halves.get(same.from)!;
        halves.set(id, { above: src.above && (same.place(src.above) as Solid), below: src.below && (same.place(src.below) as Solid) });
      }
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
        const { above, below } = halves.get(id)!;
        if (!above || !below) throw new Error(`Cut: the ${typeof line === "number" ? "guide's" : "axis" in line ? "axis'" : "path's"} cut plane does not pass through "${body.name}"`);
        kept.set(id, below);
        uppers.set(id, inGroupOf(this.doc.makeBody(above, "Solid"), body));
      }
      // Many upper pieces (e.g. a circular copy's 17): a group of their own, so they're moved, hidden
      // or deleted together; an array / circular copy cut the same all round stays one, in both halves.
      if (uppers.size > CUT_GROUP_OVER) {
        const groups = new Set(ids.filter((id) => uppers.has(id)).map((id) => this.doc.get(id)!.group));
        const from = groups.size === 1 ? [...groups][0] : undefined;
        newGroup = from ? this.uniqueGroupName(`${from} cut`) : this.newGroupName("Cut");
        for (const [id, b] of uppers) uppers.set(id, { ...b, group: newGroup });
        arrays = this.doc.arrays.flatMap((rec) => {
          if (!recs.includes(rec)) return [rec];
          const top = (id: number) => uppers.get(id)!.id;
          const made = new Map([...uppers.values()].map((b) => [b.id, b.shape as Shape]));
          const halves: [ArrayRecord, (id: number) => Shape][] = [
            [rec, (id) => kept.get(id)!],
            [{ ...rec, group: newGroup!, sources: rec.sources.map(top), copies: rec.copies.map(top) }, (id) => made.get(id)!],
          ];
          return halves.map(([r, shapeOf]) => this.recutRecord(r, rec, shapeOf));
        });
      }
      cutOff.push(...uppers.values());
    } catch (e) {
      this.toast(errorMessage(e), "error");
      return;
    }
    if (say) await say(`Drawing ${ids.length + cutOff.length} pieces…`);
    this.doc.commit([...this.doc.bodies.map((bd) => (kept.has(bd.id) ? withShape(bd, kept.get(bd.id)!) : bd)), ...cutOff], "Cut", this.doc.guides, this.doc.dimensions, arrays);
    const solidPieces = cutOff.filter((b) => b.kind !== "face");
    if (!solidPieces.length) {
      // Only faces: select all the pieces (each can be moved / pushed on its own).
      this.setSelection(facePieces.map((id) => ({ kind: "body", body: id, id: 0 })));
      this.toast(`Cut into ${facePieces.length} separate faces — they are selected`);
      return;
    }
    // Select the upper pieces, so Del removes them straight away.
    this.setSelection(solidPieces.map((bd) => ({ kind: "body", body: bd.id, id: 0 })));
    this.toast(newGroup
      ? `Cut into ${ids.length * 2} objects — the ${solidPieces.length} upper pieces are a new group, ${newGroup}, selected (Del removes it)`
      : `Cut into ${ids.length * 2} objects — the upper part is selected (Del removes it)`);
  }

  /**
   * An array / circular copy record for one half of a cut (`r`: its group and ids; `was`: the record
   * before; `shapeOf`: a member's new shape): a circular one notes its sources' boxes as they are now
   * and where the group had moved to, so it can still be changed.
   */
  private recutRecord(r: ArrayRecord, was: ArrayRecord, shapeOf: (id: number) => Shape): ArrayRecord {
    const c = was.circular;
    if (!c) return r;
    const shift = this.circularShift(was) ?? [0, 0, 0], centre = this.circularCentre(was);
    const plus = (p: V3): V3 => [p[0] + shift[0], p[1] + shift[1], p[2] + shift[2]];
    return {
      ...r,
      circular: { ...c, axis: { origin: plus(c.axis.origin), dir: c.axis.dir }, centre: plus(centre), boxes: r.sources.map((id) => shapeOf(id).boundingBox.bounds as [V3, V3]) },
    };
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
    const heavy = this.heavyBoolean(ids);
    this.runBusy(heavy, `${label} of ${ids.length} solids…`, async () => {
      let made: number[] | null;
      try {
        made = await this.applyBoolean(op, targetId, toolIds, label, false, heavy);
      } catch (err) {
        if (err instanceof JobCancelled) return this.toast(`${label} stopped — nothing changed`);
        return this.fail(err);
      }
      if (!made) return;
      this.setMode("body");
      this.setSelection(made.map((id) => ({ kind: "body", body: id, id: 0 })));
    });
  }

  /** A slow step is about to run behind the busy dialog (keys and clicks wait: see runBusy). */
  private busyNow = false;
  /** The busy dialog's Stop (Esc): set while a step that can be stopped runs. */
  private busyStop: (() => void) | null = null;

  /**
   * Run `work` — `heavy`: behind a busy dialog painted first, so the app is seen working rather than
   * hung (it fades in after a moment, so a quicker one doesn't flash; its spinner turns on the
   * compositor even while the kernel holds the page). Light: right away. The kernel can't be stopped
   * part-way, so no Cancel — Ctrl+Z undoes it afterwards. `say` (heavy only, else null): new text
   * for the dialog (e.g. "Cutting 3 of 17…"), painted before the returned promise resolves — work
   * done in steps awaits it between them.
   */
  private runBusy(heavy: boolean, text: string, work: (say: ((text: string) => Promise<void>) | null) => void | Promise<void>): void {
    if (!heavy) return void work(null);
    if (this.busyNow) return;
    this.busyNow = true;
    const el = document.createElement("div");
    el.id = "busy";
    // (the background kernel's jobs can be stopped: Stop ends whatever it's doing — nothing changes)
    const stoppable = this.bgKernel.ready;
    el.innerHTML = `<div class="busy-box"><div class="spinner"></div><div class="busy-text">${escapeHtml(text)}</div>` +
      (stoppable ? `<div class="busy-tip">Stop ends it — nothing changes</div><button type="button" class="btn busy-stop">Stop</button>` : `<div class="busy-tip">It can't be stopped part-way — Ctrl+Z undoes it afterwards</div>`) +
      `</div>`;
    // Stop / Esc: the job ends now — or, not started yet (the dialog is painted first), doesn't start
    let stopped = false;
    this.busyStop = stoppable ? () => ((stopped = true), this.bgKernel.cancel()) : null;
    el.querySelector(".busy-stop")?.addEventListener("click", () => this.busyStop?.());
    document.body.appendChild(el);
    const painted = () => new Promise<void>((done) => requestAnimationFrame(() => setTimeout(done, 0)));
    const say = (t: string) => {
      el.querySelector(".busy-text")!.textContent = t;
      return painted();
    };
    // (after the next paint: the dialog is on screen before the kernel takes over)
    void painted().then(async () => {
      try {
        if (stopped) return this.toast("Stopped — nothing changed");
        await work(say);
      } finally {
        el.remove();
        this.busyNow = false;
        this.busyStop = null;
      }
    });
  }

  /** A boolean likely to take a while (it shows the busy dialog): see heavy. */
  private heavyBoolean(ids: number[]): boolean {
    return this.heavy(ids.map((id) => this.doc.get(id)).filter((b): b is Body => !!b));
  }

  /** Solids likely to take a while to combine or draw (the busy dialog): 6 or more at once, or 400+ faces. */
  private heavy(bodies: Body[]): boolean {
    if (bodies.length >= 6) return true;
    let faces = 0;
    for (const b of bodies) faces += isBrep(b) ? b.shape.faces.length : 400; // (a mesh: heavy)
    return faces >= 400;
  }

  /**
   * Combine `toolIds` into `targetId` (keeps its id; union/intersect results are renamed "Solid N"); one undo step.
   * A result in separate pieces (e.g. a bar cut through) becomes one body per piece: the largest
   * keeps the target's id. Returns the resulting body ids, or null (with a message, nothing changed)
   * if a union would leave solids that don't touch in one body. Throws on failure.
   */
  /** `keep`: the tool solids stay (Subtract with "Keep the clicked solid"). */
  private async applyBoolean(op: BooleanOp, targetId: number, toolIds: number[], label: string, keep = false, background = false): Promise<number[] | null> {
    const target = this.doc.get(targetId)!;
    const tools = toolIds.map((id) => this.doc.get(id)!);
    // A heavy one (`background`) in the background kernel: the app stays live, the busy dialog's Stop ends it
    const result = background && this.bgKernel.ready
      ? solidFrom(await this.bgKernel.run({ op: "boolean", kind: op, target: serializeShape(this.solidOf(targetId, label)), tools: toolIds.map((id) => serializeShape(this.solidOf(id, label))) }))
      : booleanOp(op, this.solidOf(targetId, label), toolIds.map((id) => this.solidOf(id, label)));
    if (!this.doc.get(targetId) || toolIds.some((id) => !this.doc.get(id))) return null; // (gone meanwhile)
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
    const removed = new Set(keep ? [] : toolIds);
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
    /** Subtract: the solids clicked so far (used up, unless "Keep the clicked solid" brought them back). */
    const used: Body[] = [];
    /** Array / circular copy records of the used-up solids (dropped with them; Keep brings them back too). */
    const usedRecords: ArrayRecord[] = [];
    let keep = false;
    const panel = this.toolPanel(label, { label: "Done ⏎", primary: true }, () => finish());
    const showPanel = () =>
      panel.set(
        // Pro layout: just the target, the count and the option.
        `<div>Target: <b>${escapeHtml(target.name)}</b></div>` +
          (isPro() ? "" : `<div class="tp-tip">Click a solid to ${verb} it — or a group / object in the Bodies panel. Keep clicking for more.</div>`) +
          (isPro() && !count ? "" : `<div class="tp-count">${count ? `${count} done` : "None yet"}</div>`) +
          (used.length ? `<label class="tp-check"><input type="checkbox" data-act="keep"${keep ? " checked" : ""}> Keep the clicked solid</label>` : "") +
          (isPro() ? "" : `<div class="tp-tip">Done, Enter, Esc or a click on empty space finishes.</div>`),
      );
    /** Bring the clicked solids back (keep on), or take them away again (one undo step). */
    const setKeep = (on: boolean) => {
      keep = on;
      const ids = new Set(used.map((b) => b.id));
      // (bringing solids back means drawing them all again: the busy dialog if that will take a while)
      this.runBusy(on && this.viewport.drawCost(used.map((b) => b.shape)) > BUSY_DRAW_MS, `Bringing back ${used.length} solid${used.length > 1 ? "s" : ""}…`, () => {
        const others = this.doc.bodies.filter((b) => !ids.has(b.id));
        const arrays = on ? [...this.doc.arrays, ...usedRecords.filter((r) => !this.doc.arrays.includes(r))] : this.doc.arrays;
        this.doc.commit(on ? [...others, ...used] : others, on ? "Keep clicked solid" : "Use up clicked solid", this.doc.guides, this.doc.dimensions, arrays);
        show(null);
        showPanel();
      });
    };
    panel.body.addEventListener("change", (e) => {
      const box = e.target as HTMLInputElement;
      if (box.dataset.act === "keep") setKeep(box.checked);
    });
    const show = (hover: number | null) =>
      this.viewport.setHighlight([{ kind: "body", body: targetId, id: 0 }], hover === null ? null : { kind: "body", body: hover, id: 0 });
    const finish = () => {
      this.endTool();
      this.setSelection(this.doc.get(targetId) ? [{ kind: "body", body: targetId, id: 0 }] : []);
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
      const heavy = this.heavyBoolean([targetId, ...ids]);
      this.runBusy(heavy, `${label === "Subtract" ? "Subtracting" : label === "Union" ? "Joining" : "Intersecting"} ${ids.length} solid${ids.length > 1 ? "s" : ""}…`, async () => {
        try {
          const tools = ids.map((id) => this.doc.get(id)!);
          const records = this.doc.arrays.filter((r) => [...r.sources, ...r.copies].some((id) => ids.includes(id)));
          if (await this.applyBoolean(op, targetId, ids, label, op === "subtract" && keep, heavy)) {
            if (op === "subtract") usedRecords.push(...records.filter((r) => !usedRecords.includes(r)));
            count += ids.length;
            if (op === "subtract") used.push(...tools);
          }
        } catch (err) {
          if (err instanceof JobCancelled) this.toast(`${label} stopped — nothing changed`);
          else this.fail(err);
        }
        show(null);
        this.hint(msg());
        showPanel();
      });
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
        panel.remove();
      },
    };
    this.setMode("body");
    this.startTool(tool);
    this.outlinerPick = apply;
    this.viewport.canvas.style.cursor = "pointer";
    show(null);
    this.hint(msg());
    showPanel();
    this.toast(`${label} tool: click solids to ${verb} "${target.name}" — or a group in the Bodies panel · Esc to finish`);
  }

  // ================================================================ transforms

  private startTransform(mode: "translate" | "rotate", keep = false, pivot?: V3, frame?: GizmoFrame): void {
    pivot ??= keep ? this.xf?.pivot : undefined;
    frame ??= keep ? this.xf?.frame : undefined;
    if (mode !== "translate") frame = undefined; // (rotate: world axes, for now)
    if (!keep) {
      this.endTool();
      this.cancelOp();
      this.lastXf = null;
      this.repeatOps = [];
      this.placing = null; // a new move session is its own undo step (Duplicate sets it again after this)
    }
    // (keeping the gizmo: on the bodies it was on, should the selection have gone)
    let ids = this.selectedBodyIds();
    if (!ids.length && keep && this.xf) ids = this.xf.ids.filter((id) => this.doc.get(id));
    if (!ids.length) {
      this.toast(`${mode === "translate" ? "Move" : "Rotate"}: select one or more solids first`, "error");
      return;
    }
    this.xf = { mode, ids, pivot, frame };
    const turnedHint = (d: V3) => {
      const [x, y, z] = this.viewport.toGizmoAxes(d).map((n) => +n.toFixed(3));
      const steps = this.snap > 0 ? this.viewport.stepTip(`${this.snap} mm steps`) : "free";
      const off = x || y ? ` (off the axis: X ${x}, Y ${y})` : "";
      return `Slide along the dashed axis: drag the blue arrow (${steps}) · moved ${z} mm${off} · Tab: type mm · Enter/Esc: done`;
    };
    this.viewport.startTransform(mode, ids, this.snap, (r) => this.applyTransform(r), pivot, frame ? (d) => this.hint(turnedHint(d)) : undefined, frame);
    this.renderToolbarState();
    this.hint(frame ? turnedHint([0, 0, 0]) : `${mode === "translate" ? "Move" : "Rotate"}: drag the gizmo handles (${this.viewport.snapTip("grid / 5° / points")})${mode === "translate" ? " · click a round or slanted edge: slide along its axis / the edge" : ""} · Tab: type exact values · Enter/Esc: done`);
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
    this.hint(`Move edge: drag the gizmo (${this.viewport.snapTip("grid / points")}) · Tab: exact offset · Enter/Esc: done`);
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
    const mid = this.viewport.guidePivot(guide.a, guide.b);
    this.xf = { mode: "translate", ids: [], pivot: mid, guide: g };
    this.viewport.snapSkipGuide = g;
    this.viewport.startTransform("translate", [], this.snap, (r) => r.type === "translate" && this.applyGuideMove(r.vector, true), mid, (d) => this.previewGuideMove(d));
    this.renderToolbarState();
    this.hint(`Move guide: drag the gizmo (${this.viewport.snapTip("grid / points / other guides")}) · Tab: exact offset · Enter/Esc: done`);
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

  /** Why Draw line on face can't work on this body (shown to the user), or null if it can. */
  private divideRefusal(bodyId: number): string | null {
    const body = this.doc.get(bodyId);
    if (!body) return "Draw line on face: click an edge of a solid";
    if (body.kind === "face") return `Draw line on face works on solids only — "${body.name}" is a flat face. Push/Pull it (P) into a solid first.`;
    if (body.kind === "mesh") return `Draw line on face can't edit "${body.name}" — it's an imported STL mesh`;
    return null;
  }

  /** Draw line on face (D): split the face under the line a–b; the new edge is left selected (G lifts it, e.g. into a gable). */
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
    this.doc.replaceShapes(new Map([[bodyId, shape]]), "Draw line on face");
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

  /** The system's fonts for Text (asked for once). */
  private textFonts: Promise<{ family: string; style: string; file: string }[]> | null = null;

  /** Load a Text font (the built-in ones first; a system font's file once); false if it can't be read or used. */
  private async useTextFont(file: string): Promise<boolean> {
    try {
      if (!textFontReady()) await loadTextFont();
      if (!file || textFontReady(file)) return true;
      if (file.startsWith("builtin:")) return false; // (all loaded with the default)
      if (!(await (this.textFonts ??= window.yddd.listFonts().catch(() => []))).some((f) => f.file === file)) return false;
      const data = await window.yddd.readFont(file);
      if (!data) return false;
      await loadTextFont(file, data);
      return textFontReady(file);
    } catch {
      return false;
    }
  }

  /**
   * Can a Text group's text still be edited (its pencil in the Bodies panel)? null: yes; a string: why not (cut,
   * filleted, its font missing...); undefined: being checked — in the background (its letters are made again and
   * compared, tens of ms; the font may need loading), the panel redrawn when it's known. Kept until its letters change.
   */
  private textEditable(group: string, members: readonly Body[]): string | null | undefined {
    const letters = members.filter((b) => b.text);
    const known = this.textChecks.get(group);
    if (known && known.letters.length === letters.length && known.letters.every((b, i) => b === letters[i])) return known.why;
    const entry: { letters: readonly Body[]; why: string | null | undefined } = { letters, why: undefined };
    this.textChecks.set(group, entry);
    void (async () => {
      await new Promise((r) => setTimeout(r, 0)); // (after this panel update)
      const src = letters[0].text!;
      let why: string | null = null;
      if (letters.some((b) => JSON.stringify(b.text) !== JSON.stringify(src))) why = "This group holds letters of more than one text";
      else if (!(await this.useTextFont(src.font))) why = `Its font isn't on this computer (${src.font.split("/").pop()}) — the text can't be edited`;
      else if (!textPlacement(src, letters.map((b) => b.shape as Shape))) why = "Its letters were changed since (cut, filleted, some deleted...) — the text can't be edited";
      if (this.textChecks.get(group) !== entry) return;
      entry.why = why;
      if (why) this.renderOutliner();
    })();
    return undefined;
  }
  private textChecks = new Map<string, { letters: readonly Body[]; why: string | null | undefined }>();

  /**
   * The text T edits: a Text tool text's letters selected (one or all; flat or pushed) — all its letters (same
   * text, same group), in order. Null: nothing like that selected.
   */
  private textToEdit(): { letters: Body[]; src: TextRecord } | null {
    const picked = [...new Set(this.selection.map((s) => s.body))].map((id) => this.doc.get(id));
    const first = picked[0];
    if (!first?.text || picked.some((b) => !b?.text)) return null;
    const key = JSON.stringify(first.text);
    if (picked.some((b) => JSON.stringify(b!.text) !== key || b!.group !== first.group)) return null;
    return { letters: this.doc.bodies.filter((b) => b.group === first.group && JSON.stringify(b.text) === key), src: first.text };
  }

  /**
   * Text (T, A T): click where it starts, then type it in the panel (shown live) — Enter / Create adds a
   * flat face per letter outline, as one new group named after the words (Text "I love…"). `editMode` (the pencil
   * by a Text group in the Bodies panel, the text selected): edit it — the panel as it was made, the text where it
   * is now (moved, turned, scaled, pushed...); Done replaces its letters (pushed ones pushed as far again).
   */
  private async startText(editMode = false): Promise<void> {
    if (!textFontReady()) {
      try {
        await loadTextFont();
      } catch (e) {
        return this.toast(`Text: the font couldn't be loaded — ${errorMessage(e)}`, "error");
      }
    }
    // The fonts to choose from: the built-in one, then the system's (by family, each with its styles: Regular first)
    this.textFonts ??= window.yddd.listFonts().catch(() => []);
    const families = new Map<string, { style: string; file: string }[]>();
    for (const f of BUILT_IN_FONTS) families.set(BUILT_IN_FAMILY(f.family), [...(families.get(BUILT_IN_FAMILY(f.family)) ?? []), { style: f.style, file: f.key }]);
    for (const f of [...(await this.textFonts)].sort((a, b) => a.family.localeCompare(b.family))) {
      if (!families.has(f.family)) families.set(f.family, []);
      families.get(f.family)!.push({ style: f.style, file: f.file });
    }
    const regular = (st: string) => (/^(regular|book|normal|roman)$/i.test(st) ? 0 : /^medium$/i.test(st) ? 1 : 2);
    for (const styles of families.values()) styles.sort((a, b) => regular(a.style) - regular(b.style) || a.style.localeCompare(b.style));
    const familyOf = (file: string) => [...families].find(([, st]) => st.some((x) => x.file === file))?.[0];
    const useFont = (file: string) => this.useTextFont(file);
    // Editing a text: where its letters are now
    const edit = editMode ? this.textToEdit() : null;
    if (editMode && !edit) return this.toast("Edit text: this group holds letters of more than one text — select one text's letters", "error");
    let place: TextPlacement | null = null;
    // (editing a text leaves the settings for the next new one as they were)
    const forNew = TextTool.settings;
    if (edit) {
      const src = edit.src;
      if (!(await useFont(src.font))) return this.toast(`Edit text: its font isn't on this computer (${src.font.split("/").pop()}) — the text can't be made again`, "error");
      place = textPlacement(src, edit.letters.map((b) => b.shape as Shape));
      if (!place) return this.toast("Edit text: its letters were changed since (cut, filleted, some deleted...) — it can't be edited", "error");
      const k = place.scale, mm = (v: number) => +(v * k).toFixed(4);
      TextTool.settings = { text: src.text, font: src.font, height: mm(src.height), align: src.align, letterSpacing: mm(src.letterSpacing), lineSpacing: src.lineSpacing };
    }
    // The last font used (if it's still there)
    const last = localStorage.getItem(TEXT_FONT_KEY) ?? "";
    if (!edit && TextTool.settings.font === "" && last && familyOf(last) && (await useFont(last))) TextTool.settings = { ...TextTool.settings, font: last };
    if (TextTool.settings.font && !familyOf(TextTool.settings.font)) TextTool.settings = { ...TextTool.settings, font: "" };
    let panel: ReturnType<App["toolPanel"]> | null = null;
    const tool: TextTool = new TextTool(this, () => {
      panel = this.toolPanel(edit ? "Edit text" : "Text", { label: edit ? "Done ⏎" : "Create ⏎", primary: true }, () => tool.create());
      const s = TextTool.settings;
      const fam = familyOf(s.font ?? "") ?? BUILT_IN_FAMILY(BUILT_IN_FONTS[0].family);
      const opts = (items: [string, string][], sel: string) => items.map(([v, label]) => `<option value="${escapeHtml(v)}"${v === sel ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
      const styleOpts = (family: string) => opts(families.get(family)!.map((x) => [x.file, x.style]), s.font ?? "");
      const align = (["left", "center", "right"] as const).map((a) => `<option value="${a}"${s.align === a ? " selected" : ""}>${a[0].toUpperCase() + a.slice(1)}</option>`).join("");
      panel.set(
        `<textarea data-k="text" rows="2" spellcheck="false">${escapeHtml(s.text)}</textarea>` +
          `<label class="tp-field">Font<select data-k="family">${opts([...families.keys()].map((f) => [f, f]), fam)}</select></label>` +
          `<label class="tp-field">Style<select data-k="font">${styleOpts(fam)}</select></label>` +
          `<label class="tp-field">Height (mm)<input data-k="height" type="number" min="0" step="1" value="${s.height}"></label>` +
          `<label class="tp-field">Align<select data-k="align">${align}</select></label>` +
          `<label class="tp-field">Letter spacing (mm)<input data-k="letterSpacing" type="number" step="0.1" value="${s.letterSpacing ?? 0}"></label>` +
          `<label class="tp-field">Line spacing<input data-k="lineSpacing" type="number" min="0.1" step="0.1" value="${s.lineSpacing}"></label>` +
          `<div class="tp-error"></div>` +
          (isPro() ? "" : `<div class="tp-tip">Height: a capital letter. Shift+Enter: a new line. Click elsewhere to move the text.</div>`),
      );
      const body = panel.body, err = body.querySelector<HTMLElement>(".tp-error")!;
      const update = () => {
        const v = (k: string) => body.querySelector<HTMLInputElement>(`[data-k="${k}"]`)!.value;
        const num = (k: string, d: number) => (Number.isFinite(parseFloat(v(k))) ? parseFloat(v(k)) : d);
        tool.set({ text: v("text"), height: num("height", 0), align: v("align") as TextSettings["align"], letterSpacing: num("letterSpacing", 0), lineSpacing: num("lineSpacing", 1) });
        err.textContent = tool.problem;
      };
      body.addEventListener("input", (e) => {
        if (!(e.target as HTMLElement).closest("[data-k=family], [data-k=font]")) update();
      });
      // A font chosen: loaded (the first time), then the text redrawn in it; one that can't be used: back to the one before
      const famSel = body.querySelector<HTMLSelectElement>("[data-k=family]")!, styleSel = body.querySelector<HTMLSelectElement>("[data-k=font]")!;
      const setFont = async (file: string) => {
        const before = TextTool.settings.font ?? "";
        err.textContent = "Loading the font…";
        if (await useFont(file)) {
          tool.set({ font: file });
          if (!edit) localStorage.setItem(TEXT_FONT_KEY, file);
          err.textContent = tool.problem;
        } else {
          famSel.value = familyOf(before) ?? BUILT_IN_FAMILY(BUILT_IN_FONTS[0].family);
          styleSel.innerHTML = styleOpts(famSel.value);
          styleSel.value = before;
          err.textContent = "This font can't be used for text (opentype.js can't read it) — choose another";
        }
      };
      famSel.addEventListener("change", () => {
        styleSel.innerHTML = opts(families.get(famSel.value)!.map((x) => [x.file, x.style]), "");
        void setFont(styleSel.value);
      });
      styleSel.addEventListener("change", () => void setFont(styleSel.value));
      body.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          tool.create();
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.endTool();
        }
      });
      const text = body.querySelector<HTMLTextAreaElement>("textarea")!;
      text.focus();
      text.select();
      update();
    }, (faces, s) => {
      const record: TextRecord = { text: s.text, font: s.font ?? "", height: s.height, align: s.align, letterSpacing: s.letterSpacing ?? 0, lineSpacing: s.lineSpacing, frame: tool.placement() };
      // Named after its words: Text "I love you", longer ones cut short (Text "I love my cat a…")
      const words = s.text.trim().replace(/\s+/g, " ");
      const named = `Text "${words.length > TEXT_NAME_MAX ? words.slice(0, TEXT_NAME_MAX - 1).trimEnd() + "…" : words}"`;
      if (edit && place) {
        // The new letters replace the old ones where they were (in the list too); pushed ones pushed as far again
        let shapes: Shape[];
        try {
          shapes = textLetters({ ...record }, place.push, !tool.moved && place.flip);
        } catch (e) {
          return this.fail(e);
        }
        this.endTool();
        const old = new Set(edit.letters.map((b) => b.id)), oldGroup = edit.letters[0].group;
        // (the group is renamed after the new words — unless it was given a name of its own, or holds other things too)
        const ownName = oldGroup !== undefined && (!oldGroup.startsWith('Text "') || this.doc.bodies.some((b) => b.group === oldGroup && !old.has(b.id)));
        const group = ownName ? oldGroup : oldGroup === undefined ? undefined : named === oldGroup.replace(/ \d+$/, "") ? oldGroup : this.uniqueGroupName(named);
        const made = shapes.map((sh) => ({ ...this.doc.makeBody(sh, "Text", place!.push === null ? "face" : "solid"), ...(group ? { group } : {}), text: record }));
        const at = this.doc.bodies.findIndex((b) => old.has(b.id));
        const rest = this.doc.bodies.filter((b) => !old.has(b.id));
        this.doc.commit([...rest.slice(0, at), ...made, ...rest.slice(at)], "Edit text");
        this.setMode("body");
        this.setSelection(made.map((m) => ({ kind: "body", body: m.id, id: 0 })));
        this.toast(`Text changed${group ? ` — ${group}` : ""}`);
        return;
      }
      this.endTool();
      const group = this.uniqueGroupName(named);
      const made = faces.map((f) => ({ ...this.doc.makeBody(f, "Text", "face"), group, text: record }));
      this.doc.commit([...this.doc.bodies, ...made], "Create text");
      this.setMode("body");
      this.setSelection(made.map((m) => ({ kind: "body", body: m.id, id: 0 })));
      this.toast(`${group}: ${made.length} face${made.length > 1 ? "s" : ""} — press P to push/pull them · the pencil by it in the Bodies panel edits it`);
    });
    const dispose = tool.dispose.bind(tool);
    tool.dispose = () => {
      dispose();
      panel?.remove();
      if (edit) {
        this.viewport.clearGhost();
        TextTool.settings = forNew;
      }
    };
    this.startTool(tool.start());
    if (edit && place) {
      // (its letters hidden while it's being edited: the preview shows the new ones)
      this.viewport.showGhost(new Map(), edit.letters.map((b) => b.id));
      tool.placeAt(place.frame);
    }
  }

  /**
   * Sketch (K) on the selected flat face (or flat face object) — a curved face: on the plane touching
   * it under the cursor (or at its middle) — or, with nothing like that selected, on the ground. Done adds the closed outlines as flat faces.
   */
  private startSketch(): void {
    // Face objects / paths selected (whole objects): edit them in the sketch.
    const objs = this.selection.map((x) => (x.kind === "body" ? this.doc.get(x.body) : undefined));
    if (objs.length && objs.every((b) => b?.kind === "face" || b?.kind === "path")) return this.editInSketch([...new Set(objs as Body[])]);
    let frame = { origin: new THREE.Vector3(), x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
    let center = new THREE.Vector3(), what = "the ground";
    const s = this.selection.length === 1 ? this.selection[0] : null;
    const b = s ? this.doc.get(s.body) : undefined;
    const faceId = s?.kind === "face" ? s.id : s?.kind === "body" && b?.kind === "face" ? b.shape.faces[0].hashCode : null;
    let curved = false;
    if (b && faceId !== null) {
      if (!isBrep(b)) return this.toast("Sketch: select a flat face — or nothing, to sketch on the ground", "error");
      let f = planarFaceFrame(b.shape, faceId), at: V3 | undefined;
      if (!f) {
        // A curved face: the flat plane touching it where the cursor is on it (else at its middle).
        const hit = this.viewport.pick(this.pointer.x, this.pointer.y, "face");
        const t = tangentFaceFrame(b.shape, faceId, hit && hit.body === b.id && hit.id === faceId ? (hit.point.toArray() as V3) : undefined);
        if (!t) return this.toast("Sketch: select a flat face — or nothing, to sketch on the ground", "error");
        ({ frame: f, at } = t);
        curved = true;
      }
      const v = (t: V3) => new THREE.Vector3(...t);
      frame = { origin: v(f.origin), x: v(f.x), y: v(f.y), z: v(f.z) };
      // A side face's frame has x up the wall: turn it a quarter so y is up (the view stays upright, width runs along)
      if (Math.abs(frame.z.z) <= 0.9) frame = { ...frame, x: frame.y.clone().negate(), y: frame.x };
      center = v(at ?? faceAxis(b.shape, faceId)?.center ?? f.origin);
      what = b.kind === "face" ? `"${b.name}"` : `a ${curved ? "curved " : ""}face of "${b.name}"`;
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
    if (curved) this.toast("Curved face: the sketch is on the flat plane touching it at that point — what you draw stays flat, it doesn't follow the curve");
  }

  /**
   * K with face objects / paths selected: the sketch opens on their plane with them in it, to edit
   * (however they were moved / rotated since). Done replaces them (one undo step); Cancel keeps them.
   */
  private editInSketch(bodies: Body[]): void {
    const names = bodies.map((b) => `"${b.name}"`).join(", ");
    // Points along every edge: the plane they share, and the middle to look at.
    const pts: THREE.Vector3[] = [];
    for (const b of bodies) for (const e of (b.shape as Shape | Wire).edges) for (const t of [0, 0.25, 0.5, 0.75, 1]) pts.push(new THREE.Vector3(...(e.pointAt(t).toTuple() as V3)));
    const box = new THREE.Box3().setFromPoints(pts), size = box.getSize(new THREE.Vector3()).length();
    const tol = 1e-6 * Math.max(1, size);
    const v = (t: V3) => new THREE.Vector3(...t);
    let frame: SketchFrame | null = null;
    const face = bodies.find((b) => b.kind === "face") as ShapeBody | undefined;
    if (face) {
      const f = planarFaceFrame(face.shape, face.shape.faces[0].hashCode);
      if (!f) return this.toast(`Sketch: "${face.name}" isn't flat — it can't be edited in the sketch`, "error");
      frame = { origin: v(f.origin), x: v(f.x), y: v(f.y), z: v(f.z) };
      // A side face's frame has x up the wall: turned a quarter so y is up (as K on a side face)
      if (Math.abs(frame.z.z) <= 0.9) frame = { ...frame, x: frame.y.clone().negate(), y: frame.x };
    } else {
      // Paths only: the plane they lie in — flat ones: level at their height; one straight line: the upright plane through it.
      const p0 = pts[0], far = pts.reduce((a, p) => (p.distanceTo(p0) > a.distanceTo(p0) ? p : a), p0);
      const u = far.clone().sub(p0).normalize();
      const off = pts.reduce((a, p) => { const d = p.clone().sub(p0); d.addScaledVector(u, -d.dot(u)); return d.length() > a.length() ? d : a; }, new THREE.Vector3());
      const level = pts.every((p) => Math.abs(p.z - p0.z) < tol);
      const z = level ? new THREE.Vector3(0, 0, 1) : off.length() > tol ? u.clone().cross(off).normalize() : Math.abs(u.z) < 0.999 ? u.clone().cross(new THREE.Vector3(0, 0, 1)).normalize() : new THREE.Vector3(0, -1, 0);
      if (z.z < -1e-9 || (Math.abs(z.z) < 1e-9 && z.y > 1e-9)) z.negate(); // (facing up / toward the front)
      const x = Math.abs(z.z) > 0.999 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1).cross(z).normalize();
      frame = { origin: level ? new THREE.Vector3(0, 0, p0.z) : p0.clone(), x, y: z.clone().cross(x), z };
    }
    const fz = frame.z, fo = frame.origin;
    if (pts.some((p) => Math.abs(p.clone().sub(fo).dot(fz)) > tol * 10)) {
      return this.toast(`Sketch: ${names} aren't on one flat plane — select ones that lie on the same plane`, "error");
    }
    const loops: SketchLoop[] = [], opens: SketchSeg[][] = [];
    try {
      for (const b of bodies) {
        const got = sketchOfShape(b.shape as Shape | Wire, b.name);
        loops.push(...got.loops);
        opens.push(...got.opens);
      }
    } catch (e) {
      return this.toast(errorMessage(e), "error");
    }
    const ids = new Set(bodies.map((b) => b.id));
    const group = bodies.every((b) => b.group && b.group === bodies[0].group) ? bodies[0].group : undefined;
    this.endInteractions();
    this.setSelection([]);
    const tool = new SketchTool(this, frame, box.getCenter(new THREE.Vector3()), names, (faces, paths) => {
      this.endTool();
      const made = [...faces.map((f) => this.doc.makeBody(f, "Sketch", "face")), ...paths.map((w) => this.doc.makeBody(w, "Path", "path"))].map((m) => (group ? { ...m, group } : m));
      this.doc.commit([...this.doc.bodies.filter((b) => !ids.has(b.id)), ...made], "Edit in sketch");
      this.setMode("body");
      this.setSelection(made.map((m) => ({ kind: "body", body: m.id, id: 0 })));
      const n = (k: number, what: string) => (k ? `${k} ${what}${k > 1 ? "s" : ""}` : "");
      this.toast(made.length ? `${names} replaced by ${[n(faces.length, "face"), n(paths.length, "path")].filter(Boolean).join(" and ")} from the sketch` : `${names} removed — the sketch was left empty`);
    }, () => {
      this.endTool();
      this.toast(`Sketch cancelled — ${names} unchanged`);
    });
    this.startTool(tool.load(loops, opens).start());
  }

  /** Guide line tool; with an edge given (edge + Shift+D) it starts from that edge. */
  private startGuide(bodyId?: number, edgeId?: number): void {
    if (bodyId !== undefined && edgeId !== undefined && !this.edgeSides(bodyId, edgeId)) {
      return this.toast("Guide line: the edge must be straight and next to a flat face", "error");
    }
    this.endInteractions();
    const tool = new GuideTool(this, (bid, eid) => this.edgeSides(bid, eid), (lines) => {
      this.endTool();
      // Fix each guide's cut direction now: the face it lies on, or the view it was drawn in.
      const view = this.viewDir();
      const shapes = this.doc.bodies.map((b) => b.shape).filter(notMesh);
      // More than 4 at once: one group, listed in the Bodies panel (select / hide / delete them together).
      let group: string | undefined;
      if (lines.length > GUIDE_GROUP_MIN) {
        const taken = new Set(this.doc.guides.map((g) => g.group));
        for (let k = 1; !group; k++) if (!taken.has(`Guides ${k}`)) group = `Guides ${k}`;
      }
      const made = lines.map((l) => ({ ...l, n: guidePlaneNormal(shapes, l.a, l.b, view), ...(group ? { group } : {}) }));
      this.doc.setGuides([...this.doc.guides, ...made], lines.length > 1 ? `Add ${lines.length} guides` : "Add guide");
      this.toast(`Added ${lines.length} guide line(s)${group ? ` as "${group}" in the Bodies panel` : ""} — ${this.viewport.autoSnap ? "tools snap to them" : "hold Ctrl to snap to them"}`);
    }, (st) => (st ? showPanel(st) : panel.remove()));
    this.startTool(tool);
    const panel = this.toolPanel("Guide line", { label: "Cancel" }, () => this.endTool());
    let shown = "";
    const showPanel = (st: GuideState) => {
      // (Pro layout: just what it starts from and the distance — no instructions)
      const pro = isPro();
      const tip = {
        start: "Click an edge or an X / Y / Z axis for a parallel guide — or a point (corner / midpoint / centre; in Top / Front / Right view anywhere) to draw a guide through two points.",
        second: "Click the second point — near an X / Y / Z direction it locks on.",
        offset: "Move across, type a distance or Tab for distance / % / count — Enter or a click adds.",
      }[st.step];
      const html =
        `<div>From: ${st.from ? `<b>${escapeHtml(st.from)}</b>` : pro ? "—" : "<i>click an edge, axis or point</i>"}</div>` +
        (st.step === "offset" ? `<div>Distance: <b>${fmt(st.dist)} mm${st.count > 1 ? ` ×${st.count}` : ""}</b></div>` : "") +
        (pro ? "" : `<div class="tp-tip">${tip}</div><div class="tp-tip">Cancel or Esc exits.</div>`);
      if (html !== shown) panel.set((shown = html));
    };
    tool.start(bodyId, edgeId);
  }

  /**
   * Dots on the selection to click: the one selected flat face's centre (see pointCenter; G pulls the face to a
   * point), the selected solid's sharp tips (see solidTips; F rounds one).
   */
  private dots: { body: number; at: V3; face?: number; tip?: Tip }[] = [];
  /** The clicked dot (dots[selDot]; the face / solid itself isn't selected then), -1: none. */
  private selDot = -1;
  private hoverDot = -1;

  /** Work out the dots for the selection (kept while one is selected) and show them (not while an op panel is open). */
  private updateDots(): void {
    if (this.selDot < 0) {
      this.dots = [];
      const s = this.selection.length === 1 ? this.selection[0] : null;
      const b = s && this.doc.get(s.body);
      if (s && b && isBrep(b) && (b.kind === "solid" || b.kind === "face")) {
        try {
          const faceId = s.kind === "face" ? s.id : s.kind === "body" && b.kind === "face" ? b.shape.faces[0]?.hashCode : undefined;
          const p = faceId !== undefined ? pointCenter(b.shape, faceId) : null;
          if (p) this.dots.push({ body: b.id, face: faceId!, at: p.center });
          if (b.kind === "solid" && s.kind !== "edge") for (const tip of solidTips(b.shape)) this.dots.push({ body: b.id, tip, at: tip.at });
        } catch (err) {
          console.warn("dots:", err); // (a shape already freed, e.g. mid-replace: no dots)
          this.dots = [];
        }
      }
    }
    if (this.hoverDot >= this.dots.length) this.hoverDot = -1;
    const look = (i: number) => (i === this.selDot ? "selected" : i === this.hoverDot ? "hover" : "shown");
    this.viewport.showDots(this.op ? [] : this.dots.map((d, i) => ({ p: new THREE.Vector3(...d.at), look: look(i) })));
  }

  /** The dot under the pointer (index into dots), -1: none. */
  private dotAt(e: { clientX: number; clientY: number }): number {
    let best = -1, bd = 10;
    this.dots.forEach((d, i) => {
      const p = new THREE.Vector3(...d.at), s = this.viewport.toScreen(p), dist = Math.hypot(e.clientX - s.x, e.clientY - s.y);
      if (this.viewport.inView(p, 0) && dist < bd) [best, bd] = [i, dist];
    });
    return best;
  }

  private dropDot(): void {
    this.selDot = -1;
    this.updateDots();
  }

  /** G on a flat face's centre dot: the face becomes a cone (a circle) or a pyramid, its tip that far out — or a flat top. */
  private opPullToPoint(): void {
    const dot = this.dots[this.selDot];
    if (dot.face === undefined) return this.toast("G on a tip: nothing to move — F rounds it (G pulls a face's centre dot)", "error");
    const body = this.shapeBody(dot.body, "Pull to a point");
    const p = body && pointCenter(body.shape, dot.face);
    if (!body || !p) return this.dropDot();
    const faceId = dot.face;
    const size = p.circle ?? Math.max(...p.corners!.map((c) => Math.hypot(c[0] - p.center[0], c[1] - p.center[1], c[2] - p.center[2])));
    // (Top size in mm: the circle's radius / diameter, as set — else the longest side)
    const side = p.circle ? circleSize.shown(p.circle) : Math.max(...p.corners!.map((c, i, all) => Math.hypot(...[0, 1, 2].map((k) => all[(i + 1) % all.length][k] - c[k]))));
    const isFace = body.kind === "face";
    this.startOp({
      title: `Pull to a point → ${p.circle ? "cone" : "pyramid"}`,
      label: "Pull to a point",
      note: `Top size: 0 a point · a % or mm (${p.circle ? `its ${circleSize.word}` : "its longest side"}, ${fmt(side)} mm now) a flat top — over 100% it widens${isFace ? "" : " · out of the solid: added to it · into it (a minus height): cut out of it"}`,
      fields: [
        { key: "h", label: "Height (mm)", value: +Math.max(1, Math.round(size)).toFixed(0), step: 1 },
        { key: "top", label: "Top size (% or mm)", value: 0, step: 10, min: 0, mm: side },
      ],
      compute: ({ h, top }) => {
        const piece = pullToPoint(body.shape, faceId, h, top / 100);
        if (isFace) {
          const name = p.circle ? "Cone" : top > 0 ? "Block" : "Pyramid";
          return {
            ghost: new Map([[body.id, piece]]),
            commit: () => {
              const nb = extrudedFrom(this.doc.makeBody(piece, name), body);
              this.doc.commit(this.doc.bodies.map((b) => (b.id === body.id ? nb : b)), "Pull to a point");
              return { select: [nb.id], solidMode: true };
            },
          };
        }
        const result = booleanOp(h > 0 ? "union" : "subtract", this.solidOf(body.id, "Pull to a point"), [piece]);
        return { ghost: new Map([[body.id, result]]), commit: () => this.replaceOutcome(new Map([[body.id, result]]), "Pull to a point").commit() };
      },
      drag: { origin: p.center, dir: p.normal, key: "h" },
    });
    this.updateDots(); // (hidden while the panel is open; back with the selection when it closes)
  }

  /** F on a tip's dot: round the point with a ball of that radius (a cone's: smoothly; a pyramid's: smooth along its edges). */
  private opRoundTip(): void {
    const dot = this.dots[this.selDot];
    if (!dot.tip) return this.toast("F on a face's centre dot: nothing to round — G pulls it to a point (F rounds a tip)", "error");
    const body = this.shapeBody(dot.body, "Round tip");
    if (!body) return this.dropDot();
    const tip = dot.tip, max = tipRadiusMax(tip);
    const value = max > 2 ? 1 : +(max / 2).toPrecision(2);
    this.startOp({
      title: "Round tip",
      label: "Round tip",
      note: `${tip.cone ? "A cone's point: the ball blends into its side" : "A pointed corner: the ball blends into its edges"} · under ${fmt(max)} mm`,
      fields: [{ key: "r", label: "Radius (mm)", value, step: value < 1 ? 0.1 : 0.5, min: 0 }],
      compute: ({ r }) => {
        const result = roundTip(this.solidOf(body.id, "Round tip"), tip, r);
        return { ghost: new Map([[body.id, result]]), commit: () => this.replaceOutcome(new Map([[body.id, result]]), "Round tip").commit() };
      },
    });
    this.updateDots();
  }

  private selGuide = -1;
  private hoverGuide = -1;
  /** A guide group selected in the Bodies panel (all its lines lit; Del removes them), and the groups hidden there (eye). */
  private selGuideGroup: string | null = null;
  private hiddenGuideGroups = new Set<string>();
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
    const inGroups = (names: { has(g: string): boolean }) => new Set(this.doc.guides.flatMap((g, i) => (g.group !== undefined && names.has(g.group) ? [i] : [])));
    if (this.selGuideGroup !== null && !this.doc.guides.some((g) => g.group === this.selGuideGroup)) this.selGuideGroup = null;
    const sel = this.selGuideGroup !== null ? inGroups(new Set([this.selGuideGroup])) : this.selGuide;
    this.viewport.setGuides(this.doc.guides, sel, this.hoverGuide, inGroups(this.hiddenGuideGroups));
  }

  /** Drop the Bodies panel's guide group selection (another click took over). */
  private clearGuideGroup(): void {
    if (this.selGuideGroup === null) return;
    this.selGuideGroup = null;
    this.showGuides();
    this.renderOutliner();
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
        (p, frame) => {
          this.endTool();
          this.setSelection(ids.map((id) => ({ kind: "body", body: id, id: 0 })));
          this.startTransform("translate", false, [...p] as V3, frame);
          if (!frame) this.hint(`Move: drag the gizmo from the picked mark (${this.viewport.snapTip("grid / points")}) · Tab: exact values · Enter/Esc: done`);
        },
        (e) => this.slideEdgeAt(e)).start(),
    );
  }

  /**
   * G / G G: the edge under the cursor to slide along, and the turned axes for the move gizmo (Z the
   * way to slide). A round edge (circle / arc, any solid): Z along its axis (the way facing the eye),
   * X to its centre. A slanted straight edge: Z along the edge (an edge along X / Y / Z: none — the
   * plain gizmo slides that way already).
   */
  private slideEdgeAt(e: PointerEvent): { point: V3; frame: GizmoFrame } | null {
    const hit = this.viewport.pick(e.clientX, e.clientY, "edge");
    const b = hit?.kind === "edge" ? this.doc.get(hit.body) : null;
    if (!hit || !b || !isBrep(b)) return null;
    const line = lineOfEdge(b.shape, hit.id);
    if (line) {
      const A = new THREE.Vector3(...line[0]), z = new THREE.Vector3(...line[1]).sub(A);
      if (z.lengthSq() < 1e-12) return null;
      z.normalize();
      const big = Math.max(...z.toArray().map(Math.abs));
      if (big > 1 - 1e-6) return null; // (along X / Y / Z)
      if (z.toArray().find((n) => Math.abs(n) === big)! < 0) z.negate(); // (its main way positive)
      const point = A.clone().addScaledVector(z, hit.point.clone().sub(A).dot(z));
      // X across the screen, Y towards the eye
      const eye = this.viewport.camera.position.clone().sub(point);
      const x = z.clone().cross(eye);
      if (x.lengthSq() < 1e-12) x.copy(Math.abs(z.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)).cross(z);
      x.normalize();
      const y = z.clone().cross(x);
      return { point: point.toArray() as V3, frame: { x: x.toArray() as V3, y: y.toArray() as V3, z: z.toArray() as V3, toAxis: 0 } };
    }
    const c = circleOfEdge(b.shape, hit.id);
    if (!c) return null;
    const C = new THREE.Vector3(...c.center), z = new THREE.Vector3(...c.normal);
    const out = hit.point.clone().sub(C);
    out.addScaledVector(z, -out.dot(z)); // (into the circle's plane)
    if (out.lengthSq() < 1e-12) return null;
    out.normalize();
    if (z.dot(this.viewport.camera.position.clone().sub(C)) < 0) z.negate();
    const x = out.clone().negate(), y = z.clone().cross(x);
    const point = C.clone().addScaledVector(out, c.r);
    return { point: point.toArray() as V3, frame: { x: x.toArray() as V3, y: y.toArray() as V3, z: z.toArray() as V3, toAxis: c.r } };
  }

  /**
   * Copies just made by Shift+D: moving them in that same gizmo session is part of the Duplicate
   * undo step (so Undo removes the copy, not just its move, which would leave it hidden in place).
   */
  private placing: { ids: string; version: number } | null = null;

  /** Commit gizmo / Tab moves of the transformed bodies (folded into Duplicate while placing a copy). */
  private commitTransform(shapes: Map<number, Geom>, label: string): void {
    this.carrySelection(shapes);
    const p = this.placing;
    if (p && this.xf && p.ids === this.xf.ids.join() && p.version === this.doc.version) {
      this.doc.amend(this.doc.bodies.map((b) => (shapes.has(b.id) ? withShape(b, shapes.get(b.id)!) : b)));
      p.version = this.doc.version;
    } else {
      this.doc.replaceShapes(shapes, label);
    }
  }

  /**
   * Selected faces / edges of bodies about to be moved: their ids in the moved shapes (new shapes
   * have new ids — otherwise the selection, and with it the gizmo's next start, would be dropped).
   */
  private carrySelection(shapes: Map<number, Geom>): void {
    this.selection = this.selection.map((s) => {
      const b = this.doc.get(s.body), to = shapes.get(s.body);
      if (s.kind === "body" || !b || !to) return s;
      const ids = movedIds(b.shape, to);
      const id = ids && (s.kind === "face" ? ids.faces : ids.edges).get(s.id);
      return id === undefined || id === null ? s : { ...s, id };
    });
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

  /** Keep an explicit gizmo pivot (from G G) on the moved bodies. */
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
      this.carrySelection(shapes);
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
    // A turned gizmo (a round / slanted edge): typed along its axes — Z along the circle's axis / the edge.
    const frame = this.xf.frame;
    const world = (n: number[]): V3 => (frame ? [0, 1, 2].map((k) => frame.x[k] * n[0] + frame.y[k] * n[1] + frame.z[k] * n[2]) : [n[0], n[1], n[2]]) as V3;
    const moveFields = (v: V3) => frame
      ? [{ label: "Along the axis (mm)", value: r3(v[2]) }, { label: frame.toAxis ? "Off the axis: X (to centre)" : "Off the axis: X", value: r3(v[0]), more: true }, { label: "Off the axis: Y (across)", value: r3(v[1]), more: true }]
      : [{ label: "ΔX", value: r3(v[0]) }, { label: "ΔY", value: r3(v[1]) }, { label: "ΔZ", value: r3(v[2]) }];
    // (the dialog's order back to X, Y, Z)
    const typed = (n: number[]): number[] => (frame ? [n[1], n[2], n[0]] : n);
    if (last?.type === "translate" && mode === "translate") {
      const v = last.vector;
      const shown = this.viewport.toGizmoAxes(v);
      this.propsDialog(frame ? "Slide along the axis (last drag)" : "Move (last drag)", moveFields(shown), (raw) => {
        const n = world(typed(raw));
        const d: V3 = [n[0] - v[0], n[1] - v[1], n[2] - v[2]];
        if (d.some((x) => Math.abs(x) > 1e-9)) apply((s) => translateShape(s, d), "Move", { type: "translate", vector: d });
        this.lastXf = { r: { type: "translate", vector: [n[0], n[1], n[2]] }, ids: ids.join() };
      }, "Move");
      return;
    }
    if (mode === "translate") {
      this.propsDialog(frame ? "Slide along the axis by" : "Move by", moveFields([0, 0, 0]), (raw) => {
        const [x, y, z] = world(typed(raw));
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
    this.viewport.showSnapMarker(null); // (a round / slanted edge's mark, see processHover)
    this.refreshSelection();
  }

  // ================================================================ edit

  private undoRedo(which: "undo" | "redo"): void {
    this.endInteractions();
    // Going back to solids no longer on screen means drawing them again (e.g. 17 sweeps a Subtract
    // used up: ~1.5 s): behind the busy dialog when that will take a while.
    const step = this.doc.peek(which);
    const slow = !!step && this.viewport.drawCost(step.bodies.map((b) => b.shape)) > BUSY_DRAW_MS;
    this.runBusy(slow, `${which === "undo" ? "Undoing" : "Redoing"} ${step?.label ?? ""}…`, () => {
      const label = which === "undo" ? this.doc.undo() : this.doc.redo();
      if (label) this.toast(`${which === "undo" ? "Undo" : "Redo"}: ${label}`);
    });
  }

  private deleteSelected(): void {
    this.endInteractions();
    if (this.selDim >= 0) {
      const i = this.selDim;
      this.selDim = -1;
      return this.doc.setDimensions(this.doc.dimensions.filter((_, k) => k !== i), "Delete dimension");
    }
    if (this.selGuideGroup !== null) {
      const g = this.selGuideGroup, n = this.doc.guides.filter((x) => x.group === g).length;
      this.selGuideGroup = null;
      this.doc.setGuides(this.doc.guides.filter((x) => x.group !== g), `Delete ${g}`);
      return this.toast(`Deleted ${n} guide lines — Ctrl+Z brings them back`);
    }
    if (this.selGuide >= 0) {
      const i = this.selGuide;
      this.selGuide = -1;
      return this.doc.setGuides(this.doc.guides.filter((_, k) => k !== i), "Delete guide");
    }
    // Rims of round holes / pins (Edge mode): fill the holes, take off the pins.
    const rims = this.selectedRims();
    if (rims) return this.deleteRounds(rims);
    const holes = this.selectedHoles();
    if (holes) return this.deleteHoles(holes);
    const ids = new Set(this.selection.filter((s) => s.kind === "body").map((s) => s.body));
    if (!ids.size) {
      this.toast("Delete: select objects (Solid mode, key 1) — or the rims of round holes / pins (Edge mode) to fill them", "error");
      return;
    }
    this.doc.commit(this.doc.bodies.filter((b) => !ids.has(b.id)), ids.size > 1 ? `Delete ${ids.size} objects` : "Delete");
    this.setSelection([]);
  }

  /** Delete with hole / pin rims selected: the holes filled, the pins taken off (one undo step); the solids are selected. */
  private deleteRounds(rims: { body: number; rim: RoundRim }[]): void {
    const perBody = new Map<number, RoundRim[]>();
    for (const { body, rim } of rims) perBody.set(body, [...(perBody.get(body) ?? []), rim]);
    const holes = rims.filter((r) => r.rim.kind === "hole").length, pins = rims.length - holes;
    const many = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
    const label = [holes ? `Fill ${many(holes, "hole")}` : "", pins ? `Remove ${many(pins, "pin")}` : ""].filter(Boolean).join(", ");
    let shapes: Map<number, Shape>;
    try {
      shapes = new Map([...perBody].map(([id, rs]) => [id, fillRounds(this.solidOf(id, "Delete"), rs)]));
    } catch (e) {
      return this.toast(errorMessage(e), "error");
    }
    this.doc.replaceShapes(shapes, label);
    this.setMode("body");
    this.setSelection([...shapes.keys()].map((id) => ({ kind: "body", body: id, id: 0 })));
    this.toast(`${label} — Ctrl+Z brings ${rims.length === 1 ? "it" : "them"} back`);
  }

  /**
   * Copies of `ids`: the groups selected whole (every member in `ids`) → the new group their copies
   * go in ("Bracket 1" → "Bracket 2"); copies of the rest of a group's members aren't grouped.
   */
  private copyGroupNames(ids: number[]): Map<string, string> {
    const idSet = new Set(ids);
    const whole = [...new Set(ids.map((id) => this.doc.get(id)!.group))].filter(
      (g): g is string => !!g && this.doc.bodies.every((b) => b.group !== g || idSet.has(b.id)));
    const newGroup = new Map<string, string>();
    const taken = new Set(this.doc.bodies.map((b) => b.group));
    for (const g of whole) {
      const base = g.replace(/\s+\d+$/, "") || "Group";
      let n = 1;
      while (taken.has(`${base} ${n}`)) n++;
      taken.add(`${base} ${n}`);
      newGroup.set(g, `${base} ${n}`);
    }
    return newGroup;
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
      return withTextOf(this.doc.makeBody(cloneShape(b.shape), b.name.replace(/\s+\d+$/, ""), b.kind), b);
    });
    // A whole group selected: its copies are a new group of their own ("Circular 1" → "Circular 2"), and
    // an array / circular copy's record goes with them (the copy can be changed from its icon too).
    const copyOf = new Map(ids.map((id, i) => [id, copies[i].id]));
    const newGroup = this.copyGroupNames(ids), whole = [...newGroup.keys()];
    const grouped = copies.map((c, i) => {
      const g = newGroup.get(this.doc.get(ids[i])!.group ?? "");
      return g ? { ...c, group: g } : c;
    });
    const records = this.doc.arrays.flatMap((r) => {
      const g = newGroup.get(r.group);
      if (!g || ![...r.sources, ...r.copies].every((id) => copyOf.has(id))) return [];
      return [{ ...r, group: g, sources: r.sources.map((id) => copyOf.get(id)!), copies: r.copies.map((id) => copyOf.get(id)!) }];
    });
    this.doc.commit([...this.doc.bodies, ...grouped], whole.length ? `Duplicate ${whole.join(", ")}` : "Duplicate", this.doc.guides, this.doc.dimensions, [...this.doc.arrays, ...records]);
    if (whole.length) this.toast(`Copied as ${[...newGroup.values()].join(", ")} — move it into place`);
    this.setMode("body");
    this.setSelection(copies.map((b) => ({ kind: "body", body: b.id, id: 0 })));
    this.startTransform("translate");
    this.placing = this.xf ? { ids: this.xf.ids.join(), version: this.doc.version } : null;
    this.repeatCopyIds = copies.map((b) => b.id).join();
  }

  /**
   * Circular copy (corner button by Revolve): `n` objects round an axis — the original counts — in one
   * undo step. The axis: the X / Y / Z axis line (through the origin), a guide line, or a circle /
   * arc edge (its centre axis), picked from the list or clicked in the view. A total angle of 360°
   * spreads them evenly all round; less puts the first and last at its two ends. "Turn copies" off:
   * the copies only move round (they keep facing the same way).
   */
  private circularCopy(rec: ArrayRecord | null = null): void {
    const edit = rec?.circular ? rec : null;
    const ids = edit ? [...edit.sources] : this.selectedBodyIds();
    if (!ids.length) return this.toast("Circular copy: select objects first (Solid mode, key 1)", "error");
    const along = (a: V3, b: V3): Axis => ({ origin: a, dir: [b[0] - a[0], b[1] - a[1], b[2] - a[2]] });
    const axes: { name: string; axis: Axis | null; guide?: number }[] = [
      ...["X", "Y", "Z"].map((n, k) => ({ name: `${n} axis`, axis: { origin: [0, 0, 0] as V3, dir: [0, 1, 2].map((j) => (j === k ? 1 : 0)) as V3 } })),
      ...this.doc.guides.map((g, i) => ({ name: `Guide line ${i + 1}`, axis: along(g.a, g.b), guide: i })),
      { name: "Circle edge (click one)", axis: null },
    ];
    const CIRCLE = axes.length - 1;
    // Changing a circular copy: its own axis first choice (moved with the group if it was moved).
    if (edit) {
      const c = edit.circular!, d = this.circularShift(edit) ?? [0, 0, 0];
      axes.push({ name: `As before: ${c.name}`, axis: { origin: [0, 1, 2].map((k) => c.axis.origin[k] + d[k]) as V3, dir: [...c.axis.dir] as V3 } });
    }
    /** The clicked circle edge: its centre axis. */
    let circle: { axis: Axis; body: number; edge: number } | null = null;
    /** What a click at `e` picks: a circle / arc edge, a guide line or a world axis line. */
    const axisAt = (e: PointerEvent): { i: number; circle?: { axis: Axis; body: number; edge: number }; at?: THREE.Vector3 } | null => {
      const h = this.viewport.pick(e.clientX, e.clientY, "edge");
      const hb = h && this.doc.get(h.body);
      const c = h && hb && isBrep(hb) ? circleOf(hb.shape, h.id) : null;
      if (c) return { i: CIRCLE, circle: { axis: { origin: c.center, dir: c.normal }, body: h!.body, edge: h!.id }, at: h!.point };
      const g = this.viewport.guideAt(e.clientX, e.clientY);
      if (g >= 0) return { i: 3 + g };
      const w = this.viewport.axisUnder(e.clientX, e.clientY);
      if (w < 0) return null;
      // (the point on that axis line nearest the cursor ray, for its label)
      const ray = this.viewport.ray(e.clientX, e.clientY), dir = new THREE.Vector3().setComponent(w, 1);
      const b = ray.direction.dot(dir), d = ray.direction.dot(ray.origin), f = dir.dot(ray.origin);
      return { i: w, at: dir.multiplyScalar((f - b * d) / (1 - b * b)) };
    };
    const select = () => this.op?.inputs.find((i) => i.dataset.key === "axis");
    const copyName = (b: Body) => b.name.replace(/\s+\d+$/, "");
    this.startOp({
      title: edit ? `Change ${edit.group}` : "Circular copy",
      label: "Circular copy",
      applyLabel: "Done",
      fields: [
        { key: "n", label: "Copies (the original counts)", value: edit?.n ?? 6, step: 1, min: 2 },
        { key: "angle", label: "Total angle (°, 360: all round)", value: edit?.circular!.angle ?? 360, step: 15 },
        { key: "axis", label: "Axis", type: "select", options: axes.map((a) => a.name), value: edit ? axes.length - 1 : 2 },
        { key: "turn", label: "Turn copies (off: they only move round)", value: edit?.circular!.turn ?? 1, type: "checkbox" },
      ],
      hint: "Circular copy: click the X / Y / Z axis line, a guide line or a circle edge to copy round it · copies, total angle · Enter or Done apply · Esc cancel",
      pick: (e) => {
        const t = axisAt(e), sel = select();
        if (!t || !sel) return;
        if (t.circle) circle = t.circle;
        sel.value = String(t.i);
        this.previewOp();
      },
      hover: (e) => {
        const t = axisAt(e);
        this.viewport.setHighlight(this.selection, t?.circle ? { kind: "edge", body: t.circle.body, id: t.circle.edge } : null);
        const shown = axes[Number(select()?.value ?? -1)];
        this.viewport.setGuides(this.doc.guides, shown?.guide ?? -1, t && axes[t.i].guide !== undefined ? axes[t.i].guide! : -1);
        this.hud(t?.at ? (t.circle ? "Circle edge: its centre axis" : axes[t.i].name) : null, t?.at);
        this.viewport.canvas.style.cursor = t ? "pointer" : "crosshair";
      },
      compute: ({ n: count, angle, axis: ai, turn }) => {
        const a = axes[ai];
        this.viewport.setGuides(this.doc.guides, a?.guide ?? -1, -1); // (the guide used as the axis shows selected)
        const ax = ai === CIRCLE ? circle?.axis : a?.axis;
        if (!ax) throw new OpWaiting("Click a circle edge: the copies go round its centre");
        if (!(count >= 2) || count !== Math.round(count)) throw new Error("Copies must be a whole number, 2 or more (the original counts)");
        if (count > 500) throw new Error("At most 500 copies");
        if (!(Math.abs(angle) > 1e-9) || Math.abs(angle) > 360 + 1e-9) throw new Error("Total angle: between −360° and 360°, not 0");
        const len = Math.hypot(...ax.dir);
        if (len < 1e-9) throw new Error("That axis has no direction");
        const u = new THREE.Vector3(...ax.dir).divideScalar(len), o = new THREE.Vector3(...ax.origin);
        const step = Math.abs(Math.abs(angle) - 360) < 1e-9 ? angle / count : angle / (count - 1);
        // The selection's centre: how far round it goes (and, with Turn off, where each copy moves to).
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (const id of ids) {
          const [p, q] = this.doc.get(id)!.shape.boundingBox.bounds;
          for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], q[k]); }
        }
        const c = new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
        const rel = c.clone().sub(o), off = rel.clone().sub(u.clone().multiplyScalar(rel.dot(u))).length();
        if (off < 1e-6 && !turn) throw new Error("The objects sit on the axis: the copies would be on top of each other");
        const place = (shape: Geom, k: number): Geom => {
          const deg = step * k;
          if (turn) return rotateShape(shape, deg, ax.origin, ax.dir);
          const to = rel.clone().applyAxisAngle(u, THREE.MathUtils.degToRad(deg)).add(o).sub(c);
          return translateShape(shape, to.toArray() as V3);
        };
        const ghost = new Map<number, Shape>();
        for (let k = 1; k < count; k++) {
          ids.forEach((id, j) => {
            const b = this.doc.get(id)!;
            if (b.kind === "solid" || b.kind === "face") ghost.set(-(k * ids.length + j), place(b.shape, k) as Shape);
          });
        }
        return {
          ghost,
          // Changing a circular copy: its old copies make way for the new ones.
          hide: edit ? [...edit.copies] : [],
          commit: () => {
            const copies: Body[] = [];
            for (let k = 1; k < count; k++) {
              copies.push(...ids.map((id) => {
                const b = this.doc.get(id)!;
                return withTextOf(this.doc.makeBody(place(cloneShape(b.shape), k), copyName(b), b.kind), b);
              }));
            }
            // The ring is a group: the originals' own group if they share one, else a new "Circular N".
            const idSet = new Set(ids), groups = new Set(ids.map((id) => this.doc.get(id)!.group));
            const group = edit ? edit.group : groups.size === 1 && [...groups][0] ? [...groups][0]! : this.newGroupName("Circular");
            const gone = new Set(edit ? edit.copies : []);
            const bodies = this.doc.bodies.filter((b) => !gone.has(b.id)).map((b) => (idSet.has(b.id) ? { ...b, group } : b));
            const made: ArrayRecord = {
              group, sources: ids, copies: copies.map((b) => b.id), n: count, gap: 0, total: 0, dir: 0, centre: 0, offsets: [],
              circular: {
                axis: { origin: [...ax.origin] as V3, dir: [...ax.dir] as V3 },
                name: ai === CIRCLE ? "Circle edge" : axes[ai].name.replace(/^As before: /, ""),
                angle, turn: turn ? 1 : 0, centre: c.toArray() as V3,
                boxes: ids.map((id) => this.doc.get(id)!.shape.boundingBox.bounds),
              },
            };
            const arrays = [...this.doc.arrays.filter((r) => r !== edit), made];
            this.doc.commit([...bodies, ...copies.map((b) => ({ ...b, group }))], edit ? `Change ${group} ×${count}` : `Circular copy ×${count}`, this.doc.guides, this.doc.dimensions, arrays);
            return {
              select: [...ids, ...copies.map((b) => b.id)],
              solidMode: true,
              then: () => {
                this.repeatOps = [];
                this.repeatCopyIds = "";
                this.toast(edit ? `${group}: now ${count} round` : `${count} round the ${ai === CIRCLE ? "circle's centre" : axes[ai].name} (${count - 1} new) — to change it later: its icon in the Bodies panel`);
              },
            };
          },
        };
      },
    });
  }

  /**
   * Mirror (M): a mirrored copy of the selected objects beyond one side of their box — click a
   * ±X / ±Y / ±Z mark; the mirror plane is that side, so the copy touches the original. Join: each
   * solid and its copy become one where they touch (a half dome on its flat side, −Z: a ball). One
   * undo step; a whole group's copies go in a new group (as Duplicate). To flip: delete the original.
   */
  private mirrorCopy(): void {
    const ids = this.selectedBodyIds();
    if (!ids.length) return this.toast("Mirror: select objects first (Solid mode, key 1)", "error");
    const DIRS = ["+X", "−X", "+Y", "−Y", "+Z", "−Z"];
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const id of ids) {
      const [p, q] = this.doc.get(id)!.shape.boundingBox.bounds;
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], q[k]); }
    }
    const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2) as V3, ext = [0, 1, 2].map((k) => hi[k] - lo[k]);
    /** Side `dir` (index into DIRS): the mirror plane (that side of the box). */
    const plane = (dir: number): { point: V3; normal: V3 } => {
      const axis = dir >> 1, point = [...c] as V3, normal: V3 = [0, 0, 0];
      point[axis] = dir & 1 ? lo[axis] : hi[axis];
      normal[axis] = 1;
      return { point, normal };
    };
    const copyName = (b: Body) => b.name.replace(/\s+\d+$/, "");
    /** Each object's mirror image; with `join`, a solid's is unioned with it (null: they don't touch / the union failed). */
    const results = (dir: number, join: boolean) => {
      const { point, normal } = plane(dir);
      return ids.map((id) => {
        const b = this.doc.get(id)!, image = mirrorShape(b.shape, point, normal);
        let joined: Shape | null = null;
        if (join && b.kind === "solid") {
          try {
            const u = booleanOp("union", b.shape as Solid, [image as Solid]);
            joined = solidPieces(u).length === 1 ? u : null;
          } catch {
            joined = null;
          }
        }
        return { b, image, joined };
      });
    };
    this.startOp({
      title: "Mirror",
      label: "Mirror",
      applyLabel: "Done",
      fields: [
        { key: "dir", label: "Side", type: "select", options: ["— click a mark —", ...DIRS], value: 0 },
        { key: "join", label: "Join (a solid and its copy become one where they touch)", value: 0, type: "checkbox" },
      ],
      hint: "Mirror: click a ±X / ±Y / ±Z mark — the copy appears beyond that side, touching it · Join: one solid · Enter or Done apply · Esc cancel",
      // ±X / ±Y / ±Z marks just outside the objects' sides (axis colours)
      choices: (() => {
        const out = Math.max(...ext) * 0.2 + 4;
        const AXIS_COLORS = ["#d9534f", "#5cb85c", "#4a90e2"]; // (as the world axes)
        return DIRS.map((label, dir) => {
          const axis = dir >> 1, from = plane(dir).point, at = [...from] as V3;
          at[axis] += (dir & 1 ? -1 : 1) * out;
          return { at, from, key: "dir", value: dir + 1, label, color: AXIS_COLORS[axis], title: `Mirror across the ${label} side` };
        });
      })(),
      compute: ({ dir: d, join }) => {
        if (!(d >= 1)) throw new OpWaiting("Click a ±X / ±Y / ±Z mark: the side to mirror across");
        const dir = d - 1, got = results(dir, !!join);
        const ghost = new Map<number, Shape>();
        got.forEach(({ b, image, joined }, j) => {
          if (joined) ghost.set(b.id, joined);
          else if (b.kind === "solid" || b.kind === "face") ghost.set(-(j + 1), image as Shape);
        });
        return {
          ghost,
          commit: () => {
            const groups = this.copyGroupNames(ids);
            const joinedShapes = new Map(got.filter((g) => g.joined).map((g) => [g.b.id, g.joined!]));
            const copies = got.filter((g) => !g.joined).map(({ b, image }) => {
              const m = withTextOf(this.doc.makeBody(image, copyName(b), b.kind), b), g = groups.get(b.group ?? "");
              return g ? { ...m, group: g } : m;
            });
            this.doc.commit([...this.doc.bodies.map((b) => (joinedShapes.has(b.id) ? withShape(b, joinedShapes.get(b.id)!) : b)), ...copies], `Mirror ${DIRS[dir]}`);
            const n = joinedShapes.size, apart = join ? got.filter((g) => !g.joined && g.b.kind === "solid").length : 0;
            return {
              select: [...ids, ...copies.map((b) => b.id)],
              solidMode: true,
              then: () => this.toast(
                `Mirrored across the ${DIRS[dir]} side` +
                  (n ? ` — ${n} joined into one` : "") +
                  (apart ? ` (${apart} not joined: ${apart > 1 ? "they don't" : "it doesn't"} touch its copy)` : "") +
                  (groups.size ? ` · copies in ${[...groups.values()].join(", ")}` : ""),
              ),
            };
          },
        };
      },
    });
  }

  /** Array copy (corner button): a row of copies of the selected objects. */
  /**
   * Array copy: new copies of the selection (an array's group again: a grid). `change` (an array
   * group's icon in the Bodies panel): change that array instead — its copies rebuilt.
   */
  private arrayCopy(change = false): void {
    const ids = this.selectedBodyIds();
    if (!ids.length) return this.toast("Array copy: select objects first (Solid mode, key 1)", "error");
    const rec = this.arrayToChange(ids);
    if (change && typeof rec === "string") return this.toast(rec, "error");
    if (change && !rec) return this.toast("Change the array: select an array's whole group (click its name in the Bodies panel)", "error");
    if (change && rec && typeof rec !== "string" && rec.circular) return this.circularCopy(rec);
    this.opArrayCopy(ids, typeof rec === "string" ? null : rec, change);
  }

  private arrayGroupCache = { version: -1, map: new Map<string, ArrayRecord | string | null>() };

  /** The array group `g` is (see arrayToChange) — cached for the document version (the Bodies panel asks often). */
  private arrayOfGroup(g: string): ArrayRecord | string | null {
    const c = this.arrayGroupCache;
    if (c.version !== this.doc.version) {
      c.version = this.doc.version;
      c.map.clear();
    }
    if (!c.map.has(g)) {
      const ids = this.doc.bodies.filter((b) => b.group === g).map((b) => b.id);
      c.map.set(g, this.doc.arrays.some((r) => r.group === g) && ids.length ? this.arrayToChange(ids) : null);
    }
    return c.map.get(g)!;
  }

  /**
   * The array the selection is — a whole group made by Array copy — if it can still be changed: the
   * group's last array, nothing else in the group, each copy still where the array put it. A string
   * says why not (the selection is an array, but it was changed since).
   */
  private arrayToChange(ids: number[]): ArrayRecord | string | null {
    const group = this.doc.get(ids[0])?.group;
    if (!group || ids.some((id) => this.doc.get(id)?.group !== group)) return null;
    const rec = [...this.doc.arrays].reverse().find((r) => r.group === group);
    if (!rec) return null;
    const members = this.doc.bodies.filter((b) => b.group === group).map((b) => b.id);
    if (members.length !== ids.length) return null; // (part of a group)
    const why = (what: string) => `${group} can't be changed any more (${what}) — ${rec.circular ? "Circular" : "Array"} copy still makes new copies`;
    const made = new Set([...rec.sources, ...rec.copies]);
    if (rec.copies.length !== (rec.n - 1) * rec.sources.length || members.length !== made.size || members.some((id) => !made.has(id))) {
      return why("objects were added to it or taken out");
    }
    if (rec.circular) return this.circularShift(rec) ? rec : why("an object in it was moved or edited on its own");
    if (!this.copiesInPlace(rec)) {
      const S = rec.sources.length, { point } = this.arrayPlacement(rec);
      // (which one, to say so)
      const off = rec.copies.find((id, i) => {
        const p = probePoints(this.doc.get(rec.sources[i % S])!.shape, 1)[0], q = probePoints(this.doc.get(id)!.shape, 1)[0];
        return !p || !q || Math.hypot(...point(p, Math.floor(i / S) + 1).map((x, a) => x - q[a])) > 1e-6;
      });
      return why(`"${this.doc.get(off ?? rec.copies[0])!.name}" was moved or edited on its own`);
    }
    return rec;
  }

  /**
   * Each copy of `rec` still where it puts it (a few corner points of each, against its source's
   * placed there — not bounding boxes, slow on curved shapes), with the same kind and faces.
   */
  private copiesInPlace(rec: ArrayRecord, shift: V3 = [0, 0, 0]): boolean {
    const S = rec.sources.length, { point } = this.arrayPlacement(rec, shift);
    const faces = (b: Body) => (isBrep(b) ? b.shape.faces.length : -1);
    const probes = new Map(rec.sources.map((id) => [id, probePoints(this.doc.get(id)!.shape)]));
    return rec.copies.every((id, i) => {
      const k = Math.floor(i / S) + 1, src = this.doc.get(rec.sources[i % S])!, copy = this.doc.get(id);
      if (!copy || copy.kind !== src.kind || faces(copy) !== faces(src)) return false;
      const ps = probes.get(src.id)!, qs = probePoints(copy.shape);
      if (ps.length !== qs.length) return false;
      return ps.every((p, m) => {
        const want = point(p, k), tol = 1e-6 * (1 + Math.hypot(...want));
        return [0, 1, 2].every((a) => Math.abs(qs[m][a] - want[a]) <= tol);
      });
    });
  }

  /**
   * How far a circular copy's group has moved since it was made (all of it together: its sources'
   * boxes all moved the same, its copies still round the moved axis), or null if one of its objects
   * was moved or edited on its own.
   */
  private circularShift(rec: ArrayRecord): V3 | null {
    const boxes = rec.circular!.boxes;
    if (boxes.length < rec.sources.length) return null;
    const now = rec.sources.map((id) => this.doc.get(id)?.shape.boundingBox.bounds);
    if (now.some((b) => !b)) return null;
    const shift = [0, 1, 2].map((k) => now[0]![0][k] - boxes[0][0][k]) as V3;
    const tol = 1e-6 * (1 + Math.hypot(...boxes[0][1]) + Math.hypot(...shift) + Math.hypot(...rec.circular!.axis.origin));
    const moved = now.some((b, i) => [0, 1].some((e) => [0, 1, 2].some((k) => Math.abs(b![e][k] - boxes[i][e][k] - shift[k]) > tol)));
    return moved || !this.copiesInPlace(rec, shift) ? null : shift;
  }

  /**
   * Where row k (0 = the sources) of an array / circular copy sits relative to the sources: `place`
   * puts a source-shaped object there, `unplace` brings one from there back. `shift`: how far the
   * whole group has moved since it was made (circular: see circularShift).
   */
  private arrayPlacement(rec: ArrayRecord, shift: V3 = [0, 0, 0]): { place: (s: Geom, k: number) => Geom; unplace: (s: Geom, k: number) => Geom; point: (p: V3, k: number) => V3 } {
    const c = rec.circular;
    const plus = (p: V3, d: V3): V3 => [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
    if (!c) {
      const axis = rec.dir >> 1;
      const at = (k: number, sign: number): V3 => [0, 1, 2].map((i) => (i === axis ? sign * (rec.offsets[k] - rec.offsets[0]) : 0)) as V3;
      return { place: (s, k) => (k ? translateShape(s, at(k, 1)) : s), unplace: (s, k) => (k ? translateShape(s, at(k, -1)) : s), point: (p, k) => plus(p, at(k, 1)) };
    }
    const step = Math.abs(Math.abs(c.angle) - 360) < 1e-9 ? c.angle / rec.n : c.angle / (rec.n - 1);
    const origin = [0, 1, 2].map((i) => c.axis.origin[i] + shift[i]) as V3;
    const u = new THREE.Vector3(...c.axis.dir).normalize(), o = new THREE.Vector3(...origin);
    if (c.turn) {
      return {
        place: (s, k) => (k ? rotateShape(s, step * k, origin, c.axis.dir) : s),
        unplace: (s, k) => (k ? rotateShape(s, -step * k, origin, c.axis.dir) : s),
        point: (p, k) => new THREE.Vector3(...p).sub(o).applyAxisAngle(u, THREE.MathUtils.degToRad(step * k)).add(o).toArray() as V3,
      };
    }
    // Not turned: each copy only moved to where the sources' centre went round to.
    const centre = this.circularCentre(rec);
    const rel = new THREE.Vector3(...centre).add(new THREE.Vector3(...shift)).sub(o);
    const to = (k: number, sign: number) => rel.clone().applyAxisAngle(u, THREE.MathUtils.degToRad(step * k)).sub(rel).multiplyScalar(sign).toArray() as V3;
    return { place: (s, k) => (k ? translateShape(s, to(k, 1)) : s), unplace: (s, k) => (k ? translateShape(s, to(k, -1)) : s), point: (p, k) => plus(p, to(k, 1)) };
  }

  /** The sources' centre a circular copy went round from, as it was made (older records: from their boxes). */
  private circularCentre(rec: ArrayRecord): V3 {
    const c = rec.circular!;
    if (c.centre) return c.centre;
    const src = c.boxes.slice(0, rec.sources.length);
    return [0, 1, 2].map((i) => (Math.min(...src.map((b) => b[0][i])) + Math.max(...src.map((b) => b[1][i]))) / 2) as V3;
  }

  /**
   * Linked copies (Doc.linkCopies): in an array / circular copy that can still be changed, one object
   * (a source or any copy) changed shape — filleted, pushed / pulled, scaled, rotated... — and the rest
   * of its column didn't: it becomes the new source, and every copy is made again from it, where it
   * was. A plain Move of one copy only moves that one (it then can't be changed, as before); so does
   * anything once the group is taken apart (Ctrl+Shift+G).
   */
  private linkCopies(prev: readonly Body[], next: readonly Body[], arrays: readonly ArrayRecord[], label: string): { bodies: readonly Body[]; arrays: readonly ArrayRecord[] } | null {
    if (label === "Move") return null;
    const before = new Map(prev.map((b) => [b.id, b])), after = new Map(next.map((b) => [b.id, b]));
    const replaced = new Map<number, Body>();
    const records = arrays.map((rec) => {
      const S = rec.sources.length, members = [...rec.sources, ...rec.copies];
      if (rec.copies.length !== (rec.n - 1) * S) return rec;
      if (members.some((id) => !before.has(id) || after.get(id)?.group !== rec.group || replaced.has(id))) return rec;
      const changed = members.filter((id) => after.get(id)!.shape !== before.get(id)!.shape);
      if (!changed.length || changed.length === members.length) return rec;
      // (only an array that was still as it was made: its copies are where the record says)
      if (this.arrayToChange(members) !== rec) return rec;
      const shift = rec.circular ? this.circularShift(rec) ?? [0, 0, 0] : ([0, 0, 0] as V3);
      const { place, unplace } = this.arrayPlacement(rec, shift);
      const at = (k: number, j: number) => (k ? rec.copies[(k - 1) * S + j] : rec.sources[j]);
      let did = false;
      for (let j = 0; j < S; j++) {
        const column = Array.from({ length: rec.n }, (_, k) => at(k, j));
        const edited = column.findIndex((id) => after.get(id)!.shape !== before.get(id)!.shape);
        if (edited < 0 || column.every((id) => after.get(id)!.shape !== before.get(id)!.shape)) continue;
        const e = after.get(column[edited])!;
        if (isMesh(e.shape)) continue;
        const source = unplace(e.shape, edited);
        column.forEach((id, k) => {
          if (k === edited) return;
          const b = after.get(id)!;
          replaced.set(id, { ...b, kind: e.kind, shape: place(k ? cloneShape(source) : source, k) } as Body);
        });
        did = true;
      }
      if (!did || !rec.circular) return rec;
      // Circular: its boxes as they are now (and its axis / centre moved with the group), so it can still be changed.
      const now = (id: number) => (replaced.get(id) ?? after.get(id)!).shape.boundingBox.bounds;
      const c = rec.circular, centre = this.circularCentre(rec);
      return {
        ...rec,
        circular: {
          ...c,
          axis: { origin: [0, 1, 2].map((i) => c.axis.origin[i] + shift[i]) as V3, dir: c.axis.dir },
          centre: [0, 1, 2].map((i) => centre[i] + shift[i]) as V3,
          boxes: rec.sources.map(now),
        },
      };
    });
    if (!replaced.size) return null;
    const groups = [...new Set([...replaced.values()].map((b) => b.group))];
    setTimeout(() => this.toast(`Every copy in ${groups.join(", ")} changed too (Ctrl+Shift+G takes the group apart to change one alone)`));
    return { bodies: next.map((b) => replaced.get(b.id) ?? b), arrays: records };
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
  private opArrayCopy(ids: number[], rec: ArrayRecord | null = null, change = false): void {
    const DIRS = ["+X", "−X", "+Y", "−Y", "+Z", "−Z"];
    const along = (axis: number, d: number): V3 => {
      const v: V3 = [0, 0, 0];
      v[axis] = d;
      return v;
    };
    /** Changing `rec` (not new copies): its sources, back where they were before it (e.g. Align centre moved them). */
    const editing = () => change && !!rec;
    const back = (id: number): Geom => {
      const b = this.doc.get(id)!, d = rec!.offsets[0];
      return Math.abs(d) > 1e-12 ? translateShape(b.shape, along(rec!.dir >> 1, -d)) : b.shape;
    };
    /** What the row is made of: the selection, or (changing an array) its sources where they started. */
    const sourcesOf = (edit: boolean): { id: number; shape: Geom }[] =>
      edit ? rec!.sources.map((id) => ({ id, shape: back(id) })) : ids.map((id) => ({ id, shape: this.doc.get(id)!.shape }));
    const bounds = (edit: boolean) => {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const { shape } of sourcesOf(edit)) {
        const [a, b] = shape.boundingBox.bounds;
        for (let i = 0; i < 3; i++) {
          lo[i] = Math.min(lo[i], a[i]);
          hi[i] = Math.max(hi[i], b[i]);
        }
      }
      return { lo, hi };
    };
    const copyName = (b: Body) => b.name.replace(/\s+\d+$/, "");
    /** The clicked edge / path: where it runs along `axis` (from `a` to `b`). */
    let span: { axis: number; a: number; b: number } | null = change ? (rec?.span ?? null) : null;
    /**
     * The path, edge or guide line under the cursor (an edge before a guide lying on it): its
     * extent along its longest axis.
     */
    const spanAt = (e: PointerEvent): { axis: number; a: number; b: number; what: string; item: SelItem | null; guide: number; at: THREE.Vector3 } | null => {
      let hit: { bounds: [V3, V3] | null; what: string; item: SelItem | null; guide?: number; at: THREE.Vector3 } | null = null;
      const p = this.viewport.pick(e.clientX, e.clientY, "body");
      const pb = p && this.doc.get(p.body);
      if (p && pb?.kind === "path") hit = { bounds: curveBounds(pb.shape), what: "Path", item: { kind: "body", body: pb.id, id: 0 }, at: p.point };
      else {
        const h = this.viewport.pick(e.clientX, e.clientY, "edge");
        const hb = h && this.doc.get(h.body);
        if (h && hb && isBrep(hb)) hit = { bounds: curveBounds(hb.shape, h.id), what: "Edge", item: { kind: "edge", body: h.body, id: h.id }, at: h.point };
      }
      const gi = hit ? -1 : this.viewport.guideAt(e.clientX, e.clientY);
      if (gi >= 0) {
        const { a, b } = this.doc.guides[gi];
        const lo = [0, 1, 2].map((k) => Math.min(a[k], b[k])) as V3, hi = [0, 1, 2].map((k) => Math.max(a[k], b[k])) as V3;
        hit = { bounds: [lo, hi], what: "Guide", item: null, guide: gi, at: new THREE.Vector3(...a).add(new THREE.Vector3(...b)).multiplyScalar(0.5) };
      }
      if (!hit?.bounds) return null;
      const [l, u] = hit.bounds;
      const ext = [0, 1, 2].map((k) => u[k] - l[k]);
      const axis = ext.indexOf(Math.max(...ext));
      if (ext[axis] < 1e-6) return null;
      return { axis, a: l[axis], b: u[axis], what: hit.what, item: hit.item, guide: hit.guide ?? -1, at: hit.at };
    };
    /** Light up the guide line under the cursor (edges and paths light up as a hover item). */
    const lightGuide = (g: number) => {
      if (g === this.hoverGuide) return;
      this.hoverGuide = g;
      this.showGuides();
    };
    const input = (key: string) => this.op?.inputs.find((i) => i.dataset.key === key);
    // New copies start from the last ones' gap / direction; changing an array, from its own settings.
    const fresh = { n: 2, gap: this.arrayPrefs.gap, total: 0, dir: this.arrayPrefs.dir, centre: this.arrayPrefs.centre };
    const start = change && rec ? rec : fresh;
    this.startOp({
      title: change && rec ? `Change ${rec.group}` : "Array copy",
      label: "Array copy",
      fields: [
        { key: "n", label: "Copies (the original counts)", value: start.n, step: 1, min: 2 },
        { key: "gap", label: "Gap between copies (mm)", value: start.gap, step: 0.5 },
        { key: "total", label: "Total length (mm, 0: use the gap)", value: start.total, step: 1, min: 0 },
        { key: "dir", label: "Direction", value: start.dir, type: "select", options: DIRS },
        { key: "centre", label: "Align centre (the original moves too)", value: start.centre, type: "checkbox" },
      ],
      hint: "Array copy: copies, gap (edge to edge) and direction (click a ±X / ±Y / ±Z mark) — or click an edge, a guide line or a path: the copies spread to its far end (Align centre: the whole row fills it) · Enter apply · Esc cancel",
      // ±X / ±Y / ±Z marks just outside the objects (axis colours): a click picks the direction
      choices: (() => {
        const { lo, hi } = bounds(editing());
        const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2) as V3, ext = [0, 1, 2].map((k) => hi[k] - lo[k]);
        const out = Math.max(...ext) * 0.35 + 4;
        const AXIS_COLORS = ["#d9534f", "#5cb85c", "#4a90e2"]; // (as the world axes)
        return DIRS.map((label, dir) => {
          const axis = dir >> 1, at = [...c] as V3;
          at[axis] += (dir & 1 ? -1 : 1) * (ext[axis] / 2 + out);
          return { at, from: c, key: "dir", value: dir, label, color: AXIS_COLORS[axis], title: `Copies along ${label}` };
        });
      })(),
      pick: (e) => {
        const t = spanAt(e);
        const total = input("total"), dir = input("dir");
        if (!t || !total || !dir) return;
        span = { axis: t.axis, a: t.a, b: t.b };
        total.value = fmt(t.b - t.a);
        // Along the edge, toward its far end (from the original).
        const { lo, hi } = bounds(editing());
        const c = (lo[t.axis] + hi[t.axis]) / 2;
        dir.value = String(t.axis * 2 + (t.b - c < c - t.a ? 1 : 0));
        this.previewOp();
        this.toast(`${t.what} (${fmt(t.b - t.a)} mm): the copies spread along it`);
      },
      hover: (e) => {
        const t = spanAt(e);
        lightGuide(t?.guide ?? -1);
        this.viewport.setHighlight(this.selection, t?.item ?? null);
        this.hud(t ? `${t.what}: ${fmt(t.b - t.a)} mm along ${"XYZ"[t.axis]}` : null, t?.at);
        this.viewport.canvas.style.cursor = t ? "pointer" : "crosshair";
      },
      compute: (values) => {
        let { n: count, gap, dir, total, centre: alignCentre } = values;
        const edit = editing(), src = sourcesOf(edit), ids = src.map((x) => x.id);
        const { lo, hi } = bounds(edit);
        const typed = { gap, total };
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
        /** Where each source goes (k = 0) — changing an array, from where it started (it may have to move back). */
        const placed = (x: { id: number; shape: Geom }, d: number) => (Math.abs(d) > 1e-12 ? translateShape(x.shape, along(axis, d)) : x.shape);
        const sourceMoves = edit ? Math.abs(offsets[0] - rec!.offsets[0]) > 1e-9 || ((rec!.dir >> 1) !== axis && Math.abs(rec!.offsets[0]) > 1e-9) : moveOrig;
        const ghost = new Map<number, Shape>();
        offsets.forEach((d, k) => {
          if (k === 0 && !sourceMoves) return;
          src.forEach((x, j) => {
            const b = this.doc.get(x.id)!;
            // (the original's preview replaces it; copies are new: negative keys)
            if (b.kind === "solid" || b.kind === "face") ghost.set(k === 0 ? x.id : -(k * src.length + j), placed(x, d) as Shape);
          });
        });
        return {
          ghost,
          // Changing an array: its old copies make way for the new ones.
          hide: edit ? [...rec!.copies] : [],
          commit: () => {
            const copies: Body[] = [];
            for (let k = 1; k <= n; k++) {
              copies.push(...src.map((x) => {
                const b = this.doc.get(x.id)!;
                return withTextOf(this.doc.makeBody(translateShape(cloneShape(x.shape), along(axis, offsets[k])), copyName(b), b.kind), b);
              }));
            }
            // The row is a group: the originals' own group if they share one (a second array → a grid), else a new "Array N".
            const idSet = new Set(ids);
            const groups = new Set(ids.map((id) => this.doc.get(id)!.group));
            const group = edit ? rec!.group : groups.size === 1 && [...groups][0] ? [...groups][0]! : this.newGroupName("Array");
            const gone = new Set(edit ? rec!.copies : []);
            const bodies = this.doc.bodies
              .filter((b) => !gone.has(b.id))
              .map((b) => (idSet.has(b.id) ? { ...(sourceMoves ? withShape(b, placed(src[ids.indexOf(b.id)], offsets[0])) : b), group } : b));
            const made: ArrayRecord = {
              group, sources: ids, copies: copies.map((b) => b.id), n: count, gap: typed.gap, total: typed.total, dir, centre: alignCentre, offsets,
              ...(total > 0 && span ? { span } : {}),
            };
            const arrays = [...this.doc.arrays.filter((r) => r !== rec || !edit), made];
            this.doc.commit([...bodies, ...copies.map((b) => ({ ...b, group }))], edit ? `Change ${group} ×${count}` : `Array copy ×${count}`, this.doc.guides, this.doc.dimensions, arrays);
            // The whole row stays selected: Array copy again (e.g. along Y) makes a grid.
            return {
              select: [...ids, ...copies.map((b) => b.id)],
              solidMode: true,
              then: () => {
                // (Shift+R would move the whole selected row — not repeat this array)
                this.repeatOps = [];
                this.repeatCopyIds = "";
                this.toast(edit ? `${group}: now ${count} in a row` : `${count} in a row (${n} new) — all selected: Array copy again for a grid`);
              },
            };
          },
        };
      },
      // (changing an array leaves the new-copies defaults alone)
      remember: ({ gap, dir, centre }) => {
        if (!change) this.arrayPrefs = { gap, dir, centre };
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
    window.yddd?.setTitle(`${name}${this.doc.dirty ? " •" : ""} — YDDD`);
    window.yddd?.setDirty(this.doc.dirty && (this.doc.bodies.length > 0 || this.doc.filePath !== null));
    document.title = `${name} — YDDD`;
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
    if (this.viewport.xray) active.add("view.xray");
    if (this.tool) active.add(`tool.${this.tool.name.toLowerCase()}`);
    if (this.xf) active.add(this.xf.mode === "translate" ? "xf.move" : "xf.rotate");
    if (this.op) {
      const map: Record<string, string> = { "Push/Pull": "op.pushpull", Fillet: "op.fillet", Chamfer: "op.chamfer", Shell: "op.shell", Revolve: "op.revolve", Sweep: "op.sweep", "Array copy": "edit.array", "Circular copy": "edit.circular" };
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
  /** `name` if no object uses it as a group yet, else "name 2", "name 3"... */
  private uniqueGroupName(name: string): string {
    const used = new Set(this.doc.bodies.map((b) => b.group));
    let n = 2;
    if (!used.has(name)) return name;
    while (used.has(`${name} ${n}`)) n++;
    return `${name} ${n}`;
  }

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
  /** Guide group rows (see Guide.group) by group name. */
  private olGuideGroups = new Map<string, HTMLElement>();
  /** The last row clicked (without Shift) in the Bodies panel: where a Shift+click range starts. */
  private olAnchor: number | null = null;
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
        const gg = t.closest<HTMLElement>(".ol-guides")?.dataset.guides;
        if (gg !== undefined) {
          if (t.closest(".ol-eye")) {
            if (!this.hiddenGuideGroups.delete(gg)) this.hiddenGuideGroups.add(gg);
            if (this.selGuideGroup === gg) this.selGuideGroup = null;
          } else {
            // Select the group's lines (lit in the viewport); clicking it again deselects.
            if (this.xf) this.stopTransform();
            this.selGuide = -1;
            this.selDim = -1;
            this.showDimensions();
            if (this.selection.length) this.setSelection([]);
            this.selGuideGroup = this.selGuideGroup === gg ? null : gg;
            if (this.selGuideGroup !== null) this.hint(`${gg}: ${this.doc.guides.filter((x) => x.group === gg).length} guide lines selected · Del removes them · the eye hides them`);
          }
          this.showGuides();
          return this.renderOutliner();
        }
        const g = groupOf(e);
        if (g !== null) {
          const ms = members(g);
          if (t.closest(".ol-caret")) {
            if (this.olCollapsed.has(g)) this.olCollapsed.delete(g);
            else this.olCollapsed.add(g);
            return this.renderOutliner();
          }
          if (this.outlinerPick && !t.closest(".ol-eye")) return this.outlinerPick(ms.map((b) => b.id)); // (Union / Subtract... waiting for solids)
          if (t.closest(".ol-edit.off")) return this.toast(t.closest<HTMLElement>(".ol-edit")!.title, "error");
          if (t.closest(".ol-edit")) {
            // The pencil on a Text group: edit its text
            this.setMode("body");
            this.setSelection(ms.filter((b) => b.text).map((b) => ({ kind: "body", body: b.id, id: 0 })));
            return void this.startText(true);
          }
          if (t.closest(".ol-dup")) {
            // The copy icon: select the whole group and duplicate it (a new group, moved with the gizmo)
            this.setMode("body");
            this.setSelection(ms.map((b) => ({ kind: "body", body: b.id, id: 0 })));
            return this.run("edit.duplicate");
          }
          if (t.closest(".ol-array")) {
            // The array icon: select the group and change the array (or say why it can't be)
            const why = this.arrayOfGroup(g);
            if (typeof why === "string") return this.toast(why, "error");
            this.setMode("body");
            this.setSelection(ms.map((b) => ({ kind: "body", body: b.id, id: 0 })));
            return this.run("edit.arrayChange");
          }
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
        if (this.op?.spec.pickBody && !this.tool && !t.closest(".ol-eye")) return this.op.spec.pickBody(b.id);
        if (t.closest(".ol-eye")) {
          if (this.hidden.has(b.id)) this.hidden.delete(b.id);
          else this.hidden.add(b.id);
          this.viewport.setHidden(this.hidden);
          this.renderOutliner();
          return;
        }
        this.setMode("body");
        const item: SelItem = { kind: "body", body: b.id, id: 0 };
        const rows = [...el.querySelectorAll<HTMLElement>(".ol-row")].map((r) => Number(r.dataset.id));
        if (e.shiftKey && this.olAnchor !== null && rows.includes(this.olAnchor)) {
          // Shift: every row from the last clicked one to this one, up or down (Ctrl+Shift: added to the selection).
          const [i, j] = [rows.indexOf(this.olAnchor), rows.indexOf(b.id)].sort((p, q) => p - q);
          const range: SelItem[] = rows.slice(i, j + 1).map((id) => ({ kind: "body", body: id, id: 0 }));
          const keep = e.ctrlKey ? this.selection.filter((s) => !range.some((it) => sameItem(s, it))) : [];
          return this.setSelection([...keep, ...range]);
        }
        this.olAnchor = b.id;
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
    const guideGroups = new Map<string, number>();
    for (const g of this.doc.guides) if (g.group !== undefined) guideGroups.set(g.group, (guideGroups.get(g.group) ?? 0) + 1);
    if (!this.doc.bodies.length && !guideGroups.size) {
      this.olRows.clear();
      this.olGroups.clear();
      this.olGuideGroups.clear();
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
      // Made by Array copy: an icon to change it (dimmed, saying why, once it can't be)
      const arr = this.arrayOfGroup(g);
      const round = arr !== null && !![...this.doc.arrays].reverse().find((r) => r.group === g)?.circular, arrIcon = round ? ICONS.circular : ICONS.array;
      const arrBtn = arr === null ? "" : typeof arr === "string"
        ? `<button class="ol-array off" title="${escapeHtml(arr)}">${arrIcon}</button>`
        : `<button class="ol-array" title="${round ? `Circular copy (${arr.n} round)` : `Array copy (${arr.n} in a row)`}: click to change it">${arrIcon}</button>`;
      // Made by the Text tool: a pencil to edit its text (dimmed, saying why, once it can't be)
      const why = ms.some((x) => x.text) ? this.textEditable(g, ms) : null;
      const editBtn = !ms.some((x) => x.text) ? "" : why ? `<button class="ol-edit off" title="${escapeHtml(why)}">${ICONS.edit}</button>` : `<button class="ol-edit" title="Edit the text">${ICONS.edit}</button>`;
      const html = `<button class="ol-caret" title="${open ? "Fold" : "Unfold"}">${open ? "▾" : "▸"}</button><span class="ol-name" title="Click: select the group · double-click: rename">${escapeHtml(g)}</span><span class="ol-count">${ms.length}</span>${editBtn}${arrBtn}<button class="ol-dup" title="Copy the group (Shift+D): its copies as a new group">${ICONS.duplicate}</button><button class="ol-eye" title="Show/hide the group">${allHidden ? ICONS.eyeOff : ICONS.eye}</button>`;
      if (head.innerHTML !== html && !head.querySelector("input")) head.innerHTML = html;
      head.classList.toggle("selected", ms.every((x) => selected.has(x.id)));
      head.classList.toggle("hidden", allHidden);
      order.push(head);
      if (open) for (const m of ms) order.push(bodyRow(m));
      else for (const m of ms) live.add(m.id); // (kept, just not shown)
    }
    // Guide groups (more than 4 guides from one Guide tool run), after the bodies.
    for (const [g, n] of guideGroups) {
      let head = this.olGuideGroups.get(g);
      if (!head) {
        head = document.createElement("div");
        head.className = "ol-group ol-guides";
        head.dataset.guides = g;
        this.olGuideGroups.set(g, head);
      }
      const hidden = this.hiddenGuideGroups.has(g);
      const html = `<span class="ol-swatch guide" title="Guide lines"></span><span class="ol-name" title="Click: select its guide lines (Del removes them)">${escapeHtml(g)}</span><span class="ol-count">${n}</span><button class="ol-eye" title="Show/hide these guide lines">${hidden ? ICONS.eyeOff : ICONS.eye}</button>`;
      if (head.innerHTML !== html) head.innerHTML = html;
      head.classList.toggle("selected", this.selGuideGroup === g);
      head.classList.toggle("hidden", hidden);
      order.push(head);
    }
    for (const g of [...this.olGuideGroups.keys()]) if (!guideGroups.has(g)) this.olGuideGroups.delete(g);
    for (const g of [...this.hiddenGuideGroups]) if (!guideGroups.has(g)) this.hiddenGuideGroups.delete(g);
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
        tip(`Solids: <kbd>B</kbd> <kbd>B</kbd> box · <kbd>B</kbd> <kbd>C</kbd> cylinder · <kbd>B</kbd> <kbd>S</kbd> sphere · <kbd>B</kbd> <kbd>O</kbd> cone<br>Faces: <kbd>A</kbd> <kbd>A</kbd> rectangle · <kbd>A</kbd> <kbd>C</kbd> circle · <kbd>A</kbd> <kbd>P</kbd> polygon · <kbd>T</kbd> text → <kbd>P</kbd> push/pull<br><kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> solid / face / edge mode<br><kbd>F1</kbd> all shortcuts`);
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
          // (its drawn box: the exact one can take ~0.7 s on a solid with a complex spline face, on every click)
          const drawn = this.viewport.drawnBox(b.id)?.getSize(new THREE.Vector3());
          const [w, d, h] = drawn ? drawn.toArray() : boundingSize(b.shape);
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
        // A whole array group (changed with its icon in the Bodies panel): what it is, or why it can't be changed now.
        const rec = this.arrayToChange(sel.map((s) => s.body));
        if (rec) rows.unshift(typeof rec !== "string" && rec.circular
          ? ["Circular copy", `${escapeHtml(rec.group)} · ${rec.n} round the ${escapeHtml(rec.circular.name)}${Math.abs(Math.abs(rec.circular.angle) - 360) < 1e-9 ? "" : ` over ${fmt(rec.circular.angle)}°`}`]
          : ["Array", typeof rec === "string" ? escapeHtml(rec) : `${escapeHtml(rec.group)} · ${rec.n} in a row`]);
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

  /** Auto snap on / off (the status bar's Auto box); `remember`: keep it for next time. */
  setAutoSnap(on: boolean, remember = true): void {
    this.viewport.autoSnap = on;
    $<HTMLInputElement>("auto-snap").checked = on;
    if (remember) localStorage.setItem(AUTO_SNAP_KEY, on ? "1" : "0");
    // Rewrite the current hint / gizmo snapping for the new setting.
    if (this.xf?.guide !== undefined) this.startGuideMove(true);
    else if (this.xf?.edges) this.startEdgeMove(true);
    else if (this.xf) this.startTransform(this.xf.mode, true);
  }

  private bindStatusBar(): void {
    const auto = $<HTMLInputElement>("auto-snap");
    this.setAutoSnap(localStorage.getItem(AUTO_SNAP_KEY) !== "0", false);
    auto.addEventListener("change", () => {
      auto.blur();
      this.setAutoSnap(auto.checked);
      this.toast(auto.checked ? "Auto snap on — hold Ctrl to place freely" : "Auto snap off — hold Ctrl to snap");
    });
    const select = $<HTMLSelectElement>("snap-select");
    // (the step from last time, if it is still one of the choices)
    const saved = localStorage.getItem(SNAP_STEP_KEY);
    if (saved !== null && [...select.options].some((o) => o.value === saved)) {
      select.value = saved;
      this.snap = Number(saved);
      this.viewport.axisSnapStep = this.snap;
    }
    select.addEventListener("change", () => {
      this.snap = Number(select.value);
      this.viewport.axisSnapStep = this.snap;
      localStorage.setItem(SNAP_STEP_KEY, select.value);
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
      <p>Follow each step with the keys shown, or press <b>Do step</b> to see yddd do it (<kbd>Ctrl</kbd>+<kbd>Z</kbd> takes it back).</p>
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
    if (!textFontReady()) await loadTextFont().catch(() => {}); // (a step may write a label: Cable Storage Box)
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
      ["Shift + Left-drag · Shift / Ctrl + Middle-drag", "Pan view"],
      ["Wheel · two-finger slide (touchpad)", "Zoom to cursor"],
      ["1 · 2 · 3", "Selection mode: Solid · Face · Edge"],
      ["Click / Shift+click", "Select / add to selection"],
      ["Bodies panel: Shift+click · Ctrl+click", "Select all the rows from the last clicked one to this one (Ctrl+Shift: add them) · add / remove one"],
      ["B B · B C · B S · B O", "Draw solid Box · Cylinder · Sphere · Cone (B O: base, then height — a sharp tip; Tab or height,top size + Enter: a flat top) (B alone starts a box; type numbers + Enter for exact sizes)"],
      ["A · A C · A P", "Draw flat Rectangle · Circle · Polygon face (A alone starts a rectangle; then P to push/pull into a solid)"],
      ["T · A T", "Text: click where it starts (on the ground or a flat face), type it in the panel (Shift+Enter: a new line) with its font (built in: Noto Sans, Noto Serif, Noto Sans Thai — Regular / Bold; on Linux also any TrueType / OpenType font on the system; remembered; letters a font hasn't got, e.g. Thai, come from the built-in ones), height (a capital letter, mm), alignment, letter spacing (extra mm between letters) and line spacing — click elsewhere to move it · Enter / Create adds a flat face per letter, as one group: P pushes them all into raised letters (or into a solid, then Subtract, for engraved ones); S scales a text evenly only (the ring: its letters keep their shape) · the pencil by a Text group in the Bodies panel edits its text (flat or pushed) — the panel as it was made, the text where it is now (moved, turned, scaled, mirrored); Done replaces its letters, pushed ones pushed as far again (not after Subtract / fillet)"],
      ["K", `Sketch on the selected flat face (a curved face: on the flat plane touching it under the cursor — the sketch stays flat; or the ground) — with face objects / paths selected: edit them in the sketch, on their plane (however they were moved or rotated; Done replaces them, Cancel keeps them): the view turns square to it with a 3D view in the corner · Tab: exact values (first point X,Y · line length, angle · arc radius, angle · rectangle width, height · circle radius · selection ΔX, ΔY, scale %) · L line · A arc · R rectangle · C circle · click the start point to close (Enter or double-click: done — the lines stay open, a path) · typed length / w,h / radius + Enter (arc: its radius, then click where it ends) · Esc drops the outline being drawn · Ctrl+Z undo · Esc again (nothing being drawn) or a right click (keeps what is being drawn): Select — click / Shift+click outlines and paths, drag to move (or type dx,dy), G the move gizmo (red arrow X, green Y, yellow square free; Enter / click elsewhere: done, Esc: back), S scales about the centre — a gizmo: red square X, green Y, yellow ring both (X / Y unevenly: arcs / circles become freeform curves), ${this.viewport.stepTip("round steps")}, Tab: Scale / X / Y %, Enter applies (or type a % + Enter), J joins (outlines into one face, paths end to end), Del deletes · Done keeps the closed outlines as flat faces (inside ones become holes) and open lines as paths, Cancel drops the sketch · bottom-left icons: turn the view a quarter · a picture to trace (only shown while sketching, remembered for the same face): drag moves it, a % + Enter scales it, Match: click 2 points on it, then where they belong on the model · Del removes it`],
      ["Tab (while drawing)", "Property dialog: type exact size, then Create"],
      ["Enter (Move G / Rotate R)", "Done — finish the move and hide the gizmo"],
      ["Shift+R", "Repeat last move/rotate (after Shift+D: copy again → array)"],
      ["Tab (Move G / Rotate R)", "Type exact ΔX,ΔY,ΔZ or X/Y/Z angles"],
      ["D", "Draw line on face: click two points on the edges of a solid's flat face to split it (corners / midpoints snap; move the end along X / Y / Z and it locks parallel to that axis, the line in the axis colour); the new edge is selected"],
      ["G with a guide line selected", `Move the guide with the gizmo (${this.viewport.snapTip("points / other guides")}) · Tab: exact ΔX,ΔY,ΔZ · Enter done`],
      ["G with edges selected", "Move edge: drag the edge, reshaping its flat-faced solid (bent faces split into triangles)"],
      ["Shift+wheel · [ · ] (Polygon tool)", "Fewer / more sides (3–64)"],
      this.viewport.autoSnap
        ? ["Hold Ctrl", "Free: no snapping while held (Auto snap is on — tools snap to object points: corners, midpoints, centres, edges, guide lines, axes, or the grid; 5° while rotating). The Auto box by Snap in the status bar turns it off: then hold Ctrl to snap"]
        : ["Hold Ctrl", "Snap: object points (corners, midpoints, centres, edges, guide lines, axes) or grid while drawing / moving / dragging Push/Pull or Offset; 5° while rotating (tick Auto by Snap in the status bar to snap without Ctrl)"],
      ["P / Space", "Push/Pull: flat face → new solid; solid face → modify (or tick “New solid”); Shift-click several faces to push them together"],
      ["Dot · G", "Pull to a point: select a flat circle, rectangle or polygon face (or its face object) — a dot shows in its middle; click the dot, G, drag or type the height: a cone / pyramid (out of a solid: added to it; a minus height into it: cut out of it) · Top size %: a flat top instead of a point"],
      ["Tip dot · F", "Round tip: a selected solid shows a dot on each sharp tip (a cone's point, a pyramid's — not box corners); click the dot, F, the radius (mm): the point becomes a ball — on a cone it blends smoothly into the side, on a pyramid into its edges (a slight crease on the flat sides); the panel says the largest radius the tip takes"],
      ["F · Shift+F", "Fillet · Chamfer selected edges, or the edges of selected solids — all, just the vertical ones (box corners) or just the horizontal ones (Edges list); edges it can't do at that size are left sharp — the panel says how many (orange), Apply keeps the rest, and a button sets the largest size that does them all"],
      ["H", "Shell / hollow (opens the selected faces)"],
      ["Macro → Box Lid → Inside Lip / Over the Box", "A lid for an open-top box (Box from Face, Shell... — selected first, or click it while the panel waits), made closed on it: Inside Lip — a plate on the rim, a lip under it fitting in the opening (Lip depth 0: a flat lid; Lip wall 0: a solid plug); Over the Box — a cap, bigger, its skirt round the box's outside. Clearance: the gap to the box (0: an exact fit)"],
      ["Macro → Box from Face", "An open-top box round a flat face — selected first, or click one while the panel waits (a face object, or a flat face of a solid; another click changes it): the face is the box's inside, floor and inner outline (a rectangle: a tray, a circle: a cup), so the inside keeps its size — Wall grows out from it, Bottom down under it, Inside depth up from it; Round vertical edges: the inside corners get the radius, the outside ones radius + wall"],
      ["C", "Cut by guide or axis: press C — the panel waits for the solid(s) / flat face(s) (selected first, or click them; Shift+click more) and a guide line, a red X / green Y / blue Z axis line (an axis cuts on the world plane through it that faces you most) or a straight path from the sketch (cuts upright through it) — split into 2 objects by the plane through the guide, straight across the face it lies on (off a flat face, e.g. on a sphere: along the line as seen in the view); the upper part is selected (Del removes it)"],
      ["O", "Offset: new flat face on the selected face's plane, larger by the distance (negative = smaller), optionally with round corners, or Make ring for just the band between the two outlines; then P to push/pull"],
      ["Modify menu · Pro: R E", "Revolve: turn the selected flat face (or flat face object) about an axis into a solid — a guide line (draw one with Shift+G for an exact axis), one of the face's straight edges or the world X / Y / Z axis (pick it in the panel or just click it in the view); 360° = all the way round (a circle beside the axis → a donut)"],
      ["Modify menu · Pro: S W", "Sweep: a flat face (the profile) runs along a path or guide line into a solid — a flat ring (Offset → Make ring) makes a tube. Uses what is selected (a face, a path, a guide line); the panel then waits: click the profile face and the path / guide line (what a click would pick lights up). The profile moves onto the nearest end of the path, square to it (Turn profile: its angle round the path); one already sitting on the path end stays put (tick Centre to centre it). Corners: sharp or round where a path turns"],
      ["O with edges selected", "Offset edges: new flat strip centred on the selected straight edges, the distance to each side, in the plane of the adjacent face (tick “Other face” for the other plane); a closed loop of edges gives a ring"],
      ["Shift+G", `Guide line: click a reference edge, slide across a face (type / Tab: distance, %, count), Enter adds — or click two points (corners / midpoints / centres; Ctrl: edges, guides, axes) for a guide between them (in Top / Front / Right view: click anywhere — on a face, or on the grid) — near an X / Y / Z direction it locks on (red / green / blue) · click a guide + Del removes · more than 4 at once (Count): one group in the Bodies panel — click it to select them all (Del removes), the eye hides them · ${this.viewport.autoSnap ? "tools snap to guides" : "Ctrl snaps to guides"}`],
      ["+ · − · Shift+I  (also Shift+U · Shift+S)", "Union · Subtract · Intersect (first selected = target)"],
      ["=", "Measure: click 2 points for the length (ΔX ΔY ΔZ, slope; off a corner or edge the 2nd point locks onto X / Y / Z when moved nearly along it), a 3rd for the angle at the 2nd — shown in the corner panel; Esc clears a result, Esc again (or Cancel) exits · Tab: add a dimension — of the angle (3 points clicked; move to size its arc), of the length between the 2 clicked points, or (none clicked) of the straight edge under the cursor, or the radius of the circle / arc under it (move to set its distance, or where a radius points, click to place; click its text + Del removes it) · hover a point (corner / midpoint / centre: X Y Z), an edge (length; circle / arc: radius, Ø, angle) or a face (area; rectangle sides, cylinder radius / height, sphere radius...) · Esc done"],
      ["G · R", "Move · Rotate gizmo — while moving, click a round edge (circle / arc): slide along its axis (a dashed line) — or a slanted straight edge: slide along it, the blue arrow in mm steps, Tab: the distance along it"],
      ["S", `Scale selected objects about their bottom centre: drag the ring for Scale % or the red / green / blue boxes for X / Y / Z % (${this.viewport.autoSnap ? "snaps, Ctrl: free" : "Ctrl snaps"}; per-axis works on curved shapes too)`],
      ["S with hole rims selected", "Resize hole / pin: Edge mode, click the rim of a round hole or pin (Shift+click more), S — type the new diameter (holes of different sizes: how much bigger, e.g. 0.2 for a looser fit) or drag the ring on the rim; a hole grows into the solid, a pin out of it · any other hole (rectangle, slot, a sketched shape): click one edge of its rim, S — Bigger by (mm): every wall moves out by half of it, corners stay sharp"],
      ["Click a selected solid again", "Drill down: selects the edge (near one) or face under the cursor and switches to Edge / Face mode"],
      ["Right-click a solid", "Switches to Solid mode and selects it (Shift+right-click adds)"],
      ["Click an edge of a selected face", "Face mode: selects that edge and switches to Edge mode"],
      ["G G", "Move from point (G pressed twice): show marks — click one → move gizmo there; or drag a mark to the target (the other solids' circle / face centres show as marks: centre to centre); click a round edge (circle / arc) or a slanted straight edge → slide along its axis / the edge, as with G"],
      ["Ctrl+G / Ctrl+Shift+G", "Group the selected objects / take their group apart — in the Bodies panel: click a group to select it, ▸ folds it, double-click renames, the eye hides it (Array copy groups its row itself)"],
      ["Shift+D / Ctrl+D", "Duplicate solids, copy selected faces (then move), on a closed loop of edges (a circle, or edges round a face): copy it as a flat face (then move, P), or on a single straight edge: add a guide line (like Shift+G)"],
      ["M", "Mirror the selected objects: click a ±X / ±Y / ±Z mark — a mirrored copy beyond that side of them, touching it (a whole group's copies: a new group) · Join: a solid and its copy become one where they touch (a half dome on its flat side, −Z: a ball) · to flip instead: delete the original"],
      ["Del / X", "Delete selected objects — with hole rims selected (Edge mode, one edge of each; any shape): fill the holes; round pins' rims: take off the pins"],
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
    return window.yddd ? window.yddd.confirm("You have unsaved changes. Discard them?") : confirm("Discard unsaved changes?");
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
    const file = await window.yddd.openFile({ title: "Open model", filters: [{ name: "YDDD model", extensions: ["yddd", "y3d"] }], binary: false });
    if (!file) return;
    try {
      this.loadModel(file.data as string, file.path);
      this.toast(`Opened ${file.path.split(/[\\/]/).pop()}`);
      this.dropRecovery();
      void window.yddd.addRecent(file.path);
    } catch (e) {
      this.fail(e);
    }
  }

  /** File → Open Recent: open that model again (a file no longer there is taken off the list). */
  async openRecent(filePath: string): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    const name = filePath.split(/[\\/]/).pop();
    const text = await window.yddd.readFile(filePath);
    if (text === null) {
      void window.yddd.removeRecent(filePath);
      return this.toast(`${name} is no longer there (moved or deleted) — taken off the recent list`, "error");
    }
    try {
      this.loadModel(text, filePath);
      this.toast(`Opened ${name}`);
      this.dropRecovery();
      void window.yddd.addRecent(filePath);
    } catch (e) {
      this.fail(e);
    }
  }

  /** Each shape's B-rep / mesh text, made once (shapes never change): Save and autosave reuse it. */
  private shapeTexts = new WeakMap<object, string>();

  private geomText(b: Body): string {
    let t = this.shapeTexts.get(b.shape);
    if (t === undefined) {
      t = b.kind === "mesh" ? b.shape.toBase64() : serializeShape(b.shape);
      this.shapeTexts.set(b.shape, t);
    }
    return t;
  }

  /**
   * The model as a .yddd file (JSON with one B-rep per body), with its undo / redo history: the last
   * SAVED_HISTORY steps, each body and shape stored once (a step lists the bodies it had). Older
   * YDDD versions read the model and ignore the history.
   */
  private modelText(): string {
    const cur = this.doc.bodies;
    const index = new Map(cur.map((b, i) => [b.id, i]));
    const h = this.doc.history();
    // History: body / shape references — negative: the model's own bodies[-r - 1]; else the history's lists.
    const bodyRef = new Map<Body, number>(cur.map((b, i) => [b, -(i + 1)]));
    const shapeRef = new Map<object, number>(cur.map((b, i) => [b.shape, -(i + 1)]));
    const pool: { id: number; name: string; kind: string; group?: string; text?: TextRecord; s: number }[] = [];
    const shapes: string[] = [];
    let size = 0;
    const refBody = (b: Body): number => {
      let r = bodyRef.get(b);
      if (r !== undefined) return r;
      let sr = shapeRef.get(b.shape);
      if (sr === undefined) {
        sr = shapes.length;
        shapes.push(this.geomText(b));
        size += shapes[sr].length;
        shapeRef.set(b.shape, sr);
      }
      r = pool.length;
      pool.push({ id: b.id, name: b.name, kind: b.kind, ...(b.group ? { group: b.group } : {}), ...(b.text ? { text: b.text } : {}), s: sr });
      bodyRef.set(b, r);
      return r;
    };
    const step = (e: HistoryEntry) => ({ label: e.label, bodies: e.bodies.map(refBody), guides: e.guides, dims: e.dims, arrays: e.arrays });
    /** Newest steps first, until SAVED_HISTORY of them or the history's shapes reach HISTORY_BYTES (big meshes). */
    const keep = (list: readonly HistoryEntry[]) => {
      const out = [];
      for (let i = list.length - 1; i >= 0 && out.length < SAVED_HISTORY && size < HISTORY_BYTES; i--) out.push(step(list[i]));
      return out.reverse();
    };
    const undo = keep(h.undo), redo = keep(h.redo);
    return JSON.stringify({
      format: "yddd",
      version: 1,
      units: "mm",
      bodies: cur.map((b) => ({
        ...(b.kind === "mesh" ? { name: b.name, kind: b.kind, mesh: this.geomText(b) } : { name: b.name, kind: b.kind, brep: this.geomText(b) }),
        ...(b.group ? { group: b.group } : {}),
        ...(b.text ? { text: b.text } : {}),
      })),
      guides: this.doc.guides,
      // A linked dimension's body as its index in `bodies` (ids are renumbered on open).
      dimensions: this.doc.dimensions.map(({ body, ...d }) => {
        const i = body === undefined ? -1 : (index.get(body) ?? -1);
        return i < 0 ? d : { ...d, body: i };
      }),
      // Array copies that can be changed later: bodies by index too.
      arrays: this.doc.arrays
        .map((r) => ({ ...r, sources: r.sources.map((id) => index.get(id) ?? -1), copies: r.copies.map((id) => index.get(id) ?? -1) }))
        .filter((r) => r.sources.every((i) => i >= 0)),
      // Undo / redo: bodies keep their ids here (the steps refer to each other by id).
      history: { ids: cur.map((b) => b.id), dims: this.doc.dimensions, arrays: this.doc.arrays, bodies: pool, shapes, undo, redo, counters: h.counters, nextId: h.nextId },
    });
  }

  /** Replace the document with a .yddd file's contents (throws if it isn't one). */
  private loadModel(text: string, filePath: string | null): void {
    const json = JSON.parse(text) as {
      format: string;
      bodies: { name: string; kind?: BodyKind; brep?: string; mesh?: string; group?: string; text?: TextRecord }[];
      guides?: Guide[];
      dimensions?: Dimension[];
      arrays?: ArrayRecord[];
      history?: SavedHistory;
    };
    if (json.format !== "yddd" && json.format !== "y3d") throw new Error("not a YDDD file");
    const geom = (kind: string | undefined, text: string): BodyGeom => {
      if (kind === "mesh") return { kind: "mesh", shape: TriMesh.fromBase64(text) };
      const shape = deserialize(text);
      if (kind === "path") return { kind: "path", shape: shape as unknown as Wire };
      return { kind: kind === "face" || kind === "solid" ? kind : kindOf(shape), shape };
    };
    const bodies = json.bodies.map((b): BodyGeom & { name: string; group?: string; text?: TextRecord } => {
      const group = typeof b.group === "string" && b.group ? { group: b.group } : {};
      return { name: b.name, ...geom(b.kind, b.kind === "mesh" ? b.mesh! : b.brep!), ...group, ...(b.text ? { text: b.text } : {}) };
    });
    this.endInteractions();
    this.selection = [];
    this.hidden.clear();
    const h = json.history;
    if (h && Array.isArray(h.ids) && h.ids.length === bodies.length) {
      try {
        const current = bodies.map((b, i) => ({ ...b, id: h.ids[i] }) as Body);
        const made = new Map<number, Body>();
        const shapeOf = new Map<number, BodyGeom["shape"]>();
        const body = (r: number): Body => {
          if (r < 0) return current[-r - 1];
          let b = made.get(r);
          if (!b) {
            const p = h.bodies[r];
            let shape = p.s < 0 ? current[-p.s - 1].shape : shapeOf.get(p.s);
            if (!shape) shapeOf.set(p.s, (shape = geom(p.kind, h.shapes[p.s]).shape));
            b = { id: p.id, name: p.name, kind: p.kind, shape, ...(p.group ? { group: p.group } : {}), ...(p.text ? { text: p.text } : {}) } as Body;
            made.set(r, b);
          }
          return b;
        };
        const entry = (e: SavedStep): HistoryEntry => ({ label: e.label, bodies: e.bodies.map(body), guides: e.guides ?? [], dims: e.dims ?? [], arrays: e.arrays ?? [] });
        this.doc.restore(
          { label: "", bodies: current, guides: json.guides ?? [], dims: h.dims ?? [], arrays: h.arrays ?? [] },
          { undo: h.undo.map(entry), redo: h.redo.map(entry), counters: h.counters ?? [], nextId: h.nextId ?? 1 },
          filePath,
        );
        this.viewport.fit();
        return;
      } catch (e) {
        console.warn("undo history not readable", e);
        this.toast("Opened without its undo history (it could not be read)", "error");
      }
    }
    this.doc.reset(bodies, filePath, json.guides ?? [], json.dimensions ?? [], json.arrays ?? []);
    this.viewport.fit();
  }

  private async fileSave(saveAs: boolean): Promise<void> {
    const data = this.modelText();
    let path = this.doc.filePath;
    if (saveAs || !path) {
      path = await window.yddd.saveFile({ title: "Save model", defaultPath: "untitled.yddd", filters: [{ name: "YDDD model", extensions: ["yddd"] }], data });
      if (!path) return;
    } else {
      await window.yddd.writeFile(path, data);
    }
    this.doc.filePath = path;
    this.doc.dirty = false;
    this.updateTitle();
    this.toast(`Saved ${path.split(/[\\/]/).pop()}`);
    this.dropRecovery();
    void window.yddd.addRecent(path);
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
    if (!window.yddd?.writeRecovery) return;
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
      await window.yddd.writeRecovery({ savedAt: Date.now(), filePath: this.doc.filePath, data: this.modelText() });
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
    void window.yddd?.clearRecovery?.();
  }

  /** On start: offer unsaved work autosaved before a crash (or a forced quit). */
  async offerRecovery(): Promise<void> {
    const rec = await window.yddd?.readRecovery?.();
    if (!rec) return;
    const when = new Date(rec.savedAt);
    const time = when.toDateString() === new Date().toDateString() ? when.toLocaleTimeString() : when.toLocaleString();
    const name = rec.filePath ? rec.filePath.split(/[\\/]/).pop() : "an unsaved model";
    const choice = await window.yddd.ask({
      message: "Recover unsaved work?",
      detail: `YDDD closed unexpectedly. Changes to ${name}, autosaved at ${time}, can be recovered.`,
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
    const file = await window.yddd.openFile({ title: "Import STEP", filters: [{ name: "STEP", extensions: ["step", "stp"] }], binary: true });
    if (!file) return;
    try {
      // Read in the background kernel (with the display meshes): the app stays live while a big file loads
      const data = file.data as Uint8Array;
      const shapes = this.bgKernel.ready ? (this.toast("Reading the STEP file…"), (await this.bgKernel.run({ op: "importStep", data })).solids.map(solidFrom)) : await importStep(data);
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
    const file = await window.yddd.openFile({ title: "Import STL", filters: [{ name: "STL", extensions: ["stl"] }], binary: true });
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

  /** File → Settings: a Radius | Diameter switch for circles, cylinders and spheres. Saved at once (localStorage). */
  private settingsDialog(): void {
    document.getElementById("props-dlg")?.remove();
    const dlg = document.createElement("form");
    dlg.id = "props-dlg";
    dlg.innerHTML =
      `<h4>Settings</h4>` +
      `<div class="seg-row"><span>Circles, cylinders, spheres</span><span class="seg"><button type="button" class="btn" data-v="r">Radius</button><button type="button" class="btn" data-v="d">Diameter</button></span></div>` +
      `<div class="op-buttons"><button type="submit" class="btn primary">Done</button></div>`;
    const seg = [...dlg.querySelectorAll<HTMLButtonElement>(".seg button")];
    const show = () => seg.forEach((b) => b.classList.toggle("primary", (b.dataset.v === "d") === byDiameter()));
    for (const b of seg)
      b.addEventListener("click", () => {
        localStorage.setItem(CIRCLE_SIZE_KEY, b.dataset.v!);
        show();
      });
    const close = () => {
      dlg.remove();
      $("viewport").focus?.();
    };
    dlg.addEventListener("submit", (e) => {
      e.preventDefault();
      close();
    });
    dlg.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") close();
    });
    $("viewport").appendChild(dlg);
    show();
    dlg.querySelector<HTMLButtonElement>("button[type=submit]")!.focus();
  }

  /**
   * STL quality before exporting: Draft / Normal / Fine presets or custom values, with the
   * resulting triangle count and file size. Remembers the last choice. Null if cancelled.
   */
  private stlQualityDialog(solids: (Solid | TriMesh)[], format = "STL"): Promise<StlQuality | null> {
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
        `<h4>Export ${format} — quality</h4>` +
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

  /** Bodies that would print badly: a solid that isn't closed or that OpenCascade finds broken, a mesh with gaps. */
  private printProblems(bodies: Body[]): { body: Body; why: string }[] {
    const out: { body: Body; why: string }[] = [];
    for (const b of bodies) {
      if (b.kind === "mesh") {
        const open = openEdgeCount(meshForExport(b.shape, { tolerance: 0.02, angle: 8 }));
        if (open) out.push({ body: b, why: `not closed — ${open} open edge${open === 1 ? "" : "s"} (gaps in the mesh)` });
      } else if (b.kind === "solid") {
        if (!solidPieces(b.shape).length) out.push({ body: b, why: "not a closed solid (an open surface)" });
        else if (!isValidShape(b.shape)) out.push({ body: b, why: "not a valid solid (OpenCascade finds it broken)" });
      }
    }
    return out;
  }

  private async fileExport(kind: "step" | "stl" | "3mf"): Promise<void> {
    const ids = this.selectedBodyIds();
    let bodies = ids.length ? this.doc.bodies.filter((b) => ids.includes(b.id)) : this.doc.bodies.filter((b) => !this.hidden.has(b.id));
    if (bodies.some((b) => b.kind === "path")) {
      this.toast(`${kind.toUpperCase()} skips paths (open lines from a sketch) — they have no surface`);
      bodies = bodies.filter((b) => b.kind !== "path");
    }
    // Only what has a volume, in every format: flat faces are left out.
    const withVolume = bodies.filter((b) => b.kind !== "face");
    if (withVolume.length < bodies.length) this.toast(`${kind.toUpperCase()} skips flat faces (no volume) — exporting solids${kind === "step" ? "" : " and meshes"} only`);
    bodies = withVolume;
    // (STL / 3MF: solids and meshes in one file — a slicer handles touching / overlapping parts)
    if (kind === "step") {
      const solids = bodies.filter((b) => b.kind !== "mesh");
      const meshes = bodies.length - solids.length;
      if (meshes) {
        // STEP holds only solids: say so before writing a file that silently lacks the meshes.
        const names = bodies.filter((b) => b.kind === "mesh").map((b) => `"${b.name}"`).join(", ");
        const buttons = solids.length ? ["Export STEP without meshes", "Export STL instead", "Cancel"] : ["Export STL instead", "Cancel"];
        const choice = await window.yddd.ask({
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
    // Solids OpenCascade finds broken or open, meshes with gaps: say so first (Cancel selects them).
    const problems = this.printProblems(bodies);
    if (problems.length) {
      const one = problems.length === 1;
      const choice = await window.yddd.ask({
        message: one ? `"${problems[0].body.name}" may not print` : `${problems.length} objects may not print`,
        detail: `${problems.map((p) => `"${p.body.name}": ${p.why}`).join("\n")}\n\nA slicer may refuse ${one ? "it" : "them"} or print ${one ? "it" : "them"} wrong.`,
        buttons: ["Export anyway", "Cancel"],
      });
      if (choice !== 0) {
        this.setMode("body");
        this.setSelection(problems.map((p) => ({ kind: "body", body: p.body.id, id: 0 })));
        return;
      }
    }
    const shapes = bodies.map((b) => b.shape);
    let quality: StlQuality | null = { tolerance: 0.02, angle: 8 };
    if (kind !== "step" && shapes.some(notMesh)) {
      // Only solids are meshed at a chosen quality; meshes are written as they are.
      quality = await this.stlQualityDialog(shapes as (Solid | TriMesh)[], kind.toUpperCase());
      if (!quality) return;
    }
    try {
      let buf: ArrayBuffer | Uint8Array;
      if (this.bgKernel.ready) {
        // Written in the background kernel: the app stays live meanwhile (a fine STL of a big model takes a while)
        const item = (b: Body): JobShape => (b.kind === "mesh" ? { mesh: b.shape.positions } : { brep: serializeShape(b.shape as Shape) });
        const job: KernelJob =
          kind === "step" ? { op: "exportStep", items: bodies.map((b) => ({ brep: serializeShape(b.shape as Shape), name: b.name })) }
          : kind === "3mf" ? { op: "export3mf", items: bodies.map((b) => ({ ...item(b), name: b.name })), quality: quality! }
          : { op: "exportStl", items: bodies.map(item), quality: quality! };
        this.toast(`Exporting ${kind.toUpperCase()}…`);
        buf = (await this.bgKernel.run(job)).data;
      } else {
        buf =
          kind === "step" ? await exportStep(shapes.filter(notMesh).map((shape, i) => ({ shape, name: bodies[i].name })))
          : kind === "3mf" ? await write3mf(bodies.map((b) => ({ name: b.name, mesh: meshForExport(b.shape as Solid | TriMesh, quality!) })))
          : await exportStl(shapes as (Solid | TriMesh)[], quality!);
      }
      const base = this.doc.filePath?.split(/[\\/]/).pop()?.replace(/\.yddd$/, "") ?? "model";
      const path = await window.yddd.saveFile({
        title: `Export ${kind.toUpperCase()}`,
        defaultPath: `${base}.${kind}`,
        filters: kind === "step" ? [{ name: "STEP", extensions: ["step", "stp"] }] : kind === "3mf" ? [{ name: "3MF", extensions: ["3mf"] }] : [{ name: "STL", extensions: ["stl"] }],
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
    (window as unknown as { ydddApp: App }).ydddApp = app; // handy for debugging in DevTools
    (window as unknown as { ydddKernel: object }).ydddKernel = { isValidShape, serializeShape, deserialize, rotateShape, translateShape, scaleShape, pushPull, makeCylinder, makeCone, pointCenter, pullToPoint, solidTips, roundTip, tipRadiusMax, makeBox, importStl, parseStl, exportStl, importStep, exportStep, solidVolume, faceInfo, booleanOp, tessellate, splitFaceByLine, makeCircleFace, makeRectFace, makePolygonFace, makeTextFaces, loadTextFont, BUILT_IN_FONTS, boxFromFace, boxLid, offsetRing, roundSome, meshForExport, write3mf, revolveFace, extrudeFace, makeSphereAt, sketchPath, filletEdges, chamferEdges, shellSolid, splitByPlane, roundRim, resizeRounds, fillRounds, holeAt, fillHoles, resizeHoles }; // used by the smoke test and npm run bench:ops
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
