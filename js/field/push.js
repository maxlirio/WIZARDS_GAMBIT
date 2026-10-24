// Pushing things around, and the only place in the game that looks like physics.
//
// It is NOT physics, and the ceiling is deliberate: no rotation, no friction,
// props one deep, a push chain three bodies long, and travel quantised to
// 100mm. A real solver cannot be made bit-identical across JS engines without
// doing all of this in fixed point anyway, and at that point the honest version
// is a short bounded routine whose limits are written down.
//
// What it DOES model, since 2026-10-18:
//
//   FORCE, not distance. A push is an impulse `force` (1..8). A body of mass m
//   slides force x 1000 / m millimetres: a mage (mass 1) the whole way, a
//   boulder (2) half, a standing stone (4) a quarter, a wall (6) a sixth.
//
//   MOTION. What happens after the launch is `dynamics.js`: a rigid body
//   that rolls (boulders), slides (everything else), flies off edges, lands,
//   bounces off the ward and collides with whatever is in its way, sharing
//   momentum by mass and dealing damage from it. A rock that comes down on a
//   unit crumples it. This file is the rules around that: the force law,
//   toppling, the ledger, pulls that stop at your feet.
//
//   TOPPLING. A tall piece (pillar, tree) pushed hard enough falls over
//   along the push, and anything under its length is crushed.
//
// What it buys is the thing the game is actually about: the same spell
// shoves someone off a ledge on one arena and slams them into a pillar on
// another. Terrain changes outcomes, which is the whole point of leaving the
// grid behind.

import { idiv, imin, imax, isqrt, clamp, dist2, bearing, opposite, DIR64, DIR_SCALE } from './fixed.js';
import {
  STEP, FALL_SAFE, BODY_R, propSpec, heightAt, propR, propH, propMass, propOnBoard, propBurnable, propBurning,
  BURN_TURNS, FIRE_REACH, FIRE_SPREAD, inBounds,
} from './arena.js';
import { findProp, findUnit, propsOnBoard, livingUnits, blockingProp, blockingUnit, surfaceAt } from './query.js';
import { queueFall, resolveFalls, recheckSupport, isUnitBody } from './move.js';
import { throwBody, throwMany } from './dynamics.js';
import { hurt } from '../rules/combat.js';
import { fx } from '../rules/ops.js';
import { bump } from '../rules/ledger.js';

/**
 * The slide one point of force gives a body of mass 1. Was 750: pushes
 * "barely did anything" (user), and a boulder's roll was being launched at
 * its rolling friction, so it rolled exactly its sliding budget.
 */
export const FORCE_MM = 1000;
/** An impact this hard knocks a unit down: it loses its action this turn. */
export const KNOCKDOWN_DMG = 2;
/** Golem units by tier. The mage is 1. */
export const TIER_MASS = Object.freeze({ A: 3, B: 2, C: 1 });

export const bodyMass = (state, body) => {
  if (!isUnitBody(body)) return propMass(body);
  if (body.kind !== 'golem' || !body.def) return 1;
  return TIER_MASS[state.defs[body.def]?.tier] || 1;
};

/** The travel budget a force buys a mass. Mass is never below 1. */
export const travelFor = (force, mass) => idiv(force * FORCE_MM, imax(1, mass));

/**
 * Shove a body along a bearing with `force`.
 *
 * The motion itself is `dynamics.js`: a thrown rigid body that rolls, slides,
 * flies off edges, lands and hits things. This is the rules wrapper round it:
 * a tall piece pushed hard enough topples instead; the ledger is credited;
 * the nominal distance is noted beside the realised one.
 *
 *   mm        exact flat travel instead of the force (the drift harness)
 *   cap       shorten the travel (a pull stops at your feet)
 *   levitate  the body hops as it goes, clearing low obstacles
 *   lift      launched upward this much (Skyfall)
 *   air       it is already off the ground
 */
export function push(state, body, dir, force, {
  byP = null, crush = false, levitate = false, chain = null, mm = null, cap = null, lift = 0, air = false,
} = {}) {
  const log = chain || [];
  if (!body || body.dead || body.destroyed) return { mm: 0, shortfall: 0, blockedBy: null, chain: log };
  const spec = isUnitBody(body) ? null : propSpec(body.kind);
  if (spec && !spec.pushable) return { mm: 0, shortfall: 0, blockedBy: null, chain: log };
  // A tall piece pushed hard enough TOPPLES rather than slides.
  if (mm === null && spec?.tippable && force >= spec.tipForce) {
    topple(state, body, dir, { byP });
    return { mm: 0, shortfall: 0, blockedBy: null, chain: log, toppled: true };
  }
  const mass = bodyMass(state, body);
  let budget = mm !== null ? mm : travelFor(force, mass);
  if (cap !== null) budget = imin(budget, imax(0, cap));
  if (budget < STEP && lift <= 0) return { mm: 0, shortfall: 0, blockedBy: null, chain: log };

  const r = throwBody(state, body, dir, force, { byP, crush, mm, cap, lift: lift || (levitate ? 700 : 0), air: air || body.support === null });
  credit(state, body, r.mm, budget, dir, r.events, byP, log);
  return { mm: r.mm, shortfall: imax(0, budget - r.mm), blockedBy: r.blockedBy, chain: log };
}

/** What a push that moved a body writes: the chain log, the ledger, the pushResult note. */
function credit(state, body, total, budget, dir, events, byP, log) {
  if (total <= 0) return;
  log.push({ id: body.id, kind: body.body, mm: total, dir });
  if (isUnitBody(body) && byP !== null) {
    bump(state.players[byP].ledger, 'unitsPushed');
    bump(state.players[byP].ledger, 'pushMm', total);
  } else if (!isUnitBody(body) && byP !== null) {
    bump(state.players[byP].ledger, 'terrainPushMm', total);
  }
  // Units a thrown piece of terrain struck: the Spellbook's "hit a unit with
  // a thrown terrain piece".
  if (!isUnitBody(body) && byP !== null) {
    const struck = events.filter((e) => e.key === `p${body.id}` && e.kind === 'hit' && e.into[0] === 'u').length;
    if (struck) bump(state.players[byP].ledger, 'terrainImpacts', struck);
  }
  // The nominal distance beside the realised one, for selfplay's instrument.
  fx(state, 'pushResult', { id: body.id, want: budget, got: total, body: body.body });
}

/**
 * Push several bodies AT ONCE, each along its own bearing: one simulation,
 * everything launched in the same instant (dynamics.js throwMany). Each body
 * gets the same rules as `push` -- a tall piece pushed hard enough topples, a
 * fixed one stays -- and the same credit. `list` is [{ body, dir, force }].
 */
export function pushMany(state, list, { byP = null, crush = false } = {}) {
  const log = [];
  const items = [];
  for (const { body, dir, force } of list) {
    if (!body || body.dead || body.destroyed) continue;
    const spec = isUnitBody(body) ? null : propSpec(body.kind);
    if (spec && !spec.pushable) continue;
    if (spec?.tippable && force >= spec.tipForce) { topple(state, body, dir, { byP }); continue; }
    const budget = travelFor(force, bodyMass(state, body));
    if (budget < STEP) continue;
    items.push({ body, dir, travel: budget });
  }
  if (!items.length) return { chain: log, mm: [] };
  const r = throwMany(state, items, { byP, crush });
  items.forEach((it, i) => credit(state, it.body, r.mm[i], it.travel, it.dir, r.events, byP, log));
  return { chain: log, mm: r.mm };
}

/** Slammed hard enough and a unit is winded: it loses its action this turn. */
function knockdown(state, u, dmg, dir, byP = null) {
  if (!u || u.dead || dmg < KNOCKDOWN_DMG) return;
  knockDown(state, u, dir, { byP });
}

/**
 * Knock a unit flat outright: it loses its action this turn. The one funnel
 * for every knockdown -- an impact's, a topple's, a Thunderclap's -- so the
 * view hears about each and the ledger credits whoever did it.
 */
export function knockDown(state, u, dir = 0, { byP = null } = {}) {
  if (!u || u.dead) return false;
  u.acted = true;
  if (byP !== null && byP !== undefined && byP !== u.owner) bump(state.players[byP].ledger, 'knockdowns');
  fx(state, 'knockdown', { id: u.id, dir });
  return true;
}

/**
 * A tall piece falls over along `dir`. Everything under its length is hit,
 * then the piece is gone -- a felled tree or a cracked pillar is rubble.
 */
export function topple(state, prop, dir, { byP = null } = {}) {
  if (!prop || !propOnBoard(state, prop)) return false;
  const spec = propSpec(prop.kind);
  const [ux, uy] = DIR64[dir & 63];
  const L = propH(prop) + propR(prop);
  const reach = propR(prop) + BODY_R;
  const hits = [];
  for (const u of [...livingUnits(state)].sort((a, b) => a.id - b.id)) {
    // Distance from the unit to the line the trunk lands on: project onto the
    // direction, clamp to the trunk's length, compare. Integer throughout.
    const dx = u.x - prop.x, dy = u.y - prop.y;
    const t = clamp(idiv(dx * ux + dy * uy, DIR_SCALE), 0, L);
    const cx = prop.x + idiv(ux * t, DIR_SCALE), cy = prop.y + idiv(uy * t, DIR_SCALE);
    if (dist2(u.x, u.y, cx, cy) > reach * reach) continue;
    if (u.z > prop.z + propH(prop) || u.z < prop.z - 1500) continue;
    hits.push(u.id);
  }
  fx(state, 'topple', { id: prop.id, kind: prop.kind, dir, at: { x: prop.x, y: prop.y, z: prop.z }, hits });
  for (const id of hits) {
    const u = findUnit(state, id);
    hurt(state, u, spec.tipDmg, { cause: 'topple', byP });
    knockdown(state, u, spec.tipDmg, dir, byP);
  }
  shatterProp(state, prop, { byP, cause: 'topple' });
  return true;
}

/** Units standing on this prop right now. Ascending by id. */
export const ridersOf = (state, prop) =>
  state.field.units
    .filter((u) => !u.dead && u.support?.kind === 'prop' && u.support.id === prop.id)
    .sort((a, b) => a.id - b.id);

/** Push a body directly away from a point. The commonest printed phrasing. */
export const pushAwayFrom = (state, body, fromX, fromY, force, opts = {}) =>
  push(state, body, bearing(fromX, fromY, body.x, body.y), force, opts);

/**
 * Pull a body toward a point -- "to you", on a handful of blue and red faces.
 * It comes to REST beside the point: travel is capped at the gap between the
 * two bodies, so a rock pulled to your mage lands at its feet and does not
 * slam into it and shove it away (user: "Meteor Call pushed instead of
 * pulled" -- the pull was right, the arrival was the shove).
 */
export const pullToward = (state, body, toX, toY, force, opts = {}) => {
  const r = isUnitBody(body) ? BODY_R : propR(body);
  const gap = isqrt(dist2(body.x, body.y, toX, toY)) - r - BODY_R - 50;
  return push(state, body, bearing(body.x, body.y, toX, toY), force, { cap: gap, ...opts });
};

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
      if (u.z > pr.z + propH(pr) || u.z < pr.z - 1500) continue;
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
