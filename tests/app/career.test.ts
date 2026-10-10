import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SQUAD_SIZE,
  type CareerState,
  careerSeasonComplete,
  clearCareer,
  currentSeasonSummary,
  defaultCareer,
  loadCareer,
  sanitiseLineup,
  saveCareer,
  startNextSeason,
  withLineup,
  withResult,
  withSettings,
} from '../../src/app/career';
import { type Fixture, ROSTER, isHomeFixture, playerFixtures } from '../../src/sim';
import { LENGTH_OPTIONS } from '../../src/ui/screens';

/**
 * The career is the second thing that outlives a reload, so it gets the same
 * treatment as the profile: a corrupt record must degrade to a fresh season
 * rather than throw, and a saved five must never contain a Viber who no longer
 * exists in the roster.
 *
 * Node has no `localStorage`, which is convenient here — it exercises the
 * storage-missing path for free.
 */

class MemoryStorage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

function useMemoryStorage(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
}

beforeEach(() => useMemoryStorage());
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

const KEY = 'viber-league:career:v1';

/**
 * Scores are stored from the home club's point of view and the player is home
 * in only half the fixtures, so a 2-0 written blindly is a win one week and a
 * loss the next. These two helpers keep the intent ("the player won") explicit.
 */
function win(c: CareerState, f: Fixture, gf = 2): CareerState {
  return isHomeFixture(f) ? withResult(c, f.id, gf, 0) : withResult(c, f.id, 0, gf);
}

describe('a fresh career', () => {
  it('starts in season 1 with nothing played', () => {
    const c = defaultCareer(7);
    expect(c.season).toBe(1);
    expect(c.seed).toBe(7);
    expect(c.results).toEqual({});
    expect(c.lineup).toEqual([]);
    expect(c.history).toEqual([]);
    expect(c.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('gets a seed of its own when none is given', () => {
    const seeds = new Set(Array.from({ length: 8 }, () => defaultCareer().seed));
    expect(seeds.size).toBeGreaterThan(1);
  });
});

describe('the squad', () => {
  it('keeps only real Vibers, in order, without duplicates', () => {
    const ids = [ROSTER[0].id, 'not-a-viber', ROSTER[1].id, ROSTER[0].id];
    expect(sanitiseLineup(ids)).toEqual([ROSTER[0].id, ROSTER[1].id]);
  });

  it('never holds more than a full five', () => {
    const six = ROSTER.slice(0, 6).map((v) => v.id);
    expect(sanitiseLineup(six)).toHaveLength(SQUAD_SIZE);
  });

  it('rejects anything that is not an array of strings', () => {
    expect(sanitiseLineup(null)).toEqual([]);
    expect(sanitiseLineup('crimson')).toEqual([]);
    expect(sanitiseLineup([1, 2, 3])).toEqual([]);
  });

  it('is stored through withLineup', () => {
    const c = withLineup(defaultCareer(1), ROSTER.slice(0, 5).map((v) => v.id));
    expect(c.lineup).toHaveLength(5);
  });
});

describe('settings', () => {
  it('defaults to a match length the game actually offers', () => {
    // The settings screen renders `LENGTH_OPTIONS` as a segmented control and
    // highlights the entry equal to the stored value. A default that is not in
    // that list leaves a fresh career with nothing selected.
    const offered = LENGTH_OPTIONS.map((o) => o.halfSeconds);
    expect(offered).toContain(DEFAULT_SETTINGS.halfSeconds);
  });

  it('round-trips a change', () => {
    const c = withSettings(defaultCareer(1), {
      halfSeconds: 150,
      weather: 'ice',
      reducedMotion: true,
      sound: false,
    });
    expect(c.settings).toEqual({
      halfSeconds: 150,
      weather: 'ice',
      reducedMotion: true,
      sound: false,
    });
  });

  it('falls back to defaults for nonsense rather than storing it', () => {
    const c = withSettings(defaultCareer(1), { halfSeconds: -5, weather: 'lava' as never });
    expect(c.settings.halfSeconds).toBe(DEFAULT_SETTINGS.halfSeconds);
    expect(c.settings.weather).toBe('random');
  });

  it('starts with the sound on', () => {
    expect(DEFAULT_SETTINGS.sound).toBe(true);
  });

  it('leaves sound on for a career saved before the setting existed', () => {
    // Every career written before this setting existed has no `sound` key. The
    // only value that may mean "off" is an explicit `false` — anything else
    // would silently mute every returning player.
    localStorage.setItem(
      KEY,
      JSON.stringify({ season: 2, settings: { halfSeconds: 60, weather: 'sun', reducedMotion: true } }),
    );
    const c = loadCareer();
    expect(c?.settings.sound).toBe(true);
    expect(c?.settings.reducedMotion).toBe(true);
  });

  it('remembers sound being switched off', () => {
    saveCareer(withSettings(defaultCareer(1), { sound: false }));
    expect(loadCareer()?.settings.sound).toBe(false);
  });
});

describe('recording a result', () => {
  it('files it against the fixture without touching the others', () => {
    const f = playerFixtures()[0];
    const c = withResult(defaultCareer(1), f.id, 3, 1);
    expect(c.results[f.id]).toEqual({ home: 3, away: 1 });
    expect(Object.keys(c.results)).toHaveLength(1);
  });

  it('rounds and floors nonsense scores', () => {
    const c = withResult(defaultCareer(1), 'x|y', -2, 2.6);
    expect(c.results['x|y']).toEqual({ home: 0, away: 3 });
  });

  it('does not mutate the state it was given', () => {
    const before = defaultCareer(1);
    const after = withResult(before, 'a|b', 1, 0);
    expect(before.results).toEqual({});
    expect(after).not.toBe(before);
  });
});

describe('the season boundary', () => {
  it('is not complete until all twelve are played', () => {
    const fixtures = playerFixtures();
    let c = defaultCareer(1);
    expect(careerSeasonComplete(c)).toBe(false);

    for (const f of fixtures.slice(0, -1)) c = win(c, f);
    expect(careerSeasonComplete(c)).toBe(false);

    c = win(c, fixtures[fixtures.length - 1]);
    expect(careerSeasonComplete(c)).toBe(true);
  });

  it('files the finished season into the history and opens a new one', () => {
    const fixtures = playerFixtures();
    let c = defaultCareer(1);
    for (const f of fixtures) c = win(c, f);

    const next = startNextSeason(c, 99);
    expect(next.season).toBe(2);
    expect(next.seed).toBe(99);
    expect(next.results).toEqual({});
    expect(next.history).toHaveLength(1);
    expect(next.history[0].season).toBe(1);
    expect(next.history[0].played).toBe(12);
    expect(next.history[0].won).toBe(12);
    expect(next.history[0].lost).toBe(0);
    expect(next.history[0].gf).toBe(24);
  });

  it('carries the squad and the settings into the new season', () => {
    const lineup = ROSTER.slice(0, 5).map((v) => v.id);
    const c = withSettings(withLineup(defaultCareer(1), lineup), { halfSeconds: 60 });
    const next = startNextSeason(c, 2);
    expect(next.lineup).toEqual(lineup);
    expect(next.settings.halfSeconds).toBe(60);
  });

  it('keeps the most recent seasons first and the list bounded', () => {
    let c = defaultCareer(1);
    for (let i = 0; i < 25; i++) c = startNextSeason(c, i + 10);
    expect(c.history.length).toBeLessThanOrEqual(20);
    expect(c.history[0].season).toBe(25);
  });

  it('summarises the season in progress', () => {
    const fixtures = playerFixtures();
    const c = win(defaultCareer(1), fixtures[0], 4);
    const summary = currentSeasonSummary(c);
    expect(summary.season).toBe(1);
    expect(summary.played).toBe(1);
    expect(summary.gf).toBe(4);
  });
});

describe('storage', () => {
  it('round-trips a career', () => {
    const lineup = ROSTER.slice(0, 5).map((v) => v.id);
    const c = withSettings(withLineup(defaultCareer(5), lineup), { weather: 'rain' });
    expect(saveCareer(c)).toBe(true);
    const loaded = loadCareer();
    expect(loaded?.season).toBe(c.season);
    expect(loaded?.seed).toBe(5);
    expect(loaded?.lineup).toEqual(lineup);
    expect(loaded?.settings.weather).toBe('rain');
  });

  it('returns null when nothing is stored', () => {
    expect(loadCareer()).toBeNull();
  });

  it('forgets a career that has been cleared', () => {
    saveCareer(defaultCareer(1));
    clearCareer();
    expect(loadCareer()).toBeNull();
  });

  it('discards a corrupt record instead of throwing', () => {
    localStorage.setItem(KEY, '{ not json');
    expect(loadCareer()).toBeNull();
  });

  it('repairs a partial record rather than rejecting it', () => {
    localStorage.setItem(KEY, JSON.stringify({ season: 3, results: 'nonsense' }));
    const c = loadCareer();
    expect(c?.season).toBe(3);
    expect(c?.results).toEqual({});
    expect(c?.lineup).toEqual([]);
    expect(c?.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('drops results that are not two finite numbers', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        season: 1,
        results: { good: { home: 2, away: 1 }, bad: { home: 'x' }, worse: null },
      }),
    );
    expect(loadCareer()?.results).toEqual({ good: { home: 2, away: 1 } });
  });

  it('drops a saved five that has fallen out of the roster', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ season: 1, lineup: [ROSTER[0].id, 'ghost-viber'] }),
    );
    expect(loadCareer()?.lineup).toEqual([ROSTER[0].id]);
  });

  it('degrades instead of throwing when localStorage is missing', () => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    expect(loadCareer()).toBeNull();
    expect(saveCareer(defaultCareer(1))).toBe(false);
    expect(() => clearCareer()).not.toThrow();
  });
});
