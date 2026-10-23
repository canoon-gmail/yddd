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
 * Cancel drops the sketch. Esc only drops the outline being drawn (then switches to Select — a right
 * click goes straight there, keeping what is being drawn: click an
 * outline or a path to select it, Shift+click adds, drag moves (typed dx,dy too), S scales or rotates about the
 * selection's centre (mouse or a typed %), J joins — outlines into one face, paths end to end into
 * one path —, Del deletes);
 * Ctrl+Z / Backspace undo a step.
 */
import * as THREE from "three";
import type { Tool, ToolHost } from "./tools";
import { joinFlatFaces, sketchFaces, sketchPath, tessellate, type Shape, type SketchLoop, type SketchSeg, type V3, type Wire } from "./kernel";
import { num } from "./format";
import { ICONS } from "./icons";

/** A point in the sketch plane: [u, v] along the frame's x / y. */
type P = [number, number];
/**
 * spline: a freeform curve (what an arc / circle becomes when stretched unevenly) — rational quadratic
 * pieces end to end: `pts` = 2n+1 control points (pts[0] = a, the last = b, every 2nd one on the curve),
 * `w` their weights. Exact for circles / arcs, and stays exact when scaled (only the points move).
 */
type Seg = { kind: "line"; a: P; b: P } | { kind: "arc"; a: P; m: P; b: P } | { kind: "spline"; a: P; b: P; pts: P[]; w: number[] };
/** A closed outline; `g`: its join group (outlines joined with J become one face at Done). */
type Loop = ({ kind: "path"; segs: Seg[] } | { kind: "circle"; c: P; r: number }) & { g?: number };
type Mode = "select" | "line" | "arc" | "rect" | "circle" | "picture";
/** A selectable part of the sketch: a closed outline or an open path (by index). */
type Item = { kind: "loop" | "open"; i: number };
const sameItem = (a: Item | null, b: Item | null) => !!a && !!b && a.kind === b.kind && a.i === b.i;
/** Select: how near (px) a line must be to pick it. */
const PICK_PX = 6;
/** Select: a press that moves further than this (px) is a drag (moves the selection), else a click. */
const DRAG_PX = 4;

const moveP = (p: P, d: P): P => [p[0] + d[0], p[1] + d[1]];
/** A segment with each of its points mapped by f. */
const mapSeg = (g: Seg, f: (p: P) => P): Seg => {
  if (g.kind === "line") return { kind: "line", a: f(g.a), b: f(g.b) };
  if (g.kind === "arc") return { kind: "arc", a: f(g.a), m: f(g.m), b: f(g.b) };
  const pts = g.pts.map(f);
  return { kind: "spline", a: pts[0], b: pts[pts.length - 1], pts, w: g.w };
};
const moveSeg = (g: Seg, d: P): Seg => mapSeg(g, (p) => moveP(p, d));
/** The same segment run the other way. */
const revSeg = (g: Seg): Seg => (g.kind === "line" ? { kind: "line", a: g.b, b: g.a } : g.kind === "arc" ? { kind: "arc", a: g.b, m: g.m, b: g.a } : { kind: "spline", a: g.b, b: g.a, pts: [...g.pts].reverse(), w: [...g.w].reverse() });
/** Scaling about c by kx along X, ky along Y — unevenly, arcs / circles become freeform curves (they'd be ellipses). */
const scaleP = (p: P, c: P, kx: number, ky: number): P => [c[0] + (p[0] - c[0]) * kx, c[1] + (p[1] - c[1]) * ky];
const scaleSeg = (g: Seg, c: P, kx: number, ky: number): Seg => {
  const even = Math.abs(kx - ky) < 1e-12;
  return mapSeg(g.kind === "arc" && !even ? arcSpline(g) : g, (p) => scaleP(p, c, kx, ky));
};
const scaleLoop = (l: Loop, c: P, kx: number, ky: number): Loop => {
  if (l.kind === "circle" && Math.abs(kx - ky) < 1e-12) return { ...l, c: scaleP(l.c, c, kx, ky), r: l.r * Math.abs(kx) };
  const segs = l.kind === "circle" ? [circleSpline(l.c, l.r)] : l.segs;
  return { ...l, kind: "path", segs: segs.map((g) => scaleSeg(g, c, kx, ky)) } as Loop;
};
/** Turning about c by a (radians, + = counter-clockwise) — arcs / circles stay exact. */
const rotP = (p: P, c: P, a: number): P => {
  const cs = Math.cos(a), sn = Math.sin(a), x = p[0] - c[0], y = p[1] - c[1];
  return [c[0] + x * cs - y * sn, c[1] + x * sn + y * cs];
};
const rotLoop = (l: Loop, c: P, a: number): Loop => (l.kind === "circle" ? { ...l, c: rotP(l.c, c, a) } : { ...l, segs: l.segs.map((g) => mapSeg(g, (p) => rotP(p, c, a))) });
/** Scale / rotate gizmo handles: X (red square), Y (green square), XY (yellow ring, even), rotate (blue ring, top left). */
type Handle = "x" | "y" | "xy" | "rot";
/** How near (px) the cursor must be to grab a handle; how far (px) the handles sit outside the selection. */
const HANDLE_PX = 10, HANDLE_PAD_PX = 16;
/** Move gizmo (G) parts: X arrow (red), Y arrow (green), XY square (yellow, free) — its sizes (px). */
type MoveHandle = "x" | "y" | "xy";
const MOVE_ARROW_PX = 80, MOVE_SQ_PX = 26, MOVE_SQ_HALF_PX = 9;
/** Ctrl while scaling: the nearest of these. */
const SCALE_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 10];
const moveLoop = (l: Loop, d: P): Loop => (l.kind === "circle" ? { ...l, c: moveP(l.c, d) } : { ...l, segs: l.segs.map((g) => moveSeg(g, d)) });

/**
 * A picture to trace (shown only while sketching — never part of the model), remembered per sketch plane
 * for the session: its texture, size (mm) and placement in world space (centre; `u`: along its width).
 */
interface StoredPicture {
  tex: THREE.Texture;
  opacity: number;
  /** Its width when loaded (100%), and its turn since then (rad, + = counter-clockwise). */
  w0: number;
  turned: number;
  w: number;
  h: number;
  center: THREE.Vector3;
  u: THREE.Vector3;
}
const pictures = new Map<string, StoredPicture>();
/** The same plane (the same face) gives the same key: its normal and distance from the origin. */
const planeKey = (f: SketchFrame) => [...f.z.toArray().map((v) => v.toFixed(3)), f.origin.dot(f.z).toFixed(2)].join(",");
const PICTURE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp" };

/** A small square thumbnail of a picture (the whole picture, centred). */
function thumbOf(tex: THREE.Texture): HTMLCanvasElement {
  const img = tex.image as HTMLImageElement | HTMLCanvasElement, cv = document.createElement("canvas"), n = 44;
  cv.width = cv.height = n;
  const k = n / Math.max(img.width, img.height, 1), w = img.width * k, h = img.height * k;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect((n - w) / 2, (n - h) / 2, w, h);
  g.drawImage(img, (n - w) / 2, (n - h) / 2, w, h);
  return cv;
}

/** Width of a sketch's open paths on screen, px (outlines are 1 px). */
const PATH_WIDTH = 2.5;

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
  if (g.kind === "spline") return splinePoints(g);
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
  if (g.kind === "spline") {
    // (along the last control point → the end; a piece squeezed flat: from further back)
    const q = [...g.pts].reverse().find((p) => !same(p, g.b));
    return norm(q ? sub(g.b, q) : sub(g.b, g.a));
  }
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

/** Rational quadratic pieces of a circle arc (centre c, radius r, from angle a0, signed sweep): ≤ 90° each. */
function arcPieces(c: P, r: number, a0: number, sweep: number): { pts: P[]; w: number[] } {
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9)), th = sweep / n, wm = Math.cos(th / 2);
  const at = (t: number, k = r): P => [c[0] + k * Math.cos(t), c[1] + k * Math.sin(t)];
  const pts: P[] = [at(a0)], w = [1];
  for (let i = 0; i < n; i++) {
    pts.push(at(a0 + th * (i + 0.5), r / wm), at(a0 + th * (i + 1)));
    w.push(wm, 1);
  }
  return { pts, w };
}

/** An arc as a freeform curve (the same shape — exact). */
function arcSpline(g: Extract<Seg, { kind: "arc" }>): Seg {
  const k = arcGeom(g);
  if (!k) return { kind: "line", a: g.a, b: g.b };
  const { pts, w } = arcPieces(k.c, k.r, k.a0, k.sweep);
  pts[0] = g.a;
  pts[pts.length - 1] = g.b;
  return { kind: "spline", a: g.a, b: g.b, pts, w };
}

/** A full circle as one closed freeform curve (starting and ending on its right-hand side). */
function circleSpline(c: P, r: number): Seg {
  const { pts, w } = arcPieces(c, r, 0, TAU);
  pts[pts.length - 1] = pts[0];
  return { kind: "spline", a: pts[0], b: pts[0], pts, w };
}

/** Point on piece i (0-based) of a freeform curve at t ∈ [0, 1]. */
function splineAt(g: Extract<Seg, { kind: "spline" }>, i: number, t: number): P {
  const [p0, p1, p2] = g.pts.slice(2 * i, 2 * i + 3), [w0, w1, w2] = g.w.slice(2 * i, 2 * i + 3);
  const b0 = (1 - t) * (1 - t) * w0, b1 = 2 * t * (1 - t) * w1, b2 = t * t * w2, s = b0 + b1 + b2;
  return [(b0 * p0[0] + b1 * p1[0] + b2 * p2[0]) / s, (b0 * p0[1] + b1 * p1[1] + b2 * p2[1]) / s];
}

/** Points along a freeform curve, from a (included) to b (left out); `per`: per piece. */
function splinePoints(g: Extract<Seg, { kind: "spline" }>, per = 24): P[] {
  const n = (g.pts.length - 1) / 2, out: P[] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < per; j++) out.push(splineAt(g, i, j / per));
  return out;
}

/** A segment's middle point (a freeform curve: the middle of its pieces). */
function segMid(g: Seg): P {
  if (g.kind === "line") return mul(add(g.a, g.b), 0.5);
  if (g.kind === "arc") return g.m;
  const n = (g.pts.length - 1) / 2;
  return n % 2 ? splineAt(g, (n - 1) / 2, 0.5) : g.pts[n];
}

function loopPolygon(l: Loop): P[] {
  if (l.kind === "circle") return Array.from({ length: 72 }, (_, i) => [l.c[0] + l.r * Math.cos((i / 72) * TAU), l.c[1] + l.r * Math.sin((i / 72) * TAU)] as P);
  return l.segs.flatMap(segPoints);
}

/** A sketch line, or a circle / arc (sweep: signed, ±2π for a full circle). */
type Curve = { kind: "line"; a: P; b: P } | { kind: "arc"; c: P; r: number; a0: number; sweep: number } | Extract<Seg, { kind: "spline" }>;

function curvesOf(loops: Loop[], path: Seg[]): Curve[] {
  const seg = (g: Seg): Curve | null => {
    if (g.kind !== "arc") return g;
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
  if (p.kind !== "spline" && q.kind === "spline") return crossings(q, p);
  if (p.kind === "spline") {
    // With a line: exact (each piece put into the line's equation is a quadratic in t). Else: along
    // short chords of the freeform curve (close enough to snap to).
    if (q.kind === "line") return splineLineCrossings(p, q);
    const pts = [...splinePoints(p, 64), p.b], out: P[] = [];
    for (let i = 0; i + 1 < pts.length; i++) out.push(...crossings(q, { kind: "line", a: pts[i], b: pts[i + 1] }));
    return out;
  }
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

/** Where a freeform curve crosses a line segment. */
function splineLineCrossings(g: Extract<Seg, { kind: "spline" }>, l: { a: P; b: P }): P[] {
  const EPS = 1e-9, d = sub(l.b, l.a), L = len(d);
  if (L < EPS) return [];
  const nrm: P = [-d[1] / L, d[0] / L], out: P[] = [];
  for (let i = 0; i < (g.pts.length - 1) / 2; i++) {
    // Σ wk·Bk(t)·hk = 0, hk: the control points' signed distances from the line.
    const [h0, h1, h2] = [0, 1, 2].map((k) => g.w[2 * i + k] * dot(sub(g.pts[2 * i + k], l.a), nrm));
    const A = h0 - 2 * h1 + h2, B = 2 * (h1 - h0), C = h0;
    let ts: number[];
    if (Math.abs(A) < 1e-12) ts = Math.abs(B) < 1e-12 ? [] : [-C / B];
    else {
      const disc = B * B - 4 * A * C;
      if (disc < -EPS) continue;
      const sq = Math.sqrt(Math.max(0, disc));
      ts = [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
    }
    for (const t of ts) {
      if (t < -EPS || t > 1 + EPS) continue;
      const x = splineAt(g, i, Math.min(1, Math.max(0, t))), u = dot(sub(x, l.a), d) / (L * L);
      if (u >= -EPS && u <= 1 + EPS && !out.some((y) => same(x, y))) out.push(x);
    }
  }
  return out;
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

/** Distance from p to a closed polygon's outline. */
function edgeDist(p: P, poly: P[]): number {
  let d = Infinity;
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], ab = sub(poly[(k + 1) % poly.length], a), l2 = dot(ab, ab);
    const t = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2)) : 0;
    d = Math.min(d, dist(p, add(a, mul(ab, t))));
  }
  return d;
}

/**
 * Outer outlines with their holes: an outline inside an odd number of others is a hole of the
 * smallest one around it. Inside = all of it inside or on the other's outline (one that only touches
 * or overlaps another — a half circle on a rectangle's side, two crossing circles — isn't); outlines
 * joined with J are never holes of each other.
 */
function nest(loops: Loop[]): { outer: number; holes: number[] }[] {
  const polys = loops.map(loopPolygon), areas = polys.map(polyArea);
  const within = (i: number, j: number) => {
    const tol = 1e-6 * Math.max(1, Math.sqrt(areas[j]));
    return polys[i].every((p) => inside(p, polys[j]) || edgeDist(p, polys[j]) < tol);
  };
  const joined = (i: number, j: number) => loops[i].g !== undefined && loops[i].g === loops[j].g;
  const parents = loops.map((_, i) => loops.map((_, j) => j).filter((j) => j !== i && !joined(i, j) && areas[j] > areas[i] && within(i, j)));
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
  /** The tool it was in (undo back to a half-drawn outline: that tool again). */
  mode?: Mode;
}

export class SketchTool implements Tool {
  readonly name = "Sketch";
  private mode: Mode = "line";
  /** Closed outlines. */
  private loops: Loop[] = [];
  /** Select mode: the selected outlines / paths, and the one under the cursor. */
  private selected: Item[] = [];
  private hoverItem: Item | null = null;
  /** Scaling the selection (S): about c; the cursor's distance from c over r0 is the factor. */
  private scaling: {
    c: P;
    /** Half the selection's size (X, Y): where the handles sit. */
    ext: P;
    kx: number;
    ky: number;
    /** The turn (radians, + = counter-clockwise), after the scaling — the X / Y handles turn with it. */
    ang: number;
    /** The selection has arcs / circles (scaled unevenly they become freeform curves). */
    curves: boolean;
    loops: Loop[];
    opens: Seg[][];
    snap: string;
    /** The handle being dragged (from `grab`, the factors then `k0`, the turn `a0`), or under the cursor. */
    handle: Handle | null;
    grab: P | null;
    k0: P;
    a0: number;
    hover: Handle | null;
  } | null = null;
  /** Moving the selection with the gizmo (G): from where it was (c0, loops, opens) by d; the part being dragged (from `grab`, the offset then `d0`), or under the cursor. */
  private moving: { c0: P; d: P; loops: Loop[]; opens: Seg[][]; snap: string; handle: MoveHandle | null; grab: P | null; d0: P; hover: MoveHandle | null } | null = null;
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
  /** The sketch `version` the 3D corner view was last framed for. */
  private insetVersion = -1;
  /** Bumped on every change to the outlines (keeps the crossing points cached until then). */
  private version = 0;
  private crossCache: { version: number; pts: P[] } | null = null;
  private groupCache: { version: number; views: Map<number, { tris: THREE.BufferGeometry; lines: THREE.BufferGeometry } | null> } | null = null;
  private saved: { camera: ReturnType<ToolHost["viewport"]["cameraState"]>; xray: boolean } | null = null;
  /** Bottom-left corner icons: turn the view, load a picture — and, with one loaded, its thumbnail (hover: its menu). */
  private corner: HTMLElement;
  /** The picture to trace: centre, angle (rad, from the plane's x), size (mm). */
  private pic: { tex: THREE.Texture; mat: THREE.MeshBasicMaterial; c: P; ang: number; w: number; h: number; thumb: HTMLCanvasElement; w0: number; turned: number } | null = null;
  /** The mode to go back to when Picture mode ends (a click off the picture). */
  private prevMode: Mode = "select";
  /**
   * Picture mode: its handles at its bottom-right corner — a square on the corner (scale) and a ring a little
   * past it (rotate), both about its centre; `drag`: the one being dragged (from `at`; the picture's size and
   * turn then), `hover`: the one under the cursor.
   */
  private picGrip: { hover: "scale" | "rotate" | null; drag: { kind: "scale" | "rotate"; at: P; w: number; turned: number } | null } = { hover: null, drag: null };
  /** Picture mode, Match: two points on the picture, then the two on the model they belong at. */
  private picPts: P[] = [];
  /** Picture mode: a press — dragging moves the picture, else a click (a Match point). */
  private picDrag: { x: number; y: number; at: P; c0: P; moved: boolean } | null = null;
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
      else if (b.dataset.act === "scale") this.scaling ? this.endScale(true) : this.startScale();
      else if (b.dataset.act === "move") this.moving ? this.endMove(true) : this.startMove();
    });
    host.viewport.canvas.parentElement!.appendChild(this.panel);
    this.corner = document.createElement("div");
    this.corner.id = "sketch-corner";
    this.corner.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("button");
      if (!b) return;
      b.blur();
      const p = this.pic, act = b.dataset.act;
      if (act === "turn") this.turnView();
      else if (act === "picture") void this.loadPicture();
      else if (!p) return;
      else if (act === "pic") this.setMode(this.mode === "picture" ? this.prevMode : "picture"); // (on / off)
      else if (act === "pic-remove") {
        this.removePicture();
        this.host.toast("Picture removed");
        if (this.mode === "picture") this.setMode(this.prevMode);
        else this.update();
      }
    });
    // The menu's fields: Scale % (of its size when loaded), Rotate ° (since loaded), Transparent % — typed, or
    // the mouse wheel over one (Shift: finer steps)
    this.corner.addEventListener("input", (e) => this.picField(e.target as HTMLInputElement));
    this.corner.addEventListener("wheel", (e) => {
      const f = e.target as HTMLInputElement;
      if (!f.dataset?.act?.startsWith("pic-")) return;
      e.preventDefault();
      const step = Number(f.dataset.step) / (e.shiftKey ? 5 : 1);
      const v = Number(f.value) + (e.deltaY < 0 ? step : -step);
      f.value = String(+(f.type === "range" ? Math.min(Number(f.max), Math.max(Number(f.min), v)) : f.dataset.act === "pic-scale" ? Math.max(step, v) : v).toFixed(2));
      this.picField(f);
    }, { passive: false });
    this.corner.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === "Escape") && e.target instanceof HTMLInputElement) e.target.blur();
    });
    host.viewport.canvas.parentElement!.appendChild(this.corner);
    const st = pictures.get(planeKey(frame));
    if (st) this.pic = { tex: st.tex, mat: this.picMat(st.tex, st.opacity), c: this.local(st.center), ang: Math.atan2(st.u.dot(frame.y), st.u.dot(frame.x)), w: st.w, h: st.h, thumb: thumbOf(st.tex), w0: st.w0, turned: st.turned };
    this.renderCorner();
  }

  /** A menu field changed: the picture follows. */
  private picField(f: HTMLInputElement): void {
    const p = this.pic, v = Number(f.value);
    if (!p || f.value === "" || !Number.isFinite(v)) return;
    if (f.dataset.act === "pic-scale" && v > 0) this.placePicture((p.w0 * v) / 100 / p.w);
    else if (f.dataset.act === "pic-rotate") this.placePicture(1, null, (v * Math.PI) / 180 - p.turned);
    else if (f.dataset.act === "pic-clear") {
      p.mat.opacity = 1 - v / 100;
      this.storePicture();
    } else return;
    this.update();
  }

  /** The menu's fields show the picture as it is (e.g. after a Match) — the one being typed in stays as typed. */
  private syncPicMenu(): void {
    const p = this.pic;
    if (!p) return;
    const deg = (((p.turned * 180) / Math.PI + 540) % 360) - 180;
    const vals: Record<string, string> = { "pic-scale": num((p.w / p.w0) * 100), "pic-rotate": num(Math.abs(deg) < 1e-9 ? 0 : deg), "pic-clear": String(Math.round((1 - p.mat.opacity) * 100)) };
    for (const f of this.corner.querySelectorAll<HTMLInputElement>(".pic-menu input")) {
      if (f !== document.activeElement && f.value !== vals[f.dataset.act!]) f.value = vals[f.dataset.act!];
      if (f.dataset.act === "pic-clear") f.nextElementSibling!.textContent = `${f.value}%`;
    }
  }

  /** The corner icons; with a picture: a gap, then its thumbnail, its menu shown on hover. */
  private renderCorner(): void {
    this.corner.innerHTML = `<button type="button" data-act="turn" title="Turn the view a quarter (the sketch stays as it is)">${ICONS.turnView}</button><button type="button" data-act="picture" title="Load a picture to trace (shown only while sketching, remembered for this face)">${ICONS.picture}</button>`;
    const p = this.pic;
    if (!p) return;
    const clear = Math.round((1 - p.mat.opacity) * 100);
    const wrap = document.createElement("div");
    wrap.className = `pic-wrap${this.mode === "picture" ? " on" : ""}`;
    wrap.innerHTML = `<button type="button" class="pic-thumb" data-act="pic" title="The picture — click: work on it (drag to move, scale, rotate, transparency, match) · click again: done"></button>
      <div class="pic-menu"><div class="box">
        <label class="row"><span>Scale</span><input type="number" data-act="pic-scale" data-step="5" min="0" step="any" title="Size, % of the size it was loaded at — mouse wheel: ±5 (Shift: ±1)"><em>%</em></label>
        <label class="row"><span>Rotate</span><input type="number" data-act="pic-rotate" data-step="5" step="any" title="Turn, ° (+ = counter-clockwise) — mouse wheel: ±5 (Shift: ±1)"><em>°</em></label>
        <label class="row"><span>Transparent</span><input type="range" data-act="pic-clear" data-step="5" min="0" max="95" step="1" value="${clear}"><output>${clear}%</output></label>
        <div class="row"><button type="button" class="btn" data-act="pic-remove">Remove picture</button></div>
      </div></div>`;
    wrap.querySelector(".pic-thumb")!.appendChild(p.thumb);
    this.corner.appendChild(wrap);
    this.syncPicMenu();
  }

  // ------------------------------------------------------------ view, picture

  /** Turn the view a quarter about the plane's normal (e.g. when the sketch opened sideways). */
  private turnView(): void {
    const vp = this.host.viewport, s = vp.cameraState();
    s.up.applyAxisAngle(s.target.clone().sub(s.position).normalize(), -Math.PI / 2);
    vp.restoreCamera(s);
  }

  private picMat(tex: THREE.Texture, opacity = 0.55): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
  }

  /** Load a picture to trace (replacing one): centred in the view, most of its height. */
  private async loadPicture(): Promise<void> {
    const file = await window.y3d.openFile({ title: "Picture to trace", filters: [{ name: "Pictures", extensions: Object.keys(PICTURE_TYPES) }], binary: true });
    if (!file) return;
    try {
      await this.pictureFromBytes(file.data as Uint8Array<ArrayBuffer>, file.path.split(".").pop()!.toLowerCase());
      this.host.toast("Picture loaded — drag it to move, type a % + Enter to scale, or click 2 points on it and then where they belong on the model");
    } catch (e) {
      this.host.toast(`Couldn't read the picture "${file.path}"${e instanceof Error && e.message ? ` (${e.message})` : ""}`, "error");
    }
  }

  /** A picture file's bytes (`ext`: its type) as the picture. */
  async pictureFromBytes(data: Uint8Array<ArrayBuffer>, ext: string): Promise<void> {
    const url = URL.createObjectURL(new Blob([data], { type: PICTURE_TYPES[ext] ?? "image/png" }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      this.setPicture(img);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Show `img` as the picture (replacing one): centred in the view, upright on screen, 70% of its height. */
  setPicture(img: HTMLImageElement | HTMLCanvasElement): void {
    const tex = new THREE.Texture(img);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    const vp = this.host.viewport, s = vp.cameraState();
    const h = vp.worldPerPixel(s.target) * vp.canvas.clientHeight * 0.7, aspect = img.width / Math.max(1, img.height);
    this.removePicture();
    const up = this.local(s.target.clone().add(s.up)), c = this.local(s.target);
    this.pic = { tex, mat: this.picMat(tex), c, ang: Math.atan2(up[1] - c[1], up[0] - c[0]) - Math.PI / 2, w: h * aspect, h, thumb: thumbOf(tex), w0: h * aspect, turned: 0 };
    this.storePicture();
    this.renderCorner();
    this.setMode("picture");
  }

  private storePicture(): void {
    const p = this.pic;
    if (!p) return;
    const u = this.frame.x.clone().multiplyScalar(Math.cos(p.ang)).addScaledVector(this.frame.y, Math.sin(p.ang));
    pictures.set(planeKey(this.frame), { tex: p.tex, opacity: p.mat.opacity, w0: p.w0, turned: p.turned, w: p.w, h: p.h, center: this.world(p.c), u });
  }

  /** The picture's corners (in the plane). */
  private picCorners(): P[] {
    const p = this.pic!, cs = Math.cos(p.ang), sn = Math.sin(p.ang);
    return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as P[]).map(([i, j]) => {
      const x = (i * p.w) / 2, y = (j * p.h) / 2;
      return add(p.c, [x * cs - y * sn, x * sn + y * cs]);
    });
  }

  /** Where the picture's handles are: its bottom-right corner (scale), a little past it (rotate). */
  private picGripPos(kind: "scale" | "rotate"): P {
    const p = this.pic!, k = this.picCorners()[1];
    if (kind === "scale") return k;
    return add(k, mul(norm(sub(k, p.c)), 22 * this.host.viewport.worldPerPixel(this.world(k))));
  }

  /** The picture's handle under the cursor. */
  private picGripAt(e: PointerEvent): "scale" | "rotate" | null {
    if (!this.pic || this.picPts.length) return null;
    const vp = this.host.viewport;
    for (const kind of ["scale", "rotate"] as const) {
      const s = vp.toScreen(this.world(this.picGripPos(kind)));
      if (Math.hypot(s.x - e.clientX, s.y - e.clientY) <= HANDLE_PX) return kind;
    }
    return null;
  }

  /** Dragging a picture handle: scale (by the cursor's distance from the centre) or rotate (by its turn about it); when snapping: 5% / 15° steps. */
  private picGripTo(e: PointerEvent): void {
    const p = this.pic!, g = this.picGrip.drag!, q = this.planeAt(e);
    if (!q) return;
    const ctrl = this.host.snapStep(e) > 0;
    if (g.kind === "scale") {
      let pct = ((g.w * dist(q, p.c)) / Math.max(dist(g.at, p.c), 1e-9) / p.w0) * 100;
      if (ctrl) pct = Math.round(pct / 5) * 5;
      if (pct > 0.5) this.placePicture((p.w0 * pct) / 100 / p.w);
    } else {
      let deg = ((g.turned + Math.atan2(q[1] - p.c[1], q[0] - p.c[0]) - Math.atan2(g.at[1] - p.c[1], g.at[0] - p.c[0])) * 180) / Math.PI;
      if (ctrl) deg = Math.round(deg / 15) * 15;
      this.placePicture(1, null, (deg * Math.PI) / 180 - p.turned);
    }
    this.update();
  }

  /** Is q on the picture? */
  private onPicture(q: P): boolean {
    const p = this.pic;
    if (!p) return false;
    const d = sub(q, p.c), cs = Math.cos(p.ang), sn = Math.sin(p.ang);
    return Math.abs(d[0] * cs + d[1] * sn) <= p.w / 2 && Math.abs(-d[0] * sn + d[1] * cs) <= p.h / 2;
  }

  /** Drop the picture (and forget it for this plane). */
  private removePicture(): void {
    if (!this.pic) return;
    this.pic.mat.dispose();
    this.pic.tex.dispose();
    this.pic = null;
    this.picPts = [];
    pictures.delete(planeKey(this.frame));
    this.renderCorner();
  }

  /** Scale the picture by k about q (default: its centre), turn it by `rot` and move it so q lands on `to`. */
  private placePicture(k: number, q: P | null = null, rot = 0, to: P | null = null): void {
    const p = this.pic!, a = q ?? p.c, d = mul(sub(p.c, a), k), cs = Math.cos(rot), sn = Math.sin(rot);
    p.c = add(to ?? a, [d[0] * cs - d[1] * sn, d[0] * sn + d[1] * cs]);
    p.w *= k;
    p.h *= k;
    p.ang += rot;
    p.turned += rot;
    this.storePicture();
  }

  /** Picture mode: a click — the next Match point (2 on the picture, then 2 on the model: they're matched up). */
  private picClick(e: PointerEvent): void {
    const n = this.picPts.length, p = n < 2 ? this.planeAt(e) : this.pointAt(e);
    if (!p) return;
    if (n % 2 === 1 && same(p, this.picPts[n - 1])) return this.host.hint("Sketch: the two points must differ");
    this.picPts.push(p);
    if (this.picPts.length < 4) return this.update();
    const [a1, a2, b1, b2] = this.picPts, da = sub(a2, a1), db = sub(b2, b1);
    this.picPts = [];
    this.placePicture(len(db) / len(da), a1, Math.atan2(db[1], db[0]) - Math.atan2(da[1], da[0]), b1);
    this.host.viewport.showSnapMarker(null);
    this.host.toast(`Picture matched — scaled ${num((len(db) / len(da)) * 100)}%`);
    this.update();
  }

  /**
   * Existing outlines / paths (in 3D, on the sketch's plane) to edit: they start out in the sketch
   * (not an undo step — Cancel leaves the originals as they were).
   */
  load(loops: SketchLoop[], opens: SketchSeg[][]): this {
    const p2 = (p: V3): P => this.local(new THREE.Vector3(...p));
    const seg = (g: SketchSeg): Seg => {
      if (g.kind === "line") return { kind: "line", a: p2(g.a), b: p2(g.b) };
      if (g.kind === "arc") return { kind: "arc", a: p2(g.a), m: p2(g.m), b: p2(g.b) };
      const pts = g.pts.map(p2);
      return { kind: "spline", a: pts[0], b: pts[pts.length - 1], pts, w: g.w };
    };
    for (const l of loops) this.loops.push(l.kind === "circle" ? { kind: "circle", c: p2(l.c), r: l.r } : { kind: "path", segs: l.segs.map(seg) });
    for (const segs of opens) this.opens.push(segs.map(seg));
    this.version++;
    return this;
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
    this.corner.remove();
    this.pic?.mat.dispose(); // (the texture stays, remembered for this plane)
    for (const m of [...Object.values(this.mats), ...this.gizmoMats.values()]) m.dispose();
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
      pts.push({ p: segMid(g), kind: "midpoint" });
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

  /** Cursor point in the plane: the sketch's own points, then the model's points, else the plane (grid when snapping). Auto snap + Ctrl: free, no points. */
  private pointAt(e: PointerEvent): P | null {
    const vp = this.host.viewport;
    this.lock = -1;
    this.aligned = [];
    const free = vp.autoSnap && e.ctrlKey;
    let best: { p: P; kind: "vertex" | "midpoint" | "center"; score: number } | null = null;
    for (const { p, kind } of free ? [] : this.ownPoints()) {
      const s = vp.toScreen(this.world(p));
      const d = Math.hypot(s.x - e.clientX, s.y - e.clientY);
      const score = d + (kind === "vertex" ? 0 : 4); // ends before middles / centres
      if (d <= SNAP_PX && (!best || score < best.score)) best = { p, kind, score };
    }
    if (best) {
      vp.showSnapMarker({ point: this.world(best.p), kind: best.kind });
      return best.p;
    }
    const sp = free ? null : vp.snapPoint(e.clientX, e.clientY);
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
    if (this.mode === "picture") {
      if (this.picGrip.drag) return this.picGripTo(e);
      const grip = this.picGripAt(e);
      if (grip !== this.picGrip.hover) this.picGrip.hover = grip;
      if (grip) {
        this.cursor = null;
        this.host.viewport.showSnapMarker(null);
        return this.update();
      }
      const dr = this.picDrag;
      if (dr && this.pic && this.picPts.length < 2 && (dr.moved || Math.hypot(e.clientX - dr.x, e.clientY - dr.y) >= DRAG_PX)) {
        const q = this.planeAt(e);
        if (!q) return;
        dr.moved = true;
        this.pic.c = add(dr.c0, sub(q, dr.at));
        this.cursor = null;
        return this.update();
      }
      this.cursor = this.picPts.length < 2 ? this.planeAt(e) : this.pointAt(e);
      if (this.picPts.length < 2) this.host.viewport.showSnapMarker(null);
      return this.update();
    }
    if (this.mode === "select") {
      const mv = this.moving;
      if (mv) {
        if (!mv.handle) {
          const h = this.moveHandleAt(e);
          if (h !== mv.hover) {
            mv.hover = h;
            this.update();
          }
          return;
        }
        const q = this.planeAt(e);
        if (!q) return;
        // An arrow: along its axis only; the square: free. In grid steps when snapping.
        let d = sub(q, mv.grab!);
        if (mv.handle === "x") d = [d[0], 0];
        else if (mv.handle === "y") d = [0, d[1]];
        d = add(mv.d0, d);
        const step = this.host.snapStep(e);
        if (step > 0) d = [Math.round(d[0] / step) * step, Math.round(d[1] / step) * step];
        return this.moveTo(d);
      }
      const sc = this.scaling;
      if (sc) {
        if (!sc.handle) {
          const h = this.handleAt(e);
          if (h !== sc.hover) {
            sc.hover = h;
            this.update();
          }
          return;
        }
        const q = this.planeAt(e), g = sc.grab!;
        if (!q) return;
        if (sc.handle === "rot") {
          // Rotate: by the cursor's turn about the centre; when snapping, 15° steps
          let deg = ((sc.a0 + Math.atan2(q[1] - sc.c[1], q[0] - sc.c[0]) - Math.atan2(g[1] - sc.c[1], g[0] - sc.c[0])) * 180) / Math.PI;
          deg = ((((deg + 180) % 360) + 360) % 360) - 180;
          if (this.host.snapStep(e) > 0) deg = Math.round(deg / 15) * 15;
          this.turnTo((deg * Math.PI) / 180);
          return;
        }
        // (X / Y: along the gizmo's turned axes)
        const lq = rotP(q, sc.c, -sc.ang), lg = rotP(g, sc.c, -sc.ang);
        const ratio = (k: 0 | 1) => (Math.abs(lg[k] - sc.c[k]) > 1e-9 ? (lq[k] - sc.c[k]) / (lg[k] - sc.c[k]) : 1);
        const f = sc.handle === "xy" ? dist(q, sc.c) / Math.max(dist(g, sc.c), 1e-9) : ratio(sc.handle === "x" ? 0 : 1);
        const snapK = (k: number) => (this.host.snapStep(e) > 0 ? SCALE_STEPS.reduce((b, x) => (Math.abs(x - k) < Math.abs(b - k) ? x : b)) : k);
        let kx = sc.k0[0], ky = sc.k0[1];
        if (sc.handle === "x") kx = snapK(Math.max(0.01, sc.k0[0] * f));
        else if (sc.handle === "y") ky = snapK(Math.max(0.01, sc.k0[1] * f));
        else {
          kx = snapK(Math.max(0.01, sc.k0[0] * f));
          ky = kx * (sc.k0[1] / sc.k0[0]);
        }
        this.scaleTo(kx, ky);
        return;
      }
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

  /** Dragging the selection: everything selected follows the cursor (in grid steps when snapping). */
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
    if (this.moving) this.endMove(true);
    const loopIdx = this.selected.filter((s) => s.kind === "loop").map((s) => s.i);
    const openIdx = this.selected.filter((s) => s.kind === "open").map((s) => s.i);
    if (loopIdx.length < 2 && openIdx.length < 2) {
      if (this.mode !== "select") this.setMode("select"); // (from drawing: pick them now)
      return this.host.hint("Join: select two or more outlines (or paths) first — Shift+click adds");
    }
    // Paths: chain them end to end (turning a path round where needed).
    let chain: Seg[] | null = null;
    if (openIdx.length >= 2) {
      const rev = (o: Seg[]): Seg[] => [...o].reverse().map(revSeg);
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
    // The result stays selected (e.g. S scales it next).
    const result: Item[] = [];
    if (loopIdx.length >= 2) {
      const g = Math.max(-1, ...this.loops.map((l) => l.g ?? -1)) + 1;
      const old = new Set(loopIdx.map((i) => this.loops[i].g).filter((x) => x !== undefined));
      this.loops = this.loops.map((l, i) => (loopIdx.includes(i) || (l.g !== undefined && old.has(l.g)) ? { ...l, g } : l));
      this.loops.forEach((l, i) => l.g === g && result.push({ kind: "loop", i }));
    }
    if (chain) {
      this.opens = this.opens.filter((_, i) => !openIdx.includes(i));
      if (same(chain[0].a, chain[chain.length - 1].b)) {
        this.loops.push({ kind: "path", segs: chain });
        result.push({ kind: "loop", i: this.loops.length - 1 });
      } else {
        this.opens.push(chain);
        result.push({ kind: "open", i: this.opens.length - 1 });
      }
    }
    this.selected = result;
    this.hoverItem = null;
    this.host.toast(chain && same(chain[0].a, chain[chain.length - 1].b) ? "Joined: the paths close into an outline" : "Joined");
    this.update();
  }

  /** The selection's centre (middle of its bounding box). */
  private selectionCenter(): P | null {
    const pts = this.selected.flatMap((it) => (it.kind === "loop" ? loopPolygon(this.loops[it.i]) : this.opens[it.i].flatMap((g) => [...segPoints(g), g.b])));
    if (!pts.length) return null;
    const lo = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))], hi = [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
    return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
  }

  /** S: the scale / rotate gizmo round the selection — drag its X / Y / XY handles or the rotate ring; Enter or a click elsewhere applies. */
  private startScale(): void {
    if (this.moving) this.endMove(true);
    const c = this.selectionCenter();
    if (!c) return this.host.hint("Scale / rotate: select outlines / paths first");
    const pts = this.selected.flatMap((it) => (it.kind === "loop" ? loopPolygon(this.loops[it.i]) : this.opens[it.i].flatMap((g) => [...segPoints(g), g.b])));
    const ext: P = [Math.max(...pts.map((p) => Math.abs(p[0] - c[0]))), Math.max(...pts.map((p) => Math.abs(p[1] - c[1])))];
    const curves = this.selected.some((it) => (it.kind === "loop" ? this.loops[it.i].kind === "circle" || (this.loops[it.i] as { segs: Seg[] }).segs.some((g) => g.kind === "arc") : this.opens[it.i].some((g) => g.kind === "arc")));
    this.scaling = { c, ext, kx: 1, ky: 1, ang: 0, curves, loops: this.loops, opens: this.opens, snap: JSON.stringify(this.state()), handle: null, grab: null, k0: [1, 1], a0: 0, hover: null };
    this.update();
  }

  /** Where a handle of the scale / rotate gizmo is (in the plane) — turned with the selection. */
  handlePos(h: Handle): P {
    const sc = this.scaling!, pad = HANDLE_PAD_PX * this.host.viewport.worldPerPixel(this.world(sc.c));
    const x = sc.ext[0] * sc.kx + pad, y = sc.ext[1] * sc.ky + pad;
    const d: P = h === "x" ? [x, 0] : h === "y" ? [0, y] : h === "rot" ? [-x, y] : [x, y];
    return rotP(add(sc.c, d), sc.c, sc.ang);
  }

  /** The handle under the cursor. */
  private handleAt(e: PointerEvent): Handle | null {
    const vp = this.host.viewport;
    for (const h of ["xy", "rot", "x", "y"] as Handle[]) {
      const s = vp.toScreen(this.world(this.handlePos(h)));
      if (Math.hypot(s.x - e.clientX, s.y - e.clientY) <= HANDLE_PX) return h;
    }
    return null;
  }

  /** Scale the selection (from where it was when S was pressed) by kx, ky; unevenly, its arcs / circles become freeform curves. */
  private scaleTo(kx: number, ky = kx): boolean {
    const sc = this.scaling!;
    sc.kx = kx;
    sc.ky = ky;
    return this.reshape();
  }

  /** Turn the selection (from where it was when S was pressed) by a (radians, + = counter-clockwise) about its centre. */
  private turnTo(a: number): boolean {
    this.scaling!.ang = a;
    return this.reshape();
  }

  /** The selection as it was when S was pressed, scaled (kx, ky) then turned (ang) about its centre. */
  private reshape(): boolean {
    const sc = this.scaling!, { c, kx, ky, ang } = sc;
    const sel = (kind: Item["kind"], i: number) => this.selected.some((x) => x.kind === kind && x.i === i);
    const seg = (g: Seg) => (ang ? mapSeg(scaleSeg(g, c, kx, ky), (p) => rotP(p, c, ang)) : scaleSeg(g, c, kx, ky));
    this.loops = sc.loops.map((l, i) => (sel("loop", i) ? (ang ? rotLoop(scaleLoop(l, c, kx, ky), c, ang) : scaleLoop(l, c, kx, ky)) : l));
    this.opens = sc.opens.map((o, i) => (sel("open", i) ? o.map(seg) : o));
    this.version++;
    this.update();
    return true;
  }

  private endScale(apply: boolean): void {
    const sc = this.scaling;
    if (!sc) return;
    this.scaling = null;
    if (apply && (Math.abs(sc.kx - 1) > 1e-12 || Math.abs(sc.ky - 1) > 1e-12 || Math.abs(sc.ang) > 1e-12)) this.undoStack.push(sc.snap);
    else {
      this.loops = sc.loops;
      this.opens = sc.opens;
      this.version++;
    }
    this.host.hud(null);
    this.update();
  }

  /** G: the move gizmo at the selection's centre — drag its X / Y arrows or the XY square; Enter or a click elsewhere applies. */
  private startMove(): void {
    if (this.scaling) this.endScale(true);
    if (this.moving) return;
    const c0 = this.selectionCenter();
    if (!c0) return this.host.hint("Move: select outlines / paths first, then G");
    this.moving = { c0, d: [0, 0], loops: this.loops, opens: this.opens, snap: JSON.stringify(this.state()), handle: null, grab: null, d0: [0, 0], hover: null };
    this.update();
  }

  /** The move gizmo's parts in the plane: its centre, the X / Y arrow tips, the XY square's middle; w: mm per pixel there. */
  private moveGizmo(): { o: P; x: P; y: P; sq: P; w: number } {
    const mv = this.moving!, o = add(mv.c0, mv.d), w = this.host.viewport.worldPerPixel(this.world(o));
    return { o, x: add(o, [MOVE_ARROW_PX * w, 0]), y: add(o, [0, MOVE_ARROW_PX * w]), sq: add(o, [MOVE_SQ_PX * w, MOVE_SQ_PX * w]), w };
  }

  /** The move gizmo part under the cursor. */
  private moveHandleAt(e: PointerEvent): MoveHandle | null {
    const vp = this.host.viewport, g = this.moveGizmo(), s = (p: P) => vp.toScreen(this.world(p));
    const sq = s(g.sq);
    if (Math.max(Math.abs(sq.x - e.clientX), Math.abs(sq.y - e.clientY)) <= MOVE_SQ_HALF_PX + 3) return "xy";
    const o = s(g.o);
    for (const h of ["x", "y"] as const) {
      const t = s(g[h]), dx = t.x - o.x, dy = t.y - o.y, l2 = dx * dx + dy * dy || 1;
      const k = ((e.clientX - o.x) * dx + (e.clientY - o.y) * dy) / l2;
      if (k > 0.2 && k < 1.1 && Math.hypot(e.clientX - o.x - k * dx, e.clientY - o.y - k * dy) <= HANDLE_PX) return h;
    }
    return null;
  }

  /** Move the selection (from where it was when G was pressed) by d. */
  private moveTo(d: P): void {
    const mv = this.moving!;
    mv.d = d;
    this.translateSelection(d, mv.loops, mv.opens);
  }

  /** The move gizmo goes: applied (one undo step) or put back. */
  private endMove(apply: boolean): void {
    const mv = this.moving;
    if (!mv) return;
    this.moving = null;
    if (apply && (mv.d[0] || mv.d[1])) this.undoStack.push(mv.snap);
    else if (!apply) {
      this.loops = mv.loops;
      this.opens = mv.opens;
      this.version++;
    }
    this.host.hud(null);
    this.update();
  }

  up(e: PointerEvent): void {
    if (this.picGrip.drag && e.button === 0) {
      this.picGrip.drag = null;
      this.host.hud(null);
      return this.update();
    }
    if (this.picDrag && e.button === 0) {
      const dr = this.picDrag;
      this.picDrag = null;
      if (dr.moved) this.storePicture();
      else this.picClick(e);
      return this.update();
    }
    if (this.moving?.handle) {
      // (let go: the gizmo stays for more; Enter / a click elsewhere applies)
      this.moving.handle = null;
      this.moving.grab = null;
      return this.update();
    }
    if (this.scaling?.handle) {
      // (one handle let go: the gizmo stays for more; Enter / a click elsewhere applies)
      this.scaling.handle = null;
      this.scaling.grab = null;
      return this.update();
    }
    const dr = this.drag;
    if (!dr || e.button !== 0) return;
    this.drag = null;
    if (dr.moved) this.undoStack.push(dr.snap);
    // A click (no drag) on one of several selected: just that one.
    else if (dr.wasSelected && !e.shiftKey) this.selected = this.groupOf(dr.item); // (a joined outline: its whole group)
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
    if (this.moving) this.endMove(true);
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
    if (this.mode === "picture") {
      const at = this.planeAt(e), grip = this.picGripAt(e);
      if (grip && at && this.pic) {
        this.picGrip.drag = { kind: grip, at, w: this.pic.w, turned: this.pic.turned };
        return this.update();
      }
      // A first click off the picture (no Match going on) only ends Picture mode — back to what it was.
      if (at && !this.picPts.length && !this.onPicture(at)) return this.setMode(this.prevMode);
      // (Match's last 2 points are on the model: those are clicks, not drags)
      if (this.pic && at) this.picDrag = { x: e.clientX, y: e.clientY, at, c0: this.pic.c, moved: false };
      return;
    }
    if (this.mode === "select") {
      if (this.moving) {
        const h = this.moveHandleAt(e), q = this.planeAt(e);
        if (!h || !q) return this.endMove(true); // (a click away from the gizmo: done)
        Object.assign(this.moving, { handle: h, grab: q, d0: this.moving.d });
        return this.update();
      }
      if (this.scaling) {
        const h = this.handleAt(e), q = this.planeAt(e);
        if (!h || !q) return this.endScale(true); // (a click away from the handles: done)
        Object.assign(this.scaling, { handle: h, grab: q, k0: [this.scaling.kx, this.scaling.ky], a0: this.scaling.ang });
        return this.update();
      }
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
    const lines = this.mode === "line" || this.mode === "arc";
    const double = lines && !!prev && now - prev.t < 400 && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 5;
    this.lastDown = double ? null : { t: now, x: e.clientX, y: e.clientY };
    // The 2nd click of a double-click only ends the lines (on an arc it would start another one) —
    // or, when the 1st click closed the outline (on its start point), does nothing.
    if (double) return this.first ? this.endLines() : undefined;
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
    const moved: Seg | null = last.kind === "line" ? (same(last.a, first) ? null : { ...last, b: first }) : last.kind === "arc" ? threePointArc(last.a, last.m, first) : null;
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
      this.path = flip ? [...o].reverse().map(revSeg) : [...o];
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
    if (k === "Escape" && this.scaling && !this.typed) {
      this.endScale(false);
      return true;
    }
    if (k === "Escape" && this.moving && !this.typed) {
      this.endMove(false);
      return true;
    }
    if ((k === "g" || k === "G") && !e.shiftKey) {
      // (G G too: the sketch keeps the key, so it never reaches the app's Move from point)
      if (this.mode === "select") this.startMove();
      else this.host.hint("Move: select outlines / paths first (Esc: Select, click them), then G");
      return true;
    }
    if (k === "Escape") {
      if (this.typed) this.typed = "";
      else if (this.picPts.length) this.picPts = [];
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
    if ((k === "s" || k === "S") && !e.shiftKey && this.mode === "select") {
      if (!this.scaling) this.startScale();
      return true;
    }
    if ((k === "j" || k === "J") && !e.shiftKey) {
      this.join();
      return true;
    }
    if (k === "Delete" && this.mode === "picture" && this.pic) {
      this.removePicture();
      this.host.toast("Picture removed");
      this.setMode("select");
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
      else if (this.scaling) this.endScale(true);
      else if (this.moving) this.endMove(true);
      else if ((this.mode === "arc" || this.mode === "line") && this.first) {
        // Nothing typed: done drawing — an arc shown (e.g. after typing its radius) is placed first.
        if (this.mode === "arc" && this.cursor && this.cur && (this.path.length || this.arcEnd) && this.arcAt(this.cur, this.cursor)) this.click(this.cursor);
        this.endLines();
      }
      return true;
    }
    if (k === "Tab") {
      this.dialog();
      return true;
    }
    const mode = ({ l: "line", a: "arc", r: "rect", c: "circle" } as Record<string, Mode>)[k.toLowerCase()];
    if (mode && !e.shiftKey) {
      this.setMode(mode);
      return true;
    }
    return false;
  }

  private setMode(mode: Mode): void {
    if (this.scaling) this.endScale(false);
    if (this.moving) this.endMove(true); // (moved with the gizmo: kept)
    // (a line being drawn ends here, as with Enter — while still in its tool, so undo goes back to it)
    if (mode === "select" && this.first) this.endLines();
    if (mode === "picture" && this.mode !== "picture") this.prevMode = this.mode;
    this.mode = mode;
    this.typed = "";
    this.arcEnd = null;
    this.arcR = null;
    if (mode !== "rect" && mode !== "circle") this.anchor = null;
    this.hoverItem = null;
    this.picPts = [];
    this.picDrag = null;
    this.picGrip = { hover: null, drag: null };
    if (mode === "picture") {
      this.selected = [];
      this.aligned = [];
      this.host.viewport.showSnapMarker(null);
      this.cursor = this.last && this.planeAt(this.last);
    } else if (mode === "select") {
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
    if (this.mode === "picture") {
      // A % scales the picture about its centre.
      if (this.pic && vals[0] > 0) this.placePicture(vals[0] / 100);
      return this.update();
    }
    if (this.mode === "select") {
      // Select: a % scales the selection about its centre (also without S); dx,dy moves it exactly.
      if (this.selected.length && vals.length === 1) {
        if (!(vals[0] > 0)) return this.update();
        if (!this.scaling) this.startScale();
        if (!this.scaling) return this.update();
        this.scaleTo(vals[0] / 100);
        return this.endScale(true);
      }
      if (this.scaling && vals.length >= 2) {
        // While scaling: x%,y%
        if (this.scaleTo(vals[0] / 100, vals[1] / 100)) this.endScale(true);
        return this.update();
      }
      if (this.scaling) return this.update();
      if (this.moving && vals.length >= 2) {
        // While moving: dx,dy from where it was when G was pressed
        this.moveTo([vals[0], vals[1]]);
        return this.endMove(true);
      }
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
    return { loops: this.loops, opens: this.opens, path: this.path, first: this.first, arcEnd: this.arcEnd, anchor: this.anchor, mode: this.mode };
  }

  /**
   * Tab: exact values for what is being drawn (Y3D's Tab), filled in from the preview — the first point
   * (X, Y), a line (length, angle), an arc (radius, angle; a first arc: its end, then its radius), a
   * rectangle (width, height), a circle (radius), or the selection (ΔX, ΔY, scale %, rotate °).
   */
  private dialog(): void {
    const c = this.cursor, r4 = (n: number) => +n.toFixed(4);
    const deg = (d: P) => r4((Math.atan2(d[1], d[0]) * 180) / Math.PI);
    const ask = (title: string, fields: { label: string; value: number; min?: number }[], ok: (v: number[]) => void) =>
      this.host.propsDialog(title, fields.map((f) => ({ ...f, value: r4(f.value) })), ok, "OK");
    const scaleFields = (x: number, y: number) => [{ label: "Scale (%)", value: 100, min: 0 }, { label: "X (%)", value: x, min: 0 }, { label: "Y (%)", value: y, min: 0 }];
    const factors = ([s, x, y]: number[]): P | null => (s > 0 && x > 0 && y > 0 ? [(s * x) / 1e4, (s * y) / 1e4] : (this.host.toast("Scale must be greater than 0", "error"), null));
    if (this.mode === "picture") {
      if (!this.pic) return;
      return ask("Scale picture", [{ label: "Scale (%)", value: 100, min: 0 }], ([k]) => {
        if (!(k > 0)) return this.host.toast("Scale must be greater than 0", "error");
        this.placePicture(k / 100);
        this.update();
      });
    }
    const rad = (a: number) => (a * Math.PI) / 180;
    if (this.scaling) {
      // While scaling / rotating: the overall % times X % / Y % (from the size before S), the turn.
      const sc = this.scaling;
      return ask("Scale / rotate", [...scaleFields(sc.kx * 100, sc.ky * 100), { label: "Rotate (°)", value: (sc.ang * 180) / Math.PI }], ([s, x, y, a]) => {
        const k = factors([s, x, y]);
        if (!k || !this.scaling) return;
        this.scaling.ang = rad(a || 0);
        if (this.scaleTo(k[0], k[1])) this.endScale(true);
      });
    }
    if (this.moving) {
      // While moving: ΔX / ΔY from where it was when G was pressed.
      const mv = this.moving;
      return ask("Move", [{ label: "ΔX (mm)", value: mv.d[0] }, { label: "ΔY (mm)", value: mv.d[1] }], ([dx, dy]) => {
        if (!this.moving) return;
        this.moveTo([dx || 0, dy || 0]);
        this.endMove(true);
      });
    }
    if (this.mode === "select") {
      if (!this.selected.length) return this.host.hint("Sketch: select outlines / paths first, then Tab to move, scale or rotate them exactly");
      return ask("Move / scale / rotate selection", [{ label: "ΔX (mm)", value: 0 }, { label: "ΔY (mm)", value: 0 }, ...scaleFields(100, 100), { label: "Rotate (°)", value: 0 }], ([dx, dy, s, x, y, a]) => {
        const k = factors([s, x, y]);
        if (!k) return;
        const before = JSON.stringify(this.state());
        if (dx || dy) this.translateSelection([dx, dy]);
        if (Math.abs(k[0] - 1) > 1e-12 || Math.abs(k[1] - 1) > 1e-12 || a) {
          this.startScale();
          this.scaling!.ang = rad(a || 0);
          const ok = this.scaleTo(k[0], k[1]);
          this.scaling = null;
          if (!ok) return this.update();
        }
        this.undoStack.push(before); // (one undo step: the move, the scale and the turn)
        this.update();
      });
    }
    if (this.mode === "rect" || this.mode === "circle") {
      if (!this.anchor && c) this.click(c); // (anchored where the cursor is)
      const a = this.anchor;
      if (!a) return this.host.hint("Sketch: move the cursor over the sketch, then press Tab");
      if (this.mode === "circle") return ask("Circle", [{ label: "Radius (mm)", value: c ? dist(c, a) : 10, min: 0 }], ([r]) => (r > 0 ? this.click([a[0] + r, a[1]]) : undefined));
      const sx = c && c[0] < a[0] ? -1 : 1, sy = c && c[1] < a[1] ? -1 : 1;
      return ask("Rectangle", [{ label: "Width (mm)", value: c ? Math.abs(c[0] - a[0]) : 20, min: 0 }, { label: "Height (mm)", value: c ? Math.abs(c[1] - a[1]) : 10, min: 0 }], ([w, h]) =>
        w > 0 && h > 0 ? this.click([a[0] + sx * w, a[1] + sy * h]) : this.host.toast("Width and height must be greater than 0", "error"));
    }
    const from = this.cur;
    if (!from) return ask("First point", [{ label: "X (mm)", value: c ? c[0] : 0 }, { label: "Y (mm)", value: c ? c[1] : 0 }], ([x, y]) => this.click([x, y]));
    const end = (len: number, angle: number): P => {
      const p = add(from, [len * Math.cos((angle * Math.PI) / 180), len * Math.sin((angle * Math.PI) / 180)]);
      return this.first && dist(p, this.first) < 1e-6 ? this.first : p; // (back on the start: close there exactly)
    };
    if (this.mode === "line" || (!this.path.length && !this.arcEnd)) {
      const d = c && !same(c, from) ? sub(c, from) : ([10, 0] as P);
      return ask(this.mode === "line" ? "Line" : "Arc: its end", [{ label: "Length (mm)", value: len(d), min: 0 }, { label: "Angle (°)", value: deg(d) }], ([l, a]) => (l > 0 ? this.click(end(l, a)) : undefined));
    }
    if (this.arcEnd) {
      const g = c && this.arcAt(from, c), k = g && arcGeom(g as Extract<Seg, { kind: "arc" }>);
      return ask("Arc", [{ label: "Radius (mm)", value: k ? k.r : dist(from, this.arcEnd) / 2, min: 0 }], ([r]) => {
        if (!(r > 0)) return;
        if (r < dist(from, this.arcEnd!) / 2 - 1e-6) return this.host.toast(`Arc: the radius must be at least ${num(dist(from, this.arcEnd!) / 2)} mm`, "error");
        this.arcR = r;
        const arc = this.arcAt(from, c ?? add(mul(add(from, this.arcEnd!), 0.5), [0, 1]));
        if (arc && arc.kind === "arc") this.click(arc.m);
      });
    }
    // On from a segment: radius and angle, bending toward the cursor's side.
    const t = endDir(this.path[this.path.length - 1]);
    const g = c && this.arcAt(from, c), k = g && arcGeom(g as Extract<Seg, { kind: "arc" }>);
    ask("Arc", [{ label: "Radius (mm)", value: k ? k.r : 10, min: 0 }, { label: "Angle (°)", value: k ? Math.abs((k.sweep * 180) / Math.PI) : 180, min: 0 }], ([r, a]) => {
      if (!(r > 0) || !(a > 0 && a < 360)) return this.host.toast("Arc: radius > 0 and angle between 0 and 360°", "error");
      const sd = c && cross(t, sub(c, from)) < 0 ? -1 : 1;
      const center = add(from, mul([-t[1] * sd, t[0] * sd], r));
      const a1 = Math.atan2(from[1] - center[1], from[0] - center[0]) + (sd * a * Math.PI) / 180;
      const p: P = [center[0] + r * Math.cos(a1), center[1] + r * Math.sin(a1)];
      this.arcR = null;
      this.click(this.first && dist(p, this.first) < 1e-6 ? this.first : p);
    });
  }

  /** Right click: to Select (the lines being drawn are kept, as with Enter); in Select, clears the selection. */
  rightClick(): void {
    if (this.scaling) return this.endScale(false);
    if (this.moving) return this.endMove(false);
    if (this.mode !== "select") return this.setMode("select");
    this.selected = [];
    this.update();
  }

  /** Undo the last sketch step (Ctrl+Z / Backspace). */
  undo(): void {
    if (this.scaling) return this.endScale(false);
    if (this.moving) return this.endMove(false);
    const s = this.undoStack.pop();
    if (!s) return this.host.hint("Sketch: nothing to undo");
    const st = JSON.parse(s) as State;
    ({ loops: this.loops, opens: this.opens, path: this.path, first: this.first, arcEnd: this.arcEnd, anchor: this.anchor } = st);
    // Back to something half drawn (e.g. lines a right click ended): the tool that was drawing it, to go on —
    // not Select, where its points would be left as loose dots.
    const drawing = !!(st.first || st.arcEnd || st.anchor);
    if (drawing && st.mode && st.mode !== "select" && st.mode !== "picture" && st.mode !== this.mode) {
      this.mode = st.mode;
      this.typed = "";
      this.cursor = this.last && this.pointAt(this.last);
    }
    this.arcR = null;
    this.selected = [];
    this.hoverItem = null;
    this.version++;
    this.update();
  }

  // ------------------------------------------------------------ done

  /** Done: the closed outlines become flat faces. */
  private kernelLoop(l: Loop): SketchLoop {
    return l.kind === "circle"
      ? { kind: "circle", c: this.v3(l.c), r: l.r }
      : { kind: "path", segs: l.segs.map((g) => this.kernelSeg(g)) };
  }

  private kernelSeg(g: Seg): Extract<SketchLoop, { kind: "path" }>["segs"][number] {
    if (g.kind === "line") return { kind: "line", a: this.v3(g.a), b: this.v3(g.b) };
    if (g.kind === "arc") return { kind: "arc", a: this.v3(g.a), m: this.v3(g.m), b: this.v3(g.b) };
    return { kind: "spline", pts: g.pts.map((p) => this.v3(p)), w: g.w };
  }

  /** The face(s) of the outlines joined in group g (with their holes): merged into one where they touch / overlap. */
  private groupFaces(g: number, groups = nest(this.loops)): Shape[] {
    const n = this.frame.z.toArray() as V3;
    const faces = groups.filter((x) => this.loops[x.outer].g === g).flatMap((x) => sketchFaces(this.kernelLoop(this.loops[x.outer]), x.holes.map((h) => this.kernelLoop(this.loops[h])), n));
    return joinFlatFaces(faces as Parameters<typeof joinFlatFaces>[0], n);
  }

  /** Joined outlines on screen: their merged shape (fill + outline), worked out again only when the sketch changes. */
  private groupView(g: number): { tris: THREE.BufferGeometry; lines: THREE.BufferGeometry } | null {
    if (this.groupCache?.version !== this.version) this.groupCache = { version: this.version, views: new Map() };
    const views = this.groupCache.views;
    if (!views.has(g)) {
      try {
        const pos: number[] = [], idx: number[] = [], seg: number[] = [];
        for (const f of this.groupFaces(g)) {
          const t = tessellate(f);
          const o = pos.length / 3;
          pos.push(...t.faces.vertices);
          idx.push(...t.faces.triangles.map((k) => k + o));
          seg.push(...t.edges.lines);
        }
        const tris = new THREE.BufferGeometry();
        tris.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        tris.setIndex(idx);
        const lines = new THREE.BufferGeometry();
        lines.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
        views.set(g, { tris, lines });
      } catch {
        views.set(g, null); // (can't be merged: shown outline by outline)
      }
    }
    return views.get(g) ?? null;
  }

  private finish(): void {
    const groups = nest(this.loops);
    try {
      const n = this.frame.z.toArray() as V3;
      // Faces of each outline (with its holes); outlines joined with J are merged into one face.
      const faces = groups.filter((x) => this.loops[x.outer].g === undefined).flatMap((x) => sketchFaces(this.kernelLoop(this.loops[x.outer]), x.holes.map((h) => this.kernelLoop(this.loops[h])), n)) as Shape[];
      for (const g of new Set(this.loops.map((l) => l.g).filter((x): x is number => x !== undefined))) faces.push(...this.groupFaces(g, groups));
      // Open lines (also the ones still being drawn) become paths.
      const opens = this.path.length ? [...this.opens, this.path] : this.opens;
      this.done(faces, opens.map((o) => sketchPath(o.map((g) => this.kernelSeg(g)))));
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
    /** Open paths: thicker than outlines (2.5 px), in the line material's colour. */
    const pathLine = (pts: P[], mat: THREE.LineBasicMaterial) => objs.push(vp.thickLine(pts.map((p) => this.world(p)), mat.color.getHex(), PATH_WIDTH, mat.opacity));
    const dot = (p: P) => {
      const w = this.world(p), m = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), vp.mats.cursor);
      m.position.copy(w);
      m.scale.setScalar(vp.worldPerPixel(w) * 3.5);
      objs.push(m);
    };
    // Joined outlines: their merged shape (one fill, one outline); geometry is cached, so draw clones.
    const pic = this.pic;
    if (pic) {
      const f = this.frame, m = new THREE.Mesh(new THREE.PlaneGeometry(pic.w, pic.h), pic.mat);
      m.position.copy(this.world(pic.c));
      m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.x, f.y, f.z)).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), pic.ang));
      m.userData.under = true; // (drawn below the sketch's lines)
      objs.push(m);
    }
    // The picture's outline, while it's being worked on (Picture mode).
    if (pic && this.mode === "picture") lines(this.picCorners(), this.mats.sel, true);
    if (this.mode === "picture") {
      const [a1, a2, b1] = this.picPts;
      for (const p of this.picPts) dot(p);
      if (a2) lines([a1, a2], this.mats.sel);
      if (b1) lines([a1, b1], this.mats.rubber);
    }
    const groupObj = (g: number, fill: THREE.Material | null, line: THREE.LineBasicMaterial) => {
      const v = this.groupView(g);
      if (!v) return false;
      if (fill) objs.push(new THREE.Mesh(v.tris.clone(), fill));
      objs.push(new THREE.LineSegments(v.lines.clone(), line));
      return true;
    };
    const merged = new Set<number>();
    for (const g of new Set(this.loops.map((l) => l.g).filter((x): x is number => x !== undefined))) if (groupObj(g, this.mats.fill, this.mats.line)) merged.add(g);
    const shown = (l: Loop) => l.g === undefined || !merged.has(l.g);
    // Closed outlines: filled (holes left open) and outlined.
    for (const { outer, holes } of nest(this.loops)) {
      if (!shown(this.loops[outer])) continue;
      const shape = new THREE.Shape(loopPolygon(this.loops[outer]).map(([u, v]) => new THREE.Vector2(u, v)));
      for (const h of holes) shape.holes.push(new THREE.Path(loopPolygon(this.loops[h]).map(([u, v]) => new THREE.Vector2(u, v))));
      const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), this.mats.fill);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.makeBasis(this.frame.x, this.frame.y, this.frame.z).setPosition(this.frame.origin);
      objs.push(mesh);
    }
    for (const l of this.loops) if (shown(l)) lines(loopPolygon(l), this.mats.line, true);
    // Open paths, and the lines being drawn.
    // (open lines in pink — the colour of the paths they become: not a closed outline)
    for (const o of this.opens) pathLine([...o.flatMap(segPoints), o[o.length - 1].b], this.mats.open);
    if (this.path.length) lines([...this.path.flatMap(segPoints), this.cur!], this.mats.line);
    for (const p of [this.first, this.arcEnd, this.anchor]) if (p) dot(p);
    // Select: the selected outlines / paths in blue (outlines also filled), the one under the cursor in white.
    // (a joined outline: its group's merged shape, once)
    const done = new Set<string>();
    const asGroup = (it: Item, fill: THREE.Material | null, line: THREE.LineBasicMaterial) => {
      const g = it.kind === "loop" ? this.loops[it.i].g : undefined;
      if (g === undefined || !merged.has(g)) return false;
      const key = `${g}:${line.uuid}:${fill ? 1 : 0}`;
      if (!done.has(key)) {
        done.add(key);
        groupObj(g, fill, line);
      }
      return true;
    };
    const itemLines = (it: Item, mat: THREE.LineBasicMaterial) => {
      if (asGroup(it, null, mat)) return;
      if (it.kind === "loop") lines(loopPolygon(this.loops[it.i]), mat, true);
      else {
        const o = this.opens[it.i];
        pathLine([...o.flatMap(segPoints), o[o.length - 1].b], mat);
      }
    };
    const itemFill = (it: Item, mat: THREE.Material) => {
      if (it.kind !== "loop" || asGroup(it, mat, this.mats.line)) return;
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
    // Scaling / rotating: the gizmo — lines from the centre to the X (red) / Y (green) squares, the XY ring
    // (yellow), the rotate ring (blue) on a short arc round the centre; the handle under the cursor bigger.
    const sc = this.scaling;
    if (sc) {
      const w = vp.worldPerPixel(this.world(sc.c));
      dot(sc.c);
      const color = (h: Handle) => (h === "x" ? 0xe5484d : h === "y" ? 0x30a46c : h === "rot" ? 0x4f9dff : 0xffd84a);
      for (const h of ["x", "y", "xy", "rot"] as Handle[]) {
        const p = this.handlePos(h), mat = this.gizmoMat(color(h), "line") as THREE.LineBasicMaterial;
        const size = w * (sc.hover === h || sc.handle === h ? 8 : 6), ring = h === "xy" || h === "rot";
        if (!ring) lines([sc.c, p], mat);
        const shape = ring
          ? Array.from({ length: 24 }, (_, i) => [p[0] + size * Math.cos((i / 24) * TAU), p[1] + size * Math.sin((i / 24) * TAU)] as P)
          : ([[-size, -size], [size, -size], [size, size], [-size, size]] as P[]).map((d) => rotP(add(p, d), p, sc.ang));
        lines(shape, mat, true);
        if (h === "rot") {
          // (the arc it runs along: ±20° about the centre, either side of the ring)
          const r = dist(p, sc.c), a = Math.atan2(p[1] - sc.c[1], p[0] - sc.c[0]), da = Math.min(0.35, (40 * w) / Math.max(r, 1e-9));
          for (const sgn of [1, -1]) {
            const from = a + sgn * (size / Math.max(r, 1e-9));
            lines(Array.from({ length: 9 }, (_, i) => add(sc.c, [r * Math.cos(from + (sgn * da * i) / 8), r * Math.sin(from + (sgn * da * i) / 8)])), mat);
          }
        }
        if (!ring) {
          const m = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(shape.map(([u, v]) => new THREE.Vector2(u, v)))), this.gizmoMat(color(h), "fill"));
          m.matrixAutoUpdate = false;
          m.matrix.makeBasis(this.frame.x, this.frame.y, this.frame.z).setPosition(this.frame.origin);
          objs.push(m);
        }
      }
      const deg = (sc.ang * 180) / Math.PI, turn = `Rotate ${num(Math.abs(deg) < 1e-9 ? 0 : deg)}°`;
      const size = Math.abs(sc.kx - sc.ky) < 1e-9 ? `Scale ${num(sc.kx * 100)}%` : `Scale X ${num(sc.kx * 100)}% · Y ${num(sc.ky * 100)}%`;
      hud = (sc.handle ?? sc.hover) === "rot" ? `${turn}${sc.handle ? ` · ${vp.stepTip("15° steps")}` : ""}` : Math.abs(deg) > 1e-9 ? `${size} · ${turn}` : size;
    }
    // Moving (G): the gizmo, as the app's — X (red) / Y (green) arrows, the XY square (yellow); the part under the cursor bigger.
    const mv = this.moving;
    let moveAt: P | null = null;
    if (mv) {
      const g = this.moveGizmo(), w = g.w;
      dot(g.o);
      const color = (h: MoveHandle) => (h === "x" ? 0xe5484d : h === "y" ? 0x30a46c : 0xffd84a);
      const big = (h: MoveHandle) => (mv.hover === h || mv.handle === h ? 1.3 : 1);
      const fill = (shape: P[], h: MoveHandle) => {
        const m = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(shape.map(([u, v]) => new THREE.Vector2(u, v)))), this.gizmoMat(color(h), "fill"));
        m.matrixAutoUpdate = false;
        m.matrix.makeBasis(this.frame.x, this.frame.y, this.frame.z).setPosition(this.frame.origin);
        objs.push(m);
      };
      for (const h of ["x", "y"] as const) {
        const dir: P = h === "x" ? [1, 0] : [0, 1], side: P = [-dir[1], dir[0]], k = w * big(h), tip = g[h], base = add(tip, mul(dir, -14 * k));
        lines([add(g.o, mul(dir, 10 * w)), base], this.gizmoMat(color(h), "line") as THREE.LineBasicMaterial);
        fill([tip, add(base, mul(side, 5 * k)), add(base, mul(side, -5 * k))], h);
      }
      const r = MOVE_SQ_HALF_PX * w * big("xy"), sq: P[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => add(g.sq, [i * r, j * r]));
      fill(sq, "xy");
      lines(sq, this.gizmoMat(color("xy"), "line") as THREE.LineBasicMaterial, true);
      hud = `Move ${num(mv.d[0])}, ${num(mv.d[1])} mm`;
      moveAt = g.x;
    }
    // Picture mode: its handles (the one under the cursor / dragged bigger) — the scale square, the rotate ring.
    let gripAt: P | null = null;
    if (pic && this.mode === "picture" && !this.picPts.length) {
      const pg = this.picGrip, k = this.picGripPos("scale"), w = vp.worldPerPixel(this.world(k));
      const big = (kind: "scale" | "rotate") => pg.hover === kind || pg.drag?.kind === kind;
      const cs = Math.cos(pic.ang), sn = Math.sin(pic.ang), r = (q: P): P => [q[0] * cs - q[1] * sn, q[0] * sn + q[1] * cs];
      const sz = w * (big("scale") ? 7 : 5), sq = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as P[]).map(([i, j]) => add(k, r([i * sz, j * sz])));
      const fill = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(sq.map(([u, v]) => new THREE.Vector2(u, v)))), this.gizmoMat(0x4fd1ff, "fill"));
      fill.matrixAutoUpdate = false;
      fill.matrix.makeBasis(this.frame.x, this.frame.y, this.frame.z).setPosition(this.frame.origin);
      objs.push(fill);
      const ro = this.picGripPos("rotate"), rr = w * (big("rotate") ? 7 : 5);
      lines(Array.from({ length: 24 }, (_, i) => [ro[0] + rr * Math.cos((i / 24) * TAU), ro[1] + rr * Math.sin((i / 24) * TAU)] as P), this.gizmoMat(0xffd84a, "line") as THREE.LineBasicMaterial, true);
      lines([k, ro], this.gizmoMat(0xffd84a, "line") as THREE.LineBasicMaterial);
      if (pg.drag || pg.hover) {
        const deg = (((pic.turned * 180) / Math.PI + 540) % 360) - 180;
        hud = (pg.drag?.kind ?? pg.hover) === "scale" ? `Scale ${num((pic.w / pic.w0) * 100)}%${pg.drag ? ` · ${this.host.viewport.stepTip("5% steps")}` : ""}` : `Rotate ${num(Math.abs(deg) < 1e-9 ? 0 : deg)}°${pg.drag ? ` · ${this.host.viewport.stepTip("15° steps")}` : ""}`;
        gripAt = (pg.drag?.kind ?? pg.hover) === "rotate" ? ro : k;
      }
    }
    vp.setOverlay(objs);
    this.host.hud(this.typed ? `⌨ ${this.typed}_` : hud, sc ? this.world(this.handlePos((sc.handle ?? sc.hover) === "rot" ? "rot" : "xy")) : moveAt ? this.world(moveAt) : gripAt ? this.world(gripAt) : c ? this.world(c) : undefined);
    // The 3D corner view frames the model and the sketch — again after each change (moved / scaled: once let go).
    if (this.insetVersion !== this.version && !this.drag?.moved && !this.scaling?.handle && !this.moving?.handle) {
      this.insetVersion = this.version;
      vp.setInset(true, [...this.loops.flatMap((l) => loopPolygon(l)), ...this.opens.flatMap((o) => o.flatMap((g) => [...segPoints(g), g.b]))].map((p) => this.world(p)));
    }
    this.renderPanel();
  }

  /** Scale gizmo materials, one per colour (made once). */
  private gizmoMats = new Map<string, THREE.Material>();
  private gizmoMat(color: number, kind: "line" | "fill"): THREE.Material {
    const key = `${kind}:${color}`;
    let m = this.gizmoMats.get(key);
    if (!m) {
      m = kind === "line"
        ? new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true })
        : new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.85 });
      this.gizmoMats.set(key, m);
    }
    return m;
  }

  /** Redraw the panel (e.g. after switching the Pro layout). */
  refresh(): void {
    this.panelHtml = "";
    this.update();
  }

  private renderPanel(): void {
    const nSel = this.selected.length;
    const tips: Record<Mode, string> = {
      select: this.moving ? `Move: drag the red arrow (X), the green (Y) or the yellow square (free) — ${this.host.viewport.stepTip("grid steps")} · Tab / type dx,dy + Enter: exact · Enter / click elsewhere: done · Esc / right click: cancel`
        : this.scaling ? `Scale / rotate: drag the red square (X), green (Y), the yellow ring (even)${this.scaling.curves ? " — unevenly, arcs / circles become freeform curves" : ""} or the blue ring (rotate) — ${this.host.viewport.stepTip("round steps, 15°")} · Tab: exact %, ° · Enter / click elsewhere: apply · Esc / right click: cancel`
        : nSel ? `${nSel} selected · drag to move (${this.host.viewport.stepTip("grid steps")}), G: move gizmo, or type dx,dy + Enter · S: scale / rotate (or type a % + Enter) · J: join · Shift+click: add / remove · Del: delete` : "Click an outline or a path to select it · Shift+click to add more",
      line: this.first ? "Click the next point · click the start point to close · Enter / double-click: done (left open: a path) · type a length + Enter" : "Click the first point (corners, middles, crossings, centres snap) · type x,y + Enter",
      arc: !this.first ? "Click where the arc starts"
        : this.arcR ? `R ${num(this.arcR)} set — move the mouse to the side the arc should ${this.path.length ? "turn" : "bulge"}, then click (or Enter: place it, done) · Esc: clear R`
        : this.path.length ? "Click the arc's end (it bends on from the last segment) · Enter / double-click: done (left open: a path) · type a radius + Enter to fix it · L: back to lines" : this.arcEnd ? "Click a point the arc passes through (near a half circle it snaps to one) · Enter / double-click: done (left open: a path) · type a radius + Enter to fix it" : "Click the arc's end point · type a radius + Enter to fix it",
      rect: this.anchor ? "Click the opposite corner · type width,height (or 23x30) + Enter" : "Click the first corner",
      circle: this.anchor ? "Click a point on the circle · type the radius + Enter" : "Click the centre",
      picture: !this.pic ? "No picture — click the picture icon (bottom left) to load one"
        : ["Drag the picture to move it · its corner: the square scales, the ring rotates · type a % + Enter to scale it · Match: click a point on the picture · click off the picture: back to drawing", "Match: click a 2nd point on the picture", "Match: click where the 1st point belongs (on the model / sketch)", "Match: click where the 2nd point belongs"][this.picPts.length]
          + " · the menu by the thumbnail (bottom left): scale, rotate, transparency · thumbnail again: done · Del: remove it · L A R C: draw",
    };
    const btn = (m: Mode, label: string, key: string) => `<button type="button" class="btn${this.mode === m ? " primary" : ""}" data-mode="${m}" title="${label} (${key})">${label} <kbd>${key}</kbd></button>`;
    const closed = this.loops.length, open = this.opens.length;
    const moveBtn = this.mode === "select" ? `<button type="button" class="btn${this.moving ? " primary" : ""}" data-act="move" ${nSel ? "" : "disabled"} title="Move the selection with the gizmo: X / Y arrows, the square free — G (or type dx,dy + Enter)">Move <kbd>G</kbd></button>` : "";
    const scaleBtn = this.mode === "select" ? `<button type="button" class="btn${this.scaling ? " primary" : ""}" data-act="scale" ${nSel ? "" : "disabled"} title="Scale or rotate the selection about its centre: the squares / yellow ring scale, the blue ring rotates — S (or type a % + Enter)">Scale / Rotate <kbd>S</kbd></button>` : "";
    // (Join while drawing too: there it goes to Select, to pick the outlines)
    const joinBtn = this.mode !== "picture" ? `<button type="button" class="btn" data-act="join" ${nSel >= 2 || this.mode !== "select" ? "" : "disabled"} title="Join the selected outlines into one face (paths: end to end into one) — J · select two or more first (Shift+click adds)">Join <kbd>J</kbd></button>` : "";
    const html = `<h4>Sketch on ${this.what}</h4>
      <div class="modes">${btn("select", "Select", "Esc")}${btn("line", "Line", "L")}${btn("arc", "Arc", "A")}${btn("rect", "Rectangle", "R")}${btn("circle", "Circle", "C")}${moveBtn}${scaleBtn}${joinBtn}</div>
      <div class="tip">${tips[this.mode]}</div>
      <div class="muted">${closed ? `${closed} closed outline${closed > 1 ? "s" : ""}` : "No closed outline yet"}${open ? ` · ${open} open path${open > 1 ? "s" : ""}` : ""} · Tab: exact values · ${this.mode === "select" ? "L A R C: draw" : "Esc: drop the outline being drawn, again: Select"} · Ctrl+Z: undo</div>
      <div class="op-buttons"><button type="button" class="btn primary" data-act="done" title="Keep the closed outlines as flat faces">Done</button><button type="button" class="btn" data-act="cancel" title="Drop the sketch">Cancel</button></div>`;
    // Pro layout: one row of modes, Done / Cancel — no tips.
    const pro = document.body.classList.contains("pro");
    const proHtml = `<div class="modes">${btn("select", "Select", "Esc")}${btn("line", "Line", "L")}${btn("arc", "Arc", "A")}${btn("rect", "Rect", "R")}${btn("circle", "Circle", "C")}${moveBtn}${scaleBtn}${joinBtn}<span class="spacer"></span><button type="button" class="btn primary" data-act="done" title="Keep the closed outlines as flat faces, open lines as paths">Done</button><button type="button" class="btn" data-act="cancel" title="Drop the sketch">Cancel</button></div>`;
    const out = pro ? proHtml : html;
    this.panel.classList.toggle("compact", pro);
    if (out !== this.panelHtml) this.panel.innerHTML = this.panelHtml = out;
    this.corner.querySelector(".pic-wrap")?.classList.toggle("on", this.mode === "picture"); // (lit, its menu open)
    this.syncPicMenu();
    if (pro && this.mode === "picture") return this.host.hint(`Sketch — picture: ${tips.picture}`);
    if (pro) return this.host.hint(this.mode === "select" ? `Sketch — select${nSel ? `: ${nSel}, Del deletes` : ""} — L A R C: draw` : "Sketch — L line, A arc, R rect, C circle — Enter: done");
    this.host.hint(`Sketch: ${tips[this.mode]} · L line · A arc · R rectangle · C circle · Done / Cancel in the panel`);
  }
}
