// Diagnostic: load a URL, capture every console message, exception, and
// unhandled rejection, then report #ui and screenshot. Dev-only.
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.CDP_PORT || 9333);
const url = process.argv[2];
const outDir = path.resolve(process.env.OUT_DIR || 'docs/diag');
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
  // Streamed events
  if (m.method === 'Runtime.consoleAPICalled') {
    const args = (m.params.args || []).map((a) => a.value ?? a.description ?? JSON.stringify(a)).join(' ');
    logs.push(`[${m.params.type}] ${args}`);
  } else if (m.method === 'Runtime.exceptionThrown') {
    const ex = m.params.exceptionDetails;
    logs.push(`[exception] ${ex.text} :: ${ex.exception?.description ?? ''}`);
  } else if (m.method === 'Log.entryAdded') {
    const e = m.params.entry;
    logs.push(`[log:${e.level}] ${e.text} (${e.url ?? ''}:${e.lineNumber ?? ''})`);
  }
});
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
await send('Runtime.enable');
await send('Page.enable');
await send('Log.enable');
await send('Network.enable');

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

// Install onerror capture
await evalJs(`
  (() => {
    window.__errs = [];
    window.addEventListener('error', (e) => {
      window.__errs.push({ where: 'error', msg: e.message, src: e.filename, line: e.lineno, col: e.colno, stack: e.error?.stack ?? null });
    });
    window.addEventListener('unhandledrejection', (e) => {
      window.__errs.push({ where: 'unhandledrejection', reason: e.reason?.message ?? String(e.reason), stack: e.reason?.stack ?? null });
    });
  })()
`);

await send('Page.navigate', { url });
await sleep(8000);

const report = await evalJs(`(() => ({
  readyState: document.readyState,
  uiPresent: !!document.getElementById('ui'),
  uiChildCount: document.getElementById('ui')?.childElementCount ?? 0,
  uiFirstHtml: document.getElementById('ui')?.firstElementChild?.outerHTML?.slice(0, 400) ?? null,
  canvasCount: document.querySelectorAll('canvas').length,
  windowGame: typeof window.game,
  errs: window.__errs ?? [],
}))()`);

console.log('=== REPORT ===');
console.log(JSON.stringify(report, null, 2));
console.log('=== CONSOLE/EVENT LOG (last 60) ===');
for (const l of logs.slice(-60)) console.log(l);

const r = await send('Page.captureScreenshot', { format: 'png' }, 45000);
fs.writeFileSync(path.join(outDir, 'diag.png'), Buffer.from(r.data, 'base64'));
ws.close();
process.exit(0);
