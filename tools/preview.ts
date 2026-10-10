// tools/preview.ts — dev-only harness. Renders the whole roster on a plain
// backdrop with the same lights as the match, so the character art can be
// eyeballed without running the game. Bundled by tools/shot.sh, never shipped.

import * as THREE from 'three';
import { ROSTER } from '../src/sim/roster';
import { createCharacter } from '../src/render/characters';

const params = new URLSearchParams(location.search);
const scale = Number(params.get('scale') ?? '1');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(2);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf2e6d4);

const camera = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 0.1, 400);

// Same lights as render/renderer.ts
scene.add(new THREE.HemisphereLight(0xdce8ff, 0x3a4a6a, 0.62));
const sun = new THREE.DirectionalLight(0xfff2d8, 1.3);
sun.position.set(-12, 26, 10);
scene.add(sun);
const rim = new THREE.DirectionalLight(0x9ec0ff, 0.3);
rim.position.set(14, 12, -18);
scene.add(rim);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshLambertMaterial({ color: 0xe9dcc6 }),
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const COLS = Number(params.get('cols') ?? '7');
const GAP_X = 2.8;
// Rows need to be far enough apart that a low camera does not stack them.
const GAP_Z = 6.0;

ROSTER.forEach((v, i) => {
  const rig = createCharacter(v.design, 0x2f6df6, 0xffffff);
  const cx = ((i % COLS) - (COLS - 1) / 2) * GAP_X;
  const cz = Math.floor(i / COLS) * GAP_Z;
  rig.group.position.set(cx, 0, cz);
  rig.group.scale.setScalar(scale);
  rig.group.rotation.y = 0.62;
  scene.add(rig.group);
});

// Frame the whole grid.
const rows = Math.ceil(ROSTER.length / COLS);
const centreZ = ((rows - 1) * GAP_Z) / 2;
const spanW = COLS * GAP_X;
const spanD = rows * GAP_Z;
const need = Math.max(spanW / camera.aspect, spanD) * 1.15;
const dist = need / 2 / Math.tan((camera.fov * Math.PI) / 360);
camera.position.set(0, dist * 0.45, centreZ + dist * 0.9);
camera.lookAt(0, 1.0, centreZ);

renderer.render(scene, camera);
(window as unknown as { __ready: boolean }).__ready = true;
