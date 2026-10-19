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
//   slides force x 750 / m millimetres: a mage (mass 1) the whole way, a
//   boulder (2) half, a standing stone (4) a quarter, a wall (6) a sixth.
//
//   IMPACTS. When the slide is stopped early, what is left of it is energy:
//   mass x remaining travel. That energy becomes damage to BOTH the moving
//   body and whatever stopped it -- heavier things hit harder, and things hit
//   harder the earlier they are stopped (that is "faster"). The collision is
//   INELASTIC: the moving body stops where it hit, and whatever it struck is
//   knocked on with HALF the leftover travel -- enough for a thrown mage to
//   knock a golem into a pillar, not enough for a Newton's cradle (user: "no
//   friction... looks really messy").
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
import { walk, queueFall, resolveFalls, recheckSupport, isUnitBody, CLIMB_RATE } from './move.js';
import { hurt } from '../rules/combat.js';
import { fx } from '../rules/ops.js';
import { bump } from '../rules/ledger.js';

/** How many bodies a single push may set in motion. */
export const PUSH_DEPTH = 3;
/** The slide one point of force gives a body of mass 1. */
export const FORCE_MM = 750;
/** Mass x remaining travel (mm) per point of impact damage. */
export const IMPACT_K = 1500;
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
/** A 0..100 launch speed for the view: force over mass. */
const speedOf = (force, mass) => clamp(idiv(force * 25, imax(1, mass)), 5, 100);

/**
 * Shove a body along a bearing with `force`.
 *
 * `mm` overrides the force (the harness measures drift with an exact distance,
 * and a struck body is shoved on with whatever momentum is LEFT rather than a
 * fresh force). `climb: false` throughout, and that is a rule rather than a
 * simplification: being shoved does not make you scramble up a wall, it slams
 * you into it -- unless the push carries [Levitate].
 */
export function push(state, body, dir, force, {
  depth = 0, byP = null, crush = false, levitate = false, chain = null, mm = null, speed = null, settle = true, cap = null,
} = {}) {
  const log = chain || [];
  if (!body || body.dead) return { mm: 0, shortfall: 0, blockedBy: null, chain: log };
  // Whatever stands on a prop rides with it, and weighs on it: a rock with a
  // golem on top is a heavier thing to shove. Collected BEFORE the move,
  // since the move is what changes who is standing where.
  const riders = isUnitBody(body) ? [] : ridersOf(state, body);
  const mass = bodyMass(state, body) + riders.reduce((m, u) => m + bodyMass(state, u), 0);
  const spec = isUnitBody(body) ? null : propSpec(body.kind);
  // A tall piece pushed hard enough TOPPLES rather than slides.
  if (depth === 0 && mm === null && spec?.tippable && force >= spec.tipForce) {
    topple(state, body, dir, { byP });
    return { mm: 0, shortfall: 0, blockedBy: null, chain: log, toppled: true };
  }
  // `cap` shortens the force's travel without replacing it: a pull "to you"
  // stops at your feet instead of bowling you over.
  const budget = mm !== null ? mm : cap !== null ? imin(travelFor(force, mass), imax(0, cap)) : travelFor(force, mass);
  const v = speed !== null ? speed : speedOf(force, mass);
  if (budget < STEP) return { mm: 0, shortfall: 0, blockedBy: null, chain: log };

  const x0 = body.x, y0 = body.y, z0 = body.z;
  let remaining = budget, total = 0, blockedBy = null;

  // ONE slide, and the body stops where it is stopped. It used to follow
  // whatever it had knocked loose, segment after segment, and a line of
  // bodies clacked along like a Newton's cradle; now the impact is where the
  // mover ends and only the struck thing moves on (nested through `impact`,
  // bounded by PUSH_DEPTH).
  {
    const r = walk(state, body, dir, remaining, { allowFall: true, climb: levitate, riders: riders.map((u) => u.id) });
    total += r.mm;
    remaining = r.shortfall;
    blockedBy = r.blockedBy;
    // THE IMPACT. What is left of the slide is energy, and energy hurts.
    if (r.blockedBy && remaining >= STEP) impact(state, body, mass, remaining, r.blockedBy, dir, v, { byP, crush, depth, chain: log });
  }

  if (total > 0) {
    log.push({ id: body.id, kind: body.body, mm: total, dir });
    // THE RIDERS COME ALONG. A unit standing on a shoved rock moves with the
    // rock (user: "it should move with it if the thing on the bottom moves"),
    // keeping its place on top. Only if its new spot is off the board or
    // already taken -- it would be scraped off against a wall or another
    // body -- does it lose its footing and fall where it was.
    const dx = body.x - x0, dy = body.y - y0;
    for (const u of riders) {
      const nx = u.x + dx, ny = u.y + dy;
      // The rider's new spot must still have THIS prop's top as its footing:
      // a rider near the rock's edge can end up over a cliff top higher than
      // the rock (it would be standing inside the ground), or over nothing.
      const s = inBounds(state.arena, nx, ny) ? surfaceAt(state, nx, ny) : null;
      const onIt = s && s.support.kind === 'prop' && s.support.id === body.id;
      const clear = onIt
        && !blockingProp(state, nx, ny, s.z, { ignore: body.id })
        && !blockingUnit(state, nx, ny, s.z, { ignore: u.id, ignoreIds: riders.map((q) => q.id) });
      if (!clear) { queueFall(state, u); fx(state, 'scraped', { id: u.id, off: body.id }); continue; }
      const from = { x: u.x, y: u.y, z: u.z };
      u.x = nx; u.y = ny; u.z = s.z; u.support = s.support;
      fx(state, 'carry', { id: u.id, on: body.id, mm: total, dir, from, to: { x: u.x, y: u.y, z: u.z }, speed: v });
    }
    if (isUnitBody(body) && byP !== null) {
      bump(state.players[byP].ledger, 'unitsPushed');
      bump(state.players[byP].ledger, 'pushMm', total);
    } else if (!isUnitBody(body) && byP !== null) {
      // Terrain you shoved, by distance: the Spellbook's "shove terrain 12m".
      bump(state.players[byP].ledger, 'terrainPushMm', total);
    }
    fx(state, 'push', {
      id: body.id, body: body.body, mm: total, dir, from: { x: x0, y: y0 },
      to: { x: body.x, y: body.y, z: body.z }, force: force || 0, speed: v,
    });
    // The nominal distance beside the realised one, recorded only for the body
    // the card actually named. A printed force becomes a slide against real
    // terrain, and selfplay.js reports how much of it is realised.
    if (depth === 0) fx(state, 'pushResult', { id: body.id, want: budget, got: total, body: body.body });
  }

  // `settle: false` leaves the falls QUEUED for the caller to resolve: a
  // Skyfall throws a unit through the air and wants to credit its landing.
  if (depth === 0 && settle) {
    recheckSupport(state);
    const landed = resolveFalls(state, hurt);
    for (const l of landed) {
      if (l.drop > FALL_SAFE && byP !== null) bump(state.players[byP].ledger, 'fallsCaused');
    }
    if (landed.length) fx(state, 'falls', { landed });
  }
  return { mm: total, shortfall: remaining, blockedBy, chain: log };
}

/**
 * A moving body has been stopped with `remaining` travel still in it.
 *
 * Energy = mass x remaining. Both bodies take `energy / IMPACT_K` damage
 * ([Crush] doubles it); a wall, a cliff or the edge of the ward hurts only the
 * body that hit it. Whatever was struck is then knocked on with HALF the
 * leftover travel (scaled by its mass), if it is something that can move at
 * all -- a tall piece that takes enough energy topples instead.
 */
function impact(state, body, mass, remaining, blockedBy, dir, v, { byP, crush, depth, chain }) {
  const energy = mass * remaining;
  let dmg = idiv(energy, IMPACT_K);
  if (crush) dmg *= 2;
  let other = null;
  if (blockedBy.kind === 'unit') other = findUnit(state, blockedBy.id);
  else if (blockedBy.kind === 'prop' && blockedBy.id) other = findProp(state, blockedBy.id);
  fx(state, 'impact', {
    id: body.id, body: body.body, into: { kind: blockedBy.kind, id: blockedBy.id ?? null },
    dmg, at: { x: body.x, y: body.y, z: body.z }, dir, speed: v,
  });
  // A thrown rock that lands on somebody: the Spellbook's "hit a unit with a
  // thrown terrain piece", counted before the damage so a kill still counts.
  if (!isUnitBody(body) && other && isUnitBody(other) && byP !== null && byP !== undefined) {
    bump(state.players[byP].ledger, 'terrainImpacts');
  }
  if (dmg > 0) {
    if (isUnitBody(body)) { hurt(state, body, dmg, { cause: 'impact', byP }); knockdown(state, body, dmg, dir, byP); }
    else smashProp(state, body, dmg, { byP, cause: 'impact' });
    if (other) {
      if (isUnitBody(other)) { hurt(state, other, dmg, { cause: 'impact', byP }); knockdown(state, other, dmg, dir, byP); }
      else smashProp(state, other, dmg, { byP, cause: 'impact' });
    }
  }
  if (!other || depth >= PUSH_DEPTH) return { moved: false };
  if (isUnitBody(other) ? other.dead : (other.destroyed || !propSpec(other.kind).pushable)) return { moved: false };
  const ospec = isUnitBody(other) ? null : propSpec(other.kind);
  if (ospec?.tippable && energy >= ospec.tipEnergy) { topple(state, other, dir, { byP }); return { moved: true }; }
  const om = bodyMass(state, other);
  const sub = push(state, other, dir, 0, { depth: depth + 1, byP, crush, chain, mm: idiv(energy, om * 2), speed: v });
  return { moved: sub.mm >= STEP };
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
