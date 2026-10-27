/** The toolbar's groups and buttons, the recent-commands strip, and the status bar's mode hints. */
import type { SelMode } from "./viewport";

export interface ToolbarItem {
  cmd: string;
  icon: string;
  label: string;
}

export const TOOLBAR: { title: string; items: ToolbarItem[]; drawer?: boolean }[] = [
  {
    title: "Select",
    items: [
      { cmd: "mode.body", icon: "solid", label: "Solid" },
      { cmd: "mode.face", icon: "face", label: "Face" },
      { cmd: "mode.edge", icon: "edge", label: "Edge" },
    ],
  },
  {
    title: "Solid",
    drawer: true,
    items: [
      { cmd: "tool.box", icon: "box", label: "Box" },
      { cmd: "tool.cylinder", icon: "cylinder", label: "Cylinder" },
      { cmd: "tool.sphere", icon: "sphere", label: "Sphere" },
      { cmd: "tool.cone", icon: "cone", label: "Cone" },
    ],
  },
  {
    title: "Face",
    drawer: true,
    items: [
      { cmd: "tool.rectangle", icon: "rectangle", label: "Rectangle" },
      { cmd: "tool.circle", icon: "circle", label: "Circle" },
      { cmd: "tool.polygon", icon: "polygon", label: "Polygon" },
      { cmd: "tool.text", icon: "text", label: "Text" },
      { cmd: "tool.sketch", icon: "sketch", label: "Sketch" },
    ],
  },
  {
    title: "Modify",
    drawer: true,
    items: [
      { cmd: "op.pushpull", icon: "pushpull", label: "Push/Pull" },
      { cmd: "op.fillet", icon: "fillet", label: "Fillet" },
      { cmd: "op.chamfer", icon: "chamfer", label: "Chamfer" },
      { cmd: "op.shell", icon: "shell", label: "Shell" },
      { cmd: "op.offset", icon: "offset", label: "Offset" },
      { cmd: "op.revolve", icon: "revolve", label: "Revolve" },
      { cmd: "edit.circular", icon: "circular", label: "Circular copy" },
      { cmd: "edit.mirror", icon: "mirror", label: "Mirror" },
      { cmd: "op.sweep", icon: "sweep", label: "Sweep" },
      { cmd: "op.cut", icon: "cut", label: "Cut by guide or axis" },
      { cmd: "op.splitFace", icon: "splitFace", label: "Split face by guide" },
    ],
  },
  {
    title: "Boolean",
    drawer: true,
    items: [
      { cmd: "bool.union", icon: "union", label: "Union" },
      { cmd: "bool.subtract", icon: "subtract", label: "Subtract" },
      { cmd: "bool.intersect", icon: "intersect", label: "Intersect" },
    ],
  },
  {
    title: "Transform",
    drawer: true,
    items: [
      { cmd: "xf.move", icon: "move", label: "Move" },
      { cmd: "xf.moveFrom", icon: "moveFrom", label: "Move from point" },
      { cmd: "xf.rotate", icon: "rotate", label: "Rotate" },
      { cmd: "xf.scale", icon: "scale", label: "Scale" },
      { cmd: "xf.repeat", icon: "repeat", label: "Repeat last" },
      { cmd: "edit.duplicate", icon: "duplicate", label: "Duplicate" },
    ],
  },
  {
    title: "Measure",
    items: [
      { cmd: "tool.measure", icon: "measure", label: "Measure" },
      { cmd: "tool.divideFace", icon: "pencil", label: "Divide face" },
      { cmd: "tool.guide", icon: "guide", label: "Guide line" },
    ],
  },
  {
    title: "History",
    items: [
      { cmd: "edit.undo", icon: "undo", label: "Undo" },
      { cmd: "edit.redo", icon: "redo", label: "Redo" },
    ],
  },
  {
    title: "View",
    drawer: true,
    items: [
      { cmd: "view.fit", icon: "fit", label: "Fit" },
      { cmd: "view.iso", icon: "iso", label: "Iso" },
      { cmd: "view.top", icon: "top", label: "Top" },
      { cmd: "view.front", icon: "front", label: "Front" },
      { cmd: "view.right", icon: "right", label: "Right" },
    ],
  },
  {
    title: "X-ray",
    items: [{ cmd: "view.xray", icon: "xray", label: "X-ray" }],
  },
];

/** Commands that work during a sketch (anything else waits for Done / Cancel). */
export const SKETCH_COMMANDS = new Set(["view.fit", "view.fitSelection", "view.xray", "view.pro", "help.shortcuts", "help.keys"]);
/** Edge mode's pointer: the arrow with a small "E" by it. */
export const EDGE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><path d="M2 2 L2 19 L6.5 15 L9.5 22 L12.5 20.7 L9.6 14 L15.5 14 Z" fill="#fff" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/>` +
    `<text x="16" y="26" font-family="sans-serif" font-size="12" font-weight="bold" fill="#ffe066" stroke="#000" stroke-width="2.5" paint-order="stroke">E</text></svg>`,
)}") 2 2, default`;
export const TOOLBAR_ITEMS = new Map(TOOLBAR.flatMap((g) => g.items.map((it) => [it.cmd, it] as const)));
/** Toolbar commands that go into the recent strip (mode switches, undo/redo, views, X-ray and Delete have their own keys / buttons). */
export const NOT_RECENT = new Set(["Select", "History", "View", "X-ray"]);
export const RECENT_ITEMS = new Map(TOOLBAR.filter((g) => !NOT_RECENT.has(g.title)).flatMap((g) => g.items.map((it) => [it.cmd, it] as const)));
export const RECENT_MAX = 10;
/** v2: the strip saved before "tool.line" became "tool.divideFace" is dropped (see loadRecent). */
export const RECENT_KEY = "yddd.recentCmds.v2";
export const RECENT_KEY_OLD = "yddd.recentCmds";
/** The strip's commands, least recently used first (which slot a new command takes over). */
export const RECENT_USE_KEY = "yddd.recentUse";
export function loadRecent(): string[] {
  localStorage.removeItem(RECENT_KEY_OLD);
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((c) => RECENT_ITEMS.has(c)).slice(-RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export const MODE_HINTS: Record<SelMode, string> = {
  body: "Solid mode: click to select solids (click again → face / edge), Shift+click to add.  Middle-drag or Alt+drag orbit · Shift+drag pan · Wheel / two-finger slide zoom",
  face: "Face mode: click faces (P push/pull, H shell; a flat face's centre dot, then G: a cone / pyramid), click a selected face's edge → Edge mode.  Shift+click to add · Right-click a solid → Solid mode",
  edge: "Edge mode: click edges (F fillet, Shift+F chamfer, Shift+D guide line from edge — a closed loop of edges: a face copy).  Shift+click to add · Right-click a solid → Solid mode",
};
