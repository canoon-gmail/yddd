/**
 * Sketch (K): draw flat outlines on a plane — a selected flat face, or the ground — with the view
 * turned square to it (orbit off; pan and zoom still work) and a small 3D view in the corner.
 * L lines, A arcs (tangent to the previous segment; the first one: its end point, then a point it
 * passes through — a typed number fixes the arc's radius), R rectangles, C circles. Points snap to the model's corners / midpoints / centres
 * and to the sketch's own points; a line near horizontal / vertical (in the plane) locks onto it;
 * typed numbers + Enter give exact sizes. Clicking the start point closes an outline; Enter or a
 * double-click ends the lines there, open — a path (e.g. for a pipe to follow) — unless both ends lie
 * on one straight edge of an outline (a half circle on a rectangle's side): then it closes along it.
 * Done (button) keeps the closed outlines as flat faces — an outline inside another is a hole — and
 * the open ones as paths;
 * Cancel drops the sketch. Esc only drops the outline being drawn (then switches to Select: click an
 * outline or a path to select it, Shift+click adds, drag moves (typed dx,dy too), J joins — outlines
 * into one face, paths end to end into one path —, Del deletes);
 * Ctrl+Z / Backspace undo a step.
 */
import * as THREE from "three";
import type { Tool, ToolHost } from "./tools";
import { joinFlatFaces, sketchFaces, sketchPath, type Shape, type SketchLoop, type V3, type Wire } from "./kernel";
import { num } from "./format";

/** A point in the sketch plane: [u, v] along the frame's x / y. */
type P = [number, number];
type Seg = { kind: "line"; a: P; b: P } | { kind: "arc"; a: P; m: P; b: P };
/** A closed outline; `g`: its join group (outlines joined with J become one face at Done). */
type Loop = ({ kind: "path"; segs: Seg[] } | { kind: "circle"; c: P; r: number }) & { g?: number };
type Mode = "select" | "line" | "arc" | "rect" | "circle";
/** A selectable part of the sketch: a closed outline or an open path (by index). */
type Item = { kind: "loop" | "open"; i: number };
const sameItem = (a: Item | null, b: Item | null) => !!a && !!b && a.kind === b.kind && a.i === b.i;
/** Select: how near (px) a line must be to pick it. */
const PICK_PX = 6;
/** Select: a press that moves further than this (px) is a drag (moves the selection), else a click. */
const DRAG_PX = 4;

const moveP = (p: P, d: P): P => [p[0] + d[0], p[1] + d[1]];
const moveSeg = (g: Seg, d: P): Seg => (g.kind === "line" ? { kind: "line", a: moveP(g.a, d), b: moveP(g.b, d) } : { kind: "arc", a: moveP(g.a, d), m: moveP(g.m, d), b: moveP(g.b, d) });
const moveLoop = (l: Loop, d: P): Loop => (l.kind === "circle" ? { ...l, c: moveP(l.c, d) } : { ...l, segs: l.segs.map((g) => moveSeg(g, d)) });

export interface SketchFrame {
  origin: THREE.Vector3;
  x: THREE.Vector3;
  y: THREE.Vector3;
  z: THREE.Vector3;
}

const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]];
const mul = (a: P, k: number): P => [a[0] * k, a[1] * k];
const len = (a: P) => Math.hypot(a[0], a[1]);
const dist = (a: P, b: P) => len(sub(a, b));
const dot = (a: P, b: P) => a[0] * b[0] + a[1] * b[1];
const cross = (a: P, b: P) => a[0] * b[1] - a[1] * b[0];
const norm = (a: P): P => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l] : [1, 0];
};
const same = (a: P, b: P) => dist(a, b) < 1e-9;
const TAU = Math.PI * 2;
/** Angle in [0, 2π). */
const wrap = (a: number) => ((a % TAU) + TAU) % TAU;
/** Within ~4° of the plane's horizontal / vertical, a line locks onto it. */
const LOCK_SIN = Math.sin((4 * Math.PI) / 180);
const SNAP_PX = 12;
/** Lines ended (Enter / double-click) this close to their start point (px) close there. */
const NEAR_START_PX = 20;
/** Within this many pixels of a sketch point's X or Y (in the plane), the cursor lines up with it. */
const ALIGN_PX = 8;

/** Centre of the circle through three points, or null if they are in line. */
function center3(a: P, m: P, b: P): P | null {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = dot(a, a), m2 = dot(m, m), b2 = dot(b, b);
  return [(a2 * (m[1] - b[1]) + m2 * (b[1] - a[1]) + b2 * (a[1] - m[1])) / d, (a2 * (b[0] - m[0]) + m2 * (a[0] - b[0]) + b2 * (m[0] - a[0])) / d];
}

/** An arc's centre, radius, start angle and signed sweep (+ = counter-clockwise in the plane). */
function arcGeom(g: Extract<Seg, { kind: "arc" }>): { c: P; r: number; a0: number; sweep: number } | null {
  const c = center3(g.a, g.m, g.b);
  if (!c) return null;
  const ang = (p: P) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const a0 = ang(g.a), a1 = ang(g.b);
  const ccw = cross(sub(g.m, g.a), sub(g.b, g.m)) > 0;
  return { c, r: dist(g.a, c), a0, sweep: ccw ? wrap(a1 - a0) || TAU : -(wrap(a0 - a1) || TAU) };
}

/** Points along a segment, from a (included) to b (left out). */
function segPoints(g: Seg): P[] {
  if (g.kind === "line") return [g.a];
  const k = arcGeom(g);
  if (!k) return [g.a];
  const n = Math.max(6, Math.ceil(Math.abs(k.sweep) / 0.08));
  return Array.from({ length: n }, (_, i) => {
    const t = k.a0 + (k.sweep * i) / n;
    return [k.c[0] + k.r * Math.cos(t), k.c[1] + k.r * Math.sin(t)] as P;
  });
}

/** Direction of travel at the end of a segment. */
function endDir(g: Seg): P {
  if (g.kind === "line") return norm(sub(g.b, g.a));
  const k = arcGeom(g);
  if (!k) return norm(sub(g.b, g.a));
  const r = sub(g.b, k.c);
  return norm(k.sweep > 0 ? [-r[1], r[0]] : [r[1], -r[0]]);
}

/** Arc from `a` leaving in direction `t`, ending at `b` (null when b lies straight ahead). */
function tangentArc(a: P, t: P, b: P): Seg | null {
  const n: P = [-t[1], t[0]], d = sub(b, a), k = dot(d, n);
  if (len(d) < 1e-9 || Math.abs(k) < 1e-9 * len(d)) return null;
  const r = dot(d, d) / (2 * k), c = add(a, mul(n, r));
  const ang = (p: P) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const a0 = ang(a), a1 = ang(b);
  const sweep = r > 0 ? wrap(a1 - a0) : -wrap(a0 - a1);
  const mid = a0 + sweep / 2;
  return { kind: "arc", a, m: [c[0] + Math.abs(r) * Math.cos(mid), c[1] + Math.abs(r) * Math.sin(mid)], b };
}

/** Arc from a to b through p, stored with its middle point. */
function threePointArc(a: P, p: P, b: P): Seg | null {
  if (same(a, b) || same(a, p) || same(p, b)) return null;
  const g = arcGeom({ kind: "arc", a, m: p, b });
  if (!g) return null;
  const mid = g.a0 + g.sweep / 2;
  return { kind: "arc", a, m: [g.c[0] + g.r * Math.cos(mid), g.c[1] + g.r * Math.sin(mid)], b };
}

function loopPolygon(l: Loop): P[] {
  if (l.kind === "circle") return Array.from({ length: 72 }, (_, i) => [l.c[0] + l.r * Math.cos((i / 72) * TAU), l.c[1] + l.r * Math.sin((i / 72) * TAU)] as P);
  return l.segs.flatMap(segPoints);
}

/** A sketch line, or a circle / arc (sweep: signed, ±2π for a full circle). */
type Curve = { kind: "line"; a: P; b: P } | { kind: "arc"; c: P; r: number; a0: number; sweep: number };

function curvesOf(loops: Loop[], path: Seg[]): Curve[] {
  const seg = (g: Seg): Curve | null => {
    if (g.kind === "line") return g;
    const k = arcGeom(g);
    return k && { kind: "arc", ...k };
  };
  const out: Curve[] = [];
  for (const l of loops) {
    if (l.kind === "circle") out.push({ kind: "arc", c: l.c, r: l.r, a0: 0, sweep: TAU });
    else for (const g of l.segs) out.push(seg(g)!);
  }
  for (const g of path) out.push(seg(g)!);
  return out.filter((c) => !!c);
}

/** Whether a point of an arc's circle lies on the arc. */
function onArc(k: Extract<Curve, { kind: "arc" }>, p: P): boolean {
  if (Math.abs(k.sweep) >= TAU - 1e-9) return true;
  const t = Math.atan2(p[1] - k.c[1], p[0] - k.c[0]);
  const eps = 1e-9 / Math.max(k.r, 1e-9);
  return k.sweep > 0 ? wrap(t - k.a0 + eps) <= k.sweep + 2 * eps : wrap(k.a0 - t + eps) <= -k.sweep + 2 * eps;
}

/** Where two sketch curves cross (or touch). */
function crossings(p: Curve, q: Curve): P[] {
  const EPS = 1e-9;
  if (p.kind === "line" && q.kind === "line") {
    const r = sub(p.b, p.a), s = sub(q.b, q.a), den = cross(r, s);
    if (Math.abs(den) < EPS * len(r) * len(s)) return [];
    const t = cross(sub(q.a, p.a), s) / den, u = cross(sub(q.a, p.a), r) / den;
    return t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS ? [add(p.a, mul(r, t))] : [];
  }
  if (p.kind === "arc" && q.kind === "line") return crossings(q, p);
  if (p.kind === "line" && q.kind === "arc") {
    const d = sub(p.b, p.a), f = sub(p.a, q.c);
    const A = dot(d, d), B = 2 * dot(f, d), C = dot(f, f) - q.r * q.r, disc = B * B - 4 * A * C;
    if (A < EPS || disc < -EPS) return [];
    const sq = Math.sqrt(Math.max(0, disc));
    return [...new Set([(-B - sq) / (2 * A), (-B + sq) / (2 * A)])]
      .filter((t) => t >= -EPS && t <= 1 + EPS)
      .map((t) => add(p.a, mul(d, t)))
      .filter((x) => onArc(q, x));
  }
  const a = p as Extract<Curve, { kind: "arc" }>, b = q as Extract<Curve, { kind: "arc" }>;
  const dv = sub(b.c, a.c), d = len(dv);
  if (d < EPS || d > a.r + b.r + EPS || d < Math.abs(a.r - b.r) - EPS) return [];
  const x = (d * d + a.r * a.r - b.r * b.r) / (2 * d), h = Math.sqrt(Math.max(0, a.r * a.r - x * x));
  const m = add(a.c, mul(dv, x / d)), n: P = [-dv[1] / d, dv[0] / d];
  return (h < EPS ? [m] : [add(m, mul(n, h)), sub(m, mul(n, h))]).filter((pt) => onArc(a, pt) && onArc(b, pt));
}

function polyArea(pts: P[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) s += cross(pts[i], pts[(i + 1) % pts.length]);
  return Math.abs(s) / 2;
}

function inside(p: P, poly: P[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/**
 * Outer outlines with their holes: an outline inside an odd number of others is a hole of the
 * smallest one around it. (Inside = most of its points are: an outline that only touches another,
 * e.g. a half circle on a rectangle's side, isn't.)
 */
function nest(loops: Loop[]): { outer: number; holes: number[] }[] {
  const polys = loops.map(loopPolygon), areas = polys.map(polyArea);
  const within = (i: number, j: number) => polys[i].filter((p) => inside(p, polys[j])).length * 2 > polys[i].length;
  const parents = loops.map((_, i) => loops.map((_, j) => j).filter((j) => j !== i && areas[j] > areas[i] && within(i, j)));
  const depth = parents.map((p) => p.length);
  return loops
    .map((_, i) => i)
    .filter((i) => depth[i] % 2 === 0)
    .map((i) => ({ outer: i, holes: loops.map((_, j) => j).filter((j) => depth[j] === depth[i] + 1 && parents[j].includes(i)) }));
}

interface State {
  loops: Loop[];
  opens: Seg[][];
  path: Seg[];
  first: P | null;
  arcEnd: P | null;
  anchor: P | null;
}

export class SketchTool implements Tool {
  readonly name = "Sketch";
  private mode: Mode = "line";
  /** Closed outlines. */
  private loops: Loop[] = [];
  /** Select mode: the selected outlines / paths, and the one under the cursor. */
  private selected: Item[] = [];
  private hoverItem: Item | null = null;
  /** Select: a press on a selected outline / path — dragging it moves the selection. */
  private drag: { x: number; y: number; at: P; loops: Loop[]; opens: Seg[][]; snap: string; moved: boolean; item: Item; wasSelected: boolean } | null = null;
  /** Finished open lines (Enter / double-click): paths. */
  private opens: Seg[][] = [];
  /** The outline being drawn (lines / arcs) and its first point. */
  private path: Seg[] = [];
  private first: P | null = null;
  /** First arc with nothing to be tangent to: its end point, waiting for a point it passes through. */
  private arcEnd: P | null = null;
  /** Rectangle: first corner; circle: centre. */
  private anchor: P | null = null;
  /** Radius typed for the next arc (the mouse then picks where it ends). */
  private arcR: number | null = null;
  private cursor: P | null = null;
  /** Line lock: 0 = horizontal, 1 = vertical, -1 = none. */
  private lock = -1;
  /** The sketch points the cursor is lined up with (same X: k = 0, same Y: k = 1), drawn as dashed guides. */
  private aligned: { ref: P; k: 0 | 1 }[] = [];
  private typed = "";
  private undoStack: string[] = [];
  private last: PointerEvent | null = null;
  /** Last click (for double-clicks). */
  private lastDown: { t: number; x: number; y: number } | null = null;
  private panel: HTMLElement;
  private panelHtml = "";
  private insetLoops = -1;
  /** Bumped on every change to the outlines (keeps the crossing points cached until then). */
  private version = 0;
  private crossCache: { version: number; pts: P[] } | null = null;
  private saved: { camera: ReturnType<ToolHost["viewport"]["cameraState"]>; xray: boolean } | null = null;
  private readonly mats = {
    line: new THREE.LineBasicMaterial({ color: 0xffd166, depthTest: false, transparent: true }),
    open: new THREE.LineBasicMaterial({ color: 0xff69b4, depthTest: false, transparent: true }),
    sel: new THREE.LineBasicMaterial({ color: 0x4fd1ff, depthTest: false, transparent: true }),
    hover: new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.85 }),
    selFill: new THREE.MeshBasicMaterial({ color: 0x4fd1ff, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthTest: false, depthWrite: false }),
    hoverFill: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthTest: false, depthWrite: false }),
    rubber: new THREE.LineBasicMaterial({ color: 0x8fd3ff, depthTest: false, transparent: true }),
    fill: new THREE.MeshBasicMaterial({ color: 0x5aa9ff, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthTest: false, depthWrite: false }),
    guide: new THREE.LineDashedMaterial({ color: 0xff6fb5, dashSize: 1, gapSize: 1, depthTest: false, transparent: true }),
  };

  constructor(
    private host: ToolHost,
    private frame: SketchFrame,
    /** Where the view is centred (e.g. the face's centre). */
    private center: THREE.Vector3,
    private what: string,
    private done: (faces: Shape[], paths: Wire[]) => void,
    private cancel: () => void,
  ) {
    this.panel = document.createElement("div");
    this.panel.id = "sketch-panel";
    this.panel.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("button");
      if (!b) return;
      b.blur();
      if (b.dataset.mode) this.setMode(b.dataset.mode as Mode);
      else if (b.dataset.act === "done") this.finish();
      else if (b.dataset.act === "cancel") this.cancel();
      else if (b.dataset.act === "join") this.join();
    });
    host.viewport.canvas.parentElement!.appendChild(this.panel);
  }

  start(): this {
    const vp = this.host.viewport;
    this.saved = { camera: vp.cameraState(), xray: vp.xray };
    vp.lookAtPlane(this.center, this.frame.z, this.frame.y);
    vp.viewLocked = true;
    if (!vp.xray) vp.setXray(true);
    this.update();
    return this;
  }

  dispose(): void {
    const vp = this.host.viewport;
    vp.viewLocked = false;
    vp.setInset(false);
    if (this.saved) {
      vp.restoreCamera(this.saved.camera);
      if (vp.xray !== this.saved.xray) vp.setXray(this.saved.xray);
    }
    vp.showSnapMarker(null);
    vp.setOverlay([]);
    this.host.hud(null);
    this.panel.remove();
    for (const m of Object.values(this.mats)) m.dispose();
  }

  // ------------------------------------------------------------ geometry helpers

  private world(p: P): THREE.Vector3 {
    return this.frame.origin.clone().addScaledVector(this.frame.x, p[0]).addScaledVector(this.frame.y, p[1]);
  }

  private local(w: THREE.Vector3): P {
    const d = w.clone().sub(this.frame.origin);
    return [d.dot(this.frame.x), d.dot(this.frame.y)];
  }

  private v3(p: P): V3 {
    return this.world(p).toArray() as V3;
  }

  /** The end of the outline being drawn. */
  private get cur(): P | null {
    return this.path.length ? this.path[this.path.length - 1].b : this.first;
  }

  /** The sketch's own snap points: ends of lines / arcs, their middles, circle centres. */
  private ownPoints(): { p: P; kind: "vertex" | "midpoint" | "center" }[] {
    const pts: { p: P; kind: "vertex" | "midpoint" | "center" }[] = [];
    const seg = (g: Seg) => {
      pts.push({ p: g.a, kind: "vertex" }, { p: g.b, kind: "vertex" });
      pts.push({ p: g.kind === "line" ? mul(add(g.a, g.b), 0.5) : g.m, kind: "midpoint" });
    };
    for (const l of this.loops) {
      if (l.kind === "circle") pts.push({ p: l.c, kind: "center" });
      else l.segs.forEach(seg);
    }
    this.opens.flat().forEach(seg);
    this.path.forEach(seg);
    for (const p of [this.first, this.arcEnd, this.anchor]) if (p) pts.push({ p, kind: "vertex" });
    for (const p of this.crossingPoints()) pts.push({ p, kind: "vertex" });
    return pts;
  }

  /** Where the sketch's lines / arcs / circles cross each other. */
  private crossingPoints(): P[] {
    if (this.crossCache?.version !== this.version) {
      const cs = curvesOf(this.loops, [...this.opens.flat(), ...this.path]), pts: P[] = [];
      for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) pts.push(...crossings(cs[i], cs[j]));
      this.crossCache = { version: this.version, pts };
    }
    return this.crossCache.pts;
  }

  // ------------------------------------------------------------ pointer

  /** Cursor point in the plane: the sketch's own points, then the model's points, else the plane (Ctrl: grid). */
  private pointAt(e: PointerEvent): P | null {
    const vp = this.host.viewport;
    this.lock = -1;
    this.aligned = [];
    let best: { p: P; kind: "vertex" | "midpoint" | "center"; score: number } | null = null;
    for (const { p, kind } of this.ownPoints()) {
      const s = vp.toScreen(this.world(p));
      const d = Math.hypot(s.x - e.clientX, s.y - e.clientY);
      const score = d + (kind === "vertex" ? 0 : 4); // ends before middles / centres
      if (d <= SNAP_PX && (!best || score < best.score)) best = { p, kind, score };
    }
    if (best) {
      vp.showSnapMarker({ point: this.world(best.p), kind: best.kind });
      return best.p;
    }
    const sp = vp.snapPoint(e.clientX, e.clientY);
    if (sp && sp.kind !== "axis") {
      const p = this.local(sp.point);
      vp.showSnapMarker({ point: this.world(p), kind: sp.kind });
      return p;
    }
    vp.showSnapMarker(null);
    const q = vp.ray(e.clientX, e.clientY).intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(this.frame.z, this.frame.origin), new THREE.Vector3());
    if (!q) return null;
    let p = this.local(q);
    const step = this.host.snapStep(e);
    if (step > 0) p = [Math.round(p[0] / step) * step, Math.round(p[1] / step) * step];
    // Lines lock horizontal / vertical (in the plane) near those directions.
    const from = this.cur;
    if (from && this.mode === "line") {
      const d = sub(p, from), l = len(d);
      if (l > 1e-9 && Math.abs(d[1]) / l < LOCK_SIN) {
        p = [p[0], from[1]];
        this.lock = 0;
      } else if (l > 1e-9 && Math.abs(d[0]) / l < LOCK_SIN) {
        p = [from[0], p[1]];
        this.lock = 1;
      }
    }
    // Lined up with a sketch point — same X or same Y in the plane: onto that line (e.g. an arc's end
    // straight above the line it bends on from: a half circle).
    const tol = ALIGN_PX * vp.worldPerPixel(this.world(p));
    for (const k of [0, 1] as const) {
      if ((this.lock === 0 && k === 1) || (this.lock === 1 && k === 0)) continue; // already level / upright
      let ref: P | null = null;
      for (const { p: q } of this.ownPoints()) if (Math.abs(q[k] - p[k]) < tol && (!ref || Math.abs(q[k] - p[k]) < Math.abs(ref[k] - p[k]))) ref = q;
      if (!ref) continue;
      p = k === 0 ? [ref[0], p[1]] : [p[0], ref[1]];
      this.aligned.push({ ref, k });
    }
    return p;
  }

  move(e: PointerEvent): void {
    this.last = e;
    if (this.mode === "select") {
      if (this.drag) return this.dragTo(e);
      const h = this.itemAt(e);
      if (sameItem(h, this.hoverItem) || (!h && !this.hoverItem)) return;
      this.hoverItem = h;
      return this.update();
    }
    this.cursor = this.pointAt(e);
    this.update();
  }

  /** The cursor's point in the sketch plane (no snapping). */
  private planeAt(e: PointerEvent): P | null {
    const w = this.host.viewport.ray(e.clientX, e.clientY).intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(this.frame.z, this.frame.origin), new THREE.Vector3());
    return w && this.local(w);
  }

  /** Dragging the selection: everything selected follows the cursor (Ctrl: in grid steps). */
  private dragTo(e: PointerEvent): void {
    const dr = this.drag!;
    if (!dr.moved && Math.hypot(e.clientX - dr.x, e.clientY - dr.y) < DRAG_PX) return;
    const q = this.planeAt(e);
    if (!q) return;
    dr.moved = true;
    let d = sub(q, dr.at);
    const step = this.host.snapStep(e);
    if (step > 0) d = [Math.round(d[0] / step) * step, Math.round(d[1] / step) * step];
    this.translateSelection(d, dr.loops, dr.opens);
    this.host.hud(`Move ${num(d[0])}, ${num(d[1])} mm`, this.world(q));
  }

  /** The selected outlines / paths of `loops` / `opens` (as they were) moved by d. */
  private translateSelection(d: P, loops = this.loops, opens = this.opens): void {
    const sel = (kind: Item["kind"], i: number) => this.selected.some((s) => s.kind === kind && s.i === i);
    this.loops = loops.map((l, i) => (sel("loop", i) ? moveLoop(l, d) : l));
    this.opens = opens.map((o, i) => (sel("open", i) ? o.map((g) => moveSeg(g, d)) : o));
    this.version++;
    this.update();
  }

  /** An item with the outlines joined to it. */
  private groupOf(it: Item): Item[] {
    const g = it.kind === "loop" ? this.loops[it.i].g : undefined;
    if (g === undefined) return [it];
    return this.loops.flatMap((l, i) => (l.g === g ? [{ kind: "loop" as const, i }] : []));
  }

  /**
   * J: the selected outlines become one group (one face at Done); the selected paths are linked end to
   * end into one (closed into an outline if the chain comes back to its start).
   */
  private join(): void {
    const loopIdx = this.selected.filter((s) => s.kind === "loop").map((s) => s.i);
    const openIdx = this.selected.filter((s) => s.kind === "open").map((s) => s.i);
    if (loopIdx.length < 2 && openIdx.length < 2) return this.host.hint("Join: select two or more outlines (or paths) first — Shift+click adds");
    // Paths: chain them end to end (turning a path round where needed).
    let chain: Seg[] | null = null;
    if (openIdx.length >= 2) {
      const rev = (o: Seg[]): Seg[] => [...o].reverse().map((g) => (g.kind === "line" ? { kind: "line", a: g.b, b: g.a } : { kind: "arc", a: g.b, m: g.m, b: g.a }));
      const left = openIdx.map((i) => this.opens[i]);
      chain = left.shift()!;
      while (left.length) {
        const start = chain[0].a, end = chain[chain.length - 1].b;
        const k = left.findIndex((o) => [o[0].a, o[o.length - 1].b].some((p) => same(p, start) || same(p, end)));
        if (k < 0) return this.host.hint("Join: the paths must meet end to end (draw from one path's end, or move them together)");
        const o = left.splice(k, 1)[0];
        if (same(o[0].a, end)) chain = [...chain, ...o];
        else if (same(o[o.length - 1].b, end)) chain = [...chain, ...rev(o)];
        else if (same(o[o.length - 1].b, start)) chain = [...o, ...chain];
        else chain = [...rev(o), ...chain];
      }
    }
    this.undoStack.push(JSON.stringify(this.state()));
    this.version++;
    if (loopIdx.length >= 2) {
      const g = Math.max(-1, ...this.loops.map((l) => l.g ?? -1)) + 1;
      const old = new Set(loopIdx.map((i) => this.loops[i].g).filter((x) => x !== undefined));
      this.loops = this.loops.map((l, i) => (loopIdx.includes(i) || (l.g !== undefined && old.has(l.g)) ? { ...l, g } : l));
    }
    if (chain) {
      this.opens = this.opens.filter((_, i) => !openIdx.includes(i));
      if (same(chain[0].a, chain[chain.length - 1].b)) this.loops.push({ kind: "path", segs: chain });
      else this.opens.push(chain);
    }
    this.selected = [];
    this.hoverItem = null;
    this.host.toast(chain && same(chain[0].a, chain[chain.length - 1].b) ? "Joined: the paths close into an outline" : "Joined");
    this.update();
  }

  up(e: PointerEvent): void {
    const dr = this.drag;
    if (!dr || e.button !== 0) return;
    this.drag = null;
    if (dr.moved) this.undoStack.push(dr.snap);
    // A click (no drag) on one of several selected: just that one.
    else if (dr.wasSelected && !e.shiftKey) this.selected = [dr.item];
    this.host.hud(null);
    this.update();
  }

  /** Select: the path whose line is under the cursor, else the outline whose line is, else the smallest outline around it. */
  private itemAt(e: PointerEvent): Item | null {
    const vp = this.host.viewport;
    const w = vp.ray(e.clientX, e.clientY).intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(this.frame.z, this.frame.origin), new THREE.Vector3());
    if (!w) return null;
    const q = this.local(w), tol = PICK_PX * vp.worldPerPixel(w);
    const near = (pts: P[], closed: boolean) => {
      let d = Infinity;
      for (let k = 0; k + (closed ? 0 : 1) < pts.length; k++) {
        const a = pts[k], b = pts[(k + 1) % pts.length], ab = sub(b, a), l2 = dot(ab, ab);
        const t = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(q, a), ab) / l2)) : 0;
        d = Math.min(d, dist(q, add(a, mul(ab, t))));
      }
      return d;
    };
    let best: { item: Item; d: number } | null = null;
    this.opens.forEach((o, i) => {
      const d = near([...o.flatMap(segPoints), o[o.length - 1].b], false);
      if (d < tol && (!best || d < best.d)) best = { item: { kind: "open", i }, d };
    });
    this.loops.forEach((l, i) => {
      const d = near(loopPolygon(l), true);
      if (d < tol && (!best || d < best.d)) best = { item: { kind: "loop", i }, d };
    });
    if (best) return (best as { item: Item }).item;
    let inner: { i: number; area: number } | null = null;
    this.loops.forEach((l, i) => {
      const poly = loopPolygon(l), area = polyArea(poly);
      if (inside(q, poly) && (!inner || area < inner.area)) inner = { i, area };
    });
    return inner ? { kind: "loop", i: (inner as { i: number }).i } : null;
  }

  /** Delete the selected outlines / paths (one undo step). */
  private deleteSelected(): void {
    if (!this.selected.length) return;
    this.undoStack.push(JSON.stringify(this.state()));
    this.version++;
    const gone = (kind: Item["kind"], i: number) => this.selected.some((s) => s.kind === kind && s.i === i);
    this.loops = this.loops.filter((_, i) => !gone("loop", i));
    this.opens = this.opens.filter((_, i) => !gone("open", i));
    this.selected = [];
    this.hoverItem = null;
    this.update();
  }

  down(e: PointerEvent): void {
    if (e.button !== 0) return;
    if (this.mode === "select") {
      const it = this.itemAt(e);
      const wasSelected = !!it && this.selected.some((s) => sameItem(s, it));
      // (an outline joined to others brings its whole group along)
      const group = it ? this.groupOf(it) : [];
      if (e.shiftKey) {
        if (it) this.selected = wasSelected ? this.selected.filter((s) => !group.some((g) => sameItem(g, s))) : [...this.selected, ...group];
      } else if (!wasSelected) this.selected = group;
      // On a selected outline / path: dragging from here moves the selection.
      const at = it && this.selected.some((s) => sameItem(s, it)) ? this.planeAt(e) : null;
      this.drag = at && it ? { x: e.clientX, y: e.clientY, at, loops: this.loops, opens: this.opens, snap: JSON.stringify(this.state()), moved: false, item: it, wasSelected } : null;
      return this.update();
    }
    const prev = this.lastDown, now = performance.now();
    const drawing = (this.mode === "line" || this.mode === "arc") && !!this.first;
    const double = drawing && !!prev && now - prev.t < 400 && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 5;
    this.lastDown = double ? null : { t: now, x: e.clientX, y: e.clientY };
    // The 2nd click of a double-click only ends the lines (on an arc it would start another one).
    if (double) return this.endLines();
    const p = this.pointAt(e);
    if (p) this.click(p);
  }

  /**
   * Enter / double-click: the lines being drawn end here, open (a path) — unless both ends lie on one
   * straight edge of a closed outline (e.g. a half circle on a rectangle's side): closed along it.
   */
  private endLines(): void {
    if (this.mode === "rect" || this.mode === "circle" || !this.first) return;
    this.undoStack.push(JSON.stringify(this.state()));
    this.version++;
    if (this.path.length) {
      const closing: Seg = { kind: "line", a: this.cur!, b: this.first };
      const near = this.nearStart();
      if (near) this.loops.push({ kind: "path", segs: near });
      else if (this.onOneEdge(this.first, this.cur!) && polyArea([...this.path, closing].flatMap(segPoints)) > 1e-9) this.loops.push({ kind: "path", segs: [...this.path, closing] });
      else this.opens.push(this.path);
    }
    this.path = [];
    this.first = null;
    this.arcEnd = null;
    this.update();
  }

  /**
   * Ended just short of the start point (within a few pixels — a click that missed it): the
   * outline with its last line / arc moved to end exactly there; null if it isn't that close.
   */
  private nearStart(): Seg[] | null {
    const first = this.first!, end = this.cur!, vp = this.host.viewport;
    const a = vp.toScreen(this.world(first)), b = vp.toScreen(this.world(end));
    if (same(first, end) || Math.hypot(a.x - b.x, a.y - b.y) > NEAR_START_PX) return null;
    const last = this.path[this.path.length - 1];
    const moved: Seg | null = last.kind === "line" ? (same(last.a, first) ? null : { ...last, b: first }) : threePointArc(last.a, last.m, first);
    if (!moved) return null;
    const segs = [...this.path.slice(0, -1), moved];
    return polyArea(segs.flatMap(segPoints)) > 1e-9 ? segs : null;
  }

  /** Whether a and b both lie on one straight edge of a closed outline. */
  private onOneEdge(a: P, b: P): boolean {
    if (same(a, b)) return false;
    const on = (p: P, s: P, t: P) => {
      const d = sub(t, s), l = len(d), u = dot(sub(p, s), d) / (l * l);
      return l > 1e-9 && u > -1e-9 && u < 1 + 1e-9 && Math.abs(cross(d, sub(p, s))) / l < 1e-6;
    };
    return this.loops.some((l) => l.kind === "path" && l.segs.some((g) => g.kind === "line" && on(a, g.a, g.b) && on(b, g.a, g.b)));
  }

  /** A click (or typed point) at p in the current mode. */
  private click(p: P): void {
    const snap = JSON.stringify(this.state());
    let changed = true;
    if (this.mode === "rect" || this.mode === "circle") {
      if (!this.anchor) this.anchor = p;
      else if (this.mode === "rect") {
        const a = this.anchor;
        if (Math.abs(p[0] - a[0]) < 1e-9 || Math.abs(p[1] - a[1]) < 1e-9) return;
        const c: P[] = [a, [p[0], a[1]], p, [a[0], p[1]]];
        this.loops.push({ kind: "path", segs: c.map((q, i) => ({ kind: "line", a: q, b: c[(i + 1) % 4] }) as Seg) });
        this.anchor = null;
      } else {
        const r = dist(p, this.anchor);
        if (r < 1e-9) return;
        this.loops.push({ kind: "circle", c: this.anchor, r });
        this.anchor = null;
      }
    } else if (!this.first) {
      if (!this.resume(p)) this.first = p;
    } else {
      changed = this.addSegment(p);
    }
    if (!changed) return;
    this.undoStack.push(snap);
    this.version++;
    this.typed = "";
    this.update();
  }

  /**
   * A click on an end of an open path picks that path up again: drawing goes on from there (its
   * other end becomes the start point, so clicking it closes the outline).
   */
  private resume(p: P): boolean {
    for (const [i, o] of this.opens.entries()) {
      const flip = same(p, o[0].a) && !same(p, o[o.length - 1].b);
      if (!flip && !same(p, o[o.length - 1].b)) continue;
      const rev = (g: Seg): Seg => (g.kind === "line" ? { kind: "line", a: g.b, b: g.a } : { kind: "arc", a: g.b, m: g.m, b: g.a });
      this.path = flip ? [...o].reverse().map(rev) : [...o];
      this.first = this.path[0].a;
      this.opens = this.opens.filter((_, k) => k !== i);
      return true;
    }
    return false;
  }

  /** Next line / arc of the outline being drawn, to p; closes the outline at its start point. */
  private addSegment(p: P): boolean {
    const from = this.cur!;
    let g: Seg | null;
    if (this.mode === "line") {
      if (same(p, from)) return false;
      g = { kind: "line", a: from, b: p };
    } else if (!this.path.length && !this.arcEnd) {
      // First arc: its end point (with a typed radius, no further than the circle reaches).
      if (same(p, from)) return false;
      if (this.arcR && dist(p, from) > 2 * this.arcR + 2e-6) {
        this.host.hint(`Sketch: with R ${num(this.arcR)} the arc's ends can be at most ${num(2 * this.arcR)} mm apart`);
        return false;
      }
      this.arcEnd = p;
      return true;
    } else if (this.path.length === 1 && this.path[0].kind === "arc" && same(p, this.first!)) {
      // Back to the start after just one arc: close with a straight line — a half circle, not a full one.
      g = { kind: "line", a: from, b: p };
    } else {
      // (on from a segment, straight ahead with no radius typed: a line)
      g = this.arcAt(from, p) ?? (this.path.length && !this.arcR && !same(p, from) ? { kind: "line", a: from, b: p } : null);
      if (!g) return false;
      this.arcEnd = null;
      this.arcR = null;
    }
    if (!g) return false;
    const closes = same(g.b, this.first!);
    if (closes && this.path.length === 0 && g.kind === "line") return false; // straight back to the start
    this.path.push(g);
    if (closes) {
      this.loops.push({ kind: "path", segs: this.path });
      this.path = [];
      this.first = null;
    }
    return true;
  }


  /**
   * The arc a click at p adds: on from the last segment (tangent), or a first arc through p to its
   * end. With a typed radius the radius is fixed: p only picks where the arc ends (on from a
   * segment, near a quarter / half / three-quarter turn it snaps there) or which way a first arc bulges.
   */
  private arcAt(from: P, p: P): Seg | null {
    const r = this.arcR;
    if (this.path.length) {
      const t = endDir(this.path[this.path.length - 1]);
      if (!r) return tangentArc(from, t, p);
      const sd = cross(t, sub(p, from)) < 0 ? -1 : 1; // bends toward the cursor's side
      const c = add(from, mul([-t[1] * sd, t[0] * sd], r));
      const ang = (q: P) => Math.atan2(q[1] - c[1], q[0] - c[0]);
      const a0 = ang(from);
      let sweep = sd > 0 ? wrap(ang(p) - a0) : wrap(a0 - ang(p));
      const quarter = Math.round(sweep / (Math.PI / 2)) * (Math.PI / 2);
      if (quarter > 0 && quarter < TAU && Math.abs(sweep - quarter) < (5 * Math.PI) / 180) sweep = quarter;
      if (sweep < 1e-6) return null;
      let end: P = [c[0] + r * Math.cos(a0 + sd * sweep), c[1] + r * Math.sin(a0 + sd * sweep)];
      if (this.first && dist(end, this.first) < 1e-6) end = this.first; // back at the start: close exactly
      return tangentArc(from, t, end);
    }
    if (!this.arcEnd) return null;
    if (!r) {
      // Through the cursor — within 5° of a half circle: exactly one.
      const g = threePointArc(from, p, this.arcEnd), k = g && arcGeom(g as Extract<Seg, { kind: "arc" }>);
      if (!g || !k || Math.abs(Math.abs(k.sweep) - Math.PI) > (5 * Math.PI) / 180) return g;
      const u = norm(sub(this.arcEnd, from)), sd = cross(u, sub(p, from)) < 0 ? -1 : 1, half = dist(from, this.arcEnd) / 2;
      return threePointArc(from, add(mul(add(from, this.arcEnd), 0.5), mul([-u[1] * sd, u[0] * sd], half)), this.arcEnd);
    }
    // Fixed radius through both ends, bulging toward the cursor (the shorter way round).
    const b = this.arcEnd, half = dist(from, b) / 2;
    if (r < half - 1e-6) return null;
    const u = norm(sub(b, from)), sd = cross(u, sub(p, from)) < 0 ? -1 : 1, n: P = [-u[1] * sd, u[0] * sd];
    // (R within 1e-6 of half the distance: exactly a half circle)
    const mid = mul(add(from, b), 0.5), h = Math.abs(r - half) < 1e-6 ? 0 : Math.sqrt(Math.max(0, r * r - half * half));
    return threePointArc(from, add(sub(mid, mul(n, h)), mul(n, r)), b);
  }

  // ------------------------------------------------------------ keys

  key(e: KeyboardEvent): boolean {
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "z" && !e.shiftKey) {
      this.undo();
      return true;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (k === "Escape") {
      if (this.typed) this.typed = "";
      else if (this.arcR) this.arcR = null;
      else if (this.first || this.arcEnd || this.anchor) {
        this.undoStack.push(JSON.stringify(this.state()));
        this.version++;
        this.path = [];
        this.first = this.arcEnd = this.anchor = null;
      } else if (this.mode !== "select") {
        this.setMode("select"); // nothing being drawn: Select
        return true;
      } else if (this.selected.length) this.selected = [];
      else this.host.hint("Sketch: click Done to keep the closed outlines as faces, or Cancel to drop the sketch");
      this.update();
      return true;
    }
    if ((k === "j" || k === "J") && !e.shiftKey) {
      this.join();
      return true;
    }
    if ((k === "Delete" || k === "Backspace") && this.mode === "select" && this.selected.length) {
      this.deleteSelected();
      return true;
    }
    if (/^[0-9.,\-]$/.test(k) || (/^[xX*]$/.test(k) && /\d$/.test(this.typed))) {
      this.typed += k === "*" ? "x" : k.toLowerCase(); // 23x30 = 23,30
      this.update();
      return true;
    }
    if (k === "Backspace") {
      if (this.typed) this.typed = this.typed.slice(0, -1);
      else this.undo();
      this.update();
      return true;
    }
    if (k === "Enter") {
      if (this.typed) this.applyTyped();
      else if ((this.mode === "arc" || this.mode === "line") && this.first) {
        // Nothing typed: done drawing — an arc shown (e.g. after typing its radius) is placed first.
        if (this.mode === "arc" && this.cursor && this.cur && (this.path.length || this.arcEnd) && this.arcAt(this.cur, this.cursor)) this.click(this.cursor);
        this.endLines();
      }
      return true;
    }
    if (k === "Tab") return true;
    const mode = ({ l: "line", a: "arc", r: "rect", c: "circle" } as Record<string, Mode>)[k.toLowerCase()];
    if (mode && !e.shiftKey) {
      this.setMode(mode);
      return true;
    }
    return false;
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    this.typed = "";
    this.arcEnd = null;
    this.arcR = null;
    if (mode !== "rect" && mode !== "circle") this.anchor = null;
    this.hoverItem = null;
    if (mode === "select") {
      // (a line being drawn ends here, as with Enter)
      if (this.first) this.endLines();
      this.cursor = null;
      this.aligned = [];
      this.host.viewport.showSnapMarker(null);
      if (this.last) this.hoverItem = this.itemAt(this.last);
    } else {
      this.selected = [];
      if (this.last) this.cursor = this.pointAt(this.last);
    }
    this.update();
  }

  /**
   * Typed numbers + Enter: line length (or dx,dy); rectangle w,h (or wxh); circle radius; arc radius; x,y for
   * a first point.
   */
  private applyTyped(): void {
    const vals = this.typed.split(/[,x]/).filter((s) => s !== "").map(Number);
    this.typed = "";
    if (!vals.length || vals.some((v) => !Number.isFinite(v))) return this.update();
    if (this.mode === "select") {
      // Select: dx,dy moves the selection exactly.
      if (this.selected.length && vals.length >= 2) {
        this.undoStack.push(JSON.stringify(this.state()));
        this.translateSelection([vals[0], vals[1]]);
      } else this.host.hint("Sketch: select outlines / paths, then type dx,dy + Enter to move them");
      return this.update();
    }
    const c = this.cursor;
    if ((this.mode === "rect" || this.mode === "circle") && this.anchor) {
      const a = this.anchor;
      if (this.mode === "circle") return vals[0] > 0 ? this.click([a[0] + vals[0], a[1]]) : this.update();
      const [w, h = w] = vals;
      const sx = c && c[0] < a[0] ? -1 : 1, sy = c && c[1] < a[1] ? -1 : 1;
      return this.click([a[0] + sx * Math.abs(w), a[1] + sy * Math.abs(h)]);
    }
    const from = this.mode === "rect" || this.mode === "circle" ? null : this.cur;
    if (!from) return vals.length >= 2 ? this.click([vals[0], vals[1]]) : this.update();
    if (this.mode === "arc") {
      // Arcs: a typed number is the radius; the mouse then picks where the arc ends.
      const r = vals[0];
      if (!(r > 0)) return this.update();
      // A first arc's ends are already placed: the radius must reach between them.
      const half = this.arcEnd ? dist(from, this.arcEnd) / 2 : 0;
      if (r < half - 1e-6) {
        this.host.toast(`Arc: R ${num(r)} is too small — the ends are ${num(2 * half)} mm apart, so R must be at least ${num(half)}`, "error");
        return this.update();
      }
      this.arcR = r;
      return this.update();
    }
    if (vals.length >= 2) return this.click(add(from, [vals[0], vals[1]]));
    const dir = c && !same(c, from) ? norm(sub(c, from)) : ([1, 0] as P);
    const end = add(from, mul(dir, vals[0]));
    // Typed back onto the start point: close there exactly.
    this.click(this.first && dist(end, this.first) < 1e-6 ? this.first : end);
  }

  private state(): State {
    return { loops: this.loops, opens: this.opens, path: this.path, first: this.first, arcEnd: this.arcEnd, anchor: this.anchor };
  }

  /** Undo the last sketch step (Ctrl+Z / Backspace). */
  undo(): void {
    const s = this.undoStack.pop();
    if (!s) return this.host.hint("Sketch: nothing to undo");
    const st = JSON.parse(s) as State;
    ({ loops: this.loops, opens: this.opens, path: this.path, first: this.first, arcEnd: this.arcEnd, anchor: this.anchor } = st);
    this.arcR = null;
    this.selected = [];
    this.hoverItem = null;
    this.version++;
    this.update();
  }

  // ------------------------------------------------------------ done

  /** Done: the closed outlines become flat faces. */
  private finish(): void {
    const groups = nest(this.loops);
    const toKernel = (l: Loop): SketchLoop =>
      l.kind === "circle"
        ? { kind: "circle", c: this.v3(l.c), r: l.r }
        : { kind: "path", segs: l.segs.map((g) => (g.kind === "line" ? { kind: "line", a: this.v3(g.a), b: this.v3(g.b) } : { kind: "arc", a: this.v3(g.a), m: this.v3(g.m), b: this.v3(g.b) })) };
    try {
      const n = this.frame.z.toArray() as V3;
      // Faces of each outline (with its holes); outlines joined with J are merged into one face.
      const byOuter = groups.map((g) => ({ g: this.loops[g.outer].g, faces: sketchFaces(toKernel(this.loops[g.outer]), g.holes.map((h) => toKernel(this.loops[h])), n) }));
      const faces = byOuter.filter((x) => x.g === undefined).flatMap((x) => x.faces);
      for (const g of new Set(byOuter.map((x) => x.g).filter((x): x is number => x !== undefined))) faces.push(...joinFlatFaces(byOuter.filter((x) => x.g === g).flatMap((x) => x.faces), n));
      // Open lines (also the ones still being drawn) become paths.
      const opens = this.path.length ? [...this.opens, this.path] : this.opens;
      const v3seg = (g: Seg) => (g.kind === "line" ? { kind: "line" as const, a: this.v3(g.a), b: this.v3(g.b) } : { kind: "arc" as const, a: this.v3(g.a), m: this.v3(g.m), b: this.v3(g.b) });
      this.done(faces, opens.map((o) => sketchPath(o.map(v3seg))));
    } catch (e) {
      this.host.toast(e instanceof Error ? e.message : String(e), "error");
    }
  }

  // ------------------------------------------------------------ drawing

  private update(): void {
    const vp = this.host.viewport;
    const objs: THREE.Object3D[] = [];
    const lines = (pts: P[], mat: THREE.LineBasicMaterial, closed = false) => {
      const g = new THREE.BufferGeometry().setFromPoints(pts.map((p) => this.world(p)));
      objs.push(closed ? new THREE.LineLoop(g, mat) : new THREE.Line(g, mat));
    };
    const dot = (p: P) => {
      const w = this.world(p), m = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), vp.mats.cursor);
      m.position.copy(w);
      m.scale.setScalar(vp.worldPerPixel(w) * 3.5);
      objs.push(m);
    };
    // Closed outlines: filled (holes left open) and outlined.
    for (const { outer, holes } of nest(this.loops)) {
      const shape = new THREE.Shape(loopPolygon(this.loops[outer]).map(([u, v]) => new THREE.Vector2(u, v)));
      for (const h of holes) shape.holes.push(new THREE.Path(loopPolygon(this.loops[h]).map(([u, v]) => new THREE.Vector2(u, v))));
      const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), this.mats.fill);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.makeBasis(this.frame.x, this.frame.y, this.frame.z).setPosition(this.frame.origin);
      objs.push(mesh);
    }
    for (const l of this.loops) lines(loopPolygon(l), this.mats.line, true);
    // Open paths, and the lines being drawn.
    // (open lines in pink — the colour of the paths they become: not a closed outline)
    for (const o of this.opens) lines([...o.flatMap(segPoints), o[o.length - 1].b], this.mats.open);
    if (this.path.length) lines([...this.path.flatMap(segPoints), this.cur!], this.mats.line);
    for (const p of [this.first, this.arcEnd, this.anchor]) if (p) dot(p);
    // Select: the selected outlines / paths in blue (outlines also filled), the one under the cursor in white.
    const itemLines = (it: Item, mat: THREE.LineBasicMaterial) => {
      if (it.kind === "loop") lines(loopPolygon(this.loops[it.i]), mat, true);
      else {
        const o = this.opens[it.i];
        lines([...o.flatMap(segPoints), o[o.length - 1].b], mat);
      }
    };
    const itemFill = (it: Item, mat: THREE.Material) => {
      if (it.kind !== "loop") return;
      const mesh = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(loopPolygon(this.loops[it.i]).map(([u, v]) => new THREE.Vector2(u, v)))), mat);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.makeBasis(this.frame.x, this.frame.y, this.frame.z).setPosition(this.frame.origin);
      objs.push(mesh);
    };
    for (const it of this.selected) {
      itemFill(it, this.mats.selFill);
      itemLines(it, this.mats.sel);
    }
    if (this.hoverItem && !this.selected.some((s) => sameItem(s, this.hoverItem))) {
      itemFill(this.hoverItem, this.mats.hoverFill);
      itemLines(this.hoverItem, this.mats.hover);
    }
    // Rubber band to the cursor.
    const c = this.cursor;
    let hud: string | null = null;
    if (c) {
      const from = this.cur;
      if ((this.mode === "rect" || this.mode === "circle") && this.anchor) {
        const a = this.anchor;
        if (this.mode === "rect") {
          lines([a, [c[0], a[1]], c, [a[0], c[1]]], this.mats.rubber, true);
          hud = `${num(Math.abs(c[0] - a[0]))} × ${num(Math.abs(c[1] - a[1]))} mm`;
        } else {
          lines(loopPolygon({ kind: "circle", c: a, r: dist(a, c) }), this.mats.rubber, true);
          lines([a, c], this.mats.rubber);
          hud = `R ${num(dist(a, c))} mm`;
        }
      } else if (from && this.mode === "line") {
        lines([from, c], this.mats.rubber);
        const d = sub(c, from);
        hud = `${num(len(d))} mm${this.lock === 0 ? " · horizontal" : this.lock === 1 ? " · vertical" : ` · ${num((Math.atan2(d[1], d[0]) * 180) / Math.PI)}°`}`;
      } else if (from && this.mode === "arc") {
        const g = this.path.length || this.arcEnd ? this.arcAt(from, c) : null;
        const fixed = this.arcR ? ` · R ${num(this.arcR)} (typed)` : "";
        const k = g && arcGeom(g as Extract<Seg, { kind: "arc" }>);
        if (g && k) {
          lines([...segPoints(g), g.b], this.mats.rubber);
          hud = `Arc R ${num(k.r)} mm · ${num((Math.abs(k.sweep) * 180) / Math.PI)}°${this.arcR ? " (R typed)" : ""}`;
        } else if (!this.path.length && !this.arcEnd) {
          lines([from, c], this.mats.rubber);
          hud = `Arc: ${num(dist(from, c))} mm to its end${fixed}`;
        } else {
          if (!this.arcR) lines([from, c], this.mats.rubber);
          hud = this.arcR ? `R ${num(this.arcR)} doesn't reach here` : null;
        }
      }
      // Dashed guides from the points the cursor lines up with.
      const w = vp.worldPerPixel(this.world(c));
      this.mats.guide.dashSize = w * 5;
      this.mats.guide.gapSize = w * 4;
      for (const { ref } of this.aligned) {
        if (same(ref, c)) continue;
        const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([this.world(ref), this.world(c)]), this.mats.guide);
        l.computeLineDistances();
        objs.push(l);
      }
      dot(c);
      if (this.first && same(c, this.first) && from && !same(from, this.first)) hud = "Close the outline";
    }
    vp.setOverlay(objs);
    this.host.hud(this.typed ? `⌨ ${this.typed}_` : hud, c ? this.world(c) : undefined);
    // The 3D corner view frames the model and the closed outlines.
    if (this.insetLoops !== this.loops.length) {
      this.insetLoops = this.loops.length;
      vp.setInset(true, this.loops.flatMap((l) => loopPolygon(l).map((p) => this.world(p))));
    }
    this.renderPanel();
  }

  /** Redraw the panel (e.g. after switching the Pro layout). */
  refresh(): void {
    this.panelHtml = "";
    this.update();
  }

  private renderPanel(): void {
    const nSel = this.selected.length;
    const tips: Record<Mode, string> = {
      select: nSel ? `${nSel} selected · drag to move (Ctrl: grid steps) or type dx,dy + Enter · J: join · Shift+click: add / remove · Del: delete` : "Click an outline or a path to select it · Shift+click to add more",
      line: this.first ? "Click the next point · click the start point to close · Enter / double-click: done (left open: a path) · type a length + Enter" : "Click the first point (corners, middles, crossings, centres snap) · type x,y + Enter",
      arc: !this.first ? "Click where the arc starts"
        : this.arcR ? `R ${num(this.arcR)} set — move the mouse to the side the arc should ${this.path.length ? "turn" : "bulge"}, then click (or Enter: place it, done) · Esc: clear R`
        : this.path.length ? "Click the arc's end (it bends on from the last segment) · Enter / double-click: done (left open: a path) · type a radius + Enter to fix it · L: back to lines" : this.arcEnd ? "Click a point the arc passes through (near a half circle it snaps to one) · Enter / double-click: done (left open: a path) · type a radius + Enter to fix it" : "Click the arc's end point · type a radius + Enter to fix it",
      rect: this.anchor ? "Click the opposite corner · type width,height (or 23x30) + Enter" : "Click the first corner",
      circle: this.anchor ? "Click a point on the circle · type the radius + Enter" : "Click the centre",
    };
    const btn = (m: Mode, label: string, key: string) => `<button type="button" class="btn${this.mode === m ? " primary" : ""}" data-mode="${m}" title="${label} (${key})">${label} <kbd>${key}</kbd></button>`;
    const closed = this.loops.length, open = this.opens.length;
    const joinBtn = this.mode === "select" ? `<button type="button" class="btn" data-act="join" ${nSel >= 2 ? "" : "disabled"} title="Join the selected outlines into one face (paths: end to end into one) — J">Join <kbd>J</kbd></button>` : "";
    const html = `<h4>Sketch on ${this.what}</h4>
      <div class="modes">${btn("select", "Select", "Esc")}${btn("line", "Line", "L")}${btn("arc", "Arc", "A")}${btn("rect", "Rectangle", "R")}${btn("circle", "Circle", "C")}${joinBtn}</div>
      <div class="tip">${tips[this.mode]}</div>
      <div class="muted">${closed ? `${closed} closed outline${closed > 1 ? "s" : ""}` : "No closed outline yet"}${open ? ` · ${open} open path${open > 1 ? "s" : ""}` : ""} · ${this.mode === "select" ? "L A R C: draw" : "Esc: drop the outline being drawn, again: Select"} · Ctrl+Z: undo</div>
      <div class="op-buttons"><button type="button" class="btn primary" data-act="done" title="Keep the closed outlines as flat faces">Done</button><button type="button" class="btn" data-act="cancel" title="Drop the sketch">Cancel</button></div>`;
    // Pro layout: one row of modes, Done / Cancel — no tips.
    const pro = document.body.classList.contains("pro");
    const proHtml = `<div class="modes">${btn("select", "Select", "Esc")}${btn("line", "Line", "L")}${btn("arc", "Arc", "A")}${btn("rect", "Rect", "R")}${btn("circle", "Circle", "C")}${joinBtn}<span class="spacer"></span><button type="button" class="btn primary" data-act="done" title="Keep the closed outlines as flat faces, open lines as paths">Done</button><button type="button" class="btn" data-act="cancel" title="Drop the sketch">Cancel</button></div>`;
    const out = pro ? proHtml : html;
    this.panel.classList.toggle("compact", pro);
    if (out !== this.panelHtml) this.panel.innerHTML = this.panelHtml = out;
    if (pro) return this.host.hint(this.mode === "select" ? `Sketch — select${nSel ? `: ${nSel}, Del deletes` : ""} — L A R C: draw` : "Sketch — L line, A arc, R rect, C circle — Enter: done");
    this.host.hint(`Sketch: ${tips[this.mode]} · L line · A arc · R rectangle · C circle · Done / Cancel in the panel`);
  }
}
