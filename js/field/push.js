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
import {
  STEP, FALL_SAFE, propSpec, heightAt, propR, propMass, propOnBoard, propBurnable, propBurning,
  BURN_TURNS, FIRE_REACH, FIRE_SPREAD,
} from './arena.js';
import { findProp, findUnit, propsOnBoard, livingUnits } from './query.js';
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
  // MASS. Everything can be pushed, but not everything flies: a push of N
  // metres moves a piece of mass m by 2N/(m+1) -- a crystal shard (mass 1)
  // the whole way, a boulder two thirds, a standing stone two fifths, a wall a
  // seventh. Units have no mass term; a shoved body is the thing the push is
  // for. Applied once at the top, so the shortfall [Crush] converts into
  // damage is measured against what the push could really have done.
  const nominal = mmDist;
  if (!isUnitBody(body)) mmDist = idiv(mmDist * 2, propMass(body) + 1);
  if (mmDist < STEP) return { mm: 0, shortfall: 0, blockedBy: null, chain: log };

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
    if (depth === 0) fx(state, 'pushResult', { id: body.id, want: nominal, got: total, body: body.body });
  }

  if (crush && remaining >= CRUSH_MM) {
    // [Crush]: the travel the wall ate becomes damage. A push that goes
    // nowhere because the target was already against a pillar is the single
    // nastiest line this keyword enables, and it is intentional.
    const dmg = idiv(remaining, CRUSH_MM);
    if (isUnitBody(body)) hurt(state, body, dmg, { cause: 'crush', byP });
    else smashProp(state, body, dmg, { byP, cause: 'crush' });
    // And the wall takes it too. The thing that stopped the push is hit as
    // hard as the thing that was pushed into it -- a crystal shard somebody
    // is slammed against shatters.
    if (blockedBy?.kind === 'prop') {
      const wall = findProp(state, blockedBy.id);
      if (wall) smashProp(state, wall, dmg, { byP, cause: 'crush' });
    }
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
/**
 * Nothing is lifted higher than this above the ground beneath it. Lifts STACK
 * -- Sky Anchor and Levitation can raise the same rock turn after turn -- and
 * without a ceiling a unit riding one was carried 12m into the air across a
 * long random-deck game. Six metres is already a lethal fall.
 */
export const LIFT_CEILING = 6000;

export function levitate(state, prop, mmUp) {
  const riders = ridersOf(state, prop);
  const floor = heightAt(state.arena, prop.x, prop.y);
  mmUp = Math.max(0, Math.min(mmUp, floor + LIFT_CEILING - prop.z));
  if (mmUp === 0) { fx(state, 'levitate', { id: prop.id, mm: 0 }); return; }
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

/* ------------------------------------------------------------ breaking */

/**
 * Take hit points off a terrain piece. At zero it SHATTERS: gone for good,
 * and whatever stood on it falls. The one way a piece is destroyed, so the
 * ledger and the view hear about every case.
 */
export function smashProp(state, prop, amount, { byP = null, cause = 'spell' } = {}) {
  if (!prop || amount <= 0 || !propOnBoard(state, prop)) return 0;
  const dealt = imin(prop.hp, amount);
  prop.hp -= dealt;
  fx(state, 'propHit', { id: prop.id, amount: dealt, cause, hp: prop.hp });
  if (prop.hp <= 0) shatterProp(state, prop, { byP, cause });
  return dealt;
}

export function shatterProp(state, prop, { byP = null, cause = 'spell' } = {}) {
  if (prop.destroyed) return false;
  const riders = ridersOf(state, prop);
  prop.destroyed = true;
  prop.hp = 0;
  prop.burning = null;
  if (byP !== null && byP !== undefined) bump(state.players[byP].ledger, 'propsBroken');
  fx(state, 'shatter', { id: prop.id, kind: prop.kind, cause, at: { x: prop.x, y: prop.y, z: prop.z } });
  for (const u of riders) queueFall(state, u);
  recheckSupport(state);
  resolveFalls(state, hurt);
  return true;
}

/* ------------------------------------------------------------ fire */

/**
 * Set a piece alight. Only wood burns; everything else shrugs it off.
 *
 * `burning` holds the LAST turn number the fire still bites on, so the fire
 * ends by comparison rather than by a cleanup pass -- the same reason a
 * rotation prohibition is stored as a turn number. Lit during turn T, it bites
 * at the start of T+1 and again at T+2, and after that second bite it is ash.
 */
export function ignite(state, prop, { byP = null } = {}) {
  if (!prop || !propBurnable(prop) || !propOnBoard(state, prop)) return false;
  if (propBurning(state, prop)) return false;
  prop.burning = state.turn + BURN_TURNS;
  prop.litBy = byP;
  if (byP !== null && byP !== undefined) bump(state.players[byP].ledger, 'firesLit');
  fx(state, 'ignite', { id: prop.id, by: byP, at: { x: prop.x, y: prop.y, z: prop.z } });
  return true;
}

/**
 * The start-of-turn fire pass. Every burning piece, in id order: it hurts
 * every unit standing within FIRE_REACH of its edge (both sides -- fire is
 * nobody's friend), it spreads to any wood within FIRE_SPREAD, and if its
 * time is up it burns away to nothing.
 *
 * Spread is to pieces found BEFORE this pass began, so one pass cannot run a
 * fire across the whole grove in a single turn: a tree lit now bites and
 * spreads next turn. Bounded by construction -- the list is fixed up front.
 */
export function tickFire(state) {
  const burning = [...state.field.props]
    .filter((pr) => propBurning(state, pr))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (!burning.length) return;
  const lit = [];   // [piece, credited player], fixed before anything is lit
  for (const pr of burning) {
    const reach = propR(pr) + FIRE_REACH;
    for (const u of [...livingUnits(state)].sort((a, b) => a.id - b.id)) {
      if (dist2(u.x, u.y, pr.x, pr.y) > reach * reach) continue;
      if (u.z > pr.z + propSpec(pr.kind).h || u.z < pr.z - 1500) continue;
      hurt(state, u, 1, { cause: 'fire', byP: pr.litBy });
    }
    for (const o of [...state.field.props].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (o === pr || !propBurnable(o) || !propOnBoard(state, o) || propBurning(state, o)) continue;
      const gap = propR(pr) + propR(o) + FIRE_SPREAD;
      if (dist2(o.x, o.y, pr.x, pr.y) <= gap * gap) lit.push([o, pr.litBy]);
    }
  }
  for (const [o, by] of lit) ignite(state, o, { byP: by });
  for (const pr of burning) {
    if (pr.burning <= state.turn) {
      fx(state, 'burntOut', { id: pr.id, kind: pr.kind, at: { x: pr.x, y: pr.y, z: pr.z } });
      shatterProp(state, pr, { byP: pr.litBy, cause: 'fire' });
    }
  }
}
