// ui/avatar.ts — tiny CSS-drawn Viber portraits for menus.
// Mirrors the 3D rig (giant head, one of four face treatments, head-top slab,
// belt, big boots) using the exact colours from roster.ts so menus match the pitch.

import { el } from './dom';
import type { ViberCharacter } from '../sim/roster';

export function hex(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}

/**
 * Build a mini Viber figure. `scale` is a CSS multiplier on the base 46x70 box.
 */
export function viberAvatar(v: ViberCharacter, scale = 1): HTMLElement {
  const d = v.design;
  const wrap = el('div', 'vv-avatar');
  wrap.style.setProperty('--vv-scale', String(scale));
  wrap.style.setProperty('--vv-head', hex(d.head));
  wrap.style.setProperty('--vv-top', hex(d.top));
  wrap.style.setProperty('--vv-face', hex(d.face));
  wrap.style.setProperty('--vv-eye', hex(d.eye));
  wrap.style.setProperty('--vv-pupil', hex(d.pupil));
  wrap.style.setProperty('--vv-body', hex(d.body));
  wrap.style.setProperty('--vv-arm', hex(d.arm));
  wrap.style.setProperty('--vv-leg', hex(d.leg));
  wrap.style.setProperty('--vv-boot', hex(d.boot));
  wrap.style.setProperty('--vv-belt', hex(d.belt));
  wrap.style.setProperty('--vv-accent', hex(d.accent));
  if (d.ghost) wrap.classList.add('ghost');

  const inner = el('div', 'vv-inner');

  // ---- Head ---------------------------------------------------------
  const head = el('div', 'vv-head');
  if (d.headTop !== 'none') head.append(el('div', `vv-ht vv-ht-${d.headTop}`));
  if (d.brow) head.append(el('div', 'vv-brow'));

  const face = el('div', `vv-face vv-face-${d.faceStyle}`);
  if (d.faceStyle === 'cubes') {
    // Two bare cubes sitting on the head front.
    const eyes = el('div', 'vv-eyes');
    eyes.append(el('span', 'vv-eye'), el('span', 'vv-eye'));
    face.append(eyes);
  } else if (d.faceStyle === 'bar') {
    face.append(el('span', 'vv-bar'));
  } else {
    // 'panel' and 'plate' both hold two eyes; only 'panel' shows pupils.
    const eyes = el('div', 'vv-eyes');
    for (let i = 0; i < 2; i++) {
      const e = el('span', 'vv-eye');
      if (d.faceStyle === 'panel') e.append(el('span', 'vv-pupil'));
      eyes.append(e);
    }
    face.append(eyes);
  }
  head.append(face);
  inner.append(head);

  // ---- Body ---------------------------------------------------------
  const body = el('div', 'vv-body');
  body.append(el('div', 'vv-plate'));
  body.append(el('div', 'vv-arm vv-arm-l'), el('div', 'vv-arm vv-arm-r'));
  if (d.backpack) body.append(el('div', 'vv-pack'));
  if (d.tail) body.append(el('div', 'vv-tail'));
  inner.append(body);

  // ---- Belt + legs ---------------------------------------------------
  inner.append(el('div', 'vv-belt'));
  const legs = el('div', 'vv-legs');
  legs.append(el('span', 'vv-leg'), el('span', 'vv-leg'));
  inner.append(legs);

  wrap.append(inner);
  return wrap;
}
