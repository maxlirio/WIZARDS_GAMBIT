// The hinge between a continuous world and a finite question.
//
// You cannot `ask.one` over a continuum. A card that says "push a unit" has to
// become a list of clickable choices, and a card that says "relocate it three
// away" has to become a list of landing points. Every function here turns a
// region of the arena into a FINITE, DEDUPED, SORTED, DETERMINISTIC option list.
//
// Sorted is not cosmetic and the sort is not at the call site. A candidate list
// whose order depends on iteration order -- Set insertion, object key order, the
// order props happen to sit in an array -- is a lockstep desync that no other
// tool in the suite will catch, because both engines compute the same SET and
// then the player's answer (an index) means two different things. This file is
// where that is prevented, which also makes it the likeliest source of a field
// bug, so it is kept small and every list is sorted on the way out.

import { idiv, imin, imax, isqrt, dist2, dist3, DIR64, DIR_SCALE, COMPASS, bearing, step } from './fixed.js';
import { inBounds, BODY_R, STEP, propSpec, propR } from './arena.js';
import {
  surfaceAt, walkable, livingUnits, unitsOf, enemiesOf, rangeOrigins, propsOnBoard,
  hasLos, inRange,
} from './query.js';
import { walk } from './move.js';

const uniqSort = (nums) => [...new Set(nums)].sort((a, b) => a - b);

/**
 * Directions a push may be aimed in.
 *
 * The eight named compass bearings, plus "directly away from each of the
 * pusher's range origins", which is the phrasing nearly every printed push
 * uses. The extra bearings are snapped onto the 64-direction table like
 * everything else, so the answer a player gives is always an integer index.
 */
export function pushDirs() {
  // Every bearing. The player answers by DRAGGING on the battlefield and the
  // view snaps the drag to the nearest table direction, so the option list is
  // the whole table -- still finite, still an integer index.
  return ALL_DIRS;
}
const ALL_DIRS = Object.freeze(Array.from({ length: 64 }, (_, i) => i));

/**
 * The bearings a sensible player reaches for first: "directly away from each
 * of the pusher's range origins". The HUD offers them as buttons labelled as
 * such (beside the compass) for anyone who would rather not drag, and the AI
 * samples them plus the compass rather than all sixty-four.
 */
export function pushPreferred(state, p, target) {
  const dirs = [];
  for (const o of rangeOrigins(state, p)) {
    if (o.x === target.x && o.y === target.y) continue;
    dirs.push(bearing(o.x, o.y, target.x, target.y));
  }
  return [...new Set(dirs)];
}

export const dirLabel = (d) => {
  const exact = COMPASS.find((c) => c.dir === (d & 63));
  if (exact) return exact.name;
  let best = COMPASS[0];
  for (const c of COMPASS) {
    const da = ((d - c.dir) & 63), db = ((d - best.dir) & 63);
    if (imin(da, 64 - da) < imin(db, 64 - db)) best = c;
  }
  return `${best.name}+`;
};

/**
 * A ring of landing points at roughly `mmDist` from a point.
 *
 * Printed phrasings like "relocate it to a position three away" become a
 * sixteen-point annulus, each sample snapped to the nearest standable ground
 * and dropped if nothing there can be stood on. Sixteen because it is enough to
 * feel like a choice of direction and few enough to render as buttons.
 *
 * The samples are generated in increasing direction index and the survivors
 * keep that order, so the list is stable without a sort over coordinates.
 */
export function ringPoints(state, from, mmDist, { samples = 16, forId = null } = {}) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < samples; i++) {
    const d = idiv(i * 64, samples);
    const q = step(from.x, from.y, d, mmDist);
    if (!inBounds(state.arena, q.x, q.y)) continue;
    const s = surfaceAt(state, q.x, q.y);
    if (!walkable(state, q.x, q.y, s.z, { ignore: forId })) continue;
    const key = `${q.x},${q.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ x: q.x, y: q.y, z: s.z, dir: d });
  }
  return out;
}

/** The highest standable point on the ring. Printed Levitation IV's "closest elevated position". */
export function elevatedNear(state, body, mmDist) {
  const pts = [
    ...ringPoints(state, body, mmDist, { forId: body.id }),
    ...ringPoints(state, body, idiv(mmDist, 2), { forId: body.id }),
  ];
  if (!pts.length) return null;
  // Highest first; ties broken by the direction index, never by array order.
  pts.sort((a, b) => (b.z - a.z) || (a.dir - b.dir));
  return pts[0];
}

/**
 * Where a unit can actually get to, as a list of bearings.
 *
 * Only bearings that move it at least one step survive, so a unit wedged into a
 * corner is offered the two directions that work rather than eight buttons of
 * which six do nothing. Measured by a trial walk on a scratch body -- the real
 * unit is never touched.
 */
export function moveDirs(state, unit) {
  const dirs = COMPASS.map((c) => c.dir);
  for (const e of enemiesOf(state, unit.owner)) dirs.push(bearing(unit.x, unit.y, e.x, e.y));
  const out = [];
  for (const d of uniqSort(dirs)) {
    const reach = trialWalk(state, unit, d, unit.move);
    if (reach.mm >= STEP) out.push({ dir: d, mm: reach.mm, z: reach.z, label: dirLabel(d) });
  }
  return out;
}

/**
 * How far a walk WOULD go, without moving anything.
 *
 * A copy of the body is walked instead of the body, so the probe cannot leave a
 * trace. The AI calls this for every direction of every unit on every candidate
 * action, and a probe that nudged the real unit by one step would be an
 * evaluator that slowly rearranges the board it is thinking about.
 */
export function trialWalk(state, unit, dir, budget, { vec = null, stopAfter = 0 } = {}) {
  // The ghost KEEPS the real unit's id on purpose. blockingUnit excludes
  // `ignore` by id, so a ghost with a fresh id would collide with the body it
  // was copied from on its very first step and every direction would report
  // zero.
  const ghost = { ...unit, keywords: [...(unit.keywords || [])] };
  const before = { x: ghost.x, y: ghost.y };
  const r = walk(state, ghost, dir, budget, { allowFall: false, climb: true, probe: true, vec, stopAfter });
  return { mm: r.mm, x: ghost.x, y: ghost.y, z: ghost.z, blockedBy: r.blockedBy, from: before };
}

/* ------------------------------------------------------------ target lists */

// Through query.js's `inRange`, not an inline dist3 comparison. There is ONE
// range function in the game, which is the entire reason [Ignore Height] can be
// a single coefficient; a second comparison here would be a keyword that works
// on some cards and not others.
export const unitTargets = (state, p, mmDist, { side = 'enemy', heightK = 1, needLos = false } = {}) => {
  const pool = side === 'enemy' ? enemiesOf(state, p) : side === 'friendly' ? unitsOf(state, p) : livingUnits(state);
  const origins = rangeOrigins(state, p);
  return pool
    .filter((u) => inRange(state, p, u, mmDist, heightK))
    .filter((u) => !needLos || origins.some((o) => hasLos(state, o, u)))
    .map((u) => u.id)
    .sort((a, b) => a - b);
};

export const terrainTargets = (state, p, mmDist, { pushableOnly = false } = {}) =>
  propsOnBoard(state)
    .filter((pr) => !pushableOnly || propSpec(pr.kind).pushable)
    .filter((pr) => inRange(state, p, { x: pr.x, y: pr.y, z: pr.z }, mmDist, 1))
    .map((pr) => pr.id)
    .sort();

/**
 * ANYTHING on the battlefield: every living unit of either side, then every
 * pushable terrain piece. Unit ids are numbers, prop ids strings, so a body
 * list is unambiguous and `ctx.shove` tells them apart by type. Shift pushes
 * "anything on each side" (user) -- its own mage, the enemy golem, a boulder.
 */
export const bodyTargets = (state, p, mmDist, { heightK = 1 } = {}) => [
  ...unitTargets(state, p, mmDist, { side: 'any', heightK }),
  ...terrainTargets(state, p, mmDist, { pushableOnly: true }),
];

/** Points adjacent to a unit where a new body could be set down. */
export const summonPoints = (state, mage, mmDist = 1200) =>
  ringPoints(state, mage, mmDist, { samples: 8 });
