# YDDD first-run audit (2026-10-24)

Goal: a stranger lands on github.com/canoon-gmail/yddd and is using the app, and able to leave a
comment, within a few minutes.

## What was checked, and what we found

| Item | State |
|---|---|
| Repo visibility / description / topics / Discussions | **Not checked.** `gh` is not installed on this machine, so `gh repo view` could not run. Check it by hand on the GitHub settings page. |
| Releases | Not checked (no `gh`). Nothing in the repo builds a release: no `electron-builder` / `electron-forge`, no `.github/workflows/`, no `build` section in package.json. |
| How to install | Only `git clone && npm install && npm start`. That needs Node (24 here) and downloads Electron (~280 MB unpacked), then runs a TypeScript + Vite build before the window opens. |
| vendor/ | `vendor/occt/y3d_occt.wasm` (23 MB, a custom OpenCascade build) and `vendor/fonts/` (Noto fonts) are in git, so a clone runs without manual setup. Rebuilding the wasm needs `~/occt-build` + Docker, but only the maintainer does that. |
| package.json | `"version": "0.1.0"`, MIT. No `repository`, `homepage`, `bugs`, `author` or `engines` fields. |
| README first screen | Opens with "A simple, easy 3D CAD app for Linux…". The next line is "direct-modeling B-rep modeller / Electron / replicad". There is no image. Then come the developer commands (`dev`, `smoke`, `start:stress`). The 3D-printing hooks (3MF for Bambu / Prusa / Cura, Box from Face, Box Lid, hole resizing for fit, raised Text) are in the feature table, far down the page. |
| Tutorials | **The best onboarding asset, and nobody sees it.** Help → Bird House / Cable Storage Box / House / Planter / Propeller open step-by-step walkthroughs with **Do step / Do all** buttons. Do all builds the finished model in seconds. The README never mentions them. |
| First launch | An empty grid. No welcome, no sample model, no pointer to the tutorials. The things that help: the status bar mouse hint, the key cheat sheet in the bottom right (`F1 all shortcuts`), autosave recovery after a crash. |
| Opening files | `main.ts` does not read `process.argv`, so double-clicking or `yddd file.yddd` does not open a model. There are no sample `.yddd` files in the repo. |
| Feedback route in the app | No Help → "Send feedback" / "Report a bug" item. No link to GitHub anywhere in the UI. |
| Screenshots | Smoke screenshots are in `/tmp/yddd-smoke` (more in Hero images below). None are committed. |

## Ranked blockers and fixes

### 1. No download: you need Node, npm and a build to try it. (Effort: ~half a day)
This is the biggest blocker by far. Most 3D-print hobbyists will not run `npm install`.
- Add `electron-builder` (devDependency) with a `build` block: `appId: io.github.canoon.yddd`,
  `productName: YDDD`, `linux.target: [AppImage, deb]`, `linux.category: Graphics`, and
  `files: [dist/**, vendor/**, package.json]`. Check that the `app://` protocol still finds
  `vendor/occt/*.wasm` and the fonts in the packaged (asar) layout. You may need
  `asarUnpack: ["vendor/**"]`.
- Add `.github/workflows/release.yml`: on a `v*` tag, run on ubuntu-latest with Node 24,
  `npm ci && npm run build && npx electron-builder --linux --publish always` using `GH_TOKEN`.
  Windows and macOS can be added to the same matrix later (that pause is already on the roadmap).
- Tag `v0.1.0` and write short release notes: what it is, 3 screenshots, "chmod +x and run".
- Test the AppImage once on a clean distro (Ubuntu 24.04 live or a VM). Watch for the sandbox /
  `--no-sandbox` problem and for missing `libfuse2`.

### 2. No way to leave feedback. (Effort: ~1 hour)
The milestone is "first user comments", but there is nowhere obvious to leave one.
- Turn on GitHub Discussions with a category "First impressions". Pin a post with 3 questions:
  what you tried to make, where you got stuck, would you use it again.
- Add an issue template `.github/ISSUE_TEMPLATE/bug.yml` (distro, YDDD version, steps, an
  attached `.yddd`).
- Add Help → "Send Feedback…" and "Report a Bug…" menu items. They open the Discussions / new-issue
  URL with `shell.openExternal`.
- Fill in `bugs.url` and `repository` in package.json.

### 3. The README doesn't sell it, and has no picture. (Effort: ~2 hours)
- Replace the top section with the pitch in `promo/readme-pitch.md`.
- Hero image: a clean shot of the **Cable storage box** (rounded box, lid, raised "CABLES" label).
  It shows Box from Face, Lid and Text in one picture, and that is what hobbyists print. Better: a
  10–15 s GIF of Help → Cable Storage Box → **Do all**, then Export 3MF. Store images in
  `docs/img/` (or a GitHub issue attachment URL so the repo stays small).
- Move "Run from source", `dev`, `smoke`, `stress`, Code layout and the TODO under a
  `## Development` heading lower down.
- Add a short "Make your first print in 3 minutes" list: Help → Cable Storage Box → Do all →
  File → Export 3MF → open in your slicer.

### 4. The first launch is an empty grid that doesn't point to the tutorials. (Effort: ~2–3 hours)
- On first run (a localStorage flag, like the existing Pro tip), show a small welcome card over
  the viewport with:
  - "Start a walkthrough": Cable Storage Box / Planter / Bird House / Propeller
  - "Just draw: B B box, A A rectangle, P push/pull"
  - "F1 shortcuts"
  - "Send feedback"

  Dismiss it on any click; Help → Welcome reopens it.
- Or, even cheaper: put a one-line hint in the empty viewport ("New here? Help → Cable Storage
  Box → Do all"). Remove it once there is a body.

### 5. No sample files, and you can't open a file from outside the app. (Effort: ~1–2 hours)
- Commit `examples/cable-box.yddd`, `planter.yddd`, `propeller.yddd`. Save each one after "Do all"
  in its tutorial. Link them from the README (they also act as bug-report test cases).
- In `main.ts`, open the `.yddd` / `.step` path given in `process.argv` (and with
  `requestSingleInstanceLock` + `second-instance`). Add electron-builder `fileAssociations` for
  `.yddd` so a double-click in the file manager works once the deb is installed.

### 6. The repo page itself: description, topics, link. (Effort: 10 minutes, by hand)
- Description: "Simple direct-modelling 3D CAD for Linux: draw, push/pull, exact mm, export 3MF
  for your slicer."
- Topics: `cad`, `3d-printing`, `3d-modeling`, `opencascade`, `electron`, `linux`, `brep`,
  `3mf`, `stl`, `step`, `direct-modeling`, `threejs`.
- Homepage: the latest Releases page. Social preview image: the cable box shot (Settings →
  Social preview).
- First confirm that the repo is **public**. This could not be checked here.

### 7. Smaller items (each under 1 hour)
- **Bird house screenshot is not usable as is.** `5-birdhouse.png` shows two error toasts,
  including "Failed: Union: 'Ball 1' is a mesh (imported STL)…". Don't use it for promo without
  re-shooting. Check whether a real user can hit that error during the walkthrough.
- **Tutorial panel covers the model.** In every tutorial shot the panel takes about 1/3 of the
  viewport. For promo shots, close the panel (or Fit after closing) and take the model alone.
- **Version / About.** Add Help → About showing the version (0.1.0), the licence and the GitHub
  link. Reporters will need it for "which version?".
- **LGPL note.** OpenCascade is LGPL-2.1. When you ship binaries, include its licence text and a
  pointer to the source (the custom wasm build config in `~/occt-build` should be published or
  described). Add a `LICENSE` file for MIT if there isn't one; none was found in the tracked files.
- The README calls the app "Linux only". Say clearly that Windows / macOS builds are coming, and
  ask people to say whether they want one. That is also useful feedback.

## Hero images available now (`/tmp/yddd-smoke`, made by `npm run smoke`)
- `6-cablebox.png`: best subject (rounded box, lid, raised CABLES text), but the tutorial panel
  is open. Re-shoot with the panel closed.
- `5c-planter.png`: a clean tapered shell. Good second image.
- `5d-propeller.png` / `propeller.png`: shows the swept / twisted blades (new, still uncommitted).
- `round.png`, `spline.png`, `8-sketch.png`: sketch features for a "features" strip.
- `7-measure.png`, `7b-array.png`: secondary.
- Suggestion: add a smoke-only "promo" scenario that runs each tutorial's Do all, closes the
  panel, fits the view, hides the cheat sheet, and saves `promo-*.png` at 1600×1000. Then the
  README images can be made again with every release.

## Suggested order
6 (10 min) → 2 (1 h) → 3 (2 h, the README with a static image) → 1 (AppImage release) → 5 → 4.
After 1–3 the project can be posted (r/3Dprinting, r/linux, r/functionalprint, the Prusa /
Bambu forums) with a real download link and a place to comment.
