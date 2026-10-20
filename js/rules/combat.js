// Damage, death and what death costs. Nothing here moves anybody.
//
// Deliberately NOT in units.js. units.js is the action layer (a unit chooses to
// move, strike or summon) and it imports this; the field's push and fall code
// also needs to hurt people, and if damage lived in the action layer that would
// be a cycle. One module that only knows how to take hit points off something
// has no reason to import anything that moves.

import { bump, high } from './ledger.js';
import { fx, destroy, locate, extract, defOf, sweepTable } from './ops.js';
import { emit, replaceEvent } from './triggers.js';
import { awardKill } from './score.js';
import { TIER_CAP } from './golems.js';
import { applyFor } from './keywords.js';
import { shieldOn } from './derive.js';
import { unitKeywords } from '../field/query.js';

/**
 * Take hit points off a unit.
 *
 * Every point of damage in the game funnels through here, including falls, so
 * [Absorb] and any future shield is one replacement handler rather than a
 * clause repeated at each damage site.
 */
/**
 * How many times damage may be redirected before it has to land.
 *
 * Two cards that each push damage onto the other's protector would otherwise
 * hand it back and forth forever. A bound rather than a cleverer rule, because
 * every cleverer rule ("not the same unit", "not the same owner") has a
 * two-card cycle that defeats it.
 */
const MAX_REDIRECT = 3;

export function hurt(state, unit, amount, why = {}, redirects = 0) {
  if (!unit || unit.dead || amount <= 0) return 0;

  // The VICTIM's keywords get a say before the damage lands. [Absorb] takes a
  // point off here, and a derived shield takes another -- both on the way IN,
  // which is the only place that can work, because the alternative is every
  // damage site remembering to ask.
  const soak = applyFor(unitKeywords(state, unit), 'incoming', { amount });
  // A derived shield (Warden Seal) never takes a hit below ONE: it softens,
  // it does not nullify (user: "to a minimum of one"). [Absorb] alone may
  // still soak a single point away.
  const shield = shieldOn(state, unit);
  const shielded = shield > 0 && soak.amount > 0 ? Math.max(1, soak.amount - shield) : soak.amount;
  if (shielded <= 0) { fx(state, 'absorb', { id: unit.id, amount }); return 0; }

  const after = replaceEvent(state, 'afterDamage', {
    targetId: unit.id, amount: shielded, cause: why.cause || 'spell', byP: why.byP ?? null,
  });
  if (!after || after.amount <= 0) { fx(state, 'absorb', { id: unit.id, amount }); return 0; }

  // A replacement may REDIRECT the damage somewhere else. Re-dispatched rather
  // than applied here, so the new target's own keywords and shields get their
  // turn -- a redirect that bypassed [Absorb] on the body it landed on would be
  // a protection that works only when nothing intervenes.
  if (after.targetId !== unit.id && redirects < MAX_REDIRECT) {
    const other = state.field.units.find((u) => u.id === after.targetId);
    if (other && !other.dead) {
      fx(state, 'redirect', { from: unit.id, to: other.id, amount: after.amount });
      return hurt(state, other, after.amount, { ...why, cause: after.cause }, redirects + 1);
    }
  }

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
    // The dead mage's whole spell table goes to the discard (user: "when you
    // die you lose all your spells into your discard that were on your spell
    // table"). QUEUED, not done here: a mage can die in the middle of a chain
    // link resolving a face of that very table, and the board is half-mutated.
    if (state.queue) state.queue.push({ kind: 'sweep', p: victim, seq: ++state.actionSeq });
    else sweepTable(state, victim);
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
