import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveShort, PLAYER_CLUB, setPlayerClubIdentity } from '../../src/sim/content';
import {
  PROFILE_LIMITS,
  canHashPassword,
  clearProfile,
  createProfile,
  loadProfile,
  saveProfile,
  storageAvailable,
  verifyPassword,
  type LocalProfile,
} from '../../src/app/profile';

/**
 * The profile is the one piece of state that outlives a reload, so these tests
 * are about the two ways it can quietly go wrong: a club name that abbreviates
 * into something wrong on the scoreboard, and a password that either does not
 * come back or comes back for the wrong person.
 *
 * The environment is plain Node, which has WebCrypto but no `localStorage`.
 * That is useful twice over: it exercises the real `crypto.subtle` path, and it
 * proves the store degrades instead of throwing when storage is missing.
 */

/* ------------------------------------------------------------------ */
/* A minimal localStorage, so the store's own storage path is covered   */
/* ------------------------------------------------------------------ */

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

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

/* ------------------------------------------------------------------ */
/* Short name — what actually lands on the scoreboard                  */
/* ------------------------------------------------------------------ */

describe('deriveShort', () => {
  it('takes the initials of a multi-word club', () => {
    expect(deriveShort('Riverside Rovers')).toBe('RR');
    expect(deriveShort('Neon Rangers')).toBe('NR');
    expect(deriveShort('Frostbite FC')).toBe('FF');
  });

  it('uses the first three letters of a single word', () => {
    expect(deriveShort('Volt')).toBe('VOL');
    expect(deriveShort('FC')).toBe('FC');
    expect(deriveShort('a')).toBe('A');
  });

  it('splits on hyphens, dots and underscores, not just spaces', () => {
    expect(deriveShort('neon-rangers')).toBe('NR');
    expect(deriveShort('Iron.clad_Wolves')).toBe('ICW');
  });

  it('caps the abbreviation at four characters', () => {
    expect(deriveShort('Alpha Bravo Charlie Delta Echo')).toBe('ABCD');
  });

  it('never returns an empty badge', () => {
    expect(deriveShort('')).toBe('YOU');
    expect(deriveShort('   ')).toBe('YOU');
    expect(deriveShort('!!!')).toBe('YOU');
    expect(deriveShort('...')).toBe('YOU');
  });

  it('ignores surrounding whitespace', () => {
    expect(deriveShort('  Viber League  ')).toBe('VL');
  });
});

/* ------------------------------------------------------------------ */
/* Club identity — the sim side of the profile                         */
/* ------------------------------------------------------------------ */

describe('setPlayerClubIdentity', () => {
  const name = PLAYER_CLUB.name;
  const short = PLAYER_CLUB.short;
  afterEach(() => {
    PLAYER_CLUB.name = name;
    PLAYER_CLUB.short = short;
  });

  it('renames the club the world is built from', () => {
    setPlayerClubIdentity('Riverside Rovers', 'RR');
    expect(PLAYER_CLUB.name).toBe('Riverside Rovers');
    expect(PLAYER_CLUB.short).toBe('RR');
  });

  it('ignores a blank name or abbreviation rather than erasing the club', () => {
    setPlayerClubIdentity('   ', '');
    expect(PLAYER_CLUB.name).toBe(name);
    expect(PLAYER_CLUB.short).toBe(short);
  });

  it('keeps the abbreviation within the four characters the scoreboard has room for', () => {
    setPlayerClubIdentity('Long', 'ABCDEFGH');
    expect(PLAYER_CLUB.short).toBe('ABCD');
  });
});

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

describe('profile storage', () => {
  beforeEach(() => useMemoryStorage());

  const sample: LocalProfile = {
    manager: 'Alex',
    club: 'Riverside Rovers',
    short: 'RR',
    icon: 'voxel',
    hash: null,
    salt: null,
    iterations: 100_000,
    createdAt: '2026-10-09T00:00:00.000Z',
  };

  it('reports storage as available when it can write', () => {
    expect(storageAvailable()).toBe(true);
  });

  it('round-trips a profile', () => {
    expect(saveProfile(sample)).toBe(true);
    expect(loadProfile()).toEqual(sample);
  });

  it('returns null when nothing has been saved', () => {
    expect(loadProfile()).toBeNull();
  });

  it('forgets a profile that has been cleared', () => {
    saveProfile(sample);
    clearProfile();
    expect(loadProfile()).toBeNull();
  });

  it('discards corrupt or incomplete records instead of throwing', () => {
    localStorage.setItem('viber-league:profile:v1', '{ not json');
    expect(loadProfile()).toBeNull();

    localStorage.setItem('viber-league:profile:v1', JSON.stringify({ manager: 'Alex' }));
    expect(loadProfile()).toBeNull();

    localStorage.setItem(
      'viber-league:profile:v1',
      JSON.stringify({ manager: '   ', club: 'Rovers' }),
    );
    expect(loadProfile()).toBeNull();
  });

  it('re-derives a missing abbreviation rather than trusting a partial record', () => {
    localStorage.setItem(
      'viber-league:profile:v1',
      JSON.stringify({ manager: 'Alex', club: 'Riverside Rovers' }),
    );
    const loaded = loadProfile();
    expect(loaded?.short).toBe('RR');
    expect(loaded?.iterations).toBe(100_000);
  });
});

describe('profile storage when localStorage is unavailable', () => {
  beforeEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('degrades instead of throwing', () => {
    expect(storageAvailable()).toBe(false);
    expect(loadProfile()).toBeNull();
    expect(saveProfile({} as LocalProfile)).toBe(false);
    expect(() => clearProfile()).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* Password                                                            */
/* ------------------------------------------------------------------ */

describe('password hashing', () => {
  beforeEach(() => useMemoryStorage());

  it('never stores the password itself', async () => {
    const profile = await createProfile({
      manager: 'Alex',
      club: 'Riverside Rovers',
      icon: 'viber',
      password: 'hunter2secret',
    });

    expect(profile.hash).toBeTruthy();
    expect(profile.salt).toBeTruthy();
    expect(JSON.stringify(profile)).not.toContain('hunter2secret');
  });

  it('accepts the right password and rejects a wrong one', async () => {
    const profile = await createProfile({
      manager: 'Alex',
      club: 'Riverside Rovers',
      icon: 'viber',
      password: 'hunter2secret',
    });

    await expect(verifyPassword(profile, 'hunter2secret')).resolves.toBe(true);
    await expect(verifyPassword(profile, 'hunter2secre')).resolves.toBe(false);
    await expect(verifyPassword(profile, '')).resolves.toBe(false);
  });

  it('salts each profile separately, so identical passwords hash differently', async () => {
    const a = await createProfile({
      manager: 'A',
      club: 'Alpha',
      icon: 'spike',
      password: 'same-password',
    });
    const b = await createProfile({
      manager: 'B',
      club: 'Bravo',
      icon: 'shield',
      password: 'same-password',
    });

    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it('leaves an unprotected profile open, and says so', async () => {
    const profile = await createProfile({
      manager: 'Alex',
      club: 'Rovers',
      icon: 'viber',
      password: '',
    });

    expect(profile.hash).toBeNull();
    expect(profile.salt).toBeNull();
    await expect(verifyPassword(profile, '')).resolves.toBe(true);
    await expect(verifyPassword(profile, 'anything')).resolves.toBe(true);
  });

  it('stores the derived abbreviation with the club', async () => {
    const profile = await createProfile({
      manager: 'Alex',
      club: 'Riverside Rovers',
      icon: 'viber',
      password: 'hunter2secret',
    });
    expect(profile.short).toBe('RR');
    expect(loadProfile()?.short).toBe('RR');
  });

  it('reports whether the browser can hash at all', () => {
    // The test runner is Node, which always has WebCrypto — so this asserts the
    // probe works rather than that it can fail.
    expect(typeof canHashPassword()).toBe('boolean');
    expect(canHashPassword()).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* The crest the player picked                                         */
/* ------------------------------------------------------------------ */

describe('the club crest', () => {
  beforeEach(() => useMemoryStorage());

  it('is stored with the profile and comes back on the next load', async () => {
    const profile = await createProfile({
      manager: 'Alex',
      club: 'Riverside Rovers',
      icon: 'crown',
      password: 'hunter2secret',
    });

    expect(profile.icon).toBe('crown');
    expect(loadProfile()?.icon).toBe('crown');
  });

  it('falls back to the Viber mark for a club saved before the picker existed', () => {
    // Every profile written by an earlier build has no `icon` key at all. The
    // crest must degrade to the house mark, not to a blank badge.
    localStorage.setItem(
      'viber-league:profile:v1',
      JSON.stringify({ manager: 'Alex', club: 'Riverside Rovers' }),
    );
    expect(loadProfile()?.icon).toBe('viber');
  });

  it('discards a crest it does not recognise rather than drawing nothing', () => {
    localStorage.setItem(
      'viber-league:profile:v1',
      JSON.stringify({ manager: 'Alex', club: 'Rovers', icon: 'dragon' }),
    );
    expect(loadProfile()?.icon).toBe('viber');
  });
});

describe('profile limits', () => {
  it('are sane, and the password floor is a real one', () => {
    expect(PROFILE_LIMITS.managerMin).toBeGreaterThanOrEqual(1);
    expect(PROFILE_LIMITS.managerMax).toBeGreaterThan(PROFILE_LIMITS.managerMin);
    expect(PROFILE_LIMITS.clubMin).toBeGreaterThanOrEqual(1);
    expect(PROFILE_LIMITS.clubMax).toBeGreaterThan(PROFILE_LIMITS.clubMin);
    expect(PROFILE_LIMITS.passwordMin).toBeGreaterThanOrEqual(6);
  });

  it('keeps the club name inside the length the crest and the scoreboard allow', () => {
    expect(PROFILE_LIMITS.clubMax).toBeLessThanOrEqual(24);
  });
});
