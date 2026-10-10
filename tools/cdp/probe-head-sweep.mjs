// Dev-only: render candidate head silhouettes side by side with the reference.
//
//   node_modules/.bin/esbuild src/brand.ts --bundle --format=iife --global-name=Brand --outfile=/tmp/brand.js
//   tools/cdp/run.sh tools/cdp/probe-head-sweep.mjs docs/screens-brand
//
// WHY. The head is the one part of the mark that is still an approximation —
// three circles and a rounded rectangle standing in for what is really a
// squircle-ish cloud. Fitting circles to the reference's edge profile gives a
// different answer at every row, so the honest way to choose is to render a
// handful of candidates and look at them next to the artwork. Everything else
// (the V/V, the eyes, the smile) is measured exactly and is identical across
// every candidate, so only the head varies.
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.CDP_PORT || 9333);
const outDir = path.resolve(process.env.OUT_DIR || 'docs/screens-brand');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(outDir, { recursive: true });

const bundle = fs.readFileSync(process.env.BRAND_BUNDLE || '/tmp/brand.js', 'utf8');

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
      resolve: (v) => {
        clearTimeout(timer);
        res(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        rej(e);
      },
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
    expression: e,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  }
  return r.result?.value;
};

const TILE = 440;
const COLS = 2;
const ROWS = 1;
await send('Emulation.setDeviceMetricsOverride', {
  width: TILE * COLS,
  height: TILE * ROWS + 30,
  deviceScaleFactor: 1,
  mobile: false,
});
await send('Page.navigate', { url: 'about:blank' });
await sleep(500);
await evalJs(bundle + '\n;0');

const info = await evalJs(`(() => {
  /*
   * The head is the first four fills in the viber mark; the eyes are the next
   * two. Splitting the markup on '<path' is enough to swap one for the other
   * without touching the module's public API.
   */
  const svg = Brand.brandSvg('viber', { badge: false });
  const chunks = svg.split('<path');
  const headCount = 4;
  const head = chunks.slice(1, 1 + headCount);
  const tail = chunks.slice(1 + headCount);

  const cp = Brand.circlePath;
  const rr = Brand.roundRectPath;

  const candidates = [
    ['A  current', [cp(30, 27, 13.5), cp(50, 21, 15), cp(70, 27, 13.5), rr(18, 31, 64, 29, 11)]],
    ['B  lobes +1.5r', [cp(31, 29, 15), cp(50, 22, 16), cp(69, 29, 15), rr(18, 31, 64, 29, 11)]],
  ];

  document.body.style.margin = '0';
  document.body.style.background = '#1b1b1b';
  document.body.style.display = 'flex';
  document.body.style.flexWrap = 'wrap';

  const tiles = candidates.map(([label, paths]) => {
    const markup =
      chunks[0] +
      paths.map((d) => '<path d="' + d + '" fill="' + Brand.BRAND.lime + '"/>').join('') +
      '<path' +
      tail.join('<path');
    const c = document.createElement('canvas');
    c.width = ${TILE};
    c.height = ${TILE};
    c.style.display = 'block';
    c.style.margin = '0';
    const g = c.getContext('2d');
    g.fillStyle = Brand.BRAND.ink;
    g.fillRect(0, 0, ${TILE}, ${TILE});
    // Re-render the markup at tile size and rasterise it.
    const sized = markup.replace(/width="\\d+" height="\\d+"/, 'width="${TILE}" height="${TILE}"');
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sized);
    return { c, g, img, label };
  });

  return Promise.all(
    tiles.map(
      (t) =>
        new Promise((res) => {
          t.img.onload = () => {
            t.g.drawImage(t.img, 0, 0, ${TILE}, ${TILE});
            document.body.append(t.c);
            res(t.label);
          };
        }),
    ),
  );
})()`);
console.log(JSON.stringify(info));

await sleep(400);
const r = await send('Page.captureScreenshot', { format: 'png' }, 45000);
fs.writeFileSync(path.join(outDir, 'head-sweep.png'), Buffer.from(r.data, 'base64'));
console.log('wrote', path.join(outDir, 'head-sweep.png'));
ws.close();
process.exit(0);
