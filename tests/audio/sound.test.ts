// tests/audio/sound.test.ts — the parts of the sound engine that are pure.
//
// There is no AudioContext here, and there should not be: everything asserted
// below is either a table of numbers or a state machine. The cues themselves are
// verified by ear in the browser (tools/cdp/flow-club.mjs checks that the
// context unlocks); what is worth a test is that the *patterns* are right and
// that a browser without Web Audio degrades to silence instead of throwing.

import { describe, expect, it } from 'vitest';
import {
  createSoundEngine,
  CrowdHeat,
  WHISTLE_SCHEDULE,
  whistleDuration,
  type WhistleBlast,
} from '../../src/audio/sound';
import type { WhistleKind } from '../../src/sim/types';

/**
 * Every kind the sim can emit, written out by hand on purpose.
 *
 * `WhistleKind` is a type, so it has no runtime members to iterate. Listing them
 * here pins the union to the schedule: add a kind to sim/types.ts without adding
 * a blast pattern and this test fails, instead of the game blowing a silent
 * whistle — which is exactly how the original `whistle` event sat unused in the
 * event union for weeks.
 */
const KINDS: WhistleKind[] = ['kickoff', 'goal', 'foul', 'halftime', 'fulltime'];

describe('whistle patterns', () => {
  it('has a pattern for every kind the sim can emit', () => {
    expect(Object.keys(WHISTLE_SCHEDULE).sort()).toEqual([...KINDS].sort());
  });

  it('never has a blast with a negative start or duration', () => {
    for (const kind of KINDS) {
      for (const b of WHISTLE_SCHEDULE[kind]) {
        expect(b.at, `${kind} blast start`).toBeGreaterThanOrEqual(0);
        expect(b.dur, `${kind} blast duration`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps every blast in the range a pea whistle actually sits in', () => {
    // A referee's whistle is a shrill instrument: roughly 2–2.6 kHz. Anything
    // outside that band stops reading as a whistle and starts reading as a beep.
    for (const kind of KINDS) {
      for (const b of WHISTLE_SCHEDULE[kind]) {
        expect(b.hz, `${kind}`).toBeGreaterThanOrEqual(1800);
        expect(b.hz, `${kind}`).toBeLessThanOrEqual(2600);
      }
    }
  });

  it('never overlaps two blasts of the same cue', () => {
    for (const kind of KINDS) {
      const blasts = WHISTLE_SCHEDULE[kind];
      for (let i = 1; i < blasts.length; i++) {
        const prev = blasts[i - 1];
        expect(blasts[i].at, `${kind} blast ${i} starts before ${i - 1} ends`).toBeGreaterThanOrEqual(
          prev.at + prev.dur,
        );
      }
    }
  });

  it('signals the shapes a referee signals', () => {
    // Play on and a goal are single blasts; a foul and half time are two.
    expect(WHISTLE_SCHEDULE.kickoff).toHaveLength(1);
    expect(WHISTLE_SCHEDULE.goal).toHaveLength(1);
    expect(WHISTLE_SCHEDULE.foul).toHaveLength(2);
    expect(WHISTLE_SCHEDULE.halftime).toHaveLength(2);
    expect(WHISTLE_SCHEDULE.fulltime).toHaveLength(1);
  });

  it('makes full time the longest cue by a clear margin', () => {
    // The one thing a player must never mistake for anything else is the end of
    // the match, so the full-time blast has to outlast every other cue.
    const others = KINDS.filter((k) => k !== 'fulltime').map(whistleDuration);
    const longestOther = Math.max(...others);
    expect(whistleDuration('fulltime')).toBeGreaterThan(longestOther * 1.5);
  });

  it('reports the duration as the end of the last blast', () => {
    for (const kind of KINDS) {
      const blasts: WhistleBlast[] = WHISTLE_SCHEDULE[kind];
      const last = blasts.reduce((a, b) => (b.at + b.dur > a.at + a.dur ? b : a));
      expect(whistleDuration(kind)).toBeCloseTo(last.at + last.dur, 6);
    }
  });
});

describe('crowd heat', () => {
  const { AMBIENT, ADVANCE_WEIGHT, DECAY } = CrowdHeat;

  it('sits at the ambient floor with the ball on the halfway line', () => {
    expect(new CrowdHeat().step(0, 0)).toBeCloseTo(AMBIENT, 6);
  });

  it('rises as the ball travels toward a goal', () => {
    const crowd = new CrowdHeat();
    const halfway = crowd.step(0, 0);
    const edgeOfBox = crowd.step(0, 0.7);
    const onTheLine = crowd.step(0, 1);
    expect(edgeOfBox).toBeGreaterThan(halfway);
    expect(onTheLine).toBeGreaterThan(edgeOfBox);
    // A ball on the goal line, with nothing else happening, is a murmur — never
    // a full roar. That is what `excite` is for.
    expect(onTheLine).toBeLessThan(0.8);
  });

  it('weights the ball below the events', () => {
    // The whole point of the split: the ball's position must never be able to
    // reach the level a goal does. If ADVANCE_WEIGHT ever got close to 1 the
    // crowd would roar continuously and the goals would land on a ground that
    // was already at full volume.
    expect(ADVANCE_WEIGHT).toBeLessThan(1);
    const ballOnTheLine = new CrowdHeat().step(0, 1);
    const goal = new CrowdHeat();
    goal.excite(1);
    expect(goal.step(0, 0)).toBeGreaterThan(ballOnTheLine);

    // And a shot lifts the crowd above the same ball position without one.
    const idle = new CrowdHeat().step(0, 0.8);
    const afterAShot = new CrowdHeat();
    afterAShot.excite(0.4);
    expect(afterAShot.step(0, 0.8)).toBeGreaterThan(idle);
  });

  it('adds an excite on top of the ball position', () => {
    const crowd = new CrowdHeat();
    crowd.excite(0.5);
    expect(crowd.step(0, 0.5)).toBeCloseTo(AMBIENT + 0.5 * ADVANCE_WEIGHT + 0.5, 6);
  });

  it('decays back toward ambient once the moment passes', () => {
    const crowd = new CrowdHeat();
    // 0.5, not 1: a full jolt clamps the level at 1 and the clamp would hide the
    // very decay this test is measuring.
    crowd.excite(0.5);
    const peak = crowd.step(0, 0);
    const aMomentLater = crowd.step(0.5, 0);
    const aWhileLater = crowd.step(1.5, 0);
    expect(aMomentLater).toBeLessThan(peak);
    expect(aWhileLater).toBeLessThan(aMomentLater);
    // DECAY is per second, so half a second of quiet removes exactly half of it.
    expect(peak - aMomentLater).toBeCloseTo(0.5 * DECAY, 6);
  });

  it('settles back to exactly the ambient floor', () => {
    const crowd = new CrowdHeat();
    crowd.excite(1);
    // Long enough that any heat left would mean it never clears.
    expect(crowd.step(10, 0)).toBeCloseTo(AMBIENT, 6);
    expect(crowd.current).toBe(0);
  });

  it('never leaves 0..1, however hard it is pushed', () => {
    const crowd = new CrowdHeat();
    for (let i = 0; i < 20; i++) crowd.excite(1);
    expect(crowd.step(0, 1)).toBeLessThanOrEqual(1);
    crowd.step(100, 0);
    expect(crowd.step(0, 0)).toBeGreaterThanOrEqual(0);
  });

  it('treats a nonsense input as quiet rather than as NaN', () => {
    // The level is fed straight into an AudioParam; a NaN reaching one of those
    // silences the whole graph, not just the frame.
    const crowd = new CrowdHeat();
    expect(crowd.step(0.1, Number.NaN)).toBe(AMBIENT);
    crowd.excite(Number.NaN);
    expect(Number.isFinite(crowd.step(0.1, 0))).toBe(true);
  });

  it('forgets everything on reset, so a new match starts quiet', () => {
    const crowd = new CrowdHeat();
    crowd.excite(1);
    crowd.reset();
    expect(crowd.current).toBe(0);
    expect(crowd.step(0, 0)).toBeCloseTo(AMBIENT, 6);
  });
});

describe('engine without Web Audio', () => {
  // Node has no AudioContext. This is not a hypothetical: it is also what an old
  // browser looks like, and the game has to keep playing with the sound off.
  it('builds without throwing', () => {
    expect(() => createSoundEngine()).not.toThrow();
  });

  it('reports that it is not ready', () => {
    expect(createSoundEngine().ready).toBe(false);
  });

  it('makes every cue a safe no-op', () => {
    const sound = createSoundEngine();
    expect(() => {
      sound.unlock();
      for (const kind of KINDS) sound.whistle(kind);
      sound.goal();
      sound.kick();
      sound.save();
      sound.crowd(0);
      sound.crowd(1);
      sound.crowd(Number.NaN);
      sound.setMuted(true);
      sound.setMuted(false);
      sound.dispose();
    }).not.toThrow();
    expect(sound.ready).toBe(false);
  });

  it('survives a cue after being disposed', () => {
    // dispose() is called from Game.dispose(), which a hot reload can reach
    // while a cue is still in flight.
    const sound = createSoundEngine();
    sound.dispose();
    expect(() => {
      sound.whistle('goal');
      sound.crowd(0.5);
    }).not.toThrow();
  });
});
