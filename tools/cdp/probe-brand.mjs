// Dev-only: eyeball the brand mark and the club icon set.
//
//   node_modules/.bin/esbuild src/brand.ts --bundle --format=iife --global-name=Brand --outfile=/tmp/brand.js
//   tools/cdp/run.sh tools/cdp/probe-brand.mjs docs/screens-brand
//
// Renders every icon at several sizes on both the dark and the lime surface, so
// the shapes can be judged rather than assumed. Nothing here ships.
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
    const timer = setTimeout(() => { pending.delete(mid); rej(new Error('TIMEOUT ' + m)); }, t);
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
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
await send('Runtime.enable');
await send('Page.enable');

const evalJs = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result?.value;
};

await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1500, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'about:blank' });
await sleep(600);

/*
 * Bring the real typeface along. The board face auto-fits its wordmark to the
 * room beside the mark, so the only way to judge the fit is with the font the
 * game actually ships — `about:blank` has no @font-face at all.
 */
const fonts = fs.readFileSync(new URL('../../src/fonts.css', import.meta.url), 'utf8');
await evalJs(`(() => {
  const s = document.createElement('style');
  s.textContent = ${JSON.stringify(fonts)};
  document.head.append(s);
  return 1;
})()`);
await evalJs(bundle + '\n;0');
await evalJs(`document.fonts.ready.then(() => 1)`);

const info = await evalJs(`(() => {
  const ids = Brand.ICON_IDS;
  const row = (bg, fg) => ids.map((id) => {
    const big = Brand.brandSvg(id, { size: 132 });
    const mid = Brand.brandSvg(id, { size: 64 });
    const small = Brand.brandSvg(id, { size: 30 });
    const bare = Brand.brandSvg(id, { size: 84, badge: false });
    return '<div class="cell" style="background:' + bg + ';color:' + fg + '">'
      + big + '<div class="sizes">' + mid + small + '</div>'
      + '<div class="lbl">' + Brand.iconLabel(id) + '</div>'
      + '<div class="bare">' + bare + '</div></div>';
  }).join('');

  // The hoarding face, at the size the game paints it and at the size it is
  // actually seen on a 844x390 screen. Returned as live canvases rather than
  // markup: outerHTML on a canvas serialises the element, not its bitmap.
  const board = (w, h, scale) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    Brand.paintBrandBoard(c);
    const out = document.createElement('canvas');
    out.width = w * scale; out.height = h * scale;
    out.className = 'board';
    const g = out.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(c, 0, 0, out.width, out.height);
    return out;
  };

  document.body.innerHTML =
    '<style>' +
    'body{margin:0;font-family:-apple-system,sans-serif;background:#fff}' +
    'h2{margin:10px 14px 4px;font-size:13px;letter-spacing:.12em;text-transform:uppercase}' +
    '.row{display:flex;gap:12px;padding:0 14px 10px}' +
    '.cell{border-radius:14px;padding:12px;display:flex;flex-direction:column;align-items:center;gap:8px;min-width:150px}' +
    '.sizes{display:flex;align-items:center;gap:10px}' +
    '.lbl{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;opacity:.75}' +
    '.bare{opacity:.5;display:flex}' +
    '.boards{padding:0 14px 14px;display:flex;flex-direction:column;align-items:flex-start;gap:10px}' +
    '.board{border-radius:4px;display:block}' +
    '</style>' +
    '<h2>On the dark surface</h2><div class="row">' + row('#0c0f08', '#dff902') + '</div>' +
    '<h2>On a lime surface</h2><div class="row">' + row('#dff902', '#0c0f08') + '</div>' +
    '<h2>The hoarding face &mdash; as painted, then at 160px and 90px wide</h2>' +
    '<div class="boards" id="boards"></div>';

  const boards = document.getElementById('boards');
  for (const [w, h, scale] of [[512, 144, 1], [512, 144, 0.31], [512, 144, 0.175]]) {
    boards.append(board(w, h, scale));
  }

  /*
   * The centre-circle emblem, rebuilt exactly the way paintCentreMark builds
   * it — same box ratio, same two tones, same alpha — on a stand-in for the
   * turf. Worth reproducing here because the real thing is only ever seen from
   * a camera 29 units back and 25 up, which foreshortens it into an ellipse and
   * makes "is it centred?" impossible to judge from a match screenshot.
   */
  const centre = (radius, ratio, alpha) => {
    const W = 768, H = 1280;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#3d9e55';
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 10; i++) {
      g.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.055)' : 'rgba(0,0,0,0.05)';
      g.fillRect(0, (H / 10) * i, W, H / 10);
    }
    g.strokeStyle = 'rgba(255,255,255,0.92)';
    g.lineWidth = 6;
    g.beginPath(); g.moveTo(60, H / 2); g.lineTo(W - 60, H / 2); g.stroke();
    g.beginPath(); g.arc(W / 2, H / 2, radius, 0, Math.PI * 2); g.stroke();

    const size = Math.round(radius * ratio);
    const mark = document.createElement('canvas');
    mark.width = size; mark.height = size;
    Brand.drawBrand(mark.getContext('2d'), 'viber', size,
      { badge: false, color: '#ffffff', cutColor: '#2c7a41' });
    g.globalAlpha = alpha;
    g.drawImage(mark, W / 2 - size / 2, H / 2 - size / 2);
    g.globalAlpha = 1;

    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.beginPath(); g.arc(W / 2, H / 2, 8, 0, Math.PI * 2); g.fill();

    // Crop to the circle so the detail is visible at screenshot size.
    const box = Math.ceil(radius * 2.4);
    const out = document.createElement('canvas');
    out.width = box; out.height = box;
    out.className = 'board';
    out.getContext('2d').drawImage(c, W / 2 - box / 2, H / 2 - box / 2, box, box, 0, 0, box, box);
    return out;
  };

  const centreWrap = document.createElement('div');
  centreWrap.className = 'boards';
  centreWrap.style.flexDirection = 'row';
  centreWrap.style.alignItems = 'flex-start';
  // As shipped, then at the old size, then with no circle for reference.
  centreWrap.append(centre(142.56, 1.72, 0.32), centre(142.56, 1.34, 0.26), centre(142.56, 1.72, 0));
  document.body.append(centreWrap);

  return { icons: ids.length, svgChars: Brand.brandSvg('viber').length,
    boardAspect: Brand.BOARD_ASPECT };
})()`);
console.log(JSON.stringify(info));

await sleep(400);
const r = await send('Page.captureScreenshot', { format: 'png' }, 45000);
fs.writeFileSync(path.join(outDir, 'brand.png'), Buffer.from(r.data, 'base64'));
console.log('wrote', path.join(outDir, 'brand.png'));
ws.close();
process.exit(0);
