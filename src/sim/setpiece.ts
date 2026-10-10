// sim/setpiece.ts — dead-ball restarts. Corners, goal kicks, throw-ins, free
// kicks and penalties. Deterministic, like everything else in sim/.
//
// Flow: play -> the ball crosses a boundary (or a foul is given) ->
// beginSetPiece() places the ball and stands the taker over it -> every other
// player steers to a set-piece target (see setPieceTarget) -> when the phase
// timer expires runSetPiece() strikes the ball and hands play back to the AI.

import { clamp, dist, norm, scale, sub, v2, type Vec2 } from './core/math';
import {
  BALL_RADIUS,
  CORNER_SPEED,
  FREE_KICK_SPEED,
  GOAL_HALF_W,
  GOAL_KICK_SPEED,
  PASS_SPEED_BASE,
  PENALTY_AREA_DEPTH,
  PENALTY_AREA_HALF_W,
  PENALTY_SPOT,
  PENALTY_SPEED,
  PITCH_HALF_L,
  PITCH_HALF_W,
  SETPIECE_PAUSE,
  SHOOT_RANGE,
} from './constants';
import { weatherMods } from './weather';
import type { DiveDirection, Player, SetPiece, SetPieceKind, TeamId, World } from './types';

/** Which boundary the ball crossed. */
export interface OutOfPlay {
  axis: 'x' | 'y';
  /** +1 for the top / right boundary, -1 for the bottom / left. */
  side: 1 | -1;
}

/**
 * Which team would take the restart if the ball crossed this boundary now.
 *
 * Shared by the restart itself and by the AI's keep-it-in chase, so a player
 * only ever sprints after a ball their own side is allowed to stop. Without
 * that agreement the nearest defender would routinely chase a ball out and
 * leave their shape for a throw-in they were never going to get.
 */
export function restartTaker(w: World, out: OutOfPlay): TeamId {
  const lastId = w.ball.lastTouch;
  const lastTeam =
    lastId === null ? null : (w.players.find((p) => p.id === lastId)?.team ?? null);
  if (out.axis === 'y') {
    // Off the side: the other team throws it in.
    return lastTeam === null ? 0 : ((lastTeam === 0 ? 1 : 0) as TeamId);
  }
  // Behind the goal line: a corner to the attackers, a goal kick to the
  // defenders, decided by who put it there.
  const defending: TeamId = out.side > 0 ? 1 : 0;
  return lastTeam === defending ? ((defending === 0 ? 1 : 0) as TeamId) : defending;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Direction a team attacks: +1 for team 0 (towards +x), -1 for team 1. */
function attackDir(team: TeamId): 1 | -1 {
  return team === 0 ? 1 : -1;
}

/** The goal line a team is attacking. */
function targetGoalLine(team: TeamId): number {
  return attackDir(team) * PITCH_HALF_L;
}

/** The goal line a team is defending. */
function ownGoalLine(team: TeamId): number {
  return -attackDir(team) * PITCH_HALF_L;
}

function lastTouchTeam(w: World): TeamId | null {
  const id = w.ball.lastTouch;
  if (id === null) return null;
  const p = w.players.find((x) => x.id === id);
  return p ? p.team : null;
}

/** Is this player standing inside their own penalty area? */
export function inOwnPenaltyArea(p: Player): boolean {
  const line = ownGoalLine(p.team);
  return Math.abs(p.pos.x - line) < PENALTY_AREA_DEPTH && Math.abs(p.pos.y) < PENALTY_AREA_HALF_W;
}

/** Is a dead-ball restart currently being set up? */
export function isSetPiecePhase(w: World): boolean {
  return w.setPiece !== null;
}

/* ------------------------------------------------------------------ */
/* Choosing who takes it                                               */
/* ------------------------------------------------------------------ */

function pickTaker(w: World, kind: SetPieceKind, team: TeamId, pos: Vec2): Player | null {
  const pool = w.players.filter((p) => p.team === team);
  if (!pool.length) return null;

  if (kind === 'goalkick') {
    return pool.find((p) => p.isGK) ?? pool[0];
  }

  if (kind === 'penalty') {
    // The best finisher in the side takes it.
    const outfield = pool
      .filter((p) => !p.isGK)
      .sort(
        (a, b) =>
          b.attrs.shooting + b.attrs.technique - (a.attrs.shooting + a.attrs.technique),
      );
    return outfield[0] ?? pool[0];
  }

  // Corners, throw-ins and free kicks: whoever is closest can take it.
  let best: Player | null = null;
  let bd = Infinity;
  for (const p of pool) {
    if (p.isGK) continue;
    const d = dist(p.pos, pos);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best ?? pool[0];
}

/* ------------------------------------------------------------------ */
/* Starting a restart                                                  */
/* ------------------------------------------------------------------ */

export function beginSetPiece(
  w: World,
  kind: SetPieceKind,
  team: TeamId,
  pos: Vec2,
  side: 1 | -1,
): void {
  const b = w.ball;
  b.pos = v2(pos.x, pos.y);
  b.vel = v2(0, 0);
  b.h = BALL_RADIUS;
  b.vh = 0;
  b.owner = null;
  b.looseTimer = 0.5;

  const taker = pickTaker(w, kind, team, pos);
  // A new penalty cannot inherit an earlier dive or a ball still in flight.
  w.penaltyDive = null;
  w.penaltyShot = null;
  const pause = SETPIECE_PAUSE[kind];
  w.setPiece = { kind, team, pos: v2(pos.x, pos.y), taker: taker ? taker.id : null, side };
  w.phase = kind;
  w.phaseTimer = pause;
  // No tackles until the ball is live again.
  w.tackleLock = Math.max(w.tackleLock, pause + 0.25);

  if (kind === 'corner' || kind === 'penalty') {
    // These two are a cut to a packed box: there is no time for the attackers
    // to run 30 metres upfield, so everyone takes up their station at once.
    snapToStations(w);
  } else if (taker) {
    // Short restarts: stand the taker over the ball and let the rest walk.
    if (kind === 'throwin') {
      taker.pos = v2(pos.x, pos.y - side * 0.6);
    } else {
      taker.pos = v2(pos.x - attackDir(team) * 0.7, pos.y);
    }
    taker.vel = v2(0, 0);
    taker.decision = 'hold';
    taker.cooldown = 0;
    taker.intentTarget = null;
  }

  if (kind === 'corner') w.stats.corners[team] += 1;
  w.events.push({ type: 'setpiece', kind, team });
}

/** Work out the restart after the ball has left the field of play. */
export function awardFromOutOfPlay(w: World, out: OutOfPlay): void {
  const b = w.ball;
  const last = lastTouchTeam(w);

  if (out.axis === 'y') {
    // Over the touchline: throw-in to the side that did not put it out.
    const team: TeamId = last === null ? 0 : ((last === 0 ? 1 : 0) as TeamId);
    const x = clamp(b.pos.x, -PITCH_HALF_L + 0.6, PITCH_HALF_L - 0.6);
    beginSetPiece(w, 'throwin', team, v2(x, out.side * (PITCH_HALF_W - 0.35)), out.side);
    return;
  }

  // Over a goal line. Team 1 defends +x (team 0 attacks it).
  const defending: TeamId = out.side > 0 ? 1 : 0;
  if (last === defending) {
    // Put behind by the defending side => corner for the attackers.
    const team: TeamId = (defending === 0 ? 1 : 0) as TeamId;
    const ySide: 1 | -1 = b.pos.y >= 0 ? 1 : -1;
    beginSetPiece(
      w,
      'corner',
      team,
      v2(out.side * (PITCH_HALF_L - 0.4), ySide * (PITCH_HALF_W - 0.4)),
      ySide,
    );
    return;
  }

  // Attacker put it behind => goal kick to the defenders.
  beginSetPiece(w, 'goalkick', defending, v2(out.side * (PITCH_HALF_L - 5.5), 0), 1);
}

/** A foul has been given. Inside the offender's own box it is a penalty. */
export function awardFoul(w: World, offender: Player, penalty: boolean): void {
  const team: TeamId = (offender.team === 0 ? 1 : 0) as TeamId;
  w.stats.fouls[offender.team] += 1;
  // The referee stops play before anything else happens.
  w.events.push({ type: 'whistle', kind: 'foul' });
  w.events.push({ type: 'foul', team: offender.team, player: offender.id, penalty });

  if (penalty) {
    beginSetPiece(
      w,
      'penalty',
      team,
      v2(targetGoalLine(team) - attackDir(team) * PENALTY_SPOT, 0),
      1,
    );
    return;
  }

  const x = clamp(w.ball.pos.x, -PITCH_HALF_L + 1, PITCH_HALF_L - 1);
  const y = clamp(w.ball.pos.y, -PITCH_HALF_W + 1, PITCH_HALF_W - 1);
  beginSetPiece(w, 'freekick', team, v2(x, y), w.ball.pos.y >= 0 ? 1 : -1);
}

/* ------------------------------------------------------------------ */
/* Where everyone stands                                               */
/* ------------------------------------------------------------------ */

/**
 * A real corner: the taker, a near-post runner, a far-post runner, a central
 * attacker and someone on the edge of the box for the pull-back — with a
 * defender detailed to mark each of them.
 *
 * Returned as a station map so every player gets a job, rather than the whole
 * side drifting into the middle of the pitch.
 */
function cornerStations(w: World, sp: SetPiece): Map<number, Vec2> {
  const dir = attackDir(sp.team);
  const atkLine = targetGoalLine(sp.team);
  const ownLine = ownGoalLine(sp.team);
  const s = sp.side;
  const map = new Map<number, Vec2>();

  // The taker stands over the ball (snapToStations nudges them just behind it).
  if (sp.taker !== null) map.set(sp.taker, v2(sp.pos.x, sp.pos.y));

  // Attackers: the strongest and best finishers get the most dangerous spots.
  const attackers = w.players
    .filter((p) => p.team === sp.team && !p.isGK && p.id !== sp.taker)
    .sort(
      (a, b) =>
        b.attrs.strength + b.attrs.shooting - (a.attrs.strength + a.attrs.shooting),
    );
  const attackJobs: Vec2[] = [
    v2(atkLine - dir * 2.2, -s * 1.8), // near post
    v2(atkLine - dir * 3.0, s * 3.2), // far post
    v2(atkLine - dir * 5.4, s * 0.5), // central, top of the six-yard box
    v2(atkLine - dir * 9.6, -s * 1.4), // edge of the box, for the pull-back
  ];
  attackers.forEach((p, i) => map.set(p.id, attackJobs[Math.min(i, attackJobs.length - 1)]));

  const gk = w.players.find((p) => p.team === sp.team && p.isGK);
  if (gk) map.set(gk.id, v2(ownLine - dir * 0.7, 0));

  // Defenders: the best markers pick up the most dangerous runners.
  const defenders = w.players
    .filter((p) => p.team !== sp.team && !p.isGK)
    .sort((a, b) => b.attrs.tackling - a.attrs.tackling);
  const defendJobs: Vec2[] = [
    v2(atkLine - dir * 1.7, -s * 1.8), // mark the near post
    v2(atkLine - dir * 2.6, s * 3.0), // mark the far post
    v2(atkLine - dir * 4.8, s * 0.6), // mark the central attacker
    v2(atkLine - dir * 8.4, -s * 2.6), // screen the edge of the box
  ];
  defenders.forEach((p, i) => map.set(p.id, defendJobs[Math.min(i, defendJobs.length - 1)]));

  const defGk = w.players.find((p) => p.team !== sp.team && p.isGK);
  if (defGk) map.set(defGk.id, v2(atkLine - dir * 0.6, 0));

  return map;
}

/**
 * The world-space target for a player during a dead-ball phase, or null if the
 * normal AI positioning should be used instead.
 */
export function setPieceTarget(w: World, p: Player): Vec2 | null {
  const sp = w.setPiece;
  if (!sp) return null;

  const dir = attackDir(sp.team);
  const atkLine = targetGoalLine(sp.team); // goal being attacked
  const ownLine = ownGoalLine(sp.team);
  const attacking = p.team === sp.team;

  // The taker always stands over the ball.
  if (p.id === sp.taker) return v2(sp.pos.x, sp.pos.y);

  switch (sp.kind) {
    case 'corner':
      return cornerStations(w, sp).get(p.id) ?? null;

    case 'penalty': {
      if (!attacking && p.isGK) return v2(atkLine - dir * 0.6, 0);
      // Everyone else waits on the edge of the area.
      const ring = atkLine - dir * (PENALTY_AREA_DEPTH + 2.4);
      return v2(ring, p.slot.y * 5.5);
    }

    case 'goalkick': {
      if (!attacking && p.isGK) return v2(atkLine - dir * 0.7, 0);
      // Spread out to receive: defenders short, midfielders middle, striker long.
      const depth = p.role === 'DEF' ? 10 : p.role === 'MID' ? 17 : 24;
      return v2(ownLine + dir * depth, p.slot.y * PITCH_HALF_W * 0.85);
    }

    case 'freekick': {
      if (attacking) {
        if (p.isGK) return v2(ownLine - dir * 0.7, 0);
        return v2(sp.pos.x + dir * 3.0, p.slot.y * 7.5);
      }
      if (p.isGK) return v2(atkLine - dir * 0.7, 0);
      // Build the wall / drop off in front of the ball.
      return v2(sp.pos.x - dir * 4.5, p.slot.y * 6.5);
    }

    case 'throwin': {
      if (!attacking) {
        if (p.isGK) return v2(atkLine - dir * 0.7, 0);
        // Defending a throw: pick up the nearby options and hold a line.
        const mark = p.role === 'DEF' ? 2.2 : p.role === 'MID' ? 3.6 : 6.5;
        return v2(sp.pos.x + dir * mark, sp.pos.y - sp.side * (2.6 + mark * 0.45));
      }
      if (p.isGK) return v2(ownLine - dir * 0.7, 0);
      // Attacking a throw: a short option inside the line, a square option, and
      // one runner spinning in behind.
      if (p.role === 'DEF') return v2(sp.pos.x - dir * 3.4, sp.pos.y - sp.side * 4.5);
      if (p.role === 'MID') {
        const short = p.slot.y >= 0;
        return v2(
          sp.pos.x + dir * (short ? 2.0 : 6.2),
          sp.pos.y - sp.side * (short ? 3.0 : 5.6),
        );
      }
      return v2(sp.pos.x + dir * 8.5, sp.pos.y - sp.side * 1.8);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Taking it                                                           */
/* ------------------------------------------------------------------ */

/**
 * Snap every player straight to their set-piece station. Used for corners and
 * penalties, where the restart is a cut to a packed box rather than a walk.
 */
function snapToStations(w: World): void {
  const sp = w.setPiece;
  if (!sp) return;
  const dir = attackDir(sp.team);
  for (const p of w.players) {
    const target = setPieceTarget(w, p);
    if (!target) continue;
    // The taker stands just behind the ball rather than on top of it.
    const isTaker = p.id === sp.taker;
    p.pos = isTaker
      ? sp.kind === 'throwin'
        ? v2(target.x, target.y - sp.side * 0.6)
        : v2(target.x - dir * 0.7, target.y)
      : v2(target.x, target.y);
    p.vel = v2(0, 0);
    p.decision = 'hold';
    p.cooldown = 0;
    p.intentTarget = null;
  }
}

/** Launch the ball from its current spot, crediting the taker. */
function launch(w: World, dir: Vec2, speed: number, loft: number, taker: Player | null): void {
  const b = w.ball;
  const n = norm(dir);
  b.vel = scale(n, speed);
  b.vh = loft;
  b.h = Math.max(BALL_RADIUS, loft > 0 ? 0.5 : BALL_RADIUS);
  b.owner = null;
  b.lastTouch = taker ? taker.id : b.lastTouch;
  b.looseTimer = 0.2;
  b.saveCooldown = 0;
}

/**
 * The attacker closest to the six-yard box — the corner's intended target.
 * Only returns a point if somebody is genuinely in the box (the taker never
 * counts: aiming at the corner flag would be a wasted delivery).
 */
function pickBoxTarget(w: World, team: TeamId, taker: number | null): Vec2 | null {
  const dir = attackDir(team);
  const spot = v2(targetGoalLine(team) - dir * 4.5, 0);
  let best: Player | null = null;
  let bd = Infinity;
  for (const p of w.players) {
    if (p.team !== team || p.isGK || p.id === taker) continue;
    const d = dist(p.pos, spot);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  if (!best || bd > PENALTY_AREA_DEPTH + 2) return null;
  return v2(best.pos.x, best.pos.y);
}

/** The most advanced teammate — the goal kick's / free kick's long option. */
function pickUpfieldTarget(w: World, team: TeamId): Vec2 | null {
  const dir = attackDir(team);
  let best: Player | null = null;
  let bx = -Infinity;
  for (const p of w.players) {
    if (p.team !== team || p.isGK) continue;
    const x = p.pos.x * dir;
    if (x > bx) {
      bx = x;
      best = p;
    }
  }
  return best ? v2(best.pos.x, best.pos.y) : null;
}

/** The nearest teammate to a point, within `maxD`. */
function pickNearTarget(w: World, team: TeamId, from: Vec2, maxD: number): Vec2 | null {
  let best: Player | null = null;
  let bd = Infinity;
  for (const p of w.players) {
    if (p.team !== team || p.isGK) continue;
    const d = dist(p.pos, from);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  if (!best || bd > maxD * 2.4) return null;
  return v2(best.pos.x, best.pos.y);
}

/**
 * Advance the current dead-ball phase by one tick. A penalty launches a
 * travelling ball; no restart scores instantly. Returns null for compatibility
 * with the existing engine call site.
 */
export function runSetPiece(w: World, dt: number): TeamId | null {
  const sp = w.setPiece;
  if (!sp) {
    w.phase = 'play';
    return null;
  }

  w.phaseTimer -= dt;
  if (w.phaseTimer > 0) return null;

  const taker = sp.taker === null ? null : (w.players.find((p) => p.id === sp.taker) ?? null);
  const dir = attackDir(sp.team);
  const atkLine = targetGoalLine(sp.team);

  switch (sp.kind) {
    case 'corner': {
      // Whipped into the six-yard area, aimed at the nearest attacker.
      const aim =
        pickBoxTarget(w, sp.team, sp.taker) ??
        v2(atkLine - dir * 4.2, w.rng.range(-3.5, 3.5));
      const d = dist(w.ball.pos, aim);
      launch(w, sub(aim, w.ball.pos), CORNER_SPEED, clamp(3.5 + d * 0.26, 3.5, 7.0), taker);
      w.stats.passes[sp.team] += 1;
      w.events.push({ type: 'pass', team: sp.team, player: taker ? taker.id : -1 });
      break;
    }

    case 'goalkick': {
      const aim = pickUpfieldTarget(w, sp.team) ?? v2(atkLine * 0.3, w.rng.range(-6, 6));
      launch(w, sub(aim, w.ball.pos), GOAL_KICK_SPEED, 6.5, taker);
      w.stats.passes[sp.team] += 1;
      w.events.push({ type: 'pass', team: sp.team, player: taker ? taker.id : -1 });
      break;
    }

    case 'throwin': {
      const near = pickNearTarget(w, sp.team, w.ball.pos, 9);
      const aim = near ?? v2(w.ball.pos.x + dir * 5, w.ball.pos.y - sp.side * 6);
      launch(w, sub(aim, w.ball.pos), PASS_SPEED_BASE, 1.8, taker);
      w.stats.passes[sp.team] += 1;
      w.events.push({ type: 'pass', team: sp.team, player: taker ? taker.id : -1 });
      break;
    }

    case 'freekick': {
      const goal = v2(atkLine, 0);
      if (dist(w.ball.pos, goal) < SHOOT_RANGE + 2.5) {
        // Direct shot: bend it over the wall.
        const spread = 0.55 * weatherMods(w.weather).shotSpread;
        const aim = v2(atkLine, w.rng.range(-spread, spread));
        launch(w, sub(aim, w.ball.pos), FREE_KICK_SPEED, 3.4, taker);
        w.stats.shots[sp.team] += 1;
        w.events.push({
          type: 'shot',
          team: sp.team,
          player: taker ? taker.id : -1,
          onTarget: Math.abs(aim.y) < GOAL_HALF_W,
        });
      } else {
        const aim = pickUpfieldTarget(w, sp.team) ?? v2(w.ball.pos.x + dir * 12, w.rng.range(-5, 5));
        launch(w, sub(aim, w.ball.pos), FREE_KICK_SPEED, 5.5, taker);
        w.stats.passes[sp.team] += 1;
        w.events.push({ type: 'pass', team: sp.team, player: taker ? taker.id : -1 });
      }
      break;
    }

    case 'penalty':
      takePenalty(w, sp, taker);
      return null;
  }

  w.setPiece = null;
  w.phase = 'play';
  return null;
}

/**
 * Strike a real penalty ball. The defender's dive was committed before this
 * moment, so changing the UI after the kick cannot change the outcome. The
 * engine resolves the shot at the keeper line, and the ordinary ball physics
 * resolves a goal or a miss at the actual goal line.
 */
function takePenalty(w: World, sp: SetPiece, taker: Player | null): void {
  const dir = attackDir(sp.team);
  const atkLine = targetGoalLine(sp.team);
  const keeper = w.players.find((p) => p.team !== sp.team && p.isGK) ?? null;
  const shooter = taker ?? w.players.find((p) => p.team === sp.team && !p.isGK) ?? null;
  const accuracy = shooter
    ? (shooter.attrs.shooting * 0.62 + shooter.attrs.technique * 0.38) / 99
    : 0.6;
  const keeperSkill = keeper
    ? (keeper.attrs.tackling * 0.5 + keeper.attrs.technique * 0.3 + keeper.attrs.pace * 0.2) / 99
    : 0.5;

  // A shot is aimed at one of three lanes, with a skill/weather-dependent
  // spread. The keeper chooses a lane, not a probability: the ball is caught
  // only if it actually passes through the area the keeper reached.
  const lanes: DiveDirection[] = ['left', 'centre', 'right'];
  const lane = lanes[w.rng.int(0, 2)];
  const laneY = lane === 'left' ? -1.35 : lane === 'right' ? 1.35 : 0;
  const spread = (0.32 + (1 - accuracy) * 1.65) * weatherMods(w.weather).shotSpread;
  const aimY = laneY + w.rng.range(-spread, spread);
  const aim = v2(atkLine, aimY);

  let dive: DiveDirection;
  if (keeper?.team === 0) {
    // The human's command is consumed once, for this one kick. No command
    // means a centre stay (e.g. a headless sim test that never opens the UI).
    dive = w.penaltyDive ?? 'centre';
  } else {
    // The CPU reads the striker sometimes, but never perfectly. All reads use
    // the seeded world RNG, so replaying a seed always gives the same match.
    const read = w.rng.range(0, 1) < 0.28 + keeperSkill * 0.5;
    dive = read ? lane : lanes[w.rng.int(0, 2)];
  }

  w.stats.penalties[sp.team] += 1;
  w.stats.shots[sp.team] += 1;
  w.setPiece = null;
  w.penaltyDive = null;
  w.penaltyShot = { team: sp.team, keeper: keeper?.id ?? null, dive, elapsed: 0 };
  w.phase = 'penaltyshot';
  launch(w, sub(aim, w.ball.pos), PENALTY_SPEED, 1.6, shooter);
  w.ball.looseTimer = 0.6;
  w.events.push({
    type: 'shot', team: sp.team, player: shooter?.id ?? -1,
    onTarget: Math.abs(aimY) < GOAL_HALF_W,
  });
}
