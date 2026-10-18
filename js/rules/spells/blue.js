// BLUE -- the battlefield. Home cell 5.
//
// Blue moves things: units, rocks, the ground itself. Its payoffs are the
// physics the arena was built for -- a rock dropped on someone, an enemy thrown
// into the air, a quake that knocks everybody off the plateau, two units
// swapping places so the one standing on the edge is now yours to push.

import { card } from './registry.js';
import * as M from '../motifs.js';
import { SPIRAL, SHARD, WHEEL, LATTICE } from '../runes.js';

card({
  id: 'SHOVE', name: 'Shove', school: 'blue',
  // Force, building to a blast that clears the ground around you.
  runes: [SPIRAL, WHEEL, WHEEL, WHEEL],
  found: null,
  I:   { text: 'Push an enemy unit within 2m 1.5m.', ...M.push({ mm: 1500, range: 2000 }) },
  II:  { text: 'Push a terrain piece within 4m 2m.', ...M.shoveTerrain({ mm: 2000, range: 4000 }) },
  III: { text: 'Discard a card. Push an enemy unit within 3m 3m away.',
         cost: [{ id: 'discard', n: 1 }], ...M.pushAway({ mm: 3000, range: 3000 }) },
  IV:  { text: 'Push every enemy unit within 3m 2.5m away from your mage.', ...M.repel({ mm: 2500, range: 3000 }) },
});

card({
  id: 'LEVITATION', name: 'Levitation', school: 'blue',
  // Lift the stones -- and then let one go on somebody's head.
  keywords: ['Ignore Height'],
  runes: [WHEEL, SPIRAL, WHEEL, WHEEL],
  found: 'liftThree',
  I:   { text: 'Raise a terrain piece within 4m by 1m.', ...M.liftTerrain({ mm: 1000, range: 4000 }) },
  II:  { text: 'Remove a terrain piece within 5m until end of turn.', ...M.banishTerrain({ range: 5000 }) },
  III: { text: 'Put the top 2 cards of your deck into your discard. Relocate a friendly unit up to 3m.',
         cost: [{ id: 'millSelf', n: 2 }], ...M.relocate({ mm: 3000, range: 4000 }) },
  IV:  { text: 'Drop a nearby rock onto an enemy unit within 4m. Deal 3 damage to it.',
         ...M.dropRock({ amount: 3, range: 4000, near: 3000 }) },
});

card({
  id: 'UNDERTOW', name: 'Undertow', school: 'blue',
  // A current that drags everything toward you.
  runes: [WHEEL, WHEEL, LATTICE, WHEEL],
  found: 'dragThem',
  I:   { text: 'Pull an enemy unit within 4m 1.5m toward you.', ...M.pull({ mm: 1500, range: 4000 }) },
  II:  { text: 'Discard a card. Pull an enemy unit within 5m 3m toward you.',
         cost: [{ id: 'discard', n: 1 }], ...M.pull({ mm: 3000, range: 5000 }) },
  III: { text: 'Your units move 1m further.', ...M.passiveUnitMove({ mm: 1000 }) },
  IV:  { text: 'Pull every enemy unit within 5m 2m toward your mage.', ...M.vortex({ mm: 2000, range: 5000 }) },
});

card({
  id: 'STONE_TIDE', name: 'Stone Tide', school: 'blue',
  // The ground itself, moving. The last face is an earthquake that does not
  // care whose units are standing near you.
  runes: [SPIRAL, WHEEL, WHEEL, WHEEL],
  found: 'moveEarth',
  I:   { text: 'Push a terrain piece within 4m 2m.', ...M.shoveTerrain({ mm: 2000, range: 4000 }) },
  II:  { text: 'Raise a stone wall within 2m of your mage.', ...M.raiseWall({ mm: 2000 }) },
  III: { text: 'Destroy a Spell you control. Push a terrain piece within 5m 4m.',
         cost: [{ id: 'destroyFriendly', n: 1 }], ...M.shoveTerrain({ mm: 4000, range: 5000 }) },
  IV:  { text: 'Quake: push every unit within 3m 2m away from your mage, friend or foe.',
         ...M.quake({ mm: 2000, range: 3000 }) },
});

card({
  id: 'WIND_STEP', name: 'Wind Step', school: 'blue',
  // Speed, ending in a single enormous leap.
  keywords: ['Swift'],
  runes: [WHEEL, WHEEL, LATTICE, WHEEL],
  found: 'runFar',
  I:   { text: 'Your units move 1m further.', ...M.passiveUnitMove({ mm: 1000 }) },
  II:  { text: 'Relocate a friendly unit up to 3m.', ...M.relocate({ mm: 3000, range: 4000 }) },
  III: { text: 'Discard a card. Grant a Spell [Swift].',
         cost: [{ id: 'discard', n: 1 }], ...M.grantKeyword({ kw: 'Swift' }) },
  IV:  { text: 'Relocate a friendly unit up to 6m.', ...M.relocate({ mm: 6000, range: 6000 }) },
});

card({
  id: 'GRAVE_WELL', name: 'Grave Well', school: 'blue',
  // Gravity, reversed and then restored. The payoff throws an enemy three
  // metres up and lets the ground do the damage.
  runes: [SHARD, WHEEL, WHEEL, WHEEL],
  found: 'holdHeight',
  I:   { text: 'If an enemy is within 2.5m, deal 1 damage to it.',
         gate: { id: 'enemyInRange', mm: 2500 }, ...M.damage({ amount: 1, range: 2500 }) },
  II:  { text: 'Pull an enemy unit within 4m 2m toward you.', ...M.pull({ mm: 2000, range: 4000 }) },
  III: { text: 'Discard a card. Relocate any unit up to 4m.',
         cost: [{ id: 'discard', n: 1 }], ...M.relocate({ mm: 4000, range: 4000, side: 'any' }) },
  IV:  { text: 'Hurl an enemy unit within 4m three metres into the air. It falls.', ...M.hurl({ mm: 3000, range: 4000 }) },
});

card({
  id: 'FULCRUM', name: 'Fulcrum', school: 'blue',
  // Leverage. The last face swaps two bodies, either side, anywhere in reach.
  runes: [SPIRAL, WHEEL, WHEEL, WHEEL],
  found: 'leverage',
  I:   { text: 'Shift a Spell you control to an adjacent cell.', ...M.shiftASpell() },
  II:  { text: 'Push a terrain piece within 4m 3m.', ...M.shoveTerrain({ mm: 3000, range: 4000 }) },
  III: { text: 'Destroy a Spell you control. Push an enemy unit within 4m 3m.',
         cost: [{ id: 'destroyFriendly', n: 1 }], ...M.push({ mm: 3000, range: 4000 }) },
  IV:  { text: 'Swap the places of any two units within 5m.', ...M.swapUnits({ range: 5000 }) },
});

card({
  id: 'TIDE_CALLER', name: 'Tide Caller', school: 'blue',
  // A wave you ride, and finally one that breaks somebody against the rocks.
  runes: [SHARD, WHEEL, WHEEL, WHEEL],
  found: 'tideTurn',
  I:   { text: 'After a friendly unit moves, deal 1 damage to an enemy within 3m.',
         ...M.onMoveDamage({ amount: 1, range: 3000 }) },
  II:  { text: 'Pull an enemy unit within 4m 2m toward you.', ...M.pull({ mm: 2000, range: 4000 }) },
  III: { text: 'Discard a card. Push a terrain piece within 5m 4m.',
         cost: [{ id: 'discard', n: 1 }], ...M.shoveTerrain({ mm: 4000, range: 5000 }) },
  IV:  { text: 'Push an enemy unit within 4m 4m away. If it hits anything, it is crushed.',
         ...M.slam({ mm: 4000, range: 4000, crush: true }) },
});

card({
  id: 'SKY_ANCHOR', name: 'Sky Anchor', school: 'blue',
  // Floating stone. Raise the ground and put your army on top of it.
  keywords: ['Ignore Height'],
  runes: [SPIRAL, WHEEL, WHEEL, WHEEL],
  found: 'anchored',
  I:   { text: 'If the cell above this one is empty, relocate a friendly unit up to 3m.',
         gate: { id: 'neighbourEmpty', where: 'above' }, ...M.relocate({ mm: 3000, range: 4000 }) },
  II:  { text: 'Raise a terrain piece within 4m by 2m.', ...M.liftTerrain({ mm: 2000, range: 4000 }) },
  III: { text: 'Destroy a Spell you control. Raise a terrain piece within 5m by 3m.',
         cost: [{ id: 'destroyFriendly', n: 1 }], ...M.liftTerrain({ mm: 3000, range: 5000 }) },
  IV:  { text: 'Move a friendly unit to the nearest high ground within 6m.', ...M.toHighGround({ mm: 6000, range: 6000 }) },
});
