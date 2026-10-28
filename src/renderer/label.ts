/**
 * Label tool (+, i.e. Shift+=): two clicks. The first sets where the arrow points (corners, midpoints and centres snap;
 * else the face under the cursor, else the ground); then the text follows the mouse (on the plane through that point
 * facing the view) and the second click places it, reading "Label". Double-click its text to type the words.
 */
import * as THREE from "three";
import type { V3 } from "./kernel";
import type { Dimension } from "./document";
import type { Tool, ToolHost } from "./tools";

export const LABEL_TEXT = "Label";

export class LabelTool implements Tool {
  readonly name = "Label";
  /** Where the arrow points, once clicked. */
  private tip: THREE.Vector3 | null = null;

  constructor(
    private host: ToolHost,
    /** Show the label being placed (null hides it) / add it to the model (the tool is done then). */
    private dims: { preview: (d: Dimension | null) => void; add: (d: Dimension) => void },
  ) {}

  start(): this {
    this.host.hint("Label: click the point the arrow points at (corners, midpoints and centres snap) · Esc: exit");
    return this;
  }

  /** The point under the cursor for the arrow: a snap point, else the face, else the ground (Z = 0). */
  private pointAt(e: PointerEvent): THREE.Vector3 | null {
    const vp = this.host.viewport;
    const sp = vp.snapPoint(e.clientX, e.clientY);
    vp.showSnapMarker(sp);
    if (sp) return sp.point.clone();
    const hit = vp.pick(e.clientX, e.clientY, "face");
    if (hit) return hit.point.clone();
    return vp.ray(e.clientX, e.clientY).intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
  }

  /** Where the text goes: the cursor ray on the plane through the tip facing the view. */
  private textAt(e: PointerEvent): THREE.Vector3 | null {
    const vp = this.host.viewport, tip = this.tip!;
    const n = vp.camera.getWorldDirection(new THREE.Vector3());
    return vp.ray(e.clientX, e.clientY).intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, tip), new THREE.Vector3());
  }

  private labelTo(at: THREE.Vector3): Dimension {
    return { kind: "label", a: this.tip!.toArray() as V3, b: at.toArray() as V3, o: [0, 0, 0], text: LABEL_TEXT };
  }

  move(e: PointerEvent): void {
    if (!this.tip) {
      this.pointAt(e);
      return;
    }
    const at = this.textAt(e);
    if (at) this.dims.preview(this.labelTo(at));
  }

  down(e: PointerEvent): void {
    if (e.button !== 0) return;
    if (!this.tip) {
      const p = this.pointAt(e);
      if (!p) return this.host.hint("Label: click a point on the model or the ground");
      this.tip = p;
      this.host.viewport.showSnapMarker(null);
      this.dims.preview(this.labelTo(p));
      this.host.hint("Label: move the mouse to place the text, click to put it there · Esc: back to the first point");
      return;
    }
    const at = this.textAt(e);
    if (!at) return;
    this.dims.preview(null);
    this.dims.add(this.labelTo(at));
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === "Escape" && this.tip) {
      this.tip = null;
      this.dims.preview(null);
      this.start();
      return true;
    }
    return false;
  }

  dispose(): void {
    this.dims.preview(null);
    this.host.viewport.showSnapMarker(null);
  }
}
