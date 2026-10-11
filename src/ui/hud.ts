// ui/hud.ts — in-match overlay: scoreboard, clock, tactical controls (spec §5.2, §15).

import { clear, el, on } from './dom';
import type { Mentality, SetPieceKind, World } from '../sim/types';
import { WEATHERS } from '../sim/weather';
import { SPECIAL_COOLDOWN } from '../sim/constants';

export interface HudCallbacks {
  onMentality: (m: Mentality) => void;
  onSpecial: () => void;
  onAction: (a: 'shoot' | 'pass' | 'clear') => void;
  onPause: () => void;
  /** The player asked for sound on/off from inside the match. */
  onSound: (on: boolean) => void;
}

const MENTALITIES: Array<{ id: Mentality; label: string }> = [
  { id: 'attack', label: 'Attack' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'defend', label: 'Defend' },
  { id: 'counter', label: 'Counter' },
];

const SETPIECE_LABEL: Record<SetPieceKind, string> = {
  throwin: 'THROW-IN',
  corner: 'CORNER',
  goalkick: 'GOAL KICK',
  freekick: 'FREE KICK',
  penalty: 'PENALTY',
};

function displayMinute(w: World): string {
  const perHalf = w.halfSeconds;
  if (w.half === 1) {
    return `${Math.min(45, Math.floor((w.clock / perHalf) * 45))}'`;
  }
  const m = 45 + Math.min(45, Math.floor(((w.clock - perHalf) / perHalf) * 45));
  return `${m}'`;
}

/**
 * The match length, for the conditions strip.
 *
 * Every offered length is a whole number of minutes, but `halfSeconds` is just a
 * positive number as far as the career is concerned — a hand-edited save or the
 * dev harness can put anything in it, and `(2 * 2) / 60` rendered as
 * `0.06666666666666667min` on screen. One decimal is enough for any value.
 */
function displayLength(halfSeconds: number): string {
  const minutes = (halfSeconds * 2) / 60;
  if (!Number.isFinite(minutes) || minutes <= 0) return '--';
  return Number.isInteger(minutes) ? `${minutes}min` : `${minutes.toFixed(1)}min`;
}

export class Hud {
  private root: HTMLElement;
  private hudEl!: HTMLElement;
  private cb: HudCallbacks;
  private homeEl!: HTMLElement;
  private awayEl!: HTMLElement;
  private scoreEl!: HTMLElement;
  private clockEl!: HTMLElement;
  private halfEl!: HTMLElement;
  private condEl!: HTMLElement;
  private possBar!: HTMLElement;
  private banner!: HTMLElement;
  private setPieceEl!: HTMLElement;
  private mentalityBtns = new Map<Mentality, HTMLButtonElement>();
  private actionRow!: HTMLElement;
  private specialBtn!: HTMLButtonElement;
  private specialCharge!: HTMLElement;
  private specialLabel!: HTMLElement;
  private bannerTimer = 0;
  private fireTimer = 0;
  private wasActive = false;
  private soundBtn!: HTMLButtonElement;
  /**
   * Mirrors the game's setting, not the other way round. A tap reports the
   * *desired* state and the game pushes the truth back through `setMuted()`, so
   * the button can never drift out of step with what is actually audible.
   */
  private muted = false;

  constructor(root: HTMLElement, cb: HudCallbacks) {
    this.root = root;
    this.cb = cb;
    this.build();
  }

  private build(): void {
    clear(this.root);
    const hud = el('div', 'hud');
    this.hudEl = hud;

    const top = el('div', 'hud-top');
    const board = el('div', 'scoreboard');
    // Both are replaced by `setTeams` before the first frame; these are only
    // what the board reads for the instant before the world exists.
    this.homeEl = el('span', 'team home', 'YOU');
    this.scoreEl = el('span', 'score', '0 - 0');
    this.awayEl = el('span', 'team away', 'OPP');
    board.append(this.homeEl, this.scoreEl, this.awayEl);

    const clockWrap = el('div', 'clock-wrap');
    this.clockEl = el('span', 'clock', "0'");
    this.halfEl = el('span', 'half', '1st Half');
    this.condEl = el('span', 'cond-mini', '');
    clockWrap.append(this.clockEl, this.halfEl, this.condEl);
    top.append(board, clockWrap);

    const poss = el('div', 'possession');
    this.possBar = el('div', 'poss-bar');
    poss.append(this.possBar);

    this.setPieceEl = el('div', 'setpiece-chip');
    this.banner = el('div', 'banner');

    const bottom = el('div', 'hud-bottom');

    const mentalityRow = el('div', 'mentality-row');
    for (const m of MENTALITIES) {
      const b = el('button', 'mentality-btn', m.label);
      on(b, 'click', () => this.cb.onMentality(m.id));
      this.mentalityBtns.set(m.id, b);
      mentalityRow.append(b);
    }

    this.actionRow = el('div', 'action-row');

    const controls = el('div', 'controls-row');
    // SPECIAL is a charged ability: a fill bar shows it coming back, and the
    // button lights up the moment it is usable.
    this.specialBtn = el('button', 'special-btn');
    this.specialCharge = el('span', 'charge');
    this.specialLabel = el('span', 'special-label', 'SPECIAL');
    this.specialBtn.append(this.specialCharge, this.specialLabel);
    on(this.specialBtn, 'click', () => this.cb.onSpecial());
    const pauseBtn = el('button', 'pause-btn', '❚❚');
    on(pauseBtn, 'click', () => this.cb.onPause());
    // Muting mid-match matters: without this the only way to silence the ground
    // is to leave the match, find Settings and come back.
    //
    // The tap reports the requested *sound-on* state, which is the opposite of
    // the state the button is currently showing.
    this.soundBtn = el('button', 'sound-btn', '♪');
    this.soundBtn.setAttribute('aria-label', 'Sound');
    on(this.soundBtn, 'click', () => this.cb.onSound(this.muted));
    controls.append(this.specialBtn, this.soundBtn, pauseBtn);

    bottom.append(mentalityRow, this.actionRow, controls);

    // Group the top elements so the flex column only spreads top vs bottom.
    const topGroup = el('div', 'hud-top-group');
    topGroup.append(top, poss, this.setPieceEl, this.banner);

    hud.append(topGroup, bottom);
    this.root.append(hud);
  }

  private buildActionButtons(offers: World['offers']): void {
    clear(this.actionRow);
    for (const a of offers) {
      const label = a === 'shoot' ? 'SHOOT' : a === 'pass' ? 'PASS' : 'CLEAR';
      const b = el('button', `action-btn ${a}`, label);
      on(b, 'click', () => this.cb.onAction(a));
      this.actionRow.append(b);
    }
    this.actionRow.classList.toggle('empty', offers.length === 0);
  }

  update(w: World, dt: number): void {
    const [h, a] = w.teams;
    this.homeEl.textContent = h.short;
    this.awayEl.textContent = a.short;
    this.scoreEl.textContent = `${h.score} - ${a.score}`;
    this.clockEl.textContent = displayMinute(w);
    this.halfEl.textContent = w.half === 1 ? '1st Half' : '2nd Half';
    this.condEl.textContent = `${WEATHERS[w.weather].name} · ${displayLength(w.halfSeconds)}`;

    const total = Math.max(1, w.stats.possession[0] + w.stats.possession[1]);
    const homePct = (w.stats.possession[0] / total) * 100;
    this.possBar.style.width = `${homePct.toFixed(1)}%`;

    // Dead-ball indicator: who is taking what.
    const sp = w.setPiece;
    this.setPieceEl.classList.toggle('show', !!sp);
    if (sp) {
      const t = w.teams[sp.team];
      this.setPieceEl.textContent = `${SETPIECE_LABEL[sp.kind]} · ${t.short}`;
      this.setPieceEl.classList.toggle('penalty', sp.kind === 'penalty');
    }

    /*
     * A goal celebration owns the pitch. The tactical controls are inert while
     * the ball is dead — there is nothing to call — and they sit exactly where
     * the camera pushes in, so they fade out and let the celebration through.
     * Sound and pause deliberately stay: those are still usable.
     */
    this.hudEl.classList.toggle('celebrating', w.phase === 'goal');

    for (const [id, btn] of this.mentalityBtns) {
      btn.classList.toggle('active', h.mentality === id);
    }

    this.buildActionButtons(w.offers);

    // ---- SPECIAL: charge bar, ready glow, activation flash ----
    const cd = Math.max(0, h.specialCooldown);
    const active = h.specialTimer > 0;
    const charging = cd > 0 && !active;

    this.specialBtn.disabled = charging;
    this.specialBtn.classList.toggle('charging', charging);
    this.specialBtn.classList.toggle('ready', active || (!charging && cd <= 0));

    // Fill the bar as the ability comes back.
    const charge = active ? 1 : 1 - cd / SPECIAL_COOLDOWN;
    this.specialCharge.style.width = `${(Math.max(0, Math.min(1, charge)) * 100).toFixed(1)}%`;

    if (active) {
      this.specialLabel.textContent = `SPECIAL ${Math.ceil(h.specialTimer)}s`;
    } else if (charging) {
      this.specialLabel.textContent = `CHARGING ${Math.ceil(cd)}s`;
    } else {
      this.specialLabel.textContent = 'SPECIAL';
    }

    // Flash on the frame the ability fires.
    if (active && !this.wasActive) this.fireTimer = 0.55;
    this.wasActive = active;
    if (this.fireTimer > 0) {
      this.fireTimer -= dt;
      this.specialBtn.classList.add('firing');
      if (this.fireTimer <= 0) this.specialBtn.classList.remove('firing');
    }

    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.banner.classList.remove('show');
    }
  }

  showBanner(text: string, kind = ''): void {
    this.banner.textContent = text;
    this.banner.className = `banner show ${kind}`;
    this.bannerTimer = 2.2;
  }

  /** Reflect the game's sound setting. The HUD never decides it itself. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.soundBtn.classList.toggle('muted', muted);
    this.soundBtn.setAttribute('aria-pressed', String(!muted));
  }

  setVisible(v: boolean): void {
    const hud = this.root.querySelector('.hud');
    if (hud) hud.classList.toggle('hidden', !v);
  }

  destroy(): void {
    clear(this.root);
  }
}
