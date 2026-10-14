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

## Legibility

- **`--ink` is the LIGHT colour here (cream).** The name is a trap: `var(--ink)`
  on a lime fill is 1.04:1, an invisible label. **On lime, always `--on-lime`.**
- Text must clear 4.5:1. `--ink-mute` 0.55 alpha, `--ink-dim` 0.68 — don't go
  below those for anything a player has to read.
- **Baloo 2's inline content area is ~1.36em.** Any `line-height` below that
  makes `overflow: hidden` shave the glyphs, even for all-caps words. Use 1.4 on
  clamped single-line labels.
- Font-size floor 9px. Text inputs 16px or iOS Safari zooms on focus.
- Selection state is carried by the **presence of a marker** (the squad slot
  number), not colour alone — colour-blind players must still read it.

## Brand

- The official mark and the six club crests live in `src/brand.ts` as SVG path
  strings — ONE definition, consumed by the DOM renderer (`brandSvg`) and the
  canvas renderer (`drawBrand`, via `Path2D` on the same strings).
- On the pitch: mown into the centre circle in two grass tones. Around it: black
  hoardings with the mark and an auto-fitted wordmark, on both touchlines and
  either side of the far goal.
- The player's crest is stored on the profile (`icon`) and worn by the title
  screen, the account sheet, the scoreboard and the pitch.

## Verification habits that have paid off

- **Look at the screenshots.** Several real bugs (a raw `0.0666min` clock, a
  smudged centre-circle emblem, a hoarding hidden behind the goal net) were
  caught by reading the rendered PNG, never by an assertion. When a screenshot
  shows a formatting bug, grep for every other place that formats the same value.
- **Probe before building.** `tools/cdp/probe-*.mjs` cost minutes and twice
  proved a requested feature already existed.
- Judge art by rendering it, never by assuming.

## Gotchas

- `#ui button` is (1,0,1) and outranks every component class. Use
  `:where(#ui) button` for base button resets.
- **Cascade ORDER beats specificity when both selectors are equal.** `.subs-panel`
  silently lost to `.panel` (both 0,1,0) because `.panel` is declared later.
  When a component style "does not apply", check declaration order first. The
  title chip's `.menu-crest` lost `display`/`height` the same way to `.club-crest`
  (line 2328 vs 1294) — fix by raising specificity (`.menu-crest.club-crest`).
- **A CSS `transform` does not change `scrollHeight`**, so any clip detector
  comparing `scrollHeight` to `clientHeight` is BLIND to transform overflow. The
  landscape card rail clips vertically (`overflow-x: auto` forces `overflow-y` to
  clip) and the selected card's `translateY` was cut — assert rail-vs-card rects.
- **NEVER wait on wall clock for a match.** Headless Chrome has no compositor:
  rAF ~5fps, the app clamps a frame to 50ms and takes ≤6 ticks, so the sim runs
  at **~0.25× realtime**. `flow-club.mjs` steps the real world directly via a
  bundled `TestSim` injected with `Page.addScriptToEvaluateOnNewDocument`, and
  answers the penalty and half-time panels the app raises.
- `window.game` is exposed by `src/main.ts`; `?autostart` / `?seed=<n>` jump
  straight into a pinned match.
- `npm run shots` reports shell failure even when the harness passes — the
  sandbox denies Chrome's own RLZ/GoogleUpdater file deletions. The verdict is
  the `=== N failed check(s) ===` line and `report.json`'s `fails`. `report.json`
  keys are only `{viewport, shots, events, fails}` — no per-check array.
- Run vitest with `NODE_OPTIONS=--max-old-space-size=256`, one file at a time.
  `tests/sim/match.test.ts` alone takes ~130 s. `tsc` needs 1024.
- Sandbox `/tmp` is ephemeral. Tooling lives in `tools/cdp/`.
- **CDP probes must run SERIALLY** — two Chrome instances race port 9333.
- The sandbox's Bash `grep` silently returns no matches on files/patterns the
  Grep tool finds fine. Prefer the Grep tool.

## Layout budgets

- **The landscape card rail is a fixed budget and everything above it spends it.**
  A 390px-tall viewport leaves the rail ~166px for a ~150px card. The squad strip
  is TWO rows in landscape (legend on its own line via `flex: 0 0 100%`, both
  groups sharing the next), and `flow-club.mjs` asserts the selected card against
  the rail's rect.
- **A `.selected` rule must not drop the panel layer.** `.viber-card2.selected`
  set `background: <glow>, rgba(...)` with nothing opaque under it, so the chosen
  card was transparent and the 3D stage showed through — the hero model sitting
  on the player's name. Any state that restyles a card keeps `var(--panel-2)` at
  the bottom of the background stack.
- **The reserve row wraps; the starting five never does.** `.strip-group.start`
  is always one row of five (that row IS the "first five start" rule); the bench
  wraps at a 64px floor so a name is never truncated to "CHIM…".

## The league moves with the player

- **CPU results are DERIVED, never persisted.** Only the player's 12 fixtures go
  to disk; the other 30 are simulated on demand from the season seed. Anything
  that reads a table must go through `completeResults` first — including
  `summariseSeason`, which built its table from the raw stored results and so put
  every CPU club on zero, making the player top by default and **every season
  ever filed record them as CHAMPION**.
- **The reveal is keyed on the rounds the player PLAYED, not on round numbers.**
  Seven clubs means someone rests each round and the circle method gives the
  player the round-0 bye, so their fixtures are rounds `1-6, 8-13`.
- **`completeResults` takes no `playerStrength`.** It never did anything — a
  fixture the player is in is not simulated.
- **Structure checks cannot see a table that is TOO complete.** Read the
  *columns*: `readTable()` asserts a fresh league is all zeros, that nobody has
  played more than the player, and that only the bye club is on 0.

## Game modes

- **A mode is a LENS over one pre-match flow, not a second flow.** `Mode` is
  `'quick' | 'league'`; everything reads the selection through one accessor,
  `get/set activeSelected`, which swaps `quickSelected` for `selected`.
- **Quick Play is isolated by construction, not by scattered guards.**
  `starters()` returns `quickSelected.slice(0, 5)` without touching
  `fitSquad(this.career)`; `refreshBench()` returns `[]`; `commitLineup()` is a
  no-op; every career write in `enterResult` is gated on `!quick`.
- **The write that had to be gated:** `withAbsences(tickAbsences(next), picked)`
  + `commitCareer` sat OUTSIDE `if (this.fixture)`. A friendly has no fixture, so
  it would have injured league players and served their bans silently.
- **Every title tile claims `mode = 'league'`** (`openSection()` sets it), because
  `starters()` is mode-aware and League would otherwise render the *quick* five.
- **PvP is deliberately absent** — it needs a relay (the game is offline), a
  bit-identical sim across engines, and two-device testing. A tile leading
  nowhere is worse than no tile.
- **`displayLength(halfSeconds)` is the ONE match-length formatter**, in
  `screens.ts` beside `LENGTH_OPTIONS`, imported by `hud.ts`. Two strips, one
  definition — the HUD was fixed and the venue screen was not.

## A check that passes on the WRONG SCREEN is worse than no check

The Quick Play harness drove a friendly with `runMatchTo('fulltime')` and
asserted `exists('.overlay-screen')`. It went green while the friendly was stuck
in the first half, because (a) a match stops at half-time for a mentality and
driving past it spins until the guard gives up, and (b) `.overlay-screen` matches
the **half-time panel too**. Assert the element that only exists on the screen you
mean (`.stats-table`), and drive a match in two halves, always answering panels.

**Corollary: never test a screen through a route that no longer exists.** The
SQUAD tile was removed and the checks that verified the squad view clicked it; the
assertions moved to the result panel's "Squad" shortcut. A route that has been
deleted cannot fail — it just stops covering anything.

**A check can also REQUIRE the bug.** `flow-club.mjs` asserted that PLAY NEXT
MATCH was disabled on a fresh league. The harness's own career has an empty
squad, so it sat in exactly the state a player reported as a dead end — and
pinned it as correct behaviour. When a control is disabled, ask what the player
does next; if the answer is "nothing", the assertion is defending the bug.

## Front page and the league gate

- **`leagueStartedAt` gates LEAGUE, and `loadCareer` deliberately does NOT
  backfill it.** A save written before the field existed has a season and no
  marker, so it lands on the gate with its table, fixtures and injuries intact —
  which is where LOAD EXISTING LEAGUE appears instead of the progress being
  wiped. `career.test.ts` pins it by stripping the field from raw storage.
- **`leagueExists` vs `hasStoredLeague` are different questions.**
  `leagueExists` = a league is live (`leagueStartedAt !== null`).
  `hasStoredLeague` = there is a season worth resuming (results or history
  non-empty). The gate needs both.
- **A dead control beats a missing one.** LOAD EXISTING LEAGUE renders disabled
  with a `.disabled` class rather than being absent.
- **State survives the subtitle purge as CHIPS.** `Season 1 · 0/12` + position on
  LEAGUE, `Round 2 · Away` on the opponent screen, `Season N` on CAREER. A
  subtitle explains a screen; a chip is a fact about it.
- **A screen reached without `nav()` is not on the history stack.** HELP was
  wired as `() => this.showHelp()` — it set `state` but pushed nothing, so BACK
  popped the entry *below* the Play screen and dropped the player on the title.
  Route through `nav()` (and add the `case` to its switch).
- **Click harness tiles by LABEL, never by index.** Dropping the SQUAD tile
  shifted every index: `click('.menu-opt', 3)` opened Settings. Same family: two
  assertions still checked `'No win on the board yet'` after the copy pass
  shortened it to `'No win yet.'` — a stale assertion fails for an unrelated
  reason.
- **`.help-body` is a scroller** and must stay in `flow-club.mjs`'s `SCROLLERS`.
- **`.screen-sub` and `.play-sub` are gone from the app**, with all its CSS.
- **A disabled primary is only honest when nothing can be done.** LEAGUE's PLAY
  NEXT MATCH was disabled while `starters().length !== 5`, but starting a fixture
  has always begun at the squad picker (which gates its own Continue on five fit),
  so "no side named" was never a reason the flow could not start — it is what the
  flow asks first. `newLeague` preserves the squad and `defaultCareer` starts it
  empty, so a first league landed on a dead table whose only door to the picker
  was the button the picker was needed for. Now disabled only when too many are
  injured. **`starters` cannot tell "nobody signed" from "seven injured"** — both
  are `[]` — so `LeagueOpts.squadSize` carries the named count beside `lineup`.

## Known, pre-existing, NOT fixed

- **The League screen's floating action bar overlaps the last table row.** Also
  in HEAD. The screen scrolls, so the row is reachable.
