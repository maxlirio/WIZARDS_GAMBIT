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
import { inBounds, STEP, STEP_UP, STEP_DOWN, CLIMB_COST, FALL_SAFE, propSpec, BODY_R, heightAt } from './arena.js';
import { surfaceAt, settle, supported, blockingProp, blockingUnit, findProp, BODY_H } from './query.js';
import { propTop, propR } from './arena.js';

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

/**
 * The steepest step of GROUND a body can haul itself up, per 100mm. 250 is
 * 68 degrees; above that the ground is a wall and the way up is a ramp.
 */
export const CLIMB_RATE = 250;
/**
 * Onto a climbable PROP (a boulder, a wall, a floating rock) the step is its
 * whole height at once, because its side is vertical. This is the tallest
 * such top a body can reach from the ground.
 */
export const PROP_CLIMB = 1400;
/** No single move may take more steps than this, whatever the budget says. */
export const MAX_STEPS = 200;

/**
 * Fall damage: one point for clearing the safe drop at all, and one more per
 * further metre.
 *
 * The first version was `idiv(drop - FALL_SAFE, 1000)`, which is ZERO for every
 * drop under two metres -- and arena plateaus are 1.5 to 2.5m, so pushing
 * somebody off one was free. Seven falls across six full AI games did a
 * combined zero damage, and the instrument panel in selfplay.js is what said
 * so.
 */
export const fallDamageFor = (drop) => (drop <= FALL_SAFE ? 0 : 1 + idiv(drop - FALL_SAFE, 1000));

/**
 * Walk a body along a bearing, spending up to `budget` millimetres.
 *
 * Returns what actually happened, because almost every caller needs to know:
 * a push wants the shortfall (that is what [Crush] converts into damage), the
 * ledger wants the distance, and the view wants the path.
 */
export function walk(state, body, dir, budget, {
  allowFall = false, climb = true, ignoreUnits = false, probe = false, vec = null, stopAfter = 0, riders = null,
} = {}) {
  // `vec` walks an exact heading (integer, scale DIR_SCALE) instead of one of
  // the 64 table directions: a unit told to walk to a POINT must head at that
  // point, and the nearest table direction can miss it by a body width at 2m.
  const [ux, uy] = vec || DIR64[dir & 63];
  const x0 = body.x, y0 = body.y, z0 = body.z;
  const self = isUnitBody(body) ? null : body.id;
  // The walking body's own radius: a rock is as wide as a rock. With a unit's
  // radius a shoved boulder stopped only when its CENTRE came within a body
  // width of a unit, and left the unit standing inside its footprint.
  const br = isUnitBody(body) ? BODY_R : propR(body);
  // Already overlapping something (a rock shoved onto you, a summon squeezed
  // in): that thing never blocks a step that takes you further from it, or
  // the body is wedged for good (user: "the moving broke for one of my guys").
  const awayFrom = (o, nx, ny) => dist2(o.x, o.y, nx, ny) > dist2(o.x, o.y, body.x, body.y);
  // A unit standing inside a prop's footprint is wedged: for steps that lead
  // out of it, that prop is not a surface to climb either -- the ground is.
  const wedgedIn = isUnitBody(body) ? blockingProp(state, x0, y0, z0, { ignore: self, r: br }) : null;
  // `stopAfter`: a walk TO A POINT stops once it has covered that distance,
  // while still spending the whole budget on the way (climb steps cost more
  // than they cover, so capping the budget at the distance stopped a 2.6 m
  // walk up a plateau at 2.2 m -- short of the spot the player clicked).
  const maxSteps = imin(imin(idiv(budget, STEP), MAX_STEPS), stopAfter > 0 ? idiv(stopAfter + STEP - 1, STEP) : MAX_STEPS);
  let taken = 0, cost = 0, climbed = 0;
  let blockedBy = null, fell = false, airborneFrom = -1;

  for (let k = 1; k <= maxSteps; k++) {
    const nx = x0 + idiv(ux * k * STEP, DIR_SCALE);
    const ny = y0 + idiv(uy * k * STEP, DIR_SCALE);
    if (!inBounds(state.arena, nx, ny)) { blockedBy = { kind: 'edge' }; break; }

    // The surface we would be standing on. Capped at a climbable rise, so a
    // body walking under a floating rock is not offered its top.
    const feet = body.z;
    const leaving = wedgedIn && awayFrom(wedgedIn, nx, ny) ? wedgedIn.id : self;
    const s = surfaceAt(state, nx, ny, { ignore: leaving, maxZ: feet + PROP_CLIMB });
    const rise = s.z - feet;

    if (rise > STEP_UP) {
      if (!climb) { blockedBy = { kind: 'rise', mm: rise }; break; }
      if (s.support.kind === 'prop') {
        const pr = findProp(state, s.support.id);
        if (!pr || !propSpec(pr.kind).climbable) { blockedBy = { kind: 'sheer', id: s.support.id }; break; }
        if (rise > PROP_CLIMB) { blockedBy = { kind: 'wall', mm: rise }; break; }
      } else if (rise > CLIMB_RATE) { blockedBy = { kind: 'wall', mm: rise }; break; }
      // A CLIMB IS ATOMIC. Nobody stops half way up a face: if the budget
      // cannot carry the body to where the ground levels off again, the climb
      // is not started. Probed ahead, bounded by the budget, touching nothing.
      if (!climbFits(state, body, x0, y0, ux, uy, k, feet, cost, budget, self)) { blockedBy = { kind: 'climb', mm: rise }; break; }
    }
    if (rise < -STEP_DOWN) {
      // Over a lip. A body being PUSHED goes airborne; a body WALKING climbs
      // down if the drop is within climbing reach and refuses to jump if it is
      // not.
      if (!allowFall) {
        if (!climb || -rise > CLIMB_RATE) { blockedBy = { kind: 'drop', mm: -rise }; break; }
      } else {
        airborneFrom = k;
        break;
      }
    }

    let pr = blockingProp(state, nx, ny, imax(feet, s.z), { ignore: leaving, r: br });
    if (pr && blockingProp(state, body.x, body.y, feet, { ignore: self, r: br }) === pr && awayFrom(pr, nx, ny)) pr = null;
    if (pr) {
      // A climbable piece in the way is a thing to get ON TOP OF: the body
      // scrambles up its side and lands on its top, as one atomic climb.
      const up = climb ? mountOnto(state, body, pr, x0, y0, ux, uy, k, feet, cost, budget, maxSteps, self) : null;
      if (!up) { blockedBy = { kind: 'prop', id: pr.id }; break; }
      body.x = up.x; body.y = up.y; body.z = up.z; body.support = { kind: 'prop', id: pr.id };
      cost = up.cost; taken = up.k; climbed++;
      k = up.k;
      continue;
    }
    if (!ignoreUnits) {
      // A prop never collides with the units riding on it: they move with it.
      const me = isUnitBody(body) ? body.id : null;
      let u = blockingUnit(state, nx, ny, s.z, { ignore: me, ignoreIds: riders, r: br + BODY_R });
      if (u && blockingUnit(state, body.x, body.y, feet, { ignore: me, ignoreIds: riders, r: br + BODY_R }) === u && awayFrom(u, nx, ny)) u = null;
      if (u) { blockedBy = { kind: 'unit', id: u.id }; break; }
    }

    const stepCost = rise > STEP_UP ? CLIMB_COST : 1;
    if ((cost + stepCost) * STEP > budget) { blockedBy = blockedBy || { kind: 'spent' }; break; }

    cost += stepCost;
    taken = k;
    if (rise > STEP_UP) climbed++;
    // A climb DOWN costs the same as a climb up: you are on the rock either way.
    if (rise < -STEP_DOWN) climbed++;
    body.x = nx; body.y = ny; body.z = s.z; body.support = s.support;
  }

  // (see climbFits below for the look-ahead a climb step makes first)
  // AIRBORNE. A shoved body that has gone over a lip keeps travelling at the
  // height it left and only finds the ground when the push runs out. That is
  // what makes being pushed off a plateau worse than walking off one, and it is
  // the whole reason height is worth holding.
  //
  // The drop itself is NOT applied here: the body keeps its z, loses its
  // support, and the fall queue works out how far it actually is and what it
  // costs. Seating it on the lower surface at this point means the fall has
  // already quietly happened by the time resolveFalls looks -- `before` already
  // equals the landing height, no drop is detected, and nobody ever takes fall
  // damage.
  if (airborneFrom >= 0) {
    for (let k = airborneFrom; k <= maxSteps; k++) {
      if ((cost + 1) * STEP > budget) break;
      const nx = x0 + idiv(ux * k * STEP, DIR_SCALE);
      const ny = y0 + idiv(uy * k * STEP, DIR_SCALE);
      if (!inBounds(state.arena, nx, ny)) { blockedBy = { kind: 'edge' }; break; }
      const under = surfaceAt(state, nx, ny, { ignore: self });
      if (under.z > body.z) { blockedBy = { kind: 'rise', mm: under.z - body.z }; break; }
      // What a flying body hits is NAMED, so the impact can shove it on: a
      // floating rock slammed into a floating rock moves them both.
      const bp = blockingProp(state, nx, ny, body.z, { ignore: self, r: br });
      if (bp) { blockedBy = { kind: 'prop', id: bp.id }; break; }
      if (!ignoreUnits) {
        const bu = blockingUnit(state, nx, ny, body.z, { ignore: isUnitBody(body) ? body.id : null, ignoreIds: riders, r: br + BODY_R });
        if (bu) { blockedBy = { kind: 'unit', id: bu.id }; break; }
      }
      body.x = nx; body.y = ny;
      cost += 1;
      taken = k;
    }
    body.support = null;
    fell = true;
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

/**
 * Scramble onto a climbable piece that is blocking step `k`.
 *
 * Finds the first step along the same line whose footprint is over the
 * piece's top, charges a climb for every step from here to there, and refuses
 * if the budget cannot cover it (nobody hangs off the side of a rock) or if
 * the top is already taken.
 */
function mountOnto(state, body, pr, x0, y0, ux, uy, k, feet, cost, budget, maxSteps, self) {
  if (!propSpec(pr.kind).climbable) return null;
  const top = propTop(pr);
  const rise = top - feet;
  if (rise <= STEP_UP || rise > PROP_CLIMB) return null;
  const rr = propR(pr) * propR(pr);
  for (let j = k; j <= imin(maxSteps, k + 12); j++) {
    const nx = x0 + idiv(ux * j * STEP, DIR_SCALE);
    const ny = y0 + idiv(uy * j * STEP, DIR_SCALE);
    if (!inBounds(state.arena, nx, ny)) return null;
    if (dist2(pr.x, pr.y, nx, ny) > rr) continue;
    // The top has to BE the surface there. A floating rock hanging against a
    // hillside has ground above its top on the uphill side, and landing on
    // "the top" there put a unit 272 mm inside the hill.
    const s = surfaceAt(state, nx, ny, { ignore: self });
    if (s.support.kind !== 'prop' || s.support.id !== pr.id) continue;
    if (blockingProp(state, nx, ny, top, { ignore: self })) return null;
    if (blockingUnit(state, nx, ny, top, { ignore: isUnitBody(body) ? body.id : null })) return null;
    const c = cost + (j - k + 1) * CLIMB_COST;
    if (c * STEP > budget) return null;
    return { x: nx, y: ny, z: top, k: j, cost: c };
  }
  return null;
}

/**
 * Would a climb starting at step `k` reach level ground within the budget?
 *
 * Walks the same line the body is about to walk, step by step, until the
 * rise between steps is back under STEP_UP, adding each step's cost. Bounded
 * by the budget. Reads only; the body is untouched.
 */
function climbFits(state, body, x0, y0, ux, uy, k, feet, cost, budget, self) {
  let z = feet, c = cost;
  const maxSteps = imin(idiv(budget, STEP), MAX_STEPS);
  for (let j = k; j <= maxSteps; j++) {
    const nx = x0 + idiv(ux * j * STEP, DIR_SCALE);
    const ny = y0 + idiv(uy * j * STEP, DIR_SCALE);
    if (!inBounds(state.arena, nx, ny)) return false;
    const s = surfaceAt(state, nx, ny, { ignore: self, maxZ: z + PROP_CLIMB });
    const rise = s.z - z;
    if (rise <= STEP_UP) return true;             // levelled off: the climb has a top
    c += CLIMB_COST;
    if (c * STEP > budget) return false;
    z = s.z;
  }
  return false;
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
      // A FALL NEVER RAISES ANYTHING. Only surfaces at or below the body count.
      // Without the cap, two overlapping boulders each found the other's top
      // above itself, "fell" upward onto it, and ratcheted each other to 1.4km
      // until the pump gave up -- found by the 120-game random sweep after
      // Levitation began dropping rocks beside other rocks.
      const s = surfaceAt(state, body.x, body.y, { ignore: isUnit ? null : body.id, maxZ: before });
      if (s.z >= before) { body.z = s.z; body.support = s.support; continue; }
      body.z = s.z;
      body.support = s.support;
      const drop = before - s.z;
      landed.push({ key, drop, z: s.z });
      if (isUnit) {
        const dmg = fallDamageFor(drop);
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
