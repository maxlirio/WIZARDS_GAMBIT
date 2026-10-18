// Reading the battlefield. No mutation anywhere in this file.
//
// Everything a card asks about the world comes through here: what is standing
// where, what is holding it up, what it can reach, what it can see. Range in
// particular is one function, because [Ignore Height] is implemented by passing
// `heightK = 0` into it and nothing else -- a second range check somewhere
// would be a keyword that works on some cards and not others.

import {
  dist2, dist3, within, idiv, iabs, imin, imax, isqrt, clamp,
  DIR64, DIR_SCALE,
} from './fixed.js';
import {
  heightAt, inBounds, aboveMedian, propOnBoard, propR, propH, propTop, propSpec,
  BODY_R, STEP_UP, QUANT,
} from './arena.js';
import { applyFor } from '../rules/keywords.js';

/** How tall a body is. Used for "can I walk under that floating rock". */
export const BODY_H = 1800;
/** Eye height, for line of sight. */
export const EYE = 1500;

/* ------------------------------------------------------------ lookups */

export const units = (state) => state.field.units;
export const livingUnits = (state) => state.field.units.filter((u) => !u.dead);
export const unitsOf = (state, p) => livingUnits(state).filter((u) => u.owner === p);
export const enemiesOf = (state, p) => livingUnits(state).filter((u) => u.owner !== p);
export const findUnit = (state, id) => state.field.units.find((u) => u.id === id) || null;
export const mageOf = (state, p) => state.field.units.find((u) => u.owner === p && u.kind === 'mage') || null;
export const findProp = (state, id) => state.field.props.find((pr) => pr.id === id) || null;
export const propsOnBoard = (state) => state.field.props.filter((pr) => propOnBoard(state, pr));

/**
 * A unit's keywords: its card's printed ones plus anything written onto the
 * body. Sorted and unique at every site -- insertion order is a lockstep
 * divergence, and GUDNAK had to be taught that twice.
 */
export function unitKeywords(state, u) {
  const printed = u.def ? (state.defs[u.def]?.keywords || []) : [];
  return [...new Set([...printed, ...(u.keywords || [])])].sort();
}
export const unitHas = (state, u, kw) => unitKeywords(state, u).includes(kw);

/* ------------------------------------------------------------ support */

/**
 * The highest surface a body could stand on at (x, y), and what it is.
 *
 * `z` is ALWAYS recomputed from here, never accumulated. A body that adds a
 * delta to its own z each step drifts: walk out onto a slope and back and you
 * end up at a different height than you started, and after enough moves a unit
 * is standing inside the ground. One source of truth, re-read every time.
 */
export function surfaceAt(state, x, y, { ignore = null, maxZ = null } = {}) {
  let z = heightAt(state.arena, x, y);
  let support = { kind: 'ground' };
  for (const pr of state.field.props) {
    if (pr.id === ignore || !propOnBoard(state, pr)) continue;
    if (!propSpec(pr.kind).platform) continue;
    if (dist2(pr.x, pr.y, x, y) > propR(pr) * propR(pr)) continue;
    const top = propTop(pr);
    if (maxZ !== null && top > maxZ) continue;
    if (top > z) { z = top; support = { kind: 'prop', id: pr.id }; }
  }
  return { z, support };
}

/** Put a body on the surface under it. The only way z is ever written. */
export function settle(state, body, { maxZ = null } = {}) {
  const s = surfaceAt(state, body.x, body.y, { ignore: body.propId || null, maxZ });
  body.z = s.z;
  body.support = s.support;
  return s;
}

/** Does `support` still name something that exists and is still under the body? */
export function supported(state, body) {
  if (!body.support) return false;
  if (body.support.kind === 'ground') return true;
  const pr = findProp(state, body.support.id);
  if (!pr || !propOnBoard(state, pr)) return false;
  if (dist2(pr.x, pr.y, body.x, body.y) > propR(pr) * propR(pr)) return false;
  return iabs(propTop(pr) - body.z) <= QUANT;
}

/* ------------------------------------------------------------ obstruction */

/**
 * The prop that physically stops a body walking into (x, y) with feet at `feet`.
 *
 * Three cases and they are all real: a top low enough to step over is not an
 * obstacle, a base high enough to walk under is not an obstacle, and anything
 * whose span crosses yours is. The middle case is the whole reason a floating
 * rock is interesting -- you can stand under one, and then it can be pushed out
 * from over you, or from under someone else.
 */
export function blockingProp(state, x, y, feet, { ignore = null, r = BODY_R } = {}) {
  for (const pr of state.field.props) {
    if (pr.id === ignore || !propOnBoard(state, pr)) continue;
    const reach = propR(pr) + r;
    if (dist2(pr.x, pr.y, x, y) > reach * reach) continue;
    if (propTop(pr) <= feet + STEP_UP) continue;
    if (pr.z >= feet + BODY_H) continue;
    return pr;
  }
  return null;
}

/** The unit standing in the way at (x, y), if any. */
export function blockingUnit(state, x, y, feet, { ignore = null } = {}) {
  for (const u of state.field.units) {
    if (u.dead || u.id === ignore) continue;
    if (dist2(u.x, u.y, x, y) > (BODY_R * 2) * (BODY_R * 2)) continue;
    if (iabs(u.z - feet) > BODY_H) continue;
    return u;
  }
  return null;
}

export const walkable = (state, x, y, feet, opts = {}) =>
  inBounds(state.arena, x, y) && !blockingProp(state, x, y, feet, opts)
  && !blockingUnit(state, x, y, feet, opts);

/* ------------------------------------------------------------ range */

/**
 * Where a spell measures from.
 *
 * Your mage, plus any golem unit carrying [Channel]. That is what makes losing
 * your mage cost more than a unit phase: most of your spell table stops
 * reaching anything. Sorted by id so the list is stable.
 */
export function rangeOrigins(state, p) {
  return livingUnits(state)
    .filter((u) => u.owner === p && isOrigin(state, u))
    .sort((a, b) => a.id - b.id);
}

/** Through the keyword funnel, so a second origin-granting keyword just works. */
export const isOrigin = (state, u) =>
  applyFor(unitKeywords(state, u), 'origin', { isOrigin: u.kind === 'mage' }).isOrigin;

/**
 * Is `target` within `mm` of any of `p`'s origins?
 *
 * `heightK` is 1 normally and 0 under [Ignore Height]. No square root is taken
 * anywhere: `dist3 <= r*r`.
 */
export function inRange(state, p, target, mmDist, heightK = 1) {
  const r = mmDist;
  return rangeOrigins(state, p).some((o) => dist3(o, target, heightK) <= r * r);
}

/** Melee: can `a` strike `b`? `reach` is in mm and comes from the unit. */
export const canStrike = (state, a, b) =>
  !a.dead && !b.dead && a.owner !== b.owner && dist3(a, b, 1) <= a.reach * a.reach;

export const strikeTargets = (state, a) => enemiesOf(state, a.owner).filter((b) => canStrike(state, a, b)).sort((x, y) => x.id - y.id);

/* ------------------------------------------------------------ height */

export const onHighGround = (state, body) => aboveMedian(state.arena, body.x, body.y) >= 750;

/* ------------------------------------------------------------ line of sight */

/**
 * Ray-march from one body's eyes to another's, integer only.
 *
 * Compares by CROSS-MULTIPLICATION rather than dividing: the ray's height at a
 * sample is `az + (bz-az)*t/n`, and testing `ground <= that` as
 * `ground*n <= az*n + (bz-az)*t` keeps the whole thing in integers. A division
 * here would round, and a rounding rule is exactly the kind of thing two
 * engines can be made to disagree about by a compiler.
 *
 * Steps are bounded by construction: the arena's diagonal is 15m and the sample
 * spacing is 250mm, so `n` never exceeds 60.
 */
export function hasLos(state, a, b, { fromZ = null, toZ = null } = {}) {
  const az = (fromZ === null ? a.z + EYE : fromZ);
  const bz = (toZ === null ? b.z + EYE : toZ);
  const dx = b.x - a.x, dy = b.y - a.y;
  const span = imax(iabs(dx), iabs(dy));
  const n = clamp(idiv(span, 250), 1, 60);
  for (let t = 1; t < n; t++) {
    const x = a.x + idiv(dx * t, n);
    const y = a.y + idiv(dy * t, n);
    const rayZ_times_n = az * n + (bz - az) * t;
    if (heightAt(state.arena, x, y) * n > rayZ_times_n) return false;
    for (const pr of state.field.props) {
      if (!propOnBoard(state, pr)) continue;
      if (dist2(pr.x, pr.y, x, y) > propR(pr) * propR(pr)) continue;
      if (pr.z * n <= rayZ_times_n && propTop(pr) * n >= rayZ_times_n) return false;
    }
  }
  return true;
}
