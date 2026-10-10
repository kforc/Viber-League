// audio/sound.ts — the match's sound, synthesized from scratch.
//
// WHY SYNTHESIS RATHER THAN FILES. The shipped game is one self-contained HTML
// file: tools/cdp/inline-build.mjs fails the build if any external reference
// survives into the bundle, so there is nowhere to fetch a whistle or a crowd
// recording from. Everything here is therefore built out of Web Audio
// primitives — noise buffers, oscillators and filters — which also means the
// sounds are tuned by numbers rather than by taste in an audio editor.
//
// BROWSERS BLOCK AUTOPLAY. An AudioContext created before the player has touched
// the page starts `suspended`, and every sound made on it is silently dropped.
// Nothing is built until `unlock()` is called from a real gesture (the KICK OFF
// tap), and every cue before that is a no-op. A browser without Web Audio gets
// the same no-ops rather than an exception.
//
// NOTHING IN HERE KNOWS ABOUT FOOTBALL. `src/app/game.ts` reads the sim's event
// stream and decides that a `shot` is a kick and a `save` is a glove; this module
// only knows how to make those noises.

import type { WhistleKind } from '../sim/types';

/* ------------------------------------------------------------------ */
/* Pure part — no AudioContext, testable in isolation                  */
/* ------------------------------------------------------------------ */

/** One blast of the whistle. */
export interface WhistleBlast {
  /** Seconds after the cue starts. */
  at: number;
  /** Seconds the blast is held. */
  dur: number;
  /** Fundamental in Hz; the pea trill rides on top of it. */
  hz: number;
}

/**
 * What the referee actually signals, per kind of stoppage.
 *
 * A whistle is a language: one blast starts play, two stop it for a moment, and
 * the long one at the end of the match is unmistakable. Getting these shapes
 * right matters more than the timbre — a player hears *which* whistle it is
 * before they hear how it sounds.
 */
export const WHISTLE_SCHEDULE: Record<WhistleKind, WhistleBlast[]> = {
  // Play on: one short, bright blast.
  kickoff: [{ at: 0, dur: 0.34, hz: 2140 }],
  // A goal: one blast, held a touch longer so it carries over the roar.
  goal: [{ at: 0, dur: 0.5, hz: 2200 }],
  // A foul: two short blasts — the universal "stop, I've given it".
  foul: [
    { at: 0, dur: 0.16, hz: 2060 },
    { at: 0.25, dur: 0.2, hz: 2110 },
  ],
  // Half time: two blasts, the second held.
  halftime: [
    { at: 0, dur: 0.2, hz: 2130 },
    { at: 0.3, dur: 0.38, hz: 2070 },
  ],
  // Full time: the long one. Nothing else in the match sounds like it.
  fulltime: [{ at: 0, dur: 1.15, hz: 2170 }],
};

/** Total seconds a cue occupies, including every blast in it. */
export function whistleDuration(kind: WhistleKind): number {
  return WHISTLE_SCHEDULE[kind].reduce((max, b) => Math.max(max, b.at + b.dur), 0);
}

/**
 * How excited the crowd is, as one number in 0..1.
 *
 * Kept pure and separate from the audio graph for two reasons: the *reaction* to
 * a shot is football logic and belongs where it can be reasoned about, and the
 * level has to keep falling while nothing is happening — a crowd that stays loud
 * after the moment has passed sounds broken.
 *
 * `excite()` is the jolt (a shot, a save, a goal); `step()` is the slow decay
 * back to the ambient bed plus however close the ball is to a goal.
 */
export class CrowdHeat {
  /** Instantaneous excitement, 0..1. Decays on its own. */
  private heat = 0;
  /** The floor: a crowd is never silent, just quiet. */
  static readonly AMBIENT = 0.2;
  /** How much of the level comes from the ball being up the pitch. */
  static readonly ADVANCE_WEIGHT = 0.42;
  /** Heat lost per second. 1.0 reaches the floor in under two seconds. */
  static readonly DECAY = 0.55;

  /** Nudge the crowd — a shot, a save, a corner. `amount` is the jolt. */
  excite(amount: number): void {
    this.heat = clamp01(this.heat + amount);
  }

  /** The current heat, without advancing time. */
  get current(): number {
    return this.heat;
  }

  /** Forget everything — used when a new match starts. */
  reset(): void {
    this.heat = 0;
  }

  /**
   * Advance by `dt` seconds and return the level for this frame.
   *
   * `ballAdvance` is 0 at the halfway line and 1 at a goal line, so the crowd
   * rises as the ball does. It is deliberately weighted below the event heat:
   * the ball sitting near a goal is a *murmur*, a shot is a *roar*.
   */
  step(dt: number, ballAdvance: number): number {
    this.heat = Math.max(0, this.heat - dt * CrowdHeat.DECAY);
    return clamp01(
      CrowdHeat.AMBIENT + clamp01(ballAdvance) * CrowdHeat.ADVANCE_WEIGHT + this.heat,
    );
  }
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/* ------------------------------------------------------------------ */
/* The engine                                                          */
/* ------------------------------------------------------------------ */

export interface SoundEngine {
  /** Resume the audio context. Call from a user gesture — nothing else works. */
  unlock(): void;
  /** True once the context is running, i.e. sounds will actually be heard. */
  readonly ready: boolean;
  /** The referee. `kind` picks the blast pattern. */
  whistle(kind: WhistleKind): void;
  /** The crowd erupting. The bed is raised separately, by `crowd()`. */
  goal(): void;
  /** Boot on ball — a shot. */
  kick(): void;
  /** A glove on the ball: a dull thud, nothing like a kick. */
  save(): void;
  /** How loud and excited the crowd bed is right now, 0..1. Call every frame. */
  crowd(level: number): void;
  setMuted(muted: boolean): void;
  dispose(): void;
}

/**
 * Create the engine. Cheap and side-effect free: no AudioContext is built until
 * `unlock()`, so this is safe to call at module scope in a test environment.
 */
export function createSoundEngine(): SoundEngine {
  return new SynthSound();
}

class SynthSound implements SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private muted = false;

  // The crowd bed, kept alive for the whole match.
  private crowdBus: GainNode | null = null;
  private crowdRumble: BiquadFilterNode | null = null;
  private crowdHiss: BiquadFilterNode | null = null;
  private crowdHissGain: GainNode | null = null;

  /** Last time each cue fired, for the rate limits below. */
  private readonly lastAt = new Map<string, number>();

  get ready(): boolean {
    return this.ctx?.state === 'running';
  }

  unlock(): void {
    // A muted game builds no audio graph at all. There is nothing to hear, and
    // an AudioContext is not free — it holds a thread and, on some platforms,
    // lights up the system's audio indicator. Turning sound back on calls this
    // again from the same gesture.
    if (this.muted) return;
    const ctx = this.ensure();
    if (!ctx) return;
    // `resume()` is a no-op when already running, and a promise we do not need
    // to await: the crowd bed starts immediately either way.
    if (ctx.state === 'suspended') void ctx.resume();
    if (!this.crowdBus) this.startCrowd();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    // A ramp, not a jump: cutting a running noise bed instantly clicks.
    this.master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.03);
  }

  /* ----------------------------- whistle ----------------------------- */

  whistle(kind: WhistleKind): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    // One referee, one whistle. Guards against a duplicated event turning a
    // single blast into a chord.
    if (!this.gate('whistle', 0.09)) return;
    const start = ctx.currentTime + 0.01;
    for (const b of WHISTLE_SCHEDULE[kind]) this.blast(start + b.at, b.dur, b.hz);
  }

  /**
   * One blast.
   *
   * Three ingredients, all of them necessary: the tone (a near-sine at ~2.1 kHz
   * plus its octave), the air rushing through the slot (band-passed noise at the
   * same frequency), and the pea rolling inside the chamber — a ~36 Hz amplitude
   * trill. Without the trill a whistle reads as a test tone; without the air it
   * reads as a synthesiser.
   */
  private blast(at: number, dur: number, hz: number): void {
    const ctx = this.ctx!;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.linearRampToValueAtTime(0.5, at + 0.009);
    env.gain.setValueAtTime(0.5, at + Math.max(0.012, dur - 0.035));
    env.gain.linearRampToValueAtTime(0.0001, at + dur);

    const trill = ctx.createGain();
    trill.gain.value = 0.72;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 36;
    const depth = ctx.createGain();
    depth.gain.value = 0.28;
    lfo.connect(depth).connect(trill.gain);

    const tone = ctx.createOscillator();
    tone.type = 'sine';
    tone.frequency.value = hz;
    const toneGain = ctx.createGain();
    toneGain.gain.value = 0.6;

    const octave = ctx.createOscillator();
    octave.type = 'sine';
    octave.frequency.value = hz * 2;
    const octaveGain = ctx.createGain();
    octaveGain.gain.value = 0.15;

    const air = ctx.createBufferSource();
    air.buffer = this.noiseBuffer();
    air.loop = true;
    const airFilter = ctx.createBiquadFilter();
    airFilter.type = 'bandpass';
    airFilter.frequency.value = hz;
    airFilter.Q.value = 5;
    const airGain = ctx.createGain();
    airGain.gain.value = 0.3;

    tone.connect(toneGain).connect(trill);
    octave.connect(octaveGain).connect(trill);
    air.connect(airFilter).connect(airGain).connect(trill);
    trill.connect(env).connect(this.master!);

    const stop = at + dur + 0.02;
    tone.start(at);
    tone.stop(stop);
    octave.start(at);
    octave.stop(stop);
    lfo.start(at);
    lfo.stop(stop);
    // A random offset into the noise, so no two blasts breathe identically.
    air.start(at, Math.random() * (air.buffer.duration - 0.01));
    air.stop(stop);
  }

  /* ------------------------------ goal ------------------------------- */

  /**
   * The roar.
   *
   * Not one sound but three bands of noise arriving together: a low swell for
   * the size of the crowd, a mid band that is the roar itself, and a brighter
   * one a moment later for the scream on top. A single band of filtered noise
   * sounds like static; three that grow at different speeds sound like people.
   */
  goal(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    if (!this.gate('goal', 0.5)) return;
    const t = ctx.currentTime;
    this.burst(t, { type: 'lowpass', hz: 250, q: 0.4, gain: 0.5, attack: 0.3, decay: 3.2 });
    this.burst(t, { type: 'bandpass', hz: 720, q: 0.5, gain: 0.85, attack: 0.07, decay: 2.7 });
    this.burst(t + 0.05, { type: 'bandpass', hz: 2100, q: 1.1, gain: 0.32, attack: 0.15, decay: 2.1 });
  }

  /* ------------------------------ ball ------------------------------- */

  /**
   * A shot.
   *
   * There is no power parameter because the sim does not report how hard the
   * ball was struck — every `shot` event is the same event. What varies instead
   * is the strike itself: the body is detuned a few percent each time, so twenty
   * shots in a match do not sound like one sample played twenty times.
   */
  kick(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    // A shot can emit two events in the same tick (a rebound); one thump is
    // enough, and a burst of them would read as a rattle.
    if (!this.gate('kick', 0.045)) return;
    const t = ctx.currentTime;
    const detune = 0.94 + Math.random() * 0.12;
    // The body: a sine dropping from ~190 Hz to 58 Hz in a tenth of a second.
    // That fast downward sweep is most of what makes a "thock" a thock.
    this.thump(t, 190 * detune, 58, 0.5, 0.16);
    // The click of the boot landing.
    this.burst(t, { type: 'highpass', hz: 1600, q: 0.7, gain: 0.15, attack: 0.002, decay: 0.05 });
  }

  save(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    if (!this.gate('save', 0.06)) return;
    const t = ctx.currentTime;
    // A glove absorbs the ball, so there is no click — a lower, softer thump and
    // heavily low-passed noise for the leather.
    this.thump(t, 150, 64, 0.42, 0.19);
    this.burst(t, { type: 'lowpass', hz: 760, q: 0.6, gain: 0.34, attack: 0.004, decay: 0.2 });
  }

  /* ------------------------------ crowd ------------------------------ */

  crowd(level: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.crowdBus) return;
    const l = clamp01(level);
    const t = ctx.currentTime;
    // setTargetAtTime, not a ramp: this runs every frame, and a per-frame ramp
    // would restart from wherever the previous one had got to.
    //
    // 0 really is silent. The floor a crowd never drops below is `CrowdHeat`'s
    // business, not the graph's — that way `crowd(0)` is a clean fade-out when
    // the player leaves the pitch.
    this.crowdBus.gain.setTargetAtTime(l * 0.75, t, 0.25);
    // An excited crowd is not just louder, it is *brighter* — the rumble opens
    // up and the hiss comes forward. Level alone sounds like a volume knob.
    this.crowdRumble?.frequency.setTargetAtTime(330 + l * 280, t, 0.4);
    this.crowdHiss?.frequency.setTargetAtTime(1050 + l * 950, t, 0.4);
    this.crowdHissGain?.gain.setTargetAtTime(0.16 + l * 0.52, t, 0.4);
  }

  /**
   * The bed the whole match sits on: two readers of the same pink-noise buffer,
   * one low-passed into a rumble and one band-passed into the air above it, plus
   * a very slow amplitude wobble so it breathes instead of hissing.
   */
  private startCrowd(): void {
    const ctx = this.ctx!;
    const master = this.master!;
    const buf = this.noiseBuffer();

    const rumbleSrc = ctx.createBufferSource();
    rumbleSrc.buffer = buf;
    rumbleSrc.loop = true;
    const rumble = ctx.createBiquadFilter();
    rumble.type = 'lowpass';
    rumble.frequency.value = 330;
    rumble.Q.value = 0.5;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0.9;

    const hissSrc = ctx.createBufferSource();
    hissSrc.buffer = buf;
    hissSrc.loop = true;
    const hiss = ctx.createBiquadFilter();
    hiss.type = 'bandpass';
    hiss.frequency.value = 1050;
    hiss.Q.value = 0.6;
    const hissGain = ctx.createGain();
    hissGain.gain.value = 0.16;

    // Starts silent; `crowd()` raises it. A bed that comes up from zero on the
    // kick-off tap is a swell rather than a switch.
    const bus = ctx.createGain();
    bus.gain.value = 0;

    const breath = ctx.createGain();
    breath.gain.value = 1;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.11;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.13;
    lfo.connect(lfoDepth).connect(breath.gain);

    rumbleSrc.connect(rumble).connect(rumbleGain).connect(bus);
    hissSrc.connect(hiss).connect(hissGain).connect(bus);
    bus.connect(breath).connect(master);

    rumbleSrc.start(0);
    // Half a buffer apart, so the two readers never phase-lock into a tone.
    hissSrc.start(0, buf.duration / 2);
    lfo.start();

    this.crowdBus = bus;
    this.crowdRumble = rumble;
    this.crowdHiss = hiss;
    this.crowdHissGain = hissGain;
  }

  /* ---------------------------- plumbing ----------------------------- */

  /** Build the context and the master chain on first use. */
  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (typeof window === 'undefined') return null;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : 1;
      // A goal roar is three noise bands at once on top of a running bed, which
      // clips a bare sum. The compressor is what stops it crackling.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.004;
      comp.release.value = 0.22;
      master.connect(comp).connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      return ctx;
    } catch {
      // No Web Audio (or it refused to start): every cue stays a no-op.
      return null;
    }
  }

  /** Three seconds of pink noise, built once and shared by every cue. */
  private noiseBuffer(): AudioBuffer {
    const ctx = this.ctx!;
    if (this.noise) return this.noise;
    const len = Math.floor(ctx.sampleRate * 3);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // Pink, not white: flat white reads as a hiss, and a crowd has more energy
    // low down. Kellet's filter bank is three one-poles and one multiply more.
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.16;
    }
    this.noise = buf;
    return buf;
  }

  /** A pitch-swept sine with a percussive envelope — the body of a thump. */
  private thump(at: number, hz0: number, hz1: number, gain: number, dur: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(hz0, at);
    osc.frequency.exponentialRampToValueAtTime(hz1, at + dur * 0.65);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(gain, at + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(g).connect(this.master!);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  /** A filtered burst of the shared noise, shaped by an attack/decay envelope. */
  private burst(
    at: number,
    o: {
      type: BiquadFilterType;
      hz: number;
      q: number;
      gain: number;
      attack: number;
      decay: number;
    },
  ): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer();
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = o.type;
    filter.frequency.value = o.hz;
    filter.Q.value = o.q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(o.gain, at + o.attack);
    // Exponential, not linear: a linear tail on noise audibly stops rather than
    // fades. The 0.0001 floor is because the curve cannot reach zero.
    g.gain.exponentialRampToValueAtTime(0.0001, at + o.attack + o.decay);
    src.connect(filter).connect(g).connect(this.master!);
    src.start(at, Math.random() * (src.buffer.duration - 0.01));
    src.stop(at + o.attack + o.decay + 0.05);
  }

  /** Rate limit per cue. Returns false when the cue fired too recently. */
  private gate(key: string, seconds: number): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    const t = ctx.currentTime;
    if (t - (this.lastAt.get(key) ?? -Infinity) < seconds) return false;
    this.lastAt.set(key, t);
    return true;
  }

  dispose(): void {
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.crowdBus = null;
    this.crowdRumble = null;
    this.crowdHiss = null;
    this.crowdHissGain = null;
    this.noise = null;
    this.lastAt.clear();
    // Closing the context stops every source on it, so there is nothing to
    // unplug by hand.
    ctx?.close().catch(() => {
      /* already closed */
    });
  }
}
