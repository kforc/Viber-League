import { describe, expect, it } from 'vitest';
import {
  BRAND,
  ICON_IDS,
  asIconId,
  brandSvg,
  circlePath,
  iconLabel,
  roundRectPath,
  starPath,
} from '../src/brand';

/**
 * The brand module is the one drawing that has to survive two very different
 * renderers — SVG markup in the DOM and `Path2D` on a canvas — from a single
 * definition. These tests are about the things that would silently break that:
 * a path string one renderer cannot parse, an icon that renders nothing, or
 * markup that is unsafe to drop into `innerHTML`.
 *
 * The environment is plain Node, so only the pure half is covered here.
 * `drawBrand` needs a real canvas; it is exercised by the browser harness.
 */

/* ------------------------------------------------------------------ */
/* Path helpers                                                        */
/* ------------------------------------------------------------------ */

describe('path helpers', () => {
  it('draws a circle as two half-arcs, so neither renderer needs a special case', () => {
    const d = circlePath(50, 50, 20);
    expect(d.startsWith('M 30 50')).toBe(true);
    expect(d).toContain('a 20 20 0 1 0 40 0');
    expect(d).toContain('a 20 20 0 1 0 -40 0');
    expect(d.endsWith('Z')).toBe(true);
  });

  it('rounds a rect by no more than half its shortest side', () => {
    // A radius larger than half the height would make the two corner arcs cross
    // and fold the path inside out.
    const d = roundRectPath(0, 0, 40, 20, 999);
    expect(d).toContain('A 10 10 0 0 1 40 10');
    expect(d).not.toContain('A 999');
  });

  it('emits one command per star point, starting at the top', () => {
    const d = starPath(50, 50, 40, 16);
    const commands = d.match(/[ML]/g) ?? [];
    expect(commands.length).toBe(10); // five outer, five inner
    // The first vertex is directly above the centre.
    expect(d.startsWith('M 50 10')).toBe(true);
  });

  it('honours a non-default point count', () => {
    expect((starPath(50, 50, 40, 16, 6).match(/[ML]/g) ?? []).length).toBe(12);
  });

  it('never emits a number with a long float tail', () => {
    // These strings are shipped in the bundle and parsed twice per frame in the
    // worst case; 3.0000000000000004 style output is pure waste.
    const all = [
      circlePath(1 / 3, 2 / 7, 11 / 13),
      roundRectPath(1 / 3, 2 / 7, 11 / 13, 17 / 19, 23 / 29),
      starPath(1 / 3, 2 / 7, 11 / 13, 17 / 19, 7),
    ].join(' ');
    for (const token of all.match(/-?\d+\.\d+/g) ?? []) {
      expect(token.split('.')[1].length).toBeLessThanOrEqual(2);
    }
  });
});

/* ------------------------------------------------------------------ */
/* The icon set                                                        */
/* ------------------------------------------------------------------ */

describe('the icon set', () => {
  it('is the six crests the picker offers, with no duplicates', () => {
    expect(ICON_IDS.length).toBe(6);
    expect(new Set(ICON_IDS).size).toBe(ICON_IDS.length);
    expect(ICON_IDS[0]).toBe('viber');
  });

  it('gives every crest a distinct label', () => {
    const labels = ICON_IDS.map(iconLabel);
    expect(new Set(labels).size).toBe(ICON_IDS.length);
    for (const l of labels) expect(l.trim().length).toBeGreaterThan(1);
  });

  it('renders every crest as real artwork, not an empty badge', () => {
    for (const id of ICON_IDS) {
      const svg = brandSvg(id);
      expect(svg, id).toContain(`fill="${BRAND.lime}"`);
      expect((svg.match(/<path/g) ?? []).length, id).toBeGreaterThan(0);
    }
  });

  it('gives the Viber mark a face, so it is not just a silhouette', () => {
    const svg = brandSvg('viber');
    // The V/V is cut out of the band in the badge colour.
    expect(svg).toContain(`stroke="${BRAND.ink}"`);
    // ...and the smile is stroked in lime.
    expect(svg).toContain(`stroke="${BRAND.lime}"`);
  });
});

/* ------------------------------------------------------------------ */
/* The Viber mark's face                                               */
/* ------------------------------------------------------------------ */

/**
 * Recover `{cx, cy, r}` from the path `circlePath` emits, or null if the string
 * is not one of its circles.
 */
function parseCircle(d: string): { cx: number; cy: number; r: number } | null {
  const m = d.match(
    /^M (-?[\d.]+) (-?[\d.]+) a ([\d.]+) \3 0 1 0 ([\d.]+) 0 a \3 \3 0 1 0 (-?[\d.]+) 0 Z$/,
  );
  if (!m) return null;
  const [, x0, y0, r, dx] = m;
  return { cx: Number(x0) + Number(r), cy: Number(y0), r: Number(r) };
}

/** Every `<path>` in the markup, as `{ d, fill }`. */
function pathsOf(svg: string): Array<{ d: string; fill: string | null }> {
  return (svg.match(/<path[^>]*\/>/g) ?? []).map((tag) => ({
    d: /d="([^"]*)"/.exec(tag)?.[1] ?? '',
    fill: /fill="([^"]*)"/.exec(tag)?.[1] ?? null,
  }));
}

describe("the Viber mark's face", () => {
  const fills = pathsOf(brandSvg('viber')).filter((p) => p.fill === BRAND.lime);

  it('has two eyes, and they are lime — not holes cut in the badge', () => {
    /*
     * This is the regression that prompted the test. The eyes were once
     * declared as ink cut-outs, which is invisible: they sit on the badge, not
     * on the head, so ink-on-ink erased the entire face. If they ever go back
     * into `cut`, or get dropped, this fails.
     */
    const circles = fills.map((p) => parseCircle(p.d)).filter((c) => c !== null);
    expect(circles.length).toBeGreaterThanOrEqual(2);

    // Two of them are the eyes: small, level-ish, and below the head's band.
    const eyes = circles.filter((c) => c.cy > 60 && c.cy < 78 && c.r > 2.5 && c.r < 7);
    expect(eyes.length).toBe(2);

    // One either side of the middle.
    const [left, right] = [...eyes].sort((a, b) => a.cx - b.cx);
    expect(left.cx).toBeLessThan(50);
    expect(right.cx).toBeGreaterThan(50);
    expect(right.cx - left.cx).toBeGreaterThan(15);
  });

  it('sizes them like the artwork, not like tokens', () => {
    // Measured from the reference: 49px across in a 640px badge, i.e. r 3.8 in
    // this module's 0..100 box. Anything under 2.5 is a speck nobody can see;
    // anything over 7 is a different face.
    const eyes = fills
      .map((p) => parseCircle(p.d))
      .filter((c): c is NonNullable<typeof c> => c !== null && c.cy > 60 && c.cy < 78);
    for (const e of eyes) {
      expect(e.r).toBeGreaterThanOrEqual(3);
      expect(e.r).toBeLessThanOrEqual(4.6);
    }
  });

  it('keeps the face tilted, the way the artwork is', () => {
    // The whole mark sits at about -3 degrees. Levelling the eyes would read as
    // a different, stiffer logo — it is the mark's character, not a wobble.
    const eyes = fills
      .map((p) => parseCircle(p.d))
      .filter((c): c is NonNullable<typeof c> => c !== null && c.cy > 60 && c.cy < 78)
      .sort((a, b) => a.cx - b.cx);
    expect(eyes.length).toBe(2);
    expect(eyes[1].cy).toBeLessThan(eyes[0].cy);
  });

  it('keeps both eyes fully within the badge and below the head', () => {
    // SVG's relative arc deltas are negative for the return trip, so testing
    // every numeric token against 0..100 would reject a valid circle path.
    const eyes = fills
      .map((p) => parseCircle(p.d))
      .filter((c): c is NonNullable<typeof c> => c !== null && c.cy > 60 && c.cy < 78);
    expect(eyes).toHaveLength(2);
    for (const eye of eyes) {
      expect(eye.cx - eye.r).toBeGreaterThan(0);
      expect(eye.cx + eye.r).toBeLessThan(100);
      expect(eye.cy - eye.r).toBeGreaterThan(60);
      expect(eye.cy + eye.r).toBeLessThan(80);
    }
  });
});

/* ------------------------------------------------------------------ */
/* The SVG renderer                                                    */
/* ------------------------------------------------------------------ */

describe('brandSvg', () => {
  it('declares the namespace, so a bare innerHTML assignment still renders', () => {
    const svg = brandSvg('viber', { size: 64 });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox="0 0 100 100"');
    expect(svg).toContain('width="64"');
    expect(svg).toContain('height="64"');
    expect(svg.endsWith('</svg>')).toBe(true);
  });

  it('names itself for screen readers', () => {
    expect(brandSvg('crown')).toContain('role="img"');
    expect(brandSvg('crown')).toContain(`aria-label="${iconLabel('crown')}"`);
  });

  it('draws the badge plate by default and can drop it', () => {
    expect(brandSvg('quill')).toContain(`fill="${BRAND.ink}"`);
    const bare = brandSvg('quill', { badge: false });
    expect(bare).not.toContain('<rect');
  });

  it('is safe to assign as innerHTML', () => {
    // `iconNode()` sets `.innerHTML` with this string. Nothing user-supplied is
    // ever interpolated, and this pins that: no scripts, no event handlers, no
    // external references of any kind.
    for (const id of ICON_IDS) {
      const svg = brandSvg(id);
      expect(svg, id).not.toMatch(/<script/i);
      expect(svg, id).not.toMatch(/\son\w+=/i);
      expect(svg, id).not.toContain('url(');
      expect(svg, id).not.toContain('<image');
      expect(svg, id).not.toContain('<foreignObject');
      // The only absolute URL allowed is the SVG namespace itself.
      const urls = svg.match(/https?:\/\/[^"' ]+/g) ?? [];
      expect(urls, id).toEqual(['http://www.w3.org/2000/svg']);
    }
  });

  it('falls back to the house mark rather than throwing on an unknown id', () => {
    const svg = brandSvg('dragon' as never);
    expect(svg).toContain(`aria-label="${iconLabel('viber')}"`);
  });
});

/* ------------------------------------------------------------------ */
/* Narrowing a stored value                                            */
/* ------------------------------------------------------------------ */

describe('asIconId', () => {
  it('passes through every real id', () => {
    for (const id of ICON_IDS) expect(asIconId(id)).toBe(id);
  });

  it('substitutes the house mark for anything else', () => {
    // This is the path a profile saved before the picker existed takes, and the
    // path a hand-edited localStorage entry takes.
    expect(asIconId(undefined)).toBe('viber');
    expect(asIconId(null)).toBe('viber');
    expect(asIconId('')).toBe('viber');
    expect(asIconId('dragon')).toBe('viber');
    expect(asIconId(7)).toBe('viber');
    expect(asIconId({ icon: 'star' })).toBe('viber');
    expect(asIconId('VIBER')).toBe('viber'); // case matters: ids are exact
  });

  it('accepts a caller-chosen fallback', () => {
    expect(asIconId(undefined, 'voxel')).toBe('voxel');
  });

  it('maps a retired crest onto the one that took its slot', () => {
    /*
     * The picker's slots are what a player chose; the artwork inside them is
     * ours to redraw. Three crests were replaced, and a club saved before that
     * must keep its place in the picker rather than being silently handed the
     * house mark — which is exactly what dropping the ids would have done.
     */
    expect(asIconId('ball')).toBe('quill');
    expect(asIconId('bolt')).toBe('voxel');
    expect(asIconId('star')).toBe('spike');
  });
});
