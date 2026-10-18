// brand.ts — the Viber League mark and the club icon set, in one place.
//
// WHY THIS MODULE EXISTS. The official logo is a lime "chef-hat" head with a
// V/V across it, two eyes and a smile. It has to appear in two very different
// places — as SVG in the DOM (the title screen, the profile icon picker) and as
// pixels in a canvas texture (painted on the pitch, on the advertising
// hoardings) — and those must be the *same* drawing. So the geometry lives here
// once, as SVG path data, and each renderer consumes it its own way: the DOM
// gets markup, the canvas gets `Path2D`, which parses the very same strings.
//
// WHY NOT AN IMAGE FILE. The shipped game is one self-contained HTML file;
// `tools/cdp/inline-build.mjs` fails the build if any external reference
// survives into the bundle. A data-URI PNG would technically pass that check but
// would bloat the file and lose its edge at every size. Vector costs nothing.
//
// Pure: no DOM, no I/O, no Three.js. Safe to import from a test in Node — only
// `drawBrand` needs a real canvas, and only when it is called.

/** The brand palette. Mirrors the CSS custom properties in style.css. */
export const BRAND = {
  /** Electric lime — the whole identity. */
  lime: '#dff902',
  /** Near-black. Also the badge background, exactly as the reference logo. */
  ink: '#0c0f08',
} as const;

export type IconId = 'viber' | 'quill' | 'voxel' | 'spike' | 'crown' | 'shield';

export const ICON_IDS: IconId[] = ['viber', 'quill', 'voxel', 'spike', 'crown', 'shield'];

/**
 * Crests that have been retired, and the crest that now holds their slot.
 *
 * A crest is part of a saved profile, so dropping an id outright would quietly
 * hand a returning manager the house mark. What the player chose was a *slot*
 * in the picker, and the slot is what they keep — the artwork inside it is ours
 * to change.
 */
const RETIRED_ICON_IDS: Record<string, IconId> = {
  ball: 'quill',
  bolt: 'voxel',
  star: 'spike',
};

/* ------------------------------------------------------------------ */
/* Path helpers — everything is expressed as SVG path data so the two  */
/* renderers cannot drift apart.                                       */
/* ------------------------------------------------------------------ */

const n = (v: number) => Number(v.toFixed(2));

/** A circle as path data, so it needs no special case in either renderer. */
export function circlePath(cx: number, cy: number, r: number): string {
  return (
    `M ${n(cx - r)} ${n(cy)} ` +
    `a ${n(r)} ${n(r)} 0 1 0 ${n(r * 2)} 0 ` +
    `a ${n(r)} ${n(r)} 0 1 0 ${n(-r * 2)} 0 Z`
  );
}

export function roundRectPath(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): string {
  const rr = Math.min(r, w / 2, h / 2);
  return (
    `M ${n(x + rr)} ${n(y)} H ${n(x + w - rr)} ` +
    `A ${n(rr)} ${n(rr)} 0 0 1 ${n(x + w)} ${n(y + rr)} ` +
    `V ${n(y + h - rr)} A ${n(rr)} ${n(rr)} 0 0 1 ${n(x + w - rr)} ${n(y + h)} ` +
    `H ${n(x + rr)} A ${n(rr)} ${n(rr)} 0 0 1 ${n(x)} ${n(y + h - rr)} ` +
    `V ${n(y + rr)} A ${n(rr)} ${n(rr)} 0 0 1 ${n(x + rr)} ${n(y)} Z`
  );
}

/** A regular star, alternating outer and inner radii. */
export function starPath(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  points = 5,
): string {
  const parts: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    // Start at the top so the star sits upright.
    const a = (Math.PI * i) / points - Math.PI / 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    parts.push(`${i === 0 ? 'M' : 'L'} ${n(x)} ${n(y)}`);
  }
  return parts.join(' ') + ' Z';
}

/**
 * One triangular spike radiating from a circle.
 *
 * The base is a CHORD of the circle, so the triangle reaches inside the disc and
 * the two shapes overlap. That is the trick that makes a head of hair out of
 * primitives: every piece is the same fill, so the union has no seam and there
 * is no hand-authored outline to get wrong.
 *
 * `deg` is SVG degrees — 270 points straight up, because y grows downwards.
 */
function spikePath(
  cx: number,
  cy: number,
  r: number,
  deg: number,
  halfWidthDeg: number,
  len: number,
): string {
  const a = (deg * Math.PI) / 180;
  const hw = (halfWidthDeg * Math.PI) / 180;
  const at = (angle: number, radius: number) =>
    `${n(cx + Math.cos(angle) * radius)} ${n(cy + Math.sin(angle) * radius)}`;
  return `M ${at(a - hw, r)} L ${at(a, r + len)} L ${at(a + hw, r)} Z`;
}

/* ------------------------------------------------------------------ */
/* The icons                                                           */
/* ------------------------------------------------------------------ */

interface IconDef {
  /** Human label, shown under the picker tile and used as the accessible name. */
  label: string;
  /** The artwork, filled in brand lime. */
  fill: string[];
  /** Stroked in brand lime — used for the smile. */
  stroke?: Array<{ d: string; width: number }>;
  /** Cut out of the artwork in the badge colour, drawn last. */
  cut?: string[];
  /** Cut-out strokes, in the badge colour. */
  cutStroke?: Array<{ d: string; width: number }>;
}

/*
 * The Viber mark, from the reference artwork.
 *
 * The head is three overlapping lobes sitting on a rounded band, and the
 * concave notch where a lobe meets the band's corner is what makes it a chef's
 * hat rather than a cloud. Drawing it as four primitives in one fill colour
 * rather than as a single hand-authored outline is deliberate: the union is
 * exact by construction, so there is no risk of a wobble where the lobes meet
 * and it still reads as one silhouette.
 *
 * Every number below was measured off the reference, not eyeballed. The
 * reference is a 640px square whose badge fills the frame edge to edge, so it
 * maps onto this module's 0..100 box by `1.25 + v * (97.5 / 640)` — badge to
 * badge, which is the only anchor that cannot drift as the artwork changes.
 *
 * These four are the one part of the mark that is still an approximation: the
 * real silhouette is a squircle-ish blob whose edge profile fits a different
 * circle radius at every row, so no set of circles reproduces it exactly.
 * `tools/cdp/probe-head-sweep.mjs` exists to choose between candidates by
 * rendering them over the artwork; this one was picked because its outline sits
 * within about a unit of the reference everywhere while keeping the hat's step
 * readable at 26px.
 */
const VIBER_HEAD = [
  circlePath(31, 30, 14),
  circlePath(50, 21.5, 15.5),
  circlePath(69, 30, 14),
  roundRectPath(18, 31, 64, 29, 13),
];

/**
 * The eyes.
 *
 * These are LIME, sitting on the badge below the head — not holes punched in
 * the head. Getting that backwards is what made an earlier revision of this
 * mark look like it had no eyes at all: ink discs drawn on an ink badge are
 * invisible, and the whole face disappeared.
 *
 * Measured from the reference at 49px across in a 640px frame, i.e. 7.8 units
 * here. The pair is deliberately not level: the whole face is tilted about −3°
 * in the artwork, which is the mark's character rather than a wobble, so the
 * right eye sits 1.2 units above the left.
 */
const VIBER_EYES = [circlePath(37.8, 69.9, 3.8), circlePath(61.7, 68.7, 3.8)];

/**
 * The smile — the widest thing below the head, and the mark's whole mood.
 *
 * Measured as a 30px stroke (4.6 here) whose centreline runs from 34 to 66.6
 * across, dipping to y 88.2. The control point is solved from those three
 * points rather than guessed: for a quadratic, the curve's midpoint is
 * `(P0 + 2P1 + P2) / 4`, so the control is `(4M - P0 - P2) / 2`.
 */
const VIBER_SMILE = 'M 34 82.4 Q 48.5 94.7 66.6 80.9';

const ICONS: Record<IconId, IconDef> = {
  viber: {
    label: 'Viber',
    // Head then eyes, both in lime. They do not overlap, so the order is only
    // for readability.
    fill: [...VIBER_HEAD, ...VIBER_EYES],
    stroke: [{ d: VIBER_SMILE, width: 4.6 }],
    /*
     * V / V, cut out of the band.
     *
     * Measured, and much smaller than it looks: the three glyphs together
     * occupy 34.9 x 13.7 units, so each chevron is only 7.6 across and 5.3 deep
     * with a 3.4 stroke. An earlier revision drew them nearly square and half
     * as thick again, which read as a completely different — and much louder —
     * piece of lettering.
     *
     * The whole group carries the face's ~4° tilt, so the right chevron sits
     * two units above the left. `cutStroke` is stroked in the badge colour, not
     * the lime, because these sit on the band.
     */
    cutStroke: [
      { d: 'M 35.1 37.7 L 38.9 43 L 42.7 37.7', width: 3.4 },
      { d: 'M 52.1 34.9 L 48.9 45.3', width: 3.4 },
      { d: 'M 58.4 35.7 L 62.8 41 L 66.4 35.7', width: 3.4 },
    ],
  },

  /*
   * The quill.
   *
   * A feather blade with its shaft carved out as an arrow — the one idea from
   * the reference worth keeping, because it is the only part that survives at
   * 26px. The blade is a single asymmetric leaf: a long convex right edge, a
   * straighter left edge, and a flat step at the tail where the bare quill
   * leaves it.
   *
   * The arrow is CUT in the badge colour rather than stroked in lime, so the
   * blade stays one solid shape with a line through it. The head is a chevron
   * and not a filled triangle: two strokes meeting at a point still read when
   * the whole crest is 26 pixels wide, where a triangle closes into a blob.
   */
  quill: {
    label: 'Quill',
    fill: ['M 26 88 C 28 62 46 32 77 13 C 85 47 66 73 41 83 Z'],
    // The bare quill, past the end of the vane.
    stroke: [{ d: 'M 29 85 L 21 94', width: 5 }],
    cutStroke: [
      { d: 'M 32 83 L 63 31', width: 5 },
      { d: 'M 52.5 36 L 65 31 L 66 44.5', width: 5 },
    ],
  },

  /*
   * The voxel head.
   *
   * The reference is a dark cube with lime eyes; the crest inverts it, because
   * the artwork here is always lime on ink. So: a lime block of a head, ink
   * eyes, ink slats for a mouth, plus an antenna and two ears so it does not
   * read as a battery. Every part is a rounded rectangle — that IS the joke,
   * and it is also what keeps the shape crisp at 26px.
   */
  voxel: {
    label: 'Voxel',
    fill: [
      roundRectPath(39, 9, 22, 12, 3), // antenna cube
      roundRectPath(47, 20, 6, 14, 1), // antenna stalk
      roundRectPath(21, 33, 58, 55, 9), // head
      roundRectPath(12, 52, 10, 18, 3), // left ear
      roundRectPath(78, 52, 10, 18, 3), // right ear
    ],
    cut: [
      roundRectPath(29, 42, 17, 17, 3),
      roundRectPath(54, 42, 17, 17, 3),
      roundRectPath(32, 66, 36, 5, 2),
      roundRectPath(32, 73, 36, 5, 2),
      roundRectPath(32, 80, 36, 5, 2),
    ],
  },

  /*
   * The spike.
   *
   * A round face under a swept head of hair. The hair is six triangles whose
   * bases are chords of the face circle, so the union has no seam; the lengths
   * shrink from the left to the right, which is what makes it a sweep rather
   * than a sunburst.
   *
   * The face is lime like everything else, so the hairline has to be DRAWN —
   * one ink arc across the forehead. Without it this is a spiky ball with two
   * dots in it.
   */
  spike: {
    label: 'Spike',
    fill: [
      circlePath(52, 58, 23),
      ...([
        [200, 23],
        [228, 20],
        [256, 17],
        [284, 14],
        [312, 11],
        [340, 9],
      ] as Array<[number, number]>).map(([deg, len]) => spikePath(52, 58, 23, deg, 16, len)),
    ],
    cutStroke: [{ d: 'M 31 50 Q 52 35 73 50', width: 5 }],
    cut: [circlePath(43, 66, 4.6), circlePath(62, 66, 4.6)],
  },

  crown: {
    label: 'Crown',
    fill: [
      'M 18 78 L 20 32 L 35 49 L 50 24 L 65 49 L 80 32 L 82 78 Z',
      roundRectPath(17, 76, 66, 13, 4),
    ],
  },

  shield: {
    label: 'Shield',
    fill: ['M 50 8 L 84 22 V 50 C 84 74 68 88 50 94 C 32 88 16 74 16 50 V 22 Z'],
    cutStroke: [{ d: 'M 32 45 L 50 62 L 68 45', width: 7 }],
  },
};

/** The label for an icon id, for pickers and accessible names. */
export function iconLabel(id: IconId): string {
  return ICONS[id]?.label ?? ICONS.viber.label;
}

/** Narrow an unknown value (a stored profile) to a real icon id. */
export function asIconId(value: unknown, fallback: IconId = 'viber'): IconId {
  if (typeof value !== 'string') return fallback;
  if ((ICON_IDS as string[]).includes(value)) return value as IconId;
  return RETIRED_ICON_IDS[value] ?? fallback;
}

/* ------------------------------------------------------------------ */
/* Badge frame — shared by both renderers                              */
/* ------------------------------------------------------------------ */

const BOX = 100;
const BADGE_R = 24;
/**
 * A faint lime ring around the badge.
 *
 * The badge itself is the same near-black as most of the UI, so on a dark screen
 * it would vanish and the artwork would float. The ring is what makes the icon
 * read as a crest on any background, and it is deliberately weak — the mark
 * should never shout louder than the club name beside it.
 */
const BADGE_RING = 'rgba(223,249,2,0.26)';
const BADGE_RING_WIDTH = 2.5;

/* ------------------------------------------------------------------ */
/* Renderer 1 — SVG markup for the DOM                                 */
/* ------------------------------------------------------------------ */

export interface BrandSvgOpts {
  /** Rendered size in CSS pixels. Defaults to 100. */
  size?: number;
  /** Draw the rounded-square badge behind the artwork. Defaults to true. */
  badge?: boolean;
  /** Extra class on the root <svg>. */
  className?: string;
}

/**
 * The mark as inline SVG markup.
 *
 * Returned as a string rather than as an element because it is static, trusted
 * markup — there is nothing here to sanitise, and a string can be dropped into
 * any wrapper without the caller knowing about SVG namespaces.
 */
export function brandSvg(id: IconId, opts: BrandSvgOpts = {}): string {
  const def = ICONS[id] ?? ICONS.viber;
  const size = opts.size ?? BOX;
  const badge = opts.badge !== false;
  const extra = opts.className ? ` class="${opts.className}"` : '';

  const parts: string[] = [];

  if (badge) {
    parts.push(
      `<rect x="1.25" y="1.25" width="${BOX - 2.5}" height="${BOX - 2.5}" rx="${BADGE_R}" ` +
        `fill="${BRAND.ink}" stroke="${BADGE_RING}" stroke-width="${BADGE_RING_WIDTH}"/>`,
    );
  }

  const fillPaths = def.fill;
  for (const d of fillPaths) {
    parts.push(`<path d="${d}" fill="${BRAND.lime}"/>`);
  }

  for (const s of def.stroke ?? []) {
    parts.push(
      `<path d="${s.d}" fill="none" stroke="${BRAND.lime}" stroke-width="${s.width}" ` +
        `stroke-linecap="round"/>`,
    );
  }

  for (const d of def.cut ?? []) {
    parts.push(`<path d="${d}" fill="${BRAND.ink}"/>`);
  }

  for (const s of def.cutStroke ?? []) {
    parts.push(
      `<path d="${s.d}" fill="none" stroke="${BRAND.ink}" stroke-width="${s.width}" ` +
        `stroke-linecap="round" stroke-linejoin="round"/>`,
    );
  }

  return (
    `<svg${extra} viewBox="0 0 ${BOX} ${BOX}" width="${size}" height="${size}" ` +
    `xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${def.label}">` +
    parts.join('') +
    `</svg>`
  );
}

/* ------------------------------------------------------------------ */
/* Renderer 2 — Canvas2D, for the pitch and the hoardings              */
/* ------------------------------------------------------------------ */

export interface DrawBrandOpts {
  /** Draw the rounded-square badge behind the artwork. Defaults to true. */
  badge?: boolean;
  /**
   * Paint the artwork in this colour instead of the brand lime. Used for the
   * crest painted on the pitch, which has to sit on grass without shouting.
   */
  color?: string;
  /** Background colour for the cut-outs. Defaults to the badge ink. */
  cutColor?: string;
  /** Overall opacity of the artwork. Defaults to 1. */
  alpha?: number;
}

/**
 * Paint the mark into a 2D context, filling a `size`×`size` box at (0, 0).
 *
 * Uses `Path2D`, which parses the same SVG path strings the DOM renderer emits,
 * so there is exactly one definition of every shape in the project.
 */
export function drawBrand(
  g: CanvasRenderingContext2D,
  id: IconId,
  size: number,
  opts: DrawBrandOpts = {},
): void {
  const def = ICONS[id] ?? ICONS.viber;
  const badge = opts.badge !== false;
  const lime = opts.color ?? BRAND.lime;
  const cutColor = opts.cutColor ?? BRAND.ink;

  g.save();
  g.globalAlpha = opts.alpha ?? 1;
  // Everything below is authored in a 0..100 box.
  g.scale(size / BOX, size / BOX);

  if (badge) {
    const frame = new Path2D(roundRectPath(1.25, 1.25, BOX - 2.5, BOX - 2.5, BADGE_R));
    g.fillStyle = BRAND.ink;
    g.fill(frame);
    g.strokeStyle = BADGE_RING;
    g.lineWidth = BADGE_RING_WIDTH;
    g.stroke(frame);
  }

  const fillPaths = def.fill;
  g.fillStyle = lime;
  for (const d of fillPaths) g.fill(new Path2D(d));

  g.strokeStyle = lime;
  g.lineCap = 'round';
  for (const s of def.stroke ?? []) {
    g.lineWidth = s.width;
    g.stroke(new Path2D(s.d));
  }

  g.fillStyle = cutColor;
  for (const d of def.cut ?? []) g.fill(new Path2D(d));

  g.strokeStyle = cutColor;
  g.lineJoin = 'round';
  for (const s of def.cutStroke ?? []) {
    g.lineWidth = s.width;
    g.stroke(new Path2D(s.d));
  }

  g.restore();
}

/* ------------------------------------------------------------------ */
/* Renderer 3 — the hoarding face                                      */
/* ------------------------------------------------------------------ */

/** The proportions a board face is authored in, so callers can size one. */
export const BOARD_ASPECT = 144 / 512;

/**
 * Paint the face of a Viber League hoarding into `canvas`.
 *
 * Lives here rather than beside the boards themselves because it is drawing,
 * not layout — the same reason `brandSvg` is here. `stadium.ts` decides where a
 * board stands; this decides what is on it.
 *
 * The wordmark is auto-fitted to the room left beside the mark instead of being
 * set at a fixed size. That matters on the first paint, which can happen before
 * the display font has loaded: a fallback face is a different width, and a fixed
 * size would either overflow the plate or rattle around in the middle of it.
 */
export function paintBrandBoard(canvas: HTMLCanvasElement): void {
  const W = canvas.width;
  const H = canvas.height;
  const g = canvas.getContext('2d');
  if (!g) return;

  g.clearRect(0, 0, W, H);

  // The plate, plus the lime rule that is the brand's signature.
  g.fillStyle = BRAND.ink;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = BRAND.lime;
  g.lineWidth = Math.max(3, Math.round(H * 0.035));
  const inset = Math.round(H * 0.05);
  g.strokeRect(inset, inset, W - inset * 2, H - inset * 2);

  const markSize = Math.round(H * 0.72);
  const markX = Math.round(H * 0.18);
  // `drawBrand` paints from (0,0), so shift the context to place it.
  g.save();
  g.translate(markX, (H - markSize) / 2);
  drawBrand(g, 'viber', markSize, { badge: false });
  g.restore();

  const label = 'VIBER LEAGUE';
  const textLeft = markX + markSize + Math.round(H * 0.14);
  const room = W - Math.round(H * 0.18) - textLeft;
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  for (let size = Math.round(H * 0.42); size > 8; size--) {
    g.font = `900 ${size}px "Baloo 2", system-ui, sans-serif`;
    if (g.measureText(label).width <= room) break;
  }
  g.fillStyle = BRAND.lime;
  g.fillText(label, textLeft, H / 2 + Math.round(H * 0.01));
}
