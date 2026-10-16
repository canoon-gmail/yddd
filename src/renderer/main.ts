/**
 * Y3D application controller: wires the document, viewport, tools,
 * operation panel, outliner, file I/O, keyboard shortcuts and native menu.
 */
import "./style.css";
import * as THREE from "three";
import {
  initKernel,
  errorMessage,
  filletEdges,
  chamferEdges,
  pushPull,
  shellSolid,
  booleanOp,
  translateShape,
  rotateShape,
  cloneShape,
  serializeShape,
  deserialize,
  exportStep,
  exportStl,
  importStep,
  boundingSize,
  findFace,
  extrudeFace,
  seamEdgeIds,
  kindOf,
  faceAxis,
  type V3,
  makeBox,
  makeCylinder,
  type Frame,
  type BodyKind,
  type BooleanOp,
  type Shape,
  type Solid,
} from "./kernel";
import { Doc, type Body } from "./document";
import { Viewport, sameItem, type SelItem, type SelMode, type TransformResult } from "./viewport";
import { BoxTool, CylinderTool, SphereTool, PolygonTool, PointMoveTool, type Tool, type ToolHost } from "./tools";
import { ICONS } from "./icons";

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
  type?: "number" | "checkbox";
}

/** Result of a parametric operation: what to preview and how to commit it. */
interface OpOutcome {
  /** Shapes to preview, keyed by the body they replace (unknown/negative keys = new bodies). */
  ghost: Map<number, Shape>;
  /** Apply to the document. Returns the body ids to select afterwards. */
  commit(): { select: number[]; solidMode?: boolean };
}

interface OpSpec {
  title: string;
  label: string;
  fields: OpField[];
  compute(values: Record<string, number>): OpOutcome;
  remember?(values: Record<string, number>): void;
  /** Mouse-drag control: moving the mouse along `dir` (through `origin`) changes field `key`. */
  drag?: { origin: V3; dir: V3; key: string };
}

interface ToolbarItem {
  cmd: string;
  icon: string;
  label: string;
  key?: string;
}

const TOOLBAR: { title: string; items: ToolbarItem[] }[] = [
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
    items: [
      { cmd: "tool.box", icon: "box", label: "Box", key: "B" },
      { cmd: "tool.cylinder", icon: "cylinder", label: "Cylinder", key: "C" },
      { cmd: "tool.sphere", icon: "sphere", label: "Sphere", key: "S" },
    ],
  },
  {
    title: "Face",
    items: [
      { cmd: "tool.rectangle", icon: "rectangle", label: "Rectangle", key: "Q" },
      { cmd: "tool.circle", icon: "circle", label: "Circle", key: "O" },
      { cmd: "tool.polygon", icon: "polygon", label: "Polygon", key: "N" },
    ],
  },
  {
    title: "Modify",
    items: [
      { cmd: "op.pushpull", icon: "pushpull", label: "Push/Pull", key: "P" },
      { cmd: "op.fillet", icon: "fillet", label: "Fillet", key: "F" },
      { cmd: "op.chamfer", icon: "chamfer", label: "Chamfer", key: "Shift+F" },
      { cmd: "op.shell", icon: "shell", label: "Shell", key: "T" },
    ],
  },
  {
    title: "Boolean",
    items: [
      { cmd: "bool.union", icon: "union", label: "Union", key: "+ / Shift+U" },
      { cmd: "bool.subtract", icon: "subtract", label: "Subtract", key: "− / Shift+S" },
      { cmd: "bool.intersect", icon: "intersect", label: "Intersect", key: "Shift+I" },
    ],
  },
  {
    title: "Transform",
    items: [
      { cmd: "xf.move", icon: "move", label: "Move", key: "G" },
      { cmd: "xf.moveFrom", icon: "move", label: "Move from point", key: "Shift+G" },
      { cmd: "xf.rotate", icon: "rotate", label: "Rotate", key: "R" },
      { cmd: "edit.duplicate", icon: "duplicate", label: "Duplicate", key: "Ctrl+D" },
      { cmd: "edit.delete", icon: "delete", label: "Delete", key: "Del" },
    ],
  },
  {
    title: "History",
    items: [
      { cmd: "edit.undo", icon: "undo", label: "Undo", key: "Ctrl+Z" },
      { cmd: "edit.redo", icon: "redo", label: "Redo", key: "Ctrl+Shift+Z" },
    ],
  },
  {
    title: "View",
    items: [
      { cmd: "view.fit", icon: "fit", label: "Fit", key: "Home" },
      { cmd: "view.iso", icon: "iso", label: "Iso", key: "5" },
      { cmd: "view.top", icon: "top", label: "Top", key: "7" },
      { cmd: "view.front", icon: "front", label: "Front", key: "Num 1" },
      { cmd: "view.right", icon: "right", label: "Right", key: "Num 3" },
    ],
  },
];

const KEYMAP: Record<string, string> = {
  "1": "mode.body",
  "2": "mode.face",
  "3": "mode.edge",
  b: "tool.box",
  c: "tool.cylinder",
  s: "tool.sphere",
  n: "tool.polygon",
  q: "tool.rectangle",
  o: "tool.circle",
  p: "op.pushpull",
  f: "op.fillet",
  "Shift+F": "op.chamfer",
  t: "op.shell",
  g: "xf.move",
  "Shift+G": "xf.moveFrom",
  r: "xf.rotate",
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
  "=": "bool.union", // unshifted "+" key
  "-": "bool.subtract",
  "Shift+I": "bool.intersect",
  "Shift+V": "view.menu",
  "?": "help.shortcuts",
};

const MODE_HINTS: Record<SelMode, string> = {
  body: "Solid mode: click to select solids, Shift+click to add.  Middle-drag orbit · Shift+Left-drag pan · Wheel zoom",
  face: "Face mode: click faces (P push/pull, T shell).  Shift+click to add",
  edge: "Edge mode: click edges (F fillet, H chamfer).  Shift+click to add",
};

class App implements ToolHost {
  readonly doc = new Doc();
  readonly viewport: Viewport;

  private mode: SelMode = "body";
  private selection: SelItem[] = [];
  private hover: SelItem | null = null;
  private hidden = new Set<number>();
  private tool: Tool | null = null;
  private op: {
    spec: OpSpec;
    inputs: HTMLInputElement[];
    timer: number;
    result: OpOutcome | null;
    key: string;
    /** Drag reference: line parameter and field value when the mouse first moved. */
    anchor?: { x: number; y: number; v: number };
    dragQueued?: boolean;
  } | null = null;
  private xf: { mode: "translate" | "rotate"; ids: number[] } | null = null;
  private snap = 1;
  private downAt: { x: number; y: number } | null = null;
  private hoverQueued: PointerEvent | null = null;
  private defaults = { fillet: 1, chamfer: 1, pushpullNew: false, shell: 1 };

  private hudEl = $("hud");
  private hudAnchor: THREE.Vector3 | null = null;
  private handleEl = $("op-handle");
  private opPanel = $("op-panel");

  constructor() {
    const container = $("viewport");
    this.viewport = new Viewport(container);
    this.buildToolbar();
    this.bindViewportEvents();
    this.bindKeys();
    this.bindStatusBar();

    this.doc.onChange(() => this.onDocChange());
    window.y3d?.onMenu((cmd) => this.run(cmd));
    // Unsaved-changes prompt on close is handled by the main process (see setDirty);
    // a beforeunload handler would silently block closing in Electron.

    this.onDocChange();
    this.viewport.fit();
  }

  // ================================================================ ToolHost

  snapStep(e: { ctrlKey: boolean } | null): number {
    return e?.ctrlKey ? 0 : this.snap;
  }

  hint(text: string): void {
    $("status-hint").textContent = text;
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

  /** Place the op drag handle at origin + dir * value, rotated to the axis' screen direction. */
  private positionHandle(): void {
    const drag = this.op?.spec.drag;
    const input = drag && this.op!.inputs.find((i) => i.dataset.key === drag.key);
    if (!drag || !input) {
      this.handleEl.hidden = true;
      return;
    }
    const O = new THREE.Vector3(...drag.origin), D = new THREE.Vector3(...drag.dir).normalize();
    const P = O.clone().addScaledVector(D, Number(input.value) || 0);
    const s = this.viewport.toScreen(P), s1 = this.viewport.toScreen(P.clone().add(D));
    const r = $("viewport").getBoundingClientRect();
    const ang = Math.atan2(s1.y - s.y, s1.x - s.x) * (180 / Math.PI) + 90;
    this.handleEl.style.left = `${s.x - r.left}px`;
    this.handleEl.style.top = `${s.y - r.top}px`;
    this.handleEl.style.transform = `rotate(${ang}deg)`;
    this.handleEl.hidden = false;
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

  // ================================================================ commands

  run(cmd: string): void {
    try {
      this.dispatch(cmd);
    } catch (e) {
      this.fail(e);
    }
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

      case "op.pushpull": return this.opPushPull();
      case "op.fillet": return this.opEdges("fillet");
      case "op.chamfer": return this.opEdges("chamfer");
      case "op.shell": return this.opShell();

      case "bool.union": return this.boolean("union");
      case "bool.subtract": return this.boolean("subtract");
      case "bool.intersect": return this.boolean("intersect");

      case "xf.move": return this.startTransform("translate");
      case "xf.rotate": return this.startTransform("rotate");
      case "xf.moveFrom": return this.startPointMove();

      case "edit.undo": return this.undoRedo("undo");
      case "edit.redo": return this.undoRedo("redo");
      case "edit.delete": return this.deleteSelected();
      case "edit.duplicate": return this.duplicate();
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
      case "file.exportStep": void this.fileExport("step"); return;
      case "file.exportStl": void this.fileExport("stl"); return;

      case "help.shortcuts": return this.toggleHelp();
      case "view.menu": return this.showViewMenu();
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
    if (this.xf) {
      const ids = this.selectedBodyIds();
      if (ids.length) this.startTransform(this.xf.mode, true);
      else this.stopTransform();
    }
  }

  private selectedBodyIds(): number[] {
    return [...new Set(this.selection.map((s) => s.body))];
  }

  private click(e: PointerEvent): void {
    const pick = this.viewport.pick(e.clientX, e.clientY, this.mode);
    const item: SelItem | null = pick ? { kind: pick.kind, body: pick.body, id: pick.id } : null;
    if (!item) {
      if (!e.shiftKey) this.setSelection([]);
      return;
    }
    if (e.shiftKey || e.ctrlKey) {
      const exists = this.selection.some((s) => sameItem(s, item));
      this.setSelection(exists ? this.selection.filter((s) => !sameItem(s, item)) : [...this.selection, item]);
    } else {
      this.setSelection([item]);
    }
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
    c.addEventListener("pointermove", (e) => {
      if (this.tool) {
        this.tool.move(e);
        return;
      }
      this.updateCoords(e);
      if (this.op) {
        return;
      }
      // Coalesce hover picking to one per frame.
      if (!this.hoverQueued) requestAnimationFrame(() => this.processHover());
      this.hoverQueued = e;
    });
    c.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (this.tool) {
        this.tool.down(e);
        return;
      }
      if (this.op?.spec.drag && !e.shiftKey) {
        this.applyOp(); // click in the viewport confirms the dragged value
        return;
      }
      if (this.viewport.gizmoHot || this.op) return;
      this.downAt = { x: e.clientX, y: e.clientY };
    });
    // Op drag handle: press on it and drag to change the value.
    const h = this.handleEl;
    h.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !this.op?.spec.drag) return;
      e.preventDefault();
      e.stopPropagation();
      h.setPointerCapture(e.pointerId);
      h.classList.add("dragging");
      this.op.anchor = undefined;
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
      h.classList.remove("dragging");
      if (this.op) this.op.anchor = undefined;
    };
    h.addEventListener("pointerup", release);
    h.addEventListener("pointercancel", release);
    h.addEventListener("wheel", (e) => c.dispatchEvent(new WheelEvent("wheel", e)), { passive: true });
    c.addEventListener("pointerup", (e) => {
      if (e.button !== 0 || !this.downAt) return;
      const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y);
      this.downAt = null;
      if (moved < 5) this.click(e);
    });
    c.addEventListener("pointerleave", () => {
      if (this.hover) {
        this.hover = null;
        this.viewport.setHighlight(this.selection, null);
      }
    });
    c.addEventListener("wheel", () => requestAnimationFrame(() => this.positionHud()), { passive: true });
    c.addEventListener("pointermove", () => this.positionHud());
  }

  private processHover(): void {
    const e = this.hoverQueued;
    this.hoverQueued = null;
    if (!e || this.tool || this.op || this.viewport.gizmoHot) return;
    const pick = this.viewport.pick(e.clientX, e.clientY, this.mode);
    const item: SelItem | null = pick ? { kind: pick.kind, body: pick.body, id: pick.id } : null;
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
      if (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA") return;
      if (!$("help").hidden) {
        if (e.key === "Escape" || e.key === "?" || e.key === "F1") this.toggleHelp();
        return;
      }
      if (this.tool && this.tool.key(e)) {
        e.preventDefault();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (this.tool) this.endTool();
        else if (this.op) this.cancelOp();
        else if (this.xf) this.stopTransform();
        else this.setSelection([]);
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return; // handled by native menu accelerators
      const combo = e.shiftKey && e.key.length === 1 && /[a-z]/i.test(e.key) ? `Shift+${e.key.toUpperCase()}` : e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const cmd = KEYMAP[e.code] ?? KEYMAP[combo] ?? KEYMAP[e.key];
      if (cmd) {
        e.preventDefault();
        this.run(cmd);
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
    panel.innerHTML = `<h4>${spec.title}</h4>`;
    const inputs = spec.fields.map((f) => {
      const label = document.createElement("label");
      label.textContent = f.label;
      const input = document.createElement("input");
      if (f.type === "checkbox") {
        input.type = "checkbox";
        input.checked = f.value !== 0;
        label.classList.add("check");
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
      input.addEventListener(input.type === "checkbox" ? "change" : "input", () => this.scheduleOpPreview());
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.applyOp();
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.cancelOp();
        }
      });
      if (input.type === "number") input.addEventListener("wheel", (e) => {
        e.preventDefault();
        const step = Number(input.step) * (e.shiftKey ? 10 : 1);
        input.value = fmt(Number(input.value) + (e.deltaY < 0 ? step : -step));
        this.scheduleOpPreview();
      });
    }
    this.hover = null;
    this.hint(spec.drag
      ? `${spec.title}: drag the blue handle to set the distance (Ctrl = no snap) · click or Enter apply · Esc cancel`
      : `${spec.title}: adjust values (mouse wheel over a field to scrub) · Enter apply · Esc cancel`);
    this.renderToolbarState();
    this.previewOp();
    this.positionHandle();
    const first = inputs.find((i) => i.type === "number") ?? inputs[0];
    first?.focus();
    if (first?.type === "number") first.select();
  }

  /** Map mouse movement along the drag axis to the op's value (relative to where the drag started). */
  private opDrag(e: PointerEvent): void {
    const op = this.op!;
    const drag = op.spec.drag!;
    const input = op.inputs.find((i) => i.dataset.key === drag.key);
    if (!input) return;
    const O = new THREE.Vector3(...drag.origin), D = new THREE.Vector3(...drag.dir).normalize();
    // Screen-space mapping: mouse movement projected onto the axis' on-screen direction,
    // so the result doesn't depend on where the pointer is (e.g. started from a toolbar icon).
    const s0 = this.viewport.toScreen(O), s1 = this.viewport.toScreen(O.clone().addScaledVector(D, 10));
    const ax = s1.x - s0.x, ay = s1.y - s0.y;
    const pxPer10 = Math.hypot(ax, ay);
    if (pxPer10 < 5) return; // looking straight down the axis
    if (!op.anchor) {
      op.anchor = { x: e.clientX, y: e.clientY, v: Number(input.value) || 0 };
      return;
    }
    const t = (((e.clientX - op.anchor.x) * ax + (e.clientY - op.anchor.y) * ay) / pxPer10) * (10 / pxPer10);
    let v = op.anchor.v + t;
    const step = this.snapStep(e);
    if (step > 0) v = Math.round(v / step) * step;
    if (fmt(v) === input.value) return;
    input.value = fmt(v);
    this.hud(`${fmt(v)} mm`, O.clone().addScaledVector(D, v));
    if (!op.dragQueued) {
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
    for (const i of this.op!.inputs) values[i.dataset.key!] = i.type === "checkbox" ? (i.checked ? 1 : 0) : Number(i.value);
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
      const result = op.spec.compute(values);
      op.result = result;
      op.key = key;
      err.textContent = "";
      this.viewport.showGhost(result.ghost);
      return result;
    } catch (e) {
      op.result = null;
      op.key = "";
      err.textContent = errorMessage(e);
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
    this.closeOpPanel();
    const { select, solidMode } = result.commit();
    if (solidMode) this.setMode("body");
    this.setSelection(this.mode === "body" ? select.map((id) => ({ kind: "body", body: id, id: 0 })) : []);
    this.toast(`${op.spec.label} applied`);
  }

  private cancelOp(): void {
    if (!this.op) return;
    clearTimeout(this.op.timer);
    this.closeOpPanel();
    this.refreshSelection();
  }

  private closeOpPanel(): void {
    this.op = null;
    this.hud(null);
    this.handleEl.hidden = true;
    this.opPanel.hidden = true;
    this.opPanel.innerHTML = "";
    this.viewport.clearGhost();
    this.renderToolbarState();
  }

  /** Outcome that replaces body shapes in place (fillet, shell, join push/pull...). */
  private replaceOutcome(shapes: Map<number, Shape>, label: string): OpOutcome {
    return {
      ghost: shapes,
      commit: () => {
        this.doc.replaceShapes(shapes, label);
        return { select: [...shapes.keys()] };
      },
    };
  }

  /** The body's shape as a solid, or a friendly error for flat faces. */
  private solidOf(id: number, action: string): Solid {
    const b = this.doc.get(id)!;
    if (b.kind === "face") throw new Error(`${action} needs a solid — "${b.name}" is a flat face (Push/Pull it first)`);
    return b.shape as Solid;
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
    if (!target) {
      this.toast("Push/Pull: select one face (Face mode, key 2) or one flat face object", "error");
      return;
    }
    const { bodyId, faceId } = target;
    const body = this.doc.get(bodyId)!;
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
              const nb = this.doc.makeBody(solid, "Solid");
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
              const nb = this.doc.makeBody(solid, "Solid");
              this.doc.commit([...this.doc.bodies, nb], "Extrude face");
              return { select: [nb.id], solidMode: true };
            },
          };
        }
        return this.replaceOutcome(new Map([[bodyId, pushPull(this.solidOf(bodyId, "Push/Pull"), faceId, d)]]), "Push/Pull");
      },
      remember: ({ d, newBody }) => {
        this.defaults.pushpullNew = !!newBody;
      },
      drag,
    });
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
    this.startOp({
      title,
      label: title,
      fields: [{ key: "r", label: isFillet ? "Radius (mm)" : "Distance (mm)", value: isFillet ? this.defaults.fillet : this.defaults.chamfer, step: 0.1, min: 0 }],
      compute: ({ r }) => {
        if (r <= 0) throw new Error("value must be greater than 0");
        const out = new Map<number, Shape>();
        for (const [id, edges] of perBody) {
          const shape = this.solidOf(id, title);
          out.set(id, isFillet ? filletEdges(shape, edges, r) : chamferEdges(shape, edges, r));
        }
        return this.replaceOutcome(out, title);
      },
      remember: ({ r }) => {
        if (isFillet) this.defaults.fillet = r;
        else this.defaults.chamfer = r;
      },
    });
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
    this.applyBoolean(op, targetId, toolIds, label);
    this.setMode("body");
    this.setSelection([{ kind: "body", body: targetId, id: 0 }]);
  }

  /** Combine `toolIds` into `targetId` (target keeps its id/name); one undo step. Throws on failure. */
  private applyBoolean(op: BooleanOp, targetId: number, toolIds: number[], label: string): void {
    const target = this.doc.get(targetId)!;
    const result = booleanOp(op, target.shape as Solid, toolIds.map((id) => this.doc.get(id)!.shape as Solid));
    if (result.faces.length === 0) throw new Error("result is empty (the solids do not overlap?)");
    const removed = new Set(toolIds);
    const next = this.doc.bodies.filter((b) => !removed.has(b.id)).map((b) => (b.id === targetId ? { ...b, shape: result } : b));
    this.doc.commit(next, label);
    this.toast(`${label}: ${target.name}`);
  }

  /** A + key + B (+ C ...): each click on another solid applies the operation to A right away. */
  private pickBooleanTool(op: BooleanOp, targetId: number, label: string): void {
    const target = this.doc.get(targetId);
    if (!target) return;
    const verb = op === "subtract" ? "subtract from" : op === "union" ? "join with" : "intersect with";
    let count = 0;
    const msg = () =>
      `${label}: click a solid to ${verb} "${target.name}"` + (count ? ` (${count} done) · keep clicking for more` : "") +
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
    const tool: Tool = {
      name: label,
      move: (e) => show(pickAt(e)),
      down: (e) => {
        const id = pickAt(e);
        if (id === null) return finish();
        const b = this.doc.get(id);
        if (b?.kind === "face") {
          this.toast(`Booleans work on solids — "${b.name}" is a flat face. Push/Pull it first.`, "error");
          return;
        }
        try {
          this.applyBoolean(op, targetId, [id], label);
          count++;
        } catch (err) {
          this.fail(err);
        }
        show(null);
        this.hint(msg());
      },
      key: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          finish();
          return true;
        }
        return false;
      },
      dispose: () => {},
    };
    this.setMode("body");
    this.startTool(tool);
    this.viewport.canvas.style.cursor = "pointer";
    show(null);
    this.hint(msg());
    this.toast(`${label} tool: click solids to ${verb} "${target.name}" · Esc to finish`);
  }

  // ================================================================ transforms

  private startTransform(mode: "translate" | "rotate", keep = false): void {
    if (!keep) {
      this.endTool();
      this.cancelOp();
    }
    const ids = this.selectedBodyIds();
    if (!ids.length) {
      this.toast(`${mode === "translate" ? "Move" : "Rotate"}: select one or more solids first`, "error");
      return;
    }
    this.xf = { mode, ids };
    this.viewport.startTransform(mode, ids, this.snap, (r) => this.applyTransform(r));
    this.renderToolbarState();
    this.hint(`${mode === "translate" ? "Move" : "Rotate"}: drag the gizmo handles (hold Ctrl to snap to grid / 15° / points) · Esc to finish`);
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
        const shapes = new Map<number, Shape>();
        for (const id of ids) {
          const b = this.doc.get(id);
          if (b) shapes.set(id, translateShape(b.shape, d));
        }
        this.doc.replaceShapes(shapes, "Move");
      }).start(),
    );
  }

  private applyTransform(r: TransformResult): void {
    if (!this.xf) return;
    const shapes = new Map<number, Shape>();
    for (const id of this.xf.ids) {
      const b = this.doc.get(id);
      if (!b) continue;
      shapes.set(id, r.type === "translate" ? translateShape(b.shape, r.vector) : rotateShape(b.shape, r.angleDeg, r.center, r.axis));
    }
    const mode = this.xf.mode;
    this.doc.replaceShapes(shapes, mode === "translate" ? "Move" : "Rotate");
    this.startTransform(mode, true); // keep the gizmo on the moved bodies
  }

  private stopTransform(): void {
    if (!this.xf) return;
    this.xf = null;
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
  }

  // ================================================================ document changes

  private onDocChange(): void {
    this.viewport.sync(this.doc.bodies);
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
    for (const group of TOOLBAR) {
      const g = document.createElement("div");
      g.className = "tb-group";
      const btns = document.createElement("div");
      btns.className = "tb-buttons";
      for (const it of group.items) {
        const b = document.createElement("button");
        b.className = "tb-btn";
        b.dataset.cmd = it.cmd;
        b.title = it.key ? `${it.label} (${it.key})` : it.label;
        b.innerHTML = `${ICONS[it.icon]}<span>${it.label}</span>`;
        b.addEventListener("click", () => {
          b.blur();
          this.run(it.cmd);
        });
        btns.appendChild(b);
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
      const map: Record<string, string> = { "Push/Pull": "op.pushpull", Fillet: "op.fillet", Chamfer: "op.chamfer", Shell: "op.shell" };
      active.add(map[this.op.spec.label]);
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>(".tb-btn")) {
      const cmd = b.dataset.cmd!;
      b.classList.toggle("active", active.has(cmd));
      if (cmd === "edit.undo") b.disabled = !this.doc.canUndo;
      if (cmd === "edit.redo") b.disabled = !this.doc.canRedo;
    }
  }

  private olRows = new Map<number, { row: HTMLElement; body: Body; hidden: boolean }>();
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
      el.addEventListener("click", (e) => {
        const b = bodyOf(e);
        if (!b) return;
        const t = e.target as HTMLElement;
        if (t.closest(".ol-eye")) {
          if (this.hidden.has(b.id)) this.hidden.delete(b.id);
          else this.hidden.add(b.id);
          this.viewport.setHidden(this.hidden);
          this.renderOutliner();
          return;
        }
        if (t.closest("input")) return;
        this.setMode("body");
        const item: SelItem = { kind: "body", body: b.id, id: 0 };
        if (e.shiftKey || e.ctrlKey) {
          const exists = this.selection.some((s) => sameItem(s, item));
          this.setSelection(exists ? this.selection.filter((s) => !sameItem(s, item)) : [...this.selection, item]);
        } else this.setSelection([item]);
      });
      el.addEventListener("dblclick", (e) => {
        const b = bodyOf(e);
        const cell = (e.target as HTMLElement).closest(".ol-name");
        if (b && cell) this.rename(b, cell);
      });
    }
    const selected = new Set(this.selection.map((s) => s.body));
    if (!this.doc.bodies.length) {
      this.olRows.clear();
      el.innerHTML = `<div class="ol-empty">No bodies yet.<br>Press <kbd>B</kbd> to draw a box.</div>`;
      return;
    }
    el.querySelector(".ol-empty")?.remove();
    const live = new Set<number>();
    let prev: Element | null = null;
    for (const b of this.doc.bodies) {
      live.add(b.id);
      const hidden = this.hidden.has(b.id);
      let entry = this.olRows.get(b.id);
      if (!entry || entry.body !== b || entry.hidden !== hidden) {
        const row = entry?.row ?? document.createElement("div");
        row.className = "ol-row";
        row.dataset.id = String(b.id);
        row.innerHTML = `<span class="ol-swatch${b.kind === "face" ? " face" : ""}" title="${b.kind === "face" ? "Flat face" : "Solid"}"></span><span class="ol-name">${escapeHtml(b.name)}</span><button class="ol-eye" title="Show/hide">${hidden ? ICONS.eyeOff : ICONS.eye}</button>`;
        entry = { row, body: b, hidden };
        this.olRows.set(b.id, entry);
      }
      const row = entry.row;
      row.classList.toggle("selected", selected.has(b.id));
      row.classList.toggle("hidden", hidden);
      // Keep DOM order in sync with document order (no-op when already correct).
      const want: Element | null = prev ? prev.nextElementSibling : el.firstElementChild;
      if (want !== row) el.insertBefore(row, want);
      prev = row;
    }
    for (const [id, entry] of this.olRows) {
      if (!live.has(id)) {
        entry.row.remove();
        this.olRows.delete(id);
      }
    }
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
        tip(`Solids: <kbd>B</kbd> box · <kbd>C</kbd> cylinder · <kbd>S</kbd> sphere<br>Faces: <kbd>Q</kbd> rectangle · <kbd>O</kbd> circle · <kbd>N</kbd> polygon → <kbd>P</kbd> push/pull<br><kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> solid / face / edge mode<br><kbd>F1</kbd> all shortcuts`);
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
          rows.unshift(["Name", escapeHtml(b.name)], ["Type", b.kind === "face" ? "Flat face" : "Solid"]);
          rows.push(["Size", `${fmt(w)} × ${fmt(d)} × ${fmt(h)}`], ["Faces", String(b.shape.faces.length)], ["Edges", String(b.shape.edges.length - seamEdgeIds(b.shape).size)]);
        }
        hints = b?.kind === "face"
          ? `<kbd>P</kbd> push/pull into a new solid · <kbd>G</kbd> move · <kbd>R</kbd> rotate`
          : `<kbd>G</kbd> move · <kbd>R</kbd> rotate · <kbd>F</kbd> fillet all edges · <kbd>Ctrl+D</kbd> duplicate`;
      } else {
        hints = `<kbd>+</kbd> union · <kbd>−</kbd> subtract · <kbd>Shift+I</kbd> intersect<br>(first selected = target)`;
      }
    } else if (kind === "face") {
      rows.push(["Faces", String(sel.length)]);
      if (sel.length === 1) {
        const b = this.doc.get(sel[0].body);
        const f = b && findFace(b.shape, sel[0].id);
        if (b) rows.push([b.kind === "face" ? "Flat face" : "Solid", escapeHtml(b.name)]);
        if (f) rows.push(["Surface", f.geomType]);
      }
      hints = `<kbd>P</kbd> push/pull (flat face → new solid) · <kbd>T</kbd> shell (opens selected faces)`;
    } else {
      rows.push(["Edges", String(sel.length)]);
      hints = `<kbd>F</kbd> fillet · <kbd>H</kbd> chamfer`;
    }
    el.innerHTML = `<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>` + tip(hints);
  }

  private bindStatusBar(): void {
    const select = $<HTMLSelectElement>("snap-select");
    select.addEventListener("change", () => {
      this.snap = Number(select.value);
      select.blur();
      if (this.xf) this.startTransform(this.xf.mode, true);
    });
  }

  toast(msg: string, kind: "info" | "error" = "info"): void {
    const t = document.createElement("div");
    t.className = `toast ${kind}`;
    t.textContent = msg;
    const box = $("toasts");
    box.appendChild(t);
    while (box.children.length > 4) box.firstElementChild!.remove();
    setTimeout(() => t.remove(), kind === "error" ? 4500 : 2200);
  }

  private toggleHelp(): void {
    const help = $("help");
    if (!help.hidden) {
      help.hidden = true;
      return;
    }
    const rows: [string, string][] = [
      ["Middle-drag", "Orbit view"],
      ["Shift + Left-drag", "Pan view"],
      ["Wheel", "Zoom to cursor"],
      ["1 · 2 · 3", "Selection mode: Solid · Face · Edge"],
      ["Click / Shift+click", "Select / add to selection"],
      ["B · C · S", "Draw solid Box · Cylinder · Sphere (type numbers + Enter for exact sizes)"],
      ["Q · O · N", "Draw flat Rectangle · Circle · Polygon face (then P to push/pull into a solid)"],
      ["[ · ] (Polygon tool)", "Fewer / more sides (3–64)"],
      ["Ctrl (while drawing)", "Temporarily disable grid snapping"],
      ["Ctrl + gizmo drag", "Snap move / rotate (grid, 15°, object points)"],
      ["P", "Push/Pull: flat face → new solid; solid face → modify (or tick “New solid”)"],
      ["F · Shift+F", "Fillet · Chamfer selected edges (or all edges of selected solids)"],
      ["T", "Shell (opens the selected faces)"],
      ["+ · − · Shift+I  (also Shift+U · Shift+S)", "Union · Subtract · Intersect (first selected = target)"],
      ["G · R", "Move · Rotate gizmo"],
      ["Shift+G", "Move from point to point (snap)"],
      ["Ctrl+D", "Duplicate (then move)"],
      ["Del / X", "Delete selected objects"],
      ["Ctrl+Z · Ctrl+Shift+Z", "Undo · Redo"],
      ["Home · .", "Fit all · Fit selection"],
      ["5 · 7 · Num 1 · Num 3", "Iso · Top · Front · Right view"],
      ["Shift+V", "View menu (Top / Front / Right / Iso · V = opposite side, e.g. bottom)"],
      ["Enter · Esc", "Apply · Cancel / clear selection"],
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
  }

  private async fileOpen(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    const file = await window.y3d.openFile({ title: "Open model", filters: [{ name: "Y3D model", extensions: ["y3d"] }], binary: false });
    if (!file) return;
    try {
      const json = JSON.parse(file.data as string) as { format: string; bodies: { name: string; kind?: BodyKind; brep: string }[] };
      if (json.format !== "y3d") throw new Error("not a Y3D file");
      const bodies = json.bodies.map((b) => {
        const shape = deserialize(b.brep);
        return { name: b.name, kind: b.kind ?? kindOf(shape), shape };
      });
      this.endInteractions();
      this.selection = [];
      this.hidden.clear();
      this.doc.reset(bodies, file.path);
      this.viewport.fit();
      this.toast(`Opened ${file.path.split(/[\\/]/).pop()}`);
    } catch (e) {
      this.fail(e);
    }
  }

  private async fileSave(saveAs: boolean): Promise<void> {
    const data = JSON.stringify({
      format: "y3d",
      version: 1,
      units: "mm",
      bodies: this.doc.bodies.map((b) => ({ name: b.name, kind: b.kind, brep: serializeShape(b.shape) })),
    });
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
  }

  /** Stress-test scene: `n` separate solids (alternating boxes / cylinders) on a square grid. */
  loadStressScene(n: number): void {
    const t0 = performance.now();
    const ground: Frame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const cols = Math.ceil(Math.sqrt(n));
    const pitch = 20;
    const bodies: { name: string; kind: BodyKind; shape: Shape }[] = [];
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

  private async fileExport(kind: "step" | "stl"): Promise<void> {
    const ids = this.selectedBodyIds();
    let bodies = ids.length ? this.doc.bodies.filter((b) => ids.includes(b.id)) : this.doc.bodies.filter((b) => !this.hidden.has(b.id));
    if (kind === "stl") {
      const solids = bodies.filter((b) => b.kind === "solid");
      if (solids.length < bodies.length) this.toast("STL skips flat faces (no volume) — exporting solids only");
      bodies = solids;
    }
    if (!bodies.length) {
      this.toast("Nothing to export", "error");
      return;
    }
    try {
      const buf = kind === "step" ? await exportStep(bodies.map((b) => ({ shape: b.shape, name: b.name }))) : await exportStl(bodies.map((b) => b.shape as Solid));
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
    loading.remove();
    const stress = Number(new URLSearchParams(location.search).get("stress"));
    if (stress > 0) app.loadStressScene(Math.min(stress, 50000));
  } catch (e) {
    loading.classList.add("error");
    loading.innerHTML = `<div>Failed to start the geometry kernel:</div><div>${escapeHtml(errorMessage(e))}</div>`;
    console.error(e);
  }
}

void boot();
