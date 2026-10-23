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
import type { Body, Dimension } from "./document";
import { deg, num } from "./format";
import { tessellate, kindOf, curvedFaceCenter, nearestOnEdge, rigidSource, movedIds, isMesh, type Geom, type Shape, type Tessellation, type TriMesh, type V3 } from "./kernel";

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
  /** `inner`: points inside the body (sphere centres) — snappable through the body's own surface. */
  snaps?: { pts: Float64Array; kinds: Uint8Array; inner: Uint8Array; proj: Float32Array | null; projStamp: number };
}

/** Object snap kinds, in priority order. */
/** Turned axes for the move gizmo (unit, at right angles), e.g. Z along a circle's axis. */
export interface GizmoFrame {
  x: V3;
  y: V3;
  z: V3;
  /** From the gizmo along X to the axis (a circle's radius): a dashed line is drawn along Z there. */
  toAxis?: number;
}

export type SnapKind = "vertex" | "center" | "midpoint" | "axis" | "edge";
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
const COLORS = { solid: 0x9aa5b1, region: 0x6f9bd1, hover: 0xc0c4c8, selected: 0xf0d78c };

/**
 * An angle dimension's lines: an arc of radius r round `vertex` from the arm towards `a` to the arm
 * towards `c`, arrowheads at both ends, the arms drawn out to the arc where it lies past them; the
 * text ("90°") goes mid-arc. Null if an arm has no length or the arms are in line.
 */
function angleDimLines(a: THREE.Vector3, vertex: THREE.Vector3, c: THREE.Vector3, r: number): { pts: THREE.Vector3[]; text: string; at: THREE.Vector3 } | null {
  const u = a.clone().sub(vertex), v = c.clone().sub(vertex);
  const lu = u.length(), lv = v.length();
  if (lu < 1e-9 || lv < 1e-9 || !(r > 1e-9)) return null;
  u.divideScalar(lu);
  v.divideScalar(lv);
  const th = u.angleTo(v);
  if (th < 1e-6 || Math.PI - th < 1e-6) return null;
  const at = (t: number) => u.clone().multiplyScalar(Math.sin((1 - t) * th)).add(v.clone().multiplyScalar(Math.sin(t * th))).divideScalar(Math.sin(th));
  const steps = Math.max(8, Math.ceil(th / 0.05)), pts: THREE.Vector3[] = [];
  for (let k = 0; k < steps; k++) pts.push(at(k / steps).multiplyScalar(r).add(vertex), at((k + 1) / steps).multiplyScalar(r).add(vertex));
  const over = Math.max(1, r * 0.08);
  for (const [dir, l] of [[u, lu], [v, lv]] as const) if (r + over > l) pts.push(vertex.clone().addScaledVector(dir, l), vertex.clone().addScaledVector(dir, r + over));
  // Arrowheads at both ends, barbs back along the arc.
  const arrow = Math.min(r * th * 0.2, Math.max(1, r * 0.08));
  const n = u.clone().cross(v).normalize();
  for (const [dir, s] of [[u, 1], [v, -1]] as const) {
    const p = vertex.clone().addScaledVector(dir, r), tan = n.clone().cross(dir).multiplyScalar(s);
    for (const w of [1, -1]) pts.push(p, p.clone().addScaledVector(tan, arrow).addScaledVector(dir, w * arrow * 0.35));
  }
  return { pts, text: deg(THREE.MathUtils.radToDeg(th)), at: at(0.5).multiplyScalar(r).add(vertex) };
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
  private batchRoot = new THREE.Group();
  private chunks: Chunk[] = [];
  private xfSet = new Set<number>();
  private hl = { sel: [] as SelItem[], hover: null as SelItem | null, painted: new Set<number>() };
  /** Object mode: glow round the outline of the hovered body (silver) and selected bodies (blue). */
  private glowBody: number | null = null;
  private glowSel: number[] = [];
  /** While moving / rotating: the preview's matrix, so the selected bodies' glow follows it. */
  private glowXf: { ids: Set<number>; matrix: THREE.Matrix4 } | null = null;
  private glow: SilhouetteGlow | null = null;
  private batchMats = {
    solid: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, metalness: 0.05, roughness: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
    region: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, metalness: 0, roughness: 0.7, side: THREE.DoubleSide, transparent: true, opacity: 0.87, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  };
  private ghostRoot = new THREE.Group();
  private overlayRoot = new THREE.Group();
  private guideRoot = new THREE.Group();
  private dimRoot = new THREE.Group();
  /** Dimension text labels (HTML over the canvas) and the 3D point each one sits at. */
  private dimLabels: { el: HTMLElement; at: THREE.Vector3 }[] = [];
  private dimLabelBox: HTMLElement | null = null;
  /** Clicking a dimension's text (index into the list given to setDimensions; -1 = the preview). */
  onDimensionClick: ((i: number) => void) | null = null;
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
  private xfChange: ((d: V3) => void) | null = null;

  /** Shared materials, also used by tools for previews. */
  readonly mats = {
    faces: [
      new THREE.MeshStandardMaterial({ color: 0x9aa5b1, metalness: 0.05, roughness: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
      new THREE.MeshStandardMaterial({ color: 0xc0c4c8, metalness: 0.05, roughness: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
      new THREE.MeshStandardMaterial({ color: 0xf0d78c, metalness: 0.05, roughness: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
    ],
    // Flat face bodies: bluish, pulled slightly toward the camera so they win over
    // coplanar solid faces / the grid.
    regionFaces: [
      new THREE.MeshStandardMaterial({ color: 0x6f9bd1, metalness: 0, roughness: 0.7, side: THREE.DoubleSide, transparent: true, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      new THREE.MeshStandardMaterial({ color: 0xc0c4c8, metalness: 0, roughness: 0.7, side: THREE.DoubleSide, transparent: true, opacity: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      new THREE.MeshStandardMaterial({ color: 0xf0d78c, metalness: 0, roughness: 0.7, side: THREE.DoubleSide, transparent: true, opacity: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    ],
    edge: new LineMaterial({ color: 0x15171a, linewidth: 1.4 }),
    /** Paths (open lines from a sketch): bright, so they show on the dark background and on solids. */
    pathEdge: new LineMaterial({ color: 0xff69b4, linewidth: 2.4 }),
    edgeHover: new LineMaterial({ color: 0xe2e5e8, linewidth: 3.5 }),
    edgeSelected: new LineMaterial({ color: 0xffe08a, linewidth: 3.5 }),
    outlineHover: new LineMaterial({ color: 0x7cc4ff, linewidth: 2 }),
    outlineSelected: new LineMaterial({ color: 0x1e88ff, linewidth: 2 }),
    previewFill: new THREE.MeshStandardMaterial({ color: 0x5aa9ff, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }),
    previewLine: new THREE.LineBasicMaterial({ color: 0x8fd3ff, depthTest: false, transparent: true }),
    cursor: new THREE.MeshBasicMaterial({ color: 0xffe066, depthTest: false, transparent: true }),
    // Snap markers (square = corner, circle = centre, ...): fat lines, a plain line is always 1px.
    snapMarker: new LineMaterial({ color: 0x4ade80, linewidth: 2.5, depthTest: false, transparent: true }),
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

    this.scene.add(this.makeGrid(), this.batchRoot, this.bodyRoot, this.ghostRoot, this.overlayRoot, this.guideRoot, this.dimRoot);

    this.hoverEdges = this.makeOverlayLines(this.mats.edgeHover);
    this.selEdges = this.makeOverlayLines(this.mats.edgeSelected);
    this.selOutline = this.makeOverlayLines(this.mats.outlineSelected);
    this.hoverOutline = this.makeOverlayLines(this.mats.outlineHover);
    this.scene.add(this.selEdges, this.hoverEdges, this.selOutline, this.hoverOutline);

    this.controls = new OrbitControls(this.camera, this.canvas);
    // Requirements:
    // 1) No right mouse drag (disabled)
    // 2) Middle mouse drag or Alt + Left drag = Orbit (ROTATE) — Alt for touchpads / mice without a middle button
    // 3) Shift + Left mouse drag = Pan (PAN)
    // Two-finger slide on a touchpad arrives as the wheel: zoom.
    // Normal Left click/drag is reserved for select / draw tools (not camera orbit).
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: -1,
    } as unknown as OrbitControls["mouseButtons"];

    // Prevent regular Left-drag from rotating the view:
    // Only allow Left-button actions when Shift (PAN) or Alt (orbit) is held down.
    this.canvas.addEventListener("pointerdown", (e) => {
      if (this.viewLocked) {
        // Sketch: the view stays square to the plane — pan and zoom only.
        this.controls.enableRotate = false;
      } else if (e.button === 0 && !e.shiftKey && !e.altKey) {
        // Normal left-click: temporarily disable rotate on OrbitControls for this gesture
        this.controls.enableRotate = false;
      } else {
        this.controls.enableRotate = true;
      }
      // Alt + Left drag orbits even over the move / rotate gizmo.
      if (e.button === 0 && e.altKey) this.tc.enabled = false;
      // Ctrl + Left is snapping (tools, dragged points), not pan (OrbitControls would pan): only Shift pans.
      if (e.button === 0 && (e.ctrlKey || e.metaKey) && !e.shiftKey) this.controls.enablePan = false;
    }, { capture: true });

    window.addEventListener("pointerup", () => {
      this.controls.enableRotate = true;
      this.controls.enablePan = true;
      this.tc.enabled = true;
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
    this.tc.setSize(0.75);
    // A little see-through, so the model shows behind it (the handle under the cursor still turns solid).
    const gizmoMats = new Set<THREE.Material>();
    this.tc.getHelper().traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (m) for (const x of Array.isArray(m) ? m : [m]) gizmoMats.add(x);
    });
    for (const m of gizmoMats) {
      m.transparent = true;
      m.opacity *= 0.7;
    }
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
      this.gridSteps();
      this.snapPivot();
      this.applyPivotToBodies();
      if (this.xfChange && this.xfMode === "translate") {
        const d = this.pivot.position.clone().sub(this.xfStart);
        this.xfChange([d.x, d.y, d.z]);
      }
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
    for (const m of [this.mats.edge, this.mats.pathEdge, this.mats.edgeHover, this.mats.edgeSelected, this.mats.outlineHover, this.mats.outlineSelected, this.mats.snapMarker, ...this.glowMats.values()]) m.resolution.set(this.width, this.height);
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
    this.renderGlow();
    this.renderOverlay();
    this.renderInset();
    this.placeDimLabels();
  }

  // ------------------------------------------------------------ sketch view

  /** Orbit off (pan / zoom still work): the sketch view stays square to its plane. */
  viewLocked = false;

  /** The camera, to put it back after a sketch. */
  cameraState(): { position: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3 } {
    return { position: this.camera.position.clone(), target: this.controls.target.clone(), up: this.camera.up.clone() };
  }

  restoreCamera(s: { position: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3 }): void {
    this.camera.up.copy(s.up);
    this.camera.position.copy(s.position);
    this.controls.target.copy(s.target);
    this.camera.lookAt(s.target);
    this.controls.update();
  }

  /**
   * Look straight at a plane (from the `normal` side) with `up` pointing up on screen, centred on
   * `center`, far enough back to see every body (or `radius` around the centre, if larger).
   */
  lookAtPlane(center: THREE.Vector3, normal: THREE.Vector3, up: THREE.Vector3, radius = 0): void {
    const box = new THREE.Box3();
    for (const v of this.views.values()) if (v.group.visible) box.expandByObject(v.mesh);
    let r = Math.max(radius, 30);
    if (!box.isEmpty()) {
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      r = Math.max(r, sphere.radius + sphere.center.distanceTo(center) * 0.5);
    }
    const dist = (r / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.1 * Math.max(1, this.height / this.width);
    this.camera.up.copy(up).normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(normal.clone().normalize(), dist);
    this.camera.lookAt(center);
    this.controls.update();
  }

  /** Small 3D preview in the top-right corner (during a sketch): an iso view of the bodies and `extra` points. */
  private inset: { camera: THREE.PerspectiveCamera; light: THREE.Light } | null = null;
  private static readonly INSET = 220;

  setInset(on: boolean, extra: THREE.Vector3[] = []): void {
    if (!on) {
      if (this.inset) this.scene.remove(this.inset.camera);
      this.inset = null;
      this.requestRender();
      return;
    }
    if (!this.inset) {
      const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100000);
      camera.up.set(0, 0, 1);
      const light = new THREE.DirectionalLight(0xffffff, 1.6);
      light.position.set(1, 1.5, 2);
      light.visible = false; // only while the inset is drawn
      camera.add(light);
      this.scene.add(camera);
      this.inset = { camera, light };
    }
    const box = new THREE.Box3();
    for (const v of this.views.values()) if (v.group.visible) box.expandByObject(v.mesh);
    for (const p of extra) box.expandByPoint(p);
    if (box.isEmpty()) box.set(new THREE.Vector3(-30, -30, 0), new THREE.Vector3(30, 30, 20));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const cam = this.inset.camera;
    const dist = (Math.max(sphere.radius, 1) / Math.sin(THREE.MathUtils.degToRad(cam.fov / 2))) * 1.1;
    cam.position.copy(sphere.center).addScaledVector(new THREE.Vector3(1, -1.2, 0.9).normalize(), dist);
    cam.near = Math.max(0.01, dist / 2000);
    cam.far = dist * 200;
    cam.lookAt(sphere.center);
    cam.updateProjectionMatrix();
    this.requestRender();
  }

  private renderInset(): void {
    if (!this.inset) return;
    const r = this.renderer, size = Viewport.INSET, m = 12;
    const x = this.width - size - m, y = this.height - size - m; // (WebGL: y from the bottom)
    const clear = r.getClearColor(new THREE.Color()), alpha = r.getClearAlpha();
    r.setScissorTest(true);
    r.setScissor(x, y, size, size);
    r.setViewport(x, y, size, size);
    r.setClearColor(0x2b2e33, 1);
    this.inset.light.visible = true;
    r.render(this.scene, this.inset.camera);
    this.inset.light.visible = false;
    r.setClearColor(clear, alpha);
    r.setScissorTest(false);
    r.setViewport(0, 0, this.width, this.height);
  }

  /** Soft glow just outside the silhouettes of the selected (blue) and hovered (silver) bodies. */
  private renderGlow(): void {
    const at = (id: number): { mesh: THREE.Mesh; matrix: THREE.Matrix4 } | null => {
      const v = this.views.get(id);
      if (!v) return null;
      v.mesh.updateWorldMatrix(true, false);
      if (this.glowXf?.ids.has(id)) return { mesh: v.mesh, matrix: this.glowXf.matrix.clone().multiply(v.mesh.matrixWorld) };
      return v.group.visible ? { mesh: v.mesh, matrix: v.mesh.matrixWorld } : null;
    };
    const sel = this.glowSel.map(at).filter((x): x is NonNullable<typeof x> => !!x);
    const hov = this.glowBody === null ? null : at(this.glowBody);
    if (!sel.length && !hov) return;
    this.glow ??= new SilhouetteGlow();
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    if (sel.length) this.glow.draw(this.renderer, this.camera, sel, size, SilhouetteGlow.SELECTED);
    if (hov) this.glow.draw(this.renderer, this.camera, [hov], size, SilhouetteGlow.HOVER);
  }

  // ------------------------------------------------------------ bodies

  /**
   * Triangles for a body whose shape is a moved / turned copy of one on screen: that one's,
   * transformed (no meshing again), with the face / edge ids of the new shape. Null otherwise.
   */
  private movedTessellation(body: Body, shown: Map<Geom, BodyView>): Tessellation | undefined {
    if (body.kind === "mesh") return undefined;
    const src = rigidSource(body.shape, (s) => shown.has(s));
    const v = src && shown.get(src.from);
    if (!src || !v || v.body.kind === "mesh") return undefined;
    const ids = movedIds(src.from, body.shape);
    if (!ids) return undefined;
    const { R, t } = src;
    const map = (a: ArrayLike<number>, shift: boolean) => {
      const out = new Array<number>(a.length);
      for (let i = 0; i < a.length; i += 3) {
        const x = a[i], y = a[i + 1], z = a[i + 2];
        for (let r = 0; r < 3; r++) out[i + r] = R[r * 3] * x + R[r * 3 + 1] * y + R[r * 3 + 2] * z + (shift ? t[r] : 0);
      }
      return out;
    };
    const g = v.mesh.geometry;
    return {
      faces: {
        vertices: map(g.attributes.position.array, true),
        normals: map(g.attributes.normal.array, false),
        triangles: Array.from(g.index!.array),
        faceGroups: v.faceIds.map((id, i) => ({ start: v.faceStarts[i], count: g.groups[i].count, faceId: ids.faces.get(id) ?? id })),
      },
      edges: {
        lines: map(v.edgePos, true),
        edgeGroups: v.edgeIds.map((id, i) => ({ start: v.edgeStarts[i], count: v.edgeCounts[i], edgeId: ids.edges.get(id) ?? id })),
      },
    };
  }

  /** How long each shape took to mesh for display (ms), to tell ahead if drawing some again will take a while. */
  private meshMs = new WeakMap<Geom, number>();

  /**
   * About how long (ms) drawing `shapes` would take: those on screen (or moved copies of them) cost
   * nothing; ones meshed before, what they took; others a guess from their faces.
   */
  drawCost(shapes: readonly Geom[]): number {
    const shown = new Set<Geom>([...this.views.values()].map((v) => v.body.shape));
    let ms = 0;
    for (const s of shapes) {
      if (shown.has(s) || rigidSource(s, (x) => shown.has(x))) continue;
      ms += this.meshMs.get(s) ?? (isMesh(s) ? s.triangleCount / 2e4 : s.faces.length * 2);
    }
    return ms;
  }

  private buildView(body: Body, preview = false, given?: Tessellation): BodyView {
    const t0 = performance.now();
    const { faces, edges } = given ?? (body.kind === "mesh" ? meshTessellation(body.shape) : tessellate(body.shape, preview));
    if (!given && !preview) this.meshMs.set(body.shape, performance.now() - t0);
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
      lines = new LineSegments2(eg, body.kind === "path" ? this.mats.pathEdge : this.mats.edge);
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

  /** Path bodies (picked by their lines: they have no faces). */
  private pathIds = new Set<number>();

  /** Bring the scene in line with the document snapshot (rebuilds only changed bodies). */
  sync(bodies: readonly Body[]): void {
    const live = new Set<number>();
    this.pathIds = new Set(bodies.filter((b) => b.kind === "path").map((b) => b.id));
    /** What's on screen, by shape: a body moved / copied from one of them reuses its triangles. */
    const shown = new Map<Geom, BodyView>();
    for (const v of this.views.values()) shown.set(v.body.shape, v);
    // Copies of a shape also (re)built here (e.g. linked copies following a filleted one) wait for it,
    // then reuse its triangles instead of meshing again.
    const pending: Body[] = [];
    for (const body of bodies) {
      live.add(body.id);
      const existing = this.views.get(body.id);
      if (!(existing && existing.body === body)) pending.push(body);
    }
    const building = new Set(pending.map((b) => b.shape));
    const waits = (b: Body) => b.kind !== "mesh" && !rigidSource(b.shape, (s) => shown.has(s)) && !!rigidSource(b.shape, (s) => building.has(s));
    const later = pending.filter(waits);
    const first = later.length ? pending.filter((b) => !later.includes(b)) : pending;
    for (const body of [...first, ...later]) {
      const existing = this.views.get(body.id);
      const chunk = existing?.chunk ?? this.chunkWithRoom();
      const moved = this.movedTessellation(body, shown);
      if (existing) this.disposeView(existing);
      const view = this.buildView(body, false, moved);
      this.views.set(body.id, view);
      view.chunk = chunk;
      chunk.ids.add(body.id);
      chunk.dirty = true;
      this.placeView(view);
      shown.set(body.shape, view);
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
      const list = members.filter((v) => (v.body.kind === "mesh" ? "solid" : v.body.kind) === kind);
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
    // Edges: solids' / faces' in one batch, paths' (drawn brighter) in another.
    for (const paths of [false, true]) {
      const list = members.filter((v) => (v.body.kind === "path") === paths);
      let ne = 0;
      for (const v of list) ne += v.edgePos.length;
      if (ne < 6) continue;
      const ep = new Float32Array(ne);
      let o = 0;
      for (const v of list) {
        ep.set(v.edgePos, o);
        o += v.edgePos.length;
      }
      const eg = new LineSegmentsGeometry();
      eg.setPositions(ep);
      const lines = new LineSegments2(eg, paths ? this.mats.pathEdge : this.mats.edge);
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

  private raycastFaces(cx: number, cy: number, only?: number, skip?: Set<number>): { view: BodyView; faceId: number; point: THREE.Vector3; distance: number } | null {
    this.setRay(cx, cy);
    const meshes: THREE.Object3D[] = [];
    for (const v of this.views.values()) if (v.group.visible && (only === undefined || v.body.id === only) && !skip?.has(v.body.id)) meshes.push(v.mesh);
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

  private pickEdge(
    cx: number,
    cy: number,
    faceDist: number | null,
    tol = EDGE_PICK_PX,
    only?: (body: number, edgeId: number) => boolean,
    /** Bodies to look at (others are skipped before their edges are projected). */
    bodies?: Set<number>,
  ): { view: BodyView; edgeId: number; point: THREE.Vector3; d: number } | null {
    const r = this.canvas.getBoundingClientRect();
    const px = cx - r.left;
    const py = cy - r.top;
    let best: { view: BodyView; edgeId: number; point: THREE.Vector3; d: number } | null = null;
    let bestD = tol;
    const pickRay = this.ray(cx, cy);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (const v of this.views.values()) {
      if (!v.group.visible || (bodies && !bodies.has(v.body.id))) continue;
      const proj = this.projected(v);
      for (let e = 0; e < v.edgeIds.length; e++) {
        if (only && !only(v.body.id, v.edgeIds[e])) continue;
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
          // Closest point of the 3D segment to the pick ray (lerping by the screen-space t is off under perspective).
          const world = new THREE.Vector3();
          pickRay.distanceSqToSegment(a, b, undefined, world);
          if (faceDist !== null) {
            const depth = this.camera.position.distanceTo(world);
            if (depth > faceDist * 1.01 + 0.05) continue; // hidden behind a face
          }
          bestD = d;
          best = { view: v, edgeId: v.edgeIds[e], point: world, d };
        }
      }
    }
    return best;
  }

  /** Nearest visible edge accepted by `only`, within `tol` pixels. */
  pickEdgeAmong(cx: number, cy: number, tol: number, only: (body: number, edgeId: number) => boolean): Pick | null {
    const hit = this.raycastFaces(cx, cy);
    const e = this.pickEdge(cx, cy, hit ? hit.distance : null, tol, only);
    return e ? { kind: "edge", body: e.view.body.id, id: e.edgeId, point: e.point } : null;
  }

  /** What is under the cursor in `mode`; with `only`, on that body alone (others are ignored, not in the way). */
  pick(cx: number, cy: number, mode: SelMode, only?: number): Pick | null {
    const hit = this.raycastFaces(cx, cy, only);
    if (mode === "edge") {
      const e = this.pickEdge(cx, cy, hit ? hit.distance : null, undefined, only === undefined ? undefined : (b) => b === only);
      return e ? { kind: "edge", body: e.view.body.id, id: e.edgeId, point: e.point } : null;
    }
    // Paths have no faces: in front of any face hit, the nearest path line picks the path.
    const path = this.pathIds.size ? this.pickEdge(cx, cy, hit ? hit.distance : null, undefined, undefined, this.pathIds) : null;
    if (path) return { kind: "body", body: path.view.body.id, id: 0, point: path.point };
    if (!hit) return null;
    // A mesh has no faces to pick: it is always picked whole.
    if (mode === "body" || hit.view.body.kind === "mesh") return { kind: "body", body: hit.view.body.id, id: 0, point: hit.point };
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
    const inner: number[] = [];
    const seen = new Set<string>();
    const add = (x: number, y: number, z: number, kind: number, isInner = 0) => {
      const key = `${kind}:${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
      if (seen.has(key)) return;
      seen.add(key);
      pts.push(x, y, z);
      kinds.push(kind);
      inner.push(isInner);
    };
    const E = v.edgePos;
    // Exact (double precision) B-rep geometry, so snapped values match the model exactly;
    // the float32 display mesh is only the fallback.
    if (v.body.kind === "mesh") return (v.snaps = { pts: new Float64Array(), kinds: new Uint8Array(), inner: new Uint8Array(), proj: null, projStamp: -1 }); // no edges / faces to snap to
    const exactEdges = new Map(v.body.shape.edges.map((ed) => [ed.hashCode, ed]));
    const exactFaces = new Map(v.body.shape.faces.map((fc) => [fc.hashCode, fc]));
    for (let e = 0; e < v.edgeIds.length; e++) {
      const s = v.edgeStarts[e], n = v.edgeCounts[e];
      if (n < 2) continue;
      const ed = exactEdges.get(v.edgeIds[e]);
      if (ed) {
        try {
          const p0 = ed.startPoint.toTuple(), p1 = ed.endPoint.toTuple();
          if (Math.hypot(p0[0] - p1[0], p0[1] - p1[1], p0[2] - p1[2]) < 1e-9) {
            // Circle / closed curve: centre = mean of evenly spaced points (exact for circles).
            let cx = 0, cy = 0, cz = 0;
            for (let k = 0; k < 16; k++) {
              const q = ed.pointAt(k / 16).toTuple();
              cx += q[0];
              cy += q[1];
              cz += q[2];
            }
            add(cx / 16, cy / 16, cz / 16, 1);
          } else {
            add(p0[0], p0[1], p0[2], 0);
            add(p1[0], p1[1], p1[2], 0);
            const m = ed.pointAt(0.5).toTuple();
            add(m[0], m[1], m[2], 2);
          }
          continue;
        } catch {
          // fall back to the display mesh below
        }
      }
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
      if (!planar) {
        // Sphere / torus: its centre (inside the body).
        const fc = exactFaces.get(v.faceIds[f]);
        const c = fc && curvedFaceCenter(fc);
        if (c) add(c[0], c[1], c[2], 1, 1);
        continue;
      }
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
      const fc = exactFaces.get(v.faceIds[f]);
      if (fc) {
        try {
          const c = fc.center.toTuple();
          add(c[0], c[1], c[2], 1);
          continue;
        } catch {
          // fall back to the mesh centroid
        }
      }
      if (A > 0) add(cx / A, cy / A, cz / A, 1);
    }
    v.snaps = { pts: Float64Array.from(pts), kinds: Uint8Array.from(kinds), inner: Uint8Array.from(inner), proj: null, projStamp: -1 };
    return v.snaps;
  }

  /** Where guide lines cross each other or a world X / Y / Z axis line (snap points, like corners). */
  private guideCrossings(): THREE.Vector3[] {
    const lines = this.guides
      .filter((_, i) => i !== this.snapSkipGuide && !this.hiddenGuides.has(i))
      .map((g) => ({ o: g.a, dir: g.b.clone().sub(g.a).normalize(), len: g.a.distanceTo(g.b) }));
    const axes = [0, 1, 2].map((k) => ({ o: new THREE.Vector3(), dir: new THREE.Vector3().setComponent(k, 1), len: Infinity, axis: true }));
    const out: THREE.Vector3[] = [];
    const all = [...lines, ...axes];
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const A = all[i], B = all[j];
        // Closest points of the two lines: o_A + s·dir_A and o_B + t·dir_B.
        const b = A.dir.dot(B.dir), den = 1 - b * b;
        if (den < 1e-9) continue; // parallel
        const w = A.o.clone().sub(B.o), d = A.dir.dot(w), e = B.dir.dot(w);
        const sA = (b * e - d) / den, tB = (e - b * d) / den;
        const tol = 1e-6 * Math.max(1, A.len === Infinity ? 0 : A.len, B.len === Infinity ? 0 : B.len);
        const within = (t: number, len: number) => len === Infinity || (t >= -tol && t <= len + tol);
        if (!within(sA, A.len) || !within(tB, B.len)) continue;
        const pA = A.o.clone().addScaledVector(A.dir, sA), pB = B.o.clone().addScaledVector(B.dir, tB);
        if (pA.distanceTo(pB) <= tol) out.push(pA);
      }
    }
    return out;
  }

  /** Is `point` behind a visible solid (not counting `skip`), seen from the eye? Points on a face are not; in X-ray none are. */
  private hiddenFrom(point: THREE.Vector3, skip?: Set<number>): boolean {
    if (this.xray) return false;
    const meshes: THREE.Object3D[] = [];
    for (const v of this.views.values()) if (v.group.visible && !skip?.has(v.body.id)) meshes.push(v.mesh);
    if (!meshes.length) return false;
    const eye = this.camera.position;
    const dir = point.clone().sub(eye);
    const dist = dir.length();
    const tol = Math.max(0.05, eye.distanceTo(this.controls.target) * 2e-3);
    if (dist <= tol) return false;
    this.raycaster.set(eye, dir.divideScalar(dist));
    this.raycaster.far = dist - tol;
    const hit = this.raycaster.intersectObjects(meshes, false).length > 0;
    this.raycaster.far = Infinity;
    return hit;
  }

  /**
   * Nearest visible object snap point within SNAP_PX of the cursor (vertex > centre > midpoint).
   * `axes: false` leaves out the world X / Y / Z lines (guide lines and the origin still snap).
   */
  snapPoint(cx: number, cy: number, exclude?: Set<number>, opts?: { axes?: boolean }): { point: THREE.Vector3; kind: SnapKind } | null {
    const r = this.canvas.getBoundingClientRect();
    const px = cx - r.left, py = cy - r.top;
    // (what's in front, leaving out the excluded bodies — e.g. the one being moved — so points hidden
    // behind the rest still don't count; in X-ray nothing is hidden: points behind show, so they snap)
    const faceHit = this.xray ? null : this.raycastFaces(cx, cy, undefined, exclude);
    const cands: { score: number; view: BodyView; i: number }[] = [];
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
        if (faceHit && !(s.inner[i] && faceHit.view === v)) {
          // Hidden behind a face? (allow points on the hit face itself, and the hovered body's inner centres)
          p.fromArray(s.pts, i * 3);
          if (this.camera.position.distanceTo(p) > faceHit.distance * 1.01 + 0.05) continue;
        }
        cands.push({ score, view: v, i });
      }
    }
    // The best one the eye can see: also behind a solid that isn't under the cursor (the cursor just off
    // its outline) — the hovered body's inner centres excepted, as above.
    cands.sort((a, b) => a.score - b.score);
    const best = cands.find((c) => {
      if (faceHit && c.view.snaps!.inner[c.i] && faceHit.view === c.view) return true;
      return !this.hiddenFrom(p.fromArray(c.view.snaps!.pts, c.i * 3), exclude);
    }) ?? null;
    // Where guides cross (each other or an axis): like a corner.
    let cross: { d: number; p: THREE.Vector3 } | null = null;
    for (const c of this.guideCrossings()) {
      p.copy(c).project(this.camera);
      if (p.z < -1 || p.z > 1) continue;
      const d = Math.hypot(((p.x + 1) / 2) * this.width - px, ((1 - p.y) / 2) * this.height - py);
      if (d > SNAP_PX || (cross && d >= cross.d) || (best && d >= best.score)) continue;
      if (faceHit && this.camera.position.distanceTo(c) > faceHit.distance * 1.01 + 0.05) continue;
      if (this.hiddenFrom(c, exclude)) continue;
      cross = { d, p: c };
    }
    if (cross) return { point: cross.p.clone(), kind: "vertex" };
    // World origin (0,0,0) is always a vertex-type snap point.
    p.set(0, 0, 0).project(this.camera);
    if (p.z >= -1 && p.z <= 1) {
      const d = Math.hypot(((p.x + 1) / 2) * this.width - px, ((1 - p.y) / 2) * this.height - py);
      if (d <= SNAP_PX && (!best || d < best.score)) {
        const hidden = (faceHit && this.camera.position.length() > faceHit.distance * 1.01 + 0.05) || this.hiddenFrom(p.set(0, 0, 0), exclude);
        if (!hidden) return { point: new THREE.Vector3(), kind: "vertex" };
      }
    }
    if (!best) {
      // No point nearby: the closer of an axis / guide line and anywhere along a visible edge.
      let ax = this.axisSnap(px, py, cx, cy, faceHit?.distance, opts?.axes ?? true);
      let ed = this.pickEdge(cx, cy, faceHit?.distance ?? null, SNAP_PX * 0.75, exclude?.size ? (b) => !exclude.has(b) : undefined);
      // (not one behind a solid the cursor is just off)
      if (ax && this.hiddenFrom(ax.point, exclude)) ax = null;
      if (ed && this.hiddenFrom(ed.point, exclude)) ed = null;
      if (ed && (!ax || ed.d < ax.d)) {
        // Redo the point on the exact B-rep edge (the display mesh is float32: a push/pull snapped to
        // a circle's mesh would end ~1e-6 mm off — e.g. not level with another cylinder's top).
        const body = ed.view.body;
        const exact = body.kind === "mesh" ? undefined : body.shape.edges.find((x) => x.hashCode === ed.edgeId);
        if (exact?.geomType === "LINE") {
          const a = new THREE.Vector3(...exact.startPoint.toTuple()), b = new THREE.Vector3(...exact.endPoint.toTuple());
          this.ray(cx, cy).distanceSqToSegment(a, b, undefined, ed.point);
        } else if (exact) {
          const q = body.kind === "mesh" ? null : nearestOnEdge(body.shape, ed.edgeId, ed.point.toArray() as V3);
          if (q) ed.point.set(...q);
        }
        return { point: ed.point, kind: "edge" };
      }
      return ax && { point: ax.point, kind: ax.kind };
    }
    const s = best.view.snaps!;
    return { point: new THREE.Vector3().fromArray(s.pts, best.i * 3), kind: SNAP_KINDS[s.kinds[best.i]] };
  }

  /**
   * Show the dimensions (and `preview`, one being placed): a line parallel to a–b shifted by o, with
   * arrowheads, extension lines from a and b, and the length as text in the middle.
   */
  setDimensions(list: readonly Dimension[], selected = -1, preview: Dimension | null = null): void {
    for (const c of [...this.dimRoot.children]) {
      c.removeFromParent();
      (c as THREE.LineSegments).geometry.dispose();
      ((c as THREE.LineSegments).material as THREE.Material).dispose();
    }
    if (!this.dimLabelBox) {
      this.dimLabelBox = document.createElement("div");
      this.dimLabelBox.id = "dim-labels";
      this.canvas.parentElement!.appendChild(this.dimLabelBox);
      this.dimLabelBox.addEventListener("pointerdown", (e) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>(".dim-label");
        if (!el || !this.onDimensionClick) return;
        e.stopPropagation();
        this.onDimensionClick(Number(el.dataset.i));
      });
    }
    this.dimLabelBox.innerHTML = "";
    this.dimLabels = [];
    const all: [Dimension, number][] = list.map((d, i) => [d, i]);
    if (preview) all.push([preview, -1]);
    for (const [d, i] of all) {
      const a = new THREE.Vector3(...d.a), b = new THREE.Vector3(...d.b), o = new THREE.Vector3(...d.o);
      const len = a.distanceTo(b);
      if (len < 1e-9) continue;
      const u = b.clone().sub(a).normalize();
      const color = i === selected ? 0xffd166 : i < 0 ? 0x8fd3ff : 0xe6e9ee;
      const draw = (pts: THREE.Vector3[]) => {
        const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
        lines.renderOrder = 16;
        this.dimRoot.add(lines);
      };
      const label = (text: string, at: THREE.Vector3) => {
        const el = document.createElement("div");
        el.className = `dim-label${i === selected ? " sel" : ""}${i < 0 ? " preview" : ""}`;
        el.dataset.i = String(i);
        el.textContent = text;
        this.dimLabelBox!.appendChild(el);
        this.dimLabels.push({ el, at });
      };
      if (d.kind === "angle") {
        const g = angleDimLines(a, b, new THREE.Vector3(...d.c!), d.r ?? 1);
        if (g) {
          draw(g.pts);
          label(g.text, g.at);
        }
        continue;
      }
      if (d.kind === "radius") {
        // Centre mark, a line out to the circle, an arrowhead on it pointing out; "R 10" halfway.
        const n = new THREE.Vector3(...(d.n ?? [0, 0, 1])), side = n.clone().cross(u).normalize();
        const arrow = Math.min(len * 0.25, Math.max(1, len * 0.08)), mark = arrow * 0.6;
        const pts = [a, b, a.clone().addScaledVector(u, -mark), a.clone().addScaledVector(u, mark), a.clone().addScaledVector(side, -mark), a.clone().addScaledVector(side, mark)];
        for (const w of [1, -1]) pts.push(b, b.clone().addScaledVector(u, -arrow).addScaledVector(side, w * arrow * 0.35));
        draw(pts);
        label(`R ${num(len)}`, a.clone().add(b).multiplyScalar(0.5));
        continue;
      }
      const off = o.length(), on = off > 1e-9 ? o.clone().divideScalar(off) : new THREE.Vector3();
      const a2 = a.clone().add(o), b2 = b.clone().add(o);
      const arrow = Math.min(len * 0.2, Math.max(1, len * 0.05)), over = Math.max(1, off * 0.1);
      const pts: THREE.Vector3[] = [a2, b2];
      if (off > 1e-9) {
        // Extension lines from just off the geometry to a little past the dimension line.
        const gap = Math.min(off * 0.15, 2);
        pts.push(a.clone().addScaledVector(on, gap), a2.clone().addScaledVector(on, over), b.clone().addScaledVector(on, gap), b2.clone().addScaledVector(on, over));
      }
      // Arrowheads at both ends, pointing outwards.
      const side = off > 1e-9 ? on : new THREE.Vector3(0, 0, 1).cross(u).lengthSq() > 1e-9 ? new THREE.Vector3(0, 0, 1).cross(u).normalize() : new THREE.Vector3(1, 0, 0);
      for (const [p, s] of [[a2, 1], [b2, -1]] as const) {
        for (const w of [1, -1]) pts.push(p, p.clone().addScaledVector(u, s * arrow).addScaledVector(side, w * arrow * 0.35));
      }
      draw(pts);
      label(num(len), a2.clone().add(b2).multiplyScalar(0.5));
    }
    this.requestRender();
  }

  /** Keep the dimension texts on their points (after every render: the camera may have moved). */
  private placeDimLabels(): void {
    if (!this.dimLabels.length) return;
    const p = new THREE.Vector3();
    for (const { el, at } of this.dimLabels) {
      p.copy(at).project(this.camera);
      const off = p.z < -1 || p.z > 1;
      el.style.display = off ? "none" : "";
      if (!off) el.style.transform = `translate(${((p.x + 1) / 2) * this.width}px, ${((1 - p.y) / 2) * this.height}px) translate(-50%, -50%)`;
    }
  }

  /** Guide not offered as a snap target (the one being moved), -1 = none. */
  snapSkipGuide = -1;
  /** Guides hidden via the Bodies panel eye button. */
  private hiddenGuides = new Set<number>();

  /** Show guide lines (dashed); `selected` is drawn highlighted, with a glow round it. */
  setGuides(list: readonly { a: V3; b: V3 }[], selected: number | ReadonlySet<number> = -1, hover = -1, hidden: ReadonlySet<number> = this.hiddenGuides): void {
    this.hiddenGuides = new Set(hidden);
    const isSel = (i: number) => (typeof selected === "number" ? i === selected : selected.has(i));
    for (const c of [...this.guideRoot.children]) {
      c.removeFromParent();
      c.traverse((o) => (o as THREE.Line).geometry?.dispose());
      if (c instanceof THREE.Line) (c.material as THREE.Material).dispose();
    }
    this.guides = list.map((g) => ({ a: new THREE.Vector3(...g.a), b: new THREE.Vector3(...g.b) }));
    this.guides.forEach((g, i) => {
      if (this.hiddenGuides.has(i)) return;
      const mat = new THREE.LineDashedMaterial({ color: isSel(i) ? 0xffd166 : i === hover ? 0xffffff : 0xff6fb5, dashSize: 1.5, gapSize: 1, depthTest: false, transparent: true });
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([g.a, g.b]), mat);
      l.computeLineDistances();
      l.renderOrder = 15;
      if (isSel(i)) {
        // Soft halos under the dashed line (no solid core, so it still reads as a guide).
        const glow = this.glowLine(g.a, g.b, 0xffd166, 2, 0.5);
        glow.renderOrder = 14;
        this.guideRoot.add(glow);
      }
      this.guideRoot.add(l);
    });
    this.requestRender();
  }

  /** Index of the guide line within a few pixels of the cursor, or -1. */
  guideAt(cx: number, cy: number): number {
    let best = -1, bd = 6;
    this.guides.forEach((g, i) => {
      if (this.hiddenGuides.has(i)) return;
      const seg = this.segmentToScreen(g.a, g.b);
      if (!seg) return;
      const [a, b] = seg;
      const dx = b.x - a.x, dy = b.y - a.y;
      const k = Math.max(0, Math.min(1, ((cx - a.x) * dx + (cy - a.y) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(cx - a.x - k * dx, cy - a.y - k * dy);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  /** Grid step used to round points snapped onto the world axis lines. */
  axisSnapStep = 1;

  /** Auto snap (the default): tools snap to points / grid without a key, Ctrl places freely. Off: snap only while Ctrl is held. */
  autoSnap = true;

  /** Should this pointer event snap? Auto snap flips what Ctrl does. */
  snapping(e: { ctrlKey: boolean } | null | undefined): boolean {
    return !!e?.ctrlKey !== this.autoSnap;
  }

  /** Hint text for snapping to `what` ("grid / points"), worded for the current Auto snap setting. */
  snapTip(what: string): string {
    return this.autoSnap ? `snaps to ${what}, Ctrl: free` : `hold Ctrl to snap to ${what}`;
  }

  /** Hint text for rounding to `what` ("grid steps"), worded for the current Auto snap setting. */
  stepTip(what: string): string {
    return this.autoSnap ? `${what}, Ctrl: free` : `Ctrl: ${what}`;
  }

  /** Nearest point on the world X / Y / Z axis lines under the cursor (rounded to axisSnapStep). */
  private axisSnap(px: number, py: number, cx: number, cy: number, hitDist?: number, axes = true): { point: THREE.Vector3; kind: SnapKind; d: number } | null {
    const ray = this.ray(cx, cy);
    let best: { d: number; p: THREE.Vector3 } | null = null;
    const q = new THREE.Vector3();
    const lines: { o: THREE.Vector3; dir: THREE.Vector3; len: number }[] = [
      ...(axes ? [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)] : []).map((dir) => ({ o: new THREE.Vector3(), dir, len: Infinity })),
      ...this.guides.filter((_, i) => i !== this.snapSkipGuide && !this.hiddenGuides.has(i)).map((g) => ({ o: g.a, dir: g.b.clone().sub(g.a).normalize(), len: g.a.distanceTo(g.b) })),
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
    return best ? { point: best.p, kind: best.p.lengthSq() < 1e-12 ? "vertex" : "axis", d: best.d } : null;
  }

  /** The world axis line (0 = X, 1 = Y, 2 = Z) under the cursor, or -1 (e.g. to draw a guide parallel to it). */
  axisUnder(cx: number, cy: number): number {
    const r = this.canvas.getBoundingClientRect();
    const px = cx - r.left, py = cy - r.top;
    const ray = this.ray(cx, cy);
    const q = new THREE.Vector3();
    let best = { k: -1, d: SNAP_PX };
    for (let k = 0; k < 3; k++) {
      const dir = new THREE.Vector3().setComponent(k, 1);
      const b = ray.direction.dot(dir), d = ray.direction.dot(ray.origin), e = dir.dot(ray.origin);
      const den = 1 - b * b;
      if (den < 1e-6) continue; // looking straight down this axis
      q.copy(dir).multiplyScalar((e - b * d) / den).project(this.camera);
      if (q.z < -1 || q.z > 1) continue;
      const dist = Math.hypot(((q.x + 1) / 2) * this.width - px, ((1 - q.y) / 2) * this.height - py);
      if (dist < best.d) best = { k, d: dist };
    }
    return best.k;
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

  /**
   * Centre marks of the shown bodies other than `exclude`: centres of their circles and flat faces,
   * not hidden behind a solid (the excluded ones don't hide them: they are the ones being moved).
   */
  centerTargets(exclude: Set<number>): { point: THREE.Vector3; kind: SnapKind }[] {
    const out: { point: THREE.Vector3; kind: SnapKind }[] = [];
    for (const v of this.views.values()) {
      if (exclude.has(v.body.id) || !v.group.visible) continue;
      const s = this.snapsOf(v);
      for (let i = 0; i < s.kinds.length; i++) {
        if (SNAP_KINDS[s.kinds[i]] !== "center") continue;
        const p = new THREE.Vector3().fromArray(s.pts, i * 3);
        if (!this.hiddenFrom(p, exclude)) out.push({ point: p, kind: "center" });
      }
    }
    return out;
  }

  /** Keep only points not hidden behind any body (as seen from the camera), not counting the bodies in `skip`. */
  visiblePoints<T extends { point: THREE.Vector3 }>(pts: T[], skip?: Set<number>): T[] {
    const meshes = [...this.views.values()].filter((v) => !skip?.has(v.body.id)).map((v) => v.mesh);
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
      const mk = (geo: LineSegmentsGeometry) => {
        const l = new LineSegments2(geo, this.mats.snapMarker);
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
      const geo = (arr: number[]) => new LineSegmentsGeometry().setPositions(arr);
      const cross = [-1, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0];
      const diamond = [0, -1, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, -1, 0, 0, -1, 0, 0, 0, -1, 0];
      this.snapMarker = { vertex: mk(geo(sq)), center: mk(geo(circ)), midpoint: mk(geo(tri)), axis: mk(geo(cross)), edge: mk(geo(diamond)) };
      for (const m of Object.values(this.snapMarker)) {
        m.visible = false;
        this.overlayScene.add(m);
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
  private snapMarker: Record<SnapKind, LineSegments2> | null = null;
  /** Drawn after everything else: the move gizmo (renderOrder Infinity) sits right under the
   *  cursor while dragging and would otherwise hide the snap marker. */
  private overlayScene = new THREE.Scene();

  private renderOverlay(): void {
    if (!this.overlayScene.children.some((o) => o.visible)) return;
    const auto = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.render(this.overlayScene, this.camera);
    this.renderer.autoClear = auto;
  }

  // ------------------------------------------------------------ highlighting

  setHighlight(selection: SelItem[], hover: SelItem | null): void {
    // Reset only what was painted last time.
    for (const id of this.hl.painted) this.paintBody(id, null, 0);
    this.hl.painted.clear();
    this.hl.sel = selection;
    // Object mode: a hovered (unselected) body gets a glow round its outline, nothing on the body.
    // A path has no outline to glow: its lines are drawn in the selection / hover colour instead.
    const isPath = (it: SelItem) => it.kind === "body" && this.views.get(it.body)?.body.kind === "path";
    const bodyHover = hover?.kind === "body" && !isPath(hover) && !selection.some((s) => sameItem(s, hover)) ? hover.body : null;
    this.glowBody = bodyHover;
    this.glowSel = selection.filter((s) => s.kind === "body" && !isPath(s)).map((s) => s.body);
    this.hl.hover = bodyHover === null ? hover : null;
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
    this.setOverlayLines(this.selEdges, [...edgePoints(selection), ...edgePoints(selection.filter(isPath), true)]);
    this.setOverlayLines(this.hoverEdges, hover && !isSelected ? edgePoints([hover], isPath(hover)) : []);
    // Selected bodies: gold fill + a blue glow round the outline (renderGlow), no edge lines.
    this.setOverlayLines(this.selOutline, []);
    this.setOverlayLines(this.hoverOutline, hover && !isSelected && bodyHover === null ? edgePoints([hover], true) : []);
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
    // (nothing: emptied, not just hidden — a ghost preview ending shows the selection lines again,
    // which would bring back old ones, e.g. an edge selected before the solid was moved)
    lines.geometry.dispose();
    const g = new LineSegmentsGeometry();
    if (pts.length >= 6) g.setPositions(pts);
    lines.geometry = g;
    lines.visible = pts.length >= 6;
  }

  // ------------------------------------------------------------ tool overlays & ghosts

  /** Glow line materials, one per colour and width (made once). */
  private glowMats = new Map<string, LineMaterial>();

  /**
   * A glowing line a–b (for setOverlay), e.g. the edge / axis under the cursor: wide faint halos under a thick core, on top of everything.
   * `layers` = 2 gives just the halos (e.g. round a dashed guide line); `scale` scales the line widths.
   */
  glowLine(a: THREE.Vector3, b: THREE.Vector3, color: number, layers = 3, scale = 1): THREE.Object3D {
    const group = new THREE.Group();
    ([[14, 0.18], [8, 0.35], [3.5, 1]] as const).slice(0, layers).forEach(([w, opacity], i) => {
      const width = w * scale;
      const key = `${color}:${width}`;
      let m = this.glowMats.get(key);
      if (!m) {
        m = new LineMaterial({ color, linewidth: width, transparent: true, opacity, depthTest: false, depthWrite: false });
        m.resolution.set(this.width, this.height);
        this.glowMats.set(key, m);
      }
      const g = new LineSegmentsGeometry();
      g.setPositions([a.x, a.y, a.z, b.x, b.y, b.z]);
      const line = new LineSegments2(g, m);
      line.renderOrder = i; // (halos first, the core over them)
      line.frustumCulled = false;
      group.add(line);
    });
    return group;
  }

  /** A thick line through `pts` (for setOverlay; `width` in px, on top of everything), e.g. a sketch's paths. */
  thickLine(pts: THREE.Vector3[], color: number, width: number, opacity = 1): THREE.Object3D {
    const key = `${color}:${width}:${opacity}`;
    let m = this.glowMats.get(key);
    if (!m) {
      m = new LineMaterial({ color, linewidth: width, transparent: true, opacity, depthTest: false, depthWrite: false });
      m.resolution.set(this.width, this.height);
      this.glowMats.set(key, m); // (kept the window's size with the glow lines')
    }
    const g = new LineSegmentsGeometry();
    g.setPositions(pts.slice(1).flatMap((b, i) => [pts[i].x, pts[i].y, pts[i].z, b.x, b.y, b.z]));
    const line = new LineSegments2(g, m);
    line.frustumCulled = false;
    return line;
  }

  /** Replace tool overlay objects (previous overlay geometries are disposed). */
  setOverlay(objects: THREE.Object3D[]): void {
    for (const child of [...this.overlayRoot.children]) {
      child.removeFromParent();
      child.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    }
    for (const o of objects) {
      o.renderOrder = o.userData.under ? 19 : 20; // (e.g. a sketch's picture: below its lines)
      this.overlayRoot.add(o);
    }
    this.requestRender();
  }

  /**
   * Preview operation results in place of the given bodies. Keys that are not
   * existing body ids (e.g. negative numbers) add a preview without hiding anything.
   */
  showGhost(shapes: Map<number, Shape>, hide: readonly number[] = [], hideSelection = false): void {
    this.clearGhost();
    this.selEdges.visible = !hideSelection;
    for (const id of hide) {
      const v = this.views.get(id);
      if (!v) continue;
      v.group.visible = false;
      this.markDirty(id);
    }
    let k = -1;
    for (const [id, shape] of shapes) {
      const view = this.buildView({ id: k--, name: "", kind: kindOf(shape), shape }, true);
      this.ghostRoot.add(view.group);
      const orig = this.views.get(id);
      if (orig) {
        orig.group.visible = false;
        this.markDirty(id);
      }
    }
    this.requestRender();
  }

  /**
   * Preview bodies moved / stretched by `matrix` without re-tessellating: their display meshes
   * drawn through the matrix (instant even for heavy curved bodies; exact for affine maps).
   */
  showGhostTransformed(ids: number[], matrix: THREE.Matrix4): void {
    this.clearGhost();
    for (const id of ids) {
      const orig = this.views.get(id);
      if (!orig) continue;
      const g = orig.group.clone(); // shares geometry and materials with the body's view
      g.userData.sharedGeometry = true;
      g.matrixAutoUpdate = false;
      g.matrix.copy(matrix);
      g.visible = true;
      this.ghostRoot.add(g);
      orig.group.visible = false;
      this.markDirty(id);
    }
    // The selection outline / glow follows the preview (it outlines these bodies).
    this.glowXf = { ids: new Set(ids), matrix: matrix.clone() };
    for (const l of [this.selEdges, this.selOutline]) {
      l.matrixAutoUpdate = false;
      l.matrix.copy(matrix);
      l.matrixWorldNeedsUpdate = true;
    }
    this.requestRender();
  }

  /**
   * Instant push/pull drag preview: each body's display mesh with the given faces shifted (by
   * face id → offset) and the matching vertices of their neighbours shifted along, so side faces
   * stretch to follow. Approximate (no boolean): the exact preview follows once the drag pauses.
   * `extrude`: flat face objects shown pushed out by that offset (see addGhostPrism).
   */
  showGhostDeformed(moves: Map<number, Map<number, V3>>, extrude: Map<number, V3> = new Map()): void {
    this.clearGhost();
    const key = (a: ArrayLike<number>, i: number) => `${Math.round(a[i] * 1e3)},${Math.round(a[i + 1] * 1e3)},${Math.round(a[i + 2] * 1e3)}`;
    for (const [id, faces] of moves) {
      const v = this.views.get(id);
      if (!v) continue;
      const g0 = v.mesh.geometry;
      const P = g0.attributes.position.array as Float32Array;
      // Offset per vertex position (first moved face wins where two meet).
      const shift = new Map<string, V3>();
      for (const [faceId, d] of faces) {
        const gi = v.faceIndex.get(faceId);
        if (gi === undefined) continue;
        for (let k = v.faceV[gi * 2]; k < v.faceV[gi * 2 + 1]; k++) {
          const kk = key(P, k * 3);
          if (!shift.has(kk)) shift.set(kk, d);
        }
      }
      const moved = (src: ArrayLike<number>) => {
        const out = Float32Array.from(src);
        for (let i = 0; i < out.length; i += 3) {
          const d = shift.get(key(src, i));
          if (d) {
            out[i] += d[0];
            out[i + 1] += d[1];
            out[i + 2] += d[2];
          }
        }
        return out;
      };
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(moved(P), 3));
      geom.setAttribute("normal", new THREE.BufferAttribute(Float32Array.from(g0.attributes.normal.array as Float32Array), 3));
      geom.setIndex(new THREE.BufferAttribute(Uint32Array.from(g0.index!.array as Uint32Array), 1));
      for (const g of g0.groups) geom.addGroup(g.start, g.count, g.materialIndex); // per-face materials
      const group = new THREE.Group();
      group.add(new THREE.Mesh(geom, v.mesh.material));
      if (v.edges) {
        const eg = new LineSegmentsGeometry();
        eg.setPositions(moved(v.edgePos));
        const lines = new LineSegments2(eg, this.mats.edge);
        lines.raycast = () => {};
        group.add(lines);
      }
      this.ghostRoot.add(group);
      v.group.visible = false;
      this.markDirty(id);
    }
    for (const [id, d] of extrude) this.addGhostPrism(id, d);
    this.requestRender();
  }

  /**
   * A flat face object's display mesh drawn as the solid Push/Pull would make (instant: no kernel): the face, a copy
   * moved by `d`, and walls along its outline between them.
   */
  private addGhostPrism(id: number, d: V3): void {
    const v = this.views.get(id);
    if (!v) return;
    const P = v.mesh.geometry.attributes.position.array as Float32Array;
    const I = v.mesh.geometry.index!.array as ArrayLike<number>;
    const E = v.edgePos, nv = P.length / 3, ne = E.length / 6;
    const pos = new Float32Array(P.length * 2 + ne * 12);
    pos.set(P, 0);
    for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) pos[P.length + i + k] = P[i + k] + d[k];
    const idx: number[] = [];
    for (let i = 0; i < I.length; i += 3) idx.push(I[i], I[i + 2], I[i + 1], I[i] + nv, I[i + 1] + nv, I[i + 2] + nv); // (the start face turned over)
    // Walls: a quad per outline segment (corners not shared: flat shaded; double-sided, so any winding will do)
    let o = P.length * 2;
    for (let s = 0; s < ne; s++) {
      const a = s * 6, b = a + 3, base = o / 3;
      for (const [src, up] of [[a, 0], [b, 0], [b, 1], [a, 1]] as const) for (let k = 0; k < 3; k++) pos[o++] = E[src + k] + (up ? d[k] : 0);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setIndex(idx);
    geom.computeVertexNormals();
    const mat = this.mats.faces[0]; // (looks like the solid it will be)
    const group = new THREE.Group();
    group.add(new THREE.Mesh(geom, mat));
    if (E.length >= 6) {
      const lines = new Float32Array(E.length * 2);
      lines.set(E, 0);
      for (let i = 0; i < E.length; i += 3) for (let k = 0; k < 3; k++) lines[E.length + i + k] = E[i + k] + d[k];
      const eg = new LineSegmentsGeometry();
      eg.setPositions(lines);
      const l = new LineSegments2(eg, this.mats.edge);
      l.raycast = () => {};
      group.add(l);
    }
    this.ghostRoot.add(group);
    v.group.visible = false;
    this.markDirty(id);
  }

  clearGhost(): void {
    this.glowXf = null;
    this.selEdges.visible = true;
    for (const l of [this.selEdges, this.selOutline]) {
      l.matrix.identity();
      l.matrixWorldNeedsUpdate = true;
    }
    for (const child of [...this.ghostRoot.children]) {
      child.removeFromParent();
      if (!child.userData.sharedGeometry) child.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
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

  /**
   * A 3D segment on screen, cut at the camera's near plane first: a point behind the camera
   * projects to the wrong side of the screen, so a long guide running past the camera (e.g. one
   * from an axis) would be picked along a line that isn't where it's drawn. Null if all behind.
   */
  segmentToScreen(a: THREE.Vector3, b: THREE.Vector3): [{ x: number; y: number }, { x: number; y: number }] | null {
    this.camera.updateMatrixWorld();
    const va = a.clone().applyMatrix4(this.camera.matrixWorldInverse), vb = b.clone().applyMatrix4(this.camera.matrixWorldInverse);
    // View space looks down -z; keep the part in front of the near plane (orthographic: all of it).
    const near = (this.camera as THREE.PerspectiveCamera).isPerspectiveCamera ? -(this.camera as THREE.PerspectiveCamera).near * 1.01 : Infinity;
    if (va.z > near && vb.z > near) return null;
    if (va.z > near) va.lerp(vb, (va.z - near) / (va.z - vb.z));
    else if (vb.z > near) vb.lerp(va, (vb.z - near) / (vb.z - va.z));
    const toWorld = (v: THREE.Vector3) => v.applyMatrix4(this.camera.matrixWorld);
    return [this.toScreen(toWorld(va)), this.toScreen(toWorld(vb))];
  }

  toScreen(point: THREE.Vector3): { x: number; y: number } {
    const p = point.clone().project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
  }

  /** Is a 3D point inside the viewport (with `margin` px inset from the edges so the gizmo fits)? */
  inView(point: THREE.Vector3, margin = 48): boolean {
    this.camera.updateMatrixWorld();
    const p = point.clone().project(this.camera);
    if (p.z < -1 || p.z > 1) return false;
    const mx = this.width > 2 * margin ? (2 * margin) / this.width : 0.1;
    const my = this.height > 2 * margin ? (2 * margin) / this.height : 0.1;
    return Math.abs(p.x) <= 1 - mx && Math.abs(p.y) <= 1 - my;
  }

  /**
   * The part of segment `a`–`b` inside the viewport (cut at the near/far planes and inset by `margin`
   * px from the screen edges), or null if the segment misses the viewport altogether.
   */
  private clipSegmentToView(a: THREE.Vector3, b: THREE.Vector3, margin = 48): [THREE.Vector3, THREE.Vector3] | null {
    this.camera.updateMatrixWorld();
    const va = a.clone().applyMatrix4(this.camera.matrixWorldInverse);
    const vb = b.clone().applyMatrix4(this.camera.matrixWorldInverse);
    const near = (this.camera as THREE.PerspectiveCamera).isPerspectiveCamera ? -(this.camera as THREE.PerspectiveCamera).near * 1.01 : Infinity;
    if (va.z > near && vb.z > near) return null;
    if (va.z > near) va.lerp(vb, (va.z - near) / (va.z - vb.z));
    else if (vb.z > near) vb.lerp(va, (vb.z - near) / (vb.z - va.z));
    const wa = va.applyMatrix4(this.camera.matrixWorld);
    const wb = vb.applyMatrix4(this.camera.matrixWorld);
    const pa = wa.clone().project(this.camera), pb = wb.clone().project(this.camera);
    const mx = this.width > 2 * margin ? 1 - (2 * margin) / this.width : 0.9;
    const my = this.height > 2 * margin ? 1 - (2 * margin) / this.height : 0.9;
    let t0 = 0, t1 = 1;
    const clip = (p: number, q: number): boolean => {
      if (Math.abs(p) < 1e-12) return q >= 0;
      const r = q / p;
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
      else { if (r < t0) return false; if (r < t1) t1 = r; }
      return true;
    };
    const dx = pb.x - pa.x, dy = pb.y - pa.y;
    if (!clip(-dx, pa.x + mx) || !clip(dx, mx - pa.x) || !clip(-dy, pa.y + my) || !clip(dy, my - pa.y)) return null;
    const rayAt = (t: number): THREE.Vector3 => {
      const x = pa.x + dx * t, y = pa.y + dy * t;
      this.raycaster.setFromCamera(new THREE.Vector2(x, y), this.camera);
      const out = new THREE.Vector3();
      this.raycaster.ray.distanceSqToSegment(wa, wb, undefined, out);
      return out;
    };
    return [rayAt(t0), rayAt(t1)];
  }

  /**
   * A pivot for a guide line `a`–`b`: its midpoint when that's inside the viewport, otherwise the
   * middle of the part of the guide visible in the viewport (so a long / axis guide's gizmo isn't off-screen).
   */
  guidePivot(a: V3, b: V3): V3 {
    const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
    const mid = va.clone().add(vb).multiplyScalar(0.5);
    if (this.inView(mid)) return mid.toArray() as V3;
    const seg = this.clipSegmentToView(va, vb) ?? this.clipSegmentToView(va, vb, 0);
    if (!seg) return mid.toArray() as V3;
    return this.screenMidpointOnSegment(seg[0], seg[1]).toArray() as V3;
  }

  /** Point on segment `a`–`b` whose screen projection is the midpoint of `a` and `b` on screen. */
  private screenMidpointOnSegment(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 {
    const pa = a.clone().project(this.camera), pb = b.clone().project(this.camera);
    this.raycaster.setFromCamera(new THREE.Vector2((pa.x + pb.x) / 2, (pa.y + pb.y) / 2), this.camera);
    const out = new THREE.Vector3();
    this.raycaster.ray.distanceSqToSegment(a, b, undefined, out);
    return out;
  }

  /**
   * When a long path / body has its bounding-box centre off-screen, pick a pivot on the part of its
   * edges visible in the viewport (closest to the screen centre), or null if no edge is on-screen.
   */
  private visibleEdgePivot(ids: number[]): THREE.Vector3 | null {
    const a = new THREE.Vector3(), b = new THREE.Vector3(), p = new THREE.Vector3();
    for (const margin of [48, 0]) {
      let best: { pt: THREE.Vector3; d2: number } | null = null;
      for (const id of ids) {
        const v = this.views.get(id);
        if (!v) continue;
        const E = v.edgePos;
        for (let k = 0; k + 5 < E.length; k += 6) {
          a.fromArray(E, k);
          b.fromArray(E, k + 3);
          const seg = this.clipSegmentToView(a, b, margin);
          if (!seg) continue;
          const m = this.screenMidpointOnSegment(seg[0], seg[1]);
          p.copy(m).project(this.camera);
          const d2 = p.x * p.x + p.y * p.y;
          if (!best || d2 < best.d2) best = { pt: m, d2 };
        }
      }
      if (best) return best.pt;
    }
    return null;
  }

  // ------------------------------------------------------------ camera

  /** Frame the bodies (or `ids`); `rightInset` px on the right are covered (e.g. by a panel), so centre in the rest. */
  fit(ids?: number[], rightInset = 0): void {
    const box = new THREE.Box3();
    for (const [id, v] of this.views) {
      if (!v.group.visible) continue;
      if (ids && ids.length && !ids.includes(id)) continue;
      box.expandByObject(v.mesh);
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-60, -60, 0), new THREE.Vector3(60, 60, 40));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const free = Math.max(1, this.width - rightInset);
    const dist = (Math.max(sphere.radius, 1) / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.15 * Math.max(1, this.height / free);
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist);
    if (rightInset > 0) {
      // Pan so the centre lands in the middle of the uncovered part.
      this.camera.updateMatrixWorld();
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
      const shift = right.multiplyScalar((rightInset / 2) * this.worldPerPixel(sphere.center));
      this.controls.target.add(shift);
      this.camera.position.add(shift);
    }
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

  /**
   * A body's box from its drawn triangles — instant, unlike the exact `boundingBox` (tens of ms on
   * a curved solid, every time); null if it isn't drawn (yet) or has no surface (a path).
   */
  drawnBox(id: number): THREE.Box3 | null {
    const v = this.views.get(id);
    if (!v) return null;
    const box = new THREE.Box3().setFromObject(v.mesh);
    return box.isEmpty() ? null : box;
  }

  /**
   * Attach the move/rotate gizmo to `ids` (or, with no ids, just to `pivotAt`).
   * `onChange` reports the live offset while a move is dragged.
   */
  startTransform(
    mode: "translate" | "rotate",
    ids: number[],
    snapStep: number,
    onEnd: (r: TransformResult) => void,
    pivotAt?: V3,
    onChange?: (d: V3) => void,
    frame?: GizmoFrame,
  ): void {
    const box = new THREE.Box3();
    for (const id of ids) {
      const v = this.views.get(id);
      if (!v) continue;
      // (a path has no surface — an empty mesh: its own bounds instead)
      const one = new THREE.Box3().setFromObject(v.mesh);
      if (one.isEmpty() && v.body.kind === "path") {
        const [lo, hi] = v.body.shape.boundingBox.bounds;
        one.set(new THREE.Vector3(...lo), new THREE.Vector3(...hi));
      }
      box.union(one);
    }
    if (box.isEmpty() && !pivotAt) return;
    const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    // (the pivot at the true centre, grid or not: grid snapping moves in whole steps from there — see gridSteps)
    if (pivotAt) c.set(...pivotAt);
    else if (!this.inView(c)) {
      const vis = this.visibleEdgePivot(ids);
      if (vis) c.copy(vis);
    }
    this.pivot.position.copy(c);
    // A turned frame (moves only): the gizmo's arrows along its axes, snapping in steps along them.
    const turned = mode === "translate" && frame ? frame : null;
    this.xfFrame = turned ? new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...turned.x), new THREE.Vector3(...turned.y), new THREE.Vector3(...turned.z))) : null;
    this.pivot.quaternion.copy(this.xfFrame ?? new THREE.Quaternion());
    this.tc.setSpace(this.xfFrame ? "local" : "world");
    this.pivot.updateMatrixWorld();
    // The line it slides along: dashed, through the circle's centre, seen through the solids.
    const x = turned ? new THREE.Vector3(...turned.x) : null;
    this.showXfAxis(turned && x ? c.clone().addScaledVector(x, turned.toAxis ?? 0) : null, turned ? new THREE.Vector3(...turned.z) : undefined,
      Math.max(30, 1.5 * (box.isEmpty() ? 0 : box.getSize(new THREE.Vector3()).length())));
    this.xfStart.copy(c);
    this.xfIds = ids;
    this.setXfSet(ids);
    this.xfMode = mode;
    this.xfEnd = onEnd;
    this.xfChange = onChange ?? null;
    this.tc.setMode(mode);
    this.xfSnapStep = snapStep;
    this.updateXfSnap(false);
    this.tc.attach(this.pivot);
    this.requestRender();
  }

  stopTransform(): void {
    this.tc.detach();
    this.xfFrame = null;
    this.showXfAxis(null);
    this.tc.setSpace("world");
    this.resetBodyMatrices();
    this.xfIds = [];
    this.setXfSet([]);
    this.xfEnd = null;
    this.xfChange = null;
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
  /** A turned move's axis line (see startTransform). */
  private xfAxis: THREE.Line | null = null;

  private showXfAxis(at: THREE.Vector3 | null, dir?: THREE.Vector3, half = 0): void {
    if (this.xfAxis) {
      this.xfAxis.removeFromParent();
      this.xfAxis.geometry.dispose();
      (this.xfAxis.material as THREE.Material).dispose();
      this.xfAxis = null;
    }
    if (at && dir) {
      const g = new THREE.BufferGeometry().setFromPoints([at.clone().addScaledVector(dir, -half), at.clone().addScaledVector(dir, half)]);
      const m = new THREE.LineDashedMaterial({ color: 0x3e8bff, dashSize: half / 25, gapSize: half / 50, depthTest: false, transparent: true, opacity: 0.9 });
      this.xfAxis = new THREE.Line(g, m);
      this.xfAxis.computeLineDistances();
      this.xfAxis.renderOrder = 25;
      this.xfAxis.raycast = () => {};
      this.scene.add(this.xfAxis);
    }
    this.requestRender();
  }
  /** The move gizmo's turned axes (see startTransform), or null: world X / Y / Z. */
  private xfFrame: THREE.Quaternion | null = null;

  /** An offset in the gizmo's turned axes (or world ones) — e.g. for a readout. */
  toGizmoAxes(d: V3): V3 {
    const v = new THREE.Vector3(...d);
    if (this.xfFrame) v.applyQuaternion(this.xfFrame.clone().invert());
    return [v.x, v.y, v.z];
  }
  private xfSnapStep = 0;

  /** Gizmo snapping (grid / 5° / object points) is active only while Ctrl is held. */
  private updateXfSnap(ctrl: boolean): void {
    const on = ctrl !== this.autoSnap && this.xfSnapStep > 0;
    this.tc.setTranslationSnap(on ? this.xfSnapStep : null);
    this.tc.setRotationSnap(on ? THREE.MathUtils.degToRad(5) : null);
  }

  /**
   * The gizmo's grid snapping rounds the pivot to grid lines; a pivot that started off the grid (a
   * face drawn at a guide crossing) would jump onto them: moved in whole grid steps from its start instead.
   */
  private gridSteps(): void {
    const step = this.tc.translationSnap;
    if (this.xfMode !== "translate" || !this.tc.dragging || !step) return;
    const p = this.pivot.position, s = this.xfStart;
    // (in the turned axes, if any: whole steps along them)
    const d = p.clone().sub(s);
    if (this.xfFrame) d.applyQuaternion(this.xfFrame.clone().invert());
    d.set(Math.round(d.x / step) * step, Math.round(d.y / step) * step, Math.round(d.z / step) * step);
    if (this.xfFrame) d.applyQuaternion(this.xfFrame);
    p.copy(s).add(d);
  }

  /** During a move drag, pull the pivot onto a nearby object snap point (only along the dragged axes). */
  private snapPivot(): void {
    if (this.xfMode !== "translate" || !this.tc.dragging || !this.xfPointer) return;
    const ptr = this.xfPointer;
    const axis = this.tc.axis ?? "";
    const sp = ptr.ctrl !== this.autoSnap ? this.snapPoint(ptr.x, ptr.y, this.xfSet) : null;
    if (sp) {
      // Along the dragged axes only (the turned ones, if any): the snap point's offset from the start in them.
      const inv = this.xfFrame?.clone().invert();
      const cur = this.pivot.position.clone().sub(this.xfStart), want = sp.point.clone().sub(this.xfStart);
      if (inv) {
        cur.applyQuaternion(inv);
        want.applyQuaternion(inv);
      }
      if (axis.includes("X")) cur.x = want.x;
      if (axis.includes("Y")) cur.y = want.y;
      if (axis.includes("Z")) cur.z = want.z;
      if (this.xfFrame) cur.applyQuaternion(this.xfFrame);
      this.pivot.position.copy(this.xfStart).add(cur);
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
    // (a move: just the offset — a turned gizmo's own turn isn't a rotation of the bodies)
    const d = this.pivot.position.clone().sub(this.xfStart);
    const m = this.xfMode === "translate" ? new THREE.Matrix4().makeTranslation(d.x, d.y, d.z) : this.pivot.matrixWorld.clone().multiply(start.invert());
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

/**
 * Glow round bodies' silhouettes: the bodies drawn as a white mask into an offscreen buffer, then
 * a full-screen pass colours pixels just outside the mask, fading over RADIUS px. Pixels on the
 * bodies themselves are left alone, so only the outside boundary glows.
 */
class SilhouetteGlow {
  static readonly HOVER = 0xe2e5e8;
  static readonly SELECTED = 0x1e88ff;
  static readonly RADIUS = 6; // CSS px
  private target = new THREE.WebGLRenderTarget(1, 1, { samples: 4 });
  private maskScene = new THREE.Scene();
  private maskMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  private masks: THREE.Mesh[] = [];
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat = new THREE.ShaderMaterial({
    uniforms: { mask: { value: null }, texel: { value: new THREE.Vector2() }, radius: { value: 1 }, color: { value: new THREE.Color() } },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: `
      uniform sampler2D mask; uniform vec2 texel; uniform float radius; uniform vec3 color;
      varying vec2 vUv;
      void main() {
        if (texture2D(mask, vUv).r > 0.5) discard; // on the body: no glow
        float g = 0.0;
        for (int i = 0; i < 16; i++) {
          float a = float(i) * 0.39269908; // 2π / 16
          vec2 d = vec2(cos(a), sin(a)) * texel;
          for (int j = 1; j <= 4; j++) {
            float r = radius * float(j) / 4.0;
            if (texture2D(mask, vUv + d * r).r > 0.5) g = max(g, 1.0 - (r - radius / 4.0) / radius);
          }
        }
        if (g <= 0.0) discard;
        gl_FragColor = vec4(color, g * g * 0.9);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });

  constructor() {
    this.quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat));
  }

  /** Glow of `color` round the given bodies (their display meshes, placed by `matrix`). */
  draw(renderer: THREE.WebGLRenderer, camera: THREE.Camera, bodies: { mesh: THREE.Mesh; matrix: THREE.Matrix4 }[], size: THREE.Vector2, color: number): void {
    if (this.target.width !== size.x || this.target.height !== size.y) this.target.setSize(size.x, size.y);
    while (this.masks.length < bodies.length) {
      const m = new THREE.Mesh(undefined, this.maskMat);
      m.matrixAutoUpdate = false;
      this.masks.push(m);
      this.maskScene.add(m);
    }
    this.masks.forEach((m, i) => {
      m.visible = i < bodies.length;
      if (!m.visible) return;
      m.geometry = bodies[i].mesh.geometry;
      m.matrix.copy(bodies[i].matrix);
      m.matrixWorld.copy(bodies[i].matrix); // no auto-update: place it here (the mask scene has no transform)
    });
    this.mat.uniforms.color.value.set(color);
    const clear = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(this.maskScene, camera);
    renderer.setRenderTarget(null);
    renderer.setClearColor(clear, alpha);
    this.mat.uniforms.mask.value = this.target.texture;
    this.mat.uniforms.texel.value.set(1 / size.x, 1 / size.y);
    this.mat.uniforms.radius.value = SilhouetteGlow.RADIUS * renderer.getPixelRatio();
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.quadScene, this.quadCam);
    renderer.autoClear = auto;
  }
}

/**
 * A mesh body in the same form as a B-rep tessellation: one face group (id 0) with flat-shaded
 * triangles, and no edges (drawing every triangle edge would turn a fine mesh black).
 */
function meshTessellation(m: TriMesh): ReturnType<typeof tessellate> {
  const P = m.positions, N = new Float32Array(P.length), n = P.length / 3;
  for (let i = 0; i < P.length; i += 9) {
    const ux = P[i + 3] - P[i], uy = P[i + 4] - P[i + 1], uz = P[i + 5] - P[i + 2];
    const vx = P[i + 6] - P[i], vy = P[i + 7] - P[i + 1], vz = P[i + 8] - P[i + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (let k = 0; k < 9; k += 3) {
      N[i + k] = nx;
      N[i + k + 1] = ny;
      N[i + k + 2] = nz;
    }
  }
  const T = new Uint32Array(n);
  for (let i = 0; i < n; i++) T[i] = i;
  return {
    faces: { vertices: P, normals: N, triangles: T, faceGroups: [{ start: 0, count: n, faceId: 0 }] },
    edges: { lines: [], edgeGroups: [] },
  } as unknown as ReturnType<typeof tessellate>;
}
