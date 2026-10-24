# Third-party notices

YDDD's own code is MIT (see `LICENSE`). It ships with these parts, each under its own license:

| Part | Where | License | Text |
|---|---|---|---|
| OpenCascade Technology (OCCT), built to WebAssembly | `vendor/occt/y3d_occt.*` | LGPL-2.1 (with the OCCT exception) | `licenses/LGPL-2.1.txt` |
| replicad-opencascadejs (the OCCT wasm build setup) | `node_modules`, and the build `vendor/occt` is made from | LGPL-2.1 | `licenses/LGPL-2.1.txt` |
| replicad | `node_modules` | MIT, © QuaroTech Sàrl | `licenses/replicad-MIT.txt` |
| Three.js | `node_modules` | MIT, © three.js authors | `licenses/three-MIT.txt` |
| Noto Sans / Serif / Sans Thai fonts | `vendor/fonts` | SIL Open Font License 1.1, © Google LLC | `licenses/OFL-1.1.txt` |

## OpenCascade (LGPL-2.1)

`vendor/occt/y3d_occt.wasm` is a custom build of OpenCascade: replicad's build plus extra classes and
two small wrappers (see `vendor/occt/README.md` for what was added). Under the LGPL you may replace
it with your own build of OpenCascade — YDDD loads it as a separate file. The build configuration and
the wrapper sources used for it are available on request from the author
(open an issue at https://github.com/canoon-gmail/yddd/issues).
