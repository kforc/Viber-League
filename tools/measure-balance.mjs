// Dev-only: run a batch of headless matches and print scoring balance, so
// shooting/keeper tuning can be judged by numbers rather than a hunch.
//   node tools/measure-balance.mjs
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const out = path.join(os.tmpdir(), `sim-balance-${Date.now()}.mjs`);
const code = (
  await build({
    entryPoints: [fileURLToPath(new URL('../src/sim/index.ts', import.meta.url))],
    format: 'esm',
    bundle: true,
    write: false,
    platform: 'node',
  })
).outputFiles[0].text;
fs.writeFileSync(out, code);
const sim = await import(out);

const HOME = ['frost', 'moss', 'volt', 'cobalt', 'crimson'];
const cfg = (seed) => ({
  seed,
  homeIds: HOME,
  awayIds: sim.autoOpponent(HOME, seed).ids,
  awayClubId: 'neon_rangers',
  weather: 'sun',
  halfSeconds: 120,
});

const seeds = [11, 22, 33, 44, 55, 66, 77, 88, 99, 111];
const LONG = 9; // SHOOT_RANGE
let totGoals = 0, totShots = 0, totOn = 0, totSaves = 0;
let totLongShots = 0, totLongGoals = 0;
for (const seed of seeds) {
  const w = sim.createWorld(cfg(seed));
  let on = 0, saves = 0, longShots = 0, longGoals = 0;
  let lastShot = null; // { team, dist, tick }
  for (let i = 0; i < 60 * 250; i++) {
    if (w.phase === 'halftime') sim.queue(w, { type: 'resume' });
    sim.step(w, sim.TICK);
    for (const e of sim.drainEvents(w)) {
      if (e.type === 'shot') {
        const gx = e.team === 0 ? 20 : -20;
        const dist = Math.hypot(w.ball.pos.x - gx, w.ball.pos.y);
        if (e.onTarget) on++;
        if (dist > LONG) longShots++;
        lastShot = { team: e.team, dist, tick: w.tick };
      } else if (e.type === 'save') {
        saves++;
      } else if (e.type === 'goal') {
        // Attribute the goal to the shot that led to it, if it was recent.
        if (lastShot && lastShot.team === e.team && w.tick - lastShot.tick < 180) {
          if (lastShot.dist > LONG) longGoals++;
        }
      }
    }
  }
  const goals = w.teams[0].score + w.teams[1].score;
  const shots = w.stats.shots[0] + w.stats.shots[1];
  totGoals += goals; totShots += shots; totOn += on; totSaves += saves;
  totLongShots += longShots; totLongGoals += longGoals;
  console.log(
    `seed ${seed}: goals=${goals} shots=${shots} onTarget=${on} saves=${saves} ` +
    `longShots=${longShots} longGoals=${longGoals}`,
  );
}
const n = seeds.length;
console.log(
  `AVG/match goals=${(totGoals / n).toFixed(2)} shots=${(totShots / n).toFixed(1)} ` +
  `onTarget%=${(100 * totOn / Math.max(1, totShots)).toFixed(0)} saves=${(totSaves / n).toFixed(1)} ` +
  `longShots=${(totLongShots / n).toFixed(1)} longGoals/match=${(totLongGoals / n).toFixed(2)}`,
);
fs.rmSync(out, { force: true });
