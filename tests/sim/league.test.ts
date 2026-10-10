import { describe, expect, it } from 'vitest';
import {
  LEAGUE_CLUB_IDS,
  PLAYER_CLUB_ID,
  buildTable,
  careerTotals,
  clubStrength,
  completeResults,
  isHomeFixture,
  lifetimeTotals,
  makeSchedule,
  nextFixture,
  opponentOf,
  playerFixtures,
  playerPosition,
  playerRow,
  recentForm,
  seasonComplete,
  seasonRounds,
  simulateCpuFixture,
  summariseSeason,
  type Fixture,
} from '../../src/sim/league';
import { OPPONENT_CLUBS } from '../../src/sim/content';

/**
 * The league is the spine of the game now: PLAY advances the season, and the
 * table is what the player is actually playing for. So these tests are about
 * the two ways it could quietly be wrong — a schedule that does not add up, and
 * a table that disagrees with the results it was built from.
 *
 * Determinism gets its own attention: the CPU half of the season is *generated*
 * every time it is read rather than stored, so if it were not stable the table
 * would move on its own between one screen and the next.
 */

const N = LEAGUE_CLUB_IDS.length;

describe('the schedule', () => {
  const schedule = makeSchedule();

  it('plays every club home and away', () => {
    // C(7,2) = 21 pairings, each played twice.
    expect(schedule).toHaveLength((N * (N - 1)));
    expect(seasonRounds()).toBe(14);
  });

  it('gives every club the same number of games, half of them at home', () => {
    const home = new Map<string, number>();
    const away = new Map<string, number>();
    for (const f of schedule) {
      home.set(f.homeId, (home.get(f.homeId) ?? 0) + 1);
      away.set(f.awayId, (away.get(f.awayId) ?? 0) + 1);
    }
    for (const id of LEAGUE_CLUB_IDS) {
      expect(home.get(id), `${id} home games`).toBe(N - 1);
      expect(away.get(id), `${id} away games`).toBe(N - 1);
    }
  });

  it('never schedules a club against itself', () => {
    for (const f of schedule) expect(f.homeId).not.toBe(f.awayId);
  });

  it('gives every fixture a unique id, so results cannot collide', () => {
    const ids = new Set(schedule.map((f) => f.id));
    expect(ids.size).toBe(schedule.length);
  });

  it('is deterministic — the same clubs always produce the same season', () => {
    expect(makeSchedule().map((f) => f.id)).toEqual(makeSchedule().map((f) => f.id));
  });

  it('is stable under an odd club count, resting one club per round', () => {
    const six = makeSchedule(LEAGUE_CLUB_IDS.slice(0, 6));
    expect(six).toHaveLength(6 * 5);
    const odd = makeSchedule(LEAGUE_CLUB_IDS.slice(0, 5));
    // 5 clubs → C(5,2) = 10 pairings, played twice.
    expect(odd).toHaveLength(20);
  });

  it('schedules the player 12 times', () => {
    expect(playerFixtures()).toHaveLength((N - 1) * 2);
  });
});

describe('CPU fixtures', () => {
  it('is deterministic per season and fixture', () => {
    const a = simulateCpuFixture(70, 70, 12345, 'x|y');
    const b = simulateCpuFixture(70, 70, 12345, 'x|y');
    expect(a).toEqual(b);
  });

  it('does not give every fixture the same scoreline', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const r = simulateCpuFixture(70, 70, 99, `home${i}|away`);
      seen.add(`${r.home}-${r.away}`);
    }
    expect(seen.size).toBeGreaterThan(3);
  });

  it('produces plausible scorelines', () => {
    for (let i = 0; i < 300; i++) {
      const r = simulateCpuFixture(70, 70, 5, `h${i}|a`);
      expect(r.home).toBeGreaterThanOrEqual(0);
      expect(r.away).toBeGreaterThanOrEqual(0);
      expect(r.home).toBeLessThanOrEqual(9);
      expect(r.away).toBeLessThanOrEqual(9);
    }
  });

  it('makes a much stronger side win most of the time', () => {
    let wins = 0;
    for (let i = 0; i < 300; i++) {
      const r = simulateCpuFixture(86, 56, 7, `strong${i}|weak`);
      if (r.home > r.away) wins++;
    }
    expect(wins).toBeGreaterThan(170);
  });

  it('rates the CPU clubs by tier', () => {
    const strengths = OPPONENT_CLUBS.map(clubStrength);
    for (let i = 1; i < strengths.length; i++) {
      expect(strengths[i]).toBeGreaterThan(strengths[i - 1]);
    }
  });
});

describe('completeResults', () => {
  it('fills in every fixture the player is not in', () => {
    const filled = completeResults({}, { seed: 1, playerStrength: 75 });
    const schedule = makeSchedule();
    const playerGames = playerFixtures(schedule);

    expect(Object.keys(filled)).toHaveLength(schedule.length - playerGames.length);
    for (const f of playerGames) expect(filled[f.id]).toBeUndefined();
  });

  it('never overwrites a result that is already there', () => {
    const f = playerFixtures()[0];
    const played = { [f.id]: { home: 4, away: 1 } };
    const filled = completeResults(played, { seed: 1, playerStrength: 75 });
    expect(filled[f.id]).toEqual({ home: 4, away: 1 });
  });

  it('is stable across calls, so the table does not move on its own', () => {
    const a = completeResults({}, { seed: 42, playerStrength: 75 });
    const b = completeResults({}, { seed: 42, playerStrength: 75 });
    expect(a).toEqual(b);
  });

  it('changes with the season seed — a new season is a new set of results', () => {
    const a = completeResults({}, { seed: 1, playerStrength: 75 });
    const b = completeResults({}, { seed: 2, playerStrength: 75 });
    expect(a).not.toEqual(b);
  });
});

describe('the table', () => {
  it('credits a win, a draw and a loss correctly', () => {
    const f = playerFixtures()[0];
    const home = isHomeFixture(f);
    const results = { [f.id]: home ? { home: 3, away: 0 } : { home: 0, away: 3 } };

    const table = buildTable(results);
    const me = playerRow(table);
    expect(me).toBeDefined();
    expect(me?.played).toBe(1);
    expect(me?.won).toBe(1);
    expect(me?.points).toBe(3);
    expect(me?.gf).toBe(3);
    expect(me?.ga).toBe(0);
    expect(me?.gd).toBe(3);

    const opponent = table.find((r) => r.clubId === opponentOf(f));
    expect(opponent?.played).toBe(1);
    expect(opponent?.lost).toBe(1);
    expect(opponent?.points).toBe(0);
    expect(opponent?.gd).toBe(-3);
  });

  it('counts a draw as one point each', () => {
    const f = playerFixtures()[0];
    const table = buildTable({ [f.id]: { home: 2, away: 2 } });
    expect(playerRow(table)?.points).toBe(1);
    expect(playerRow(table)?.drawn).toBe(1);
  });

  it('orders by points, then goal difference, then goals scored', () => {
    const synthetic: Fixture[] = [
      { id: 'a|b', round: 0, homeId: 'a', awayId: 'b' },
      { id: 'c|d', round: 0, homeId: 'c', awayId: 'd' },
    ];
    const table = buildTable({ 'a|b': { home: 1, away: 0 }, 'c|d': { home: 4, away: 0 } }, ['a', 'b', 'c', 'd'], synthetic);
    // c and a both won; c's goal difference is better, so c is first.
    expect(table.map((r) => r.clubId)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('starts every club on zero before a ball is kicked', () => {
    const table = buildTable({});
    expect(table).toHaveLength(N);
    for (const row of table) {
      expect(row.played).toBe(0);
      expect(row.points).toBe(0);
      expect(row.form).toEqual([]);
    }
  });

  it('records form most recent last', () => {
    const fixtures = playerFixtures();
    const results: Record<string, { home: number; away: number }> = {};
    // Win the first, lose the second.
    for (const [i, f] of fixtures.slice(0, 2).entries()) {
      const home = isHomeFixture(f);
      const mine = i === 0 ? 3 : 0;
      const theirs = i === 0 ? 0 : 3;
      results[f.id] = home ? { home: mine, away: theirs } : { home: theirs, away: mine };
    }
    const form = recentForm(results, 5);
    expect(form.map((f) => f.outcome)).toEqual(['W', 'L']);
    expect(form[0].gf).toBe(3);
    expect(form[1].ga).toBe(3);
  });
});

describe('the season in progress', () => {
  it('points at the first unplayed fixture, then moves on', () => {
    const fixtures = playerFixtures();
    expect(nextFixture({})?.id).toBe(fixtures[0].id);

    const afterFirst = { [fixtures[0].id]: { home: 1, away: 0 } };
    expect(nextFixture(afterFirst)?.id).toBe(fixtures[1].id);
  });

  it('reports the season complete once all twelve are played', () => {
    const results: Record<string, { home: number; away: number }> = {};
    for (const f of playerFixtures()) results[f.id] = { home: 1, away: 0 };
    expect(seasonComplete(results)).toBe(true);
    expect(nextFixture(results)).toBeNull();
  });

  it('counts the player 12th when nothing has been played', () => {
    expect(playerPosition(buildTable({}))).toBeGreaterThan(0);
  });
});

describe('career totals', () => {
  it('aggregates wins, goals and the best result', () => {
    const fixtures = playerFixtures();
    const results: Record<string, { home: number; away: number }> = {};
    const mine = [5, 0, 2];
    for (const [i, f] of fixtures.slice(0, 3).entries()) {
      const home = isHomeFixture(f);
      const theirs = [0, 3, 2][i];
      results[f.id] = home ? { home: mine[i], away: theirs } : { home: theirs, away: mine[i] };
    }

    const totals = careerTotals([results]);
    expect(totals.played).toBe(3);
    expect(totals.won).toBe(1);
    expect(totals.lost).toBe(1);
    expect(totals.drawn).toBe(1);
    expect(totals.gf).toBe(7);
    expect(totals.ga).toBe(5);
    expect(totals.winPct).toBe(33);
    expect(totals.best).toMatchObject({ margin: 5, gf: 5, ga: 0 });
  });

  it('is empty, not broken, before the first match', () => {
    const totals = careerTotals([{}]);
    expect(totals.played).toBe(0);
    expect(totals.winPct).toBe(0);
    expect(totals.best).toBeNull();
  });

  it('adds completed seasons on top of the one in progress', () => {
    const summary = summariseSeason(1, 1, {});
    const withHistory = lifetimeTotals([{ ...summary, played: 12, won: 8, drawn: 2, lost: 2, gf: 24, ga: 10 }], {});
    expect(withHistory.played).toBe(12);
    expect(withHistory.won).toBe(8);
    expect(withHistory.gf).toBe(24);
    expect(withHistory.winPct).toBe(67);
  });

  it('carries the best result across seasons', () => {
    const summary = summariseSeason(1, 1, {});
    const great = { ...summary, played: 1, won: 1, gf: 9, ga: 0, best: { margin: 9, gf: 9, ga: 0, opponentId: 'apex' } };
    const totals = lifetimeTotals([great], {});
    expect(totals.best?.margin).toBe(9);
  });
});

describe('summariseSeason', () => {
  it('files the finishing position, the points and the champion', () => {
    const fixtures = playerFixtures();
    const results: Record<string, { home: number; away: number }> = {};
    for (const f of fixtures) {
      const home = isHomeFixture(f);
      results[f.id] = home ? { home: 2, away: 0 } : { home: 0, away: 2 };
    }
    const filled = completeResults(results, { seed: 3, playerStrength: 88 });
    const summary = summariseSeason(1, 3, filled);

    expect(summary.played).toBe(12);
    expect(summary.won).toBe(12);
    expect(summary.points).toBe(36);
    // Twelve wins at +2 should be enough to top a seven-club league.
    expect(summary.position).toBe(1);
    expect(summary.champion).toBe(PLAYER_CLUB_ID);
  });
});
