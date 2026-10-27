# YDDD

Simple 3D CAD for 3D printing. Draw a shape, push/pull it, type sizes, export 3MF. Linux + Windows.

![screenshot](docs/img/hero.jpg)

## Download

[Releases](https://github.com/canoon-gmail/yddd/releases/latest)

- Windows: unzip, run `YDDD.exe`. Not signed yet, so click More info → Run anyway.
- Linux: `sudo apt install ./YDDD-*.deb`

No macOS yet.

## Try it

Help → Cable Storage Box → Do all. Then File → Export 3MF and open it in your slicer.

F1 = shortcuts, / = search commands.

## Stuff it does

- box, cylinder, sphere, cone, rectangle, circle, polygon, sketch (lines, arcs, splines)
- push/pull, fillet, chamfer, shell, offset, revolve, sweep, cut
- union / subtract / intersect
- move, rotate, scale, mirror, circular copy
- text (flat or wrapped round a curved face, Thai works)
- resize holes for print fit
- macros: box from face, lids, dividers, battery case, gridfinity bin + baseplate, random scatter
- STEP / STL / 3MF export, STEP + STL import

## Mouse

- middle drag / alt+drag: orbit
- shift+drag: pan
- wheel: zoom
- ctrl: no snap

## Notes

I do 3D-print jobs and made this for them. Written with a lot of help from Claude (AI).
Bugs / ideas: [issues](https://github.com/canoon-gmail/yddd/issues).

## Build

Electron + TypeScript + Three.js + OpenCascade (replicad).

```
npm install
npm start
npm run dist      # .deb
npm run dist:win  # windows zip
```

## License

MIT. OpenCascade is LGPL-2.1, Noto fonts OFL. See `THIRD_PARTY_NOTICES.md`.
