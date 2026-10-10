// render/renderer.ts — Three.js presentation of the sim world.
// Reads the sim (never writes to it), interpolates, and draws.

import * as THREE from 'three';
import { BALL_RADIUS, GOAL_PAUSE, PITCH_HALF_L } from '../sim/constants';
import { ROSTER_BY_ID, type ViberDesign } from '../sim/roster';
import { WEATHERS } from '../sim/weather';
import type { WeatherKind, World } from '../sim/types';
import {
  animateRig,
  applyCelebration,
  celebrationWeight,
  createCharacter,
  type CharacterRig,
} from './characters';
import { buildPitch, setPitchTint } from './pitch';
import { buildStadium, setStadiumTheme, updateStadium } from './stadium';
import { ShowcaseStage, type ShowcaseOptions } from './showcase';

/** sim (x, y) -> world (x = y, z = x). Length runs up the screen (portrait-friendly). */
const toWorldX = (simY: number) => simY;
const toWorldZ = (simX: number) => simX;

const CAM_HEIGHT = 25;
const CAM_BACK = 29;

/**
 * Where the camera goes for a goal. From the full-pitch rig the celebration
 * happens a few dozen units away and reads as a handful of pixels, which
 * defeats the point of animating it — so a goal pushes in on the box.
 */
const GOAL_CAM_HEIGHT = 8;
const GOAL_CAM_BACK = 11;

/**
 * A portrait viewport is narrow. The same push-in that frames the group in
 * landscape crops the near Vibers clean out of shot, so pull back a little.
 */
const NARROW_MIN = 1;
const NARROW_MAX = 1.15;
const CAM_FOV = 48;

/**
 * How brightly the floodlights burn in each weather. Daylight barely needs
 * them; rain and the frozen pitches want the drama.
 */
const LAMP_STRENGTH: Record<WeatherKind, number> = {
  sun: 0.16,
  rain: 0.58,
  ice: 0.44,
  cold: 0.62,
};

interface Particle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
}

/**
 * The ring under a player's feet, plus the arrow that floats over the one the
 * human is currently controlling.
 *
 * Colour is the ownership contract: the human's five always wear Viber lime,
 * the CPU always wears a hot crimson. Neither is ever the other, so "whose is
 * that?" is answered at a glance even in a goalmouth scramble.
 */
interface PlayerMarker {
  ring: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  halo: THREE.Mesh;
  haloMat: THREE.MeshBasicMaterial;
  arrow: THREE.Mesh;
  arrowMat: THREE.MeshBasicMaterial;
  team: 0 | 1;
}

/** The human's ring — the brand lime, matching --lime in the UI. */
const OWN_LIME = 0xdff902;
/** The CPU's ring — deliberately hot and never lime. */
const OWN_CPU = 0xff2d55;
const RING_INNER = 0.62;
const RING_OUTER = 0.84;
/** Height of the controlled-player arrow above the ground. */
const ARROW_Y = 3.05;

export class MatchRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  private rigs: CharacterRig[] = [];
  private markers: PlayerMarker[] = [];
  private ballMesh!: THREE.Mesh;
  private ballShadow!: THREE.Mesh;
  private hemi!: THREE.HemisphereLight;
  private sun!: THREE.DirectionalLight;
  private rim!: THREE.DirectionalLight;
  private camZ = 0;
  private camBack = CAM_BACK;
  private camHeight = CAM_HEIGHT;
  private particles: Particle[] = [];
  private particlePool: THREE.Mesh[] = [];
  private weather: WeatherKind = 'sun';
  private precip: THREE.Points | null = null;
  private precipVel: Float32Array | null = null;
  private precipCount = 0;
  private precipIsSnow = false;
  /** The menu hero stage — one Viber, framed for the DOM to build around. */
  private showcase: ShowcaseStage;
  /** Seconds since start — drives the marker pulse. Never read by the sim. */
  private elapsed = 0;
  /** The player the human is controlling, and the flash when that changes. */
  private controlledId = -1;
  private switchFlash = 0;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(WEATHERS.sun.sky);
    // Fog hides the hard edge of the world and gives the far end of the pitch
    // somewhere to go. Distances come from the weather preset.
    this.scene.fog = new THREE.Fog(WEATHERS.sun.fog, WEATHERS.sun.fogNear, WEATHERS.sun.fogFar);

    this.camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 0.5, 200);
    this.camera.position.set(0, CAM_HEIGHT, CAM_BACK);

    this.buildLights();
    buildPitch(this.scene);
    buildStadium(this.scene);
    this.buildBall();
    this.showcase = new ShowcaseStage(this.scene, this.camera);
    this.resize();
  }

  private buildLights(): void {
    // Flat, clean key light + soft sky fill. No toon banding — the forms read
    // from their black edge outlines, not from shading steps.
    this.hemi = new THREE.HemisphereLight(0xdce8ff, 0x3a4a6a, 0.62);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff2d8, 1.3);
    this.sun.position.set(-12, 26, 10);
    this.scene.add(this.sun);
    this.rim = new THREE.DirectionalLight(0x9ec0ff, 0.3);
    this.rim.position.set(14, 12, -18);
    this.scene.add(this.rim);
  }

  private buildBall(): void {
    const geo = new THREE.SphereGeometry(BALL_RADIUS, 16, 12);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.ballMesh = new THREE.Mesh(geo, mat);
    const outline = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: 0x14161a, side: THREE.BackSide }),
    );
    outline.scale.setScalar(1.09);
    this.ballMesh.add(outline);
    this.scene.add(this.ballMesh);

    this.ballShadow = new THREE.Mesh(
      new THREE.CircleGeometry(BALL_RADIUS * 1.5, 12),
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.25,
        depthWrite: false,
      }),
    );
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.ballShadow.position.y = 0.03;
    this.scene.add(this.ballShadow);
  }

  /** Build one rig per player (called once, after the world exists). */
  bindWorld(world: World): void {
    this.hideShowcase();
    for (const rig of this.rigs) this.scene.remove(rig.group);
    this.rigs = [];
    this.clearMarkers();
    this.controlledId = -1;

    for (const p of world.players) {
      const design = ROSTER_BY_ID[p.viber]?.design;
      const team = world.teams[p.team];
      if (!design) continue;
      const rig = createCharacter(design, team.color, team.accent);
      this.scene.add(rig.group);
      this.rigs.push(rig);
      this.markers.push(this.buildMarker(p.team));
    }
    this.setMatchVisible(true);
    this.applyWeather(world.weather);
  }

  /** One ownership ring + controlled-player arrow. */
  private buildMarker(team: 0 | 1): PlayerMarker {
    const colour = team === 0 ? OWN_LIME : OWN_CPU;

    const ringMat = new THREE.MeshBasicMaterial({
      color: colour,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(RING_INNER, RING_OUTER, 30), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.045;
    ring.renderOrder = 2;
    this.scene.add(ring);

    // The soft halo that only the controlled player shows.
    const haloMat = new THREE.MeshBasicMaterial({
      color: colour,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const halo = new THREE.Mesh(new THREE.RingGeometry(RING_OUTER, RING_OUTER + 0.3, 30), haloMat);
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.04;
    halo.renderOrder = 1;
    this.scene.add(halo);

    const arrowMat = new THREE.MeshBasicMaterial({
      color: colour,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.36, 0.66, 4), arrowMat);
    arrow.rotation.x = Math.PI; // point down at the player
    arrow.position.y = ARROW_Y;
    arrow.renderOrder = 3;
    this.scene.add(arrow);

    return { ring, ringMat, halo, haloMat, arrow, arrowMat, team };
  }

  private clearMarkers(): void {
    for (const m of this.markers) {
      this.scene.remove(m.ring, m.halo, m.arrow);
      m.ring.geometry.dispose();
      m.halo.geometry.dispose();
      m.arrow.geometry.dispose();
      m.ringMat.dispose();
      m.haloMat.dispose();
      m.arrowMat.dispose();
    }
    this.markers = [];
  }

  /**
   * Which of the human's players is "theirs" right now: whoever has the ball if
   * it is ours, otherwise the one closest to it. Derived from sim state — the
   * renderer never writes back.
   */
  private controlledPlayer(world: World): number {
    const b = world.ball;
    if (b.owner !== null) {
      const owner = world.players.find((p) => p.id === b.owner);
      if (owner && owner.team === 0) return owner.id;
    }
    let best = -1;
    let bd = Infinity;
    for (const p of world.players) {
      if (p.team !== 0 || p.isGK) continue;
      const dx = p.pos.x - b.pos.x;
      const dy = p.pos.y - b.pos.y;
      const d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        best = p.id;
      }
    }
    return best;
  }

  /** Hide every match actor so a menu hero has the pitch to itself. */
  private setMatchVisible(v: boolean): void {
    for (const rig of this.rigs) rig.group.visible = v;
    for (const m of this.markers) {
      m.ring.visible = v;
      m.halo.visible = v;
      m.arrow.visible = v;
    }
    this.ballMesh.visible = v;
    this.ballShadow.visible = v;
  }

  /* --------------------------- hero showcase --------------------------- */

  /** Put one Viber on the pitch, framed for the menu UI around it. */
  enterShowcase(design: ViberDesign, accent: number, opts?: ShowcaseOptions): void {
    this.setMatchVisible(false);
    this.showcase.show(design, accent, opts);
  }

  hideShowcase(): void {
    this.showcase.hide();
    this.setMatchVisible(true);
  }

  get showcaseActive(): boolean {
    return this.showcase.isActive;
  }

  /** Recolour the scene for the chosen conditions. */
  applyWeather(kind: WeatherKind): void {
    this.weather = kind;
    const w = WEATHERS[kind];
    (this.scene.background as THREE.Color).setHex(w.sky);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.setHex(w.fog);
    fog.near = w.fogNear;
    fog.far = w.fogFar;
    this.hemi.intensity = w.ambient;
    this.sun.intensity = w.sunIntensity;
    this.rim.intensity = w.precipitation === 'none' ? 0.3 : 0.18;
    setPitchTint(w.groundTint, w.precipitation === 'snow');
    setStadiumTheme(w.sky, w.fog, LAMP_STRENGTH[kind]);
    this.buildPrecipitation(kind);
  }

  /* ------------------------ precipitation ------------------------ */

  private buildPrecipitation(kind: WeatherKind): void {
    if (this.precip) {
      this.scene.remove(this.precip);
      this.precip.geometry.dispose();
      (this.precip.material as THREE.Material).dispose();
      this.precip = null;
      this.precipVel = null;
    }
    const def = WEATHERS[kind];
    if (def.precipitation === 'none') return;

    const isSnow = def.precipitation === 'snow';
    const count = isSnow ? 340 : 560;
    const pos = new Float32Array(count * 3);
    const vel = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 64;
      pos[i * 3 + 1] = Math.random() * 26;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 64;
      vel[i] = isSnow ? 2 + Math.random() * 1.6 : 22 + Math.random() * 12;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: isSnow ? 0xffffff : 0xaecbe8,
      size: isSnow ? 0.2 : 0.12,
      transparent: true,
      opacity: isSnow ? 0.92 : 0.6,
      depthWrite: false,
    });
    this.precip = new THREE.Points(geo, mat);
    this.precipVel = vel;
    this.precipCount = count;
    this.precipIsSnow = isSnow;
    this.scene.add(this.precip);
  }

  private updatePrecipitation(dt: number): void {
    const p = this.precip;
    if (!p || !this.precipVel) return;
    const attr = p.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const cx = this.camera.position.x;
    const cz = this.camera.position.z;
    for (let i = 0; i < this.precipCount; i++) {
      arr[i * 3 + 1] -= this.precipVel[i] * dt;
      if (!this.precipIsSnow) arr[i * 3] -= 1.8 * dt; // wind slant
      if (arr[i * 3 + 1] < 0) {
        arr[i * 3 + 1] = 24 + Math.random() * 4;
        arr[i * 3] = cx + (Math.random() - 0.5) * 60;
        arr[i * 3 + 2] = cz + (Math.random() - 0.5) * 60;
      }
    }
    attr.needsUpdate = true;
  }

  resize(): void {
    const el = this.renderer.domElement.parentElement;
    const w = el?.clientWidth || window.innerWidth;
    const h = el?.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.showcase.resize();
  }

  sync(world: World, _alpha: number): void {
    // ---- ownership indicators ----
    const controlled = this.controlledPlayer(world);
    if (controlled !== this.controlledId) {
      this.controlledId = controlled;
      this.switchFlash = 0.32; // animate the handover
    }
    if (this.switchFlash > 0) this.switchFlash -= 1 / 60;

    /*
     * A short celebration for the side that just scored. The sim's own goal
     * timer is the clock, so it stays in step with the replay, is deterministic
     * under test, and freezes along with everything else when paused.
     *
     * Goals are scored in the box, so the celebrating players are already the
     * ones the camera is looking at — no repositioning, no writing to the sim.
     */
    const goalT = world.phase === 'goal' ? GOAL_PAUSE - world.phaseTimer : -1;
    const goalK = celebrationWeight(goalT);
    const celebrating = goalK > 0 ? world.lastGoalTeam : null;

    // Players
    for (let i = 0; i < world.players.length; i++) {
      const p = world.players[i];
      const rig = this.rigs[i];
      if (!rig) continue;
      rig.group.position.set(toWorldX(p.pos.y), 0, toWorldZ(p.pos.x));
      rig.group.rotation.y = p.facing;
      animateRig(rig, p.animPhase, p.speedNorm);
      if (celebrating !== null && p.team === celebrating) {
        applyCelebration(rig, goalT, p.id, goalK);
      }

      const m = this.markers[i];
      if (!m) continue;
      const wx = toWorldX(p.pos.y);
      const wz = toWorldZ(p.pos.x);
      const isMine = p.id === controlled;

      // The handover flash: the ring snaps wide and settles.
      const flash = this.switchFlash > 0 ? this.switchFlash / 0.32 : 0;
      const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * 5.5);

      m.ring.position.set(wx, 0.045, wz);
      m.halo.position.set(wx, 0.04, wz);
      m.arrow.position.set(wx, ARROW_Y + Math.sin(this.elapsed * 4.2) * 0.12, wz);
      m.arrow.rotation.y = this.elapsed * 1.4;

      if (isMine) {
        // The controlled player: a strong ring, a breathing halo, an arrow.
        m.ring.scale.setScalar(1.18 + flash * 0.7);
        m.ringMat.opacity = 0.95;
        m.halo.scale.setScalar(1 + pulse * 0.16 + flash * 0.5);
        m.haloMat.opacity = 0.3 + pulse * 0.34 + flash * 0.5;
        m.arrowMat.opacity = 0.92;
      } else {
        m.ring.scale.setScalar(1);
        m.ringMat.opacity = p.team === 0 ? 0.44 : 0.4;
        m.halo.scale.setScalar(1);
        m.haloMat.opacity = 0;
        m.arrowMat.opacity = 0;
      }
    }

    // Ball
    const b = world.ball;
    this.ballMesh.position.set(toWorldX(b.pos.y), b.h, toWorldZ(b.pos.x));
    this.ballMesh.rotation.x += b.vel.y * 0.01;
    this.ballMesh.rotation.z -= b.vel.x * 0.01;
    this.ballShadow.position.set(toWorldX(b.pos.y), 0.03, toWorldZ(b.pos.x));

    // Camera sits behind the player's own goal looking up the pitch, so the
    // player attacks AWAY from the viewer (the natural reading direction).
    //
    // A goal pushes the camera in on the ball, which is sitting in the net where
    // the celebration is. From the full-pitch rig the celebration is a handful
    // of pixels at the far end, so without this the animation would be wasted.
    //
    // Deliberately NOT framed on the celebrating side's centroid: after a goal
    // the rest of the team is still strung out up to their own half, and
    // averaging would swing the camera away from the goal that was just scored.
    // The pitch margin relaxes too, or the clamp stops it short of the box.
    const margin = 6 - 3 * goalK;
    const targetZ = THREE.MathUtils.clamp(
      toWorldZ(b.pos.x),
      -PITCH_HALF_L + margin,
      PITCH_HALF_L - margin,
    );
    this.camZ += (targetZ - this.camZ) * 0.08;
    // Smoothing the rig here (rather than snapping to the celebration weight)
    // keeps the whip-in from reading as a glitch, and the pull-out is already
    // under way before the restart.
    const narrow = THREE.MathUtils.clamp(1 / this.camera.aspect, NARROW_MIN, NARROW_MAX);
    const wantBack = CAM_BACK + (GOAL_CAM_BACK * narrow - CAM_BACK) * goalK;
    const wantHeight = CAM_HEIGHT + (GOAL_CAM_HEIGHT - CAM_HEIGHT) * goalK;
    this.camBack += (wantBack - this.camBack) * 0.12;
    this.camHeight += (wantHeight - this.camHeight) * 0.12;
    this.camera.position.set(0, this.camHeight, this.camZ - this.camBack);
    this.camera.lookAt(0, 0, this.camZ + 2);

    this.updateParticles();
    this.updatePrecipitation(1 / 60);
  }

  private updateParticles(): void {
    const dt = 1 / 60;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      p.vel.y -= 18 * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      const t = Math.max(0, p.life / p.maxLife);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = t;
      p.mesh.scale.setScalar(0.4 + t * 0.6);
      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        this.particlePool.push(p.mesh);
        this.particles.splice(i, 1);
      }
    }
  }

  /** Confetti burst at a world position (goal celebration). */
  burst(x: number, z: number, color: number): void {
    for (let i = 0; i < 40; i++) {
      let mesh = this.particlePool.pop();
      if (!mesh) {
        mesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.16, 0.16, 0.16),
          new THREE.MeshBasicMaterial({ color, transparent: true }),
        );
      }
      (mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
      (mesh.material as THREE.MeshBasicMaterial).opacity = 1;
      mesh.position.set(x, 1 + Math.random() * 2, z);
      this.scene.add(mesh);
      const a = Math.random() * Math.PI * 2;
      const sp = 4 + Math.random() * 6;
      this.particles.push({
        mesh,
        vel: new THREE.Vector3(Math.cos(a) * sp * 0.5, 5 + Math.random() * 6, Math.sin(a) * sp),
        life: 1.6,
        maxLife: 1.6,
      });
    }
  }

  render(dt = 1 / 60): void {
    // The world is alive even when the match is not: the crowd breathes and
    // the floodlights shimmer behind every menu.
    this.elapsed += dt;
    updateStadium(dt);
    this.showcase.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.clearMarkers();
    this.renderer.dispose();
  }
}
