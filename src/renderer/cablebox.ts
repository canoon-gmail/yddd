/** Help → Cable Storage Box: an open box with rounded outer corners and 4 compartments (see tutorials.ts). */
import { booleanOp, filletEdges, makeBox, shellSolid, type Solid } from "./kernel";
import type { Body } from "./document";
import { GROUND, addSolid, faceWith, replaceShape, roleBody, type Tutorial } from "./tutorials";

// Sizes (mm). The box is centred on the origin, standing on the ground, long side along X.
const L = 240, W = 120, H = 60, WALL = 4, CORNER = 8, DIVIDERS = 3;
const IN_L = L - 2 * WALL, IN_W = W - 2 * WALL, IN_H = H - WALL;
/** Width of each compartment: the inside length less the dividers, shared out evenly (55). */
const BAY = (IN_L - DIVIDERS * WALL) / (DIVIDERS + 1);
/** Centre X of divider `i` (0-based). */
const dividerX = (i: number) => -IN_L / 2 + (i + 1) * BAY + i * WALL + WALL / 2;

const divider = (i: number): Solid => makeBox(GROUND, [dividerX(i), 0, WALL], WALL, IN_W, IN_H);

export const CABLE_STORAGE_BOX: Tutorial = {
  title: "Cable storage box",
  steps: [
    {
      title: "Box",
      how: `<kbd>B</kbd> <kbd>B</kbd> (Box), hover the grid, <kbd>Tab</kbd>: Width <b>${L}</b>, Depth <b>${W}</b>, Height <b>${H}</b> → Create.`,
      run: (doc, ctx, label) => addSolid(doc, ctx, "box", makeBox(GROUND, [0, 0, 0], L, W, H), "Box", label),
    },
    {
      title: "Hollow it, open at the top",
      how: `<kbd>2</kbd> (Face mode), click the top face, <kbd>H</kbd> (Shell) thickness <b>${WALL}</b> → Enter. The walls and floor are ${WALL} mm.`,
      run(doc, ctx, label) {
        const box = roleBody(doc, ctx, "box");
        replaceShape(doc, box.id, shellSolid(box.shape as Solid, new Set([faceWith(box.shape, [0, 0, 1])]), WALL), label);
      },
    },
    {
      title: "Round the outer corners",
      how: `<kbd>3</kbd> (Edge mode), click one <b>outside</b> vertical corner edge, <kbd>Shift</kbd>-click the other three, <kbd>F</kbd> (Fillet) radius <b>${CORNER}</b> → Enter. The inside corners stay square.`,
      run(doc, ctx, label) {
        const box = roleBody(doc, ctx, "box");
        const outer = new Set(
          box.shape.edges
            .filter((e) => {
              const a = e.startPoint, b = e.endPoint;
              return Math.abs(a.z - b.z) > 1 && Math.abs(Math.abs(a.x) - L / 2) < 1e-6 && Math.abs(Math.abs(a.y) - W / 2) < 1e-6;
            })
            .map((e) => e.hashCode),
        );
        replaceShape(doc, box.id, filletEdges(box.shape as Solid, outer, CORNER), label);
      },
    },
    {
      title: "First divider",
      how: `<kbd>B</kbd> <kbd>B</kbd>, hold <kbd>Ctrl</kbd> and click the inside floor corner at the <b>back left</b> (easy to see in the iso view, <kbd>5</kbd>), move the mouse a little into the box, <kbd>Tab</kbd>: Width <b>${WALL}</b>, Depth <b>${IN_W}</b>, Height <b>${IN_H}</b> → Create (flush with the rim). Then <kbd>G</kbd>, <kbd>Tab</kbd>: ΔX <b>${BAY}</b> → Enter: the first compartment is ${BAY} mm wide.`,
      run: (doc, ctx, label) => addSolid(doc, ctx, "divider 1", divider(0), "Divider", label),
    },
    {
      title: "More dividers",
      how: `With the divider selected: <kbd>Shift</kbd>+<kbd>D</kbd> (Duplicate), <kbd>Tab</kbd>: ΔX <b>${BAY + WALL}</b> → Enter, then <kbd>Shift</kbd>+<kbd>R</kbd> (Repeat) for the third. Four equal compartments.`,
      run(doc, ctx, label) {
        const made = [1, 2].map((i) => doc.makeBody(divider(i), "Divider"));
        made.forEach((b, k) => ctx.set(`divider ${k + 2}`, b.id));
        doc.commit([...doc.bodies, ...made], label);
      },
    },
    {
      title: "Join into one part",
      how: "<kbd>1</kbd>, click the box, <kbd>Shift</kbd>-click the three dividers, <kbd>+</kbd> (Union). Done — <kbd>Ctrl</kbd>+<kbd>S</kbd> to save, File → Export STL to print.",
      run(doc, ctx, label) {
        const box = roleBody(doc, ctx, "box");
        const divs = [1, 2, 3].map((i) => roleBody(doc, ctx, `divider ${i}`));
        const joined = booleanOp("union", box.shape as Solid, divs.map((d) => d.shape as Solid));
        const gone = new Set(divs.map((d) => d.id));
        doc.commit(doc.bodies.filter((b) => !gone.has(b.id)).map((b) => (b.id === box.id ? ({ ...b, name: "Cable box", shape: joined } as Body) : b)), label);
      },
    },
  ],
};
