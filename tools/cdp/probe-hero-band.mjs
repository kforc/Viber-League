// Dev-only: where does the framed Viber actually sit, and does it sit inside
// the band the DOM reserved for it?
//
//   tools/cdp/run.sh tools/cdp/probe-hero-band.mjs docs/screens-heroband
//
// The title screen frames a Viber into `.menu-spacer` — the empty band between
// the wordmark/crest above and the PLAY button below. In the rendered PNG the
// figure appears to overlap the club-crest line and hide the middle of the club
// name. It is present in the committed screenshots too, so it is not a
// regression; this probe exists to find out whether it is *cosmetic and
// unavoidable* or a framing bug, before touching the framing code.
//
// The figure is drawn on the WebGL canvas, so no DOM query can find it. It is
// isolated by subtraction instead: screenshot the screen, hide the showcase,
// screenshot again, and diff. Whatever changed IS the figure, with an exact
// pixel bounding box — no guessing at where a model ends.
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.CDP_PORT || 9333);
const url = process.argv[2];
const outDir = path.resolve(process.env.OUT_DIR || 'docs/screens-heroband');
const W = Number(process.env.VW || 844);
const H = Number(process.env.VH || 390);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(outDir, { recursive: true });

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page =
  list.find((t) => t.type === 'page' && t.url !== 'about:blank') ??
  list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);

let id = 0;
const pending = new Map();
function send(m, p = {}, t = 30000) {
  return new Promise((res, rej) => {
    const mid = ++id;
    const timer = setTimeout(() => { pending.delete(mid); rej(new Error('TIMEOUT ' + m)); }, t);
    pending.set(mid, {
      resolve: (v) => { clearTimeout(timer); res(v); },
      reject: (e) => { clearTimeout(timer); rej(e); },
    });
    ws.send(JSON.stringify({ id: mid, method: m, params: p }));
  });
}
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
  }
});
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
await send('Runtime.enable');
await send('Page.enable');

const evalJs = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result?.value;
};
const shoot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' }, 45000);
  const p = path.join(outDir, `${name}.png`);
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  return p;
};

await send('Emulation.setDeviceMetricsOverride', {
  width: W, height: H, deviceScaleFactor: 1, mobile: true,
});

// A club so the crest line renders — that is the element being covered.
await send('Page.navigate', { url });
await sleep(3000);
await evalJs(`(() => { try {
  localStorage.setItem('viber-league:profile:v1', JSON.stringify({
    manager: 'Alex', club: 'Riverside Rovers', short: 'RR', icon: 'crown',
    hash: null, salt: null, iterations: 100000,
    createdAt: '2026-10-09T00:00:00.000Z' }));
} catch {} return 1; })()`);
await send('Page.navigate', { url });
await sleep(9000);

// Freeze animation so the two shots are of the same pose, not two poses.
await evalJs(`(() => {
  const s = document.createElement('style');
  s.textContent = '*,*::before,*::after{animation:none !important;transition:none !important}';
  document.head.append(s);
  return 1;
})()`);
await sleep(600);

const rects = await evalJs(`(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) };
  };
  return {
    vh: innerHeight,
    top: pick('.menu-top'),
    crest: pick('.menu-crest'),
    spacer: pick('.menu-spacer'),
    bottom: pick('.menu-bottom'),
    play: pick('.play-btn'),
    tiles: pick('.menu-options'),
  };
})()`);

const withHero = await shoot('01-with-hero');
await evalJs('window.game.renderer.hideShowcase(); 1');
await sleep(1200);
const without = await shoot('02-without-hero');

fs.writeFileSync(
  path.join(outDir, 'rects.json'),
  JSON.stringify({ viewport: [W, H], rects, withHero, without }, null, 2),
);

console.log('viewport', W + 'x' + H, ' innerHeight', rects.vh);
for (const k of ['top', 'crest', 'spacer', 'bottom', 'play', 'tiles']) {
  const r = rects[k];
  console.log(`  ${k.padEnd(8)} ${r ? `top=${String(r.top).padStart(4)} bottom=${String(r.bottom).padStart(4)} h=${r.h}` : '(absent)'}`);
}
const sp = rects.spacer;
if (sp) {
  const fill = Math.max(0.16, Math.min(0.46, (sp.h / rects.vh) * 1.04));
  const figureH = fill * rects.vh;
  const centre = sp.top + sp.h / 2;
  console.log(`\n  band ${sp.top}..${sp.bottom} (${sp.h}px)`);
  console.log(`  fill=${fill.toFixed(3)}  figureHeight=${figureH.toFixed(0)}px  centre=${centre.toFixed(0)}`);
  console.log(`  predicted figure top=${(centre - figureH / 2).toFixed(0)} bottom=${(centre + figureH / 2).toFixed(0)}`);
  if (rects.crest) console.log(`  crest line is at ${rects.crest.top}..${rects.crest.bottom}`);
}
console.log('\nwrote', path.join(outDir, 'rects.json'));
ws.close();
process.exit(0);
