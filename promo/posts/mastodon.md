# Mastodon drafts (500 chars each; attach GIF/video with alt text)

## Toot 1 (main)

I've been writing a small, simple 3D CAD app for Linux, for designing 3D-print parts: draw a shape, push/pull it, type exact sizes, export 3MF. No history tree.

Exact geometry via OpenCascade (WebAssembly), Electron + Three.js. Free, MIT, solo project.

Looking for honest feedback: what's the first part you'd try to make, and where does it get stuck?

https://github.com/canoon-gmail/yddd

#3DPrinting #Linux #FOSS #CAD #OpenSource

**Alt text for the GIF:** Screen recording: a rectangle is drawn on a grid, pulled up into a box, made into an open box with walls, edges rounded, then exported as 3MF and opened in a slicer.

## Toot 2 (reply to toot 1, a day later or in thread)

Some things it does that I needed for printing:
- make a hole "0.2 mm bigger" in one step for a looser fit
- Box from Face + Box Lid with a clearance
- raised text with any installed font (Thai works too)
- checks solids are closed before export

What tolerance/fit tools do you wish your CAD had?

#3DPrinting #FunctionalPrint

## Toot 3 (optional, tech audience)

Fun bit of YDDD's internals: two OpenCascade wasm instances — one on the main thread for quick ops, one in a Web Worker for fillets/shells/booleans/export, so Esc can cancel by just killing the worker and starting a fresh one.

Anyone else running OCCT in the browser? What bit you?

#WebAssembly #OpenCascade #TypeScript
