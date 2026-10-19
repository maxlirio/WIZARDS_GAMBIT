// GREEN -- the spell table itself. Home cell 3.
//
// Green is the chain school. It rotates, shifts and raises your own cards, so
// it is the school that MAKES matches rather than exploiting them -- and its
// payoffs move the whole table at once. Time Warp turns every other spell you
// own back a face; Grove Keeper turns them all forward. Either can start a
// chain of a length nothing else in the game reaches, and either can wreck you.

import { card } from './registry.js';
import * as M from '../motifs.js';
import { SPIRAL, SHARD, WHEEL, LATTICE } from '../runes.js';

card({
  id: 'CHANGE', name: 'Change', school: 'green',
  // Adaptation: small adjustments, then two at once.
  keywords: ['Inevitable'],
  runes: [SPIRAL, SPIRAL, SHARD, SPIRAL],
  found: null,
  I:   { text: 'Shift a Spell you control to an adjacent cell.', ...M.shiftASpell() },
  II:  { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  III: { text: 'Destroy a Spell you control. Draw a card.', ...M.destroyASpell({ side: 'friendly', then: 'draw' }) },
  IV:  { text: 'Rotate up to two Spells you control left, one after the other.', ...M.turnSeveral({ n: 2, dir: 'left' }) },
});

card({
  id: 'PRECISION', name: 'Precision', school: 'green',
  // Exactness: at the end, any card turned to any face, without consequence.
  runes: [SPIRAL, SPIRAL, SHARD, SPIRAL],
  found: 'turnFive',
  I:   { text: 'Rotate a Spell you control right.', ...M.turnASpell({ dir: 'right' }) },
  II:  { text: 'Shift a Spell you control to an adjacent cell.', ...M.shiftASpell() },
  III: { text: 'Discard a card. Destroy an enemy Spell.',
         cost: [{ id: 'discard', n: 1 }], ...M.destroyASpell({ side: 'enemy' }) },
  IV:  { text: 'Rotate a Spell to any side. Trigger no effects from it.', ...M.setSideFreely() },
});

card({
  id: 'SPELL_DRAIN', name: 'Spell Drain', school: 'green',
  // Eat your own table for cards.
  runes: [SPIRAL, SHARD, SPIRAL, LATTICE],
  found: 'drainTwo',
  I:   { text: 'Shift this Spell to an adjacent cell.', ...M.shiftSelf() },
  II:  { text: 'Destroy a Spell you control. Draw a card.', ...M.destroyASpell({ side: 'friendly', then: 'draw' }) },
  III: { text: 'If the cell above is occupied, rotate a Spell left.',
         gate: { id: 'neighbourFilled', where: 'above' }, ...M.turnASpell({ dir: 'left' }) },
  IV:  { text: 'Destroy a Spell you control. Draw 3 cards.',
         cost: [{ id: 'destroyFriendly', n: 1 }], ...M.drawCards({ n: 3 }) },
});

card({
  id: 'REWIND', name: 'Time Warp', school: 'green',
  // Turn the clock back. The payoff turns every other spell you own back a face.
  runes: [SPIRAL, LATTICE, LATTICE, SPIRAL],
  found: 'rewindOnce',
  I:   { text: 'Rotate a Spell you control right.', ...M.turnASpell({ dir: 'right' }) },
  II:  { text: 'Return a card from your discard to your hand.', ...M.recall() },
  III: { text: 'Destroy a Spell you control. Resolve the I of a friendly Spell, regardless of orientation.',
         cost: [{ id: 'destroyFriendly', n: 1 }], ...M.rewind({ index: 0 }) },
  IV:  { text: 'Rotate each of your other Spells right.', ...M.turnAll({ dir: 'right' }) },
});

card({
  id: 'GROVE_KEEPER', name: 'Grove Keeper', school: 'green',
  // Growth. The payoff is spring: every other spell you own turns forward at once.
  runes: [SPIRAL, SPIRAL, LATTICE, SPIRAL],
  found: 'offColour',
  I:   { text: 'This Spell may be rotated on any colour.', ...M.passiveFreeTurn() },
  II:  { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  III: { text: 'Your mage regains 1 life.', ...M.mend({ n: 1 }) },
  IV:  { text: 'Rotate each of your other Spells left.', ...M.turnAll({ dir: 'left' }) },
});

card({
  id: 'SEED_OF_ORDER', name: 'Seed of Order', school: 'green',
  // Discipline, spread to everything you control.
  runes: [LATTICE, SPIRAL, SPIRAL, LATTICE],
  found: 'tableFull',
  I:   { text: 'Your range is increased by 1m.', ...M.passiveRange({ mm: 1000 }) },
  II:  { text: 'Shift a Spell you control to an adjacent cell.', ...M.shiftASpell() },
  III: { text: 'Discard a card. Grant a Spell [Spell Mastery].',
         cost: [{ id: 'discard', n: 1 }], ...M.grantKeyword({ kw: 'Spell Mastery' }) },
  IV:  { text: 'Every Spell you control gains [Spell Mastery].', ...M.grantAll({ kw: 'Spell Mastery' }) },
});

card({
  id: 'UNRAVEL', name: 'Unravel', school: 'green',
  // Pulling the enemy's magic apart, thread by thread, then all at once.
  keywords: ['Spell Bane'],
  runes: [LATTICE, SPIRAL, SPIRAL, SHARD],
  found: 'banedThem',
  I:   { text: 'Spells either side of this one lose their Keywords.', ...M.passiveSilence() },
  II:  { text: 'Hex an enemy Spell: it may not rotate until after its owner’s next turn.', ...M.hexSpell() },
  III: { text: 'Discard a card. Rotate a Spell left.',
         cost: [{ id: 'discard', n: 1 }], ...M.turnASpell({ dir: 'left' }) },
  IV:  { text: 'Destroy an enemy Spell.', ...M.destroyASpell({ side: 'enemy' }) },
});

card({
  id: 'WEAVER', name: 'Weaver', school: 'green',
  // Threads of fate: draw deep, keep the best.
  runes: [SPIRAL, SPIRAL, LATTICE, LATTICE],
  found: 'woven',
  I:   { text: 'Draw a card, then discard a card.', ...M.drawThenDiscard({ draw: 1, discard: 1 }) },
  II:  { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  III: { text: 'Rotate another Spell you control left. Draw 2 cards.',
         cost: [{ id: 'rotateFriendly' }], ...M.drawCards({ n: 2 }) },
  IV:  { text: 'Draw 3 cards, then discard a card.', ...M.drawThenDiscard({ draw: 3, discard: 1 }) },
});

card({
  id: 'SPIRE_WARD', name: 'Spire Ward', school: 'green',
  // A tower around your table. At the top, nothing of yours can be touched.
  runes: [SPIRAL, SHARD, SPIRAL, LATTICE],
  found: 'spired',
  I:   { text: 'This Spell may be rotated on any colour.', ...M.passiveFreeTurn() },
  II:  { text: 'Destroy a Spell you control. Draw a card.', ...M.destroyASpell({ side: 'friendly', then: 'draw' }) },
  III: { text: 'If you control 4 Spells, destroy an enemy Spell.',
         gate: { id: 'spellsAtLeast', n: 4 }, ...M.destroyASpell({ side: 'enemy' }) },
  IV:  { text: 'Your opponent may not choose your Spells.', ...M.passiveWard() },
});

card({
  id: 'HOLLOW_RITE', name: 'Hollow Rite', school: 'green',
  // A rite over the dead. The last face raises a destroyed spell back onto the table.
  runes: [LATTICE, SPIRAL, LATTICE, LATTICE],
  found: 'hollowed',
  I:   { text: 'After one of your Spells is destroyed, draw a card.', ...M.onDestroyedDraw({ n: 1 }) },
  II:  { text: 'Put the top 2 cards of your deck into your discard. Draw a card.',
         cost: [{ id: 'millSelf', n: 2 }], ...M.drawCards({ n: 1 }) },
  III: { text: 'If you control 2 or fewer Spells, draw 2 cards.',
         gate: { id: 'spellsAtMost', n: 2 }, ...M.drawCards({ n: 2 }) },
  IV:  { text: 'Return a Spell from your discard to an empty cell of its colour.', ...M.reanimate() },
});
