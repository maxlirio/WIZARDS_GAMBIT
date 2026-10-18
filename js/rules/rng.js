// Seeded randomness. ALL randomness in the rules and the field must come from
// here, or replay, save/restore and lockstep all break.
//
// sfc32, lifted from HIGHGROUND js/sim/rng.js, but refactored in one important
// way: the generator state is PLAIN DATA living on `state.rng` as a four-element
// array of integers, rather than being closed over inside an object.
//
// That refactor is forced by the effect driver. A card effect that stops to ask
// a question is parked as a snapshot of the state plus the answers so far, and
// replayed from that snapshot on every answer. If the dice lived in a closure
// they would not roll back with the snapshot, so a replayed effect would draw
// different numbers than it drew the first time -- and an effect is only
// required to be deterministic GIVEN its answers. Putting the state in the
// state is what makes that promise keepable.
//
// The AI must NOT draw from here. ai/ seeds its own generator from
// (state.seed, ply): if AI deliberation consumed the game's dice, then one side
// thinking harder than the other would desync a lockstep game.

/** Build a generator state from a seed. Four words, as plain integers. */
export function seedRng(seed) {
  let s = (seed | 0) >>> 0;
  const out = [];
  for (let i = 0; i < 4; i++) {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = (Math.imul(z ^ (z >>> 16), 0x21f0aaad)) >>> 0;
    z = (Math.imul(z ^ (z >>> 15), 0x735a2d97)) >>> 0;
    out.push((z ^ (z >>> 15)) >>> 0);
  }
  // sfc32 degenerates from all-zero state; a seed of 0 must still work.
  if (out.every((w) => w === 0)) out[3] = 1;
  return out;
}

/**
 * Advance the generator in place and return a float in [0, 1).
 *
 * Mutates `r`, which is `state.rng`. That is deliberate: the roll is part of
 * the game state transition, so it must be visible to the state hash.
 */
export function next(r) {
  let [a, b, c, d] = r;
  a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
  const t = (a + b + d) >>> 0;
  d = (d + 1) >>> 0;
  a = (b ^ (b >>> 9)) >>> 0;
  b = (c + (c << 3)) >>> 0;
  c = ((c << 21) | (c >>> 11)) >>> 0;
  c = (c + t) >>> 0;
  r[0] = a; r[1] = b; r[2] = c; r[3] = d;
  return t / 4294967296;
}

/** An integer in [0, n). */
export const int = (r, n) => (n <= 0 ? 0 : Math.floor(next(r) * n) % n);

/** An integer in [lo, hi], inclusive. */
export const range = (r, lo, hi) => lo + int(r, hi - lo + 1);

export const chance = (r, p) => next(r) < p;

/** Pick one element. Returns undefined for an empty list, never throws. */
export const pick = (r, list) => (list.length ? list[int(r, list.length)] : undefined);

/**
 * Fisher-Yates, in place, drawing from `r`.
 *
 * ONE implementation, exported, and every caller uses it. GUDNAK ended up with
 * two inline modulo shuffles in different files -- duplicated
 * determinism-critical code is a desync waiting for someone to edit one copy.
 */
export function shuffle(r, list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = int(r, i + 1);
    const t = list[i]; list[i] = list[j]; list[j] = t;
  }
  return list;
}

/** Snapshot / restore, for saves. The state is already plain data; copy it. */
export const save = (r) => [r[0], r[1], r[2], r[3]];
export const load = (r, saved) => { for (let i = 0; i < 4; i++) r[i] = saved[i]; };
