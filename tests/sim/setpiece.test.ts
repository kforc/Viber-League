import { describe, expect, it } from 'vitest';
import {
  awardFoul,
  awardFromOutOfPlay,
  autoOpponent,
  createWorld,
  drainEvents,
  inOwnPenaltyArea,
  PENALTY_SPOT,
  PITCH_HALF_L,
  PITCH_HALF_W,
  queue,
  step,
  TICK,
  v2,
  type MatchConfig,
  type SimEvent,
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

describe('set pieces', () => {
  it('gives a corner when the defending side puts it behind', () => {
    const w = createWorld(makeConfig(7));
    // Team 1 defends +x (team 0 attacks it). Last touch by a defender, ball out
    // over the +x goal line away from the goal mouth.
    const def = w.players.find((p) => p.team === 1 && p.role === 'DEF')!;
    w.ball.lastTouch = def.id;
    w.ball.pos = v2(PITCH_HALF_L, 5);
    w.phase = 'play';

    awardFromOutOfPlay(w, { axis: 'x', side: 1 });

    expect(w.phase).toBe('corner');
    expect(w.setPiece?.kind).toBe('corner');
    expect(w.setPiece?.team).toBe(0);
    expect(w.stats.corners[0]).toBe(1);
    // The ball sits on the corner flag, on the side it went out.
    expect(Math.abs(w.ball.pos.x)).toBeCloseTo(PITCH_HALF_L - 0.4, 3);
    expect(Math.abs(w.ball.pos.y)).toBeCloseTo(PITCH_HALF_W - 0.4, 3);
  });

  it('gives a goal kick when the attacking side puts it behind', () => {
    const w = createWorld(makeConfig(7));
    const att = w.players.find((p) => p.team === 0)!;
    w.ball.lastTouch = att.id;
    w.ball.pos = v2(PITCH_HALF_L, 5);
    w.phase = 'play';

    awardFromOutOfPlay(w, { axis: 'x', side: 1 });

    expect(w.phase).toBe('goalkick');
    expect(w.setPiece?.team).toBe(1);
    // The keeper takes it from the edge of the six-yard box.
    expect(w.setPiece?.pos.x).toBeCloseTo(PITCH_HALF_L - 5.5, 3);
    const taker = w.players.find((p) => p.id === w.setPiece?.taker);
    expect(taker?.isGK).toBe(true);
  });

  it('gives a throw-in to the side that did not put it out', () => {
    const w = createWorld(makeConfig(7));
    const att = w.players.find((p) => p.team === 0)!;
    w.ball.lastTouch = att.id;
    w.ball.pos = v2(4, PITCH_HALF_W);
    w.phase = 'play';

    awardFromOutOfPlay(w, { axis: 'y', side: 1 });

    expect(w.phase).toBe('throwin');
    expect(w.setPiece?.team).toBe(1);
    expect(w.setPiece?.side).toBe(1);
    expect(Math.abs(w.ball.pos.y)).toBeCloseTo(PITCH_HALF_W - 0.35, 3);
  });

  it('awards a penalty for a foul inside the offender own box', () => {
    const w = createWorld(makeConfig(7));
    const def = w.players.find((p) => p.team === 1 && p.role === 'DEF')!;
    // Team 1 defends +x.
    def.pos = v2(PITCH_HALF_L - 2, 1);
    expect(inOwnPenaltyArea(def)).toBe(true);

    awardFoul(w, def, true);

    expect(w.phase).toBe('penalty');
    expect(w.setPiece?.kind).toBe('penalty');
    expect(w.setPiece?.team).toBe(0);
    // Spotted PENALTY_SPOT from the goal line, dead centre.
    expect(w.setPiece?.pos.x).toBeCloseTo(PITCH_HALF_L - PENALTY_SPOT, 3);
    expect(w.setPiece?.pos.y).toBe(0);
    // The best finisher takes it.
    const taker = w.players.find((p) => p.id === w.setPiece?.taker)!;
    expect(taker.team).toBe(0);
    expect(taker.isGK).toBe(false);
    expect(w.stats.fouls[1]).toBe(1);
  });

  it('lets the human shooter pick where the penalty goes', () => {
    // Award the human (team 0) a penalty, queue a `shot` command for each lane,
    // then resolve. The chosen lane must set the sign of the launch, so a right
    // aim must launch further right than a left aim regardless of accuracy spread.
    const launchVy = (aim: 'left' | 'centre' | 'right'): number => {
      const w = createWorld(makeConfig(3));
      const def = w.players.find((p) => p.team === 1 && p.role === 'DEF')!;
      awardFoul(w, def, true); // penalty to team 0
      queue(w, { type: 'shot', team: 0, value: aim });
      for (let i = 0; i < 200; i++) {
        step(w, TICK);
        if (w.phase === 'penaltyshot' && w.penaltyShot) return w.ball.vel.y;
      }
      throw new Error('penalty never struck');
    };

    const vyRight = launchVy('right');
    const vyLeft = launchVy('left');
    // The +Z camera mirrors world +Y onto screen-left, so the "right" placement
    // must launch to world -Y (negative vy) and "left" to world +Y (positive).
    expect(vyRight).toBeLessThan(0);
    expect(vyLeft).toBeGreaterThan(0);
    expect(vyRight).toBeLessThan(vyLeft);
  });

  it('ignores a penalty-aim command from the non-human team', () => {
    const w = createWorld(makeConfig(3));
    const def = w.players.find((p) => p.team === 1 && p.role === 'DEF')!;
    awardFoul(w, def, true);
    queue(w, { type: 'shot', team: 1, value: 'right' });
    step(w, TICK);
    expect(w.penaltyAim).toBeNull();
  });

  it('blows the whistle before it says who fouled', () => {
    // The referee stops play first and reports second. The audio layer plays the
    // whistle off the FIRST event, so if the order ever flips the blast arrives
    // after the restart has already been announced on screen.
    const w = createWorld(makeConfig(7));
    const def = w.players.find((p) => p.team === 1 && p.role === 'DEF')!;
    awardFoul(w, def, false);

    expect(w.events[0]).toEqual({ type: 'whistle', kind: 'foul' });
    expect(w.events[1]?.type).toBe('foul');
    // A free kick is not a penalty, and no whistle is blown twice for it.
    expect(w.events.filter((e) => e.type === 'whistle')).toHaveLength(1);
  });

  it('strikes a moving penalty ball before resolving a save, goal or miss', () => {
    const w = createWorld(makeConfig(7));
    const def = w.players.find((p) => p.team === 1 && p.role === 'DEF')!;
    def.pos = v2(PITCH_HALF_L - 2, 1);
    awardFoul(w, def, true);

    let guard = 0;
    while (w.setPiece && guard++ < 60 * 6) step(w, TICK);

    expect(w.setPiece).toBeNull();
    expect(w.phase).toBe('penaltyshot');
    expect(w.penaltyShot?.team).toBe(0);
    expect(Math.abs(w.ball.vel.x)).toBeGreaterThan(15);
    expect(w.stats.penalties[0]).toBe(1);
    expect(w.stats.shots[0]).toBe(1);

    while (w.penaltyShot && guard++ < 60 * 10) step(w, TICK);
    expect(w.penaltyShot).toBeNull();
    expect(['play', 'goal', 'goalkick', 'corner']).toContain(w.phase);
  });

  it('lets the human keeper catch a correctly read CPU penalty', () => {
    // Two worlds, identical seed and shooter, differing ONLY in the human's
    // queued dive. A catch must be an actual consequence of that choice, not a
    // predetermined random save, and the seed must replay exactly.
    const make = (seed: number, dive: 'left' | 'centre' | 'right') => {
      const w = createWorld(makeConfig(seed));
      const def = w.players.find((p) => p.team === 0 && p.role === 'DEF')!;
      awardFoul(w, def, true);
      // The match UI freezes here. No ticks (or commands) pass until the tap.
      w.paused = true;
      queue(w, { type: 'dive', team: 0, value: dive });
      const frozen = w.tick;
      step(w, TICK);
      expect(w.tick).toBe(frozen);
      expect(w.pending).toHaveLength(1);
      w.paused = false;
      const events: SimEvent[] = [];
      for (let i = 0; i < 60 * 6; i++) {
        step(w, TICK);
        events.push(...drainEvents(w));
        if (!w.setPiece && !w.penaltyShot) break;
      }
      return { w, events };
    };

    let seed = 0;
    let saved: ReturnType<typeof make> | null = null;
    let beaten: ReturnType<typeof make> | null = null;
    for (let s = 1; s <= 48; s++) {
      const left = make(s, 'left');
      const right = make(s, 'right');
      if (left.events.some((e) => e.type === 'save' && e.team === 0) &&
          right.events.some((e) => e.type === 'goal' && e.team === 1)) {
        seed = s; saved = left; beaten = right; break;
      }
    }
    expect(seed).toBeGreaterThan(0);
    expect(saved?.w.ball.owner).toBe(saved?.w.players.find((p) => p.team === 0 && p.isGK)?.id);
    expect(saved?.w.teams[1].score).toBe(0);
    expect(beaten?.w.teams[1].score).toBe(1);
    const replay = make(seed, 'left');
    expect(replay.w.ball.owner).toBe(saved?.w.ball.owner);
    expect(replay.events).toEqual(saved?.events);
  });

  it('ignores late and attacking-side dive commands', () => {
    const w = createWorld(makeConfig(13));
    const def = w.players.find((p) => p.team === 0 && p.role === 'DEF')!;
    awardFoul(w, def, true);
    queue(w, { type: 'dive', team: 1, value: 'left' });
    step(w, TICK);
    expect(w.penaltyDive).toBeNull();
    queue(w, { type: 'dive', team: 0, value: 'right' });
    step(w, TICK);
    expect(w.penaltyDive).toBe('right');
    for (let i = 0; i < 60 * 3 && w.setPiece; i++) step(w, TICK);
    expect(w.penaltyShot?.dive).toBe('right');
    queue(w, { type: 'dive', team: 0, value: 'left' });
    step(w, TICK);
    expect(w.penaltyDive).toBeNull();
    expect(w.penaltyShot?.dive).toBe('right');
  });

  it('takes a corner into the box and hands play back to the AI', () => {
    const w = createWorld(makeConfig(7));
    const def = w.players.find((p) => p.team === 1 && p.role === 'DEF')!;
    w.ball.lastTouch = def.id;
    w.ball.pos = v2(PITCH_HALF_L, 5);
    w.phase = 'play';
    awardFromOutOfPlay(w, { axis: 'x', side: 1 });

    let guard = 0;
    while (w.setPiece && guard++ < 60 * 6) step(w, TICK);

    expect(w.setPiece).toBeNull();
    expect(w.phase).toBe('play');
    // The cross left the corner: give it a moment, then the ball has moved
    // infield rather than sitting on the flag.
    for (let i = 0; i < 30; i++) step(w, TICK);
    expect(Math.abs(w.ball.pos.y)).toBeLessThan(PITCH_HALF_W - 1);
  });

  it('a restart left pending when the clock runs out does not resurrect the match', () => {
    const w = createWorld(makeConfig(3));
    w.half = 2;
    w.clock = w.halfSeconds * 2 - 0.01;
    w.phase = 'play';
    // Force a corner with the clock about to expire.
    const def = w.players.find((p) => p.team === 1 && p.role === 'DEF')!;
    w.ball.lastTouch = def.id;
    w.ball.pos = v2(PITCH_HALF_L, 5);
    awardFromOutOfPlay(w, { axis: 'x', side: 1 });

    for (let i = 0; i < 60 * 5; i++) step(w, TICK);

    expect(w.phase).toBe('fulltime');
  });
});

describe('plays like real football', () => {
  it('produces corners, throw-ins, goal kicks, free kicks and goals across a season', () => {
    let corners = 0;
    let fouls = 0;
    let goals = 0;
    let throwins = 0;
    let goalkicks = 0;
    let freekicks = 0;
    let shots = 0;

    for (const seed of [11, 22, 33, 44, 55, 66]) {
      const w = createWorld(makeConfig(seed));
      const events: SimEvent[] = [];
      for (let i = 0; i < 60 * 260; i++) {
        if (w.phase === 'halftime') queue(w, { type: 'resume' });
        step(w, TICK);
        events.push(...drainEvents(w));
        // The ball must never be left lying outside the field of play.
        expect(Math.abs(w.ball.pos.x)).toBeLessThanOrEqual(PITCH_HALF_L + 0.6);
        expect(Math.abs(w.ball.pos.y)).toBeLessThanOrEqual(PITCH_HALF_W + 0.6);
      }
      corners += w.stats.corners[0] + w.stats.corners[1];
      fouls += w.stats.fouls[0] + w.stats.fouls[1];
      shots += w.stats.shots[0] + w.stats.shots[1];
      for (const e of events) {
        if (e.type === 'goal') goals++;
        else if (e.type === 'setpiece') {
          if (e.kind === 'throwin') throwins++;
          else if (e.kind === 'goalkick') goalkicks++;
          else if (e.kind === 'freekick') freekicks++;
        }
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `6 matches: goals=${goals} shots=${shots} corners=${corners} fouls=${fouls} ` +
        `throwins=${throwins} goalkicks=${goalkicks} freekicks=${freekicks}`,
    );

    expect(goals).toBeGreaterThan(0);
    expect(corners).toBeGreaterThan(0);
    expect(throwins).toBeGreaterThan(0);
    expect(goalkicks).toBeGreaterThan(0);
    expect(freekicks).toBeGreaterThan(0);
    expect(shots).toBeGreaterThan(30);
    // Real football averages roughly 25 shots and 10 corners a match.
    expect(shots / 6).toBeLessThan(45);
    expect(corners / 6).toBeLessThan(18);
  });

  it('is still deterministic with set pieces in play', () => {
    const a = createWorld(makeConfig(99));
    const b = createWorld(makeConfig(99));
    for (let i = 0; i < 60 * 200; i++) {
      if (a.phase === 'halftime') queue(a, { type: 'resume' });
      if (b.phase === 'halftime') queue(b, { type: 'resume' });
      step(a, TICK);
      step(b, TICK);
    }
    expect(a.teams[0].score).toBe(b.teams[0].score);
    expect(a.teams[1].score).toBe(b.teams[1].score);
    expect(a.stats.corners).toEqual(b.stats.corners);
    expect(a.stats.fouls).toEqual(b.stats.fouls);
    expect(a.stats.penalties).toEqual(b.stats.penalties);
  });
});
