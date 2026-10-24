# r/linux draft

Check r/linux rules on the day (self-promo, flair, maybe "Software Release" flair) — verify.
Alternative / backup: r/opensource (needs the LICENSE file in the repo first).

**Title:**

    YDDD: a simple 3D CAD app for Linux (OpenCascade + Electron), for people who just want to design a 3D-print part

**Image:** screenshot or short GIF.

**Body:**

---

Fusion 360 doesn't run on Linux, and FreeCAD is powerful but a lot to learn if you just
want a bracket or a box with a lid. So I've been writing YDDD as a solo hobby project.

- Direct modeling: draw, push/pull faces, type exact mm sizes. No history tree.
- Exact geometry (OpenCascade B-rep): STEP import/export, STL, 3MF for slicers.
- Fillet/chamfer, shell, booleans, sweep, revolve, sketch with splines, raised text
  with any installed TTF/OTF font (Thai and other scripts work).
- Electron + Three.js; OpenCascade runs as WebAssembly, heavy ops in a worker thread.
- MIT license (bundled OpenCascade wasm: LGPL-2.1).

Install right now: [git clone + npm install + npm start / AppImage on the Releases page].
Tested on [your distro + version]. [Wayland/X11 notes if known.]

Repo: https://github.com/canoon-gmail/yddd

What I'd like to know:
1. Does it start on your distro? (Wayland, X11, NVIDIA/AMD/Intel — please say which.)
2. What packaging would you actually use: AppImage, Flatpak, .deb, AUR?
3. Electron for a CAD app: acceptable, or a reason you wouldn't try it?

---

Expect: "Electron, really?" — see reply-guide.md. Stay calm and factual.
