// TRAPS -- grey, face down, one side.
//
// A trap goes into an empty grey corner like an artifact, but it is set rather
// than cast: nothing resolves, nothing matches, and it waits. The first time
// its trigger is met during the OPPONENT'S turn it springs -- revealed,
// reaction, then the discard. See js/rules/traps.js for the mechanism and the
// one rule every trap obeys: its reaction never asks a question.
//
// Texts start with "TRAP:" (the schema insists) and state the trigger and the
// reaction in one breath, because the opponent reads this text exactly once,
// as it goes off.

import { card } from './registry.js';
import * as T from '../traps.js';

card({
  id: 'EARTH_WALL', name: 'Earth Wall', school: 'grey', kind: 'trap',
  sigil: null,
  I: { text: 'TRAP: when an enemy Spell would damage your unit, dirt heaves into a wall that takes the hit.',
       ...T.trapEarthWall() },
});

card({
  id: 'SNARE', name: 'Snare', school: 'grey', kind: 'trap',
  sigil: ['WLL.', '..LS'],
  I: { text: 'TRAP: an enemy unit ending a move within 2m of your mage takes 1 damage and loses its next action.',
       ...T.trapSnare({ range: 2000, amount: 1 }) },
});

card({
  id: 'BACKLASH', name: 'Backlash', school: 'grey', kind: 'trap',
  sigil: ['.W', 'SW', 'SL'],
  I: { text: 'TRAP: when an enemy Spell or unit damages your unit, the enemy mage takes 1 damage.',
       ...T.trapBacklash({ amount: 1 }) },
});

card({
  id: 'SPRING_TRAP', name: 'Spring Trap', school: 'grey', kind: 'trap',
  sigil: ['WHW', '..L', '..S'],
  I: { text: 'TRAP: an enemy unit ending a move within 1.5m of your unit is flung away from it with force 4.',
       ...T.trapSpring({ range: 1500, force: 4 }) },
});
