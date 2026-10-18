// RED -- attack. Home cell 1.
//
// Every red card is a weapon that CHARGES. Side I is the spark you can afford
// to have on the table all game; II and III are the price and the build-up;
// side IV is the blow the card exists for. Most range is measured from your
// mage, so a dead mage turns the school off -- which is what makes feeding your
// mage to the enemy for 2 VP a real decision rather than a free trade.

import { card } from './registry.js';
import * as M from '../motifs.js';
import { SPIRAL, SHARD, WHEEL, LATTICE } from '../runes.js';

card({
  id: 'EMBER_LASH', name: 'Ember Lash', school: 'red',
  // A whip of fire that ends as a fireball.
  runes: [SHARD, SHARD, WHEEL, SHARD],
  found: null,
  I:   { text: 'Deal 1 damage to an enemy unit within 3m.', ...M.damage({ amount: 1, range: 3000, element: 'fire' }) },
  II:  { text: 'Discard a card. Deal 2 damage to an enemy unit within 3m.',
         cost: [{ id: 'discard', n: 1 }], ...M.damage({ amount: 2, range: 3000, element: 'fire' }) },
  III: { text: 'Push an enemy unit within 3m 2m away.', ...M.pushAway({ mm: 2000, range: 3000 }) },
  IV:  { text: 'Fireball: deal 3 damage to an enemy unit within 4m and 1 to each enemy near it.',
         ...M.fireball({ amount: 3, splash: 1, radius: 1500, range: 4000 }) },
});

card({
  id: 'FIREBRAND', name: 'Firebrand', school: 'red',
  // A blade heated past bearing. The last face is a killing blow that locks the
  // card in place, so you cannot cycle straight back round to it.
  keywords: ['Impact'],
  runes: [LATTICE, SHARD, SPIRAL, SHARD],
  found: 'burnBright',
  I:   { text: 'Your damage is increased by 1.', ...M.passiveDamage({ n: 1 }) },
  II:  { text: 'Destroy a Spell you control. Deal 3 damage to an enemy unit within 3m.',
         cost: [{ id: 'destroyFriendly', n: 1 }], ...M.damage({ amount: 3, range: 3000, element: 'fire' }) },
  III: { text: 'Rotate this Spell left.', ...M.turnSelf({ dir: 'left' }) },
  IV:  { text: 'Deal 4 damage within 3m. Do not rotate this Spell again this turn.',
         ...M.damageAndLock({ amount: 4, range: 3000, element: 'fire' }) },
});

card({
  id: 'CINDER_RAIN', name: 'Cinder Rain', school: 'red',
  // Burning ash over a widening circle.
  runes: [SHARD, SHARD, LATTICE, SHARD],
  found: 'wideBurn',
  I:   { text: 'Deal 1 damage to each enemy unit within 2m.', ...M.damageAll({ amount: 1, range: 2000, element: 'fire' }) },
  II:  { text: 'Discard a card. Deal 1 damage to each enemy unit within 3m.',
         cost: [{ id: 'discard', n: 1 }], ...M.damageAll({ amount: 1, range: 3000, element: 'fire' }) },
  III: { text: 'Grant a Spell [Poison].', ...M.grantKeyword({ kw: 'Poison' }) },
  IV:  { text: 'Deal 2 damage to each enemy unit within 4m.', ...M.damageAll({ amount: 2, range: 4000, element: 'fire' }) },
});

card({
  id: 'SPLINTER_WARD', name: 'Thornwall', school: 'red',
  // Spiked stone that bites whoever comes close, and finally bursts outward.
  keywords: ['Spell Bane'],
  runes: [SHARD, WHEEL, LATTICE, SHARD],
  found: 'breakTwo',
  I:   { text: 'If an enemy is within 3m, deal 1 damage to it.',
         gate: { id: 'enemyInRange', mm: 3000 }, ...M.damage({ amount: 1, range: 3000 }) },
  II:  { text: 'Raise a stone wall within 2m of your mage.', ...M.raiseWall({ mm: 2000 }) },
  III: { text: 'Your units take 1 less damage.', ...M.passiveShield({ n: 1 }) },
  IV:  { text: 'Deal 2 damage to each enemy unit within 2.5m and push each 1.5m away.',
         ...M.nova({ amount: 2, mm: 1500, range: 2500 }) },
});

card({
  id: 'BLOOD_PACT', name: 'Blood Pact', school: 'red',
  // Pay in your own blood, then drink theirs.
  runes: [LATTICE, SHARD, LATTICE, SHARD],
  found: 'payInBlood',
  I:   { text: 'Your mage takes 1 damage. Draw 2 cards.',
         cost: [{ id: 'mageWound', n: 1 }], ...M.drawCards({ n: 2 }) },
  II:  { text: 'Your mage takes 1 damage. Deal 3 damage to an enemy unit within 4m.',
         cost: [{ id: 'mageWound', n: 1 }], ...M.damage({ amount: 3, range: 4000 }) },
  III: { text: 'Your mage regains 2 life.', ...M.mend({ n: 2 }) },
  IV:  { text: 'Deal 3 damage to an enemy unit within 4m. Your mage regains what it dealt.',
         ...M.drain({ amount: 3, range: 4000 }) },
});

card({
  id: 'HAMMER_FALL', name: 'Hammer Fall', school: 'red',
  // Everything is a wall if you hit someone into it hard enough.
  keywords: ['Crush'],
  runes: [WHEEL, LATTICE, WHEEL, WHEEL],
  found: 'slamHome',
  I:   { text: 'Push an enemy unit within 2m 1.5m.', ...M.push({ mm: 1500, range: 2000 }) },
  II:  { text: 'Grant a Spell [Crush].', ...M.grantKeyword({ kw: 'Crush' }) },
  III: { text: 'Destroy a Spell you control. Push an enemy unit within 3m 3m away.',
         cost: [{ id: 'destroyFriendly', n: 1 }], ...M.pushAway({ mm: 3000, range: 3000 }) },
  IV:  { text: 'Push an enemy unit within 3m 4m away, then deal 2 damage to it.',
         ...M.slam({ mm: 4000, range: 3000, amount: 2 }) },
});

card({
  id: 'VENOM_DART', name: 'Venom Dart', school: 'red',
  // Small wounds that do not stop hurting.
  keywords: ['Poison'],
  runes: [LATTICE, SHARD, SHARD, SHARD],
  found: 'poisonTwo',
  I:   { text: 'Grant a Spell [Poison].', ...M.grantKeyword({ kw: 'Poison' }) },
  II:  { text: 'Deal 1 damage to an enemy unit within 4m.', ...M.damage({ amount: 1, range: 4000 }) },
  III: { text: 'Put the top 2 cards of your deck into your discard. Deal 2 damage to an enemy unit within 4m.',
         cost: [{ id: 'millSelf', n: 2 }], ...M.damage({ amount: 2, range: 4000 }) },
  IV:  { text: 'Deal 2 damage to an enemy unit within 5m and poison it twice.',
         ...M.envenom({ amount: 2, poison: 2, range: 5000 }) },
});

card({
  id: 'ASH_WRAITH', name: 'Ash Wraith', school: 'red',
  // A spirit that spends itself. Its last face is a death that takes someone with it.
  keywords: ['Unstable'],
  runes: [SHARD, SHARD, LATTICE, SHARD],
  found: 'unstableEnd',
  I:   { text: 'Deal 1 damage to an enemy unit within 3m.', ...M.damage({ amount: 1, range: 3000 }) },
  II:  { text: 'Rotate another Spell you control left. Deal 2 damage to an enemy unit within 3m.',
         cost: [{ id: 'rotateFriendly' }], ...M.damage({ amount: 2, range: 3000, element: 'fire' }) },
  III: { text: 'Grant a Spell [Unstable].', ...M.grantKeyword({ kw: 'Unstable' }) },
  IV:  { text: 'Destroy this Spell. Deal 4 damage to an enemy unit within 4m.',
         cost: [{ id: 'destroySelf' }], ...M.damage({ amount: 4, range: 4000, element: 'fire' }) },
});

card({
  id: 'SIEGE_BRAND', name: 'Storm Brand', school: 'red',
  // Lightning that jumps from body to body. Stand your enemies close together
  // and the last face arcs through all of them.
  runes: [LATTICE, SHARD, SHARD, SHARD],
  found: 'besieged',
  I:   { text: 'Your range is increased by 1m.', ...M.passiveRange({ mm: 1000 }) },
  II:  { text: 'Deal 1 damage to an enemy unit within 4m. It arcs to one more enemy near it.',
         ...M.chainLightning({ amount: 1, jumps: 1, hop: 2500, range: 4000 }) },
  III: { text: "Spend a friendly unit's action. Deal 2 damage to an enemy unit within 5m.",
         cost: [{ id: 'spendUnitAction' }], ...M.damage({ amount: 2, range: 5000, element: 'lightning' }) },
  IV:  { text: 'Deal 2 damage to an enemy unit within 5m. It arcs to two more enemies near it.',
         ...M.chainLightning({ amount: 2, jumps: 2, hop: 2500, range: 5000 }) },
});
