// THE SPELLBOOK -- the system that took mana's place.
//
// The Spellbook is a record of THE WAYS TO GET CARDS. It is your accumulating
// knowledge of the game, not an inventory and not a deck list. You always start
// a match with the same ten-card deck; what a long Spellbook buys you is knowing
// which conditions find which spells, and being able to aim a turn at one.
//
// A FIND is a SIGIL (sigils.js): a small shape of runes you lay from the
// pouch your resolved faces fill, and bind once a turn. Making it puts the
// card in your DISCARD for the rest of that match -- not your hand, so you
// have to earn the draw as well -- and the Spellbook remembers the shape.
//
// It used to be a list of conditions ("deal 25 damage", "let your mage be
// wounded to half"). The user rejected that: a condition is a quest you must
// seek, and a quest that wins games becomes the one thing every match does.
// A sigil is something you figure out.

import { canonical, contains, sigilRunes } from './sigils.js';

/**
 * Validate the corpus's sigils at load.
 *
 * Two cards with the same sigil (as drawn -- orientation matters) would be a shape that
 * finds two spells -- a page the player cannot act on. A sigil that contains
 * another could never be completed: the smaller one fires first and spends
 * the runes. Both are refused here rather than discovered by a player.
 */
export function validateSigils(cards) {
  const have = [];
  for (const d of cards) {
    if (!d.sigil) continue;
    const key = canonical(d.sigil);
    const dup = have.find((h) => h.key === key);
    if (dup) throw new Error(`${d.id} and ${dup.id} share a sigil`);
    for (const h of have) {
      if (contains(h.cells, d.sigil)) throw new Error(`${h.id}'s sigil contains ${d.id}'s`);
      if (contains(d.sigil, h.cells)) throw new Error(`${d.id}'s sigil contains ${h.id}'s`);
    }
    have.push({ id: d.id, key, cells: d.sigil });
  }
  return have.length;
}

/**
 * The Spellbook page: every findable card, with its sigil once you have
 * found it and only a hint -- how many runes, and which -- until then.
 * `learned` maps card id -> how it was learned. Sorted by name.
 */
export const spellbookPage = (cards, learned) =>
  cards.filter((d) => d.sigil)
    .map((d) => ({ id: d.id, name: d.name, known: !!learned?.[d.id], sigil: learned?.[d.id] ? d.sigil : null, runes: sigilRunes(d.sigil), size: d.sigil.length }))
    .sort((a, b) => a.name.localeCompare(b.name));
