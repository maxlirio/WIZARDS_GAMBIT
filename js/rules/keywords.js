// [Keywords] -- your printed Aspect system, which already exists on your cards
// and already has two cards that copy them (Spell Splice, Link). So the digital
// version takes your terminology rather than inventing a parallel one.
//
// THE DESIGN RULE: an effect never tests for a keyword by hand. It builds a
// DESCRIPTOR -- a plain object saying what it is about to do -- and passes it
// through `apply`, which lets every keyword on the card have a turn at
// modifying it. A new keyword therefore works on every face that already
// exists, the day it is registered, without touching one of them.
//
// That is why [Ignore Height] is one line. A range check is `{mm, heightK}`,
// the keyword sets `heightK: 0`, and every range in the game respects it
// because there is only one range function. If effects branched on keywords at
// the call site, that keyword would need editing into forty faces and would
// work on thirty-eight of them.

import { defOf, fx, findSpell } from './ops.js';
import { grantedOn, lostOn, ensureFresh } from './derive.js';
import { bump } from './ledger.js';
import { ask } from './driver.js';

/** The most copied keywords one instance may carry. */
export const MAX_KEYWORDS = 4;

/**
 * The hooks a keyword may register. A CLOSED list.
 *
 * A keyword registering an unknown hook is a load-time error rather than a
 * keyword that silently never fires -- which is what a free-form string key
 * would give you, and is indistinguishable from "implemented" at every level
 * above this file.
 */
export const HOOKS = Object.freeze([
  'range',      // ({mm, heightK}) -> the same shape
  'damage',     // ({amount}) -> the same shape
  'push',       // ({mm, crush, levitate}) -> the same shape
  'hit',        // (ctx, {target}) -> void. After a hit lands.
  'incoming',   // ({amount}) -> the same shape. Damage being taken.
  'unitMove',   // ({mm}) -> the same shape
  'destroy',    // ({protected}) -> the same shape. Can the OPPONENT destroy the carrier?
  'turnLock',   // ({free}) -> the same shape
  'targets',    // ({side}) -> the same shape
  'cost',       // (ctx, {kind}) -> void. After a cost is paid.
  'onDestroy',  // (ctx) -> void. When the carrier is destroyed.
  'origin',     // marker only, read by field/query.js::rangeOrigins
]);

export const KEYWORDS = Object.freeze({
  /** The entire implementation. One coefficient, every range check in the game. */
  'Ignore Height': { text: 'Range ignores height.', range: (r) => ({ ...r, heightK: 0 }) },

  Reach: { text: 'Range +1m.', range: (r) => ({ ...r, mm: r.mm + 1000 }) },

  Impact: { text: 'Damage +1.', damage: (dd) => ({ ...dd, amount: dd.amount + 1 }) },

  /** Travel the wall ate becomes damage. See field/push.js. */
  Crush: { text: 'A blocked push deals damage instead.', push: (pp) => ({ ...pp, crush: true }) },

  /** Pushed through the air: terrain does not stop it. */
  Levitate: { text: 'A push ignores terrain.', push: (pp) => ({ ...pp, levitate: true }) },

  Stun: {
    text: "Spends the target's action.",
    hit: (ctx, { target }) => { if (target) target.acted = true; },
  },

  Poison: {
    text: '1 damage at the start of the target\'s turns.',
    hit: (ctx, { target }) => { if (target) target.poison = (target.poison || 0) + 1; },
  },

  Absorb: { text: 'Takes 1 less damage.', incoming: (dd) => ({ ...dd, amount: dd.amount - 1 }) },

  Swift: { text: 'Moves 1m further.', unitMove: (mv) => ({ ...mv, mm: mv.mm + 1000 }) },

  /**
   * A range origin -- which is what makes losing your mage cost more than a
   * unit phase, and what a [Channel] golem buys back.
   *
   * Through the hook, not by name. query.js used to test `unitHas(u,
   * 'Channel')`, which works right up until a second keyword wants to grant an
   * origin and has to be added to a hard-coded list in another file.
   */
  Channel: { text: 'Spells may measure range from this unit.', origin: (o) => ({ ...o, isOrigin: true }) },

  /**
   * The opponent cannot destroy this card. Your own effects still can -- a
   * cost that destroys a friendly Spell may eat it -- and a gate on one of
   * its faces still applies; [Inevitable] protects the card, not the effect.
   */
  Inevitable: { text: 'Your opponent cannot destroy it.', destroy: (d) => ({ ...d, protected: true }) },

  'Spell Mastery': { text: 'May be rotated on any colour.', turnLock: (t) => ({ ...t, free: true }) },

  'Spell Bane': { text: 'May target enemy Spells.', targets: (t) => ({ ...t, side: 'any' }) },

  Consume: {
    text: 'Destroying a friendly Spell for a cost also draws a card.',
    cost: (ctx, { kind }) => { if (kind === 'destroy') ctx.draw(1); },
  },

  Unstable: {
    text: 'Deals 1 damage to a unit in range when destroyed.',
    onDestroy: (ctx) => ctx.blast(1),
  },
});

export const KEYWORD_NAMES = Object.freeze(Object.keys(KEYWORDS).sort());

// Validated at load, not at use. A typo'd hook is otherwise a keyword that
// reads correct in the table above and never fires once.
for (const [name, k] of Object.entries(KEYWORDS)) {
  for (const h of Object.keys(k)) {
    if (h === 'text') continue;
    if (!HOOKS.includes(h)) throw new Error(`keyword '${name}' registers unknown hook '${h}'`);
  }
}

/* ------------------------------------------------------------ reading */

/**
 * A spell's keywords: printed on the card, plus copied onto this instance, plus
 * granted by somebody's passive, minus anything taken away.
 *
 * Recomputed on every query and never written back. Sorted and unique at the
 * exit, once, so no caller has to remember.
 */
export function keywordsOf(state, spell) {
  if (!spell) return [];
  ensureFresh(state);
  const printed = defOf(state, spell)?.keywords || [];
  const all = new Set([...printed, ...(spell.keywords || []), ...grantedOn(state, spell.uid)]);
  for (const k of lostOn(state, spell.uid)) all.delete(k);
  return [...all].sort();
}

export const has = (state, spell, kw) => keywordsOf(state, spell).includes(kw);

/**
 * Run a descriptor through every keyword on a card.
 *
 * Iterated over a SORTED list, always. Two keywords that both modify the same
 * field must compose in the same order on both machines of a lockstep game, and
 * Set iteration order follows insertion, which follows the order a chain
 * happened to copy things in.
 */
export function apply(state, spell, hook, desc) {
  return applyFor(keywordsOf(state, spell), hook, desc);
}

/** The side-effecting hooks (`hit`, `cost`, `onDestroy`) take a ctx. */
export function fire(state, spell, hook, ctx, payload) {
  return fireFor(keywordsOf(state, spell), hook, ctx, payload);
}

/**
 * The same two funnels over an explicit name list, so a UNIT's keywords go
 * through exactly the same code as a spell's.
 *
 * A golem carrying [Impact] and a red face carrying [Impact] must add the same
 * point of damage, and the only way to be sure of that is for there to be one
 * implementation that neither of them owns. `names` must already be sorted.
 */
export function applyFor(names, hook, desc) {
  let out = desc;
  for (const name of names) {
    const fn = KEYWORDS[name]?.[hook];
    if (typeof fn === 'function') out = fn(out) ?? out;
  }
  return out;
}

export function fireFor(names, hook, ctx, payload) {
  for (const name of names) {
    const fn = KEYWORDS[name]?.[hook];
    if (typeof fn === 'function') fn(ctx, payload);
  }
}

/* ------------------------------------------------------------ copying */

/**
 * The match's keyword copy, offered ONCE PER LINK and BEFORE the effect
 * resolves.
 *
 * Before, because the whole point of the mechanic is that putting [Ignore
 * Height] on a push changes the push you are about to make. Offered after, it
 * would only ever affect some later turn, and your own cards' phrasing ("cast a
 * levitate spell on a pushing spell") is about this turn.
 *
 * A generator, because it asks questions, so it has to be able to park.
 */
export function* offerCopy(state, uids) {
  const spells = uids.map((u) => findSpell(state, u)).filter(Boolean);
  if (spells.length < 2) return false;

  // Only keywords that are actually somewhere, and only onto a card that does
  // not already have them. An offer with nothing behind it is a question the
  // player cannot answer, and the driver answers a zero-option request null --
  // but asking it at all costs a click and a replay step.
  const pairs = [];
  for (const from of spells) {
    for (const kw of keywordsOf(state, from)) {
      for (const to of spells) {
        if (to.uid === from.uid) continue;
        if (keywordsOf(state, to).includes(kw)) continue;
        if ((to.keywords || []).length >= MAX_KEYWORDS) continue;
        pairs.push({ kw, from: from.uid, to: to.uid });
      }
    }
  }
  if (!pairs.length) return false;
  pairs.sort((a, b) => a.kw.localeCompare(b.kw) || a.from - b.from || a.to - b.to);

  // The ANSWER IS AN INDEX, never a label. A label is a display string that a
  // future rename changes, and an answer is recorded in `pending.answers` and
  // replayed on every subsequent question -- so a recorded label is a saved
  // game that breaks when the wording of a prompt is edited.
  const options = [-1, ...pairs.map((_, i) => i)];
  const labels = ['(copy nothing)', ...pairs.map((x) => `${x.kw}: ${x.from} to ${x.to}`)];
  const choice = yield ask.pick(options, { prompt: 'Copy a Keyword?', labels });
  if (choice === null || choice < 0) return false;
  const picked = pairs[choice];
  if (!picked) return false;

  const to = findSpell(state, picked.to);
  to.keywords = [...new Set([...(to.keywords || []), picked.kw])].sort();
  bump(state.players[to.owner].ledger, 'keywordsCopied');
  fx(state, 'keywordCopy', { kw: picked.kw, from: picked.from, to: picked.to });
  return true;
}
