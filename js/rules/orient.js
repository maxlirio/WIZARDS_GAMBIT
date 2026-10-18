// Rotation algebra. Everything about which face is active and which rune sits at
// which grid vertex comes from here, and from nothing else.
//
// AUTHORING ORDER matches the printed card, so data is transcribed rather than
// translated:
//
//   faces[0..3] are sides I, II, III, IV  -- CLOCKWISE FROM THE TOP edge
//   runes[0..3] are the four corners      -- CLOCKWISE FROM THE TOP-LEFT corner
//
// That is exactly the CARD_FORGE template's layout (sideI top upright, sideII
// right at 90 degrees, sideIII bottom at 180, sideIV left at 270; corner
// numerals I-IV clockwise from top-left).
//
// POSITIONS are in the table's frame, indexed the same way:
//
//   face positions    0 top, 1 right, 2 bottom, 3 left
//   corner positions  0 top-left, 1 top-right, 2 bottom-right, 3 bottom-left
//
// THE ACTIVE FACE IS THE ONE AT THE TOP. A spell is played at rot = 0, so its
// side I is active when it lands.
//
// `rot` counts LEFT (counter-clockwise) quarter turns. A counter-clockwise turn
// carries the top edge to the left, and the top-left corner to the bottom-left
// -- in both vocabularies that is position k -> position k-1. So after `rot`
// left turns, table position p is occupied by the thing authored at index
// (p + rot) mod 4, for faces and corners alike.
//
// Hence the identity the whole engine leans on:
//
//     activeFaceIndex === rot
//
// One addition, one identity, two uses, no lookup tables. tools/checkrotate.js
// proves it against a hand-worked card for all 4 rotations x 4 positions.

export const POS = Object.freeze({ top: 0, right: 1, bottom: 2, left: 3 });
export const CORNER = Object.freeze({ topLeft: 0, topRight: 1, bottomRight: 2, bottomLeft: 3 });

/** The printed numerals, for authoring and for error messages. */
export const NUMERALS = Object.freeze(['I', 'II', 'III', 'IV']);

/** Which authored index currently sits at table position `p`. */
export const indexAt = (rot, p) => (p + rot) & 3;

/** The index of the active (top) face. */
export const activeIndex = (spell) => spell.rot & 3;

/** Apply a turn. `steps` defaults to 1; 'any' is handled by the caller. */
export function turned(rot, dir, steps = 1) {
  const n = ((steps % 4) + 4) % 4;
  return dir === 'right' ? (rot + 4 - n) & 3 : (rot + n) & 3;
}

/* ------------------------------------------------------------------ accessors
 * These take `def` rather than `state` so they stay pure and testable. The
 * state-aware versions (which apply derived rune overrides and wildcards) live
 * in match.js, and NOTHING outside match.js may read def.runes directly --
 * Resonis Orb ("the corners of this Artifact count as any corner") is invisible
 * to any matcher that bypasses it, which is a planted fault in verify-faces.
 */

export const faceAt = (def, spell, p) => def.faces[indexAt(spell.rot, p)];
export const runeAt = (def, spell, p) => def.runes[indexAt(spell.rot, p)];
export const activeFace = (def, spell) => def.faces[activeIndex(spell)];

/** The rotation that would make authored face `i` active. */
export const rotFor = (i) => i & 3;
