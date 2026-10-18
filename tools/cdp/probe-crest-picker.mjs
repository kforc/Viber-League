// Dev-only: the crest picker as a player actually meets it.
//
//   npm run bundle && tools/cdp/run.sh tools/cdp/probe-crest-picker.mjs docs/screens-crests
//
// The contact sheet in probe-brand.mjs judges the artwork; this judges the
// screen — six 40px tiles in a row, and the 34px preview that updates as you
// pick. Those are the two sizes a crest is chosen at, and the only place the
// player ever sees all six side by side.
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.CDP_PORT || 9333);
const outDir = path.resolve(process.env.OUT_DIR || 'docs/screens-crests');
const width = Number(process.env.VW || 844);
const height = Number(process.env.VH || 390);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync(outDir, { recursive: true });

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url !== 'about:blank') ??
  list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const errors = [];
const send = (method, params = {}, timeout = 30000) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    const timer = setTimeout(() => { pending.delete(mid); reject(new Error(`TIMEOUT ${method}`)); }, timeout);
    pending.set(mid, {
      resolve: (r) => { clearTimeout(timer); resolve(r); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
ws.addEventListener('message', ({ data }) => {
  const m = JSON.parse(data);
  if (m.method === 'Runtime.exceptionThrown')
    errors.push(m.params.exceptionDetails?.exception?.description || 'unknown exception');
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
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result?.value;
};
const until = async (predicate, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(predicate)) return true;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${predicate}`);
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' }, 45000);
  fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(r.data, 'base64'));
};
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const url = process.argv[2];
await send('Page.navigate', { url });
await sleep(3000);
await evaluate(`(() => {
  try { localStorage.removeItem('viber-league:profile:v1'); localStorage.removeItem('viber-league:career:v1'); } catch {}
  return 1;
})()`);
await send('Page.navigate', { url });
await sleep(8500);

// A guest asking for the league is sent to create a club, which is the one-tap
// route to the onboarding form — no gate, no sign-in.
await evaluate(`(() => {
  const t = [...document.querySelectorAll('.menu-opt')].find((b) => /league/i.test(b.textContent));
  t?.click();
  return !!t;
})()`);
await until('!!document.querySelector(".icon-picker")');

const picker = await evaluate(`(() => {
  const tiles = [...document.querySelectorAll('.icon-choice')];
  const wrap = document.querySelector('.icon-picker').getBoundingClientRect();
  const boxes = tiles.map((b) => {
    const r = b.getBoundingClientRect();
    return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  });
  return {
    count: tiles.length,
    labels: tiles.map((b) => b.getAttribute('aria-label')),
    paths: tiles.map((b) => b.querySelectorAll('path').length),
    preview: document.querySelector('.crest-preview svg')?.getAttribute('aria-label') ?? null,
    rows: new Set(boxes.map((b) => b.t)).size,
    box: { l: Math.round(wrap.left), r: Math.round(wrap.right) },
    boxes,
  };
})()`);
console.log('picker', JSON.stringify({ ...picker, boxes: undefined }));
check('the picker offers six crests', picker.count === 6, 'n=' + picker.count);
check('every crest has its own accessible name',
  new Set(picker.labels).size === 6, JSON.stringify(picker.labels));
check('every crest draws real artwork',
  picker.paths.every((n) => n > 0), JSON.stringify(picker.paths));
check('the six fit on one row at 844x390', picker.rows === 1, 'rows=' + picker.rows);
check('the picker stays inside the viewport',
  picker.box.l >= 0 && picker.box.r <= width, JSON.stringify(picker.box));
check('the preview shows the default crest', picker.preview === 'Viber', 'preview=' + picker.preview);
await shot('01-crest-picker');

// Pick each new crest and confirm the preview follows it — the whole promise of
// the picker is that what you choose here is what you get everywhere else.
const walked = [];
for (const label of ['Quill', 'Voxel', 'Spike']) {
  const state = await evaluate(`(() => {
    const b = [...document.querySelectorAll('.icon-choice')].find((n) => n.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!b) return null;
    b.click();
    return {
      pressed: b.getAttribute('aria-pressed'),
      preview: document.querySelector('.crest-preview svg')?.getAttribute('aria-label') ?? null,
    };
  })()`);
  walked.push({ label, ...state });
  await sleep(350);
}
console.log('walked', JSON.stringify(walked));
check('each new crest can be selected and reaches the preview',
  walked.every((w) => w?.pressed === 'true' && w?.preview === w.label),
  JSON.stringify(walked));
await shot('02-crest-picked');

// Portrait too: six 40px tiles are a row that has to survive a narrow screen.
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await sleep(700);
const portrait = await evaluate(`(() => {
  const tiles = [...document.querySelectorAll('.icon-choice')];
  const boxes = tiles.map((b) => b.getBoundingClientRect());
  return {
    rows: new Set(boxes.map((r) => Math.round(r.top))).size,
    minRight: Math.max(...boxes.map((r) => r.right)),
    minBottom: Math.max(...boxes.map((r) => r.bottom)),
  };
})()`);
console.log('portrait', JSON.stringify(portrait));
check('the crest row still fits at 390 wide',
  portrait.rows === 1 && portrait.minRight <= 390 + 1, JSON.stringify(portrait));
await shot('03-crest-picker-portrait');

check('the page reported no JavaScript exceptions', errors.length === 0, errors.join(' | '));
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ picker, walked, portrait, errors, failures }, null, 2));
console.log(`=== ${failures} failed check(s) ===`);
ws.close();
process.exit(failures ? 1 : 0);
