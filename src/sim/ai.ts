// sim/ai.ts — the decision layer and steering targets (spec §5.2, §8).
//
// Three jobs live here:
//
//   1. think()      — one staggered decision tick per player (shoot/pass/chase…)
//   2. moveTarget() — where that decision sends them
//   3. updateTeamAI() — the CPU's own brain, which never reads the human's
//                       tactical button
//
// The thing that makes the football work is that players read the ball's
// *future* position (see `interceptPoint` in physics.ts), not its current one.
// Chasing a moving ball by its present position is why loose balls used to run
// out for throw-ins: the player arrives where the ball was.

import {
  add,
  clamp,
  dist,
  len,
  norm,
  scale,
  sub,
  v2,
  type Vec2,
} from './core/math';
import {
  ACTION_COOLDOWN,
  ARRIVE_RADIUS,
  CROSS_RANGE,
  FOUL_CHANCE_BOX,
  FOUL_CHANCE_OPEN,
  GOAL_HALF_W,
  INTERCEPT_HORIZON,
  KEEP_IN_HORIZON,
  KEEP_IN_SPRINT_MULT,
  LONG_SHOT_MIN_SHOOTING,
  LONG_SHOT_RANGE,
  LONG_SHOT_SPACE,
  PASS_MIN_ADVANCE,
  PENALTY_AREA_DEPTH,
  PENALTY_AREA_HALF_W,
  PITCH_HALF_L,
  PITCH_HALF_W,
  SEPARATION_MIN_PROGRESS,
  SHOOT_RANGE,
  THINK_INTERVAL,
} from './constants';
import {
  ballExit,
  interceptPoint,
  isTackleRange,
  nearestOpponent,
  playerMaxSpeed,
  steerPlayer,
  timeToBall,
} from './physics';
import { awardFoul, inOwnPenaltyArea, restartTaker, setPieceTarget } from './setpiece';
import { slotWorldPos } from './world';
import type { Mentality, Player, TeamId, World } from './types';

export function opponentGoalPos(team: TeamId): Vec2 {
  return v2(team === 0 ? PITCH_HALF_L : -PITCH_HALF_L, 0);
}
export function ownGoalPos(team: TeamId): Vec2 {
  return v2(team === 0 ? -PITCH_HALF_L : PITCH_HALF_L, 0);
}

function attackDir(team: TeamId): 1 | -1 {
  return team === 0 ? 1 : -1;
}

/* ------------------------------------------------------------------ */
/* Reading the ball                                                    */
/* ------------------------------------------------------------------ */

/**
 * The outfield players of a team, ordered by how soon they can actually get to
 * the ball. The first entry is the presser/chaser; the second is the cover.
 */
function chaseOrder(w: World, team: TeamId): Player[] {
  return w.players
    .filter((p) => p.team === team && !p.isGK)
    .map((p) => ({ p, t: timeToBall(p, w, INTERCEPT_HORIZON) }))
    .sort((a, b) => a.t - b.t)
    .map((x) => x.p);
}

/** Where this player ranks in the chase queue (0 = first to the ball). */
function chaseRank(w: World, p: Player): number {
  return chaseOrder(w, p.team).findIndex((x) => x.id === p.id);
}

/** Does this player's team have the ball? */
function hasPossession(w: World, team: TeamId): boolean {
  if (w.ball.owner === null) return false;
  const owner = w.players.find((x) => x.id === w.ball.owner);
  return owner ? owner.team === team : false;
}

/* ------------------------------------------------------------------ */
/* Passing                                                             */
/* ------------------------------------------------------------------ */

/** Choose the best open, forward pass option. Returns teammate + score. */
function bestPassOption(w: World, p: Player): { mate: Player; score: number } | null {
  const goal = opponentGoalPos(p.team);
  const goalDir = norm(sub(goal, p.pos));
  let best: { mate: Player; score: number } | null = null;

  for (const t of w.players) {
    if (t.team !== p.team || t.id === p.id || t.isGK) continue;
    const toMate = sub(t.pos, p.pos);
    const d = len(toMate);
    // Nothing beyond a hopeful long ball.
    if (d > 26) continue;
    const forward = toMate.x * goalDir.x + toMate.y * goalDir.y;
    // Never hoof it deep into our own half; a lateral or short back-pass is fine
    // (this guarantees an outlet even when everyone is behind the ball).
    if (forward < -3) continue;

    // How open is the receiving player, and is the lane to them clear?
    let open = 99;
    for (const o of w.players) {
      if (o.team === p.team) continue;
      open = Math.min(open, dist(o.pos, t.pos));
    }
    const laneBlocked = laneIntercepted(w, p, t.pos);

    // Progression is what breaks a midfield stalemate: a forward pass is worth
    // far more than a safe square ball, and going backwards is a last resort.
    const backwardPenalty = forward < PASS_MIN_ADVANCE ? 3.4 : 0;
    const score =
      forward * 1.35 +
      clamp(open, 0, 8) * 1.15 -
      d * 0.1 -
      backwardPenalty -
      (laneBlocked ? 6.5 : 0);
    if (!best || score > best.score) best = { mate: t, score };
  }
  return best;
}

/** Is there an opponent sitting in the straight line between two points? */
function laneIntercepted(w: World, from: Player, to: Vec2): boolean {
  const d = sub(to, from.pos);
  const L = len(d);
  if (L < 0.001) return false;
  const dir = scale(d, 1 / L);
  for (const o of w.players) {
    if (o.team === from.team) continue;
    const rel = sub(o.pos, from.pos);
    const along = rel.x * dir.x + rel.y * dir.y;
    if (along < 0.6 || along > L - 0.4) continue;
    const perp = Math.abs(rel.x * -dir.y + rel.y * dir.x);
    if (perp < 1.0) return true;
  }
  return false;
}

/** Public: world-space position of the best pass target, or null. */
export function bestPassTarget(w: World, p: Player): Vec2 | null {
  const opt = bestPassOption(w, p);
  return opt ? v2(opt.mate.pos.x, opt.mate.pos.y) : null;
}

/** The teammate a pass should go to, or null. */
export function bestPassMate(w: World, p: Player): Player | null {
  return bestPassOption(w, p)?.mate ?? null;
}

/**
 * Where a pass should actually be aimed. A long ball forward is played into
 * space ahead of the runner (a through ball) rather than at their feet.
 */
export function passAimPoint(w: World, p: Player, mate: Player): Vec2 {
  const goalDir = norm(sub(opponentGoalPos(p.team), p.pos));
  const toMate = norm(sub(mate.pos, p.pos));
  const d = dist(p.pos, mate.pos);
  const forward = toMate.x * goalDir.x + toMate.y * goalDir.y;
  if (d > 6 && forward > 0.45) {
    return add(mate.pos, scale(goalDir, clamp(d * 0.32, 1.5, 5.0)));
  }
  return v2(mate.pos.x, mate.pos.y);
}

/** Is anyone in the opponent's box to aim at? */
function hasBoxTarget(w: World, team: TeamId): boolean {
  const dir = attackDir(team);
  const goalLine = dir * PITCH_HALF_L;
  return w.players.some(
    (p) =>
      p.team === team &&
      !p.isGK &&
      Math.abs(goalLine - p.pos.x) < PENALTY_AREA_DEPTH &&
      Math.abs(p.pos.y) < PENALTY_AREA_HALF_W,
  );
}

/** A point in the opponent's box to aim a cross at. */
function crossTarget(w: World, team: TeamId): Vec2 {
  const dir = attackDir(team);
  const goalLine = dir * PITCH_HALF_L;
  let best: Player | null = null;
  let bestCost = Infinity;
  for (const p of w.players) {
    if (p.team !== team || p.isGK) continue;
    const cost = Math.abs(p.pos.y) * 1.4 + Math.abs(goalLine - dir * 5 - p.pos.x);
    if (cost < bestCost) {
      bestCost = cost;
      best = p;
    }
  }
  const y = best ? clamp(best.pos.y, -5, 5) : 0;
  return v2(goalLine - dir * 4.5, y);
}

/* ------------------------------------------------------------------ */
/* Decisions                                                           */
/* ------------------------------------------------------------------ */

function think(w: World, p: Player): void {
  const b = w.ball;

  if (p.isGK) {
    // Keepers clear the ball when they have it, otherwise guard the goal.
    p.decision = b.owner === p.id ? 'clear' : 'keeper';
    return;
  }

  // ---- Carrier ----
  if (b.owner === p.id) {
    const goal = opponentGoalPos(p.team);
    const dGoal = dist(p.pos, goal);
    const dir = attackDir(p.team);
    const opp = nearestOpponent(w, p);
    const pressure = opp ? dist(p.pos, opp.pos) : 99;
    const pass = bestPassOption(w, p);
    const m = w.teams[p.team].mentality;

    // Wide and advanced with a man in the box: get to the byline and whip it
    // in. This is what turns possession into corners and headed chances instead
    // of square passes — but only when there is actually someone to aim at.
    const toByline = PITCH_HALF_L - p.pos.x * dir;
    const wide = Math.abs(p.pos.y) > PITCH_HALF_W * 0.42;
    if (wide && toByline < CROSS_RANGE - 1.5 && p.cooldown <= 0 && hasBoxTarget(w, p.team)) {
      p.decision = 'cross';
      p.intentTarget = crossTarget(w, p.team);
      return;
    }

    // ---- Shooting ----
    // In comfortable range, shoot — unless we are smothered *and* a pass is on
    // (a marker on our shoulder must never make shooting impossible). Inside
    // six metres, always pull the trigger.
    if (dGoal < SHOOT_RANGE && p.cooldown <= 0) {
      if (dGoal < 6 || pressure > 0.9 || !pass) {
        p.decision = 'shoot';
        return;
      }
    }
    // ---- Long shots ----
    // From distance, only with shooting ability, a sight of goal and room to
    // set yourself. An attacking mentality buys a little more licence.
    if (dGoal < LONG_SHOT_RANGE && p.cooldown <= 0) {
      const space = pressure > LONG_SHOT_SPACE;
      const able = p.attrs.shooting >= LONG_SHOT_MIN_SHOOTING;
      const lane = !laneIntercepted(w, p, goal);
      const licence = m === 'attack' ? 0.82 : m === 'defend' ? 1.12 : 1.0;
      if (space && able && lane && dGoal < LONG_SHOT_RANGE * licence) {
        p.decision = 'shoot';
        return;
      }
    }

    if (pass && p.cooldown <= 0) {
      // Pass when genuinely pressured, or when a clearly better option exists.
      if (pressure < 1.6 || pass.score > 9) {
        p.decision = 'pass';
        p.intentTarget = passAimPoint(w, p, pass.mate);
        return;
      }
    }

    // Deep in own half under heavy pressure => clear it.
    const ownHalf = p.pos.x * dir < -PITCH_HALF_L * 0.3;
    if (ownHalf && pressure < 1.3 && p.cooldown <= 0) {
      p.decision = 'clear';
      return;
    }

    p.decision = 'dribble';
    return;
  }

  // ---- Off the ball ----
  const order = chaseOrder(w, p.team);
  const rank = order.findIndex((x) => x.id === p.id);
  const loose = b.owner === null;

  if (rank === 0) {
    // First to the ball: press the carrier, or hunt a loose ball.
    if (!loose && isTackleRange(w, p) && w.tackleLock <= 0 && p.cooldown <= 0) {
      const owner = w.players.find((x) => x.id === b.owner)!;
      w.tackleLock = 0.7;
      const win =
        p.attrs.tackling * 1.0 + w.rng.range(-22, 22) >
        owner.attrs.technique * 0.6 + owner.attrs.strength * 0.5;
      if (win) {
        b.owner = p.id;
        b.lastTouch = p.id;
        w.stats.tackles[p.team] += 1;
        p.cooldown = ACTION_COOLDOWN;
        w.events.push({ type: 'tackle', team: p.team, player: p.id, won: true });
      } else {
        w.events.push({ type: 'tackle', team: p.team, player: p.id, won: false });
        p.cooldown = ACTION_COOLDOWN;
        // A mistimed challenge is sometimes penalised. Inside your own box that
        // is a penalty; anywhere else it is a free kick.
        const inBox = inOwnPenaltyArea(p);
        if (w.rng.range(0, 1) < (inBox ? FOUL_CHANCE_BOX : FOUL_CHANCE_OPEN)) {
          awardFoul(w, p, inBox);
        }
      }
    }
    p.decision = 'chase';
    return;
  }

  // Second man: if the ball is genuinely there to be won, go with the first.
  // This is the fix for loose balls trickling out of play — one chaser is not
  // enough, and the second man is often the one who gets there.
  if (rank === 1 && loose && timeToBall(p, w, INTERCEPT_HORIZON) < 1.7) {
    p.decision = 'chase';
    return;
  }

  p.decision = 'support';
}

/* ------------------------------------------------------------------ */
/* Keeping the ball in play                                            */
/* ------------------------------------------------------------------ */

/** Who has been sent to stop the ball crossing the line, and where. */
export interface KeepInErrand {
  playerId: number;
  at: Vec2;
}

/**
 * Decide, once per tick, whether anyone should break off to stop a loose ball
 * going out of play — and if so, who.
 *
 * Two rules keep this from wrecking the shape of the team:
 *
 *   - Only the side that would *win* the restart chases. A defender sprinting
 *     after a ball that is going to be the opposition's throw-in has simply
 *     abandoned their position for nothing.
 *   - Only the closest of that side goes. If everyone read the same exit the
 *     whole team would collapse onto one touchline.
 *
 * Computed once per tick rather than per player, and passed into `moveTarget`,
 * so the decision cannot drift between the two places that need it.
 */
function keepInAssignment(w: World): KeepInErrand | null {
  const exit = ballExit(w, KEEP_IN_HORIZON);
  if (!exit) return null;
  const entitled = restartTaker(w, exit);
  let best: Player | null = null;
  let bd = Infinity;
  for (const q of w.players) {
    if (q.team !== entitled || q.isGK) continue;
    const d = dist(q.pos, exit.at);
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  return best ? { playerId: best.id, at: exit.at } : null;
}

/* ------------------------------------------------------------------ */
/* Movement targets                                                    */
/* ------------------------------------------------------------------ */

function moveTarget(w: World, p: Player): Vec2 {
  const b = w.ball;

  // A dead ball overrides everything: everyone walks to their set-piece station
  // (the taker stands over the ball) until the restart is taken.
  const station = setPieceTarget(w, p);
  if (station) return station;

  const dir = attackDir(p.team);

  switch (p.decision) {
    case 'keeper': {
      const line = p.team === 0 ? -PITCH_HALF_L + 0.7 : PITCH_HALF_L - 0.7;
      const towardGoalX = p.team === 0 ? -1 : 1;
      let ty = clamp(b.pos.y * 0.5, -GOAL_HALF_W + 0.3, GOAL_HALF_W - 0.3);

      // Predict where a moving ball will cross the goal line and get there.
      if (b.owner === null && Math.sign(b.vel.x) === towardGoalX && Math.abs(b.vel.x) > 2) {
        const t = (line - b.pos.x) / b.vel.x;
        if (t > 0 && t < 2.5) {
          ty = clamp(b.pos.y + b.vel.y * t, -GOAL_HALF_W - 0.4, GOAL_HALF_W + 0.4);
        }
      }
      // Stay on the line and cover the predicted crossing point. Rushing out
      // was leaving the goal exposed, so keepers hold their ground.
      return v2(line, ty);
    }

    case 'chase': {
      if (b.owner !== null) {
        const owner = w.players.find((x) => x.id === b.owner)!;
        if (owner.team !== p.team) {
          // Get goal-side but stand off enough to leave the carrier room (a
          // marker glued at 0.7m would smother every shot attempt).
          const gs = norm(sub(ownGoalPos(p.team), owner.pos));
          return add(owner.pos, scale(gs, 1.15));
        }
      }
      // Loose ball: run to where it is going to be, not where it is.
      return interceptPoint(p, w, INTERCEPT_HORIZON);
    }

    case 'dribble': {
      const goal = opponentGoalPos(p.team);
      const opp = nearestOpponent(w, p);
      const toByline = PITCH_HALF_L - p.pos.x * dir;
      const ySide = p.pos.y >= 0 ? 1 : -1;

      // Drive at the goal. A player who has already reached the byline holds
      // the corner instead of running straight into the keeper.
      let t: Vec2 = goal;
      if (toByline < 4.5 && Math.abs(p.pos.y) > PITCH_HALF_W * 0.5) {
        t = v2(PITCH_HALF_L * dir - dir * 1.5, ySide * (PITCH_HALF_W - 1.5));
      }
      if (opp && dist(p.pos, opp.pos) < 2.2) {
        // Steer around the nearest defender.
        const away = norm(sub(p.pos, opp.pos));
        t = add(t, scale(away, 3.5));
      }
      return t;
    }

    case 'cross':
      // Get to the byline; the cross itself is struck by handleCarrier.
      return v2(PITCH_HALF_L * dir - dir * 1.6, p.pos.y);

    case 'shoot':
    case 'pass':
    case 'clear':
      return opponentGoalPos(p.team);

    case 'support':
    default:
      return supportTarget(w, p);
  }
}

/**
 * Where an off-the-ball player goes.
 *
 * The base is their formation slot, slid with the ball and pushed up or back by
 * the team mentality. On top of that the team is given jobs by rank, so one
 * player supports the carrier, one runs beyond, and the rest hold the shape
 * instead of the whole side collapsing onto the ball.
 */
function supportTarget(w: World, p: Player): Vec2 {
  const b = w.ball;
  const dir = attackDir(p.team);
  const m = w.teams[p.team].mentality;

  const slot = slotWorldPos(p, b.pos);
  const push = m === 'attack' ? 2.6 : m === 'defend' ? -2.6 : m === 'counter' ? -1.6 : 0;

  // Width by role: midfielders hold the touchline and stretch the pitch. That
  // is how the ball ends up in the corners in the first place.
  let ty = slot.y;
  if (p.role === 'MID') ty = clamp(ty * 1.4, -PITCH_HALF_W * 0.88, PITCH_HALF_W * 0.88);
  else if (p.role === 'DEF') ty = clamp(ty * 1.15, -PITCH_HALF_W * 0.8, PITCH_HALF_W * 0.8);

  const carrier =
    b.owner !== null ? (w.players.find((x) => x.id === b.owner) ?? null) : null;
  const weHaveIt = carrier !== null && carrier.team === p.team;
  const rank = chaseRank(w, p);

  if (weHaveIt && carrier) {
    const carrierDir = attackDir(carrier.team);
    // Job 1 — support: sit off the carrier's shoulder, inside the passing lane,
    // on the opposite side of the pitch to them so a square ball is always on.
    if (rank <= 1) {
      const away = carrier.pos.y >= 0 ? -1 : 1;
      return v2(
        clamp(carrier.pos.x + carrierDir * 1.4, -PITCH_HALF_L * 0.95, PITCH_HALF_L * 0.95),
        clamp(carrier.pos.y + away * 4.6, -PITCH_HALF_W * 0.9, PITCH_HALF_W * 0.9),
      );
    }
    // Job 2 — runner: get beyond the ball and give a forward option.
    if (rank === 2) {
      return v2(
        clamp(carrier.pos.x + carrierDir * 9.0, -PITCH_HALF_L * 0.92, PITCH_HALF_L * 0.92),
        clamp(p.slot.y * PITCH_HALF_W * 0.62, -PITCH_HALF_W * 0.75, PITCH_HALF_W * 0.75),
      );
    }
    // Everyone else keeps the shape, shaded forward with play.
    return v2(slot.x + push * dir, ty);
  }

  // ---- Off the ball, we do not have it ----
  if (rank === 1) {
    // Cover: drop in behind the presser and screen the space in front of them.
    return v2(b.pos.x - dir * 1.6, clamp(b.pos.y * 0.5, -PITCH_HALF_W * 0.6, PITCH_HALF_W * 0.6));
  }

  // Hold a compact block. Defenders shade across to the flank under threat.
  const compact = m === 'defend' ? 0.78 : m === 'counter' ? 0.84 : 0.9;
  let tx = slot.x * compact + b.pos.x * (1 - compact) + push * dir;
  ty = ty * compact + b.pos.y * (1 - compact);

  // The CPU shades toward whichever flank the human keeps attacking.
  if (!w.teams[p.team].isHuman && p.role === 'DEF') {
    ty += w.flankBias * 2.4;
  }

  return v2(clamp(tx, -PITCH_HALF_L * 0.95, PITCH_HALF_L * 0.95), ty);
}

/* ------------------------------------------------------------------ */
/* Team brain                                                          */
/* ------------------------------------------------------------------ */

/** Mentality the CPU would pick for itself given the state of the match. */
function cpuMentality(w: World, team: TeamId): Mentality {
  const opp: TeamId = team === 0 ? 1 : 0;
  const diff = w.teams[team].score - w.teams[opp].score;
  const progress = w.clock / Math.max(1, w.halfSeconds * 2);

  const possTotal = Math.max(1, w.stats.possession[0] + w.stats.possession[1]);
  const myPoss = w.stats.possession[team] / possTotal;
  const myShots = w.stats.shots[team];
  const theirShots = w.stats.shots[opp];

  // Chasing the game: the later it gets and the more we are behind, the more
  // we commit. Never a stat boost — just more bodies forward.
  if (diff <= -2 && progress > 0.4) return 'attack';
  if (diff === -1 && progress > 0.6) return 'attack';
  // Comfortably ahead: protect it.
  if (diff >= 2) return 'defend';
  // Being out-played: sit in, stay compact and break. Pushing up against a
  // side that is dominating the ball just opens more space for them.
  if (myPoss < 0.42 && progress > 0.18) return 'counter';
  // On top: keep the pressure on.
  if (myPoss > 0.6 || myShots > theirShots + 3) return 'attack';
  return 'balanced';
}

/**
 * Update every non-human team's approach. The human's mentality is set only by
 * the human's own button — this function deliberately skips their team.
 */
export function updateTeamAI(w: World, dt: number): void {
  for (const t of w.teams) {
    if (t.isHuman) continue;
    t.mentality = cpuMentality(w, t.id);
  }

  // Track which flank the human favours, so the CPU can shade across to it.
  // A slow rolling average: one counter-attack should not swing the shape.
  if (w.possession === 0 && Math.abs(w.ball.pos.x) > PITCH_HALF_L * 0.2) {
    const s = Math.sign(w.ball.pos.y);
    if (s !== 0) {
      const target = s;
      w.flankBias += (target - w.flankBias) * clamp(dt * 0.35, 0, 1);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Tick                                                                */
/* ------------------------------------------------------------------ */

/** Advance AI for one tick: decrement timers, decide on think ticks, steer. */
export function updateAI(w: World, dt: number): void {
  updateTeamAI(w, dt);

  // Decided once for the whole tick, then handed to whoever it names.
  const keepIn = keepInAssignment(w);

  for (const p of w.players) {
    if (p.cooldown > 0) p.cooldown -= dt;
    p.think -= dt;
    if (p.think <= 0) {
      // Stagger thinking across players for performance (spec §6.6).
      p.think = THINK_INTERVAL + (p.id % 5) * 0.017;
      think(w, p);
    }

    // Sent to the line: this overrides the normal decision. Whoever is closest
    // to where the ball is about to go out goes, even if the shape says they
    // should be supporting — and they get a turn of speed for the errand.
    const errand = keepIn && keepIn.playerId === p.id;
    const target = errand ? keepIn.at : moveTarget(w, p);
    const urgency = errand ? KEEP_IN_SPRINT_MULT : 1;

    // A ball-winner goes to the ball, full stop. Separation is for off-ball
    // shape: two teammates hunting the same loose ball would otherwise push
    // each other *away* from it and neither would ever arrive — a deadlock the
    // collision radius makes permanent.
    const sep =
      errand || p.decision === 'chase' || p.decision === 'keeper'
        ? v2(0, 0)
        : teammateSeparation(w, p);
    steerPlayer(p, blendSeparation(p, target, sep), w, dt, urgency);
  }
}

/**
 * Mix the player's real target with the push away from crowding teammates.
 *
 * The subtlety that matters: separation is a *bias*, never a veto. If the two
 * are simply added, a crowded player's net target can land within a stride of
 * where they already are — and since `steerPlayer` treats "already there" as
 * "stop", they freeze on the spot permanently. That is what made players stand
 * around in midfield and let loose balls sit untouched a metre away.
 *
 * So: once in position, separation alone drives them (they shuffle apart and
 * stay alive). Still travelling, separation may bend the run but is never
 * allowed to remove more than half of the remaining distance.
 */
function blendSeparation(p: Player, target: Vec2, sep: Vec2): Vec2 {
  const toTarget = sub(target, p.pos);
  const dTarget = len(toTarget);

  // In position: the only job left is to not stand on a teammate.
  if (dTarget <= ARRIVE_RADIUS) return add(p.pos, sep);

  const blended = add(target, sep);
  const toBlended = sub(blended, p.pos);
  const dBlended = len(toBlended);
  const minProgress = dTarget * SEPARATION_MIN_PROGRESS;

  // Separation cannot cancel the run: keep a guaranteed step toward the target.
  if (dBlended < minProgress) return add(p.pos, scale(norm(toTarget), minProgress));
  return blended;
}



/** Push away from crowding teammates. Stronger than it looks: bunching is the
 *  single fastest way to make a football match look wrong. */
function teammateSeparation(w: World, p: Player): Vec2 {
  let sx = 0;
  let sy = 0;
  for (const o of w.players) {
    if (o.team !== p.team || o.id === p.id) continue;
    const d = dist(o.pos, p.pos);
    if (d < 4.0 && d > 0.001) {
      // Falls off with distance, so a distant teammate barely nudges us.
      const f = (4.0 - d) / 4.0;
      sx += ((p.pos.x - o.pos.x) / d) * f;
      sy += ((p.pos.y - o.pos.y) / d) * f;
    }
  }
  return v2(sx * 2.1, sy * 2.1);
}

export { playerMaxSpeed };
