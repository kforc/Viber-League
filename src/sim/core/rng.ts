// sim/core/rng.ts — deterministic PRNG. The ONLY source of randomness in sim/.

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform float in [lo, hi). */
  range(lo: number, hi: number): number;
  /** Uniform integer in [lo, hi]. */
  int(lo: number, hi: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  pick<T>(arr: readonly T[]): T;
  /** Current internal state (for save / replay). */
  state(): number;
  setState(s: number): void;
}

/**
 * mulberry32 — small, fast, deterministic. Same seed => same sequence,
 * which is what makes replays and async-PvP validation possible.
 */
export function makeRng(seed: number): Rng {
  let s = seed >>> 0;

  const next = (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    range: (lo, hi) => lo + next() * (hi - lo),
    int: (lo, hi) => Math.floor(lo + next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: <T,>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)],
    state: () => s,
    setState: (v: number) => {
      s = v >>> 0;
    },
  };
}
