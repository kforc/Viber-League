// Dev-only: what does the game show a BRAND NEW player?
//
//   tools/cdp/run.sh tools/cdp/probe-boot.mjs docs/screens-boot
//
// Clears both storage keys, reloads, and reports which screen is on screen plus
// the text of the title screen's crest line. This is the only way to see the
// first-run path, because the main harness deliberately seeds a profile.
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.CDP_PORT || 9333);
const url = process.argv[2];
const outDir = path.resolve(process.env.OUT_DIR || 'docs/screens-boot');
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
    pending.set(mid, { resolve: (v) => { clearTimeout(timer); res(v); }, reject: (e) => { clearTimeout(timer); rej(e); } });
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
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result?.value;
};

await send('Emulation.setDeviceMetricsOverride', {
  width: Number(process.env.VW || 844),
  height: Number(process.env.VH || 390),
  deviceScaleFactor: 1,
  mobile: true,
});

await send('Page.navigate', { url });
await sleep(3000);
await evalJs(`(() => {
  localStorage.removeItem('viber-league:profile:v1');
  localStorage.removeItem('viber-league:career:v1');
  return 1;
})()`);
await send('Page.navigate', { url });
await sleep(9000);

const report = await evalJs(`(() => {
  const ui = document.getElementById('ui');
  const screen = ui?.querySelector('.screen');
  return {
    screenClass: screen ? [...screen.classList].join('.') : '(none)',
    hasOnboarding: !!ui?.querySelector('.onboard-screen'),
    hasTitle: !!ui?.querySelector('.menu-screen'),
    hasSignIn: !!ui?.querySelector('.signin-screen'),
    fields: [...(ui?.querySelectorAll('.field-label') ?? [])].map((n) => n.textContent),
    buttons: [...(ui?.querySelectorAll('.profile-card button'))].map((n) => n.textContent.trim()),
    crestLine: ui?.querySelector('.menu-crest')?.textContent ?? null,
    storageOk: (() => { try { localStorage.setItem('x','1'); localStorage.removeItem('x'); return true; } catch { return false; } })(),
    profile: localStorage.getItem('viber-league:profile:v1'),
  };
})()`);
console.log(JSON.stringify(report, null, 2));

const r = await send('Page.captureScreenshot', { format: 'png' }, 45000);
fs.writeFileSync(path.join(outDir, 'boot.png'), Buffer.from(r.data, 'base64'));
ws.close();
process.exit(0);
