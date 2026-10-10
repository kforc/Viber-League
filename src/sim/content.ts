// sim/content.ts — typed content registries (spec §19/§20: content is data).

import type { Role } from './types';
import type { Vec2 } from './core/math';

/** 5-a-side formation: 1 GK + 4 outfield. Normalized slots. */
export interface FormationDef {
  id: string;
  name: string;
  /** Ordered slots. x: -1 own goal .. 1 opponent goal. y: -1 .. 1. */
  slots: Array<{ role: Role; pos: Vec2 }>;
}

export const FORMATIONS: Record<string, FormationDef> = {
  '5-1-2-1': {
    id: '5-1-2-1',
    name: 'Diamond',
    slots: [
      { role: 'GK', pos: { x: -0.92, y: 0 } },
      { role: 'DEF', pos: { x: -0.45, y: 0 } },
      { role: 'MID', pos: { x: -0.05, y: -0.42 } },
      { role: 'MID', pos: { x: -0.05, y: 0.42 } },
      { role: 'FWD', pos: { x: 0.5, y: 0 } },
    ],
  },
};

export interface ClubDef {
  id: string;
  name: string;
  short: string;
  color: number;
  accent: number;
  /** Difficulty tier 0 (weakest) .. 5 (strongest). Used by auto-opponent. */
  tier: number;
}

/**
 * The player's club.
 *
 * The name here is a *stand-in*, never a real club. `setPlayerClubIdentity`
 * overwrites both fields from the saved profile before the first frame, so the
 * only way to ever see these values is a browser that blocks local storage —
 * where the player genuinely has no club yet. The old default ("Vibe Vibe
 * United") was invented filler, and it showed up on the scoreboard and the squad
 * screen as a team nobody had chosen.
 */
export const PLAYER_CLUB: ClubDef = {
  id: 'vibe_united',
  name: 'Your Club',
  short: 'YOU',
  // The brand lime. The old 0x2f6df6 was a leftover from the washed-out blue
  // palette the design brief rejects, and it made the user's side read
  // identically to a blue CPU club on the opponent screen — you could not tell
  // which half of the VS card was yours.
  color: 0xdff902,
  accent: 0x0c0f08,
  tier: 0,
};

/** Opponent clubs, one band per difficulty tier. */
export const OPPONENT_CLUBS: ClubDef[] = [
  { id: 'rookie_rovers', name: 'Rookie Rovers', short: 'ROV', color: 0x8ab24a, accent: 0x1b2a10, tier: 0 },
  { id: 'neon_rangers', name: 'Neon Rangers', short: 'NEON', color: 0xff5db1, accent: 0x1b0d2a, tier: 1 },
  { id: 'ironworks', name: 'Ironworks FC', short: 'IRN', color: 0xc0653a, accent: 0x2a1408, tier: 2 },
  { id: 'vortex', name: 'Vortex Athletic', short: 'VTX', color: 0x34a2f7, accent: 0x08192a, tier: 3 },
  { id: 'titan', name: 'Titan United', short: 'TTN', color: 0x7b5cff, accent: 0x150a33, tier: 4 },
  { id: 'apex', name: 'Apex Legion', short: 'APX', color: 0xd93a2b, accent: 0x1a0805, tier: 5 },
];

export const CLUBS: Record<string, ClubDef> = Object.fromEntries(
  [PLAYER_CLUB, ...OPPONENT_CLUBS].map((c) => [c.id, c]),
);

/**
 * "Riverside Rovers" → "RR", "Riverside" → "RIV", "" → "YOU".
 *
 * Lives here, beside the club definitions, because it is a naming rule about
 * clubs rather than anything to do with storage or presentation — both the
 * profile store and the onboarding screen need it, and this is the one module
 * they already share. Pure: no DOM, no I/O.
 *
 * Multi-word names use initials; a single word uses its first three letters.
 * Capped at four characters because the scoreboard and the VS card render it
 * beside three- and four-letter CPU clubs (ROV, NEON, VTX …).
 */
export function deriveShort(club: string): string {
  const words = club
    .trim()
    .split(/[\s\-_.]+/)
    .filter(Boolean);

  if (words.length >= 2) {
    const initials = words
      .map((w) => w.replace(/[^A-Za-z0-9]/g, '')[0] ?? '')
      .join('');
    if (initials.length >= 2) return initials.slice(0, 4).toUpperCase();
  }

  const single = words.join('').replace(/[^A-Za-z0-9]/g, '');
  return (single.slice(0, 3) || 'YOU').toUpperCase();
}

/**
 * Rename the player's club from their saved profile.
 *
 * `CLUBS` stores the *same object reference* as `PLAYER_CLUB`, so mutating the
 * fields here is enough — no registry rebuild, and nothing that already holds a
 * reference goes stale. Call this before `createWorld`, which copies `name`,
 * `short` and `color` onto the team.
 *
 * No DOM and no storage in here: this is the sim layer being told a fact.
 */
export function setPlayerClubIdentity(name: string, short: string): void {
  const cleanName = name.trim();
  const cleanShort = short.trim().toUpperCase();
  if (cleanName) PLAYER_CLUB.name = cleanName;
  if (cleanShort) PLAYER_CLUB.short = cleanShort.slice(0, 4);
}
