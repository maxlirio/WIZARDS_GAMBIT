// Position evaluation. One number, from the point of view of one player.
//
// The features are chosen around one observation: THE CHAIN IS THE GAME. A bot
// that evaluates only the board it can see plays this like a worse version of
// a card game, because the whole point of a turn is what the NEXT perturbation
// will set off. So `matchPotential` is a first-class term, not a tiebreak.
//
// The other deliberate feature is `exposure`, which counts the VP the OPPONENT
// would collect for killing your units. Without it a bot treats its own mage
// as a thing to be kept alive, when mechanically the mage is a 2 VP gift it is
// carrying around -- and the design wants that tension measured, not assumed.

import { spellsOn, defOf, topOf, canTurn } from '../rules/ops.js';
import { MATCH_SITES, VERTEX_CARDS, INTERIOR_SITES, CELL_COLOR } from '../rules/table.js';
import { activeIndex } from '../rules/orient.js';
import { runeAtCorner, findMatches } from '../rules/match.js';
import { keywordsOf } from '../rules/keywords.js';
import { gateProgress, gateMet } from '../rules/gates.js';
import { objectiveVp } from '../rules/objectives.js';
import { vpConfig } from '../rules/score.js';
import { unitsOf, enemiesOf, livingUnits, mageOf, onHighGround, rangeOrigins } from '../field/query.js';
import { dist3, isqrt, idiv } from '../field/fixed.js';
import { heightAt } from '../field/arena.js';

export const WEIGHTS = Object.freeze({
  vp: 100,
  vpRamp: 40,           // extra per point once either side is past 11
  matchLive: 14,        // a junction that would match RIGHT NOW
  matchInterior: 6,     // and a bonus if it is a four-card junction
  matchLatent: 3,       // one rotation away from matching
  goldReady: 22,        // a gold objective whose gate is met and whose VP is real
  goldProgress: 8,      // per unit of 0..1 progress toward one
  development: 9,       // a spell of yours in play
  developmentGold: 4,   // and a little more if it is gold
  hand: 3,
  deck: 1,
  keyword: 4,
  unitHp: 5,
  unitAlive: 12,
  mageAlive: 20,
  height: 6,
  exposure: -26,        // VP the opponent would collect for killing your units
  golemCard: 7,
  golemSpent: -5,
});

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * How much the spell table is primed to go off.
 *
 * Two terms. LIVE junctions are matching now, so the next action that checks
 * matches fires them. LATENT junctions would match if one of their cards turned
 * one step, which is what makes a rotate worth playing toward. Without the
 * second term the bot cannot see a combo one move away and plays every card as
 * if the table were static.
 */
export function matchPotential(state, p) {
  let score = 0;
  const live = findMatches(state, p, []);
  for (const h of live) score += WEIGHTS.matchLive + (h.interior ? WEIGHTS.matchInterior : 0);

  const liveSet = new Set(live.map((h) => h.vertex));
  for (const v of MATCH_SITES) {
    if (liveSet.has(v)) continue;
    const here = [];
    for (const { cell, pos } of VERTEX_CARDS[v]) {
      const sp = topOf(state, p, cell);
      if (sp) here.push({ sp, pos });
    }
    if (here.length < 2) continue;
    // Would one left turn of one of these cards make this junction match?
    for (const x of here) {
      if (!canTurn(state, x.sp)) continue;
      const after = { ...x.sp, rot: (x.sp.rot + 1) & 3 };
      const r = runeAtCorner(state, after, x.pos);
      if (here.some((y) => y.sp.uid !== x.sp.uid && runeAtCorner(state, y.sp, y.pos) === r)) {
        score += WEIGHTS.matchLatent;
        break;
      }
    }
  }
  return score;
}

/** Gold readiness: what is scoreable now, and how close the rest is. */
export function goldOutlook(state, p) {
  let score = 0;
  for (const sp of spellsOn(state, p)) {
    const def = defOf(state, sp);
    if (def.school !== 'gold') continue;
    for (const face of def.faces) {
      const obj = face.objective;
      if (!obj) continue;
      const vp = objectiveVp(state, sp, obj);
      if (vp <= 0) continue;
      const met = !obj.gate || gateMet(state, sp, obj.gate);
      // A face that is up NOW is worth much more than one three rotations away:
      // a match rotates LEFT, so the distance to a face is how many links of
      // chain you need to reach it.
      const away = (face.index - activeIndex(sp) + 4) % 4;
      const reach = 1 / (1 + away);
      if (met) score += WEIGHTS.goldReady * vp * reach;
      else score += WEIGHTS.goldProgress * (gateProgress(state, sp, obj.gate) / 100) * vp * reach;
    }
  }
  return score;
}

/** What the enemy would be paid for killing what you have on the field. */
export function exposure(state, p) {
  const cfg = vpConfig(state);
  const foes = enemiesOf(state, p);
  let vp = 0;
  for (const u of unitsOf(state, p)) {
    const worth = u.kind === 'mage' ? cfg.mage : cfg.golemUnit;
    // Weighted by how reachable it is: a mage standing next to the enemy mage
    // is nearly a gift, one on the far side of the arena is not.
    let near = 0;
    for (const f of foes) {
      const d = isqrt(dist3(f, u, 1));
      const reach = f.move + f.reach;
      if (d <= reach) near = Math.max(near, 1);
      else near = Math.max(near, clamp01((reach * 2 - d) / reach));
    }
    const frail = clamp01((u.maxHp - u.hp + 1) / u.maxHp);
    vp += worth * near * (0.4 + 0.6 * frail);
  }
  return vp;
}

export function evaluate(state, p) {
  const foe = 1 - p;
  const cfg = vpConfig(state);
  if (state.winner === p) return 1e9;
  if (state.winner === foe) return -1e9;

  let s = 0;
  s += WEIGHTS.vp * (state.vp[p] - state.vp[foe]);
  // The race tightens at the end: a point at 13 is worth more than a point at
  // 3, in both directions, and a bot without this term trades away a lead.
  const ramp = (v) => Math.max(0, v - 11);
  s += WEIGHTS.vpRamp * (ramp(state.vp[p]) - ramp(state.vp[foe]));

  s += matchPotential(state, p) - matchPotential(state, foe);
  s += goldOutlook(state, p) - goldOutlook(state, foe);

  for (const q of [p, foe]) {
    const sign = q === p ? 1 : -1;
    const pl = state.players[q];
    for (const sp of spellsOn(state, q)) {
      s += sign * (WEIGHTS.development + (defOf(state, sp).school === 'gold' ? WEIGHTS.developmentGold : 0));
      s += sign * WEIGHTS.keyword * keywordsOf(state, sp).length;
    }
    s += sign * WEIGHTS.hand * pl.hand.length;
    s += sign * WEIGHTS.deck * pl.deck.length;
    for (const g of pl.golems) {
      if (!g) continue;
      s += sign * WEIGHTS.golemCard;
      // A deployed card with one body left is one death from being spent.
      if (g.everDeployed && g.units.length <= 1) s += sign * WEIGHTS.golemSpent;
    }
    for (const u of unitsOf(state, q)) {
      s += sign * (WEIGHTS.unitAlive + (u.kind === 'mage' ? WEIGHTS.mageAlive : 0));
      s += sign * WEIGHTS.unitHp * u.hp;
      if (onHighGround(state, u)) s += sign * WEIGHTS.height;
    }
  }

  s += WEIGHTS.exposure * (exposure(state, p) - exposure(state, foe));
  return s;
}
