import { describe, expect, it } from 'vitest';
import {
  animateRig,
  applyCelebration,
  CELEBRATION_END,
  celebrationWeight,
  createCharacter,
  type CharacterRig,
} from '../../src/render/characters';
import {
  autoOpponent,
  createWorld,
  drainEvents,
  GOAL_PAUSE,
  PITCH_HALF_L,
  ROSTER,
  step,
  TICK,
  v2,
  type MatchConfig,
} from '../../src/sim';

const HOME = ['frost', 'moss', 'volt', 'cobalt', 'crimson'];

function makeConfig(seed: number): MatchConfig {
  return {
    seed,
    homeIds: HOME,
    awayIds: autoOpponent(HOME, seed).ids,
    awayClubId: 'neon_rangers',
    weather: 'sun',
    halfSeconds: 90,
  };
}

/** A fresh rig, posed by locomotion only, exactly as `sync` leaves it. */
function idleRig(phase = 0, speedNorm = 0): CharacterRig {
  const r = createCharacter(ROSTER[0].design, 0xdff902, 0xffffff);
  animateRig(r, phase, speedNorm);
  return r;
}

const pose = (r: CharacterRig) =>
  [r.armL.rotation.x, r.armL.rotation.z, r.armR.rotation.x, r.armR.rotation.z]
    .map((v) => v.toFixed(4))
    .join(',');

describe('the celebration curve', () => {
  it('is off before the goal and once the celebration is over', () => {
    expect(celebrationWeight(-1)).toBe(0);
    expect(celebrationWeight(0)).toBe(0);
    expect(celebrationWeight(CELEBRATION_END)).toBeLessThan(0.001);
    expect(celebrationWeight(CELEBRATION_END + 5)).toBe(0);
  });

  it('reaches full and holds there', () => {
    expect(celebrationWeight(0.3)).toBe(1);
    expect(celebrationWeight(1.0)).toBe(1);
  });

  it('rises then fades, and never leaves the 0..1 band', () => {
    let prev = -1;
    for (let t = 0; t <= 0.3; t += 0.01) {
      const k = celebrationWeight(t);
      expect(k).toBeGreaterThanOrEqual(prev);
      prev = k;
    }
    prev = 1.1;
    for (let t = 1.0; t <= CELEBRATION_END; t += 0.01) {
      const k = celebrationWeight(t);
      expect(k).toBeLessThanOrEqual(prev);
      prev = k;
    }
    for (let t = -0.5; t <= CELEBRATION_END + 0.5; t += 0.05) {
      const k = celebrationWeight(t);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThanOrEqual(1);
    }
  });

  it('is short — it fits inside the goal pause with room to spare', () => {
    expect(CELEBRATION_END).toBeLessThan(GOAL_PAUSE);
    // "A very short one": it must not eat the whole replay.
    expect(CELEBRATION_END).toBeLessThanOrEqual(GOAL_PAUSE * 0.7);
  });
});

describe('the celebration pose', () => {
  it('is a no-op at zero weight, so locomotion is untouched', () => {
    const a = idleRig(1.3, 0.8);
    const b = idleRig(1.3, 0.8);
    applyCelebration(b, 0.5, 0, 0);
    expect(pose(b)).toBe(pose(a));
    expect(b.group.position.y).toBe(a.group.position.y);
    expect(b.group.rotation.y).toBe(a.group.rotation.y);
  });

  it('throws both arms overhead at full weight', () => {
    const r = idleRig();
    r.group.position.y = 0;
    applyCelebration(r, 0.4, 0, 1); // variant 0
    // The arm hangs down at rest, so ~pi means straight up.
    expect(r.armL.rotation.x).toBeGreaterThan(2.4);
    expect(r.armR.rotation.x).toBeGreaterThan(2.4);
  });

  it('lifts the player off the ground but never sinks them', () => {
    const r = idleRig();
    let maxHop = 0;
    for (let t = 0; t < CELEBRATION_END; t += 0.02) {
      animateRig(r, 0, 0);
      r.group.position.y = 0; // what `sync` does every frame
      applyCelebration(r, t, 0, celebrationWeight(t));
      expect(r.group.position.y).toBeGreaterThanOrEqual(0);
      maxHop = Math.max(maxHop, r.group.position.y);
    }
    expect(maxHop).toBeGreaterThan(0.1);
  });

  it('gives a squad three different moves, deterministically', () => {
    const seeds = [0, 1, 2].map((seed) => {
      const r = idleRig();
      applyCelebration(r, 0.6, seed, 1);
      return pose(r);
    });
    expect(new Set(seeds).size).toBe(3);

    const replay = (() => {
      const r = idleRig();
      applyCelebration(r, 0.6, 0, 1);
      return pose(r);
    })();
    expect(replay).toBe(seeds[0]);
  });

  it('spins the whole body for the second variant', () => {
    const r = idleRig();
    r.group.rotation.y = 0.5; // what `sync` sets from p.facing
    applyCelebration(r, 0.5, 1, 1);
    expect(r.group.rotation.y).toBeGreaterThan(0.5);
    expect(Math.abs(r.armL.rotation.z)).toBeGreaterThan(1);
  });

  it('cannot leave a rig stuck in a goal pose', () => {
    const r = idleRig();
    applyCelebration(r, 0.6, 1, 1); // variant 1 splays the arms wide
    expect(Math.abs(r.armL.rotation.z)).toBeGreaterThan(1);
    animateRig(r, 0, 0); // back to locomotion
    expect(r.armL.rotation.z).toBe(0);
    expect(r.armR.rotation.z).toBe(0);
    expect(r.head.rotation.x).toBe(0);
  });
});

describe('a real goal drives the celebration', () => {
  it('sets the phase, the scoring side, and a fresh goal clock', () => {
    const w = createWorld(makeConfig(11));
    // Team 0 attacks +x, so roll the ball over their target goal line. Aim near
    // the post so the keeper cannot smother it inside a single tick.
    w.phase = 'play';
    w.ball.owner = null;
    w.ball.pos = v2(PITCH_HALF_L - 0.2, 1.5);
    w.ball.vel = v2(25, 0);

    let scored = false;
    for (let i = 0; i < 90 && !scored; i++) {
      step(w, TICK);
      scored = drainEvents(w).some((e) => e.type === 'goal');
    }

    expect(scored).toBe(true);
    expect(w.phase).toBe('goal');
    expect(w.lastGoalTeam).toBe(0);

    // The renderer's clock is `GOAL_PAUSE - phaseTimer`. On the goal tick it is
    // still exactly 0, so the celebration blends in from the locomotion pose
    // rather than snapping — and it is nowhere near its end.
    expect(GOAL_PAUSE - w.phaseTimer).toBe(0);
    expect(celebrationWeight(0)).toBe(0);

    // A fifth of a second later it is at full strength.
    for (let i = 0; i < 12; i++) step(w, TICK);
    expect(w.phase).toBe('goal');
    expect(celebrationWeight(GOAL_PAUSE - w.phaseTimer)).toBe(1);
  });

  it('only celebrates the side that scored', () => {
    const w = createWorld(makeConfig(11));
    w.phase = 'play';
    w.ball.owner = null;
    w.ball.pos = v2(PITCH_HALF_L - 0.2, 1.5);
    w.ball.vel = v2(25, 0);
    for (let i = 0; i < 90 && w.phase !== 'goal'; i++) {
      step(w, TICK);
      drainEvents(w);
    }
    expect(w.phase).toBe('goal');
    // Mirror the renderer's rule: only `lastGoalTeam` celebrates.
    const celebrating = w.players.filter((p) => p.team === w.lastGoalTeam);
    expect(celebrating).toHaveLength(5);
    expect(w.players.filter((p) => p.team !== w.lastGoalTeam)).toHaveLength(5);
  });
});
