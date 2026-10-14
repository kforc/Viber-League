// Dev-only: drive the club sections and the league loop over CDP.
//
//   menu -> League (gate -> table + fixtures) -> Players -> Career -> Settings
//   -> Play -> Help -> League -> Play Next Match -> squad -> venue -> minutes
//   -> opponent -> kick off -> half-time -> full time -> result -> squad view
//   -> back to the League
//
// Tiles are clicked by LABEL, never by index: dropping the SQUAD tile shifted
// every index after it, and an index-based harness fails by quietly opening the
// wrong screen.
//
// Writes <outDir>/<NN>-<name>.png plus report.json holding page errors,
// per-screen clipping/spill numbers, and the computed paint of the new
// controls — so "the tile is lime with a black outline" is a measurement
// rather than a vibe.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

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
  // The game guide is a document: it is meant to run past the fold and be read
  // by scrolling, and its own body is the scroller rather than the screen.
  '.help-body',
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

/*
 * THE SIM, SO THE MATCH CAN BE DRIVEN RATHER THAN WAITED ON.
 *
 * Headless Chrome has no compositor. `requestAnimationFrame` here runs at ~5fps
 * and the app clamps a frame to 50ms and takes at most six ticks, so a live
 * match advances at roughly **0.25x real time** — measured, not guessed, with
 * tools/cdp/probe-rate.mjs. A 90-second half is therefore about six minutes of
 * wall clock, and the old fixed 150x2s budgets ran out mid-match: half-time
 * never arrived, full time never arrived, and fifteen checks downstream failed
 * against a match that had been playing perfectly the whole time. Worse, the
 * slower the machine, the more of the run failed, so a green run said more
 * about the load than about the game.
 *
 * So the match is stepped directly, exactly as probe-penalty.mjs does — through
 * `TestSim.step` on the app's OWN world object, so it is the real simulation
 * and not a second one. The app's own loop still drains the events on its next
 * frame, which is what renders the panels the checks below look for.
 *
 * Injected on every new document so it survives the reloads further down.
 */
const sim = (await build({
  entryPoints: [fileURLToPath(new URL('../../src/sim/index.ts', import.meta.url))],
  format: 'iife',
  globalName: 'TestSim',
  bundle: true,
  write: false,
})).outputFiles[0].text;
await send('Page.addScriptToEvaluateOnNewDocument', { source: `${sim}\n;0` });

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
check('the menu has four section tiles', tiles === 4, 'tiles=' + tiles);
/*
 * SQUAD lost its tile.
 *
 * It was a second way to see the same five the picker already shows, and it sat
 * one tap from the front page competing with LEAGUE for the same job. The
 * screen itself survives — the result panel still offers it as a shortcut —
 * but the tile does not, so assert by LABEL rather than by count: a count
 * would pass just as happily on a menu that had quietly swapped SQUAD for
 * something else.
 */
const tileLabels = await evalJs(
  `[...document.querySelectorAll('.menu-opt')].map((b) => b.textContent.trim())`);
check('the SQUAD tile is gone from the front page',
  Array.isArray(tileLabels) && !tileLabels.some((t) => /squad/i.test(t)), JSON.stringify(tileLabels));
check('the Players tile is still there',
  Array.isArray(tileLabels) && tileLabels.some((t) => /players/i.test(t)), JSON.stringify(tileLabels));
const deadTiles = await evalJs(
  `[...document.querySelectorAll('.menu-opt')].filter((b) => b.disabled).length`);
check('no tile is disabled any more', deadTiles === 0, 'disabled=' + deadTiles);
check('the "soon" badges are gone', !(await exists('.soon-tag')));
// The tagline under the wordmark went with the rest of the explanatory prose.
check('the title screen carries no tagline', !(await exists('.tagline')));
// And so did the sub-label under PLAY. "Choose a mode" explained a button whose
// very next screen is two cards reading Quick Play and League.
check('the PLAY button carries no explanatory sub-label',
  !(await exists('.play-btn .play-sub')));
check('the title screen shows the brand mark', await exists('.logo-mark svg'));
// The seeded profile has no `icon` key, which is exactly what a club saved by an
// earlier build looks like — so this also covers the migration.
check('the title screen wears the player\'s own club, not a placeholder',
  (await text('.club-crest')) === 'Riverside Rovers', 'crest=' + (await text('.club-crest')));
check('a club with no stored crest falls back to the house mark',
  (await evalJs(`document.querySelector('.club-crest svg')?.getAttribute('aria-label')`)) === 'Viber');
/*
 * …and the name must be INSIDE the chip.
 *
 * The check above reads `textContent`, which returns the string whether or not
 * a glyph was ever painted — so it passed for as long as `.club-crest`'s later
 * `display: inline-grid` beat `.menu-crest`'s `display: flex`, laying the badge
 * and the name out as TWO ROWS. The name hung ~17px below the chip's own
 * background, straight under the framed Viber, and was covered by it on the
 * title screen. Nothing that reads text can see that. Assert the geometry.
 */
const chip = await evalJs(`(() => {
  const el = document.querySelector('.menu-crest.club-crest');
  if (!el) return 'missing';
  const name = [...el.querySelectorAll('span')].find((s) => (s.textContent || '').trim());
  const badge = el.querySelector('.brand-icon');
  if (!name || !badge) return 'no-children';
  const box = (n) => { const r = n.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const c = box(el), nm = box(name), bd = box(badge);
  const rows = { chip: [Math.round(c.t), Math.round(c.b)], name: [Math.round(nm.t), Math.round(nm.b)], badge: [Math.round(bd.t), Math.round(bd.b)] };
  // The name's vertical centre inside the chip's vertical span = same row.
  const nameMid = nm.t + nm.h / 2;
  return {
    rows,
    inside: nm.t >= c.t - 1 && nm.b <= c.b + 1 && nm.l >= c.l - 1 && nm.r <= c.r + 1,
    sameRow: nameMid >= c.t && nameMid <= c.b,
    // Side by side, not stacked: the badge ends before the name begins.
    badgeBeforeName: bd.r <= nm.l + 2,
    nameWidth: Math.round(nm.w),
  };
})()`);
check('the club name sits inside its own chip',
  chip !== 'missing' && chip !== 'no-children' && chip.inside === true, JSON.stringify(chip));
check('the club name shares the chip\'s row with the badge',
  chip !== 'missing' && chip !== 'no-children' && chip.sameRow === true && chip.badgeBeforeName === true,
  JSON.stringify(chip));
check('the club name is actually given room to draw',
  chip !== 'missing' && chip !== 'no-children' && chip.nameWidth > 60, JSON.stringify(chip));
// Measured here, while the tiles are still on screen — see the note where this
// used to live, one screen later.
console.log('tile paint:', JSON.stringify(await css('.menu-opt',
  ['backgroundColor', 'color', 'borderTopWidth', 'borderTopLeftRadius'])));
await shot('01-menu');

// ------------------------------------------------------------- 2. the gate
/*
 * LEAGUE opens on a gate, not a table.
 *
 * A club is not a season. Before this screen existed, LEAGUE showed seven clubs
 * on zero points, which reads as a competition that has been played and nobody
 * turned up — a table that is a lie until the player has answered whether they
 * are starting one. So the first thing LEAGUE shows is the choice.
 *
 * The career is wiped in the seeding above, so this is the fresh-club case:
 * nothing stored, nothing to resume, and NEW LEAGUE costs nothing.
 */
await clickText('League', '.menu-opt');
await sleep(600);
check('the League tile opens the league gate', await exists('.league-gate'));
check('the gate shows no table before a league exists',
  (await count('.league-table .lt-row')) === 0,
  'rows=' + (await count('.league-table .lt-row')));
check('the gate offers to start a league', await exists('.gate-actions .primary-btn'));
/*
 * Look the load button up by its TEXT, not by position.
 *
 * With a season already stored, NEW LEAGUE is also a ghost button and comes
 * first — so `.gate-actions .ghost-btn` would quietly return the wrong control
 * on exactly the saves that matter most.
 */
const loadBtn = await evalJs(`(() => {
  const b = [...document.querySelectorAll('.gate-actions button')]
    .find((x) => (x.textContent || '').includes('Load Existing'));
  return b ? { label: b.textContent.trim(), disabled: b.disabled, dim: b.classList.contains('disabled') } : 'missing';
})()`);
check('the gate offers to load an existing league',
  loadBtn !== 'missing' && loadBtn.label === 'Load Existing League', JSON.stringify(loadBtn));
/*
 * Nothing has been played, so there is nothing to resume — and the control says
 * so by being dead rather than by being absent. A button that is missing looks
 * like a feature that was never built; a button that is disabled with a label
 * is a feature that is honestly not applicable yet.
 */
check('there is nothing to load on a fresh club',
  loadBtn !== 'missing' && loadBtn.disabled === true, JSON.stringify(loadBtn));
check('the dead load button is styled as dead',
  loadBtn !== 'missing' && loadBtn.dim === true, JSON.stringify(loadBtn));
await shot('02-league-gate');

await clickText('New League', '.gate-actions button');
await sleep(700);
check('starting a league leaves the gate behind', !(await exists('.league-gate')));
check('starting a league opens the league screen', await exists('.league-screen'));

// ------------------------------------------------------------- 2b. league
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

/*
 * Read the table's actual numbers.
 *
 * The structural checks above cannot see a table that is *too complete*. A
 * fresh season showing six clubs ten games in and a leader on 25 points looked
 * perfectly well-formed — right number of rows, right header, nothing clipped —
 * and shipped. The bug was only ever visible in the columns.
 *
 * Columns are P, W, D, L, GD, Pts, in that order.
 */
const readTable = () => evalJs(`(() => {
  return [...document.querySelectorAll('.league-table .lt-row:not(.lt-head)')].map((row) => {
    const nums = [...row.querySelectorAll('.lt-num')].map((n) => n.textContent.trim());
    return {
      club: row.querySelector('.lt-name')?.textContent?.trim() ?? '',
      you: row.classList.contains('lt-you'),
      played: Number(nums[0]),
      points: Number(nums[5]),
    };
  });
})()`);

const fresh = await readTable();
check('a fresh league starts every club on zero',
  fresh?.length === 7 && fresh.every((r) => r.played === 0 && r.points === 0),
  JSON.stringify(fresh?.map((r) => `${r.club} ${r.played}/${r.points}`)));
await shot('02-league-table');

console.log('\nleague note:', await text('.league-screen .section-note'));
/*
 * The tile paint is read in section 1, while the menu is still on screen.
 * It used to be logged here, but LEAGUE now opens on the gate and this point
 * in the run is one screen past the tiles — `.menu-opt` is gone, the probe
 * returned null, and the measurement quietly stopped measuring anything.
 */
console.log('you-row paint:', JSON.stringify(await css('.lt-you',
  ['backgroundColor', 'borderLeftWidth', 'borderLeftColor'])));

/*
 * The dead end, and the reason this section exists.
 *
 * PLAY NEXT MATCH used to be disabled until five fit players were already
 * named. A brand-new club creates its first league with an EMPTY squad, so it
 * landed on a table whose only control was inert — and the squad picker, the
 * one screen that can fix that, was reachable only through that same button. A
 * player who tapped LEAGUE and then tried to start a match got nothing.
 *
 * The check that used to sit here asserted the disabled button, which is the
 * "a check that passes on the wrong screen" trap: it pinned the dead end as
 * correct behaviour. Starting the next fixture has always begun at the picker,
 * which gates its own Continue on five fit, so an empty squad is not a reason
 * the flow cannot start — it is the first thing the flow asks.
 */
const playState = await evalJs(`(() => {
  const b = [...document.querySelectorAll('.league-screen .primary-btn')][0];
  return b ? { label: (b.textContent || '').trim(), disabled: b.disabled } : { missing: true };
})()`);
check('a fresh league offers a live way to play',
  playState?.label === 'Play Next Match' && playState?.disabled === false,
  JSON.stringify(playState));
check('an empty squad is reported as unnamed, not as unfit',
  (await text('.league-screen .section-note'))?.includes('No side named yet') === true,
  await text('.league-screen .section-note'));

// Walk it: the button must actually reach the screen that can fix the squad.
await clickText('Play Next Match', '.primary-btn');
await sleep(900);
check('an empty squad still reaches the squad picker', await exists('.hero-select'));
check('the picker states the shortfall rather than failing',
  (await text('.hero-select .primary-btn')) === 'Pick 5 more',
  await text('.hero-select .primary-btn'));
check('the picker offers a way to fill the side in one tap',
  (await evalJs(`[...document.querySelectorAll('.hero-select button')]
     .some((b) => (b.textContent || '').trim() === 'Auto Pick')`)) === true);
await shot('02a-empty-squad-picker');
// Back out without picking: this section must not leave a squad behind, or the
// strip checks in section 7 would find a side already named.
await click('.back-btn');
await sleep(700);
check('back from the picker returns to the league table', await exists('.league-screen'));
check('the squad is still empty after backing out',
  (await text('.league-screen .section-note'))?.includes('No side named yet') === true,
  await text('.league-screen .section-note'));

/*
 * The league opt-in. Starting a league from scratch is destructive — there is
 * no undo — so it is two taps, and this walks both of them. On a career with
 * nothing played yet the second tap is a no-op in terms of results, which is
 * exactly why it is safe to press it here.
 */
check('the League screen offers a new league', await exists('.league-screen .ghost-btn.danger'));
check('the new-league button is not armed on arrival',
  (await text('.league-screen'))?.includes('tap again') === false);
const armNew = await clickText('New league', '.ghost-btn');
check('the new-league control is present to tap', armNew === 'ok', armNew);
await sleep(400);
check('the first tap arms rather than restarts',
  (await text('.league-screen'))?.includes('tap again') === true,
  await text('.league-screen .ghost-btn.danger'));
check('the armed new-league button is styled as armed',
  await exists('.league-screen .ghost-btn.danger.armed'));
await shot('02b-league-new-armed');

await clickText('New league', '.ghost-btn');
await sleep(700);
/*
 * Season and progress are header CHIPS now, not a subtitle.
 *
 * The line under the title carried real state — how far through the season you
 * are — so it was not deleted with the rest of the explanatory prose; it moved
 * into the same chip furniture as the league position. Assert the chips, since
 * `.screen-sub` is gone from the app entirely and a check against it would pass
 * vacuously.
 */
check('the second tap starts the league again from nothing',
  (await text('.league-screen .league-meta'))?.includes('Season 1') === true,
  await text('.league-screen .league-meta'));
check('the restarted league has nothing played',
  (await text('.league-screen .league-meta'))?.includes('0/12') === true,
  await text('.league-screen .league-meta'));
check('a fresh league puts the button back to unarmed',
  (await text('.league-screen'))?.includes('tap again') === false);

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

// ------------------------------------------------------------- 3. help
/*
 * HELP replaced the subtitles.
 *
 * Every screen used to carry a line of prose under its title explaining what
 * the screen was for — which the player could already see. All of it went, and
 * the explanations were written down once, here, where someone who wants them
 * can go and read them. So this section is not a nicety: it is the only place
 * the removed text lives now, and if it does not open the app has simply lost
 * that information.
 *
 * It lives on the Play screen, one tap below the two mode cards.
 */
await click('.play-btn');
await sleep(800);
check('PLAY opens the Play screen', await exists('.modes-screen'));
const helpBtn = await evalJs(`(() => {
  const b = [...document.querySelectorAll('.modes-stack button')]
    .find((x) => (x.textContent || '').trim() === 'Help');
  return b ? 'ok' : 'missing';
})()`);
check('the Play screen offers Help', helpBtn === 'ok', helpBtn);
await clickText('Help', '.modes-stack button');
await sleep(700);
check('Help opens from the Play screen', await exists('.help-body'));
const topics = await count('.help-topic');
check('the guide covers every topic', topics >= 7, 'topics=' + topics);
check('every topic has a title and at least one line',
  (await evalJs(`(() => {
     const ts = [...document.querySelectorAll('.help-topic')];
     return ts.length > 0 && ts.every((t) =>
       (t.querySelector('.help-title')?.textContent || '').trim().length > 0 &&
       t.querySelectorAll('.help-line').length > 0);
   })()`)) === true);
check('the guide explains how to play a match',
  (await text('.help-body'))?.includes('On the pitch') === true);

/*
 * The guide is a pitch: a green board with a light-green touchline, and the
 * write-up stays white on it.
 *
 * These are computed-colour and geometry checks, not text ones. `textContent`
 * returns the same string whether the board is a pitch or a plain list, so a
 * text assertion is blind to the entire thing that was asked for — the same
 * trap as the club chip, where the name read back fine while nothing was
 * painted inside the pill.
 */
const board = await evalJs(`(() => {
  const b = document.querySelector('.help-board');
  const body = b && b.querySelector('.help-body');
  const line = document.querySelector('.help-line');
  const title = document.querySelector('.help-title');
  if (!b || !body || !line || !title) return null;
  const cs = getComputedStyle(b);
  const br = b.getBoundingClientRect();
  const lr = line.getBoundingClientRect();
  const tr = title.getBoundingClientRect();
  return {
    bg: cs.backgroundImage,
    borderW: parseFloat(cs.borderTopWidth),
    radius: parseFloat(cs.borderTopLeftRadius),
    overflow: getComputedStyle(body).overflowY,
    line: getComputedStyle(line).color,
    title: getComputedStyle(title).color,
    markings: !!b.querySelector('.help-pitch .hp-circle') &&
              !!b.querySelector('.help-pitch .hp-half'),
    // Text inset from the board's border-box edge. The touchline sits at 8px
    // + its own 3px, so anything under ~15 would be running through it.
    inset: Math.round(Math.min(lr.left, tr.left) - br.left),
    // The write-up must sit inside the board, not overflow it.
    inside: lr.left >= br.left && lr.right <= br.right &&
            lr.top >= br.top && lr.bottom <= br.bottom,
    boardH: Math.round(br.height),
    viewH: window.innerHeight,
  };
})()`);
check('the guide sits on a board', board !== null);
check('the board is a green pitch',
  (board?.bg ?? '').includes('linear-gradient') &&
  (board?.bg ?? '').includes('rgb(23, 97, 46)'),
  (board?.bg ?? '').slice(0, 90));
check('the board carries pitch markings', board?.markings === true);
check('the write-up is white on the pitch',
  board?.line === 'rgb(255, 255, 255)', board?.line);
check('the write-up clears the light-green touchline',
  (board?.inset ?? 0) >= 15, 'inset=' + board?.inset);
check('the write-up stays inside the board', board?.inside === true);
check('the guide body is the scroller, not the board',
  board?.overflow === 'auto', board?.overflow);
check('the board fits the viewport',
  (board?.boardH ?? 1e9) <= (board?.viewH ?? 0),
  board?.boardH + ' vs ' + board?.viewH);

/*
 * The guide is the only place the removed subtitles live now, so a line that
 * describes a game other than this one is a real loss. Two had drifted: SPECIAL
 * was written as a long shot when it is a speed surge, and the conditions
 * section invented a fog the sim does not have. Pin the corrected facts.
 */
const guide = (await text('.help-body')) ?? '';
check('the guide names the four conditions the game has',
  ['SUNNY', 'RAINY', 'ICY', 'COLD'].every((n) => guide.includes(n)));
check('the guide invents no weather the game has not got',
  !/Fog/.test(guide));
check('the guide describes SPECIAL as it is, not as a shot',
  guide.includes('SPECIAL') && !/shot from distance/i.test(guide));

await shot('04-help');

await click('.back-btn');
await sleep(600);
/*
 * BACK from the guide lands on the Play screen it was opened from, not on the
 * title. The button was wired straight to the renderer, which set the state but
 * never pushed the screen onto the history stack — so BACK skipped a level and
 * dropped the player on the front page.
 */
check('back from Help returns to the Play screen', await exists('.modes-screen'));

await click('.back-btn');
await sleep(600);
check('back from the Play screen returns to the menu', await exists('.menu-screen'));

// ------------------------------------------------------------- 4. players
await clickText('Players', '.menu-opt');
await sleep(600);
check('the Players tile opens the players screen', await exists('.players-screen'));
const allCards = await count('.viber-card2');
check('every Viber is in the grid', allCards > 10, 'cards=' + allCards);
check('the filter row lists every role', (await count('.chip-row .chip')) >= 5);
check('the sort row is present', (await count('.sort-row .chip')) === 3);
check('a card carries a rating badge', await exists('.viber-card2 .ovr-badge'));

/*
 * The card rail is a horizontal scroller with `overflow-y: hidden` and centred
 * items, so a card taller than the rail is clipped at BOTH ends — the rating
 * plate sliced at the top, the role bar gone at the bottom. The generic
 * clipping check above cannot see it: the card is still well inside the
 * viewport, it is the RAIL that is cutting it. Measure the two directly, so
 * "the cards fit" is a number rather than a squint at a screenshot.
 */
const railFit = await evalJs(`(() => {
  const rail = document.querySelector('.screen.hero-select .viber-grid');
  const card = document.querySelector('.card-slot .viber-card2');
  if (!rail || !card) return null;
  const r = rail.getBoundingClientRect(), c = card.getBoundingClientRect();
  return {
    over: Math.round(Math.max(r.top - c.top, c.bottom - r.bottom)),
    cardH: Math.round(c.height),
    railH: Math.round(r.height),
    // Only the landscape rail clips (overflow-y: hidden). In portrait the grid
    // scrolls vertically and a tall card is reachable, not cut.
    clips: getComputedStyle(rail).overflowY === 'hidden',
    roleBar: !!card.querySelector('.card-role'),
  };
})()`);
check('the card fits inside the rail instead of being clipped by it',
  railFit != null && (!railFit.clips || railFit.over <= 1), JSON.stringify(railFit));
check('the role bar survives the layout', railFit?.roleBar === true);

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
/*
 * Tiles are clicked by LABEL, not by index.
 *
 * Dropping the SQUAD tile shifted every index after it, and an index-based
 * harness fails by quietly opening the wrong screen — every assertion below
 * would then be made against a screen the run never meant to visit. A label
 * cannot drift.
 */
await clickText('Career', '.menu-opt');
await sleep(600);
check('the Career tile opens the career screen', await exists('.career-screen'));
check('the stat grid has eight cells', (await count('.stat-cell')) === 8);
check('career totals start at zero',
  (await text('.stat-cell .stat-num')) === '0', await text('.stat-cell .stat-num'));
check('the form panel says there is no form yet', await exists('.form-empty'));
/*
 * The empty-state lines lost their tails with the rest of the prose — "No win
 * on the board yet." is now "No win yet.", and the season-history line no
 * longer explains how to file one. An empty panel still has to say why it is
 * empty, so the lines stay; they just stopped being sentences.
 */
check('the best-result panel says there is no win yet',
  (await text('.career-screen'))?.includes('No win yet.') === true,
  await text('.career-panel .panel-sub'));
check('the history panel says no season is filed',
  (await text('.career-screen'))?.includes('No completed seasons yet') === true);
await shot('08-career-empty');

await click('.back-btn');
await sleep(500);

// ------------------------------------------------------------- 6. settings
await clickText('Settings', '.menu-opt');
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
await clickText('Settings', '.menu-opt');
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
await clickText('League', '.menu-opt');
await sleep(600);
check('back on the League screen', await exists('.league-screen'));

await clickText('Play Next Match', '.primary-btn');
await sleep(800);
check('the league fixture goes through the squad picker', await exists('.hero-select'));

/*
 * The squad rule. Twelve may be named, five of them play, and the strip is the
 * only place that is stated rather than implied — so it is worth asserting the
 * split itself, not just that some slots exist.
 */
check('the picker states the squad rule as a strip of slots',
  (await count('.squad-strip .strip-slot')) === 12,
  'slots=' + (await count('.squad-strip .strip-slot')));
check('the strip splits the five who play from the seven in reserve',
  (await count('.strip-group.start .strip-slot')) === 5 &&
    (await count('.strip-group.bench .strip-slot')) === 7,
  `start=${await count('.strip-group.start .strip-slot')} bench=${await count('.strip-group.bench .strip-slot')}`);
check('the strip names both halves',
  (await text('.strip-group.start .strip-label')) === 'Starting five' &&
    (await text('.strip-group.bench .strip-label')) === '7 in reserve',
  `${await text('.strip-group.start .strip-label')} / ${await text('.strip-group.bench .strip-label')}`);
check('the strip starts empty', (await count('.strip-slot.filled')) === 0);
/*
 * The line that used to spell the rule out — "the first five start" — is gone
 * with every other subtitle. The strip's own two labels carry it now ("Starting
 * five" / "7 in reserve", asserted directly above), so there is nothing left to
 * check here; a check against `.screen-sub` would pass against `null`.
 */
check('the picker no longer explains itself in prose',
  !(await exists('.hero-select .screen-sub')));

await clickText('Auto', 'button');
await sleep(700);
const picked = await evalJs(`document.querySelectorAll('.viber-card2.selected').length`);
check('the auto pick names a full twelve-man squad', picked === 12, 'selected=' + picked);
check('every slot in the strip fills in', (await count('.strip-slot.filled')) === 12,
  'filled=' + (await count('.strip-slot.filled')));
check('the strip names every player', (await count('.strip-slot .strip-name')) === 12);
check('the counter reads out of twelve',
  (await text('.pick-ring .ring-label'))?.includes('/12') === true,
  await text('.pick-ring .ring-label'));
// The number is what carries "this player is picked" for a colour-blind player,
// so it has to actually be there and match the slot in the strip.
const pickNums = await evalJs(`(() => {
  const nums = [...document.querySelectorAll('.viber-card2.selected .card-pick')]
    .map((e) => e.textContent.trim());
  const strip = [...document.querySelectorAll('.strip-slot.filled .strip-n')]
    .map((e) => e.textContent.trim());
  return { nums, inStrip: nums.every((n) => strip.includes(n)) };
})()`);
check('every picked card is numbered', pickNums?.nums?.length === 12,
  'nums=' + JSON.stringify(pickNums?.nums));
check('the card numbers match the squad slots in the strip', pickNums?.inStrip === true,
  JSON.stringify(pickNums));

// A filled slot is a way into the squad, not just a readout.
const openedFromStrip = await click('.strip-slot.filled');
check('a filled slot opens that player', openedFromStrip === 'ok', openedFromStrip);
await sleep(600);
check('the slot opened a player card', await exists('.sheet'));
await click('.back-btn');
await sleep(600);
check('closing the card returns to the picker', await exists('.hero-select'));

/*
 * A picked card lifts out of the row (a transform), and a transform does not
 * change scrollHeight — so the clip detector above, which compares scrollHeight
 * to clientHeight, is blind to it. The rail's `overflow-y: hidden` will still
 * cut it off, though. Measure the lifted card against the rail directly.
 */
const pickedFit = await evalJs(`(() => {
  const rail = document.querySelector('.screen.hero-select .viber-grid');
  const card = document.querySelector('.card-slot .viber-card2.selected');
  if (!rail || !card) return null;
  const r = rail.getBoundingClientRect(), c = card.getBoundingClientRect();
  const cs = getComputedStyle(rail);
  const slot = card.parentElement.getBoundingClientRect();
  return {
    over: Math.round(Math.max(r.top - c.top, c.bottom - r.bottom)),
    clips: cs.overflowY === 'hidden',
    // The numbers the verdict is made of, so a failure explains itself instead
    // of just reporting a pixel count.
    rail: { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) },
    card: { top: Math.round(c.top), bottom: Math.round(c.bottom), h: Math.round(c.height) },
    slot: { top: Math.round(slot.top), bottom: Math.round(slot.bottom), h: Math.round(slot.height) },
    pad: cs.paddingTop + '/' + cs.paddingBottom,
    transform: getComputedStyle(card).transform,
  };
})()`);
check('a picked card is not clipped by the rail either',
  pickedFit != null && (!pickedFit.clips || pickedFit.over <= 1), JSON.stringify(pickedFit));
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
/*
 * Which round this is, and whether it is home or away, moved from the subtitle
 * into a header chip. It is real state a player acts on, so it was not deleted
 * with the rest of the prose — it just stopped being a sentence.
 */
check('the opponent screen names the league round in a chip',
  (await text('.fixture-meta'))?.includes('Round') === true,
  await text('.fixture-meta'));
check('the opponent screen shows both fives',
  (await count('.vs-side')) === 2 && (await count('.vs-avatars')) === 2);
check('the conditions strip names the pitch and length',
  (await count('.conditions-strip .cond')) === 3,
  await text('.conditions-strip'));
// Counting the chips is not enough — the bug this guards against was a chip that
// was present and reading a raw float. Assert what it says.
check('the conditions strip shows no raw float',
  !/\d{4,}/.test((await text('.conditions-strip')) ?? ''),
  'cond=' + (await text('.conditions-strip')));
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

await clickText('League', '.menu-opt');
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

/*
 * Advance the match toward a phase, answering anything that stops it.
 *
 * The world pauses for exactly two things mid-match: a penalty (the human picks
 * a direction) and half-time (the human picks a mentality). Neither was ever
 * answered by this harness — a penalty would have hung it outright, and only
 * luck kept one from being awarded in a run. Answering them here closes that
 * hole and is what makes the driver safe to loop.
 *
 * Returns the world's phase when it stopped, so the caller can tell "arrived"
 * from "gave up".
 */
const runMatchTo = async (target, label) => {
  // A 90-second half is 5400 ticks; 4x that is room for a whole match of
  // stoppages without the guard ever being the thing that ends the loop.
  const cap = 60 * 60 * 4;
  for (let round = 0; round < 200; round++) {
    const r = await evalJs(`(() => {
      const w = window.game.world;
      let guard = 0;
      while (w.phase !== ${JSON.stringify(target)} && !w.paused && guard++ < ${cap}) {
        TestSim.step(w, TestSim.TICK);
      }
      return { phase: w.phase, paused: w.paused, guard, clock: w.clock, half: w.half };
    })()`);
    if (r.phase === target) return r;
    if (!r.paused) {
      console.log(`   ...${label}: guard exhausted at ${r.phase} (clock ${r.clock.toFixed(1)})`);
      return r;
    }
    /*
     * Paused. Wait for the panel to appear — the app renders it on its next
     * animation frame, which is up to a few hundred ms away at 5fps.
     */
    let kind = null;
    for (let i = 0; i < 40 && !kind; i++) {
      if (await exists('.penalty-panel')) kind = 'penalty';
      else if (await exists('.overlay-screen .choice-btn')) kind = 'choice';
      else await sleep(250);
    }
    if (kind === 'penalty') {
      console.log(`   ...${label}: penalty at ${r.clock.toFixed(1)}s — choosing a direction`);
      await click('.dive-btn');
    } else if (kind === 'choice') {
      console.log(`   ...${label}: decision panel at ${r.clock.toFixed(1)}s — taking Balanced`);
      await clickText('Balanced', '.choice-btn');
    } else {
      console.log(`   ...${label}: world paused at ${r.phase} with no panel to answer`);
      return r;
    }
    await sleep(400);
  }
  return { phase: null };
};

// Half time arrives after one half, and the game waits for a mentality.
console.log('\ndriving the first half...');
let ht = false;
for (let i = 0; i < 30 && !ht; i++) {
  const r = await runMatchTo('halftime', 'first half');
  // The world reaches half-time a frame or two before the app has rendered the
  // mentality panel that is the thing being asserted, so wait for the panel.
  for (let k = 0; k < 20 && !ht; k++) {
    if (await exists('.overlay-screen .choice-btn')) ht = true;
    else await sleep(250);
  }
  if (r.phase === null) break;
}
check('half-time pauses the match for a decision', ht);
if (ht) {
  await shot('16-halftime');
  check('half-time offers the four mentalities',
    (await count('.overlay-screen .choice-btn')) === 4,
    'choices=' + (await count('.overlay-screen .choice-btn')));
  await clickText('Balanced', '.choice-btn');
  // The panel closes and the second half starts on the app's next frame or two.
  let resumed = false;
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    if ((await text('.half')) === '2nd Half') { resumed = true; break; }
  }
  check('choosing a mentality closes the half-time panel',
    (await exists('.overlay-screen .choice-btn')) === false);
  check('choosing a mentality resumes the second half', resumed,
    'half=' + (await text('.half')));
}

console.log('\ndriving the second half...');
let ft = false;
for (let i = 0; i < 30 && !ft; i++) {
  await runMatchTo('fulltime', 'second half');
  // The result panel is rendered by the app when it drains the fulltime event,
  // which is a frame or two behind the phase change.
  for (let k = 0; k < 20 && !ft; k++) {
    if (await exists('.stats-table')) { ft = true; break; }
    await sleep(250);
  }
}
check('the match reaches full time', ft, 'clock=' + (await clockAt()));
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

/*
 * The squad view, reached the only way left to reach it.
 *
 * This screen used to have its own front-page tile, and the checks that used to
 * live there clicked it. That tile is gone — the screen survives as this
 * shortcut on the result panel — so the assertions move here, where the door
 * actually is. Testing a screen through a route that no longer exists is how a
 * green run stops meaning anything.
 */
await clickText('Squad', '.ghost-btn');
await sleep(800);
check('the result shortcut opens the read-only squad view', await exists('.squad-view'));
check('the squad view still shows the five on the pitch',
  (await count('.squad-view .squad-slot')) === 5,
  'slots=' + (await count('.squad-view .squad-slot')));
check('every slot in the squad view has a role label',
  (await count('.squad-view .squad-slot-role')) === 5);
check('the squad view still names all four roles in the balance strip',
  (await count('.squad-view .squad-balance .balance-pill')) === 4);
/*
 * The five are picked automatically before the match, so the side is full and
 * the note that explains a SHORT side is correctly absent. Assert the absence:
 * a note that appears when it should not is as wrong as one that does not.
 */
check('a full five carries no "you are short" note',
  !(await exists('.squad-view .section-note')));
await shot('17b-squad-view');

/*
 * Leave the way a player would: reload, then walk in from the front page.
 *
 * The squad view is reached with `record = false`, so BACK from it pops the
 * PRE-MATCH stack and lands on the opponent screen of a match already played.
 * Rather than encode that accident, reload — everything that matters is on
 * disk, and this is also a second, free proof that the result persisted.
 */
await send('Page.navigate', { url });
await sleep(8500);
await freeze();
await clickText('League', '.menu-opt');
await sleep(800);
check('the result returns to the League', await exists('.league-screen'));
const playedCell = await text('.lt-you .lt-num');
check('the player row now shows one played', playedCell === '1', 'played=' + playedCell);

/*
 * The league moves with the player, and this is the assertion that says so.
 *
 * It used to show every CPU club ten or eleven games in with the player on
 * none — the whole CPU season was simulated the moment the table was built, so
 * the only thing left to chase was arithmetic. Nobody is now a game ahead of
 * the player, and the only club yet to play is the one with the bye.
 */
const after = await readTable();
const me = after?.find((r) => r.you);
const busiest = Math.max(...(after ?? []).map((r) => r.played));
check('no club has played more league games than the player',
  after != null && me != null && busiest <= me.played,
  `busiest=${busiest} player=${me?.played}`);
check('only the club with the bye is still on none played',
  after?.filter((r) => r.played === 0).length === 1,
  JSON.stringify(after?.map((r) => `${r.club} ${r.played}`)));
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
await clickText('Career', '.menu-opt');
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
await clickText('League', '.menu-opt');
await sleep(800);
/*
 * And the league gate does not come back.
 *
 * This is the whole point of the gate being gated on `leagueStartedAt` rather
 * than on "are there any results": a manager who has played one fixture must
 * land straight back in their season, not be asked to start or load one. The
 * gate is for the FIRST visit. Asserting it here — after a reload, with a
 * result on disk — is the only way to prove the difference.
 */
check('a league already on the device skips the gate',
  !(await exists('.league-gate')), 'gate=' + (await exists('.league-gate')));
check('the stored result survived the reload',
  (await text('.lt-you .lt-num')) === '1',
  'played=' + (await text('.lt-you .lt-num')));
await shot('21-league-after-reload');

// -------------------------------------------- 9b. injuries, bans and depth
/*
 * The point of a twelve-man squad, end to end.
 *
 * Whether a match injures anyone is seed-dependent, so the absence is written
 * straight into storage instead: a check that only fires on some seeds is not a
 * check. What is being proved is the whole chain — a stored absence comes back
 * as a player who is listed as out, is excluded from the five, has a replacement
 * step up in their place, and cannot be added to the squad again.
 */
const injuredId = await evalJs(`(() => {
  const raw = localStorage.getItem('viber-league:career:v1');
  if (!raw) return null;
  const c = JSON.parse(raw);
  if (!c.lineup || !c.lineup.length) return null;
  const id = c.lineup[0];
  c.absences = { [id]: { kind: 'injury', matches: 2 } };
  localStorage.setItem('viber-league:career:v1', JSON.stringify(c));
  return id;
})()`);
check('there was a squad member to injure', typeof injuredId === 'string' && injuredId.length > 0,
  'id=' + injuredId);

await send('Page.navigate', { url });
await sleep(8500);
await freeze();
await clickText('League', '.menu-opt');
await sleep(800);
check('the league screen lists who is out', await exists('.league-screen .out-list'));
check('the casualty list names one player',
  (await count('.league-screen .out-list .out-row')) === 1,
  'rows=' + (await count('.league-screen .out-list .out-row')));
check('the casualty list says how long they are out for',
  (await text('.league-screen .out-tag')) === 'OUT 2',
  await text('.league-screen .out-tag'));
check('the casualty list says what is wrong',
  (await text('.league-screen .out-why')) === 'Injured',
  await text('.league-screen .out-why'));
await shot('21b-league-injury');

// -------------------------------------------- 9c. quick play leaves no trace
/*
 * The mode screen, and a friendly played with a season already running.
 *
 * This is where the two modes could quietly bleed into each other, so it is
 * checked with the career in its most fragile state: one result filed, and one
 * player two games into an injury. A friendly must file nothing AND must not
 * run that ban down. `tickAbsences` used to fire on any match at all, which
 * would have let a manager cure a two-match layoff by playing friendlies — and
 * nothing on screen would have said so.
 */
await click('.back-btn');
await sleep(700);
await click('.play-btn');
await sleep(800);
check('PLAY opens the mode screen', await exists('.modes-screen'));
const modeCards = await count('.mode-card');
check('the mode screen offers two modes', modeCards === 2, 'cards=' + modeCards);
const modeCopy = (await text('.modes-screen')) ?? '';
check('the League tile carries the season context',
  modeCopy.includes('1 of 12 played'), modeCopy.slice(0, 140));
// PvP needs a relay and a simulation that is bit-identical on two devices. It
// is absent until that is proven: a tile that leads nowhere is worse than none.
check('PvP is not offered before it is proven',
  !/pvp|versus|player vs/i.test(modeCopy), modeCopy.slice(0, 90));
await shot('27-modes');

await clickText('Quick Play', '.mode-card');
await sleep(800);
check('Quick Play opens the squad picker', await exists('.hero-select'));
/*
 * The friendly picker asks for five, not twelve — and the line that used to say
 * so in words is gone. The shape says it instead: one group, five slots, no
 * reserve row. Assert the structure, because that is what a player sees.
 */
check('the friendly picker offers exactly five slots',
  (await count('.hero-select .strip-slot')) === 5,
  'slots=' + (await count('.hero-select .strip-slot')));
check('the friendly picker names its one group',
  (await count('.hero-select .strip-group')) === 1,
  'groups=' + (await count('.hero-select .strip-group')));
const quickStrip = await evalJs(`(() => {
  const s = document.querySelector('.hero-select .squad-strip');
  return s ? {
    groups: s.querySelectorAll('.strip-group').length,
    bench: s.querySelectorAll('.strip-group.bench').length,
    slots: s.querySelectorAll('.strip-slot').length,
  } : null;
})()`);
check('a friendly draws no reserve row', quickStrip?.bench === 0, JSON.stringify(quickStrip));
check('the injured league player is not marked out in a friendly',
  (await count('.hero-select .strip-slot.is-out')) === 0,
  'out=' + (await count('.hero-select .strip-slot.is-out')));
await shot('27b-quick-squad');

await clickText('Auto Pick', '.ghost-btn');
await sleep(800);
const quickPicked = await count('.hero-select .viber-card2.selected');
check('Auto Pick fills exactly five for a friendly', quickPicked === 5, 'picked=' + quickPicked);
await clickText('Continue', '.primary-btn');
await sleep(900);
check('Quick Play skips the venue and match-length screens', await exists('.vs-row'));
/*
 * The conditions strip is where a raw float escapes: `halfSeconds` is only a
 * positive number to the career, and this run pins a two-second half, so the
 * strip's length reads `(2 * 2) / 60`. Counting the chips proved nothing — the
 * chip was there, reading `0.06666666666666667 min`. Assert the text.
 */
const quickConds = (await text('.conditions-strip')) ?? '';
check('the friendly conditions strip shows no raw float',
  !/\d{4,}/.test(quickConds), 'cond=' + quickConds);
check('the friendly conditions strip still names all three conditions',
  (await count('.conditions-strip .cond')) === 3, 'cond=' + quickConds);
await shot('27c-quick-opponent');

await click('.primary-btn');
await sleep(2500);
check('a friendly reaches kick-off', await exists('.hud'));

/*
 * A friendly is a match like any other, so it stops at half-time for a
 * mentality — and that is the whole reason this drives it in two halves.
 *
 * Driving straight to full time spins against a world parked in `halftime`
 * waiting to be answered, and the loop gives up. The weaker `.overlay-screen`
 * assertion then passed on the HALF-TIME panel, so the section reported success
 * with the friendly still stuck in the first half — and every isolation check
 * below was vacuous, because no full-time whistle had been reached for the
 * career to fail to record. Asserting on `.stats-table` instead is what tells
 * the result panel apart from the half-time one; both are `.overlay-screen`.
 */
console.log('\ndriving the friendly...');
let quickHt = false;
for (let i = 0; i < 30 && !quickHt; i++) {
  await runMatchTo('halftime', 'quick play first half');
  for (let k = 0; k < 20 && !quickHt; k++) {
    if (await exists('.overlay-screen .choice-btn')) quickHt = true;
    else await sleep(250);
  }
}
check('a friendly stops at half-time for a mentality like any match', quickHt);
if (quickHt) await clickText('Balanced', '.choice-btn');

let quickFt = false;
for (let i = 0; i < 30 && !quickFt; i++) {
  await runMatchTo('fulltime', 'quick play second half');
  for (let k = 0; k < 20 && !quickFt; k++) {
    if (await exists('.stats-table')) { quickFt = true; break; }
    await sleep(250);
  }
}
check('a friendly reaches full time', quickFt);
await shot('27d-quick-result');

/*
 * The screen has to LOOK like a friendly, not merely avoid writing anything. A
 * result panel that offered "Back to the League" and a league position would
 * tell the player the match counted, whatever the save file says.
 */
check('the friendly result screen says it counted for nothing',
  (await text('.result-note')) === 'Friendly · no league impact',
  'note=' + (await text('.result-note')));
check('the friendly result screen carries no league position',
  (await text('.overlay-screen'))?.includes('in the league') !== true);
check('the friendly result screen offers the menu, not the league',
  (await text('.overlay-screen'))?.includes('Main menu') === true);

/*
 * Read the save file, not the screen. This is the whole point of the mode: the
 * screens would look identical whether or not the career had been written to.
 */
const afterQuick = await evalJs(`(() => {
  const c = JSON.parse(localStorage.getItem('viber-league:career:v1') || '{}');
  const ids = Object.keys(c.absences || {});
  return {
    results: Object.keys(c.results || {}).length,
    absences: ids.length,
    matches: ids.length ? c.absences[ids[0]].matches : null,
    lineup: (c.lineup || []).length,
  };
})()`);
check('a friendly files no league result',
  afterQuick?.results === 1,
  `results=${afterQuick?.results} — one was filed before the friendly, so nothing was added`);
check('a friendly does not run an existing injury down',
  afterQuick?.matches === 2, JSON.stringify(afterQuick));
check('a friendly does not touch the league squad',
  afterQuick?.lineup === 12, 'lineup=' + afterQuick?.lineup);

await clickText('Main menu', '.primary-btn');
await sleep(1000);
check('a friendly ends back at the title', await exists('.menu-screen'));

// Back to the league, where the next fixture is still waiting.
await clickText('League', '.menu-opt');
await sleep(900);
check('the league is exactly where the friendly found it',
  (await text('.lt-you .lt-num')) === '1' &&
    (await count('.league-screen .out-list .out-row')) === 1,
  'played=' + (await text('.lt-you .lt-num')) +
    ' out=' + (await count('.league-screen .out-list .out-row')));

await clickText('Play Next Match', '.primary-btn');
await sleep(900);
check('the picker still opens with an injured player in the squad', await exists('.hero-select'));

const outCard = await evalJs(`(() => {
  const card = document.querySelector('.viber-card2.is-out');
  if (!card) return null;
  const add = card.closest('.card-slot')?.querySelector('.card-add');
  return {
    tag: card.querySelector('.card-out')?.textContent.trim() ?? null,
    addDisabled: add ? add.disabled : null,
    label: card.getAttribute('aria-label'),
  };
})()`);
check('the injured card is badged', outCard?.tag === 'OUT 2', JSON.stringify(outCard));
check('the card says why, for a screen reader',
  typeof outCard?.label === 'string' && outCard.label.includes('Injured'), JSON.stringify(outCard));
check('an injured player can still be dropped from the squad',
  outCard?.addDisabled === false, JSON.stringify(outCard));

const outSlot = await evalJs(`(() => {
  const slot = document.querySelector('.strip-slot.filled.is-out');
  if (!slot) return null;
  return {
    inStart: !!slot.closest('.strip-group.start'),
    inBench: !!slot.closest('.strip-group.bench'),
    tag: slot.querySelector('.strip-tag')?.textContent.trim() ?? null,
  };
})()`);
check('the injured player is shown in the reserves, not the five',
  outSlot?.inBench === true && outSlot?.inStart === false, JSON.stringify(outSlot));
check('the injured slot carries the same badge', outSlot?.tag === 'OUT 2', JSON.stringify(outSlot));
check('a fit player steps up into the starting five',
  (await count('.strip-group.start .strip-slot.filled')) === 5,
  'filled=' + (await count('.strip-group.start .strip-slot.filled')));
check('the five that take the pitch are all fit',
  (await count('.strip-group.start .strip-slot.is-out')) === 0);

/*
 * An out chip is WIDER than a plain one — it carries "OUT 2" as well as its
 * number — and it does not shrink. So the one thing that can push the strip
 * past its column is an injury, which is exactly the state the plain picker
 * never reaches. Measure every chip against the strip itself rather than
 * trusting the screenshot, and keep the screenshot too: this is the state the
 * player sees for a whole match, and it was never captured before.
 */
const stripFit = await evalJs(`(() => {
  const strip = document.querySelector('.hero-select .squad-strip');
  const slots = [...document.querySelectorAll('.hero-select .squad-strip .strip-slot')];
  if (!strip || !slots.length) return null;
  const s = strip.getBoundingClientRect();
  let over = -Infinity;
  for (const el of slots) {
    const r = el.getBoundingClientRect();
    over = Math.max(over, s.left - r.left, r.right - s.right);
  }
  const last = slots[slots.length - 1].getBoundingClientRect();
  return {
    over: Math.round(over),
    slots: slots.length,
    strip: Math.round(s.left) + '..' + Math.round(s.right),
    lastRight: Math.round(last.right),
  };
})()`);
check('every squad slot fits inside the strip, badge and all',
  stripFit != null && stripFit.over <= 1, JSON.stringify(stripFit));
await shot('21c-picker-injury');

/*
 * And the loophole that would make all of the above pointless: if AUTO PICK
 * quietly released the injured player, one tap would erase the injury — the
 * squad would be refilled from the roster and the absence would be gone with
 * them. It must keep what the manager has and only top the squad up.
 */
await clickText('Auto', 'button');
await sleep(700);
check('auto pick does not drop an injured player', await exists('.viber-card2.is-out'));
check('auto pick leaves the squad at twelve',
  (await count('.viber-card2.selected')) === 12,
  'selected=' + (await count('.viber-card2.selected')));
const stillOut = await evalJs(`(() => {
  const c = JSON.parse(localStorage.getItem('viber-league:career:v1') || '{}');
  return {
    inSquad: (c.lineup || []).includes(${JSON.stringify(injuredId)}),
    absences: Object.keys(c.absences || {}),
  };
})()`);
check('the injured player is still in the squad after auto pick',
  stillOut?.inSquad === true, JSON.stringify(stillOut));
check('the injury is still on the books after auto pick',
  stillOut?.absences?.length === 1, JSON.stringify(stillOut));
check('a fit player still steps up into the five',
  (await count('.strip-group.start .strip-slot.filled')) === 5);
await shot('21d-picker-after-autopick');

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
