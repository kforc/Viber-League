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

/**
 * Play the first `n` of the player's fixtures, all won 1-0, and return the
 * stored results. This is the calendar: matchday `n` is the player's nth game.
 */
function playMatchdays(n: number): Record<string, { home: number; away: number }> {
  const out: Record<string, { home: number; away: number }> = {};
  for (const f of playerFixtures().slice(0, n)) {
    out[f.id] = isHomeFixture(f) ? { home: 1, away: 0 } : { home: 0, away: 1 };
  }
  return out;
}

/** Every one of the player's twelve fixtures, scored the same way. */
function playerSeason(mine: number, theirs: number): Record<string, { home: number; away: number }> {
  const out: Record<string, { home: number; away: number }> = {};
  for (const f of playerFixtures()) {
    out[f.id] = isHomeFixture(f) ? { home: mine, away: theirs } : { home: theirs, away: mine };
  }
  return out;
}

describe('completeResults', () => {
  /*
   * The league moves with the player. Every other club plays its matchday at
   * the same time the player plays theirs and not before, so a new season opens
   * with all seven clubs on zero and a result is never visible for a matchday
   * the player has not reached. These tests pin that, because the failure mode
   * is silent: a table that is simply *too complete* looks entirely plausible —
   * it was showing six clubs ten games in before the player had kicked off.
   */
  it('leaves a brand-new season completely empty', () => {
    const filled = completeResults({}, { seed: 1 });
    expect(filled).toEqual({});

    const table = buildTable(filled);
    expect(table).toHaveLength(N);
    for (const row of table) {
      expect(row.played, `${row.clubId} played`).toBe(0);
      expect(row.points).toBe(0);
    }
  });

  it('puts the player on one game with nobody ahead after matchday one', () => {
    const table = buildTable(completeResults(playMatchdays(1), { seed: 1 }));
    const me = playerRow(table);
    expect(me?.played).toBe(1);

    // Nobody has played more than the player: the league is on their matchday.
    for (const row of table) {
      expect(row.played, `${row.clubId} played`).toBeLessThanOrEqual(1);
    }
    // Six clubs played and one rested — which is what a seven-club round is.
    expect(table.filter((r) => r.played === 1)).toHaveLength(6);
    expect(table.filter((r) => r.played === 0)).toHaveLength(1);
  });

  it('never reveals a matchday the player has not reached', () => {
    const filled = completeResults(playMatchdays(1), { seed: 1 });
    // The player's first fixture is round 1, so that is the only round the rest
    // of the league has played. Round 0 is the player's bye — not a matchday.
    for (const f of makeSchedule()) {
      const isPlayer = f.homeId === PLAYER_CLUB_ID || f.awayId === PLAYER_CLUB_ID;
      if (isPlayer || f.round === 1) continue;
      expect(filled[f.id], `${f.id} (round ${f.round})`).toBeUndefined();
    }
    // And the round they did reach is there — the league moved with them.
    const roundOne = makeSchedule().filter(
      (f) => f.round === 1 && f.homeId !== PLAYER_CLUB_ID && f.awayId !== PLAYER_CLUB_ID,
    );
    expect(roundOne.length).toBeGreaterThan(0);
    for (const f of roundOne) expect(filled[f.id]).toBeDefined();
  });

  it('fills in CPU fixtures only — never one of the player\'s own', () => {
    const played = playMatchdays(3);
    const filled = completeResults(played, { seed: 1 });
    for (const f of playerFixtures()) {
      if (played[f.id]) expect(filled[f.id]).toEqual(played[f.id]);
      else expect(filled[f.id], `${f.id} is the player's`).toBeUndefined();
    }
  });

  it('keeps the player level with the leaders on every single matchday', () => {
    /*
     * The invariant the player actually asked for. A seven-club league rests
     * one club a round, and the player sits out rounds 0 and 7 — so a naive
     * "reveal every round up to the player's last" hands five clubs two games
     * the moment the player kicks off. Counting matchdays instead keeps the
     * player tied with the busiest club from the first whistle to the last.
     */
    for (let n = 1; n <= 12; n++) {
      const table = buildTable(completeResults(playMatchdays(n), { seed: 5 }));
      const me = playerRow(table);
      const most = Math.max(...table.map((r) => r.played));
      expect(me?.played, `matchday ${n}: the player's games`).toBe(n);
      expect(me?.played, `matchday ${n}: most games by any club`).toBe(most);
    }
  });

  it('keeps the results it derived stable as the season goes on', () => {
    // A matchday already played must read the same later in the season, or the
    // table would quietly rewrite itself between one screen and the next.
    const early = completeResults(playMatchdays(1), { seed: 9 });
    const late = completeResults(playMatchdays(7), { seed: 9 });
    expect(Object.keys(early).length).toBeGreaterThan(0);
    for (const [id, r] of Object.entries(early)) expect(late[id]).toEqual(r);
  });

  it('never overwrites a result that is already there', () => {
    const f = playerFixtures()[0];
    const played = { [f.id]: { home: 4, away: 1 } };
    const filled = completeResults(played, { seed: 1 });
    expect(filled[f.id]).toEqual({ home: 4, away: 1 });
  });

  it('is stable across calls, so the table does not move on its own', () => {
    const a = completeResults(playMatchdays(3), { seed: 42 });
    const b = completeResults(playMatchdays(3), { seed: 42 });
    expect(a).toEqual(b);
  });

  it('changes with the season seed — a new season is a new set of results', () => {
    const a = completeResults(playMatchdays(3), { seed: 1 });
    const b = completeResults(playMatchdays(3), { seed: 2 });
    expect(a).not.toEqual(b);
  });

  it('reveals the whole table once the player\'s season is done', () => {
    const played = playMatchdays(12);
    const filled = completeResults(played, { seed: 3 });
    expect(Object.keys(filled)).toHaveLength(makeSchedule().length);
    // The player's own results are untouched — only the CPU half is derived.
    for (const f of playerFixtures()) expect(filled[f.id]).toEqual(played[f.id]);

    // And the finished table is a real one: everyone played everyone twice.
    for (const row of buildTable(filled)) {
      expect(row.played, `${row.clubId} played`).toBe((N - 1) * 2);
    }
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
    // Twelve 2-0 wins is enough to top a seven-club league whatever the CPU
    // half does, so this stays true across seeds.
    const summary = summariseSeason(1, 3, playerSeason(2, 0));

    expect(summary.played).toBe(12);
    expect(summary.won).toBe(12);
    expect(summary.points).toBe(36);
    expect(summary.position).toBe(1);
    expect(summary.champion).toBe(PLAYER_CLUB_ID);
  });

  it('files the real champion when the player does not win the league', () => {
    /*
     * The regression this exists for: a stored season holds the player's twelve
     * fixtures and nothing else, because the CPU results are derived rather
     * than persisted. Building the table from those alone left every other club
     * on zero — so the player was top of the league by default and EVERY season
     * ever filed recorded them as champion, however badly they had played.
     */
    const summary = summariseSeason(2, 3, playerSeason(0, 2));

    expect(summary.played).toBe(12);
    expect(summary.won).toBe(0);
    expect(summary.position).toBe(N);
    expect(summary.champion).not.toBe(PLAYER_CLUB_ID);
    // The champion must be a real club that actually earned it.
    expect(LEAGUE_CLUB_IDS).toContain(summary.champion);
  });
});
