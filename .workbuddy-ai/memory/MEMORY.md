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

## Legibility (added 2026-10-12)

- **`--ink` is the LIGHT colour here (cream).** The reference project calls its
  dark colour `--ink`, so the name is a trap: `color: var(--ink)` on a lime fill
  is cream-on-lime = 1.04:1, an invisible label. **On lime, always `--on-lime`.**
- Text must clear 4.5:1. `--ink-mute` is 0.55 alpha and `--ink-dim` 0.68; do not
  go below those for anything a player has to read.
- **Baloo 2's inline content area is ~1.36em.** Any `line-height` below that
  makes `overflow: hidden` shave the glyphs, even for all-caps words. Use 1.4 on
  clamped single-line labels.
- Font-size floor is 9px. Text inputs must be 16px or iOS Safari zooms the
  viewport on focus.
- Selection state is carried by the **presence of a marker** (the squad slot
  number), not by colour alone — colour-blind players must still read it.

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
- **Cascade ORDER beats specificity when both selectors are equal.** `.subs-panel`
  silently lost to `.panel` (both 0,1,0) because `.panel` is declared later.
  When a component style "does not apply", check declaration order before the
  property. Same family as the `#ui button` trap above.
- **A CSS `transform` does not change `scrollHeight`**, so any clip detector that
  compares `scrollHeight` to `clientHeight` is BLIND to transform overflow. The
  landscape card rail clips vertically (`overflow-x: auto` forces `overflow-y` to
  clip) and the selected card's `translateY` was being cut — assert rail-vs-card
  rects explicitly instead.
- **NEVER wait on wall clock for a match.** Headless Chrome has no compositor:
  rAF runs at ~5fps, the app clamps a frame to 50ms and takes ≤6 ticks, so the
  sim advances at **~0.25× realtime** (measured with `tools/cdp/probe-rate.mjs`;
  a 90s half needs ~6 min of wall clock). `flow-club.mjs` therefore steps the
  real world directly via a bundled `TestSim` injected with
  `Page.addScriptToEvaluateOnNewDocument`, and answers the penalty and half-time
  panels the app raises. Waiting instead made the run fail *more* the busier the
  machine was — 15 cascading failures from one under-sized budget.
- `window.game` is exposed by `src/main.ts` for console debugging, and
  `?autostart` / `?seed=<n>` jump straight into a pinned match. Use them.
- `npm run shots` reports failure even when the harness passes — the sandbox
  denies Chrome's own RLZ/GoogleUpdater file deletions. The verdict is the
  `=== N failed check(s) ===` line and `report.json`'s `fails`.
- Run vitest with `NODE_OPTIONS=--max-old-space-size=256` and one file at a time.
  `tests/sim/match.test.ts` alone takes ~130 s.
- Sandbox `/tmp` is ephemeral. Tooling lives in `tools/cdp/`.
- **CDP probes must run SERIALLY** — two Chrome instances race port 9333.
- The sandbox's Bash `grep` silently returned no matches on files/patterns the
  Grep tool found fine. Prefer the Grep tool.

## Layout budgets (added 2026-10-13)

- **The landscape card rail is a fixed budget and everything above it spends it.**
  A 390px-tall viewport leaves the rail ~166px for a ~150px card. The squad strip
  and the filter chips are the only things above it, and every pixel they take
  comes straight off the cards — a 3-row strip cut the rating plates in half and
  sliced the role bars. The strip is therefore TWO rows in landscape (legend on
  its own line via `flex: 0 0 100%`, both groups sharing the next), and
  `flow-club.mjs` asserts the selected card against the rail's rect.
- **A `.selected` rule must not drop the panel layer.** `.viber-card2.selected`
  set `background: <glow>, rgba(223,249,2,0.1)` with nothing opaque under it, so
  the chosen card was 90% transparent and the 3D stage showed through it — the
  hero model sitting on top of the player's name. Only ever visible on the
  SELECTED card. Any state that restyles a card keeps `var(--panel-2)` at the
  bottom of the background stack.
- **The reserve row wraps; the starting five never does.** `.strip-group.start`
  is always one row of five (that row IS the "first five start" rule); the bench
  wraps at a 64px floor so a name is never truncated to "CHIM…".

## The league moves with the player (added 2026-10-13)

- **CPU results are DERIVED, never persisted.** Only the player's 12 fixtures go
  to disk; the other 30 are simulated on demand from the season seed. Anything
  that reads a table must go through `completeResults` first — including
  `summariseSeason`, which used to build its table from the raw stored results
  and so put every CPU club on zero. That made the player top of the league by
  default and **every season ever filed recorded them as CHAMPION**. Fixed.
- **A new season opens with all seven clubs on zero, and the CPU half of a
  matchday does not exist until the player has reached it.**
- **The reveal is keyed on the rounds the player PLAYED, not on round numbers.**
  Seven clubs means someone rests each round and the circle method gives the
  player the round-0 bye, so their fixtures are rounds `1-6, 8-13`. Revealing
  "every round up to the player's last" instead puts five clubs on two games the
  moment the player kicks off — the reported bug in miniature. Keyed on played
  rounds the player is never behind: after matchday one six clubs and the player
  are on 1 game and only the bye club is on 0.
- **`completeResults` takes no `playerStrength`.** It never did anything — a
  fixture the player is in is not simulated. Adding an option "just in case"
  cost two call sites and an import when it was finally removed.
- **Structure checks cannot see a table that is TOO complete.** The harness
  asserted row count, header text and clipping — all of which a table showing
  six clubs ten games in satisfied perfectly. Read the *columns*: `readTable()`
  in `flow-club.mjs` now asserts a fresh league is all zeros, that nobody has
  played more than the player, and that only the bye club is on 0.
