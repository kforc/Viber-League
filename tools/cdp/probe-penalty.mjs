// Dev-only: make an actual foul inside the human's area, then exercise the
// shipped match UI and its dive command. Run after `npm run bundle`:
//   tools/cdp/run.sh tools/cdp/probe-penalty.mjs docs/screens-penalty
//   VW=390 VH=844 tools/cdp/run.sh tools/cdp/probe-penalty.mjs docs/screens-penalty-portrait
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const port = Number(process.env.CDP_PORT || 9333);
const outDir = path.resolve(process.env.OUT_DIR || 'docs/screens-penalty');
const width = Number(process.env.VW || 844);
const height = Number(process.env.VH || 390);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync(outDir, { recursive: true });

// This test-only IIFE calls the real foul-award function on the actual world
// that the app is rendering. It does not ship with Viber-League.html.
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

const url = new URL(process.argv[2]);
url.searchParams.set('autostart', '');
await send('Page.navigate', { url: url.toString() });
await until('!!window.game?.world && document.querySelectorAll(".overlay-layer").length === 1');
await evaluate(sim + '\n;0');
await evaluate(`(() => {
  const w = window.game.world;
  const defender = w.players.find((p) => p.team === 0 && p.role === 'DEF');
  TestSim.awardFoul(w, defender, true);
  return 1;
})()`);
await until('!!document.querySelector(".penalty-panel")');
const before = await evaluate(`(() => {
  const w = window.game.world;
  const panel = document.querySelector('.penalty-panel');
  const buttons = [...document.querySelectorAll('.dive-btn')];
  return {
    state: window.game.state,
    paused: w.paused,
    phase: w.phase,
    tick: w.tick,
    buttons: buttons.map((button) => ({
      label: button.textContent.trim(),
      left: button.getBoundingClientRect().left,
      right: button.getBoundingClientRect().right,
      width: button.getBoundingClientRect().width,
      height: button.getBoundingClientRect().height,
    })),
    panel: {
      left: panel.getBoundingClientRect().left,
      right: panel.getBoundingClientRect().right,
      scrollHeight: panel.scrollHeight,
      clientHeight: panel.clientHeight,
    },
  };
})()`);
console.log('overlay', JSON.stringify(before));
check('foul opens a paused keeper choice', before.state === 'penalty' && before.paused && before.phase === 'penalty');
check('three directions appear in camera order', before.buttons.length === 3 &&
  before.buttons[0].label.includes('Left') && before.buttons[1].label.includes('Centre') &&
  before.buttons[2].label.includes('Right'));
check('all three touch targets fit the viewport', before.buttons.every((b) =>
  b.width >= 45 && b.height >= 42 && b.left >= -1 && b.right <= width + 1));
check('penalty panel fits horizontally', before.panel.left >= -1 && before.panel.right <= width + 1 &&
  before.panel.scrollHeight <= before.panel.clientHeight + 2);
await screenshot('01-choose-dive');
await sleep(250);
check('the sim stays frozen until a direction is chosen',
  await evaluate(`window.game.world.tick`) === before.tick);

await evaluate(`document.querySelectorAll('.dive-btn')[0].click()`);
await until('window.game.state === "match" && !window.game.world.paused');
check('the choice closes the overlay and resumes play',
  await evaluate('document.querySelectorAll(".penalty-panel").length') === 0);
// Software WebGL can run at 0.2x realtime. Advance the *real simulation*
// directly from this test-only probe rather than waiting tens of seconds for
// 120 animation frames. The app's queued command is still drained by step().
const shotInfo = await evaluate(`(() => {
  const w = window.game.world;
  let guard = 0;
  while (w.phase !== 'penaltyshot' && guard++ < 60 * 5) TestSim.step(w, TestSim.TICK);
  if (w.phase !== 'penaltyshot') throw new Error('Penalty was not struck');
  w.paused = true; // hold the struck frame for its screenshot
  return {
    phase: w.phase,
    dive: w.penaltyShot?.dive ?? null,
    velocity: w.ball.vel,
    penalties: w.stats.penalties[1],
    tick: w.tick,
  };
})()`);
console.log('strike', JSON.stringify(shotInfo));
check('the penalty becomes a moving shot', shotInfo.penalties === 1 &&
  Math.abs(shotInfo.velocity.x) > 12);
check('the queued left dive reaches the simulation', shotInfo.dive === 'left');
await screenshot('02-ball-in-flight');
const after = await evaluate(`(() => {
  const w = window.game.world;
  w.paused = false;
  let guard = 0;
  while (w.phase === 'penaltyshot' && guard++ < 60 * 5) TestSim.step(w, TestSim.TICK);
  w.paused = true;
  return {
    phase: w.phase,
    score: w.teams.map((team) => team.score),
    ballOwner: w.ball.owner,
    penaltyShot: w.penaltyShot,
  };
})()`);
console.log('resolved', JSON.stringify(after));
check('the ball resolves to play, goal or a restart',
  after.penaltyShot === null && ['play', 'goal', 'goalkick', 'corner'].includes(after.phase));
check('the page reported no JavaScript exceptions', errors.length === 0);
await screenshot('03-resolved');
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({
  viewport: [width, height], before, shot: shotInfo, after, errors, failures,
}, null, 2));
console.log(`=== ${failures} failed check(s) ===`);
ws.close();
process.exit(failures ? 1 : 0);
