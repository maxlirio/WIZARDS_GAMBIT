// The card corpus. Importing this registers every card.
//
// School files call `card()` from registry.js; this file imports them for their
// side effect and then declares the standard deck. The split keeps the registry
// out of the import cycle -- the school files need `card` before this module's
// own bindings exist.

import { CARDS, allCards, bySchool, byKind, inertReport } from './registry.js';

import './red.js';
import './blue.js';
import './green.js';
import './purple.js';
import './gold.js';
import './grey.js';
import './golems.js';

import { validateGate } from '../gates.js';
import { validateCost } from '../costs.js';
import { validateObjective } from '../objectives.js';
import { validateFinds } from '../learn.js';

/**
 * Validate gates, costs and VP formulas AFTER every card is registered.
 *
 * Not inside makeDef, deliberately. The gate and cost registries sit downstream
 * of ops and triggers, which import each other, and calling into them while the
 * school files are still being evaluated means depending on module
 * initialisation order for correctness. Running the pass once, here, is the same
 * check with none of that fragility.
 *
 * It THROWS. A gate referring to a counter that does not exist reads
 * `undefined >= 3` -- false, forever, silently -- and every gold face behind it
 * would be permanently unscoreable while the card still looked implemented.
 */
export function validateCorpus() {
  for (const d of allCards()) {
    for (const f of d.faces) {
      validateGate(d.id, f.numeral, f.gate);
      validateCost(d.id, f.numeral, f.cost);
      validateObjective(d.id, f.numeral, f.objective);
      if (f.objective?.gate) validateGate(d.id, f.numeral, f.objective.gate);
    }
  }
  validateFinds(allCards());
  return true;
}
validateCorpus();

export { CARDS, allCards, bySchool, byKind, inertReport };

/**
 * THE STANDARD DECK: ten spells, the same for both players, every match.
 *
 * The Spellbook is a record of the WAYS to get cards, not an inventory -- it is
 * accumulated game knowledge. So your starting deck never grows. What a long
 * Spellbook buys you is knowing which conditions find which cards, and being
 * able to aim a match at them.
 *
 * One of each school plus an artifact and a golem, so every cell on the table
 * is reachable from the opening hand and no school is dead on turn one. The
 * duplicate Change and Ember Lash are deliberate: a ten-card deck with ten
 * unique cards draws like a toolbox, and you want at least one card you expect
 * to see twice.
 */
export const STANDARD_DECK = Object.freeze([
  'EMBER_LASH', 'EMBER_LASH',
  'SHOVE',
  'CHANGE', 'CHANGE',
  'FUSE',
  'TALLY', 'RECKONING',
  'FOCUS_STONE',
  'CLAY_HAND',
]);

/** Everything that can be FOUND mid-match, with the condition that finds it. */
export const FINDABLE = Object.freeze(
  allCards().filter((d) => d.found).map((d) => ({ id: d.id, found: d.found })),
);

/**
 * A random legal ten-card deck drawn from the whole corpus.
 *
 * For harnesses and for the AI's practice games, not for a real match -- a real
 * match always uses STANDARD_DECK, because the Spellbook replaced deckbuilding
 * with knowledge rather than with a collection.
 *
 * It takes one card from each school first and fills the rest at random. A deck
 * missing a school is not merely weak: that school's home cell is unreachable,
 * so a whole quarter of the board never gets tested, and a corpus harness that
 * silently stops exercising purple is worse than no harness.
 */
export function randomDeck(rng, pickFn) {
  const out = [];
  for (const s of ['red', 'blue', 'green', 'purple', 'gold']) out.push(pickFn(rng, bySchool(s)).id);
  out.push(pickFn(rng, byKind('artifact')).id);
  out.push(pickFn(rng, byKind('golem')).id);
  const rest = allCards().filter((d) => d.kind !== 'golem');
  while (out.length < 10) out.push(pickFn(rng, rest).id);
  return out;
}
