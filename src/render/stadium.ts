// render/stadium.ts — the cartoon football world around the pitch.
//
// Presentation-only decoration, built once and only ever re-tinted, so a frame
// costs a handful of sines. It supplies the "world" layer of the art direction:
//
//   raked stands  — stepped concrete tiers on all four sides, corners left open
//   the crowd     — one InstancedMesh per stand, gently breathing and popping
//   floodlights   — corner towers with warm additive halos
//   ad boards     — a band of alternating sponsor blocks along every touchline
//   brand boards  — the ground's own signage, carrying the Viber League mark
//   corner flags  — the small details that say "football", not "arena"
//   a painted sky — a gradient dome that re-tints with the weather
//
// World mapping matches the pitch: worldX = sim.y (width), worldZ = sim.x (length).

import * as THREE from 'three';
import { PITCH_HALF_L, PITCH_HALF_W } from '../sim/constants';
import { BOARD_ASPECT, paintBrandBoard } from '../brand';

/* ------------------------------- layout ------------------------------- */

/** Front row of the stands that run along the touchlines. */
const SIDE_INNER = PITCH_HALF_W + 3.2;
/** Front row of the stands behind the goals. */
const END_INNER = PITCH_HALF_L + 3.2;
const SIDE_LEN = 44;
const END_LEN = 26;
const TIERS = 6;
const TIER_RISE = 0.78;
const TIER_RUN = 1.55;
/** Seats per tier on each stand. */
const SEATS_PER_TIER = 30;
/** Vertical travel of the crowd's idle breathing, in world units. */
const CROWD_BREATH = 0.055;

/* ------------------------------- palette ------------------------------ */

/** Stepped concrete, alternating so the tiers read as rows. */
const CONCRETE = [0x2b3654, 0x222d47, 0x323f62];

/**
 * The crowd.
 *
 * Deliberately muted. The old set was nine fully-saturated neons — red, yellow,
 * green, blue, violet, white, orange, cyan, pink — tiled across both stands,
 * which made the crowd the loudest thing on screen and pulled the eye off the
 * pitch and the HUD. These are the same nine hues with roughly half the
 * saturation and the brightness pulled down: still recognisably a colourful
 * crowd, but it now sits behind the play instead of shouting over it.
 */
const CROWD_COLORS = [
  0x5c6f96, // blue
  0x8a5f74, // wine
  0x7a8752, // olive
  0x4f8188, // teal
  0xa08a5f, // ochre
  0x6f5f96, // violet
  0x9a6f5c, // clay
  0x5a6b7a, // slate
  0x7d8a6f, // sage
  0x9a9385, // stone
];

/**
 * The sponsor blocks along the hoardings.
 *
 * Darker and duller than they were. Their job is to be a band of advertising
 * the eye skims past — not six competing brand colours. Keeping them low-key is
 * also what lets the black-and-lime Viber League boards stand proud of them, the
 * way a real ground's own signage reads against its sponsor strip.
 */
const BOARD_COLORS = [0x243a63, 0x5a2f47, 0x6b5a26, 0x1f4a52, 0x3b2f5e, 0x25482f];
const FLAG_COLORS = [0xd95050, 0xe0b45a, 0x6f93c4, 0x5fa877];

/* ------------------------------- module ------------------------------- */

interface Stadium {
  group: THREE.Group;
  sky: THREE.Mesh;
  skyTex: THREE.CanvasTexture;
  skyCanvas: HTMLCanvasElement;
  /** One bobbing crowd mesh per stand, plus its phase offset. */
  crowd: THREE.InstancedMesh[];
  crowdPhase: number[];
  halos: THREE.Sprite[];
  haloMat: THREE.SpriteMaterial;
  /** Floodlight strength for the current weather — the shimmer scales off this. */
  lamp: number;
}

let stadium: Stadium | null = null;
let elapsed = 0;

/* ------------------------------ textures ------------------------------ */

/** A soft radial falloff, used for the floodlight halos. */
function radialTexture(inner: string, outer: string): THREE.CanvasTexture {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.45, outer);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Paint a vertical sky gradient. Canvas top maps to the top of the dome. */
function paintSky(canvas: HTMLCanvasElement, top: number, horizon: number): void {
  const g = canvas.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, `#${top.toString(16).padStart(6, '0')}`);
  grad.addColorStop(0.52, `#${horizon.toString(16).padStart(6, '0')}`);
  grad.addColorStop(1, `#${horizon.toString(16).padStart(6, '0')}`);
  g.fillStyle = grad;
  g.fillRect(0, 0, canvas.width, canvas.height);
}

/* ------------------------------- builders ----------------------------- */

/**
 * One raked stand: a stack of solid steps, so the front face of every tier is
 * visible from the pitch and nothing shows through from below.
 *
 * `axis` is the direction the tiers climb away from the pitch.
 */
function buildStand(
  group: THREE.Group,
  axis: 'x' | 'z',
  sign: 1 | -1,
  inner: number,
  length: number,
): THREE.Group {
  const stand = new THREE.Group();
  const cross = axis === 'x' ? 'z' : 'x';

  for (let t = 0; t < TIERS; t++) {
    const height = (t + 1) * TIER_RISE;
    const depth = TIER_RUN;
    const w = cross === 'z' ? depth : length;
    const d = cross === 'z' ? length : depth;
    const geo = new THREE.BoxGeometry(w, height, d);
    const mat = new THREE.MeshLambertMaterial({ color: CONCRETE[t % CONCRETE.length] });
    const step = new THREE.Mesh(geo, mat);

    const offset = inner + (t + 0.5) * TIER_RUN;
    step.position.y = height / 2;
    if (axis === 'x') step.position.x = sign * offset;
    else step.position.z = sign * offset;
    stand.add(step);
  }

  // A back wall closes the stand off so the sky does not leak underneath.
  const backGeo = new THREE.BoxGeometry(
    axis === 'x' ? 1.2 : length + 1.2,
    TIERS * TIER_RISE + 1.4,
    axis === 'x' ? length + 1.2 : 1.2,
  );
  const back = new THREE.Mesh(backGeo, new THREE.MeshLambertMaterial({ color: 0x1a2338 }));
  const backOffset = inner + TIERS * TIER_RUN + 0.6;
  back.position.y = (TIERS * TIER_RISE + 1.4) / 2 - 0.4;
  if (axis === 'x') back.position.x = sign * backOffset;
  else back.position.z = sign * backOffset;
  stand.add(back);

  group.add(stand);
  return stand;
}

/** A seated crowd on one stand, as a single InstancedMesh. */
function buildCrowd(
  group: THREE.Group,
  axis: 'x' | 'z',
  sign: 1 | -1,
  inner: number,
  length: number,
): THREE.InstancedMesh {
  const count = TIERS * SEATS_PER_TIER;
  const geo = new THREE.BoxGeometry(0.42, 0.64, 0.5);
  const mat = new THREE.MeshLambertMaterial();
  const mesh = new THREE.InstancedMesh(geo, mat, count);

  const m = new THREE.Matrix4();
  const color = new THREE.Color();
  let i = 0;
  for (let t = 0; t < TIERS; t++) {
    const treadTop = (t + 1) * TIER_RISE;
    const offset = inner + (t + 0.5) * TIER_RUN;
    for (let s = 0; s < SEATS_PER_TIER; s++) {
      // Spread along the stand, with a little jitter so it reads as people.
      const u = (s + 0.5) / SEATS_PER_TIER;
      const along = (u - 0.5) * length + (Math.random() - 0.5) * 0.5;
      const px = axis === 'x' ? sign * (offset + (Math.random() - 0.5) * 0.4) : along;
      const pz = axis === 'x' ? along : sign * (offset + (Math.random() - 0.5) * 0.4);
      m.makeTranslation(px, treadTop + 0.32, pz);
      mesh.setMatrixAt(i, m);
      color.setHex(CROWD_COLORS[Math.floor(Math.random() * CROWD_COLORS.length)]);
      // Dim the higher rows a touch so the front row carries the eye, and let
      // the back of the stand fall away into the gloom instead of reading as a
      // flat wall of seats.
      color.multiplyScalar(1 - t * 0.06);
      mesh.setColorAt(i, color);
      i++;
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  group.add(mesh);
  return mesh;
}

/** A corner floodlight tower: pole, lamp bank, and a warm additive halo. */
function buildFloodlight(
  group: THREE.Group,
  x: number,
  z: number,
  haloMat: THREE.SpriteMaterial,
): THREE.Sprite {
  const tower = new THREE.Group();
  tower.position.set(x, 0, z);

  const poleMat = new THREE.MeshLambertMaterial({ color: 0x36415f });
  const pole = new THREE.Mesh(new THREE.BoxGeometry(0.6, 15, 0.6), poleMat);
  pole.position.y = 7.5;
  tower.add(pole);

  const rig = new THREE.Mesh(new THREE.BoxGeometry(6.2, 3.2, 0.5), poleMat);
  rig.position.y = 15.8;
  tower.add(rig);

  // Aim the lamp bank at the middle of the pitch.
  tower.rotation.y = Math.atan2(-x, -z) + Math.PI;

  const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff4d6 });
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 6; col++) {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.7, 0.24), lampMat);
      lamp.position.set((col - 2.5) * 0.92, 15.0 + row * 0.86, 0.34);
      tower.add(lamp);
    }
  }

  const halo = new THREE.Sprite(haloMat);
  halo.scale.set(16, 12, 1);
  halo.position.set(0, 15.8, 0.9);
  tower.add(halo);

  group.add(tower);
  return halo;
}

/** Alternating sponsor blocks in a band along a touchline or byline. */
function buildBoards(
  group: THREE.Group,
  axis: 'x' | 'z',
  sign: 1 | -1,
  offset: number,
  length: number,
  segments: number,
  startIndex: number,
): number {
  const geo = new THREE.BoxGeometry(
    axis === 'x' ? 0.3 : length / segments,
    0.95,
    axis === 'x' ? length / segments : 0.3,
  );
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial(), segments);
  const m = new THREE.Matrix4();
  const color = new THREE.Color();
  for (let i = 0; i < segments; i++) {
    const u = (i + 0.5) / segments;
    const along = (u - 0.5) * length;
    const px = axis === 'x' ? sign * offset : along;
    const pz = axis === 'x' ? along : sign * offset;
    m.makeTranslation(px, 0.48, pz);
    mesh.setMatrixAt(i, m);
    color.setHex(BOARD_COLORS[(startIndex + i) % BOARD_COLORS.length]);
    mesh.setColorAt(i, color);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  group.add(mesh);
  return startIndex + segments;
}

/** The four corner flags, on their little poles. */
function buildCornerFlags(group: THREE.Group): void {
  const poleMat = new THREE.MeshLambertMaterial({ color: 0xf1f5f9 });
  const x = PITCH_HALF_W - 0.2;
  const z = PITCH_HALF_L - 0.2;
  let i = 0;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const flag = new THREE.Group();
      flag.position.set(sx * x, 0, sz * z);
      const pole = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.1, 0.12), poleMat);
      pole.position.y = 1.05;
      const cloth = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, 0.55, 0.06),
        new THREE.MeshLambertMaterial({ color: FLAG_COLORS[i % FLAG_COLORS.length] }),
      );
      cloth.position.set(0.5, 1.78, 0);
      flag.add(pole, cloth);
      group.add(flag);
      i++;
    }
  }
}

/* --------------------------- the brand boards -------------------------- */

/** One board, standing just inside the sponsor blocks and facing the pitch. */
function buildBrandBoard(
  group: THREE.Group,
  tex: THREE.CanvasTexture,
  x: number,
  z: number,
  yaw: number,
  width: number,
): void {
  const height = width * BOARD_ASPECT;
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshLambertMaterial({ map: tex }),
  );
  board.position.set(x, height / 2 + 0.02, z);
  board.rotation.y = yaw;
  group.add(board);
}

/**
 * The ground's own signage.
 *
 * Deliberately the same object as the sponsor blocks, just taller and carrying
 * our mark — a board that floats, glows or faces the camera would read as a
 * watermark rather than as something the stadium owns.
 *
 * Two placements, for two different jobs:
 *
 *   touchlines — the boards the camera runs past. Seen at a glancing angle, so
 *                only the mark end of the face is ever legible; the point of
 *                these is the black-and-lime plate standing out against the
 *                pastel sponsor blocks, which is how a real ground reads.
 *   bylines    — the far end, seen close to face-on, which is the only place in
 *                this camera the wordmark can actually be read. Set either side
 *                of the goal rather than behind it: the net is 2.2m tall and
 *                would swallow a 1.4m board whole.
 */
function buildBrandBoards(group: THREE.Group, tex: THREE.CanvasTexture): void {
  // Inside the sponsor blocks (PITCH_HALF_W + 1.5), so it stands proud of them.
  const side = PITCH_HALF_W + 1.34;
  for (const sign of [1, -1] as Array<1 | -1>) {
    for (const z of [-8.5, 8.5]) {
      buildBrandBoard(group, tex, sign * side, z, sign > 0 ? -Math.PI / 2 : Math.PI / 2, 4.6);
    }
  }
  // Behind the far goal, clear of the net and the goal frame.
  for (const sign of [1, -1] as Array<1 | -1>) {
    buildBrandBoard(group, tex, sign * 7.6, PITCH_HALF_L + 1.55, Math.PI, 5.6);
  }
}

/* ------------------------------- public ------------------------------- */

/** Build the whole world once. Safe to call a single time per scene. */
export function buildStadium(scene: THREE.Scene): void {
  const group = new THREE.Group();

  // Sky dome — unlit and unfogged so the horizon stays crisp.
  const skyCanvas = document.createElement('canvas');
  skyCanvas.width = 4;
  skyCanvas.height = 256;
  const skyTex = new THREE.CanvasTexture(skyCanvas);
  skyTex.colorSpace = THREE.SRGBColorSpace;
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(150, 24, 16),
    new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  group.add(sky);

  const haloMat = new THREE.SpriteMaterial({
    map: radialTexture('rgba(255,244,214,0.85)', 'rgba(255,220,150,0.22)'),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: 0.5,
  });

  const crowd: THREE.InstancedMesh[] = [];
  const crowdPhase: number[] = [];

  // Side stands run along the touchlines; end stands sit behind the goals.
  for (const sign of [1, -1] as Array<1 | -1>) {
    buildStand(group, 'x', sign, SIDE_INNER, SIDE_LEN);
    crowd.push(buildCrowd(group, 'x', sign, SIDE_INNER, SIDE_LEN));
    crowdPhase.push(sign > 0 ? 0 : Math.PI * 0.7);

    buildStand(group, 'z', sign, END_INNER, END_LEN);
    crowd.push(buildCrowd(group, 'z', sign, END_INNER, END_LEN));
    crowdPhase.push(sign > 0 ? Math.PI * 1.3 : Math.PI * 0.35);
  }

  // Advertising hoardings on all four sides.
  let boardIndex = 0;
  for (const sign of [1, -1] as Array<1 | -1>) {
    boardIndex = buildBoards(group, 'x', sign, PITCH_HALF_W + 1.5, SIDE_LEN, 16, boardIndex);
    boardIndex = buildBoards(group, 'z', sign, PITCH_HALF_L + 1.8, END_LEN, 10, boardIndex);
  }

  const halos: THREE.Sprite[] = [];
  const fx = PITCH_HALF_W + 5.5;
  const fz = PITCH_HALF_L + 5.5;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      halos.push(buildFloodlight(group, sx * fx, sz * fz, haloMat));
    }
  }

  buildCornerFlags(group);

  // The ground's own boards. The face is painted now and repainted once the
  // display font is actually available: `@font-face` from a data URI still
  // loads asynchronously, and a board whose wordmark silently fell back to a
  // system sans would be the one piece of signage that does not look like us.
  const brandCanvas = document.createElement('canvas');
  brandCanvas.width = 512;
  brandCanvas.height = 144;
  paintBrandBoard(brandCanvas);
  const brandTex = new THREE.CanvasTexture(brandCanvas);
  brandTex.colorSpace = THREE.SRGBColorSpace;
  brandTex.anisotropy = 4;
  buildBrandBoards(group, brandTex);
  void document.fonts?.ready
    .then(() => {
      paintBrandBoard(brandCanvas);
      brandTex.needsUpdate = true;
    })
    .catch(() => {
      /* The first paint already stands; a missing font is not an error. */
    });

  scene.add(group);
  paintSky(skyCanvas, 0x5fa8ff, 0x9fd0ff);
  skyTex.needsUpdate = true;

  stadium = { group, sky, skyTex, skyCanvas, crowd, crowdPhase, halos, haloMat, lamp: 0.5 };
}

/**
 * Re-tint the world for the chosen conditions. `sky` is the colour overhead,
 * `horizon` the haze at the far end, `lamp` the floodlight strength.
 */
export function setStadiumTheme(sky: number, horizon: number, lamp: number): void {
  if (!stadium) return;
  paintSky(stadium.skyCanvas, sky, horizon);
  stadium.skyTex.needsUpdate = true;
  stadium.lamp = lamp;
  stadium.haloMat.opacity = lamp;
  for (const halo of stadium.halos) halo.visible = lamp > 0.02;
}

/** Idle life: the crowd breathes, and the floodlights shimmer very slightly. */
export function updateStadium(dt: number): void {
  if (!stadium) return;
  elapsed += dt;
  for (let i = 0; i < stadium.crowd.length; i++) {
    const phase = stadium.crowdPhase[i];
    // A slow breath plus a faster ripple, so the stands never look frozen.
    const breath = Math.sin(elapsed * 1.1 + phase) * CROWD_BREATH;
    const ripple = Math.sin(elapsed * 3.3 + phase * 2.1) * CROWD_BREATH * 0.28;
    stadium.crowd[i].position.y = breath + ripple;
  }
  // Shimmer around the base level — never a cumulative multiplier.
  stadium.haloMat.opacity = stadium.lamp * (1 + Math.sin(elapsed * 7.1) * 0.06);
}
