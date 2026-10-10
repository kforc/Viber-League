// Dev-only: look at the pitch and the hoardings, with the match running.
//
// The harness screenshots always land on a screen with an overlay on it, so the
// one thing the brand work changed — the turf and the boards — is never actually
// looked at. This boots straight into a match and takes a short sequence of
// frames as the camera travels, so both the centre-circle mark and the
// touchline boards are seen from more than one angle.
//
//   tools/cdp/run.sh tools/cdp/probe-brand-pitch.mjs docs/brand-pitch
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.CDP_PORT || 9333);
const url = process.argv[2];
const outDir = path.resolve(process.env.OUT_DIR || 'docs/brand-pitch');
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
    const timer = setTimeout(() => {
      pending.delete(mid);
      rej(new Error('TIMEOUT ' + m));
    }, t);
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
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', rej);
});
await send('Runtime.enable');
await send('Page.enable');

const evalJs = async (e) => {
  const r = await send('Runtime.evaluate', {
    expression: e, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result?.value;
};

const W = Number(process.env.VW || 844);
const H = Number(process.env.VH || 390);
await send('Emulation.setDeviceMetricsOverride', {
  width: W, height: H, deviceScaleFactor: 1, mobile: true,
});

// Seed a club and pin the match to a short, clear, half so the camera moves
// quickly, then jump straight in — no pre-match flow to sit through.
await send('Page.navigate', { url });
await sleep(3000);
await evalJs(`(() => {
  localStorage.setItem('viber-league:profile:v1', JSON.stringify({
    manager: 'Alex', club: 'Riverside Rovers', short: 'RR', icon: 'crown',
    hash: null, salt: null, iterations: 100000,
    createdAt: '2026-10-09T00:00:00.000Z',
  }));
  localStorage.setItem('viber-league:career:v1', JSON.stringify({
    settings: { halfSeconds: 2, weather: 'sun', sound: false },
  }));
  return 1;
})()`);
await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'autostart' });
await sleep(14000);

// Hide the HUD chrome so the pitch is what is being looked at, but leave the
// 3D canvas untouched.
await evalJs(`(() => {
  const s = document.createElement('style');
  s.id = 'probe';
  s.textContent =
    '*{animation:none !important;transition:none !important}' +
    '#ui{opacity:0 !important}';
  document.head.append(s);
  return 1;
})()`);
await sleep(500);

for (let i = 0; i < 5; i++) {
  const clock = await evalJs(
    `document.querySelector('.clock')?.textContent || '?'`);
  const r = await send('Page.captureScreenshot', { format: 'png' }, 45000);
  fs.writeFileSync(path.join(outDir, `pitch-${i}.png`), Buffer.from(r.data, 'base64'));
  console.log(`pitch-${i}.png  clock=${clock}`);
  await sleep(3500);
}

console.log('done');
// The socket keeps the event loop alive, and the shell would then sit waiting
// on a Chrome that has nothing left to do.
ws.close();
process.exit(0);
