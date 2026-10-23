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
