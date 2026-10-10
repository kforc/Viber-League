// app/profile.ts — the player's local profile.
//
// SCOPE: this is a DEVICE-LOCAL profile, not an account. It lives in
// localStorage, so it survives reloads and browser restarts on this machine and
// nothing else — clearing site data, or opening the game on another device,
// starts over. That is a deliberate, user-approved interim choice: the managed
// cloud backend (real accounts that follow the player between devices) was
// unavailable when this was built.
//
// Everything that touches persistence is behind this module on purpose.
// Upgrading to cloud accounts later means rewriting the functions in this file,
// not the screens and not the game.
//
// The password is never stored. It is run through PBKDF2-SHA256 with a random
// per-profile salt and only the derived hash is kept, so the profile is locked
// against a casual takeover on a shared device. It is not, and cannot be,
// protection against someone with access to the device's storage.

export interface LocalProfile {
  /** The player's name. This is the "username" the player chose. */
  manager: string;
  /** The club (team) name, shown in-game. */
  club: string;
  /** Derived abbreviation for the scoreboard, e.g. "Riverside Rovers" → "RR". */
  short: string;
  /** The club's chosen crest (see brand.ts). */
  icon: IconId;
  /** PBKDF2-SHA256 hash, base64. `null` when no password was set. */
  hash: string | null;
  /** Random salt, base64. `null` when no password was set. */
  salt: string | null;
  iterations: number;
  createdAt: string;
}

const STORAGE_KEY = 'viber-league:profile:v1';
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

/** Limits are shared with the onboarding form so the UI and the store agree. */
export const PROFILE_LIMITS = {
  managerMin: 2,
  managerMax: 18,
  clubMin: 2,
  clubMax: 24,
  passwordMin: 6,
} as const;

/* ------------------------------------------------------------------ */
/* Short name                                                          */
/* ------------------------------------------------------------------ */

// The abbreviation rule lives in sim/content.ts beside the club definitions,
// because the onboarding screen needs it too and both layers already import
// that module. Imported for local use and re-exported so callers of the profile
// store have a single import.
import { deriveShort } from '../sim/content';
import { asIconId, type IconId } from '../brand';

export { deriveShort };

/* ------------------------------------------------------------------ */
/* Hashing                                                             */
/* ------------------------------------------------------------------ */

/** `crypto.subtle` needs a secure context; it is absent in a few sandboxes. */
export function canHashPassword(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';
}

function toBase64(buf: ArrayBuffer): string {
  let out = '';
  for (const byte of new Uint8Array(buf)) out += String.fromCharCode(byte);
  return btoa(out);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pbkdf2(password: string, saltB64: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const salt = fromBase64(saltB64);
  const bits = await crypto.subtle.deriveBits(
    // `salt.buffer` is typed as `ArrayBufferLike`; the view is freshly
    // allocated and whole, so the backing store is an ordinary ArrayBuffer.
    { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations, hash: 'SHA-256' },
    key,
    KEY_BITS,
  );
  return toBase64(bits);
}

/** Length-independent comparison, so a wrong password leaks no timing signal. */
function equalHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

export function storageAvailable(): boolean {
  try {
    const probe = '__viber_league_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

export function loadProfile(): LocalProfile | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<LocalProfile>;
    if (typeof p?.manager !== 'string' || typeof p?.club !== 'string') return null;
    if (!p.manager.trim() || !p.club.trim()) return null;
    return {
      manager: p.manager,
      club: p.club,
      short: typeof p.short === 'string' && p.short ? p.short : deriveShort(p.club),
      // Every profile written before the crest picker existed has no `icon`.
      // Those players get the Viber mark rather than a broken badge.
      icon: asIconId(p.icon),
      hash: typeof p.hash === 'string' ? p.hash : null,
      salt: typeof p.salt === 'string' ? p.salt : null,
      iterations: typeof p.iterations === 'number' ? p.iterations : PBKDF2_ITERATIONS,
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveProfile(profile: LocalProfile): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
    return true;
  } catch {
    return false;
  }
}

export function clearProfile(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do — the profile was never readable */
  }
}

/* ------------------------------------------------------------------ */
/* Create / verify                                                     */
/* ------------------------------------------------------------------ */

export async function createProfile(input: {
  manager: string;
  club: string;
  icon: IconId;
  password: string;
}): Promise<LocalProfile> {
  const manager = input.manager.trim();
  const club = input.club.trim();

  let hash: string | null = null;
  let salt: string | null = null;
  if (input.password && canHashPassword()) {
    const saltBytes = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    salt = toBase64(saltBytes.buffer as ArrayBuffer);
    hash = await pbkdf2(input.password, salt, PBKDF2_ITERATIONS);
  }

  const profile: LocalProfile = {
    manager,
    club,
    short: deriveShort(club),
    icon: asIconId(input.icon),
    hash,
    salt,
    iterations: PBKDF2_ITERATIONS,
    createdAt: new Date().toISOString(),
  };
  saveProfile(profile);
  return profile;
}

/**
 * `true` when the password matches — or when the profile has no password at
 * all (a browser without `crypto.subtle` creates one that way).
 */
export async function verifyPassword(profile: LocalProfile, password: string): Promise<boolean> {
  if (!profile.hash || !profile.salt) return true;
  if (!canHashPassword()) return false;
  const attempt = await pbkdf2(password, profile.salt, profile.iterations || PBKDF2_ITERATIONS);
  return equalHash(attempt, profile.hash);
}
