# Viber League — durable project notes

Mobile-first arcade cartoon football club game. Vite + TypeScript + Three.js,
shipped as ONE self-contained `Viber-League.html`.

## Hard rules

- **The bundle must stay self-contained.** `tools/cdp/inline-build.mjs` fails the
  build on any leftover external reference. No image files, no font `<link>`s, no
  audio files. Art is vector or synthesized.
- **Layer boundary.** `sim/` never imports three.js or the DOM. `render/` reads
  sim state and never writes to it. `ui/` is presentation only. `app/game.ts` is
  the only place they meet. `src/brand.ts` sits at the root beside `sim/` because
  both `ui/` and `render/` need it and neither may import the other.
- **`sim/` is deterministic.** Fixed 60 Hz timestep, seeded mulberry32, no
  `Math.random` / `Date.now` / `performance.now` anywhere in it.
- **Do not rewrite working systems to add a feature.** Extend at the seam.

## Design language

- Palette: electric lime `#DFF902` + near-black `#0c0f08` + dark green-black.
- Flat fills, thick black outlines, hard offset shadows. No gradients, no gloss.
- Landscape-phone-first, but portrait must work too.
- **No explanatory text under action buttons.**
- Stock convention: price up = red, down = green (not used yet, but noted).

## Brand

- The official mark and the six club crests live in `src/brand.ts` as SVG path
  strings — ONE definition, consumed by the DOM renderer (`brandSvg`) and the
  canvas renderer (`drawBrand`, via `Path2D` on the same strings).
- On the pitch: mown into the centre circle in two grass tones. Around it: black
  hoardings with the mark and an auto-fitted wordmark, on both touchlines and
  either side of the far goal.
- A player picks a crest at sign-up; it is stored on the profile (`icon`) and worn
  by the title screen, the account sheet, the scoreboard and the pitch.

## Verification habits that have paid off

- **Look at the screenshots.** Several real bugs (a raw `0.0666min` clock, a
  smudge of a centre-circle emblem, a hoarding hidden behind the goal net) were
  caught by reading the rendered PNG, never by an assertion.
- **Probe before building.** `tools/cdp/probe-*.mjs` cost minutes and twice
  proved a requested feature already existed.
- Judge art by rendering it (`docs/screens-brand/brand.png`), never by assuming.

## Gotchas

- `#ui button` is (1,0,1) and outranks every component class. Use
  `:where(#ui) button` for base button resets.
- Headless Chrome runs WebGL in software: a match is ~0.2× real time and one
  frame can be ~700 ms. Poll in harnesses; never sleep a fixed amount.
- `npm run shots` reports failure even when the harness passes — the sandbox
  denies Chrome's own RLZ/GoogleUpdater file deletions. The verdict is the
  `=== N failed check(s) ===` line and `report.json`'s `fails`.
- Run vitest with `NODE_OPTIONS=--max-old-space-size=256` and one file at a time.
  `tests/sim/match.test.ts` alone takes ~130 s.
- Sandbox `/tmp` is ephemeral. Tooling lives in `tools/cdp/`.
