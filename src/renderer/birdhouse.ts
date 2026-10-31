/** Help → Bird House: a gable bird house on a bevelled base (see tutorials.ts). */
import {
  booleanOp,
  chamferEdges,
  edgeBetween,
  extrudeFace,
  makeBox,
  makeCylinder,
  moveEdges,
  offsetFace,
  shellSolid,
  splitFaceByLine,
  type Frame,
  type Solid,
} from "./kernel";
import type { Body, Doc } from "./document";
import { GROUND, addSolid, faceWith, replaceShape as replace, roleBody as body, type TutCtx, type Tutorial } from "./tutorials";

/** The house's front face (looking from the front view, Num 1): outward normal −Y, its "up" is +Z. */
const FRONT: Frame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], z: [0, -1, 0] };

// Sizes (mm). The base is centred on the origin, the house centred on the base.
const BASE = 160, BASE_H = 15, BEVEL = 3;
const HOUSE = 110, WALL_H = 130, RIDGE = 55, WALL = 8;
const HOLE_R = 18, HOLE_Z = BASE_H + 85;
const PERCH_W = 30, PERCH_T = 12, PERCH_L = 25, PERCH_Z = HOLE_Z - HOLE_R - 15;
const ROOF_T = 15; // board thickness = overhang: on a 45° roof the two boards then meet flush at the ridge

const EAVE_Z = BASE_H + WALL_H;
const FRONT_Y = -HOUSE / 2;

const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;

const S = Math.SQRT1_2;

/** A roof board on one slope: Offset the slope face by ROOF_T, Push/Pull it out ROOF_T. */
function roofBoard(doc: Doc, ctx: TutCtx, side: "roofL" | "roofR", label: string): void {
  const house = body(doc, ctx, "house");
  const slope = faceWith(house.shape, [side === "roofL" ? -S : S, 0, S]);
  const face = offsetFace(house.shape, slope, ROOF_T);
  addSolid(doc, ctx, side, extrudeFace(face, face.faces[0].hashCode, ROOF_T), "Roof board", label);
}

export const BIRD_HOUSE: Tutorial = {
  title: "Bird house",
  steps: [
    {
      title: "Base plate",
      how: "<kbd>B</kbd> <kbd>B</kbd> (Box), hover the grid, <kbd>Tab</kbd>: Width <b>160</b>, Depth <b>160</b>, Height <b>15</b> → Create.",
      run(doc, ctx, label) {
        addSolid(doc, ctx, "base", makeBox(GROUND, [0, 0, 0], BASE, BASE, BASE_H), "Base", label);
      },
    },
    {
      title: "Bevel the base",
      how: "<kbd>3</kbd> (Edge mode), click one top edge of the base, <kbd>Shift</kbd>-click the other three, <kbd>Shift</kbd>+<kbd>F</kbd> (Chamfer) <b>3</b> → Enter.",
      run(doc, ctx, label) {
        const base = body(doc, ctx, "base");
        const top = new Set(base.shape.edges.filter((e) => near(e.startPoint.z, BASE_H) && near(e.endPoint.z, BASE_H)).map((e) => e.hashCode));
        replace(doc, base.id, chamferEdges(base.shape as Solid, top, BEVEL), label);
      },
    },
    {
      title: "House block",
      how: "<kbd>B</kbd> <kbd>B</kbd> on the base's top face, <kbd>Tab</kbd>: <b>110</b> × <b>110</b> × <b>130</b> → Create. Centre it: <kbd>Shift</kbd>+<kbd>G</kbd> and drag its bottom-centre mark onto the base's top-centre mark.",
      run(doc, ctx, label) {
        addSolid(doc, ctx, "house", makeBox(GROUND, [0, 0, BASE_H], HOUSE, HOUSE, WALL_H), "House", label);
      },
    },
    {
      title: "Ridge line",
      how: "<b>Divide face</b> (toolbar, next to Measure): click the <b>midpoint</b> of the front top edge, then of the back top edge (midpoints snap). The new edge is selected.",
      run(doc, ctx, label) {
        const h = body(doc, ctx, "house");
        replace(doc, h.id, splitFaceByLine(h.shape as Solid, [0, FRONT_Y, EAVE_Z], [0, -FRONT_Y, EAVE_Z]), label);
      },
    },
    {
      title: "Gable roof",
      how: "With the ridge edge selected: <kbd>G</kbd>, <kbd>Tab</kbd>: ΔZ <b>55</b> → Enter. The top becomes two 45° slopes.",
      run(doc, ctx, label) {
        const h = body(doc, ctx, "house");
        const ridge = edgeBetween(h.shape, [0, FRONT_Y, EAVE_Z], [0, -FRONT_Y, EAVE_Z]);
        if (ridge === null) throw new Error("The ridge edge is missing — do the ridge line step first");
        replace(doc, h.id, moveEdges(h.shape as Solid, new Set([ridge]), [0, 0, RIDGE]), label);
      },
    },
    {
      title: "Hollow it",
      how: "The base covers the house's bottom face: hide it with the eye icon next to <b>Base 1</b> in the <b>Bodies</b> list (right). <kbd>2</kbd> (Face mode), <kbd>V</kbd> <kbd>V</kbd> (bottom view), click the house's bottom face, <kbd>H</kbd> (Shell) thickness <b>8</b> → Enter. Click the eye again to show the base, <kbd>5</kbd> back to iso.",
      run(doc, ctx, label) {
        const h = body(doc, ctx, "house");
        const bottom = faceWith(h.shape, [0, 0, -1]);
        replace(doc, h.id, shellSolid(h.shape as Solid, new Set([bottom]), WALL), label);
      },
    },
    {
      title: "Entrance hole",
      how: "<kbd>B</kbd> <kbd>C</kbd> (Cylinder): click the centre on the front face <b>85</b> above the base, radius <b>18</b> Enter, height <b>-20</b> Enter (into the wall). <kbd>1</kbd>, click the house, <kbd>Shift</kbd>-click the cylinder, <kbd>−</kbd> (Subtract).",
      run(doc, ctx, label) {
        const h = body(doc, ctx, "house");
        const drill = makeCylinder(FRONT, [0, FRONT_Y, HOLE_Z], HOLE_R, -20);
        replace(doc, h.id, booleanOp("subtract", h.shape as Solid, [drill]), label);
      },
    },
    {
      title: "Perch",
      how: "<kbd>B</kbd> <kbd>B</kbd> on the front face under the hole, <kbd>Tab</kbd>: <b>30</b> × <b>12</b> × <b>25</b> → Create (centre it with <kbd>G</kbd>). Click the house, <kbd>Shift</kbd>-click the perch, <kbd>+</kbd> (Union).",
      run(doc, ctx, label) {
        const h = body(doc, ctx, "house");
        const perch = makeBox(FRONT, [0, FRONT_Y, PERCH_Z], PERCH_W, PERCH_T, PERCH_L);
        replace(doc, h.id, booleanOp("union", h.shape as Solid, [perch]), label);
      },
    },
    {
      title: "Left roof board",
      how: "<kbd>2</kbd>, click the left roof slope, <kbd>O</kbd> (Offset) <b>15</b> → Enter (a bigger face on the slope), then <kbd>P</kbd> (Push/Pull), <kbd>Tab</kbd>: <b>15</b> → Enter.",
      run: (doc, ctx, label) => roofBoard(doc, ctx, "roofL", label),
    },
    {
      title: "Right roof board",
      how: "The same on the right slope: <kbd>2</kbd>, click it, <kbd>O</kbd> <b>15</b>, <kbd>P</kbd>, <kbd>Tab</kbd>: <b>15</b>. The boards meet flush at the ridge.",
      run: (doc, ctx, label) => roofBoard(doc, ctx, "roofR", label),
    },
    {
      title: "Join the roof",
      how: "<kbd>1</kbd>, click one board, <kbd>Shift</kbd>-click the other, <kbd>+</kbd> (Union). Done — <kbd>Ctrl</kbd>+<kbd>S</kbd> to save, File → Export STL to print.",
      run(doc, ctx, label) {
        const l = body(doc, ctx, "roofL"), r = body(doc, ctx, "roofR");
        const roof = { ...l, name: "Roof", shape: booleanOp("union", l.shape as Solid, [r.shape as Solid]) } as Body;
        doc.commit(doc.bodies.filter((b) => b.id !== r.id).map((b) => (b.id === l.id ? roof : b)), label);
      },
    },
  ],
};
