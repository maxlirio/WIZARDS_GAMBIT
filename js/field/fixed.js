// Integer-only arithmetic. THE ONLY FILE IN js/ ALLOWED TO MENTION Math.*
//
// Every position, height, velocity and distance in the game is an integer number
// of MILLIMETRES. The reason is not performance, it is determinism across
// engines.
//
// Floats would in fact replay identically within one engine -- which is exactly
// what makes this trap dangerous, because every local test would pass. But
// Math.sqrt, Math.sin and Math.pow are NOT specified to be bit-identical across
// JS engines, so a float here breaks lockstep between a browser and node, and
// the only tool that would ever notice is checklockstep.js reporting an
// unexplained hash divergence forty moves deep. Integers delete the class.
//
// tools/checkfield.js greps the source as a hard build gate: any Math.* outside
// this file, or any `document`/`window` inside js/rules or js/field, fails.

/** One metre. The printed cards' "N squares" becomes N metres of real travel. */
export const M = 1000;
/** Metres -> millimetres. */
export const mm = (metres) => Math.round(metres * M);

/**
 * Floor division. NOT `(a / b) | 0`.
 *
 * `|0` truncates toward zero, so it rounds -3 and +3 in opposite directions.
 * On a map whose origin is a corner that is invisible until something is pushed
 * past the edge, at which point positions quietly stop being reproducible.
 */
export const idiv = (a, b) => Math.floor(a / b);

/* ----------------------------------------------------- integer housekeeping
 * Re-exported from here rather than used in place, because the source gate
 * forbids Math.* everywhere else and a blanket ban is the only kind anyone
 * remembers. abs/min/max/floor are exact on integers and perfectly safe; the
 * ban exists for sqrt, sin, cos, pow and atan, which are not specified
 * bit-identical across engines. One door, so the gate can be a one-line grep.
 */
export const iabs = (a) => (a < 0 ? -a : a);
export const imin = (a, b) => (a < b ? a : b);
export const imax = (a, b) => (a > b ? a : b);
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const isign = (a) => (a > 0 ? 1 : a < 0 ? -1 : 0);

/**
 * Nearest multiple of `q`, rounding halves UP (toward +inf) at every magnitude.
 *
 * Deliberately not Math.round's "half away from zero": a rule that changes
 * direction at the origin is the same bug `idiv` exists to avoid, one level up.
 */
export const snap = (v, q) => idiv(v + idiv(q, 2), q) * q;

/** Squared distance. Exact, and never needs a root. */
export const dist2 = (ax, ay, bx, by) => {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
};

/**
 * Squared distance in three dimensions, with the height term switchable.
 *
 * `heightK` is 1 normally and 0 under [Ignore Height]. That one coefficient IS
 * the entire implementation of that Keyword, which is a good sign the Keyword
 * layer sits at the right level.
 */
export const dist3 = (a, b, heightK = 1) => {
  const dz = a.z - b.z;
  return dist2(a.x, a.y, b.x, b.y) + heightK * dz * dz;
};

/** Is `b` within `r` of `a`? A comparison, never a root. */
export const within = (a, b, r, heightK = 1) => dist3(a, b, heightK) <= r * r;

/**
 * Integer square root, by Newton's method. Identical on every engine.
 *
 * Only for the rare case a real length is needed (reporting, or normalising a
 * long push). Range checks must use `within` instead.
 */
export function isqrt(n) {
  if (n <= 0) return 0;
  if (n < 4) return 1;
  let x = n, y = idiv(x + 1, 2);
  while (y < x) { x = y; y = idiv(x + idiv(n, x), 2); }
  return x;
}

export const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

/**
 * 64 unit vectors at scale 1024, as integer literals generated offline.
 *
 * There is no trigonometry at runtime anywhere in this game. A direction is a
 * table index, which also makes it trivially serialisable into an action log
 * and comparable across machines.
 */
export const DIR_SCALE = 1024;
export const DIR64 = Object.freeze([
  [1024,0], [1019,100], [1004,200], [980,297],
  [946,392], [903,483], [851,569], [792,650],
  [724,724], [650,792], [569,851], [483,903],
  [392,946], [297,980], [200,1004], [100,1019],
  [0,1024], [-100,1019], [-200,1004], [-297,980],
  [-392,946], [-483,903], [-569,851], [-650,792],
  [-724,724], [-792,650], [-851,569], [-903,483],
  [-946,392], [-980,297], [-1004,200], [-1019,100],
  [-1024,0], [-1019,-100], [-1004,-200], [-980,-297],
  [-946,-392], [-903,-483], [-851,-569], [-792,-650],
  [-724,-724], [-650,-792], [-569,-851], [-483,-903],
  [-392,-946], [-297,-980], [-200,-1004], [-100,-1019],
  [0,-1024], [100,-1019], [200,-1004], [297,-980],
  [392,-946], [483,-903], [569,-851], [650,-792],
  [724,-724], [792,-650], [851,-569], [903,-483],
  [946,-392], [980,-297], [1004,-200], [1019,-100],
].map(Object.freeze));

/**
 * The eight compass bearings, as DIR64 indices. Used for push prompts.
 *
 * x is EAST and y is NORTH, in metres, matching the sim convention in
 * HIGHGROUND (js/sim/map.js) -- NOT screen coordinates. So +y is north and
 * DIR64[16] = [0, +1024] is N. Getting this backwards mislabels every push
 * prompt in the game while every distance still computes correctly, so it is
 * asserted in tools/checkrotate.js rather than left to a comment.
 */
export const COMPASS = Object.freeze([
  { name: 'E',  dir: 0  }, { name: 'NE', dir: 8  },
  { name: 'N',  dir: 16 }, { name: 'NW', dir: 24 },
  { name: 'W',  dir: 32 }, { name: 'SW', dir: 40 },
  { name: 'S',  dir: 48 }, { name: 'SE', dir: 56 },
].map(Object.freeze));

/** Advance a point `mmDist` along direction index `d`. */
export const step = (x, y, d, mmDist) => {
  const [ux, uy] = DIR64[d & 63];
  return { x: x + idiv(ux * mmDist, DIR_SCALE), y: y + idiv(uy * mmDist, DIR_SCALE) };
};

/**
 * The DIR64 index pointing from a to b, without trig.
 *
 * Picks the table entry with the largest dot product. O(64) and exact, where
 * atan2 would be neither portable nor necessary.
 */
export function bearing(ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  if (dx === 0 && dy === 0) return 0;
  let best = 0, bestDot = -Infinity;
  for (let d = 0; d < 64; d++) {
    const [ux, uy] = DIR64[d];
    const dot = ux * dx + uy * dy;
    if (dot > bestDot) { bestDot = dot; best = d; }
  }
  return best;
}

export const opposite = (d) => (d + 32) & 63;
