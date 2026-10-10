// sim/core/math.ts — pure math helpers. No DOM / no three.js.

export interface Vec2 {
  x: number;
  y: number;
}

export const v2 = (x = 0, y = 0): Vec2 => ({ x, y });
export const clone = (a: Vec2): Vec2 => ({ x: a.x, y: a.y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const distSq = (a: Vec2, b: Vec2): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};
export const norm = (a: Vec2): Vec2 => {
  const l = Math.hypot(a.x, a.y);
  return l > 1e-6 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
};
export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const lerpVec = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
});
export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x);
export const fromAngle = (ang: number, mag = 1): Vec2 => ({
  x: Math.cos(ang) * mag,
  y: Math.sin(ang) * mag,
});
/** Shortest signed angular difference b - a, wrapped to [-PI, PI]. */
export const angleDiff = (a: number, b: number): number => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};
/** Move `cur` toward `target` by at most `maxDelta`. */
export const moveToward = (cur: number, target: number, maxDelta: number): number => {
  const d = target - cur;
  if (Math.abs(d) <= maxDelta) return target;
  return cur + Math.sign(d) * maxDelta;
};
