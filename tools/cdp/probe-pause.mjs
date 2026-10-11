// Dev-only: open the pause menu mid-match, verify Resume and Quit work, and
// that quitting returns to the league without recording a result. Run after
// `npm run bundle`:
//   tools/cdp/run.sh tools/cdp/probe-pause.mjs docs/screens-pause
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const port = Number(process.env.CDP_PORT || 9333);
const outDir = path.resolve(process.env.OUT_DIR || 'docs/screens-pause');
const width = Number(process.env.VW || 844);
const height = Number(process.env.VH || 390);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync(outDir, { recursive: true });

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((tab) => tab.type === 'page' && tab.url !== 'about:blank') ??
  list.find((tab) => tab.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const errors = [];
function send(method, params = {}, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    const timer = setTimeout(() => { pending.delete(mid); reject(new Error(`TIMEOUT ${method}`)); }, timeout);
    pending.set(mid, {
      resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
ws.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === 'Runtime.exceptionThrown')
    errors.push(message.params.exceptionDetails?.exception?.description || 'unknown exception');
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  }
});
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});
await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'eval error');
  return result.result?.value;
};
const until = async (predicate, timeout = 40000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await evaluate(predicate);
    if (value) return value;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${predicate}`);
};
const screenshot = async (name) => {
  const result = await send('Page.captureScreenshot', { format: 'png' }, 45000);
  fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(result.data, 'base64'));
};
const check = (label, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failures++; };
let failures = 0;

const url = new URL(process.argv[2]);
url.searchParams.set('autostart', '');
await send('Page.navigate', { url: url.toString() });
await until('!!window.game?.world && window.game.state === "match" && !window.game.world.paused');

// Open the pause menu via the HUD pause button.
await evaluate('document.querySelector(".pause-btn").click()');
await until('!!document.querySelector(".pause-panel")');
const menu = await evaluate(`(() => {
  const w = window.game.world;
  const panel = document.querySelector('.pause-panel');
  const buttons = [...document.querySelectorAll('.menu-btn')].map((b) => b.textContent.trim());
  const r = panel.getBoundingClientRect();
  return { state: window.game.state, paused: w.paused, buttons, l: r.left, r: r.right, sh: panel.scrollHeight, ch: panel.clientHeight };
})()`);
console.log('pause-menu', JSON.stringify(menu));
check('pause opens the menu and freezes the match', menu.state === 'paused' && menu.paused);
check('menu offers Resume and Quit to League',
  menu.buttons.includes('Resume') && menu.buttons.includes('Quit to League'));
check('pause panel fits horizontally', menu.l >= -1 && menu.r <= width + 1 && menu.sh <= menu.ch + 2);
await screenshot('01-pause-menu');

// Resume works.
await evaluate('document.querySelector(".menu-btn.primary").click()');
await until('window.game.state === "match" && !window.game.world.paused');
check('Resume closes the menu and continues the match',
  (await evaluate('document.querySelectorAll(".pause-panel").length')) === 0);

// Open again and quit (with the confirm step).
await evaluate('document.querySelector(".pause-btn").click()');
await until('!!document.querySelector(".pause-panel")');
await evaluate('document.querySelector(".menu-btn.danger").click()'); // Quit to League
await until('!!document.querySelector(".pause-panel") && document.body.textContent.includes("Quit match?")');
const confirm = await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('.menu-btn')].map((b) => b.textContent.trim());
  return { buttons, title: document.querySelector('.panel-title')?.textContent.trim() };
})()`);
console.log('confirm', JSON.stringify(confirm));
check('quit shows a confirm step', confirm.title === 'Quit match?' &&
  confirm.buttons.includes('Quit without saving') && confirm.buttons.includes('Back'));
await screenshot('02-quit-confirm');

const resultsBefore = await evaluate('JSON.stringify(window.game.career?.results ?? null)');
await evaluate('document.querySelector(".menu-btn.danger").click()'); // confirm quit
await until('window.game.state === "league"');
check('confirming quit returns to the league', await evaluate('window.game.state') === 'league');
check('the page reported no JavaScript exceptions', errors.length === 0);
await screenshot('03-back-to-league');

fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({
  viewport: [width, height], menu, confirm, resultsBefore, errors, failures,
}, null, 2));
console.log(`=== ${failures} failed check(s) ===`);
ws.close();
process.exit(failures ? 1 : 0);
