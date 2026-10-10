// ui/screens.ts — the game screens: main menu, hero select, player profile,
// venue picker, opponent reveal, half-time and full-time.
//
// Pure presentation. Every action is a callback; nothing here touches the sim.
// The 3D world behind these screens is driven by app/game.ts through the
// renderer's showcase stage, so the middle of each screen is deliberately left
// translucent for the hero to show through.

import { clear, el, on } from './dom';
import { hex, viberAvatar } from './avatar';
import { ICON_IDS, brandSvg, iconLabel, type IconId } from '../brand';
import {
  ROSTER,
  ROSTER_BY_ID,
  overallOf,
  teamOverall,
  type OpponentSelection,
  type ViberCharacter,
  type ViberRole,
} from '../sim/roster';
import { WEATHERS, WEATHER_ORDER } from '../sim/weather';
import { CLUBS, PLAYER_CLUB, deriveShort } from '../sim/content';
import {
  LEAGUE_CLUB_IDS,
  PLAYER_CLUB_ID,
  buildTable,
  clubName,
  clubShort,
  isHomeFixture,
  lifetimeTotals,
  opponentOf,
  playerFixtures,
  playerPosition,
  playerRow,
  recentForm,
  type FormEntry,
  type ResultMap,
  type SeasonSummary,
  type TableRow,
} from '../sim/league';
import type { DiveDirection, Mentality, WeatherKind, World } from '../sim/types';

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

const ROLE_LABEL: Record<ViberRole, string> = {
  GK: 'Goalkeeper',
  DEF: 'Defender',
  MID: 'Midfielder',
  FWD: 'Forward',
};

export type RoleFilter = 'ALL' | ViberRole;

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, cls?: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  if (cls) node.setAttribute('class', cls);
  return node;
}

/** Attribute bar colour, from the same thresholds the sim balance uses. */
function attrPaint(value: number): { grad: string; solid: string } {
  if (value >= 85) return { grad: 'linear-gradient(90deg,#15803d,#4ade80)', solid: '#4ade80' };
  if (value >= 70) return { grad: 'linear-gradient(90deg,#0e7490,#22d3ee)', solid: '#22d3ee' };
  if (value >= 55) return { grad: 'linear-gradient(90deg,#b45309,#fbbf24)', solid: '#fbbf24' };
  return { grad: 'linear-gradient(90deg,#991b1b,#f87171)', solid: '#f87171' };
}

function attrRow(label: string, value: number): HTMLElement {
  const row = el('div', 'attr-row');
  const paint = attrPaint(value);
  const track = el('div', 'attr-track');
  const fill = el('div', 'attr-fill');
  fill.style.width = `${Math.max(6, value)}%`;
  fill.style.background = paint.grad;
  fill.style.color = paint.solid;
  track.append(fill);
  row.append(el('span', 'attr-k', label), track, el('span', 'attr-v', String(value)));
  return row;
}

const RING_R = 20;
const RING_C = 2 * Math.PI * RING_R;

/** The 0 / 5 game-HUD counter. Animates up from empty on mount. */
function progressRing(count: number, total = 5): HTMLElement {
  const wrap = el('div', 'pick-ring');
  if (count >= total) wrap.classList.add('full');

  const s = svg('svg');
  s.setAttribute('viewBox', '0 0 48 48');
  const track = svg('circle', 'ring-track');
  const fill = svg('circle', 'ring-fill');
  for (const c of [track, fill]) {
    c.setAttribute('cx', '24');
    c.setAttribute('cy', '24');
    c.setAttribute('r', String(RING_R));
  }
  fill.setAttribute('stroke-dasharray', String(RING_C));
  fill.setAttribute('stroke-dashoffset', String(RING_C));
  s.append(track, fill);

  const label = el('div', 'ring-label');
  label.append(el('b', '', String(count)), el('i', '', `/${total}`));
  wrap.append(s, label);

  // Fill on the next frame so the CSS transition has somewhere to travel from.
  requestAnimationFrame(() => {
    fill.setAttribute('stroke-dashoffset', String(RING_C * (1 - count / total)));
  });
  return wrap;
}

/** One collectible hero card, plus its sibling quick-add control. */
function cardSlot(
  v: ViberCharacter,
  opts: {
    selected: boolean;
    index: number;
    order: number;
    canAdd: boolean;
    onOpen: () => void;
    onToggle: () => void;
  },
): HTMLElement {
  const slot = el('div', 'card-slot');
  slot.style.setProperty('--i', String(opts.order));

  const card = el('button', `viber-card2 role-${v.role}`);
  if (opts.selected) card.classList.add('selected');

  const badge = el('span', 'ovr-badge', String(overallOf(v)));

  const art = el('div', 'card-art');
  art.append(viberAvatar(v, 1.15));

  const meta = el('div', 'card-meta');
  meta.append(
    el('div', 'card-name', v.name),
    el('div', 'card-epithet', v.epithet),
    el('div', 'card-role', ROLE_LABEL[v.role]),
  );

  card.append(badge, art, meta);
  if (opts.selected) {
    card.append(el('span', 'pick-num', String(opts.index + 1)));
    card.append(el('span', 'card-check', '✓'));
    const shine = el('span', 'card-shine');
    card.append(shine);
  }
  on(card, 'click', opts.onOpen);

  const add = el('button', `card-add${opts.selected ? ' on' : ''}`, opts.selected ? '−' : '+');
  add.setAttribute('aria-label', opts.selected ? `Remove ${v.name}` : `Add ${v.name} to squad`);
  if (!opts.selected && !opts.canAdd) add.disabled = true;
  on(add, 'click', (ev) => {
    ev.stopPropagation();
    opts.onToggle();
  });

  slot.append(card, add);
  return slot;
}

/** The little brand mark used above secondary screens. */
/**
 * The brand mark as a real element.
 *
 * `brandSvg` returns static markup assembled from our own path strings — no user
 * input is ever interpolated into it — so assigning it as `innerHTML` is both
 * safe and the only practical way to build an `<svg>` without spelling out the
 * namespace by hand.
 */
function iconNode(
  id: IconId,
  size: number,
  opts: { className?: string; badge?: boolean } = {},
): HTMLElement {
  const wrap = el('span', `brand-icon${opts.className ? ' ' + opts.className : ''}`);
  wrap.innerHTML = brandSvg(id, { size, badge: opts.badge });
  return wrap;
}

/** The small "Viber League" chip that heads the profile screens. */
function brand(): HTMLElement {
  const b = el('div', 'menu-crest');
  b.append(iconNode('viber', 22), el('span', '', 'Viber League'));
  return b;
}

/* ------------------------------------------------------------------ */
/* Navigation furniture                                                */
/* ------------------------------------------------------------------ */

/**
 * The one BACK control. Every secondary screen wears the same one, in the same
 * place, at the same touch size — so the player never has to hunt for it.
 */
function backButton(onBack: () => void, label = 'Back'): HTMLElement {
  const b = el('button', 'back-btn');
  b.setAttribute('aria-label', label);
  b.append(el('span', 'back-chev', '‹'), el('span', 'back-label', label));
  on(b, 'click', onBack);
  return b;
}

/** A header row: optional back button, then the title block. */
function screenHead(
  title: string,
  sub: string,
  onBack?: () => void,
  right?: HTMLElement,
): HTMLElement {
  const head = el('div', 'screen-head');
  const titleWrap = el('div', 'head-text');
  titleWrap.append(el('h1', 'screen-title', title), el('p', 'screen-sub', sub));

  if (onBack) {
    const left = el('div', 'head-left');
    left.append(backButton(onBack), titleWrap);
    head.append(left);
  } else {
    head.append(titleWrap);
  }
  if (right) head.append(right);
  return head;
}

/* ------------------------------------------------------------------ */
/* 1. Main menu                                                        */
/* ------------------------------------------------------------------ */

/** The five club sections behind the main menu. */
export type MenuSection = 'league' | 'squad' | 'players' | 'career' | 'settings';

const MENU_OPTIONS: Array<{ id: MenuSection; ico: string; label: string }> = [
  { id: 'league', ico: '🏆', label: 'League' },
  { id: 'squad', ico: '👥', label: 'Squad' },
  { id: 'players', ico: '⭐', label: 'Players' },
  { id: 'career', ico: '📈', label: 'Career' },
  { id: 'settings', ico: '⚙️', label: 'Settings' },
];

export interface TitleOpts {
  /** Shown on the account chip in the top-right. Absent for a guest. */
  manager?: string;
  /**
   * The player's own club, for the crest line under the logo. Absent for a
   * guest — and absent is the point: there is no club to name, so nothing is
   * named, rather than filling the space with a placeholder that reads like
   * generated text.
   */
  club?: { name: string; icon: IconId };
  onAccount?: () => void;
  /** Every tile on the menu opens a real screen. */
  onSection: (section: MenuSection) => void;
}

export function renderTitle(root: HTMLElement, onStart: () => void, opts?: TitleOpts): void {
  clear(root);
  const wrap = el('div', 'screen menu-screen');

  const top = el('div', 'menu-top');

  // The official mark, above the wordmark: the one place in the game where the
  // brand is allowed to be the hero.
  const logo = el('div', 'logo');
  logo.append(
    iconNode('viber', 64, { className: 'logo-mark' }),
    el('div', 'logo-line1', 'Viber'),
    el('div', 'logo-line2', 'League'),
  );

  top.append(logo, el('p', 'tagline', 'Pick your five. Read the pitch. Win the match.'));

  // The player's own club, under the wordmark, wearing the crest they chose.
  if (opts?.club) {
    const crest = el('div', 'menu-crest club-crest');
    crest.append(iconNode(opts.club.icon, 26), el('span', '', opts.club.name));
    top.append(crest);
  }

  const bottom = el('div', 'menu-bottom');
  const play = el('button', 'primary-btn play-btn');
  play.append(el('span', '', 'Play'), el('span', 'play-sub', 'Next league fixture'));
  on(play, 'click', onStart);

  const options = el('div', 'menu-options');
  for (const o of MENU_OPTIONS) {
    const b = el('button', 'menu-opt');
    b.append(el('span', 'ico', o.ico), el('span', '', o.label));
    if (opts) on(b, 'click', () => opts.onSection(o.id));
    else b.disabled = true;
    options.append(b);
  }

  bottom.append(play, options);
  wrap.append(top, el('div', 'menu-spacer'), bottom);

  // Who you are, and the way back out of the profile. Top-right and out of the
  // play path: the account is not something a player should hit by accident.
  if (opts?.manager && opts.onAccount) {
    const chip = el('button', 'account-chip');
    chip.setAttribute('aria-label', 'Account');
    chip.append(
      el('span', 'acct-initial', opts.manager.trim().charAt(0).toUpperCase() || '?'),
      el('span', 'acct-name', opts.manager),
    );
    on(chip, 'click', opts.onAccount);
    wrap.append(chip);
  }

  root.append(wrap);
}

/* ------------------------------------------------------------------ */
/* 1b. Profile — create a club, or sign back into one                  */
/* ------------------------------------------------------------------ */

/**
 * Field limits, passed in from the profile store so the form and the store
 * agree on one set of numbers instead of drifting apart.
 */
export interface ProfileLimits {
  managerMin: number;
  managerMax: number;
  clubMin: number;
  clubMax: number;
  passwordMin: number;
}

interface FieldSpec {
  id: string;
  label: string;
  type?: string;
  placeholder?: string;
  maxLength?: number;
  autocomplete?: AutoFill;
  onInput?: (value: string) => void;
  onEnter?: () => void;
}

/** A labelled input in the game's own language, not a web form. */
function field(spec: FieldSpec): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = el('label', 'field');
  wrap.append(el('span', 'field-label', spec.label));

  const input = el('input', 'text-input');
  input.type = spec.type ?? 'text';
  input.id = spec.id;
  input.spellcheck = false;
  if (spec.placeholder) input.placeholder = spec.placeholder;
  if (spec.maxLength) input.maxLength = spec.maxLength;
  if (spec.autocomplete) input.autocomplete = spec.autocomplete;

  wrap.append(input);
  if (spec.onInput) on(input, 'input', () => spec.onInput?.(input.value));
  if (spec.onEnter) {
    on(input, 'keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        spec.onEnter?.();
      }
    });
  }
  return { wrap, input };
}

/**
 * The crest the player will actually see, updating as they type and as they pick
 * an icon. Showing the derived abbreviation up front avoids the surprise of
 * "Riverside Rovers" turning into "RR" once the match starts.
 */
function crestPreview(initial: IconId): {
  wrap: HTMLElement;
  setClub: (name: string) => void;
  setIcon: (id: IconId) => void;
} {
  const wrap = el('div', 'crest-preview');
  const badge = el('span', 'crest-badge');
  const icon = iconNode(initial, 34);
  badge.append(icon);

  const short = el('span', 'crest-short', 'YOU');
  const name = el('span', 'crest-name', 'Your club');
  wrap.append(badge, short, name);

  return {
    wrap,
    setClub: (value: string) => {
      const clean = value.trim();
      short.textContent = clean ? deriveShort(clean) : 'YOU';
      name.textContent = clean || 'Your club';
    },
    setIcon: (id: IconId) => {
      icon.innerHTML = brandSvg(id, { size: 34 });
    },
  };
}

/**
 * The crest picker.
 *
 * Real buttons rather than a `<select>`, because the whole point is that the
 * player can *see* the crest they are choosing — and every one of them is drawn
 * from the same vector set the title screen, the pitch and the hoardings use, so
 * what they pick here is exactly what they get.
 */
function iconPicker(
  initial: IconId,
  onPick: (id: IconId) => void,
): { wrap: HTMLElement; get: () => IconId } {
  const wrap = el('div', 'icon-picker');
  wrap.setAttribute('role', 'radiogroup');
  wrap.setAttribute('aria-label', 'Club crest');

  let current = initial;
  const buttons = new Map<IconId, HTMLButtonElement>();

  const paint = () => {
    for (const [id, b] of buttons) {
      const on_ = id === current;
      b.classList.toggle('active', on_);
      b.setAttribute('aria-pressed', String(on_));
    }
  };

  for (const id of ICON_IDS) {
    const b = el('button', 'icon-choice');
    // Without this the first crest in the grid is the form's submit button.
    b.type = 'button';
    b.setAttribute('aria-label', iconLabel(id));
    b.append(iconNode(id, 40));
    on(b, 'click', () => {
      current = id;
      paint();
      onPick(id);
    });
    buttons.set(id, b);
    wrap.append(b);
  }

  paint();
  return { wrap, get: () => current };
}

export function renderOnboarding(
  root: HTMLElement,
  opts: {
    limits: ProfileLimits;
    canHash: boolean;
    storageOk: boolean;
    onSignIn?: () => void;
    onCreate: (input: {
      manager: string;
      club: string;
      icon: IconId;
      password: string;
    }) => void | Promise<void>;
  },
): void {
  clear(root);
  const wrap = el('div', 'screen profile-screen onboard-screen');
  const card = el('div', 'profile-card');

  const head = el('div', 'profile-head');
  head.append(
    brand(),
    el('h1', 'screen-title', 'Create your club'),
    el(
      'p',
      'screen-sub',
      'Your name, your club and your crest. Set a password so you can get them back.',
    ),
  );

  const form = el('form', 'profile-form');
  form.setAttribute('novalidate', '');

  const errorEl = el('p', 'form-error');
  errorEl.setAttribute('role', 'alert');

  const manager = field({
    id: 'ob-manager',
    label: 'Manager name',
    placeholder: 'e.g. Alex',
    maxLength: opts.limits.managerMax,
    autocomplete: 'username',
  });
  const club = field({
    id: 'ob-club',
    label: 'Club name',
    placeholder: 'e.g. Riverside Rovers',
    maxLength: opts.limits.clubMax,
    autocomplete: 'organization',
  });
  const crest = crestPreview('viber');
  club.input.addEventListener('input', () => crest.setClub(club.input.value));

  const icons = iconPicker('viber', (id) => crest.setIcon(id));
  const iconField = el('div', 'field icon-field');
  iconField.append(el('span', 'field-label', 'Club crest'), icons.wrap);

  const password = field({
    id: 'ob-password',
    label: 'Password',
    type: 'password',
    placeholder: `${opts.limits.passwordMin}+ characters`,
    autocomplete: 'new-password',
  });
  const confirm = field({
    id: 'ob-confirm',
    label: 'Confirm password',
    type: 'password',
    placeholder: 'repeat it',
    autocomplete: 'new-password',
  });

  const submit = el('button', 'primary-btn profile-submit', 'Create club');
  submit.type = 'submit';

  let busy = false;
  const fail = (message: string) => {
    errorEl.textContent = message;
    errorEl.classList.add('show');
  };

  const run = () => {
    if (busy) return;
    errorEl.classList.remove('show');

    const managerName = manager.input.value.trim();
    const clubName = club.input.value.trim();
    const pass = password.input.value;

    if (managerName.length < opts.limits.managerMin) {
      fail(`Give your manager a name of at least ${opts.limits.managerMin} characters.`);
      manager.input.focus();
      return;
    }
    if (clubName.length < opts.limits.clubMin) {
      fail(`Give your club a name of at least ${opts.limits.clubMin} characters.`);
      club.input.focus();
      return;
    }
    if (opts.canHash) {
      if (pass.length < opts.limits.passwordMin) {
        fail(`Passwords need at least ${opts.limits.passwordMin} characters.`);
        password.input.focus();
        return;
      }
      if (pass !== confirm.input.value) {
        fail('Those two passwords do not match.');
        confirm.input.focus();
        return;
      }
    }

    busy = true;
    submit.disabled = true;
    submit.textContent = 'Creating…';
    Promise.resolve(
      opts.onCreate({
        manager: managerName,
        club: clubName,
        icon: icons.get(),
        password: pass,
      }),
    ).catch(() => {
      busy = false;
      submit.disabled = false;
      submit.textContent = 'Create club';
      fail('Could not save your club. Please try again.');
    });
  };

  on(form, 'submit', (ev) => {
    ev.preventDefault();
    run();
  });
  on(confirm.input, 'keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      run();
    }
  });

  form.append(
    manager.wrap,
    club.wrap,
    crest.wrap,
    iconField,
    password.wrap,
    confirm.wrap,
    errorEl,
    submit,
  );

  card.append(head, form);

  if (!opts.storageOk) {
    card.append(
      el(
        'p',
        'notice warn',
        'This browser is blocking local storage, so your club cannot be saved here. Playing is still fine — the profile just will not persist.',
      ),
    );
  } else if (!opts.canHash) {
    card.append(
      el(
        'p',
        'notice',
        'This browser cannot secure a password, so your club will be saved without one.',
      ),
    );
  }

  if (opts.onSignIn) {
    const foot = el('div', 'profile-foot');
    const link = el('button', 'ghost-btn', 'Sign in to an existing club');
    on(link, 'click', opts.onSignIn);
    foot.append(link);
    card.append(foot);
  }

  wrap.append(card);
  root.append(wrap);
  manager.input.focus();
}

export function renderSignIn(
  root: HTMLElement,
  opts: {
    manager: string;
    club: string;
    short: string;
    icon: IconId;
    hasPassword: boolean;
    /** Return `false` to keep the player on this screen with an error shown. */
    onSignIn: (password: string) => void | Promise<boolean | void>;
    onStartOver: () => void;
  },
): void {
  clear(root);
  const wrap = el('div', 'screen profile-screen signin-screen');
  const card = el('div', 'profile-card');

  const head = el('div', 'profile-head');
  head.append(
    brand(),
    el('h1', 'screen-title', 'Welcome back'),
    el('p', 'screen-sub', `Manager ${opts.manager} · ${opts.club}`),
  );

  const crest = el('div', 'crest-preview big');
  const badge = el('span', 'crest-badge');
  badge.append(iconNode(opts.icon, 56));
  crest.append(badge, el('span', 'crest-short', opts.short), el('span', 'crest-name', opts.club));

  const errorEl = el('p', 'form-error');
  errorEl.setAttribute('role', 'alert');

  const password = field({
    id: 'si-password',
    label: 'Password',
    type: 'password',
    placeholder: opts.hasPassword ? 'your password' : 'no password was set',
    autocomplete: 'current-password',
  });
  // A club created on a browser without `crypto.subtle` has no password to ask
  // for, so the field is shut rather than left as a box that swallows typing.
  password.input.disabled = !opts.hasPassword;

  const submit = el('button', 'primary-btn profile-submit', 'Enter');
  submit.type = 'submit';

  let busy = false;
  const run = () => {
    if (busy) return;
    // Nothing to check: an unprotected club opens on the first tap.
    if (!opts.hasPassword) {
      void opts.onSignIn('');
      return;
    }
    errorEl.classList.remove('show');
    busy = true;
    submit.disabled = true;
    submit.textContent = 'Checking…';
    Promise.resolve(opts.onSignIn(password.input.value))
      .then((ok) => {
        if (ok === false) {
          busy = false;
          submit.disabled = false;
          submit.textContent = 'Enter';
          errorEl.textContent = 'That password does not match this club.';
          errorEl.classList.add('show');
          password.input.select();
        }
      })
      .catch(() => {
        busy = false;
        submit.disabled = false;
        submit.textContent = 'Enter';
        errorEl.textContent = 'Could not check the password. Please try again.';
        errorEl.classList.add('show');
      });
  };

  on(submit, 'click', run);

  const form = el('form', 'profile-form narrow');
  form.setAttribute('novalidate', '');
  on(form, 'submit', (ev) => {
    ev.preventDefault();
    run();
  });
  form.append(crest, password.wrap, errorEl, submit);

  // A local profile has no email behind it, so there is genuinely no recovery
  // path. Say so plainly and offer the only real option, behind a confirmation.
  const foot = el('div', 'profile-foot');
  const note = el('div', 'forgot-note');
  const startOver = el('button', 'ghost-btn danger', 'Start a new club');

  note.append(
    el(
      'p',
      'notice',
      opts.hasPassword
        ? 'This club lives only on this device, so there is no password reset. Starting over erases it and you would build a new club from scratch.'
        : 'This club was saved without a password, so anyone on this device can open it. Starting over erases it and you would build a new club from scratch.',
    ),
    startOver,
  );

  let armed = false;
  const disarm = () => {
    armed = false;
    startOver.textContent = 'Start a new club';
    startOver.classList.remove('armed');
  };
  on(startOver, 'click', () => {
    if (!armed) {
      armed = true;
      startOver.textContent = 'Erase this club and start over';
      startOver.classList.add('armed');
      return;
    }
    opts.onStartOver();
  });

  if (opts.hasPassword) {
    const forgot = el('button', 'ghost-btn', 'Forgot password?');
    on(forgot, 'click', () => {
      note.hidden = !note.hidden;
      if (note.hidden) disarm();
    });
    note.hidden = true;
    foot.append(forgot);
  } else {
    // Nothing to forget, so the warning and the option are simply there.
    note.hidden = false;
  }

  card.append(head, form, foot, note);
  wrap.append(card);
  root.append(wrap);
  if (opts.hasPassword) password.input.focus();
}

export function renderAccountSheet(
  root: HTMLElement,
  opts: {
    manager: string;
    club: string;
    short: string;
    icon: IconId;
    hasPassword: boolean;
    onClose: () => void;
    onSignOut: () => void;
  },
): void {
  clear(root);
  const wrap = el('div', 'screen overlay-screen');

  const sheet = el('div', 'sheet account-sheet');
  const title = el('div', 'sheet-name', 'Account');
  const role = el('div', 'sheet-role', 'Local profile · this device only');

  // The crest they chose, exactly as the title screen and the pitch show it.
  const crest = el('div', 'crest-preview');
  const badge = el('span', 'crest-badge');
  badge.append(iconNode(opts.icon, 34));
  crest.append(badge, el('span', 'crest-short', opts.short), el('span', 'crest-name', opts.club));

  const rows = el('div', 'account-rows');
  const row = (label: string, value: string) => {
    const r = el('div', 'account-row');
    r.append(el('span', 'account-key', label), el('span', 'account-val', value));
    return r;
  };
  rows.append(
    row('Manager', opts.manager),
    row('Club', `${opts.club} (${opts.short})`),
    // Worth stating outright: a club with no password is open to anyone who
    // picks up the device, and nothing else on screen would say so.
    row('Password', opts.hasPassword ? 'Set' : 'Not set'),
  );

  const actions = el('div', 'flow-actions');
  if (opts.hasPassword) {
    const out = el('button', 'ghost-btn', 'Sign out');
    on(out, 'click', opts.onSignOut);
    actions.append(out);
  }
  const close = el('button', 'primary-btn', 'Back to the game');
  on(close, 'click', opts.onClose);
  actions.append(close);

  sheet.append(title, role, crest, rows, actions);
  wrap.append(sheet);
  root.append(wrap);
}

/* ------------------------------------------------------------------ */
/* 2. Hero select — choose your five                                   */
/* ------------------------------------------------------------------ */

export interface SquadSelectOpts {
  selected: string[];
  focus: ViberCharacter;
  filter: RoleFilter;
  onCard: (id: string) => void;
  onToggle: (id: string) => void;
  onFilter: (f: RoleFilter) => void;
  onAuto: () => void;
  onClear: () => void;
  onNext: () => void;
  onBack: () => void;
}

const FILTERS: RoleFilter[] = ['ALL', 'GK', 'DEF', 'MID', 'FWD'];

export function renderSquadSelect(root: HTMLElement, opts: SquadSelectOpts): void {
  clear(root);
  const wrap = el('div', 'screen squad-screen hero-select');

  // ---- header + progress ring ----
  const head = screenHead(
    'Choose Your Five',
    'Tap a Viber to inspect their qualities, then add them to your squad.',
    opts.onBack,
    progressRing(opts.selected.length),
  );

  // ---- hero stage: the 3D Viber shows through this band ----
  const stage = el('div', 'hero-stage');
  const plate = el('div', `hero-plate role-${opts.focus.role}`);
  plate.append(
    el('span', 'ovr-badge', String(overallOf(opts.focus))),
    (() => {
      const t = el('div', 'hero-plate-text');
      t.append(
        el('div', 'hero-plate-name', opts.focus.name),
        el('div', 'hero-plate-sub', `${opts.focus.epithet} · ${ROLE_LABEL[opts.focus.role]}`),
      );
      return t;
    })(),
  );
  stage.append(plate);

  // ---- role filters ----
  const chips = el('div', 'chip-row');
  for (const f of FILTERS) {
    const n = f === 'ALL' ? ROSTER.length : ROSTER.filter((v) => v.role === f).length;
    const b = el('button', `chip${opts.filter === f ? ' active' : ''}`);
    b.append(el('span', '', f === 'ALL' ? 'All' : f), el('span', 'chip-n', String(n)));
    on(b, 'click', () => opts.onFilter(f));
    chips.append(b);
  }

  // ---- the card grid ----
  const grid = el('div', 'viber-grid');
  const shown = ROSTER.filter((v) => opts.filter === 'ALL' || v.role === opts.filter);
  const canAdd = opts.selected.length < 5;
  shown.forEach((v, i) => {
    const idx = opts.selected.indexOf(v.id);
    grid.append(
      cardSlot(v, {
        selected: idx >= 0,
        index: idx,
        order: i,
        canAdd,
        onOpen: () => opts.onCard(v.id),
        onToggle: () => opts.onToggle(v.id),
      }),
    );
  });

  // ---- footer ----
  const actions = el('div', 'flow-actions');
  const auto = el('button', 'ghost-btn', 'Auto Pick');
  on(auto, 'click', opts.onAuto);
  const clearBtn = el('button', 'ghost-btn', 'Clear');
  on(clearBtn, 'click', opts.onClear);
  const next = el('button', 'primary-btn', 'Continue');
  next.disabled = opts.selected.length !== 5;
  if (next.disabled) next.classList.add('disabled');
  on(next, 'click', opts.onNext);
  actions.append(auto, clearBtn, next);

  const footer = el('div', 'flow-footer');
  footer.append(actions);

  // The filters and the rail travel together as one column. In portrait that
  // is simply the rest of the screen; in landscape it becomes the right-hand
  // column beside the hero, so the cards get the full height of the viewport
  // instead of the ~90px a stacked layout leaves them.
  const body = el('div', 'hero-body');
  body.append(chips, grid);

  wrap.append(head, stage, body, footer);
  root.append(wrap);
}

/* ------------------------------------------------------------------ */
/* 3. Player profile — a bottom sheet with the hero above it           */
/* ------------------------------------------------------------------ */

export function renderViberDetail(
  root: HTMLElement,
  v: ViberCharacter,
  opts: { selected: boolean; canAdd: boolean; onToggle: () => void; onClose: () => void },
): void {
  clear(root);
  const wrap = el('div', 'screen overlay-screen');
  const sheet = el('div', `sheet role-${v.role}`);

  const head = el('div', 'sheet-head');
  const idBox = el('div', 'sheet-id');
  idBox.append(
    el('div', 'sheet-name', v.name),
    el('div', 'sheet-epithet', `"${v.epithet}"`),
    (() => {
      const role = el('span', 'sheet-role');
      role.append(el('span', '', ROLE_LABEL[v.role]), el('span', '', `· ${v.archetype}`));
      return role;
    })(),
  );
  head.append(idBox, el('div', 'sheet-ovr', String(overallOf(v))));
  sheet.append(head);

  const attrs = el('div', 'attr-list');
  attrs.append(
    attrRow('PACE', v.attrs.pace),
    attrRow('STRENGTH', v.attrs.strength),
    attrRow('SHOOTING', v.attrs.shooting),
    attrRow('PASSING', v.attrs.passing),
    attrRow('TACKLING', v.attrs.tackling),
    attrRow('TECHNIQUE', v.attrs.technique),
  );
  sheet.append(attrs);

  const special = el('div', 'special-box');
  special.append(
    el('div', 'special-label', 'Special Move'),
    el('div', 'special-name', v.special.name),
    el('div', 'special-desc', v.special.description),
  );
  sheet.append(special);

  const btn = el('button', 'primary-btn', opts.selected ? 'Remove from Squad' : 'Add to Squad');
  if (!opts.selected && !opts.canAdd) {
    btn.disabled = true;
    btn.classList.add('disabled');
    btn.textContent = 'Squad Full';
  }
  on(btn, 'click', opts.onToggle);
  sheet.append(btn);

  const close = backButton(opts.onClose, 'Back to Squad');
  close.classList.add('wide');
  sheet.append(close);

  wrap.append(sheet);
  root.append(wrap);
}

/* ------------------------------------------------------------------ */
/* 4. Venue / conditions                                               */
/* ------------------------------------------------------------------ */

const WEATHER_ICON: Record<WeatherKind, string> = {
  sun: '☀',
  rain: '🌧',
  ice: '❄',
  cold: '☁',
};

/** Each venue is the cartoon home of one set of pitch conditions. */
const VENUES: Record<WeatherKind, { name: string; city: string; sky: string }> = {
  sun: { name: 'City Stadium', city: 'Downtown', sky: 'linear-gradient(180deg,#8fd0ff,#3d8ee0)' },
  rain: { name: 'Neon Arena', city: 'The Strip', sky: 'linear-gradient(180deg,#6b7ba0,#232c44)' },
  ice: { name: 'Frozen Stadium', city: 'North Bank', sky: 'linear-gradient(180deg,#eaf6ff,#a9cbe8)' },
  cold: { name: 'Rooftop Field', city: 'Old Quarter', sky: 'linear-gradient(180deg,#93a1bb,#4a5568)' },
};

/**
 * The paint for one stadium's artwork. Everything the venue scene needs to look
 * like a place rather than a swatch: sky, concrete, crowd, turf and floodlight.
 */
interface VenueArt {
  skyTop: string;
  skyBottom: string;
  stand: string;
  standDark: string;
  crowd: string[];
  turf: string;
  turfDark: string;
  lamp: string;
  accent: string;
}

const VENUE_ART: Record<WeatherKind, VenueArt> = {
  sun: {
    skyTop: '#8fd0ff',
    skyBottom: '#e9f6ff',
    stand: '#cfdbe8',
    standDark: '#a3b4c8',
    crowd: ['#ff6b6b', '#ffd166', '#4ade80', '#60a5fa', '#f472b6', '#f97316'],
    turf: '#43a247',
    turfDark: '#2f7d36',
    lamp: '#fff8d6',
    accent: '#ffc531',
  },
  rain: {
    skyTop: '#0d1620',
    skyBottom: '#2b3a4a',
    stand: '#2b3745',
    standDark: '#1a232e',
    crowd: ['#ccff00', '#ff4fa3', '#22d3ee', '#8b5cf6', '#ff8a2f', '#67e8f9'],
    turf: '#2c6b3c',
    turfDark: '#1c4a28',
    lamp: '#eaffd8',
    accent: '#ccff00',
  },
  ice: {
    skyTop: '#cfe8fb',
    skyBottom: '#f6fcff',
    stand: '#bdd2e4',
    standDark: '#96b1c9',
    crowd: ['#3b82f6', '#67e8f9', '#e2e8f0', '#a855f7', '#f87171', '#38bdf8'],
    turf: '#86bf96',
    turfDark: '#639c76',
    lamp: '#ffffff',
    accent: '#67e8f9',
  },
  cold: {
    skyTop: '#3c4757',
    skyBottom: '#8496ab',
    stand: '#4d596b',
    standDark: '#363f4f',
    crowd: ['#ffc531', '#4ade80', '#e2e8f0', '#ff8a2f', '#60a5fa', '#f472b6'],
    turf: '#3d7d54',
    turfDark: '#2b5b3d',
    lamp: '#ffeec2',
    accent: '#9fb0c4',
  },
};

/** Deterministic 0..1 stream — the artwork must not flicker between renders. */
function artRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

let sceneSeq = 0;

/**
 * A stadium, drawn: floodlit sky, raked stands packed with crowd, floodlight
 * towers with their cones, and a turf pitch running to a goal at the far end.
 * Precipitation is layered last so the weather reads at a glance.
 *
 * The composition is deliberately "banded". The featured ground is a wide,
 * short box (so `slice` crops the top and bottom away), while a rail thumbnail
 * is nearly the full viewBox. Keeping every landmark inside y ≈ 70–170 means
 * both crops show stands, floodlights, goal and turf — never an empty sky.
 *
 * `detail` scales the amount of crowd and rain — thumbnails stay cheap.
 */
function venueScene(kind: WeatherKind, detail = 1): SVGElement {
  const art = VENUE_ART[kind];
  const uid = `ven${sceneSeq++}`;
  const rnd = artRng(kind.length * 7919 + 13);
  const s = svg('svg', 'venue-scene-svg');
  s.setAttribute('viewBox', '0 0 400 240');
  s.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  s.setAttribute('aria-hidden', 'true');

  const HORIZON = 126;

  // ---- defs ----
  const defs = svg('defs');
  const sky = svg('linearGradient');
  sky.setAttribute('id', `${uid}-sky`);
  sky.setAttribute('x1', '0');
  sky.setAttribute('y1', '0');
  sky.setAttribute('x2', '0');
  sky.setAttribute('y2', '1');
  for (const [o, c] of [['0', art.skyTop], ['1', art.skyBottom]] as const) {
    const st = svg('stop');
    st.setAttribute('offset', o);
    st.setAttribute('stop-color', c);
    sky.append(st);
  }

  const turf = svg('linearGradient');
  turf.setAttribute('id', `${uid}-turf`);
  turf.setAttribute('x1', '0');
  turf.setAttribute('y1', '0');
  turf.setAttribute('x2', '0');
  turf.setAttribute('y2', '1');
  for (const [o, c] of [['0', art.turfDark], ['1', art.turf]] as const) {
    const st = svg('stop');
    st.setAttribute('offset', o);
    st.setAttribute('stop-color', c);
    turf.append(st);
  }

  const glow = svg('radialGradient');
  glow.setAttribute('id', `${uid}-glow`);
  for (const [o, op] of [['0', '0.85'], ['1', '0']] as const) {
    const st = svg('stop');
    st.setAttribute('offset', o);
    st.setAttribute('stop-color', art.lamp);
    st.setAttribute('stop-opacity', op);
    glow.append(st);
  }

  defs.append(sky, turf, glow);
  s.append(defs);

  // ---- sky ----
  const skyRect = svg('rect');
  skyRect.setAttribute('width', '400');
  skyRect.setAttribute('height', String(HORIZON));
  skyRect.setAttribute('fill', `url(#${uid}-sky)`);
  s.append(skyRect);

  // ---- back stand: stepped concrete tiers, receding ----
  const tiers = 5;
  const tierH = 10.4;
  for (let i = 0; i < tiers; i++) {
    const top = 74 + i * tierH;
    const inset = 44 - i * 5;
    const tier = svg('rect');
    tier.setAttribute('x', String(inset));
    tier.setAttribute('y', String(top));
    tier.setAttribute('width', String(400 - inset * 2));
    tier.setAttribute('height', String(tierH));
    tier.setAttribute('fill', i % 2 === 0 ? art.stand : art.standDark);
    s.append(tier);

    // Crowd: a scatter of heads per tier.
    const heads = Math.round(44 * detail);
    for (let h = 0; h < heads; h++) {
      const dot = svg('circle');
      dot.setAttribute('cx', String(inset + 5 + rnd() * (400 - inset * 2 - 10)));
      dot.setAttribute('cy', String(top + 3.5 + rnd() * 5));
      dot.setAttribute('r', String(1.4 + rnd() * 0.9));
      dot.setAttribute('fill', art.crowd[Math.floor(rnd() * art.crowd.length)]);
      dot.setAttribute('opacity', String(0.55 + rnd() * 0.45));
      s.append(dot);
    }
  }

  // ---- floodlight towers with their light cones ----
  const towers: Array<[number, number]> = [
    [56, 1],
    [344, -1],
  ];
  for (const [x, dir] of towers) {
    const mast = svg('rect');
    mast.setAttribute('x', String(x - 2));
    mast.setAttribute('y', '44');
    mast.setAttribute('width', '4');
    mast.setAttribute('height', String(HORIZON - 44));
    mast.setAttribute('fill', art.standDark);
    s.append(mast);

    const bank = svg('rect');
    bank.setAttribute('x', String(x - 17));
    bank.setAttribute('y', '34');
    bank.setAttribute('width', '34');
    bank.setAttribute('height', '12');
    bank.setAttribute('rx', '2');
    bank.setAttribute('fill', art.standDark);
    s.append(bank);

    for (let l = 0; l < 4; l++) {
      const lamp = svg('circle');
      lamp.setAttribute('cx', String(x - 12 + l * 8));
      lamp.setAttribute('cy', '40');
      lamp.setAttribute('r', '2.6');
      lamp.setAttribute('fill', art.lamp);
      lamp.setAttribute('opacity', '0.95');
      s.append(lamp);
    }

    // The cone of light falling across the turf.
    const cone = svg('polygon');
    cone.setAttribute('points', `${x - 16},46 ${x + 16},46 ${x + dir * 104},178 ${x - dir * 44},178`);
    cone.setAttribute('fill', `url(#${uid}-glow)`);
    cone.setAttribute('opacity', '0.42');
    s.append(cone);

    const halo = svg('circle');
    halo.setAttribute('cx', String(x));
    halo.setAttribute('cy', '40');
    halo.setAttribute('r', '28');
    halo.setAttribute('fill', `url(#${uid}-glow)`);
    halo.setAttribute('opacity', '0.55');
    s.append(halo);
  }

  // ---- turf, in perspective ----
  const pitch = svg('polygon');
  pitch.setAttribute('points', `66,${HORIZON} 334,${HORIZON} 452,240 -52,240`);
  pitch.setAttribute('fill', `url(#${uid}-turf)`);
  s.append(pitch);

  // Mown stripes.
  const lerpY = (t: number) => HORIZON + t * (240 - HORIZON);
  const widthAt = (t: number) => 268 + t * 236;
  for (let i = 0; i < 6; i++) {
    const t0 = i / 6;
    const t1 = (i + 0.5) / 6;
    const stripe = svg('polygon');
    stripe.setAttribute(
      'points',
      `${200 - widthAt(t0) / 2},${lerpY(t0)} ${200 + widthAt(t0) / 2},${lerpY(t0)} ` +
        `${200 + widthAt(t1) / 2},${lerpY(t1)} ${200 - widthAt(t1) / 2},${lerpY(t1)}`,
    );
    stripe.setAttribute('fill', '#ffffff');
    stripe.setAttribute('opacity', '0.05');
    s.append(stripe);
  }

  // The far goal, with its net.
  const goalW = 46;
  const goal = svg('rect');
  goal.setAttribute('x', String(200 - goalW / 2));
  goal.setAttribute('y', String(HORIZON - 16));
  goal.setAttribute('width', String(goalW));
  goal.setAttribute('height', '16');
  goal.setAttribute('fill', 'none');
  goal.setAttribute('stroke', '#ffffff');
  goal.setAttribute('stroke-width', '1.6');
  goal.setAttribute('opacity', '0.9');
  s.append(goal);

  for (let gx = 1; gx < 6; gx++) {
    const line = svg('line');
    const gxp = 200 - goalW / 2 + (goalW / 6) * gx;
    line.setAttribute('x1', String(gxp));
    line.setAttribute('y1', String(HORIZON - 16));
    line.setAttribute('x2', String(gxp));
    line.setAttribute('y2', String(HORIZON));
    line.setAttribute('stroke', '#ffffff');
    line.setAttribute('stroke-width', '0.5');
    line.setAttribute('opacity', '0.45');
    s.append(line);
  }

  // Penalty box.
  const box = svg('polygon');
  box.setAttribute('points', `128,${HORIZON} 272,${HORIZON} 302,${HORIZON + 27} 98,${HORIZON + 27}`);
  box.setAttribute('fill', 'none');
  box.setAttribute('stroke', '#ffffff');
  box.setAttribute('stroke-width', '1.1');
  box.setAttribute('opacity', '0.5');
  s.append(box);

  // ---- weather ----
  if (kind === 'rain') {
    const drops = Math.round(70 * detail);
    for (let i = 0; i < drops; i++) {
      const x = rnd() * 400;
      const y = rnd() * 240;
      const drop = svg('line');
      drop.setAttribute('x1', String(x));
      drop.setAttribute('y1', String(y));
      drop.setAttribute('x2', String(x - 4));
      drop.setAttribute('y2', String(y + 13));
      drop.setAttribute('stroke', '#dff3ff');
      drop.setAttribute('stroke-width', '0.9');
      drop.setAttribute('opacity', String(0.2 + rnd() * 0.35));
      s.append(drop);
    }
  } else if (kind === 'ice') {
    const flakes = Math.round(60 * detail);
    for (let i = 0; i < flakes; i++) {
      const flake = svg('circle');
      flake.setAttribute('cx', String(rnd() * 400));
      flake.setAttribute('cy', String(rnd() * 240));
      flake.setAttribute('r', String(0.9 + rnd() * 1.6));
      flake.setAttribute('fill', '#ffffff');
      flake.setAttribute('opacity', String(0.35 + rnd() * 0.5));
      s.append(flake);
    }
  } else if (kind === 'sun') {
    const sun = svg('circle');
    sun.setAttribute('cx', '318');
    sun.setAttribute('cy', '52');
    sun.setAttribute('r', '18');
    sun.setAttribute('fill', '#fff6c9');
    sun.setAttribute('opacity', '0.9');
    s.append(sun);
  }

  return s;
}

/** Difficulty 1–5, derived from how much the conditions slow the game down. */
function venueDifficulty(kind: WeatherKind): number {
  const m = WEATHERS[kind].mods;
  const d = 1 - (m.accel + m.turnRate + m.maxSpeed) / 3;
  return Math.max(1, Math.min(5, Math.round(1 + d * 18)));
}

function difficultyMeter(stars: number): HTMLElement {
  const wrap = el('div', 'diff-meter');
  wrap.append(el('span', 'diff-k', 'Difficulty'));
  const pips = el('div', 'diff-pips');
  for (let i = 0; i < 5; i++) {
    pips.append(el('span', `diff-pip${i < stars ? ' on' : ''}`));
  }
  wrap.append(pips);
  return wrap;
}

export function renderWeather(
  root: HTMLElement,
  opts: { value: WeatherKind; onPick: (k: WeatherKind) => void; onNext: () => void; onBack: () => void },
): void {
  clear(root);
  const wrap = el('div', 'screen squad-screen venue-screen');
  const head = screenHead(
    'Choose Your Venue',
    'Four grounds, four different games. The weather decides the bounce, the grip and the tempo.',
    opts.onBack,
  );

  // ---- the featured stadium ----
  const stage = el('div', 'venue-stage');
  const scene = el('div', 'venue-scene');
  scene.append(venueScene(opts.value, 1));

  const w = WEATHERS[opts.value];
  const v = VENUES[opts.value];
  const plate = el('div', 'venue-plate');
  const plateText = el('div', 'venue-plate-text');
  plateText.append(
    el('div', 'venue-city', v.city),
    el('div', 'venue-name', v.name),
    el('div', 'venue-blurb', w.blurb),
  );
  const meta = el('div', 'venue-meta');
  meta.append(
    el('span', `venue-chip cond-${opts.value}`, `${WEATHER_ICON[opts.value]} ${w.name}`),
    el('span', 'venue-chip', w.tag),
  );
  plateText.append(meta);
  plate.append(plateText, difficultyMeter(venueDifficulty(opts.value)));
  scene.append(plate);
  stage.append(scene);

  // ---- the rail of grounds ----
  const rail = el('div', 'venue-rail');
  for (const k of WEATHER_ORDER) {
    const card = el('button', `venue-thumb${opts.value === k ? ' active' : ''}`);
    const thumbScene = el('div', 'venue-thumb-scene');
    thumbScene.append(venueScene(k, 0.35));
    card.append(
      thumbScene,
      el('span', 'venue-thumb-name', VENUES[k].name),
      el('span', `venue-thumb-cond cond-${k}`, WEATHERS[k].tag),
    );
    on(card, 'click', () => opts.onPick(k));
    rail.append(card);
  }

  const actions = el('div', 'flow-actions');
  const next = el('button', 'primary-btn', 'Kick Off Here');
  on(next, 'click', opts.onNext);
  actions.append(next);

  wrap.append(head, stage, rail, el('div', 'flow-footer', ''), actions);
  root.append(wrap);
}

/* ------------------------------------------------------------------ */
/* 5. Match length                                                     */
/* ------------------------------------------------------------------ */

export const LENGTH_OPTIONS: Array<{ halfSeconds: number; label: string; sub: string }> = [
  { halfSeconds: 60, label: '2 Min', sub: 'Quick blast' },
  { halfSeconds: 90, label: '3 Min', sub: 'Standard' },
  { halfSeconds: 150, label: '5 Min', sub: 'Full contest' },
];

export function renderMinutes(
  root: HTMLElement,
  opts: { value: number; onPick: (s: number) => void; onNext: () => void; onBack: () => void },
): void {
  clear(root);
  const wrap = el('div', 'screen squad-screen');
  const head = screenHead('Match Length', 'How long is the match?', opts.onBack);

  const row = el('div', 'choice-row length-row');
  for (const o of LENGTH_OPTIONS) {
    const b = el('button', `choice-btn${opts.value === o.halfSeconds ? ' active' : ''}`);
    b.append(el('span', 'choice-label', o.label), el('span', 'choice-hint', o.sub));
    on(b, 'click', () => opts.onPick(o.halfSeconds));
    row.append(b);
  }

  const actions = el('div', 'flow-actions');
  const next = el('button', 'primary-btn', 'Next');
  on(next, 'click', opts.onNext);
  actions.append(next);

  wrap.append(head, row, el('div', 'flow-footer', ''), actions);
  root.append(wrap);
}

/* ------------------------------------------------------------------ */
/* 6. Opponent reveal                                                  */
/* ------------------------------------------------------------------ */

export function renderOpponent(
  root: HTMLElement,
  opts: {
    playerIds: string[];
    opponent: OpponentSelection;
    weather: WeatherKind;
    halfSeconds: number;
    /** Set when the match is a league fixture rather than a friendly. */
    fixture?: { round: number; home: boolean; season: number } | null;
    onKickoff: () => void;
    onBack: () => void;
  },
): void {
  clear(root);
  const wrap = el('div', 'screen squad-screen');
  const f = opts.fixture;
  const head = screenHead(
    'Your Opponent',
    f
      ? `Season ${f.season} · Round ${f.round} · ${f.home ? 'at home' : 'away'}`
      : 'Matched to your squad rating — an even fight.',
    opts.onBack,
  );

  const vs = el('div', 'vs-row');

  const makeSide = (name: string, short: string, ids: string[], color: number, overall: number) => {
    const side = el('div', 'vs-side');
    side.style.setProperty('--accent', hex(color));
    const badge = el('div', 'vs-badge', short);
    badge.style.background = hex(color);
    side.append(badge, el('div', 'vs-name', name), el('div', 'vs-ovr', `OVR ${overall}`));
    const avatars = el('div', 'vs-avatars');
    for (const id of ids) {
      const v = ROSTER_BY_ID[id];
      if (v) avatars.append(viberAvatar(v, 0.62));
    }
    side.append(avatars);
    return side;
  };

  vs.append(
    makeSide(PLAYER_CLUB.name, PLAYER_CLUB.short, opts.playerIds, PLAYER_CLUB.color, teamOverall(opts.playerIds)),
    el('div', 'vs-mid', 'VS'),
    makeSide(opts.opponent.club.name, opts.opponent.club.short, opts.opponent.ids, opts.opponent.club.color, opts.opponent.overall),
  );

  const conditions = el('div', 'conditions-strip');
  conditions.append(
    el('span', 'cond', `${WEATHER_ICON[opts.weather]} ${VENUES[opts.weather].name}`),
    el('span', 'cond', `${WEATHERS[opts.weather].name}`),
    el('span', 'cond', `${(opts.halfSeconds * 2) / 60} min`),
  );

  const actions = el('div', 'flow-actions');
  const go = el('button', 'primary-btn', 'Kick Off');
  on(go, 'click', opts.onKickoff);
  actions.append(go);

  wrap.append(head, vs, conditions, actions);
  root.append(wrap);
}

/* ------------------------------------------------------------------ */
/* 7. Half-time                                                        */
/* ------------------------------------------------------------------ */

export function renderHalftime(
  root: HTMLElement,
  world: World,
  onContinue: (m: Mentality) => void,
): void {
  clear(root);
  const wrap = el('div', 'screen overlay-screen');

  const panel = el('div', 'panel');
  panel.append(el('h2', 'panel-title', 'Half-Time'));

  const score = el('div', 'big-score');
  score.textContent = `${world.teams[0].short}  ${world.teams[0].score} - ${world.teams[1].score}  ${world.teams[1].short}`;
  panel.append(score);

  panel.append(el('p', 'panel-sub', 'How do you want to play the second half?'));

  const row = el('div', 'choice-row');
  const choices: Array<{ id: Mentality; label: string; hint: string }> = [
    { id: 'attack', label: 'Attack', hint: 'Push for a winner' },
    { id: 'balanced', label: 'Balanced', hint: 'Stay in control' },
    { id: 'defend', label: 'Defend', hint: 'Protect the score' },
    { id: 'counter', label: 'Counter', hint: 'Hit them on the break' },
  ];
  for (const c of choices) {
    const b = el('button', 'choice-btn');
    b.append(el('span', 'choice-label', c.label), el('span', 'choice-hint', c.hint));
    on(b, 'click', () => onContinue(c.id));
    row.append(b);
  }
  panel.append(row);
  wrap.append(panel);
  root.append(wrap);
}

/* ------------------------------------------------------------------ */
/* 8. Defend a penalty                                                 */
/* ------------------------------------------------------------------ */

/**
 * The human must commit before the opponent shoots. Left and right are from
 * the keeper's camera view, so the buttons map directly to what is on screen.
 */
export function renderPenaltyDive(
  root: HTMLElement,
  world: World,
  onDive: (direction: DiveDirection) => void,
): void {
  clear(root);
  const wrap = el('div', 'screen overlay-screen penalty-screen');
  const panel = el('div', 'panel penalty-panel');
  panel.append(el('h2', 'panel-title', 'Defend the Penalty'));
  panel.append(el('p', 'panel-sub',
    `${world.teams[1].name} are stepping up. Pick a direction for your keeper before the kick.`));

  const row = el('div', 'choice-row dive-row');
  const choices: Array<{ id: DiveDirection; label: string; hint: string }> = [
    { id: 'left', label: '← Left', hint: 'Cover the left corner' },
    { id: 'centre', label: '↓ Centre', hint: 'Hold your ground' },
    { id: 'right', label: 'Right →', hint: 'Cover the right corner' },
  ];
  for (const c of choices) {
    const b = el('button', 'choice-btn dive-btn');
    b.type = 'button';
    b.append(el('span', 'choice-label', c.label), el('span', 'choice-hint', c.hint));
    on(b, 'click', () => onDive(c.id));
    row.append(b);
  }
  panel.append(row, el('p', 'penalty-hint', 'Watch the keeper dive — a correct read can catch the shot.'));
  wrap.append(panel);
  root.append(wrap);
}

/* ------------------------------------------------------------------ */
/* 9. Full-time                                                        */
/* ------------------------------------------------------------------ */

export function renderResult(
  root: HTMLElement,
  world: World,
  onPlayAgain: () => void,
  onChangeSquad: () => void,
  opts?: { againLabel?: string; changeLabel?: string; note?: string },
): void {
  clear(root);
  const [home, away] = world.teams;
  const wrap = el('div', 'screen overlay-screen');
  const panel = el('div', 'panel');

  const outcome = home.score > away.score ? 'Win' : home.score < away.score ? 'Defeat' : 'Draw';
  panel.append(el('h2', `panel-title ${outcome.toLowerCase()}`, outcome));

  const score = el('div', 'big-score');
  score.textContent = `${home.short}  ${home.score} - ${away.score}  ${away.short}`;
  panel.append(score);

  // Where this leaves the season, when the match came from the league.
  if (opts?.note) panel.append(el('p', 'result-note', opts.note));

  const stats = el('div', 'stats-table');
  const possTotal = Math.max(1, world.stats.possession[0] + world.stats.possession[1]);
  const possHome = Math.round((world.stats.possession[0] / possTotal) * 100);
  const rows: Array<[string, string, string]> = [
    ['Possession', `${possHome}%`, `${100 - possHome}%`],
    ['Shots', `${world.stats.shots[0]}`, `${world.stats.shots[1]}`],
    ['Passes', `${world.stats.passes[0]}`, `${world.stats.passes[1]}`],
    ['Corners', `${world.stats.corners[0]}`, `${world.stats.corners[1]}`],
    ['Fouls', `${world.stats.fouls[0]}`, `${world.stats.fouls[1]}`],
    ['Tackles', `${world.stats.tackles[0]}`, `${world.stats.tackles[1]}`],
  ];
  const head = el('div', 'stats-row head');
  head.append(el('span', '', home.short), el('span', '', 'Match stats'), el('span', '', away.short));
  stats.append(head);
  for (const [label, h, a] of rows) {
    const r = el('div', 'stats-row');
    r.append(el('span', 'v', h), el('span', 'k', label), el('span', 'v', a));
    stats.append(r);
  }
  panel.append(stats);

  const again = el('button', 'primary-btn', opts?.againLabel ?? 'Play Again');
  on(again, 'click', onPlayAgain);
  panel.append(again);

  const change = el('button', 'ghost-btn wide', opts?.changeLabel ?? 'Change Squad');
  on(change, 'click', onChangeSquad);
  panel.append(change);

  wrap.append(panel);
  root.append(wrap);
}

/* ================================================================== */
/* The club sections — LEAGUE / SQUAD / PLAYERS / CAREER / SETTINGS    */
/* ================================================================== */
/* These are the five tiles on the main menu. Each one is a real screen
   reading real state: the league table is built from results, the squad is
   the five that will actually take the pitch, and the career is the record
   those matches leave behind. */

/* ---- shared furniture ---- */

/** A club's badge: its short name in its own colour inside a black frame. */
function clubCrest(clubId: string, size: 'sm' | 'md' = 'sm'): HTMLElement {
  const club = CLUBS[clubId];
  const b = el('span', `club-crest ${size}`, club ? clubShort(clubId) : '???');
  if (club) {
    b.style.background = hex(club.color);
    // The palette runs from olive to violet; no single text colour reads on all
    // of it, so the badge picks its own from the fill's luminance.
    const r = (club.color >> 16) & 255;
    const g = (club.color >> 8) & 255;
    const bl = club.color & 255;
    const lum = (0.299 * r + 0.587 * g + 0.114 * bl) / 255;
    b.style.color = lum > 0.6 ? '#0c0f08' : '#f6f2e6';
  }
  if (clubId === PLAYER_CLUB_ID) b.classList.add('you');
  return b;
}

function statCell(label: string, value: string | number, hint?: string): HTMLElement {
  const c = el('div', 'stat-cell');
  c.append(el('div', 'stat-num', String(value)), el('div', 'stat-label', label));
  if (hint) c.append(el('div', 'stat-hint', hint));
  return c;
}

/** The last few results as W/D/L pills, oldest first. */
function formPills(form: FormEntry[], empty = 'No matches played yet'): HTMLElement {
  const wrap = el('div', 'form-pills');
  if (!form.length) {
    wrap.append(el('span', 'form-empty', empty));
    return wrap;
  }
  for (const f of form) {
    const pill = el('span', `form-pill ${f.outcome.toLowerCase()}`);
    pill.textContent = f.outcome;
    pill.title = `${f.outcome} ${f.gf}-${f.ga} vs ${clubName(f.opponentId)}`;
    wrap.append(pill);
  }
  return wrap;
}

/** A titled group of rows, used by the settings screen. */
function settingsGroup(title: string, rows: HTMLElement[]): HTMLElement {
  const group = el('section', 'settings-group');
  group.append(el('h2', 'settings-group-title', title));
  for (const r of rows) group.append(r);
  return group;
}

/** One settings row: a label on the left, a control on the right. */
function settingRow(label: string, help: string, control: HTMLElement): HTMLElement {
  const row = el('div', 'setting-row');
  const text = el('div', 'setting-text');
  text.append(el('div', 'setting-label', label), el('div', 'setting-help', help));
  row.append(text, control);
  return row;
}

/**
 * A segmented control — the right shape for "pick one of a few", which is what
 * almost every setting is. Buttons, not a `<select>`: it stays in the same
 * chunky visual language as the rest of the game.
 */
function segment<T extends string | number>(
  options: Array<{ value: T; label: string }>,
  current: T,
  onPick: (v: T) => void,
): HTMLElement {
  const seg = el('div', 'seg');
  for (const o of options) {
    const b = el('button', `seg-btn${o.value === current ? ' active' : ''}`, o.label);
    b.setAttribute('aria-pressed', String(o.value === current));
    on(b, 'click', () => onPick(o.value));
    seg.append(b);
  }
  return seg;
}

/* ------------------------------------------------------------------ */
/* LEAGUE — the season table and the fixture list                      */
/* ------------------------------------------------------------------ */

export type LeagueTab = 'table' | 'fixtures';

export interface LeagueOpts {
  season: number;
  /** Every result so far this season, including the simulated CPU fixtures. */
  results: ResultMap;
  /** The five that would take the pitch right now, for the squad rating. */
  lineup: string[];
  tab: LeagueTab;
  onTab: (t: LeagueTab) => void;
  onPlayNext: () => void;
  onNextSeason: () => void;
  onBack: () => void;
}

export function renderLeague(root: HTMLElement, opts: LeagueOpts): void {
  clear(root);
  const wrap = el('div', 'screen squad-screen league-screen');
  const table = buildTable(opts.results);
  const position = playerPosition(table);
  const row = playerRow(table);
  const fixtures = playerFixtures();
  const played = fixtures.filter((f) => opts.results[f.id]).length;
  const done = played === fixtures.length;

  const head = screenHead(
    'League',
    `Season ${opts.season} · ${LEAGUE_CLUB_IDS.length} clubs · ${played} of ${fixtures.length} played`,
    opts.onBack,
    el('span', 'league-pos', position ? `${ordinal(position)}` : '—'),
  );

  const tabs = el('div', 'chip-row');
  for (const t of ['table', 'fixtures'] as LeagueTab[]) {
    const b = el('button', `chip${opts.tab === t ? ' active' : ''}`, t === 'table' ? 'Table' : 'Fixtures');
    on(b, 'click', () => opts.onTab(t));
    tabs.append(b);
  }

  const body = opts.tab === 'table' ? leagueTable(table) : leagueFixtures(fixtures, opts.results);

  // What the player's five are actually worth, and what that buys them.
  const ovr = teamOverall(opts.lineup);
  const note = el('p', 'section-note');
  note.textContent = row
    ? `Your five rate OVR ${ovr}. ${row.played} played, ${row.points} points, ${row.gd >= 0 ? '+' : ''}${row.gd} goal difference.`
    : `Your five rate OVR ${ovr}. Pick a squad to get started.`;

  const actions = el('div', 'flow-actions');
  if (done) {
    const next = el('button', 'primary-btn', `Start Season ${opts.season + 1}`);
    on(next, 'click', opts.onNextSeason);
    actions.append(next);
  } else {
    const next = el('button', 'primary-btn', 'Play Next Match');
    next.disabled = opts.lineup.length !== 5;
    if (next.disabled) next.classList.add('disabled');
    on(next, 'click', opts.onPlayNext);
    actions.append(next);
  }

  wrap.append(head, tabs, body, note, actions);
  root.append(wrap);
}

function leagueTable(table: TableRow[]): HTMLElement {
  const box = el('div', 'league-table');
  const head = el('div', 'lt-row lt-head');
  head.append(
    el('span', 'lt-pos', '#'),
    el('span', 'lt-club', 'Club'),
    el('span', 'lt-num', 'P'),
    el('span', 'lt-num', 'W'),
    el('span', 'lt-num', 'D'),
    el('span', 'lt-num', 'L'),
    el('span', 'lt-num', 'GD'),
    el('span', 'lt-num lt-pts', 'Pts'),
  );
  box.append(head);

  table.forEach((r, i) => {
    const row = el('div', `lt-row${r.clubId === PLAYER_CLUB_ID ? ' lt-you' : ''}`);
    row.append(
      el('span', 'lt-pos', String(i + 1)),
      (() => {
        const club = el('span', 'lt-club');
        club.append(clubCrest(r.clubId), el('span', 'lt-name', clubName(r.clubId)));
        return club;
      })(),
      el('span', 'lt-num', String(r.played)),
      el('span', 'lt-num', String(r.won)),
      el('span', 'lt-num', String(r.drawn)),
      el('span', 'lt-num', String(r.lost)),
      el('span', 'lt-num', `${r.gd >= 0 ? '+' : ''}${r.gd}`),
      el('span', 'lt-num lt-pts', String(r.points)),
    );
    box.append(row);
  });
  return box;
}

function leagueFixtures(
  fixtures: ReturnType<typeof playerFixtures>,
  results: ResultMap,
): HTMLElement {
  const list = el('div', 'fixture-list');
  // The next unplayed fixture is the one the PLAY button will play, so it is
  // marked rather than left for the player to work out.
  const nextId = fixtures.find((f) => !results[f.id])?.id;

  for (const f of fixtures) {
    const r = results[f.id];
    const home = isHomeFixture(f);
    const opponent = opponentOf(f);
    const cls = ['fixture-row'];
    if (f.id === nextId) cls.push('next');
    if (r) cls.push('played');

    const row = el('div', cls.join(' '));
    row.append(
      el('span', 'fx-round', `R${f.round + 1}`),
      el('span', `fx-venue ${home ? 'home' : 'away'}`, home ? 'H' : 'A'),
      clubCrest(opponent, 'md'),
      el('span', 'fx-name', clubName(opponent)),
      (() => {
        const score = el('span', 'fx-score');
        if (!r) {
          score.textContent = f.id === nextId ? 'Next' : '—';
          if (f.id === nextId) score.classList.add('is-next');
          return score;
        }
        const gf = home ? r.home : r.away;
        const ga = home ? r.away : r.home;
        score.textContent = `${gf} - ${ga}`;
        score.classList.add(gf > ga ? 'win' : gf === ga ? 'draw' : 'loss');
        return score;
      })(),
    );
    list.append(row);
  }
  return list;
}

/** 1 → "1st", 2 → "2nd", 11 → "11th". Shared with the result screen. */
export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

/* ------------------------------------------------------------------ */
/* SQUAD — the five, in the shape they will play                       */
/* ------------------------------------------------------------------ */

export interface SquadViewOpts {
  lineup: string[];
  onChange: () => void;
  onOpen: (id: string) => void;
  onBack: () => void;
}

/** The formation slots, in the order the sim fills them. */
const PITCH_SLOTS: Array<{ role: ViberRole; label: string }> = [
  { role: 'GK', label: 'Goalkeeper' },
  { role: 'DEF', label: 'Defender' },
  { role: 'MID', label: 'Midfield' },
  { role: 'MID', label: 'Midfield' },
  { role: 'FWD', label: 'Forward' },
];

export function renderSquadView(root: HTMLElement, opts: SquadViewOpts): void {
  clear(root);
  const wrap = el('div', 'screen squad-screen squad-view');

  const ovr = teamOverall(opts.lineup);
  const head = screenHead(
    'Squad',
    'The five that take the pitch. Change them here and every match uses them.',
    opts.onBack,
    el('span', 'ovr-chip', `OVR ${ovr}`),
  );

  const pitch = el('div', 'squad-pitch');
  PITCH_SLOTS.forEach((slot, i) => {
    const id = opts.lineup[i];
    const v = id ? ROSTER_BY_ID[id] : undefined;
    const cell = el('div', `squad-slot slot-${slot.role.toLowerCase()}`);
    cell.append(el('span', 'squad-slot-role', slot.role));

    if (!v) {
      const empty = el('button', 'squad-empty');
      empty.append(el('span', 'squad-empty-plus', '+'), el('span', '', 'Empty'));
      on(empty, 'click', opts.onChange);
      cell.append(empty);
      pitch.append(cell);
      return;
    }

    const card = el('button', `squad-card role-${v.role}`);
    card.append(
      el('span', 'ovr-badge', String(overallOf(v))),
      viberAvatar(v, 0.72),
      el('span', 'squad-card-name', v.name),
      el('span', 'squad-card-epithet', v.epithet),
    );
    on(card, 'click', () => opts.onOpen(v.id));
    cell.append(card);
    pitch.append(cell);
  });

  // What the five are made of. A squad with no natural defender is a real
  // problem in this game, and nothing else on screen would say so.
  const counts = { GK: 0, DEF: 0, MID: 0, FWD: 0 } as Record<ViberRole, number>;
  for (const id of opts.lineup) {
    const v = ROSTER_BY_ID[id];
    if (v) counts[v.role]++;
  }
  const balance = el('div', 'squad-balance');
  for (const role of ['GK', 'DEF', 'MID', 'FWD'] as ViberRole[]) {
    const n = counts[role];
    const pill = el('span', `balance-pill role-${role}${n ? '' : ' empty'}`, `${role} ${n}`);
    balance.append(pill);
  }
  const slotsFilled = opts.lineup.length;
  const warn = el('p', 'section-note');
  warn.textContent =
    slotsFilled === 5
      ? `${PLAYER_CLUB.name} · Diamond formation · average rating ${ovr}.`
      : `${slotsFilled} of 5 places filled — matches need a full five.`;

  const actions = el('div', 'flow-actions');
  const change = el('button', 'primary-btn', slotsFilled === 5 ? 'Change Squad' : 'Pick Your Five');
  on(change, 'click', opts.onChange);
  actions.append(change);

  wrap.append(head, pitch, balance, warn, actions);
  root.append(wrap);
}

/* ------------------------------------------------------------------ */
/* PLAYERS — every Viber in the game, as a library                     */
/* ------------------------------------------------------------------ */

export type PlayerSort = 'rating' | 'name' | 'role';

export interface PlayersOpts {
  filter: RoleFilter;
  sort: PlayerSort;
  /** Ids already in the saved five, so the cards can show it. */
  lineup: string[];
  onFilter: (f: RoleFilter) => void;
  onSort: (s: PlayerSort) => void;
  onCard: (id: string) => void;
  onToggle: (id: string) => void;
  onBack: () => void;
}

export function renderPlayers(root: HTMLElement, opts: PlayersOpts): void {
  clear(root);
  const wrap = el('div', 'screen squad-screen hero-select players-screen');

  const head = screenHead(
    'Players',
    `All ${ROSTER.length} Vibers. Tap one to read their card, or add them to your five.`,
    opts.onBack,
    progressRing(opts.lineup.length),
  );

  const chips = el('div', 'chip-row');
  for (const f of FILTERS) {
    const n = f === 'ALL' ? ROSTER.length : ROSTER.filter((v) => v.role === f).length;
    const b = el('button', `chip${opts.filter === f ? ' active' : ''}`);
    b.append(el('span', '', f === 'ALL' ? 'All' : f), el('span', 'chip-n', String(n)));
    on(b, 'click', () => opts.onFilter(f));
    chips.append(b);
  }

  const sorts = el('div', 'chip-row sort-row');
  for (const s of [
    { id: 'rating' as PlayerSort, label: 'By Rating' },
    { id: 'name' as PlayerSort, label: 'By Name' },
    { id: 'role' as PlayerSort, label: 'By Role' },
  ]) {
    const b = el('button', `chip${opts.sort === s.id ? ' active' : ''}`, s.label);
    on(b, 'click', () => opts.onSort(s.id));
    sorts.append(b);
  }

  const shown = ROSTER.filter((v) => opts.filter === 'ALL' || v.role === opts.filter);
  shown.sort((a, b) => {
    if (opts.sort === 'name') return a.name.localeCompare(b.name);
    if (opts.sort === 'role') {
      return ROLE_SORT[a.role] - ROLE_SORT[b.role] || overallOf(b) - overallOf(a);
    }
    return overallOf(b) - overallOf(a);
  });

  const grid = el('div', 'viber-grid');
  const canAdd = opts.lineup.length < 5;
  shown.forEach((v, i) => {
    const idx = opts.lineup.indexOf(v.id);
    grid.append(
      cardSlot(v, {
        selected: idx >= 0,
        index: idx,
        order: i,
        canAdd,
        onOpen: () => opts.onCard(v.id),
        onToggle: () => opts.onToggle(v.id),
      }),
    );
  });

  const actions = el('div', 'flow-actions');
  const done = el('button', 'primary-btn', 'Done');
  on(done, 'click', opts.onBack);
  actions.append(done);

  const body = el('div', 'hero-body');
  body.append(chips, sorts, grid);

  const footer = el('div', 'flow-footer');
  footer.append(actions);

  wrap.append(head, el('div', 'hero-stage'), body, footer);
  root.append(wrap);
}

const ROLE_SORT: Record<ViberRole, number> = { GK: 0, DEF: 1, MID: 2, FWD: 3 };

/* ------------------------------------------------------------------ */
/* CAREER — the manager's record                                       */
/* ------------------------------------------------------------------ */

export interface CareerOpts {
  manager: string;
  club: string;
  season: number;
  /** The season in progress. Completed seasons live in `history`. */
  current: ResultMap;
  history: SeasonSummary[];
  lineup: string[];
  onBack: () => void;
}

export function renderCareer(root: HTMLElement, opts: CareerOpts): void {
  clear(root);
  const wrap = el('div', 'screen squad-screen career-screen');

  const totals = lifetimeTotals(opts.history, opts.current);
  const form = recentForm(opts.current, 5);
  const head = screenHead(
    'Career',
    `${opts.manager} · ${opts.club} · Season ${opts.season}`,
    opts.onBack,
  );

  const grid = el('div', 'stat-grid');
  grid.append(
    statCell('Played', totals.played),
    statCell('Won', totals.won),
    statCell('Drawn', totals.drawn),
    statCell('Lost', totals.lost),
    statCell('Win rate', `${totals.winPct}%`),
    statCell('Goals for', totals.gf),
    statCell('Goals against', totals.ga),
    statCell('Difference', `${totals.gf - totals.ga >= 0 ? '+' : ''}${totals.gf - totals.ga}`),
  );

  const formPanel = el('section', 'panel career-panel');
  formPanel.append(
    el('h2', 'panel-title', 'Current Form'),
    formPills(form),
    el(
      'p',
      'panel-sub',
      form.length
        ? 'Your last five results this season, oldest first.'
        : 'Play a league match and your form appears here.',
    ),
  );

  const bestPanel = el('section', 'panel career-panel');
  bestPanel.append(el('h2', 'panel-title', 'Best Result'));
  if (totals.best && totals.best.margin > 0) {
    bestPanel.append(
      el('div', 'best-score', `${totals.best.gf} - ${totals.best.ga}`),
      el('p', 'panel-sub', `against ${clubName(totals.best.opponentId)}`),
    );
  } else {
    bestPanel.append(el('p', 'panel-sub', 'No win on the board yet.'));
  }

  const historyPanel = el('section', 'panel career-panel');
  historyPanel.append(el('h2', 'panel-title', 'Season History'));
  if (!opts.history.length) {
    historyPanel.append(
      el('p', 'panel-sub', 'No completed seasons yet. Finish all 12 league matches to file one.'),
    );
  } else {
    const list = el('div', 'history-list');
    for (const s of opts.history) {
      const row = el('div', 'history-row');
      row.append(
        el('span', 'history-season', `S${s.season}`),
        el('span', 'history-pos', ordinal(s.position)),
        el('span', 'history-record', `${s.won}W ${s.drawn}D ${s.lost}L`),
        el('span', 'history-pts', `${s.points} pts`),
      );
      if (s.champion === PLAYER_CLUB_ID) row.classList.add('champion');
      list.append(row);
    }
    historyPanel.append(list);
  }

  const squad = el('p', 'section-note');
  squad.textContent = `Squad rating OVR ${teamOverall(opts.lineup)} · ${opts.history.length} season${opts.history.length === 1 ? '' : 's'} completed.`;

  wrap.append(head, grid, formPanel, bestPanel, historyPanel, squad);
  root.append(wrap);
}

/* ------------------------------------------------------------------ */
/* SETTINGS                                                            */
/* ------------------------------------------------------------------ */

export interface SettingsOpts {
  halfSeconds: number;
  weather: WeatherKind | 'random';
  reducedMotion: boolean;
  /** Reduced motion is also being asked for by the operating system. */
  systemReducedMotion: boolean;
  sound: boolean;
  season: number;
  manager: string;
  club: string;
  onHalfSeconds: (s: number) => void;
  onWeather: (w: WeatherKind | 'random') => void;
  onReducedMotion: (v: boolean) => void;
  onSound: (v: boolean) => void;
  onResetSquad: () => void;
  onResetCareer: () => void;
  onBack: () => void;
}

export function renderSettings(root: HTMLElement, opts: SettingsOpts): void {
  clear(root);
  const wrap = el('div', 'screen squad-screen settings-screen');
  const head = screenHead('Settings', 'Saved on this device, alongside your club.', opts.onBack);

  const match = settingsGroup('Match', [
    settingRow(
      'Match length',
      'How long each half runs. Shorter matches suit quick sessions.',
      segment(
        LENGTH_OPTIONS.map((o) => ({ value: o.halfSeconds, label: o.label })),
        opts.halfSeconds,
        opts.onHalfSeconds,
      ),
    ),
    settingRow(
      'Pitch conditions',
      'Leave it on Random and every fixture gets its own weather.',
      segment<WeatherKind | 'random'>(
        [
          ...WEATHER_ORDER.map((k) => ({ value: k as WeatherKind | 'random', label: WEATHERS[k].name })),
          { value: 'random', label: 'RANDOM' },
        ],
        opts.weather,
        opts.onWeather,
      ),
    ),
  ]);

  const access = settingsGroup('Accessibility', [
    settingRow(
      'Reduced motion',
      opts.systemReducedMotion
        ? 'Your device already asks for this, so animations are already off.'
        : 'Stops the menus drifting and the cards flying in.',
      segment(
        [
          { value: 'off', label: 'Off' },
          { value: 'on', label: 'On' },
        ],
        opts.reducedMotion ? 'on' : 'off',
        (v) => opts.onReducedMotion(v === 'on'),
      ),
    ),
  ]);

  const audio = settingsGroup('Sound', [
    settingRow(
      'Crowd & whistle',
      'The referee, the roar when you score and the noise of the ground.',
      segment(
        [
          { value: 'off', label: 'Off' },
          { value: 'on', label: 'On' },
        ],
        opts.sound ? 'on' : 'off',
        (v) => opts.onSound(v === 'on'),
      ),
    ),
  ]);

  const resetSquad = el('button', 'ghost-btn', 'Clear Squad');
  on(resetSquad, 'click', opts.onResetSquad);

  const resetCareer = el('button', 'ghost-btn danger', 'Erase Career');
  // Two taps: the first arms it, the second does it. There is no undo, and the
  // button says so before it is live rather than after.
  let armed = false;
  on(resetCareer, 'click', () => {
    if (!armed) {
      armed = true;
      resetCareer.textContent = 'Erase career — tap again';
      resetCareer.classList.add('armed');
      return;
    }
    opts.onResetCareer();
  });

  const data = settingsGroup('Your Data', [
    settingRow(
      'Squad',
      'Forgets your five. The league and your record are untouched.',
      resetSquad,
    ),
    settingRow(
      'Career',
      `Erases every result and starts Season 1 again. ${opts.manager} and ${opts.club} stay.`,
      resetCareer,
    ),
  ]);

  const info = el('div', 'settings-info');
  info.append(
    el('div', 'settings-info-row', `Manager ${opts.manager}`),
    el('div', 'settings-info-row', `Club ${opts.club}`),
    el('div', 'settings-info-row', `Season ${opts.season}`),
    el('div', 'settings-info-row', 'Stored on this device only'),
  );

  wrap.append(head, match, audio, access, data, info);
  root.append(wrap);
}
