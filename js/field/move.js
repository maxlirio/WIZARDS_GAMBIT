// Walking, climbing and falling.
//
// Bounded `for` loops ONLY. Not one `while`. Movement over continuous ground is
// exactly the place where a termination argument is easy to get wrong -- a
// blocked body that neither moves nor gives up is a hung game -- so every loop
// here counts steps against a limit it cannot exceed.
//
// Positions are recomputed FROM THE STARTING POINT on every step
// (`x0 + idiv(ux * k * STEP, DIR_SCALE)`) rather than accumulated. Adding a
// per-step delta truncates 64 times over a 6m walk, and the error is
// direction-dependent, so a unit that walks east and then west does not come
// home. From-the-origin costs one multiply and is exact.

import { idiv, imax, imin, isqrt, dist2, DIR64, DIR_SCALE } from './fixed.js';
import { inBounds, STEP, STEP_UP, CLIMB_COST, FALL_SAFE, propSpec } from './arena.js';
import { surfaceAt, settle, supported, blockingProp, blockingUnit, findProp, BODY_H } from './query.js';

/**
 * Every body carries `body: 'unit' | 'prop'`.
 *
 * A tag rather than a duck-type check. Units and props both have a `kind`, both
 * have x/y/z, and both get walked and pushed by the same code, so "does it have
 * an owner" is the sort of test that works until the day a neutral unit or an
 * owned prop exists.
 */
export const isUnitBody = (b) => b.body === 'unit';
export const fallKey = (b) => (isUnitBody(b) ? `u${b.id}` : `p${b.id}`);

/** The steepest single step a body can haul itself up. Above this, it is a wall. */
export const CLIMB_RATE = 750;
/** No single move may take more steps than this, whatever the budget says. */
export const MAX_STEPS = 200;

/** Damage per metre fallen beyond the safe drop. */
export const FALL_DAMAGE_PER_M = 1;

/**
 * Walk a body along a bearing, spending up to `budget` millimetres.
 *
 * Returns what actually happened, because almost every caller needs to know:
 * a push wants the shortfall (that is what [Crush] converts into damage), the
 * ledger wants the distance, and the view wants the path.
 */
export function walk(state, body, dir, budget, {
  allowFall = false, climb = true, ignoreUnits = false, probe = false,
} = {}) {
  const [ux, uy] = DIR64[dir & 63];
  const x0 = body.x, y0 = body.y, z0 = body.z;
  const self = isUnitBody(body) ? null : body.id;
  const maxSteps = imin(idiv(budget, STEP), MAX_STEPS);
  let taken = 0, cost = 0, climbed = 0;
  let blockedBy = null, fell = false;

  for (let k = 1; k <= maxSteps; k++) {
    const nx = x0 + idiv(ux * k * STEP, DIR_SCALE);
    const ny = y0 + idiv(uy * k * STEP, DIR_SCALE);
    if (!inBounds(state.arena, nx, ny)) { blockedBy = { kind: 'edge' }; break; }

    // The surface we would be standing on. Capped at a climbable rise, so a
    // body walking under a floating rock is not offered its top.
    const feet = body.z;
    const s = surfaceAt(state, nx, ny, { ignore: self, maxZ: feet + CLIMB_RATE });
    const rise = s.z - feet;

    if (rise > STEP_UP) {
      if (!climb) { blockedBy = { kind: 'rise', mm: rise }; break; }
      if (rise > CLIMB_RATE) { blockedBy = { kind: 'wall', mm: rise }; break; }
      if (s.support.kind === 'prop') {
        const pr = findProp(state, s.support.id);
        if (!pr || !propSpec(pr.kind).climbable) { blockedBy = { kind: 'sheer', id: s.support.id }; break; }
      }
    }
    if (rise < -FALL_SAFE && !allowFall) { blockedBy = { kind: 'drop', mm: -rise }; break; }

    const pr = blockingProp(state, nx, ny, imax(feet, s.z), { ignore: self });
    if (pr) { blockedBy = { kind: 'prop', id: pr.id }; break; }
    if (!ignoreUnits) {
      const u = blockingUnit(state, nx, ny, s.z, { ignore: isUnitBody(body) ? body.id : null });
      if (u) { blockedBy = { kind: 'unit', id: u.id }; break; }
    }

    const stepCost = rise > STEP_UP ? CLIMB_COST : 1;
    if ((cost + stepCost) * STEP > budget) { blockedBy = blockedBy || { kind: 'spent' }; break; }

    body.x = nx; body.y = ny; body.z = s.z; body.support = s.support;
    cost += stepCost;
    taken = k;
    if (rise > STEP_UP) climbed++;
    if (rise < -FALL_SAFE) { fell = true; break; }
  }

  if (taken === 0) {
    // Nothing moved, so nothing is re-settled: a body that could not take a
    // single step must be left exactly as it was, including its support, or a
    // failed push quietly re-seats whoever was standing on a prop.
    return { mm: 0, cost: 0, climbed: 0, blockedBy, fell: false, shortfall: budget };
  }
  const movedMm = isqrt(dist2(x0, y0, body.x, body.y));
  // A PROBE walks a throwaway copy of a body to find out how far it could get
  // (candidates.js does this for every direction of every unit on every
  // candidate action the AI considers). It must leave no trace at all: counting
  // a probe's climbs into the ledger would have the evaluator slowly inflating
  // a counter that gold faces score off.
  if (!probe) {
    if (climbed && isUnitBody(body)) state.players[body.owner].ledger.climbs += climbed;
    if (fell || !supported(state, body)) queueFall(state, body);
  }
  return {
    mm: movedMm, cost: cost * STEP, climbed, blockedBy, fell,
    shortfall: imax(0, budget - cost * STEP), fromZ: z0,
  };
}

/* ------------------------------------------------------------ falling */

/**
 * Falls are QUEUED IN STATE, not resolved on the spot.
 *
 * A push can drop three things at once, each of those landings can push
 * something else, and the whole cascade has to survive the effect driver
 * parking the game to ask a question in the middle of it. `field.pendingFalls`
 * is plain data on the state, so it snapshots and replays exactly; a recursive
 * resolve-on-the-spot would be a stack that cannot be serialised.
 */
export function queueFall(state, body) {
  const key = fallKey(body);
  if (!state.field.pendingFalls.includes(key)) state.field.pendingFalls.push(key);
}

/** Drain the fall queue. Bounded: each pass can only add bodies that exist. */
export function resolveFalls(state, hurt) {
  const landed = [];
  for (let pass = 0; pass < 8 && state.field.pendingFalls.length; pass++) {
    const batch = [...state.field.pendingFalls].sort();
    state.field.pendingFalls = [];
    for (const key of batch) {
      const isUnit = key[0] === 'u';
      const id = isUnit ? Number(key.slice(1)) : key.slice(1);
      const body = isUnit
        ? state.field.units.find((u) => u.id === id)
        : state.field.props.find((pr) => pr.id === id);
      if (!body || body.dead) continue;
      // A floating rock is held up by magic, not by the ground. It does not
      // fall when whatever was beneath it goes away -- which is precisely why
      // it is worth pushing one out from under somebody.
      if (!isUnit && propSpec(body.kind).floating) continue;
      const before = body.z;
      const s = surfaceAt(state, body.x, body.y, { ignore: isUnit ? null : body.id });
      if (s.z >= before) { body.z = s.z; body.support = s.support; continue; }
      body.z = s.z;
      body.support = s.support;
      const drop = before - s.z;
      landed.push({ key, drop, z: s.z });
      if (isUnit && drop > FALL_SAFE) {
        const dmg = idiv(drop - FALL_SAFE, 1000) * FALL_DAMAGE_PER_M;
        if (dmg > 0 && hurt) hurt(state, body, dmg, { cause: 'fall', drop });
      }
      // Anything that was standing on this prop has lost its footing.
      if (!isUnit) for (const u of state.field.units) {
        if (!u.dead && u.support?.kind === 'prop' && u.support.id === body.id) queueFall(state, u);
      }
    }
  }
  return landed;
}

/** Re-check every body's footing. Called after terrain changes. */
export function recheckSupport(state) {
  for (const u of state.field.units) if (!u.dead && !supported(state, u)) queueFall(state, u);
  for (const pr of state.field.props) {
    if (!propSpec(pr.kind).floating && !supported(state, pr)) queueFall(state, pr);
  }
}

/** Put a body down at a point, finding its footing. Used by summon and respawn. */
export function placeBody(state, body, x, y) {
  body.x = x; body.y = y;
  settle(state, body);
  return body;
}
