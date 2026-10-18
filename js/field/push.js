// Pushing things around, and the only place in the game that looks like physics.
//
// It is NOT physics, and the ceiling is deliberate: no rotation, no momentum,
// no friction, props one deep, a push chain three bodies long, and travel
// quantised to 100mm. A real solver cannot be made bit-identical across JS
// engines without doing all of this in fixed point anyway, and at that point
// the honest version is a short bounded routine whose limits are written down.
//
// What it does buy is the thing the game is actually about: a printed "push 4
// squares" becomes four metres of travel resolved against real ground, so the
// same spell shoves someone off a ledge on one arena and slams them into a
// pillar on another. Terrain changes outcomes, which is the whole point of
// leaving the grid behind.

import { idiv, imin, imax, isqrt, dist2, bearing, opposite, DIR64 } from './fixed.js';
import { STEP, FALL_SAFE, propSpec } from './arena.js';
import { findProp, findUnit, propsOnBoard } from './query.js';
import { walk, queueFall, resolveFalls, recheckSupport, isUnitBody, CLIMB_RATE } from './move.js';
import { hurt } from '../rules/combat.js';
import { fx } from '../rules/ops.js';
import { bump } from '../rules/ledger.js';

/** How many bodies a single push may set in motion. */
export const PUSH_DEPTH = 3;
/** Millimetres of blocked travel per point of [Crush] damage. */
export const CRUSH_MM = 500;

/**
 * Shove a body along a bearing.
 *
 * `climb: false` throughout, and that is a rule rather than a simplification:
 * being shoved does not make you scramble up a wall, it slams you into it. The
 * travel you did not get is the `shortfall`, and [Crush] is the keyword that
 * turns it into damage -- which is why the shortfall is returned rather than
 * discarded.
 */
export function push(state, body, dir, mmDist, {
  depth = 0, byP = null, crush = false, chain = null,
} = {}) {
  const log = chain || [];
  if (!body || body.dead || mmDist < STEP) return { mm: 0, shortfall: mmDist, blockedBy: null, chain: log };

  const riders = isUnitBody(body) ? [] : ridersOf(state, body);
  const x0 = body.x, y0 = body.y;
  let remaining = mmDist, total = 0, blockedBy = null;

  // Bounded by PUSH_DEPTH + 1 segments: each segment either moves the body or
  // clears exactly one obstacle out of the way, and clearing is what costs a
  // segment. No `while`, so there is no arrangement of bodies that hangs here.
  for (let seg = 0; seg <= PUSH_DEPTH && remaining >= STEP; seg++) {
    const r = walk(state, body, dir, remaining, { allowFall: true, climb: false });
    total += r.mm;
    remaining = r.shortfall;
    blockedBy = r.blockedBy;
    if (!r.blockedBy || remaining < STEP) break;
    if (depth >= PUSH_DEPTH) break;

    let next = null;
    if (r.blockedBy.kind === 'unit') next = findUnit(state, r.blockedBy.id);
    else if (r.blockedBy.kind === 'prop') {
      const pr = findProp(state, r.blockedBy.id);
      if (pr && propSpec(pr.kind).pushable) next = pr;
    }
    if (!next) break;

    const sub = push(state, next, dir, remaining, { depth: depth + 1, byP, crush, chain: log });
    // If the body in front could not be budged, the whole column is jammed.
    // Trying again would re-walk into the same obstacle for the rest of the
    // segment budget and return the same answer.
    if (sub.mm < STEP) break;
  }

  if (total > 0) {
    log.push({ id: body.id, kind: body.body, mm: total, dir });
    // Anything that was riding this prop has lost its footing. That is the
    // dramatic case the whole module exists for -- shoving the rock out from
    // under someone -- and it is also why a prop's riders are collected BEFORE
    // it moves, since afterwards nothing is standing on it any more.
    for (const u of riders) queueFall(state, u);
    if (isUnitBody(body)) {
      if (byP !== null) { bump(state.players[byP].ledger, 'unitsPushed'); bump(state.players[byP].ledger, 'pushMm', total); }
    }
    fx(state, 'push', { id: body.id, body: body.body, mm: total, dir, from: { x: x0, y: y0 } });
    // The nominal distance beside the realised one, recorded only for the body
    // the card actually named. A printed "push 3m" becomes 3m of travel against
    // real terrain, so the two differ -- and the gap is the price of leaving the
    // grid, which is a number worth being able to read rather than assume.
    if (depth === 0) fx(state, 'pushResult', { id: body.id, want: mmDist, got: total, body: body.body });
  }

  if (crush && remaining >= CRUSH_MM && isUnitBody(body)) {
    // [Crush]: the travel the wall ate becomes damage. A push that goes
    // nowhere because the target was already against a pillar is the single
    // nastiest line this keyword enables, and it is intentional.
    hurt(state, body, idiv(remaining, CRUSH_MM), { cause: 'crush', byP });
  }

  if (depth === 0) {
    recheckSupport(state);
    const landed = resolveFalls(state, hurt);
    for (const l of landed) {
      if (l.drop > FALL_SAFE && byP !== null) bump(state.players[byP].ledger, 'fallsCaused');
    }
    if (landed.length) fx(state, 'falls', { landed });
  }
  return { mm: total, shortfall: remaining, blockedBy, chain: log };
}

/** Units standing on this prop right now. Ascending by id. */
export const ridersOf = (state, prop) =>
  state.field.units
    .filter((u) => !u.dead && u.support?.kind === 'prop' && u.support.id === prop.id)
    .sort((a, b) => a.id - b.id);

/** Push a body directly away from a point. The commonest printed phrasing. */
export const pushAwayFrom = (state, body, fromX, fromY, mmDist, opts = {}) =>
  push(state, body, bearing(fromX, fromY, body.x, body.y), mmDist, opts);

/** Pull a body toward a point. Printed on a handful of blue faces. */
export const pullToward = (state, body, toX, toY, mmDist, opts = {}) =>
  push(state, body, bearing(body.x, body.y, toX, toY), mmDist, opts);

/**
 * Lift a prop into the air and let it hang there. Printed Levitation's partner:
 * the push-them-out-from-under game needs a way to make a floater in the first
 * place.
 */
export function levitate(state, prop, mmUp) {
  const riders = ridersOf(state, prop);
  prop.z += mmUp;
  prop.levitated = true;
  for (const u of riders) { u.z += mmUp; }
  fx(state, 'levitate', { id: prop.id, mm: mmUp });
  recheckSupport(state);
  resolveFalls(state, hurt);
}

/** Take a terrain piece off the battlefield until the end of a turn. */
export function removeTerrain(state, prop, untilTurn) {
  prop.removedUntil = untilTurn;
  bump(state.players[state.active].ledger, 'terrainRemoved');
  fx(state, 'terrainRemoved', { id: prop.id, until: untilTurn });
  recheckSupport(state);
  resolveFalls(state, hurt);
}
