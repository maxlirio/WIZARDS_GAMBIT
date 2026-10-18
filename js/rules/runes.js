// The four corner runes.
//
// A rune is a glyph printed at a corner of a card. Two or more of your cards
// meeting at one grid vertex and showing the SAME rune there match, which is the
// only way a face's effect ever resolves. So the rune set is not decoration: it
// is the game's entire trigger vocabulary, and how runes are handed out decides
// how often anything happens at all.
//
// They are assigned by a FUNCTIONAL TAXONOMY of what a face does, so that a
// match reads as "two corners doing the same kind of work resonate". That is
// legible across the table, designable, and something a deck can aim at.
//
// The rejected alternative was deriving the rune from (school, numeral). It is
// free and needs no data, but it makes every match predictable from position
// alone and leaves deckbuilding nothing to say.
//
// Runes are AUTHORED DATA, not computed from the faces. A card may deliberately
// carry a rune that disagrees with the face it shares an index with -- that is
// how a trap or a misdirection card is built. tools/checkrunes.js measures how
// often they agree and holds the corpus to a floor, rather than forcing it.

export const SPIRAL = 'SPIRAL';    // turning, shifting, the spell table itself
export const SHARD = 'SHARD';      // destruction and damage
export const WHEEL = 'WHEEL';      // pushing, relocating, terrain, height
export const LATTICE = 'LATTICE';  // cards, keywords, passives, scoring

export const RUNES = Object.freeze([SPIRAL, SHARD, WHEEL, LATTICE]);

/**
 * Every rune needs FOUR-FOLD ROTATIONAL SYMMETRY, because the card visibly
 * spins and a corner glyph must read the same from all four rotations -- that
 * is the convention your printed cards already use.
 *
 * And they must differ by SILHOUETTE CLASS, not by hue. A rune-matching game
 * that leans on colour alone is unplayable for a colour-blind player, and this
 * one asks you to compare four corners at a glance.
 *
 * Recorded here rather than in the art notes because it is the matcher's
 * accessibility contract, and the day someone draws these it has to be in the
 * file they are implementing against.
 */
export const GLYPH = Object.freeze({
  SPIRAL:  Object.freeze({ silhouette: 'curved',   stroke: 'four-armed swirl, no straight edge' }),
  SHARD:   Object.freeze({ silhouette: 'pointed',  stroke: 'four sharp points, concave between' }),
  WHEEL:   Object.freeze({ silhouette: 'circular', stroke: 'closed ring with four spokes' }),
  LATTICE: Object.freeze({ silhouette: 'square',   stroke: 'crosshatched square, flat sides' }),
});

/** A rune that matches everything. NOT authorable -- see match.js. */
export const WILD = 'WILD';

export const isRune = (r) => RUNES.includes(r);

/* ------------------------------------------------------- the verb taxonomy */
// What a face DOES, in four classes, one per rune. A motif declares its class
// once (motifs.js), so a face built from a motif is classified for free and a
// hand-written face declares `tag` itself.

export const VERB_RUNE = Object.freeze({
  turn: SPIRAL,
  break: SHARD,
  move: WHEEL,
  draw: LATTICE,
});

export const VERBS = Object.freeze(Object.keys(VERB_RUNE));

/** The rune a face's work would suggest, or null if the face declares nothing. */
export function suggestedRune(face) {
  if (!face) return null;
  const v = face.tag || null;
  return v ? VERB_RUNE[v] || null : null;
}
