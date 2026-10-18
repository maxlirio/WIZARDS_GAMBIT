// PURPLE -- combining Keywords. Home cell 4, the centre.
//
// Purple reads the keyword set as INPUT rather than modifying it: scale by
// distinct keyword count, fuse a neighbour's keywords onto a card, resolve
// somebody else's face with your keywords attached. Printed Spell Splice is the
// archetype and it is the one face that does not need to know what it is
// resolving.
//
// The board hands this school its identity for free. The centre cell is the only
// one touching all four INTERIOR (four-card) vertices and no two-card vertex, so
// purple can only ever match into a crowd. It is combo-only by geometry rather
// than by anybody deciding it should be.

import { card } from './registry.js';
import * as M from '../motifs.js';
import { SPIRAL, SHARD, WHEEL, LATTICE } from '../runes.js';

card({
  id: 'FUSE', name: 'Fuse', school: 'purple',
  runes: [LATTICE, LATTICE, SPIRAL, SPIRAL],
  found: null,
  I:   { text: "Resolve a friendly Spell's face, adding adjacent Keywords.", ...M.spliceResolve() },
  II:  { text: 'Grant a Spell [Ignore Height].', ...M.grantKeyword({ kw: 'Ignore Height' }) },
  III: { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  IV:  { text: 'Shift a Spell you control to an adjacent cell.', ...M.shiftASpell() },
});

card({
  id: 'SPELL_SPLICE', name: 'Spell Splice', school: 'purple',
  runes: [LATTICE, LATTICE, LATTICE, SHARD],
  found: 'spliceTwice',
  I:   { text: "Resolve a friendly Spell's face, adding adjacent Keywords.", ...M.spliceResolve() },
  II:  { text: 'Grant a Spell [Crush].', ...M.grantKeyword({ kw: 'Crush' }) },
  III: { text: 'Resolve the I of a friendly Spell, regardless of orientation.', ...M.rewind({ index: 0 }) },
  IV:  { text: 'If this Spell has 2 Keywords, deal 2 damage within 3m.',
         gate: { id: 'keywordsAtLeast', n: 2 }, ...M.damage({ amount: 2, range: 3000 }) },
});

card({
  id: 'LINK', name: 'Link', school: 'purple',
  runes: [LATTICE, LATTICE, LATTICE, SPIRAL],
  found: 'linked',
  I:   { text: 'The Spell left of this has the Keywords of the Spell right of it.', ...M.passiveLink() },
  II:  { text: 'Grant a Spell [Reach].', ...M.grantKeyword({ kw: 'Reach' }) },
  III: { text: "Resolve a friendly Spell's face, adding adjacent Keywords.", ...M.spliceResolve() },
  IV:  { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
});

card({
  id: 'RESONANCE', name: 'Resonance', school: 'purple',
  runes: [SHARD, LATTICE, LATTICE, LATTICE],
  found: 'copyThree',
  I:   { text: '1 damage per Keyword you have copied this duel, up to 4.',
         ...M.damagePerLedger({ key: 'keywordsCopied', per: 1, cap: 4, range: 3500 }) },
  II:  { text: 'Grant a Spell [Impact].', ...M.grantKeyword({ kw: 'Impact' }) },
  III: { text: "Resolve a friendly Spell's face, adding adjacent Keywords.", ...M.spliceResolve() },
  IV:  { text: 'If this Spell has 2 Keywords, draw 2 cards.',
         gate: { id: 'keywordsAtLeast', n: 2 }, ...M.drawCards({ n: 2 }) },
});

card({
  id: 'PRISM', name: 'Prism', school: 'purple',
  runes: [LATTICE, LATTICE, LATTICE, WHEEL],
  found: 'prismatic',
  I:   { text: 'Grant a Spell [Levitate].', ...M.grantKeyword({ kw: 'Levitate' }) },
  II:  { text: 'Grant a Spell [Stun].', ...M.grantKeyword({ kw: 'Stun' }) },
  III: { text: "Resolve a friendly Spell's face, adding adjacent Keywords.", ...M.spliceResolve() },
  IV:  { text: 'If this Spell has [Levitate], push a unit within 3m 3m.',
         gate: { id: 'hasKeyword', kw: 'Levitate' }, ...M.push({ mm: 3000, range: 3000 }) },
});

card({
  id: 'CONFLUENCE', name: 'Confluence', school: 'purple',
  runes: [LATTICE, LATTICE, SPIRAL, LATTICE],
  found: 'threeKeywords',
  I:   { text: "Resolve a friendly Spell's face, adding adjacent Keywords.", ...M.spliceResolve() },
  II:  { text: 'Draw 2 cards, then discard a card.', ...M.drawThenDiscard({ draw: 2, discard: 1 }) },
  III: { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  IV:  { text: 'If this Spell has 3 Keywords, your damage is increased by 1.',
         gate: { id: 'keywordsAtLeast', n: 3 }, ...M.passiveDamage({ n: 1 }) },
});

/* ------------------------------------------------------------ second tranche */

card({
  id: 'KEY_OF_MANY', name: 'Key of Many', school: 'purple',
  keywords: ['Consume'],
  runes: [LATTICE, LATTICE, LATTICE, SPIRAL],
  found: 'consumed',
  // [Consume] turns the cost into a second draw, which is the keyword funnel
  // doing its job: the face says nothing about Consume and never will.
  I:   { text: 'Destroy a Spell you control. Draw a card.',
         cost: [{ id: 'destroyFriendly', n: 1 }], ...M.drawCards({ n: 1 }) },
  II:  { text: 'Grant a Spell [Consume].', ...M.grantKeyword({ kw: 'Consume' }) },
  III: { text: "Resolve a friendly Spell's face, adding adjacent Keywords.", ...M.spliceResolve() },
  IV:  { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
});

card({
  id: 'CHORUS', name: 'Chorus', school: 'purple',
  runes: [LATTICE, SHARD, LATTICE, LATTICE],
  found: 'chorused',
  I:   { text: 'At the end of one of your chains of 2 or more, draw a card.',
         ...M.onChainEndDraw({ n: 1, minLinks: 2 }) },
  // The only gate that reads the chain you are standing in the middle of, which
  // makes it the one face that is worth more the deeper a chain has gone.
  II:  { text: 'If this chain has resolved 3 links, deal 3 damage within 4m.',
         gate: { id: 'chainAtLeast', n: 3 }, ...M.damage({ amount: 3, range: 4000 }) },
  III: { text: "Resolve a friendly Spell's face, adding adjacent Keywords.", ...M.spliceResolve() },
  IV:  { text: 'If you have 4 cards in hand, grant a Spell [Reach].',
         gate: { id: 'handAtLeast', n: 4 }, ...M.grantKeyword({ kw: 'Reach' }) },
});
