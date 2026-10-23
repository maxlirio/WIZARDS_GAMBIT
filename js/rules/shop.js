// THE SHOP -- coins after every duel, packs that write a sigil into the Spellbook.
//
// User (2026-10-23): "After each game you get coins and you can buy a random
// pack with a spell formula in it (rarer spells cost more). Which goes into
// your spell book. You can still discover them in the game, but just to
// expedite it so you don't have a silly long thing going on where it takes you
// 10 games to find one spell."
//
// Nothing here touches the engine or the save file. A duel's state comes in,
// a purse comes out; a Spellbook and a rarity come in, a card id comes out.
// js/profile.js is the only thing that remembers the result, and the engine
// never learns that this file exists -- two machines in a lockstep game must
// not diverge on how rich one player is.

/**
 * RARITY is the kind of work a sigil finds. The three school spells you build
 * a table from are common; the combo school, the artifacts and the traps are
 * uncommon; the gold cards that score and the golems that fight are rare --
 * the same split as their sigils, four runes for the first two tiers, five
 * for the rare ones.
 */
export const RARITIES = Object.freeze(['common', 'uncommon', 'rare']);

export function rarityOf(def) {
  if (def.kind === 'golem') return 'rare';
  if (def.kind === 'artifact' || def.kind === 'trap') return 'uncommon';
  if (def.school === 'gold') return 'rare';
  if (def.school === 'purple') return 'uncommon';
  return 'common';
}

/** The three packs. One sigil each, of the pack's rarity, never one you know. */
export const PACKS = Object.freeze([
  { rarity: 'common', name: 'Apprentice pack', price: 50, blurb: 'A red, blue or green spell.' },
  { rarity: 'uncommon', name: 'Adept pack', price: 100, blurb: 'A purple spell, an artifact or a trap.' },
  { rarity: 'rare', name: 'Archmage pack', price: 200, blurb: 'A gold card or a golem.' },
]);

export const packOf = (rarity) => PACKS.find((k) => k.rarity === rarity) || null;

/** The findable cards of `rarity` that `learned` (card id -> how) does not hold yet, sorted by id. */
export const packContents = (cards, learned, rarity) =>
  cards.filter((d) => d.sigil && rarityOf(d) === rarity && !learned?.[d.id])
    .map((d) => d.id).sort();

/**
 * Open a pack: one card id of `rarity` you do not know, chosen by `rng01` (a
 * number in [0, 1)). Null when every sigil of that rarity is already known --
 * the shop must not sell an empty pack.
 */
export function openPack(cards, learned, rarity, rng01) {
  const pool = packContents(cards, learned, rarity);
  if (!pool.length) return null;
  const i = Math.min(pool.length - 1, Math.max(0, Math.floor(rng01 * pool.length)));
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
