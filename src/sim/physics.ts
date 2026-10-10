// sim/physics.ts — 2.5D ball + kinematic player movement. Deterministic.

import {
  add,
  clamp,
  dist,
  fromAngle,
  len,
  lerpVec,
  norm,
  scale,
  sub,
  v2,
  type Vec2,
  angleOf,
  moveToward,
  angleDiff,
} from './core/math';
import {
  ACCEL_FACTOR,
  ARRIVE_RADIUS,
  BALL_AIR_DRAG,
  BALL_FRICTION,
  BALL_GRAVITY,
  BALL_MAX_SPEED,
  BALL_RADIUS,
  BALL_RESTITUTION,
  BASE_ACCEL,
  BASE_MAX_SPEED,
  CONTROL_RADIUS,
  GOAL_H,
  GOAL_HALF_W,
  LOSE_RADIUS,
  PACE_SPEED_FACTOR,
  PITCH_HALF_L,
  PITCH_HALF_W,
  PLAYER_RADIUS,
  SPECIAL_SPEED_MULT,
  TACKLE_RADIUS,
  TURN_RATE,
} from './constants';
import type { Player, World } from './types';
import type { OutOfPlay } from './setpiece';
import { weatherMods } from './weather';

export interface GoalHit {
  team: 0 | 1; // team that scored
}

/** What happened to a free ball this tick. */
export interface BallOutcome {
  /** Set when the ball crossed the line inside the goal mouth. */
  goal: 0 | 1 | null;
  /** Set when the ball left the field of play (touchline or goal line). */
  out: OutOfPlay | null;
}

export function playerMaxSpeed(p: Player, w: World, urgency = 1): number {
  const boost = w.teams[p.team].specialTimer > 0 ? SPECIAL_SPEED_MULT : 1;
  return (
    (BASE_MAX_SPEED + p.attrs.pace * PACE_SPEED_FACTOR) *
    boost *
    urgency *
    weatherMods(w.weather).maxSpeed
  );
}

export function playerAccel(p: Player, w: World): number {
  return (BASE_ACCEL + p.attrs.technique * ACCEL_FACTOR) * weatherMods(w.weather).accel;
}

/**
 * Where a free ball will be in `t` seconds.
 *
 * The ball loses speed to an exponential drag, so the distance it covers is
 * v0 * (1 - e^(-k t)) / k rather than v0 * t. That difference is the whole
 * point: at t = 2s a pass travelling 15 m/s has rolled ~13.5 m, not 30 m, and a
 * player who does not know that runs to the wrong place and the ball goes out.
 */
export function ballAt(w: World, t: number): Vec2 {
  const b = w.ball;
  const airborne = b.h > BALL_RADIUS + 0.05;
  const drag = airborne ? BALL_AIR_DRAG : BALL_FRICTION * weatherMods(w.weather).ballFriction;
  const k = drag > 0.0001 ? (1 - Math.exp(-drag * t)) / drag : t;
  return v2(b.pos.x + b.vel.x * k, b.pos.y + b.vel.y * k);
}

/**
 * How far this player can travel in `t` seconds starting from rest, capped by
 * their top speed and their acceleration ramp.
 */
export function playerReach(p: Player, w: World, t: number): number {
  const vmax = playerMaxSpeed(p, w);
  const a = playerAccel(p, w);
  // Distance while still accelerating, then at top speed for the remainder.
  const tRamp = vmax / a;
  if (t <= tRamp) return 0.5 * a * t * t;
  return 0.5 * a * tRamp * tRamp + vmax * (t - tRamp);
}

/**
 * Earliest time at which this player could get to the ball, or Infinity if
 * they never can. This is what makes players anticipate rather than chase.
 */
export function timeToBall(p: Player, w: World, horizon: number): number {
  const b = w.ball;
  // A ball at rest (or already reachable) is an immediate job.
  if (dist(p.pos, b.pos) <= CONTROL_RADIUS) return 0;
  const step = 0.08;
  for (let t = step; t <= horizon; t += step) {
    if (dist(p.pos, ballAt(w, t)) <= playerReach(p, w, t) + CONTROL_RADIUS) return t;
  }
  return Infinity;
}

/**
 * The point a player should run to in order to meet a moving ball: the
 * predicted ball position at the moment they can actually arrive.
 */
export function interceptPoint(p: Player, w: World, horizon: number): Vec2 {
  const t = timeToBall(p, w, horizon);
  if (!Number.isFinite(t)) return ballAt(w, horizon);
  // Aim at where the ball will be when we get there.
  return ballAt(w, t);
}

/**
 * Where a loose ball will cross a boundary, and when.
 *
 * This is what lets a player set off *before* the ball goes out rather than
 * reacting once it already has. The keep-in stretch on the line only fires in
 * the instant the ball crosses, so a player who has not already arrived is
 * always too late — which is exactly why loose balls kept trickling out for
 * throw-ins with a defender standing a metre away watching.
 *
 * Returns null when the ball is not going out within the horizon, or when it is
 * heading into the goal mouth (the keeper's ball — nobody should sprint in
 * there after it).
 */
export interface BallExit {
  /** Seconds until the ball reaches the line. */
  t: number;
  /** The crossing point, clamped to the line itself. */
  at: Vec2;
  axis: 'x' | 'y';
  side: 1 | -1;
}

export function ballExit(w: World, horizon: number): BallExit | null {
  const b = w.ball;
  if (b.owner !== null) return null;
  const step = 0.06;
  for (let t = step; t <= horizon + 1e-6; t += step) {
    const p = ballAt(w, t);
    const outY = Math.abs(p.y) > PITCH_HALF_W;
    const outX = Math.abs(p.x) > PITCH_HALF_L;
    if (!outY && !outX) continue;
    // Through the goal mouth: that is a goal or the keeper's, not a chase.
    if (outX && !outY && Math.abs(p.y) < GOAL_HALF_W) return null;
    const axis: 'x' | 'y' = outY ? 'y' : 'x';
    return {
      t,
      at: v2(clamp(p.x, -PITCH_HALF_L, PITCH_HALF_L), clamp(p.y, -PITCH_HALF_W, PITCH_HALF_W)),
      axis,
      side: (axis === 'y' ? p.y : p.x) > 0 ? 1 : -1,
    };
  }
  return null;
}

/** Steer a player toward a world-space target for one tick. */
export function steerPlayer(
  p: Player,
  target: Vec2,
  w: World,
  dt: number,
  urgency = 1,
): void {
  const toTarget = sub(target, p.pos);
  const d = len(toTarget);
  const maxSpeed = playerMaxSpeed(p, w, urgency);

  let desired: Vec2;
  if (d < ARRIVE_RADIUS) {
    desired = v2(0, 0);
  } else {
    // Arrive: ease speed down inside 2m.
    const speed = Math.min(maxSpeed, d * 2.4);
    desired = scale(norm(toTarget), speed);
  }

  const accel = playerAccel(p, w) * dt;
  p.vel.x = moveToward(p.vel.x, desired.x, accel);
  p.vel.y = moveToward(p.vel.y, desired.y, accel);

  const sp = len(p.vel);
  if (sp > maxSpeed) {
    p.vel = scale(norm(p.vel), maxSpeed);
  }
}

export function integratePlayer(p: Player, w: World, dt: number): void {
  p.pos.x += p.vel.x * dt;
  p.pos.y += p.vel.y * dt;

  // Keep players inside the arena (a touch beyond the boards is fine).
  p.pos.x = clamp(p.pos.x, -PITCH_HALF_L - 0.5, PITCH_HALF_L + 0.5);
  p.pos.y = clamp(p.pos.y, -PITCH_HALF_W - 0.5, PITCH_HALF_W + 0.5);

  const sp = len(p.vel);
  if (sp > 0.2) {
    const target = angleOf(p.vel);
    const turn = TURN_RATE * weatherMods(w.weather).turnRate;
    p.facing += clamp(angleDiff(p.facing, target), -turn * dt, turn * dt);
  }
  p.speedNorm = clamp(sp / BASE_MAX_SPEED, 0, 1.4);
  p.animPhase += dt * (2 + sp * 1.6);
}

/** Simple circle separation between players (no stacking). */
export function resolvePlayerCollisions(w: World): void {
  const ps = w.players;
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i];
      const b = ps[j];
      const dx = b.pos.x - a.pos.x;
      const dy = b.pos.y - a.pos.y;
      const d = Math.hypot(dx, dy);
      const min = PLAYER_RADIUS * 2;
      if (d > 0.0001 && d < min) {
        const overlap = (min - d) * 0.5;
        const nx = dx / d;
        const ny = dy / d;
        // Stronger player pushes the weaker one further (strength matters).
        const aStr = a.attrs.strength;
        const bStr = b.attrs.strength;
        const total = aStr + bStr;
        const aShare = (bStr / total) * 2; // pushed more if weaker
        const bShare = (aStr / total) * 2;
        a.pos.x -= nx * overlap * clamp(aShare, 0.4, 1.6);
        a.pos.y -= ny * overlap * clamp(aShare, 0.4, 1.6);
        b.pos.x += nx * overlap * clamp(bShare, 0.4, 1.6);
        b.pos.y += ny * overlap * clamp(bShare, 0.4, 1.6);
      }
    }
  }
}

/**
 * Free ball integration. Returns whether the ball crossed the goal line (a
 * goal) or left the field of play (a restart for the engine to set up).
 */
export function integrateBall(w: World, dt: number): BallOutcome {
  const b = w.ball;
  if (b.owner !== null) return { goal: null, out: null }; // dribbling handled elsewhere

  // Horizontal motion
  const speed = len(b.vel);
  if (speed > 0.001) {
    const airborne = b.h > BALL_RADIUS + 0.05;
    // Ground friction is weather-sensitive (ice slides, rain skids, cold grips).
    const drag = airborne ? BALL_AIR_DRAG : BALL_FRICTION * weatherMods(w.weather).ballFriction;
    const damp = Math.max(0, 1 - drag * dt);
    b.vel = scale(b.vel, damp);
  }
  b.pos.x += b.vel.x * dt;
  b.pos.y += b.vel.y * dt;

  // Vertical motion
  b.vh -= BALL_GRAVITY * dt;
  b.h += b.vh * dt;
  if (b.h <= BALL_RADIUS) {
    b.h = BALL_RADIUS;
    if (b.vh < -0.4) b.vh = -b.vh * BALL_RESTITUTION;
    else b.vh = 0;
  }

  // Clamp absurd speeds
  if (len(b.vel) > BALL_MAX_SPEED) b.vel = scale(norm(b.vel), BALL_MAX_SPEED);

  // --- Goal check ---
  if (Math.abs(b.pos.x) > PITCH_HALF_L && Math.abs(b.pos.y) < GOAL_HALF_W && b.h < GOAL_H) {
    const scoringTeam: 0 | 1 = b.pos.x > 0 ? 0 : 1; // team 0 attacks +x
    return { goal: scoringTeam, out: null };
  }

  // --- Out of play ---
  // There are no boards any more: the painted lines are the boundary. Whichever
  // line the ball is furthest past is the one it went out over.
  const overX = Math.abs(b.pos.x) - PITCH_HALF_L;
  const overY = Math.abs(b.pos.y) - PITCH_HALF_W;

  if (overX > 0 || overY > 0) {
    if (overX >= overY) {
      const side: 1 | -1 = b.pos.x > 0 ? 1 : -1;
      b.pos.x = side * PITCH_HALF_L;
      b.vel = scale(b.vel, 0.15);
      return { goal: null, out: { axis: 'x', side } };
    }
    const side: 1 | -1 = b.pos.y > 0 ? 1 : -1;
    b.pos.y = side * PITCH_HALF_W;
    b.vel = scale(b.vel, 0.15);
    return { goal: null, out: { axis: 'y', side } };
  }

  return { goal: null, out: null };
}

/** Keep the controlled ball glued slightly ahead of the carrier. */
export function dribbleBall(w: World, p: Player, dt: number): void {
  const b = w.ball;
  const lead = fromAngle(p.facing, 0.62 + p.speedNorm * 0.25);
  const target = add(p.pos, lead);
  const t = clamp(dt * 16, 0, 1);
  b.pos = lerpVec(b.pos, target, t);

  // A dribble stays on the pitch. The one exception is the goal mouth, where
  // the carrier is allowed to walk the ball over the line (and score).
  b.pos.y = clamp(b.pos.y, -PITCH_HALF_W + BALL_RADIUS, PITCH_HALF_W - BALL_RADIUS);
  const mouth = Math.abs(b.pos.y) < GOAL_HALF_W;
  const limit = mouth ? PITCH_HALF_L + 0.3 : PITCH_HALF_L - BALL_RADIUS;
  b.pos.x = clamp(b.pos.x, -limit, limit);

  b.vel = scale(p.vel, 1);
  b.h = BALL_RADIUS;
  b.vh = 0;
  b.owner = p.id;
}

/** Try to gain control of a loose ball for this player. */
export function tryControl(w: World, p: Player): boolean {
  const b = w.ball;
  if (b.looseTimer > 0) return false;
  if (b.h > 0.75) return false;
  if (dist(p.pos, b.pos) > CONTROL_RADIUS) return false;
  b.owner = p.id;
  b.lastTouch = p.id;
  return true;
}

/** Release the ball with a velocity + optional loft. */
export function kickBall(
  w: World,
  from: Player,
  dir: Vec2,
  speed: number,
  loft = 0,
): void {
  const b = w.ball;
  const n = norm(dir);
  b.pos = add(from.pos, scale(n, PLAYER_RADIUS + BALL_RADIUS + 0.05));
  b.vel = scale(n, speed);
  b.vh = loft;
  b.h = Math.max(BALL_RADIUS, loft > 0 ? 0.35 : BALL_RADIUS);
  b.owner = null;
  b.lastTouch = from.id;
  b.looseTimer = 0.12;
  b.saveCooldown = 0; // a new strike earns the keeper a fresh dive
}

export function nearestOpponent(w: World, p: Player): Player | null {
  let best: Player | null = null;
  let bd = Infinity;
  for (const o of w.players) {
    if (o.team === p.team) continue;
    const d = dist(o.pos, p.pos);
    if (d < bd) {
      bd = d;
      best = o;
    }
  }
  return best;
}

export function isTackleRange(w: World, p: Player): boolean {
  const b = w.ball;
  if (b.owner === null) return false;
  const owner = w.players.find((x) => x.id === b.owner);
  if (!owner || owner.team === p.team) return false;
  return dist(p.pos, owner.pos) < TACKLE_RADIUS && dist(p.pos, b.pos) < TACKLE_RADIUS + 0.4;
}

export { CONTROL_RADIUS, LOSE_RADIUS };
