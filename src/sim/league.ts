// sim/league.ts — the season: fixtures, results and the table.
//
// Pure logic. No DOM, no storage, no clock, no Math.random — the same season
// seed always produces the same schedule and the same CPU-vs-CPU scorelines, so
// a table built on one device matches the table on any other, and reopening the
// game does not quietly reshuffle the league behind the player.
//
// The player's own results arrive from the match; every other fixture is
// simulated here from the two clubs' strength.

import type { WeatherKind } from './types';
import { makeRng, type Rng } from './core/rng';
import { clamp } from './core/math';
import { CLUBS, OPPONENT_CLUBS, PLAYER_CLUB, type ClubDef } from './content';

/** The league is every club in the game: the player's plus the CPU six. */
export const LEAGUE_CLUB_IDS: string[] = [PLAYER_CLUB.id, ...OPPONENT_CLUBS.map((c) => c.id)];

export const PLAYER_CLUB_ID = PLAYER_CLUB.id;

/**
 * A club's baseline rating when it plays itself.
 *
 * Tiers run 0..5; the player's club is tier 0 by definition but is rated from
 * the five actually picked (see `playerStrength`), so this only ever describes
 * the CPU. 56..86 lines up with the roster's overalls, which is what makes a
 * mid-table CPU side a fair fight for a mid-table human five.
 */
export function clubStrength(club: ClubDef): number {
  return 56 + club.tier * 6;
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

export interface Fixture {
  /**
   * Stable within a season, and the key results are stored under. A single
   * round-robin never repeats a pairing, so home|away is unique.
   */
  id: string;
  /** 0-based. Fixtures are played in round order. */
  round: number;
  homeId: string;
  awayId: string;
}

/** A round-robin leg via the circle method; an odd club count sits one out. */
function singleLeg(clubIds: string[]): Array<{ round: number; homeId: string; awayId: string }> {
  const ids = [...clubIds];
  const hasBye = ids.length % 2 === 1;
  if (hasBye) ids.push('__bye__');

  const n = ids.length;
  const half = n / 2;
  const rounds = n - 1;
  let order = ids.slice(1);
  const out: Array<{ round: number; homeId: string; awayId: string }> = [];

  for (let r = 0; r < rounds; r++) {
    const pairs: Array<[string, string]> = [[ids[0], order[order.length - 1]]];
    for (let i = 0; i < half - 1; i++) {
      pairs.push([order[i], order[order.length - 2 - i]]);
    }
    for (const [a, b] of pairs) {
      if (a === '__bye__' || b === '__bye__') continue;
      // Alternate which side of the pairing gets home advantage each round, so
      // the schedule does not hand one club a run of home games.
      out.push(r % 2 === 0 ? { round: r, homeId: a, awayId: b } : { round: r, homeId: b, awayId: a });
    }
    order = [order[order.length - 1], ...order.slice(0, order.length - 1)];
  }
  return out;
}

/**
 * A full season: every club home and away against every other.
 *
 * Seven clubs → 7 rounds per leg → 14 rounds, 42 fixtures, 12 per club. The
 * schedule is generated, not stored, so it costs nothing to persist and cannot
 * drift out of sync with the results.
 */
export function makeSchedule(clubIds: string[] = LEAGUE_CLUB_IDS): Fixture[] {
  const first = singleLeg(clubIds);
  const roundsPerLeg = first.reduce((m, f) => Math.max(m, f.round + 1), 0);
  const second = first.map((f) => ({
    round: f.round + roundsPerLeg,
    homeId: f.awayId,
    awayId: f.homeId,
  }));
  return [...first, ...second].map((f) => ({
    ...f,
    id: `${f.homeId}|${f.awayId}`,
  }));
}

/** Total rounds in a season for a given club count. */
export function seasonRounds(clubIds: string[] = LEAGUE_CLUB_IDS): number {
  const n = clubIds.length % 2 === 0 ? clubIds.length : clubIds.length + 1;
  return (n - 1) * 2;
}

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

/** A played fixture. Both scores are from the home club's point of view. */
export interface Result {
  home: number;
  away: number;
}

export type ResultMap = Record<string, Result>;

/** One fixture's outcome for one club, kept for the form guide. */
export interface FormEntry {
  round: number;
  /** 'W' | 'D' | 'L' */
  outcome: 'W' | 'D' | 'L';
  /** Goals for / against, from this club's point of view. */
  gf: number;
  ga: number;
  opponentId: string;
  home: boolean;
}

/* ------------------------------------------------------------------ */
/* CPU-vs-CPU simulation                                               */
/* ------------------------------------------------------------------ */

/** FNV-1a over the fixture id, so each fixture has its own stable stream. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Knuth's Poisson sampler. Fine here: expected goals never exceed ~4.5. */
function poisson(lambda: number, rng: Rng): number {
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng.next();
  } while (p > limit && k < 12);
  return k - 1;
}

/**
 * A scoreline for a fixture neither side of which is the player.
 *
 * Expected goals come from the strength gap, with a home bump — the same
 * 1.35 / 1.15 baseline a real five-a-side game lands near. Deterministic per
 * (season seed, fixture), so the table never moves on its own.
 */
export function simulateCpuFixture(
  homeStrength: number,
  awayStrength: number,
  seed: number,
  fixtureId: string,
): Result {
  const rng = makeRng((seed ^ hashString(fixtureId)) >>> 0);
  const diff = (homeStrength - awayStrength) / 12;
  const homeXg = clamp(1.35 + diff * 0.55 + 0.18, 0.3, 4.5);
  const awayXg = clamp(1.15 - diff * 0.55, 0.3, 4.5);
  return { home: poisson(homeXg, rng), away: poisson(awayXg, rng) };
}

/**
 * Fill in every fixture the player has not played.
 *
 * The player's club is rated by `playerStrength` (their five's overall) so the
 * table reflects the squad they have actually built rather than a fixed number.
 */
export function completeResults(
  results: ResultMap,
  opts: { seed: number; playerStrength: number; schedule?: Fixture[]; clubIds?: string[] },
): ResultMap {
  const schedule = opts.schedule ?? makeSchedule(opts.clubIds);
  const out: ResultMap = { ...results };

  for (const f of schedule) {
    if (out[f.id]) continue;
    const involvesPlayer = f.homeId === PLAYER_CLUB_ID || f.awayId === PLAYER_CLUB_ID;
    // A fixture the player is in has no result until they play it.
    if (involvesPlayer) continue;

    const home = CLUBS[f.homeId];
    const away = CLUBS[f.awayId];
    if (!home || !away) continue;
    out[f.id] = simulateCpuFixture(clubStrength(home), clubStrength(away), opts.seed, f.id);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The table                                                           */
/* ------------------------------------------------------------------ */

export interface TableRow {
  clubId: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
  gd: number;
  points: number;
  /** Most recent last. Empty until the club has played. */
  form: FormEntry[];
}

/**
 * The table, best first: points, then goal difference, then goals scored, then
 * name — so the order is total and never depends on insertion order.
 */
export function buildTable(
  results: ResultMap,
  clubIds: string[] = LEAGUE_CLUB_IDS,
  schedule: Fixture[] = makeSchedule(clubIds),
): TableRow[] {
  const rows = new Map<string, TableRow>();
  for (const id of clubIds) {
    rows.set(id, {
      clubId: id, played: 0, won: 0, drawn: 0, lost: 0,
      gf: 0, ga: 0, gd: 0, points: 0, form: [],
    });
  }

  const ordered = [...schedule].sort((a, b) => a.round - b.round);
  for (const f of ordered) {
    const r = results[f.id];
    if (!r) continue;
    const home = rows.get(f.homeId);
    const away = rows.get(f.awayId);
    if (!home || !away) continue;

    applyResult(home, r.home, r.away, f, false);
    applyResult(away, r.away, r.home, f, true);
  }

  for (const row of rows.values()) row.gd = row.gf - row.ga;

  return [...rows.values()].sort(
    (a, b) =>
      b.points - a.points ||
      b.gd - a.gd ||
      b.gf - a.gf ||
      clubName(a.clubId).localeCompare(clubName(b.clubId)),
  );
}

function applyResult(row: TableRow, gf: number, ga: number, f: Fixture, isAway: boolean): void {
  row.played++;
  row.gf += gf;
  row.ga += ga;
  const opponentId = isAway ? f.homeId : f.awayId;
  if (gf > ga) {
    row.won++;
    row.points += 3;
    row.form.push({ round: f.round, outcome: 'W', gf, ga, opponentId, home: !isAway });
  } else if (gf === ga) {
    row.drawn++;
    row.points += 1;
    row.form.push({ round: f.round, outcome: 'D', gf, ga, opponentId, home: !isAway });
  } else {
    row.lost++;
    row.form.push({ round: f.round, outcome: 'L', gf, ga, opponentId, home: !isAway });
  }
}

export function clubName(id: string): string {
  return CLUBS[id]?.name ?? id;
}

export function clubShort(id: string): string {
  return CLUBS[id]?.short ?? id.slice(0, 3).toUpperCase();
}

/* ------------------------------------------------------------------ */
/* Reading the season                                                  */
/* ------------------------------------------------------------------ */

/** The player's fixtures, in round order. */
export function playerFixtures(schedule: Fixture[] = makeSchedule()): Fixture[] {
  return schedule
    .filter((f) => f.homeId === PLAYER_CLUB_ID || f.awayId === PLAYER_CLUB_ID)
    .sort((a, b) => a.round - b.round);
}

/**
 * The player's next unplayed fixture, or null when the season is complete.
 * This is what the pre-match flow plays, so PLAY always advances the season.
 */
export function nextFixture(
  results: ResultMap,
  schedule: Fixture[] = makeSchedule(),
): Fixture | null {
  return playerFixtures(schedule).find((f) => !results[f.id]) ?? null;
}

/** The player's row, whether or not they are on top of the table. */
export function playerRow(table: TableRow[]): TableRow | undefined {
  return table.find((r) => r.clubId === PLAYER_CLUB_ID);
}

/** 1-based league position, or 0 if the club is somehow missing. */
export function playerPosition(table: TableRow[]): number {
  return table.findIndex((r) => r.clubId === PLAYER_CLUB_ID) + 1;
}

/** Which club the player is up against in a fixture. */
export function opponentOf(f: Fixture): string {
  return f.homeId === PLAYER_CLUB_ID ? f.awayId : f.homeId;
}

export function isHomeFixture(f: Fixture): boolean {
  return f.homeId === PLAYER_CLUB_ID;
}

/** True once every one of the player's fixtures has a result. */
export function seasonComplete(results: ResultMap, schedule: Fixture[] = makeSchedule()): boolean {
  return playerFixtures(schedule).every((f) => Boolean(results[f.id]));
}

/* ------------------------------------------------------------------ */
/* Career totals                                                       */
/* ------------------------------------------------------------------ */

export interface CareerTotals {
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
  /** Win percentage, rounded. */
  winPct: number;
  /** Biggest winning margin, and the fixture it came in. */
  best: { margin: number; gf: number; ga: number; opponentId: string } | null;
}

/** Aggregate every player fixture that has a result — across all seasons. */
export function careerTotals(allResults: ResultMap[]): CareerTotals {
  const totals: CareerTotals = {
    played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, winPct: 0, best: null,
  };

  for (const results of allResults) {
    for (const f of playerFixtures()) {
      const r = results[f.id];
      if (!r) continue;
      const home = isHomeFixture(f);
      const gf = home ? r.home : r.away;
      const ga = home ? r.away : r.home;
      totals.played++;
      totals.gf += gf;
      totals.ga += ga;
      if (gf > ga) totals.won++;
      else if (gf === ga) totals.drawn++;
      else totals.lost++;

      const margin = gf - ga;
      if (!totals.best || margin > totals.best.margin) {
        totals.best = { margin, gf, ga, opponentId: opponentOf(f) };
      }
    }
  }

  totals.winPct = totals.played ? Math.round((totals.won / totals.played) * 100) : 0;
  return totals;
}

/** The player's last N results across a season, most recent last. */
export function recentForm(results: ResultMap, n = 5, schedule: Fixture[] = makeSchedule()): FormEntry[] {
  const played = playerFixtures(schedule).filter((f) => results[f.id]);
  return played
    .map((f) => {
      const r = results[f.id];
      const home = isHomeFixture(f);
      const gf = home ? r.home : r.away;
      const ga = home ? r.away : r.home;
      return {
        round: f.round,
        outcome: (gf > ga ? 'W' : gf === ga ? 'D' : 'L') as FormEntry['outcome'],
        gf, ga,
        opponentId: opponentOf(f),
        home,
      };
    })
    .slice(-n);
}

/** Where the player finished, for the history list. */
export interface SeasonSummary {
  season: number;
  seed: number;
  position: number;
  points: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
  /** Carried here because the raw results are discarded when a season closes. */
  best: CareerTotals['best'];
  champion: string;
}

export function summariseSeason(
  season: number,
  seed: number,
  results: ResultMap,
): SeasonSummary {
  const table = buildTable(results);
  const row = playerRow(table);
  const totals = careerTotals([results]);
  return {
    season,
    seed,
    position: playerPosition(table),
    points: row?.points ?? 0,
    played: totals.played,
    won: totals.won,
    drawn: totals.drawn,
    lost: totals.lost,
    gf: totals.gf,
    ga: totals.ga,
    best: totals.best,
    champion: table[0]?.clubId ?? '',
  };
}

/**
 * Totals across a whole career: the seasons already filed into the history,
 * plus the one in progress.
 *
 * The history keeps aggregates rather than raw results — a completed season's
 * fixtures are of no further use and would grow the save file forever — so this
 * adds them up rather than replaying them.
 */
export function lifetimeTotals(history: SeasonSummary[], current: ResultMap): CareerTotals {
  const totals = careerTotals([current]);

  for (const s of history) {
    totals.played += s.played;
    totals.won += s.won;
    totals.drawn += s.drawn;
    totals.lost += s.lost;
    totals.gf += s.gf;
    totals.ga += s.ga;
    if (s.best && (!totals.best || s.best.margin > totals.best.margin)) {
      totals.best = s.best;
    }
  }

  totals.winPct = totals.played ? Math.round((totals.won / totals.played) * 100) : 0;
  return totals;
}

/** The weather a fixture is played in, when the player left it to chance. */
export function fixtureWeather(seed: number, fixtureId: string): WeatherKind {
  const rng = makeRng((seed ^ hashString(fixtureId) ^ 0x5bf03635) >>> 0);
  return rng.pick<WeatherKind>(['sun', 'rain', 'ice', 'cold']);
}

export type { ClubDef };
