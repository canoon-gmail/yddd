# Y3D

A simple, easy 3D CAD app for Linux: draw a shape, push and pull it, and get
exact sizes — no history tree or settings to learn first. Under the hood it is
a direct-modeling B-rep modeller, so models stay exact. Built with **Electron + TypeScript**, **Three.js** for the viewport and
**OpenCascade** (via [replicad](https://replicad.xyz) / WebAssembly) as the
geometry kernel. Units are millimetres, Z is up.

## Run

```bash
npm install
npm start        # type-check, build and launch
npm run dev      # Vite dev server with hot reload + Electron
npm run smoke    # automated end-to-end test, screenshots in /tmp/y3d-smoke
npm run smoke:half  # the same without scenarios 1–3 (about half the time)
npm run start:stress          # launch with 2000 test solids (N=5000 npm run start:stress for more)
```

## Features (v0.1)

| Area | What you can do |
|---|---|
| Solids | Box, Cylinder, Sphere drawn interactively on the grid **or on any planar face**, grid snapping (Ctrl = free), typed exact dimensions |
| Faces | Rectangle, Circle, Polygon (3–64 sides) create **flat faces**; **Push/Pull** a flat face to extrude it into a new solid |
| Text | **T** (or **A T**): click where it starts on the ground or a flat face (upright on a wall), type it in the panel — font (built in: Noto Sans / Serif / Sans Thai, Regular and Bold — on Linux also any installed TTF / OTF font; Thai letters work in any of them), height (a capital letter, mm), alignment, letter spacing, more lines (Shift+Enter); Enter adds a flat face per letter as one group, **P** pushes them all into raised letters; **S** scales text evenly only (it keeps its shape); the pencil by a text group in the Bodies panel edits it again — wherever it was moved / turned / scaled, flat or pushed |
| Sketch | **K**: draw lines, tangent arcs, rectangles and circles on a flat face or the ground in a flat view (3D preview in the corner); select outlines to move them (**G**) or scale / rotate them with one gizmo (**S**: squares and yellow ring scale, blue ring rotates); Done turns the closed outlines into flat faces (with holes) and open lines (ended with Enter / double-click) into **paths** |
| Select | Solid / Face / Edge modes with hover highlight, Shift+click multi-select |
| Modify | Push/Pull face (flat face → new solid; solid face → modify, or tick *New solid*), Fillet & Chamfer (selected edges or whole solid), Shell (open selected faces) — all with live preview |
| Revolve / Sweep | **Revolve** (Modify menu; Pro: **R E**) a flat face about a guide line, one of its edges or X / Y / Z (any angle; a circle beside the axis → a donut) · **Sweep** (Pro: **S W**) a flat face along a path or guide line — a flat ring makes a tube; pick the face and path in the viewport while the panel is open |
| Macro | **Box from Face**: a flat face (any outline) is the inside of an open-top box — type Wall (grows outward), Bottom (grows down) and the inside depth; optionally round vertical edges · **Box Lid** (Inside Lip / Over the Box): a lid for an open-top box, closed on it — a lip in the opening or a cap over it, with a clearance |
| Holes | **Resize hole / pin**: Edge mode, click a round hole's (or pin's) rim, **S**, type the diameter — or how much bigger for several of different sizes (a looser fit for 3D printing); any other hole — rectangle, slot, a sketched shape — one rim edge + **S**: *Bigger by* mm, all round · **Del** with rims selected fills the holes (any shape) / takes off the pins |
| Boolean | Union, Subtract, Intersect (first selected solid is the target) |
| Transform | Move / Rotate gizmo (snaps to grid / 5°), Duplicate, **Mirror** (**M**: click a ±X / ±Y / ±Z mark — a mirrored copy beyond that side, touching it; *Join* makes a solid and its copy one, e.g. a half dome → a ball), Delete |
| History | Unlimited-ish undo / redo (200 steps) |
| Files | Save/Open native `.y3d` (exact BREP), **Open Recent** (last 10, Ctrl+Shift+1…9), Import STEP, Export STEP / STL / **3MF** (for slicers: Bambu Studio, PrusaSlicer, Cura — one named object per body, closed meshes, mm) |

Press **F1** in the app for all shortcuts.

## Mouse
 
* **Middle-drag** or **Alt + Left-drag**: orbit
* **Shift + Left-drag** or **Shift / Ctrl + Middle-drag**: pan
* **Wheel**: zoom to cursor
* **Left click**: select / draw / use tool
* **Snapping**: tools snap to corners, midpoints, centres, edges, guides, axes and the grid by themselves —
  hold **Ctrl** to place freely. Untick **Auto** (status bar, by Snap) to snap only while Ctrl is held.

## Code layout

```
src/main/main.ts        Electron main: app:// protocol (serves wasm), menu, file dialogs
src/main/preload.ts     Safe IPC bridge (window.y3d)
src/main/smoke.ts       Opt-in E2E test (Y3D_SMOKE=<dir>)
src/renderer/kernel.ts  The only module that talks to OpenCascade/replicad
src/renderer/kernel.worker.ts  A second OpenCascade in a Web Worker for slow ops (Fillet / Chamfer, Shell, heavy booleans, STEP import, STEP / STL / 3MF export), results meshed there too: the app stays live, Esc / Stop ends them
src/renderer/kernelWorker.ts   The app's end of it (jobs → promises, cancel = end the worker and start a fresh one)
src/renderer/document.ts Immutable body snapshots + undo/redo
src/renderer/viewport.ts Three.js scene, tessellation display, picking, gizmo
src/renderer/tools.ts   Interactive Box/Cylinder/Sphere drawing tools
src/renderer/main.ts    App controller: commands, selection, op panel, UI
```

Face and edge ids are the OpenCascade shape hash codes, which link the
tessellated triangles/lines back to the exact B-rep topology for fillets,
push/pull and so on.

## License notes

OpenCascade (replicad-opencascadejs) is LGPL-2.1; replicad and Three.js are MIT.

## TODO

- [ ] **Pre-build snap points ahead of time.** Snap points are built lazily on the first
  snap query (~100 ms hitch at 5000 solids, `npm run bench`). Build them in idle time
  after `Viewport.sync()` (e.g. `requestIdleCallback`, in chunks) so complex models
  respond instantly on the first hover.
