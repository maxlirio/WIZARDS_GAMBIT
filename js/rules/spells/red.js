// RED -- attack. Home cell 1.
//
// Red's job is damage and the threat of it, and its dependency is the mage: most
// red faces measure range from an origin, so a dead mage turns the whole school
// off. That is the pressure that makes feeding your mage to the enemy for 2 VP a
// real decision rather than a free trade.

import { card } from './registry.js';
import * as M from '../motifs.js';
import { SPIRAL, SHARD, WHEEL, LATTICE } from '../runes.js';

card({
  id: 'EMBER_LASH', name: 'Ember Lash', school: 'red',
  runes: [SHARD, SHARD, WHEEL, LATTICE],
  found: null,
  I:   { text: 'Deal 2 damage to an enemy unit within 3m.', ...M.damage({ amount: 2, range: 3000 }) },
  II:  { text: 'Deal 1 damage to each enemy unit within 2.5m.', ...M.damageAll({ amount: 1, range: 2500 }) },
  III: { text: 'Push an enemy unit within 3m 2m away.', ...M.pushAway({ mm: 2000, range: 3000 }) },
  IV:  { text: 'Draw a card.', ...M.drawCards({ n: 1 }) },
});

card({
  id: 'FIREBRAND', name: 'Firebrand', school: 'red',
  keywords: ['Impact'],
  runes: [SHARD, SPIRAL, SHARD, SPIRAL],
  found: 'burnBright',
  I:   { text: 'Destroy a Spell you control. Deal 3 damage within 4m.',
         cost: [{ id: 'destroyFriendly', n: 1 }], ...M.damage({ amount: 3, range: 4000 }) },
  II:  { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  III: { text: 'Deal 4 damage within 3m. Do not rotate this Spell again this turn.',
         ...M.damageAndLock({ amount: 4, range: 3000 }) },
  IV:  { text: 'Rotate this Spell left.', ...M.turnSelf({ dir: 'left' }) },
});

card({
  id: 'CINDER_RAIN', name: 'Cinder Rain', school: 'red',
  runes: [SHARD, SHARD, SHARD, WHEEL],
  found: 'wideBurn',
  I:   { text: 'Deal 1 damage to each enemy unit within 3m.', ...M.damageAll({ amount: 1, range: 3000 }) },
  II:  { text: 'Deal 2 damage to an enemy unit you can see within 5m.',
         ...M.damage({ amount: 2, range: 5000, needLos: true }) },
  III: { text: '1 damage per Spell of yours destroyed this duel, up to 4.',
         ...M.damagePerLedger({ key: 'spellsDestroyed', per: 1, cap: 4, range: 3000 }) },
  IV:  { text: 'Push an enemy unit within 3m 2m.', ...M.push({ mm: 2000, range: 3000 }) },
});

card({
  id: 'SPLINTER_WARD', name: 'Splinter Ward', school: 'red',
  keywords: ['Spell Bane'],
  runes: [SHARD, SHARD, LATTICE, LATTICE],
  found: 'breakTwo',
  I:   { text: 'If an enemy is within 3m, deal 2 damage to it.',
         gate: { id: 'enemyInRange', mm: 3000 }, ...M.damage({ amount: 2, range: 3000 }) },
  II:  { text: 'Destroy a Spell.', ...M.destroyASpell({ side: 'friendly' }) },
  III: { text: 'Grant a Spell [Impact].', ...M.grantKeyword({ kw: 'Impact' }) },
  IV:  { text: 'Your damage is increased by 1.', ...M.passiveDamage({ n: 1 }) },
});

card({
  id: 'BLOOD_PACT', name: 'Blood Pact', school: 'red',
  runes: [SHARD, LATTICE, SHARD, SHARD],
  found: 'payInBlood',
  I:   { text: 'Your mage takes 1 damage. Deal 3 damage within 4m.',
         cost: [{ id: 'mageWound', n: 1 }], ...M.damage({ amount: 3, range: 4000 }) },
  II:  { text: 'Destroy a Spell you control. Draw 2 cards.',
         cost: [{ id: 'destroyFriendly', n: 1 }], ...M.drawCards({ n: 2 }) },
  III: { text: 'Discard a card. Deal 2 damage to each enemy within 2.5m.',
         cost: [{ id: 'discard', n: 1 }], ...M.damageAll({ amount: 2, range: 2500 }) },
  IV:  { text: 'Destroy this Spell. Draw 2 cards.', ...M.destroySelf({ then: 'draw' }) },
});

card({
  id: 'HAMMER_FALL', name: 'Hammer Fall', school: 'red',
  keywords: ['Crush'],
  runes: [WHEEL, SHARD, WHEEL, WHEEL],
  found: 'slamHome',
  I:   { text: 'Push an enemy unit within 3m 3m.', ...M.push({ mm: 3000, range: 3000 }) },
  II:  { text: 'Deal 2 damage to an enemy unit within 3m.', ...M.damage({ amount: 2, range: 3000 }) },
  III: { text: 'Push an enemy unit within 3m 4m away.', ...M.pushAway({ mm: 4000, range: 3000 }) },
  IV:  { text: 'Move a friendly unit to the nearest high ground.', ...M.toHighGround({ mm: 3000 }) },
});

card({
  id: 'VENOM_DART', name: 'Venom Dart', school: 'red',
  keywords: ['Poison'],
  runes: [SHARD, SHARD, LATTICE, SHARD],
  found: 'poisonTwo',
  I:   { text: 'Deal 1 damage to an enemy unit within 4m.', ...M.damage({ amount: 1, range: 4000 }) },
  II:  { text: 'Deal 2 damage to an enemy unit within 3m.', ...M.damage({ amount: 2, range: 3000 }) },
  III: { text: 'Grant a Spell [Poison].', ...M.grantKeyword({ kw: 'Poison' }) },
  IV:  { text: 'Deal 1 damage to each enemy unit within 2.5m.', ...M.damageAll({ amount: 1, range: 2500 }) },
});
