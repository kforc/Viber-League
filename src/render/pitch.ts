// render/pitch.ts — stylized arena pitch, markings and goals (spec §16).

import * as THREE from 'three';
import {
  GOAL_H,
  GOAL_HALF_W,
  PITCH_HALF_L,
  PITCH_HALF_W,
} from '../sim/constants';
import { drawBrand } from '../brand';

type Surface = 'grass' | 'snow';

/**
 * The house mark, mown into the centre circle.
 *
 * Drawn on its own canvas first and composited as one piece, because the mark's
 * face is built from *cut-outs* — painting them straight onto the grass would
 * stamp near-black ink into the turf. Compositing lets the whole emblem fade at
 * once, and lets the cut-outs take a second grass tone, so it reads as mown in
 * rather than printed on.
 *
 * Deliberately faint. This is a design on the pitch, not a billboard on it: at
 * full strength a 200px face in the middle of the field fights the players for
 * attention, which is the one thing pitch decoration must never do.
 */
function paintCentreMark(
  g: CanvasRenderingContext2D,
  W: number,
  H: number,
  radius: number,
  snow: boolean,
): void {
  // The artwork fills all but a sliver of its 100-unit box, so the box wants to
  // be very nearly the circle's diameter — anything smaller and the mark reads
  // as a smudge in the middle of the field rather than as a painted emblem. The
  // smile is the widest thing near the bottom of the box, which is what sets the
  // ceiling: at 1.72× the radius it clears the ring with a little to spare.
  const size = Math.round(radius * 1.72);
  const mark = document.createElement('canvas');
  mark.width = size;
  mark.height = size;
  const mg = mark.getContext('2d')!;
  drawBrand(mg, 'viber', size, {
    badge: false,
    // Two grass tones, in both surfaces. On turf that is white paint with a
    // darker green cut-out; on snow it has to invert — white on white would
    // leave nothing but the eyes.
    color: snow ? '#5a82b4' : '#ffffff',
    cutColor: snow ? '#ffffff' : '#2c7a41',
  });

  g.save();
  g.globalAlpha = snow ? 0.4 : 0.32;
  g.drawImage(mark, W / 2 - size / 2, H / 2 - size / 2);
  g.restore();
}

/**
 * Pitch is drawn into a canvas texture so markings cost nothing at runtime.
 * World mapping: worldX = sim.y (width), worldZ = sim.x (length).
 */
function makePitchTexture(surface: Surface): THREE.CanvasTexture {
  const W = 768;
  const H = 1280;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;

  const snow = surface === 'snow';
  const lineColor = snow ? 'rgba(90,130,180,0.9)' : 'rgba(255,255,255,0.92)';

  // Base + mown stripes along the length.
  g.fillStyle = snow ? '#e9f3fc' : '#3d9e55';
  g.fillRect(0, 0, W, H);
  const stripes = 10;
  for (let i = 0; i < stripes; i++) {
    g.fillStyle = snow
      ? i % 2 === 0
        ? 'rgba(140,180,220,0.16)'
        : 'rgba(255,255,255,0.10)'
      : i % 2 === 0
        ? 'rgba(255,255,255,0.055)'
        : 'rgba(0,0,0,0.05)';
    g.fillRect(0, (H / stripes) * i, W, H / stripes);
  }

  const margin = 60;
  const x0 = margin;
  const x1 = W - margin;
  const y0 = margin;
  const y1 = H - margin;

  g.strokeStyle = lineColor;
  g.lineWidth = 6;

  // Boundary
  g.strokeRect(x0, y0, x1 - x0, y1 - y0);

  // Halfway line
  g.beginPath();
  g.moveTo(x0, H / 2);
  g.lineTo(x1, H / 2);
  g.stroke();

  // Centre circle
  const r = (x1 - x0) * 0.22;
  g.beginPath();
  g.arc(W / 2, H / 2, r, 0, Math.PI * 2);
  g.stroke();

  // The brand, inside the circle and under the spot.
  paintCentreMark(g, W, H, r, snow);

  // Centre spot
  g.fillStyle = lineColor;
  g.beginPath();
  g.arc(W / 2, H / 2, 8, 0, Math.PI * 2);
  g.fill();

  // Goal areas (top and bottom)
  const boxW = (x1 - x0) * 0.55;
  const boxD = (y1 - y0) * 0.16;
  g.strokeRect(W / 2 - boxW / 2, y0, boxW, boxD);
  g.strokeRect(W / 2 - boxW / 2, y1 - boxD, boxW, boxD);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

let grassTex: THREE.CanvasTexture | null = null;
let snowTex: THREE.CanvasTexture | null = null;
let pitchMat: THREE.MeshLambertMaterial | null = null;
let surroundMat: THREE.MeshBasicMaterial | null = null;

const SURROUND_BASE = 0x1e2a44;

export function buildPitch(scene: THREE.Scene): void {
  const width = PITCH_HALF_W * 2;
  const length = PITCH_HALF_L * 2;

  grassTex = makePitchTexture('grass');
  snowTex = makePitchTexture('snow');

  pitchMat = new THREE.MeshLambertMaterial({ map: grassTex });
  const pitch = new THREE.Mesh(new THREE.PlaneGeometry(width, length), pitchMat);
  pitch.rotation.x = -Math.PI / 2;
  pitch.receiveShadow = false;
  scene.add(pitch);

  // A darker surround so the arena reads as a stage. Made generous so the
  // camera never sees past the edge of the world.
  surroundMat = new THREE.MeshBasicMaterial({ color: SURROUND_BASE });
  const surround = new THREE.Mesh(
    new THREE.PlaneGeometry(width + 110, length + 110),
    surroundMat,
  );
  surround.rotation.x = -Math.PI / 2;
  surround.position.y = -0.02;
  scene.add(surround);

  // Goal frames + nets at both ends.
  buildGoal(scene, PITCH_HALF_L, 1);
  buildGoal(scene, -PITCH_HALF_L, -1);
}

/** Swap the pitch surface + tint for the chosen weather. */
export function setPitchTint(tint: number, snow: boolean): void {
  if (pitchMat) {
    pitchMat.map = snow ? snowTex : grassTex;
    pitchMat.color.setHex(snow ? 0xffffff : tint);
    pitchMat.needsUpdate = true;
  }
  if (surroundMat) {
    const c = new THREE.Color(SURROUND_BASE);
    if (snow) c.lerp(new THREE.Color(0x8ea6c4), 0.45);
    surroundMat.color.copy(c);
  }
}

function buildGoal(scene: THREE.Scene, z: number, dir: 1 | -1): void {
  const postMat = new THREE.MeshLambertMaterial({ color: 0xf4f4f4 });
  const postGeo = new THREE.BoxGeometry(0.16, GOAL_H, 0.16);
  const depth = 1.4;

  const left = new THREE.Mesh(postGeo, postMat);
  left.position.set(-GOAL_HALF_W, GOAL_H / 2, z);
  const right = new THREE.Mesh(postGeo, postMat);
  right.position.set(GOAL_HALF_W, GOAL_H / 2, z);
  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(GOAL_HALF_W * 2 + 0.16, 0.16, 0.16),
    postMat,
  );
  bar.position.set(0, GOAL_H, z);
  scene.add(left, right, bar);

  // Net — a translucent box behind the line.
  const net = new THREE.Mesh(
    new THREE.BoxGeometry(GOAL_HALF_W * 2, GOAL_H, depth),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
    }),
  );
  net.position.set(0, GOAL_H / 2, z + dir * (depth / 2));
  scene.add(net);
}
