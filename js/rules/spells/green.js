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
  runes: [SPIRAL, SPIRAL, SPIRAL, LATTICE],
  found: 'turnFive',
  I:   { text: 'Rotate a Spell to any side. Trigger no effects from it.', ...M.setSideFreely() },
  II:  { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  III: { text: 'Shift a Spell you control to an adjacent cell.', ...M.shiftASpell() },
  IV:  { text: 'Draw a card.', ...M.drawCards({ n: 1 }) },
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
  runes: [SPIRAL, LATTICE, SPIRAL, LATTICE],
  found: 'rewindOnce',
  I:   { text: 'Rotate a Spell you control right.', ...M.turnASpell({ dir: 'right' }) },
  II:  { text: 'Resolve the I of a friendly Spell, regardless of orientation.', ...M.rewind({ index: 0 }) },
  III: { text: 'Rotate this Spell right.', ...M.turnSelf({ dir: 'right' }) },
  IV:  { text: 'Draw a card.', ...M.drawCards({ n: 1 }) },
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
  IV:  { text: 'Draw a card.', ...M.drawCards({ n: 1 }) },
});
