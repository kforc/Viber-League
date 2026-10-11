# Viber League

Mobile-first arcade football club game — a **pre-MVP vertical slice** built from
[`docs/Viber_League_Technical_Plan.md`](docs/Viber_League_Technical_Plan.md),
which derives from the product spec *Viber League Game Build Specification v1.0*.

The point of this slice is the spec's own gate (§22): **prove the match is fun
before building the meta-systems.** So this build is the match — the club,
academy, transfers and league layers are deliberately not here yet.

---

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

Then open the URL on a phone-sized viewport and tap **START GAME**.

Other scripts:

```bash
npm run build      # type-check + production build to dist/
npm run preview    # serve the production build
npm test           # simulation test suite (determinism + balance)
```

Dev hook: append `?autostart` to the URL to skip the title screen and drop
straight into a match.

---

## What's playable right now

**Create a club → Title → Choose your five → Weather → Match length → Auto opponent → Kick off**

- **Create your club first.** A new player picks a manager name, a club name and
  one of six crests, and sets a password so the club can be got back. The password
  is never stored — PBKDF2-SHA256 with a random per-profile salt, and only the
  derived hash is kept. The league starts from scratch: 0 played, 0 points.
- **The crest you pick is the crest you get.** The same vector mark is worn by the
  title screen, the account sheet, the scoreboard and the pitch, because all four
  read it from one definition in `brand.ts`.
- **59 Viber characters** (matching the reference art), each with a football-card
  profile: six attributes, an overall rating, an archetype and a team SPECIAL.
- **Tap any Viber to inspect their qualities** — a card with attribute bars,
  overall badge and special ability, then add them to your squad.
- **Pick five** to form your team. A natural keeper always takes the gloves; if
  you skip keepers, your most defensive outfield goes in goal.
- **Weather matters.** Sunny, Rainy, Icy and Cold each change ball friction,
  acceleration, turn rate, top speed and shot accuracy — and repaint the pitch.
- **Match length**: 2 / 3 / 5 minute matches.
- **The opponent is chosen automatically** from your squad's overall rating, so
  every match is an even fight. It is composed by position (1 GK, 1 DEF, 2 MID,
  1 FWD) and drawn from a club pool that scales with difficulty.
- **AI plays the game for you** — you don't move players with a joystick. You
  make the decisions (spec §5.2): Attack / Balanced / Defend / Counter,
  contextual **Shoot / Pass / Clear** prompts, and a team **SPECIAL**.
- **It plays like football, not pinball.** The pitch has real boundaries, so the
  ball goes out: **throw-ins, corners, goal kicks and free kicks** are all
  awarded, positioned and taken. Wingers hold the touchline and drive at the
  byline to **cross**; shots are blocked and **deflected behind for corners**;
  keepers dive (one dive per shot) and either hold, tip behind, or get beaten;
  and a mistimed tackle in the box concedes a **penalty**. On an opponent's
  penalty, you choose **Left / Centre / Right** for your keeper before the kick;
  a correctly read ball can be caught, and the shot travels through the sim
  rather than being decided by an instant score roll.
- **Two halves** with a half-time tactical choice, goal celebrations with
  confetti, pause, and a full-time results screen with match stats (possession,
  shots, passes, corners, fouls, tackles).
- **Goal celebrations.** The scoring side throws its arms up for ~2 seconds
  while the camera pushes in on the goal and the tactical controls fade out
  (sound and pause stay live). Three arm variants cycle across the squad so it
  never reads as one animation stamped on five players.
- **Mobile-first UI** — portrait, touch-sized targets, safe-area aware.

### The roster

**59 Vibers** across four roles, each with distinct attributes and a signature
design (head-top slab, face treatment, eyes and colour). Examples:

| Viber | Role | Archetype | Identity |
|---|---|---|---|
| **Frost** | GK | Keeper | The Glacier — safe hands between the posts |
| **Moss** | DEF | Defensive | The Wall — a rock that reads the game |
| **Crimson** | FWD | Power | The Anvil — heavy, wins the ball, bullies the box |
| **Volt** | MID | Speed | The Current — pure acceleration, breakaways |
| **Phantom** | MID | Trickster | The Ghost — creates from nothing |
| **Cobalt** | MID | Playmaker | The Captain — pings passes nobody else sees |
| **Beacon** | MID | Playmaker | The Signal Tower — the periscope head |
| **Warden** | DEF | Anchor | The Curfew — black cap, green visor |
| **Periscope** | MID | Engine | The Up Periscope — cross-eyed cyan optics |
| **Icicle** | FWD | Striker | The Cold Snap — ice-blue, gold boots |
| **Moose** | FWD | Target Man | The Antlers — wins every header |

Teams are told apart by a **team-coloured ground ring** and a **kit stripe**,
while each Viber keeps their own head/body colours — so both "which team?" and
"which Viber?" read at a glance from the high camera.

---

## Architecture

Three layers with one hard rule, enforced by the file layout:

```
sim/     pure, deterministic simulation  ── never imports three.js, React, or the DOM
render/  Three.js presentation           ── reads sim state, never writes to it
ui/      menus, HUD, screens             ── presentation only
audio/   synthesized match sound         ── driven by the sim's event stream
brand.ts the mark and the crest set      ── pure geometry, consumed by BOTH ui/ and render/
app/     the ONLY place these meet
```

`brand.ts` sits at the root beside `sim/` rather than inside `ui/` or `render/`
because both of them need it and neither is allowed to import the other. It is
data and geometry, not presentation: the SVG path strings *are* the artwork.

### The simulation is the product

- **Fixed 60 Hz timestep.** The sim never sees a variable `dt`.
- **Seeded PRNG only** — there is no `Math.random()`, `Date.now()` or
  `performance.now()` anywhere in `sim/`.
- **Replayable.** Same seed + same inputs ⇒ identical event log. The test suite
  asserts this.
- **Custom 2.5D ball physics** and kinematic steering — no general physics
  engine, because determinism and mobile weight both matter more than realism.

This boundary is what makes replay, headless testing, and (later) async PvP
possible without a redesign.

### Rendering

- Three.js, **flat-shaded (Lambert)** chunky low-poly characters built
  **procedurally from data** (`roster.ts` drives head-top, face treatment,
  colours, accessories) with **uniform-thickness inverted-hull black outlines**
  (the Viber Brawl look).
- **One giant box head (~1.7× the torso width), a flat overhanging head-top slab,
  and glowing eyes** — matching the supplied reference art.
- Four face treatments drive most of the personality: `cubes` (bare eyes on the
  head), `panel` (coloured plate, big white eyes), `plate` (black plate, small
  glowing eyes) and `bar` (single glowing bar).
- Pitch markings baked into a canvas texture (free at runtime); the texture
  swaps between grass and snow for icy conditions.
- Per-weather **fog** softens the far end of the pitch and hides the edge of the
  world; rain and snow are a single recycled `THREE.Points` cloud (cheap on mobile).
- Blob shadows instead of shadow maps (mobile budget).
- Camera sits behind the player's own goal so **you attack away from the
  viewer**. On a goal it pushes in toward the goal end (height and distance
  eased at 12%/frame, so the whip-in never reads as a glitch) and pulls back out
  before the restart. The push-in is aspect-aware: a portrait viewport is narrow,
  so the same move that frames the group in landscape would crop the near Vibers
  out of shot, and the camera holds further back there.

### The brand

The official mark — a lime chef-hat head with a V/V, two eyes and a smile on a
near-black rounded square — lives in `src/brand.ts` as **pure geometry**. The
large lime eyes sit below the head, on the ink badge, and preserve the original
mark's slight tilt; they are not ink cut-outs. There is exactly **one** definition
of the mark. The same SVG path strings are used by
both renderers: the DOM gets `<path d="…">` markup, the canvas gets
`new Path2D(d)` on those identical strings.

- **Why not an image file.** The shipped game is one self-contained HTML file and
  the inliner fails the build on any external reference. A data-URI PNG would
  pass that check but bloat the bundle and lose its edge at every size.
- **Six club crests** come from the same module (`viber`, `ball`, `bolt`, `star`,
  `crown`, `shield`), which is what makes the crest a player picks in the
  onboarding form the same crest the title screen, the account sheet and the
  pitch all wear.
- **On the pitch**, the mark is mown into the centre circle in two grass tones —
  white paint with a darker green cut-out, inverted on snow. It is painted on its
  own canvas and composited at low alpha, because the face is made of *cut-outs*:
  painted straight onto the turf the near-black ink would land as a smudge.
- **Around the pitch**, the ground carries its own hoardings: a black plate with a
  lime rule, the mark, and an auto-fitted `VIBER LEAGUE` wordmark. They stand on
  both touchlines (seen at a glancing angle, where the point is the plate standing
  out among the pastel sponsor blocks) and either side of the far goal (seen close
  to face-on, which is the only place the wordmark reads).
- The board face is repainted once `document.fonts.ready` resolves. The display
  face ships as a data-URI `@font-face`, which still loads asynchronously, and a
  board whose wordmark silently fell back to a system sans would be the one piece
  of signage that does not look like us.

### Sound

Every sound is **synthesized at runtime** from Web Audio primitives — there is
no audio file anywhere in the project, because the shipped build is a single
self-contained HTML file with no external references at all.

- The referee's whistle is band-passed noise (air through the slot) plus a
  near-sine at ~2.1 kHz and its octave (the tone) plus a 36 Hz amplitude trill
  (the pea). `WHISTLE_SCHEDULE` in `audio/sound.ts` holds the **shape** per kind
  of stoppage: one blast to start play, two for a foul and for half time, one
  long one to end the match.
- The crowd is two readers of one pink-noise buffer — one low-passed into a
  rumble, one band-passed into the hiss — with a slow wobble so it breathes.
  Excitement drives the gain **and** both filter cutoffs: an excited crowd is
  brighter, not merely louder.
- A goal is three noise bands arriving at different speeds, so it reads as people
  rather than as static.
- `CrowdHeat` is the pure part: event jolts (`excite`) plus a decay, weighted so
  the ball's position can never reach the level a goal does.
- Nothing is built until `unlock()` is called from the KICK OFF tap, and a muted
  game **never constructs an `AudioContext` at all**.

---

## Project structure

```
src/
  sim/          engine, ai, physics, world, setpiece, roster, weather, content, constants (pure)
  render/       renderer, characters, pitch, stadium, showcase
  ui/           hud, screens, avatar, dom helpers
  audio/        sound (synthesized whistle, crowd, goal, kick, save)
  brand.ts      the official mark + the six club crests, as pure SVG geometry
  app/game.ts   wiring: sim <-> renderer <-> UI, flow state machine, fixed-timestep loop
tests/sim/      determinism + balance + roster/flow + set-piece tests
tests/app/      career + profile persistence tests
tests/audio/    whistle patterns + crowd model + no-Web-Audio fallback
tests/render/   celebration poses + the goal-phase clock that drives them
tests/brand.test.ts  path helpers, the icon set, and that the markup is safe for innerHTML
tools/cdp/      headless-Chrome harnesses, single-file bundler, contact sheets
docs/           technical plan
```

### Dead-ball phases

`sim/setpiece.ts` owns everything that happens when the ball is not in play.
`physics.integrateBall` reports *that* the ball left the field (touchline or goal
line); `setpiece.awardFromOutOfPlay` decides *what* that means:

| Situation | Restart |
|---|---|
| Over the touchline | Throw-in to the side that did not put it out |
| Over the goal line, last touch by the defending side | **Corner** |
| Over the goal line, last touch by the attacking side | Goal kick |
| Failed tackle inside the offender's own box | **Penalty** |
| Failed tackle anywhere else | Free kick |

Each restart is a real phase (`w.phase` equals the set-piece kind) with its own
timer. Corners and penalties **snap everyone to their station** — there is no
time for attackers to run 30 metres upfield, so the box is packed immediately.
Every other restart lets players walk. When the timer expires `runSetPiece`
strikes the ball and hands play back to the AI.

The **clock runs through dead balls too**, so the chosen match length is exact,
and a restart left pending when the clock expires cannot resurrect the match.

---

## Tuning

Almost everything that defines the feel lives in:

- `src/sim/constants.ts` — pitch size, ball physics, shot range, set-piece pauses,
  the penalty area, foul chances, special ability.
- `src/sim/roster.ts` — the 59 Vibers: attributes, roles, specials, designs, and
  the auto-opponent matching logic.
- `src/sim/weather.ts` — per-condition gameplay multipliers and visuals.
- `src/sim/setpiece.ts` — restart stations, who takes what, and how each is played.
- `src/sim/content.ts` — formations and the opponent club pool.

Current balance: matches are **deterministic** (same seed ⇒ identical result),
have **no structural home advantage** (identical squads split 16-14 over eight
seeds), and the auto-opponent lands within a few rating points of your squad.

Two things drive results more than anything else, and `overallOf` is weighted to
match: **pace** (winning loose balls and breakaways) and **strength/technique**
(shielding the ball and surviving challenges). Shooting affects power *and*
accuracy — a weak finisher sprays shots.

A typical 3-minute match now produces roughly **3 goals, 18 shots, 7 corners,
5 free kicks** and a couple of throw-ins.

If you want calmer or wilder games, tune `SHOT_SPEED`, `SHOOT_RANGE`,
`KEEPER_SAVE_REACH` and `FOUL_CHANCE_BOX` in `src/sim/constants.ts`. The keeper's
**one dive per shot** (`Ball.saveCooldown`) is what stops them covering the whole
goal; widen `KEEPER_SAVE_REACH` for more saves, narrow it for more goals.

---

## Status against the plan

| Milestone | Status |
|---|---|
| M0 App shell + identity | ✅ |
| M1 Vibers in football context | ✅ (59-Viber roster + card profiles) |
| M2 Pitch + ball physics + deterministic loop | ✅ |
| M3 AI players + formations | ✅ |
| M4 Tactical controls | ✅ |
| **M5 Complete playable match — the fun gate** | ✅ **ready for playtest** |
| M6 Goal presentation / pause / results | ✅ (early) |
| M6.5 Pre-match flow: squad select, weather, length, auto opponent | ✅ |
| M6.6 Set pieces: corners, throw-ins, goal kicks, free kicks, penalties | ✅ |
| M7+ Club, squad, academy, transfers, league | ⛔ not started (by design) |

**Next step per the plan:** run the M5 playtest. If the match isn't fun, fix the
match — do not start the club systems.
