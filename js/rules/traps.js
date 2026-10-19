// TRAPS. Concealed cards that react to the opponent.
//
// A trap is a grey card with ONE face, played face down into an empty grey
// corner. It has no corner runes, so it never matches and is never a chain
// neighbour; it cannot be rotated or shifted; its owner may destroy it and an
// enemy "destroy an enemy Spell" may target it (they can see a trap is there,
// not which). The first time its trigger is met DURING THE OPPONENT'S TURN
// it SPRINGS: it is revealed, its reaction resolves at once, and the card
// goes to its owner's discard (ops.springTrap). A trap never springs on its
// owner's own actions.
//
// Two trigger shapes, both already in the engine, and no new event:
//
//   replace.afterDamage   for a reaction that must happen BEFORE the damage
//                         lands. combat.hurt() runs every point of damage
//                         through `replaceEvent` and honours a changed
//                         targetId/amount or a null (prevented). A
//                         replacement is a plain function running
//                         mid-mutation, so it may not ask anything.
//
//   on.afterMove          for a reaction to something that has happened. A
//                         listener only QUEUES; it runs as its own work item
//                         once the move is complete, as a generator that --
//                         here -- never yields.
//
// So every reaction below is written to need NO CHOICE: the nearest unit, the
// acting player's range origin, the enemy mage. That is the design rule for
// any trap added later, and the schema will not let a trap carry an effect,
// a cost or a gate that could want one.
//
// Concealment is a VIEW matter. Both lockstep engines hold the full state and
// hash the `concealed` flag; what the opponent's screen shows is up to it.

import { fx, springTrap } from './ops.js';
import { hurt } from './combat.js';
import { holdUnit } from './units.js';
import { findUnit, mageOf, unitsOf, livingUnits, rangeOrigins, propsOnBoard, surfaceAt } from '../field/query.js';
import { pushAwayFrom, smashProp } from '../field/push.js';
import { propSpec, propR, BODY_R } from '../field/arena.js';
import { bearing, dist2, within, idiv, DIR64, DIR_SCALE } from '../field/fixed.js';

/**
 * Damage that counts as "an enemy Spell would deal damage". A strike is a
 * unit's own blow, an impact or a fall is the arena's doing, fire takes no
 * sides and poison is a condition already on the body. A spell's bolt, a
 * dropped rock, an [Unstable] blast and damage another replacement already
 * redirected are the spell's own.
 */
export const SPELL_CAUSES = Object.freeze(['spell', 'rock', 'unstable', 'redirected']);

/** The common guard: it is the opponent's turn and the opponent is acting. */
const enemyActing = (state, p, byP) => state.active === 1 - p && byP === 1 - p;

/* ------------------------------------------------------------ Earth Wall */

/** The earth wall stands this far in front of the victim, toward the source. */
const WALL_STANDOFF = BODY_R + 700 + 50;

/**
 * Where the dirt can heave up: on the line from the victim toward the damage
 * source, one body-width in front of the victim, or the nearest free spot
 * to that on a short bounded search (further out, then a little to either
 * side). Null if nowhere is free -- the trap still springs and the damage is
 * simply prevented.
 */
export function earthWallSpot(state, victim, source) {
  const r = propSpec('earthwall').r;
  const d0 = bearing(victim.x, victim.y, source.x, source.y);
  const free = (x, y) => {
    const a = state.arena;
    if (x < r || y < r || x > a.w - r || y > a.h - r) return false;
    for (const u of livingUnits(state)) if (dist2(u.x, u.y, x, y) <= (r + BODY_R) ** 2) return false;
    for (const pr of propsOnBoard(state)) if (dist2(pr.x, pr.y, x, y) <= (r + propR(pr)) ** 2) return false;
    return true;
  };
  for (const dist of [WALL_STANDOFF, WALL_STANDOFF + 300, WALL_STANDOFF + 600]) {
    for (const off of [0, 6, -6, 12, -12]) {
      const [ux, uy] = DIR64[(d0 + off + 64) & 63];
      const x = victim.x + idiv(ux * dist, DIR_SCALE), y = victim.y + idiv(uy * dist, DIR_SCALE);
      if (free(x, y)) return { x, y };
    }
  }
  return null;
}

/** Heave a wall of earth out of the ground at a point. Named, so it can be smashed. */
export function raiseEarthWall(state, x, y, { byP = null } = {}) {
  const f = state.field;
  f.nextPropId = (f.nextPropId ?? f.props.length) + 1;
  const s = surfaceAt(state, x, y);
  const pr = {
    id: `e${f.nextPropId}`, kind: 'earthwall', x, y, z: s.z,
    removedUntil: null, body: 'prop', support: s.support, raised: true,
    hp: propSpec('earthwall').hp, burning: null, litBy: null, destroyed: false,
  };
  f.props.push(pr);
  fx(state, 'raiseWall', { id: pr.id, at: { x, y, z: s.z }, prop: 'earthwall', p: byP });
  return pr;
}

/**
 * TRAP: when an enemy Spell would damage your unit, dirt heaves into a wall
 * between them; the wall takes the damage.
 */
export const trapEarthWall = () => ({
  tag: 'move',
  replace: {
    afterDamage: ({ state, spell, p }, payload) => {
      if (!enemyActing(state, p, payload.byP) || !SPELL_CAUSES.includes(payload.cause)) return payload;
      const victim = findUnit(state, payload.targetId);
      if (!victim || victim.dead || victim.owner !== p) return payload;
      // Sprung first, so the wall's own consequences (a shatter, a fall) see a
      // table without the trap on it and cannot spring it twice.
      springTrap(state, spell.uid);
      const source = rangeOrigins(state, 1 - p)[0] || mageOf(state, 1 - p);
      const spot = source && !source.dead ? earthWallSpot(state, victim, source) : null;
      if (spot) {
        const wall = raiseEarthWall(state, spot.x, spot.y, { byP: p });
        smashProp(state, wall, payload.amount, { byP: payload.byP, cause: 'spell' });
      }
      return null;              // the unit takes nothing
    },
  },
});

/* ------------------------------------------------------------ Backlash */

/** Damage that counts as "you are attacked": a Spell's own damage or a unit's strike. */
export const ATTACK_CAUSES = Object.freeze([...SPELL_CAUSES, 'strike']);

/**
 * TRAP: when an enemy Spell or unit would damage your unit, the enemy mage
 * takes 1 damage. The hit still lands -- this trap punishes, it does not
 * protect (Mirror Ward, which it replaced, bounced the whole blast back and
 * was worth far more than Earth Wall). If the enemy mage is dead, nothing is
 * punished and the trap still springs.
 */
export const trapBacklash = ({ amount = 1 } = {}) => ({
  tag: 'break',
  replace: {
    afterDamage: ({ state, spell, p }, payload) => {
      if (!enemyActing(state, p, payload.byP) || !ATTACK_CAUSES.includes(payload.cause)) return payload;
      const victim = findUnit(state, payload.targetId);
      if (!victim || victim.dead || victim.owner !== p) return payload;
      // Sprung first, so the mage's own wound cannot spring it again.
      springTrap(state, spell.uid);
      const foe = mageOf(state, 1 - p);
      if (foe && !foe.dead) {
        fx(state, 'backlash', { id: foe.id, victim: victim.id, amount, p });
        hurt(state, foe, amount, { cause: 'spell', byP: p });
      }
      return payload;           // the hit still lands
    },
  },
});

/* ------------------------------------------------------------ Snare */

/**
 * TRAP: when an enemy unit ends a move within 2m of your mage, it is snared:
 * 1 damage, and it loses its next action.
 */
export const trapSnare = ({ range = 2000, amount = 1 } = {}) => ({
  tag: 'break',
  on: {
    afterMove: function* (ctx, payload) {
      const { state, p } = ctx;
      if (!enemyActing(state, p, payload.p)) return;
      const mover = findUnit(state, payload.id);
      const mage = mageOf(state, p);
      if (!mover || mover.dead || mover.owner !== 1 - p || !mage || mage.dead) return;
      if (!within(mover, mage, range)) return;
      springTrap(state, ctx.spell.uid);
      fx(state, 'snared', { id: mover.id, p });
      holdUnit(state, mover);
      hurt(state, mover, amount, { cause: 'spell', byP: p });
    },
  },
});

/* ------------------------------------------------------------ Spring Trap */

/**
 * TRAP: when an enemy unit ends a move within 1.5m of one of your units, it is
 * flung away from that unit with force 4.
 */
export const trapSpring = ({ range = 1500, force = 4 } = {}) => ({
  tag: 'move',
  on: {
    afterMove: function* (ctx, payload) {
      const { state, p } = ctx;
      if (!enemyActing(state, p, payload.p)) return;
      const mover = findUnit(state, payload.id);
      if (!mover || mover.dead || mover.owner !== 1 - p) return;
      // The NEAREST of your units, ties by id: no choice to make.
      let near = null, best = range * range + 1;
      for (const u of unitsOf(state, p)) {
        const d = dist2(u.x, u.y, mover.x, mover.y);
        if (d <= range * range && d < best) { near = u; best = d; }
      }
      if (!near) return;
      springTrap(state, ctx.spell.uid);
      fx(state, 'sprung', { id: mover.id, from: near.id, p });
      pushAwayFrom(state, mover, near.x, near.y, force, { byP: p });
    },
  },
});
