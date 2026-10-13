// sim/constants.ts — tuning constants. Data, not code (spec §20).

import type { Mentality, Role } from './types';

export const TICK_HZ = 60;
export const TICK = 1 / TICK_HZ;

// --- Pitch (metres). x = length, y = width. Origin at centre spot. ---
export const PITCH_HALF_L = 20;
export const PITCH_HALF_W = 12;
export const GOAL_HALF_W = 2.0;
export const GOAL_H = 2.2;

// --- Entities ---
export const PLAYER_RADIUS = 0.45;
export const BALL_RADIUS = 0.22;
/**
 * How close a player must be to take control of a loose ball.
 *
 * Deliberately larger than the player collision diameter (PLAYER_RADIUS * 2 =
 * 0.9). If it were smaller, two players jostling over a loose ball would be
 * held apart by the collision solver at exactly the distance where neither
 * could claim it — the ball would sit untouched between them forever.
 */
export const CONTROL_RADIUS = 0.95;
export const KEEPER_CONTROL_RADIUS = 2.5;
/**
 * How far a keeper can reach to keep out a *fast* ball. Collecting a slow ball
 * (a cross, a back-pass) uses KEEPER_CONTROL_RADIUS; stopping a shot is a dive,
 * so the reach is much smaller — otherwise the keeper covers the whole goal and
 * nobody ever scores.
 */
export const KEEPER_SAVE_REACH = 1.25;
export const LOSE_RADIUS = 1.15;
export const TACKLE_RADIUS = 1.05;

// --- Ball physics ---
export const BALL_FRICTION = 1.6; // ground rolling damping (per second)
export const BALL_AIR_DRAG = 0.35;
export const BALL_GRAVITY = 14;
export const BALL_RESTITUTION = 0.55;
export const BALL_MAX_SPEED = 42;

// --- Movement ---
export const BASE_MAX_SPEED = 5.4;
export const PACE_SPEED_FACTOR = 0.040; // + up to ~4.0 m/s at pace 99
export const BASE_ACCEL = 19;
export const ACCEL_FACTOR = 0.14;
export const TURN_RATE = 10.5; // rad/s
export const SPECIAL_SPEED_MULT = 1.28;
export const SPECIAL_DURATION = 6; // seconds
export const SPECIAL_COOLDOWN = 22; // seconds

/**
 * How far ahead a player looks when hunting a loose ball. Long enough that a
 * struck pass or a shot can be read and intercepted, short enough that nobody
 * abandons their shape to chase a ball that is already gone.
 */
export const INTERCEPT_HORIZON = 3.2;

/**
 * A player this close to a ball that just crossed the line can still stretch
 * and keep it in play (only for the side that would win the restart).
 */
export const KEEP_IN_REACH = 2.2;

/**
 * How far ahead a player reads a loose ball that is heading out of play. Long
 * enough to actually set off toward the line, short enough that nobody abandons
 * a ball that is only going to be a throw-in to the other side.
 */
export const KEEP_IN_HORIZON = 1.7;

/**
 * The extra turn of speed a player gets when chasing a ball down to keep it in.
 *
 * This is the difference the request was about: without it a player who reads
 * the exit correctly still arrives a stride late and the ball rolls over the
 * line anyway. It applies only to that errand — not to open play — so it cannot
 * be farmed as a free speed boost.
 */
export const KEEP_IN_SPRINT_MULT = 1.2;

// --- Match ---
export const HALF_SECONDS = 90; // real seconds per half => 3 min match
export const DISPLAY_MINUTES = 90; // shown on the clock across the whole match
export const KICKOFF_PAUSE = 1.6; // seconds
export const GOAL_PAUSE = 2.6; // seconds
export const THINK_INTERVAL = 0.22; // seconds between AI decisions
export const ACTION_COOLDOWN = 0.7; // seconds between shoot/pass attempts
export const SHOT_SPEED = 28;
/**
 * A long shot is hit harder than a placed finish, so a striker can score from
 * range rather than only from inside the box. Combined with the raised
 * BALL_MAX_SPEED this is what makes "a goal from anywhere" possible.
 */
export const LONG_SHOT_POWER = 1.24;
export const PASS_SPEED_BASE = 13;
/** Comfortably in range: always worth pulling the trigger. */
export const SHOOT_RANGE = 9;
/**
 * The edge of realistic long-shot territory. Beyond SHOOT_RANGE a player will
 * still have a go if they have shooting ability and room to line it up — this
 * is where the spectacular goals come from.
 */
export const LONG_SHOT_RANGE = 17.5;
/** Shooting ability needed before a player will try one from distance. */
export const LONG_SHOT_MIN_SHOOTING = 52;
/** Clearance in metres a player needs before attempting a long shot. */
export const LONG_SHOT_SPACE = 2.4;
export const PASS_MIN_ADVANCE = 0.5; // must be forward of carrier (metres)
/** Passes longer than this are lofted rather than rolled. */
export const LONG_PASS_DISTANCE = 15;

// --- Steering ---
/**
 * How close a player has to be to a target before they stop walking toward it.
 * Anything larger than a stride reads as "standing still", which is the single
 * most common way a football sim looks broken.
 */
export const ARRIVE_RADIUS = 0.15;
/**
 * Teammate separation is a *bias* on a run, never a veto. When a player still
 * has ground to cover toward their real target, at least this fraction of that
 * distance is always kept — otherwise crowding can cancel the target and freeze
 * the player on the spot forever.
 */
export const SEPARATION_MIN_PROGRESS = 0.45;

// --- Dead-ball restarts (set pieces) ---
export const SETPIECE_PAUSE: Record<'throwin' | 'goalkick' | 'freekick' | 'corner' | 'penalty', number> = {
  throwin: 0.7,
  goalkick: 1.0,
  freekick: 1.1,
  corner: 1.1,
  penalty: 2.0,
};

/** The penalty area: depth from the goal line, half-width across. */
export const PENALTY_AREA_DEPTH = 6.5;
export const PENALTY_AREA_HALF_W = 7.5;
/** Where a penalty is spotted from the goal line. */
export const PENALTY_SPOT = 10.0;

/** Chance a failed tackle inside your own box is given as a foul. */
export const FOUL_CHANCE_BOX = 0.34;
/** Chance a failed tackle elsewhere is given as a foul. */
export const FOUL_CHANCE_OPEN = 0.12;

/*
 * DISCIPLINE.
 *
 * Every roll below is drawn from `world.disciplineRng`, never the match rng.
 * That separation is deliberate: the match rng decides every pass, shot and
 * tackle, so taking discipline rolls from it would shift every later value and
 * quietly change matches that have nothing to do with cards. On its own stream,
 * these numbers can be tuned without moving a single existing result.
 */
/** Share of fouls bad enough to be carded at all. */
export const CARD_CHANCE = 0.26;
/** Share of those cards that are red rather than yellow. */
export const RED_CARD_SHARE = 0.12;
/** Share of fouls that leave the victim unable to continue. */
export const INJURY_CHANCE_FOUL = 0.06;
/** How far beyond the touchline a player who has left the pitch is parked. */
export const OFF_PITCH_MARGIN = 3.5;

/*
 * How long a player is out for, in LEAGUE FIXTURES, as an inclusive range.
 *
 * Rolled here, on `disciplineRng`, rather than by the career layer — the same
 * reason the card rolls live here. The duration is decided by the seed, so a
 * replay of the same season produces the same injury list, and the career only
 * has to *record* what the match reported. "Moderate" severity, as chosen:
 * a knock costs up to three games, a sending-off up to two.
 */
/** Fixtures missed through injury. */
export const INJURY_MATCHES: readonly [number, number] = [1, 3];
/** Fixtures missed through a red card. */
export const SUSPENSION_MATCHES: readonly [number, number] = [1, 2];

/** Distance from the byline inside which a wide player crosses instead of shooting. */
export const CROSS_RANGE = 7.5;
/** Distance from the byline inside which a player attacks the corner flag. */
export const BYLINE_RANGE = 9;

export const CROSS_SPEED = 15;
export const CORNER_SPEED = 14.5;
export const GOAL_KICK_SPEED = 21;
export const FREE_KICK_SPEED = 18;
export const PENALTY_SPEED = 26;

/**
 * How a mentality reshapes the side's *arrangement* — not a stat boost, a
 * different shape on the pitch. This is what makes "Defend" actually look like
 * a defensive block and "Attack" look like a side pushing up, rather than the
 * whole team simply sliding a couple of metres.
 *
 *   depth — whole-team forward shift in metres (positive = up the pitch).
 *   role  — extra forward shift per role on top of `depth`, so the lines do not
 *           move as one lump (a defensive line pushes up while the striker
 *           stays high; a striker drops in to press when defending).
 *   width — horizontal stretch (1 = full width, <1 = narrow and compact).
 *   compact — how tightly the block sits around the ball (1 = rigid slots,
 *           lower = the whole side collapses onto the ball's channel).
 */
export interface MentalityShape {
  depth: number;
  role: Record<Role, number>;
  width: number;
  compact: number;
}

export const MENTALITY_SHAPE: Record<Mentality, MentalityShape> = {
  // High line, full width, bodies committed forward.
  attack: { depth: 3.0, role: { GK: 0, DEF: 3.5, MID: 3.0, FWD: 2.5 }, width: 1.0, compact: 0.95 },
  // The neutral shape: moderate depth, normal width.
  balanced: { depth: 0.0, role: { GK: 0, DEF: 0, MID: 0, FWD: 0 }, width: 0.85, compact: 0.9 },
  // A deep, narrow block. The striker stays high as an out-ball.
  defend: { depth: -2.8, role: { GK: 0, DEF: -3.0, MID: -1.5, FWD: 1.5 }, width: 0.7, compact: 0.78 },
  // Sit in, stay compact, ready to break: deeper than balanced, but the striker
  // is already upfield so the counter has an outlet.
  counter: { depth: -1.6, role: { GK: 0, DEF: -1.5, MID: -0.5, FWD: 0.5 }, width: 0.78, compact: 0.84 },
};
