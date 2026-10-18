// What a Spell costs. THERE IS NO MANA IN THIS GAME.
//
// Playing a card costs your spell action and nothing else. Every other cost is
// printed inside a face, where your own cards already put them: destroy a Spell
// you control, discard a card, give up a unit's action. So a cost here is never
// a resource check, it is always a THING YOU DO -- which is also what bounds the
// chain in practice: nearly every face worth resolving eats a friendly spell at
// some point, and you run out of table before the chain runs out of links.
//
// Every cost is a generator, because paying one asks a question. A cost that
// cannot be paid, or that the player declines, FIZZLES THE EFFECT -- and the
// rotation that caused it still stands. That asymmetry is the whole reason a
// mandatory chain can hurt you.

import { ask } from './driver.js';
import * as ops from './ops.js';
import { bump } from './ledger.js';
import { spellsOn, defOf, findSpell, destroy, discardFromHand, mill, draw, fx } from './ops.js';
import { canTurn, turn } from './ops.js';
import { fire, keywordsOf } from './keywords.js';
import { unitsOf, mageOf } from '../field/query.js';
import { hurt } from './combat.js';

/**
 * The cost vocabulary. A CLOSED registry, same reasoning as gates: a cost
 * written inline on a card is a cost the AI cannot price and the UI cannot
 * explain before you commit to it.
 *
 * Each entry is a generator taking (ctx, spec) and returning true if it was
 * paid. `can` is a cheap pure pre-check so legalActions and the AI can tell
 * whether a face is worth anything without running it.
 */
export const COSTS = Object.freeze({
  discard: {
    text: (c) => `discard ${c.n} card${c.n === 1 ? '' : 's'}`,
    can: (state, sp, c) => state.players[sp.owner].hand.length >= c.n,
    *pay(ctx, c) {
      const hand = ctx.state.players[ctx.p].hand.map((x) => x.uid).sort((a, b) => a - b);
      if (hand.length < c.n) return false;
      const chosen = yield ask.some(hand, c.n, { prompt: `Discard ${c.n}`, kind: 'hand' });
      const list = [].concat(chosen || []).slice(0, c.n);
      if (list.length < c.n) return false;
      for (const uid of list) discardFromHand(ctx.state, ctx.p, uid);
      return true;
    },
  },

  destroyFriendly: {
    text: (c) => `destroy ${c.n} Spell${c.n === 1 ? '' : 's'} you control`,
    can: (state, sp, c) => spellsOn(state, sp.owner).filter((s) => s.uid !== sp.uid).length >= c.n,
    *pay(ctx, c) {
      const opts = spellsOn(ctx.state, ctx.p)
        .filter((s) => s.uid !== ctx.spell.uid)
        .map((s) => s.uid).sort((a, b) => a - b);
      if (opts.length < c.n) return false;
      const chosen = yield ask.some(opts, c.n, { prompt: `Destroy ${c.n} of your Spells` });
      const list = [].concat(chosen || []).slice(0, c.n);
      if (list.length < c.n) return false;
      for (const uid of list) {
        destroy(ctx.state, uid, { by: 'cost' });
        bump(ctx.state.players[ctx.p].ledger, 'spellsSacrificed');
      }
      // [Consume] turns paying this into drawing a card. The keyword hook fires
      // here, once, rather than being a clause repeated on every face that
      // happens to cost a spell.
      fire(ctx.state, ctx.spell, 'cost', ctx, { kind: 'destroy', n: c.n });
      return true;
    },
  },

  /** Eats the card that is resolving. Gold's payout always does this. */
  destroySelf: {
    text: () => 'destroy this Spell',
    can: () => true,
    *pay(ctx) {
      destroy(ctx.state, ctx.spell.uid, { by: 'cost' });
      bump(ctx.state.players[ctx.p].ledger, 'spellsSacrificed');
      return true;
    },
  },

  millSelf: {
    text: (c) => `put the top ${c.n} cards of your deck into your discard`,
    can: (state, sp, c) => state.players[sp.owner].deck.length + state.players[sp.owner].discard.length >= c.n,
    *pay(ctx, c) {
      const got = mill(ctx.state, ctx.p, c.n);
      return got.length >= c.n;
    },
  },

  /** A unit gives up its action. The one cost paid on the battlefield. */
  spendUnitAction: {
    text: () => "spend a friendly unit's action",
    can: (state, sp) => unitsOf(state, sp.owner).some((u) => !u.acted),
    *pay(ctx) {
      const opts = unitsOf(ctx.state, ctx.p).filter((u) => !u.acted).map((u) => u.id).sort((a, b) => a - b);
      if (!opts.length) return false;
      const id = yield ask.one(opts, { prompt: "Spend a unit's action", kind: 'unit' });
      const u = ctx.state.field.units.find((x) => x.id === id);
      if (!u) return false;
      u.acted = true;
      return true;
    },
  },

  /** Your own mage pays in blood. A real cost: it feeds the enemy's VP. */
  mageWound: {
    text: (c) => `your mage takes ${c.n} damage`,
    can: (state, sp, c) => { const m = mageOf(state, sp.owner); return !!m && !m.dead && m.hp > c.n; },
    *pay(ctx, c) {
      const m = mageOf(ctx.state, ctx.p);
      if (!m || m.dead || m.hp <= c.n) return false;
      hurt(ctx.state, m, c.n, { cause: 'cost', byP: null });
      return true;
    },
  },

  rotateFriendly: {
    text: () => 'rotate another Spell you control left',
    can: (state, sp) => spellsOn(state, sp.owner).some((s) => s.uid !== sp.uid && canTurn(state, s)),
    *pay(ctx) {
      const opts = spellsOn(ctx.state, ctx.p)
        .filter((s) => s.uid !== ctx.spell.uid && canTurn(ctx.state, s))
        .map((s) => s.uid).sort((a, b) => a - b);
      if (!opts.length) return false;
      const uid = yield ask.one(opts, { prompt: 'Rotate one of your Spells left' });
      return turn(ctx.state, uid, { dir: 'left' });
    },
  },
});

export const COST_IDS = Object.freeze(Object.keys(COSTS).sort());

export function validateCost(cardId, numeral, cost) {
  for (const c of cost || []) {
    if (!COSTS[c.id]) throw new Error(`${cardId} ${numeral}: no such cost '${c.id}'`);
  }
}

/** Could this face's cost be paid at all, right now? Pure, cheap, no asking. */
export const costPayable = (state, spell, cost) =>
  (cost || []).every((c) => COSTS[c.id].can(state, spell, c));

/**
 * Pay a face's whole cost, or none of it.
 *
 * ALL OR NOTHING, and that needs saying: paying the first half of a two-part
 * cost and then failing the second would destroy your spell for nothing. The
 * pre-check runs over the whole list before anything is spent, and any part
 * that then fails to be paid is a bug rather than a game outcome -- so the
 * fizzle is reported, not swallowed.
 */
export function* payAll(ctx, cost) {
  if (!cost || !cost.length) return true;
  if (!costPayable(ctx.state, ctx.spell, cost)) return false;
  for (const c of cost) {
    const ok = yield* COSTS[c.id].pay(ctx, c);
    if (!ok) {
      fx(ctx.state, 'costDeclined', { uid: ctx.spell.uid, cost: c.id });
      return false;
    }
  }
  return true;
}

export const costText = (cost) =>
  (cost || []).map((c) => (typeof COSTS[c.id].text === 'function' ? COSTS[c.id].text(c) : COSTS[c.id].text)).join(', ');
