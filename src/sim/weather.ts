// sim/weather.ts — pitch conditions. Pure data + a lookup. The sim reads the
// modifiers; the renderer reads the visual fields. No Three.js / DOM here.

import type { WeatherKind } from './types';

/** Multipliers applied by the simulation. 1 = neutral. */
export interface WeatherMods {
  /** Ground rolling friction (higher = ball stops sooner). */
  ballFriction: number;
  /** Player acceleration. */
  accel: number;
  /** How fast players can turn (ice = sluggish). */
  turnRate: number;
  /** Top speed. */
  maxSpeed: number;
  /** Shot inaccuracy (higher = wilder). */
  shotSpread: number;
}

export interface WeatherDef {
  kind: WeatherKind;
  name: string;
  blurb: string;
  /** Short tag shown on the selection card. */
  tag: string;
  mods: WeatherMods;
  // --- Presentation only (consumed by render/) ---
  sky: number;
  fog: number;
  /** Fog start / end distance. Shorter = heavier air. */
  fogNear: number;
  fogFar: number;
  groundTint: number;
  ambient: number;
  sunIntensity: number;
  precipitation: 'none' | 'rain' | 'snow';
}

export const WEATHERS: Record<WeatherKind, WeatherDef> = {
  sun: {
    kind: 'sun',
    name: 'SUNNY',
    blurb: 'Dry, fast pitch. Clean touches and true bounces.',
    tag: 'Fast surface',
    mods: { ballFriction: 0.92, accel: 1.06, turnRate: 1.06, maxSpeed: 1.03, shotSpread: 0.92 },
    sky: 0x5fa8ff,
    fog: 0x9fd0ff,
    fogNear: 45,
    fogFar: 120,
    groundTint: 0xffffff,
    ambient: 1.1,
    sunIntensity: 1.25,
    precipitation: 'none',
  },
  rain: {
    kind: 'rain',
    name: 'RAINY',
    blurb: 'Wet and slick. The ball skids away and turns get loose.',
    tag: 'Slick ball',
    mods: { ballFriction: 0.72, accel: 0.94, turnRate: 0.92, maxSpeed: 0.98, shotSpread: 1.12 },
    sky: 0x3a4658,
    fog: 0x4a5668,
    fogNear: 30,
    fogFar: 88,
    groundTint: 0x9fb0c0,
    ambient: 0.72,
    sunIntensity: 0.55,
    precipitation: 'rain',
  },
  ice: {
    kind: 'ice',
    name: 'ICY',
    blurb: 'Frozen ground. Nobody can stop — or turn — in a hurry.',
    tag: 'No grip',
    mods: { ballFriction: 0.42, accel: 0.8, turnRate: 0.6, maxSpeed: 0.96, shotSpread: 1.22 },
    sky: 0xbfe0f2,
    fog: 0xdcefff,
    fogNear: 34,
    fogFar: 96,
    groundTint: 0xdff0ff,
    ambient: 0.95,
    sunIntensity: 0.85,
    precipitation: 'snow',
  },
  cold: {
    kind: 'cold',
    name: 'COLD',
    blurb: 'Freezing air. Heavy legs and slow, grinding play.',
    tag: 'Heavy legs',
    mods: { ballFriction: 1.08, accel: 0.86, turnRate: 0.9, maxSpeed: 0.94, shotSpread: 1.04 },
    sky: 0x6b7a90,
    fog: 0x8794a8,
    fogNear: 42,
    fogFar: 110,
    groundTint: 0xcfd8e0,
    ambient: 0.85,
    sunIntensity: 0.7,
    precipitation: 'none',
  },
};

export const WEATHER_ORDER: WeatherKind[] = ['sun', 'rain', 'ice', 'cold'];

export function weatherMods(kind: WeatherKind): WeatherMods {
  return WEATHERS[kind].mods;
}
