// CORNERS -- the one state-aware reading of a card's runes, and which of its
// corners are touching a matching corner right now.
//
// Lives apart from match.js because two readers need it that must not pull
// the chain in: the matcher itself, and keywords.js, where a Keyword RESONATES
// across a match for exactly as long as the corners agree (user: "the
// keywords AUTOMATICALLY transfer, but they ONLY remain on a not original
// spell as long as there is a match in edges").

import { MATCH_SITES, SITE } from './table.js';
import { indexAt } from './orient.js';
import { WILD } from './runes.js';
import { topOf, defOf } from './ops.js';
import { ensureFresh } from './derive.js';

/**
 * THE state-aware rune accessor. Nothing outside this file reads `def.runes`.
 *
 * Printed Resonis Orb -- "the corners of this Artifact count as any corner" --
 * is invisible to any matcher that goes straight to the data, and the failure
 * is silent: the card sits there looking implemented and simply never matches.
 * orient.js says so in its header and verify-faces.js plants exactly this fault.
 */
export function runeAtCorner(state, spell, pos) {
  // A trap has NO corners: face down, nothing shows, and even a wildcard
  // beside it has nothing to agree with. `null` is "no rune here", and
  // `runesMatch` below refuses it against everything, WILD included.
  if (defOf(state, spell).kind === 'trap') return null;
  const d = ensureFresh(state);
  if (d.wildCorners.has(spell.uid)) return WILD;
  const runes = d.runeOverride.get(spell.uid) || defOf(state, spell).runes;
  return runes[indexAt(spell.rot, pos)];
}

/**
 * Do two touching corners match? A wildcard matches anything, including
 * another wildcard.
 */
export const runesMatch = (a, b) => a !== null && b !== null && (a === WILD || b === WILD || a === b);

/**
 * The cards whose corner agrees with one of this card's corners right now:
 * `[{uid, site, mine, theirs}]` in site order, so the answer never depends on
 * anything the state could vary. Read by keywords.js for resonance and by
 * the HUD to draw the bonds.
 */
export function touching(state, spell) {
  if (!spell || spell.cell === null || spell.cell === undefined) return [];
  const out = [];
  const p = spell.owner;
  for (const id of MATCH_SITES) {
    const site = SITE[id];
    const k = site.cells.indexOf(spell.cell);
    if (k < 0) continue;
    const me = topOf(state, p, site.cells[k]);
    if (!me || me.uid !== spell.uid) continue;              // buried
    const other = topOf(state, p, site.cells[1 - k]);
    if (!other) continue;
    if (!runesMatch(runeAtCorner(state, me, site.pos[k]), runeAtCorner(state, other, site.pos[1 - k]))) continue;
    out.push({ uid: other.uid, site: id, mine: site.pos[k], theirs: site.pos[1 - k] });
  }
  return out;
}
