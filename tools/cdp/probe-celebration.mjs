// Dev-only: score a real goal through the shipped sim and watch the Vibers
// celebrate. Run after `npm run bundle`:
//   tools/cdp/run.sh tools/cdp/probe-celebration.mjs docs/screens-celebration
//   VW=390 VH=844 tools/cdp/run.sh tools/cdp/probe-celebration.mjs docs/screens-celebration-portrait
//
// NOTE ON FRAMES. Headless Chrome does not run the app's requestAnimationFrame
// loop on its own here — the sim sits at tick 0 until something forces a
// compositor frame. `Page.captureScreenshot` does, which is how flow-club.mjs
// drives a whole match. So this probe always *takes a shot before it reads a
// rig*: the shot pumps the frame, that frame runs the real `sync`, and only then
// is the pose meaningful. The positive control in step A pins that down.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const port = Number(process.env.CDP_PORT || 9333);
const outDir = path.resolve(process.env.OUT_DIR || 'docs/screens-celebration');
const width = Number(process.env.VW || 844);
const height = Number(process.env.VH || 390);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync(outDir, { recursive: true });

// Test-only IIFE. Calls the real sim on the world the app is rendering.
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
    pending.set(mid, { resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (error) => { clearTimeout(timer); reject(error); } });
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
  if (name) fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(result.data, 'base64'));
};
/** Force a frame, then read the rigs. Order matters — see the header note. */
const frameThenRead = async (name) => {
  await screenshot(name);
  return evaluate(readRigs);
};
/** Pump `n` throwaway frames (the only way to advance the loop here). */
const pump = async (n) => { for (let i = 0; i < n; i++) await screenshot(null); };

/**
 * Settle the camera by calling the real `sync` directly. Going through frames
 * would work too, but each frame ages the HUD banner timer, and the banner is
 * only 2.2s — so the camera and the banner cannot both be reached that way.
 */
const settleCamera = (n) => evaluate(`(() => {
  const g = window.game;
  for (let i = 0; i < ${n}; i++) g.renderer.sync(g.world, 0);
  return 1;
})()`);
let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};

/** Arms + root height for every player, straight off the live rigs. */
const readRigs = `(() => {
  const g = window.game;
  const w = g.world;
  const rigs = g.renderer.rigs;
  return w.players.map((p, i) => {
    const r = rigs[i];
    return {
      team: p.team,
      role: p.role,
      armL: r ? r.armL.rotation.x : null,
      armR: r ? r.armR.rotation.x : null,
      splay: r ? r.armL.rotation.z : null,
      y: r ? r.group.position.y : null,
    };
  });
})()`;

/**
 * A Viber is celebrating if either arm is overhead or the arms are thrown out
 * wide. Locomotion can only reach |rotation.x| <= 0.82 and never splays, so
 * this cannot be satisfied by running.
 */
const isCelebrating = (p) =>
  p.armL > 2.2 || p.armR > 2.2 || Math.abs(p.splay) > 1.2;

/** The camera, so the goal push-in can be measured rather than assumed. */
const readCam = `(() => {
  const c = window.game.renderer.camera;
  return { y: +c.position.y.toFixed(2), z: +c.position.z.toFixed(2) };
})()`;

const url = new URL(process.argv[2]);
url.searchParams.set('autostart', '');
// A pinned match, so the celebration is framed against the same goal every run.
// Seed 9 has the human scoring inside 16s; seed 13 has the CPU scoring at 12s,
// which puts the celebration at the other end of the pitch.
url.searchParams.set('seed', process.env.SEED || '9');
await send('Page.navigate', { url: url.toString() });
await until('!!window.game?.world && document.querySelectorAll(".overlay-layer").length === 1');
await evaluate(sim + '\n;0');

// ---- A. positive control: does a frame actually reach the rigs? ----
// Locomotion can only ever produce |arm| <= 0.82, so a planted 99 is a clean
// probe for "did sync run". If this fails, every reading below is meaningless.
await evaluate('window.game.renderer.rigs[0].armL.rotation.x = 99; 1');
const afterFrame = await frameThenRead(null);
check('a forced frame reaches the rigs (sync is running)',
  Math.abs(afterFrame[0].armL) <= 0.85);

const calm = await frameThenRead('01-before-goal');
const calmCam = await evaluate(readCam);
check('no celebration before the goal', calm.every((p) => !isCelebrating(p)));

/*
 * Play the sim forward headlessly until it scores. This is a *real* goal from
 * real play, not a teleported ball — which matters here, because the whole
 * question is whether the celebration is framed and visible. A staged ball on
 * the goal line leaves the attacking side back in their own half, and the
 * camera has nothing to show.
 */
const goal = await evaluate(`(() => {
  const w = window.game.world;
  w.paused = false;
  let guard = 0;
  let scored = null;
  // A full match plus a margin. Half-time parks the sim until it is resumed,
  // so that has to be driven too or the search just spins out at the break.
  //
  // Events are drained as we go. Stepping the sim headlessly leaves the app's
  // own event handler far behind, and when it finally gets a frame it replays
  // the whole backlog — including the half-time whistle, which pops the
  // half-time overlay over the celebration. Only the goal is handed back.
  while (guard++ < 60 * 400) {
    if (w.phase === 'halftime') TestSim.queue(w, { type: 'resume' });
    TestSim.step(w, TestSim.TICK);
    const events = TestSim.drainEvents(w);
    if (w.phase === 'goal') {
      scored = events.find((e) => e.type === 'goal') ?? null;
      break;
    }
  }
  if (w.phase !== 'goal') throw new Error('no goal inside a full match');
  // Hand the app the goal alone, so it fires its banner and confetti.
  if (scored) w.events.push(scored);
  // Leave the goal event in the queue: the app's own handler still has to fire
  // the banner and the confetti, and that is part of what is being looked at.
  w.paused = true; // hold the goal frame
  return {
    phase: w.phase,
    team: w.lastGoalTeam,
    score: w.teams.map((t) => t.score),
    ticks: guard,
  };
})()`);
console.log('goal', JSON.stringify(goal));
check('a real goal is scored by the sim', goal.phase === 'goal' && goal.team !== null);

/** Step the *real sim* to `t` seconds into the goal, then freeze it there. */
const seek = (t) => evaluate(`(() => {
  const w = window.game.world;
  w.paused = false;
  let guard = 0;
  while (TestSim.GOAL_PAUSE - w.phaseTimer < ${t} && guard++ < 600) TestSim.step(w, TestSim.TICK);
  w.paused = true;
  return { elapsed: TestSim.GOAL_PAUSE - w.phaseTimer, phase: w.phase };
})()`);

// ---- B. mid-celebration ----
const mid = await seek(0.4);
// The sim was stepped headlessly, so `camZ` never followed the ball up the
// pitch. Settle the camera before the shot, then take exactly one frame so the
// app's own goal banner and confetti are still on screen when it lands.
await settleCamera(80);
const posed = await frameThenRead('02-celebrating');
const banner = await evaluate(`(() => {
  const b = document.querySelector('.banner');
  return b ? { text: b.textContent, shown: b.classList.contains('show') } : null;
})()`);
console.log('banner', JSON.stringify(banner));
check('the app still fires its own goal banner and confetti',
  !!banner && banner.shown && /GOAL/i.test(banner.text));
check('nothing is covering the pitch during the celebration',
  await evaluate('document.querySelectorAll(".overlay-screen").length') === 0);

/*
 * Where the celebration actually lands on screen. A celebration behind the
 * centred GOAL banner is no more visible than one at the far end, so this
 * projects each celebrating Viber's head through the live camera and checks it
 * clears the banner and is inside the viewport.
 */
const framing = await evaluate(`(() => {
  const g = window.game;
  const w = g.world;
  const cam = g.renderer.camera;
  const rigs = g.renderer.rigs;
  const box = document.querySelector('.banner').getBoundingClientRect();
  const v = rigs[0].group.position.clone();
  const players = w.players.map((p, i) => {
    if (p.team !== w.lastGoalTeam) return null;
    // Head height in world units (the rig is ~1.9 tall at ROOT_SCALE).
    v.set(rigs[i].group.position.x, 1.9, rigs[i].group.position.z).project(cam);
    return {
      x: (v.x * 0.5 + 0.5) * window.innerWidth,
      y: (-v.y * 0.5 + 0.5) * window.innerHeight,
    };
  }).filter(Boolean);
  return {
    banner: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
    players,
    view: { w: window.innerWidth, h: window.innerHeight },
  };
})()`);
const onScreen = framing.players.filter((p) =>
  p.x >= 0 && p.x <= framing.view.w && p.y >= 0 && p.y <= framing.view.h);
const clearOfBanner = onScreen.filter((p) =>
  p.y > framing.banner.bottom || p.x < framing.banner.left || p.x > framing.banner.right);
console.log('framing', JSON.stringify({
  onScreen: onScreen.length,
  clearOfBanner: clearOfBanner.length,
  banner: framing.banner,
  players: framing.players.map((p) => [+p.x.toFixed(0), +p.y.toFixed(0)]),
  view: framing.view,
}));
/*
 * The bar is deliberately "clearly visible", not "perfectly framed". The
 * landscape HUD owns the middle of the screen — score bar at the top, goal
 * banner under it, the control row at ~55% — so a group of Vibers spread from
 * the box back towards midfield cannot all land in clear air. What must be true
 * is that the celebration is on screen and at least partly unobstructed; if the
 * camera ever stopped pushing in, both of these collapse to zero.
 */
check('the celebration is on screen, not just in the sim',
  onScreen.length >= 2);
check('the celebration is not entirely hidden behind the HUD',
  clearOfBanner.length >= 1);
const arms = (list) => list.map((p) => [p.team, +p.armL.toFixed(2), +p.armR.toFixed(2)]);
console.log('mid', JSON.stringify(mid), JSON.stringify(arms(posed)));

const scorers = posed.filter((p) => p.team === goal.team);
const others = posed.filter((p) => p.team !== goal.team);
check('every Viber on the scoring side is celebrating',
  scorers.length === 5 && scorers.every(isCelebrating));
check('the conceding side does not celebrate', others.every((p) => !isCelebrating(p)));
check('at least one Viber actually leaves the ground', scorers.some((p) => p.y > 0.05));
check('the celebration is a lift, never a sink into the pitch', posed.every((p) => p.y >= 0));
check('a squad does not move as one — the three variants all appear',
  new Set(scorers.map((p) => [p.armL, p.armR, p.splay].map((v) => v.toFixed(2)).join()))
    .size >= 3);

// The push-in is what makes any of the above visible: from the full-pitch rig
// the celebration is a few pixels at the far end.
const goalCam = await evaluate(readCam);
console.log('camera', JSON.stringify({ calm: calmCam, goal: goalCam }));
check('the camera pushes in on the goal', goalCam.y < calmCam.y - 4);

// ---- C. the celebration is over well before the restart ----
const late = await seek(2.1);
const settled = await frameThenRead('03-after-celebration');
console.log('settled', JSON.stringify(late), JSON.stringify(arms(settled)));
check('the celebration is short — it is over well before the restart',
  late.elapsed > 2 && late.elapsed < 2.6 && settled.every((p) => !isCelebrating(p)));

await pump(10);
const settledCam = await evaluate(readCam);
console.log('camera after', JSON.stringify(settledCam));
check('the camera pulls back out for the restart', settledCam.y > goalCam.y + 5);

// ---- D. the match plays on afterwards ----
const resumed = await evaluate(`(() => {
  const w = window.game.world;
  w.paused = false;
  const before = w.phaseTimer;
  let guard = 0;
  while (w.phase === 'goal' && guard++ < 600) TestSim.step(w, TestSim.TICK);
  return { phase: w.phase, tick: w.tick, wasGoal: before > 0 };
})()`);
console.log('resumed', JSON.stringify(resumed));
check('the match returns to play after the celebration',
  ['kickoff', 'play'].includes(resumed.phase));

check('the page reported no JavaScript exceptions', errors.length === 0);
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({
  viewport: [width, height], goal, banner, mid, late, resumed,
  camera: { calm: calmCam, goal: goalCam, after: settledCam },
  posed, settled, errors, failures,
}, null, 2));
console.log(`=== ${failures} failed check(s) ===`);
ws.close();
process.exit(failures ? 1 : 0);
