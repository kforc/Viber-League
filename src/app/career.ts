// app/career.ts — the player's season: results, squad, settings.
//
// SCOPE: device-local, like app/profile.ts and for the same reason — it is the
// only other thing that has to outlive a reload. Everything that touches
// persistence lives behind this module, so moving the career to real cloud
// accounts later means rewriting this file and not the screens or the game.
//
// Nothing in here is a simulation. The schedule, the table and the CPU results
// all come from sim/league.ts; this module only decides what is *remembered*.

import { ROSTER_BY_ID } from '../sim/roster';
import {
  makeSchedule,
  seasonComplete,
  summariseSeason,
  type ResultMap,
  type SeasonSummary,
} from '../sim/league';
import type { SimEvent } from '../sim/types';
import type { WeatherKind } from '../sim/types';

const STORAGE_KEY = 'viber-league:career:v1';
const CAREER_VERSION = 2;

/** The saved starting five, as a slot count the formation can fill. */
export const SQUAD_SIZE = 5;

/**
 * How many players a league squad may hold.
 *
 * Not the same thing as `SQUAD_SIZE`. Five of them take the pitch; the rest are
 * the season's depth, and they exist for one reason: injuries and suspensions
 * take players away, and a club with no spare bodies cannot field a five. The
 * bench is still three (see `BENCH_SIZE`) — the extra squad members are cover
 * for the *season*, not extra substitutes in a match.
 */
export const LEAGUE_SQUAD_MAX = 12;

/** Why a player is unavailable, and for how many league fixtures. */
export interface Absence {
  kind: 'injury' | 'suspension';
  /** Fixtures still to be missed. Ticks down after every played fixture. */
  matches: number;
}

/*
 * How long an absence lasts is NOT decided here. The sim rolls it off its own
 * seeded stream at the moment of the incident (see `INJURY_MATCHES` /
 * `SUSPENSION_MATCHES` in sim/constants.ts) and reports it on the event; this
 * module only records the number it is handed. That keeps a season replayable
 * from its seed, and keeps the career layer free of football rules.
 */

export interface CareerSettings {
  /** Real seconds per half. */
  halfSeconds: number;
  /** Preferred pitch conditions, or `random` to let the fixture decide. */
  weather: WeatherKind | 'random';
  /** Force reduced motion even when the OS has not asked for it. */
  reducedMotion: boolean;
  /** Crowd, whistles and ball. Off silences the match without touching the rest. */
  sound: boolean;
}

export interface CareerState {
  version: number;
  /** 1-based. */
  season: number;
  /** The season's schedule seed. New season, new fixtures and new CPU results. */
  seed: number;
  /** Played fixtures, keyed by fixture id. */
  results: ResultMap;
  /**
   * The league squad, in pick order. The first `SQUAD_SIZE` are the starting
   * five; the rest are the matchday squad. Capped at `LEAGUE_SQUAD_MAX`.
   */
  lineup: string[];
  /**
   * Players who cannot be picked, keyed by Viber id. This is what makes the
   * squad larger than a five worth having: a manager who has lost three players
   * to injury still has to name a side.
   */
  absences: Record<string, Absence>;
  settings: CareerSettings;
  /** Completed seasons, most recent first. */
  history: SeasonSummary[];
  /**
   * When the current league was created, or null when there isn't one yet.
   *
   * The league is opt-in: a club is not a season. Until this is set the League
   * screen offers NEW LEAGUE and LOAD EXISTING LEAGUE rather than a table of
   * seven clubs that nobody has actually kicked off in.
   *
   * Deliberately NOT migrated. A save written before this field exists holds a
   * season the manager was already part way through, and the whole point of the
   * gate is that such a player is offered LOAD EXISTING LEAGUE instead of being
   * forced down the path that wipes it. So an old save loads as "no league
   * created" and is recovered by that button.
   */
  leagueStartedAt: string | null;
  createdAt: string;
}

export const DEFAULT_SETTINGS: CareerSettings = {
  /*
   * Must be one of `LENGTH_OPTIONS` (60 / 90 / 150 in ui/screens). It was 120,
   * which is not offered — so a brand-new career opened Settings with no match
   * length highlighted and the minutes screen with nothing selected, and played
   * halves no option could produce. `career.test.ts` pins the two together.
   */
  halfSeconds: 90,
  weather: 'random',
  reducedMotion: false,
  sound: true,
};

/** A fresh career. The seed is derived from the clock once, at creation. */
export function defaultCareer(seed?: number): CareerState {
  return {
    version: CAREER_VERSION,
    season: 1,
    seed: seed ?? Math.floor(Math.random() * 1e9),
    results: {},
    lineup: [],
    absences: {},
    settings: { ...DEFAULT_SETTINGS },
    history: [],
    leagueStartedAt: null,
    createdAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Availability                                                        */
/* ------------------------------------------------------------------ */

/** True when the Viber is fit to be picked. */
export function isAvailable(career: CareerState, id: string): boolean {
  return !career.absences[id];
}

/** The squad members who are fit to play, in squad order. */
export function fitSquad(career: CareerState): string[] {
  return career.lineup.filter((id) => isAvailable(career, id));
}

/**
 * How many of the SQUAD are unavailable, and why — for the UI.
 *
 * Scoped to the squad on purpose. The absence map itself can hold entries for
 * roster players the manager does not own (an injury outlives a squad slot),
 * and counting those would tell a manager they have three players out when only
 * one of them is theirs.
 */
export function absenceCount(career: CareerState): { injury: number; suspension: number } {
  let injury = 0;
  let suspension = 0;
  for (const id of career.lineup) {
    const a = career.absences[id];
    if (!a) continue;
    if (a.kind === 'injury') injury += 1;
    else suspension += 1;
  }
  return { injury, suspension };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/** Keep only ids that still exist in the roster, capped at a full squad. */
export function sanitiseLineup(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || seen.has(id) || !ROSTER_BY_ID[id]) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= LEAGUE_SQUAD_MAX) break;
  }
  return out;
}

/**
 * Absences are keyed by Viber id and belong to the PLAYER, not to a squad slot.
 *
 * That distinction is the whole point. If an absence lived on squad membership,
 * then dropping an injured player and adding them straight back would be a free
 * cure — two taps that erase the one mechanic the twelve-man squad exists for.
 * An injury is a fact about a footballer; it does not heal because a manager
 * stopped picking them. So the record is kept for as long as the roster knows
 * the player, and it is the calendar (`tickAbsences`) that ends it.
 *
 * Only ids the roster still recognises survive, and a count below 1 means the
 * player is back — the entry is dropped rather than stored, because a stale zero
 * would read as "absent".
 */
function sanitiseAbsences(raw: unknown): Record<string, Absence> {
  const out: Record<string, Absence> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ROSTER_BY_ID[id]) continue;
    const a = value as Partial<Absence>;
    const matches = typeof a?.matches === 'number' ? Math.floor(a.matches) : 0;
    if (matches < 1) continue;
    out[id] = { kind: a.kind === 'suspension' ? 'suspension' : 'injury', matches };
  }
  return out;
}

function sanitiseSettings(raw: unknown): CareerSettings {
  const s = (raw ?? {}) as Partial<CareerSettings>;
  const weather: CareerSettings['weather'] =
    s.weather === 'sun' || s.weather === 'rain' || s.weather === 'ice' || s.weather === 'cold'
      ? s.weather
      : 'random';
  return {
    halfSeconds:
      typeof s.halfSeconds === 'number' && s.halfSeconds > 0
        ? s.halfSeconds
        : DEFAULT_SETTINGS.halfSeconds,
    weather,
    reducedMotion: s.reducedMotion === true,
    /*
     * `!== false`, not `=== true`. Every career saved before sound existed has
     * no `sound` key at all, and those players should get the crowd, not
     * silence — the only value that means "off" is an explicit `false`.
     */
    sound: s.sound !== false,
  };
}

function sanitiseResults(raw: unknown): ResultMap {
  const out: ResultMap = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const r = value as { home?: unknown; away?: unknown };
    if (typeof r?.home !== 'number' || typeof r?.away !== 'number') continue;
    if (!Number.isFinite(r.home) || !Number.isFinite(r.away)) continue;
    out[id] = { home: Math.max(0, Math.round(r.home)), away: Math.max(0, Math.round(r.away)) };
  }
  return out;
}

function sanitiseHistory(raw: unknown): SeasonSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is SeasonSummary =>
      Boolean(s) && typeof s === 'object' && typeof (s as SeasonSummary).season === 'number',
  );
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

export function loadCareer(): CareerState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<CareerState>;
    if (!c || typeof c !== 'object') return null;
    return {
      version: CAREER_VERSION,
      season: typeof c.season === 'number' && c.season >= 1 ? Math.floor(c.season) : 1,
      seed: typeof c.seed === 'number' ? c.seed : Math.floor(Math.random() * 1e9),
      results: sanitiseResults(c.results),
      lineup: sanitiseLineup(c.lineup),
      absences: sanitiseAbsences(c.absences),
      settings: sanitiseSettings(c.settings),
      history: sanitiseHistory(c.history),
      // See `leagueStartedAt` on the interface: an unmigrated save is one with a
      // season already in it, and it must reach LOAD EXISTING LEAGUE rather than
      // being silently adopted.
      leagueStartedAt: typeof c.leagueStartedAt === 'string' ? c.leagueStartedAt : null,
      createdAt: typeof c.createdAt === 'string' ? c.createdAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveCareer(career: CareerState): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(career));
    return true;
  } catch {
    return false;
  }
}

export function clearCareer(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}

/* ------------------------------------------------------------------ */
/* Transitions — each returns a new state rather than mutating         */
/* ------------------------------------------------------------------ */

/** Record a played fixture. Scores are from the home club's point of view. */
export function withResult(career: CareerState, fixtureId: string, home: number, away: number): CareerState {
  return {
    ...career,
    results: {
      ...career.results,
      [fixtureId]: { home: Math.max(0, Math.round(home)), away: Math.max(0, Math.round(away)) },
    },
  };
}

export function withLineup(career: CareerState, ids: string[]): CareerState {
  /*
   * The absences are deliberately NOT touched. Dropping an injured player does
   * not heal them — see `sanitiseAbsences` for why that matters — so a manager
   * who removes a player and adds them back finds them still in the treatment
   * room, which is what the mechanic promises.
   */
  return { ...career, lineup: sanitiseLineup(ids) };
}

/**
 * Record new absences after a match.
 *
 * The sim reports what happened on the pitch; this only records it. Where a
 * player is already out, the LONGER of the two absences wins: a knock picked up
 * while suspended does not let them back early.
 */
export function withAbsences(
  career: CareerState,
  added: Record<string, Absence>,
): CareerState {
  const absences: Record<string, Absence> = { ...career.absences };
  for (const [id, a] of Object.entries(added)) {
    if (!ROSTER_BY_ID[id] || a.matches < 1) continue;
    const prev = absences[id];
    if (!prev || a.matches > prev.matches) absences[id] = { ...a };
  }
  return { ...career, absences: sanitiseAbsences(absences) };
}

/**
 * Move the calendar on by one played fixture: every absence loses a fixture and
 * anyone whose count reaches zero is available again.
 */
export function tickAbsences(career: CareerState): CareerState {
  const absences: Record<string, Absence> = {};
  for (const [id, a] of Object.entries(career.absences)) {
    if (a.matches > 1) absences[id] = { ...a, matches: a.matches - 1 };
  }
  return { ...career, absences };
}

/**
 * The absences a match leaves behind, read off its card and injury events.
 *
 * Kept pure, and out of `game.ts`, for a specific reason: this is the one piece
 * of the discipline feature that a unit test otherwise cannot reach — buried in
 * a click handler it can only be exercised by playing a whole match in a real
 * browser. And it is the piece where a mistake is SILENT. Get the player-id
 * mapping wrong and injuries simply never happen, with nothing anywhere
 * reporting a problem.
 *
 * `viberOf` maps a sim player id to the Viber behind it; a card against a player
 * it cannot resolve is dropped rather than guessed at.
 *
 * `team` defaults to the human's side. The CPU clubs field Vibers from the same
 * roster, so without that filter an opponent's red card would ban a player who
 * might be in the manager's own squad.
 */
export function absencesFromEvents(
  viberOf: (playerId: number) => string | undefined,
  events: readonly SimEvent[],
  team: 0 | 1 = 0,
): Record<string, Absence> {
  const out: Record<string, Absence> = {};
  const record = (id: string, a: Absence) => {
    // The longer of two wins: a knock picked up while suspended must not let
    // the player back early.
    const prev = out[id];
    if (!prev || a.matches > prev.matches) out[id] = a;
  };

  for (const ev of events) {
    // Narrow on the tag before reading anything off the event: `SimEvent` is a
    // union and most of its members carry no `team` or `matches` at all.
    if (ev.type === 'card') {
      // A yellow carries no ban in this game, so it is not an absence at all.
      if (ev.card !== 'red' || ev.team !== team || ev.matches < 1) continue;
      const id = viberOf(ev.player);
      if (id) record(id, { kind: 'suspension', matches: ev.matches });
    } else if (ev.type === 'injury') {
      if (ev.team !== team || ev.matches < 1) continue;
      const id = viberOf(ev.player);
      if (id) record(id, { kind: 'injury', matches: ev.matches });
    }
  }
  return out;
}

/**
 * Opt into a new league: the table, the fixtures and the injury list all start
 * from nothing, while the club and the squad the manager has built stay. A
 * brand-new *club* is a different action (Settings → Erase career).
 *
 * Creating a league is what makes the League screen exist at all — this is the
 * field that turns "a club with no season" into "a season in progress".
 */
export function newLeague(career: CareerState, seed?: number): CareerState {
  return {
    ...career,
    season: 1,
    seed: seed ?? Math.floor(Math.random() * 1e9),
    results: {},
    absences: {},
    history: [],
    leagueStartedAt: new Date().toISOString(),
  };
}

/**
 * Continue the league already stored on this device.
 *
 * Used by the League gate's LOAD EXISTING LEAGUE. It changes nothing about the
 * season — the results, the table and the injury list are exactly what the
 * manager left behind — it only records that a league is live now. This is the
 * no-lost-progress path: a save from before the gate existed, or a season the
 * player stepped away from, comes back as it stood rather than being reset.
 */
export function loadExistingLeague(career: CareerState): CareerState {
  return { ...career, leagueStartedAt: new Date().toISOString() };
}

/** True once a league has been created, not merely a club. */
export function leagueExists(career: CareerState): boolean {
  return career.leagueStartedAt !== null;
}

/**
 * True when the device holds a league worth loading.
 *
 * The career on disk is the only copy — nothing is archived — so what can be
 * loaded is whatever is still standing in it. An empty club has nothing to
 * resume, which is why the gate can tell the two cases apart.
 */
export function hasStoredLeague(career: CareerState): boolean {
  return Object.keys(career.results).length > 0 || career.history.length > 0;
}

export function withSettings(career: CareerState, patch: Partial<CareerSettings>): CareerState {
  return { ...career, settings: sanitiseSettings({ ...career.settings, ...patch }) };
}

/** True when every one of the player's fixtures has been played. */
export function careerSeasonComplete(career: CareerState): boolean {
  return seasonComplete(career.results, makeSchedule());
}

/**
 * Close the season and open the next one: the finished season is filed into the
 * history, the results are cleared and the schedule is reseeded.
 *
 * The squad and the settings carry over — a manager does not rebuild their club
 * every year. Absences do NOT: a close season is long enough for every knock to
 * heal and every ban to be served, and starting a season with players already
 * ruled out would be a punishment with no way to have avoided it.
 */
export function startNextSeason(career: CareerState, seed?: number): CareerState {
  const summary = summariseSeason(career.season, career.seed, career.results);
  return {
    ...career,
    season: career.season + 1,
    seed: seed ?? Math.floor(Math.random() * 1e9),
    results: {},
    absences: {},
    history: [summary, ...career.history].slice(0, 20),
  };
}

/** The season the player is currently in, summarised as it stands. */
export function currentSeasonSummary(career: CareerState): SeasonSummary {
  return summariseSeason(career.season, career.seed, career.results);
}
