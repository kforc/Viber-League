// Dev-only: drive the five club sections and the league loop over CDP.
//
//   menu -> League (table + fixtures) -> Squad -> Players -> Career -> Settings
//   -> League -> Play Next Match -> squad -> venue -> minutes -> opponent
//   -> kick off -> half-time -> full time -> result -> back to the League
//
// Writes <outDir>/<NN>-<name>.png plus report.json holding page errors,
// per-screen clipping/spill numbers, and the computed paint of the new
// controls — so "the tile is lime with a black outline" is a measurement
// rather than a vibe.
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.CDP_PORT || 9333);
const url = process.argv[2];
const outDir = path.resolve(process.env.OUT_DIR || 'docs/screens');
const W = Number(process.env.VW || 844);
const H = Number(process.env.VH || 390);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(outDir, { recursive: true });

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page =
  list.find((t) => t.type === 'page' && t.url !== 'about:blank') ??
  list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);

let id = 0;
const pending = new Map();
const events = [];
function send(m, p = {}, t = 30000) {
  return new Promise((res, rej) => {
    const mid = ++id;
    const timer = setTimeout(() => {
      pending.delete(mid);
      rej(new Error('TIMEOUT ' + m));
    }, t);
    pending.set(mid, {
      resolve: (v) => { clearTimeout(timer); res(v); },
      reject: (e) => { clearTimeout(timer); rej(e); },
    });
    ws.send(JSON.stringify({ id: mid, method: m, params: p }));
  });
}
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
    events.push('console: ' + JSON.stringify(m.params.args.map((a) => a.value)));
  if (m.method === 'Runtime.exceptionThrown')
    events.push('exception: ' + (m.params.exceptionDetails?.exception?.description || ''));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error')
    events.push('log: ' + m.params.entry.text);
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
await send('Log.enable');

const evalJs = async (e) => {
  const r = await send('Runtime.evaluate', {
    expression: e, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result?.value;
};

const click = (sel, nth = 0) =>
  evalJs(`(() => {
    const all = [...document.querySelectorAll(${JSON.stringify(sel)})];
    const el = all[${nth}];
    if (!el) return 'MISSING ' + ${JSON.stringify(sel)} + '[' + ${nth} + '] of ' + all.length;
    el.scrollIntoView({ block: 'nearest' });
    for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    }
    return 'ok';
  })()`);

const clickText = (needle, sel = 'button') =>
  evalJs(`(() => {
    const all = [...document.querySelectorAll(${JSON.stringify(sel)})];
    const el = all.find((b) => (b.textContent || '').includes(${JSON.stringify(needle)}));
    if (!el) return 'MISSING text ' + ${JSON.stringify(needle)} + ' of ' + all.length;
    el.scrollIntoView({ block: 'nearest' });
    for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    }
    return 'ok';
  })()`);

const text = (sel) =>
  evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    return el ? el.textContent.trim() : null;
  })()`);

const count = (sel) => evalJs(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const exists = (sel) => evalJs(`!!document.querySelector(${JSON.stringify(sel)})`);

const css = (sel, props) =>
  evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const cs = getComputedStyle(el);
    return Object.fromEntries(${JSON.stringify(props)}.map((p) => [p, cs[p]]));
  })()`);

/*
 * Intentional scrollers. Several screens are DESIGNED to scroll — the fixture
 * list, the career page, and the landscape card rail (`overflow-x:auto` with
 * snap points). Counting those as "clipped" would drown out the real
 * regressions, so they are reported separately as `scrolls`.
 */
const SCROLLERS = [
  '.viber-grid', '.fixture-list', '.league-table', '.hero-body',
  '.screen', '.settings-screen', '.career-screen', '.squad-view',
  '.card-shine', '.account-sheet', '.profile-card',
  // The filter / tab chips are an `overflow-x: auto` rail; in portrait the five
  // role chips just exceed the row and are meant to be swiped.
  '.chip-row',
];
const isScroller = (cls) =>
  SCROLLERS.some((s) => cls.split(/\s+/).some((c) => '.' + c === s || c === s.slice(1)));

const probe = () =>
  evalJs(`(() => {
    const root = document.getElementById('ui');
    const scr = root?.querySelector('.screen');
    const name = scr ? [...scr.classList].join('.') : '(none)';
    const clipped = [], scrolls = [];
    for (const el of (root?.querySelectorAll('*') ?? [])) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const oy = el.scrollHeight - el.clientHeight;
      const ox = el.scrollWidth - el.clientWidth;
      const clipsY = cs.overflowY !== 'visible' && oy > 2;
      const clipsX = cs.overflowX !== 'visible' && ox > 2;
      if (clipsY || clipsX) {
        clipped.push({
          cls: (el.className || el.tagName).toString().slice(0, 48),
          scroll: el.scrollHeight + 'x' + el.scrollWidth,
          client: el.clientHeight + 'x' + el.clientWidth,
          oy, ox,
        });
      }
    }
    const vw = innerWidth, vh = innerHeight;
    const spill = [];
    for (const el of (root?.querySelectorAll('*') ?? [])) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.position === 'fixed') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.right > vw + 1.5 || r.left < -1.5 || r.bottom > vh + 1.5 || r.top < -1.5)
        spill.push({
          cls: (el.className || el.tagName).toString().slice(0, 48),
          box: [r.left, r.top, r.right, r.bottom].map((v) => Math.round(v)).join(','),
        });
    }
    return { screen: name, clipped, spill: spill.slice(0, 8) };
  })()`);

const shots = [];
let fails = 0;
async function shot(name, settle = 700) {
  await sleep(settle);
  const info = await probe();
  // Software WebGL saturates the renderer during a match, so the screenshot
  // needs a longer budget than a menu does.
  const r = await send('Page.captureScreenshot', { format: 'png' }, 45000);
  fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(r.data, 'base64'));

  // Split genuine clipping from the screens that are meant to scroll.
  const real = info.clipped.filter((c) => !isScroller(c.cls));
  const ok = info.clipped.filter((c) => isScroller(c.cls));
  shots.push({ name, screen: info.screen, clipped: real.length,
    scrolls: ok.length, spill: info.spill.length });
  console.log(`[${name}] screen=${info.screen} clipped=${real.length} scrolls=${ok.length} spill=${info.spill.length}`);
  if (real.length) console.log('   CLIPPED:', JSON.stringify(real.slice(0, 4)));
  if (info.spill.length) console.log('   spill:', JSON.stringify(info.spill.slice(0, 4)));
  if (real.length) fails++;
}

const check = (label, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
};

await send('Emulation.setDeviceMetricsOverride', {
  width: W, height: H, deviceScaleFactor: 1, mobile: true,
});

/*
 * AUDIO PROBE.
 *
 * Installed on every new document so it is already in place before the game's
 * module runs. It wraps AudioContext to record whether the game ever *builds*
 * one and whether it ever asks it to start. That is the whole assertion: the
 * crowd is synthesized, so there is no file to fetch and nothing to listen to
 * headlessly — what can be verified is that the graph is created on the kick-off
 * gesture and, crucially, that it is NOT created at all when sound is off.
 *
 * `resumed` counts calls, not successes. A synthetic MouseEvent is not trusted
 * user activation, so the browser is free to keep the context suspended; that is
 * a headless policy, not a product bug, and the harness does not assert on it.
 */
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const log = { constructed: 0, resumed: 0, state: null, error: null };
    Object.defineProperty(window, '__audio', { value: log, configurable: true });
    const Real = window.AudioContext || window.webkitAudioContext;
    if (!Real) { log.error = 'no AudioContext in this browser'; return; }
    class Probed extends Real {
      constructor(...args) {
        super(...args);
        log.constructed += 1;
        log.state = this.state;
      }
      resume() {
        log.resumed += 1;
        const p = super.resume();
        if (p && typeof p.then === 'function') {
          p.then(() => { log.state = this.state; }, (e) => { log.error = String(e); });
        }
        return p;
      }
    }
    window.AudioContext = Probed;
    if (window.webkitAudioContext) window.webkitAudioContext = Probed;
  })();`,
});

// Seed a club so the run starts at the menu, and a career with an EMPTY squad
// so the "pick five first" gate is exercised for real rather than assumed.
await send('Page.navigate', { url });
await sleep(3000);
await evalJs(`(() => {
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
await send('Page.navigate', { url });
await sleep(8500);

const freeze = () => evalJs(`(() => {
  const s = document.createElement('style');
  s.id = 'freeze';
  s.textContent = '*,*::before,*::after{animation:none !important;transition:none !important}';
  document.head.append(s);
  return 'frozen';
})()`);
await freeze();

// ------------------------------------------------------------- 1. menu tiles
check('the run starts at the menu', await exists('.menu-screen'));
const tiles = await count('.menu-opt');
check('the menu has five section tiles', tiles === 5, 'tiles=' + tiles);
const deadTiles = await evalJs(
  `[...document.querySelectorAll('.menu-opt')].filter((b) => b.disabled).length`);
check('no tile is disabled any more', deadTiles === 0, 'disabled=' + deadTiles);
check('the "soon" badges are gone', !(await exists('.soon-tag')));
check('the title screen shows the brand mark', await exists('.logo-mark svg'));
// The seeded profile has no `icon` key, which is exactly what a club saved by an
// earlier build looks like — so this also covers the migration.
check('the title screen wears the player\'s own club, not a placeholder',
  (await text('.club-crest')) === 'Riverside Rovers', 'crest=' + (await text('.club-crest')));
check('a club with no stored crest falls back to the house mark',
  (await evalJs(`document.querySelector('.club-crest svg')?.getAttribute('aria-label')`)) === 'Viber');
await shot('01-menu');

// ------------------------------------------------------------- 2. league
await click('.menu-opt', 0);
await sleep(600);
check('the League tile opens the league screen', await exists('.league-screen'));
const ltRows = await count('.league-table .lt-row');
check('the table lists all seven clubs', ltRows === 8, 'rows(incl head)=' + ltRows);
check('the player row is highlighted', await exists('.lt-you'));
check('the player crest is on the table', await exists('.lt-you .club-crest'));
check('the position badge is filled in',
  (await text('.league-pos')) !== '—', 'pos=' + (await text('.league-pos')));
check('the table header names the columns',
  (await text('.lt-head'))?.includes('Pts') === true, await text('.lt-head'));
/*
 * The table used to be a shrinkable flex child with `overflow: hidden`, so in a
 * 390px landscape viewport it clipped four of the seven clubs with no way to
 * scroll to them. It must now keep its height and let the screen scroll.
 */
const tableFit = await evalJs(`(() => {
  const t = document.querySelector('.league-table');
  const s = document.querySelector('.screen');
  if (!t || !s) return null;
  return {
    clipped: t.scrollHeight - t.clientHeight,
    rows: document.querySelectorAll('.league-table .lt-row').length,
    screenScrolls: s.scrollHeight - s.clientHeight,
  };
})()`);
check('the table is not internally clipped', tableFit?.clipped === 0, JSON.stringify(tableFit));
// Orientation-independent: portrait fits the whole table so nothing needs to
// scroll, landscape overflows. Either way the overflow must be scrollable
// rather than hidden, or the rows past the fold are unreachable.
const leagueOverflowY = await evalJs(
  `getComputedStyle(document.querySelector('.league-screen')).overflowY`);
check('the league screen scrolls its overflow rather than hiding it',
  leagueOverflowY === 'auto', 'overflow-y=' + leagueOverflowY);
await shot('02-league-table');

console.log('\nleague note:', await text('.league-screen .section-note'));
console.log('tile paint:', JSON.stringify(await css('.menu-opt',
  ['backgroundColor', 'color', 'borderTopWidth', 'borderTopLeftRadius'])));
console.log('you-row paint:', JSON.stringify(await css('.lt-you',
  ['backgroundColor', 'borderLeftWidth', 'borderLeftColor'])));

const gateDisabled = await evalJs(
  `(() => { const b = [...document.querySelectorAll('.league-screen .primary-btn')][0];
     return b ? b.disabled : 'none'; })()`);
check('Play Next Match is gated until five are picked', gateDisabled === true,
  'disabled=' + gateDisabled);

await clickText('Fixtures', '.chip');
await sleep(500);
check('the Fixtures tab opens the fixture list', await exists('.fixture-list'));
const fxRows = await count('.fixture-row');
check('all twelve fixtures are listed', fxRows === 12, 'rows=' + fxRows);
check('exactly one fixture is marked Next', (await count('.fixture-row.next')) === 1);
check('an unplayed fixture shows Next',
  (await text('.fixture-row.next .fx-score')) === 'Next',
  await text('.fixture-row.next .fx-score'));
check('the fixtures are numbered in ascending rounds',
  (await evalJs(`(() => {
     const rs = [...document.querySelectorAll('.fixture-row .fx-round')]
       .map((e) => Number((e.textContent || '').replace(/\\D/g, '')));
     return rs.length === 12 && rs.every((n, i) => i === 0 || n > rs[i - 1]) && rs[0] >= 1;
   })()`)) === true,
  'rounds=' + (await evalJs(
    `[...document.querySelectorAll('.fixture-row .fx-round')].map((e) => e.textContent).join(',')`)));
check('every fixture names an opponent', (await count('.fixture-row .fx-name')) === 12);
await shot('03-league-fixtures');

await click('.back-btn');
await sleep(500);
check('back from the League returns to the menu', await exists('.menu-screen'));

// ------------------------------------------------------------- 3. squad
await click('.menu-opt', 1);
await sleep(600);
check('the Squad tile opens the squad screen', await exists('.squad-view'));
check('the pitch has five slots', (await count('.squad-slot')) === 5);
check('every slot has a role label', (await count('.squad-slot-role')) === 5);
check('an empty squad shows five empty buttons',
  (await count('.squad-empty')) === 5);
check('the balance strip names all four roles',
  (await count('.squad-balance .balance-pill')) === 4);
check('the squad note says the five is short',
  (await text('.squad-view .section-note'))?.includes('0 of 5') === true,
  await text('.squad-view .section-note'));
check('the action reads "Pick Your Five"',
  (await text('.squad-view .primary-btn'))?.includes('Pick Your Five') === true);
await shot('04-squad-empty');

await click('.back-btn');
await sleep(500);

// ------------------------------------------------------------- 4. players
await click('.menu-opt', 2);
await sleep(600);
check('the Players tile opens the players screen', await exists('.players-screen'));
const allCards = await count('.viber-card2');
check('every Viber is in the grid', allCards > 10, 'cards=' + allCards);
check('the filter row lists every role', (await count('.chip-row .chip')) >= 5);
check('the sort row is present', (await count('.sort-row .chip')) === 3);
check('a card carries a rating badge', await exists('.viber-card2 .ovr-badge'));
await shot('05-players-all');

await clickText('GK', '.chip-row .chip');
await sleep(500);
const gkCards = await count('.viber-card2');
check('filtering by GK narrows the grid', gkCards > 0 && gkCards < allCards,
  `${gkCards} of ${allCards}`);
check('the GK chip is the active one',
  (await text('.chip-row .chip.active'))?.includes('GK') === true,
  await text('.chip-row .chip.active'));
await shot('06-players-gk');

await clickText('By Name', '.sort-row .chip');
await sleep(500);
check('sorting by name keeps the filter', (await count('.viber-card2')) === gkCards);
check('the name sort is the active one',
  (await text('.sort-row .chip.active'))?.includes('By Name') === true);
await shot('07-players-sorted');

await clickText('All', '.chip-row .chip');
await sleep(500);
check('clearing the filter restores the grid', (await count('.viber-card2')) === allCards);

await click('.back-btn');
await sleep(500);
check('back from Players returns to the menu', await exists('.menu-screen'));

// ------------------------------------------------------------- 5. career
await click('.menu-opt', 3);
await sleep(600);
check('the Career tile opens the career screen', await exists('.career-screen'));
check('the stat grid has eight cells', (await count('.stat-cell')) === 8);
check('career totals start at zero',
  (await text('.stat-cell .stat-num')) === '0', await text('.stat-cell .stat-num'));
check('the form panel says there is no form yet', await exists('.form-empty'));
check('the best-result panel says there is no win yet',
  (await text('.career-screen'))?.includes('No win on the board yet') === true);
check('the history panel says no season is filed',
  (await text('.career-screen'))?.includes('No completed seasons yet') === true);
await shot('08-career-empty');

await click('.back-btn');
await sleep(500);

// ------------------------------------------------------------- 6. settings
await click('.menu-opt', 4);
await sleep(600);
check('the Settings tile opens the settings screen', await exists('.settings-screen'));
check('there are four setting groups', (await count('.settings-group')) === 4);
check('the match length is a three-way segment',
  (await count('.setting-row .seg-btn')) >= 3);
check('settings name the manager and club',
  (await text('.settings-screen'))?.includes('Alex') === true);
check('the erase button is not armed on arrival',
  (await text('.settings-screen'))?.includes('tap again') === false);
// The first setting row is Match length. A fresh career must open with one of
// the three options already highlighted — the default used to be 120s, which is
// not an option, so nothing was selected.
const defaultLen = await evalJs(`(() => {
  const row = document.querySelector('.settings-group .setting-row');
  const a = row?.querySelector('.seg-btn.active');
  return a ? a.textContent.trim() : null;
})()`);
check('a match length is selected by default', defaultLen !== null,
  'active=' + defaultLen);
await shot('09-settings');

const beforeLen = await evalJs(
  `JSON.parse(localStorage.getItem('viber-league:career:v1') || '{}')?.settings?.halfSeconds ?? null`);
await clickText('2 Min', '.seg-btn');
await sleep(600);
const afterLen = await evalJs(
  `JSON.parse(localStorage.getItem('viber-league:career:v1') || '{}')?.settings?.halfSeconds ?? null`);
check('picking 2 Min stores a 60s half', afterLen === 60, `${beforeLen} -> ${afterLen}`);
check('the 2 Min segment is now the active one',
  (await text('.setting-row .seg-btn.active'))?.includes('2 Min') === true,
  await text('.setting-row .seg-btn.active'));

await clickText('Erase Career', '.ghost-btn');
await sleep(300);
check('the first tap arms rather than erases',
  (await text('.settings-screen'))?.includes('tap again') === true);
check('the armed button is styled as armed', await exists('.ghost-btn.danger.armed'));
await shot('10-settings-armed');

await click('.back-btn');
await sleep(500);
await click('.menu-opt', 4);
await sleep(600);
check('the match length survived leaving the screen',
  (await text('.setting-row .seg-btn.active'))?.includes('2 Min') === true);

/*
 * The Sound group. Two things are being checked, and the second is the one that
 * matters: the setting persists, AND switching it back on is what lets the game
 * build an audio context at all — a muted career must never create one.
 */
const groupTitle = (t) =>
  `[...document.querySelectorAll('.settings-group')].find((s) =>` +
  ` (s.querySelector('.settings-group-title')?.textContent || '') === ${JSON.stringify(t)})`;
const activeIn = async (t) =>
  evalJs(`(() => {
    const g = ${groupTitle(t)};
    const a = g?.querySelector('.seg-btn.active');
    return a ? a.textContent.trim() : null;
  })()`);
const clickIn = (t, needle) =>
  evalJs(`(() => {
    const g = ${groupTitle(t)};
    if (!g) return 'MISSING group';
    const el = [...g.querySelectorAll('.seg-btn')]
      .find((b) => b.textContent.trim() === ${JSON.stringify(needle)});
    if (!el) return 'MISSING segment ' + ${JSON.stringify(needle)};
    el.scrollIntoView({ block: 'nearest' });
    for (const e of ['pointerdown','mousedown','pointerup','mouseup','click']) {
      el.dispatchEvent(new MouseEvent(e, { bubbles: true, cancelable: true, view: window }));
    }
    return 'ok';
  })()`);

check('there is a Sound group with a switch', (await activeIn('Sound')) !== null,
  'active=' + (await activeIn('Sound')));
check('sound is on by default', (await activeIn('Sound')) === 'On');
await shot('10b-settings-sound');

const storedSound = () =>
  evalJs(`JSON.parse(localStorage.getItem('viber-league:career:v1') || '{}')?.settings?.sound ?? null`);
await clickIn('Sound', 'Off');
await sleep(500);
check('switching sound off is stored', (await storedSound()) === false,
  'stored=' + (await storedSound()));
await clickIn('Sound', 'On');
await sleep(500);
check('switching sound back on is stored', (await storedSound()) === true,
  'stored=' + (await storedSound()));
await click('.back-btn');
await sleep(500);

/** Click BACK until the menu is showing. Keeps the harness from depending on
 *  the exact depth of the screen stack. */
async function returnToMenu() {
  for (let i = 0; i < 8; i++) {
    if (await exists('.menu-screen')) return true;
    await click('.back-btn');
    await sleep(450);
  }
  return await exists('.menu-screen');
}

// ------------------------------------------------------------- 7. the loop
// First pass: prove the stored match length actually reaches the match setup.
await click('.menu-opt', 0);
await sleep(600);
check('back on the League screen', await exists('.league-screen'));

await clickText('Play Next Match', '.primary-btn');
await sleep(800);
check('the league fixture goes through the squad picker', await exists('.hero-select'));

await clickText('Auto', 'button');
await sleep(700);
const picked = await evalJs(`document.querySelectorAll('.viber-card2.selected').length`);
check('the auto pick selects five', picked === 5, 'selected=' + picked);
await shot('11-squad-picked');

await click('.primary-btn');
await sleep(700);
check('the flow reaches the venue screen', await exists('.venue-thumb'));
await shot('12-venue');

await click('.primary-btn');
await sleep(700);
check('the flow reaches the minutes screen', await exists('.choice-btn'));
check('the minutes screen honours the 2 Min setting',
  (await text('.choice-btn.active'))?.includes('2 Min') === true,
  'active=' + (await text('.choice-btn.active')));
await shot('13-minutes');

await click('.primary-btn');
await sleep(700);
check('the flow reaches the opponent screen', await exists('.vs-row'));
check('the opponent screen names the league round',
  (await text('.screen-sub'))?.includes('Round') === true,
  await text('.screen-sub'));
check('the opponent screen shows both fives',
  (await count('.vs-side')) === 2 && (await count('.vs-avatars')) === 2);
check('the conditions strip names the pitch and length',
  (await count('.conditions-strip .cond')) === 3,
  await text('.conditions-strip'));
await shot('14-opponent');

// Second pass: actually play it.
check('the flow can be left and re-entered', await returnToMenu());

/*
 * Headless Chrome renders WebGL in software (swiftshader), so a match runs at
 * roughly 1-2fps and a real 2-minute match would need a quarter of an hour of
 * wall clock. Measured: with a 1-second half and clear weather, half-time lands
 * at ~19s and full-time at ~31s. Rain is ~5x slower again — its particles are
 * brutal in software — so the run pins clear weather as well as a short half.
 *
 * None of this changes what is being verified: the loop below is about the
 * WIRING (fixture -> kick off -> half time -> full time -> result -> filed
 * against the fixture -> table and career update), and that wiring is identical
 * at any match length. The 60-second half is covered by the checks above.
 */
await evalJs(`(() => {
  const k = 'viber-league:career:v1';
  const c = JSON.parse(localStorage.getItem(k) || '{}');
  c.settings = { ...(c.settings || {}), halfSeconds: 2, weather: 'sun' };
  localStorage.setItem(k, JSON.stringify(c));
  return JSON.stringify(c.settings);
})()`);
await send('Page.navigate', { url });
await sleep(8500);
await freeze();

await click('.menu-opt', 0);
await sleep(600);
await clickText('Play Next Match', '.primary-btn');
await sleep(800);
await clickText('Auto', 'button');
await sleep(700);
await click('.primary-btn');
await sleep(700);
await click('.primary-btn');
await sleep(700);
await click('.primary-btn');
await sleep(700);
check('the fixture reaches the opponent screen again', await exists('.vs-row'));

await click('.primary-btn');
await sleep(2500);
check('the match HUD is up', await exists('.hud'));

/*
 * The kick-off was the gesture, so the audio graph should exist by now — and it
 * should NOT have existed before, because nothing is built at boot. `__audio` is
 * per-document and this document is the one the match was started in.
 */
const audio = await evalJs('window.__audio || null');
check('the kick-off gesture built the audio graph', (audio?.constructed ?? 0) >= 1,
  JSON.stringify(audio));
check('the audio graph is asked to start', (audio?.resumed ?? 0) >= 1,
  'resumed=' + (audio?.resumed ?? 0));
if (audio?.error) console.log('   audio note:', audio.error);
console.log('   audio state after kick off:', audio?.state);

// The in-match mute. It has to be reachable without leaving the match, and it
// has to write through to the stored career rather than only to the graph.
check('the HUD has a sound button', await exists('.sound-btn'));
check('the HUD sound button starts unmuted', !(await exists('.sound-btn.muted')));
await click('.sound-btn');
await sleep(400);
check('tapping it mutes and marks the button', await exists('.sound-btn.muted'));
check('muting from the match is stored',
  (await evalJs(`JSON.parse(localStorage.getItem('viber-league:career:v1') || '{}')
    ?.settings?.sound ?? null`)) === false);
await click('.sound-btn');
await sleep(400);
check('tapping again unmutes', !(await exists('.sound-btn.muted')));
check('unmuting from the match is stored',
  (await evalJs(`JSON.parse(localStorage.getItem('viber-league:career:v1') || '{}')
    ?.settings?.sound ?? null`)) === true);
// Three buttons now share the controls row. `probe()` reports spill but does not
// fail on it, so the row is asserted directly.
check('the controls row still fits the viewport',
  await evalJs(`(() => {
    const r = document.querySelector('.controls-row');
    if (!r) return false;
    const b = r.getBoundingClientRect();
    return b.left >= -1.5 && b.right <= innerWidth + 1.5;
  })()`));

// Sampling the clock a couple of seconds in already reads 1-2', so assert the
// clock is a running match clock rather than pinning it to zero.
check('the match clock is running',
  /^\d+'$/.test((await text('.clock')) ?? ''), 'clock=' + (await text('.clock')));
check('the first half has started',
  (await text('.half')) === '1st Half', 'half=' + (await text('.half')));
await shot('15-match', 1500);

const clockAt = async () => text('.clock');

// Half time arrives after one half; the game waits for a mentality. Measured at
// ~19s for a 1-second half, so 150 x 2s is a very wide margin.
console.log('\nwaiting for half-time...');
let ht = false;
for (let i = 0; i < 150; i++) {
  await sleep(2000);
  if (await exists('.overlay-screen .choice-btn')) { ht = true; break; }
  if (i % 5 === 0) console.log(`   ...clock=${await clockAt()}`);
}
check('half-time pauses the match for a decision', ht);
if (ht) {
  await shot('16-halftime');
  check('half-time offers the four mentalities',
    (await count('.overlay-screen .choice-btn')) === 4,
    'choices=' + (await count('.overlay-screen .choice-btn')));
  await clickText('Balanced', '.choice-btn');
  /*
   * Poll rather than sleep a fixed amount. Software WebGL renders the match at
   * roughly a fifth of real time, so a single frame can be most of a second
   * away; a fixed 1.2s wait sat right on that boundary and failed whenever the
   * renderer happened to be mid-frame when the button was tapped.
   */
  let resumed = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    if ((await text('.half')) === '2nd Half') { resumed = true; break; }
  }
  check('choosing a mentality closes the half-time panel',
    (await exists('.overlay-screen .choice-btn')) === false);
  check('choosing a mentality resumes the second half', resumed,
    'half=' + (await text('.half')));
}

console.log('waiting for full time...');
let ft = false;
for (let i = 0; i < 150; i++) {
  await sleep(2000);
  if (await exists('.stats-table')) { ft = true; break; }
  if (i % 5 === 0) console.log(`   ...clock=${await clockAt()}`);
}
check('the match reaches full time', ft);
await shot('17-result', 1500);

/*
 * The result panel is taller than a 390px landscape viewport. It used to be
 * pushed off the top by `justify-content: flex-end` on a scrolling flex
 * container, which put the outcome, the score and the league note out of reach.
 */
const resultTop = await evalJs(`(() => {
  const p = document.querySelector('.overlay-screen .panel');
  return p ? Math.round(p.getBoundingClientRect().top) : null;
})()`);
check('the result headline is on screen, not clipped above it',
  resultTop !== null && resultTop >= -1, 'panelTop=' + resultTop);

const note = await text('.result-note');
check('the result screen says where the season now stands',
  typeof note === 'string' && note.length > 0, 'note=' + note);
check('the result screen offers a way back to the League',
  (await text('.overlay-screen'))?.includes('Back to the League') === true);
check('the squad shortcut is still offered',
  (await text('.overlay-screen'))?.includes('Squad') === true);

const filed = await evalJs(`(() => {
  const raw = localStorage.getItem('viber-league:career:v1');
  if (!raw) return null;
  const c = JSON.parse(raw);
  const vals = Object.values(c.results || {});
  return { keys: vals.length, one: vals[0] };
})()`);
check('the result is stored against the fixture', filed?.keys === 1, JSON.stringify(filed));

await clickText('Back to the League', '.primary-btn');
await sleep(900);
check('the result returns to the League', await exists('.league-screen'));
const playedCell = await text('.lt-you .lt-num');
check('the player row now shows one played', playedCell === '1', 'played=' + playedCell);
await shot('18-league-after');

await clickText('Fixtures', '.chip');
await sleep(600);
const playedRows = await count('.fixture-row.played');
check('the fixture list marks the played game', playedRows === 1, 'played=' + playedRows);
check('a second fixture is now Next', (await count('.fixture-row.next')) === 1);
await shot('19-fixtures-after');

// ------------------------------------------------------------- 8. career again
await click('.back-btn');
await sleep(500);
await click('.menu-opt', 3);
await sleep(600);
check('the career screen is reachable after a match', await exists('.career-screen'));
check('career totals now count the match',
  (await text('.stat-cell .stat-num')) === '1',
  'played=' + (await text('.stat-cell .stat-num')));
check('a form pill appeared', (await count('.form-pill')) === 1,
  'pills=' + (await count('.form-pill')));
await shot('20-career-after');

// ------------------------------------------------------------- 9. persistence
await send('Page.navigate', { url });
await sleep(8500);
await freeze();
check('the season survives a reload', await exists('.menu-screen'));
check('the reload does not fall back to onboarding', !(await exists('.profile-screen')));
await click('.menu-opt', 0);
await sleep(800);
check('the stored result survived the reload',
  (await text('.lt-you .lt-num')) === '1',
  'played=' + (await text('.lt-you .lt-num')));
await shot('21-league-after-reload');

// ------------------------------------------------------- 10. muted = silent
/*
 * The other half of the audio contract. A career with sound switched off must
 * never construct an AudioContext — not at boot, not at kick-off. The check is
 * `constructed === 0`, which is only observable from outside the game, so it
 * cannot be covered by a unit test.
 *
 * `?autostart` is the shortest path into a match: it skips the pre-match flow
 * entirely, and it still goes through the same `startMatch()` that a real
 * kick-off does, so the audio path under test is the real one.
 */
await evalJs(`(() => {
  const k = 'viber-league:career:v1';
  const c = JSON.parse(localStorage.getItem(k) || '{}');
  c.settings = { ...(c.settings || {}), sound: false };
  localStorage.setItem(k, JSON.stringify(c));
  return c.settings.sound;
})()`);
await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'autostart' });
await sleep(12000);
const muted = await evalJs('window.__audio || null');
check('a muted career reaches the match', await exists('.hud'));
check('a muted career builds no audio graph', (muted?.constructed ?? -1) === 0,
  JSON.stringify(muted));
await shot('22-muted-match');
// Leave the stored career the way the run found it.
await evalJs(`(() => {
  const k = 'viber-league:career:v1';
  const c = JSON.parse(localStorage.getItem(k) || '{}');
  c.settings = { ...(c.settings || {}), sound: true };
  localStorage.setItem(k, JSON.stringify(c));
  return 1;
})()`);

// -------------------------------------------------- 11. creating a club
/*
 * The onboarding path, driven the way a new player drives it. Everything above
 * this point starts from a seeded profile, which is exactly what hid the fact
 * that the crest was not being collected at all — so this section starts from
 * empty storage and goes through the real form.
 *
 * It also pins the two things the title screen used to get wrong: an invented
 * club name, and a club line that was the same for everybody.
 */
const typeInto = (sel, value) =>
  evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'MISSING ' + ${JSON.stringify(sel)};
    el.focus();
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()`);

await evalJs(`(() => {
  localStorage.removeItem('viber-league:profile:v1');
  localStorage.removeItem('viber-league:career:v1');
  return 1;
})()`);
await send('Page.navigate', { url });
await sleep(9000);
await freeze();

check('a brand new player lands on the create-club form', await exists('.onboard-screen'));
check('the form asks for a manager and a club',
  (await exists('#ob-manager')) && (await exists('#ob-club')));
check('the form asks for a password and a confirmation',
  (await exists('#ob-password')) && (await exists('#ob-confirm')));

const crests = await count('.icon-picker .icon-choice');
check('the form offers six crests', crests === 6, 'choices=' + crests);
check('every crest is a real drawing',
  (await evalJs(`[...document.querySelectorAll('.icon-choice')]
    .every((b) => !!b.querySelector('svg path'))`)) === true);
check('the first crest is chosen to begin with',
  (await count('.icon-choice.active')) === 1 &&
    (await evalJs(`document.querySelector('.icon-choice')?.classList.contains('active')`)) === true);
check('the crest buttons are not the form submit',
  (await evalJs(`[...document.querySelectorAll('.icon-choice')]
    .every((b) => b.type === 'button')`)) === true);
check('the preview shows a crest before anything is typed',
  await exists('.crest-preview .crest-badge svg'));
/*
 * The picker is six across and the crests have a natural size, so on a 390px
 * phone the last one used to be pushed half off the card — a `1fr` grid track
 * will not shrink below its content. `probe()` reports spill but does not fail
 * on it, so the row is asserted directly.
 */
check('every crest is inside the viewport at this width',
  await evalJs(`(() => {
    const btns = [...document.querySelectorAll('.icon-choice')];
    if (btns.length !== 6) return false;
    return btns.every((b) => {
      const r = b.getBoundingClientRect();
      return r.left >= -1.5 && r.right <= innerWidth + 1.5 && r.width >= 28;
    });
  })()`),
  await evalJs(`JSON.stringify([...document.querySelectorAll('.icon-choice')]
    .map((b) => Math.round(b.getBoundingClientRect().right)))`));
await shot('23-onboard');

await typeInto('#ob-club', 'Riverside Rovers');
await sleep(200);
check('the preview derives the scoreboard abbreviation as the club is typed',
  (await text('.crest-short')) === 'RR', 'short=' + (await text('.crest-short')));
check('the preview shows the club name back',
  (await text('.crest-name')) === 'Riverside Rovers');

// Pick the crown (index 4 of viber, ball, bolt, star, crown, shield).
await click('.icon-choice', 4);
await sleep(250);
check('tapping a crest selects exactly one',
  (await count('.icon-choice.active')) === 1);
check('the tapped crest is the one selected',
  (await evalJs(`[...document.querySelectorAll('.icon-choice')]
    .findIndex((b) => b.classList.contains('active'))`)) === 4);
check('the selection is announced to assistive tech',
  (await evalJs(`document.querySelectorAll('.icon-choice[aria-pressed="true"]').length`)) === 1);
check('the preview swaps to the chosen crest',
  (await evalJs(`document.querySelector('.crest-badge svg')?.getAttribute('aria-label')`)) === 'Crown',
  'label=' + (await evalJs(`document.querySelector('.crest-badge svg')?.getAttribute('aria-label')`)));
await shot('24-onboard-crest');

await typeInto('#ob-manager', 'Alex');
await typeInto('#ob-password', 'hunter2secret');
await typeInto('#ob-confirm', 'hunter2secret');
await sleep(200);

await clickText('Create club', '.profile-submit');
// A synthetic click on a submit button usually submits the form; fall back to
// the explicit call so a harness quirk never looks like a product failure.
for (let i = 0; i < 20 && !(await exists('.menu-screen')); i++) {
  await sleep(500);
  if (i === 6) await evalJs(`document.querySelector('.profile-form')?.requestSubmit?.()`);
}
check('creating a club reaches the title screen', await exists('.menu-screen'));

const saved = await evalJs(`(() => {
  const raw = localStorage.getItem('viber-league:profile:v1');
  return raw ? JSON.parse(raw) : null;
})()`);
check('the chosen crest is stored with the club', saved?.icon === 'crown', 'icon=' + saved?.icon);
check('the stored club keeps the name that was typed', saved?.club === 'Riverside Rovers');
check('the stored club keeps the manager that was typed', saved?.manager === 'Alex');
check('the password is still never stored as itself',
  !!saved && JSON.stringify(saved).indexOf('hunter2secret') === -1);

check('the title screen names the player\'s own club',
  (await text('.club-crest')) === 'Riverside Rovers', 'crest=' + (await text('.club-crest')));
check('the club line wears the crest the player chose',
  (await evalJs(`document.querySelector('.club-crest svg')?.getAttribute('aria-label')`)) === 'Crown');
check('the brand mark heads the title screen', await exists('.logo-mark svg'));
check('no invented club name is left anywhere on screen',
  (await evalJs(`document.body.textContent.includes('Vibe Vibe')`)) === false);
check('no placeholder competition line is left anywhere on screen',
  (await evalJs(`document.body.textContent.includes('5-a-side')`)) === false);
check('a brand new club starts the league from scratch',
  (await evalJs(`(() => {
    const raw = localStorage.getItem('viber-league:career:v1');
    if (!raw) return true;             // no career at all is also "from scratch"
    return Object.keys(JSON.parse(raw).results || {}).length === 0;
  })()`)) === true);
await shot('25-title-new-club');

// The account sheet, which is the one place the crest is shown back to the
// player rather than worn by the team.
await click('.account-chip');
await sleep(600);
check('the account sheet opens', await exists('.account-sheet'));
check('the account sheet shows the crest',
  (await evalJs(`document.querySelector('.account-sheet .crest-preview svg')?.getAttribute('aria-label')`)) === 'Crown');
check('the account sheet names the manager and the club',
  (await text('.account-sheet'))?.includes('Alex') === true &&
    (await text('.account-sheet'))?.includes('Riverside Rovers') === true);
await shot('26-account-sheet');
await clickText('Back to the game', '.primary-btn');
await sleep(500);

// And it all survives a reload, which is the entire point of a profile.
await send('Page.navigate', { url });
await sleep(8500);
await freeze();
check('the club survives a reload', await exists('.menu-screen'));
check('the reload does not ask for a new club', !(await exists('.onboard-screen')));
check('the reloaded title screen still wears the chosen crest',
  (await evalJs(`document.querySelector('.club-crest svg')?.getAttribute('aria-label')`)) === 'Crown');

// Leave storage the way the run found it, so the earlier sections stay valid.
await evalJs(`(() => {
  localStorage.setItem('viber-league:profile:v1', JSON.stringify({
    manager: 'Alex', club: 'Riverside Rovers', short: 'RR', icon: 'viber',
    hash: null, salt: null, iterations: 100000,
    createdAt: '2026-10-09T00:00:00.000Z',
  }));
  return 1;
})()`);

fs.writeFileSync(path.join(outDir, 'report.json'),
  JSON.stringify({ viewport: `${W}x${H}`, shots, events, fails }, null, 1));
console.log('\n=== page errors (' + events.length + ') ===');
for (const e of events.slice(0, 15)) console.log(' ', e);
console.log(`\n=== ${fails} failed check(s) ===`);
ws.close();
process.exit(fails > 0 ? 1 : 0);
