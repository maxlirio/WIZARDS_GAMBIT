// GREY -- artifacts. The four corner cells.
//
// An artifact is a spell in every mechanical sense: four faces, four corner
// runes, it rotates, it matches and it chains. What makes it different is where
// it lives. A grey corner touches ONE interior vertex, two edge vertices and one
// dead outer corner, so an artifact is the cheapest way to reach a four-card
// junction without spending the centre -- and the only card that can be placed
// in four different places.

import { card } from './registry.js';
import * as M from '../motifs.js';
import { SPIRAL, SHARD, WHEEL, LATTICE } from '../runes.js';

card({
  id: 'FOCUS_STONE', name: 'Focus Stone', school: 'grey', kind: 'artifact',
  runes: [LATTICE, WHEEL, SPIRAL, LATTICE],
  sigil: null,
  I:   { text: 'Your range is increased by 1m.', ...M.passiveRange({ mm: 1000 }) },
  II:  { text: 'Your units move 1m further.', ...M.passiveUnitMove({ mm: 1000 }) },
  III: { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  IV:  { text: 'Your damage is increased by 1.', ...M.passiveDamage({ n: 1 }) },
});

card({
  id: 'RESONIS_ORB', name: 'Resonis Orb', school: 'grey', kind: 'artifact',
  runes: [SPIRAL, SPIRAL, SHARD, SPIRAL],
  sigil: ['SSH', '.S.'],
  I:   { text: 'The corners of this Artifact count as any corner.', ...M.passiveWildCorners() },
  II:  { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  III: { text: 'Deal 1 damage to an enemy unit within 3m.', ...M.damage({ amount: 1, range: 3000 }) },
  IV:  { text: 'This Artifact may be rotated on any colour.', ...M.passiveFreeTurn() },
});

card({
  id: 'DEFRINOL_ORB', name: 'Defrinol Orb', school: 'grey', kind: 'artifact',
  runes: [SPIRAL, SPIRAL, SPIRAL, SHARD],
  sigil: ['.H', '.H', 'SS'],
  I:   { text: 'After this Artifact is rotated, rotate a Spell you control left.', ...M.onRotatedRotate() },
  II:  { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  III: { text: 'Shift a Spell you control to an adjacent cell.', ...M.shiftASpell() },
  IV:  { text: 'Destroy a Spell you control. Draw a card.', ...M.destroyASpell({ side: 'friendly', then: 'draw' }) },
});

card({
  id: 'WARD_LANTERN', name: 'Ward Lantern', school: 'grey', kind: 'artifact',
  runes: [LATTICE, LATTICE, LATTICE, SHARD],
  sigil: ['LL', 'LH'],
  I:   { text: 'Your opponent may not choose your Spells.', ...M.passiveWard() },
  II:  { text: 'Your mage has +2 life.', ...M.passiveMageLife({ n: 2 }) },
  III: { text: 'Draw a card.', ...M.drawCards({ n: 1 }) },
  IV:  { text: 'Deal 1 damage to an enemy unit within 3m.', ...M.damage({ amount: 1, range: 3000 }) },
});

card({
  id: 'ECHO_BELL', name: 'Echo Bell', school: 'grey', kind: 'artifact',
  runes: [SHARD, LATTICE, SPIRAL, SPIRAL],
  sigil: ['SH', 'LS'],
  I:   { text: 'After a match on your table, deal 1 damage within 3m.', ...M.onMatchDamage({ amount: 1, range: 3000 }) },
  II:  { text: 'After you kill a unit, draw a card.', ...M.onKillDraw({ n: 1 }) },
  III: { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  IV:  { text: 'Rotate this Spell left.', ...M.turnSelf({ dir: 'left' }) },
});

card({
  id: 'KEYSTONE', name: 'Keystone', school: 'grey', kind: 'artifact',
  runes: [SPIRAL, LATTICE, SPIRAL, SPIRAL],
  sigil: ['L.', 'SS', '.S'],
  // Side I makes every corner of this card read the same, so the junctions it
  // touches match whatever is beside them and KEEP matching through a rotation.
  // That is the one-rune-card pathology, printed on purpose: the chain's vertex
  // bound contains it (each junction resonates once), so what you get is a
  // corner of the table that reliably goes off rather than an infinite loop.
  I:   { text: 'Every corner of this Artifact counts as a Spiral.', ...M.passiveRuneSeal({ rune: SPIRAL }) },
  II:  { text: 'Draw a card.', ...M.drawCards({ n: 1 }) },
  III: { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  IV:  { text: 'Shift a Spell you control to an adjacent cell.', ...M.shiftASpell() },
});

card({
  id: 'SEALSTONE', name: 'Sealstone', school: 'grey', kind: 'artifact',
  runes: [LATTICE, SPIRAL, SHARD, SPIRAL],
  sigil: ['.H', 'SS', '.L'],
  I:   { text: 'Your opponent may not choose your Spells.', ...M.passiveWard() },
  II:  { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  III: { text: 'Destroy a Spell you control. Draw a card.', ...M.destroyASpell({ side: 'friendly', then: 'draw' }) },
  // A PROHIBITION rather than a gate, and it is permanent: rotate onto this face
  // and the card is anchored there for the rest of the duel, immune even to a
  // match. Its corners never change again, which is either a reliable junction
  // or a dead one depending on what you parked it beside.
  //
  // On IV rather than III on purpose. A card lands showing I and a match rotates
  // LEFT, so a lock on III would make IV unreachable by any ordinary means --
  // and a 400-game sweep duly reported SEALSTONE:IV as the one face in the
  // whole corpus that never resolved once. On IV, the lock is where the card
  // ENDS UP.
  IV:  { text: 'This Artifact may not be rotated.', ...M.passiveLocked() },
});

card({
  id: 'TITHE_BELL', name: 'Tithe Bell', school: 'grey', kind: 'artifact',
  runes: [LATTICE, LATTICE, SPIRAL, WHEEL],
  sigil: ['SS', 'LW'],
  I:   { text: 'Grant a Spell [Unstable].', ...M.grantKeyword({ kw: 'Unstable' }) },
  II:  { text: 'If you have 3 units on the battlefield, your damage is increased by 1.',
         gate: { id: 'unitsAtLeast', n: 3 }, ...M.passiveDamage({ n: 1 }) },
  III: { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  IV:  { text: 'Relocate a friendly unit up to 3m.', ...M.relocate({ mm: 3000, range: 4000 }) },
});

card({
  id: 'AEGIS_SIGIL', name: 'Aegis Sigil', school: 'grey', kind: 'artifact',
  runes: [LATTICE, LATTICE, SPIRAL, WHEEL],
  sigil: ['W..', 'WLS'],
  // The only REPLACEMENT effect in the corpus. It intercepts damage before it
  // lands rather than reacting to it afterwards, which is why it has to be a
  // pure function: it runs inside `hurt`, where the board is mid-mutation.
  //
  // And it is a genuine trade, not a shield: your mage keeps its hit points and
  // its range, and the golem that ate the blow is one death from taking its
  // card with it.
  I:   { text: 'Damage to your mage is dealt to a friendly golem unit instead.', ...M.replaceMageDamage() },
  II:  { text: 'Your units take 1 less damage.', ...M.passiveShield({ n: 1 }) },
  III: { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  IV:  { text: 'Push an enemy unit within 3m away with force 3.', ...M.pushAway({ force: 3, range: 3000 }) },
});

card({
  id: 'ANCHOR_STONE', name: 'Anchor Stone', school: 'grey', kind: 'artifact',
  // A weight on a chain in a corner of the table: it hardens your units,
  // hauls an enemy in, and heaves everything back out.
  runes: [LATTICE, WHEEL, SPIRAL, WHEEL],
  sigil: ['.L', '.L', 'SW'],
  I:   { text: 'Your units take 1 less damage, to a minimum of 1.', ...M.passiveShield({ n: 1 }) },
  II:  { text: 'Pull an enemy unit within 3m toward you with force 2.', ...M.pull({ force: 2, range: 3000 }) },
  III: { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  IV:  { text: 'Push everything within 2m away from your mage with force 2.', ...M.repel({ force: 2, range: 2000, side: 'anything' }) },
});
