<!-- Proposed new top of README.md. It replaces everything above "## Features (v0.1)".
     Move the current "## Run" block down into a "## Development" section. -->

# YDDD: easy 3D CAD for 3D printing, on Linux

**Draw a shape, push and pull it, type exact sizes, export 3MF for your slicer.**
No history tree, no constraint solver, nothing to set up first.

![A cable storage box with a lid and a raised label, made in YDDD](docs/img/hero-cablebox.png)
<!-- TODO: hero image or a 10–15 s GIF: Help → Cable Storage Box → Do all → Export 3MF -->

## Download

**[Download YDDD for Linux (.deb)](https://github.com/canoon-gmail/yddd/releases/latest)**:
download it, then `sudo apt install ./YDDD-*.deb` (Ubuntu, Debian, Mint, Pop!_OS).
Windows and macOS are coming. [Tell us if you want one](https://github.com/canoon-gmail/yddd/discussions).

## Your first print in 3 minutes

1. Open YDDD and choose **Help → Cable Storage Box**.
2. Press **Do all** to watch it build the box, the lid and the label. Or follow the steps yourself.
3. Choose **File → Export 3MF** and open the file in Bambu Studio, PrusaSlicer or Cura.

There are more walkthroughs in the Help menu: Planter, Bird House, House, Propeller.
Press **F1** for all the shortcuts.

## What it's good at

- **Boxes and enclosures**: *Box from Face* turns any outline into an open box with walls and a
  floor. *Box Lid* adds a lid with a lip or a cap, with the print clearance built in.
- **Fit for printing**: click a hole or pin and type a new diameter, or "0.2 mm bigger all
  round". Fillet, chamfer, shell.
- **Text**: raised or cut letters on any flat face, in any installed font.
- **Exact geometry**: an OpenCascade B-rep kernel underneath. Export STEP, STL or 3MF (one
  closed, named object per body).

## Tell us what you think

YDDD is new, and first impressions are the most useful thing you can give us.
**[Leave a comment in Discussions](https://github.com/canoon-gmail/yddd/discussions)**: what
you tried to make, where you got stuck, and whether you'd use it again.
Found a bug? [Open an issue](https://github.com/canoon-gmail/yddd/issues/new) and attach the
`.yddd` file if you can.

---
