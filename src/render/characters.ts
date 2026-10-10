// render/characters.ts — procedural Viber figures built from a ViberDesign.
//
// Matches the reference art (~/Downloads/vibe-vibers-*.png):
//   * one GIANT box head (~1.7x the torso width, ~half the total height)
//   * a flat overhanging head-top slab, or rods / antennae / ears / spikes / fin
//   * four face treatments: cubes | panel | plate | bar
//   * a small torso with a belt slab and a chest plate
//   * thin arms with light cuffs, short legs, big flat boots
//   * a thick uniform black border on every part (inflated back-face hull)
//
// Flat-shaded (Lambert) so the forms read cleanly. Every part is a box, which
// keeps it cheap enough for a phone.

import * as THREE from 'three';
import type { ViberDesign } from '../sim/roster';

export interface CharacterRig {
  group: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  torso: THREE.Mesh;
  headMesh: THREE.Mesh;
  shadow: THREE.Mesh;
  ring: THREE.Mesh;
}

/* ------------------------------------------------------------------ */
/* Materials                                                           */
/* ------------------------------------------------------------------ */

/** Reference outline colour — near-black, very slightly blue. */
const OUTLINE_COLOR = 0x14161a;

/**
 * Border thickness in rig units, applied uniformly to every part no matter how
 * big it is. (LineBasicMaterial ignores `linewidth` in WebGL, so the outline is
 * drawn as an inflated back-face hull instead.)
 */
const OUTLINE_THICKNESS = 0.07;

const OUTLINE_MAT = new THREE.MeshBasicMaterial({
  color: OUTLINE_COLOR,
  side: THREE.BackSide,
});

const OUTLINE_MAT_GHOST = new THREE.MeshBasicMaterial({
  color: OUTLINE_COLOR,
  side: THREE.BackSide,
  transparent: true,
  opacity: 0.6,
});

const matCache = new Map<number, THREE.MeshLambertMaterial>();
function flatMat(color: number): THREE.MeshLambertMaterial {
  let m = matCache.get(color);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color });
    matCache.set(color, m);
  }
  return m;
}

/** Unlit material for glowing eyes, bars and bulbs. */
const glowCache = new Map<number, THREE.MeshBasicMaterial>();
function glowMat(color: number): THREE.MeshBasicMaterial {
  let m = glowCache.get(color);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color });
    glowCache.set(color, m);
  }
  return m;
}

/* ------------------------------------------------------------------ */
/* Colour helpers                                                      */
/* ------------------------------------------------------------------ */

const _c = new THREE.Color();

function darken(hex: number, factor: number): number {
  return _c.setHex(hex).multiplyScalar(factor).getHex();
}

function lighten(hex: number, factor: number): number {
  const c = _c.setHex(hex);
  c.r = Math.min(1, c.r * factor);
  c.g = Math.min(1, c.g * factor);
  c.b = Math.min(1, c.b * factor);
  return c.getHex();
}

/* ------------------------------------------------------------------ */
/* Primitive helpers                                                   */
/* ------------------------------------------------------------------ */

interface PartOpts {
  /** Draw the black border (default true). */
  outline?: boolean;
  /** Unlit — for glowing parts. */
  glow?: boolean;
  /** Translucent (the ghost). */
  ghost?: boolean;
}

/** A solid box part, bordered in black by default. */
function box(
  w: number,
  h: number,
  d: number,
  color: number,
  opts: PartOpts = {},
): THREE.Mesh {
  const { outline = true, glow = false, ghost = false } = opts;
  const geo = new THREE.BoxGeometry(w, h, d);
  const mat = glow ? glowMat(color) : flatMat(color);
  if (ghost) {
    mat.transparent = true;
    mat.opacity = 0.74;
  }
  const m = new THREE.Mesh(geo, mat);
  if (outline) {
    const hull = new THREE.Mesh(geo, ghost ? OUTLINE_MAT_GHOST : OUTLINE_MAT);
    // Grow by a fixed amount on every axis so thin parts get the same border.
    hull.scale.set(
      (w + OUTLINE_THICKNESS) / w,
      (h + OUTLINE_THICKNESS) / h,
      (d + OUTLINE_THICKNESS) / d,
    );
    m.add(hull);
  }
  return m;
}

/** A limb that pivots at its top (shoulder / hip). */
function limb(w: number, h: number, d: number, color: number, ghost = false): THREE.Group {
  const g = new THREE.Group();
  const m = box(w, h, d, color, { ghost });
  m.position.y = -h / 2;
  g.add(m);
  return g;
}

/* ------------------------------------------------------------------ */
/* Proportions (rig units; the whole figure is scaled at the end)       */
/* ------------------------------------------------------------------ */

const HEAD_W = 1.72;
const HEAD_H = 1.46;
const HEAD_D = 1.60;
const HEAD_Y = 2.20; // head centre
const HEAD_BOTTOM = HEAD_Y - HEAD_H / 2; // 1.47

const TORSO_W = 1.0;
const TORSO_H = 0.78;
const TORSO_D = 0.74;
const TORSO_Y = HEAD_BOTTOM - TORSO_H / 2 + 0.02; // 1.07

/** Final world height ≈ 3.45 * ROOT_SCALE. Just under the 2.2m goal. */
const ROOT_SCALE = 0.56;

/**
 * Approximate world height of a built figure, including a tall head-top.
 * Hero framing in `showcase.ts` measures against this.
 */
export const CHARACTER_WORLD_HEIGHT = 2.05;

/* ------------------------------------------------------------------ */
/* Face                                                                */
/* ------------------------------------------------------------------ */

function buildFace(head: THREE.Group, d: ViberDesign, ghost: boolean): void {
  const z = HEAD_D / 2; // front surface

  if (d.faceStyle === 'cubes') {
    // Two bare cubes sitting straight on the head front.
    for (const sx of [-1, 1]) {
      const eye = box(0.36, 0.36, 0.2, d.eye, { glow: true, ghost });
      eye.position.set(sx * 0.38, 0.1, z);
      head.add(eye);
    }
    return;
  }

  if (d.faceStyle === 'panel') {
    // A large coloured plate holding two big white eyes with dark pupils.
    const plate = box(1.34, 1.02, 0.18, d.face, { ghost });
    plate.position.set(0, 0.02, z + 0.02);
    head.add(plate);
    for (const sx of [-1, 1]) {
      const eye = box(0.5, 0.62, 0.1, d.eye, { glow: true, ghost });
      eye.position.set(sx * 0.36, 0.06, z + 0.14);
      head.add(eye);
      const pupil = box(0.18, 0.2, 0.08, d.pupil, { ghost });
      pupil.position.set(sx * 0.36, 0.02, z + 0.2);
      head.add(pupil);
    }
    return;
  }

  if (d.faceStyle === 'bar') {
    // A dark plate with a single glowing horizontal bar (the robot).
    const plate = box(1.4, 1.0, 0.2, d.face, { ghost });
    plate.position.set(0, 0.02, z + 0.02);
    head.add(plate);
    const bar = box(0.94, 0.24, 0.1, d.eye, { glow: true, ghost });
    bar.position.set(0, 0.04, z + 0.14);
    head.add(bar);
    return;
  }

  // 'plate': a large black plate covering the front, two small glowing eyes.
  const plate = box(1.52, 1.2, 0.2, d.face, { ghost });
  plate.position.set(0, 0.02, z + 0.02);
  head.add(plate);
  for (const sx of [-1, 1]) {
    const eye = box(0.26, 0.26, 0.1, d.eye, { glow: true, ghost });
    eye.position.set(sx * 0.34, 0.08, z + 0.14);
    head.add(eye);
  }
}

/** Thin pale band across the brow. */
function buildBrow(head: THREE.Group, d: ViberDesign, ghost: boolean): void {
  const band = box(1.5, 0.18, 0.08, lighten(d.head, 2.1), { ghost });
  band.position.set(0, 0.5, HEAD_D / 2 + 0.02);
  head.add(band);
}

/* ------------------------------------------------------------------ */
/* Head top                                                            */
/* ------------------------------------------------------------------ */

function buildHeadTop(head: THREE.Group, d: ViberDesign, ghost: boolean): void {
  const top = HEAD_H / 2; // 0.73
  const c = d.top;

  switch (d.headTop) {
    case 'flatslab': {
      const slab = box(1.98, 0.24, 1.84, c, { ghost });
      slab.position.set(0, top + 0.12, 0);
      head.add(slab);
      const block = box(1.1, 0.26, 0.9, c, { ghost });
      block.position.set(0, top + 0.37, 0);
      head.add(block);
      break;
    }
    case 'mortar': {
      const slab = box(2.0, 0.22, 1.86, c, { ghost });
      slab.position.set(0, top + 0.11, 0);
      head.add(slab);
      const cube = box(0.42, 0.22, 0.42, lighten(c, 0.9), { ghost });
      cube.position.set(0.44, top + 0.33, 0.18);
      head.add(cube);
      break;
    }
    case 'rods': {
      const heights = [0.62, 0.46, 0.54, 0.34];
      const xs = [-0.36, -0.12, 0.14, 0.42];
      for (let i = 0; i < heights.length; i++) {
        const rod = box(0.2, heights[i], 0.2, c, { ghost });
        rod.position.set(xs[i], top + heights[i] / 2, -0.1);
        head.add(rod);
      }
      break;
    }
    case 'antenna': {
      const rod = box(0.14, 0.6, 0.14, c, { ghost });
      rod.position.set(0, top + 0.3, 0);
      head.add(rod);
      const bulb = box(0.26, 0.26, 0.26, d.eye, { glow: true, ghost });
      bulb.position.set(0, top + 0.72, 0);
      head.add(bulb);
      break;
    }
    case 'ears': {
      for (const sx of [-1, 1]) {
        const ear = box(0.34, 0.42, 0.34, c, { ghost });
        ear.position.set(sx * 0.52, top + 0.21, 0);
        head.add(ear);
      }
      break;
    }
    case 'spikes': {
      const heights = [0.62, 0.44, 0.52];
      const xs = [-0.44, 0, 0.44];
      for (let i = 0; i < heights.length; i++) {
        const spike = box(0.22, heights[i], 0.22, c, { ghost });
        spike.position.set(xs[i], top + heights[i] / 2, -0.12);
        head.add(spike);
      }
      break;
    }
    case 'block': {
      const block = box(0.86, 0.44, 0.72, c, { ghost });
      block.position.set(0, top + 0.22, 0);
      head.add(block);
      break;
    }
    case 'wing': {
      const fin = box(0.16, 1.2, 0.66, c, { ghost });
      fin.position.set(0.95, top - 0.42, -0.1);
      head.add(fin);
      break;
    }
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Character assembly                                                  */
/* ------------------------------------------------------------------ */

export function createCharacter(
  d: ViberDesign,
  teamColor: number,
  teamAccent = 0xffffff,
): CharacterRig {
  const ghost = !!d.ghost;
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  const hs = d.headScale ?? 1;
  const hw = HEAD_W * hs;
  const hh = HEAD_H * hs;
  const hd = HEAD_D * hs;

  // --- Legs: short thin boxes with big flat boots --------------------
  const legL = limb(0.32, 0.56, 0.36, d.leg, ghost);
  legL.position.set(-0.28, 0.66, 0);
  body.add(legL);
  const legR = limb(0.32, 0.56, 0.36, d.leg, ghost);
  legR.position.set(0.28, 0.66, 0);
  body.add(legR);

  for (const [g, sx] of [[legL, -1], [legR, 1]] as Array<[THREE.Group, number]>) {
    const boot = box(0.46, 0.28, 0.68, d.boot, { ghost });
    boot.position.set(0, -0.56 - 0.06, 0.08);
    g.add(boot);
  }

  // --- Belt slab across the waist ------------------------------------
  const belt = box(1.16, 0.22, 0.84, d.belt, { ghost });
  belt.position.y = 0.72;
  body.add(belt);

  // --- Torso ---------------------------------------------------------
  const torso = box(TORSO_W, TORSO_H, TORSO_D, d.body, { ghost });
  torso.position.y = TORSO_Y;
  body.add(torso);

  // Chest plate in the Viber's accent colour — their "kit".
  const plate = box(0.6, 0.4, 0.12, d.accent, { ghost });
  plate.position.set(0, TORSO_Y + 0.04, TORSO_D / 2 + 0.04);
  body.add(plate);

  // Team stripe across the shoulders so both sides read from the high camera.
  const stripe = box(TORSO_W + 0.06, 0.14, TORSO_D + 0.06, teamColor, { ghost });
  stripe.position.y = TORSO_Y + TORSO_H / 2 - 0.04;
  body.add(stripe);

  // --- Arms: thin, with a light cuff at the bottom --------------------
  // Set slightly wider than the torso so they read past the edge of the head.
  const armL = limb(0.32, 0.82, 0.36, d.arm, ghost);
  armL.position.set(-0.76, TORSO_Y + 0.34, 0);
  body.add(armL);
  const armR = limb(0.32, 0.82, 0.36, d.arm, ghost);
  armR.position.set(0.76, TORSO_Y + 0.34, 0);
  body.add(armR);

  for (const [g] of [[armL], [armR]] as Array<[THREE.Group]>) {
    const cuff = box(0.34, 0.16, 0.38, teamAccent, { ghost });
    cuff.position.set(0, -0.82 - 0.02, 0);
    g.add(cuff);
  }

  // --- Optional extras ------------------------------------------------
  if (d.backpack) {
    const pack = box(0.72, 0.6, 0.3, darken(d.body, 0.7), { ghost });
    pack.position.set(0, TORSO_Y + 0.02, -TORSO_D / 2 - 0.2);
    body.add(pack);
  }
  if (d.tail) {
    const tail = box(0.3, 0.3, 0.52, darken(d.body, 0.75), { ghost });
    tail.position.set(0.62, TORSO_Y - 0.02, -0.42);
    body.add(tail);
  }

  // --- Head (huge, sits straight on the torso — almost no neck) --------
  const head = new THREE.Group();
  head.position.y = HEAD_Y * hs;
  body.add(head);

  const headMesh = box(hw, hh, hd, d.head, { ghost });
  head.add(headMesh);
  buildFace(head, d, ghost);
  if (d.brow) buildBrow(head, d, ghost);
  buildHeadTop(head, d, ghost);

  // --- Ground: blob shadow + team ring (readability from the camera) ---
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.62, 18),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
    }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;
  group.add(shadow);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.6, 0.74, 22),
    new THREE.MeshBasicMaterial({
      color: teamColor,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.025;
  group.add(ring);

  group.scale.setScalar(ROOT_SCALE);

  return { group, body, head, legL, legR, armL, armR, torso, headMesh, shadow, ring };
}

/** Locomotion animation driven by speed + phase. */
export function animateRig(rig: CharacterRig, phase: number, speedNorm: number): void {
  const s = Math.min(speedNorm, 1.2);
  const swing = Math.sin(phase * 2.2) * 0.8 * s;
  rig.legL.rotation.x = swing;
  rig.legR.rotation.x = -swing;
  rig.armL.rotation.x = -swing * 0.85;
  rig.armR.rotation.x = swing * 0.85;
  // A celebration splays the arms sideways; locomotion always pulls them back
  // in, so the rig can never get stuck in a goal pose.
  rig.armL.rotation.z = 0;
  rig.armR.rotation.z = 0;
  // Slight bob + a touch of head lead while running.
  rig.body.position.y = Math.abs(Math.sin(phase * 2.2)) * 0.06 * s;
  rig.head.rotation.z = Math.sin(phase * 1.1) * 0.03 * s;
}

/* ------------------------------------------------------------------ */
/* Goal celebrations                                                   */
/* ------------------------------------------------------------------ */

/**
 * How strongly the scoring side is celebrating, `t` seconds after the ball
 * crossed the line. Rises fast, holds, then fades — so the whole thing is over
 * in about a second and a half and never runs into the kickoff.
 *
 * Pure, and deliberately independent of the goal-pause length: the caller
 * decides how much of the pause to spend on it.
 */
export const CELEBRATION_END = 1.5;

export function celebrationWeight(t: number): number {
  const RISE = 0.12;
  const HOLD = 1.05;
  const FADE = CELEBRATION_END - HOLD;
  if (t <= 0) return 0;
  if (t < RISE) return t / RISE;
  if (t <= HOLD) return 1;
  return Math.max(0, 1 - (t - HOLD) / FADE);
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/**
 * A short goal celebration, blended *over* the locomotion pose by `k`
 * (0 = pure locomotion, 1 = full celebration).
 *
 * Blending rather than overriding is what lets the rig hand itself back to
 * `animateRig` with no reset bookkeeping: at `k` = 0 this is a no-op.
 *
 * `seed` picks a variant, so a squad does not all move as one. The three
 * variants are the ones that read at this camera distance: arms overhead
 * pumping, arms out spinning, and a one-fist leap.
 */
export function applyCelebration(rig: CharacterRig, t: number, seed: number, k: number): void {
  if (k <= 0) return;
  const variant = Math.abs(Math.trunc(seed)) % 3;
  const beat = Math.sin(t * 11);

  let armLX = Math.PI - 0.30 + beat * 0.26;
  let armRX = Math.PI - 0.30 - beat * 0.26;
  let armLZ = 0.34;
  let armRZ = -0.34;
  let hop = Math.max(0, Math.sin(t * 9)) * 0.46;
  let spin = 0;
  let lean = 0;

  if (variant === 1) {
    // Arms out wide, spinning on the spot.
    armLX = 0.15;
    armRX = 0.15;
    armLZ = 1.4;
    armRZ = -1.4;
    hop = Math.max(0, Math.sin(t * 7)) * 0.3;
    spin = t * 7;
  } else if (variant === 2) {
    // One fist punched up, leaning back into it.
    armRX = Math.PI - 0.12 + beat * 0.36;
    armLX = 0.55;
    armLZ = 0.6;
    armRZ = -0.16;
    hop = Math.max(0, Math.sin(t * 8)) * 0.6;
    lean = -0.12;
  }

  rig.armL.rotation.x = lerp(rig.armL.rotation.x, armLX, k);
  rig.armR.rotation.x = lerp(rig.armR.rotation.x, armRX, k);
  rig.armL.rotation.z = lerp(rig.armL.rotation.z, armLZ, k);
  rig.armR.rotation.z = lerp(rig.armR.rotation.z, armRZ, k);
  rig.legL.rotation.x = lerp(rig.legL.rotation.x, 0.22, k);
  rig.legR.rotation.x = lerp(rig.legR.rotation.x, 0.22, k);
  rig.head.rotation.z = lerp(rig.head.rotation.z, beat * 0.13, k);
  rig.head.rotation.x = lerp(rig.head.rotation.x, lean, k);
  rig.body.position.y = lerp(rig.body.position.y, 0.02, k);

  // `sync` rewrites the root position and yaw every frame, so adding the
  // absolute offset here is safe — it is not integrated across frames.
  rig.group.position.y += hop * k;
  if (spin !== 0) rig.group.rotation.y += spin * k;
}
