// render/showcase.ts — the hero stage used by every menu screen.
//
// Puts ONE Viber on the pitch, big, lit and gently alive, then frames it so the
// DOM can layer game UI around it. This is what turns a character-select screen
// into "a footballer being presented before a match".
//
// Everything is deterministic apart from the idle motion, which is driven by
// wall-clock time passed in from the render loop.

import * as THREE from 'three';
import type { ViberDesign } from '../sim/roster';
import { createCharacter, CHARACTER_WORLD_HEIGHT, type CharacterRig } from './characters';

/** Horizontal extent of a figure including its arms, in world units. */
const FIGURE_WIDTH = 1.35;
/**
 * Where the figure stands: a few metres out from the far goal, so the posts
 * and net frame it. The camera always sits on the centre-spot side, which
 * means it looks in the +z direction and the goal lands behind the subject.
 */
const STAGE_Z = 9;
/** Figures are built facing +z; the camera sits on the −z side, so turn them. */
const BASE_YAW = Math.PI;

export interface ShowcaseOptions {
  /**
   * Where the figure's centre should land, as a fraction of the viewport
   * measured from the top. 0.5 is dead centre; 0.3 pushes it up the screen so
   * cards can sit underneath it.
   */
  screenFrac?: number;
  /** Fraction of the viewport height the figure should fill. */
  fill?: number;
}

interface Resolved {
  screenFrac: number;
  fill: number;
}

const DEFAULTS: Resolved = { screenFrac: 0.5, fill: 0.58 };

/** Soft radial falloff for the aura behind the figure. */
function auraTexture(): THREE.CanvasTexture {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.42)');
  grad.addColorStop(0.72, 'rgba(255,255,255,0.10)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class ShowcaseStage {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;

  private root: THREE.Group;
  private aura: THREE.Mesh;
  private auraMat: THREE.MeshBasicMaterial;
  private disc: THREE.Mesh;
  private discMat: THREE.MeshBasicMaterial;
  /** Coloured kicker behind the subject — the "spotlight" of the hero shot. */
  private rim: THREE.PointLight;

  private rig: CharacterRig | null = null;
  private opts: Resolved = { ...DEFAULTS };
  private t = 0;
  /** 0 → 1 entrance blend, so the figure springs in instead of popping. */
  private blend = 0;
  private active = false;
  /** Framing solved by `frame()`; the idle drift orbits around these. */
  private camY = 1.5;
  private lookY = 1.0;
  private camZ = 4;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.scene = scene;
    this.camera = camera;

    this.root = new THREE.Group();
    this.root.visible = false;
    scene.add(this.root);

    const tex = auraTexture();

    this.auraMat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.5,
    });
    this.aura = new THREE.Mesh(new THREE.PlaneGeometry(7.4, 7.4), this.auraMat);
    this.aura.position.set(0, CHARACTER_WORLD_HEIGHT * 0.52, STAGE_Z + 1.9);
    this.root.add(this.aura);

    this.discMat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.55,
    });
    this.disc = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 4.6), this.discMat);
    this.disc.rotation.x = -Math.PI / 2;
    this.disc.position.set(0, 0.04, STAGE_Z);
    this.root.add(this.disc);

    // A tight coloured kicker just behind the subject, so its silhouette
    // separates from the pitch instead of melting into the green.
    this.rim = new THREE.PointLight(0xffffff, 0, 16, 2);
    this.rim.position.set(0, CHARACTER_WORLD_HEIGHT * 0.7, STAGE_Z + 2.4);
    this.root.add(this.rim);
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Swap in a new Viber and (re)frame the camera. */
  show(design: ViberDesign, accent: number, opts: ShowcaseOptions = {}): void {
    this.opts = { ...DEFAULTS, ...opts };

    if (this.rig) {
      this.root.remove(this.rig.group);
      this.rig = null;
    }
    // No team colours here — this is a portrait, not a match.
    this.rig = createCharacter(design, accent, accent);
    this.rig.group.position.set(0, 0, STAGE_Z);
    this.root.add(this.rig.group);

    const tint = new THREE.Color(accent);
    this.auraMat.color.copy(tint);
    this.discMat.color.copy(tint);
    this.rim.color.copy(tint);
    this.rim.intensity = 9;

    this.active = true;
    this.root.visible = true;
    // Restart the entrance whenever the subject changes.
    this.blend = 0;
    this.frame();
  }

  hide(): void {
    this.active = false;
    this.root.visible = false;
    this.rim.intensity = 0;
  }

  /**
   * Recompute the camera so the figure lands where the DOM expects it.
   * Called on every show and on every resize — portrait phones have a much
   * narrower horizontal field of view, so the figure must back off to fit.
   */
  resize(): void {
    if (this.active) this.frame();
  }

  private frame(): void {
    const cam = this.camera;
    const vFov = THREE.MathUtils.degToRad(cam.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * cam.aspect);

    // Distance that makes the figure fill `fill` of the viewport height…
    const distV = CHARACTER_WORLD_HEIGHT / this.opts.fill / (2 * Math.tan(vFov / 2));
    // …and the distance that keeps it comfortably inside the width.
    const distH = FIGURE_WIDTH / 0.72 / (2 * Math.tan(hFov / 2));
    const dist = Math.max(distV, distH);

    const midY = CHARACTER_WORLD_HEIGHT / 2;
    // Looking below the figure pushes it up the frame (and vice versa).
    const theta = (0.5 - this.opts.screenFrac) * vFov;

    // Sit the camera above the figure's middle and look slightly down: a
    // heroic three-quarter view, and it keeps the giant head in proportion.
    this.camY = midY + CHARACTER_WORLD_HEIGHT * 0.30;
    this.lookY = midY - CHARACTER_WORLD_HEIGHT * 0.10 - dist * Math.tan(theta);
    // On the centre-spot side of the subject, so the goal frames it.
    this.camZ = STAGE_Z - dist;

    cam.position.set(0, this.camY, this.camZ);
    cam.lookAt(0, this.lookY, STAGE_Z);
  }

  /** Idle life. `dt` is real seconds; safe to call while inactive. */
  update(dt: number): void {
    if (!this.active || !this.rig) return;
    this.t += dt;

    // Spring the entrance: scale up and fade the aura in over ~0.4s.
    this.blend = Math.min(1, this.blend + dt * 3.2);
    const eased = 1 - Math.pow(1 - this.blend, 3);

    const rig = this.rig;
    const t = this.t;

    // Breathing + a slow sway, so the figure reads as alive, not a statue.
    rig.body.position.y = Math.sin(t * 1.7) * 0.035;
    rig.group.rotation.y = BASE_YAW + Math.sin(t * 0.55) * 0.13;
    this.root.scale.setScalar(0.93 + eased * 0.07);

    rig.armL.rotation.z = Math.sin(t * 1.4) * 0.12 + 0.04;
    rig.armR.rotation.z = -Math.sin(t * 1.4 + 0.6) * 0.12 - 0.04;
    rig.armL.rotation.x = Math.sin(t * 1.1) * 0.06;
    rig.armR.rotation.x = -Math.sin(t * 1.1 + 0.4) * 0.06;

    rig.head.rotation.y = Math.sin(t * 0.42) * 0.10;
    rig.head.rotation.z = Math.sin(t * 0.9) * 0.025;

    // A gentle weight shift between the feet.
    rig.legL.rotation.x = Math.sin(t * 0.7) * 0.04;
    rig.legR.rotation.x = -Math.sin(t * 0.7) * 0.04;

    this.auraMat.opacity = (0.46 + Math.sin(t * 0.8) * 0.09) * eased;
    this.discMat.opacity = (0.5 + Math.sin(t * 1.1 + 1) * 0.08) * eased;
    this.aura.scale.setScalar(0.94 + eased * 0.06);

    // Ambient camera drift — the world breathes behind the UI. The framing
    // solved in `frame()` is preserved; only a small lateral offset is added.
    const drift = Math.sin(t * 0.17);
    this.camera.position.set(drift * 0.4, this.camY, this.camZ);
    this.camera.lookAt(drift * 0.14, this.lookY, STAGE_Z);
  }
}
