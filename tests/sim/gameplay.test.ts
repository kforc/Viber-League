import { describe, expect, it } from 'vitest';
import {
  autoOpponent,
  createWorld,
  dist,
  drainEvents,
  len,
  queue,
  step,
  TICK,
  type MatchConfig,
  type SimEvent,
} from '../../src/sim';

/**
 * These tests exist because the sim once shipped with a steering bug that made
 * every player freeze on the spot: teammate separation could cancel a player's
 * target, and `steerPlayer` reads "target is where I already am" as "stop".
 * The result was a match where the ball sat untouched a metre from four
 * players, and the whole side stood around in midfield.
 *
 * They assert *behaviour*, not implementation, so the numbers are deliberately
 * loose — they are a floor on liveliness, not a tuning target.
 */

const HOME = ['frost', 'moss', 'volt', 'cobalt', 'crimson'];

/**
 * How close to the ball a player has to be for "standing still" to be a defect
 * rather than a job.
 *
 * The pitch is 40m long and 24m wide, so 12m is comfortably inside the same
 * passage of play and comfortably outside a striker holding the highest line
 * while his side has the ball 30m away in their own corner.
 */
const INVOLVED_RADIUS = 12;

function makeConfig(seed: number): MatchConfig {
  return {
    seed,
    homeIds: HOME,
    awayIds: autoOpponent(HOME, seed).ids,
    awayClubId: 'neon_rangers',
    weather: 'sun',
    halfSeconds: 120,
  };
}

interface MatchRead {
  seed: number;
  finalThirdEntries: number;
  ballSideStall: number;
  longestFrozen: number;
  longestFrozenAnywhere: number;
  longestUnclaimed: number;
  passes: number;
  shots: number;
  goals: number;
  throwins: number;
  corners: number;
}

function readMatch(seed: number): MatchRead {
  const w = createWorld(makeConfig(seed));
  const events: SimEvent[] = [];

  let inFinal = false;
  let finalThirdEntries = 0;
  let ballSideStall = 0;
  let ballSideTicks = 0;
  let longestFrozen = 0;
  let longestFrozenAnywhere = 0;
  let longestUnclaimed = 0;
  const stallRun = new Map<number, number>();
  const anywhereRun = new Map<number, number>();
  let unclaimedRun = 0;

  for (let i = 0; i < 60 * 250; i++) {
    if (w.phase === 'halftime') queue(w, { type: 'resume' });
    step(w, TICK);
    events.push(...drainEvents(w));
    if (w.phase !== 'play') continue;

    const b = w.ball;

    // The ball actually reaches the final third (no midfield stalemate).
    const nowFinal = Math.abs(b.pos.x) > 20 * 0.667;
    if (nowFinal && !inFinal) finalThirdEntries++;
    inFinal = nowFinal;

    // A stationary ball with nobody claiming it is the freeze signature.
    const stationary = len(b.vel) < 0.15 && b.h < 0.6;
    const claimed = b.owner !== null;
    unclaimedRun = stationary && !claimed ? unclaimedRun + 1 : 0;
    if (unclaimedRun > longestUnclaimed) longestUnclaimed = unclaimedRun;

    for (const p of w.players) {
      /*
       * A sent-off or injured player is parked beyond the touchline and is
       * SUPPOSED to stand still — that is what being a man down looks like on
       * the pitch. The invariant below is about players still involved in play,
       * so anyone off is excluded rather than counted as a frozen spectator.
       */
      if (p.isGK || p.off) continue;
      const d = dist(p.pos, b.pos);
      if (d < 10) {
        ballSideTicks++;
        if (len(p.vel) < 0.6) ballSideStall++;
      }

      /*
       * The frozen run is only counted while the player is IN the passage of
       * play, and this is a correctness fix rather than a loosening.
       *
       * The sim deliberately leaves the furthest-forward attacker standing on
       * his station while his side has the ball deep in their own half: he is
       * the out-ball, and holding the highest line is the whole point of him
       * (see MENTALITY_SHAPE — "the striker stays high as an out-ball"). That
       * role is stationary by design, so a global "nobody stands still" check
       * was measuring a tactic and calling it a bug. It only ever passed
       * because no seed happened to produce a long spell of possession deep in
       * one half; a red card stretches a side enough to expose it.
       *
       * Inactivity near the ball is the thing that actually looks broken, so
       * that is what is measured. The separate `longestFrozenAnywhere` below
       * keeps the global reach for a genuine statue.
       */
      const involved = d < INVOLVED_RADIUS;
      const run = involved && len(p.vel) < 0.35 ? (stallRun.get(p.id) ?? 0) + 1 : 0;
      stallRun.set(p.id, run);
      if (run > longestFrozen) longestFrozen = run;

      const anywhere = len(p.vel) < 0.35 ? (anywhereRun.get(p.id) ?? 0) + 1 : 0;
      anywhereRun.set(p.id, anywhere);
      if (anywhere > longestFrozenAnywhere) longestFrozenAnywhere = anywhere;
    }
  }

  let throwins = 0;
  let corners = 0;
  for (const e of events) {
    if (e.type !== 'setpiece') continue;
    if (e.kind === 'throwin') throwins++;
    else if (e.kind === 'corner') corners++;
  }

  return {
    seed,
    finalThirdEntries,
    ballSideStall: ballSideStall / Math.max(1, ballSideTicks),
    longestFrozen: longestFrozen * TICK,
    longestFrozenAnywhere: longestFrozenAnywhere * TICK,
    longestUnclaimed: longestUnclaimed * TICK,
    passes: w.stats.passes[0] + w.stats.passes[1],
    shots: w.stats.shots[0] + w.stats.shots[1],
    goals: w.teams[0].score + w.teams[1].score,
    throwins,
    corners,
  };
}

describe('gameplay feel', () => {
  const seeds = [11, 22, 33, 44, 55, 66];
  const reads = seeds.map(readMatch);

  it('keeps players involved instead of standing around', () => {
    for (const r of reads) {
      // Ball-side players are actively adjusting, not frozen spectators.
      expect(r.ballSideStall, `seed ${r.seed} ball-side stall`).toBeLessThan(0.25);
      // Nobody in the passage of play is statuesque for a whole second and a
      // half. `longestFrozen` is scoped to players near the ball — see the
      // note in `readMatch` for why a striker holding an out-ball is not a bug.
      expect(r.longestFrozen, `seed ${r.seed} longest frozen run`).toBeLessThan(1.5);
      // And nobody anywhere on the pitch stands still for four seconds, which
      // no role justifies.
      expect(r.longestFrozenAnywhere, `seed ${r.seed} longest frozen run anywhere`).toBeLessThan(4);
    }
  });

  it('never leaves a loose ball sitting untouched', () => {
    for (const r of reads) {
      // A ball at rest with nobody claiming it for seconds on end is the exact
      // failure that made the game look broken.
      expect(r.longestUnclaimed, `seed ${r.seed} longest unclaimed ball`).toBeLessThan(2.5);
    }
  });

  it('moves the ball up the pitch rather than passing to and fro', () => {
    for (const r of reads) {
      expect(r.finalThirdEntries, `seed ${r.seed} final-third entries`).toBeGreaterThanOrEqual(8);
      expect(r.passes, `seed ${r.seed} passes`).toBeGreaterThanOrEqual(40);
    }
  });

  it('produces shots and goals without the ball constantly going out', () => {
    for (const r of reads) {
      expect(r.shots, `seed ${r.seed} shots`).toBeGreaterThanOrEqual(6);
      // Throw-ins should be occasional restarts, not the main event.
      expect(r.throwins, `seed ${r.seed} throw-ins`).toBeLessThan(14);
    }
    const goals = reads.reduce((a, r) => a + r.goals, 0);
    const matches = reads.length;
    // An arcade five-a-side match should be lively but never a cricket score.
    expect(goals / matches).toBeGreaterThan(0.8);
    expect(goals / matches).toBeLessThan(8);
  });
});

describe('tactics are the human\'s alone', () => {
  it('changes only the human team when ATTACK is pressed', () => {
    const w = createWorld(makeConfig(101));
    queue(w, { type: 'mentality', team: 0, value: 'attack' });
    step(w, TICK);

    expect(w.teams[0].mentality).toBe('attack');
    // The CPU must never simply copy the button the human pressed.
    expect(w.teams[1].mentality).not.toBe('attack');

    // And the human's instruction sticks — the CPU brain must not overwrite it.
    for (let i = 0; i < 60 * 30; i++) step(w, TICK);
    expect(w.teams[0].mentality).toBe('attack');
  });

  it('lets the CPU pick its own approach, and change it as the game turns', () => {
    const w = createWorld(makeConfig(202));
    const seen = new Set<string>();
    for (let i = 0; i < 60 * 200; i++) {
      if (w.phase === 'halftime') queue(w, { type: 'resume' });
      step(w, TICK);
      drainEvents(w);
      seen.add(w.teams[1].mentality);
    }
    // Not stuck on one setting for a whole match: it reads the game.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('gives the CPU no artificial stat boost when it changes approach', () => {
    const w = createWorld(makeConfig(303));
    const before = w.players.map((p) => ({ id: p.id, ...p.attrs }));

    queue(w, { type: 'mentality', team: 0, value: 'attack' });
    for (let i = 0; i < 60 * 60; i++) {
      if (w.phase === 'halftime') queue(w, { type: 'resume' });
      step(w, TICK);
      drainEvents(w);
    }

    for (const p of w.players) {
      const b = before.find((x) => x.id === p.id)!;
      expect(p.attrs).toEqual({
        pace: b.pace,
        strength: b.strength,
        shooting: b.shooting,
        passing: b.passing,
        tackling: b.tackling,
        technique: b.technique,
      });
    }
  });
});
