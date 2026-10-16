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
  /** Surface area of each face group (same order as faceIds), used to prefer small faces when picking. */
  faceAreas: number[];
  edgeIds: number[];
  edgeStarts: number[];
  edgeCounts: number[];
  edgeIndex: Map<number, number>;
  edgePos: Float32Array;
  proj: Float32Array | null;
  projStamp: number;
  /** [firstVertex, endVertex) per face group, used to recolour faces inside a batch. */
  faceV: number[];
  vertexCount: number;
  chunk: Chunk | null;
  /** Where this body currently lives inside its chunk's merged mesh (null = not batched). */
  slot: { mesh: THREE.Mesh; vOffset: number } | null;
  /** Lazily built snap points (see snapsOf). */
  snaps?: { pts: Float32Array; kinds: Uint8Array; proj: Float32Array | null; projStamp: number };
}

/** Object snap kinds, in priority order. */
export type SnapKind = "vertex" | "center" | "midpoint" | "axis";
const SNAP_KINDS: SnapKind[] = ["vertex", "center", "midpoint"];
const SNAP_PX = 12;

/**
 * Rendering batch: up to CHUNK_SIZE bodies merged into one solid mesh, one
 * flat-face mesh and one edge line set (3 draw calls instead of 2 per body).
 * Bodies stay separate for picking/selection; only drawing is merged.
 * Only the chunk containing a changed body is rebuilt.
 */
interface Chunk {
  ids: Set<number>;
  root: THREE.Group;
  dirty: boolean;
}

const CHUNK_SIZE = 256;
const COLORS = { solid: 0x9aa5b1, region: 0x6f9bd1, hover: 0xe9c46a, selected: 0xf4a259 };

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
  private batchRoot = new THREE.Group();
  private chunks: Chunk[] = [];
  private xfSet = new Set<number>();
  private hl = { sel: [] as SelItem[], hover: null as SelItem | null, painted: new Set<number>() };
  private batchMats = {
    solid: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, metalness: 0.05, roughness: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
    region: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, metalness: 0, roughness: 0.7, side: THREE.DoubleSide, transparent: true, opacity: 0.87, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  };
  private ghostRoot = new THREE.Group();
  private overlayRoot = new THREE.Group();
  private guideRoot = new THREE.Group();
  /** Guide lines (snap targets); see setGuides. */
  private guides: { a: THREE.Vector3; b: THREE.Vector3 }[] = [];
  private hoverEdges: LineSegments2;
  private selOutline: LineSegments2;
  private hoverOutline: LineSegments2;
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
    outlineHover: new LineMaterial({ color: 0x7cc4ff, linewidth: 3 }),
    outlineSelected: new LineMaterial({ color: 0x1e88ff, linewidth: 3.5 }),
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

    this.scene.add(this.makeGrid(), this.batchRoot, this.bodyRoot, this.ghostRoot, this.overlayRoot, this.guideRoot);

    this.hoverEdges = this.makeOverlayLines(this.mats.edgeHover);
    this.selEdges = this.makeOverlayLines(this.mats.edgeSelected);
    this.selOutline = this.makeOverlayLines(this.mats.outlineSelected);
    this.hoverOutline = this.makeOverlayLines(this.mats.outlineHover);
    this.scene.add(this.selEdges, this.hoverEdges, this.selOutline, this.hoverOutline);

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
      if (!dragging) {
        this.showSnapMarker(null);
        this.finishTransformDrag();
      }
    });
    this.tc.addEventListener("objectChange", () => {
      this.snapPivot();
      this.applyPivotToBodies();
    });
    // Capture phase on window so the pointer is current before TransformControls handles the move.
    window.addEventListener("pointermove", (e) => {
      this.xfPointer = { x: e.clientX, y: e.clientY, ctrl: e.ctrlKey };
      this.updateXfSnap(e.ctrlKey);
    }, { capture: true });
    window.addEventListener("pointerdown", (e) => this.updateXfSnap(e.ctrlKey), { capture: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Control") return;
      if (this.xfPointer) this.xfPointer.ctrl = e.type === "keydown";
      this.updateXfSnap(e.type === "keydown");
    };
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("keyup", onKey, { capture: true });

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
    for (const m of [this.mats.edge, this.mats.edgeHover, this.mats.edgeSelected, this.mats.outlineHover, this.mats.outlineSelected]) m.resolution.set(this.width, this.height);
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
    this.flushBatches();
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
    const faceAreas: number[] = [];
    const faceV: number[] = [];
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
    const P = faces.vertices, T = faces.triangles;
    faces.faceGroups.forEach((g, i) => {
      geom.addGroup(g.start, g.count, 0);
      faceIds.push(g.faceId);
      faceStarts.push(g.start);
      faceIndex.set(g.faceId, i);
      let area = 0;
      let vMin = Infinity, vMax = -1;
      for (let k = g.start; k < g.start + g.count; k++) {
        if (T[k] < vMin) vMin = T[k];
        if (T[k] > vMax) vMax = T[k];
      }
      faceV.push(vMax < 0 ? 0 : vMin, vMax + 1);
      for (let k = g.start; k + 2 < g.start + g.count; k += 3) {
        va.fromArray(P, T[k] * 3);
        vb.fromArray(P, T[k + 1] * 3).sub(va);
        vc.fromArray(P, T[k + 2] * 3).sub(va);
        area += vb.cross(vc).length() / 2;
      }
      faceAreas.push(area);
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
    return {
      body, group, mesh, edges: lines, faceIds, faceStarts, faceIndex, faceAreas, edgeIds, edgeStarts, edgeCounts, edgeIndex, edgePos,
      proj: null, projStamp: -1, faceV, vertexCount: P.length / 3, chunk: null, slot: null,
    };
  }

  private disposeView(v: BodyView): void {
    v.group.removeFromParent();
    v.mesh.geometry.dispose();
    v.edges?.geometry.dispose();
    if (v.chunk) {
      v.chunk.ids.delete(v.body.id);
      v.chunk.dirty = true;
    }
  }

  /** Bring the scene in line with the document snapshot (rebuilds only changed bodies). */
  sync(bodies: readonly Body[]): void {
    const live = new Set<number>();
    for (const body of bodies) {
      live.add(body.id);
      const existing = this.views.get(body.id);
      if (existing && existing.body === body) continue;
      const chunk = existing?.chunk ?? this.chunkWithRoom();
      if (existing) this.disposeView(existing);
      const view = this.buildView(body);
      this.views.set(body.id, view);
      view.chunk = chunk;
      chunk.ids.add(body.id);
      chunk.dirty = true;
      this.placeView(view);
    }
    for (const [id, v] of this.views) {
      if (!live.has(id)) {
        this.disposeView(v);
        this.views.delete(id);
        this.hl.painted.delete(id);
      }
    }
    this.stamp++;
    this.requestRender();
  }

  // ------------------------------------------------------------ batching

  private chunkWithRoom(): Chunk {
    let c = this.chunks.find((k) => k.ids.size < CHUNK_SIZE);
    if (!c) {
      c = { ids: new Set(), root: new THREE.Group(), dirty: true };
      this.chunks.push(c);
      this.batchRoot.add(c.root);
    }
    return c;
  }

  /** Bodies being dragged by the gizmo render on their own (so they can move); all others render batched. */
  private placeView(v: BodyView): void {
    if (this.xfSet.has(v.body.id)) this.bodyRoot.add(v.group);
    else v.group.removeFromParent();
  }

  private markDirty(id: number): void {
    const c = this.views.get(id)?.chunk;
    if (c) c.dirty = true;
  }

  private flushBatches(): void {
    let rebuilt = false;
    for (const c of this.chunks) {
      if (!c.dirty) continue;
      this.buildChunk(c);
      rebuilt = true;
    }
    if (rebuilt) {
      this.chunks = this.chunks.filter((c) => {
        if (c.ids.size) return true;
        c.root.removeFromParent();
        return false;
      });
      this.paintHighlight();
    }
  }

  private buildChunk(c: Chunk): void {
    c.dirty = false;
    for (const o of [...c.root.children]) {
      o.removeFromParent();
      (o as THREE.Mesh).geometry.dispose();
    }
    const members: BodyView[] = [];
    for (const id of c.ids) {
      const v = this.views.get(id);
      if (!v) continue;
      v.slot = null;
      if (v.group.visible && !this.xfSet.has(id)) members.push(v);
    }
    const tmp = new THREE.Color();
    for (const kind of ["solid", "face"] as const) {
      const list = members.filter((v) => v.body.kind === kind);
      if (!list.length) continue;
      let nv = 0, ni = 0;
      for (const v of list) {
        nv += v.vertexCount;
        ni += v.mesh.geometry.index!.count;
      }
      const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
      const idx = new Uint32Array(ni);
      tmp.setHex(kind === "face" ? COLORS.region : COLORS.solid);
      const geom = new THREE.BufferGeometry();
      const mesh = new THREE.Mesh(geom, kind === "face" ? this.batchMats.region : this.batchMats.solid);
      mesh.raycast = () => {}; // picking uses the per-body meshes
      let vo = 0, io = 0;
      for (const v of list) {
        const g = v.mesh.geometry;
        pos.set(g.attributes.position.array as Float32Array, vo * 3);
        nor.set(g.attributes.normal.array as Float32Array, vo * 3);
        const src = g.index!.array;
        for (let k = 0; k < src.length; k++) idx[io + k] = src[k] + vo;
        for (let k = vo * 3; k < (vo + v.vertexCount) * 3; k += 3) {
          col[k] = tmp.r;
          col[k + 1] = tmp.g;
          col[k + 2] = tmp.b;
        }
        v.slot = { mesh, vOffset: vo };
        vo += v.vertexCount;
        io += src.length;
      }
      geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geom.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
      geom.setAttribute("color", new THREE.BufferAttribute(col, 3));
      geom.setIndex(new THREE.BufferAttribute(idx, 1));
      geom.computeBoundingSphere();
      c.root.add(mesh);
    }
    let ne = 0;
    for (const v of members) ne += v.edgePos.length;
    if (ne >= 6) {
      const ep = new Float32Array(ne);
      let o = 0;
      for (const v of members) {
        ep.set(v.edgePos, o);
        o += v.edgePos.length;
      }
      const eg = new LineSegmentsGeometry();
      eg.setPositions(ep);
      const lines = new LineSegments2(eg, this.mats.edge);
      lines.raycast = () => {};
      c.root.add(lines);
    }
  }

  setHidden(ids: Set<number>): void {
    this.hidden = new Set(ids);
    for (const [id, v] of this.views) {
      const vis = !this.hidden.has(id);
      if (v.group.visible !== vis) this.markDirty(id);
      v.group.visible = vis;
    }
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
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (!hits.length || hits[0].faceIndex == null) return null;
    const groupOf = (view: BodyView, faceIndex: number): number => {
      // Binary search the face group containing this triangle.
      const idx = faceIndex * 3;
      let lo = 0;
      let hi = view.faceStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (view.faceStarts[mid] <= idx) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    const viewOf = (o: THREE.Object3D) => [...this.views.values()].find((v) => v.mesh === o)!;
    // Hits at (nearly) the same depth as the nearest one are overlapping faces;
    // prefer the smallest so small faces win over big ones underneath them.
    const tol = Math.max(0.05, hits[0].distance * 2e-3);
    let best: { view: BodyView; gi: number; hit: THREE.Intersection; area: number } | null = null;
    for (const hit of hits) {
      if (hit.distance - hits[0].distance > tol) break;
      if (hit.faceIndex == null) continue;
      const view = viewOf(hit.object);
      const gi = groupOf(view, hit.faceIndex);
      const area = view.faceAreas[gi];
      if (!best || area < best.area) best = { view, gi, hit, area };
    }
    const { view, gi, hit } = best!;
    return { view, faceId: view.faceIds[gi], point: hit.point.clone(), distance: hit.distance };
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

  // ------------------------------------------------------------ object snapping

  /**
   * Snap points of a body: edge end points (vertices), edge midpoints, centres
   * of closed (circular) edges and centres of planar faces. Built on first use.
   */
  private snapsOf(v: BodyView): NonNullable<BodyView["snaps"]> {
    if (v.snaps) return v.snaps;
    const pts: number[] = [];
    const kinds: number[] = [];
    const seen = new Set<string>();
    const add = (x: number, y: number, z: number, kind: number) => {
      const key = `${kind}:${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
      if (seen.has(key)) return;
      seen.add(key);
      pts.push(x, y, z);
      kinds.push(kind);
    };
    const E = v.edgePos;
    for (let e = 0; e < v.edgeIds.length; e++) {
      const s = v.edgeStarts[e], n = v.edgeCounts[e];
      if (n < 2) continue;
      const a = s * 3, b = (s + n - 1) * 3;
      const closed = Math.hypot(E[a] - E[b], E[a + 1] - E[b + 1], E[a + 2] - E[b + 2]) < 1e-6;
      if (closed) {
        // Circle / closed curve: centre = mean of its points.
        let cx = 0, cy = 0, cz = 0;
        for (let k = s; k < s + n; k++) {
          cx += E[k * 3];
          cy += E[k * 3 + 1];
          cz += E[k * 3 + 2];
        }
        add(cx / n, cy / n, cz / n, 1);
        continue;
      }
      add(E[a], E[a + 1], E[a + 2], 0);
      add(E[b], E[b + 1], E[b + 2], 0);
      // Midpoint by arc length along the segment pairs.
      let total = 0;
      for (let k = s; k + 1 < s + n; k += 2) total += Math.hypot(E[k * 3 + 3] - E[k * 3], E[k * 3 + 4] - E[k * 3 + 1], E[k * 3 + 5] - E[k * 3 + 2]);
      let acc = 0;
      for (let k = s; k + 1 < s + n; k += 2) {
        const len = Math.hypot(E[k * 3 + 3] - E[k * 3], E[k * 3 + 4] - E[k * 3 + 1], E[k * 3 + 5] - E[k * 3 + 2]);
        if (acc + len >= total / 2) {
          const t = len > 0 ? (total / 2 - acc) / len : 0;
          add(E[k * 3] + (E[k * 3 + 3] - E[k * 3]) * t, E[k * 3 + 1] + (E[k * 3 + 4] - E[k * 3 + 1]) * t, E[k * 3 + 2] + (E[k * 3 + 5] - E[k * 3 + 2]) * t, 2);
          break;
        }
        acc += len;
      }
    }
    // Planar face centres (area-weighted centroid; skipped for curved faces).
    const g = v.mesh.geometry;
    const P = g.attributes.position.array as Float32Array, N = g.attributes.normal.array as Float32Array, T = g.index!.array;
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
    for (let f = 0; f < v.faceIds.length; f++) {
      const [v0, v1] = [v.faceV[f * 2], v.faceV[f * 2 + 1]];
      let planar = true;
      for (let k = v0 + 1; k < v1 && planar; k++) {
        if (N[k * 3] * N[v0 * 3] + N[k * 3 + 1] * N[v0 * 3 + 1] + N[k * 3 + 2] * N[v0 * 3 + 2] < 0.9999) planar = false;
      }
      if (!planar) continue;
      const start = v.faceStarts[f], end = f + 1 < v.faceStarts.length ? v.faceStarts[f + 1] : T.length;
      let A = 0, cx = 0, cy = 0, cz = 0;
      for (let k = start; k + 2 < end + 0 && k + 2 < T.length; k += 3) {
        va.fromArray(P, T[k] * 3);
        vb.fromArray(P, T[k + 1] * 3);
        vc.fromArray(P, T[k + 2] * 3);
        const area = vb.clone().sub(va).cross(vc.clone().sub(va)).length() / 2;
        A += area;
        cx += ((va.x + vb.x + vc.x) / 3) * area;
        cy += ((va.y + vb.y + vc.y) / 3) * area;
        cz += ((va.z + vb.z + vc.z) / 3) * area;
      }
      if (A > 0) add(cx / A, cy / A, cz / A, 1);
    }
    v.snaps = { pts: Float32Array.from(pts), kinds: Uint8Array.from(kinds), proj: null, projStamp: -1 };
    return v.snaps;
  }

  /** Nearest visible object snap point within SNAP_PX of the cursor (vertex > centre > midpoint). */
  snapPoint(cx: number, cy: number, exclude?: Set<number>): { point: THREE.Vector3; kind: SnapKind } | null {
    const r = this.canvas.getBoundingClientRect();
    const px = cx - r.left, py = cy - r.top;
    const faceHit = exclude?.size ? null : this.raycastFaces(cx, cy);
    let best: { score: number; view: BodyView; i: number } | null = null;
    const p = new THREE.Vector3();
    for (const [id, v] of this.views) {
      if (!v.group.visible || exclude?.has(id)) continue;
      const s = this.snapsOf(v);
      if (s.projStamp !== this.stamp || !s.proj) {
        const n = s.kinds.length;
        s.proj = s.proj && s.proj.length === n * 3 ? s.proj : new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          p.fromArray(s.pts, i * 3).project(this.camera);
          s.proj[i * 3] = ((p.x + 1) / 2) * this.width;
          s.proj[i * 3 + 1] = ((1 - p.y) / 2) * this.height;
          s.proj[i * 3 + 2] = p.z;
        }
        s.projStamp = this.stamp;
      }
      for (let i = 0; i < s.kinds.length; i++) {
        const z = s.proj[i * 3 + 2];
        if (z < -1 || z > 1) continue;
        const d = Math.hypot(s.proj[i * 3] - px, s.proj[i * 3 + 1] - py);
        if (d > SNAP_PX) continue;
        const score = d + s.kinds[i] * 4; // prefer vertices, then centres, then midpoints
        if (best && score >= best.score) continue;
        if (faceHit) {
          // Hidden behind a face? (allow points on the hit face itself)
          p.fromArray(s.pts, i * 3);
          if (this.camera.position.distanceTo(p) > faceHit.distance * 1.01 + 0.05) continue;
        }
        best = { score, view: v, i };
      }
    }
    // World origin (0,0,0) is always a vertex-type snap point.
    p.set(0, 0, 0).project(this.camera);
    if (p.z >= -1 && p.z <= 1) {
      const d = Math.hypot(((p.x + 1) / 2) * this.width - px, ((1 - p.y) / 2) * this.height - py);
      const hidden = faceHit && this.camera.position.length() > faceHit.distance * 1.01 + 0.05;
      if (d <= SNAP_PX && !hidden && (!best || d < best.score)) return { point: new THREE.Vector3(), kind: "vertex" };
    }
    if (!best) return this.axisSnap(px, py, cx, cy, faceHit?.distance);
    const s = best.view.snaps!;
    return { point: new THREE.Vector3().fromArray(s.pts, best.i * 3), kind: SNAP_KINDS[s.kinds[best.i]] };
  }

  /** Show guide lines (dashed); `selected` is drawn highlighted. */
  setGuides(list: readonly { a: V3; b: V3 }[], selected = -1): void {
    for (const c of [...this.guideRoot.children]) {
      c.removeFromParent();
      (c as THREE.Line).geometry.dispose();
    }
    this.guides = list.map((g) => ({ a: new THREE.Vector3(...g.a), b: new THREE.Vector3(...g.b) }));
    this.guides.forEach((g, i) => {
      const mat = new THREE.LineDashedMaterial({ color: i === selected ? 0xffd166 : 0xff6fb5, dashSize: 1.5, gapSize: 1, depthTest: false, transparent: true });
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([g.a, g.b]), mat);
      l.computeLineDistances();
      l.renderOrder = 15;
      this.guideRoot.add(l);
    });
    this.requestRender();
  }

  /** Index of the guide line within a few pixels of the cursor, or -1. */
  guideAt(cx: number, cy: number): number {
    let best = -1, bd = 6;
    this.guides.forEach((g, i) => {
      const a = this.toScreen(g.a), b = this.toScreen(g.b);
      const dx = b.x - a.x, dy = b.y - a.y;
      const k = Math.max(0, Math.min(1, ((cx - a.x) * dx + (cy - a.y) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(cx - a.x - k * dx, cy - a.y - k * dy);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  /** Grid step used to round points snapped onto the world axis lines. */
  axisSnapStep = 1;

  /** Nearest point on the world X / Y / Z axis lines under the cursor (rounded to axisSnapStep). */
  private axisSnap(px: number, py: number, cx: number, cy: number, hitDist?: number): { point: THREE.Vector3; kind: SnapKind } | null {
    const ray = this.ray(cx, cy);
    let best: { d: number; p: THREE.Vector3 } | null = null;
    const q = new THREE.Vector3();
    const lines: { o: THREE.Vector3; dir: THREE.Vector3; len: number }[] = [
      ...[new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].map((dir) => ({ o: new THREE.Vector3(), dir, len: Infinity })),
      ...this.guides.map((g) => ({ o: g.a, dir: g.b.clone().sub(g.a).normalize(), len: g.a.distanceTo(g.b) })),
    ];
    for (const { o, dir, len } of lines) {
      // Closest point on the axis / guide line to the cursor ray.
      const w0 = ray.origin.clone().sub(o);
      const b = ray.direction.dot(dir), d = ray.direction.dot(w0), e = dir.dot(w0);
      const den = 1 - b * b;
      if (den < 1e-6) continue; // looking straight down this axis
      let t = (e - b * d) / den;
      const step = this.axisSnapStep;
      if (step > 0) t = Math.round(t / step) * step;
      if (len !== Infinity) {
        if (t < -1e-9 || t > len + 1e-9) continue;
        if (len - t < step / 2) t = len; // land on the far end
      }
      const p = o.clone().addScaledVector(dir, t);
      if (hitDist !== undefined && this.camera.position.distanceTo(p) > hitDist * 1.01 + 0.05) continue;
      q.copy(p).project(this.camera);
      if (q.z < -1 || q.z > 1) continue;
      const dist = Math.hypot(((q.x + 1) / 2) * this.width - px, ((1 - q.y) / 2) * this.height - py);
      if (dist <= SNAP_PX * 0.75 && (!best || dist < best.d)) best = { d: dist, p };
    }
    return best ? { point: best.p, kind: best.p.lengthSq() < 1e-12 ? "vertex" : "axis" } : null;
  }

  /** Pivot candidates of bodies: their snap points plus each body's bounding-box centre. */
  pivotCandidates(ids: number[]): { point: THREE.Vector3; kind: SnapKind }[] {
    const out: { point: THREE.Vector3; kind: SnapKind }[] = [];
    for (const id of ids) {
      const v = this.views.get(id);
      if (!v) continue;
      const s = this.snapsOf(v);
      for (let i = 0; i < s.kinds.length; i++) out.push({ point: new THREE.Vector3().fromArray(s.pts, i * 3), kind: SNAP_KINDS[s.kinds[i]] });
      const box = new THREE.Box3().setFromBufferAttribute(v.mesh.geometry.attributes.position as THREE.BufferAttribute);
      out.push({ point: box.getCenter(new THREE.Vector3()), kind: "center" });
    }
    return out;
  }

  /** Keep only points not hidden behind any body (as seen from the camera). */
  visiblePoints<T extends { point: THREE.Vector3 }>(pts: T[]): T[] {
    const meshes = [...this.views.values()].map((v) => v.mesh);
    const eye = this.camera.position;
    const tol = Math.max(0.05, eye.distanceTo(this.controls.target) * 2e-3);
    return pts.filter((p) => {
      const dir = p.point.clone().sub(eye);
      const dist = dir.length();
      this.raycaster.set(eye, dir.normalize());
      this.raycaster.far = dist - tol;
      const hit = this.raycaster.intersectObjects(meshes, false).length > 0;
      this.raycaster.far = Infinity;
      return !hit;
    });
  }

  /** Nearest of `pts` to the cursor within `maxPx` screen pixels. */
  nearestOnScreen<T extends { point: THREE.Vector3 }>(cx: number, cy: number, pts: T[], maxPx = 12): T | null {
    let best: T | null = null, bd = maxPx;
    for (const p of pts) {
      const s = this.toScreen(p.point);
      const d = Math.hypot(s.x - cx, s.y - cy);
      if (d <= bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  /** Show fixed-size dots at `pts` (drawn on top), or hide them with null. */
  showPivotDots(pts: THREE.Vector3[] | null): void {
    if (this.pivotDots) {
      this.scene.remove(this.pivotDots);
      this.pivotDots.geometry.dispose();
      (this.pivotDots.material as THREE.Material).dispose();
      this.pivotDots = null;
    }
    if (pts?.length) {
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      const m = new THREE.PointsMaterial({ color: 0x1e88ff, size: 9, sizeAttenuation: false, depthTest: false, transparent: true });
      this.pivotDots = new THREE.Points(g, m);
      this.pivotDots.renderOrder = 29;
      this.scene.add(this.pivotDots);
    }
    this.requestRender();
  }
  private pivotDots: THREE.Points | null = null;

  /** Show (or hide with null) the object-snap marker. */
  showSnapMarker(snap: { point: THREE.Vector3; kind: SnapKind } | null): void {
    if (!this.snapMarker) {
      const mk = (geo: THREE.BufferGeometry) => {
        const l = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x4ade80, depthTest: false, transparent: true }));
        l.renderOrder = 30;
        return l;
      };
      const sq = [-1, -1, 0, 1, -1, 0, 1, -1, 0, 1, 1, 0, 1, 1, 0, -1, 1, 0, -1, 1, 0, -1, -1, 0];
      const tri = [-1, -0.8, 0, 1, -0.8, 0, 1, -0.8, 0, 0, 1, 0, 0, 1, 0, -1, -0.8, 0];
      const circ: number[] = [];
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2, b = ((i + 1) / 16) * Math.PI * 2;
        circ.push(Math.cos(a), Math.sin(a), 0, Math.cos(b), Math.sin(b), 0);
      }
      const geo = (arr: number[]) => new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
      const cross = [-1, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0];
      this.snapMarker = { vertex: mk(geo(sq)), center: mk(geo(circ)), midpoint: mk(geo(tri)), axis: mk(geo(cross)) };
      for (const m of Object.values(this.snapMarker)) {
        m.visible = false;
        this.scene.add(m);
      }
    }
    for (const [k, m] of Object.entries(this.snapMarker)) {
      m.visible = !!snap && snap.kind === k;
      if (m.visible && snap) {
        m.position.copy(snap.point);
        m.quaternion.copy(this.camera.quaternion); // face the camera
        m.scale.setScalar(this.worldPerPixel(snap.point) * 7);
      }
    }
    this.requestRender();
  }
  private snapMarker: Record<SnapKind, THREE.LineSegments> | null = null;

  // ------------------------------------------------------------ highlighting

  setHighlight(selection: SelItem[], hover: SelItem | null): void {
    // Reset only what was painted last time.
    for (const id of this.hl.painted) this.paintBody(id, null, 0);
    this.hl.painted.clear();
    this.hl.sel = selection;
    this.hl.hover = hover;
    this.paintHighlight();

    const edgePoints = (items: SelItem[], bodies = false) => {
      const out: number[] = [];
      for (const it of items) {
        if (it.kind !== "edge" && it.kind !== "face") {
          if (!bodies) continue;
          // Whole body: outline all of its edges.
          const v = this.views.get(it.body);
          if (v) for (let k = 0; k < v.edgePos.length; k++) out.push(v.edgePos[k]);
          continue;
        }
        if (it.kind !== "edge" || bodies) continue;
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
    this.setOverlayLines(this.selOutline, edgePoints(selection, true));
    this.setOverlayLines(this.hoverOutline, hover && !isSelected ? edgePoints([hover], true) : []);
    this.requestRender();
  }

  private paintHighlight(): void {
    const h = this.hl;
    if (h.hover && h.hover.kind !== "edge") this.paintBody(h.hover.body, h.hover.kind === "face" ? h.hover.id : null, 1);
    for (const it of h.sel) if (it.kind !== "edge") this.paintBody(it.body, it.kind === "face" ? it.id : null, 2);
  }

  /** Colour a whole body (faceId null) or one face: 0 = base, 1 = hover, 2 = selected. */
  private paintBody(bodyId: number, faceId: number | null, level: 0 | 1 | 2): void {
    const v = this.views.get(bodyId);
    if (!v) return;
    if (level) this.hl.painted.add(bodyId);
    const fi = faceId === null ? -1 : v.faceIndex.get(faceId) ?? -2;
    if (fi === -2) return;
    // Standalone mesh (used while transforming): material groups.
    const groups = v.mesh.geometry.groups;
    if (fi < 0) for (const g of groups) g.materialIndex = level;
    else groups[fi].materialIndex = level;
    // Batched mesh: vertex colours.
    if (!v.slot) return;
    const attr = v.slot.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const c = new THREE.Color(level === 1 ? COLORS.hover : level === 2 ? COLORS.selected : v.body.kind === "face" ? COLORS.region : COLORS.solid);
    const [a, b] = fi < 0 ? [0, v.vertexCount] : [v.faceV[fi * 2], v.faceV[fi * 2 + 1]];
    const arr = attr.array as Float32Array;
    for (let k = (v.slot.vOffset + a) * 3; k < (v.slot.vOffset + b) * 3; k += 3) {
      arr[k] = c.r;
      arr[k + 1] = c.g;
      arr[k + 2] = c.b;
    }
    attr.needsUpdate = true;
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
      if (orig) {
        orig.group.visible = false;
        this.markDirty(id);
      }
    }
    this.requestRender();
  }

  clearGhost(): void {
    for (const child of [...this.ghostRoot.children]) {
      child.removeFromParent();
      child.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    }
    for (const [id, v] of this.views) {
      const vis = !this.hidden.has(id);
      if (v.group.visible !== vis) this.markDirty(id);
      v.group.visible = vis;
    }
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

  /** Semi-transparent (x-ray) solids: hidden faces and edges show through. */
  xray = false;
  setXray(on: boolean): void {
    this.xray = on;
    for (const m of [this.batchMats.solid, ...this.mats.faces]) {
      m.transparent = on;
      m.opacity = on ? 0.8 : 1;
      m.depthWrite = !on;
      m.needsUpdate = true;
    }
    this.requestRender();
  }

  setView(name: "top" | "front" | "right" | "iso"): void {
    const dirs: Record<string, V3> = { top: [0, -1e-4, 1], front: [0, -1, 0], right: [1, 0, 0], iso: [1, -1.2, 0.9] };
    const dist = this.camera.position.distanceTo(this.controls.target);
    const dir = new THREE.Vector3(...dirs[name]).normalize();
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    this.controls.update();
  }

  /** Look from the opposite side (top ↔ bottom, front ↔ back, right ↔ left...). */
  flipView(): void {
    const off = this.camera.position.clone().sub(this.controls.target);
    this.camera.position.copy(this.controls.target).sub(off);
    this.controls.update();
  }

  // ------------------------------------------------------------ transform gizmo

  get gizmoHot(): boolean {
    return this.tc.object !== undefined && this.tc.axis !== null;
  }

  get transforming(): boolean {
    return this.tc.object !== undefined;
  }

  startTransform(mode: "translate" | "rotate", ids: number[], snapStep: number, onEnd: (r: TransformResult) => void, pivotAt?: V3): void {
    const box = new THREE.Box3();
    for (const id of ids) {
      const v = this.views.get(id);
      if (v) box.expandByObject(v.mesh);
    }
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    if (pivotAt) c.set(...pivotAt);
    else if (snapStep > 0) c.set(Math.round(c.x / snapStep) * snapStep, Math.round(c.y / snapStep) * snapStep, Math.round(c.z / snapStep) * snapStep);
    this.pivot.position.copy(c);
    this.pivot.quaternion.identity();
    this.pivot.updateMatrixWorld();
    this.xfStart.copy(c);
    this.xfIds = ids;
    this.setXfSet(ids);
    this.xfMode = mode;
    this.xfEnd = onEnd;
    this.tc.setMode(mode);
    this.xfSnapStep = snapStep;
    this.updateXfSnap(false);
    this.tc.attach(this.pivot);
    this.requestRender();
  }

  stopTransform(): void {
    this.tc.detach();
    this.resetBodyMatrices();
    this.xfIds = [];
    this.setXfSet([]);
    this.xfEnd = null;
    this.requestRender();
  }

  private setXfSet(ids: number[]): void {
    const changed = new Set([...this.xfSet, ...ids]);
    this.xfSet = new Set(ids);
    for (const id of changed) {
      const v = this.views.get(id);
      if (!v) continue;
      this.placeView(v);
      this.markDirty(id);
    }
  }

  private resetBodyMatrices(): void {
    for (const v of this.views.values()) {
      v.group.matrixAutoUpdate = true;
      v.group.position.set(0, 0, 0);
      v.group.quaternion.identity();
      v.group.updateMatrix();
    }
  }

  private xfPointer: { x: number; y: number; ctrl: boolean } | null = null;
  private xfSnapStep = 0;

  /** Gizmo snapping (grid / 15° / object points) is active only while Ctrl is held. */
  private updateXfSnap(ctrl: boolean): void {
    const on = ctrl && this.xfSnapStep > 0;
    this.tc.setTranslationSnap(on ? this.xfSnapStep : null);
    this.tc.setRotationSnap(on ? THREE.MathUtils.degToRad(15) : null);
  }

  /** During a move drag, pull the pivot onto a nearby object snap point (only along the dragged axes). */
  private snapPivot(): void {
    if (this.xfMode !== "translate" || !this.tc.dragging || !this.xfPointer) return;
    const ptr = this.xfPointer;
    const axis = this.tc.axis ?? "";
    const sp = ptr.ctrl ? this.snapPoint(ptr.x, ptr.y, this.xfSet) : null;
    if (sp) {
      const p = this.pivot.position;
      if (axis.includes("X")) p.x = sp.point.x;
      if (axis.includes("Y")) p.y = sp.point.y;
      if (axis.includes("Z")) p.z = sp.point.z;
    }
    this.showSnapMarker(sp);
  }

  /** Show `ids` displaced by `d` (null clears). Used by the base-point Move tool. */
  previewOffset(ids: number[], d: THREE.Vector3 | null): void {
    if (!d) {
      this.resetBodyMatrices();
      if (this.xfSet.size) this.setXfSet([]);
      this.requestRender();
      return;
    }
    if (this.xfSet.size !== ids.length || ids.some((id) => !this.xfSet.has(id))) this.setXfSet(ids);
    for (const id of ids) {
      const v = this.views.get(id);
      if (!v) continue;
      v.group.matrixAutoUpdate = false;
      v.group.matrix.makeTranslation(d.x, d.y, d.z);
      v.group.matrixWorldNeedsUpdate = true;
    }
    this.requestRender();
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
