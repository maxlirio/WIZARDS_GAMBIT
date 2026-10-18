// Damage, death and what death costs. Nothing here moves anybody.
//
// Deliberately NOT in units.js. units.js is the action layer (a unit chooses to
// move, strike or summon) and it imports this; the field's push and fall code
// also needs to hurt people, and if damage lived in the action layer that would
// be a cycle. One module that only knows how to take hit points off something
// has no reason to import anything that moves.

import { bump, high } from './ledger.js';
import { fx, destroy, locate, extract, defOf } from './ops.js';
import { emit, replaceEvent } from './triggers.js';
import { awardKill } from './score.js';
import { TIER_CAP } from './golems.js';

/**
 * Take hit points off a unit.
 *
 * Every point of damage in the game funnels through here, including falls, so
 * [Absorb] and any future shield is one replacement handler rather than a
 * clause repeated at each damage site.
 */
export function hurt(state, unit, amount, why = {}) {
  if (!unit || unit.dead || amount <= 0) return 0;
  const after = replaceEvent(state, 'afterDamage', {
    targetId: unit.id, amount, cause: why.cause || 'spell', byP: why.byP ?? null,
  });
  if (!after || after.amount <= 0) { fx(state, 'absorb', { id: unit.id }); return 0; }

  const dealt = after.amount;
  unit.hp -= dealt;
  if (why.byP !== null && why.byP !== undefined) bump(state.players[why.byP].ledger, 'damageDealt', dealt);
  if (why.cause === 'fall') bump(state.players[unit.owner].ledger, 'fallDamage', dealt);
  fx(state, 'damage', { id: unit.id, amount: dealt, cause: after.cause });
  emit(state, 'afterDamage', { id: unit.id, amount: dealt, cause: after.cause, p: unit.owner });

  if (unit.hp <= 0) kill(state, unit, why);
  return dealt;
}

/**
 * A unit dies.
 *
 * The killer is whoever caused it, and that is `why.byP` -- NOT the unit's
 * enemy. A unit shoved off a cliff by its own side's push, or dropped by its
 * own levitation ending, has killed itself, and awarding the points to the
 * other player because "the other player is the enemy" would be a free two VP
 * for standing still.
 */
export function kill(state, unit, why = {}) {
  if (unit.dead) return;
  unit.dead = true;
  unit.hp = 0;
  const victim = unit.owner;
  const killer = why.byP ?? null;

  if (unit.kind === 'mage') {
    bump(state.players[victim].ledger, 'mageDeaths');
    // "the mage respawns at its owner's own starting circle at the start of
    // that owner's next turn." Dying on your OWN turn costs you the turn after
    // next, which is the whole reason walking your mage into a fight is a real
    // decision and not a free trade.
    state.players[victim].mage.respawnOnTurn = state.turn + (state.active === victim ? 2 : 1);
  } else {
    bump(state.players[victim].ledger, 'unitsLost');
    releaseGolemUnit(state, unit);
  }

  fx(state, 'kill', { id: unit.id, victim: unit.kind, p: victim, by: killer });
  emit(state, 'afterKill', { id: unit.id, victim: unit.kind, p: victim, by: killer });

  if (killer !== null && killer !== undefined && killer !== victim) {
    awardKill(state, killer, unit.kind === 'mage' ? 'mage' : 'golem', victim);
  }
  if (unit.kind !== 'mage') checkGolemAttrition(state);
}

/** Take a dead body off its golem card's roster. */
function releaseGolemUnit(state, unit) {
  const pl = state.players[unit.owner];
  for (const g of pl.golems) {
    if (!g) continue;
    const i = g.units.indexOf(unit.id);
    if (i >= 0) g.units.splice(i, 1);
  }
}

/**
 * THE ATTRITION RULE. A golem card that has been deployed at least once and now
 * has no units on the battlefield is destroyed and goes to its owner's discard,
 * freeing the slot.
 *
 * So the tier is a durability budget as much as a unit count: an A-tier golem is
 * one body and then the card is gone, while a C-tier can lose two and keep
 * working. A card that has never deployed is safe in its slot indefinitely,
 * which makes holding one back a real decision rather than a wasted draw.
 *
 * This is exactly the sort of rule that silently stops firing, so playtest.js
 * asserts that no such card survives the end of an action.
 */
export function checkGolemAttrition(state) {
  for (let p = 0; p < 2; p++) {
    const pl = state.players[p];
    for (let s = 0; s < 3; s++) {
      const g = pl.golems[s];
      if (!g || !g.everDeployed || g.units.length) continue;
      pl.golems[s] = null;
      g.slot = null;
      pl.discard.push(g);
      bump(pl.ledger, 'golemCardsLost');
      fx(state, 'golemSpent', { uid: g.uid, p, slot: s });
    }
  }
}

/** How many more units of this golem card may stand on the battlefield. */
export const golemRoom = (state, golemCard) =>
  TIER_CAP[defOf(state, golemCard).tier] - golemCard.units.length;
