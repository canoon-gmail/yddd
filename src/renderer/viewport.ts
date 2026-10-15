/**
 * 3D viewport: renders bodies (tessellated B-rep), handles picking of
 * bodies / faces / edges, selection highlighting, tool overlays, operation
 * previews ("ghosts") and the move/rotate gizmo.
 *
 * Coordinate system is CAD-style Z-up, units are millimetres.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type { Body } from "./document";
import { tessellate, kindOf, type Shape, type V3 } from "./kernel";

export type SelMode = "body" | "face" | "edge";

/** A selectable element. `id` is the face/edge hash (0 for whole bodies). */
export interface SelItem {
  kind: SelMode;
  body: number;
  id: number;
}

export interface Pick extends SelItem {
  point: THREE.Vector3;
}

export const sameItem = (a: SelItem | null, b: SelItem | null): boolean =>
  !!a && !!b && a.kind === b.kind && a.body === b.body && a.id === b.id;

export type TransformResult =
  | { type: "translate"; vector: V3 }
  | { type: "rotate"; angleDeg: number; axis: V3; center: V3 };

const EDGE_PICK_PX = 8;

interface BodyView {
  body: Body;
  group: THREE.Group;
  mesh: THREE.Mesh;
  edges: LineSegments2 | null;
  faceIds: number[];
  faceStarts: number[];
  faceIndex: Map<number, number>;
  edgeIds: number[];
  edgeStarts: number[];
  edgeCounts: number[];
  edgeIndex: Map<number, number>;
  edgePos: Float32Array;
  proj: Float32Array | null;
  projStamp: number;
}

export class Viewport {
  readonly canvas: HTMLCanvasElement;
  readonly camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private controls: OrbitControls;
  private tc: TransformControls;
  private pivot = new THREE.Object3D();
  private raycaster = new THREE.Raycaster();

  private views = new Map<number, BodyView>();
  private hidden = new Set<number>();
  private bodyRoot = new THREE.Group();
  private ghostRoot = new THREE.Group();
  private overlayRoot = new THREE.Group();
  private hoverEdges: LineSegments2;
  private selEdges: LineSegments2;

  private stamp = 0;
  private renderQueued = false;
  private width = 1;
  private height = 1;

  private xfIds: number[] = [];
  private xfStart = new THREE.Vector3();
  private xfMode: "translate" | "rotate" = "translate";
  private xfEnd: ((r: TransformResult) => void) | null = null;

  /** Shared materials, also used by tools for previews. */
  readonly mats = {
    faces: [
      new THREE.MeshStandardMaterial({ color: 0x9aa5b1, metalness: 0.05, roughness: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
      new THREE.MeshStandardMaterial({ color: 0xe9c46a, metalness: 0.05, roughness: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
      new THREE.MeshStandardMaterial({ color: 0xf4a259, metalness: 0.05, roughness: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
    ],
    // Flat face bodies: bluish, pulled slightly toward the camera so they win over
    // coplanar solid faces / the grid.
    regionFaces: [
      new THREE.MeshStandardMaterial({ color: 0x6f9bd1, metalness: 0, roughness: 0.7, side: THREE.DoubleSide, transparent: true, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      new THREE.MeshStandardMaterial({ color: 0xe9c46a, metalness: 0, roughness: 0.7, side: THREE.DoubleSide, transparent: true, opacity: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      new THREE.MeshStandardMaterial({ color: 0xf4a259, metalness: 0, roughness: 0.7, side: THREE.DoubleSide, transparent: true, opacity: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    ],
    edge: new LineMaterial({ color: 0x15171a, linewidth: 1.4 }),
    edgeHover: new LineMaterial({ color: 0xffe066, linewidth: 3.5 }),
    edgeSelected: new LineMaterial({ color: 0xff9f1c, linewidth: 3.5 }),
    previewFill: new THREE.MeshStandardMaterial({ color: 0x5aa9ff, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }),
    previewLine: new THREE.LineBasicMaterial({ color: 0x8fd3ff, depthTest: false, transparent: true }),
    cursor: new THREE.MeshBasicMaterial({ color: 0xffe066, depthTest: false, transparent: true }),
  };

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.canvas = this.renderer.domElement;
    container.appendChild(this.canvas);

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(140, -190, 130);
    this.scene.add(this.camera);

    // Lights follow the camera so shading is consistent from every angle.
    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30343a, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, 1.5, 2);
    this.camera.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-2, -1, 0.5);
    this.camera.add(fill);

    this.scene.add(this.makeGrid(), this.bodyRoot, this.ghostRoot, this.overlayRoot);

    this.hoverEdges = this.makeOverlayLines(this.mats.edgeHover);
    this.selEdges = this.makeOverlayLines(this.mats.edgeSelected);
    this.scene.add(this.selEdges, this.hoverEdges);

    this.controls = new OrbitControls(this.camera, this.canvas);
    // Requirements:
    // 1) No right mouse drag (disabled)
    // 2) Middle mouse drag = Orbit (ROTATE)
    // 3) Shift + Left mouse drag = Pan (PAN)
    // Normal Left click/drag is reserved for select / draw tools (not camera orbit).
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: -1,
    } as unknown as OrbitControls["mouseButtons"];

    // Prevent regular Left-drag from rotating the view:
    // Only allow Left-button actions when Shift is held down (which triggers PAN).
    this.canvas.addEventListener("pointerdown", (e) => {
      if (e.button === 0 && !e.shiftKey) {
        // Normal left-click: temporarily disable rotate on OrbitControls for this gesture
        this.controls.enableRotate = false;
      } else {
        this.controls.enableRotate = true;
      }
    }, { capture: true });

    window.addEventListener("pointerup", () => {
      this.controls.enableRotate = true;
    }, { capture: true });

    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.addEventListener("change", () => {
      this.updateClipPlanes();
      this.stamp++;
      this.requestRender();
    });

    this.tc = new TransformControls(this.camera, this.canvas);
    this.tc.setSpace("world");
    this.tc.setSize(0.9);
    this.scene.add(this.pivot, this.tc.getHelper());
    this.tc.addEventListener("change", () => this.requestRender());
    this.tc.addEventListener("dragging-changed", (e) => {
      const dragging = (e as unknown as { value: boolean }).value;
      this.controls.enabled = !dragging;
      if (!dragging) this.finishTransformDrag();
    });
    this.tc.addEventListener("objectChange", () => this.applyPivotToBodies());

    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    new ResizeObserver(() => this.resize(container)).observe(container);
    this.resize(container);
    this.updateClipPlanes();
  }

  // ------------------------------------------------------------ scene setup

  private makeGrid(): THREE.Group {
    const g = new THREE.Group();
    const minor = new THREE.GridHelper(200, 200, 0x3b3f46, 0x3b3f46);
    const major = new THREE.GridHelper(1000, 100, 0x4b5059, 0x4b5059);
    for (const grid of [minor, major]) {
      grid.rotation.x = Math.PI / 2;
      const m = grid.material as THREE.Material;
      m.transparent = true;
      m.opacity = grid === minor ? 0.35 : 0.6;
      m.depthWrite = false;
      g.add(grid);
    }
    const axis = (from: V3, to: V3, color: number) => {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...from), new THREE.Vector3(...to)]);
      return new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
    };
    // Red (+X), Green (+Y), Blue (+Z upward into positive space)
    g.add(
      axis([0, 0, 0], [500, 0, 0], 0xd9534f),
      axis([0, 0, 0], [0, 500, 0], 0x5cb85c),
      axis([0, 0, 0], [0, 0, 50000], 0x4a90e2)
    );
    g.renderOrder = -1;
    return g;
  }

  private makeOverlayLines(mat: LineMaterial): LineSegments2 {
    const l = new LineSegments2(new LineSegmentsGeometry(), mat);
    l.visible = false;
    l.renderOrder = 10;
    l.raycast = () => {};
    return l;
  }

  private resize(container: HTMLElement): void {
    this.width = Math.max(1, container.clientWidth);
    this.height = Math.max(1, container.clientHeight);
    this.renderer.setSize(this.width, this.height);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    for (const m of [this.mats.edge, this.mats.edgeHover, this.mats.edgeSelected]) m.resolution.set(this.width, this.height);
    this.stamp++;
    this.render();
  }

  private updateClipPlanes(): void {
    const d = this.camera.position.distanceTo(this.controls.target);
    this.camera.near = Math.max(0.01, d / 2000);
    this.camera.far = Math.max(10000, d * 200);
    this.camera.updateProjectionMatrix();
  }

  requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  // ------------------------------------------------------------ bodies

  private buildView(body: Body): BodyView {
    const { faces, edges } = tessellate(body.shape);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(faces.vertices), 3));
    geom.setAttribute("normal", new THREE.BufferAttribute(Float32Array.from(faces.normals), 3));
    geom.setIndex(new THREE.BufferAttribute(Uint32Array.from(faces.triangles), 1));
    const faceIds: number[] = [];
    const faceStarts: number[] = [];
    const faceIndex = new Map<number, number>();
    faces.faceGroups.forEach((g, i) => {
      geom.addGroup(g.start, g.count, 0);
      faceIds.push(g.faceId);
      faceStarts.push(g.start);
      faceIndex.set(g.faceId, i);
    });
    const mesh = new THREE.Mesh(geom, body.kind === "face" ? this.mats.regionFaces : this.mats.faces);

    const edgePos = Float32Array.from(edges.lines);
    let lines: LineSegments2 | null = null;
    if (edgePos.length >= 6) {
      const eg = new LineSegmentsGeometry();
      eg.setPositions(edgePos);
      lines = new LineSegments2(eg, this.mats.edge);
      lines.raycast = () => {};
    }
    const edgeIds: number[] = [];
    const edgeStarts: number[] = [];
    const edgeCounts: number[] = [];
    const edgeIndex = new Map<number, number>();
    edges.edgeGroups.forEach((g, i) => {
      edgeIds.push(g.edgeId);
      edgeStarts.push(g.start);
      edgeCounts.push(g.count);
      edgeIndex.set(g.edgeId, i);
    });

    const group = new THREE.Group();
    group.add(mesh);
    if (lines) group.add(lines);
    group.visible = !this.hidden.has(body.id);
    return { body, group, mesh, edges: lines, faceIds, faceStarts, faceIndex, edgeIds, edgeStarts, edgeCounts, edgeIndex, edgePos, proj: null, projStamp: -1 };
  }

  private disposeView(v: BodyView): void {
    v.group.removeFromParent();
    v.mesh.geometry.dispose();
    v.edges?.geometry.dispose();
  }

  /** Bring the scene in line with the document snapshot (rebuilds only changed bodies). */
  sync(bodies: readonly Body[]): void {
    const live = new Set<number>();
    for (const body of bodies) {
      live.add(body.id);
      const existing = this.views.get(body.id);
      if (existing && existing.body === body) continue;
      if (existing) this.disposeView(existing);
      const view = this.buildView(body);
      this.views.set(body.id, view);
      this.bodyRoot.add(view.group);
    }
    for (const [id, v] of this.views) {
      if (!live.has(id)) {
        this.disposeView(v);
        this.views.delete(id);
      }
    }
    this.stamp++;
    this.requestRender();
  }

  setHidden(ids: Set<number>): void {
    this.hidden = new Set(ids);
    for (const [id, v] of this.views) v.group.visible = !this.hidden.has(id);
    this.stamp++;
    this.requestRender();
  }

  /** Whether a selection item still refers to existing geometry. */
  isValid(it: SelItem): boolean {
    const v = this.views.get(it.body);
    if (!v) return false;
    if (it.kind === "face") return v.faceIndex.has(it.id);
    if (it.kind === "edge") return v.edgeIndex.has(it.id);
    return true;
  }

  // ------------------------------------------------------------ picking

  private setRay(cx: number, cy: number): void {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
  }

  ray(cx: number, cy: number): THREE.Ray {
    this.setRay(cx, cy);
    return this.raycaster.ray.clone();
  }

  private raycastFaces(cx: number, cy: number): { view: BodyView; faceId: number; point: THREE.Vector3; distance: number } | null {
    this.setRay(cx, cy);
    const meshes: THREE.Object3D[] = [];
    for (const v of this.views.values()) if (v.group.visible) meshes.push(v.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (!hit || hit.faceIndex == null) return null;
    const view = [...this.views.values()].find((v) => v.mesh === hit.object)!;
    // Binary search the face group containing this triangle.
    const idx = hit.faceIndex * 3;
    let lo = 0;
    let hi = view.faceStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (view.faceStarts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return { view, faceId: view.faceIds[lo], point: hit.point.clone(), distance: hit.distance };
  }

  /** Screen-space projection of a body's edge polyline points, cached per camera state. */
  private projected(v: BodyView): Float32Array {
    if (v.proj && v.projStamp === this.stamp) return v.proj;
    const n = v.edgePos.length / 3;
    const out = v.proj && v.proj.length === n * 3 ? v.proj : new Float32Array(n * 3);
    const p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      p.set(v.edgePos[i * 3], v.edgePos[i * 3 + 1], v.edgePos[i * 3 + 2]).project(this.camera);
      out[i * 3] = ((p.x + 1) / 2) * this.width;
      out[i * 3 + 1] = ((1 - p.y) / 2) * this.height;
      out[i * 3 + 2] = p.z;
    }
    v.proj = out;
    v.projStamp = this.stamp;
    return out;
  }

  private pickEdge(cx: number, cy: number, faceDist: number | null): { view: BodyView; edgeId: number; point: THREE.Vector3 } | null {
    const r = this.canvas.getBoundingClientRect();
    const px = cx - r.left;
    const py = cy - r.top;
    let best: { view: BodyView; edgeId: number; point: THREE.Vector3 } | null = null;
    let bestD = EDGE_PICK_PX;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (const v of this.views.values()) {
      if (!v.group.visible) continue;
      const proj = this.projected(v);
      for (let e = 0; e < v.edgeIds.length; e++) {
        const end = v.edgeStarts[e] + v.edgeCounts[e];
        for (let k = v.edgeStarts[e]; k + 1 < end; k += 2) {
          const ax = proj[k * 3], ay = proj[k * 3 + 1], az = proj[k * 3 + 2];
          const bx = proj[k * 3 + 3], by = proj[k * 3 + 4], bz = proj[k * 3 + 5];
          if (az > 1 || bz > 1 || az < -1 || bz < -1) continue;
          const dx = bx - ax, dy = by - ay;
          const len2 = dx * dx + dy * dy;
          const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
          const d = Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
          if (d >= bestD) continue;
          a.fromArray(v.edgePos, k * 3);
          b.fromArray(v.edgePos, k * 3 + 3);
          const world = a.clone().lerp(b, t);
          if (faceDist !== null) {
            const depth = this.camera.position.distanceTo(world);
            if (depth > faceDist * 1.01 + 0.05) continue; // hidden behind a face
          }
          bestD = d;
          best = { view: v, edgeId: v.edgeIds[e], point: world };
        }
      }
    }
    return best;
  }

  pick(cx: number, cy: number, mode: SelMode): Pick | null {
    const hit = this.raycastFaces(cx, cy);
    if (mode === "edge") {
      const e = this.pickEdge(cx, cy, hit ? hit.distance : null);
      return e ? { kind: "edge", body: e.view.body.id, id: e.edgeId, point: e.point } : null;
    }
    if (!hit) return null;
    if (mode === "body") return { kind: "body", body: hit.view.body.id, id: 0, point: hit.point };
    return { kind: "face", body: hit.view.body.id, id: hit.faceId, point: hit.point };
  }

  /** Face under the cursor regardless of selection mode (used by drawing tools). */
  faceUnder(cx: number, cy: number): { body: Body; faceId: number; point: THREE.Vector3 } | null {
    const hit = this.raycastFaces(cx, cy);
    return hit ? { body: hit.view.body, faceId: hit.faceId, point: hit.point } : null;
  }

  // ------------------------------------------------------------ highlighting

  setHighlight(selection: SelItem[], hover: SelItem | null): void {
    for (const v of this.views.values()) for (const g of v.mesh.geometry.groups) g.materialIndex = 0;

    const paint = (it: SelItem, matIndex: number) => {
      const v = this.views.get(it.body);
      if (!v) return;
      const groups = v.mesh.geometry.groups;
      if (it.kind === "body") for (const g of groups) g.materialIndex = matIndex;
      else if (it.kind === "face") {
        const i = v.faceIndex.get(it.id);
        if (i !== undefined) groups[i].materialIndex = matIndex;
      }
    };
    if (hover) paint(hover, 1);
    for (const it of selection) paint(it, 2);

    const edgePoints = (items: SelItem[]) => {
      const out: number[] = [];
      for (const it of items) {
        if (it.kind !== "edge") continue;
        const v = this.views.get(it.body);
        const i = v?.edgeIndex.get(it.id);
        if (!v || i === undefined) continue;
        const s = v.edgeStarts[i] * 3;
        const e = (v.edgeStarts[i] + v.edgeCounts[i]) * 3;
        for (let k = s; k < e; k++) out.push(v.edgePos[k]);
      }
      return out;
    };
    const isSelected = hover && selection.some((s) => sameItem(s, hover));
    this.setOverlayLines(this.selEdges, edgePoints(selection));
    this.setOverlayLines(this.hoverEdges, hover && !isSelected ? edgePoints([hover]) : []);
    this.requestRender();
  }

  private setOverlayLines(lines: LineSegments2, pts: number[]): void {
    if (pts.length < 6) {
      lines.visible = false;
      return;
    }
    lines.geometry.dispose();
    const g = new LineSegmentsGeometry();
    g.setPositions(pts);
    lines.geometry = g;
    lines.visible = true;
  }

  // ------------------------------------------------------------ tool overlays & ghosts

  /** Replace tool overlay objects (previous overlay geometries are disposed). */
  setOverlay(objects: THREE.Object3D[]): void {
    for (const child of [...this.overlayRoot.children]) {
      child.removeFromParent();
      child.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    }
    for (const o of objects) {
      o.renderOrder = 20;
      this.overlayRoot.add(o);
    }
    this.requestRender();
  }

  /**
   * Preview operation results in place of the given bodies. Keys that are not
   * existing body ids (e.g. negative numbers) add a preview without hiding anything.
   */
  showGhost(shapes: Map<number, Shape>): void {
    this.clearGhost();
    let k = -1;
    for (const [id, shape] of shapes) {
      const view = this.buildView({ id: k--, name: "", kind: kindOf(shape), shape });
      this.ghostRoot.add(view.group);
      const orig = this.views.get(id);
      if (orig) orig.group.visible = false;
    }
    this.requestRender();
  }

  clearGhost(): void {
    for (const child of [...this.ghostRoot.children]) {
      child.removeFromParent();
      child.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    }
    for (const [id, v] of this.views) v.group.visible = !this.hidden.has(id);
    this.requestRender();
  }

  /** World-space size of one screen pixel at the given point. */
  worldPerPixel(point: THREE.Vector3): number {
    const d = this.camera.position.distanceTo(point);
    return (2 * d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / this.height;
  }

  toScreen(point: THREE.Vector3): { x: number; y: number } {
    const p = point.clone().project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
  }

  // ------------------------------------------------------------ camera

  fit(ids?: number[]): void {
    const box = new THREE.Box3();
    for (const [id, v] of this.views) {
      if (!v.group.visible) continue;
      if (ids && ids.length && !ids.includes(id)) continue;
      box.expandByObject(v.mesh);
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-60, -60, 0), new THREE.Vector3(60, 60, 40));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const dist = (Math.max(sphere.radius, 1) / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.15;
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist);
    this.controls.update();
  }

  setView(name: "top" | "front" | "right" | "iso"): void {
    const dirs: Record<string, V3> = { top: [0, -1e-4, 1], front: [0, -1, 0], right: [1, 0, 0], iso: [1, -1.2, 0.9] };
    const dist = this.camera.position.distanceTo(this.controls.target);
    const dir = new THREE.Vector3(...dirs[name]).normalize();
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    this.controls.update();
  }

  // ------------------------------------------------------------ transform gizmo

  get gizmoHot(): boolean {
    return this.tc.object !== undefined && this.tc.axis !== null;
  }

  get transforming(): boolean {
    return this.tc.object !== undefined;
  }

  startTransform(mode: "translate" | "rotate", ids: number[], snapStep: number, onEnd: (r: TransformResult) => void): void {
    const box = new THREE.Box3();
    for (const id of ids) {
      const v = this.views.get(id);
      if (v) box.expandByObject(v.mesh);
    }
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    if (snapStep > 0) c.set(Math.round(c.x / snapStep) * snapStep, Math.round(c.y / snapStep) * snapStep, Math.round(c.z / snapStep) * snapStep);
    this.pivot.position.copy(c);
    this.pivot.quaternion.identity();
    this.pivot.updateMatrixWorld();
    this.xfStart.copy(c);
    this.xfIds = ids;
    this.xfMode = mode;
    this.xfEnd = onEnd;
    this.tc.setMode(mode);
    this.tc.setTranslationSnap(snapStep > 0 ? snapStep : null);
    this.tc.setRotationSnap(snapStep > 0 ? THREE.MathUtils.degToRad(15) : null);
    this.tc.attach(this.pivot);
    this.requestRender();
  }

  stopTransform(): void {
    this.tc.detach();
    this.resetBodyMatrices();
    this.xfIds = [];
    this.xfEnd = null;
    this.requestRender();
  }

  private resetBodyMatrices(): void {
    for (const v of this.views.values()) {
      v.group.matrixAutoUpdate = true;
      v.group.position.set(0, 0, 0);
      v.group.quaternion.identity();
      v.group.updateMatrix();
    }
  }

  private applyPivotToBodies(): void {
    this.pivot.updateMatrixWorld();
    const start = new THREE.Matrix4().makeTranslation(this.xfStart.x, this.xfStart.y, this.xfStart.z);
    const m = this.pivot.matrixWorld.clone().multiply(start.invert());
    for (const id of this.xfIds) {
      const v = this.views.get(id);
      if (!v) continue;
      v.group.matrixAutoUpdate = false;
      v.group.matrix.copy(m);
      v.group.matrixWorldNeedsUpdate = true;
    }
    this.requestRender();
  }

  private finishTransformDrag(): void {
    const end = this.xfEnd;
    if (!end) return;
    let result: TransformResult | null = null;
    if (this.xfMode === "translate") {
      const d = this.pivot.position.clone().sub(this.xfStart);
      if (d.lengthSq() > 1e-12) result = { type: "translate", vector: [d.x, d.y, d.z] };
    } else {
      const q = this.pivot.quaternion;
      const angle = 2 * Math.acos(Math.min(1, Math.max(-1, q.w)));
      const s = Math.sin(angle / 2);
      if (angle > 1e-6 && s > 1e-9) {
        result = {
          type: "rotate",
          angleDeg: THREE.MathUtils.radToDeg(angle),
          axis: [q.x / s, q.y / s, q.z / s],
          center: [this.xfStart.x, this.xfStart.y, this.xfStart.z],
        };
      }
    }
    this.resetBodyMatrices();
    if (result) end(result);
    else this.requestRender();
  }
}
