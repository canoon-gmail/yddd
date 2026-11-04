# y3d_occt — custom OpenCascade wasm

replicad's build (`replicad-opencascadejs`) plus classes yddd needs and function names kept for
crash stacks. Rebuild: `~/occt-build/y3d-config/build.sh` (Docker; config `y3d_occt.yml`, which is
replicad's `build-config/custom_build_single.yml` with the additions marked `# y3d:`), then copy
`y3d_occt.js`, `.wasm`, `.d.ts` here.

Added: `Y3DFaceOffset` (per-face offset, wrappers/y3d-face-offset.cpp), `BRepFeat_MakePrism`,
`BRepAlgoAPI_Defeaturing`, `BRepTools_ReShape`, `ShapeBuild_ReShape`, `ShapeAnalysis_Surface`,
`Geom_RectangularTrimmedSurface`, `ShapeFix_Shape`, `BRepCheck_Result`, `LocOpe_SplitShape`.

`ReplicadMeshExtractor.extractWith` (wrappers/mesh-extractor.cpp): mesh with BRepMesh's own
parameters (interior deflection / angle, MinSize, flags for ControlSurfaceDeflection,
InternalVerticesMode, ...) — yddd's display meshes turn surface control off (see `meshFaces` in
kernel.ts). The original wasm is kept in `~/occt-build/backup-2026-10-20/`.

**Threaded build (branch dev-native-occt):** built from `~/occt-build/y3d-config-mt` with the image
`ghcr.io/taucad/opencascade.js:canary-ebd263f1-multi-threaded` — `y3d_occt.yml` there adds `-pthread` and
`-sPTHREAD_POOL_SIZE=globalThis["y3dOccThreads"]||0` (the page sets how many workers before loading it: kernel.ts
`initKernel` — the background kernel BG_THREADS, 0 by default, `YDDD_THREADS=16 npm start` for full speed; the window's own none) and leaves out `-sEVAL_CTORS` (not with pthreads).
Needs a cross-origin isolated page (main.ts `ISOLATED` headers, vite.config.mts `server.headers`). Booleans run with
`SetRunParallel`; OpenCascade's default thread pool is made first in every kernel (the mesher asks for it: without
workers it must be 1, or a thread it can't start hangs the window).
