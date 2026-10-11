// Dev-only: prove the arrangement follows the mentality, visually and
// numerically. Lays team 0 out at a kickoff under each mentality and captures a
// frame of each. Run after `npm run bundle`:
//   tools/cdp/run.sh tools/cdp/probe-arrangement.mjs docs/screens-arrangement
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const port = Number(process.env.CDP_PORT || 9333);
const outDir = path.resolve(process.env.OUT_DIR || 'docs/screens-arrangement');
const width = Number(process.env.VW || 844);
const height = Number(process.env.VH || 390);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync(outDir, { recursive: true });

const sim = (
  await build({
    entryPoints: [fileURLToPath(new URL('../../src/sim/index.ts', import.meta.url))],
    format: 'iife',
    globalName: 'TestSim',
    bundle: true,
    write: false,
  })
).outputFiles[0].text;

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page =
  list.find((tab) => tab.type === 'page' && tab.url !== 'about:blank') ??
  list.find((tab) => tab.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const errors = [];
function send(method, params = {}, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    const timer = setTimeout(() => {
      pending.delete(mid);
      reject(new Error(`TIMEOUT ${method}`));
    }, timeout);
    pending.set(mid, {
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
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
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description || 'eval error');
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
  // Hide the transient centre banners so the arrangement underneath is visible.
  await evaluate(
    `(() => {
      for (const sel of ['.banner', '.setpiece-el', '.setpiece']) {
        const el = document.querySelector(sel);
        if (el) el.style.display = 'none';
      }
      return true;
    })()`,
  );
  const result = await send('Page.captureScreenshot', { format: 'png' }, 45000);
  fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(result.data, 'base64'));
};
let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};

const url = new URL(process.argv[2]);
url.searchParams.set('autostart', '');
await send('Page.navigate', { url: url.toString() });
await until('!!window.game?.world && document.querySelectorAll(".overlay-layer").length === 1');
await evaluate(sim + '\n;0');

// Lay out team 0 at a kickoff under `m`, freeze, and read the outfield shape.
const layOut = async (m, shot) => {
  const r = await evaluate(`(() => {
    const w = window.game.world;
    w.paused = false; // step() no-ops while paused, so unpause before applying
    TestSim.queue(w, { type: 'mentality', team: 0, value: ${JSON.stringify(m)} });
    TestSim.step(w, TestSim.TICK);
    TestSim.resetPositions(w, 'kickoff');
    w.paused = true; // freeze so the capture shows exactly this shape
    const of = w.players.filter((p) => p.team === 0 && !p.isGK);
    const avgX = of.reduce((a, p) => a + p.pos.x, 0) / of.length;
    const width = of.reduce((a, p) => a + Math.abs(p.pos.y), 0) / of.length;
    const xs = of.map((p) => Math.round(p.pos.x * 10) / 10);
    return { mentality: w.teams[0].mentality, avgX, width, xs };
  })()`);
  await screenshot(shot);
  return r;
};

const atk = await layOut('attack', '01-attack');
const bal = await layOut('balanced', '02-balanced');
const def = await layOut('defend', '03-defend');
const ctr = await layOut('counter', '04-counter');
console.log('attack  ', JSON.stringify(atk));
console.log('balanced', JSON.stringify(bal));
console.log('defend  ', JSON.stringify(def));
console.log('counter ', JSON.stringify(ctr));

// Live play: hand the CPU the ball in midfield so team 0 shapes up off the
// ball, let it settle, then freeze and capture — this is the shape the player
// actually sees, with the kickoff banner gone.
const liveShape = async (m, shot) => {
  const r = await evaluate(`(() => {
    const w = window.game.world;
    w.paused = false;
    TestSim.queue(w, { type: 'mentality', team: 0, value: ${JSON.stringify(m)} });
    // A ball pinned dead at the centre spot: one player chases it and the rest
    // settle into their off-ball block, so the shape is not smeared by a
    // moving ball.
    for (let i = 0; i < 60 * 4; i++) {
      w.ball.owner = null;
      w.ball.pos = TestSim.v2(0, 0);
      w.ball.vel = TestSim.v2(0, 0);
      w.ball.h = 0.22;
      TestSim.step(w, TestSim.TICK);
    }
    w.paused = true;
    const of = w.players.filter((p) => p.team === 0 && !p.isGK);
    const avgX = of.reduce((a, p) => a + p.pos.x, 0) / of.length;
    const width = of.reduce((a, p) => a + Math.abs(p.pos.y), 0) / of.length;
    return { mentality: w.teams[0].mentality, avgX, width };
  })()`);
  await screenshot(shot);
  return r;
};
const liveAtk = await liveShape('attack', '05-live-attack');
const liveDef = await liveShape('defend', '06-live-defend');
console.log('live-attack', JSON.stringify(liveAtk));
console.log('live-defend', JSON.stringify(liveDef));

check('attack lines up higher up the pitch than defend', atk.avgX > def.avgX + 2);
check('attack is wider than a defensive block', atk.width > def.width);
check('defend sits deeper than balanced', def.avgX < bal.avgX);
check('counter sits between defend and balanced', ctr.avgX > def.avgX && ctr.avgX < bal.avgX);
check('in live play an attacking side holds a higher line than a defending one', liveAtk.avgX > liveDef.avgX);
check('the page reported no JavaScript exceptions', errors.length === 0);

fs.writeFileSync(
  path.join(outDir, 'report.json'),
  JSON.stringify(
    { viewport: [width, height], attack: atk, balanced: bal, defend: def, counter: ctr, liveAttack: liveAtk, liveDefend: liveDef, errors, failures },
    null,
    2,
  ),
);
console.log(`=== ${failures} failed check(s) ===`);
ws.close();
process.exit(failures ? 1 : 0);
