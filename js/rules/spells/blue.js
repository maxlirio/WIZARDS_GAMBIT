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
  id: 'SHIFT', name: 'Shift', school: 'blue',
  // The starting blue card: force that moves ANY body -- yours or theirs --
  // building to a blast that clears the ground around you. Pushing your own
  // mage out of a corner, or your golem onto a ledge, is half of what it is for.
  runes: [SPIRAL, WHEEL, WHEEL, WHEEL],
  sigil: null,
  // "Anything" is literal: any unit of EITHER side, or any terrain piece that
  // can move (user: "shift should be anything on each side ... or objects also").
  I:   { text: 'Push anything within 2m with force 2.', ...M.push({ force: 2, range: 2000, side: 'anything' }) },
  II:  { text: 'Push anything within 4m with force 3.', ...M.push({ force: 3, range: 4000, side: 'anything' }) },
  III: { text: 'Discard a card. Push anything within 3m away with force 4.',
         cost: [{ id: 'discard', n: 1 }], ...M.pushAway({ force: 4, range: 3000, side: 'anything' }) },
  IV:  { text: 'Push everything within 3m away from your mage with force 3.', ...M.repel({ force: 3, range: 3000, side: 'anything' }) },
});

card({
  id: 'LEVITATION', name: 'Levitation', school: 'blue',
  // Lift the stones -- and then let one go on somebody's head.
  keywords: ['Ignore Height'],
  runes: [WHEEL, SPIRAL, WHEEL, WHEEL],
  sigil: ['.WWS', 'WW..'],
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
  sigil: ['LW.', 'WLW'],
  I:   { text: 'Pull an enemy unit within 4m toward you with force 2.', ...M.pull({ force: 2, range: 4000 }) },
  II:  { text: 'Discard a card. Pull an enemy unit within 5m toward you with force 4.',
         cost: [{ id: 'discard', n: 1 }], ...M.pull({ force: 4, range: 5000 }) },
  III: { text: 'Your units move 1m further.', ...M.passiveUnitMove({ mm: 1000 }) },
  IV:  { text: 'Pull every enemy unit within 5m toward your mage with force 3.', ...M.vortex({ force: 3, range: 5000 }) },
});

card({
  id: 'STONE_TIDE', name: 'Stone Tide', school: 'blue',
  // The ground itself, moving. The last face is an earthquake that does not
  // care whose units are standing near you.
  runes: [SPIRAL, WHEEL, WHEEL, WHEEL],
  sigil: ['.SWW', 'WW..'],
  I:   { text: 'Push a terrain piece within 4m with force 3.', ...M.shoveTerrain({ force: 3, range: 4000 }) },
  II:  { text: 'Raise a stone wall within 2m of your mage.', ...M.raiseWall({ mm: 2000 }) },
  III: { text: 'Destroy a Spell you control. Push a terrain piece within 5m with force 5.',
         cost: [{ id: 'destroyFriendly', n: 1 }], ...M.shoveTerrain({ force: 5, range: 5000 }) },
  IV:  { text: 'Quake: push every unit within 3m away from your mage with force 3, friend or foe.',
         ...M.quake({ force: 3, range: 3000 }) },
});

card({
  id: 'WIND_STEP', name: 'Wind Step', school: 'blue',
  // Speed, ending in a single enormous leap.
  keywords: ['Swift'],
  runes: [WHEEL, WHEEL, LATTICE, WHEEL],
  sigil: ['..L', '..L', 'WWW'],
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
  sigil: ['.WW', 'WW.', '.H.'],
  I:   { text: 'If an enemy is within 2.5m, deal 1 damage to it.',
         gate: { id: 'enemyInRange', mm: 2500 }, ...M.damage({ amount: 1, range: 2500 }) },
  II:  { text: 'Pull an enemy unit within 4m toward you with force 3.', ...M.pull({ force: 3, range: 4000 }) },
  III: { text: 'Discard a card. Relocate any unit up to 4m.',
         cost: [{ id: 'discard', n: 1 }], ...M.relocate({ mm: 4000, range: 4000, side: 'any' }) },
  IV:  { text: 'Hurl an enemy unit within 4m three metres into the air. It falls.', ...M.hurl({ mm: 3000, range: 4000 }) },
});

card({
  id: 'FULCRUM', name: 'Fulcrum', school: 'blue',
  // Leverage. The last face swaps two bodies, either side, anywhere in reach.
  runes: [SPIRAL, WHEEL, WHEEL, WHEEL],
  sigil: ['.W.', 'WS.', '.WS'],
  I:   { text: 'Shift a Spell you control to an adjacent cell.', ...M.shiftASpell() },
  II:  { text: 'Push a terrain piece within 4m with force 4.', ...M.shoveTerrain({ force: 4, range: 4000 }) },
  III: { text: 'Destroy a Spell you control. Push an enemy unit within 4m with force 4.',
         cost: [{ id: 'destroyFriendly', n: 1 }], ...M.push({ force: 4, range: 4000 }) },
  IV:  { text: 'Swap the places of any two units within 5m.', ...M.swapUnits({ range: 5000 }) },
});

card({
  id: 'TIDE_CALLER', name: 'Tide Caller', school: 'blue',
  // A wave you ride, and finally one that breaks somebody against the rocks.
  runes: [SHARD, WHEEL, WHEEL, WHEEL],
  sigil: ['.W..', 'WHWW'],
  I:   { text: 'After a friendly unit moves, deal 1 damage to an enemy within 3m.',
         ...M.onMoveDamage({ amount: 1, range: 3000 }) },
  II:  { text: 'Pull an enemy unit within 4m toward you with force 3.', ...M.pull({ force: 3, range: 4000 }) },
  III: { text: 'Discard a card. Push a terrain piece within 5m with force 5.',
         cost: [{ id: 'discard', n: 1 }], ...M.shoveTerrain({ force: 5, range: 5000 }) },
  IV:  { text: 'Push an enemy unit within 4m away with force 5. If it hits anything, it is crushed.',
         ...M.slam({ force: 5, range: 4000, crush: true }) },
});

card({
  id: 'SKY_ANCHOR', name: 'Sky Anchor', school: 'blue',
  // Floating stone. Raise the ground and put your army on top of it.
  keywords: ['Ignore Height'],
  runes: [SPIRAL, WHEEL, WHEEL, WHEEL],
  sigil: ['WSW', '.WW'],
  I:   { text: 'If the cell above this one is empty, relocate a friendly unit up to 3m.',
         gate: { id: 'neighbourEmpty', where: 'above' }, ...M.relocate({ mm: 3000, range: 4000 }) },
  II:  { text: 'Raise a terrain piece within 4m by 2m.', ...M.liftTerrain({ mm: 2000, range: 4000 }) },
  III: { text: 'Destroy a Spell you control. Raise a terrain piece within 5m by 3m.',
         cost: [{ id: 'destroyFriendly', n: 1 }], ...M.liftTerrain({ mm: 3000, range: 5000 }) },
  IV:  { text: 'Move a friendly unit to the nearest high ground within 6m.', ...M.toHighGround({ mm: 6000, range: 6000 }) },
});
