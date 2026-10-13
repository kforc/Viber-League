import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  LEAGUE_SQUAD_MAX,
  SQUAD_SIZE,
  type CareerState,
  absenceCount,
  absencesFromEvents,
  careerSeasonComplete,
  clearCareer,
  currentSeasonSummary,
  defaultCareer,
  fitSquad,
  isAvailable,
  loadCareer,
  newLeague,
  sanitiseLineup,
  saveCareer,
  startNextSeason,
  tickAbsences,
  withAbsences,
  withLineup,
  withResult,
  withSettings,
} from '../../src/app/career';
import {
  CARD_CHANCE,
  RED_CARD_SHARE,
  ROSTER,
  ROSTER_BY_ID,
  awardFoul,
  autoOpponent,
  createWorld,
  drainEvents,
  isHomeFixture,
  makeRng,
  playerFixtures,
  type Fixture,
  type SimEvent,
} from '../../src/sim';
import { LENGTH_OPTIONS, displayLength } from '../../src/ui/screens';

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

  it('never holds more than a full squad', () => {
    const many = ROSTER.slice(0, LEAGUE_SQUAD_MAX + 3).map((v) => v.id);
    expect(sanitiseLineup(many)).toHaveLength(LEAGUE_SQUAD_MAX);
  });

  it('still fields only five of them', () => {
    // The cap and the starting eleven are different numbers and must stay that
    // way: the squad is depth, the five is what plays.
    expect(SQUAD_SIZE).toBe(5);
    expect(LEAGUE_SQUAD_MAX).toBeGreaterThan(SQUAD_SIZE);
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

  it('keeps a twelve-man squad intact through withLineup', () => {
    const twelve = ROSTER.slice(0, LEAGUE_SQUAD_MAX).map((v) => v.id);
    expect(withLineup(defaultCareer(1), twelve).lineup).toEqual(twelve);
  });
});

describe('injuries and suspensions', () => {
  const squad = ROSTER.slice(0, LEAGUE_SQUAD_MAX).map((v) => v.id);
  const base = (): CareerState => withLineup(defaultCareer(1), squad);

  it('starts with nobody out', () => {
    const c = base();
    expect(c.absences).toEqual({});
    expect(isAvailable(c, squad[0])).toBe(true);
    expect(fitSquad(c)).toHaveLength(LEAGUE_SQUAD_MAX);
  });

  it('takes an unavailable player out of the fit squad but not the squad', () => {
    const c = withAbsences(base(), { [squad[0]]: { kind: 'injury', matches: 2 } });
    expect(c.lineup).toContain(squad[0]);
    expect(isAvailable(c, squad[0])).toBe(false);
    // Order is preserved: the next fit player steps up rather than the list
    // being reordered, which is what makes `fitSquad(...).slice(0, 5)` the side.
    expect(fitSquad(c)).toEqual(squad.filter((id) => id !== squad[0]));
  });

  it('records a ban and an injury by kind', () => {
    const c = withAbsences(base(), {
      [squad[0]]: { kind: 'suspension', matches: 1 },
      [squad[1]]: { kind: 'injury', matches: 3 },
    });
    expect(c.absences[squad[0]]).toEqual({ kind: 'suspension', matches: 1 });
    expect(c.absences[squad[1]]).toEqual({ kind: 'injury', matches: 3 });
    expect(absenceCount(c)).toEqual({ injury: 1, suspension: 1 });
  });

  it('ignores a player the roster has never heard of', () => {
    // The sim reports what happened on the pitch; this records it. A player who
    // is not a Viber at all leaves nothing behind.
    const c = withAbsences(base(), { 'ghost-viber': { kind: 'injury', matches: 2 } });
    expect(c.absences).toEqual({});
  });

  it('records an absence even for a roster player outside the squad', () => {
    // An absence belongs to the PLAYER, not to a squad slot — see the note on
    // `sanitiseAbsences`. This is what stops "drop them, add them back" from
    // being a two-tap cure for an injury.
    const outsider = ROSTER[LEAGUE_SQUAD_MAX + 1].id;
    const c = withAbsences(base(), { [outsider]: { kind: 'injury', matches: 2 } });
    expect(c.absences[outsider]).toEqual({ kind: 'injury', matches: 2 });
    // ...but they are not one of the squad, so they are not one of "your" outs.
    expect(absenceCount(c)).toEqual({ injury: 0, suspension: 0 });
  });

  it('ignores an absence that has already run out', () => {
    const c = withAbsences(base(), { [squad[0]]: { kind: 'injury', matches: 0 } });
    expect(c.absences).toEqual({});
  });

  it('keeps the LONGER of two overlapping absences', () => {
    // A knock picked up while suspended must not let the player back early.
    let c = withAbsences(base(), { [squad[0]]: { kind: 'suspension', matches: 2 } });
    c = withAbsences(c, { [squad[0]]: { kind: 'injury', matches: 1 } });
    expect(c.absences[squad[0]]).toEqual({ kind: 'suspension', matches: 2 });

    c = withAbsences(c, { [squad[0]]: { kind: 'injury', matches: 4 } });
    expect(c.absences[squad[0]]).toEqual({ kind: 'injury', matches: 4 });
  });

  it('serves one fixture at a time and clears the player when it runs out', () => {
    let c = withAbsences(base(), { [squad[0]]: { kind: 'injury', matches: 2 } });
    c = tickAbsences(c);
    expect(c.absences[squad[0]]).toEqual({ kind: 'injury', matches: 1 });
    expect(isAvailable(c, squad[0])).toBe(false);

    c = tickAbsences(c);
    // Dropped, not stored as zero: a stale zero would read as "absent".
    expect(c.absences[squad[0]]).toBeUndefined();
    expect(isAvailable(c, squad[0])).toBe(true);
  });

  it('does not mutate the state it was given', () => {
    const before = withAbsences(base(), { [squad[0]]: { kind: 'injury', matches: 2 } });
    const after = tickAbsences(before);
    expect(before.absences[squad[0]].matches).toBe(2);
    expect(after).not.toBe(before);
  });

  it('does NOT heal a player who is dropped from the squad', () => {
    /*
     * The rule that makes the whole mechanic hold together. If an absence were
     * tied to squad membership, removing an injured player and adding them
     * straight back would be a free cure — two taps that erase the only reason
     * a squad is twelve rather than five. An injury is a fact about a
     * footballer, and it is the calendar that ends it, not the team sheet.
     */
    const c = withAbsences(base(), { [squad[0]]: { kind: 'injury', matches: 3 } });
    const trimmed = withLineup(c, squad.slice(1));
    expect(trimmed.lineup).not.toContain(squad[0]);
    expect(trimmed.absences[squad[0]]).toEqual({ kind: 'injury', matches: 3 });

    // And putting them back does not cure them either.
    const restored = withLineup(trimmed, squad);
    expect(restored.absences[squad[0]]).toEqual({ kind: 'injury', matches: 3 });
    expect(isAvailable(restored, squad[0])).toBe(false);
  });

  it('survives a save and a load', () => {
    const c = withAbsences(base(), {
      [squad[2]]: { kind: 'suspension', matches: 2 },
    });
    saveCareer(c);
    expect(loadCareer()?.absences[squad[2]]).toEqual({ kind: 'suspension', matches: 2 });
  });

  it('keeps a stored absence for a squad member who is no longer picked', () => {
    // The absence rides with the player, not the squad slot, so a stored record
    // for a roster player outside the two picked here is still valid. Only an
    // id the roster does not know is thrown away.
    localStorage.setItem(
      KEY,
      JSON.stringify({
        season: 1,
        lineup: [squad[0], squad[1]],
        absences: {
          [squad[0]]: { kind: 'injury', matches: 2 },
          ghost: { kind: 'injury', matches: 2 },
          [squad[9]]: { kind: 'suspension', matches: 1 },
        },
      }),
    );
    expect(loadCareer()?.absences).toEqual({
      [squad[0]]: { kind: 'injury', matches: 2 },
      [squad[9]]: { kind: 'suspension', matches: 1 },
    });
  });

  it('drops a stored absence with a nonsense count or kind', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        season: 1,
        lineup: [squad[0], squad[1], squad[2]],
        absences: {
          [squad[0]]: { kind: 'injury', matches: 0 },
          [squad[1]]: { kind: 'injury', matches: -4 },
          [squad[2]]: { kind: 'banana', matches: 2 },
        },
      }),
    );
    const c = loadCareer();
    expect(c?.absences[squad[0]]).toBeUndefined();
    expect(c?.absences[squad[1]]).toBeUndefined();
    // An unrecognised kind is an injury rather than a reason to lose the record.
    expect(c?.absences[squad[2]]).toEqual({ kind: 'injury', matches: 2 });
  });

  it('heals everyone over the close season', () => {
    const c = withAbsences(withLineup(defaultCareer(1), squad), {
      [squad[0]]: { kind: 'injury', matches: 3 },
      [squad[1]]: { kind: 'suspension', matches: 2 },
    });
    const next = startNextSeason(c, 2);
    // Starting a season with players already ruled out would be a punishment
    // with no way to have avoided it.
    expect(next.absences).toEqual({});
    expect(next.lineup).toEqual(squad);
  });
});

/**
 * The bridge from the pitch to the career.
 *
 * This is the one part of the discipline feature a unit test can otherwise
 * never reach: buried in the event switch in `game.ts` it could only be
 * exercised by playing a match in a real browser. And it is the part where a
 * mistake is SILENT — map the player id wrong and injuries simply never happen,
 * with nothing anywhere reporting a problem. So it is worth testing directly.
 */
describe('reading absences off a match', () => {
  const squad = ROSTER.slice(0, LEAGUE_SQUAD_MAX).map((v) => v.id);
  /** Stands in for the world's player table: sim id -> Viber id. */
  const table: Record<number, string> = {
    0: squad[0],
    1: squad[1],
    2: squad[2],
  };
  const viberOf = (id: number) => table[id];
  const card = (
    player: number,
    over: Partial<Extract<SimEvent, { type: 'card' }>> = {},
  ): SimEvent => ({
    type: 'card',
    team: 0,
    player,
    card: 'red',
    off: true,
    matches: 1,
    ...over,
  });

  it('turns a red card into a suspension of the length it carried', () => {
    expect(absencesFromEvents(viberOf, [card(0, { matches: 2 })])).toEqual({
      [squad[0]]: { kind: 'suspension', matches: 2 },
    });
  });

  it('ignores a yellow, which carries no ban in this game', () => {
    // A booking is shown and forgotten: there is no accumulation rule, and
    // inventing one would punish a player for something the referee never said.
    const yellow = card(0, { card: 'yellow', off: false, matches: 0 });
    expect(absencesFromEvents(viberOf, [yellow])).toEqual({});
  });

  it('turns an injury into a layoff', () => {
    const injury: SimEvent = { type: 'injury', team: 0, player: 1, matches: 3 };
    expect(absencesFromEvents(viberOf, [injury])).toEqual({
      [squad[1]]: { kind: 'injury', matches: 3 },
    });
  });

  it('ignores the CPU side, whose bans are none of the manager\'s business', () => {
    // Both sides field Vibers from the same roster. Without the team filter an
    // opponent's red card would ban a player who may be in the manager's own
    // squad — an absence with no cause the player could ever see.
    const theirs: SimEvent = { type: 'injury', team: 1, player: 0, matches: 2 };
    expect(absencesFromEvents(viberOf, [theirs])).toEqual({});
    // ...and the same event on the human's side is recorded.
    const ours: SimEvent = { type: 'injury', team: 0, player: 0, matches: 2 };
    expect(absencesFromEvents(viberOf, [ours])).toEqual({
      [squad[0]]: { kind: 'injury', matches: 2 },
    });
  });

  it('drops a card it cannot map back to a Viber rather than guessing', () => {
    // Degrading to "no ban" is the only safe direction: the alternative is
    // banning the wrong player.
    expect(absencesFromEvents(viberOf, [card(99, { matches: 2 })])).toEqual({});
    expect(absencesFromEvents(() => undefined, [card(0)])).toEqual({});
  });

  it('keeps the LONGER of two absences in the same match', () => {
    // A player sent off and then hurt, or booked twice in the notebook, must
    // serve the longer punishment — never the shorter of the two.
    const events: SimEvent[] = [
      card(0, { matches: 1 }),
      { type: 'injury', team: 0, player: 0, matches: 3 },
    ];
    expect(absencesFromEvents(viberOf, events)).toEqual({
      [squad[0]]: { kind: 'injury', matches: 3 },
    });
  });

  it('reads a whole match at once, keeping each player separate', () => {
    const events: SimEvent[] = [
      { type: 'goal', team: 0, scorer: 0, minute: 12 },
      card(1, { matches: 2 }),
      { type: 'injury', team: 0, player: 2, matches: 1 },
      { type: 'injury', team: 1, player: 0, matches: 3 },
    ];
    expect(absencesFromEvents(viberOf, events)).toEqual({
      [squad[1]]: { kind: 'suspension', matches: 2 },
      [squad[2]]: { kind: 'injury', matches: 1 },
    });
  });

  it('is empty for a match nobody was hurt in', () => {
    // The common case, and the one that must never accidentally book anyone.
    const events: SimEvent[] = [
      { type: 'goal', team: 0, scorer: 1, minute: 30 },
      card(2, { card: 'yellow', off: false, matches: 0 }),
      { type: 'whistle', kind: 'fulltime' },
    ];
    expect(absencesFromEvents(viberOf, events)).toEqual({});
  });

  it('ignores an absence with no fixtures left on it', () => {
    // A zero-length ban is not an absence; recording it would put a fit player
    // in the treatment room.
    const events: SimEvent[] = [
      card(0, { matches: 0 }),
      { type: 'injury', team: 0, player: 1, matches: 0 },
    ];
    expect(absencesFromEvents(viberOf, events)).toEqual({});
  });

  it('does not mutate the events it was given', () => {
    const events: SimEvent[] = [card(0, { matches: 2 })];
    const snapshot = JSON.stringify(events);
    absencesFromEvents(viberOf, events);
    expect(JSON.stringify(events)).toBe(snapshot);
  });
});

/**
 * The same conversion, but against a REAL world rather than a hand-built table.
 *
 * The block above proves the mapping logic is right. This proves the mapping
 * itself: that the field names and id semantics `enterResult` reads off a live
 * world really do line up. That is the failure mode with no symptom at all — a
 * wrong field here and injuries simply never happen, silently, in the shipped
 * game, with every other test still green.
 *
 * Deliberately not a whole match: one forced foul against a freshly built world
 * exercises the same contract in milliseconds.
 */
describe('the bridge from the pitch to the career', () => {
  /** The first discipline state that opens with a red card. */
  function stateOpeningWithRedCard(): number {
    for (let s = 1; s < 200_000; s++) {
      const r = makeRng(s);
      if (r.chance(CARD_CHANCE) && r.chance(RED_CARD_SHARE)) return s;
    }
    throw new Error('no discipline state opens with a red card');
  }

  it('records a real send-off against the Viber who was actually playing', () => {
    const lineup = ROSTER.slice(0, LEAGUE_SQUAD_MAX).map((v) => v.id);
    const starters = lineup.slice(0, SQUAD_SIZE);
    const w = createWorld({
      seed: 7,
      homeIds: starters,
      awayIds: autoOpponent(starters, 7).ids,
      awayClubId: 'neon_rangers',
      weather: 'sun',
      halfSeconds: 90,
    });

    const offender = w.players.find((p) => p.team === 0 && !p.isGK)!;
    w.phase = 'play';
    w.disciplineRng.setState(stateOpeningWithRedCard());
    awardFoul(w, offender, false);

    const events = drainEvents(w);
    const sentOff = events.find(
      (e): e is Extract<SimEvent, { type: 'card' }> => e.type === 'card' && e.card === 'red',
    );
    expect(sentOff).toBeDefined();
    if (!sentOff) throw new Error('unreachable');

    // Exactly the lambda `enterResult` passes.
    const picked = absencesFromEvents(
      (id) => w.players.find((p) => p.id === id)?.viber,
      events,
    );

    const viber = w.players.find((p) => p.id === offender.id)!.viber;
    expect(picked[viber]).toEqual({ kind: 'suspension', matches: sentOff.matches });
    // ...and it is a Viber the career will accept, not a name that silently
    // falls through `sanitiseAbsences`.
    expect(ROSTER_BY_ID[viber]).toBeDefined();
    // A send-off is a ban, so it must be a real absence and not a zero.
    expect(sentOff.matches).toBeGreaterThan(0);
  });

  it('carries the ban into the career, where it costs the player a fixture', () => {
    // The whole chain, end to end: a foul on the pitch becomes a Viber sitting
    // out a league game.
    const lineup = ROSTER.slice(0, LEAGUE_SQUAD_MAX).map((v) => v.id);
    const starters = lineup.slice(0, SQUAD_SIZE);
    const w = createWorld({
      seed: 7,
      homeIds: starters,
      awayIds: autoOpponent(starters, 7).ids,
      awayClubId: 'neon_rangers',
      weather: 'sun',
      halfSeconds: 90,
    });
    const offender = w.players.find((p) => p.team === 0 && !p.isGK)!;
    w.phase = 'play';
    w.disciplineRng.setState(stateOpeningWithRedCard());
    awardFoul(w, offender, false);

    const picked = absencesFromEvents(
      (id) => w.players.find((p) => p.id === id)?.viber,
      drainEvents(w),
    );
    const career = withAbsences(withLineup(defaultCareer(1), lineup), picked);
    const banned = w.players.find((p) => p.id === offender.id)!.viber;

    expect(isAvailable(career, banned)).toBe(false);
    expect(fitSquad(career)).not.toContain(banned);
    expect(absenceCount(career).suspension).toBe(1);
  });
});

describe('a new league', () => {
  const squad = ROSTER.slice(0, 5).map((v) => v.id);

  it('clears the season, the table, the history and the injury list', () => {
    const f = playerFixtures()[0];
    let c = withAbsences(withLineup(defaultCareer(1), squad), {
      [squad[0]]: { kind: 'injury', matches: 2 },
    });
    c = win(c, f);
    c = startNextSeason(c, 2);

    const fresh = newLeague(c, 99);
    expect(fresh.season).toBe(1);
    expect(fresh.seed).toBe(99);
    expect(fresh.results).toEqual({});
    expect(fresh.history).toEqual([]);
    expect(fresh.absences).toEqual({});
  });

  it('keeps the club and the squad the manager built', () => {
    // Starting a new LEAGUE is not starting a new CLUB. Erasing the club is a
    // different action, in Settings, and it says so.
    const c = withSettings(withLineup(defaultCareer(1), squad), { halfSeconds: 60 });
    const fresh = newLeague(c, 99);
    expect(fresh.lineup).toEqual(squad);
    expect(fresh.settings.halfSeconds).toBe(60);
    expect(fresh.createdAt).toBe(c.createdAt);
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

  /*
   * The conditions strip shows the length twice — on the venue screen and in the
   * HUD — and both go through `displayLength`. A screenshot is what caught this
   * the first time: `halfSeconds` is only "a positive number" to the career, so
   * anything that is not a whole number of minutes used to render its raw float.
   * The dev harness pins a two-second half, which is exactly that case, and the
   * venue screen was still printing `0.06666666666666667 min` after the HUD had
   * been fixed.
   */
  it('never prints a raw float for a match length', () => {
    for (const seconds of [2, 5, 30, 45]) {
      const shown = displayLength(seconds);
      expect(shown).not.toMatch(/\d{5,}/);
      expect(shown.length).toBeLessThan(10);
    }
    // Every length the game actually offers reads as a clean whole minute.
    for (const o of LENGTH_OPTIONS) {
      expect(displayLength(o.halfSeconds)).toBe(`${(o.halfSeconds * 2) / 60} min`);
    }
    // And the degenerate values a hand-edited save could carry do not throw.
    expect(displayLength(0)).toBe('--');
    expect(displayLength(-5)).toBe('--');
    expect(displayLength(Number.NaN)).toBe('--');
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
