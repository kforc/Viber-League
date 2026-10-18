// Dev-only: prove the league squad locks once the season has started, and that
// an injured starter is covered from the squad rather than replaced from the
// roster.
//
//   npm run bundle && tools/cdp/run.sh tools/cdp/probe-squad-lock.mjs docs/screens-lock
//
// The state is reached the honest way — create a league, play a fixture — rather
// than by writing a hand-made career into localStorage, because the rule under
// test is a rule about a season, and a season is what a played fixture makes.
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.CDP_PORT || 9333);
const outDir = path.resolve(process.env.OUT_DIR || 'docs/screens-lock');
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
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${predicate}`);
};
const screenshot = async (name) => {
  const result = await send('Page.captureScreenshot', { format: 'png' }, 45000);
  fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(result.data, 'base64'));
};
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};
const clickText = (text, selector = 'button') =>
  evaluate(`(() => {
    const needle = ${JSON.stringify(text)}.toLowerCase();
    const b = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((n) => n.textContent.replace(/\\s+/g, ' ').trim().toLowerCase().includes(needle));
    if (!b) return false;
    b.click();
    return true;
  })()`);
const exists = (selector) => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
const textOf = (selector) =>
  evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? null`);
const freeze = () => evaluate(`(() => {
  if (document.getElementById('freeze')) return 'frozen';
  const s = document.createElement('style');
  s.id = 'freeze';
  s.textContent = '*,*::before,*::after{animation:none !important;transition:none !important}';
  document.head.append(s);
  return 'frozen';
})()`);

const url = process.argv[2];
const go = async (wait = 8500) => {
  await send('Page.navigate', { url });
  await sleep(wait);
  await freeze();
};

// --- a club, and a career with a squad but no season ---------------------
await go(3000);
await evaluate(`(() => {
  try {
    localStorage.setItem('viber-league:profile:v1', JSON.stringify({
      manager: 'Alex', club: 'Riverside Rovers', short: 'RR',
      hash: null, salt: null, iterations: 100000,
      createdAt: '2026-10-09T00:00:00.000Z',
    }));
    localStorage.removeItem('viber-league:career:v1');
  } catch {}
  return 1;
})()`);
// Two-second halves and clear weather: the match is a formality here, and rain
// particles in software WebGL are the difference between 30 seconds and 3
// minutes of wall clock.
await go();
await evaluate(`(() => {
  const k = 'viber-league:career:v1';
  const c = JSON.parse(localStorage.getItem(k) || '{}');
  c.settings = { ...(c.settings || {}), halfSeconds: 2, weather: 'sun' };
  localStorage.setItem(k, JSON.stringify(c));
  return 1;
})()`);
await go();

// --- 1. an unstarted season does NOT lock the squad ----------------------
await clickText('League', '.menu-opt');
await sleep(700);
check('a club with no league meets the league gate', await exists('.league-gate'));
await clickText('New League', 'button');
await sleep(900);
const openNote = await evaluate(
  `document.querySelector('.section-note')?.textContent.trim() ?? null`);
console.log('open-season note:', JSON.stringify(openNote));
check('a brand-new season is not locked', !/squad locked/i.test(openNote ?? ''),
  'note=' + JSON.stringify(openNote));
check('the league offers PLAY NEXT MATCH', await exists('.flow-actions .primary-btn'));

// --- 2. name the squad and play the first fixture ------------------------
await clickText('Play Next Match', '.primary-btn');
await sleep(900);
check('the first fixture opens the squad picker', await exists('.squad-screen'));
const firstOpen = await evaluate(`(() => ({
  chip: !!document.querySelector('.screen-head .lock-chip'),
  ring: !!document.querySelector('.screen-head .pick-ring'),
  adds: [...document.querySelectorAll('.card-add')].filter((b) => b.disabled).length,
}))()`);
check('the picker is editable before a fixture is played',
  firstOpen.chip === false && firstOpen.ring === true && firstOpen.adds === 0,
  JSON.stringify(firstOpen));

await clickText('Auto', 'button');
await sleep(800);
const named = await evaluate(
  `[...document.querySelectorAll('.strip-group.start .strip-name')].map((n) => n.textContent.trim())`);
console.log('named five:', JSON.stringify(named));
check('AUTO PICK names a starting five', named.length === 5, 'n=' + named.length);
for (let i = 0; i < 3; i++) {
  await evaluate(`document.querySelector('.flow-actions .primary-btn')?.click()`);
  await sleep(700);
}
check('the fixture reaches the opponent screen', await exists('.vs-row'));
await evaluate(`document.querySelector('.flow-actions .primary-btn')?.click()`);
await sleep(2500);
check('the match HUD is up', await exists('.hud'));

/*
 * Drive the match to full time.
 *
 * The clock is real time and software WebGL is the slow part, but the match also
 * STOPS — at half-time for a mentality, and at a penalty for a dive. A probe
 * that just waits for the result screen waits forever at the first of those.
 */
const resultUp = () =>
  evaluate(`document.querySelector('.overlay-screen')?.textContent.includes('Back to the League') === true`);
const deadline = Date.now() + 240000;
let drove = 0;
while (Date.now() < deadline) {
  if (await resultUp()) break;
  const screen = await evaluate(`(() => {
    const o = document.querySelector('.overlay-screen');
    if (!o) return null;
    const title = o.querySelector('.panel-title')?.textContent.trim() ?? '';
    const btn = o.querySelector('.choice-btn');
    return { title, label: btn?.textContent.trim() ?? null };
  })()`);
  if (screen?.label) {
    await evaluate(`document.querySelector('.overlay-screen .choice-btn')?.click()`);
    drove++;
    await sleep(900);
    continue;
  }
  await sleep(600);
}
console.log('overlays dismissed:', drove);
await until(
  `document.querySelector('.overlay-screen')?.textContent.includes('Back to the League') === true`,
  60000,
);
await screenshot('01-result');
await clickText('Back to the League', 'button');
await sleep(900);

// --- 3. the season has started, so the squad is frozen -------------------
const lockNote = await textOf('.league-screen .section-note');
console.log('locked note:', JSON.stringify(lockNote));
check('the League screen says the squad is locked',
  typeof lockNote === 'string' && /squad locked until the season ends/i.test(lockNote),
  'note=' + JSON.stringify(lockNote));
check('the League screen says injuries are covered from the reserves',
  typeof lockNote === 'string' && /injuries are covered from the reserves/i.test(lockNote));
await screenshot('02-league-locked');

// --- 4. the picker is a team sheet, not a picker -------------------------
await clickText('Play Next Match', '.primary-btn');
await sleep(900);
check('the picker still opens for the next fixture', await exists('.squad-screen'));
const locked = await evaluate(`(() => {
  const adds = [...document.querySelectorAll('.card-add')];
  const ghosts = [...document.querySelectorAll('.flow-actions .ghost-btn')];
  const primary = document.querySelector('.flow-actions .primary-btn');
  return {
    chip: document.querySelector('.screen-head .lock-chip')?.textContent.trim() ?? null,
    ring: !!document.querySelector('.screen-head .pick-ring'),
    adds: adds.length,
    addsDisabled: adds.filter((b) => b.disabled).length,
    addsBlocked: adds.filter((b) => b.classList.contains('blocked')).length,
    ghosts: ghosts.map((b) => ({ label: b.textContent.trim(), disabled: b.disabled })),
    primary: primary ? { label: primary.textContent.trim(), disabled: primary.disabled } : null,
  };
})()`);
console.log('locked picker:', JSON.stringify(locked));
check('the header shows the lock instead of the pick ring',
  locked.chip === 'Locked' && locked.ring === false, JSON.stringify({ chip: locked.chip, ring: locked.ring }));
check('every card control is disabled',
  locked.adds > 0 && locked.addsDisabled === locked.adds,
  `${locked.addsDisabled}/${locked.adds}`);
check('the disabled card controls are the neutral "blocked" paint, not the red remove',
  locked.addsBlocked === locked.adds, `${locked.addsBlocked}/${locked.adds}`);
check('AUTO PICK and CLEAR are both disabled',
  locked.ghosts.length === 2 && locked.ghosts.every((g) => g.disabled),
  JSON.stringify(locked.ghosts));
check('the primary action reads PLAY MATCH and is still live',
  locked.primary?.label === 'Play Match' && locked.primary?.disabled === false,
  JSON.stringify(locked.primary));
await screenshot('03-picker-locked');

// A card sheet is still readable, and says why its button is dead.
await evaluate(`document.querySelector('.viber-card2')?.click()`);
await sleep(800);
const sheet = await evaluate(`(() => {
  const b = document.querySelector('.sheet .primary-btn');
  return { open: !!document.querySelector('.sheet'), label: b?.textContent.trim() ?? null, disabled: b?.disabled ?? null };
})()`);
console.log('card sheet:', JSON.stringify(sheet));
check('a player card still opens while the squad is locked', sheet.open === true);
check('its action says the squad is locked and cannot be pressed',
  sheet.label === 'Squad locked for the season' && sheet.disabled === true,
  JSON.stringify(sheet));
await screenshot('04-card-locked');
await evaluate(`document.querySelector('.sheet .back-btn')?.click()`);
await sleep(600);

// --- 5. an injury promotes from the squad, not from the roster ----------
const lineup = await evaluate(
  `JSON.parse(localStorage.getItem('viber-league:career:v1') || '{}').lineup ?? []`);
const before = await evaluate(`(() => ({
  start: [...document.querySelectorAll('.strip-group.start .strip-name')].map((n) => n.textContent.trim()),
  startN: [...document.querySelectorAll('.strip-group.start .strip-n')].map((n) => Number(n.textContent.trim())),
  bench: [...document.querySelectorAll('.strip-group.bench .strip-name')].map((n) => n.textContent.trim()),
}))()`);
console.log('squad before injury:', JSON.stringify(before));
check('the club named a twelve-man squad', lineup.length === 12, 'n=' + lineup.length);
check('the starting five is numbered 1-12, in squad order',
  before.startN.length === 5 && before.startN.every((n) => n >= 1 && n <= 12),
  JSON.stringify(before.startN));

/*
 * The strip numbers each slot with the player's place in `career.lineup`, so the
 * slot number is the lookup: no second roster table, and no assumption that the
 * first name on the team sheet is the first id in the saved squad — a match can
 * have injured someone before this point, and it very often has.
 */
const hurtId = lineup[before.startN[0] - 1];
check('the first starter resolves to a real squad id', typeof hurtId === 'string', String(hurtId));
await evaluate(`(() => {
  const k = 'viber-league:career:v1';
  const c = JSON.parse(localStorage.getItem(k) || '{}');
  c.absences = { ...(c.absences || {}), ${JSON.stringify(hurtId)}: { kind: 'injury', matches: 2 } };
  localStorage.setItem(k, JSON.stringify(c));
  return 1;
})()`);
await go();
await clickText('League', '.menu-opt');
await sleep(700);
await clickText('Play Next Match', '.primary-btn');
await sleep(900);

const after = await evaluate(`(() => ({
  start: [...document.querySelectorAll('.strip-group.start .strip-name')].map((n) => n.textContent.trim()),
  bench: [...document.querySelectorAll('.strip-group.bench .strip-name')].map((n) => n.textContent.trim()),
  benchTags: [...document.querySelectorAll('.strip-group.bench .strip-tag')].map((n) => n.textContent.trim()),
  outCards: document.querySelectorAll('.viber-card2.is-out').length,
  chip: document.querySelector('.screen-head .lock-chip')?.textContent.trim() ?? null,
}))()`);
console.log('squad after injury:', JSON.stringify(after));
check('the squad is still locked with an injured starter', after.chip === 'Locked');
check('the injured starter is no longer in the starting five',
  after.start[0] !== before.start[0], `${before.start[0]} -> ${after.start[0]}`);
check('his replacement comes from the club\'s own squad',
  after.start.every((n) => before.start.includes(n) || before.bench.includes(n)),
  JSON.stringify(after.start));
check('the injured player drops into the reserves, still in the squad',
  after.bench.includes(before.start[0]), JSON.stringify(after.bench));
check('and wears an OUT tag there',
  after.benchTags.some((t) => /^(INJ|OUT)/i.test(t)), JSON.stringify(after.benchTags));
await screenshot('05-injury-cover');

// --- 6. the library is read-only too ------------------------------------
await evaluate(`document.querySelector('.back-btn')?.click()`);
await sleep(700);
await evaluate(`document.querySelector('.back-btn')?.click()`);
await sleep(900);
check('back returns to the menu', await exists('.menu-screen'));
await clickText('Players', '.menu-opt');
await sleep(900);
const library = await evaluate(`(() => {
  const adds = [...document.querySelectorAll('.card-add')];
  return {
    chip: document.querySelector('.screen-head .lock-chip')?.textContent.trim() ?? null,
    ring: !!document.querySelector('.screen-head .pick-ring'),
    adds: adds.length,
    addsDisabled: adds.filter((b) => b.disabled).length,
  };
})()`);
console.log('players library:', JSON.stringify(library));
check('the Players library shows the lock',
  library.chip === 'Locked' && library.ring === false, JSON.stringify(library));
check('no card in the library can be added or dropped',
  library.adds > 0 && library.addsDisabled === library.adds,
  `${library.addsDisabled}/${library.adds}`);
await screenshot('06-players-locked');

// --- 7. Settings cannot clear a locked squad ----------------------------
await evaluate(`document.querySelector('.back-btn')?.click()`);
await sleep(800);
await clickText('Settings', '.menu-opt');
await sleep(900);
const settings = await evaluate(`(() => {
  const row = [...document.querySelectorAll('.setting-row')]
    .find((r) => r.querySelector('.setting-label')?.textContent.trim() === 'Squad');
  const b = row?.querySelector('button');
  return { label: b?.textContent.trim() ?? null, disabled: b?.disabled ?? null };
})()`);
console.log('settings squad row:', JSON.stringify(settings));
check('CLEAR SQUAD reads LOCKED and is disabled',
  settings.label === 'Locked' && settings.disabled === true, JSON.stringify(settings));
await screenshot('07-settings-locked');

check('the page reported no JavaScript exceptions', errors.length === 0, errors.join(' | '));

fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({
  viewport: [width, height], openNote, named, lockNote, locked, sheet, before, after, library, settings, errors, failures,
}, null, 2));
console.log(`=== ${failures} failed check(s) ===`);
ws.close();
process.exit(failures ? 1 : 0);
