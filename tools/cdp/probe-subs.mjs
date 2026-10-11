// Dev-only: open the pause menu mid-match, use the substitution screen, and
// verify a swap moves a Viber from the bench onto the pitch without the match
// clock moving a tick. Run after `npm run bundle`:
//   tools/cdp/run.sh tools/cdp/probe-subs.mjs docs/screens-subs
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.CDP_PORT || 9333);
const outDir = path.resolve(process.env.OUT_DIR || 'docs/screens-subs');
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

/** Read the squad as the world sees it: who is on the pitch, who is on the bench. */
const readSquad = () => evaluate(`(() => {
  const w = window.game.world;
  return {
    state: window.game.state,
    paused: w.paused,
    clock: w.clock,
    subsMade: w.subsMade[0],
    bench: w.bench[0].map((b) => ({ viber: b.viber, role: b.role })),
    pitch: w.players.filter((p) => p.team === 0).map((p) => ({ id: p.id, viber: p.viber, name: p.name, role: p.role })),
  };
})()`);

const url = new URL(process.argv[2]);
url.searchParams.set('autostart', '');
await send('Page.navigate', { url: url.toString() });
await until('!!window.game?.world && window.game.state === "match" && !window.game.world.paused');

const start = await readSquad();
console.log('start', JSON.stringify({ bench: start.bench, subsMade: start.subsMade }));
check('a matchday squad carries three substitutes', start.bench.length === 3);
check('the bench holds no starter',
  start.bench.every((b) => !start.pitch.some((p) => p.viber === b.viber)));

// --- open the pause menu -------------------------------------------------
await evaluate('document.querySelector(".pause-btn").click()');
await until('!!document.querySelector(".pause-panel")');
const pause = await evaluate(`(() => ({
  state: window.game.state,
  paused: window.game.world.paused,
  clock: window.game.world.clock,
  buttons: [...document.querySelectorAll('.menu-btn')].map((b) => b.textContent.trim()),
  subsDisabled: document.querySelector('.menu-btn:not(.primary):not(.danger)')?.disabled ?? null,
}))()`);
console.log('pause', JSON.stringify(pause));
check('the pause menu offers Substitutions with the count left',
  pause.buttons.some((b) => b.startsWith('Substitutions')) && pause.subsDisabled === false);

// --- open the substitution screen ---------------------------------------
await evaluate(`[...document.querySelectorAll('.menu-btn')].find((b) => b.textContent.trim().startsWith('Substitutions')).click()`);
await until('!!document.querySelector(".subs-panel")');
const subs = await evaluate(`(() => {
  const cols = [...document.querySelectorAll('.subs-col')];
  const titles = cols.map((c) => c.querySelector('.subs-col-title')?.textContent.trim());
  const rows = cols.map((c) => [...c.querySelectorAll('.sub-row')].map((r) => ({
    name: r.querySelector('.sub-name')?.textContent.trim(),
    role: r.querySelector('.sub-role')?.textContent.trim(),
    ovr: r.querySelector('.sub-ovr')?.textContent.trim(),
  })));
  const p = document.querySelector('.subs-panel').getBoundingClientRect();
  return { titles, onPitch: rows[0], bench: rows[1], l: p.left, r: p.right, t: p.top, b: p.bottom };
})()`);
console.log('subs', JSON.stringify({ ...subs, onPitch: undefined, bench: undefined }));
check('the screen lists the five on the pitch and the bench',
  subs.onPitch.length === 5 && subs.bench.length === 3);
check('the two lists are labelled',
  subs.titles[0] === 'On the pitch' && subs.titles[1] === 'Bench');
check('every row shows a role and a rating',
  [...subs.onPitch, ...subs.bench].every((r) => r.role && r.ovr && r.ovr !== '--'));
check('the substitution panel fits the viewport',
  subs.l >= -1 && subs.r <= width + 1 && subs.t >= -1 && subs.b <= height + 1);
await screenshot('01-subs-screen');

// --- make a substitution: pick a player off, then their replacement ------
const target = await evaluate(`(() => {
  const row = document.querySelector('.subs-col:first-child .sub-row');
  row.click();
  return row.querySelector('.sub-name').textContent.trim();
})()`);
await until('!!document.querySelector(".sub-row.selected")');
const benchName = await evaluate(`(() => {
  const row = document.querySelector('.subs-col:last-child .sub-row');
  const name = row.querySelector('.sub-name').textContent.trim();
  row.click();
  return name;
})()`);
await sleep(400);
const after = await readSquad();
console.log('after-sub', JSON.stringify({ target, benchName, subsMade: after.subsMade, bench: after.bench.map((b) => b.viber) }));
check('the substitute leaves the bench', after.bench.length === 2);
check('the substitution is recorded', after.subsMade === 1);
check('the incoming Viber is now on the pitch',
  after.pitch.some((p) => p.name === benchName) &&
  !after.pitch.some((p) => p.name === target));
check('the match is still frozen through the whole swap',
  after.paused === true && after.clock === pause.clock);
check('the world stayed in the substitution screen', after.state === 'subs');
await screenshot('02-after-sub');

// --- the bench empties out, and the option closes ------------------------
for (let i = 0; i < 2; i++) {
  await evaluate(`document.querySelector('.subs-col:first-child .sub-row').click()`);
  await until('!!document.querySelector(".sub-row.selected")');
  await evaluate(`document.querySelector('.subs-col:last-child .sub-row').click()`);
  await sleep(400);
}
const spent = await readSquad();
console.log('spent', JSON.stringify({ subsMade: spent.subsMade, bench: spent.bench.length }));
check('all three substitutions can be used', spent.subsMade === 3 && spent.bench.length === 0);
await screenshot('03-bench-empty');

// Back to the pause menu: the option must now be closed.
await evaluate('document.querySelector(".subs-back").click()');
await until('!!document.querySelector(".pause-panel")');
const spentPause = await evaluate(`(() => ({
  label: [...document.querySelectorAll('.menu-btn')].map((b) => b.textContent.trim()).find((t) => t.startsWith('Substitutions')),
  disabled: [...document.querySelectorAll('.menu-btn')].find((b) => b.textContent.trim().startsWith('Substitutions'))?.disabled,
}))()`);
console.log('spent-pause', JSON.stringify(spentPause));
check('with the bench empty the option is disabled', spentPause.disabled === true);

// --- resume and confirm the match is live again --------------------------
await evaluate('document.querySelector(".menu-btn.primary").click()');
await until('window.game.state === "match" && !window.game.world.paused');
check('Resume returns to the match after substituting',
  (await evaluate('document.querySelectorAll(".subs-panel, .pause-panel").length')) === 0);
check('the page reported no JavaScript exceptions', errors.length === 0);
await screenshot('04-resumed');

fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({
  viewport: [width, height], start, pause, subs, after, spent, spentPause, errors, failures,
}, null, 2));
console.log(`=== ${failures} failed check(s) ===`);
ws.close();
process.exit(failures ? 1 : 0);
