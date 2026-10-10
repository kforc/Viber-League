// Dev-only: render the Viber mark alone, at reference size, for a side-by-side
// against the official artwork.
//
//   node_modules/.bin/esbuild src/brand.ts --bundle --format=iife --global-name=Brand --outfile=/tmp/brand.js
//   tools/cdp/run.sh tools/cdp/probe-logo.mjs docs/screens-brand
//
// WHY A SEPARATE PROBE. `probe-brand` shows the mark among the icon set, which
// is how it is judged for legibility. This one reproduces the reference's own
// conditions exactly — 640x640, badge off, on the badge ink — so the two images
// can be overlaid or read side by side without any scaling guesswork. The eye
// regression that this probe exists for was invisible in the icon sheet and
// obvious the moment the two were put next to each other.
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

// The reference is a 640px square, so the probe is too.
const SIDE = 640;
await send('Emulation.setDeviceMetricsOverride', {
  width: SIDE,
  height: SIDE,
  deviceScaleFactor: 1,
  mobile: false,
});
await send('Page.navigate', { url: 'about:blank' });
await sleep(500);

await evalJs(bundle + '\n;0');

const info = await evalJs(`(() => {
  // The reference artwork fills its frame with the badge ink and paints the
  // mark on it with no badge of its own — reproduce that literally.
  document.body.style.margin = '0';
  document.body.style.background = Brand.BRAND.ink;

  // Two renderers, one geometry: the canvas path (used on the pitch and the
  // hoardings) and the SVG path (used everywhere in the DOM). They are supposed
  // to be the same drawing, so render both and compare them.
  const c = document.createElement('canvas');
  c.width = ${SIDE}; c.height = ${SIDE};
  c.id = 'mark';
  c.style.display = 'block';
  Brand.drawBrand(c.getContext('2d'), 'viber', ${SIDE}, { badge: false });
  document.body.append(c);

  const svgHost = document.createElement('canvas');
  svgHost.width = ${SIDE}; svgHost.height = ${SIDE};
  svgHost.style.display = 'none';
  svgHost.id = 'svg-host';
  document.body.append(svgHost);
  const svgMarkup = Brand.brandSvg('viber', { size: ${SIDE}, badge: false });
  const svgImg = new Image();
  svgImg.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgMarkup);
  const svgReady = new Promise((res) => { svgImg.onload = () => {
    svgHost.getContext('2d').drawImage(svgImg, 0, 0, ${SIDE}, ${SIDE});
    res(1);
  }; });

  // Where the eyes landed, measured off the bitmap rather than assumed — the
  // whole point is that they exist and are the right size.
  const g = c.getContext('2d');
  const px = g.getImageData(0, 0, ${SIDE}, ${SIDE}).data;
  const isLime = (i) => px[i] > 150 && px[i + 1] > 180 && px[i + 2] < 120;
  const scan = (canvas) => {
    const d = canvas.getContext('2d').getImageData(0, 0, ${SIDE}, ${SIDE}).data;
    const ok = (i) => d[i] > 150 && d[i + 1] > 180 && d[i + 2] < 120;
    const rows = new Array(${SIDE}).fill(0);
    for (let y = 0; y < ${SIDE}; y++) {
      for (let x = 0; x < ${SIDE}; x++) if (ok((y * ${SIDE} + x) * 4)) rows[y]++;
    }
    const bands = [];
    let start = -1;
    for (let y = 0; y < ${SIDE}; y++) {
      if (rows[y] > 0 && start < 0) start = y;
      else if (rows[y] === 0 && start >= 0) { bands.push([start, y - 1]); start = -1; }
    }
    if (start >= 0) bands.push([start, ${SIDE} - 1]);
    return bands;
  };
  return svgReady.then(() => ({
    canvas: scan(c),
    svg: scan(svgHost),
    size: ${SIDE},
  }));
})()`);
console.log(JSON.stringify(info));

await sleep(300);
const r = await send(
  'Page.captureScreenshot',
  { format: 'png', clip: { x: 0, y: 0, width: SIDE, height: SIDE, scale: 1 } },
  45000,
);
fs.writeFileSync(path.join(outDir, 'logo.png'), Buffer.from(r.data, 'base64'));
console.log('wrote', path.join(outDir, 'logo.png'));
ws.close();
process.exit(0);
