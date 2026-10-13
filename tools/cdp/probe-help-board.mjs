// Dev-only: render the Help guide and report the pitch board's real geometry
// and computed paint, in whichever viewport VW/VH says.
//
//   tools/cdp/run.sh tools/cdp/probe-help-board.mjs docs/screens-help
//
// The harness checks the board too, but this is the fast loop: the full club
// flow takes ~7 minutes, and the board is a visual decision that needs the PNG
// read, not a pass/fail. Contrast of the copy over the board is measured
// separately from the PNG with Pillow, because the interesting number is the
// rendered pixel, not the declared colour.
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.CDP_PORT || 9333);
const url = process.argv[2];
const outDir = path.resolve(process.env.OUT_DIR || 'docs/screens-help');
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

await send('Page.navigate', { url });
await sleep(3000);
await evalJs(`(() => { try {
  localStorage.setItem('viber-league:profile:v1', JSON.stringify({
    manager: 'Alex', club: 'Riverside Rovers', short: 'RR', icon: 'crown',
    hash: null, salt: null, iterations: 100000,
    createdAt: '2026-10-09T00:00:00.000Z' }));
  localStorage.removeItem('viber-league:career:v1');
} catch {} return 1; })()`);
await send('Page.navigate', { url });
await sleep(9000);

// Title -> Play -> Help.
await evalJs(`(() => { document.querySelector('.play-btn')?.click(); return 1; })()`);
await sleep(900);
await evalJs(`(() => {
  const b = [...document.querySelectorAll('.modes-stack button')]
    .find((x) => (x.textContent || '').trim() === 'Help');
  b?.click(); return 1;
})()`);
await sleep(1200);

const info = await evalJs(`(() => {
  const b = document.querySelector('.help-board');
  const body = b && b.querySelector('.help-body');
  const line = document.querySelector('.help-line');
  const title = document.querySelector('.help-title');
  if (!b || !body || !line || !title) return { missing: true };
  const cs = getComputedStyle(b);
  const br = b.getBoundingClientRect();
  const lr = line.getBoundingClientRect();
  const tr = title.getBoundingClientRect();
  const ring = getComputedStyle(b, '::before');
  return {
    bg: cs.backgroundImage,
    border: cs.borderTopWidth + ' ' + cs.borderTopColor,
    radius: cs.borderTopLeftRadius,
    overflow: getComputedStyle(body).overflowY,
    line: getComputedStyle(line).color,
    title: getComputedStyle(title).color,
    ring: ring.borderTopWidth + ' ' + ring.borderTopColor,
    ringInset: ring.top,
    markings: {
      half: !!b.querySelector('.hp-half'),
      circle: !!b.querySelector('.hp-circle'),
      spot: !!b.querySelector('.hp-spot'),
      circleOpacity: (() => {
        const c = b.querySelector('.hp-circle');
        return c ? getComputedStyle(c).borderTopColor : null;
      })(),
    },
    board: { l: Math.round(br.left), t: Math.round(br.top), w: Math.round(br.width), h: Math.round(br.height) },
    textInset: Math.round(Math.min(lr.left, tr.left) - br.left),
    inside: lr.left >= br.left && lr.right <= br.right && lr.top >= br.top && lr.bottom <= br.bottom,
    topics: document.querySelectorAll('.help-topic').length,
    viewH: innerHeight,
    scrollable: body.scrollHeight > body.clientHeight,
  };
})()`);

const png = await shoot('help-board');
fs.writeFileSync(path.join(outDir, 'info.json'), JSON.stringify({ viewport: [W, H], info }, null, 2));

console.log('viewport', W + 'x' + H, 'topics', info.topics);
console.log('board ', JSON.stringify(info.board), 'fits:', info.board?.h <= info.viewH);
console.log('bg    ', (info.bg || '').slice(0, 110));
console.log('ring  ', info.ring, 'inset', info.ringInset);
console.log('text  ', 'line=' + info.line, 'title=' + info.title, 'inset=' + info.textInset, 'inside=' + info.inside);
console.log('marks ', JSON.stringify(info.markings));
console.log('body  ', 'overflow=' + info.overflow, 'scrollable=' + info.scrollable);
console.log('wrote', png);
ws.close();
process.exit(0);
