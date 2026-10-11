import { describe, expect, it } from 'vitest';
import {
  autoOpponent,
  createWorld,
  queue,
  resetPositions,
  step,
  TICK,
  type MatchConfig,
  type Mentality,
} from '../../src/sim';

/**
 * The arrangement must follow the approach, not just slide a few metres: a
 * Defend side lines up as a deep, narrow block, an Attack side pushes up and
 * spreads out, and Counter sits in between with an outlet. These assert the
 * *shape* (average depth and width), not exact coordinates, so the tuning can
 * move without the tests becoming a straitjacket.
 */

const HOME = ['frost', 'moss', 'volt', 'cobalt', 'crimson'];
function cfg(seed: number): MatchConfig {
  return {
    seed,
    homeIds: HOME,
    awayIds: autoOpponent(HOME, seed).ids,
    awayClubId: 'neon_rangers',
    weather: 'sun',
    halfSeconds: 120,
  };
}

/** Lay out team 0 at a kickoff under `m` and read the outfield arrangement. */
function kickoffShape(m: Mentality, seed = 7): { avgX: number; width: number } {
  const w = createWorld(cfg(seed));
  queue(w, { type: 'mentality', team: 0, value: m });
  step(w, TICK); // apply the command
  resetPositions(w, 'kickoff'); // re-lay the shape under the new mentality
  const outfield = w.players.filter((p) => p.team === 0 && !p.isGK);
  const avgX = outfield.reduce((a, p) => a + p.pos.x, 0) / outfield.length;
  const width = outfield.reduce((a, p) => a + Math.abs(p.pos.y), 0) / outfield.length;
  return { avgX, width };
}

describe('the arrangement follows the mentality', () => {
  it('pushes up and stretches out when attacking, sits deep when defending', () => {
    const atk = kickoffShape('attack');
    const bal = kickoffShape('balanced');
    const def = kickoffShape('defend');

    // Attack sits noticeably higher up the pitch than Defend...
    expect(atk.avgX).toBeGreaterThan(def.avgX + 2);
    expect(atk.avgX).toBeGreaterThan(bal.avgX);
    // ...and Defend sits deeper than the neutral shape.
    expect(def.avgX).toBeLessThan(bal.avgX);
    // Attack is wider than a narrow defensive block.
    expect(atk.width).toBeGreaterThan(def.width);
  });

  it('keeps Counter compact, but with an outlet — between Defend and Balanced', () => {
    const bal = kickoffShape('balanced');
    const ctr = kickoffShape('counter');
    const def = kickoffShape('defend');

    expect(ctr.avgX).toBeGreaterThan(def.avgX); // higher than a full block
    expect(ctr.avgX).toBeLessThan(bal.avgX); // still sitting in
    expect(ctr.width).toBeLessThan(bal.width); // narrow and compact
  });

  it('never lines anyone up across the halfway line at a kickoff', () => {
    for (const m of ['attack', 'balanced', 'defend', 'counter'] as Mentality[]) {
      const w = createWorld(cfg(3));
      queue(w, { type: 'mentality', team: 0, value: m });
      step(w, TICK);
      resetPositions(w, 'kickoff');
      for (const p of w.players.filter((x) => x.team === 0)) {
        expect(p.pos.x, `${m} ${p.role}`).toBeLessThanOrEqual(-0.5);
      }
    }
  });
});
