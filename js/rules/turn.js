// Turn structure. ONE spell action, then the Unit Phase.
//
// The asymmetry is the game's whole action economy: your spell table gets one
// decision a turn and your army gets a full round of them. So the table is
// about setting up a chain that does several things from one action, and the
// battlefield is about position. Nothing here lets a player take two spell
// actions, which is why `spellActionUsed` is a flag on the state rather than a
// count -- there is no card that gives you another, and if one is ever written
// it has to come through here.

import { spellsOn, fx, draw } from './ops.js';
import { emit } from './triggers.js';
import { refresh } from './derive.js';
import {
  respawnMage, startUnitTurn, tickPoison, recordHighGround, pendingUnits,
} from './units.js';
import { mageOf } from '../field/query.js';

export const PHASES = Object.freeze(['spell', 'unit', 'over']);

export function beginTurn(state) {
  const p = state.active;
  state.phase = 'spell';
  state.spellActionUsed = false;
  state.tableDirty = [false, false];

  const pl = state.players[p];
  // "the mage respawns at its owner's own starting circle at the start of that
  // owner's next turn" -- here, before anything else can happen, so a
  // respawning mage gets its unit action this turn.
  if (pl.mage.respawnOnTurn !== null && pl.mage.respawnOnTurn <= state.turn) respawnMage(state, p);

  startUnitTurn(state, p);
  refresh(state);
  tickPoison(state, p);
  fx(state, 'turnStart', { p, turn: state.turn });
  emit(state, 'turnStart', { p, turn: state.turn });
}

export function endTurn(state) {
  const p = state.active;
  recordHighGround(state, p);
  emit(state, 'turnEnd', { p, turn: state.turn });
  fx(state, 'turnEnd', { p, turn: state.turn });

  // A prohibition expires by COMPARISON, not by being cleared: `noTurnUntil`
  // holds the turn number it applies to, and `noTurnUntil >= state.turn` goes
  // false on its own. A cleanup pass would be a second place that decides when
  // a prohibition ends, and the two would eventually disagree about a chain
  // that crossed a turn boundary.
  state.turn++;
  state.active = 1 - state.active;
  beginTurn(state);
}

/** Is the current player out of things they are obliged to do? */
export const unitPhaseDone = (state) => pendingUnits(state, state.active).length === 0;
