// The only file in the project allowed to persist anything.
//
// One file, so a harness can fake it, so a replay cannot depend on it, and so
// `tools/checksource.js` can enforce the rule with a one-line grep. Nothing in
// js/rules or js/field may reach `localStorage`, and that is checked rather
// than agreed.
//
// What persists is the SPELLBOOK: which cards' sigils you have discovered
// (card id -> how: 'sigil' bound in play, 'pack' bought in the shop), so their
// shapes can be shown on the page -- and the PURSE, the coins every finished
// duel pays and the shop's packs cost (js/rules/shop.js). It is knowledge, not
// inventory -- your starting deck is the same ten cards in your first match and
// your thousandth. So this file can be deleted, corrupted or absent and the
// game still plays identically; you just stop knowing where the spells come
// from, and start saving up again.

import { coinsFor, openPack, packOf } from './rules/shop.js';

const KEY = 'wizards-gambit:profile:v1';

/**
 * In-memory fallback.
 *
 * Browser storage comes back empty in a private window, throws with site data
 * blocked, and does not exist at all in node -- where every harness runs. So
 * the store is always this object, and localStorage is only ever a mirror of
 * it. Reading through a try/catch that falls back to memory is the difference
 * between a Spellbook that is sometimes forgotten and a game that sometimes
 * will not start.
 */
const fresh = () => ({ learned: {}, matches: 0, wins: 0, coins: 0, spent: 0, packs: 0 });
let memory = fresh();

const host = () => {
  try { return typeof localStorage === 'undefined' ? null : localStorage; }
  catch { return null; }
};

export function load() {
  const h = host();
  if (h) {
    try {
      const raw = h.getItem(KEY);
      if (raw) memory = { ...fresh(), ...JSON.parse(raw) };
    } catch { /* corrupt or blocked: memory keeps whatever it had */ }
  }
  return memory;
}

export function save() {
  const h = host();
  if (!h) return false;
  try { h.setItem(KEY, JSON.stringify(memory)); return true; }
  catch { return false; }
}

/**
 * Learn `cardId`'s sigil (`how` is the fx's `why`, 'sigil'; the shop writes
 * 'pack'). Idempotent, and the first way wins: a sigil bought from a pack and
 * later bound in play was known before that duel, so it stays 'pack'.
 */
export function learn(cardId, how = 'sigil') {
  const p = load();
  if (p.learned[cardId]) return false;
  p.learned[cardId] = how;
  save();
  return true;
}

/**
 * Read a finished match's finds into the Spellbook and its coins into the
 * purse. Returns `{ learned, coins, lines }` -- how many sigils were new, and
 * the purse's itemised award (js/rules/shop.js `coinsFor`).
 *
 * Takes the state rather than being called from inside it: the engine must not
 * know this file exists, or a replay could depend on what the player happens to
 * have learned, and two machines in a lockstep game would diverge on a
 * difference in their save files.
 *
 * A sigil bought from a pack and then bound in play keeps 'pack': the shape
 * was known before the duel, so the duel did not discover it.
 */
export function recordMatch(state, p) {
  const prof = load();
  prof.matches++;
  if (state.winner === p) prof.wins++;
  let learned = 0;
  for (const f of state.fx || []) {
    if (f.kind === 'found' && f.p === p && f.why) {
      if (!prof.learned[f.defId]) { prof.learned[f.defId] = f.why; learned++; }
    }
  }
  const purse = coinsFor(state, p);
  prof.coins += purse.total;
  save();
  return { learned, coins: purse.total, lines: purse.lines };
}

export const coins = () => load().coins | 0;

/**
 * Buy the pack `packId` ('apprentice' | 'adept' | 'archmage') from `cards`
 * (the corpus). Returns the card id the pack held, now in the Spellbook as
 * 'pack'; throws when the purse is short or every sigil is already known.
 * `rng` is a function returning a number in [0, 1): the page passes its own
 * dice, a harness passes what it likes -- the shop is not part of any replay,
 * so it is the one place chance may be real.
 */
export function buyPack(cards, packId, rng) {
  const pack = packOf(packId);
  if (!pack) throw new Error(`no pack '${packId}'`);
  const prof = load();
  const id = openPack(cards, prof.learned, pack, rng);
  if (!id) throw new Error('you know every sigil there is');
  if (prof.coins < pack.price) throw new Error(`${pack.name} costs ${pack.price} coins; you have ${prof.coins}`);
  prof.coins -= pack.price;
  prof.spent += pack.price;
  prof.packs++;
  prof.learned[id] = 'pack';
  save();
  return id;
}

export function reset() {
  memory = fresh();
  const h = host();
  try { h?.removeItem(KEY); } catch { /* nothing to do */ }
  return memory;
}

export const known = () => Object.keys(load().learned).sort();

/**
 * A one-time UI note -- "has this browser seen the rules yet?". Returns whether
 * it had, and records that it now has. Kept here so localStorage stays in one
 * file; it is not part of the Spellbook and a reset leaves it alone.
 */
export function seen(what) {
  const h = host();
  const key = `wizards-gambit:seen:${what}`;
  try {
    if (h?.getItem(key)) return true;
    h?.setItem(key, '1');
  } catch { /* blocked: behave as if never seen, which only re-shows a note */ }
  return false;
}

/**
 * A browser setting that is not part of the Spellbook: the graphics quality.
 * Here for the same reason `seen` is -- one file touches localStorage.
 */
export function setting(what, value) {
  const h = host();
  const key = `wizards-gambit:setting:${what}`;
  try {
    if (value !== undefined) { h?.setItem(key, String(value)); return value; }
    return h?.getItem(key) ?? null;
  } catch { return value === undefined ? null : value; }
}
