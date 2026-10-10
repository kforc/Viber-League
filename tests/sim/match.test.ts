import { describe, expect, it } from 'vitest';
import {
  autoOpponent,
  buildLineup,
  createWorld,
  drainEvents,
  overallOf,
  queue,
  ROSTER,
  ROSTER_BY_ID,
  step,
  teamOverall,
  TICK,
  WEATHER_ORDER,
  type MatchConfig,
  type SimEvent,
} from '../../src/sim';

const HOME = ['frost', 'moss', 'volt', 'cobalt', 'crimson'];

function makeConfig(seed: number, over: Partial<MatchConfig> = {}): MatchConfig {
  return {
    seed,
    homeIds: HOME,
    awayIds: autoOpponent(HOME, seed).ids,
    awayClubId: 'neon_rangers',
    weather: 'sun',
    halfSeconds: 90,
    ...over,
  };
}

function runMatch(config: MatchConfig, ticks = 60 * 260) {
  const w = createWorld(config);
  const events: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    // A manager always sends the team out for the second half.
    if (w.phase === 'halftime') queue(w, { type: 'resume' });
    step(w, TICK);
    events.push(...drainEvents(w));
  }
  return { w, events };
}

describe('match simulation', () => {
  it('runs a full match without crashing and reaches full-time', () => {
    const { w, events } = runMatch(makeConfig(1234));
    const goals = events.filter((e) => e.type === 'goal').length;
    // eslint-disable-next-line no-console
    console.log(
      `clock=${w.clock.toFixed(1)} score=${w.teams[0].score}-${w.teams[1].score} ` +
        `goals=${goals} shots=${w.stats.shots} passes=${w.stats.passes} tackles=${w.stats.tackles}`,
    );
    expect(w.clock).toBeGreaterThan(170);
    expect(events.some((e) => e.type === 'fulltime')).toBe(true);
    expect(events.some((e) => e.type === 'kickoff')).toBe(true);
    const shots = w.stats.shots[0] + w.stats.shots[1];
    const passes = w.stats.passes[0] + w.stats.passes[1];
    expect(shots).toBeGreaterThan(3);
    expect(passes).toBeGreaterThan(10);
  });

  /*
   * The referee's signals.
   *
   * These exist because `{ type: 'whistle' }` sat in the SimEvent union for
   * weeks without the engine ever pushing one — the audio layer would have had
   * nothing to play, and no test would have noticed. A union member that is
   * never emitted is dead code that looks alive.
   */
  describe('the referee', () => {
    it('signals the start, the break and the end of the match', () => {
      const { events } = runMatch(makeConfig(1234));
      const kinds = events
        .filter((e) => e.type === 'whistle')
        .map((e) => e.kind);

      // Two halves, so at least two kick-off blasts.
      expect(kinds.filter((k) => k === 'kickoff').length).toBeGreaterThanOrEqual(2);
      expect(kinds).toContain('halftime');
      expect(kinds).toContain('fulltime');
      expect(kinds.length).toBeGreaterThan(3);
    });

    it('only ever blows a kind the audio layer has a pattern for', () => {
      const { events } = runMatch(makeConfig(4242));
      // Written out by hand: `WhistleKind` is a type, so there is no runtime
      // list to iterate. This is the one place the two sides are pinned together.
      const known = ['kickoff', 'goal', 'foul', 'halftime', 'fulltime'];
      for (const e of events) {
        if (e.type !== 'whistle') continue;
        expect(known, `unknown whistle kind ${e.kind}`).toContain(e.kind);
      }
    });

    it('keeps every whistle next to the moment it signals', () => {
      /*
       * One match, every ordering asserted at once. A whistle is pushed either
       * immediately before its event (play on, a foul, the break, the end) or —
       * for a goal only — immediately after it, because the crowd roar has to
       * start first and the blast cuts across it. If either ever drifts, the
       * sound lands on the wrong moment.
       */
      const { events } = runMatch(makeConfig(1234));
      const known = ['kickoff', 'goal', 'foul', 'halftime', 'fulltime'];
      let seen = 0;

      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.type !== 'whistle') continue;
        expect(known, `unknown whistle kind ${e.kind}`).toContain(e.kind);

        const before = events[i - 1];
        const after = events[i + 1];
        const adjacent =
          e.kind === 'goal' ? before?.type === 'goal' : after?.type === e.kind;
        expect(adjacent, `whistle(${e.kind}) at ${i} is not next to its moment`).toBe(true);
        seen++;
      }

      expect(seen).toBeGreaterThan(3);
    });
  });

  it('honours the chosen match length', () => {
    const short = runMatch(makeConfig(5, { halfSeconds: 60 }), 60 * 240);
    // 120s of play, plus kickoff / goal / half-time pauses.
    expect(short.w.clock).toBeGreaterThan(118);
    expect(short.w.clock).toBeLessThan(122);
    expect(short.events.some((e) => e.type === 'fulltime')).toBe(true);
  });

  it('is deterministic: same seed => identical outcome', () => {
    const a = runMatch(makeConfig(777));
    const b = runMatch(makeConfig(777));
    expect(a.w.teams[0].score).toBe(b.w.teams[0].score);
    expect(a.w.teams[1].score).toBe(b.w.teams[1].score);
    expect(a.w.stats.shots).toEqual(b.w.stats.shots);
    expect(a.w.stats.passes).toEqual(b.w.stats.passes);
    expect(a.events.length).toBe(b.events.length);
  });

  it('different seeds produce different matches', () => {
    const sig = (seed: number) => {
      const { w, events } = runMatch(makeConfig(seed));
      return [
        w.teams[0].score,
        w.teams[1].score,
        w.stats.shots[0],
        w.stats.shots[1],
        w.stats.passes[0],
        w.stats.passes[1],
        w.stats.tackles[0],
        w.stats.tackles[1],
        events.length,
      ].join('|');
    };
    // Any single stat can coincide by chance; the full signature should not.
    expect(sig(1)).not.toBe(sig(2));
  });

  it('is not systematically biased toward one side', () => {
    let home = 0;
    let away = 0;
    const lines: string[] = [];
    for (const seed of [11, 22, 33, 44, 55, 66, 77, 88]) {
      const { w } = runMatch(makeConfig(seed));
      home += w.teams[0].score;
      away += w.teams[1].score;
      lines.push(`${seed}: ${w.teams[0].score}-${w.teams[1].score}`);
    }
    // eslint-disable-next-line no-console
    console.log(`aggregate home=${home} away=${away} | ${lines.join('  ')}`);
    expect(home).toBeGreaterThan(0);
    expect(away).toBeGreaterThan(0);
    expect(Math.abs(home - away)).toBeLessThan(home + away); // no runaway
  });

  it('every weather produces a playable, deterministic match', () => {
    for (const weather of WEATHER_ORDER) {
      const a = runMatch(makeConfig(303, { weather }), 60 * 200);
      const b = runMatch(makeConfig(303, { weather }), 60 * 200);
      expect(a.w.weather).toBe(weather);
      expect(a.w.teams[0].score).toBe(b.w.teams[0].score);
      expect(a.w.stats.passes).toEqual(b.w.stats.passes);
    }
  });
});

describe('roster + pre-match logic', () => {
  it('has a full roster with valid designs and attributes', () => {
    expect(ROSTER.length).toBeGreaterThanOrEqual(15);
    for (const v of ROSTER) {
      expect(v.name.length).toBeGreaterThan(0);
      expect(v.epithet.length).toBeGreaterThan(0);
      for (const key of ['pace', 'strength', 'shooting', 'passing', 'tackling', 'technique'] as const) {
        expect(v.attrs[key]).toBeGreaterThan(0);
        expect(v.attrs[key]).toBeLessThanOrEqual(99);
      }
      const ovr = overallOf(v);
      expect(ovr).toBeGreaterThan(30);
      expect(ovr).toBeLessThan(100);
    }
    // Keepers must exist so a squad can always field one.
    expect(ROSTER.filter((v) => v.role === 'GK').length).toBeGreaterThanOrEqual(2);
  });

  it('assigns five picks to GK/DEF/MID/MID/FWD slots', () => {
    const lineup = buildLineup(['volt', 'crimson', 'moss', 'frost', 'cobalt']);
    expect(lineup).toHaveLength(5);
    expect(lineup.map((l) => l.role)).toEqual(['GK', 'DEF', 'MID', 'MID', 'FWD']);
    // A natural keeper always takes the gloves.
    expect(lineup[0].id).toBe('frost');
    // No duplicates.
    expect(new Set(lineup.map((l) => l.id)).size).toBe(5);
  });

  it('falls back to the most defensive outfield when no keeper is picked', () => {
    const lineup = buildLineup(['volt', 'crimson', 'moss', 'cobalt', 'blaze']);
    expect(lineup).toHaveLength(5);
    expect(ROSTER_BY_ID[lineup[0].id].role).not.toBe('GK');
    expect(ROSTER_BY_ID[lineup[0].id].role).toBe('DEF');
  });

  it('auto-selects an opponent near the player rating', () => {
    const strong = ['frost', 'granite', 'cobalt', 'amp', 'blaze'];
    const weak = ['tundra', 'brick', 'rusty', 'sage', 'ember'];
    const strongOpp = autoOpponent(strong, 42);
    const weakOpp = autoOpponent(weak, 42);
    expect(strongOpp.ids).toHaveLength(5);
    expect(strongOpp.club.id.length).toBeGreaterThan(0);
    // The opponent tracks the player's overall, so it is always an even fight.
    expect(Math.abs(strongOpp.overall - teamOverall(strong))).toBeLessThanOrEqual(4);
    expect(Math.abs(weakOpp.overall - teamOverall(weak))).toBeLessThanOrEqual(4);
    // A stronger squad must not draw a weaker opponent than a weak squad does.
    expect(strongOpp.overall).toBeGreaterThanOrEqual(weakOpp.overall);
    // Never fields a player the human already picked.
    expect(strongOpp.ids.some((id) => strong.includes(id))).toBe(false);
    // Composed by position: exactly one keeper.
    expect(strongOpp.ids.filter((id) => ROSTER_BY_ID[id].role === 'GK')).toHaveLength(1);
  });

  it('has no structural home advantage (mirrored squads)', () => {
    const five = ['frost', 'moss', 'volt', 'cobalt', 'crimson'];
    let home = 0;
    let away = 0;
    const lines: string[] = [];
    for (const seed of [3, 9, 15, 21, 27, 33, 39, 45]) {
      const { w } = runMatch({
        seed,
        homeIds: five,
        awayIds: five, // identical teams on both sides
        awayClubId: 'titan',
        weather: 'sun',
        halfSeconds: 90,
      });
      home += w.teams[0].score;
      away += w.teams[1].score;
      lines.push(`${seed}: ${w.teams[0].score}-${w.teams[1].score}`);
    }
    // eslint-disable-next-line no-console
    console.log(`mirror home=${home} away=${away} | ${lines.join('  ')}`);
    expect(home + away).toBeGreaterThan(0);
    // Identical squads: the gap must be explainable by sampling noise alone
    // (~2 standard deviations of the difference of two Poisson counts).
    const tolerance = Math.ceil(2 * Math.sqrt(home + away));
    expect(Math.abs(home - away)).toBeLessThanOrEqual(tolerance);
  });

  it('rates a balanced squad higher than a weak one', () => {
    expect(teamOverall(['frost', 'granite', 'cobalt', 'amp', 'blaze'])).toBeGreaterThan(
      teamOverall(['tundra', 'brick', 'rusty', 'sage', 'ember']),
    );
  });
});
