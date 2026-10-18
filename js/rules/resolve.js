// Resolving one face of one card. The entry point every effect goes through,
// and the context object every card is written against.
//
// `resolveSide(state, spell, index, opts)` TAKES THE INDEX. It is deliberately
// decoupled from the card's orientation, and the printed corpus forces it:
// Rewind II reads "resolve the effect of a I of a friendly Spell, REGARDLESS OF
// ORIENTATION". The chain calls this with the active index; Rewind calls it
// with 0. Designed the other way round -- resolveActive(spell) -- that card is
// unimplementable and you find out at card ninety.
//
// The CONTEXT is the real API of this whole engine. Cards never touch state,
// never import ops, never test for a keyword and never measure a distance
// themselves. They ask the ctx, and the ctx has already applied the keywords,
// the derived bonuses and the targeting restrictions. That is what makes a new
// keyword work on faces written months earlier.

import { ask } from './driver.js';
import {
  spellsOn, defOf, findSpell, destroy, turn, setRot, shift, draw, mill, fx,
  topOf, occupied, canTurn, prohibited, noteCards,
} from './ops.js';
import { activeIndex, NUMERALS } from './orient.js';
import { CELL_COLOR, above, below, leftOf, rightOf, orthoNeighbours } from './table.js';
import { gateMet, gateText } from './gates.js';
import { payAll, costPayable, costText } from './costs.js';
import { keywordsOf, apply as applyKw, fire as fireKw } from './keywords.js';
import { scoreObjective } from './objectives.js';
import { bump } from './ledger.js';
import { emit } from './triggers.js';
import { hurt } from './combat.js';
import { int, pick, next } from './rng.js';
import { bonusRange, bonusDamage, untargetable } from './derive.js';
import { dist3, idiv } from '../field/fixed.js';
import {
  livingUnits, unitsOf, enemiesOf, findUnit, findProp, propsOnBoard, rangeOrigins,
  mageOf, hasLos, surfaceAt,
} from '../field/query.js';
import { push, pushAwayFrom, pullToward, levitate, removeTerrain } from '../field/push.js';
import { walk, placeBody } from '../field/move.js';
import { pushDirs, ringPoints, elevatedNear, unitTargets, terrainTargets, dirLabel } from '../field/candidates.js';

/**
 * How deep one face may reach into another.
 *
 * Printed Spell Splice resolves a friendly Spell's effect, and a table with two
 * Spell Splices on it is a face that resolves a face that resolves the first
 * one. A depth cap rather than a cleverer rule, because the cleverer rules
 * ("not the same card", "not the same school") all have a two-card cycle that
 * defeats them.
 */
export const MAX_NEST = 3;

export function makeCtx(state, spell, def, face, opts = {}) {
  const p = spell.owner;
  const enemy = 1 - p;

  /** Every range check in the game, with keywords and auras already applied. */
  const range = (mmDist) => applyKw(state, spell, 'range', {
    mm: mmDist + bonusRange(state, p), heightK: 1,
  });

  const ctx = {
    state, spell, def, face, p, enemy, ask, depth: opts.depth || 0,
    numeral: face?.numeral, chained: !!opts.chained,

    /* ------------------------------------------------- the spell table */
    friendlySpells: ({ exceptSelf = true } = {}) => spellsOn(state, p)
      .filter((s) => !(exceptSelf && s.uid === spell.uid))
      .map((s) => s.uid).sort((a, b) => a - b),

    enemySpells: () => spellsOn(state, enemy)
      .filter((s) => !untargetable(state, s.uid))
      .map((s) => s.uid).sort((a, b) => a - b),

    /**
     * Which spells this face may choose. [Spell Bane] opens it to the enemy's.
     *
     * A face never writes `if (has('Spell Bane'))`. It asks for its targets and
     * the keyword has already widened them, which is why the keyword works on
     * every destroying and rotating face there is or ever will be.
     */
    spellTargets: ({ side = 'friendly', exceptSelf = true } = {}) => {
      const eff = applyKw(state, spell, 'targets', { side }).side;
      const mine = ctx.friendlySpells({ exceptSelf });
      if (eff === 'friendly') return mine;
      if (eff === 'enemy') return ctx.enemySpells();
      return [...mine, ...ctx.enemySpells()].sort((a, b) => a - b);
    },

    rotatable: (uids) => uids.filter((u) => canTurn(state, findSpell(state, u))),
    turnSpell: (uid, dir = 'left', o = {}) => turn(state, uid, { dir, ...o }),
    setSide: (uid, index, o = {}) => setRot(state, uid, index, o),
    shiftSpell: (uid, cell) => shift(state, uid, cell),
    destroySpell: (uid) => {
      const target = findSpell(state, uid);
      const victim = target?.owner;
      const out = destroy(state, uid, { by: `face:${def.id}:${face.numeral}` });
      if (out && victim !== p) bump(state.players[p].ledger, 'enemySpellsDestroyed');
      return out;
    },
    cellOf: (uid) => findSpell(state, uid)?.cell ?? null,
    neighbourCells: () => orthoNeighbours(spell.cell),
    neighbourSpell: (where) => {
      const c = where === 'above' ? above(spell.cell) : where === 'below' ? below(spell.cell)
        : where === 'left' ? leftOf(spell.cell) : rightOf(spell.cell);
      return c === null ? null : topOf(state, p, c);
    },
    adjacentSpells: () => orthoNeighbours(spell.cell)
      .map((c) => topOf(state, p, c)).filter(Boolean)
      .map((s) => s.uid).sort((a, b) => a - b),

    keywords: () => keywordsOf(state, spell),
    keywordsNear: () => [...new Set(ctx.adjacentSpells()
      .flatMap((u) => keywordsOf(state, findSpell(state, u))))].sort(),
    grantKeyword: (uid, kw) => {
      const t = findSpell(state, uid);
      if (!t) return false;
      t.keywords = [...new Set([...(t.keywords || []), kw])].sort().slice(0, 4);
      fx(state, 'keywordGrant', { uid, kw });
      return true;
    },

    /* ------------------------------------------------- cards */
    draw: (n = 1) => draw(state, p, n),
    mill: (n = 1) => mill(state, p, n),
    handUids: () => state.players[p].hand.map((c) => c.uid).sort((a, b) => a - b),
    discardUids: () => state.players[p].discard.map((c) => c.uid).sort((a, b) => a - b),

    /* ------------------------------------------------- the battlefield */
    range,
    origins: () => rangeOrigins(state, p),
    mage: () => mageOf(state, p),
    enemyUnits: (mmDist, o = {}) => {
      const r = range(mmDist);
      return unitTargets(state, p, r.mm, { side: 'enemy', heightK: r.heightK, ...o });
    },
    friendlyUnits: (mmDist, o = {}) => {
      const r = range(mmDist);
      return unitTargets(state, p, r.mm, { side: 'friendly', heightK: r.heightK, ...o });
    },
    anyUnits: (mmDist, o = {}) => {
      const r = range(mmDist);
      return unitTargets(state, p, r.mm, { side: 'any', heightK: r.heightK, ...o });
    },
    propsInRange: (mmDist, o = {}) => terrainTargets(state, p, range(mmDist).mm, o),
    unit: (id) => findUnit(state, id),
    prop: (id) => findProp(state, id),

    /** Damage, with [Impact] and any aura already in, and [Stun]/[Poison] after. */
    hit: (unitId, amount, why = {}) => {
      const u = findUnit(state, unitId);
      if (!u || u.dead) return 0;
      const d = applyKw(state, spell, 'damage', { amount: amount + bonusDamage(state, p) });
      const dealt = hurt(state, u, d.amount, { cause: why.cause || 'spell', byP: p });
      if (dealt > 0) fireKw(state, spell, 'hit', ctx, { target: u });
      noteCards(state, spell.uid);
      return dealt;
    },

    /** A push, with [Crush] and [Levitate] already folded in. */
    shove: (bodyId, dir, mmDist, o = {}) => {
      const body = typeof bodyId === 'number' ? findUnit(state, bodyId) : findProp(state, bodyId);
      if (!body) return { mm: 0 };
      const pp = applyKw(state, spell, 'push', { mm: mmDist, crush: false, levitate: false });
      return push(state, body, dir, pp.mm, { byP: p, crush: pp.crush, ...o });
    },
    shoveAway: (bodyId, mmDist, o = {}) => {
      const body = typeof bodyId === 'number' ? findUnit(state, bodyId) : findProp(state, bodyId);
      const o0 = rangeOrigins(state, p)[0] || { x: 0, y: 0 };
      if (!body) return { mm: 0 };
      const pp = applyKw(state, spell, 'push', { mm: mmDist, crush: false, levitate: false });
      return pushAwayFrom(state, body, o0.x, o0.y, pp.mm, { byP: p, crush: pp.crush, ...o });
    },
    pullIn: (bodyId, mmDist, o = {}) => {
      const body = typeof bodyId === 'number' ? findUnit(state, bodyId) : findProp(state, bodyId);
      const o0 = rangeOrigins(state, p)[0] || { x: 0, y: 0 };
      if (!body) return { mm: 0 };
      const pp = applyKw(state, spell, 'push', { mm: mmDist, crush: false, levitate: false });
      return pullToward(state, body, o0.x, o0.y, pp.mm, { byP: p, crush: pp.crush, ...o });
    },
    relocate: (unitId, point) => {
      const u = findUnit(state, unitId);
      if (!u || !point) return false;
      placeBody(state, u, point.x, point.y);
      fx(state, 'relocate', { id: unitId, to: point });
      return true;
    },
    landingPoints: (unitId, mmDist) => {
      const u = findUnit(state, unitId);
      return u ? ringPoints(state, u, mmDist, { forId: unitId }) : [];
    },
    elevatedNear: (unitId, mmDist) => {
      const u = findUnit(state, unitId);
      return u ? elevatedNear(state, u, mmDist) : null;
    },
    pushDirs: (unitId) => {
      const u = typeof unitId === 'number' ? findUnit(state, unitId) : findProp(state, unitId);
      return u ? pushDirs(state, p, u) : [];
    },
    dirLabel,
    liftTerrain: (propId, mmUp) => {
      const pr = findProp(state, propId);
      if (pr) levitate(state, pr, mmUp);
      return !!pr;
    },
    banishTerrain: (propId) => {
      const pr = findProp(state, propId);
      // "until end of turn" -- removed for the rest of THIS turn, so the
      // comparison that brings it back is `removedUntil < state.turn`.
      if (pr) removeTerrain(state, pr, state.turn);
      return !!pr;
    },

    /** [Unstable]'s blast. Hits the nearest enemy unit in reach of the table. */
    blast: (amount) => {
      const ids = ctx.enemyUnits(4000);
      if (!ids.length) return 0;
      return ctx.hit(ids[0], amount, { cause: 'unstable' });
    },

    /* ------------------------------------------------- misc */
    rng: state.rng,
    roll: (n) => int(state.rng, n),
    fx: (kind, data) => fx(state, kind, data),

    /** Resolve another face. Printed Spell Splice and Rewind. */
    resolve: (uid, index, o = {}) => {
      const t = findSpell(state, uid);
      if (!t) return (function* () {})();
      return resolveSide(state, t, index, { ...o, depth: (opts.depth || 0) + 1 });
    },
    resolveActive: (uid, o = {}) => {
      const t = findSpell(state, uid);
      if (!t) return (function* () {})();
      return resolveSide(state, t, activeIndex(t), { ...o, depth: (opts.depth || 0) + 1 });
    },
  };
  return ctx;
}

/**
 * Resolve face `index` of `spell`.
 *
 * The order is fixed and each step is a real decision point:
 *   1. the GATE. Unmet means INERT -- nothing happens, no VP -- and whatever
 *      rotation brought this face up still stands.
 *   2. the COST, all of it or none of it. Declined or unpayable means the
 *      effect fizzles, and again the rotation stands. That asymmetry is why a
 *      mandatory chain can hurt you.
 *   3. the OBJECTIVE, gold only, which destroys the card on the way out.
 *   4. the EFFECT.
 */
export function* resolveSide(state, spell, index, opts = {}) {
  if (!spell || spell.cell === null) return false;
  if ((opts.depth || 0) > MAX_NEST) { fx(state, 'nestTooDeep', { uid: spell.uid }); return false; }
  const def = defOf(state, spell);
  const face = def.faces[index & 3];
  if (!face) return false;

  const ctx = makeCtx(state, spell, def, face, opts);
  fx(state, 'resolveStart', { uid: spell.uid, def: def.id, numeral: face.numeral });

  if (face.gate && !gateMet(state, spell, face.gate)) {
    bump(state.players[spell.owner].ledger, 'inertResolutions');
    fx(state, 'gateUnmet', { uid: spell.uid, numeral: face.numeral, gate: face.gate.id, text: gateText(face.gate) });
    return false;
  }

  if (face.cost && face.cost.length) {
    const paid = yield* payAll(ctx, face.cost);
    if (!paid) {
      fx(state, 'fizzle', { uid: spell.uid, numeral: face.numeral, cost: costText(face.cost) });
      return false;
    }
    // The cost may have destroyed the resolving card itself (destroySelf, or a
    // destroyFriendly that chose it). A face whose effect reads its own cell
    // after that would be reading a card in the discard pile.
    if (spell.cell === null && !face.objective) return false;
  }

  if (face.objective) scoreObjective(state, spell, face);
  if (state.winner !== null) return true;

  if (face.effect) {
    try {
      yield* face.effect(ctx);
    } catch (e) {
      (state.resolveErrors ||= []).push({
        def: def.id, numeral: face.numeral, error: String(e && e.message || e), stack: String(e && e.stack || ''),
      });
    }
  }
  emit(state, 'afterResolve', { uid: spell.uid, def: def.id, numeral: face.numeral, p: spell.owner });
  return true;
}
