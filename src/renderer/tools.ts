/**
 * Interactive drawing tools.
 *   Solid tools: Box / Cylinder / Sphere create closed 3D solids.
 *   Face tools:  Rectangle / Circle / Polygon / Text create flat planar faces, which
 *                Push/Pull then extrudes into a new solid.
 *
 * Every tool draws on the ground plane, or on the planar face under the
 * cursor at the first click, so you can build directly on existing solids.
 * Points snap to the grid / object points only while Ctrl is held. While a tool is active you
 * can also type exact dimensions (e.g. "40,25" then Enter for a rectangle).
 */
import * as THREE from "three";
import type { Viewport, SnapKind, GizmoFrame } from "./viewport";
import {
  planarFaceFrame,
  axisCrossEdge,
  nearestOnEdge,
  makeBox,
  makeCylinder,
  makeSphereAt,
  makeCone,
  makePolygonPrism,
  makeRectFace,
  makeCircleFace,
  makePolygonFace,
  makeTextFaces,
  wrappedTextFaces,
  tessellate,
  type TextOptions,
  type BodyKind,
  type RefEdge,
  type Frame,
  type Shape,
  type V3,
} from "./kernel";
import { circleSize, parseLen, typedUnit } from "./format";

export interface ToolHost {
  viewport: Viewport;
  /** Grid step for snapping; 0 when not snapping (see Viewport.snapping) or when the step is Off. */
  snapStep(e: { ctrlKey: boolean } | null): number;
  hint(text: string): void;
  toast(msg: string, kind?: "info" | "error"): void;
  hud(text: string | null, at?: THREE.Vector3): void;
  finish(shape: Shape, baseName: string, kind: BodyKind): void;
  fail(e: unknown): void;
  /** Show a property dialog; onOk receives the edited values in field order. */
  propsDialog(title: string, fields: PropField[], onOk: (values: number[]) => void, okLabel?: string): void;
}

export interface PropField {
  label: string;
  value: number;
  step?: number;
  min?: number;
  /** Hidden behind a "More…" link (still sent back, with its value). */
  more?: boolean;
}

export interface Tool {
  readonly name: string;
  move(e: PointerEvent): void;
  down(e: PointerEvent): void;
  /** Optional: left button released in the viewport. */
  up?(e: PointerEvent): void;
  /** Returns true if the key was consumed. */
  key(e: KeyboardEvent): boolean;
  /** Optional: a right click (no drag) in the viewport. */
  rightClick?(e: PointerEvent): void;
  /** Optional: mouse wheel in the viewport. Return true to consume it (no zoom). */
  wheel?(e: WheelEvent): boolean;
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

/**
 * Construction plane for empty space, chosen from the view: the ground (XY) unless the
 * camera looks almost horizontally — then XZ (front/back views) or YZ (side views), so shapes
 * are drawn facing the viewer. Passes through `at` (default: origin).
 */
function workPlane(camera: THREE.Camera, at = new THREE.Vector3()): PlaneFrame {
  const d = camera.getWorldDirection(new THREE.Vector3());
  const o = at.clone();
  // Only near-horizontal views (within ~15°, e.g. front/right) switch to a vertical plane.
  if (Math.abs(d.z) >= 0.26) return new PlaneFrame(new THREE.Vector3(0, 0, o.z), GROUND.x, GROUND.y, GROUND.z);
  const up = new THREE.Vector3(0, 0, 1);
  if (Math.abs(d.y) >= Math.abs(d.x)) {
    // XZ plane; normal points back toward the camera.
    const s = d.y > 0 ? 1 : -1;
    return new PlaneFrame(new THREE.Vector3(0, o.y, 0), new THREE.Vector3(s, 0, 0), up, new THREE.Vector3(0, -s, 0));
  }
  const s = d.x > 0 ? 1 : -1;
  return new PlaneFrame(new THREE.Vector3(o.x, 0, 0), new THREE.Vector3(0, -s, 0), up, new THREE.Vector3(-s, 0, 0));
}

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
    const base = `${this.hints[this.stage] ?? ""} · Tab: properties`;
    this.host.hint(this.typed ? `${base}   ⌨ ${this.typed}_ (Enter to apply)` : base);
  }

  /** The planar face frame under the cursor, or the ground plane. */
  protected frameUnder(e: PointerEvent): PlaneFrame {
    const frame = this.faceFrameUnder(e);
    const sp = this.host.viewport.snapping(e) ? this.host.viewport.snapPoint(e.clientX, e.clientY) : null;
    // Vertices / edge midpoints sit on several faces at once, so the face under the cursor
    // is ambiguous: draw on the view's work plane through the point. Centres keep their face.
    if (sp && (sp.kind !== "center" || Math.abs(sp.point.clone().sub(frame.origin).dot(frame.z)) > 1e-4)) {
      return workPlane(this.host.viewport.camera, sp.point);
    }
    return frame;
  }

  private faceFrameUnder(e: PointerEvent): PlaneFrame {
    const f = this.host.viewport.faceUnder(e.clientX, e.clientY);
    if (!f) return workPlane(this.host.viewport.camera);
    const key = `${f.body.id}:${f.faceId}`;
    if (!this.faceCache.has(key)) {
      const k = f.body.kind === "solid" || f.body.kind === "face" ? planarFaceFrame(f.body.shape, f.faceId) : null;
      this.faceCache.set(key, k ? PlaneFrame.from(k) : null);
    }
    return this.faceCache.get(key) ?? workPlane(this.host.viewport.camera);
  }

  protected ray(e: PointerEvent): THREE.Ray {
    return this.host.viewport.ray(e.clientX, e.clientY);
  }

  /** True when the last hit()/height() locked onto an object snap point. */
  protected objSnapped = false;

  /** Object snap under the cursor (when snapping, see Viewport.snapping); updates the marker. */
  private objectSnap(e: PointerEvent): THREE.Vector3 | null {
    const snap = this.host.viewport.snapping(e) ? this.host.viewport.snapPoint(e.clientX, e.clientY) : null;
    this.host.viewport.showSnapMarker(snap);
    return snap ? snap.point : null;
  }

  /** Cursor point on the drawing plane: object snap (projected onto the plane) or grid snap. */
  protected hit(e: PointerEvent, step: number): { u: number; v: number } | null {
    const sp = this.objectSnap(e);
    this.objSnapped = !!sp;
    if (sp) {
      const d = sp.sub(this.frame.origin);
      return { u: d.dot(this.frame.x), v: d.dot(this.frame.y) };
    }
    return this.frame.hit(this.ray(e), step);
  }

  /** Height along the frame normal from `base`: object snap point's height, or the cursor ray's. */
  protected height(e: PointerEvent, base: THREE.Vector3): number | null {
    const sp = this.objectSnap(e);
    this.objSnapped = !!sp;
    if (sp) return sp.sub(base).dot(this.frame.z);
    return heightAlong(this.ray(e), base, this.frame.z);
  }

  /** Grid-round a value unless it came from an object snap. */
  protected sv(n: number, step: number): number {
    return this.objSnapped ? n : snapValue(n, step);
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

  /** Editable properties of the shape being drawn (Tab dialog). */
  protected abstract props(): PropField[];
  protected abstract applyProps(values: number[]): void;
  private static lastProps = new Map<string, number[]>();

  /** Tab: anchor at the cursor if nothing is placed yet, then open the property dialog. */
  private openProps(): void {
    if (this.stage === 0) {
      if (!this.last) {
        this.host.hint(`${this.name}: move the cursor over the viewport, then press Tab`);
        return;
      }
      this.down(this.last);
      if (this.stage === 0) return;
    }
    const remembered = DrawTool.lastProps.get(this.name);
    const fields = this.props().map((f, i) => (f.value || !remembered ? f : { ...f, value: remembered[i] ?? f.value }));
    this.host.propsDialog(this.name, fields, (vals) => {
      DrawTool.lastProps.set(this.name, vals);
      this.applyProps(vals);
    });
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === "Tab") {
      this.openProps();
      return true;
    }
    if (this.stage === 0) return false;
    const inch = typedUnit(this.typed, e.key); // 3.34in / 3.34" = 84.836 mm
    if (inch !== null || /^[0-9.,\-]$/.test(e.key) || (/^[xX*]$/.test(e.key) && /\d$/.test(this.typed))) {
      this.typed = inch ?? this.typed + (e.key === "*" ? "x" : e.key.toLowerCase()); // 40x25 = 40,25
    } else if (e.key === "Backspace" && this.typed) {
      this.typed = this.typed.slice(0, -1);
    } else if (e.key === "Enter" && this.typed) {
      const nums = this.typed.split(/[,x]/).map(parseLen);
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
    this.host.viewport.showSnapMarker(null);
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
      `${n}: click the opposite corner — or type width,depth (or 40x25) + Enter`,
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
      const p = this.hit(e, step);
      if (!p) return;
      const w = this.frame.point(p.u, p.v);
      this.host.viewport.setOverlay([this.cursor(w)]);
      this.host.hud(null);
    } else if (this.stage === 1) {
      const p = this.hit(e, step);
      if (!p) return;
      this.u2 = p.u;
      this.v2 = p.v;
      this.drawRect();
    } else {
      const h = this.height(e, this.rectCenter());
      if (h === null) return;
      this.h = this.sv(h, step);
      this.drawBox();
    }
  }

  down(e: PointerEvent): void {
    const step = this.host.snapStep(e);
    if (this.stage === 0) {
      const p = this.hit(e, step);
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

  protected props(): PropField[] {
    const f: PropField[] = [
      { label: "Width", value: +Math.abs(this.u2 - this.u1).toFixed(4), min: 0 },
      { label: "Depth", value: +Math.abs(this.v2 - this.v1).toFixed(4), min: 0 },
    ];
    if (!this.faceMode) f.push({ label: "Height", value: +this.h.toFixed(4) });
    return f;
  }

  protected applyProps([w, d, h]: number[]): void {
    if (!(w > 0) || !(d > 0)) return this.host.fail("width and depth must be > 0");
    this.u2 = this.u1 + w * (this.u2 < this.u1 ? -1 : 1);
    this.v2 = this.v1 + d * (this.v2 < this.v1 ? -1 : 1);
    if (this.faceMode) return this.buildFace();
    if (!h) return this.host.fail("height must not be 0");
    this.h = h;
    this.build();
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
      `${n}: click to set the ${circleSize.word} — or type ${circleSize.word} + Enter`,
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
      const p = this.hit(e, step);
      if (p) this.host.viewport.setOverlay([this.cursor(this.frame.point(p.u, p.v))]);
    } else if (this.stage === 1) {
      const p = this.hit(e, 0);
      if (!p) return;
      this.r = this.sv(Math.hypot(p.u - this.cu, p.v - this.cv), step);
      this.drawCircle();
    } else {
      const h = this.height(e, this.center());
      if (h === null) return;
      this.h = this.sv(h, step);
      this.drawCylinder();
    }
  }

  down(e: PointerEvent): void {
    if (this.stage === 0) {
      const p = this.hit(e, this.host.snapStep(e));
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
      this.r = circleSize.radius(Math.abs(v));
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

  protected props(): PropField[] {
    const f: PropField[] = [{ label: circleSize.label, value: +circleSize.shown(this.r).toFixed(4), min: 0 }];
    if (!this.faceMode) f.push({ label: "Height", value: +this.h.toFixed(4) });
    return f;
  }

  protected applyProps([r, h]: number[]): void {
    if (!(r > 0)) return this.host.fail(`${circleSize.word} must be > 0`);
    this.r = circleSize.radius(r);
    if (this.faceMode) return this.buildFace();
    if (!h) return this.host.fail("height must not be 0");
    this.h = h;
    this.build();
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
    this.host.hud(`${circleSize.tag} ${fmt(circleSize.shown(this.r))} mm`, pts[0]);
  }

  private drawCylinder(): void {
    const geo = new THREE.CylinderGeometry(this.r, this.r, Math.max(Math.abs(this.h), 1e-3), 64);
    const c = this.center().addScaledVector(this.frame.z, this.h / 2);
    this.host.viewport.setOverlay([this.frame.place(this.solidPreview(geo), c, "xz-cyl")]);
    this.host.hud(`${circleSize.tag} ${fmt(circleSize.shown(this.r))} × H ${fmt(this.h)} mm`, this.center().addScaledVector(this.frame.z, this.h));
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

// ------------------------------------------------------------------ Cone

/** Cone solid: base centre, base size, height — a sharp tip, or a flat top (cut-off cone) with a top size > 0. */
export class ConeTool extends DrawTool {
  readonly name = "Cone";
  protected get hints(): string[] {
    const w = circleSize.word;
    return [
      "Cone: click the centre of its base (on the grid or on a planar face)",
      `Cone: click to set the base ${w} — or type ${w} + Enter`,
      `Cone: move to set the height and click (a sharp tip) — or type height + Enter, or height,top ${w} + Enter (a flat top)`,
    ];
  }
  private cu = 0;
  private cv = 0;
  private r = 0;
  private top = 0;
  private h = 0;

  move(e: PointerEvent): void {
    this.last = e;
    const step = this.host.snapStep(e);
    if (this.stage === 0) {
      this.frame = this.frameUnder(e);
      const p = this.hit(e, step);
      if (p) this.host.viewport.setOverlay([this.cursor(this.frame.point(p.u, p.v))]);
    } else if (this.stage === 1) {
      const p = this.hit(e, 0);
      if (!p) return;
      this.r = this.sv(Math.hypot(p.u - this.cu, p.v - this.cv), step);
      this.drawBase();
    } else {
      const h = this.height(e, this.center());
      if (h === null) return;
      this.h = this.sv(h, step);
      this.drawCone();
    }
  }

  down(e: PointerEvent): void {
    if (this.stage === 0) {
      const p = this.hit(e, this.host.snapStep(e));
      if (!p) return;
      this.cu = p.u;
      this.cv = p.v;
      this.r = 0;
      this.stage = 1;
    } else if (this.stage === 1) {
      if (this.r < 1e-6) return;
      this.stage = 2;
      this.h = 0;
    } else {
      if (Math.abs(this.h) < 1e-6) return;
      this.build();
      return;
    }
    this.updateHint();
  }

  protected applyTyped([v, top]: number[]): void {
    if (!v) return;
    if (this.stage === 1) {
      this.r = circleSize.radius(Math.abs(v));
      this.stage = 2;
      this.h = 0;
      this.drawBase();
    } else if (this.stage === 2) {
      if (top !== undefined && !(top >= 0)) return this.host.fail(`top ${circleSize.word} must be 0 or more`);
      this.h = v;
      this.top = top ? circleSize.radius(top) : 0;
      this.build();
    }
  }

  protected props(): PropField[] {
    return [
      { label: circleSize.label, value: +circleSize.shown(this.r).toFixed(4), min: 0 },
      { label: `Top ${circleSize.word} (0: a sharp tip)`, value: +circleSize.shown(this.top).toFixed(4), min: 0 },
      { label: "Height", value: +this.h.toFixed(4) },
    ];
  }

  protected applyProps([r, top, h]: number[]): void {
    if (!(r > 0)) return this.host.fail(`${circleSize.word} must be > 0`);
    if (!(top >= 0)) return this.host.fail(`top ${circleSize.word} must be 0 or more`);
    if (!h) return this.host.fail("height must not be 0");
    this.r = circleSize.radius(r);
    this.top = circleSize.radius(top);
    this.h = h;
    this.build();
  }

  private center(): THREE.Vector3 {
    return this.frame.point(this.cu, this.cv);
  }

  private drawBase(): void {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      pts.push(this.frame.point(this.cu + Math.cos(a) * this.r, this.cv + Math.sin(a) * this.r));
    }
    const objs: THREE.Object3D[] = [this.outline(pts), this.cursor(this.center())];
    if (this.r > 0) objs.push(this.frame.place(new THREE.Mesh(new THREE.CircleGeometry(this.r, 64), this.host.viewport.mats.previewFill), this.center()));
    this.host.viewport.setOverlay(objs);
    this.host.hud(`${circleSize.tag} ${fmt(circleSize.shown(this.r))} mm`, pts[0]);
  }

  private drawCone(): void {
    // (the geometry's +Y end is the top only when the cone goes up the face normal)
    const up = this.h >= 0;
    const geo = new THREE.CylinderGeometry(up ? this.top : this.r, up ? this.r : this.top, Math.max(Math.abs(this.h), 1e-3), 64);
    const c = this.center().addScaledVector(this.frame.z, this.h / 2);
    this.host.viewport.setOverlay([this.frame.place(this.solidPreview(geo), c, "xz-cyl")]);
    this.host.hud(`${circleSize.tag} ${fmt(circleSize.shown(this.r))} × H ${fmt(this.h)} mm`, this.center().addScaledVector(this.frame.z, this.h));
  }

  private build(): void {
    const c = this.center();
    const { r, top, h } = this;
    this.emit(() => makeCone(this.frame.toKernel(), [c.x, c.y, c.z], r, top, h), "Cone");
  }
}

// ------------------------------------------------------------------ Sphere

export class SphereTool extends DrawTool {
  readonly name = "Sphere";
  protected get hints(): string[] {
    return ["Sphere: click the center (on the grid or on a planar face)", `Sphere: click to set the ${circleSize.word} — or type ${circleSize.word} + Enter`];
  }
  private c = new THREE.Vector3();
  private cu = 0;
  private cv = 0;
  private r = 0;

  move(e: PointerEvent): void {
    this.last = e;
    const step = this.host.snapStep(e);
    if (this.stage === 0) {
      this.frame = this.frameUnder(e);
      const p = this.hit(e, step);
      if (p) this.host.viewport.setOverlay([this.cursor(this.frame.point(p.u, p.v))]);
    } else {
      const p = this.hit(e, 0);
      if (!p) return;
      this.r = this.sv(Math.hypot(p.u - this.cu, p.v - this.cv), step);
      this.draw();
    }
  }

  down(e: PointerEvent): void {
    if (this.stage === 0) {
      const p = this.hit(e, this.host.snapStep(e));
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
      this.r = circleSize.radius(Math.abs(values[0]));
      this.build();
    }
  }

  protected props(): PropField[] {
    return [{ label: circleSize.label, value: +circleSize.shown(this.r).toFixed(4), min: 0 }];
  }

  protected applyProps([r]: number[]): void {
    if (!(r > 0)) return this.host.fail(`${circleSize.word} must be > 0`);
    this.r = circleSize.radius(r);
    this.build();
  }

  private draw(): void {
    const geo = new THREE.SphereGeometry(Math.max(this.r, 1e-3), 48, 24);
    const preview = this.solidPreview(geo);
    preview.position.copy(this.c);
    this.host.viewport.setOverlay([preview, this.cursor(this.c)]);
    this.host.hud(`${circleSize.tag} ${fmt(circleSize.shown(this.r))} mm`, this.c.clone().addScaledVector(this.frame.x, this.r));
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
    const n = `${this.sides} sides — Shift+wheel or [ / ] to change`;
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
      const p = this.hit(e, step);
      if (p) this.host.viewport.setOverlay([this.cursor(this.frame.point(p.u, p.v))]);
    } else if (this.stage === 1) {
      const p = this.hit(e, 0);
      if (!p) return;
      const du = p.u - this.cu;
      const dv = p.v - this.cv;
      this.r = this.sv(Math.hypot(du, dv), step);
      let a = Math.atan2(dv, du);
      if (step > 0) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12); // 15° steps
      this.a = a;
      this.drawOutline();
    } else {
      const h = this.height(e, this.center());
      if (h === null) return;
      this.h = this.sv(h, step);
      this.drawPrism();
    }
  }

  down(e: PointerEvent): void {
    if (this.stage === 0) {
      const p = this.hit(e, this.host.snapStep(e));
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

  private changeSides(d: number): void {
    this.sides = Math.min(64, Math.max(3, this.sides + d));
    PolygonTool.lastSides = this.sides;
    this.updateHint();
    if (this.stage === 1) this.drawOutline();
    else if (this.stage === 2) this.drawPrism();
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === "[" || e.key === "]") {
      this.changeSides(e.key === "]" ? 1 : -1);
      return true;
    }
    return super.key(e);
  }

  /** Shift+wheel: wheel up adds a side, wheel down removes one. */
  wheel(e: WheelEvent): boolean {
    if (!e.shiftKey) return false;
    const d = e.deltaY || e.deltaX; // some platforms map Shift+wheel to horizontal
    if (!d) return true;
    this.changeSides(d < 0 ? 1 : -1);
    return true;
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

  protected props(): PropField[] {
    const f: PropField[] = [
      { label: "Radius", value: +this.r.toFixed(4), min: 0 },
      { label: "Sides", value: this.sides, step: 1, min: 3 },
      { label: "Rotation °", value: +THREE.MathUtils.radToDeg(this.a).toFixed(2), step: 15 },
    ];
    if (!this.faceMode) f.push({ label: "Height", value: +this.h.toFixed(4) });
    return f;
  }

  protected applyProps([r, n, deg, h]: number[]): void {
    if (!(r > 0)) return this.host.fail("radius must be > 0");
    this.r = r;
    this.sides = PolygonTool.lastSides = Math.min(64, Math.max(3, Math.round(n || this.sides)));
    this.a = THREE.MathUtils.degToRad(deg || 0);
    if (this.faceMode) return this.buildFace();
    if (!h) return this.host.fail("height must not be 0");
    this.h = h;
    this.build();
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

// ------------------------------------------------------------------ Text

/** The Text tool's settings (its panel; kept for the next text). */
export interface TextSettings extends TextOptions {
  text: string;
}

/**
 * Flat Text faces: click where the text starts (its baseline, on the grid or on a planar face) — the
 * panel (`onPlaced`) sets the text, font, size, alignment and spacing, shown live; Enter / Create adds one face
 * per letter outline (`done`). A click elsewhere moves the text there.
 */
export class TextTool extends DrawTool {
  readonly name = "Text";
  static settings: TextSettings = { text: "Text", height: 10, align: "left", lineSpacing: 1, letterSpacing: 0, font: "" };
  protected readonly hints = [
    "Text: click where it starts (on the grid or on a planar face) — or on a curved side (a cup): it wraps round it",
    "Text: type in the panel · click elsewhere to move it · Enter / Create adds it",
  ];
  private at = new THREE.Vector3();
  /** Wrapped round a curved face (clicked on one): the face and where the text's middle is. */
  private curved: { shape: Shape; faceId: number; at: V3 } | null = null;
  /** No wrapping (editing a flat text: a click on a curved face moves it flat). */
  noWrap = false;

  /** The text wraps round a curved face (see wrappedTextFaces): its letters can't be edited again as a text. */
  get wrapped(): boolean {
    return this.curved !== null;
  }

  /** The curved face under the cursor (not a planar one), and the point on it. */
  private curvedUnder(e: PointerEvent): { shape: Shape; faceId: number; at: V3 } | null {
    if (this.noWrap) return null;
    const f = this.host.viewport.faceUnder(e.clientX, e.clientY);
    if (!f || f.body.kind !== "solid" || planarFaceFrame(f.body.shape, f.faceId)) return null;
    return { shape: f.body.shape, faceId: f.faceId, at: [f.point.x, f.point.y, f.point.z] };
  }
  private faces: Shape[] = [];
  private error = "";

  constructor(host: ToolHost, private readonly onPlaced: () => void, private readonly done: (faces: Shape[], s: TextSettings) => void) {
    super(host);
  }

  get placed(): boolean {
    return this.stage === 1;
  }

  /** Clicked somewhere else since placeAt. */
  moved = false;

  /** Start already placed (editing a text): on `frame`, its first baseline starting at frame.origin. */
  placeAt(frame: Frame): this {
    this.frame = PlaneFrame.from(frame);
    this.at = this.frame.origin.clone();
    this.stage = 1;
    this.updateHint();
    this.redraw();
    this.onPlaced();
    return this;
  }

  /** The plane the text is on, its origin where it starts (the TextRecord's frame). */
  placement(): Frame {
    return { ...this.frame.toKernel(), origin: [this.at.x, this.at.y, this.at.z] };
  }

  /** Why the text can't be made (e.g. a letter the font hasn't got), "" if it can. */
  get problem(): string {
    return this.error;
  }

  move(e: PointerEvent): void {
    this.last = e;
    if (this.stage === 1) return;
    const c = this.curvedUnder(e);
    if (c) return this.host.viewport.setOverlay([this.cursor(new THREE.Vector3(...c.at))]);
    this.frame = upright(this.frameUnder(e));
    const p = this.hit(e, this.host.snapStep(e));
    if (p) this.host.viewport.setOverlay([this.cursor(this.frame.point(p.u, p.v))]);
  }

  down(e: PointerEvent): void {
    const curved = this.curvedUnder(e);
    if (curved) {
      this.curved = curved;
      this.at.set(...curved.at);
    } else {
      const frame = upright(this.frameUnder(e));
      const prev = this.frame;
      this.frame = frame;
      const p = this.hit(e, this.host.snapStep(e));
      if (!p) return void (this.frame = prev);
      this.at = this.frame.point(p.u, p.v);
      this.curved = null;
    }
    const first = this.stage === 0;
    if (!first) this.moved = true;
    this.stage = 1;
    this.updateHint();
    this.redraw();
    if (first) this.onPlaced();
  }

  /** The panel changed a setting: redraw the text. */
  set(s: Partial<TextSettings>): void {
    TextTool.settings = { ...TextTool.settings, ...s };
    if (this.stage === 1) this.redraw();
  }

  /** Add the text (one face per letter outline). */
  create(): void {
    if (this.stage !== 1) return this.host.hint("Text: click where it starts first");
    if (this.error) return this.host.fail(this.error);
    if (!this.faces.length) return this.host.toast("Text: type some letters first", "error");
    const faces = this.faces;
    this.faces = [];
    this.done(faces, TextTool.settings);
  }

  private redraw(): void {
    const vp = this.host.viewport;
    const s = TextTool.settings;
    try {
      this.faces = this.curved
        ? wrappedTextFaces(this.curved.shape, this.curved.faceId, this.curved.at, s.text, s)
        : makeTextFaces(this.frame.toKernel(), [this.at.x, this.at.y, this.at.z], s.text, s);
      this.error = "";
    } catch (err) {
      this.faces = [];
      this.error = err instanceof Error ? err.message : String(err);
    }
    const pos: number[] = [], idx: number[] = [], seg: number[] = [];
    for (const f of this.faces) {
      const t = tessellate(f, true), o = pos.length / 3;
      pos.push(...t.faces.vertices);
      idx.push(...t.faces.triangles.map((k) => k + o));
      seg.push(...t.edges.lines);
    }
    // (lifted a hair off the plane, so a text on a solid's face shows over it)
    const lift = this.curved ? new THREE.Vector3() : this.frame.z.clone().multiplyScalar(vp.worldPerPixel(this.at) * 0.5);
    const tris = new THREE.BufferGeometry();
    tris.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    tris.setIndex(idx);
    tris.translate(lift.x, lift.y, lift.z);
    const lines = new THREE.BufferGeometry();
    lines.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
    lines.translate(lift.x, lift.y, lift.z);
    vp.setOverlay([new THREE.Mesh(tris, vp.mats.previewFill), new THREE.LineSegments(lines, vp.mats.previewLine), this.cursor(this.at)]);
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === "Enter" && this.stage === 1) {
      this.create();
      return true;
    }
    if (e.key === "Tab") return true; // (the panel has the settings)
    return false;
  }

  protected props(): PropField[] {
    return [];
  }
  protected applyProps(): void {}
  protected applyTyped(): void {}
}

/**
 * The frame turned so text reads upright: on a wall, y points up and x along it; on a level plane
 * (or one leaning back), x runs along +X as far as it can.
 */
function upright(f: PlaneFrame): PlaneFrame {
  const up = new THREE.Vector3(0, 0, 1);
  if (Math.abs(f.z.z) <= 0.9) {
    const y = up.addScaledVector(f.z, -f.z.z).normalize();
    return new PlaneFrame(f.origin, y.clone().cross(f.z), y, f.z);
  }
  const x = new THREE.Vector3(1, 0, 0).addScaledVector(f.z, -f.z.x).normalize();
  return new PlaneFrame(f.origin, x, f.z.clone().cross(x), f.z);
}

// ------------------------------------------------------------------ Move by points

/**
 * Base-point move: the selection's pivot candidates (corners, edge midpoints, centres)
 * are shown as dots. Press on one and drag to the target (or click it, then click the
 * target): while dragging, the centres of the other solids' circles and flat faces show as dots
 * to drop it on (centre to centre, e.g. a rod onto the middle of a round face at any slant). A base can also be clicked anywhere else (Ctrl snaps to any solid). The selection moves by target − base.
 * Off-snap points use a horizontal plane through the base (grid-snapped). Shift locks
 * to the dominant axis; typing "dx,dy,dz" + Enter moves by an exact offset.
 */
export class PointMoveTool implements Tool {
  readonly name = "Move from point";
  private base: THREE.Vector3 | null = null;
  private delta: THREE.Vector3 | null = null;
  private typed = "";
  private exclude: Set<number>;
  private pivots: { point: THREE.Vector3; kind: SnapKind }[] = [];
  private press: { x: number; y: number } | null = null;
  private all: { point: THREE.Vector3; kind: SnapKind; inside?: boolean }[] = [];
  /** Once a base is picked: the other solids' centre marks to drop it on. */
  private targets: { point: THREE.Vector3; kind: SnapKind }[] = [];
  private camKey = "";

  constructor(
    private host: ToolHost,
    private ids: number[],
    private onDone: (d: V3) => void,
    /** Clicking a mark (no drag) hands it over, e.g. to show the move gizmo there — or a point on a round / slanted edge, with its turned axes. */
    private onPick?: (p: V3, frame?: GizmoFrame) => void,
    /** The point on a round / slanted edge under the cursor and its turned axes (Z along the circle's axis / the edge), if any. */
    private slideEdgeAt?: (e: PointerEvent) => { point: V3; frame: GizmoFrame } | null,
  ) {
    this.exclude = new Set(ids);
  }

  start(): this {
    this.all = this.host.viewport.pivotCandidates(this.ids);
    this.refreshPivots();
    this.updateHint();
    return this;
  }

  /** Recompute which marks are visible (not behind a body) when the camera moves: the base marks, or once a base is picked, the target centres. */
  private refreshPivots(): void {
    const vp = this.host.viewport, c = vp.camera;
    const key = c.position.toArray().concat(c.quaternion.toArray() as number[]).map((n) => n.toFixed(4)).join();
    if (key === this.camKey) return;
    this.camKey = key;
    if (this.base) {
      this.targets = vp.spreadOnScreen(vp.centerTargets(this.exclude));
      vp.showPivotDots(this.targets);
    } else {
      // (only marks in sight: none behind a solid, the moved one included — but the solid's middle and a sphere's centre, inside it)
      // (marks closer than 14 px on screen: one of them — zoom in for the others)
      this.pivots = vp.spreadOnScreen([...this.all.filter((p) => p.inside), ...vp.visiblePoints(this.all.filter((p) => !p.inside))]);
      vp.showPivotDots(this.pivots);
    }
  }

  private updateHint(): void {
    const base = this.base
      ? `Move: drop on a blue centre mark (centre to centre) or any point (Shift = axis lock, ${this.host.viewport.autoSnap ? "Ctrl = free" : "Ctrl = snap"}) — or type dx,dy,dz + Enter · Esc cancel`
      : `Move: click a blue mark to get the move gizmo there — or press a mark and drag it to the target${this.slideEdgeAt ? " · click a round or slanted edge: the gizmo turned to it (Z along its axis / the edge)" : ""}`;
    this.host.hint(this.typed ? `${base}   ⌨ ${this.typed}_ (Enter to apply)` : base);
  }

  private pointAt(e: PointerEvent, planeZ: number, exclude?: Set<number>): THREE.Vector3 | null {
    const vp = this.host.viewport;
    const sp = vp.snapping(e) ? vp.snapPoint(e.clientX, e.clientY, exclude) : null;
    vp.showSnapMarker(sp);
    if (sp) return sp.point;
    const p = vp.ray(e.clientX, e.clientY).intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -planeZ), new THREE.Vector3());
    if (!p) return null;
    const step = this.host.snapStep(e);
    if (step > 0) {
      const o = this.base ?? new THREE.Vector3();
      p.x = o.x + Math.round((p.x - o.x) / step) * step;
      p.y = o.y + Math.round((p.y - o.y) / step) * step;
    }
    return p;
  }

  move(e: PointerEvent): void {
    const vp = this.host.viewport;
    if (!this.base) {
      this.refreshPivots();
      const pv = this.host.viewport.nearestOnScreen(e.clientX, e.clientY, this.pivots);
      const round = pv ? null : this.slideEdgeAt?.(e);
      vp.showSnapMarker(pv ?? (round ? { point: new THREE.Vector3(...round.point), kind: "edge" } : null));
      return;
    }
    this.refreshPivots();
    // A centre mark of another solid near the cursor wins (exactly centre to centre).
    const mark = vp.snapping(e) ? vp.nearestOnScreen(e.clientX, e.clientY, this.targets) : null;
    if (mark) vp.showSnapMarker(mark);
    const t = mark ? mark.point.clone() : this.pointAt(e, this.base.z, this.exclude);
    if (!t) return;
    const d = t.sub(this.base);
    if (e.shiftKey) {
      const a = Math.abs(d.x) >= Math.abs(d.y) && Math.abs(d.x) >= Math.abs(d.z) ? "x" : Math.abs(d.y) >= Math.abs(d.z) ? "y" : "z";
      for (const k of ["x", "y", "z"] as const) if (k !== a) d[k] = 0;
    }
    this.delta = d;
    vp.previewOffset(this.ids, d);
    const end = this.base.clone().add(d);
    vp.setOverlay([new THREE.Line(new THREE.BufferGeometry().setFromPoints([this.base, end]), vp.mats.previewLine)]);
    const f = (n: number) => +n.toFixed(3);
    this.host.hud(`Δ ${f(d.x)}, ${f(d.y)}, ${f(d.z)}  (${f(d.length())})`, end);
  }

  down(e: PointerEvent): void {
    if (!this.base) {
      const pv = this.host.viewport.nearestOnScreen(e.clientX, e.clientY, this.pivots);
      if (!pv) {
        // A round / slanted edge: the gizmo there, turned to it.
        const round = this.onPick ? this.slideEdgeAt?.(e) : null;
        if (round) return this.onPick!(round.point, round.frame);
        this.host.hint("Move: start from a blue mark (corner / edge midpoint / centre) · Esc cancel");
        return;
      }
      const p = pv.point;
      this.base = p.clone();
      this.press = { x: e.clientX, y: e.clientY };
      this.camKey = ""; // (shows the target centres now)
      this.refreshPivots();
      this.updateHint();
      return;
    }
    this.move(e);
    if (this.delta) this.finish([this.delta.x, this.delta.y, this.delta.z]);
  }

  /** Releasing after dragging from the base point drops the selection at the target. */
  up(e: PointerEvent): void {
    const p = this.press;
    this.press = null;
    if (!p || !this.base) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 5) {
      // A click on a mark: show the move gizmo there (or, without onPick, wait for the target click).
      if (this.onPick) {
        this.host.viewport.previewOffset(this.ids, null);
        this.onPick([this.base.x, this.base.y, this.base.z]);
      }
      return;
    }
    this.move(e);
    if (this.delta) this.finish([this.delta.x, this.delta.y, this.delta.z]);
  }

  private finish(d: V3): void {
    this.host.viewport.previewOffset(this.ids, null);
    if (Math.hypot(...d) > 1e-9) this.onDone(d);
  }

  key(e: KeyboardEvent): boolean {
    const inch = typedUnit(this.typed, e.key);
    if (inch !== null || /^[0-9.,\-]$/.test(e.key)) {
      this.typed = inch ?? this.typed + e.key;
    } else if (e.key === "Backspace" && this.typed) {
      this.typed = this.typed.slice(0, -1);
    } else if (e.key === "Enter" && this.typed) {
      const n = this.typed.split(",").map(parseLen);
      this.typed = "";
      if (n.length <= 3 && n.every(Number.isFinite)) this.finish([n[0] ?? 0, n[1] ?? 0, n[2] ?? 0]);
    } else {
      return false;
    }
    this.updateHint();
    return true;
  }

  dispose(): void {
    const vp = this.host.viewport;
    vp.previewOffset(this.ids, null);
    vp.showSnapMarker(null);
    vp.showPivotDots(null);
    vp.setOverlay([]);
    this.host.hud(null);
  }
}

/** Faces next to an edge, each with the edge as seen from that face. */
export interface EdgeSides {
  bodyId: number;
  faces: { faceId: number; ref: RefEdge }[];
}

/**
 * Guide line: pick a reference edge (or start from a selected edge), then move the mouse
 * to slide a parallel copy across the adjacent flat face under the cursor (distance shown,
 * Ctrl snaps to the grid step). Type a distance, or Tab for Distance / % / Count; Enter or
 * click adds the guide line(s). Guides are snap targets (Ctrl) for drawing and moving.
 */
const AXIS_COLORS = [0xe5484d, 0x30a46c, 0x3e8bff];
/** Within ~4° of an axis on screen, a 2-point guide (or a measurement) locks onto it. */
const AXIS_LOCK_COS = Math.cos((4 * Math.PI) / 180);

/**
 * Axis lock: when the cursor's direction from `p1` is within a few degrees (on screen) of a world
 * axis, the point on that axis through `p1` closest to the cursor ray (rounded to `step` if > 0),
 * and the axis (0 = X, 1 = Y, 2 = Z). Null when no axis is close or the cursor is on `p1`.
 */
export function axisLockPoint(vp: Viewport, p1: THREE.Vector3, e: PointerEvent, step: number): { point: THREE.Vector3; k: number } | null {
  const s1 = vp.toScreen(p1);
  const dx = e.clientX - s1.x, dy = e.clientY - s1.y;
  const len = Math.hypot(dx, dy);
  if (len < 12) return null;
  const reach = vp.worldPerPixel(p1) * 100;
  let best: { k: number; cos: number } | null = null;
  for (let k = 0; k < 3; k++) {
    const d = new THREE.Vector3().setComponent(k, reach);
    const s2 = vp.toScreen(p1.clone().add(d));
    const ax = s2.x - s1.x, ay = s2.y - s1.y, al = Math.hypot(ax, ay);
    if (al < 25) continue; // axis points (nearly) at the camera
    const cos = Math.abs(dx * ax + dy * ay) / (len * al);
    if (cos > AXIS_LOCK_COS && (!best || cos > best.cos)) best = { k, cos };
  }
  if (!best) return null;
  // Closest point on the axis line through p1 to the cursor ray.
  const d = new THREE.Vector3().setComponent(best.k, 1);
  const ray = vp.ray(e.clientX, e.clientY);
  const w = p1.clone().sub(ray.origin);
  const b = d.dot(ray.direction), denom = 1 - b * b;
  if (denom < 1e-9) return null;
  let t = (b * w.dot(ray.direction) - w.dot(d)) / denom;
  if (step > 0) t = Math.round(t / step) * step;
  if (Math.abs(t) < 1e-9) return null;
  return { point: p1.clone().setComponent(best.k, p1.getComponent(best.k) + t), k: best.k };
}

/** What the Guide line tool has and waits for (its panel): the start, else a reference and how far from it. */
export interface GuideState {
  /** "start": waiting for an edge / axis / first point; "second": for the second point; "offset": sliding off `from`. */
  step: "start" | "second" | "offset";
  /** What it starts from: "edge", "X axis", "point (1, 2, 0)"... (null at "start"). */
  from: string | null;
  dist: number;
  count: number;
}

export class GuideTool implements Tool {
  readonly name = "Guide line";
  private sides: EdgeSides | null = null;
  private hoverSides: EdgeSides | null = null;
  private ref: RefEdge | null = null;
  /** 2-point guide: the first clicked point and the current second point. */
  private p1: THREE.Vector3 | null = null;
  private p2: THREE.Vector3 | null = null;
  /** World axis (0 = X, 1 = Y, 2 = Z) the 2-point guide is locked onto, or -1. */
  private axis = -1;
  /** World axis under the cursor (highlighted: click it for a guide parallel to it), or -1. */
  private hoverAxis = -1;
  /** Guide from an axis: the solid under the cursor and its extent along the slide axis (for "· 50% across Box 1"). */
  private across: { name: string; lo: number; hi: number } | null = null;
  /** The reference is a world axis (not an edge): no face, so the guide may go either side. */
  private onAxis = false;
  /** Axis reference: where along the axis it was clicked (the offset line is drawn there), the last pointer event. */
  private axisAt = 0;
  private lastEvent: PointerEvent | null = null;
  private dist = 0;
  private count = 1;
  private typed = "";

  constructor(
    private host: ToolHost,
    /** Adjacent flat faces of an edge (null if the edge is not straight / has no flat face). */
    private sidesOf: (bodyId: number, edgeId: number) => EdgeSides | null,
    private onDone: (lines: { a: V3; b: V3 }[]) => void,
    /** Its state changed (null: the tool is closing) — for a panel. */
    private onState: (s: GuideState | null) => void = () => {},
  ) {}

  private emitState(): void {
    const at = (p: THREE.Vector3) => `point (${p.toArray().map((n) => fmt(n)).join(", ")})`;
    const step = this.p1 ? "second" : this.ref ? "offset" : "start";
    const from = this.p1 ? at(this.p1) : this.ref ? (this.onAxis ? `${"XYZ"[this.axisOf(this.ref).k]} axis` : "edge") : null;
    this.onState({ step, from, dist: this.dist, count: this.count });
  }

  start(bodyId?: number, edgeId?: number): this {
    if (bodyId !== undefined && edgeId !== undefined) {
      const s = this.sidesOf(bodyId, edgeId);
      if (s) this.choose(s);
    }
    this.draw();
    this.updateHint();
    return this;
  }

  private choose(s: EdgeSides, dist = 0): void {
    this.sides = s;
    this.ref = s.faces[0].ref;
    this.dist = dist;
  }

  /** Test hook: choose the reference edge and distance directly. */
  pick(bodyId: number, edgeId: number, dist = 0): void {
    const s = this.sidesOf(bodyId, edgeId);
    if (s) this.choose(s, dist);
    this.draw();
    this.updateHint();
  }

  private distances(): number[] {
    return Array.from({ length: this.count }, (_, i) => this.dist * (i + 1));
  }

  private v = (t: V3) => new THREE.Vector3(...t);

  private draw(): void {
    const line = (a: THREE.Vector3, b: THREE.Vector3, color: number) =>
      new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
    const objs: THREE.Object3D[] = [];
    if (this.p1) {
      if (this.p2) objs.push(line(this.p1, this.p2, this.axis >= 0 ? AXIS_COLORS[this.axis] : 0xff6fb5));
    } else if (!this.ref) {
      // The edge / axis under the cursor glows (thick, with a halo): clicking picks it as the reference.
      const r = this.hoverSides?.faces[0].ref;
      if (r) objs.push(this.host.viewport.glowLine(this.v(r.a), this.v(r.b), 0xffd166));
      else if (this.hoverAxis >= 0) {
        const r2 = this.axisRef(this.hoverAxis);
        objs.push(this.host.viewport.glowLine(this.v(r2.a), this.v(r2.b), AXIS_COLORS[this.hoverAxis], 3, 0.5));
      }
    } else {
      const r = this.ref;
      const ax = this.onAxis ? this.axisOf(r) : null;
      objs.push(line(this.v(r.a), this.v(r.b), ax ? AXIS_COLORS[ax.k] : 0xffd166));
      for (const d of this.distances()) {
        const off = this.v(r.inward).multiplyScalar(d);
        objs.push(line(this.v(r.a).add(off), this.v(r.b).add(off), 0xff6fb5));
      }
      if (ax && this.dist > 1e-9) {
        // Offset line from the axis to the guide, in the colour of the direction it moves (X red, Y green, Z blue).
        const p0 = new THREE.Vector3().setComponent(ax.k, this.axisAt);
        objs.push(line(p0, p0.clone().addScaledVector(this.v(r.inward), this.dist * this.count), AXIS_COLORS[ax.slide]));
      }
    }
    this.host.viewport.setOverlay(objs);
  }

  private updateHint(): void {
    const t = this.p1
      ? "Guide line: click the second point (corners / midpoints / centres snap, Ctrl: any snap — edges, guides, axes; near an X / Y / Z direction it locks on — red / green / blue) · Esc cancel"
      : this.ref && this.onAxis
        ? this.axisHint()
        : this.ref
        ? `Guide line: move across the face under the cursor (${this.host.viewport.snapTip("points / grid")}) · type a distance or Tab for distance / % / count · Enter / click add · Esc cancel`
        : "Guide line: click a reference edge or an X / Y / Z axis (parallel guide), or click a point — corner / midpoint / centre, Ctrl: any snap — to draw a guide through two points (in Top / Front / Right view: anywhere)";
    this.host.hint(this.typed ? `${t}   ⌨ ${this.typed}_` : t);
    this.emitState();
  }

  private axisHint(): string {
    const { k, slide } = this.axisOf(this.ref!);
    const name = (i: number) => `${"XYZ"[i]} (${["red", "green", "blue"][i]})`;
    const other = k === 2 ? ` — press ${"XY"[1 - slide]} to move along ${"XY"[1 - slide]} instead` : "";
    return `Guide parallel to the ${"XYZ"[k]} axis, moving along ${name(slide)}${other} · either side (${this.host.viewport.snapTip("points / grid")}) · type a distance or Tab for distance / count · Enter / click add · Esc cancel`;
  }

  /**
   * Point snap for 2-point guides: corners / midpoints / centres always, any snap (edges, guides, axes)
   * only with Ctrl, whatever Auto snap says — a plain click on an edge / axis picks it as the reference.
   */
  private pointSnap(e: PointerEvent): { point: THREE.Vector3; kind: SnapKind } | null {
    const sp = this.host.viewport.snapPoint(e.clientX, e.clientY);
    return sp && (e.ctrlKey || sp.kind === "vertex" || sp.kind === "midpoint" || sp.kind === "center") ? sp : null;
  }

  /** World axis the camera looks straight along (Top / Front / Right and their other sides), or -1 in a slanted view. */
  private mainViewAxis(): number {
    const d = this.host.viewport.camera.getWorldDirection(new THREE.Vector3());
    return [d.x, d.y, d.z].findIndex((c) => Math.abs(c) > 0.9998);
  }

  /**
   * Main view (see mainViewAxis), nothing to snap to: the face under the cursor, else the plane
   * across the view through `through` (the first point; else the origin: Top Z = 0, Front Y = 0...),
   * on the grid step. Null in a slanted view.
   */
  private viewPoint(e: PointerEvent, through?: THREE.Vector3): THREE.Vector3 | null {
    const k = this.mainViewAxis();
    if (k < 0) return null;
    const vp = this.host.viewport;
    const hit = vp.faceUnder(e.clientX, e.clientY);
    if (hit) return hit.point.clone();
    const n = new THREE.Vector3().setComponent(k, 1);
    const p = vp.ray(e.clientX, e.clientY).intersectPlane(new THREE.Plane(n, -(through?.getComponent(k) ?? 0)), new THREE.Vector3());
    if (!p) return null;
    const step = this.host.snapStep(e);
    for (let i = 0; i < 3; i++) if (i !== k) p.setComponent(i, snapValue(p.getComponent(i), step));
    return p;
  }

  /** Second point: a snap, else locked onto a world axis, else the face under the cursor, else the view plane through the first point. */
  private secondPoint(e: PointerEvent): THREE.Vector3 | null {
    const vp = this.host.viewport;
    const sp = this.pointSnap(e);
    vp.showSnapMarker(sp);
    this.axis = -1;
    if (sp) return sp.point;
    const locked = this.axisLock(e);
    if (locked) return locked;
    const onView = this.viewPoint(e, this.p1!);
    if (onView) return onView;
    const hit = vp.faceUnder(e.clientX, e.clientY);
    if (hit) return hit.point.clone();
    const n = vp.camera.getWorldDirection(new THREE.Vector3());
    return vp.ray(e.clientX, e.clientY).intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, this.p1!), new THREE.Vector3());
  }

  /** Axis lock (see axisLockPoint): the guide is exactly horizontal / vertical (e.g. across a sphere in front view). */
  private axisLock(e: PointerEvent): THREE.Vector3 | null {
    const lock = axisLockPoint(this.host.viewport, this.p1!, e, this.host.snapStep(e));
    if (!lock) return null;
    this.axis = lock.k;
    return lock.point;
  }

  /**
   * A world axis as a reference "edge": a long segment along it through the origin. X and Y
   * guides slide on the ground (X along Y, Y along X — always at z = 0; G moves a guide anywhere
   * else); a Z guide slides along X or Y, whichever faces the camera more. Either side, any distance.
   */
  private axisRef(k: number, slideAxis?: number): RefEdge {
    const vp = this.host.viewport;
    let slide = slideAxis ?? (k === 0 ? 1 : 0);
    if (k === 2 && slideAxis === undefined) {
      const view = vp.camera.getWorldDirection(new THREE.Vector3());
      slide = Math.abs(view.y) >= Math.abs(view.x) ? 0 : 1; // looking along Y: slide along X
    }
    const half = Math.max(500, vp.worldPerPixel(new THREE.Vector3()) * 1500);
    const a: V3 = [0, 0, 0], b: V3 = [0, 0, 0], inward: V3 = [0, 0, 0];
    a[k] = -half;
    b[k] = half;
    inward[slide] = 1;
    return { id: -1, a, b, inward, width: Infinity };
  }

  /** Axis reference: the axis it runs along and the axis it slides along (0 = X, 1 = Y, 2 = Z). */
  private axisOf(r: RefEdge): { k: number; slide: number } {
    return { k: r.a.findIndex((x, i) => x !== r.b[i]), slide: r.inward.findIndex((x) => x !== 0) };
  }

  /** Where along world axis k the cursor ray passes closest (the point clicked on the axis). */
  private alongAxis(e: PointerEvent, k: number): number {
    const ray = this.host.viewport.ray(e.clientX, e.clientY);
    const d = new THREE.Vector3().setComponent(k, 1);
    const b = ray.direction.dot(d), w = ray.origin;
    const den = 1 - b * b;
    return den < 1e-9 ? 0 : (b * w.dot(ray.direction) - w.dot(d)) / den;
  }

  private edgeUnder(e: PointerEvent): EdgeSides | null {
    const p = this.host.viewport.pick(e.clientX, e.clientY, "edge");
    return p && p.kind === "edge" ? this.sidesOf(p.body, p.id) : null;
  }

  private showHud(): void {
    const r = this.ref!;
    if (this.onAxis) {
      // Which way the guide moved from the axis, signed: "X = 25 mm", "Y = -10 mm" — and over a solid,
      // how far across it the guide is ("· 50% across Box 1").
      const { k, slide } = this.axisOf(r);
      const signed = this.dist * r.inward[slide];
      const at = new THREE.Vector3().setComponent(k, this.axisAt).addScaledVector(this.v(r.inward), this.dist);
      const across = this.across ? ` · ${fmt(((signed - this.across.lo) / (this.across.hi - this.across.lo)) * 100)}% across ${this.across.name}` : "";
      this.host.hud(`${"XYZ"[slide]} = ${fmt(signed)} mm${across}${this.count > 1 ? ` ×${this.count}` : ""}`, at);
      this.emitState();
      return;
    }
    const at = this.v(r.b).add(this.v(r.inward).multiplyScalar(this.dist));
    const pct = r.width > 0 && Number.isFinite(r.width) ? ` · ${fmt((this.dist / r.width) * 100)}%` : "";
    this.host.hud(`${fmt(this.dist)} mm${pct}${this.count > 1 ? ` ×${this.count}` : ""}`, at);
    this.emitState();
  }

  move(e: PointerEvent): void {
    if (this.p1) {
      this.p2 = this.secondPoint(e);
      this.draw();
      if (this.p2) this.host.hud(`${fmt(this.p1.distanceTo(this.p2))} mm${this.axis >= 0 ? ` · on ${"XYZ"[this.axis]} axis` : ""}`, this.p2);
      return;
    }
    if (!this.ref) {
      // A point snap under the cursor means "start a 2-point guide here"; otherwise hover edges.
      const sp = this.pointSnap(e);
      this.host.viewport.showSnapMarker(sp);
      const h = sp ? null : this.edgeUnder(e);
      // No point or edge here: a world axis line under the cursor (a reference too).
      const ax = sp || h ? -1 : this.host.viewport.axisUnder(e.clientX, e.clientY);
      // Main view, nothing else here: a click starts a 2-point guide at this point.
      const vpt = sp || h || ax >= 0 ? null : this.viewPoint(e);
      if (vpt) this.host.viewport.showSnapMarker({ point: vpt, kind: "axis" });
      if (h?.faces[0].ref.id !== this.hoverSides?.faces[0].ref.id || ax !== this.hoverAxis) {
        this.hoverSides = h;
        this.hoverAxis = ax;
        this.draw();
      }
      return;
    }
    if (this.typed) return;
    if (this.onAxis) {
      this.lastEvent = e;
      // Either side of the axis: the slide direction follows the cursor.
      const r = this.ref;
      const k = r.a.findIndex((x, i) => x !== r.b[i]);
      const slide = r.inward.findIndex((x) => x !== 0);
      const nk = [0, 1, 2].find((j) => j !== k && j !== slide)!;
      const plane = new THREE.Plane(new THREE.Vector3().setComponent(nk, 1), 0);
      const vp = this.host.viewport;
      const sp = vp.snapping(e) ? vp.snapPoint(e.clientX, e.clientY) : null;
      vp.showSnapMarker(sp);
      // Over a solid: through the point under the cursor (not where the ray meets the axis plane, far
      // behind it in a slanted view); and how far across that solid the guide is.
      const hit = vp.faceUnder(e.clientX, e.clientY);
      let d: number;
      if (sp) d = sp.point.getComponent(slide);
      else {
        const p = hit ? hit.point : vp.ray(e.clientX, e.clientY).intersectPlane(plane, new THREE.Vector3());
        if (!p) return;
        d = snapValue(p.getComponent(slide), this.host.snapStep(e));
      }
      const inward: V3 = [0, 0, 0];
      inward[slide] = d < 0 ? -1 : 1;
      this.across = null;
      if (hit && hit.body.kind !== "mesh") {
        const [lo, hi] = hit.body.shape.boundingBox.bounds;
        if (hi[slide] - lo[slide] > 1e-6) this.across = { name: hit.body.name, lo: lo[slide], hi: hi[slide] };
      }
      this.ref = { ...r, inward };
      this.dist = Math.abs(d);
      this.draw();
      this.showHud();
      return;
    }
    // The adjacent face under the cursor decides which way the copy slides.
    const hit = this.host.viewport.faceUnder(e.clientX, e.clientY);
    const side = hit && hit.body.id === this.sides!.bodyId ? this.sides!.faces.find((f) => f.faceId === hit.faceId) : undefined;
    if (side) this.ref = side.ref;
    const r = this.ref;
    const n = this.v(r.inward).cross(this.v(r.b).sub(this.v(r.a))).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, this.v(r.a));
    // Snapping: to object points (corners, midpoints, centres, other guides / axes), else to the grid step.
    const vp = this.host.viewport;
    const sp = vp.snapping(e) ? vp.snapPoint(e.clientX, e.clientY) : null;
    vp.showSnapMarker(sp);
    let d: number;
    if (sp) {
      d = sp.point.clone().sub(this.v(r.a)).dot(this.v(r.inward));
    } else {
      const p = vp.ray(e.clientX, e.clientY).intersectPlane(plane, new THREE.Vector3());
      if (!p) return;
      d = snapValue(p.sub(this.v(r.a)).dot(this.v(r.inward)), this.host.snapStep(e));
    }
    this.dist = Math.max(0, Math.min(r.width, d));
    this.draw();
    this.showHud();
  }

  down(e: PointerEvent): void {
    if (this.p1) {
      const b = this.secondPoint(e);
      if (!b || b.distanceTo(this.p1) < 1e-6) return this.host.hint("Guide line: click a second point away from the first");
      this.onDone([{ a: this.p1.toArray() as V3, b: b.toArray() as V3 }]);
      return;
    }
    if (!this.ref) {
      const sp = this.pointSnap(e);
      if (sp) {
        this.p1 = sp.point.clone();
        this.hoverSides = null;
        this.draw();
        this.updateHint();
        return;
      }
      const h = this.edgeUnder(e);
      if (!h) {
        const ax = this.host.viewport.axisUnder(e.clientX, e.clientY);
        const vpt = ax < 0 ? this.viewPoint(e) : null;
        if (vpt) {
          this.p1 = vpt;
          this.draw();
          this.updateHint();
          return;
        }
        if (ax < 0) return this.host.hint("Guide line: click a straight edge next to a flat face, or an X / Y / Z axis — or, in Top / Front / Right view, any two points");
        this.ref = this.axisRef(ax);
        this.onAxis = true;
        this.axisAt = this.alongAxis(e, ax);
        this.dist = 0;
        this.hoverAxis = -1;
        this.draw();
        this.updateHint();
        return;
      }
      this.choose(h);
      this.draw();
      this.updateHint();
      return;
    }
    this.move(e);
    this.apply();
  }

  private apply(): void {
    const r = this.ref;
    if (!r) return;
    const ds = this.distances().filter((d) => d > 1e-6);
    if (!ds.length) return this.host.hint("Guide line: move away from the edge or type a distance first");
    const off = (p: V3, d: number): V3 => [p[0] + r.inward[0] * d, p[1] + r.inward[1] * d, p[2] + r.inward[2] * d];
    this.onDone(ds.map((d) => ({ a: off(r.a, d), b: off(r.b, d) })));
  }

  private dialog(): void {
    const r = this.ref!;
    this.host.propsDialog(
      "Guide line",
      [
        { label: "Distance", value: +this.dist.toFixed(3), step: 1 },
        { label: "% of face width (0 = use distance)", value: 0, step: 5 },
        { label: "Count", value: this.count, step: 1, min: 1 },
      ],
      ([d, pct, c]) => {
        this.count = Math.max(1, Math.round(c || 1));
        this.dist = pct > 0 && Number.isFinite(r.width) ? (r.width * pct) / 100 : d;
        this.draw();
        this.apply();
      },
      "Add",
    );
  }

  key(e: KeyboardEvent): boolean {
    if (!this.ref) return false;
    const pick = this.onAxis ? "xy".indexOf(e.key.toLowerCase()) : -1;
    if (pick >= 0 && this.axisOf(this.ref).k === 2) {
      // Guide from the Z axis: X / Y chooses which way it moves.
      this.ref = this.axisRef(2, pick);
      if (this.lastEvent) this.move(this.lastEvent);
      else this.draw();
      this.updateHint();
      return true;
    }
    if (e.key === "Tab") {
      this.dialog();
    } else if (typedUnit(this.typed, e.key) !== null || /^[0-9.]$/.test(e.key)) {
      this.typed = typedUnit(this.typed, e.key) ?? this.typed + e.key;
    } else if (e.key === "Backspace" && this.typed) {
      this.typed = this.typed.slice(0, -1);
    } else if (e.key === "Enter") {
      if (this.typed && Number.isFinite(parseLen(this.typed))) this.dist = parseLen(this.typed);
      this.typed = "";
      this.apply();
      return true;
    } else {
      return false;
    }
    if (this.typed && Number.isFinite(parseLen(this.typed))) {
      this.dist = parseLen(this.typed);
      this.draw();
      this.showHud();
    }
    this.updateHint();
    return true;
  }

  dispose(): void {
    this.host.viewport.setOverlay([]);
    this.host.viewport.showSnapMarker(null);
    this.host.hud(null);
    this.onState(null);
  }
}

// ------------------------------------------------------------------ pencil

/**
 * Divide face: click two points on the edges of a flat face to split it with a line — again for more lines, Enter / Done ends
 * (e.g. the two top midpoints of a box → a ridge edge that Move can lift into a gable).
 * Corners and midpoints snap automatically; anywhere along an edge works too. The end point locks
 * where the X / Y / Z axis line through the start meets the edge under the cursor when the cursor
 * runs (nearly) along that axis on screen: a line parallel to an axis without hunting for it.
 */
export class DivideFaceTool implements Tool {
  readonly name = "Divide face";
  private a: { point: THREE.Vector3; body: number } | null = null;
  private cur: THREE.Vector3 | null = null;
  /** World axis (0 = X, 1 = Y, 2 = Z) the end point is locked onto, or -1. */
  private axis = -1;

  constructor(
    private host: ToolHost,
    /** Split the face under the line; false if it couldn't (the line is dropped, the tool goes on). */
    private onDivide: (bodyId: number, a: V3, b: V3) => boolean,
    /** Why the body can't be divided (e.g. a flat face body, a mesh), or null if it can. */
    private refuse: (bodyId: number) => string | null = () => null,
    private shapeOf: (bodyId: number) => Shape | null = () => null,
    /** The lines drawn so far and whether one is started (null: the tool is gone) — for its panel. */
    private onState: (st: { lines: number; started: boolean } | null) => void = () => {},
    /** Enter: finish. */
    private onDone: () => void = () => {},
  ) {}
  private lines = 0;

  start(): this {
    this.host.hint("Divide face: click a point on an edge of a solid's flat face (corners / midpoints snap) · Enter / Esc done");
    this.onState({ lines: 0, started: false });
    return this;
  }

  /** Point under the cursor: a corner / midpoint, else the nearest point on an edge. */
  private pointAt(e: PointerEvent): { point: THREE.Vector3; body: number; kind: SnapKind; axis?: number } | null {
    const vp = this.host.viewport;
    const edge = vp.pick(e.clientX, e.clientY, "edge");
    if (!edge) return null;
    const sp = vp.snapPoint(e.clientX, e.clientY);
    if (sp && (sp.kind === "vertex" || sp.kind === "midpoint")) return { point: sp.point, body: edge.body, kind: sp.kind };
    const lock = this.a && edge.kind === "edge" ? this.axisOnEdge(e, edge.body, edge.id) : null;
    if (lock) return { point: lock.point, body: edge.body, kind: "axis", axis: lock.k };
    return { point: this.onExactEdge(edge.body, edge.id, edge.point), body: edge.body, kind: "axis" };
  }

  /**
   * The point redone on the exact B-rep edge: the display mesh is float32 (a top at z = 41.4 is hit at
   * 41.4000015), and an axis line through a start that far off misses the other edges — no lock.
   */
  private onExactEdge(body: number, edgeId: number, p: THREE.Vector3): THREE.Vector3 {
    const shape = this.shapeOf(body);
    const q = shape ? nearestOnEdge(shape, edgeId, p.toArray() as V3) : null;
    return q ? new THREE.Vector3(...q) : p.clone();
  }

  /** End point locked on a world axis through the start (see axisLockPoint): where that axis line meets the edge, if it does. */
  private axisOnEdge(e: PointerEvent, body: number, edgeId: number): { point: THREE.Vector3; k: number } | null {
    const from = this.a!.point;
    const lock = axisLockPoint(this.host.viewport, from, e, 0);
    const shape = lock ? this.shapeOf(body) : null;
    const q = shape ? axisCrossEdge(shape, edgeId, from.toArray() as V3, lock!.k) : null;
    return q && new THREE.Vector3(...q).distanceTo(from) > 1e-6 ? { point: new THREE.Vector3(...q), k: lock!.k } : null;
  }

  private draw(): void {
    const objs: THREE.Object3D[] = [];
    if (this.a && this.cur) {
      objs.push(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([this.a.point, this.cur]),
        new THREE.LineBasicMaterial({ color: this.axis >= 0 ? AXIS_COLORS[this.axis] : 0xff6fb5, depthTest: false, transparent: true }),
      ));
    }
    this.host.viewport.setOverlay(objs);
  }

  move(e: PointerEvent): void {
    const p = this.pointAt(e);
    this.axis = p?.axis ?? -1;
    this.host.viewport.showSnapMarker(p && this.axis < 0 ? p : null);
    if (!this.a) return;
    this.cur = p?.point ?? this.host.viewport.faceUnder(e.clientX, e.clientY)?.point ?? null;
    this.draw();
    if (this.cur) this.host.hud(`${this.axis >= 0 ? `On ${"XYZ"[this.axis]} axis\n` : ""}${fmt(this.cur.distanceTo(this.a.point))}`, this.cur);
  }

  down(e: PointerEvent): void {
    const p = this.pointAt(e);
    if (!p) return this.host.hint("Divide face: click on an edge (corners / midpoints snap)");
    if (!this.a) {
      const why = this.refuse(p.body);
      if (why) return this.host.toast(why, "error");
      this.a = { point: p.point, body: p.body };
      this.host.hint("Divide face: click the end point on another edge of the same face — move along X / Y / Z to lock the line parallel to it · Esc drops the start");
      this.onState({ lines: this.lines, started: true });
      return;
    }
    if (p.body !== this.a.body) return this.host.toast("Divide face: the end point must be on the same solid as the start", "error");
    const t = (v: THREE.Vector3): V3 => [v.x, v.y, v.z];
    if (!this.onDivide(p.body, t(this.a.point), t(p.point))) return;
    this.lines++;
    this.restart();
  }

  /** Ready for the next line's start. */
  private restart(): void {
    this.a = null;
    this.cur = null;
    this.axis = -1;
    this.draw();
    this.host.hud(null);
    this.host.hint("Divide face: click a point on an edge for the next line · Enter / Esc done");
    this.onState({ lines: this.lines, started: false });
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === "Escape" && this.a) {
      this.restart();
      return true;
    }
    if (e.key === "Enter" || e.key === "Escape") {
      this.onDone();
      return true;
    }
    return false;
  }

  dispose(): void {
    this.host.viewport.setOverlay([]);
    this.host.viewport.showSnapMarker(null);
    this.host.hud(null);
    this.onState(null);
  }
}
