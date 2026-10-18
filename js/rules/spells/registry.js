// The card registry. Separate from index.js on purpose: the school files call
// `card()`, index.js imports the school files, and if the registry lived in
// index.js that cycle would touch `CARDS` before its `const` was initialised.

import { makeDef, inertFaces } from '../schema.js';

export const CARDS = Object.create(null);

export function card(spec) {
  const def = makeDef(spec);
  if (CARDS[def.id]) throw new Error(`duplicate card id '${def.id}'`);
  CARDS[def.id] = def;
  return def;
}

/** Every registered card, in id order. Sorted at every site -- lockstep. */
export const allCards = () => Object.keys(CARDS).sort().map((k) => CARDS[k]);

export const bySchool = (school) => allCards().filter((d) => d.school === school);
export const byKind = (kind) => allCards().filter((d) => d.kind === kind);

/** { cardId: ['II', 'IV'] } for every card with an unimplemented face. */
export function inertReport() {
  const out = {};
  for (const d of allCards()) {
    const inert = inertFaces(d);
    if (inert.length) out[d.id] = inert;
  }
  return out;
}
