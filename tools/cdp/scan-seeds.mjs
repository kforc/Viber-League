// Dev-only: which seeds score early. Used to pin the celebration probe.
import { build } from 'esbuild';
const out = '/tmp/sim-bundle.mjs';
await build({ entryPoints: ['src/sim/index.ts'], format: 'esm', bundle: true, outfile: out, logLevel: 'error' });
const S = await import(out);
const HOME = ['frost', 'moss', 'volt', 'cobalt', 'crimson'];
const rows = [];
for (let seed = 1; seed <= 24; seed++) {
  const w = S.createWorld({
    seed, homeIds: HOME, awayIds: S.autoOpponent(HOME, seed).ids,
    awayClubId: 'neon_rangers', weather: 'sun', halfSeconds: 180,
  });
  let ticks = 0;
  while (ticks++ < 60 * 400 && w.phase !== 'goal') {
    if (w.phase === 'halftime') S.queue(w, { type: 'resume' });
    S.step(w, S.TICK);
  }
  rows.push({ seed, team: w.phase === 'goal' ? w.lastGoalTeam : null, ticks, sec: +(ticks / 60).toFixed(1) });
}
rows.sort((a, b) => a.ticks - b.ticks);
for (const r of rows.slice(0, 14)) console.log(JSON.stringify(r));
