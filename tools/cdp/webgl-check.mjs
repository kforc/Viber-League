// Diagnostic: load a URL and report whether the game booted, whether a
// graceful .fatal screen appeared, and capture console + uncaught errors.
// Set NO_WEBGL=1 to override getContext so WebGL is unavailable (reproduces
// the reported environment). Dev-only.
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.CDP_PORT || 9333);
const url = process.argv[2];
const outDir = path.resolve(process.env.OUT_DIR || 'docs/diag-webgl');
const noWebgl = process.env.NO_WEBGL === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(outDir, { recursive: true });

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page') ?? list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);

let id = 0;
const pending = new Map();
function send(m, p = {}, t = 30000) {
  return new Promise((res, rej) => {
    const mid = ++id;
    const timer = setTimeout(() => { pending.delete(mid); rej(new Error('TIMEOUT ' + m)); }, t);
    pending.set(mid, { resolve: (v) => { clearTimeout(timer); res(v); }, reject: (e) => { clearTimeout(timer); rej(e); } });
    ws.send(JSON.stringify({ id: mid, method: m, params: p }));
  });
}

const logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const args = (m.params.args || []).map((a) => a.value ?? a.description ?? JSON.stringify(a)).join(' ');
    logs.push(`[${m.params.type}] ${args}`);
  } else if (m.method === 'Runtime.exceptionThrown') {
    const ex = m.params.exceptionDetails;
    logs.push(`[exception] ${ex.text} :: ${ex.exception?.description ?? ''}`);
  }
});
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
await send('Runtime.enable');
await send('Page.enable');

// Kill WebGL before any page script runs.
if (noWebgl) {
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      (() => {
        const orig = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
          if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null;
          return orig.call(this, type, ...rest);
        };
      })();
    `,
  });
}

await send('Emulation.setDeviceMetricsOverride', {
  width: Number(process.env.VW || 844),
  height: Number(process.env.VH || 390),
  deviceScaleFactor: 1, mobile: true,
});

const evalJs = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'eval failed');
  return r.result?.value;
};
await evalJs(`(function(){ window.__errs=[]; window.addEventListener('error',function(e){window.__errs.push(e.message);}); window.addEventListener('unhandledrejection',function(e){window.__errs.push('rejection: '+(e.reason&&e.reason.message||e.reason));}); })()`);

await send('Page.navigate', { url });
await sleep(7000);

const report = await evalJs(`(() => ({
  readyState: document.readyState,
  windowGame: typeof window.game,
  uiChildCount: document.getElementById('ui')?.childElementCount ?? -1,
  fatalShown: !!document.querySelector('.fatal'),
  fatalTitle: document.querySelector('.fatal-title')?.textContent ?? null,
  canvasCount: document.querySelectorAll('canvas').length,
  bodyTextSnippet: (document.body.innerText || '').slice(0, 120),
  errs: window.__errs || []
}))()`);

console.log('=== MODE:', noWebgl ? 'NO-WEBGL' : 'WEBGL-OK', '===');
console.log(JSON.stringify(report, null, 2));
console.log('=== CONSOLE/ERRORS (last 40) ===');
for (const l of logs.slice(-40)) console.log(l);

const r = await send('Page.captureScreenshot', { format: 'png' }, 45000);
fs.writeFileSync(path.join(outDir, noWebgl ? 'no-webgl.png' : 'webgl-ok.png'), Buffer.from(r.data, 'base64'));
ws.close();
process.exit(0);
