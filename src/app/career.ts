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
import type { WeatherKind } from '../sim/types';

const STORAGE_KEY = 'viber-league:career:v1';
const CAREER_VERSION = 1;

/** The saved starting five, as a slot count the formation can fill. */
export const SQUAD_SIZE = 5;

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
  /** The starting five carried into every match. */
  lineup: string[];
  settings: CareerSettings;
  /** Completed seasons, most recent first. */
  history: SeasonSummary[];
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
    settings: { ...DEFAULT_SETTINGS },
    history: [],
    createdAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/** Keep only ids that still exist in the roster, capped at a full five. */
export function sanitiseLineup(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || seen.has(id) || !ROSTER_BY_ID[id]) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= SQUAD_SIZE) break;
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
      settings: sanitiseSettings(c.settings),
      history: sanitiseHistory(c.history),
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
  return { ...career, lineup: sanitiseLineup(ids) };
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
 * every year.
 */
export function startNextSeason(career: CareerState, seed?: number): CareerState {
  const summary = summariseSeason(career.season, career.seed, career.results);
  return {
    ...career,
    season: career.season + 1,
    seed: seed ?? Math.floor(Math.random() * 1e9),
    results: {},
    history: [summary, ...career.history].slice(0, 20),
  };
}

/** The season the player is currently in, summarised as it stands. */
export function currentSeasonSummary(career: CareerState): SeasonSummary {
  return summariseSeason(career.season, career.seed, career.results);
}
