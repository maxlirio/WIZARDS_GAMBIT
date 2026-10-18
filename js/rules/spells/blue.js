// BLUE -- the battlefield. Home cell 5.
//
// Blue does not deal damage, it moves things: units, props and the ground they
// are standing on. It is the school that makes the arena matter, and the school
// that cares most about which arena you got -- a push worth four metres on open
// ground is a kill on the chasm.

import { card } from './registry.js';
import * as M from '../motifs.js';
import { SPIRAL, SHARD, WHEEL, LATTICE } from '../runes.js';

card({
  id: 'SHOVE', name: 'Shove', school: 'blue',
  runes: [WHEEL, WHEEL, WHEEL, LATTICE],
  found: null,
  I:   { text: 'Push an enemy unit within 3m 2m.', ...M.push({ mm: 2000, range: 3000 }) },
  II:  { text: 'Push an enemy unit within 3m 3m away.', ...M.pushAway({ mm: 3000, range: 3000 }) },
  III: { text: 'Push a terrain piece within 4m 2m.', ...M.shoveTerrain({ mm: 2000, range: 4000 }) },
  IV:  { text: 'Draw a card.', ...M.drawCards({ n: 1 }) },
});

card({
  id: 'LEVITATION', name: 'Levitation', school: 'blue',
  keywords: ['Ignore Height'],
  runes: [WHEEL, WHEEL, WHEEL, LATTICE],
  found: 'liftThree',
  I:   { text: 'Remove a terrain piece within 5m until end of turn.', ...M.banishTerrain({ range: 5000 }) },
  II:  { text: 'Raise a terrain piece within 4m by 1.5m.', ...M.liftTerrain({ mm: 1500, range: 4000 }) },
  III: { text: 'Relocate any unit up to 3m.', ...M.relocate({ mm: 3000, range: 4000, side: 'any' }) },
  IV:  { text: 'Grant a Spell [Ignore Height].', ...M.grantKeyword({ kw: 'Ignore Height' }) },
});

card({
  id: 'UNDERTOW', name: 'Undertow', school: 'blue',
  runes: [WHEEL, SHARD, WHEEL, WHEEL],
  found: 'dragThem',
  I:   { text: 'Pull an enemy unit within 4m 3m toward you.', ...M.pull({ mm: 3000, range: 4000 }) },
  II:  { text: 'Deal 1 damage to an enemy unit within 3m.', ...M.damage({ amount: 1, range: 3000 }) },
  III: { text: 'Push an enemy unit within 3m 2m.', ...M.push({ mm: 2000, range: 3000 }) },
  IV:  { text: 'Pull an enemy unit within 4m 2m toward you.', ...M.pull({ mm: 2000, range: 4000 }) },
});

card({
  id: 'STONE_TIDE', name: 'Stone Tide', school: 'blue',
  runes: [WHEEL, WHEEL, SHARD, WHEEL],
  found: 'moveEarth',
  I:   { text: 'Push a terrain piece within 4m 3m.', ...M.shoveTerrain({ mm: 3000, range: 4000 }) },
  II:  { text: 'Raise a terrain piece within 4m by 2m.', ...M.liftTerrain({ mm: 2000, range: 4000 }) },
  III: { text: 'Deal 1 damage to an enemy unit within 3m.', ...M.damage({ amount: 1, range: 3000 }) },
  IV:  { text: 'Your units move 1m further.', ...M.passiveUnitMove({ mm: 1000 }) },
});

card({
  id: 'WIND_STEP', name: 'Wind Step', school: 'blue',
  keywords: ['Swift'],
  runes: [WHEEL, WHEEL, LATTICE, WHEEL],
  found: 'runFar',
  I:   { text: 'Relocate a friendly unit up to 4m.', ...M.relocate({ mm: 4000, range: 4000 }) },
  II:  { text: 'Move a friendly unit to the nearest elevated position.', ...M.toHighGround({ mm: 3000 }) },
  III: { text: 'Grant a Spell [Swift].', ...M.grantKeyword({ kw: 'Swift' }) },
  IV:  { text: 'Pull an enemy unit within 4m 2m toward you.', ...M.pull({ mm: 2000, range: 4000 }) },
});

card({
  id: 'GRAVE_WELL', name: 'Grave Well', school: 'blue',
  runes: [WHEEL, SHARD, WHEEL, WHEEL],
  found: 'holdHeight',
  I:   { text: 'If you hold the high ground, push a unit within 3m 2m.',
         gate: { id: 'highGround' }, ...M.push({ mm: 2000, range: 3000 }) },
  II:  { text: 'If an enemy is within 2.5m, deal 2 damage to it.',
         gate: { id: 'enemyInRange', mm: 2500 }, ...M.damage({ amount: 2, range: 2500 }) },
  III: { text: 'Relocate any unit up to 3m.', ...M.relocate({ mm: 3000, range: 4000, side: 'any' }) },
  IV:  { text: 'Relocate a friendly unit up to 3m.', ...M.relocate({ mm: 3000, range: 4000 }) },
});

card({
  id: 'FULCRUM', name: 'Fulcrum', school: 'blue',
  runes: [SPIRAL, WHEEL, WHEEL, LATTICE],
  found: 'leverage',
  I:   { text: 'Shift a Spell you control to an adjacent cell.', ...M.shiftASpell() },
  II:  { text: 'Push an enemy unit within 3m 3m.', ...M.push({ mm: 3000, range: 3000 }) },
  III: { text: 'Push a terrain piece within 4m 2m.', ...M.shoveTerrain({ mm: 2000, range: 4000 }) },
  IV:  { text: 'Your range is increased by 1m.', ...M.passiveRange({ mm: 1000 }) },
});
