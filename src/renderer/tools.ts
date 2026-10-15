/**
 * Interactive drawing tools.
 *   Solid tools: Box / Cylinder / Sphere create closed 3D solids.
 *   Face tools:  Rectangle / Circle / Polygon create flat planar faces, which
 *                Push/Pull then extrudes into a new solid.
 *
 * Every tool draws on the ground plane, or on the planar face under the
 * cursor at the first click, so you can build directly on existing solids.
 * Points snap to the grid (hold Ctrl to disable). While a tool is active you
 * can also type exact dimensions (e.g. "40,25" then Enter for a rectangle).
 */
import * as THREE from "three";
import type { Viewport } from "./viewport";
import {
  planarFaceFrame,
  makeBox,
  makeCylinder,
  makeSphereAt,
  makePolygonPrism,
  makeRectFace,
  makeCircleFace,
  makePolygonFace,
  type BodyKind,
  type Frame,
  type Shape,
  type V3,
} from "./kernel";

export interface ToolHost {
  viewport: Viewport;
  /** Grid step for snapping, 0 when snapping is off (or Ctrl is held). */
  snapStep(e: { ctrlKey: boolean } | null): number;
  hint(text: string): void;
  hud(text: string | null, at?: THREE.Vector3): void;
  finish(shape: Shape, baseName: string, kind: BodyKind): void;
  fail(e: unknown): void;
}

export interface Tool {
  readonly name: string;
  move(e: PointerEvent): void;
  down(e: PointerEvent): void;
  /** Returns true if the key was consumed. */
  key(e: KeyboardEvent): boolean;
  dispose(): void;
}

// ------------------------------------------------------------------ plane frame

class PlaneFrame {
  constructor(
    readonly origin: THREE.Vector3,
    readonly x: THREE.Vector3,
    readonly y: THREE.Vector3,
    readonly z: THREE.Vector3,
  ) {}

  static from(f: Frame): PlaneFrame {
    const v = (t: V3) => new THREE.Vector3(...t);
    return new PlaneFrame(v(f.origin), v(f.x), v(f.y), v(f.z));
  }

  toKernel(): Frame {
    const t = (v: THREE.Vector3): V3 => [v.x, v.y, v.z];
    return { origin: t(this.origin), x: t(this.x), y: t(this.y), z: t(this.z) };
  }

  point(u: number, v: number, h = 0): THREE.Vector3 {
    return this.origin.clone().addScaledVector(this.x, u).addScaledVector(this.y, v).addScaledVector(this.z, h);
  }

  /** Ray/plane intersection in local (u, v) coordinates, optionally snapped. */
  hit(ray: THREE.Ray, step: number): { u: number; v: number } | null {
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.z, this.origin);
    const p = ray.intersectPlane(plane, new THREE.Vector3());
    if (!p) return null;
    const d = p.sub(this.origin);
    let u = d.dot(this.x);
    let v = d.dot(this.y);
    if (step > 0) {
      u = Math.round(u / step) * step;
      v = Math.round(v / step) * step;
    }
    return { u, v };
  }

  /** Orient an object so its local XY plane lies on this frame at `center`. */
  place(obj: THREE.Object3D, center: THREE.Vector3, basis: "xy" | "xz-cyl" = "xy"): THREE.Object3D {
    obj.matrixAutoUpdate = false;
    if (basis === "xy") obj.matrix.makeBasis(this.x, this.y, this.z);
    else obj.matrix.makeBasis(this.x, this.z, this.x.clone().cross(this.z)); // cylinder axis = local Y
    obj.matrix.setPosition(center);
    return obj;
  }
}

const GROUND = new PlaneFrame(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1));

/** Signed parameter along `axis` (through `base`) closest to the ray. */
function heightAlong(ray: THREE.Ray, base: THREE.Vector3, axis: THREE.Vector3): number | null {
  const w0 = ray.origin.clone().sub(base);
  const b = ray.direction.dot(axis);
  const d = ray.direction.dot(w0);
  const e = axis.dot(w0);
  const denom = 1 - b * b;
  if (denom < 1e-6) return null;
  return (e - b * d) / denom;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);
const snapValue = (n: number, step: number) => (step > 0 ? Math.round(n / step) * step : n);

// ------------------------------------------------------------------ base class

abstract class DrawTool implements Tool {
  abstract readonly name: string;
  protected abstract readonly hints: string[];
  protected stage = 0;
  protected frame = GROUND;
  protected typed = "";
  private faceCache = new Map<string, PlaneFrame | null>();
  protected last: PointerEvent | null = null;

  constructor(protected host: ToolHost) {}

  start(): this {
    this.updateHint();
    return this;
  }

  protected updateHint(): void {
    const base = this.hints[this.stage] ?? "";
    this.host.hint(this.typed ? `${base}   ⌨ ${this.typed}_ (Enter to apply)` : base);
  }

  /** The planar face frame under the cursor, or the ground plane. */
  protected frameUnder(e: PointerEvent): PlaneFrame {
    const f = this.host.viewport.faceUnder(e.clientX, e.clientY);
    if (!f) return GROUND;
    const key = `${f.body.id}:${f.faceId}`;
    if (!this.faceCache.has(key)) {
      const k = planarFaceFrame(f.body.shape, f.faceId);
      this.faceCache.set(key, k ? PlaneFrame.from(k) : null);
    }
    return this.faceCache.get(key) ?? GROUND;
  }

  protected ray(e: PointerEvent): THREE.Ray {
    return this.host.viewport.ray(e.clientX, e.clientY);
  }

  protected cursor(p: THREE.Vector3): THREE.Object3D {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), this.host.viewport.mats.cursor);
    m.position.copy(p);
    m.scale.setScalar(this.host.viewport.worldPerPixel(p) * 4);
    return m;
  }

  protected outline(points: THREE.Vector3[]): THREE.Object3D {
    return new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), this.host.viewport.mats.previewLine);
  }

  protected solidPreview(geo: THREE.BufferGeometry): THREE.Object3D {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(geo, this.host.viewport.mats.previewFill));
    g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), this.host.viewport.mats.previewLine));
    return g;
  }

  protected emit(shapeFn: () => Shape, baseName: string, kind: BodyKind = "solid"): void {
    try {
      this.host.finish(shapeFn(), baseName, kind);
    } catch (err) {
      this.host.fail(err);
    }
  }

  key(e: KeyboardEvent): boolean {
    if (this.stage === 0) return false;
    if (/^[0-9.,\-]$/.test(e.key)) {
      this.typed += e.key;
    } else if (e.key === "Backspace" && this.typed) {
      this.typed = this.typed.slice(0, -1);
    } else if (e.key === "Enter" && this.typed) {
      const nums = this.typed.split(",").map(Number);
      this.typed = "";
      if (nums.every((n) => Number.isFinite(n))) this.applyTyped(nums);
    } else {
      return false;
    }
    this.updateHint();
    return true;
  }

  protected abstract applyTyped(values: number[]): void;
  abstract move(e: PointerEvent): void;
  abstract down(e: PointerEvent): void;

  dispose(): void {
    this.host.viewport.setOverlay([]);
    this.host.hud(null);
  }
}

// ------------------------------------------------------------------ Box

/** Box solid, or (faceMode) a flat Rectangle face. */
export class BoxTool extends DrawTool {
  constructor(host: ToolHost, private readonly faceMode = false) {
    super(host);
  }

  get name(): string {
    return this.faceMode ? "Rectangle" : "Box";
  }

  protected get hints(): string[] {
    const n = this.name;
    return [
      `${n}: click the first corner (on the grid or on a planar face)`,
      `${n}: click the opposite corner — or type width,depth + Enter`,
      `${n}: move to set the height and click — or type height + Enter`,
    ];
  }
  private u1 = 0;
  private v1 = 0;
  private u2 = 0;
  private v2 = 0;
  private h = 0;

  move(e: PointerEvent): void {
    this.last = e;
    const step = this.host.snapStep(e);
    if (this.stage === 0) {
      this.frame = this.frameUnder(e);
      const p = this.frame.hit(this.ray(e), step);
      if (!p) return;
      const w = this.frame.point(p.u, p.v);
      this.host.viewport.setOverlay([this.cursor(w)]);
      this.host.hud(null);
    } else if (this.stage === 1) {
      const p = this.frame.hit(this.ray(e), step);
      if (!p) return;
      this.u2 = p.u;
      this.v2 = p.v;
      this.drawRect();
    } else {
      const h = heightAlong(this.ray(e), this.rectCenter(), this.frame.z);
      if (h === null) return;
      this.h = snapValue(h, step);
      this.drawBox();
    }
  }

  down(e: PointerEvent): void {
    const step = this.host.snapStep(e);
    if (this.stage === 0) {
      const p = this.frame.hit(this.ray(e), step);
      if (!p) return;
      this.u1 = this.u2 = p.u;
      this.v1 = this.v2 = p.v;
      this.stage = 1;
    } else if (this.stage === 1) {
      if (Math.abs(this.u2 - this.u1) < 1e-6 || Math.abs(this.v2 - this.v1) < 1e-6) return;
      if (this.faceMode) {
        this.buildFace();
        return;
      }
      this.stage = 2;
      this.h = 0;
    } else {
      if (Math.abs(this.h) < 1e-6) return;
      this.build();
      return;
    }
    this.updateHint();
  }

  protected applyTyped(values: number[]): void {
    if (this.stage === 1) {
      const [w, d = w] = values;
      if (!w || !d) return;
      this.u2 = this.u1 + Math.abs(w) * (this.u2 < this.u1 ? -1 : 1);
      this.v2 = this.v1 + Math.abs(d) * (this.v2 < this.v1 ? -1 : 1);
      if (this.faceMode) {
        this.buildFace();
        return;
      }
      this.stage = 2;
      this.h = 0;
      this.drawRect();
    } else if (this.stage === 2 && values[0]) {
      this.h = values[0];
      this.build();
    }
  }

  private rectCenter(): THREE.Vector3 {
    return this.frame.point((this.u1 + this.u2) / 2, (this.v1 + this.v2) / 2);
  }

  private drawRect(): void {
    const f = this.frame;
    const pts = [f.point(this.u1, this.v1), f.point(this.u2, this.v1), f.point(this.u2, this.v2), f.point(this.u1, this.v2)];
    const w = Math.abs(this.u2 - this.u1);
    const d = Math.abs(this.v2 - this.v1);
    const objs: THREE.Object3D[] = [this.outline(pts), this.cursor(pts[2])];
    if (w > 0 && d > 0) objs.push(f.place(new THREE.Mesh(new THREE.PlaneGeometry(w, d), this.host.viewport.mats.previewFill), this.rectCenter()));
    this.host.viewport.setOverlay(objs);
    this.host.hud(`${fmt(w)} × ${fmt(d)} mm`, pts[2]);
  }

  private drawBox(): void {
    const w = Math.abs(this.u2 - this.u1);
    const d = Math.abs(this.v2 - this.v1);
    const center = this.rectCenter().addScaledVector(this.frame.z, this.h / 2);
    const preview = this.frame.place(this.solidPreview(new THREE.BoxGeometry(w, d, Math.max(Math.abs(this.h), 1e-3))), center);
    this.host.viewport.setOverlay([preview]);
    this.host.hud(`${fmt(w)} × ${fmt(d)} × ${fmt(this.h)} mm`, this.rectCenter().addScaledVector(this.frame.z, this.h));
  }

  private build(): void {
    const c = this.rectCenter();
    const w = Math.abs(this.u2 - this.u1);
    const d = Math.abs(this.v2 - this.v1);
    const h = this.h;
    this.emit(() => makeBox(this.frame.toKernel(), [c.x, c.y, c.z], w, d, h), "Box");
  }

  private buildFace(): void {
    const c = this.rectCenter();
    const w = Math.abs(this.u2 - this.u1);
    const d = Math.abs(this.v2 - this.v1);
    this.emit(() => makeRectFace(this.frame.toKernel(), [c.x, c.y, c.z], w, d), "Rectangle", "face");
  }
}

// ------------------------------------------------------------------ Cylinder

/** Cylinder solid, or (faceMode) a flat Circle face. */
export class CylinderTool extends DrawTool {
  constructor(host: ToolHost, private readonly faceMode = false) {
    super(host);
  }

  get name(): string {
    return this.faceMode ? "Circle" : "Cylinder";
  }

  protected get hints(): string[] {
    const n = this.name;
    return [
      `${n}: click the center (on the grid or on a planar face)`,
      `${n}: click to set the radius — or type radius + Enter`,
      `${n}: move to set the height and click — or type height + Enter`,
    ];
  }
  private cu = 0;
  private cv = 0;
  private r = 0;
  private h = 0;

  move(e: PointerEvent): void {
    this.last = e;
    const step = this.host.snapStep(e);
    if (this.stage === 0) {
      this.frame = this.frameUnder(e);
      const p = this.frame.hit(this.ray(e), step);
      if (p) this.host.viewport.setOverlay([this.cursor(this.frame.point(p.u, p.v))]);
    } else if (this.stage === 1) {
      const p = this.frame.hit(this.ray(e), 0);
      if (!p) return;
      this.r = snapValue(Math.hypot(p.u - this.cu, p.v - this.cv), step);
      this.drawCircle();
    } else {
      const h = heightAlong(this.ray(e), this.center(), this.frame.z);
      if (h === null) return;
      this.h = snapValue(h, step);
      this.drawCylinder();
    }
  }

  down(e: PointerEvent): void {
    if (this.stage === 0) {
      const p = this.frame.hit(this.ray(e), this.host.snapStep(e));
      if (!p) return;
      this.cu = p.u;
      this.cv = p.v;
      this.r = 0;
      this.stage = 1;
    } else if (this.stage === 1) {
      if (this.r < 1e-6) return;
      if (this.faceMode) {
        this.buildFace();
        return;
      }
      this.stage = 2;
      this.h = 0;
    } else {
      if (Math.abs(this.h) < 1e-6) return;
      this.build();
      return;
    }
    this.updateHint();
  }

  protected applyTyped(values: number[]): void {
    const v = values[0];
    if (!v) return;
    if (this.stage === 1) {
      this.r = Math.abs(v);
      if (this.faceMode) {
        this.buildFace();
        return;
      }
      this.stage = 2;
      this.h = 0;
      this.drawCircle();
    } else if (this.stage === 2) {
      this.h = v;
      this.build();
    }
  }

  private center(): THREE.Vector3 {
    return this.frame.point(this.cu, this.cv);
  }

  private drawCircle(): void {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      pts.push(this.frame.point(this.cu + Math.cos(a) * this.r, this.cv + Math.sin(a) * this.r));
    }
    const objs: THREE.Object3D[] = [this.outline(pts), this.cursor(this.center())];
    if (this.r > 0) objs.push(this.frame.place(new THREE.Mesh(new THREE.CircleGeometry(this.r, 64), this.host.viewport.mats.previewFill), this.center()));
    this.host.viewport.setOverlay(objs);
    this.host.hud(`R ${fmt(this.r)} mm`, pts[0]);
  }

  private drawCylinder(): void {
    const geo = new THREE.CylinderGeometry(this.r, this.r, Math.max(Math.abs(this.h), 1e-3), 64);
    const c = this.center().addScaledVector(this.frame.z, this.h / 2);
    this.host.viewport.setOverlay([this.frame.place(this.solidPreview(geo), c, "xz-cyl")]);
    this.host.hud(`R ${fmt(this.r)} × H ${fmt(this.h)} mm`, this.center().addScaledVector(this.frame.z, this.h));
  }

  private build(): void {
    const c = this.center();
    const r = this.r;
    const h = this.h;
    this.emit(() => makeCylinder(this.frame.toKernel(), [c.x, c.y, c.z], r, h), "Cylinder");
  }

  private buildFace(): void {
    const c = this.center();
    const r = this.r;
    this.emit(() => makeCircleFace(this.frame.toKernel(), [c.x, c.y, c.z], r), "Circle", "face");
  }
}

// ------------------------------------------------------------------ Sphere

export class SphereTool extends DrawTool {
  readonly name = "Sphere";
  protected readonly hints = [
    "Sphere: click the center (on the grid or on a planar face)",
    "Sphere: click to set the radius — or type radius + Enter",
  ];
  private c = new THREE.Vector3();
  private cu = 0;
  private cv = 0;
  private r = 0;

  move(e: PointerEvent): void {
    this.last = e;
    const step = this.host.snapStep(e);
    if (this.stage === 0) {
      this.frame = this.frameUnder(e);
      const p = this.frame.hit(this.ray(e), step);
      if (p) this.host.viewport.setOverlay([this.cursor(this.frame.point(p.u, p.v))]);
    } else {
      const p = this.frame.hit(this.ray(e), 0);
      if (!p) return;
      this.r = snapValue(Math.hypot(p.u - this.cu, p.v - this.cv), step);
      this.draw();
    }
  }

  down(e: PointerEvent): void {
    if (this.stage === 0) {
      const p = this.frame.hit(this.ray(e), this.host.snapStep(e));
      if (!p) return;
      this.cu = p.u;
      this.cv = p.v;
      this.c = this.frame.point(p.u, p.v);
      this.r = 0;
      this.stage = 1;
      this.updateHint();
    } else if (this.r > 1e-6) {
      this.build();
    }
  }

  protected applyTyped(values: number[]): void {
    if (this.stage === 1 && values[0]) {
      this.r = Math.abs(values[0]);
      this.build();
    }
  }

  private draw(): void {
    const geo = new THREE.SphereGeometry(Math.max(this.r, 1e-3), 48, 24);
    const preview = this.solidPreview(geo);
    preview.position.copy(this.c);
    this.host.viewport.setOverlay([preview, this.cursor(this.c)]);
    this.host.hud(`R ${fmt(this.r)} mm`, this.c.clone().addScaledVector(this.frame.x, this.r));
  }

  private build(): void {
    const c = this.c;
    const r = this.r;
    this.emit(() => makeSphereAt([c.x, c.y, c.z], r), "Sphere");
  }
}

// ------------------------------------------------------------------ Polygon (regular n-gon face, or prism)

/** Flat regular Polygon face (default), or a polygon prism solid when faceMode is false. */
export class PolygonTool extends DrawTool {
  readonly name = "Polygon";
  constructor(host: ToolHost, private readonly faceMode = true) {
    super(host);
  }

  private static lastSides = 6;
  private sides = PolygonTool.lastSides;
  private cu = 0;
  private cv = 0;
  private r = 0;
  /** Angle of the first corner, radians, measured from frame.x toward frame.y. */
  private a = 0;
  private h = 0;

  protected get hints(): string[] {
    const n = `${this.sides} sides — [ / ] to change`;
    return [
      `Polygon (${n}): click the center (on the grid or on a planar face)`,
      `Polygon (${n}): click to set radius & rotation (15° snap) — or type radius[,sides] + Enter`,
      // (stage 2 is only used for prisms)
      `Polygon (${n}): move to set the height and click — or type height + Enter`,
    ];
  }

  move(e: PointerEvent): void {
    this.last = e;
    const step = this.host.snapStep(e);
    if (this.stage === 0) {
      this.frame = this.frameUnder(e);
      const p = this.frame.hit(this.ray(e), step);
      if (p) this.host.viewport.setOverlay([this.cursor(this.frame.point(p.u, p.v))]);
    } else if (this.stage === 1) {
      const p = this.frame.hit(this.ray(e), 0);
      if (!p) return;
      const du = p.u - this.cu;
      const dv = p.v - this.cv;
      this.r = snapValue(Math.hypot(du, dv), step);
      let a = Math.atan2(dv, du);
      if (step > 0) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12); // 15° steps
      this.a = a;
      this.drawOutline();
    } else {
      const h = heightAlong(this.ray(e), this.center(), this.frame.z);
      if (h === null) return;
      this.h = snapValue(h, step);
      this.drawPrism();
    }
  }

  down(e: PointerEvent): void {
    if (this.stage === 0) {
      const p = this.frame.hit(this.ray(e), this.host.snapStep(e));
      if (!p) return;
      this.cu = p.u;
      this.cv = p.v;
      this.r = 0;
      this.stage = 1;
    } else if (this.stage === 1) {
      if (this.r < 1e-6) return;
      if (this.faceMode) {
        this.buildFace();
        return;
      }
      this.stage = 2;
      this.h = 0;
    } else {
      if (Math.abs(this.h) < 1e-6) return;
      this.build();
      return;
    }
    this.updateHint();
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === "[" || e.key === "]") {
      this.sides = Math.min(64, Math.max(3, this.sides + (e.key === "]" ? 1 : -1)));
      PolygonTool.lastSides = this.sides;
      this.updateHint();
      if (this.stage === 1) this.drawOutline();
      else if (this.stage === 2) this.drawPrism();
      return true;
    }
    return super.key(e);
  }

  protected applyTyped(values: number[]): void {
    if (this.stage === 1) {
      const [r, n] = values;
      if (!r) return;
      this.r = Math.abs(r);
      if (n && n >= 3) this.sides = PolygonTool.lastSides = Math.min(64, Math.round(n));
      if (this.faceMode) {
        this.buildFace();
        return;
      }
      this.stage = 2;
      this.h = 0;
      this.drawOutline();
    } else if (this.stage === 2 && values[0]) {
      this.h = values[0];
      this.build();
    }
  }

  private center(): THREE.Vector3 {
    return this.frame.point(this.cu, this.cv);
  }

  private corners(h = 0): THREE.Vector3[] {
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k < this.sides; k++) {
      const t = this.a + (k / this.sides) * Math.PI * 2;
      pts.push(this.frame.point(this.cu + Math.cos(t) * this.r, this.cv + Math.sin(t) * this.r, h));
    }
    return pts;
  }

  private drawOutline(): void {
    const pts = this.corners();
    const objs: THREE.Object3D[] = [this.outline(pts), this.cursor(this.center()), this.cursor(pts[0])];
    if (this.r > 0) {
      // Fan-triangulated fill (convex polygon).
      const fill = new THREE.BufferGeometry().setFromPoints([this.center(), ...pts]);
      const idx: number[] = [];
      for (let k = 1; k <= this.sides; k++) idx.push(0, k, (k % this.sides) + 1);
      fill.setIndex(idx);
      objs.push(new THREE.Mesh(fill, this.host.viewport.mats.previewFill));
    }
    this.host.viewport.setOverlay(objs);
    const deg = Math.round((THREE.MathUtils.radToDeg(this.a) + 360) % 360);
    this.host.hud(`${this.sides}-gon  R ${fmt(this.r)} mm  ∠ ${deg}°`, pts[0]);
  }

  private drawPrism(): void {
    // CylinderGeometry corners sit at local (sinθ, ·, cosθ); with the "xz-cyl" basis
    // that is world (u, v) = (sinθ, -cosθ), so θ = a + 90° puts a corner at angle a.
    let geo: THREE.BufferGeometry = new THREE.CylinderGeometry(this.r, this.r, Math.max(Math.abs(this.h), 1e-3), this.sides, 1, false, this.a + Math.PI / 2);
    geo = geo.toNonIndexed();
    geo.computeVertexNormals(); // flat-shaded sides
    const c = this.center().addScaledVector(this.frame.z, this.h / 2);
    this.host.viewport.setOverlay([this.frame.place(this.solidPreview(geo), c, "xz-cyl")]);
    this.host.hud(`${this.sides}-gon  R ${fmt(this.r)} × H ${fmt(this.h)} mm`, this.center().addScaledVector(this.frame.z, this.h));
  }

  private build(): void {
    const c = this.center();
    const { r, sides, h } = this;
    const deg = THREE.MathUtils.radToDeg(this.a);
    this.emit(() => makePolygonPrism(this.frame.toKernel(), [c.x, c.y, c.z], r, sides, deg, h), "Polygon");
  }

  private buildFace(): void {
    const c = this.center();
    const { r, sides } = this;
    const deg = THREE.MathUtils.radToDeg(this.a);
    this.emit(() => makePolygonFace(this.frame.toKernel(), [c.x, c.y, c.z], r, sides, deg), "Polygon", "face");
  }
}
