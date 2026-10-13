import { describe, expect, it } from 'vitest';
import {
  CARD_CHANCE,
  INJURY_CHANCE_FOUL,
  INJURY_MATCHES,
  PITCH_HALF_W,
  RED_CARD_SHARE,
  SUSPENSION_MATCHES,
  TICK,
  awardFoul,
  awardFromOutOfPlay,
  autoOpponent,
  createWorld,
  drainEvents,
  len,
  makeRng,
  sendOff,
  step,
  v2,
  type MatchConfig,
  type Rng,
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

/**
 * Force the referee's hand.
 *
 * The discipline stream is seeded, so a card cannot simply be requested — but
 * the seed can be searched for. `makeRng(s)` is the same generator the world
 * uses, so a state that opens with the rolls we want will produce exactly those
 * rolls once `setState` puts it there. Searching beats hard-coding a magic
 * number that would silently stop testing anything the day the roll order
 * changed.
 */
function stateOpeningWith(pred: (rng: Rng) => boolean): number {
  for (let s = 1; s < 200_000; s++) {
    if (pred(makeRng(s))) return s;
  }
  throw new Error('no discipline state opens with those rolls');
}

const cardRoll = (want: 'red' | 'yellow') => (r: Rng) =>
  r.chance(CARD_CHANCE) && r.chance(RED_CARD_SHARE) === (want === 'red');

/** No card, then an injury — the exact draw order `rollDiscipline` uses. */
const injuryRoll = (r: Rng) => !r.chance(CARD_CHANCE) && r.chance(INJURY_CHANCE_FOUL);

function cards(events: SimEvent[]): Extract<SimEvent, { type: 'card' }>[] {
  return events.filter((e): e is Extract<SimEvent, { type: 'card' }> => e.type === 'card');
}
function injuries(events: SimEvent[]): Extract<SimEvent, { type: 'injury' }>[] {
  return events.filter((e): e is Extract<SimEvent, { type: 'injury' }> => e.type === 'injury');
}

describe('the referee', () => {
  it('sends a player off for a red card, and bans them for one or two games', () => {
    const w = createWorld(makeConfig(7));
    const offender = w.players.find((p) => p.team === 0 && p.role === 'MID')!;
    w.phase = 'play';
    w.disciplineRng.setState(stateOpeningWith(cardRoll('red')));

    awardFoul(w, offender, false);

    const card = cards(drainEvents(w))[0];
    expect(card).toBeDefined();
    expect(card.card).toBe('red');
    expect(card.off).toBe(true);
    expect(card.player).toBe(offender.id);
    expect(card.matches).toBeGreaterThanOrEqual(SUSPENSION_MATCHES[0]);
    expect(card.matches).toBeLessThanOrEqual(SUSPENSION_MATCHES[1]);

    // Off the pitch: parked beyond the touchline, stopped, and no longer able to
    // be involved. This is the whole point of a red card — the side is a man
    // down for the rest of the match, not just fined a player on paper.
    expect(offender.off).toBe('red');
    expect(Math.abs(offender.pos.y)).toBeGreaterThan(PITCH_HALF_W);
    expect(len(offender.vel)).toBe(0);
  });

  it('books a player without removing them, and without a ban', () => {
    const w = createWorld(makeConfig(7));
    const offender = w.players.find((p) => p.team === 0 && p.role === 'MID')!;
    w.phase = 'play';
    w.disciplineRng.setState(stateOpeningWith(cardRoll('yellow')));

    awardFoul(w, offender, false);

    const card = cards(drainEvents(w))[0];
    expect(card.card).toBe('yellow');
    expect(card.off).toBe(false);
    // A yellow carries no ban in this game — there is no accumulation rule, and
    // inventing one would punish a player for something nothing warned them of.
    expect(card.matches).toBe(0);
    expect(offender.off).toBeUndefined();
    expect(Math.abs(offender.pos.y)).toBeLessThanOrEqual(PITCH_HALF_W);
  });

  it('puts the fouled player out of the match and off for up to three games', () => {
    const w = createWorld(makeConfig(7));
    const offender = w.players.find((p) => p.team === 0 && p.role === 'MID')!;
    const victim = w.players.find((p) => p.team === 1 && p.role === 'FWD')!;
    w.phase = 'play';
    w.disciplineRng.setState(stateOpeningWith(injuryRoll));

    awardFoul(w, offender, false, victim);

    const events = drainEvents(w);
    expect(cards(events)).toHaveLength(0);
    const injury = injuries(events)[0];
    expect(injury).toBeDefined();
    expect(injury.player).toBe(victim.id);
    expect(injury.matches).toBeGreaterThanOrEqual(INJURY_MATCHES[0]);
    expect(injury.matches).toBeLessThanOrEqual(INJURY_MATCHES[1]);

    expect(victim.off).toBe('injury');
    expect(Math.abs(victim.pos.y)).toBeGreaterThan(PITCH_HALF_W);
    // The offender was not carded on this draw, so they stay on.
    expect(offender.off).toBeUndefined();
  });

  it('reports a ban or a layoff inside the configured range, whatever the seed', () => {
    for (let seed = 1; seed <= 24; seed++) {
      const w = createWorld(makeConfig(seed));
      for (let i = 0; i < 120; i++) {
        const offender = w.players.find((p) => p.team === 0 && !p.off && !p.isGK);
        const victim = w.players.find((p) => p.team === 1 && !p.off && !p.isGK);
        if (!offender) break;
        awardFoul(w, offender, false, victim);
        for (const e of drainEvents(w)) {
          if (e.type === 'card' && e.card === 'red') {
            expect(e.matches, `seed ${seed}`).toBeGreaterThanOrEqual(SUSPENSION_MATCHES[0]);
            expect(e.matches, `seed ${seed}`).toBeLessThanOrEqual(SUSPENSION_MATCHES[1]);
          } else if (e.type === 'card') {
            expect(e.matches, `seed ${seed}`).toBe(0);
          } else if (e.type === 'injury') {
            expect(e.matches, `seed ${seed}`).toBeGreaterThanOrEqual(INJURY_MATCHES[0]);
            expect(e.matches, `seed ${seed}`).toBeLessThanOrEqual(INJURY_MATCHES[1]);
          }
        }
      }
    }
  });
});

describe('a player who has left the pitch', () => {
  it('is released from the ball and stops being a candidate to receive it', () => {
    const w = createWorld(makeConfig(11));
    const p = w.players.find((x) => x.team === 0 && !x.isGK)!;
    w.ball.owner = p.id;
    w.ball.looseTimer = 3;

    sendOff(w, p, 'red');

    expect(w.ball.owner).toBeNull();
    expect(w.ball.lastTouch).toBe(p.id);
    expect(p.intentTarget).toBeNull();
  });

  it('stands still while play carries on around them', () => {
    const w = createWorld(makeConfig(23));
    const p = w.players.find((x) => x.team === 0 && !x.isGK)!;
    sendOff(w, p, 'injury');
    const parked = v2(p.pos.x, p.pos.y);

    for (let i = 0; i < 60 * 20; i++) {
      if (w.phase === 'halftime') break;
      step(w, TICK);
    }

    // The guard is in the integrator, so the model never drifts back on: the
    // renderer draws them where the send-off left them.
    expect(p.pos.x).toBeCloseTo(parked.x, 6);
    expect(p.pos.y).toBeCloseTo(parked.y, 6);
    expect(w.ball.owner).not.toBe(p.id);
  });

  it('is not picked to take a set piece', () => {
    const w = createWorld(makeConfig(31));
    const p = w.players.find((x) => x.team === 0 && !x.isGK)!;
    sendOff(w, p, 'red');

    // Put the ball out for a corner to team 0 — the restart they would normally
    // be a candidate for.
    w.ball.lastTouch = w.players.find((x) => x.team === 1)!.id;
    w.ball.pos = v2(20, 5);
    w.phase = 'play';
    awardFromOutOfPlay(w, { axis: 'x', side: 1 });

    expect(w.setPiece?.taker).not.toBe(p.id);
  });

  it('is never given a second send-off', () => {
    const w = createWorld(makeConfig(41));
    const p = w.players.find((x) => x.team === 0 && !x.isGK)!;
    sendOff(w, p, 'red');
    const parked = p.pos.y;

    // A second call must be a no-op rather than moving them further out or
    // overwriting why they went off.
    sendOff(w, p, 'injury');
    expect(p.off).toBe('red');
    expect(p.pos.y).toBe(parked);
  });
});

describe('discipline is seeded, not sampled', () => {
  /** The cards and injuries a fixed sequence of fouls produces, as text. */
  function log(seed: number): string[] {
    const w = createWorld(makeConfig(seed));
    const out: string[] = [];
    for (let i = 0; i < 160; i++) {
      const offender = w.players.find((p) => p.team === 0 && !p.off && !p.isGK);
      const victim = w.players.find((p) => p.team === 1 && !p.off && !p.isGK);
      if (!offender) break;
      awardFoul(w, offender, false, victim);
      for (const e of drainEvents(w)) {
        if (e.type === 'card' || e.type === 'injury') out.push(JSON.stringify(e));
      }
    }
    return out;
  }

  it('replays identically from the same seed', () => {
    expect(log(42)).toEqual(log(42));
  });

  it('gives a different season a different casualty list', () => {
    expect(log(42)).not.toEqual(log(43));
  });

  it('keeps its own stream, so a card cannot shift the match rng', () => {
    /*
     * The guarantee the separate `disciplineRng` exists to provide.
     *
     * Two worlds of the same seed, the same foul on the same player, differing
     * only in whether the referee reached for a card. A booking does not remove
     * anyone from the pitch, so both worlds go on to set up their free kick
     * with the same players available — which means the match rng must end up
     * in the same place. If discipline had been drawn from it, showing a card
     * would have silently changed every later pass and shot.
     */
    const booked = createWorld(makeConfig(55));
    const clean = createWorld(makeConfig(55));
    booked.disciplineRng.setState(stateOpeningWith(cardRoll('yellow')));
    clean.disciplineRng.setState(stateOpeningWith((r) => !r.chance(CARD_CHANCE)));

    awardFoul(booked, booked.players.find((p) => p.team === 0 && !p.isGK)!, false);
    awardFoul(clean, clean.players.find((p) => p.team === 0 && !p.isGK)!, false);

    expect(booked.rng.state()).toBe(clean.rng.state());
    // And the streams really did take different paths, so the test is not
    // passing because nothing happened.
    expect(booked.disciplineRng.state()).not.toBe(clean.disciplineRng.state());
  });
});
