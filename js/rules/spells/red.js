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
  III: { text: 'Push an enemy unit within 3m away with force 3.', ...M.pushAway({ force: 3, range: 3000 }) },
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
  IV:  { text: 'Deal 2 damage to each enemy unit within 2.5m and push each away with force 2.',
         ...M.nova({ amount: 2, force: 2, range: 2500 }) },
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
  I:   { text: 'Push an enemy unit within 2m with force 2.', ...M.push({ force: 2, range: 2000 }) },
  II:  { text: 'Grant a Spell [Crush].', ...M.grantKeyword({ kw: 'Crush' }) },
  III: { text: 'Destroy a Spell you control. Push an enemy unit within 3m away with force 4.',
         cost: [{ id: 'destroyFriendly', n: 1 }], ...M.pushAway({ force: 4, range: 3000 }) },
  IV:  { text: 'Push an enemy unit within 3m away with force 5, then deal 2 damage to it.',
         ...M.slam({ force: 5, range: 3000, amount: 2 }) },
});

card({
  id: 'VENOM_DART', name: 'Venom Dart', school: 'red',
  // Small wounds that do not stop hurting.
  keywords: ['Poison'],
  runes: [LATTICE, SHARD, SHARD, SHARD],
  found: 'poisonTwo',
  I:   { text: 'Grant a Spell [Poison].', ...M.grantKeyword({ kw: 'Poison' }) },
  II:  { text: 'Deal 1 damage to an enemy unit within 4m.', ...M.damage({ amount: 1, range: 4000 }) },
  III: { text: 'Put the top 2 cards of your deck into your discard. Burn an enemy Spell: destroy it.',
         cost: [{ id: 'millSelf', n: 2 }], ...M.destroyASpell({ side: 'enemy' }) },
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

/* ------------------------------------------------------------------------ */
// THE PHYSICAL TRANCHE. The owner's note on the first nine: "really boring".
// What they had in common was that they were numbers -- deal 2, deal 3. These
// eight are EVENTS: a rock out of the sky, a stone bursting into shrapnel, a
// mage running through the line trailing fire. Each has one visible theme,
// I-III pay for and set up IV, and IV is the thing you would tell someone
// about afterwards.

card({
  id: 'METEOR_CALL', name: 'Meteor Call', school: 'red',
  // Reach up, heat the sky, pull a rock down out of it. The boulder STAYS:
  // every meteor is a new piece of terrain to fight over.
  runes: [SHARD, WHEEL, LATTICE, WHEEL],
  found: 'starfall',
  I:   { text: 'Deal 1 damage to an enemy unit within 4m.', ...M.damage({ amount: 1, range: 4000, element: 'fire' }) },
  II:  { text: 'Pull a terrain piece within 4m to you with force 3.', ...M.pullTerrain({ force: 3, range: 4000 }) },
  III: { text: 'Discard a card. Grant a Spell [Crush].',
         cost: [{ id: 'discard', n: 1 }], ...M.grantKeyword({ kw: 'Crush' }) },
  IV:  { text: 'Drop a boulder within 5m. Units within 1m take 3 damage and fly away with force 3.',
         ...M.meteor({ amount: 3, force: 3, radius: 1000, range: 5000 }) },
});

card({
  id: 'STONEBURST', name: 'Stoneburst', school: 'red',
  // Crack it, shove it among them, then burst it. The terrain is the bomb.
  runes: [SHARD, LATTICE, WHEEL, SHARD],
  found: 'rubble',
  I:   { text: 'Crack a terrain piece within 4m for 1.', ...M.crackTerrain({ amount: 1, range: 4000 }) },
  II:  { text: 'Crack a terrain piece within 4m for 2. Draw a card.', ...M.crackTerrain({ amount: 2, range: 4000, then: 'draw' }) },
  III: { text: 'Destroy a Spell you control. Push a terrain piece within 4m with force 5.',
         cost: [{ id: 'destroyFriendly', n: 1 }], ...M.shoveTerrain({ force: 5, range: 4000 }) },
  IV:  { text: 'Shatter a terrain piece within 4m. Units within 1.5m of it take 2 damage, thrown with force 3.',
         ...M.shatterTerrain({ amount: 2, force: 3, radius: 1500, range: 4000 }) },
});

card({
  id: 'THUNDERCLAP', name: 'Thunderclap', school: 'red',
  // Short range on purpose: the mage has to stand IN the fight to clap, and
  // what it buys is a whole turn stolen from everyone it floors.
  keywords: ['Stun'],
  runes: [SHARD, SHARD, LATTICE, SHARD],
  found: 'floored',
  I:   { text: 'Deal 1 damage to each enemy unit within 1.5m.', ...M.damageAll({ amount: 1, range: 1500, element: 'lightning' }) },
  II:  { text: 'Your mage takes 1 damage. Knock down an enemy unit within 2m.',
         cost: [{ id: 'mageWound', n: 1 }], ...M.knockDown({ range: 2000 }) },
  III: { text: 'Grant a Spell [Stun].', ...M.grantKeyword({ kw: 'Stun' }) },
  IV:  { text: 'Deal 2 damage to each enemy unit within 2m and knock each of them down.',
         ...M.thunderclap({ amount: 2, range: 2000 }) },
});

card({
  id: 'BLAZING_CHARGE', name: 'Blazing Charge', school: 'red',
  // The mage is the weapon. Get it moving, get it close, then run them down.
  runes: [WHEEL, SHARD, LATTICE, WHEEL],
  found: 'hotFooted',
  I:   { text: 'Your units move 1m further.', ...M.passiveUnitMove({ mm: 1000 }) },
  II:  { text: 'Deal 1 damage to each enemy unit within 1m.', ...M.damageAll({ amount: 1, range: 1000, element: 'fire' }) },
  III: { text: 'Discard a card. Relocate your mage up to 2m.',
         cost: [{ id: 'discard', n: 1 }], ...M.dashMage({ mm: 2000 }) },
  IV:  { text: 'Charge 3m: each enemy within 1m of the run takes 2 damage; the one it rams is shoved.',
         ...M.charge({ mm: 3000, amount: 2, radius: 1000, force: 2 }) },
});

card({
  id: 'CANNONADE', name: 'Cannonade', school: 'red',
  // Every rock on the field is ammunition. [Levitate] on the shot and the
  // rock flies over whatever is in the way.
  runes: [WHEEL, LATTICE, WHEEL, WHEEL],
  found: 'ballista',
  I:   { text: 'Push a terrain piece within 3m with force 3.', ...M.shoveTerrain({ force: 3, range: 3000 }) },
  II:  { text: 'Grant a Spell [Levitate].', ...M.grantKeyword({ kw: 'Levitate' }) },
  III: { text: 'Destroy a Spell you control. Pull a terrain piece within 4m to you with force 4.',
         cost: [{ id: 'destroyFriendly', n: 1 }], ...M.pullTerrain({ force: 4, range: 4000 }) },
  IV:  { text: 'Fire a terrain piece within 3m at the enemy nearest it with force 6.',
         ...M.cannonade({ force: 6, range: 3000 }) },
});

card({
  id: 'IMMOLATE', name: 'Immolate', school: 'red',
  // Fire ON a unit, not beside it: it burns at the start of its own turns,
  // and burning things set other things alight.
  runes: [SHARD, LATTICE, SHARD, SHARD],
  found: 'kindled',
  I:   { text: 'Deal 1 damage to an enemy unit within 3m and set it burning.', ...M.immolate({ amount: 1, burn: 2, range: 3000 }) },
  II:  { text: 'Discard a card. Each burning enemy unit within 4m takes 2 damage.',
         cost: [{ id: 'discard', n: 1 }], ...M.stokeBurning({ amount: 2, range: 4000 }) },
  III: { text: 'Your mage takes 1 damage. Each enemy within 1m of a burning enemy catches fire.',
         cost: [{ id: 'mageWound', n: 1 }], ...M.spreadBurn({ radius: 1000, burn: 2 }) },
  IV:  { text: 'Every burning enemy takes 3 damage; each enemy within 1.5m of one catches fire.',
         ...M.conflagration({ amount: 3, radius: 1500, burn: 2 }) },
});

card({
  id: 'FLAME_LINE', name: 'Flame Line', school: 'red',
  // The grove as a weapon. Light the trees, push a burning one into their
  // line, then set the whole stand going at once.
  runes: [SHARD, LATTICE, WHEEL, SHARD],
  found: 'wildfire',
  I:   { text: 'Ignite a burnable terrain piece within 3m.', ...M.igniteTerrain({ range: 3000 }) },
  II:  { text: 'Discard a card. Each enemy within 1m of a burning piece takes 1 damage.',
         cost: [{ id: 'discard', n: 1 }], ...M.fireBite({ amount: 1, radius: 1000 }) },
  // Force 3 is a tree's tipping force (arena.js), so this is a FELLING: the
  // tree goes over along the line you drag, burning or not, onto whoever is
  // under it.
  III: { text: 'Fell a burnable terrain piece within 3m along a line you drag.', ...M.shoveTerrain({ force: 3, range: 3000, burnableOnly: true }) },
  IV:  { text: 'Ignite all burnable pieces within 3m; each enemy within 1m of one takes 2 damage.',
         ...M.flameLine({ range: 3000, radius: 1000, amount: 2 }) },
});

card({
  id: 'SKYFALL', name: 'Skyfall', school: 'red',
  // Gravity, switched off and on again. Lift the ground, drag them in, then
  // throw them over the wall and let the landing do the work.
  runes: [WHEEL, SHARD, LATTICE, WHEEL],
  found: 'skyborne',
  I:   { text: 'Raise a terrain piece within 4m by 1m.', ...M.liftTerrain({ mm: 1000, range: 4000 }) },
  II:  { text: 'Hurl an enemy unit within 3m 2m into the air. It falls.', ...M.hurl({ mm: 2000, range: 3000 }) },
  III: { text: 'Discard a card. Pull an enemy unit within 5m toward you with force 3.',
         cost: [{ id: 'discard', n: 1 }], ...M.pull({ force: 3, range: 5000 }) },
  IV:  { text: 'Lift an enemy unit within 4m 2m up and throw it with force 4. The fall hurts.',
         ...M.skyfall({ up: 2000, force: 4, range: 4000 }) },
});
