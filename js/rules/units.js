// The Unit Phase: what a mage and a golem unit may do, and what summoning costs.
//
//   mage       -- move, strike an adjacent enemy, or summon a golem unit
//                 adjacent to itself
//   golem unit -- move, or strike an adjacent enemy
//
// Each friendly unit acts ONCE. Summoning spends the mage's whole action, so a
// summoning mage neither moves nor strikes that turn -- it is one of the three
// options, not a free extra.
//
// Damage and death live in combat.js. This file only decides and moves.

import { ask } from './driver.js';
import { fx, defOf, locate, extract, makeCard } from './ops.js';
import { bump } from './ledger.js';
import { emit } from './triggers.js';
import { hurt, kill, checkGolemAttrition, golemRoom } from './combat.js';
import { applyFor, fireFor } from './keywords.js';
import { unitMove, shieldOn, bonusMageLife } from './derive.js';
import { TIER_CAP, SLOTS } from './golems.js';
import { idiv, dist3, bearing, imin, imax, isqrt, DIR64, DIR_SCALE } from '../field/fixed.js';
import { STEP } from '../field/arena.js';
import {
  livingUnits, unitsOf, enemiesOf, findUnit, mageOf, unitKeywords,
  strikeTargets, surfaceAt, onHighGround,
} from '../field/query.js';
import { walk, placeBody, resolveFalls, recheckSupport } from '../field/move.js';
import { moveDirs, summonPoints, trialWalk, dirLabel } from '../field/candidates.js';

/** The mage's statline. One place, so a balance pass is one edit. */
export const MAGE = Object.freeze({ hp: 5, move: 3000, atk: 2, reach: 900 });

/**
 * A mage's life is 5 plus whatever ACTIVE passives add (derive.js mageLife).
 *
 * Settled at rest by the pump rather than computed on read, because hit points
 * are spent: when the bonus arrives the mage gains that much life, and when it
 * leaves it loses that much -- but never below 1. Taking the last of a mage's
 * life is a kill and a kill is worth 2 VP to somebody; turning a card away is
 * not something that should be able to award it.
 */
export function settleMageLife(state) {
  for (const u of state.field.units) {
    if (u.kind !== 'mage' || u.dead) continue;
    const want = MAGE.hp + bonusMageLife(state, u.owner);
    if (u.maxHp === want) continue;
    const delta = want - u.maxHp;
    u.maxHp = want;
    u.hp = imax(1, imin(want, u.hp + delta));
    fx(state, 'mageLife', { id: u.id, p: u.owner, maxHp: want, delta });
  }
}

export function makeMage(state, p) {
  const s = state.arena.spawns[p];
  const u = {
    body: 'unit', id: ++state.field.nextUnitId, owner: p, kind: 'mage',
    def: null, golemUid: null,
    hp: MAGE.hp, maxHp: MAGE.hp, move: MAGE.move, atk: MAGE.atk, reach: MAGE.reach,
    x: s.x, y: s.y, z: 0, support: { kind: 'ground' },
    acted: false, dead: false, poison: 0, keywords: [],
  };
  placeBody(state, u, s.x, s.y);
  state.field.units.push(u);
  return u;
}

/**
 * Bring a dead mage back at its owner's own starting circle, at full hit points.
 *
 * Keywords are CLEARED. A mage that came back still carrying the [Poison] and
 * the copied [Stun] it died with would make dying a way to launder a bad board
 * state, and it is already a 2 VP gift to the opponent.
 */
export function respawnMage(state, p) {
  const pl = state.players[p];
  const old = mageOf(state, p);
  const s = state.arena.spawns[p];
  if (old) {
    old.dead = false;
    old.hp = old.maxHp;
    old.poison = 0;
    old.burn = 0;
    old.burnBy = null;
    old.keywords = [];
    old.acted = false;
    old.heldUntil = null;
    placeBody(state, old, s.x, s.y);
  } else {
    makeMage(state, p);
  }
  pl.mage.respawnOnTurn = null;
  fx(state, 'respawn', { p });
}

/* ------------------------------------------------------------ summoning */

export function canSummon(state, p) {
  const m = mageOf(state, p);
  if (!m || m.dead || m.acted) return [];
  return state.players[p].golems
    .filter((g) => g && golemRoom(state, g) > 0)
    .map((g) => g.uid).sort((a, b) => a - b);
}

export function summon(state, p, golemUid, point) {
  const pl = state.players[p];
  const g = pl.golems.find((x) => x && x.uid === golemUid);
  if (!g) return null;
  const def = defOf(state, g);
  if (golemRoom(state, g) <= 0) return null;

  const u = {
    body: 'unit', id: ++state.field.nextUnitId, owner: p, kind: 'golem',
    def: g.def, golemUid: g.uid,
    hp: def.unit.hp, maxHp: def.unit.hp, move: def.unit.move,
    atk: def.unit.atk, reach: def.unit.reach,
    x: point.x, y: point.y, z: 0, support: { kind: 'ground' },
    acted: true, dead: false, poison: 0, keywords: [],
  };
  placeBody(state, u, point.x, point.y);
  state.field.units.push(u);
  g.units.push(u.id);
  // The flag the attrition rule turns on. Once a card has put a body on the
  // battlefield it is committed: when its last unit dies, the card dies with it.
  g.everDeployed = true;
  bump(pl.ledger, 'summons');
  fx(state, 'summon', { p, uid: g.uid, id: u.id, at: point });
  emit(state, 'afterSummon', { p, uid: g.uid, id: u.id });
  return u;
}

/* ------------------------------------------------------------ attacking */

export function strike(state, attacker, target) {
  if (!attacker || !target || attacker.dead || target.dead) return 0;
  const kws = unitKeywords(state, attacker);
  const d = applyFor(kws, 'damage', { amount: attacker.atk });
  // The high ground is worth something concrete rather than flavour: a metre of
  // elevation is a point of damage, which is why `highGround` is a gate worth
  // gating a gold face on.
  const edge = attacker.z - target.z >= 750 ? 1 : 0;
  bump(state.players[attacker.owner].ledger, 'attacks');
  const dealt = hurt(state, target, d.amount + edge, { cause: 'strike', byP: attacker.owner });
  if (dealt > 0) fireFor(kws, 'hit', { state, p: attacker.owner, draw: () => {}, blast: () => 0 }, { target });
  fx(state, 'strike', { from: attacker.id, to: target.id, amount: dealt, edge });
  return dealt;
}

/* ------------------------------------------------------------ the actions */

/**
 * Everything one unit may legally do right now, as plain serialisable actions.
 *
 * `pass` is always offered. A unit wedged against a pillar with no enemy in
 * reach has to have SOMETHING to choose, or the phase cannot advance -- and the
 * alternative, auto-passing it, hides the stuck unit from the player.
 */
export function unitActions(state, unit) {
  if (unit.dead || unit.acted) return [];
  const out = [];
  // Movement goes ANYWHERE inside the unit's move circle (see canMoveTo). This
  // list is a sample of that circle -- the furthest reach in each direction --
  // which is what the AI searches and the terminal offers.
  const mm = moveBudget(state, unit);
  for (const d of moveDirs(state, { ...unit, move: mm })) {
    const [ux, uy] = DIR64[d.dir];
    out.push({
      type: 'unit', id: unit.id, act: 'move', label: d.label, mm: d.mm,
      x: unit.x + idiv(ux * d.mm, DIR_SCALE), y: unit.y + idiv(uy * d.mm, DIR_SCALE),
    });
  }
  for (const t of strikeTargets(state, unit)) {
    out.push({ type: 'unit', id: unit.id, act: 'strike', target: t.id });
  }
  if (unit.kind === 'mage') {
    for (const uid of canSummon(state, unit.owner)) {
      if (summonPoints(state, unit).length) out.push({ type: 'unit', id: unit.id, act: 'summon', golem: uid });
    }
  }
  out.push({ type: 'unit', id: unit.id, act: 'pass' });
  return out;
}

/** How far this unit may move this turn, with passives and keywords applied. */
export const moveBudget = (state, u) =>
  applyFor(unitKeywords(state, u), 'unitMove', { mm: unitMove(state, u) }).mm;

/**
 * May this unit be told to walk to (x, y)? Anywhere inside its move circle
 * that is at least one step away. Where it actually ENDS is decided by the walk
 * -- a wall, a cliff or another body can stop it short -- and that is the
 * engine's answer, not the player's.
 */
export function canMoveTo(state, u, x, y) {
  if (!u || u.dead || u.acted) return false;
  const dx = x - u.x, dy = y - u.y;
  const d2 = dx * dx + dy * dy;
  // A few millimetres of slack: a point sampled at full reach along a table
  // direction floors to just outside the circle on the diagonals. The walk is
  // capped at the budget regardless, so the slack moves nobody further.
  const r = moveBudget(state, u) + 25;
  if (d2 < STEP * STEP || d2 > r * r) return false;
  // Inside the circle is not enough: the walk has to GET there. A boulder, a
  // cliff or another unit in the way stops the walk short, and a spot you
  // cannot reach is not offered (user: "it says you can move somewhere but
  // doesn't let you move there"). Judged by the same walk the move makes.
  const { dist, dir, vec } = headingTo(u, x, y);
  const reach = trialWalk(state, u, dir, moveBudget(state, u), { vec, stopAfter: dist });
  return reach.mm + STEP > dist;
}

/**
 * The heading a walk to a point takes. A point that lies ON one of the 64
 * table rays -- which is what every sampled move is -- walks that ray's exact
 * vector; a vector re-derived from the point's offset is a millimetre off and
 * can brush a shard the sampled walk slipped past, so the engine's own
 * samples were being refused as illegal. Any other point walks straight at it.
 */
export function headingTo(u, x, y) {
  const dx = x - u.x, dy = y - u.y;
  const dist = isqrt(dx * dx + dy * dy);
  const dir = bearing(u.x, u.y, x, y);
  const [ux, uy] = DIR64[dir];
  // Within 2 mm of the ray counts: a sample at 1299 mm reads back as 1298
  // through the integer square root, and the rounding must not matter.
  const ex = idiv(ux * dist, DIR_SCALE) - dx, ey = idiv(uy * dist, DIR_SCALE) - dy;
  const onRay = ex >= -2 && ex <= 2 && ey >= -2 && ey <= 2;
  const vec = onRay || dist === 0 ? [ux, uy] : [idiv(dx * DIR_SCALE, dist), idiv(dy * DIR_SCALE, dist)];
  return { dist, dir, vec };
}

/**
 * The move circle's TRUE outline: how far this unit's walk really gets along
 * each of 128 headings (the 64 table directions and their midpoints). The HUD
 * draws this shape instead of a plain disc, so what is lit is exactly what a
 * click can do. Midpoint headings are a hair short of unit length (0.1%),
 * which the 100mm step swallows.
 */
export function moveReach(state, unit) {
  const mm = moveBudget(state, unit);
  const out = [];
  if (!mm || unit.dead || unit.acted) return out;
  for (let i = 0; i < 64; i++) {
    const [ax, ay] = DIR64[i], [bx, by] = DIR64[(i + 1) & 63];
    for (const vec of [[ax, ay], [idiv(ax + bx, 2), idiv(ay + by, 2)]]) {
      const r = trialWalk(state, unit, i, mm, { vec });
      out.push({ x: r.x, y: r.y, z: r.z, mm: r.mm });
    }
  }
  return out;
}

/** Perform one unit action. A generator: summoning asks where. */
export function* doUnitAction(state, action) {
  const u = findUnit(state, action.id);
  if (!u || u.dead || u.acted) return false;

  if (action.act === 'pass') { u.acted = true; return true; }

  if (action.act === 'move') {
    const { dist, dir, vec } = headingTo(u, action.x, action.y);
    if (dist < STEP) { u.acted = true; return false; }
    const r = walk(state, u, dir, moveBudget(state, u), { allowFall: false, climb: true, vec, stopAfter: dist });
    bump(state.players[u.owner].ledger, 'moves');
    u.acted = true;
    recheckSupport(state);
    resolveFalls(state, hurt);
    fx(state, 'move', { id: u.id, mm: r.mm, to: { x: u.x, y: u.y, z: u.z } });
    emit(state, 'afterMove', { id: u.id, p: u.owner, mm: r.mm });
    return true;
  }

  if (action.act === 'strike') {
    const t = findUnit(state, action.target);
    u.acted = true;
    if (!t) return false;
    strike(state, u, t);
    return true;
  }

  if (action.act === 'summon') {
    const pts = summonPoints(state, u);
    if (!pts.length) { u.acted = true; return false; }
    const i = pts.length === 1 ? 0 : yield ask.pick(
      pts.map((_, k) => k),
      { prompt: 'Summon where?', labels: pts.map((pt) => `${dirLabel(pt.dir)} (${pt.x},${pt.y})`), show: pts.map(({ x, y, z }) => ({ x, y, z })) },
    );
    u.acted = true;
    summon(state, u.owner, action.golem, pts[i ?? 0]);
    return true;
  }
  return false;
}

/* ------------------------------------------------------------ turn edges */

/** Units that still owe an action this turn, ascending by id. */
export const pendingUnits = (state, p) =>
  unitsOf(state, p).filter((u) => !u.acted).sort((a, b) => a.id - b.id);

export function startUnitTurn(state, p) {
  for (const u of livingUnits(state)) {
    if (u.owner !== p) continue;
    // A SNARED unit (printed Snare: "it loses its next action") sits this
    // turn out. `heldUntil` is the turn number it applies to and expires by
    // comparison, exactly like a rotation prohibition -- no cleanup pass.
    u.acted = u.heldUntil !== null && u.heldUntil !== undefined && u.heldUntil >= state.turn;
  }
}

/** Take a unit's NEXT action: it may not act on its owner's coming turn. */
export function holdUnit(state, u) {
  if (!u || u.dead) return false;
  // The owner's next turn is one turn away if they are not active now, two
  // if they are (their own units cannot be snared on their own turn, but the
  // arithmetic is kept honest regardless).
  u.heldUntil = state.turn + (state.active === u.owner ? 2 : 1);
  fx(state, 'held', { id: u.id, until: u.heldUntil });
  return true;
}

/** [Poison] bites at the start of its victim's turn. */
export function tickPoison(state, p) {
  for (const u of [...livingUnits(state)].sort((a, b) => a.id - b.id)) {
    if (u.owner !== p || !u.poison) continue;
    hurt(state, u, u.poison, { cause: 'poison', byP: 1 - p });
  }
}

/* ------------------------------------------------------------ burning */

/**
 * Set a UNIT alight. `burn` is how many of its own turn starts the fire still
 * bites on (1 damage each); a second immolation ADDS turns rather than
 * resetting them, like poison stacks. `burnBy` is who gets the credit, so a
 * unit that burns to death scores for whoever lit it.
 *
 * The mirror of a burning terrain piece (field/push.js::ignite), kept apart
 * on purpose: a tree spreads to other trees and burns away, a unit just
 * hurts until the fire is out.
 */
export function setBurning(state, u, turns, { byP = null } = {}) {
  if (!u || u.dead || turns <= 0) return false;
  const fresh = !(u.burn > 0);
  u.burn = (u.burn || 0) + turns;
  u.burnBy = byP ?? u.burnBy ?? null;
  if (fresh && byP !== null && byP !== undefined && byP !== u.owner) bump(state.players[byP].ledger, 'unitsBurned');
  fx(state, 'burning', { id: u.id, turns: u.burn, by: byP });
  return true;
}

/** The fire on a unit bites at the start of its owner's turn, then counts down. */
export function tickBurn(state, p) {
  for (const u of [...livingUnits(state)].sort((a, b) => a.id - b.id)) {
    if (u.owner !== p || !(u.burn > 0)) continue;
    hurt(state, u, 1, { cause: 'burn', byP: u.burnBy ?? null });
    u.burn -= 1;
    if (u.burn <= 0) { u.burn = 0; u.burnBy = null; fx(state, 'burnOut', { id: u.id }); }
  }
}

/** The high-ground counter, measured once a turn so gold can score off it. */
export function recordHighGround(state, p) {
  if (unitsOf(state, p).some((u) => onHighGround(state, u))) {
    bump(state.players[p].ledger, 'highGroundEnds');
  }
}
