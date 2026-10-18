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
import { unitMove, shieldOn } from './derive.js';
import { TIER_CAP, SLOTS } from './golems.js';
import { idiv, dist3, bearing } from '../field/fixed.js';
import {
  livingUnits, unitsOf, enemiesOf, findUnit, mageOf, unitKeywords,
  strikeTargets, surfaceAt, onHighGround,
} from '../field/query.js';
import { walk, placeBody, resolveFalls, recheckSupport } from '../field/move.js';
import { moveDirs, summonPoints, trialWalk, dirLabel } from '../field/candidates.js';

/** The mage's statline. One place, so a balance pass is one edit. */
export const MAGE = Object.freeze({ hp: 8, move: 2500, atk: 2, reach: 900 });

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
    old.keywords = [];
    old.acted = false;
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
  const budget = unitMove(state, unit);
  const mv = applyFor(unitKeywords(state, unit), 'unitMove', { mm: budget });
  for (const d of moveDirs(state, { ...unit, move: mv.mm })) {
    out.push({ type: 'unit', id: unit.id, act: 'move', dir: d.dir, mm: d.mm, label: d.label });
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

/** Perform one unit action. A generator: summoning asks where. */
export function* doUnitAction(state, action) {
  const u = findUnit(state, action.id);
  if (!u || u.dead || u.acted) return false;

  if (action.act === 'pass') { u.acted = true; return true; }

  if (action.act === 'move') {
    const mv = applyFor(unitKeywords(state, u), 'unitMove', { mm: unitMove(state, u) });
    const r = walk(state, u, action.dir, mv.mm, { allowFall: false, climb: true });
    bump(state.players[u.owner].ledger, 'moves');
    u.acted = true;
    recheckSupport(state);
    resolveFalls(state, hurt);
    fx(state, 'move', { id: u.id, mm: r.mm, dir: action.dir, to: { x: u.x, y: u.y, z: u.z } });
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
  for (const u of livingUnits(state)) if (u.owner === p) u.acted = false;
}

/** [Poison] bites at the start of its victim's turn. */
export function tickPoison(state, p) {
  for (const u of [...livingUnits(state)].sort((a, b) => a.id - b.id)) {
    if (u.owner !== p || !u.poison) continue;
    hurt(state, u, u.poison, { cause: 'poison', byP: 1 - p });
  }
}

/** The high-ground counter, measured once a turn so gold can score off it. */
export function recordHighGround(state, p) {
  if (unitsOf(state, p).some((u) => onHighGround(state, u))) {
    bump(state.players[p].ledger, 'highGroundEnds');
  }
}
