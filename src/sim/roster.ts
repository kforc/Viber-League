// sim/roster.ts — the Viber roster. Pure data: design spec + football attributes.
//
// The design vocabulary is taken straight from the reference art
// (~/Downloads/vibe-vibers-*.png). A Viber is:
//   * one GIANT box head — about 1.7x the torso width and half the total height
//   * a flat, overhanging head-top slab (or rods / antennae / ears / spikes)
//   * one of four face treatments: cubes | panel | plate | bar
//   * a small torso with a belt slab and a chest plate
//   * thin arms with light cuffs, short legs, big flat boots
//   * thick uniform black outlines on every edge

import type { Attributes, Role } from './types';
import { makeRng } from './core/rng';
import { CLUBS, OPPONENT_CLUBS, type ClubDef } from './content';

export type ViberRole = 'GK' | 'DEF' | 'MID' | 'FWD';

/** How the face is built. See `buildFace` in render/characters.ts. */
export type FaceStyle =
  /** Two bare cubes sitting on the head front (the simplest look). */
  | 'cubes'
  /** A large coloured plate holding two big white eyes with dark pupils. */
  | 'panel'
  /** A large black plate covering the front, with two small glowing eyes. */
  | 'plate'
  /** A dark plate with a single glowing horizontal bar (robot look). */
  | 'bar';

/** What sits on top of the head. */
export type HeadTop =
  | 'none'
  /** Wide overhanging slab + a raised block on top. */
  | 'flatslab'
  /** Flat slab + a small centred cube (graduation-cap look). */
  | 'mortar'
  /** A cluster of vertical rods of varying height. */
  | 'rods'
  /** One rod with a glowing bulb. */
  | 'antenna'
  /** Two blocks on the top corners. */
  | 'ears'
  /** A row of three spikes. */
  | 'spikes'
  /** One chunky centred block. */
  | 'block'
  /** A tall thin fin standing up behind the head. */
  | 'wing';

export interface ViberDesign {
  /** Main head box. */
  head: number;
  /** Head-top slab / rods / fin colour. */
  top: number;
  /** Face plate or panel colour (ignored by `cubes`). */
  face: number;
  eye: number;
  pupil: number;
  body: number;
  arm: number;
  leg: number;
  boot: number;
  /** Waist slab. */
  belt: number;
  /** Chest plate / trim. */
  accent: number;
  faceStyle: FaceStyle;
  headTop: HeadTop;
  /** Thin light strip above the eyes. */
  brow?: boolean;
  /** Multiplier on the already-large head. */
  headScale?: number;
  backpack?: boolean;
  /** A block trailing behind the body. */
  tail?: boolean;
  /** Translucent — the ghost. */
  ghost?: boolean;
}

export interface ViberCharacter {
  id: string;
  name: string;
  epithet: string;
  role: ViberRole;
  archetype: string;
  attrs: Attributes;
  special: { name: string; description: string };
  design: ViberDesign;
}

export const ROSTER: ViberCharacter[] = [
  {
    id: 'crimson',
    name: 'CRIMSON',
    epithet: 'The Anvil',
    role: 'FWD',
    archetype: 'Power',
    attrs: { pace: 62, strength: 95, shooting: 90, passing: 60, tackling: 72, technique: 70 },
    special: { name: 'Deep Strike', description: 'Explosive power surge across the team.' },
    design: {
      head: 0xd93a2b, top: 0x8a5ad0, face: 0x2a1a14, eye: 0xf0ece0, pupil: 0x1a1a1a,
      body: 0xd93a2b, arm: 0x8a5ad0, leg: 0xd93a2b, boot: 0xe8e2d0,
      belt: 0x6a5a3a, accent: 0x8a5ad0,
      faceStyle: 'panel', headTop: 'rods', brow: true, headScale: 1.04,
    },
  },
  {
    id: 'moss',
    name: 'MOSS',
    epithet: 'The Wall',
    role: 'DEF',
    archetype: 'Defensive',
    attrs: { pace: 54, strength: 88, shooting: 42, passing: 74, tackling: 94, technique: 60 },
    special: { name: 'Rooted', description: 'Locks down shape and smothers attacks.' },
    design: {
      head: 0x2a6a42, top: 0x2a6a42, face: 0x0f0f12, eye: 0xdff902, pupil: 0x0a0a0a,
      body: 0x2a6a42, arm: 0x1d4a2e, leg: 0x1d4a2e, boot: 0xe8e2d0,
      belt: 0x2a3035, accent: 0x8fd94a,
      faceStyle: 'plate', headTop: 'ears',
    },
  },
  {
    id: 'volt',
    name: 'VOLT',
    epithet: 'The Current',
    role: 'MID',
    archetype: 'Speed',
    attrs: { pace: 97, strength: 52, shooting: 76, passing: 72, tackling: 44, technique: 80 },
    special: { name: 'Overdrive', description: 'Blistering pace burst for the whole team.' },
    design: {
      head: 0xdfe23a, top: 0x2ad0c0, face: 0x141414, eye: 0x2ad0c0, pupil: 0x0a0a0a,
      body: 0xdfe23a, arm: 0x1a1a1e, leg: 0x1a1a1e, boot: 0xe8e2d0,
      belt: 0x2a2a2a, accent: 0x2ad0c0,
      faceStyle: 'cubes', headTop: 'antenna',
    },
  },
  {
    id: 'phantom',
    name: 'PHANTOM',
    epithet: 'The Ghost',
    role: 'MID',
    archetype: 'Trickster',
    attrs: { pace: 82, strength: 46, shooting: 70, passing: 92, tackling: 38, technique: 96 },
    special: { name: 'Vanish', description: 'Ghost through pressure and create chaos.' },
    design: {
      head: 0x9a8ad0, top: 0x9a8ad0, face: 0x0d0d10, eye: 0x8ac8ff, pupil: 0x0a0a0a,
      body: 0x1a1a1e, arm: 0x9a8ad0, leg: 0x1a1a1e, boot: 0x2a1840,
      belt: 0x3ad07a, accent: 0x9a8ad0,
      faceStyle: 'plate', headTop: 'none', ghost: true,
    },
  },
  {
    id: 'brick',
    name: 'BRICK',
    epithet: 'The Foreman',
    role: 'DEF',
    archetype: 'Power',
    attrs: { pace: 50, strength: 92, shooting: 48, passing: 66, tackling: 90, technique: 58 },
    special: { name: 'Hard Hat', description: 'Nothing gets past the site.' },
    design: {
      head: 0x8a5a3c, top: 0xe8e2d0, face: 0x2a1a14, eye: 0x0a0a0a, pupil: 0x0a0a0a,
      body: 0x8a5a3c, arm: 0x8a5a3c, leg: 0x2a2a2a, boot: 0xe8e2d0,
      belt: 0x6a5a3a, accent: 0xd93a2b,
      faceStyle: 'cubes', headTop: 'flatslab', brow: true,
    },
  },
  {
    id: 'neon',
    name: 'NEON',
    epithet: 'The Signal',
    role: 'MID',
    archetype: 'Engine',
    attrs: { pace: 80, strength: 62, shooting: 74, passing: 84, tackling: 60, technique: 78 },
    special: { name: 'Broadcast', description: 'Pings passes nobody else sees.' },
    design: {
      head: 0x2a3a9a, top: 0x2a3a9a, face: 0x8fe08a, eye: 0xf0ece0, pupil: 0x1a1a1a,
      body: 0x2a3a9a, arm: 0x2a3a9a, leg: 0x1a1a2a, boot: 0xe8e2d0,
      belt: 0xc8c0e0, accent: 0x8fe08a,
      faceStyle: 'panel', headTop: 'flatslab', brow: true,
    },
  },
  {
    id: 'frost',
    name: 'FROST',
    epithet: 'The Glacier',
    role: 'GK',
    archetype: 'Keeper',
    attrs: { pace: 48, strength: 78, shooting: 22, passing: 66, tackling: 88, technique: 72 },
    special: { name: 'Safe Hands', description: 'Sharpens reflexes between the posts.' },
    design: {
      head: 0xb8c8d8, top: 0xa8805a, face: 0x14161c, eye: 0x6fe3e0, pupil: 0x6fe3e0,
      body: 0xb8c8d8, arm: 0xb8c8d8, leg: 0x2a2a30, boot: 0x1a1a1a,
      belt: 0x6a5a3a, accent: 0xa8805a,
      faceStyle: 'bar', headTop: 'flatslab',
    },
  },
  {
    id: 'diesel',
    name: 'DIESEL',
    epithet: 'The Machine',
    role: 'DEF',
    archetype: 'Anchor',
    attrs: { pace: 58, strength: 90, shooting: 50, passing: 70, tackling: 92, technique: 62 },
    special: { name: 'Lockdown', description: 'Grinds the opposition to a halt.' },
    design: {
      head: 0x1a1a1e, top: 0x0d0d0d, face: 0x0a0a0a, eye: 0x8aff6a, pupil: 0x0a0a0a,
      body: 0x4a3020, arm: 0x1a1a1e, leg: 0x1a1a1e, boot: 0xe8e2d0,
      belt: 0x2a2a2a, accent: 0x8aff6a,
      faceStyle: 'plate', headTop: 'block', backpack: true,
    },
  },
  {
    id: 'ember',
    name: 'EMBER',
    epithet: 'The Spark',
    role: 'FWD',
    archetype: 'Poacher',
    attrs: { pace: 84, strength: 60, shooting: 92, passing: 58, tackling: 40, technique: 76 },
    special: { name: 'Flashpoint', description: 'Turns half a chance into a goal.' },
    design: {
      head: 0xd93a2b, top: 0xe8e2d0, face: 0xd8c69a, eye: 0x1a1a1a, pupil: 0x1a1a1a,
      body: 0xd93a2b, arm: 0xd93a2b, leg: 0x3a2a1a, boot: 0xe8e2d0,
      belt: 0x6a5a3a, accent: 0x8fd94a,
      faceStyle: 'cubes', headTop: 'flatslab', brow: true,
    },
  },
  {
    id: 'rusty',
    name: 'RUSTY',
    epithet: 'The Scrap',
    role: 'MID',
    archetype: 'Scrapper',
    attrs: { pace: 72, strength: 68, shooting: 66, passing: 76, tackling: 78, technique: 64 },
    special: { name: 'Second Ball', description: 'Wins everything that bounces loose.' },
    design: {
      head: 0xb09468, top: 0x14161c, face: 0xb09468, eye: 0x1a1a1a, pupil: 0x1a1a1a,
      body: 0xb09468, arm: 0x14161c, leg: 0x2a2a2a, boot: 0xe8e2d0,
      belt: 0x2a2a2a, accent: 0x2a6a42,
      faceStyle: 'cubes', headTop: 'mortar', brow: true,
    },
  },
  {
    id: 'cobalt',
    name: 'COBALT',
    epithet: 'The Captain',
    role: 'MID',
    archetype: 'Playmaker',
    attrs: { pace: 76, strength: 70, shooting: 72, passing: 94, tackling: 66, technique: 88 },
    special: { name: 'Armband', description: 'Steadies the whole side under pressure.' },
    design: {
      head: 0x34a2f7, top: 0x2a6ac0, face: 0x8fe08a, eye: 0xf0ece0, pupil: 0x1a1a1a,
      body: 0x34a2f7, arm: 0x34a2f7, leg: 0x1a4a30, boot: 0x111111,
      belt: 0x1a4a30, accent: 0x8fe08a,
      faceStyle: 'panel', headTop: 'flatslab', brow: true,
    },
  },
  {
    id: 'onyx',
    name: 'ONYX',
    epithet: 'The Broker',
    role: 'DEF',
    archetype: 'Sentinel',
    attrs: { pace: 60, strength: 84, shooting: 46, passing: 72, tackling: 90, technique: 66 },
    special: { name: 'Closed Shop', description: 'Shuts the door and keeps it shut.' },
    design: {
      head: 0x1a1a1e, top: 0x2a2a30, face: 0x0a0a0a, eye: 0x9dff8a, pupil: 0x0a0a0a,
      body: 0x2a2a30, arm: 0x1a1a1e, leg: 0x1a1a1e, boot: 0xe8e2d0,
      belt: 0x2a6a42, accent: 0x9dff8a,
      faceStyle: 'plate', headTop: 'none',
    },
  },
  {
    id: 'sage',
    name: 'SAGE',
    epithet: 'The Elder',
    role: 'MID',
    archetype: 'Metronome',
    attrs: { pace: 64, strength: 66, shooting: 68, passing: 90, tackling: 70, technique: 86 },
    special: { name: 'Tempo', description: 'Sets the rhythm nobody can break.' },
    design: {
      head: 0xa89a6a, top: 0xa89a6a, face: 0x141414, eye: 0xf0ece0, pupil: 0x1a1a1a,
      body: 0xa89a6a, arm: 0xa89a6a, leg: 0x2a2a2a, boot: 0xe8e2d0,
      belt: 0x6a5a3a, accent: 0x8a7a58,
      faceStyle: 'cubes', headTop: 'ears',
    },
  },
  {
    id: 'timber',
    name: 'TIMBER',
    epithet: 'The Logger',
    role: 'DEF',
    archetype: 'Enforcer',
    attrs: { pace: 56, strength: 94, shooting: 44, passing: 64, tackling: 93, technique: 56 },
    special: { name: 'Fell Them', description: 'Wins the ball and the man with it.' },
    design: {
      head: 0x4a2f1e, top: 0x14161c, face: 0x8fe08a, eye: 0xf0ece0, pupil: 0x1a1a1a,
      body: 0x4a2f1e, arm: 0x4a2f1e, leg: 0x2a2a2a, boot: 0xe8e2d0,
      belt: 0x6a5a3a, accent: 0xd95a2a,
      faceStyle: 'panel', headTop: 'mortar', brow: true,
    },
  },
  {
    id: 'blaze',
    name: 'BLAZE',
    epithet: 'The Furnace',
    role: 'FWD',
    archetype: 'Striker',
    attrs: { pace: 88, strength: 58, shooting: 94, passing: 62, tackling: 36, technique: 82 },
    special: { name: 'Firestorm', description: 'Runs hot and finishes everything.' },
    design: {
      head: 0x3a2418, top: 0xd93a2b, face: 0x0d0d0d, eye: 0xff8a3a, pupil: 0x0a0a0a,
      body: 0x3a2418, arm: 0x1a1a1e, leg: 0x1a1a1e, boot: 0xe8e2d0,
      belt: 0x6a2a1a, accent: 0xd93a2b,
      faceStyle: 'plate', headTop: 'spikes',
    },
  },
  {
    id: 'tundra',
    name: 'TUNDRA',
    epithet: 'The Deep Freeze',
    role: 'GK',
    archetype: 'Keeper',
    attrs: { pace: 52, strength: 74, shooting: 20, passing: 70, tackling: 86, technique: 78 },
    special: { name: 'Ice Wall', description: 'Freezes the game at the back.' },
    design: {
      head: 0x2a8a7a, top: 0x8a8a92, face: 0x121212, eye: 0x9dff8a, pupil: 0x0a0a0a,
      body: 0x2a8a7a, arm: 0x2a8a7a, leg: 0x1a1a1e, boot: 0xe8e2d0,
      belt: 0x2a3035, accent: 0x9dff8a,
      faceStyle: 'plate', headTop: 'block', brow: true,
    },
  },
  {
    id: 'granite',
    name: 'GRANITE',
    epithet: 'The Boulder',
    role: 'DEF',
    archetype: 'Rock',
    attrs: { pace: 54, strength: 96, shooting: 40, passing: 62, tackling: 91, technique: 52 },
    special: { name: 'Avalanche', description: 'Buries attackers under pure mass.' },
    design: {
      head: 0xb0b4bc, top: 0xf08a2a, face: 0x1a1a1a, eye: 0xf08a2a, pupil: 0x0a0a0a,
      body: 0xb0b4bc, arm: 0x6a6e78, leg: 0x6a6e78, boot: 0xe8e2d0,
      belt: 0x6a6e78, accent: 0xf08a2a,
      faceStyle: 'cubes', headTop: 'antenna',
    },
  },
  {
    id: 'quartz',
    name: 'QUARTZ',
    epithet: 'The Prism',
    role: 'GK',
    archetype: 'Keeper',
    attrs: { pace: 50, strength: 76, shooting: 24, passing: 68, tackling: 84, technique: 80 },
    special: { name: 'Refraction', description: 'Bends shots away from the goal.' },
    design: {
      head: 0xd8a088, top: 0xe8e2d0, face: 0x141414, eye: 0xff6a5a, pupil: 0x0a0a0a,
      body: 0xd8a088, arm: 0xd8a088, leg: 0x8a5a3c, boot: 0xe8e2d0,
      belt: 0x8a5a3c, accent: 0xff6a5a,
      faceStyle: 'plate', headTop: 'flatslab', brow: true,
    },
  },
  {
    id: 'amp',
    name: 'AMP',
    epithet: 'The Loudspeaker',
    role: 'MID',
    archetype: 'Winger',
    attrs: { pace: 90, strength: 48, shooting: 72, passing: 82, tackling: 42, technique: 88 },
    special: { name: 'Feedback', description: 'Deafening runs down the flank.' },
    design: {
      head: 0x7a4ab0, top: 0x5aa8ff, face: 0x7a4ab0, eye: 0xf0ece0, pupil: 0x1a1a1a,
      body: 0x7a4ab0, arm: 0x7a4ab0, leg: 0x5a3a8a, boot: 0xe8e2d0,
      belt: 0x5aa8ff, accent: 0x5aa8ff,
      faceStyle: 'cubes', headTop: 'wing', brow: true,
    },
  },
  // --- Bureau Roll (vibe-vibers-bureau-roll-*.png) -----------------------
  {
    id: 'beacon',
    name: 'BEACON',
    epithet: 'The Signal Tower',
    role: 'MID',
    archetype: 'Playmaker',
    attrs: { pace: 74, strength: 60, shooting: 70, passing: 90, tackling: 58, technique: 86 },
    special: { name: 'Signal Boost', description: 'Every pass finds the man nobody else saw.' },
    design: {
      head: 0x9aa0a8, top: 0x14161c, face: 0x8fe08a, eye: 0xf0ece0, pupil: 0x1a1a1a,
      body: 0x9aa0a8, arm: 0x9aa0a8, leg: 0x14161c, boot: 0x8fe08a,
      belt: 0x2a2a30, accent: 0x8fe08a,
      faceStyle: 'panel', headTop: 'antenna', brow: true,
    },
  },
  {
    id: 'warden',
    name: 'WARDEN',
    epithet: 'The Curfew',
    role: 'DEF',
    archetype: 'Anchor',
    attrs: { pace: 56, strength: 90, shooting: 44, passing: 68, tackling: 93, technique: 62 },
    special: { name: 'Lights Out', description: 'Nothing moves in his zone after dark.' },
    design: {
      head: 0x4a2f22, top: 0x14161c, face: 0x8fe08a, eye: 0xf0ece0, pupil: 0x1a1a1a,
      body: 0x4a2f22, arm: 0x3a241a, leg: 0x3a241a, boot: 0xe8e2d0,
      belt: 0x6a5a3a, accent: 0xd95a2a,
      faceStyle: 'panel', headTop: 'mortar', brow: true,
    },
  },
  {
    id: 'tangerine',
    name: 'TANGERINE',
    epithet: 'The Courier',
    role: 'FWD',
    archetype: 'Poacher',
    attrs: { pace: 86, strength: 58, shooting: 88, passing: 60, tackling: 40, technique: 78 },
    special: { name: 'Special Delivery', description: 'Arrives in the box a half-second early.' },
    design: {
      head: 0xd98a4a, top: 0xd98a4a, face: 0xff7a6a, eye: 0xf0ece0, pupil: 0x1a1a1a,
      body: 0xd98a4a, arm: 0xd98a4a, leg: 0x3a2f22, boot: 0xe8e2d0,
      belt: 0x1a1a1e, accent: 0xff7a6a,
      faceStyle: 'panel', headTop: 'none', backpack: true,
    },
  },
  {
    id: 'indigo',
    name: 'INDIGO',
    epithet: 'The Navigator',
    role: 'MID',
    archetype: 'Engine',
    attrs: { pace: 80, strength: 64, shooting: 72, passing: 86, tackling: 62, technique: 80 },
    special: { name: 'Deep Map', description: 'Charts a route through any midfield.' },
    design: {
      head: 0x2a2a8a, top: 0x3a3aa8, face: 0x8fe08a, eye: 0xf0ece0, pupil: 0x1a1a1a,
      body: 0x2a2a8a, arm: 0x2a2a8a, leg: 0x2a2a8a, boot: 0x14161c,
      belt: 0xc8c0e0, accent: 0x8fe08a,
      faceStyle: 'panel', headTop: 'flatslab', brow: true,
    },
  },
  {
    id: 'spruce',
    name: 'SPRUCE',
    epithet: 'The Tree Line',
    role: 'DEF',
    archetype: 'Rock',
    attrs: { pace: 54, strength: 92, shooting: 42, passing: 66, tackling: 91, technique: 58 },
    special: { name: 'Tree Line', description: 'Roots across the back and never gives ground.' },
    design: {
      head: 0x2a2a30, top: 0x1a4a2e, face: 0x8fe08a, eye: 0xf0ece0, pupil: 0x1a1a1a,
      body: 0x2a2a30, arm: 0x2a2a30, leg: 0x1a1a1e, boot: 0xc8c4b8,
      belt: 0x8a8a92, accent: 0x8fe08a,
      faceStyle: 'panel', headTop: 'antenna',
    },
  },
  {
    id: 'maroon',
    name: 'MAROON',
    epithet: 'The Bull',
    role: 'FWD',
    archetype: 'Power',
    attrs: { pace: 68, strength: 94, shooting: 88, passing: 58, tackling: 66, technique: 68 },
    special: { name: 'Charge', description: 'Lowers the shoulder and goes straight through.' },
    design: {
      head: 0xc0392b, top: 0x8a5ad0, face: 0x2a1a14, eye: 0x0a0a0a, pupil: 0x0a0a0a,
      body: 0xc0392b, arm: 0xc0392b, leg: 0x8a5ad0, boot: 0x8a5ad0,
      belt: 0x8a5ad0, accent: 0x8a5ad0,
      faceStyle: 'cubes', headTop: 'rods', tail: true,
    },
  },
  {
    id: 'split',
    name: 'SPLIT',
    epithet: 'The Two Minds',
    role: 'DEF',
    archetype: 'Sentinel',
    attrs: { pace: 62, strength: 86, shooting: 44, passing: 74, tackling: 89, technique: 68 },
    special: { name: 'Two Minds', description: 'Shows the winger one way, then takes the other.' },
    design: {
      head: 0x6a4a30, top: 0x6a4a30, face: 0x14161c, eye: 0x8fe08a, pupil: 0x8fe08a,
      body: 0xe8e4dc, arm: 0xe8e4dc, leg: 0xe8e4dc, boot: 0x1a1a1e,
      belt: 0x8a8a92, accent: 0x8fe08a,
      faceStyle: 'plate', headTop: 'ears',
    },
  },
  {
    id: 'souffle',
    name: 'SOUFFLE',
    epithet: 'The Rise',
    role: 'GK',
    archetype: 'Keeper',
    attrs: { pace: 50, strength: 78, shooting: 22, passing: 70, tackling: 88, technique: 76 },
    special: { name: 'Rise', description: 'Gets up higher than the crossbar allows.' },
    design: {
      head: 0xb8ccd8, top: 0xe8e2d0, face: 0xff9a4a, eye: 0xf0ece0, pupil: 0x1a1a1a,
      body: 0xb8ccd8, arm: 0xb8ccd8, leg: 0xe8e2d0, boot: 0x14161c,
      belt: 0x2a2a30, accent: 0xff9a4a,
      faceStyle: 'panel', headTop: 'flatslab',
    },
  },
  {
    id: 'medic',
    name: 'MEDIC',
    epithet: 'The Vital Sign',
    role: 'MID',
    archetype: 'Metronome',
    attrs: { pace: 66, strength: 70, shooting: 66, passing: 88, tackling: 72, technique: 84 },
    special: { name: 'Vital Signs', description: 'Keeps the whole side breathing.' },
    design: {
      head: 0xe8a888, top: 0x14161c, face: 0xe8a888, eye: 0x0a0a0a, pupil: 0x0a0a0a,
      body: 0xe8a888, arm: 0xe8a888, leg: 0xe8a888, boot: 0x1a1a1e,
      belt: 0xe8e4dc, accent: 0xc0392b,
      faceStyle: 'cubes', headTop: 'antenna',
    },
  },
  {
    id: 'visor',
    name: 'VISOR',
    epithet: 'The Blindside',
    role: 'MID',
    archetype: 'Winger',
    attrs: { pace: 88, strength: 56, shooting: 74, passing: 80, tackling: 46, technique: 84 },
    special: { name: 'Blindside', description: 'Gone before you can read the number.' },
    design: {
      head: 0xd9603f, top: 0x3a3a3a, face: 0x14161c, eye: 0x8fe08a, pupil: 0x8fe08a,
      body: 0xd9603f, arm: 0xd9603f, leg: 0xd9603f, boot: 0xe8e2d0,
      belt: 0xe8e2d0, accent: 0x2ad0c0,
      faceStyle: 'bar', headTop: 'ears', brow: true,
    },
  },
  {
    id: 'bubble',
    name: 'BUBBLE',
    epithet: 'The Soap',
    role: 'MID',
    archetype: 'Trickster',
    attrs: { pace: 84, strength: 48, shooting: 68, passing: 88, tackling: 40, technique: 92 },
    special: { name: 'Soap Bubble', description: 'The ball slides off him and into space.' },
    design: {
      head: 0xe08ac0, top: 0x8a6a4a, face: 0x14161c, eye: 0x8fe08a, pupil: 0x8fe08a,
      body: 0xe08ac0, arm: 0x8a6a4a, leg: 0xe08ac0, boot: 0xe8e2d0,
      belt: 0x6a5a3a, accent: 0x8fe08a,
      faceStyle: 'plate', headTop: 'ears',
    },
  },
  {
    id: 'rivet',
    name: 'RIVET',
    epithet: 'The Yard Boss',
    role: 'DEF',
    archetype: 'Enforcer',
    attrs: { pace: 58, strength: 92, shooting: 46, passing: 68, tackling: 92, technique: 60 },
    special: { name: 'Rivet Gun', description: 'Bolts attackers to the touchline.' },
    design: {
      head: 0xb8c4d0, top: 0xa8563a, face: 0x14161c, eye: 0x6fe3e0, pupil: 0x6fe3e0,
      body: 0xb8c4d0, arm: 0xb8c4d0, leg: 0xb8c4d0, boot: 0x14161c,
      belt: 0x8a4a30, accent: 0x6fe3e0,
      faceStyle: 'bar', headTop: 'flatslab',
    },
  },
  {
    id: 'chef',
    name: 'CHEF',
    epithet: 'The Hot Plate',
    role: 'FWD',
    archetype: 'Target Man',
    attrs: { pace: 62, strength: 88, shooting: 86, passing: 66, tackling: 48, technique: 74 },
    special: { name: 'Hot Plate', description: 'Serves up the scrappiest of chances.' },
    design: {
      head: 0xc0392b, top: 0xe8e2d0, face: 0xd8c69a, eye: 0x0a0a0a, pupil: 0x0a0a0a,
      body: 0xc0392b, arm: 0xc0392b, leg: 0x2a2a2a, boot: 0xe8e2d0,
      belt: 0x6a5a3a, accent: 0x8fd94a,
      faceStyle: 'cubes', headTop: 'mortar', brow: true,
    },
  },
  {
    id: 'fedora',
    name: 'FEDORA',
    epithet: 'The Read',
    role: 'DEF',
    archetype: 'Sweeper',
    attrs: { pace: 64, strength: 80, shooting: 40, passing: 84, tackling: 86, technique: 78 },
    special: { name: 'Read It', description: 'Intercepts the pass before it is played.' },
    design: {
      head: 0xa8aab0, top: 0xe8e2d0, face: 0xe8e2d0, eye: 0x1a1a1a, pupil: 0x1a1a1a,
      body: 0xa8aab0, arm: 0xa8aab0, leg: 0x8a8a92, boot: 0x14161c,
      belt: 0x8a6a4a, accent: 0x5a6a80,
      faceStyle: 'panel', headTop: 'mortar',
    },
  },
  {
    id: 'plum',
    name: 'PLUM',
    epithet: 'The Ripeness',
    role: 'MID',
    archetype: 'Playmaker',
    attrs: { pace: 72, strength: 64, shooting: 70, passing: 92, tackling: 58, technique: 90 },
    special: { name: 'Ripeness', description: 'Picks the exact moment to release it.' },
    design: {
      head: 0xd8a888, top: 0x7a8898, face: 0x9a6ae0, eye: 0xf0ece0, pupil: 0x1a1a1a,
      body: 0xd8a888, arm: 0xd8a888, leg: 0xd8a888, boot: 0x14161c,
      belt: 0x7a8898, accent: 0x9a6ae0,
      faceStyle: 'panel', headTop: 'flatslab',
    },
  },
  {
    id: 'amber',
    name: 'AMBER',
    epithet: 'The Ledger',
    role: 'MID',
    archetype: 'Captain',
    attrs: { pace: 74, strength: 72, shooting: 74, passing: 90, tackling: 70, technique: 86 },
    special: { name: 'Ledger', description: 'Balances the game to the last minute.' },
    design: {
      head: 0x9ad8b8, top: 0x14161c, face: 0x8aa8f0, eye: 0xf0ece0, pupil: 0x1a1a1a,
      body: 0x9ad8b8, arm: 0x9ad8b8, leg: 0x9ad8b8, boot: 0x14161c,
      belt: 0xe0a83a, accent: 0xe0a83a,
      faceStyle: 'panel', headTop: 'flatslab', brow: true,
    },
  },
  {
    id: 'seafoam',
    name: 'SEAFOAM',
    epithet: 'The Undertow',
    role: 'DEF',
    archetype: 'Anchor',
    attrs: { pace: 60, strength: 88, shooting: 42, passing: 72, tackling: 90, technique: 64 },
    special: { name: 'Undertow', description: 'Drags the attack back out to sea.' },
    design: {
      head: 0x9ad8c0, top: 0x14161c, face: 0x14161c, eye: 0xf0ece0, pupil: 0x1a1a1e,
      body: 0x9ad8c0, arm: 0x9ad8c0, leg: 0x9ad8c0, boot: 0x1a1a1e,
      belt: 0x2a3a8a, accent: 0x3a5ad0,
      faceStyle: 'bar', headTop: 'rods',
    },
  },
  {
    id: 'glider',
    name: 'GLIDER',
    epithet: 'The Glide Path',
    role: 'MID',
    archetype: 'Winger',
    attrs: { pace: 92, strength: 54, shooting: 72, passing: 82, tackling: 44, technique: 86 },
    special: { name: 'Glide Path', description: 'Lands the cross on a sixpence.' },
    design: {
      head: 0xd98a4a, top: 0xd98a4a, face: 0x14161c, eye: 0x8fe08a, pupil: 0x8fe08a,
      body: 0xd98a4a, arm: 0xd98a4a, leg: 0xd98a4a, boot: 0x14161c,
      belt: 0xe8e2d0, accent: 0x8fe08a,
      faceStyle: 'plate', headTop: 'ears', brow: true,
    },
  },
  {
    id: 'mauve',
    name: 'MAUVE',
    epithet: 'The Smoke Screen',
    role: 'MID',
    archetype: 'Trickster',
    attrs: { pace: 82, strength: 56, shooting: 70, passing: 86, tackling: 46, technique: 90 },
    special: { name: 'Smoke Screen', description: 'Disappears behind his own dummy.' },
    design: {
      head: 0x3a2418, top: 0x14161c, face: 0xa85a8a, eye: 0x8ac8ff, pupil: 0x1a1a2a,
      body: 0x3a2418, arm: 0x3a2418, leg: 0x3a2418, boot: 0x14161c,
      belt: 0x14161c, accent: 0xa85a8a,
      faceStyle: 'panel', headTop: 'antenna',
    },
  },
  {
    id: 'porter',
    name: 'PORTER',
    epithet: 'The Bellhop',
    role: 'DEF',
    archetype: 'Sentinel',
    attrs: { pace: 58, strength: 88, shooting: 44, passing: 74, tackling: 89, technique: 66 },
    special: { name: 'Bellhop', description: 'Carries attackers straight back out the door.' },
    design: {
      head: 0xb08a5a, top: 0x14161c, face: 0xb08a5a, eye: 0x0a0a0a, pupil: 0x0a0a0a,
      body: 0xb08a5a, arm: 0xb08a5a, leg: 0xb08a5a, boot: 0x1a1a1e,
      belt: 0x2a6a42, accent: 0x2a6a42,
      faceStyle: 'cubes', headTop: 'mortar', brow: true,
    },
  },
  {
    id: 'periscope',
    name: 'PERISCOPE',
    epithet: 'The Up Periscope',
    role: 'MID',
    archetype: 'Engine',
    attrs: { pace: 78, strength: 66, shooting: 70, passing: 88, tackling: 62, technique: 82 },
    special: { name: 'Up Periscope', description: 'Sees the whole pitch from one spot.' },
    design: {
      head: 0xe0b090, top: 0x6a5a48, face: 0x6fe3e0, eye: 0x6fe3e0, pupil: 0x6fe3e0,
      body: 0xe0b090, arm: 0xe0b090, leg: 0xe0b090, boot: 0xe8e2d0,
      belt: 0x7a4ab0, accent: 0x6fe3e0,
      faceStyle: 'panel', headTop: 'antenna',
    },
  },
  {
    id: 'honey',
    name: 'HONEY',
    epithet: 'The Sweet Spot',
    role: 'FWD',
    archetype: 'Poacher',
    attrs: { pace: 82, strength: 62, shooting: 90, passing: 62, tackling: 42, technique: 80 },
    special: { name: 'Sweet Spot', description: 'Sticks every rebound in the top corner.' },
    design: {
      head: 0xd9a02a, top: 0x14161c, face: 0x8fe08a, eye: 0xf0ece0, pupil: 0x1a1a1a,
      body: 0xd9a02a, arm: 0xd9a02a, leg: 0xd9a02a, boot: 0xc8c4b8,
      belt: 0xc8c4b8, accent: 0x8fe08a,
      faceStyle: 'panel', headTop: 'antenna',
    },
  },
  {
    id: 'scope',
    name: 'SCOPE',
    epithet: 'The Zero In',
    role: 'GK',
    archetype: 'Keeper',
    attrs: { pace: 48, strength: 76, shooting: 20, passing: 72, tackling: 86, technique: 82 },
    special: { name: 'Zero In', description: 'Reads the striker, not the ball.' },
    design: {
      head: 0xa8a8b0, top: 0x6a5a48, face: 0x14161c, eye: 0x8fe08a, pupil: 0x8fe08a,
      body: 0xa8a8b0, arm: 0xa8a8b0, leg: 0x6a5a48, boot: 0x8fe08a,
      belt: 0x6a5a48, accent: 0x8fe08a,
      faceStyle: 'bar', headTop: 'antenna',
    },
  },
  {
    id: 'sail',
    name: 'SAIL',
    epithet: 'The Trade Wind',
    role: 'DEF',
    archetype: 'Rock',
    attrs: { pace: 60, strength: 90, shooting: 44, passing: 70, tackling: 90, technique: 62 },
    special: { name: 'Trade Wind', description: 'Sweeps every cross away from the box.' },
    design: {
      head: 0x5a3a9a, top: 0x7aa8f0, face: 0x14161c, eye: 0xf0ece0, pupil: 0x1a1a1e,
      body: 0x5a3a9a, arm: 0x5a3a9a, leg: 0x5a3a9a, boot: 0xc8c4b8,
      belt: 0x7aa8f0, accent: 0x7aa8f0,
      faceStyle: 'bar', headTop: 'wing',
    },
  },
  {
    id: 'bracket',
    name: 'BRACKET',
    epithet: 'The Torque',
    role: 'DEF',
    archetype: 'Anchor',
    attrs: { pace: 56, strength: 90, shooting: 46, passing: 72, tackling: 91, technique: 64 },
    special: { name: 'Torque', description: 'Locks the defensive line in place.' },
    design: {
      head: 0x3a2418, top: 0xa8b0b8, face: 0x14161c, eye: 0xf0ece0, pupil: 0xf0ece0,
      body: 0x3a2418, arm: 0x3a2418, leg: 0x3a2418, boot: 0xa8b0b8,
      belt: 0x8a8a92, accent: 0xe8e2d0,
      faceStyle: 'bar', headTop: 'flatslab',
    },
  },
  {
    id: 'mustard',
    name: 'MUSTARD',
    epithet: 'The Slow Burn',
    role: 'MID',
    archetype: 'Metronome',
    attrs: { pace: 70, strength: 68, shooting: 72, passing: 88, tackling: 68, technique: 86 },
    special: { name: 'Slow Burn', description: 'Wears the opposition down, pass by pass.' },
    design: {
      head: 0xd9a02a, top: 0xd9a02a, face: 0x8fe08a, eye: 0xf0ece0, pupil: 0x1a1a1a,
      body: 0xd9a02a, arm: 0xd9a02a, leg: 0xe8e2d0, boot: 0x14161c,
      belt: 0x8a5ad0, accent: 0x8a5ad0,
      faceStyle: 'panel', headTop: 'flatslab', brow: true,
    },
  },
  {
    id: 'icicle',
    name: 'ICICLE',
    epithet: 'The Cold Snap',
    role: 'FWD',
    archetype: 'Striker',
    attrs: { pace: 90, strength: 56, shooting: 92, passing: 60, tackling: 38, technique: 82 },
    special: { name: 'Cold Snap', description: 'Freezes defenders with one touch.' },
    design: {
      head: 0xc8dce8, top: 0xc8dce8, face: 0xff9a4a, eye: 0xf0ece0, pupil: 0x1a1a1a,
      body: 0xc8dce8, arm: 0xc8dce8, leg: 0xc8dce8, boot: 0xe0a83a,
      belt: 0xe0a83a, accent: 0xff9a4a,
      faceStyle: 'panel', headTop: 'ears',
    },
  },
  {
    id: 'magnet',
    name: 'MAGNET',
    epithet: 'The Pull',
    role: 'DEF',
    archetype: 'Enforcer',
    attrs: { pace: 62, strength: 90, shooting: 48, passing: 70, tackling: 92, technique: 64 },
    special: { name: 'Pull', description: 'Every loose ball ends up at his feet.' },
    design: {
      head: 0xc0392b, top: 0x14161c, face: 0x8aa8f0, eye: 0xf0ece0, pupil: 0x1a1a1a,
      body: 0xc0392b, arm: 0xc0392b, leg: 0xc0392b, boot: 0xe8e2d0,
      belt: 0x2a3a8a, accent: 0x8aa8f0,
      faceStyle: 'panel', headTop: 'flatslab', brow: true,
    },
  },
  {
    id: 'azure',
    name: 'AZURE',
    epithet: 'The Clear Sky',
    role: 'MID',
    archetype: 'Playmaker',
    attrs: { pace: 76, strength: 66, shooting: 72, passing: 90, tackling: 62, technique: 88 },
    special: { name: 'Clear Sky', description: 'Opens up the pitch with one switch.' },
    design: {
      head: 0x3a9ad9, top: 0x3a9ad9, face: 0x8fe08a, eye: 0xf0ece0, pupil: 0x1a1a1a,
      body: 0x3a9ad9, arm: 0x3a9ad9, leg: 0x3a9ad9, boot: 0xe8e2d0,
      belt: 0x14161c, accent: 0x8fe08a,
      faceStyle: 'panel', headTop: 'flatslab',
    },
  },
  {
    id: 'moose',
    name: 'MOOSE',
    epithet: 'The Antlers',
    role: 'FWD',
    archetype: 'Target Man',
    attrs: { pace: 58, strength: 96, shooting: 84, passing: 60, tackling: 52, technique: 66 },
    special: { name: 'Antlers', description: 'Wins every header in the box.' },
    design: {
      head: 0x4a2f1e, top: 0x4a2f1e, face: 0x4a2f1e, eye: 0x0a0a0a, pupil: 0x0a0a0a,
      body: 0x4a2f1e, arm: 0x4a2f1e, leg: 0x4a2f1e, boot: 0xd97a3a,
      belt: 0xd97a3a, accent: 0xd97a3a,
      faceStyle: 'cubes', headTop: 'ears',
    },
  },
  {
    id: 'midnight',
    name: 'MIDNIGHT',
    epithet: 'The Blackout',
    role: 'DEF',
    archetype: 'Sentinel',
    attrs: { pace: 60, strength: 88, shooting: 44, passing: 72, tackling: 91, technique: 66 },
    special: { name: 'Blackout', description: 'Switches off the opposition attack.' },
    design: {
      head: 0x2a2a30, top: 0x2a2a30, face: 0x8fe08a, eye: 0xf0ece0, pupil: 0x1a1a1a,
      body: 0x2a2a30, arm: 0x2a2a30, leg: 0x2a2a30, boot: 0xc8c4b8,
      belt: 0x6a5a3a, accent: 0x8fe08a,
      faceStyle: 'panel', headTop: 'none',
    },
  },
  {
    id: 'navy',
    name: 'NAVY',
    epithet: 'The Fleet Order',
    role: 'MID',
    archetype: 'Engine',
    attrs: { pace: 80, strength: 66, shooting: 74, passing: 84, tackling: 64, technique: 80 },
    special: { name: 'Fleet Order', description: 'Moves the whole block up the pitch.' },
    design: {
      head: 0x2a3a8a, top: 0x2a3a8a, face: 0xff9a4a, eye: 0xf0ece0, pupil: 0x1a1a1a,
      body: 0x2a3a8a, arm: 0x2a3a8a, leg: 0x8a8a92, boot: 0xe8e2d0,
      belt: 0x8a8a92, accent: 0xff9a4a,
      faceStyle: 'panel', headTop: 'none',
    },
  },
  {
    id: 'ranger',
    name: 'RANGER',
    epithet: 'The Range',
    role: 'GK',
    archetype: 'Keeper',
    attrs: { pace: 52, strength: 80, shooting: 22, passing: 68, tackling: 88, technique: 78 },
    special: { name: 'Range', description: 'Owns everything inside the six-yard box.' },
    design: {
      head: 0xd98a4a, top: 0xe8e2d0, face: 0x14161c, eye: 0xe8e2d0, pupil: 0xe8e2d0,
      body: 0xd98a4a, arm: 0xd98a4a, leg: 0x14161c, boot: 0x14161c,
      belt: 0xe8e2d0, accent: 0xc0392b,
      faceStyle: 'bar', headTop: 'mortar',
    },
  },
  {
    id: 'sheriff',
    name: 'SHERIFF',
    epithet: 'The Posse',
    role: 'DEF',
    archetype: 'Marshal',
    attrs: { pace: 60, strength: 86, shooting: 46, passing: 76, tackling: 90, technique: 70 },
    special: { name: 'Posse', description: 'Rounds up the attack and escorts it out.' },
    design: {
      head: 0xd9603f, top: 0x14161c, face: 0xd97a3a, eye: 0xf0ece0, pupil: 0x1a1a1a,
      body: 0xd9603f, arm: 0xd9603f, leg: 0xd9603f, boot: 0xe8e2d0,
      belt: 0x8fe08a, accent: 0x8fe08a,
      faceStyle: 'panel', headTop: 'mortar', brow: true,
    },
  },
  {
    id: 'solder',
    name: 'SOLDER',
    epithet: 'The Joint',
    role: 'MID',
    archetype: 'Scrapper',
    attrs: { pace: 72, strength: 76, shooting: 66, passing: 78, tackling: 82, technique: 68 },
    special: { name: 'Joint', description: 'Holds the whole shape together.' },
    design: {
      head: 0xa8aab0, top: 0x6a5a48, face: 0x14161c, eye: 0x8fd9b0, pupil: 0x8fd9b0,
      body: 0xa8aab0, arm: 0xa8aab0, leg: 0xa8aab0, boot: 0xe8e2d0,
      belt: 0x6a5a48, accent: 0xff9a4a,
      faceStyle: 'bar', headTop: 'ears',
    },
  },
  {
    id: 'glacier',
    name: 'GLACIER',
    epithet: 'The Crevasse',
    role: 'GK',
    archetype: 'Keeper',
    attrs: { pace: 50, strength: 78, shooting: 20, passing: 74, tackling: 87, technique: 80 },
    special: { name: 'Crevasse', description: 'Swallows shots that looked certain.' },
    design: {
      head: 0xc8dce8, top: 0xc8dce8, face: 0x6fe3e0, eye: 0xf0ece0, pupil: 0x1a1a1a,
      body: 0xc8dce8, arm: 0xc8dce8, leg: 0xa8aab0, boot: 0x14161c,
      belt: 0x6a6e78, accent: 0x6fe3e0,
      faceStyle: 'panel', headTop: 'ears', brow: true,
    },
  },
  {
    id: 'cactus',
    name: 'CACTUS',
    epithet: 'The Thorns',
    role: 'DEF',
    archetype: 'Rock',
    attrs: { pace: 54, strength: 94, shooting: 40, passing: 64, tackling: 92, technique: 56 },
    special: { name: 'Thorns', description: 'Unpleasant to dribble past.' },
    design: {
      head: 0x8a8a3a, top: 0x3a3a40, face: 0x8a8a3a, eye: 0xf0ece0, pupil: 0x1a1a1e,
      body: 0x8a8a3a, arm: 0x8a8a3a, leg: 0x8a8a3a, boot: 0x14161c,
      belt: 0x3a3a40, accent: 0x3a3a40,
      faceStyle: 'cubes', headTop: 'rods',
    },
  },
  {
    id: 'vane',
    name: 'VANE',
    epithet: 'The Wind Rose',
    role: 'MID',
    archetype: 'Winger',
    attrs: { pace: 90, strength: 54, shooting: 70, passing: 82, tackling: 44, technique: 86 },
    special: { name: 'Wind Rose', description: 'Turns whichever way the game is blowing.' },
    design: {
      head: 0xc8dce8, top: 0x14161c, face: 0x6fe3e0, eye: 0x0a0a0a, pupil: 0x0a0a0a,
      body: 0xc8dce8, arm: 0xc8dce8, leg: 0xc8dce8, boot: 0x14161c,
      belt: 0x14161c, accent: 0x2a8a5a,
      faceStyle: 'cubes', headTop: 'antenna',
    },
  },
  {
    id: 'hedge',
    name: 'HEDGE',
    epithet: 'The Trim',
    role: 'DEF',
    archetype: 'Enforcer',
    attrs: { pace: 58, strength: 90, shooting: 42, passing: 70, tackling: 93, technique: 62 },
    special: { name: 'Trim', description: 'Cuts down every run before it starts.' },
    design: {
      head: 0x8ad8b8, top: 0x14161c, face: 0x14161c, eye: 0x0a0a0a, pupil: 0x0a0a0a,
      body: 0x8ad8b8, arm: 0x8ad8b8, leg: 0x8ad8b8, boot: 0x14161c,
      belt: 0x14161c, accent: 0x8fd94a,
      faceStyle: 'bar', headTop: 'spikes',
    },
  },
  {
    id: 'crane',
    name: 'CRANE',
    epithet: 'The Hook',
    role: 'FWD',
    archetype: 'Poacher',
    attrs: { pace: 84, strength: 60, shooting: 88, passing: 60, tackling: 40, technique: 78 },
    special: { name: 'Hook', description: 'Lifts the ball out of nowhere and scores.' },
    design: {
      head: 0xc0392b, top: 0x6a5a48, face: 0xc0392b, eye: 0x0a0a0a, pupil: 0x0a0a0a,
      body: 0xc0392b, arm: 0xc0392b, leg: 0xc0392b, boot: 0x8aa8f0,
      belt: 0x8aa8f0, accent: 0x8fd94a,
      faceStyle: 'cubes', headTop: 'antenna',
    },
  },
];

export const ROSTER_BY_ID: Record<string, ViberCharacter> = Object.fromEntries(
  ROSTER.map((v) => [v.id, v]),
);

/** Simple overall rating (0-99), like a football player card. */
export function overallOf(v: ViberCharacter): number {
  const a = v.attrs;
  if (v.role === 'GK') {
    return Math.round(a.tackling * 0.45 + a.technique * 0.25 + a.strength * 0.2 + a.pace * 0.1);
  }
  // Weights mirror what the simulation actually rewards: pace (loose balls and
  // breakaways), strength (shielding the ball and winning duels), technique and
  // tackling (retention and challenges), passing (progression), and shooting
  // (finishing). Shooting is deliberately light — a striker's real value here is
  // getting into the position in the first place.
  const w = {
    FWD: { pace: 0.22, strength: 0.22, shooting: 0.16, passing: 0.08, tackling: 0.04, technique: 0.28 },
    MID: { pace: 0.2, strength: 0.18, shooting: 0.08, passing: 0.24, tackling: 0.16, technique: 0.14 },
    DEF: { pace: 0.18, strength: 0.3, shooting: 0.02, passing: 0.1, tackling: 0.28, technique: 0.12 },
    GK: { pace: 0.1, strength: 0.2, shooting: 0, passing: 0.1, tackling: 0.35, technique: 0.25 },
  }[v.role];
  return Math.round(
    a.pace * w.pace + a.strength * w.strength + a.shooting * w.shooting +
    a.passing * w.passing + a.tackling * w.tackling + a.technique * w.technique,
  );
}

/** Team rating = mean of the five starters' overalls. */
export function teamOverall(ids: string[]): number {
  if (!ids.length) return 0;
  const sum = ids.reduce((acc, id) => acc + (ROSTER_BY_ID[id] ? overallOf(ROSTER_BY_ID[id]) : 0), 0);
  return Math.round(sum / ids.length);
}

/** The formation's slots, in the exact order world.ts fills them. */
export const SLOT_ROLES: Role[] = ['GK', 'DEF', 'MID', 'MID', 'FWD'];

/**
 * How many substitutes a matchday squad carries.
 *
 * Three, and one per outfield line: the bench is cover, not a second team. It
 * is also the substitution limit — you can only bring on the players who are
 * actually sitting there.
 */
export const BENCH_SIZE = 3;

/**
 * Choose the bench that covers a starting five.
 *
 * One defender, one midfielder and one forward, taken from the best Vibers in
 * the roster the manager did NOT pick. The point is cover: whoever goes down
 * injured — or is simply having a bad game — has a like-for-like replacement
 * waiting, which is what makes the substitution worth offering at all.
 *
 * A natural keeper is never benched. There is one gloves slot and the starter
 * owns it; benching a second keeper would burn a third of the bench on a
 * position that cannot be rotated into the outfield.
 */
export function autoBench(lineupIds: string[], size = BENCH_SIZE): string[] {
  const taken = new Set(lineupIds);
  const out: string[] = [];
  for (const role of ['DEF', 'MID', 'FWD'] as ViberRole[]) {
    if (out.length >= size) break;
    const best = ROSTER
      .filter((v) => v.role === role && !taken.has(v.id))
      .sort((a, b) => overallOf(b) - overallOf(a))[0];
    if (best) {
      taken.add(best.id);
      out.push(best.id);
    }
  }
  // Backfill if the roster ever lacks a line, so the bench is always full.
  for (const v of [...ROSTER].sort((a, b) => overallOf(b) - overallOf(a))) {
    if (out.length >= size) break;
    if (taken.has(v.id)) continue;
    taken.add(v.id);
    out.push(v.id);
  }
  return out;
}

/**
 * The bench for a league match, drawn from the club's OWN squad.
 *
 * This is the difference between a squad and a roster. `autoBench` above reaches
 * into the whole roster — it answers "who could cover this five?" — which is
 * fine for a one-off friendly but wrong for a league: a club can only field
 * players it has signed, and it is exactly that limit that makes an injury or a
 * ban bite. Here the pool is the squad's non-starters, and if the squad is thin
 * the bench is short.
 *
 * Cover is still one per outfield line, best first, so a manager who loses a
 * defender has a defender to bring on.
 */
export function benchFromSquad(
  squadIds: string[],
  starterIds: string[],
  size = BENCH_SIZE,
): string[] {
  const taken = new Set(starterIds);
  const pool = squadIds.map((id) => ROSTER_BY_ID[id]).filter(Boolean) as ViberCharacter[];
  const out: string[] = [];

  for (const role of ['DEF', 'MID', 'FWD'] as ViberRole[]) {
    if (out.length >= size) break;
    const best = pool
      .filter((v) => v.role === role && !taken.has(v.id))
      .sort((a, b) => overallOf(b) - overallOf(a))[0];
    if (best) {
      taken.add(best.id);
      out.push(best.id);
    }
  }
  // Backfill from whatever is left of the squad, so a squad with no cover in
  // one line still fills the bench it is allowed.
  for (const v of [...pool].sort((a, b) => overallOf(b) - overallOf(a))) {
    if (out.length >= size) break;
    if (taken.has(v.id)) continue;
    taken.add(v.id);
    out.push(v.id);
  }
  return out;
}

const ROLE_ORDER: Role[] = ['GK', 'DEF', 'MID', 'FWD'];

/** How badly a Viber's natural role fits a formation slot (0 = perfect). */
function roleFit(playerRole: ViberRole, slotRole: Role): number {
  if (playerRole === slotRole) return 0;
  const d = Math.abs(ROLE_ORDER.indexOf(playerRole) - ROLE_ORDER.indexOf(slotRole));
  return d === 1 ? 4 : d === 2 ? 9 : 16;
}

export interface LineupSlot {
  id: string;
  role: Role;
}

/**
 * Assign the chosen Vibers to the five formation slots (GK, DEF, MID, MID, FWD).
 * Role fit dominates; overall breaks ties. A natural keeper always takes the
 * gloves; if none was picked, the most defensive outfield goes in goal.
 */
export function buildLineup(ids: string[]): LineupSlot[] {
  const pool = ids.map((id) => ROSTER_BY_ID[id]).filter(Boolean) as ViberCharacter[];
  const used = new Set<string>();
  const out: LineupSlot[] = [];

  for (const slotRole of SLOT_ROLES) {
    let best: ViberCharacter | null = null;
    let bestCost = Infinity;
    for (const v of pool) {
      if (used.has(v.id)) continue;
      const cost = roleFit(v.role, slotRole) * 100 - overallOf(v);
      if (cost < bestCost) {
        bestCost = cost;
        best = v;
      }
    }
    if (best) {
      used.add(best.id);
      out.push({ id: best.id, role: slotRole });
    }
  }
  return out;
}

export interface OpponentSelection {
  ids: string[];
  club: ClubDef;
  overall: number;
}

/**
 * Build an opponent whose overall rating tracks the player's, so every match is
 * a fair fight (spec: "opponent selection is automatic according to the current
 * overall level of the player").
 *
 * The five are composed by position (1 GK, 1 DEF, 2 MID, 1 FWD). We first try to
 * use Vibers the player did NOT pick; if that squad can't reach the player's
 * level (a hand-picked elite five can out-rate the rest of the roster), we fall
 * back to fielding the same quality of Viber, which keeps the match competitive
 * rather than a walkover.
 *
 * Pass `clubId` to fix the opponent — the league hands the next fixture's club
 * in, so a season match is against the club actually on the schedule rather
 * than whichever tier happens to match. The five is still built to the player's
 * level, so a fixture is a fair fight whoever it is against.
 *
 * `excludeIds` keeps Vibers off the opponent's five beyond the player's own
 * starters — the bench in particular, so a Viber waiting on your bench is never
 * simultaneously lining up against you.
 */
export function autoOpponent(
  playerIds: string[],
  seed: number,
  clubId?: string,
  excludeIds: string[] = [],
): OpponentSelection {
  const target = teamOverall(playerIds);
  const rng = makeRng((seed ^ 0x9e3779b9) >>> 0);

  const build = (pool: ViberCharacter[]): string[] => {
    const ids: string[] = [];
    const used = new Set<string>();
    for (const role of SLOT_ROLES) {
      const candidates = pool.filter((v) => !used.has(v.id) && v.role === role);
      if (!candidates.length) continue;
      // Strongest first: an elite human five deserves an elite opponent.
      const sorted = [...candidates].sort((a, b) => overallOf(b) - overallOf(a));
      const top = sorted.slice(0, Math.min(3, sorted.length));
      const chosen = top[rng.int(0, top.length - 1)];
      used.add(chosen.id);
      ids.push(chosen.id);
    }
    return ids;
  };

  const taken = new Set([...playerIds, ...excludeIds]);
  const ids = build(ROSTER.filter((v) => !taken.has(v.id)));

  // Top up: if the distinct squad still rates below the player's, upgrade the
  // weakest slot from the full roster (this may reuse a Viber the player picked,
  // which is the only way a small roster can field an equally strong side).
  for (let guard = 0; guard < SLOT_ROLES.length; guard++) {
    if (ids.length < SLOT_ROLES.length || teamOverall(ids) >= target) break;

    let weakestIdx = 0;
    let weakestOvr = Infinity;
    for (let i = 0; i < ids.length; i++) {
      const o = overallOf(ROSTER_BY_ID[ids[i]]);
      if (o < weakestOvr) {
        weakestOvr = o;
        weakestIdx = i;
      }
    }

    const role = SLOT_ROLES[weakestIdx];
    const current = new Set(ids);
    const upgrades = ROSTER
      .filter((v) => v.role === role && !current.has(v.id) && overallOf(v) > weakestOvr)
      .sort((a, b) => overallOf(b) - overallOf(a));
    if (!upgrades.length) break;

    const pick = upgrades[rng.int(0, Math.min(2, upgrades.length - 1))];
    ids[weakestIdx] = pick.id;
  }

  const club = (clubId ? CLUBS[clubId] : undefined) ?? pickClub(target, rng.int(0, 99));
  return { ids, club, overall: teamOverall(ids) };
}

/** Choose an opponent club whose tier matches the target rating. */
function pickClub(target: number, jitter: number): ClubDef {
  const tier = target >= 87 ? 5 : target >= 81 ? 4 : target >= 75 ? 3 : target >= 69 ? 2 : target >= 63 ? 1 : 0;
  const band = OPPONENT_CLUBS.filter((c) => c.tier === tier);
  const pool = band.length ? band : OPPONENT_CLUBS;
  return pool[jitter % pool.length];
}
