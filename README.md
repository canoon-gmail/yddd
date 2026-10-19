# Y3D

A direct-modeling NURBS / B-rep CAD app for Linux, in the spirit of Plasticity.
Built with **Electron + TypeScript**, **Three.js** for the viewport and
**OpenCascade** (via [replicad](https://replicad.xyz) / WebAssembly) as the
geometry kernel. Units are millimetres, Z is up.

## Run

```bash
npm install
npm start        # type-check, build and launch
npm run dev      # Vite dev server with hot reload + Electron
npm run smoke    # automated end-to-end test, screenshots in /tmp/y3d-smoke
npm run start:stress          # launch with 2000 test solids (N=5000 npm run start:stress for more)
```

## Features (v0.1)

| Area | What you can do |
|---|---|
| Solids | Box, Cylinder, Sphere drawn interactively on the grid **or on any planar face**, grid snapping (Ctrl = free), typed exact dimensions |
| Faces | Rectangle, Circle, Polygon (3–64 sides) create **flat faces**; **Push/Pull** a flat face to extrude it into a new solid |
| Select | Solid / Face / Edge modes with hover highlight, Shift+click multi-select |
| Modify | Push/Pull face (flat face → new solid; solid face → modify, or tick *New solid*), Fillet & Chamfer (selected edges or whole solid), Shell (open selected faces) — all with live preview |
| Boolean | Union, Subtract, Intersect (first selected solid is the target) |
| Transform | Move / Rotate gizmo (snaps to grid / 15°), Duplicate, Delete |
| History | Unlimited-ish undo / redo (200 steps) |
| Files | Save/Open native `.y3d` (exact BREP), Import STEP, Export STEP / STL |

Press **F1** in the app for all shortcuts.

## Mouse
 
* **Middle-drag** or **Alt + Left-drag**: orbit
* **Shift + Left-drag** or **Ctrl + Middle-drag**: pan
* **Wheel**: zoom to cursor
* **Left click**: select / draw / use tool

## Code layout

```
src/main/main.ts        Electron main: app:// protocol (serves wasm), menu, file dialogs
src/main/preload.ts     Safe IPC bridge (window.y3d)
src/main/smoke.ts       Opt-in E2E test (Y3D_SMOKE=<dir>)
src/renderer/kernel.ts  The only module that talks to OpenCascade/replicad
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
