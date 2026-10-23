// THE SHOP -- coins after every duel, packs that write a sigil into the Spellbook.
//
// User (2026-10-23): "After each game you get coins and you can buy a random
// pack with a spell formula in it (rarer spells cost more). Which goes into
// your spell book. You can still discover them in the game, but just to
// expedite it so you don't have a silly long thing going on where it takes you
// 10 games to find one spell." And, on a first cut that sorted packs by school:
// "The packs have all the types of card in each, just there are different
// power tiers. Some are better than others."
//
// So RARITY IS POWER. Every pack holds every kind of card -- a spell of any
// school, an artifact, a trap, a golem, a gold card -- and what a dearer pack
// buys is better ODDS of a stronger one. The tiers themselves are measured,
// not guessed: js/rules/spells/rarity.js is written by tools/ratecards.js
// from how often decks holding each card win.
//
// Nothing here touches the engine or the save file. A duel's state comes in,
// a purse comes out; a Spellbook and a pack come in, a card id comes out.
// js/profile.js is the only thing that remembers the result, and the engine
// never learns that this file exists -- two machines in a lockstep game must
// not diverge on how rich one player is.
import { RARITY } from './spells/rarity.js';

/** Weakest first. A pack's odds are listed in this order too. */
export const RARITIES = Object.freeze(['common', 'uncommon', 'rare']);

/** A findable card's power tier. Unrated (a card added since the last rating run) is common. */
export const rarityOf = (def) => RARITY[def.id] || 'common';

/**
 * The three packs. Each holds ONE sigil of any kind; `odds` is the chance of
 * each tier, weakest first, summing to 1. The Archmage pack never pays out a
 * common card, which is what its price is for.
 */
export const PACKS = Object.freeze([
  { id: 'apprentice', name: 'Apprentice pack', price: 50, odds: [0.80, 0.18, 0.02], blurb: 'Mostly common cards, now and then something better.' },
  { id: 'adept', name: 'Adept pack', price: 100, odds: [0.45, 0.45, 0.10], blurb: 'As likely uncommon as common; one in ten is rare.' },
  { id: 'archmage', name: 'Archmage pack', price: 200, odds: [0, 0.50, 0.50], blurb: 'Never common; half the time rare.' },
]);

export const packOf = (id) => PACKS.find((k) => k.id === id) || null;

/** The findable cards of `rarity` that `learned` (card id -> how) does not hold yet, sorted by id. */
export const tierContents = (cards, learned, rarity) =>
  cards.filter((d) => d.sigil && rarityOf(d) === rarity && !learned?.[d.id])
    .map((d) => d.id).sort();

/** Every findable card `learned` does not hold yet -- what any pack can still pay out. */
export const packContents = (cards, learned) =>
  cards.filter((d) => d.sigil && !learned?.[d.id]).map((d) => d.id).sort();

/**
 * Roll a pack's tier from its odds with `r` in [0, 1), then settle on a tier
 * that still has unknown cards: the nearest one, and upward on a tie -- a pack
 * that cannot pay its rolled tier never pays a worse one when a better one is
 * there. Null only when the whole Spellbook is full.
 */
export function rollTier(pack, counts, r) {
  let acc = 0, rolled = RARITIES.length - 1;
  for (let i = 0; i < RARITIES.length; i++) { acc += pack.odds[i]; if (r < acc) { rolled = i; break; } }
  if (!RARITIES.some((t) => counts[t] > 0)) return null;
  let best = null;
  for (let i = 0; i < RARITIES.length; i++) {
    if (!(counts[RARITIES[i]] > 0)) continue;
    const dist = Math.abs(i - rolled);
    if (best === null || dist < best.dist || (dist === best.dist && i > best.i)) best = { i, dist };
  }
  return RARITIES[best.i];
}

/**
 * Open a pack: one card id you do not know, its tier rolled from the pack's
 * odds, the card uniform within the tier. `rng` is a function returning a
 * number in [0, 1) -- called twice. Null when every sigil is already known;
 * the shop must not sell an empty pack.
 */
export function openPack(cards, learned, pack, rng) {
  const counts = Object.fromEntries(RARITIES.map((t) => [t, tierContents(cards, learned, t).length]));
  const tier = rollTier(pack, counts, rng());
  if (!tier) return null;
  const pool = tierContents(cards, learned, tier);
  const i = Math.min(pool.length - 1, Math.max(0, Math.floor(rng() * pool.length)));
  return pool[i];
}

/**
 * COINS for a finished duel, seat `p`. Playing pays, winning pays more, every
 * VP pays, and every sigil bound in play pays a little -- so a lost duel still
 * buys something, a won one buys a pack, and the player who binds in play
 * gets to the shop faster than the one who waits for it.
 *
 * Watching two AIs pays nothing (p === null), and an unfinished duel pays
 * nothing: the purse is for duels played to the end.
 */
export const PURSE = Object.freeze({ played: 20, won: 30, perVp: 2, perFind: 10 });

export function coinsFor(state, p) {
  if (p === null || p === undefined || state.winner === null) return { total: 0, lines: [] };
  const lines = [{ label: 'Duel played', coins: PURSE.played }];
  if (state.winner === p) lines.push({ label: 'Victory', coins: PURSE.won });
  const vp = state.vp[p] | 0;
  if (vp > 0) lines.push({ label: `${vp} VP scored`, coins: vp * PURSE.perVp });
  const found = state.players[p].ledger.cardsFound | 0;
  if (found > 0) lines.push({ label: `${found} sigil${found === 1 ? '' : 's'} bound`, coins: found * PURSE.perFind });
  return { total: lines.reduce((s, l) => s + l.coins, 0), lines };
}
