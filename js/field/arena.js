// The arena: a small seeded battlefield, generated as a pure function of the
// seed so two machines build the same ground without sending it over the wire.
//
// 12m x 9m, which is "arena" rather than "battlefield" on purpose -- everything
// is within a few moves of everything, and the terrain matters at every step
// instead of being scenery you march past.
//
// TWO REPRESENTATIONS, and the division is the whole design:
//
//   the HEIGHTFIELD is the ground. Integer millimetres on a 500mm node grid,
//   bilinearly sampled, quantised to 250mm so that a step up reads as a step
//   rather than a slope. It expresses plateaus, ramps, cliffs and pits.
//
//   PROPS are the things on the ground. Pillars, boulders, crystal shards,
//   floating rocks. They are addressable (printed Levitation removes a terrain
//   piece from the battlefield until end of turn, so terrain has to have names),
//   pushable, and some of them can be stood on -- which is where the game gets
//   to be about physics, because pushing a rock out from under someone drops
//   them.
//
// The heightfield lives on `state.arena`, which the effect driver does NOT
// clone: it is a pure function of the seed, so cloning 475 integers on every
// question would be pure waste. Props live on `state.field`, which IS cloned,
// because they move.
//
// There is no separate "ledges" list. A heightfield can express a cliff
// perfectly well -- a steep gradient -- and climbing one is a movement rule, not
// a geometry problem. What a heightfield cannot express is an OVERHANG, and this
// game does not need one. Floating rocks cover the case that actually matters.

import { M, idiv, dist2, iabs, imin, clamp, snap } from './fixed.js';
import { seedRng, int, range } from '../rules/rng.js';

export const ARENA_W = 12 * M;
export const ARENA_H = 9 * M;
export const NODE = 500;              // heightfield node spacing, mm
export const QUANT = 250;             // heights snap to this, so steps read as steps

/** Movement granularity. The engine is steppy by construction. */
export const STEP = 100;
/** A height difference a unit simply walks up. */
export const STEP_UP = 300;
/**
 * A height difference a unit simply steps DOWN.
 *
 * Deliberately smaller than it is tempting to make it. A body SHOVED over a
 * lip steeper than this goes airborne and keeps travelling at the height it
 * left, which is what turns a plateau into something worth standing on; a body
 * WALKING climbs down instead, at climbing cost. Set this loosely and nothing
 * in the arena can ever be fallen off.
 */
export const STEP_DOWN = 350;
/** Above this, it is a climb: half speed, and only on climbable ground. */
export const CLIMB_COST = 2;
/** Falls shorter than this hurt nobody. */
export const FALL_SAFE = 1000;
/** Bodies are this wide. Two of them cannot occupy the same 500mm. */
export const BODY_R = 250;

export const CHALLENGES = Object.freeze([
  'none',            // bare ground and rocks
  'spires',          // tall climbable pillars; height advantage everywhere
  'chasm',           // a trench across the middle; falls are lethal
  'levitation',      // several floating rocks, the push-them-out game
  'ruins',           // low walls; line of sight is the puzzle
  'causeway',        // one raised road between two pits
]);

/**
 * Build the static ground. Pure in `seed`; nothing here reads game state.
 *
 * Returns the object that lives at `state.arena` and is rebuilt rather than
 * cloned.
 */
export function makeArena(seed) {
  const r = seedRng(seed ^ 0x5bd1e995);
  const nx = idiv(ARENA_W, NODE) + 1;
  const ny = idiv(ARENA_H, NODE) + 1;
  const hs = new Array(nx * ny).fill(0);
  const challenge = CHALLENGES[int(r, CHALLENGES.length)];

  const at = (i, j) => j * nx + i;
  const raise = (cx, cy, rad, h) => {
    const rr = rad * rad;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const d = dist2(i * NODE, j * NODE, cx, cy);
        if (d > rr) continue;
        // A flat top with a steep rim: full height out to 70% of the radius,
        // then a short ramp. That gives a plateau you can stand on and a face
        // you have to climb, from one primitive.
        // A SHEER RIM, not a long ramp: full height out to 90% of the radius
        // and then straight down. The bilinear sample over a 500mm node grid
        // limits how fast ground can actually fall away, so a gentle rim on top
        // of that produced a plateau nobody could ever be pushed off -- eight
        // full AI games reported zero falls across ninety-nine metres of
        // pushing. Height comes from the plateau; steepness has to come from
        // the rim being narrower than a node.
        const inner = idiv(rr * 81, 100);
        const v = d <= inner ? h : idiv(h * (rr - d), rr - inner);
        if (v > hs[at(i, j)]) hs[at(i, j)] = v;
      }
    }
  };
  const trench = (y0, y1, depth) => {
    for (let j = 0; j < ny; j++) {
      const y = j * NODE;
      if (y < y0 || y > y1) continue;
      for (let i = 0; i < nx; i++) hs[at(i, j)] = -depth;
    }
  };

  // The middle third is where the fight happens, so the terrain goes there and
  // the two ends stay walkable -- an arena you cannot deploy into is not a map.
  const midLo = idiv(ARENA_W, 4), midHi = ARENA_W - idiv(ARENA_W, 4);

  if (challenge === 'chasm') {
    const cy = idiv(ARENA_H, 2);
    trench(cy - 900, cy + 900, 1500);
    // a crossing, so the two halves are not two separate games
    const bx = range(r, midLo, midHi);
    for (let j = 0; j < ny; j++) {
      const y = j * NODE;
      if (y < cy - 900 || y > cy + 900) continue;
      for (let i = 0; i < nx; i++) if (iabs(i * NODE - bx) <= 800) hs[at(i, j)] = 0;
    }
  } else if (challenge === 'causeway') {
    trench(0, idiv(ARENA_H, 2) - 1200, 1250);
    trench(idiv(ARENA_H, 2) + 1200, ARENA_H, 1250);
  } else {
    const plateaus = range(r, 2, 4);
    for (let k = 0; k < plateaus; k++) {
      // Tall enough to matter. A 500mm plateau is a kerb; the interesting
      // feature is one a body can be shoved off and take damage for.
      raise(range(r, midLo - 1000, midHi + 1000), range(r, 1200, ARENA_H - 1200),
            range(r, 1400, 2400), range(r, 3, challenge === 'spires' ? 7 : 5) * 500);
    }
  }

  // Quantise LAST. Everything above works in free millimetres and the snap
  // happens once, so a plateau's top is exactly level and a 250mm lip is a real
  // thing a unit either steps over or does not.
  for (let i = 0; i < hs.length; i++) hs[i] = snap(hs[i], QUANT);

  // Spawn circles at opposite ends, flattened so a respawning mage never
  // materialises inside a cliff.
  const spawns = [
    { x: 900, y: idiv(ARENA_H, 2), r: 900 },
    { x: ARENA_W - 900, y: idiv(ARENA_H, 2), r: 900 },
  ];
  for (const s of spawns) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (dist2(i * NODE, j * NODE, s.x, s.y) <= (s.r + NODE) * (s.r + NODE)) hs[at(i, j)] = 0;
      }
    }
  }

  const arena = { seed, w: ARENA_W, h: ARENA_H, node: NODE, nx, ny, hs, spawns, challenge };
  arena.median = medianHeight(arena);
  return arena;
}

function medianHeight(a) {
  const sorted = [...a.hs].sort((x, y) => x - y);
  return sorted[idiv(sorted.length, 2)];
}

/** Ground height at a point, bilinear over the node grid. Integers throughout. */
export function heightAt(a, x, y) {
  const cx = clamp(x, 0, a.w), cy = clamp(y, 0, a.h);
  const gi = imin(idiv(cx, a.node), a.nx - 2);
  const gj = imin(idiv(cy, a.node), a.ny - 2);
  const fx = cx - gi * a.node, fy = cy - gj * a.node;
  const h00 = a.hs[gj * a.nx + gi],       h10 = a.hs[gj * a.nx + gi + 1];
  const h01 = a.hs[(gj + 1) * a.nx + gi], h11 = a.hs[(gj + 1) * a.nx + gi + 1];
  const top = h00 * (a.node - fx) + h10 * fx;
  const bot = h01 * (a.node - fx) + h11 * fx;
  return idiv(top * (a.node - fy) + bot * fy, a.node * a.node);
}

/** Is the ground under a disc of radius `r` level enough to set something on? */
export function flatEnough(a, x, y, r, tol = QUANT) {
  const h = heightAt(a, x, y);
  for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
    if (iabs(heightAt(a, x + dx, y + dy) - h) > tol) return false;
  }
  return true;
}

export const inBounds = (a, x, y) => x >= BODY_R && y >= BODY_R && x <= a.w - BODY_R && y <= a.h - BODY_R;

/** How much higher than the arena's median this ground is. The "high ground". */
export const aboveMedian = (a, x, y) => heightAt(a, x, y) - a.median;

/* ------------------------------------------------------------ props */

const PROP_KINDS = Object.freeze({
  boulder: { r: 450, h: 700, mass: 2, climbable: true, platform: true, pushable: true },
  pillar:  { r: 350, h: 2200, mass: 4, climbable: true, platform: false, pushable: false },
  shard:   { r: 250, h: 1400, mass: 1, climbable: false, platform: false, pushable: true },
  wall:    { r: 700, h: 1100, mass: 6, climbable: true, platform: true, pushable: false },
  floater: { r: 500, h: 400, mass: 1, climbable: false, platform: true, pushable: true, floating: true },
});

export const PROP_TYPES = Object.freeze(Object.keys(PROP_KINDS).sort());
export const propSpec = (kind) => PROP_KINDS[kind];

/**
 * Scatter the terrain pieces. Mutable, so these live on state.field.
 *
 * Every piece gets a NAME (`r3`, `p1`) because printed Levitation I removes a
 * terrain piece from the battlefield until end of turn, and you cannot remove
 * something you cannot refer to.
 */
export function makeProps(arena, seed) {
  const r = seedRng(seed ^ 0x27d4eb2f);
  const out = [];
  const want = arena.challenge === 'levitation'
    ? { floater: 5, boulder: 3, shard: 2 }
    : arena.challenge === 'spires' ? { pillar: 6, boulder: 2 }
    : arena.challenge === 'ruins' ? { wall: 5, shard: 3, boulder: 2 }
    : { boulder: 4, pillar: 2, shard: 3, floater: 1 };

  const midLo = idiv(arena.w, 5), midHi = arena.w - idiv(arena.w, 5);
  for (const kind of Object.keys(want).sort()) {
    const spec = PROP_KINDS[kind];
    for (let k = 0; k < want[kind]; k++) {
      let x = 0, y = 0, ok = false;
      // A bounded search. Twenty tries and then this piece simply does not
      // exist -- an unbounded "keep looking" loop is a hang waiting for a seed
      // that fills the map.
      for (let tries = 0; tries < 20 && !ok; tries++) {
        x = range(r, midLo, midHi);
        y = range(r, 700, arena.h - 700);
        // o.r does not exist: a prop's radius lives on its KIND, not its
        // instance, so that pushing one around cannot change its size. Reading
        // o.r gave NaN, every comparison against NaN is false, and the search
        // failed every time after the first piece -- every arena came out with
        // exactly one boulder on it.
        ok = out.every((o) => dist2(o.x, o.y, x, y) > (PROP_KINDS[o.kind].r + spec.r + 300) ** 2)
          && arena.spawns.every((s) => dist2(s.x, s.y, x, y) > (s.r + spec.r + 400) ** 2)
          && flatEnough(arena, x, y, spec.r);
      }
      if (!ok) continue;
      // Snapped to the height quantum, so a prop you can stand on has a top at
      // a crisp height. Unsnapped, a boulder on a ramp sat at 793mm and the
      // step up onto it was a different size on every side of it.
      const base = snap(heightAt(arena, x, y), QUANT);
      out.push({
        id: `${kind[0]}${out.length}`, kind, x, y,
        // A floater hovers: its base sits above the ground and stays there,
        // because it is held up by magic rather than by anything a push can
        // take away. What a push CAN do is shove it sideways out from under
        // whoever is standing on it, which is the interesting half.
        z: spec.floating ? base + range(r, 2, 4) * 500 : base,
        removedUntil: null,
      });
    }
  }
  return out;
}

export const propR = (prop) => PROP_KINDS[prop.kind].r;
export const propH = (prop) => PROP_KINDS[prop.kind].h;
export const propTop = (prop) => prop.z + PROP_KINDS[prop.kind].h;
export const propOnBoard = (state, prop) =>
  prop.removedUntil === null || prop.removedUntil < state.turn;
