// sim/world.ts — builds a fresh, deterministic match world from a MatchConfig.

import { makeRng } from './core/rng';
import { v2, type Vec2 } from './core/math';
import { BALL_RADIUS, PITCH_HALF_L, PITCH_HALF_W } from './constants';
import { CLUBS, FORMATIONS } from './content';
import { buildLineup, ROSTER_BY_ID, type LineupSlot } from './roster';
import type { MatchConfig, Player, Role, Team, TeamId, ViberId, World } from './types';

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

function slotWorldPos(p: Player, ball: Vec2): Vec2 {
  // Formation slot in world space, mirrored per team, then pulled toward the ball
  // so the block slides with play (spec §5.2: AI owns positioning).
  const baseX = p.slot.x * PITCH_HALF_L * 0.92;
  const baseY = p.slot.y * PITCH_HALF_W * 0.82;
  const pull = p.isGK ? 0.05 : 0.22;
  return v2(
    baseX + (ball.x - baseX) * pull,
    baseY + (ball.y - baseY) * pull * 0.9,
  );
}

export { slotWorldPos };

export function createWorld(config: MatchConfig): World {
  nextPlayerId = 1;
  const home = makeTeam(0, 'vibe_united', true);
  const away = makeTeam(1, config.awayClubId, false);
  const homeLineup = buildLineup(config.homeIds);
  const awayLineup = buildLineup(config.awayIds);
  const players = [...makePlayers(home, homeLineup), ...makePlayers(away, awayLineup)];

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
    possession: null,
    lastGoalTeam: null,
    kickoffTeam: 0,
    tackleLock: 0,
    setPiece: null,
    penaltyDive: null,
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

  const kicking = world.kickoffTeam;

  for (const p of world.players) {
    // Kickoff rules: everyone starts in their own half, spread by role so the
    // shape reads like a real restart instead of a pile-up at the centre.
    const ownSideSign = p.team === 0 ? -1 : 1;
    const x = ownSideSign * KICKOFF_DEPTH[p.role] * PITCH_HALF_L;
    const y = p.slot.y * PITCH_HALF_W * 0.72;

    p.pos = v2(x, y);
    p.vel = v2(0, 0);
    p.decision = 'hold';
    p.think = 0;
    p.cooldown = 0;
    p.intentTarget = null;
  }

  // The kicking team's forward steps up to the ball, guaranteeing a clean,
  // uncontested restart for the side that has the right to kick off.
  const taker = world.players.find((p) => p.team === kicking && p.role === 'FWD');
  if (taker) taker.pos = v2(kicking === 0 ? -0.6 : 0.6, 0);
}
