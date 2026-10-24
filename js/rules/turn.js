// Turn structure. The Unit Phase FIRST, then ONE spell action.
//
// Units move before spells so that the spell you choose is cast from where
// your mage now stands: walk into range, then strike with the table.
//
// The asymmetry is the game's whole action economy: your spell table gets one
// decision a turn and your army gets a full round of them. So the table is
// about setting up a chain that does several things from one action, and the
// battlefield is about position. Nothing here lets a player take two spell
// actions, which is why `spellActionUsed` is a flag on the state rather than a
// count -- there is no card that gives you another, and if one is ever written
// it has to come through here.

import { fx, draw } from './ops.js';
import { emit } from './triggers.js';
import { refresh } from './derive.js';
import {
  respawnMage, startUnitTurn, tickPoison, tickBurn, recordHighGround, pendingUnits,
} from './units.js';
import { mageOf } from '../field/query.js';
import { tickFire } from '../field/push.js';

export function beginTurn(state) {
  const p = state.active;
  state.phase = 'unit';
  state.spellActionUsed = false;
  state.bindUsed = false;
  state.tableDirty = [false, false];
  state.fresh = [[], []];
  // Every spell may be rotated once per TURN (ops.ROTATION_CAP); the budget
  // is for both players' tables, since your effects can turn their cards.
  for (let q = 0; q < 2; q++) for (const stack of state.players[q].table) for (const sp of stack) sp.turnsThisTurn = 0;

  const pl = state.players[p];
  // "the mage respawns at its owner's own starting circle at the start of that
  // owner's next turn" -- here, before anything else can happen, so a
  // respawning mage gets its unit action this turn.
  if (pl.mage.respawnOnTurn !== null && pl.mage.respawnOnTurn <= state.turn) respawnMage(state, p);

  startUnitTurn(state, p);
  // Every turn begins with a draw -- except the very first turn of the duel,
  // which is how going first is paid for.
  if (state.turn > 1) draw(state, p, 1);
  refresh(state);
  tickPoison(state, p);
  // A unit set alight (Immolate) burns at the start of its own turns.
  tickBurn(state, p);
  // Whatever is burning bites now, on EVERY turn start -- fire takes no sides.
  tickFire(state);
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
