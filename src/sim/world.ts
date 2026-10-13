// sim/world.ts — builds a fresh, deterministic match world from a MatchConfig.

import { makeRng } from './core/rng';
import { clamp, v2 } from './core/math';
import { BALL_RADIUS, MENTALITY_SHAPE, PITCH_HALF_L, PITCH_HALF_W } from './constants';
import { CLUBS, FORMATIONS } from './content';
import { buildLineup, ROSTER_BY_ID, type LineupSlot } from './roster';
import type {
  BenchPlayer,
  MatchConfig,
  Player,
  Role,
  Team,
  TeamId,
  ViberId,
  World,
} from './types';

let nextPlayerId = 1;

function makeTeam(id: TeamId, clubId: string, isHuman: boolean): Team {
  const club = CLUBS[clubId];
  return {
    id,
    name: club.name,
    short: club.short,
    isHuman,
    mentality: 'balanced',
    formation: '5-1-2-1',
    score: 0,
    specialTimer: 0,
    specialCooldown: 0,
    color: club.color,
    accent: club.accent,
    possessionTicks: 0,
  };
}

function makePlayers(team: Team, lineup: LineupSlot[]): Player[] {
  const formation = FORMATIONS[team.formation];
  const out: Player[] = [];
  const dir = team.id === 0 ? 1 : -1; // team 0 attacks +x

  formation.slots.forEach((slot, index) => {
    const isGK = slot.role === 'GK';
    const pick = lineup[index];
    const viber: ViberId = pick?.id ?? 'volt';
    const v = ROSTER_BY_ID[viber];

    out.push({
      id: nextPlayerId++,
      team: team.id,
      viber,
      name: v?.name ?? 'Viber',
      role: slot.role,
      slot: { x: slot.pos.x * dir, y: slot.pos.y },
      pos: v2(0, 0),
      vel: v2(0, 0),
      facing: dir > 0 ? 0 : Math.PI,
      attrs: { ...(v?.attrs ?? { pace: 60, strength: 60, shooting: 60, passing: 60, tackling: 60, technique: 60 }) },
      isGK,
      decision: 'hold',
      think: 0,
      cooldown: 0,
      intentTarget: null,
      animPhase: 0,
      speedNorm: 0,
    });
  });

  return out;
}

/** Turn a list of bench Viber ids into the bench the match actually carries. */
function makeBench(ids: string[]): BenchPlayer[] {
  const out: BenchPlayer[] = [];
  for (const id of ids) {
    const v = ROSTER_BY_ID[id];
    if (!v) continue;
    out.push({ viber: v.id, name: v.name, role: v.role, attrs: { ...v.attrs } });
  }
  return out;
}

export function createWorld(config: MatchConfig): World {
  nextPlayerId = 1;
  const home = makeTeam(0, 'vibe_united', true);
  const away = makeTeam(1, config.awayClubId, false);
  const homeLineup = buildLineup(config.homeIds);
  const awayLineup = buildLineup(config.awayIds);
  const players = [...makePlayers(home, homeLineup), ...makePlayers(away, awayLineup)];
  // Only the human's side carries a bench. The CPU does not rotate, so giving
  // it one would be dead weight the renderer and the UI both have to skip.
  const bench: [BenchPlayer[], BenchPlayer[]] = [makeBench(config.benchIds ?? []), []];

  const world: World = {
    seed: config.seed,
    tick: 0,
    clock: 0,
    half: 1,
    halfSeconds: config.halfSeconds,
    weather: config.weather,
    phase: 'kickoff',
    phaseTimer: 1.2,
    paused: false,
    ball: {
      pos: v2(0, 0),
      h: BALL_RADIUS,
      vel: v2(0, 0),
      vh: 0,
      spin: 0,
      owner: null,
      lastTouch: null,
      looseTimer: 0,
      saveCooldown: 0,
    },
    players,
    teams: [home, away],
    bench,
    subsMade: [0, 0],
    stats: {
      shots: [0, 0],
      passes: [0, 0],
      tackles: [0, 0],
      possession: [0, 0],
      corners: [0, 0],
      fouls: [0, 0],
      penalties: [0, 0],
    },
    events: [],
    rng: makeRng(config.seed),
    // A distinct stream (a different constant, same seed) so discipline rolls
    // cannot perturb the match rng. See `World.disciplineRng`.
    disciplineRng: makeRng((config.seed ^ 0x9e3779b9) >>> 0),
    possession: null,
    lastGoalTeam: null,
    kickoffTeam: 0,
    tackleLock: 0,
    setPiece: null,
    penaltyDive: null,
    penaltyAim: null,
    penaltyShot: null,
    flankBias: 0,
    pending: [],
    offers: [],
  };

  resetPositions(world, 'kickoff');
  return world;
}

/** How deep in their own half each role starts at a kickoff (fraction of half-length). */
const KICKOFF_DEPTH: Record<Role, number> = {
  GK: 0.92,
  DEF: 0.52,
  MID: 0.26,
  FWD: 0.06,
};

/** Place everyone for a kickoff / restart. */
export function resetPositions(world: World, _kind: 'kickoff' | 'goal'): void {
  const ball = world.ball;
  ball.pos = v2(0, 0);
  ball.h = BALL_RADIUS;
  ball.vel = v2(0, 0);
  ball.vh = 0;
  ball.spin = 0;
  ball.owner = null;
  ball.lastTouch = null;
  ball.looseTimer = 0;
  ball.saveCooldown = 0;

  // Any dead ball is cancelled by a kickoff.
  world.setPiece = null;
  world.penaltyShot = null;
  world.penaltyDive = null;
  world.penaltyAim = null;

  const kicking = world.kickoffTeam;

  for (const p of world.players) {
    // Anyone who has left the pitch (red card, injury) stays off it. A restart
    // must not march a dismissed player back on.
    if (p.off) continue;
    // Kickoff rules: everyone starts in their own half, spread by role so the
    // shape reads like a real restart instead of a pile-up at the centre. The
    // mentality reshapes it further, so a Defend side lines up deep and narrow
    // while an Attack side lines up high — the arrangement matches the approach
    // from the very first whistle.
    const ownSideSign = p.team === 0 ? -1 : 1;
    const dir = p.team === 0 ? 1 : -1;
    const shape = MENTALITY_SHAPE[world.teams[p.team].mentality];
    // At a kickoff only the whole-team depth shift is applied, so the role
    // lines keep their relative order (the full per-role shape would pile
    // everyone onto the halfway line, which the own-half rule clamps them to).
    const rawX = ownSideSign * KICKOFF_DEPTH[p.role] * PITCH_HALF_L + shape.depth * dir;
    // Never let the shape push anyone across the halfway line at a kickoff.
    const x =
      ownSideSign < 0
        ? clamp(rawX, -PITCH_HALF_L * 0.95, -0.6)
        : clamp(rawX, 0.6, PITCH_HALF_L * 0.95);
    const y = clamp(
      p.slot.y * PITCH_HALF_W * shape.width,
      -PITCH_HALF_W * 0.9,
      PITCH_HALF_W * 0.9,
    );

    p.pos = v2(x, y);
    p.vel = v2(0, 0);
    p.decision = 'hold';
    p.think = 0;
    p.cooldown = 0;
    p.intentTarget = null;
  }

  // The kicking team's forward steps up to the ball, guaranteeing a clean,
  // uncontested restart for the side that has the right to kick off.
  const taker = world.players.find((p) => p.team === kicking && p.role === 'FWD' && !p.off);
  if (taker) taker.pos = v2(kicking === 0 ? -0.6 : 0.6, 0);
}
