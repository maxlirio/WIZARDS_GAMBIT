// GREEN -- the spell table itself. Home cell 3.
//
// Green is the chain school. It rotates, shifts and destroys your own cards,
// which means it is the school that MAKES matches rather than exploiting them,
// and the school most able to hurt itself: every rotation it hands out is a
// rotation a chain can turn against you.

import { card } from './registry.js';
import * as M from '../motifs.js';
import { SPIRAL, SHARD, WHEEL, LATTICE } from '../runes.js';

card({
  id: 'CHANGE', name: 'Change', school: 'green',
  keywords: ['Inevitable'],
  runes: [SPIRAL, SPIRAL, SHARD, SPIRAL],
  found: null,
  I:   { text: 'Shift a Spell you control to an adjacent cell.', ...M.shiftASpell() },
  II:  { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  III: { text: 'Destroy a Spell you control.', ...M.destroyASpell({ side: 'friendly' }) },
  IV:  { text: 'Rotate a Spell you control right.', ...M.turnASpell({ dir: 'right' }) },
});

card({
  id: 'PRECISION', name: 'Precision', school: 'green',
  runes: [SPIRAL, SPIRAL, SPIRAL, SHARD],
  found: 'turnFive',
  I:   { text: 'Rotate a Spell to any side. Trigger no effects from it.', ...M.setSideFreely() },
  II:  { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  III: { text: 'Shift a Spell you control to an adjacent cell.', ...M.shiftASpell() },
  IV:  { text: 'Destroy a Spell you control. Draw a card.', ...M.destroyASpell({ side: 'friendly', then: 'draw' }) },
});

card({
  id: 'SPELL_DRAIN', name: 'Spell Drain', school: 'green',
  runes: [SHARD, SPIRAL, LATTICE, SPIRAL],
  found: 'drainTwo',
  I:   { text: 'Destroy a Spell you control. Draw a card.', ...M.destroyASpell({ side: 'friendly', then: 'draw' }) },
  II:  { text: 'If the cell above is occupied, rotate a Spell left.',
         gate: { id: 'neighbourFilled', where: 'above' }, ...M.turnASpell({ dir: 'left' }) },
  III: { text: 'Destroy a Spell you control. Draw 2 cards.',
         cost: [{ id: 'destroyFriendly', n: 1 }], ...M.drawCards({ n: 2 }) },
  IV:  { text: 'Shift this Spell to an adjacent cell.', ...M.shiftSelf() },
});

card({
  id: 'REWIND', name: 'Rewind', school: 'green',
  runes: [SPIRAL, LATTICE, SPIRAL, SPIRAL],
  found: 'rewindOnce',
  I:   { text: 'Rotate a Spell you control right.', ...M.turnASpell({ dir: 'right' }) },
  II:  { text: 'Resolve the I of a friendly Spell, regardless of orientation.', ...M.rewind({ index: 0 }) },
  III: { text: 'Rotate this Spell right.', ...M.turnSelf({ dir: 'right' }) },
  IV:  { text: 'Shift this Spell to an adjacent cell.', ...M.shiftSelf() },
});

card({
  id: 'GROVE_KEEPER', name: 'Grove Keeper', school: 'green',
  runes: [SPIRAL, SPIRAL, SPIRAL, SHARD],
  found: 'offColour',
  I:   { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  II:  { text: 'This Spell may be rotated on any colour.', ...M.passiveFreeTurn() },
  III: { text: 'Shift a Spell you control to an adjacent cell.', ...M.shiftASpell() },
  IV:  { text: 'Destroy a Spell you control. Draw a card.', ...M.destroyASpell({ side: 'friendly', then: 'draw' }) },
});

card({
  id: 'SEED_OF_ORDER', name: 'Seed of Order', school: 'green',
  runes: [SPIRAL, SPIRAL, LATTICE, LATTICE],
  found: 'tableFull',
  I:   { text: 'Shift a Spell you control to an adjacent cell.', ...M.shiftASpell() },
  II:  { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  III: { text: 'Grant a Spell [Spell Mastery].', ...M.grantKeyword({ kw: 'Spell Mastery' }) },
  IV:  { text: 'Your range is increased by 1m.', ...M.passiveRange({ mm: 1000 }) },
});

card({
  id: 'UNRAVEL', name: 'Unravel', school: 'green',
  keywords: ['Spell Bane'],
  runes: [SHARD, SPIRAL, SPIRAL, LATTICE],
  found: 'banedThem',
  I:   { text: 'Destroy a Spell.', ...M.destroyASpell({ side: 'friendly' }) },
  II:  { text: 'Rotate a Spell left.', ...M.turnASpell({ dir: 'left' }) },
  III: { text: 'Shift a Spell to an adjacent cell.', ...M.shiftASpell() },
  IV:  { text: 'Spells either side of this one lose their Keywords.', ...M.passiveSilence() },
});

/* ------------------------------------------------------------ second tranche */

card({
  id: 'WEAVER', name: 'Weaver', school: 'green',
  runes: [LATTICE, SPIRAL, SPIRAL, SPIRAL],
  found: 'woven',
  // Paying with a rotation is green paying in its own currency -- and the
  // rotation it costs you can start a chain of its own.
  I:   { text: 'Rotate another Spell you control left. Draw 2 cards.',
         cost: [{ id: 'rotateFriendly' }], ...M.drawCards({ n: 2 }) },
  II:  { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  III: { text: 'Shift a Spell you control to an adjacent cell.', ...M.shiftASpell() },
  IV:  { text: 'Rotate a Spell to any side. Trigger no effects from it.', ...M.setSideFreely() },
});

card({
  id: 'SPIRE_WARD', name: 'Spire Ward', school: 'green',
  runes: [SPIRAL, SHARD, SPIRAL, SPIRAL],
  found: 'spired',
  I:   { text: 'If you control 4 Spells, rotate a Spell you control left.',
         gate: { id: 'spellsAtLeast', n: 4 }, ...M.turnASpell({ dir: 'left' }) },
  II:  { text: 'Destroy a Spell you control. Draw a card.', ...M.destroyASpell({ side: 'friendly', then: 'draw' }) },
  III: { text: 'Rotate this Spell left.', ...M.turnSelf({ dir: 'left' }) },
  IV:  { text: 'This Spell may be rotated on any colour.', ...M.passiveFreeTurn() },
});

card({
  id: 'HOLLOW_RITE', name: 'Hollow Rite', school: 'green',
  runes: [LATTICE, LATTICE, SHARD, SPIRAL],
  found: 'hollowed',
  I:   { text: 'After one of your Spells is destroyed, draw a card.', ...M.onDestroyedDraw({ n: 1 }) },
  // The one gate that rewards an EMPTY table, which is a real position: every
  // good face eats a friendly spell, so running on fumes happens by itself.
  II:  { text: 'If you control 2 or fewer Spells, draw 2 cards.',
         gate: { id: 'spellsAtMost', n: 2 }, ...M.drawCards({ n: 2 }) },
  III: { text: 'Put the top 2 cards of your deck into your discard. Destroy a Spell you control.',
         cost: [{ id: 'millSelf', n: 2 }], ...M.destroyASpell({ side: 'friendly' }) },
  IV:  { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
});
