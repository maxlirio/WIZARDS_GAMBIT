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
  runes: [LATTICE, LATTICE, SPIRAL, LATTICE],
  found: null,
  I:   { text: 'Your range is increased by 1m.', ...M.passiveRange({ mm: 1000 }) },
  II:  { text: 'Draw a card.', ...M.drawCards({ n: 1 }) },
  III: { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  IV:  { text: 'Your damage is increased by 1.', ...M.passiveDamage({ n: 1 }) },
});

card({
  id: 'RESONIS_ORB', name: 'Resonis Orb', school: 'grey', kind: 'artifact',
  runes: [SPIRAL, SPIRAL, LATTICE, SPIRAL],
  found: 'wildMatch',
  I:   { text: 'The corners of this Artifact count as any corner.', ...M.passiveWildCorners() },
  II:  { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  III: { text: 'Draw a card.', ...M.drawCards({ n: 1 }) },
  IV:  { text: 'This Artifact may be rotated on any colour.', ...M.passiveFreeTurn() },
});

card({
  id: 'DEFRINOL_ORB', name: 'Defrinol Orb', school: 'grey', kind: 'artifact',
  runes: [SPIRAL, SPIRAL, SPIRAL, LATTICE],
  found: 'longChain',
  I:   { text: 'After this Artifact is rotated, rotate a Spell you control left.', ...M.onRotatedRotate() },
  II:  { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  III: { text: 'Shift a Spell you control to an adjacent cell.', ...M.shiftASpell() },
  IV:  { text: 'Draw a card.', ...M.drawCards({ n: 1 }) },
});

card({
  id: 'WARD_LANTERN', name: 'Ward Lantern', school: 'grey', kind: 'artifact',
  runes: [LATTICE, LATTICE, LATTICE, SHARD],
  found: 'warded',
  I:   { text: 'Your opponent may not choose your Spells.', ...M.passiveWard() },
  II:  { text: 'Your units take 1 less damage.', ...M.passiveShield({ n: 1 }) },
  III: { text: 'Draw a card.', ...M.drawCards({ n: 1 }) },
  IV:  { text: 'Deal 1 damage to a unit within 3m.', ...M.damage({ amount: 1, range: 3000 }) },
});

card({
  id: 'ECHO_BELL', name: 'Echo Bell', school: 'grey', kind: 'artifact',
  runes: [SHARD, LATTICE, SPIRAL, LATTICE],
  found: 'echoes',
  I:   { text: 'After a match on your table, deal 1 damage within 3m.', ...M.onMatchDamage({ amount: 1, range: 3000 }) },
  II:  { text: 'After you kill a unit, draw a card.', ...M.onKillDraw({ n: 1 }) },
  III: { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  IV:  { text: 'Draw a card.', ...M.drawCards({ n: 1 }) },
});
