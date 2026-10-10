// Dev-only: measure how long a headless match actually takes, so the harness
// wait loops can be sized from data rather than guesswork.
import fs from 'node:fs';

const port = Number(process.env.CDP_PORT || 9333);
const url = process.argv[2];
const HALF = Number(process.env.HALF || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url !== 'about:blank') ?? list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
function send(m, p = {}, t = 30000) {
  return new Promise((res, rej) => {
    const mid = ++id;
    const timer = setTimeout(() => { pending.delete(mid); rej(new Error('TIMEOUT ' + m)); }, t);
    pending.set(mid, { resolve: (v) => { clearTimeout(timer); res(v); }, reject: (e) => { clearTimeout(timer); rej(e); } });
    ws.send(JSON.stringify({ id: mid, method: m, params: p }));
  });
}
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result); }
});
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
await send('Runtime.enable'); await send('Page.enable');
const evalJs = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result?.value;
};
const click = (sel, nth = 0) => evalJs(`(() => {
  const all = [...document.querySelectorAll(${JSON.stringify(sel)})];
  const el = all[${nth}]; if (!el) return 'MISSING';
  el.scrollIntoView({ block: 'nearest' });
  for (const t of ['pointerdown','mousedown','pointerup','mouseup','click'])
    el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  return 'ok';
})()`);
const clickText = (needle, sel = 'button') => evalJs(`(() => {
  const all = [...document.querySelectorAll(${JSON.stringify(sel)})];
  const el = all.find((b) => (b.textContent || '').includes(${JSON.stringify(needle)}));
  if (!el) return 'MISSING';
  el.scrollIntoView({ block: 'nearest' });
  for (const t of ['pointerdown','mousedown','pointerup','mouseup','click'])
    el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  return 'ok';
})()`);
const snap = () => evalJs(`JSON.stringify({
  clock: document.querySelector('.clock')?.textContent ?? null,
  half: document.querySelector('.half')?.textContent ?? null,
  score: document.querySelector('.score')?.textContent ?? null,
  ht: !!document.querySelector('.overlay-screen .choice-btn'),
  res: !!document.querySelector('.stats-table'),
  choices: document.querySelectorAll('.overlay-screen .choice-btn').length,
})`);

await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
await send('Page.navigate', { url });
await sleep(3000);
await evalJs(`(() => { try {
  localStorage.setItem('viber-league:profile:v1', JSON.stringify({
    manager: 'Alex', club: 'Riverside Rovers', short: 'RR', hash: null, salt: null,
    iterations: 100000, createdAt: '2026-10-09T00:00:00.000Z' }));
  localStorage.setItem('viber-league:career:v1', JSON.stringify({
    season: 1, seed: 5, results: {}, lineup: [], history: [],
    settings: { halfSeconds: ${HALF}, weather: 'sun', reducedMotion: false } }));
} catch {} return 1; })()`);
await send('Page.navigate', { url });
await sleep(8500);

await click('.menu-opt', 0); await sleep(600);
await clickText('Play Next Match', '.primary-btn'); await sleep(800);
await clickText('Auto', 'button'); await sleep(700);
await click('.primary-btn'); await sleep(700);
await click('.primary-btn'); await sleep(700);
await click('.primary-btn'); await sleep(700);
await click('.primary-btn'); await sleep(2000);

const t0 = Date.now();
let htAt = null, ftAt = null, htChoices = 0;
console.log(`half=${HALF}s  starting match at t=0`);
for (let i = 0; i < 200; i++) {
  const s = JSON.parse(await snap());
  const t = ((Date.now() - t0) / 1000).toFixed(0);
  if (s.ht && !htAt) {
    htAt = t; htChoices = s.choices;
    console.log(`  t+${t}s  HALF-TIME (${s.choices} choices)  ${s.score}`);
    await clickText('Balanced', '.choice-btn');
    await sleep(500);
    continue;
  }
  if (s.res && !ftAt) { ftAt = t; console.log(`  t+${t}s  FULL TIME  ${s.score}`); break; }
  if (i % 5 === 0) console.log(`  t+${t}s  clock=${s.clock} half=${s.half} score=${s.score}`);
  await sleep(2000);
}
console.log(`\nRESULT: half-time at ${htAt ?? 'never'}s (${htChoices} choices), full-time at ${ftAt ?? 'never'}s`);
ws.close(); process.exit(0);
