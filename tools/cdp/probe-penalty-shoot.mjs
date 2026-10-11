// Dev-only: give the HUMAN (team 0) a penalty, then exercise the new
// "Take the Penalty" shoot overlay and confirm the chosen placement steers the
// ball. Mirrors probe-penalty.mjs but awards the foul to a CPU defender so the
// penalty goes to team 0. Run after `npm run bundle`:
//   tools/cdp/run.sh tools/cdp/probe-penalty-shoot.mjs docs/screens-penalty-shoot
//   VW=390 VH=844 tools/cdp/run.sh tools/cdp/probe-penalty-shoot.mjs docs/screens-penalty-shoot-portrait
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const port = Number(process.env.CDP_PORT || 9333);
const outDir = path.resolve(process.env.OUT_DIR || 'docs/screens-penalty-shoot');
const width = Number(process.env.VW || 844);
const height = Number(process.env.VH || 390);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync(outDir, { recursive: true });

// Test-only IIFE: calls the real foul-award on the actual world the app renders.
const sim = (await build({
  entryPoints: [fileURLToPath(new URL('../../src/sim/index.ts', import.meta.url))],
  format: 'iife',
  globalName: 'TestSim',
  bundle: true,
  write: false,
})).outputFiles[0].text;
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
await send('Emulation.setDeviceMetricsOverride', {
  width, height, deviceScaleFactor: 1, mobile: true,
});
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
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
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};
let failures = 0;

// Award the human (team 0) a penalty by fouling a CPU (team 1) defender.
const humanPenalty = `(() => {
  const w = window.game.world;
  const defender = w.players.find((p) => p.team === 1 && p.role === 'DEF');
  TestSim.awardFoul(w, defender, true);
  return { team: w.setPiece?.team, phase: w.phase };
})()`;

const url = new URL(process.argv[2]);
url.searchParams.set('autostart', '');
await send('Page.navigate', { url: url.toString() });
await until('!!window.game?.world && document.querySelectorAll(".overlay-layer").length === 1');
await evaluate(sim + '\n;0');

// --- First penalty: choose RIGHT (index 2) ---
await evaluate(humanPenalty);
await until('!!document.querySelector(".penalty-panel")');
const beforeR = await evaluate(`(() => {
  const w = window.game.world;
  const panel = document.querySelector('.penalty-panel');
  const buttons = [...document.querySelectorAll('.dive-btn')];
  return {
    state: window.game.state, paused: w.paused, phase: w.phase,
    buttons: buttons.map((b) => b.textContent.trim()),
    rects: buttons.map((b) => { const r = b.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width, h: r.height }; }),
    panel: { l: panel.getBoundingClientRect().left, r: panel.getBoundingClientRect().right, sh: panel.scrollHeight, ch: panel.clientHeight },
  };
})()`);
console.log('overlay', JSON.stringify(beforeR));
check('human penalty opens a paused shoot choice', beforeR.state === 'penalty' && beforeR.paused && beforeR.phase === 'penalty');
check('three placement targets appear', beforeR.buttons.length === 3 &&
  beforeR.buttons[0].includes('Left') && beforeR.buttons[1].includes('Centre') && beforeR.buttons[2].includes('Right'));
check('all three touch targets fit the viewport', beforeR.rects.every((b) =>
  b.w >= 45 && b.h >= 42 && b.l >= -1 && b.r <= width + 1));
check('panel fits horizontally', beforeR.panel.l >= -1 && beforeR.panel.r <= width + 1 &&
  beforeR.panel.sh <= beforeR.panel.ch + 2);
await screenshot('01-choose-right');
const tickBeforeRight = await evaluate('window.game.world.tick');
await sleep(250);
check('the sim stays frozen until a placement is chosen',
  (await evaluate('window.game.world.tick')) === tickBeforeRight);

await evaluate(`document.querySelectorAll('.dive-btn')[2].click()`);
await until('window.game.state === "match" && !window.game.world.paused');
check('the choice closes the overlay and resumes play',
  await evaluate('document.querySelectorAll(".penalty-panel").length') === 0);

const strikeR = await evaluate(`(() => {
  const w = window.game.world;
  let guard = 0;
  while (w.phase !== 'penaltyshot' && guard++ < 60 * 5) TestSim.step(w, TestSim.TICK);
  if (w.phase !== 'penaltyshot') throw new Error('Penalty was not struck');
  w.paused = true;
  return { phase: w.phase, velocity: w.ball.vel, penalties: w.stats.penalties[0] };
})()`);
console.log('strike-right', JSON.stringify(strikeR));
check('the penalty becomes a moving shot', strikeR.penalties === 1 && Math.abs(strikeR.velocity.x) > 12);
check('the human aim is queued (no exception so far)', errors.length === 0);
await screenshot('02-struck-right');
const vyRight = strikeR.velocity.y;

// Resolve the right-hand penalty before taking the left-hand one.
await evaluate(`(() => {
  const w = window.game.world; w.paused = false;
  let guard = 0;
  while (w.phase === 'penaltyshot' && guard++ < 60 * 5) TestSim.step(w, TestSim.TICK);
  w.paused = true;
  return w.phase;
})()`);
await screenshot('03-resolved-right');

// --- Second penalty: choose LEFT (index 0) ---
await evaluate(humanPenalty);
await until('!!document.querySelector(".penalty-panel")');
await evaluate(`document.querySelectorAll('.dive-btn')[0].click()`);
await until('window.game.state === "match" && !window.game.world.paused');
const strikeL = await evaluate(`(() => {
  const w = window.game.world;
  let guard = 0;
  while (w.phase !== 'penaltyshot' && guard++ < 60 * 5) TestSim.step(w, TestSim.TICK);
  if (w.phase !== 'penaltyshot') throw new Error('Penalty was not struck');
  w.paused = true;
  return { velocity: w.ball.vel };
})()`);
const vyLeft = strikeL.velocity.y;
console.log('strike-right.vy', vyRight, 'strike-left.vy', vyLeft);
// Screen mapping: the +Z camera mirrors world +Y onto the screen's LEFT, so a
// "right" pick (world -Y, vy < 0) appears on the screen's right, i.e. to the
// screen-right of a "left" pick (world +Y, vy > 0). Hence vyRight < vyLeft.
check('a right placement launches to screen-right of a left placement',
  vyRight < vyLeft && vyRight < 0 && vyLeft > 0);

check('the page reported no JavaScript exceptions', errors.length === 0);
await screenshot('04-struck-left');
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({
  viewport: [width, height], beforeR, strikeR, vyRight, vyLeft, errors, failures,
}, null, 2));
console.log(`=== ${failures} failed check(s) ===`);
ws.close();
process.exit(failures ? 1 : 0);
