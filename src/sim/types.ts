// sim/types.ts — the shared vocabulary of the simulation.

import type { Vec2 } from './core/math';
import type { Rng } from './core/rng';

/** Any roster id (see roster.ts). Kept as a string so new Vibers are pure data. */
export type ViberId = string;
export type TeamId = 0 | 1;
export type Mentality = 'attack' | 'balanced' | 'defend' | 'counter';
export type Role = 'GK' | 'DEF' | 'MID' | 'FWD';

/** Pitch conditions chosen before kick-off. */
export type WeatherKind = 'sun' | 'rain' | 'ice' | 'cold';

/** Everything the pre-match flow decides. Passed to createWorld(). */
export interface MatchConfig {
  seed: number;
  /** Home (human) starting five, in the order they were picked. */
  homeIds: string[];
  /** Away (CPU) starting five. */
  awayIds: string[];
  awayClubId: string;
  weather: WeatherKind;
  /** Real seconds per half. */
  halfSeconds: number;
  /**
   * Substitutes available to the human's side. Optional: a match with no bench
   * simply cannot make a substitution. See `autoBench` for the default bench.
   */
  benchIds?: string[];
}

export type Decision =
  | 'chase'
  | 'hold'
  | 'support'
  | 'dribble'
  | 'pass'
  | 'cross'
  | 'shoot'
  | 'clear'
  | 'keeper';

/** The dead-ball restarts a match can be stopped for. */
export type SetPieceKind = 'throwin' | 'corner' | 'goalkick' | 'freekick' | 'penalty';
/** From the defending keeper's view, matching the camera's left-to-right axis. */
export type DiveDirection = 'left' | 'centre' | 'right';

/** A penalty in flight; resolved where it crosses the keeper's reach. */
export interface PenaltyShot {
  team: TeamId;
  keeper: number | null;
  dive: DiveDirection;
  /** Elapsed flight time, used for the keeper's visible lateral dive. */
  elapsed: number;
}

/** A restart waiting to be taken. */
export interface SetPiece {
  kind: SetPieceKind;
  /** The team awarded the restart. */
  team: TeamId;
  /** Where the ball is placed. */
  pos: Vec2;
  /** Player id taking it, or null until one is assigned. */
  taker: number | null;
  /** Which side of the pitch (sign of y) — corners and throw-ins only. */
  side: 1 | -1;
}

export interface Attributes {
  pace: number; // 1..99
  strength: number;
  shooting: number;
  passing: number;
  tackling: number;
  technique: number;
}

/**
 * A Viber waiting on the bench.
 *
 * Deliberately NOT a `Player`: a substitute is not in the world until they come
 * on, so they have no position, no velocity and no AI state — giving them a
 * Player would mean a rig on the pitch that nobody can see. Everything needed
 * to *become* a player is here.
 */
export interface BenchPlayer {
  viber: ViberId;
  name: string;
  role: Role;
  attrs: Attributes;
}

export interface Player {
  id: number;
  team: TeamId;
  viber: ViberId;
  name: string;
  role: Role;
  slot: Vec2; // normalized formation slot: x -1(own goal)..1(opp goal), y -1..1
  pos: Vec2;
  vel: Vec2;
  facing: number; // radians
  attrs: Attributes;
  isGK: boolean;
  /**
   * Why this player is no longer on the pitch, if they are not. A sent-off or
   * injured player is parked off it and skipped by the AI, so the side plays a
   * player short — the whole point of a red card.
   *
   * The player stays in `world.players` rather than being spliced out: the
   * renderer binds a rig per player at kick-off and the ball may still reference
   * their id, so removing the entry would leave both dangling. Parking keeps
   * every id stable and lets the model visibly walk to the touchline.
   */
  off?: 'red' | 'injury';
  // AI runtime
  decision: Decision;
  think: number; // seconds until next decision
  cooldown: number; // seconds until next shoot/pass allowed
  intentTarget: Vec2 | null; // pass target for the current decision
  // presentation hints
  animPhase: number;
  speedNorm: number; // 0..1 for animation blending
}

export interface Ball {
  pos: Vec2;
  h: number; // height above ground
  vel: Vec2;
  vh: number; // vertical velocity
  spin: number;
  owner: number | null; // player id currently controlling
  lastTouch: number | null;
  looseTimer: number; // seconds since last touch (prevents instant re-own)
  /** Seconds until a keeper may dive at this ball again (one dive per shot). */
  saveCooldown: number;
}

export interface Team {
  id: TeamId;
  name: string;
  short: string;
  isHuman: boolean;
  mentality: Mentality;
  formation: string;
  score: number;
  specialTimer: number; // seconds of active special remaining
  specialCooldown: number;
  color: number;
  accent: number;
  possessionTicks: number;
}

export type MatchPhase =
  | 'kickoff'
  | 'play'
  | 'goal'
  | 'halftime'
  | 'fulltime'
  // Dead-ball phases. The clock keeps running; the ball is placed and the
  // awarded side restarts it when the phase timer expires.
  | 'throwin'
  | 'corner'
  | 'goalkick'
  | 'freekick'
  | 'penalty'
  | 'penaltyshot';

export interface MatchStats {
  shots: [number, number];
  passes: [number, number];
  tackles: [number, number];
  possession: [number, number]; // ticks
  corners: [number, number];
  fouls: [number, number];
  penalties: [number, number];
}

export type SimEvent =
  | { type: 'kickoff'; half: 1 | 2 }
  | { type: 'goal'; team: TeamId; scorer: number; minute: number }
  | { type: 'shot'; team: TeamId; player: number; onTarget: boolean }
  | { type: 'save'; team: TeamId; keeper: number }
  | { type: 'pass'; team: TeamId; player: number }
  | { type: 'tackle'; team: TeamId; player: number; won: boolean }
  | { type: 'special'; team: TeamId; player: number }
  | { type: 'setpiece'; kind: SetPieceKind; team: TeamId }
  | { type: 'foul'; team: TeamId; player: number; penalty: boolean }
  /**
   * Discipline.
   *
   * `matches` is how many LEAGUE FIXTURES the player will miss AFTER this one.
   * A yellow carries no ban, so it reports 0; a red reports 1-2 and an injury
   * 1-3. The sim decides the number because the roll comes off the seeded
   * `disciplineRng` — the career layer records it rather than inventing it, so
   * the same seed always produces the same injury list.
   */
  | { type: 'card'; team: TeamId; player: number; card: 'yellow' | 'red'; off: boolean; matches: number }
  | { type: 'injury'; team: TeamId; player: number; matches: number }
  | { type: 'halftime' }
  | { type: 'fulltime'; score: [number, number] }
  /**
   * The referee's whistle. `kind` is what the audio layer keys off — a single
   * short blast to start play reads nothing like the long one that ends the
   * match, and the sim is the only place that knows which is which.
   */
  | { type: 'whistle'; kind: WhistleKind }
  /** A Viber came on for another. `out` is the id they replaced. */
  | { type: 'sub'; team: TeamId; out: number; in: ViberId };

export type WhistleKind = 'kickoff' | 'goal' | 'foul' | 'halftime' | 'fulltime';

export type Command =
  | { type: 'mentality'; team: TeamId; value: Mentality }
  | { type: 'special'; team: TeamId }
  | { type: 'action'; team: TeamId; value: 'shoot' | 'pass' | 'clear' }
  | { type: 'dive'; team: TeamId; value: DiveDirection }
  | { type: 'shot'; team: TeamId; value: DiveDirection }
  /**
   * Bring a substitute on. `out` is the on-pitch player's id and `in` the bench
   * Viber's id. Applied by `substitute()`; the roster change is the only thing
   * a substitution does.
   */
  | { type: 'sub'; team: TeamId; out: number; in: ViberId }
  | { type: 'resume' }
  | { type: 'pause'; value: boolean };

export interface World {
  seed: number;
  tick: number;
  clock: number; // elapsed match seconds (real-time seconds of play)
  half: 1 | 2;
  /** Real seconds per half (chosen before kick-off). */
  halfSeconds: number;
  /** Pitch conditions for this match. */
  weather: WeatherKind;
  phase: MatchPhase;
  phaseTimer: number; // countdown within kickoff/goal phases
  paused: boolean;
  ball: Ball;
  players: Player[];
  teams: [Team, Team];
  /**
   * Substitutes available to each team (index 0 = the human's side). A Viber
   * leaves this list the moment they come on; when it is empty, no further
   * substitution is possible.
   */
  bench: [BenchPlayer[], BenchPlayer[]];
  /** Substitutions already made, per team. */
  subsMade: [number, number];
  stats: MatchStats;
  events: SimEvent[];
  rng: Rng;
  /**
   * A SECOND, independent stream for cards and injuries.
   *
   * Kept separate on purpose. The main `rng` sequence decides every pass, shot
   * and tackle, so drawing discipline rolls from it would shift every later
   * value and silently change the outcome of matches that have nothing to do
   * with discipline — including the pinned replays the test suite compares. Its
   * own stream means adding cards changed no existing result.
   */
  disciplineRng: Rng;
  possession: TeamId | null;
  lastGoalTeam: TeamId | null;
  /** Which team restarts play (the conceding side, per football convention). */
  kickoffTeam: TeamId;
  /** Seconds during which no tackles may be attempted (prevents ping-pong). */
  tackleLock: number;
  /** The restart currently being set up, if any. */
  setPiece: SetPiece | null;
  /** The defending side's queued dive, consumed when the penalty is struck. */
  penaltyDive: DiveDirection | null;
  /** The human shooter's queued placement, consumed when their penalty is struck. */
  penaltyAim: DiveDirection | null;
  /** Non-null while a penalty ball is travelling toward the goalkeeper. */
  penaltyShot: PenaltyShot | null;
  /**
   * Which flank the human keeps attacking, as a rolling average of the ball's
   * y-sign in the attacking third (-1..1). The CPU shades its block across.
   */
  flankBias: number;
  pending: Command[];
  /** Actions currently offered to the human (contextual, spec §5.2). */
  offers: Array<'shoot' | 'pass' | 'clear'>;
}
