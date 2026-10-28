/**
 * Measure tool (=). Hover: the HUD shows what is under the cursor — a point (corner, midpoint,
 * centre) with its coordinates, an edge with its length (radius / angle for circles and arcs), or a
 * face with its area and the sizes of its kind (rectangle sides, cylinder radius / height...).
 * Click 2 points for a length (ΔX ΔY ΔZ, slope), a 3rd for the angle at the 2nd; the numbers go in a
 * panel in the corner. Tab adds a dimension: the angle if 3 points are clicked, the length between
 * the first two if 2, else for the straight edge (length) or circle / arc (radius) under the cursor — that one stays
 * linked to it. Move to set how far it stands off (a radius: where round the circle it points; an
 * angle: the size of its arc),
 * click (or Tab / Enter) to place it, Esc cancels.
 * Object snapping is always on here; off a snap point or edge, the 2nd / 3rd point locks onto the X / Y / Z
 * line through the previous one when the cursor runs (nearly) along it. The model itself is never changed.
 */
import * as THREE from "three";
import { axisCrossEdge, circleOf, edgeInfo, faceInfo, nearestOnEdge, type EdgeInfo, type FaceInfo, type Shape, type V3 } from "./kernel";
import type { Dimension } from "./document";
import { axisLockPoint, type Tool, type ToolHost } from "./tools";
import type { SelItem, SnapKind } from "./viewport";
import { deg, num } from "./format";


const POINT_NAMES: Partial<Record<SnapKind, string>> = { vertex: "Corner", midpoint: "Midpoint", center: "Centre" };

export function pointText(kind: SnapKind, p: THREE.Vector3): string {
  const name = p.lengthSq() < 1e-12 ? "Origin" : POINT_NAMES[kind] ?? "Point";
  return `${name}\nX ${num(p.x)}  Y ${num(p.y)}  Z ${num(p.z)}`;
}

export function edgeText(e: EdgeInfo): string {
  switch (e.type) {
    case "line": return `Edge\nLength ${num(e.length)} mm`;
    case "circle": return `Circle\nR ${num(e.radius!)}  ·  Ø ${num(2 * e.radius!)}\nLength ${num(e.length)} mm`;
    case "arc": return `Arc  ${deg(e.angle!)}\nR ${num(e.radius!)}  ·  Ø ${num(2 * e.radius!)}\nLength ${num(e.length)} mm`;
    default: return `Curve\nLength ${num(e.length)} mm`;
  }
}

export function faceText(f: FaceInfo): string {
  const area = `Area ${num(f.area)} mm²`;
  const part = f.angle === undefined ? "" : `  ${deg(f.angle)}`;
  switch (f.type) {
    case "flat": return f.rect ? `Flat face\n${num(f.rect[0])} × ${num(f.rect[1])} mm\n${area}` : `Flat face\n${area}`;
    case "cylinder": return `Cylinder${part}\nR ${num(f.radius!)}  ·  Ø ${num(2 * f.radius!)}  ·  Height ${num(f.height!)}\n${area}`;
    case "cone": return `Cone${part}\nHalf-angle ${deg(f.halfAngle!)}\n${area}`;
    case "sphere": return `Sphere\nR ${num(f.radius!)}  ·  Ø ${num(2 * f.radius!)}\n${area}`;
    case "torus": return `Torus\nR ${num(f.radius!)}  ·  tube r ${num(f.minorRadius!)}\n${area}`;
    default: return `Curved face\n${area}`;
  }
}

const AXIS_COLORS = [0xe05555, 0x4fbf6a, 0x4f8fe0];

/** Angle between two directions, in degrees. */
const angleBetween = (u: THREE.Vector3, v: THREE.Vector3) => THREE.MathUtils.radToDeg(u.angleTo(v));

export class MeasureTool implements Tool {
  readonly name = "Measure";
  /** Clicked points: A (start), B (end of the length; corner of the angle), C (end of the angle). */
  private pts: THREE.Vector3[] = [];
  /** The point under the cursor (snapped), if any. */
  private cursor: THREE.Vector3 | null = null;
  /** Last hover, so the HUD text is only worked out again when it changes. */
  private hoverKey = "";
  private text: string | null = null;
  private panel: HTMLElement;
  /** The straight edge under the cursor (for Tab → dimension). */
  private hoverEdge: { a: V3; b: V3; body: number } | null = null;
  /** The circle / arc under the cursor (for Tab → radius dimension). */
  private hoverCircle: { shape: Shape; edgeId: number; body: number; center: V3; normal: V3; radius: number } | null = null;
  /** The circle / arc of the radius dimension being placed. */
  private placingCircle: MeasureTool["hoverCircle"] = null;
  /** A dimension being placed (after Tab): its ends and the current offset. */
  private placing: Dimension | null = null;
  /** The dimension being placed is between the clicked points (they are cleared once it is placed). */
  private placingPts = false;
  private last: PointerEvent | null = null;
  /** World axis (0 = X, 1 = Y, 2 = Z) the point under the cursor is locked onto, or -1. */
  private axis = -1;

  constructor(
    private host: ToolHost,
    /** The B-rep of a body (null for meshes / missing). */
    private shapeOf: (bodyId: number) => Shape | null,
    /** Highlight the hovered edge / face (null clears). */
    private highlight: (item: SelItem | null) => void,
    /** Leave the tool (Cancel / Esc before a result). */
    private exit: () => void,
    /** Show the dimension being placed (null hides it) / add it to the model. */
    private dims: { preview: (d: Dimension | null) => void; add: (d: Dimension) => void; count: () => number; clear: () => void },
  ) {
    this.panel = document.createElement("div");
    this.panel.id = "measure-panel";
    this.panel.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("button")?.dataset.act;
      if (act === "cancel") this.exit();
      else if (act === "clear-dims") {
        this.dims.clear();
        this.update();
      }
    });
    host.viewport.canvas.parentElement!.appendChild(this.panel);
  }

  start(): this {
    this.update();
    return this;
  }

  move(e: PointerEvent): void {
    this.last = e;
    if (this.placing) return this.placeAt(e);
    const vp = this.host.viewport;
    // Points first (corner > centre > midpoint), always snapping.
    const sp = vp.snapPoint(e.clientX, e.clientY);
    this.cursor = sp ? sp.point.clone() : vp.pick(e.clientX, e.clientY, "face")?.point.clone() ?? null;
    const from = this.pts.length === 1 || this.pts.length === 2 ? this.pts[this.pts.length - 1] : null;
    // Points win over the lock; on an edge / curve it takes the point where the axis line meets the
    // edge (e.g. straight above, on a cylinder's top circle), else the edge point.
    let lock = from && (!sp || sp.kind === "axis" || sp.kind === "edge") ? axisLockPoint(vp, from, e, this.host.snapStep(e)) : null;
    if (lock && sp?.kind === "edge") lock = this.onEdge(e, from!, lock.k);
    this.axis = lock ? lock.k : -1;
    if (lock) {
      this.cursor = lock.point;
      this.noteEdge(null, null);
      vp.showSnapMarker(null);
      const len = lock.point.distanceTo(from!);
      this.show(`axis:${lock.point.toArray().join()}`, null, () => `On ${"XYZ"[lock.k]} axis\n${num(len)} mm`, lock.point);
    } else if (sp && POINT_NAMES[sp.kind]) {
      this.noteEdge(null, null);
      vp.showSnapMarker(sp);
      this.show(`p:${sp.point.toArray().join()}:${sp.kind}`, null, () => pointText(sp.kind, sp.point), sp.point);
    } else {
      vp.showSnapMarker(sp && sp.kind === "edge" ? sp : null);
      this.hover(e);
    }
    if (this.pts.length === 1 || this.pts.length === 2) this.update();
  }

  /** Lock onto axis k through `from` where that line meets the edge under the cursor, if it does. */
  private onEdge(e: PointerEvent, from: THREE.Vector3, k: number): { point: THREE.Vector3; k: number } | null {
    const hit = this.host.viewport.pick(e.clientX, e.clientY, "edge");
    const shape = hit && hit.kind === "edge" ? this.shapeOf(hit.body) : null;
    const q = shape ? axisCrossEdge(shape, hit!.id, from.toArray() as V3, k) : null;
    return q && new THREE.Vector3(...q).distanceTo(from) > 1e-9 ? { point: new THREE.Vector3(...q), k } : null;
  }

  /** Edge or face under the cursor: highlight it and put its sizes in the HUD. */
  private hover(e: PointerEvent): void {
    const vp = this.host.viewport;
    for (const mode of ["edge", "face"] as const) {
      const hit = vp.pick(e.clientX, e.clientY, mode);
      if (!hit || hit.kind !== mode) continue;
      const shape = this.shapeOf(hit.body);
      if (!shape) continue;
      const item: SelItem = { kind: mode, body: hit.body, id: hit.id };
      this.noteEdge(mode === "edge" ? shape : null, mode === "edge" ? hit.id : null, hit.body);
      const text = () => {
        const info = mode === "edge" ? edgeInfo(shape, hit.id) : faceInfo(shape, hit.id);
        return info ? (mode === "edge" ? edgeText(info as EdgeInfo) : faceText(info as FaceInfo)) : null;
      };
      this.show(`${mode}:${hit.body}:${hit.id}`, item, text, hit.point);
      return;
    }
    this.noteEdge(null, null);
    this.show("", null, () => null, null);
  }

  /** Remember the straight edge / circle under the cursor, for Tab. */
  private noteEdge(shape: Shape | null, edgeId: number | null, body = -1): void {
    const e = shape && edgeId !== null ? shape.edges.find((x) => x.hashCode === edgeId) : undefined;
    this.hoverEdge = e && e.geomType === "LINE" ? { a: e.startPoint.toTuple() as V3, b: e.endPoint.toTuple() as V3, body } : null;
    if (this.hoverCircle?.shape === shape && this.hoverCircle?.edgeId === edgeId) return;
    let c: ReturnType<typeof circleOf> = null;
    try {
      c = e && e.geomType !== "LINE" ? circleOf(shape!, edgeId!) : null; // (a curve that is a circle too: see circleOf)
    } catch {
      c = null;
    }
    this.hoverCircle = c ? { shape: shape!, edgeId: edgeId!, body, ...c } : null;
  }

  /** Tab: start placing a dimension between the first two clicked points, or for the straight edge / circle under the cursor. */
  private startDimension(): void {
    this.placingPts = this.pts.length >= 2;
    this.placingCircle = null;
    const [a, b, c] = this.pts;
    if (c && a.clone().sub(b).cross(c.clone().sub(b)).lengthSq() > 1e-12) {
      const r = Math.min(a.distanceTo(b), c.distanceTo(b)) * 0.3;
      this.placing = { kind: "angle", a: a.toArray() as V3, b: b.toArray() as V3, c: c.toArray() as V3, o: [0, 0, 0], r };
    } else if (this.placingPts) {
      this.placing = { a: this.pts[0].toArray() as V3, b: this.pts[1].toArray() as V3, o: [0, 0, 0] };
    } else if (this.hoverEdge) {
      this.placing = { ...this.hoverEdge, o: [0, 0, 0] };
    } else if (this.hoverCircle) {
      const c = (this.placingCircle = this.hoverCircle);
      // Until the mouse moves: the circle's start point.
      const rim = (c.shape.edges.find((x) => x.hashCode === c.edgeId)?.startPoint.toTuple() ?? c.center) as V3;
      this.placing = { kind: "radius", a: c.center, b: rim, o: [0, 0, 0], n: c.normal, body: c.body };
    } else {
      this.host.hint("Dimension: click two points, or hover a straight edge, circle or arc, then press Tab");
      return;
    }
    this.host.hud(null);
    this.highlight(null);
    this.host.viewport.showSnapMarker(null);
    this.host.viewport.setOverlay([]);
    if (this.last) this.placeAt(this.last);
    else this.dims.preview(this.placing);
    const how = this.placingCircle ? "Radius: move the mouse round the circle to choose where it points"
      : this.placing.kind === "angle" ? "Angle: move the mouse to set the size of the arc"
      : "Dimension: move the mouse to set how far it stands off the edge";
    this.host.hint(`${how} · click / Tab / Enter: place · Esc: cancel`);
  }

  /**
   * Offset of the dimension being placed: where the cursor ray meets the plane through the edge that
   * faces the camera most, measured square to the edge.
   */
  private placeAt(e: PointerEvent): void {
    const d = this.placing!;
    const vp = this.host.viewport;
    if (d.kind === "angle") {
      // Angle: the arc passes where the cursor ray meets the plane of the three points.
      const a = new THREE.Vector3(...d.a), b = new THREE.Vector3(...d.b), c = new THREE.Vector3(...d.c!);
      const n = a.clone().sub(b).cross(c.clone().sub(b)).normalize();
      const q = vp.ray(e.clientX, e.clientY).intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, b), new THREE.Vector3());
      if (!q || q.distanceTo(b) < 1e-9) return;
      this.placing = { ...d, r: q.distanceTo(b) };
      this.dims.preview(this.placing);
      return;
    }
    const circle = this.placingCircle;
    if (circle) {
      // Radius: the point of the circle / arc nearest where the cursor ray meets its plane.
      const c = new THREE.Vector3(...circle.center);
      const q = vp.ray(e.clientX, e.clientY).intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...circle.normal), c), new THREE.Vector3());
      if (!q || q.distanceTo(c) < 1e-9) return;
      const p = q.sub(c).setLength(circle.radius).add(c).toArray() as V3;
      let rim: V3 | null = null;
      try {
        rim = nearestOnEdge(circle.shape, circle.edgeId, p);
      } catch {
        rim = null;
      }
      this.placing = { ...d, b: rim ?? p };
      this.dims.preview(this.placing);
      return;
    }
    const a = new THREE.Vector3(...d.a), u = new THREE.Vector3(...d.b).sub(a).normalize();
    const view = vp.camera.getWorldDirection(new THREE.Vector3());
    const n = view.clone().addScaledVector(u, -view.dot(u));
    if (n.lengthSq() < 1e-12) return; // looking straight along the edge
    const q = vp.ray(e.clientX, e.clientY).intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n.normalize(), a), new THREE.Vector3());
    if (!q) return;
    const o = q.sub(a);
    o.addScaledVector(u, -o.dot(u));
    this.placing = { ...d, o: o.toArray() as V3 };
    this.dims.preview(this.placing);
  }

  private placeDimension(): void {
    const d = this.placing!;
    this.placing = null;
    this.dims.preview(null);
    this.dims.add(d);
    if (this.placingPts) this.pts = [];
    this.placingCircle = null;
    this.update();
  }

  /** Show `text()` at `at` (worked out once per hovered thing; the HUD follows the cursor point). */
  private show(key: string, item: SelItem | null, text: () => string | null, at: THREE.Vector3 | null): void {
    if (key !== this.hoverKey) {
      this.hoverKey = key;
      this.highlight(item);
      try {
        this.text = text();
      } catch {
        this.text = null;
      }
    }
    this.host.hud(this.text, at ?? undefined);
  }

  down(e: PointerEvent): void {
    if (e.button !== 0) return;
    if (this.placing) return this.placeDimension();
    if (!this.cursor) return this.host.hint("Measure: click on a point, edge or face");
    if (this.pts.length >= 3) this.pts = [];
    // A second click on the same point would measure nothing.
    if (this.pts.length && this.cursor.distanceTo(this.pts[this.pts.length - 1]) < 1e-9) return;
    this.pts.push(this.cursor.clone());
    this.update();
  }

  key(e: KeyboardEvent): boolean {
    if (this.placing) {
      if (e.key === "Tab" || e.key === "Enter") this.placeDimension();
      else if (e.key === "Escape") {
        this.placing = null;
        this.placingCircle = null;
        this.dims.preview(null);
        this.update();
      } else return false;
      return true;
    }
    if (e.key === "Tab") {
      this.startDimension();
      return true;
    }
    // With a result on screen (a length or an angle), Esc clears it and stays in Measure;
    // before that (nothing or just the first point), Esc leaves the tool.
    if (e.key === "Escape" && this.pts.length >= 2) {
      this.pts = [];
      this.update();
      return true;
    }
    return false;
  }

  /** The model changed (e.g. undo): redraw the panel (the Delete all button follows the dimensions). */
  refresh(): void {
    if (!this.placing) this.update();
  }

  /** The live end point: the cursor while choosing the next point. */
  private get live(): THREE.Vector3[] {
    return this.pts.length < 3 && this.cursor ? [...this.pts, this.cursor] : this.pts;
  }

  /** Redraw the lines / arc in the view and the numbers in the corner panel. */
  private update(): void {
    const n = this.pts.length;
    const p = this.live;
    const objs: THREE.Object3D[] = [];
    const vp = this.host.viewport;
    const line = (a: THREE.Vector3, b: THREE.Vector3, color: number, dashed = false) => {
      const mat = dashed
        ? new THREE.LineDashedMaterial({ color, dashSize: vp.worldPerPixel(a) * 6, gapSize: vp.worldPerPixel(a) * 4, depthTest: false, transparent: true })
        : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), mat);
      if (dashed) l.computeLineDistances();
      objs.push(l);
    };
    const dot = (q: THREE.Vector3) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), vp.mats.cursor);
      m.position.copy(q);
      m.scale.setScalar(vp.worldPerPixel(q) * 4);
      objs.push(m);
    };
    for (const q of n ? p : []) dot(q);
    let rows = "";
    if (p.length >= 2) {
      const [a, b] = p, d = b.clone().sub(a);
      line(a, b, n === 1 && this.axis >= 0 ? AXIS_COLORS[this.axis] : 0xffd166);
      // Legs along X, Y, Z (red, green, blue) from A to B.
      let c = a.clone();
      for (let k = 0; k < 3; k++) {
        if (Math.abs(d.getComponent(k)) < 1e-9) continue;
        const next = c.clone().setComponent(k, b.getComponent(k));
        line(c, next, AXIS_COLORS[k], true);
        c = next;
      }
      const slope = THREE.MathUtils.radToDeg(Math.atan2(Math.abs(d.z), Math.hypot(d.x, d.y)));
      rows += `<div class="big">Length ${num(d.length())} mm</div>
        <div class="axes"><span class="x">ΔX ${num(d.x)}</span><span class="y">ΔY ${num(d.y)}</span><span class="z">ΔZ ${num(d.z)}</span></div>
        <div>Slope ${deg(slope)} from level</div>`;
    }
    // (The cursor still on the second point: no angle yet.)
    if (p.length === 3 && p[2].distanceTo(p[1]) > 1e-9) {
      const [a, b, c] = p, u = a.clone().sub(b), v = c.clone().sub(b);
      line(b, c, n === 2 && this.axis >= 0 ? AXIS_COLORS[this.axis] : 0xffd166);
      const ang = angleBetween(u, v);
      // Arc between the two arms at B.
      const r = Math.min(u.length(), v.length()) * 0.3, th = THREE.MathUtils.degToRad(ang);
      if (ang > 0.5 && ang < 179.5) {
        const un = u.clone().normalize(), vn = v.clone().normalize(), arc: THREE.Vector3[] = [];
        for (let i = 0; i <= 32; i++) {
          const t = i / 32;
          arc.push(un.clone().multiplyScalar(Math.sin((1 - t) * th)).add(vn.clone().multiplyScalar(Math.sin(t * th))).divideScalar(Math.sin(th)).multiplyScalar(r).add(b));
        }
        objs.push(new THREE.Line(new THREE.BufferGeometry().setFromPoints(arc), new THREE.LineBasicMaterial({ color: 0xffd166, depthTest: false, transparent: true })));
      }
      rows += `<div class="big">Angle ${deg(ang)}</div><div>Second length ${num(v.length())} mm</div>`;
    }
    vp.setOverlay(objs);
    const tip = [
      "Click a point to start (corners, midpoints and centres snap)",
      `Click a second point for the length (along X / Y / Z it locks on — red / green / blue; ${this.host.viewport.stepTip("grid steps")}) · Esc: exit`,
      "Click a third point for the angle at the second · Esc: new measurement",
      "Click to start a new measurement · Esc: clear",
    ][n];
    this.host.hint(`Measure: ${tip} · hover anything to see its sizes · Tab: dimension (${n >= 3 ? "of this angle" : n === 2 ? "of this length" : "of the edge, or radius of the circle / arc, under the cursor"})`);
    this.panel.innerHTML = `<h4>Measure</h4>${rows || '<div class="muted intro">Hover a point, edge or face for its sizes. Click points to measure a length (2 clicks) or an angle (3 clicks).</div>'}
      <div class="tip">${tip}</div>
      <div class="op-buttons"><button type="button" class="btn" data-act="clear-dims" ${this.dims.count() ? "" : "disabled"} title="Remove every dimension (Ctrl+Z brings them back)">Delete all dimensions</button><button type="button" class="btn" data-act="cancel">Done</button></div>`;
  }

  dispose(): void {
    if (this.placing) this.dims.preview(null);
    const vp = this.host.viewport;
    vp.showSnapMarker(null);
    vp.setOverlay([]);
    this.host.hud(null);
    this.highlight(null);
    this.panel.remove();
  }
}
