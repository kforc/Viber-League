// Dev-only: regression probe for the penalty screen-axis fix. Verifies that
// (a) the "right" placement launches to world -Y == screen-right (vy < 0), and
// (b) a MISALIGNED guess is still a goal while an aligned guess saves. Run after
// `npm run bundle`:
//   tools/cdp/run.sh tools/cdp/probe-penalty-save.mjs docs/screens-penalty-save
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const port = Number(process.env.CDP_PORT || 9333);
const outDir = path.resolve(process.env.OUT_DIR || 'docs/screens-penalty-save');
const width = Number(process.env.VW || 844);
const height = Number(process.env.VH || 390);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync(outDir, { recursive: true });

const sim = (await build({
  entryPoints: [fileURLToPath(new URL('../../src/sim/index.ts', import.meta.url))],
  format: 'iife', globalName: 'TestSim', bundle: true, write: false,
})).outputFiles[0].text;
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url !== 'about:blank') ?? list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const errors = [];
function send(method, params = {}, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    const timer = setTimeout(() => { pending.delete(mid); reject(new Error(`TIMEOUT ${method}`)); }, timeout);
    pending.set(mid, { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
ws.addEventListener('message', ({ data }) => {
  const m = JSON.parse(data);
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || 'unknown');
  if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }
});
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
const evaluate = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval'); return r.result?.value; };
const until = async (p, t = 40000) => { const d = Date.now() + t; while (Date.now() < d) { if (await evaluate(p)) return true; await sleep(150); } throw new Error(`timeout ${p}`); };
const check = (l, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${l}`); if (!ok) failures++; };
let failures = 0;
const laneOf = (vy) => (vy < -0.3 ? 'left' : vy > 0.3 ? 'right' : 'centre');
const opposite = (lane) => (lane === 'left' ? 'right' : 'left');

const url = new URL(process.argv[2]);
url.searchParams.set('autostart', '');
await send('Page.navigate', { url: url.toString() });
await until('!!window.game?.world && window.game.state === "match" && !window.game.world.paused');
await evaluate(sim + '\n;0');

async function strike(penaltyTeam, pickIndex, forceWrong) {
  await evaluate(`(() => { const w = window.game.world; const def = w.players.find((p) => p.team === ${penaltyTeam} && p.role === 'DEF'); TestSim.awardFoul(w, def, true); return 1; })()`);
  await until('!!document.querySelector(".penalty-panel")');
  await evaluate(`document.querySelectorAll('.dive-btn')[${pickIndex}].click()`);
  await until('window.game.state === "match" && !window.game.world.paused');
  await evaluate(`(() => { const w = window.game.world; let g = 0; while (w.phase !== 'penaltyshot' && g++ < 60 * 5) TestSim.step(w, TestSim.TICK); return w.phase; })()`);
  const pre = await evaluate(`(() => { const w = window.game.world; return { vy: w.ball.vel.y, shootTeam: w.penaltyShot.team, scoreBefore: w.teams.map((t) => t.score) }; })()`);
  if (forceWrong) {
    await evaluate(`(() => { const w = window.game.world; const vy = w.ball.vel.y; const ballLane = vy < -0.3 ? 'left' : vy > 0.3 ? 'right' : 'centre'; w.penaltyShot.dive = ${opposite.toString()}(ballLane); return w.penaltyShot.dive; })()`);
  }
  const post = await evaluate(`(() => { const w = window.game.world; const shootTeam = w.penaltyShot.team; const scoreBefore = w.teams.map((t) => t.score); let g = 0; while (w.penaltyShot && g++ < 60 * 5) TestSim.step(w, TestSim.TICK); return { scored: w.teams[shootTeam].score > scoreBefore[shootTeam], scoreAfter: w.teams.map((t) => t.score) }; })()`);
  return { ...pre, ...post, ballLane: laneOf(pre.vy) };
}

console.log('--- screen mapping: right placement must be world -Y (vy < 0) ---');
const m = await strike(1, 2, false); // human shoots, picks RIGHT (index 2)
console.log('right-pick', JSON.stringify(m));
check('right placement launches to screen-right (vy < 0)', m.vy < 0);
const m2 = await strike(1, 0, false); // human shoots, picks LEFT (index 0)
console.log('left-pick', JSON.stringify(m2));
check('left placement launches to screen-left (vy > 0)', m2.vy > 0);

console.log('--- misaligned guess must NOT save (goal) ---');
const w1 = await strike(1, 0, true); // human shoots left, force keeper wrong
console.log('wrong-keeper', JSON.stringify(w1));
check('wrong keeper dive on human penalty -> GOAL', w1.scored === true);
const w2 = await strike(0, 2, true); // human keeps, picks right, force wrong
console.log('wrong-keeper2', JSON.stringify(w2));
check('wrong keeper dive on conceded penalty -> GOAL', w2.scored === true);

check('no JS exceptions', errors.length === 0);
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ m, m2, w1, w2, errors, failures }, null, 2));
console.log(`=== ${failures} failed check(s) ===`);
ws.close();
process.exit(failures ? 1 : 0);
