// Dev-only: how fast does a live match actually run under headless Chrome?
//
// The match-wait loops in flow-club.mjs spend real time and assume the
// animation frame keeps firing. run.sh's own note warns that headless Chrome
// has no compositor and rAF *can* collapse to ~1.6fps — if that happens, a
// match measured in wall clock is not a match at all. This measures the real
// numbers instead of guessing.
//
//   tools/cdp/run.sh tools/cdp/probe-rate.mjs /tmp/rate
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.CDP_PORT || 9333);
const outDir = path.resolve(process.env.OUT_DIR || '/tmp/rate');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seed = Number(process.env.SEED || 12345);
fs.mkdirSync(outDir, { recursive: true });

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((tab) => tab.type === 'page' && tab.url !== 'about:blank') ??
  list.find((tab) => tab.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const errors = [];
function send(method, params = {}, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    const timer = setTimeout(() => { pending.delete(mid); reject(new Error(`TIMEOUT ${method}`)); }, timeout);
    pending.set(mid, {
      resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
ws.addEventListener('message', ({ data }) => {
  const m = JSON.parse(data);
  if (m.method === 'Runtime.exceptionThrown')
    errors.push(m.params.exceptionDetails?.exception?.description || 'unknown');
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
  }
});
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});
await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 844, height: 390, deviceScaleFactor: 1, mobile: true,
});
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'eval error');
  return result.result?.value;
};
const until = async (predicate, timeout = 40000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await evaluate(predicate);
    if (value) return value;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${predicate}`);
};

const url = new URL(process.argv[2]);
url.searchParams.set('autostart', '');
url.searchParams.set('seed', String(seed));
await send('Page.navigate', { url: url.toString() });
await until('!!window.game?.world');

// Count animation frames independently of the game's own loop.
await evaluate(`(() => {
  window.__raf = 0;
  window.__last = performance.now();
  (function tick() { window.__raf++; requestAnimationFrame(tick); })();
  return 1;
})()`);

console.log(`\nsampling a live match, seed=${seed}\n`);
console.log('   t(s)   raf   fps    tick    clock   phase      state   paused  .clock');
const samples = Number(process.env.SAMPLES || 12);
const interval = Number(process.env.INTERVAL || 2500);
const start = Date.now();
let prevRaf = 0;
let prevTick = 0;
let stalls = 0;
const rows = [];
for (let i = 0; i < samples; i++) {
  await sleep(interval);
  const s = await evaluate(`(() => {
    const w = window.game.world;
    return {
      raf: window.__raf,
      tick: w.tick,
      clock: w.clock,
      phase: w.phase,
      state: window.game.state,
      paused: w.paused,
      clockText: document.querySelector('.clock')?.textContent ?? null,
      halfSeconds: w.halfSeconds,
      half: w.half,
    };
  })()`);
  const t = (Date.now() - start) / 1000;
  const fps = ((s.raf - prevRaf) / (interval / 1000)).toFixed(1);
  const simRate = ((s.tick - prevTick) / 60 / (interval / 1000)).toFixed(3);
  if (s.tick === prevTick) stalls++;
  console.log(
    `  ${t.toFixed(1).padStart(5)}  ${String(s.raf).padStart(5)}  ${fps.padStart(5)}  ` +
    `${String(s.tick).padStart(7)}  ${s.clock.toFixed(1).padStart(6)}  ` +
    `${s.phase.padEnd(10)} ${s.state.padEnd(7)} ${String(s.paused).padEnd(6)} ${s.clockText}`,
  );
  rows.push({ t, ...s, fps: Number(fps), simRate: Number(simRate) });
  prevRaf = s.raf;
  prevTick = s.tick;
}

const first = rows[0];
const last = rows[rows.length - 1];
const simSeconds = (last.tick - first.tick) / 60;
const wallSeconds = last.t - first.t;
console.log(`\nsim ran ${simSeconds.toFixed(1)}s of match time in ${wallSeconds.toFixed(1)}s of wall clock`);
console.log(`=> ${(simSeconds / wallSeconds).toFixed(3)}x realtime`);
console.log(`stalled samples (no tick at all): ${stalls}/${rows.length}`);
console.log(`halfSeconds=${first.halfSeconds}, half=${last.half}, phase=${last.phase}, state=${last.state}`);
console.log(`page errors: ${errors.length}${errors.length ? ' :: ' + errors.join(' | ') : ''}`);
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ seed, rows, errors }, null, 2));
ws.close();
process.exit(0);
