# Viber League — Technical Plan (Pre-MVP)

**Status:** Draft v0.1 — for review  
**Derived from:** *Viber League Game Build Specification v1.0* (product source of truth)  
**Scope of this document:** Everything that must be decided/built *before and around* the MVP. This is the bridge from the product spec to the first line of code.  
**Companion docs to be produced after sign-off:** `MVP_TASK_BREAKDOWN.md` (sprint-level tickets), `ART_PIPELINE.md`, `SIM_DESIGN.md` (deep-dive on the match engine).

---

## 0. How to read this document

The product spec says *what the game is* and *what it must feel like*. This document says *how we build it*, in what order, with what boundaries, and how we know each piece is done. It intentionally over-specifies the **match engine** and the **module boundaries**, because the spec's §27 priority order is:

> (1) fun football matches → (2) mobile usability/perf → (3) Viber visual identity → (4) club ownership/progression → (5) extensible architecture.

Every technical decision below is justified against that order. If a decision trades fun for architecture, it is flagged.

---

## 1. Locked assumptions & decisions to confirm

These are the high-leverage forks. I have chosen defaults based on the spec (which explicitly references a **browser** game at `theviberbrawl.vercel.app` and requires "mobile browser support"). **Confirm or override before build starts.**

| #   | Decision              | Chosen default                                                                          | Why                                                                                                                    | Alternative if overridden                                                                       |
| --- | --------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| D1  | **Platform**          | Web (mobile browser first, installable PWA)                                             | Spec references a Vercel-hosted browser game; "mobile browser support" is a stated Viber trait; fastest iteration loop | Native (Unity/Capacitor wrap) — changes §9 rendering + §12 persistence                          |
| D2  | **Rendering**         | Three.js (WebGL2), custom match renderer                                                | Full control over mobile perf + toon/outline style; mature, tiny dependency                                            | Babylon.js (heavier), PlayCanvas, or react-three-fiber (adds React coupling to the render loop) |
| D3  | **UI framework**      | React + TypeScript for menus/HUD, **decoupled from the render loop**                    | Spec §20: "separate game simulation/state from presentation/UI"                                                        | Preact (smaller), Svelte                                                                        |
| D4  | **Simulation**        | Custom deterministic fixed-timestep engine (no physics engine)                          | Spec §20: deterministic + reproducible; football arcade needs bespoke ball/AI feel, not rigid-body realism             | Rapier/cannon-es for ball only — adds determinism risk + weight                                 |
| D5  | **Backend for MVP**   | **None** — local persistence only; backend behind an interface                          | Spec §22 MVP has no online requirement; async PvP is §11 "later"                                                       | Add Supabase/cloud-service now (see §13)                                                        |
| D6  | **Match format**      | **5v5** (4 outfield + GK) on a ~44×28 m pitch, ~3 min default                           | Spec §5.1 "small-sided preferred for clarity and mobile performance"                                                   | 6v6/7v7 (more draw calls, denser AI)                                                            |
| D7  | **Orientation**       | **Portrait-first UI**; match runs in portrait with an optional **landscape match mode** | Spec §15                                                                                                               | Force landscape for matches only                                                                |
| D8  | **Outline technique** | **Inverted-hull** (scaled backface pass)                                                | Cheap, mobile-safe, matches "thick black outlines"                                                                     | Post-process edge detect (costlier)                                                             |
| D9  | **Sim/render rate**   | Sim fixed **60 Hz**, render interpolated; 30 Hz low-power fallback                      | Responsive arcade feel; interpolation hides render jitter                                                              | 30 Hz sim always (cheaper, less crisp)                                                          |
| D10 | **Determinism level** | Same-device replay-exact for MVP; cross-device hardening deferred to server PvP         | Async PvP opponent runs locally in MVP                                                                                 | Fixed-point math from day one (safer, slower to write)                                          |

> **Action:** Confirm D1–D10. Everything downstream assumes them.

---

## 2. Product constraints → technical implications

| Spec requirement                                                    | Technical implication                                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Match is the core product (§1, §22)                                 | Engine + AI get built and tuned **first**; all meta-systems are consumers of match events   |
| No virtual joystick for 11 players (§2, §5.2)                       | Input is a **command/decision layer**, not continuous stick input; AI owns movement         |
| Matches 2–4 min, short & replayable (§2, §5.1)                      | Compressed match clock; small pitch; deterministic seeding for variety without content cost |
| 60 FPS on ordinary phones (§15)                                     | Hard perf budget (§14), instancing, blob/low-res shadows, pooled VFX                        |
| Chunky low-poly + thick outlines (§2, §16)                          | Toon shading + inverted-hull outlines; shared materials; no PBR realism                     |
| Deterministic, reproducible bugs/events (§20)                       | Seeded PRNG, fixed timestep, command log → replay hash                                      |
| Data-driven content, no hardcoded UI stats (§20)                    | All players/traits/formations/competitions in typed data files (§7)                         |
| Extensible: add Vibers/stadiums/traits without rewriting core (§20) | Registry + factory patterns; content = data, systems = code                                 |
| No fake multiplayer, no placeholder systems (§20, §25)              | Async PvP either works end-to-end or is absent; features ship complete or not at all        |
| Retention via ownership/competition, not timers (§26)               | No server clock gating; save is local and instant; "next match" always available            |

---

## 3. Architecture overview

### 3.1 Layer diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│  PRESENTATION LAYER                                                   │
│  ┌───────────────┐   ┌────────────────────┐   ┌──────────────────┐   │
│  │ React UI      │   │ Three.js Match      │   │ Audio / Haptics  │   │
│  │ (menus, HUD,  │   │ Renderer            │   │ (WebAudio)       │   │
│  │  tactics,     │   │ (characters, pitch, │   │                  │   │
│  │  post-match)  │   │  camera, VFX)       │   │                  │   │
│  └──────▲────────┘   └─────────▲──────────┘   └────────▲─────────┘   │
│         │  events / state       │ interpolated state     │ events     │
├─────────┼───────────────────────┼────────────────────────┼───────────┤
│  BRIDGE  │  SimEvent stream      │  StateSnapshot @60Hz   │            │
│          │  InputCommand queue   │                        │            │
├──────────┴───────────────────────┴────────────────────────┴───────────┤
│  SIMULATION LAYER  (pure TypeScript, zero rendering/DOM deps)         │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────────────┐ │
│  │ Match Sim  │ │ Player AI  │ │ Ball Phys  │ │ Referee/Rules      │ │
│  │ (FSM+clock)│ │ (utility)  │ │ (2.5D)     │ │ (goals, out, cards)│ │
│  └────────────┘ └────────────┘ └────────────┘ └────────────────────┘ │
│  Deterministic: seeded PRNG · fixed 60Hz tick · command log · events  │
├───────────────────────────────────────────────────────────────────────┤
│  DOMAIN / META LAYER  (club, squad, academy, transfers, league, rival)│
│  Pure data + rules. Consumes match results/events. Produces fixtures. │
├───────────────────────────────────────────────────────────────────────┤
│  CONTENT LAYER  (typed data registries)                               │
│  Vibers · Traits · Formations · Tactics · Competitions · Cosmetics    │
├───────────────────────────────────────────────────────────────────────┤
│  PLATFORM / SERVICES  (adapters, swappable)                           │
│  SaveStore(IndexedDB) · BackendClient(local→remote) · Audio · Clock   │
└───────────────────────────────────────────────────────────────────────┘
```

### 3.2 The one rule that keeps this maintainable

**The simulation layer never imports from presentation, DOM, or Three.js.** It exposes:

- `step(dt)` — advances exactly one fixed tick
- `applyCommand(cmd)` — enqueues an input for a tick boundary
- `getSnapshot()` — cheap read for rendering
- `drainEvents()` — ordered `SimEvent[]` since last drain

This single boundary is what makes replay, async PvP, headless testing, and a future authoritative server all possible without redesign (spec §11, §20).


### 3.3 Data flow per frame

```
requestAnimationFrame(t)
  ├─ accumulator += (t - last)
  ├─ while accumulator >= TICK(1/60):
  │     sim.applyQueuedCommands(tick)
  │     sim.step(TICK)                 → mutates sim state, emits events
  │     accumulator -= TICK
  ├─ alpha = accumulator / TICK
  ├─ renderer.render(sim.getSnapshot(), alpha)   // interpolate between ticks
  └─ ui.consume(sim.drainEvents())               // HUD, goals, stats, audio
```

---

## 4. Tech stack

| Concern     | Choice                                                         | Notes                                                          |
| ----------- | -------------------------------------------------------------- | -------------------------------------------------------------- |
| Language    | **TypeScript** (strict)                                        | Single language across sim, UI, content                        |
| Build/dev   | **Vite**                                                       | Fast HMR, tiny config, good PWA plugin                         |
| 3D          | **Three.js**                                                   | Toon materials, instancing, custom shaders                     |
| UI          | **React 18** + CSS modules (or Tailwind)                       | Menus/HUD only; not in the render loop                         |
| App state   | **Zustand**                                                    | Lightweight; holds club/meta state; sim is separate            |
| Persistence | **IndexedDB** via `idb`                                        | Versioned saves + migrations; JSON export/import               |
| Audio       | **WebAudio** (Howler optional)                                 | Punchy UI + goal/crowd; must be non-essential to comprehension |
| Testing     | **Vitest** (unit/sim) + **Playwright** (e2e, mobile viewports) | Determinism + perf harness                                     |
| Lint/format | ESLint + Prettier                                              | Enforce the layer import boundary with an ESLint rule          |
| Deploy      | Static host (Vercel/Netlify) as **PWA**                        | Installable; offline-capable shell                             |

**Deliberately excluded:** a general physics engine (determinism + weight), a UI component mega-library (bundle size), any analytics SDK in MVP (privacy + weight; add later behind an adapter).

---

## 5. Repository structure

```
viber-league/
├─ docs/                         # this plan + companions
├─ public/
│  ├─ models/                    # viber_*.glb, stadium, ball
│  ├─ audio/                     # ui, goals, crowd, character voices
│  └─ icons/                     # PWA assets
├─ src/
│  ├─ sim/                       # ★ PURE. No DOM/Three imports allowed.
│  │  ├─ core/                   # world, tick loop, rng, math, vec2/3
│  │  ├─ entities/               # ball, player, team
│  │  ├─ physics/                # ball 2.5D, collisions, dribble model
│  │  ├─ ai/                     # steering, utility decisions, team tactics
│  │  ├─ rules/                  # goals, out-of-play, cards, clock, restarts
│  │  ├─ match/                  # match state machine, events, snapshot
│  │  └─ commands/               # InputCommand types + queue
│  ├─ render/                    # ★ Three.js only
│  │  ├─ scene/                  # lights, pitch, skybox
│  │  ├─ characters/             # loading, toon material, outline, anim mixer
│  │  ├─ camera/                 # follow rig, cinematic triggers
│  │  ├─ vfx/                    # pooled particles, trails, goal FX
│  │  └─ interpolation.ts
│  ├─ ui/                        # React
│  │  ├─ screens/                # per §18 screen map
│  │  ├─ components/             # Card, Button, Tab, StatBar, PlayerChip…
│  │  ├─ hud/                    # match HUD + tactical controls
│  │  └─ theme/                  # design tokens, responsive breakpoints
│  ├─ domain/                    # club, squad, academy, transfers, league, rivalry
│  ├─ content/                   # typed data: vibers, traits, formations, comps
│  ├─ services/                  # SaveStore, BackendClient, AudioService, Clock
│  └─ app/                       # bootstrap, routing, sim↔ui↔render wiring
├─ tests/
│  ├─ sim/                       # unit + determinism/replay
│  └─ e2e/                       # Playwright mobile flows
└─ tools/                        # perf harness, content validators, replay diff
```

**Enforced boundary:** an ESLint `no-restricted-imports` rule forbids `sim/**` from importing `three`, `react`, or `render/**`. This is non-negotiable — it is the spec's §20 requirement made mechanical.

---

## 6. Core simulation engine (the heart)

### 6.1 Determinism contract

- **Fixed timestep:** `TICK = 1/60 s`. Sim never sees variable `dt`.
- **Seeded PRNG:** single `mulberry32`/`xorshift128` instance owned by the sim; every stochastic choice (AI jitter, ball bounce noise, commentary variety) draws from it in a fixed order. No `Math.random()` anywhere in `sim/`.
- **Command log:** ordered `{tick, command}[]`. Replaying seed + command log reproduces the exact `SimEvent[]` and a **state hash** per N ticks.
- **No wall-clock / no `Date.now()` in sim.** Match clock is sim-tick-derived.
- **Golden replay tests:** store a few canonical seeds+inputs; CI asserts the event-log hash is unchanged. Any unintended gameplay change breaks CI loudly.
- **Cross-device hardening (post-MVP, for server authority):** migrate hot math to fixed-point or integer-based fixed-point wrappers. Isolated behind `sim/core/math`, so it's a contained change.

### 6.2 Ball physics (2.5D)

- State: `pos(x,y)`, `height z`, `vel(x,y,z)`, `spin`.
- Forces: gravity, ground friction (rolling), air drag, simple Magnus-style curve from spin.
- Bounce with restitution + tangential friction on ground; deterministic.
- **Control/dribble model:** when a player is within `controlRadius` and facing/approaching, ball is softly constrained to a lead offset with periodic "touches"; knock-ons on sprint. No full rigid-body coupling — tuned for arcade feel and cheap compute.
- Interactions: shot/pass apply an impulse vector + spin from the player's power/technique attributes and input aim.

### 6.3 Player movement

- Kinematic agents (not rigid bodies): `pos`, `vel`, `accel`, `radius`, `maxSpeed`, `accelRate`, `turnRate`.
- Steering behaviors: seek, arrive, separation (teammate spacing), lane-hold (stay in formation slot), intercept (ball), press (nearest defender), cover (second defender).
- Collisions resolved by simple circle separation + impulse; no stacking.
- Attributes modulate the constants: e.g., Volt = high `maxSpeed`/`accelRate`; Crimson Miner = high `mass`/strength (wins 50/50s, slower turn).

### 6.4 Match state machine

```
Kickoff → InPlay ⇄ (Goal | OutOfPlay→Restart) → … → HalfTime → InPlay → FullTime → Results
```

- **Half-time** is a first-class pause for tactical decisions (spec §18).
- **Restarts:** throw-in / goal-kick / corner / kickoff — simplified arcade versions, auto-arranged by AI, player only makes a decision if it matters (spec §5.2).
- **Referee rules:** goal detection (ball crossing line between posts under bar), out-of-play, fouls (contact impulse over threshold + trait modifiers), cards (Hothead ↑), advantage optional.

### 6.5 Events & snapshots

- `SimEvent` union: `Kickoff, Pass, Shot, Save, Goal, Tackle, Foul, Card, SpecialUsed, PossessionChange, HalfTime, FullTime, Substitution, Injury?`.
- Events drive: HUD updates, commentary/audio, VFX triggers, match stats, and post-match narrative (rivalry/history hooks).
- `Snapshot` is a flat, allocation-light view (typed arrays or reused objects) so the renderer can interpolate at 60 Hz without GC churn.

### 6.6 Performance discipline in sim

- Zero per-tick heap allocation in hot paths (object pools for events, reused vectors).
- AI "think" is **staggered**: each player re-evaluates decisions every N ticks (offset by index) — steering runs every tick, costly utility scoring does not.

---

## 7. Data model

Aligned to spec §19. Content is **data**, systems are **code** (spec §20).

```ts
// --- Content (static, authored) ---
type ViberType = 'crimson_miner' | 'moss' | 'volt' | 'phantom';
interface ViberDef {
  id: ViberType;
  archetype: 'power' | 'defensive' | 'speed' | 'trickster';
  modelAsset: string;              // glb
  baseAttributes: Attributes;
  signatureAbility: AbilityDef;    // the "Special"
  animationSet: string;
  personalityBias: TraitId[];      // default lean
}

interface Attributes {            // 0–99 scale
  pace: number; acceleration: number; strength: number;
  stamina: number; technique: number; passing: number;
  shooting: number; tackling: number; positioning: number;
  vision: number; aggression: number; composure: number;
}

interface TraitDef { id: TraitId; effects: TraitEffect[]; // e.g. Clutch: +X in last 10 min
}

interface FormationDef { id: string; slots: Slot[]; }     // normalized 0–1 pitch coords
interface Slot { role: RoleId; pos: Vec2; lane: 'L'|'C'|'R'; }

// --- Runtime / save entities ---
interface Player {
  id: string; viber: ViberType; name: string; age: number;
  position: Position; attributes: Attributes; potential: Attributes;
  traits: TraitId[]; morale: number; form: number;
  contract: { salary: number; expiresSeason: number };
  development: { xp: number; focus: TrainingFocus };
}
interface Club {
  id: string; name: string; badge: BadgeConfig; colors: KitColors;
  stadium: StadiumState; division: number; season: number;
  reputation: number; records: ClubRecords;
  squad: { playerIds: string[]; lineup: string[]; bench: string[];
           captainId: string; tactics: Tactics };
  academy: Prospect[]; history: ClubHistory;
}
interface Tactics {
  formationId: string; mentality: Mentality;       // attack|balanced|defend|counter
  pressing: number; lineHeight: number;
  roleOverrides?: Record<string, RoleId>;
}
interface Match {
  id: string; homeId: string; awayId: string;
  tacticsSnapshot: { home: Tactics; away: Tactics };
  seed: number; events: SimEvent[]; score: [number, number];
  stats: MatchStats; timestamp: number;
}
interface Season { id: string; division: number; fixtures: Fixture[];
                   standings: StandingRow[]; rules: PromotionRelegationRules; }
interface Rivalry { aId: string; bId: string; meetings: number;
                    aWins: number; bWins: number; draws: number;
                    notable: RivalryEvent[]; }
interface Prospect { id: string; viber: ViberType; visiblePotential: PotentialBand;
                     hiddenPotential: number; attributes: Attributes;
                     traits: TraitId[]; stage: DevelopmentStage; }
interface TransferOffer { fromId: string; toId: string; playerId: string;
                          fee: number; salary: number; status: 'open'|'accepted'|'rejected'|'countered'; }
```


**Content validation:** a `tools/validate-content.ts` script fails the build if any Viber/trait/formation references a missing asset, id, or slot role — prevents "data drift" as content grows.

---

## 8. AI & tactics

### 8.1 Team layer

- **Formation** defines normalized slots; players are assigned to slots and hold them relative to ball position (attack/defense shift).
- **Mentality** (Attack / Balanced / Defend / Counter) is a small parameter set that shifts slot offsets, pressing line, and decision weights — a *few dials*, not a slider wall (spec §5.2: "do not turn the match into a menu simulator").
- **Counter** temporarily boosts transition speed and forward runs for a short window after possession is won.

### 8.2 Player layer (utility-based)

Every think-tick, a player scores candidate actions and picks the max (with a small seeded jitter for personality):

```
score(action) = w_ctx · contextFit        // e.g. "shoot" fits only if near goal + clear line
              + w_role · roleFit          // striker values shooting runs; CB values holding shape
              + w_trait · traitBias       // Showboat ↑ flashy; Wall ↑ hold; Hothead ↑ tackle
              + w_attr · attributeFit     // technique/shooting modulate
              - riskPenalty               // Hothead lowers this
```

Candidate actions: `SeekBall, Support, HoldShape, Mark, Press, Intercept, Carry, Pass, ThroughBall, Cross, Shoot, Tackle, Clear, HoldPosition, UseSpecial`.

- **Ball-carrier decisions** and **off-ball decisions** use the same scorer with different context features.
- **Special ability** is a team/character ability on cooldown; surfaced to the human as the "Special" button; AI may auto-use per trait/context.

### 8.3 The human's role (command layer)

Human inputs are **commands**, not movement:

```ts
type InputCommand =
  | { type: 'SetMentality'; value: Mentality }
  | { type: 'UseSpecial' }
  | { type: 'ContextAction'; action: 'Shoot'|'Pass'|'Cross'|'ThroughBall'|'Tackle'|'HoldPosition' }
  | { type: 'Pause' } | { type: 'Substitute'; out: string; in: string };
```

- The system **surfaces** contextual action prompts only when they matter (spec §5.2) — e.g., a "Shoot" prompt appears when the ball carrier is in a shooting zone with a clear angle. Prompts are a UI concern; the sim just accepts the command if valid that tick.
- Commands are queued and applied at tick boundaries → fully replayable.

### 8.4 Difficulty & variety

- Difficulty tunes AI reaction latency, decision noise, and pressing aggression — **not** hidden stat cheats.
- Seed variation produces different micro-events so repeated fixtures don't feel identical (spec §5.1).

---

## 9. Rendering & art pipeline

### 9.1 Character rendering

- **Model:** chunky low-poly, exaggerated proportions, thick outlines, bright materials (spec §16).
- **Material:** `MeshToonMaterial` with a 3–4 step gradient map for the cel look.
- **Outline:** inverted-hull — duplicate mesh, back-face, scaled by a normal offset, black, `depthWrite` off, rendered first. Per-mesh offset tuning so outline thickness reads consistently at small phone sizes.
- **Animation:** skeletal, shared rig across Vibers; a common locomotion set (idle/run/sprint/turn) + per-Viber signature clips; an `AnimationMixer` per instance, blended by speed.
- **Football kits** are re-skins/textures over the existing Viber bodies (spec §16), not new models.

### 9.2 Pitch & stadium

- Stylized pitch: flat, high-contrast, readable markings; a small set of low-poly stadium props (stands, banners, floodlights) that can be swapped per stadium identity.
- **Vibe Vibe / Viber branding** appears on banners, ad boards, and goal celebrations (spec §2, §13).

### 9.3 Lighting & shadows

- Hemisphere + single directional light.
- Shadows: **blob shadows** by default (cheap, readable); one low-res directional shadow map (512–1024) as an optional quality tier.

### 9.4 VFX (pooled)

- Goal explosion, net ripple, confetti, crowd flash, speed lines, tackle dust, special-ability FX. All pooled; hard cap on live particles (§14).

### 9.5 Camera

- **Portrait:** elevated angled follow-cam that keeps ball + key players in frame, dynamic zoom by ball danger, clamped so goals are always readable.
- **Cinematic triggers:** brief goal/special shots that never block input and auto-return.
- **Landscape match mode:** wider FOV, same rig; transition is explicit and polished (spec §15).

### 9.6 Quality tiers (auto-detected + user override)

| Tier   | Shadows         | Particles | Outline    | Render scale |
| ------ | --------------- | --------- | ---------- | ------------ |
| High   | 1024 shadow map | full      | full       | 1.0          |
| Medium | 512             | reduced   | full       | 0.85         |
| Low    | blob only       | minimal   | simplified | 0.7          |

---

## 10. Match presentation & feel

- **Goals:** camera emphasis + character celebration clip + crowd audio swell + particle burst + banner/branding moment (spec §5.3).
- **Understandable without sound:** every audio cue has a visual counterpart (spec §5.3, §17).
- **Pause safe on mobile:** pause is authoritative in the sim (halts ticks) and restores cleanly on resume / tab-blur (spec §5.3, §15).
- **Post-match:** clear stats (possession, shots, xG-lite, top performer), memorable moments timeline, development results, next-fixture CTA (spec §18).

---

## 11. UI/UX architecture (mobile-first)

- **Screens** (spec §18): Splash, Home/Club, Squad, Player detail, Academy, Training, Transfers, League/standings, Fixtures, Match prep, Live match, Half-time, Post-match, Club history, Rivalries, Stadium/customization, Settings.
- **Home answers three questions immediately:** Who am I playing next? How is my club doing? What should I do next? (spec §18).
- **Components (reusable, spec §20):** Card, Button, Tab, StatBar, PlayerChip, TraitBadge, MomentumMeter, FixtureRow, ExpandableSection.
- **Rules:** comfortable touch targets (≥44px), no hover dependence, large readable text, cards/tabs over dense tables, one-thumb reach for primary actions, responsive breakpoints (narrow phone / large phone / tablet / desktop), safe-area insets respected (spec §15).
- **Design tokens:** color, spacing, type scale, radii in one theme module so visual identity stays consistent and themeable.

---

## 12. Persistence & save system

- **Store:** IndexedDB (`idb`) with a **versioned schema** + forward migrations.
- **Autosave** after every match and after any squad/tactics change (debounced).
- **Save integrity:** write to a temp key then swap (avoid partial saves on mobile tab kill).
- **Export/Import:** JSON download/upload for backup + debugging (also the vehicle for future cloud sync).
- **`SaveStore` interface** so IndexedDB can be swapped for a cloud store later without touching domain code.

---

## 13. Backend & async PvP (designed now, built later)

**MVP: no backend.** But the seams are designed so §11 async PvP drops in without redesign.

- **`BackendClient` interface** with a `LocalBackend` (MVP: mock/no-op, single-player league) and a future `RemoteBackend`.
- **Async PvP model:** an opponent club is stored as a **snapshot** — lineup, formation, tactics, behavioral params, player attributes. The match is simulated **on the player's device** with a server-provided `seed`; the opponent side is driven by their saved tactic profile using the same AI. Result + replay hash are submitted.
- **Fairness/anti-cheat seam:** because sim is deterministic and the command log + seed are recorded, results are **replay-verifiable** server-side later. Cross-device determinism (§6.1) becomes mandatory at that point.
- **When we add a backend**, prefer the built-in `cloud-service` skill (DB + auth + storage + functions) to avoid bespoke infra. Auth, club snapshots, fixtures/matchmaking, leaderboards, and rivalry sync are the initial resources.

---

## 14. Performance budget (mid-tier Android, portrait)

| Metric                   | Target            | Hard ceiling        |
| ------------------------ | ----------------- | ------------------- |
| Frame time               | ≤ 8 ms CPU+GPU    | 16.6 ms (60 FPS)    |
| Draw calls               | ≤ 40              | 60                  |
| Triangles on screen      | ≤ 90k             | 150k                |
| Texture memory           | ≤ 30 MB           | 40 MB               |
| Live particles           | ≤ 300             | 500                 |
| Shadow maps              | 0 (blob) / 1×512  | 1×1024              |
| JS heap growth in match  | ~0 steady         | no unbounded growth |
| Cold load (4G)           | ≤ 3 s to playable | 5 s                 |
| Per-tick sim allocations | 0 in hot path     | 0                   |

**Tools:** a `tools/perf-harness` page that runs a scripted match, records frame times, draw calls, and memory; run on real devices via remote debugging before each milestone. Graceful degradation via quality tiers (§9.6).

---

## 15. Testing strategy

| Layer                  | Tool                                  | What it protects                                                          |
| ---------------------- | ------------------------------------- | ------------------------------------------------------------------------- |
| Sim unit               | Vitest                                | Physics, AI scoring, rules edge cases                                     |
| **Determinism/replay** | Vitest + golden hashes                | Same seed+inputs → identical event log; catches accidental gameplay drift |
| Content validation     | `tools/validate-content`              | No dangling ids/assets; data stays consistent                             |
| Domain rules           | Vitest                                | Promotion/relegation, transfer/contract math, academy generation          |
| E2E                    | Playwright (iPhone/Android viewports) | Onboarding, prepare→play→result→improve loop, safe-area/touch             |
| Perf                   | perf-harness + device runs            | Budgets in §14                                                            |
| Visual (optional)      | screenshot diff                       | Art direction regressions                                                 |


## 17. MVP definition & acceptance criteria

Per spec §22, the MVP is the **smallest version that proves the game is worth returning to** — roughly **M0–M9 plus a minimal league table (part of M12)**.

**MVP must contain:**

- 4 recognizable Vibers; 1 stylized stadium/pitch
- Small-sided match, ~2–4 min
- Useful AI teammates/opponents
- Meaningful tactical controls
- Goals + satisfying presentation
- Basic club creation
- Basic squad/player development
- Simple league table + progression
- Mobile-first responsive interface
- One complete loop: **prepare → play → result → improve → next match**

**Acceptance tests (spec §24):**

- [ ] A player wants to play one more match
- [ ] A new player understands the match on a phone
- [ ] The Vibers are clearly distinguishable and feel different
- [ ] A win is satisfying; a loss is understandable
- [ ] The club feels like it belongs to the player
- [ ] There's a clear reason to care about the next match
- [ ] It looks like Viber, not generic football
- [ ] It holds 60 FPS on an ordinary phone
- [ ] Menus support the game, not replace it

**MVP explicitly excludes:** async PvP, cups, deep transfer market, cosmetics store, multiple stadiums, real-time multiplayer.

---

## 18. Risks & mitigations

| Risk                                    | Impact           | Mitigation                                                                                                       |
| --------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| Match isn't fun by M5                   | Project-defining | Gate at M5; iterate on feel before any meta-system; tune AI/physics/pacing first                                 |
| Mobile perf (outlines + particles + 3D) | High             | Budget §14, quality tiers §9.6, blob shadows, instancing, real-device testing each milestone                     |
| AI feels dumb / "watching a bad sim"    | High             | Utility AI with role/trait context; staggered think; extensive tuning harness; difficulty via latency not cheats |
| Camera readability in portrait          | Medium           | Dynamic follow-cam, clamped framing, readability tests at narrow widths                                          |
| Determinism drift breaks replays        | Medium           | Golden replay hashes in CI; fixed timestep; no `Math.random`/clock in sim                                        |
| Scope creep (spec is large)             | High             | Strict milestone order; "does it improve the core loop?" filter (spec §27); MVP excludes meta online systems     |
| Content drift (assets/ids)              | Low              | `validate-content` in CI                                                                                         |
| Art asset availability (Viber models)   | Medium           | Confirm assets exist early (Open question Q3); fallback = recreate from Viber Brawl reference                    |

---

## 19. Open questions (need answers before build)

1. **Platform confirm (D1):** Web/PWA, or native? (Plan assumes web.)
2. **Backend timing (D5):** Confirm MVP is fully local; when do we want async PvP — right after MVP, or later?
3. **Art assets:** Do we have the Viber Brawl character models/rigs (GLB/GLTF) and rights to reuse, or do we recreate them from the reference site? This gates M1.
4. **Target devices:** What is the minimum phone we must hold 60 FPS on? (Sets the perf tier floor.)
5. **Monetization stance:** Spec forbids pay-to-win/timers — is the game fully free, or cosmetic-only monetization later? (Affects architecture seams only.)
6. **Offline requirement:** Must the whole game work offline (PWA), or only the shell + single-player? (Affects save/sync design.)
7. **Match orientation final call (D7):** Portrait match, landscape match, or both?

---

## 20. Immediate next steps after sign-off

1. Confirm D1–D10 and answer §19.
2. Produce `MVP_TASK_BREAKDOWN.md` — M0–M9 as concrete tickets with acceptance criteria.
3. Scaffold the repo: Vite + TS + Three.js + React + the `sim/` boundary lint + perf harness (M0).
4. Confirm art assets (Q3) and lock the Viber→football reinterpretation (roles, attributes, abilities).
5. Build M1→M5 in tight increments; run the **M5 fun gate** before anything else.

---

*This plan is a living document. Update it when decisions change; keep the spec as the product source of truth and this as the engineering source of truth.*
