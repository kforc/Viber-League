// sim/engine.ts — the match loop. Deterministic, fixed-timestep, pure.

import {
  angleOf,
  clamp,
  dist,
  fromAngle,
  len,
  norm,
  scale,
  sub,
  v2,
  type Vec2,
} from './core/math';
import {
  ACTION_COOLDOWN,
  BALL_RADIUS,
  CONTROL_RADIUS,
  CROSS_SPEED,
  DISPLAY_MINUTES,
  GOAL_H,
  GOAL_HALF_W,
  GOAL_PAUSE,
  KEEP_IN_REACH,
  KEEPER_CONTROL_RADIUS,
  KEEPER_SAVE_REACH,
  KICKOFF_PAUSE,
  LONG_PASS_DISTANCE,
  LONG_SHOT_RANGE,
  PASS_SPEED_BASE,
  PENALTY_AREA_DEPTH,
  PITCH_HALF_L,
  PITCH_HALF_W,
  SHOT_SPEED,
  SHOOT_RANGE,
  SPECIAL_COOLDOWN,
  SPECIAL_DURATION,
} from './constants';
import {
  dribbleBall,
  integrateBall,
  integratePlayer,
  kickBall,
  resolvePlayerCollisions,
} from './physics';
import { bestPassTarget, updateAI } from './ai';
import { awardFromOutOfPlay, restartTaker, runSetPiece } from './setpiece';
import { resetPositions } from './world';
import { weatherMods } from './weather';
import type { Command, Player, TeamId, World } from './types';

export function currentMinute(w: World): number {
  return clamp(
    Math.floor((w.clock / (w.halfSeconds * 2)) * DISPLAY_MINUTES),
    0,
    DISPLAY_MINUTES,
  );
}

function findCarrier(w: World, team: TeamId): Player | null {
  if (w.ball.owner === null) return null;
  const p = w.players.find((x) => x.id === w.ball.owner);
  return p && p.team === team ? p : null;
}

/** Execute shoot / pass / clear for a carrier, else dribble. */
function handleCarrier(w: World, p: Player): void {
  const b = w.ball;

  if (p.cooldown > 0) {
    dribbleBall(w, p, 1 / 60);
    return;
  }

  const goal = v2(p.team === 0 ? PITCH_HALF_L : -PITCH_HALF_L, 0);

  if (p.decision === 'shoot') {
    // Accuracy degrades with distance and improves with the shooter's skill
    // (spec §5.1: unpredictable but readable). The spread is wide enough that
    // shots genuinely miss — which is where goal kicks and corners come from.
    const dGoal = dist(p.pos, goal);
    const skill = 1.25 - (p.attrs.shooting / 99) * 0.55; // 0.70 (elite) .. 1.25
    const spread = (0.95 + dGoal * 0.3) * weatherMods(w.weather).shotSpread * skill;
    // A long shot is aimed at a corner and hit harder; a close-range finish is
    // placed rather than blasted.
    const long = dGoal > SHOOT_RANGE;
    const corner = long ? (w.rng.range(0, 1) < 0.5 ? -1 : 1) * GOAL_HALF_W * 0.6 : 0;
    const aim = v2(goal.x, goal.y + corner + w.rng.range(-spread, spread));
    const power =
      SHOT_SPEED * (0.82 + (p.attrs.shooting / 99) * 0.4) * (long ? 1.14 : 1);
    kickBall(w, p, sub(aim, p.pos), power, w.rng.range(0.5, 2.0));
    w.stats.shots[p.team] += 1;
    const onTarget = Math.abs(aim.y) < GOAL_HALF_W;
    w.events.push({ type: 'shot', team: p.team, player: p.id, onTarget });
    p.cooldown = ACTION_COOLDOWN;
    p.decision = 'dribble';
    return;
  }

  if (p.decision === 'pass') {
    const target = p.intentTarget ?? bestPassTarget(w, p);
    if (target) {
      const d = dist(p.pos, target);
      const aim = sub(target, p.pos);
      // Passing is a skill, not a laser: the weaker the passer and the longer
      // the ball, the wider the error cone.
      const err = (1 - p.attrs.passing / 99) * (0.05 + clamp(d, 0, 22) * 0.011);
      const dir = fromAngle(angleOf(aim) + w.rng.range(-err, err), 1);
      // A long ball is lofted over the lines; a short one is rolled.
      const lofted = d > LONG_PASS_DISTANCE;
      const speed =
        (PASS_SPEED_BASE + clamp(d * 0.95, 0, 11)) * (0.88 + p.attrs.passing / 700);
      kickBall(w, p, dir, speed, lofted ? clamp(2.2 + d * 0.18, 2.2, 6.0) : 0);
      w.stats.passes[p.team] += 1;
      w.events.push({ type: 'pass', team: p.team, player: p.id });
    }
    p.cooldown = ACTION_COOLDOWN * 0.6;
    p.decision = 'dribble';
    p.intentTarget = null;
    return;
  }

  if (p.decision === 'cross') {
    // Whipped in from wide: lofted towards the head of the most central
    // attacker, which is how corners and headers are won.
    const target = p.intentTarget ?? v2(goal.x, 0);
    const d = dist(p.pos, target);
    const loft = clamp(3.0 + d * 0.2, 3.0, 6.5);
    kickBall(w, p, sub(target, p.pos), CROSS_SPEED, loft);
    w.stats.passes[p.team] += 1;
    w.events.push({ type: 'pass', team: p.team, player: p.id });
    p.cooldown = ACTION_COOLDOWN * 0.75;
    p.decision = 'dribble';
    p.intentTarget = null;
    return;
  }

  if (p.decision === 'clear') {
    const aim = v2(goal.x, w.rng.range(-6, 6));
    kickBall(w, p, sub(aim, p.pos), 20, 3.2);
    p.cooldown = ACTION_COOLDOWN;
    p.decision = 'dribble';
    return;
  }

  dribbleBall(w, p, 1 / 60);
}

function computeOffers(w: World): void {
  const offers: Array<'shoot' | 'pass' | 'clear'> = [];
  const carrier = findCarrier(w, 0);
  if (carrier) {
    const goal = v2(PITCH_HALF_L, 0);
    // Long shots are on offer too, as long as there is a sight of goal.
    if (dist(carrier.pos, goal) < LONG_SHOT_RANGE) offers.push('shoot');
    if (bestPassTarget(w, carrier)) offers.push('pass');
    if (carrier.pos.x < -PITCH_HALF_L * 0.2) offers.push('clear');
  }
  w.offers = offers;
}

/**
 * A player right on the line can still stretch and keep the ball in play.
 *
 * Only the side that would *win* the restart may do it (otherwise it would be
 * a foul throw), and only if they are genuinely within reach. This is the last
 * line of defence against the ball trickling out while a player stands next to
 * it — the thing that made possession feel so cheap.
 */
function tryKeepIn(w: World, out: { axis: 'x' | 'y'; side: 1 | -1 }): boolean {
  const b = w.ball;
  if (b.h > 0.75) return false;

  // Which side is entitled to the restart?
  const entitled = restartTaker(w, out);

  let best: Player | null = null;
  let bd = Infinity;
  for (const p of w.players) {
    if (p.team !== entitled || p.isGK) continue;
    const d = dist(p.pos, b.pos);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  if (!best || bd > KEEP_IN_REACH) return false;

  // Stretched and got there. Put the ball back in play at their feet.
  b.owner = best.id;
  b.lastTouch = best.id;
  b.vel = v2(0, 0);
  b.vh = 0;
  b.h = BALL_RADIUS;
  b.looseTimer = 0.2;
  b.pos = v2(
    clamp(b.pos.x, -PITCH_HALF_L + 0.5, PITCH_HALF_L - 0.5),
    clamp(b.pos.y, -PITCH_HALF_W + 0.5, PITCH_HALF_W - 0.5),
  );
  w.events.push({ type: 'tackle', team: best.team, player: best.id, won: true });
  return true;
}

function applyCommand(w: World, c: Command): void {
  switch (c.type) {
    case 'mentality':
      w.teams[c.team].mentality = c.value;
      break;
    case 'special': {
      const t = w.teams[c.team];
      if (t.specialCooldown <= 0) {
        t.specialTimer = SPECIAL_DURATION;
        t.specialCooldown = SPECIAL_COOLDOWN;
        w.events.push({ type: 'special', team: c.team, player: -1 });
      }
      break;
    }
    case 'action': {
      const carrier = findCarrier(w, c.team);
      if (!carrier) break;
      if (c.value === 'shoot') carrier.decision = 'shoot';
      if (c.value === 'pass') {
        carrier.decision = 'pass';
        carrier.intentTarget = bestPassTarget(w, carrier);
      }
      if (c.value === 'clear') carrier.decision = 'clear';
      carrier.cooldown = 0; // player command overrides the AI cooldown
      break;
    }
    case 'dive':
      // Only the defending human keeper can commit a dive, and only before
      // the kick. A delayed or spoofed command cannot rewrite a shot in flight.
      if (w.setPiece?.kind === 'penalty' && w.setPiece.team !== c.team &&
          w.teams[c.team].isHuman) {
        w.penaltyDive = c.value;
      }
      break;
    case 'resume':
      if (w.phase === 'halftime') {
        w.half = 2;
        w.kickoffTeam = 1; // the other side kicks off the second half
        resetPositions(w, 'kickoff');
        w.phase = 'kickoff';
        w.phaseTimer = KICKOFF_PAUSE;
      }
      break;
    case 'pause':
      w.paused = c.value;
      break;
  }
}

/**
 * Resolve a penalty as a moving ball, not an instant score roll. During the
 * flight everyone holds their set-piece station; only the keeper slides to
 * the lane chosen *before* the shot. Contact is checked where the ball crosses
 * the keeper's plane, and the ordinary goal/out physics decides the rest.
 */
function advancePenaltyShot(w: World, dt: number): void {
  const shot = w.penaltyShot;
  if (!shot) return;
  const b = w.ball;
  const dir = shot.team === 0 ? 1 : -1;
  const goalLine = dir * PITCH_HALF_L;
  const keeperLine = goalLine - dir * 1.3;
  const keeper = w.players.find((p) => p.id === shot.keeper) ?? null;
  const diveY = shot.dive === 'left' ? -1.35 : shot.dive === 'right' ? 1.35 : 0;
  const before = v2(b.pos.x, b.pos.y);
  const beforeH = b.h;
  shot.elapsed += dt;
  if (keeper) {
    // An actual lateral dive visible on the pitch, not just a hidden roll.
    keeper.pos.y = diveY * Math.min(1, shot.elapsed / 0.25);
    keeper.vel = v2(0, 0);
  }

  const outcome = integrateBall(w, dt);
  const crossed = (before.x - keeperLine) * dir < 0 && (b.pos.x - keeperLine) * dir >= 0;
  if (crossed && keeper) {
    // Interpolate at the keeper line rather than using this tick's endpoint;
    // the outcome must not change if a test uses a smaller fixed timestep.
    const t = (keeperLine - before.x) / (b.pos.x - before.x);
    const contactY = before.y + (b.pos.y - before.y) * t;
    const contactH = beforeH + (b.h - beforeH) * t;
    const skill = (keeper.attrs.tackling * 0.5 + keeper.attrs.technique * 0.3 +
      keeper.attrs.pace * 0.2) / 99;
    const reach = 0.7 + skill * 0.32;
    if (Math.abs(contactY - diveY) <= reach && contactH < GOAL_H) {
      b.pos = v2(keeperLine, contactY);
      keeper.pos.y = contactY;
      b.owner = keeper.id;
      b.lastTouch = keeper.id;
      b.vel = v2(0, 0);
      b.vh = 0;
      b.h = BALL_RADIUS;
      b.looseTimer = 0.2;
      b.saveCooldown = 0.7;
      w.penaltyShot = null;
      w.phase = 'play';
      w.events.push({ type: 'save', team: keeper.team, keeper: keeper.id });
      return;
    }
  }

  if (outcome.goal !== null) {
    w.penaltyShot = null;
    onGoal(w, outcome.goal);
  } else if (outcome.out) {
    w.penaltyShot = null;
    awardFromOutOfPlay(w, outcome.out);
  }
}

/** Clock transitions shared by open play and a penalty in flight. */
function advanceClock(w: World, dt: number): void {
  if (w.phase === 'halftime' || w.phase === 'fulltime') return;
  w.clock += dt;
  if (w.half === 1 && w.clock >= w.halfSeconds) {
    w.penaltyShot = null;
    w.phase = 'halftime';
    w.events.push({ type: 'whistle', kind: 'halftime' });
    w.events.push({ type: 'halftime' });
  } else if (w.half === 2 && w.clock >= w.halfSeconds * 2) {
    w.penaltyShot = null;
    w.phase = 'fulltime';
    w.events.push({ type: 'whistle', kind: 'fulltime' });
    w.events.push({ type: 'fulltime', score: [w.teams[0].score, w.teams[1].score] });
  }
}

/** Advance the world by exactly one fixed tick. */
export function step(w: World, dt: number): void {
  if (w.paused) return;
  w.tick += 1;

  // Drain commands at the tick boundary.
  if (w.pending.length) {
    for (const c of w.pending) applyCommand(w, c);
    w.pending.length = 0;
  }

  // Phase timers
  if (w.phase === 'kickoff') {
    w.phaseTimer -= dt;
    if (w.phaseTimer <= 0) {
      w.phase = 'play';
      // The whistle goes before the kick, the way it does on a real pitch.
      w.events.push({ type: 'whistle', kind: 'kickoff' });
      w.events.push({ type: 'kickoff', half: w.half });
    }
  } else if (w.phase === 'goal') {
    w.phaseTimer -= dt;
    if (w.phaseTimer <= 0) {
      resetPositions(w, 'kickoff');
      w.phase = 'kickoff';
      w.phaseTimer = KICKOFF_PAUSE;
    }
  } else if (w.setPiece && w.phase === w.setPiece.kind) {
    // A corner, throw-in, goal kick, free kick or penalty. Players are already
    // steering to their set-piece stations; the taker strikes it when the
    // timer runs out. Penalties launch a separate in-flight phase.
    // (The `phase === kind` check means a restart left pending when the clock
    // runs out does not resurrect the match after half-time or full-time.)
    const scored = runSetPiece(w, dt);
    if (scored !== null) onGoal(w, scored);
  }

  // Team timers tick down regardless.
  for (const t of w.teams) {
    if (t.specialTimer > 0) t.specialTimer -= dt;
    if (t.specialCooldown > 0) t.specialCooldown -= dt;
  }
  if (w.tackleLock > 0) w.tackleLock -= dt;

  if (w.phase === 'penaltyshot') {
    // No loose-ball claims, tackles or AI movement before the ball has passed
    // the keeper. Otherwise an outfielder can scoop it up mid-penalty.
    advancePenaltyShot(w, dt);
    w.offers = [];
    advanceClock(w, dt);
    return;
  }

  // AI + movement always run so players settle during pauses.
  updateAI(w, dt);
  for (const p of w.players) integratePlayer(p, w, dt);
  resolvePlayerCollisions(w);

  // Ball
  const b = w.ball;
  // The ball keeps *travelling* through a goal celebration, but nobody plays it:
  // once the ball is dead a keeper must not scoop it up and boot it back over
  // the line while the replay is still playing.
  const live = w.phase === 'play' || w.phase === 'goal';
  const playable = w.phase === 'play';
  if (live) {
    if (b.owner !== null) {
      const owner = w.players.find((x) => x.id === b.owner);
      if (owner && playable) {
        handleCarrier(w, owner);
        // A carried ball can still be walked over the line (and a keeper who
        // fails to claim it should be punished).
        if (
          w.phase === 'play' &&
          Math.abs(b.pos.x) > PITCH_HALF_L &&
          Math.abs(b.pos.y) < GOAL_HALF_W &&
          b.h < GOAL_H
        ) {
          onGoal(w, b.pos.x > 0 ? 0 : 1);
        }
      } else b.owner = null;
    } else {
      const outcome = integrateBall(w, dt);
      if (outcome.goal !== null && w.phase === 'play') {
        onGoal(w, outcome.goal);
      } else if (outcome.out && w.phase === 'play') {
        // Out of play — unless somebody can still stretch and keep it in.
        if (!tryKeepIn(w, outcome.out)) awardFromOutOfPlay(w, outcome.out);
      } else if (playable && b.owner === null && b.looseTimer <= 0) {
        // Loose-ball control: the NEAREST player wins the ball (fair 50/50s).
        let best: Player | null = null;
        let bd = Infinity;
        for (const p of w.players) {
          const maxH = p.isGK ? GOAL_H : 0.75;
          if (b.h > maxH) continue;
          const reach = p.isGK ? KEEPER_CONTROL_RADIUS : CONTROL_RADIUS;
          const d = dist(p.pos, b.pos);
          if (d <= reach && d < bd) {
            bd = d;
            best = p;
          }
        }
        if (best) {
          const speedNow = len(b.vel);
          const ownLine = best.team === 0 ? -PITCH_HALF_L : PITCH_HALF_L;
          // Team 0 defends -x, so "towards their own goal" is -x for them.
          const towardOwnGoal = best.team === 0 ? -1 : 1;
          const upfield = -towardOwnGoal;
          const ySign = b.pos.y >= 0 ? 1 : -1;
          /** Push the ball behind the goal line off the defender — a corner. */
          const deflectBehind = (): void => {
            b.lastTouch = best!.id;
            b.owner = null;
            b.pos = v2(ownLine, ySign * (GOAL_HALF_W + 0.8));
            b.vel = v2(towardOwnGoal * 8, ySign * 4);
            b.h = BALL_RADIUS;
            b.vh = 0;
            b.looseTimer = 0.3;
          };

          if (best.isGK && speedNow > 8 && b.saveCooldown <= 0) {
            // A shot is coming in. Stopping it is a dive, not a catch: the
            // keeper only covers KEEPER_SAVE_REACH and only gets one dive per
            // shot. Straight at them -> held. Reaching for it -> fingertips and
            // behind for a corner. Beaten all ends up -> goal.
            const reflex =
              (best.attrs.tackling * 0.5 +
                best.attrs.technique * 0.3 +
                best.attrs.pace * 0.2) /
              99;
            b.saveCooldown = 0.5;

            if (bd <= KEEPER_SAVE_REACH) {
              if (w.rng.range(0, 1) < 0.22 + reflex * 0.42) {
                // Held.
                b.owner = best.id;
                b.lastTouch = best.id;
                b.vel = v2(0, 0);
                w.events.push({ type: 'save', team: best.team, keeper: best.id });
              } else if (w.rng.range(0, 1) < 0.18) {
                // Beaten but gets a fingertip to it: turned behind for a corner.
                deflectBehind();
                w.events.push({ type: 'save', team: best.team, keeper: best.id });
              }
              // Otherwise it is a goal.
            } else if (w.rng.range(0, 1) < 0.15 + reflex * 0.25) {
              // Stretched full length and just reached it — behind for a corner.
              deflectBehind();
              w.events.push({ type: 'save', team: best.team, keeper: best.id });
            }
            // Otherwise the keeper is beaten all ends up — it is a goal.
          } else if (speedNow > 12 && b.saveCooldown <= 0) {
            // A shot blocked by an outfield defender. The ball deflects away,
            // and a block near their own byline usually goes out for a corner.
            b.saveCooldown = 0.4;
            b.lastTouch = best.id;
            b.owner = null;
            b.h = BALL_RADIUS;
            b.vh = 0;
            b.looseTimer = 0.3;
            if (
              Math.abs(best.pos.x - ownLine) < PENALTY_AREA_DEPTH &&
              w.rng.range(0, 1) < 0.35
            ) {
              deflectBehind();
            } else {
              // Half-blocked, still in play.
              b.vel = v2(upfield * 6, ySign * 5);
            }
          } else {
            b.owner = best.id;
            b.lastTouch = best.id;
          }
        }
      }
    }
    if (b.looseTimer > 0) b.looseTimer -= dt;
    if (b.saveCooldown > 0) b.saveCooldown -= dt;
  }

  // Possession + offers (only while in live play)
  if (w.phase === 'play') {
    if (b.owner !== null) {
      const owner = w.players.find((x) => x.id === b.owner);
      if (owner) {
        w.possession = owner.team;
        w.stats.possession[owner.team] += 1;
      }
    }
    computeOffers(w);
  } else {
    w.offers = [];
  }

  // The clock runs through dead balls as well as live play. A penalty in
  // flight takes the same path via the early branch above.
  advanceClock(w, dt);
}

function onGoal(w: World, team: TeamId): void {
  const b = w.ball;
  const scorer = b.lastTouch !== null ? b.lastTouch : -1;
  w.teams[team].score += 1;
  w.lastGoalTeam = team;
  w.kickoffTeam = (team === 0 ? 1 : 0) as TeamId; // conceding side restarts
  w.phase = 'goal';
  w.phaseTimer = GOAL_PAUSE;
  w.setPiece = null;
  w.penaltyShot = null;
  w.events.push({ type: 'goal', team, scorer, minute: currentMinute(w) });
  // The referee points to the centre spot. Emitted after the goal so the crowd
  // roar starts first and the whistle cuts across it.
  w.events.push({ type: 'whistle', kind: 'goal' });
  b.owner = null;
  b.vel = v2(0, 0);
}

export function drainEvents(w: World) {
  const out = w.events;
  w.events = [];
  return out;
}

export function queue(w: World, c: Command): void {
  w.pending.push(c);
}
