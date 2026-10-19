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
  topOf, occupied, canTurn, prohibited, noteCards, playFromHand, homeCells,
  protectedFrom,
} from './ops.js';
import { activeIndex, NUMERALS } from './orient.js';
import { CELL_COLOR, above, below, leftOf, rightOf, orthoNeighbours } from './table.js';
import { gateMet, gateText } from './gates.js';
import { payAll, costPayable, costText } from './costs.js';
import { keywordsOf, apply as applyKw, fire as fireKw, KEYWORD_NAMES } from './keywords.js';
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
import { push, pushAwayFrom, pullToward, levitate, removeTerrain, smashProp, ignite } from '../field/push.js';
import { propR, propOnBoard, propSpec } from '../field/arena.js';
import { walk, placeBody, fallDamageFor, recheckSupport, resolveFalls } from '../field/move.js';
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
      const out = destroy(state, uid, { by: `face:${def.id}:${face.numeral}`, byP: p });
      if (out && victim !== p) bump(state.players[p].ledger, 'enemySpellsDestroyed');
      return out;
    },
    /** Spells this face could destroy: an enemy's [Inevitable] card is never offered. */
    destroyTargets: ({ side = 'friendly' } = {}) => ctx.spellTargets({ side }).filter((uid) => {
      const t = findSpell(state, uid);
      return t && (t.owner === p || !protectedFrom(state, t));
    }),
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
    keywordsOf: (uid) => { const t = findSpell(state, uid); return t ? keywordsOf(state, t) : []; },
    keywordNames: () => [...KEYWORD_NAMES],
    homeCellsOf: (defId) => homeCells(state.defs[defId]),
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

    /** Terrain whose edge is within `r` of a point. On the board, id order. */
    propsNear: (x, y, r) => propsOnBoard(state)
      .filter((pr) => (pr.x - x) ** 2 + (pr.y - y) ** 2 <= (r + propR(pr)) ** 2)
      .map((pr) => pr.id).sort(),
    smash: (propId, amount, why = {}) => smashProp(state, findProp(state, propId), amount, { byP: p, cause: why.cause || 'spell' }),
    ignite: (propId) => ignite(state, findProp(state, propId), { byP: p }),

    /**
     * EVERYTHING CAN BE AFFECTED. A face's element, let loose on the terrain
     * around a point:
     *
     *   fire       lights anything made of wood. The fire is the effect -- it
     *              bites at the start of every turn and spreads.
     *   lightning  lights wood too, and bursts crystal outright.
     *   force      cracks whatever it reaches for `amount`, and throws it
     *              `mm` away from the point if `mm` is given. A quake topples a
     *              standing stone; a nova shoves a boulder as well as a mage.
     *
     * One funnel, so a card that says "fire" never has to know what wood is.
     */
    sweep: (x, y, radius, element, { amount = 1, mm = 0 } = {}) => {
      if (!element) return;
      for (const id of ctx.propsNear(x, y, radius)) {
        const pr = findProp(state, id);
        if (!pr || !propOnBoard(state, pr)) continue;
        if (element === 'fire') {
          ignite(state, pr, { byP: p });
        } else if (element === 'lightning') {
          ignite(state, pr, { byP: p });
          if (pr.kind === 'shard') smashProp(state, pr, pr.hp, { byP: p, cause: 'lightning' });
        } else if (element === 'force') {
          if (mm > 0 && !(pr.x === x && pr.y === y)) {
            const pp = applyKw(state, spell, 'push', { mm, crush: false, levitate: false });
            pushAwayFrom(state, pr, x, y, pp.mm, { byP: p, crush: pp.crush });
          }
          if (propOnBoard(state, pr)) smashProp(state, pr, amount, { byP: p, cause: 'force' });
        }
      }
    },

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

    /** Push a body directly away from an arbitrary point. */
    pushFrom: (bodyId, fromX, fromY, mmDist, o = {}) => {
      const body = typeof bodyId === 'number' ? findUnit(state, bodyId) : findProp(state, bodyId);
      if (!body) return { mm: 0 };
      const pp = applyKw(state, spell, 'push', { mm: mmDist, crush: false, levitate: false });
      return pushAwayFrom(state, body, fromX, fromY, pp.mm, { byP: p, crush: pp.crush || !!o.crush, ...o });
    },
    pullTo: (bodyId, toX, toY, mmDist, o = {}) => {
      const body = typeof bodyId === 'number' ? findUnit(state, bodyId) : findProp(state, bodyId);
      if (!body) return { mm: 0 };
      const pp = applyKw(state, spell, 'push', { mm: mmDist, crush: false, levitate: false });
      return pullToward(state, body, toX, toY, pp.mm, { byP: p, crush: pp.crush, ...o });
    },
    /** Where this face measures from: the first range origin (usually the mage). */
    origin: () => rangeOrigins(state, p)[0] || null,

    /**
     * Throw a unit straight up and let it come down where it was. The fall is
     * the damage, at the fall table's rate, and it is credited to the caster --
     * an ordinary fall has nobody to credit, and a kill nobody made scores
     * nothing.
     */
    hurl: (unitId, mmUp) => {
      const u = findUnit(state, unitId);
      if (!u || u.dead) return 0;
      fx(state, 'hurl', { id: unitId, mm: mmUp });
      const dmg = fallDamageFor(mmUp);
      return dmg > 0 ? hurt(state, u, dmg, { cause: 'fall', byP: p, drop: mmUp }) : 0;
    },

    /**
     * Lift a terrain piece and drop it on a unit: the unit takes the hit and
     * is knocked aside, and the rock comes to rest where the unit stood.
     */
    dropRock: (propId, unitId, amount) => {
      const pr = findProp(state, propId);
      const u = findUnit(state, unitId);
      if (!pr || !u || u.dead) return 0;
      const ix = u.x, iy = u.y, fromX = pr.x, fromY = pr.y;
      fx(state, 'dropRock', { id: propId, onto: unitId, from: { x: fromX, y: fromY }, to: { x: ix, y: iy } });
      const dealt = ctx.hit(unitId, amount, { cause: 'rock' });
      if (!u.dead) pushAwayFrom(state, u, fromX === ix && fromY === iy ? ix - 1 : fromX, fromY, 800, { byP: p });
      // The rock lands where the unit stood -- or, if another piece of terrain
      // already fills that spot, just short of it along the line it fell, so
      // two rocks never end up inside each other.
      let lx = ix, ly = iy;
      const r0 = propR(pr);
      for (let k = 0; k < 10; k++) {
        const clash = state.field.props.some((o) => o !== pr && propOnBoard(state, o)
          && (o.x - lx) ** 2 + (o.y - ly) ** 2 < (propR(o) + r0) ** 2);
        if (!clash) break;
        lx = ix + idiv((fromX - ix) * (k + 1), 10);
        ly = iy + idiv((fromY - iy) * (k + 1), 10);
      }
      pr.x = lx; pr.y = ly;
      const s = surfaceAt(state, lx, ly, { ignore: pr.id });
      pr.z = s.z; pr.support = s.support;
      recheckSupport(state);
      resolveFalls(state, hurt);
      return dealt;
    },

    /** Swap two units' places. Both settle on whatever is under them. */
    swapUnits: (aId, bId) => {
      const a = findUnit(state, aId), b = findUnit(state, bId);
      if (!a || !b || a === b) return false;
      const ax = a.x, ay = a.y;
      placeBody(state, a, b.x, b.y);
      placeBody(state, b, ax, ay);
      fx(state, 'swap', { a: aId, b: bId });
      recheckSupport(state);
      resolveFalls(state, hurt);
      return true;
    },

    /** Raise a new stone wall. Terrain is created, named, and stays. */
    raiseWall: (point) => {
      if (!point) return null;
      const f = state.field;
      f.nextPropId = (f.nextPropId ?? f.props.length) + 1;
      const s = surfaceAt(state, point.x, point.y);
      const pr = { id: `w${f.nextPropId}`, kind: 'wall', x: point.x, y: point.y, z: s.z,
        removedUntil: null, body: 'prop', support: s.support, raised: true,
        hp: propSpec('wall').hp, burning: null, litBy: null, destroyed: false };
      f.props.push(pr);
      fx(state, 'raiseWall', { id: pr.id, at: { x: point.x, y: point.y, z: s.z } });
      return pr.id;
    },

    /** The mage regains life, up to its maximum. */
    mend: (n) => {
      const m = mageOf(state, p);
      if (!m || m.dead) return 0;
      const got = Math.min(n, m.maxHp - m.hp);
      m.hp += got;
      if (got > 0) fx(state, 'heal', { id: m.id, amount: got });
      return got;
    },

    /** A card from your discard pile back into your hand. */
    recall: (uid) => {
      const pl = state.players[p];
      const i = pl.discard.findIndex((c) => c.uid === uid);
      if (i < 0) return false;
      pl.hand.push(pl.discard.splice(i, 1)[0]);
      fx(state, 'recall', { uid, p });
      return true;
    },

    /** A spell from your discard straight back onto an empty cell, showing I. */
    reanimate: (uid, cell) => {
      const c = playFromHand(state, p, uid, cell);
      if (c) fx(state, 'reanimate', { uid, p, cell });
      return !!c;
    },

    /** An enemy Spell may not rotate until the end of its owner's next turn. */
    hex: (uid) => {
      const t = findSpell(state, uid);
      if (!t) return false;
      t.noTurnUntil = state.turn + 1;
      fx(state, 'prohibited', { uid, untilTurn: state.turn + 1 });
      return true;
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

  // A gold face's OBJECTIVE condition is checked before its cost too. Gold
  // costs are the price of scoring; paying one and then being told the
  // objective was not met would make the cost a trap rather than a price.
  if (face.objective?.gate && !gateMet(state, spell, face.objective.gate, { objective: true })) {
    bump(state.players[spell.owner].ledger, 'inertResolutions');
    fx(state, 'gateUnmet', { uid: spell.uid, numeral: face.numeral, gate: face.objective.gate.id, text: gateText(face.objective.gate) });
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
    // A face whose cost is "destroy THIS Spell" is the exception: the card is
    // spent ON PURPOSE to power the effect, and stopping here meant printed
    // Ash Wraith ("Destroy this Spell. Deal 4 damage...") never dealt any.
    const spentItself = face.cost.some((c) => c.id === 'destroySelf');
    if (spell.cell === null && !face.objective && !spentItself) return false;
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
