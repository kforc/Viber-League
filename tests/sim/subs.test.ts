import { describe, expect, it } from 'vitest';
import {
  BENCH_SIZE,
  ROSTER,
  ROSTER_BY_ID,
  autoBench,
  autoOpponent,
  createWorld,
  flushCommands,
  overallOf,
  queue,
  step,
  substitute,
  TICK,
  type MatchConfig,
} from '../../src/sim';

/**
 * The bench and the substitution are the one place a manager can change the
 * team *during* a match, so the contract matters: a swap must move a Viber onto
 * the pitch without disturbing anything else in the world, and it must be
 * impossible for the same Viber to be in two places at once.
 */

const HOME = ['frost', 'moss', 'volt', 'cobalt', 'crimson'];

function cfg(seed = 7, benchIds?: string[]): MatchConfig {
  return {
    seed,
    homeIds: HOME,
    awayIds: autoOpponent(HOME, seed).ids,
    awayClubId: 'neon_rangers',
    weather: 'sun',
    halfSeconds: 120,
    benchIds,
  };
}

describe('the bench', () => {
  it('covers each outfield line and never includes a starter', () => {
    const bench = autoBench(HOME);
    expect(bench).toHaveLength(BENCH_SIZE);
    for (const id of bench) expect(HOME).not.toContain(id);
    const roles = bench.map((id) => ROSTER_BY_ID[id].role);
    expect(roles).toContain('DEF');
    expect(roles).toContain('MID');
    expect(roles).toContain('FWD');
  });

  it('never wastes a bench place on a second goalkeeper', () => {
    // One gloves slot, and the starter owns it — a benched keeper can never be
    // rotated in, so the place is better spent on outfield cover.
    const bench = autoBench(HOME);
    expect(bench.map((id) => ROSTER_BY_ID[id].role)).not.toContain('GK');
  });

  it('is carried into the world, on the human side only', () => {
    const bench = autoBench(HOME);
    const w = createWorld(cfg(7, bench));
    expect(w.bench[0].map((b) => b.viber)).toEqual(bench);
    expect(w.subsMade).toEqual([0, 0]);
    // The CPU does not rotate, so it carries no bench to rotate from.
    expect(w.bench[1]).toEqual([]);
  });

  it('gives a match with no bench an empty one, not a crash', () => {
    const w = createWorld(cfg(7));
    expect(w.bench[0]).toEqual([]);
  });
});

describe('a substitution', () => {
  it('puts the substitute in the outgoing player’s place, keeping their identity', () => {
    const bench = autoBench(HOME);
    const w = createWorld(cfg(7, bench));
    const out = w.players.find((p) => p.team === 0 && p.role === 'MID')!;
    const before = {
      id: out.id,
      slot: { ...out.slot },
      role: out.role,
      pos: { ...out.pos },
      isGK: out.isGK,
    };
    const inViber = bench[0];

    expect(substitute(w, 0, out.id, inViber)).toBe(true);

    // Identity is unchanged: the ball's owner, the set-piece taker and the
    // renderer's rigs are all keyed by id, and that id must survive the swap.
    expect(out.id).toBe(before.id);
    expect(out.slot).toEqual(before.slot);
    expect(out.role).toBe(before.role);
    expect(out.pos).toEqual(before.pos);
    expect(out.isGK).toBe(before.isGK);

    // The Viber, the name and the attributes are the substitute's.
    expect(out.viber).toBe(inViber);
    expect(out.name).toBe(ROSTER_BY_ID[inViber].name);
    expect(out.attrs).toEqual(ROSTER_BY_ID[inViber].attrs);

    // And the substitute leaves the bench — nobody can be in two places.
    expect(w.bench[0].map((b) => b.viber)).not.toContain(inViber);
    expect(w.subsMade[0]).toBe(1);
  });

  it('rejects a Viber who is not on the bench', () => {
    const w = createWorld(cfg(7, autoBench(HOME)));
    const out = w.players.find((p) => p.team === 0 && !p.isGK)!;
    const before = out.viber;
    expect(substitute(w, 0, out.id, 'not-on-the-bench')).toBe(false);
    expect(out.viber).toBe(before);
    expect(w.subsMade[0]).toBe(0);
  });

  it('rejects a player who is not on the pitch', () => {
    const w = createWorld(cfg(7, autoBench(HOME)));
    expect(substitute(w, 0, 9999, w.bench[0][0].viber)).toBe(false);
    expect(w.subsMade[0]).toBe(0);
  });

  it('cannot be made by the CPU, which has no bench', () => {
    const w = createWorld(cfg(7, autoBench(HOME)));
    const out = w.players.find((p) => p.team === 1)!;
    const before = out.viber;
    queue(w, { type: 'sub', team: 1, out: out.id, in: 'volt' });
    step(w, TICK);
    expect(out.viber).toBe(before);
    expect(w.subsMade[1]).toBe(0);
  });

  it('changes only the squad — not the clock, the ball or the score', () => {
    const w = createWorld(cfg(7, autoBench(HOME)));
    step(w, TICK);
    const clock = w.clock;
    const tick = w.tick;
    const ballPos = { ...w.ball.pos };
    const ballOwner = w.ball.owner;
    const score: [number, number] = [w.teams[0].score, w.teams[1].score];
    const out = w.players.find((p) => p.team === 0 && !p.isGK)!;

    substitute(w, 0, out.id, w.bench[0][0].viber);

    expect(w.clock).toBe(clock);
    expect(w.tick).toBe(tick);
    expect(w.ball.pos).toEqual(ballPos);
    expect(w.ball.owner).toBe(ballOwner);
    expect([w.teams[0].score, w.teams[1].score]).toEqual(score);
  });

  it('can be applied while the match is frozen, through the command queue', () => {
    const w = createWorld(cfg(7, autoBench(HOME)));
    w.paused = true;
    const out = w.players.find((p) => p.team === 0 && !p.isGK)!;
    const inViber = w.bench[0][0].viber;

    queue(w, { type: 'sub', team: 0, out: out.id, in: inViber });
    // `step()` returns early while paused, so the queue would never drain on
    // its own — which is exactly why the app flushes it explicitly.
    step(w, TICK);
    expect(out.viber).not.toBe(inViber);

    flushCommands(w);
    expect(out.viber).toBe(inViber);
    expect(w.subsMade[0]).toBe(1);
    // The match is still frozen.
    expect(w.paused).toBe(true);
  });
});

describe('the opponent is drawn against the whole matchday squad', () => {
  it('does not put a Viber on your bench into their starting five', () => {
    // A deliberately weak five, so the opponent comfortably out-rates it and
    // the "top up to the player's level" fallback never runs — which is the
    // only path that may legitimately reuse a Viber the player picked.
    const weak = [...ROSTER].sort((a, b) => overallOf(a) - overallOf(b)).slice(0, 5).map((v) => v.id);
    const bench = autoBench(weak);
    const opp = autoOpponent(weak, 7, undefined, bench);
    expect(opp.ids).toHaveLength(5);
    for (const id of bench) expect(opp.ids).not.toContain(id);
  });
});
