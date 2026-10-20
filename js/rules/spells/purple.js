// PURPLE -- combining Keywords. Home cell 4, the centre.
//
// Purple reads the keyword set as INPUT rather than modifying it: fuse a
// neighbour's keywords onto a card, resolve somebody else's face with your
// keywords attached, scale damage by how many keywords your table holds. Its
// payoffs resolve OTHER cards -- two at once, all of them, or another card's
// own side IV -- so a purple card is only ever as strong as the table around it.
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
  // Two spells cast as one.
  runes: [SPIRAL, SPIRAL, LATTICE, LATTICE],
  sigil: null,
  I:   { text: 'Grant a Spell [Ignore Height].', ...M.grantKeyword({ kw: 'Ignore Height' }) },
  II:  { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  III: { text: "Discard a card. Resolve a friendly Spell's face, adding adjacent Keywords.",
         cost: [{ id: 'discard', n: 1 }], ...M.spliceResolve() },
  IV:  { text: "Resolve two friendly Spells' faces, adding adjacent Keywords to each.", ...M.spliceMany({ n: 2 }) },
});

card({
  id: 'SPELL_SPLICE', name: 'Spell Splice', school: 'purple',
  // Cut a spell open and use its heart. The payoff fires another card's side IV
  // without that card having to get there.
  runes: [LATTICE, SPIRAL, SHARD, LATTICE],
  sigil: ['LS', 'LH'],
  I:   { text: 'Grant a Spell [Crush].', ...M.grantKeyword({ kw: 'Crush' }) },
  II:  { text: "Destroy a Spell you control. Resolve a friendly Spell's face, adding adjacent Keywords.",
         cost: [{ id: 'destroyFriendly', n: 1 }], ...M.spliceResolve() },
  III: { text: 'If this Spell has 2 Keywords, deal 2 damage within 3m.',
         gate: { id: 'keywordsAtLeast', n: 2 }, ...M.damage({ amount: 2, range: 3000 }) },
  IV:  { text: 'Resolve the IV of a friendly Spell, regardless of orientation.', ...M.rewind({ index: 3 }) },
});

card({
  id: 'LINK', name: 'Link', school: 'purple',
  // A chain between cards; at the end every keyword you own flows into one.
  runes: [LATTICE, SPIRAL, LATTICE, LATTICE],
  sigil: ['.L.', 'LSL'],
  I:   { text: 'The Spell left of this has the Keywords of the Spell right of it.', ...M.passiveLink() },
  II:  { text: 'Grant a Spell [Reach].', ...M.grantKeyword({ kw: 'Reach' }) },
  III: { text: "Discard a card. Resolve a friendly Spell's face, adding adjacent Keywords.",
         cost: [{ id: 'discard', n: 1 }], ...M.spliceResolve() },
  IV:  { text: 'Gather every Keyword on your table onto one Spell you control.', ...M.gatherKeywords() },
});

card({
  id: 'RESONANCE', name: 'Resonance', school: 'purple',
  // Every keyword on your table hums at once.
  runes: [WHEEL, SHARD, LATTICE, SHARD],
  sigil: ['WHH', 'L..'],
  I:   { text: 'Grant a Spell [Impact].', ...M.grantKeyword({ kw: 'Impact' }) },
  II:  { text: '1 damage per Keyword that has resonated onto your Spells this duel, up to 3.',
         ...M.damagePerLedger({ key: 'keywordsCopied', per: 1, cap: 3, range: 3500 }) },
  III: { text: "Discard a card. Resolve a friendly Spell's face, adding adjacent Keywords.",
         cost: [{ id: 'discard', n: 1 }], ...M.spliceResolve() },
  IV:  { text: 'An enemy unit within 4m takes 1 damage per Keyword on your table, up to 5.',
         ...M.keywordBolt({ per: 1, cap: 5, range: 4000 }) },
});

card({
  id: 'PRISM', name: 'Prism', school: 'purple',
  // Light split many ways: this card's keywords, given to every card you own.
  runes: [SPIRAL, LATTICE, LATTICE, LATTICE],
  sigil: ['..S', 'LLL'],
  I:   { text: 'Grant a Spell [Levitate].', ...M.grantKeyword({ kw: 'Levitate' }) },
  II:  { text: 'Grant a Spell [Stun].', ...M.grantKeyword({ kw: 'Stun' }) },
  III: { text: "Rotate another Spell you control left. Resolve a friendly Spell's face, adding adjacent Keywords.",
         cost: [{ id: 'rotateFriendly' }], ...M.spliceResolve() },
  IV:  { text: "Every other Spell you control gains this Spell's Keywords.", ...M.spreadKeywords() },
});

card({
  id: 'CONFLUENCE', name: 'Confluence', school: 'purple',
  // Every stream at once. The payoff resolves the face showing on every other
  // spell you own, in cell order -- the biggest single effect in the game, and
  // as dangerous as your table is careless.
  runes: [SPIRAL, SPIRAL, LATTICE, LATTICE],
  sigil: ['S', 'S', 'L', 'L'],
  I:   { text: 'Draw 2 cards, then discard a card.', ...M.drawThenDiscard({ draw: 2, discard: 1 }) },
  II:  { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  III: { text: "Destroy a Spell you control. Resolve a friendly Spell's face, adding adjacent Keywords.",
         cost: [{ id: 'destroyFriendly', n: 1 }], ...M.spliceResolve() },
  IV:  { text: 'Resolve the face of each other Spell you control.', ...M.resolveAll() },
});

card({
  id: 'KEY_OF_MANY', name: 'Key of Many', school: 'purple',
  // A key that fits every lock: at the end, any keyword in the game.
  keywords: ['Consume'],
  runes: [LATTICE, SPIRAL, SPIRAL, LATTICE],
  sigil: ['.L', 'SS', 'L.'],
  I:   { text: 'Grant a Spell [Consume].', ...M.grantKeyword({ kw: 'Consume' }) },
  II:  { text: 'Destroy a Spell you control. Draw a card.',
         cost: [{ id: 'destroyFriendly', n: 1 }], ...M.drawCards({ n: 1 }) },
  III: { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  IV:  { text: 'Choose any Keyword. Give it to a Spell you control.', ...M.grantChosen() },
});

card({
  id: 'CHORUS', name: 'Chorus', school: 'purple',
  // Many voices; the last note lands only at the end of a long chain.
  runes: [LATTICE, SPIRAL, LATTICE, SHARD],
  sigil: ['L.', 'LL', 'H.'],
  I:   { text: 'At the end of one of your chains of 2 or more, draw a card.',
         ...M.onChainEndDraw({ n: 1, minLinks: 2 }) },
  II:  { text: 'If you have 4 cards in hand, grant a Spell [Reach].',
         gate: { id: 'handAtLeast', n: 4 }, ...M.grantKeyword({ kw: 'Reach' }) },
  III: { text: "Discard a card. Resolve a friendly Spell's face, adding adjacent Keywords.",
         cost: [{ id: 'discard', n: 1 }], ...M.spliceResolve() },
  IV:  { text: 'If this chain has resolved 3 links, deal 4 damage to an enemy unit within 5m.',
         gate: { id: 'chainAtLeast', n: 3 }, ...M.damage({ amount: 4, range: 5000 }) },
});
