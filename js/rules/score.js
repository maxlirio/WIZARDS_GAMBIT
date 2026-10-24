// Victory points. `award` is the ONLY way state.vp ever changes.
//
// Same discipline as ops being the only way a card moves, and for the same
// reason: the total, the per-source ledger counters and the append-only log are
// one fact recorded three times, and the moment there are two places that can
// add a point they will disagree. The harness re-sums `scoreLog`
// INDEPENDENTLY and compares -- which is only a real check because nothing can
// bypass this function.

import { bump } from './ledger.js';
import { fx } from './ops.js';
import { emit } from './triggers.js';

export const VP_DEFAULTS = Object.freeze({
  target: 15,
  mage: 2,          // killing the enemy mage
  /**
   * Killing an enemy golem unit, BY TIER. User (2026-10-24): "golems like
   * clay hands are buns and the only reason you would ever play them is for
   * your opponent to farm them." So the swarm is worth nothing to kill, a
   * B-tier body is worth one, and the one giant is worth two -- a prize
   * because it is dangerous, not because it was cheap to put out.
   */
  golemByTier: Object.freeze({ C: 0, B: 1, A: 2 }),
  /**
   * Diminishing returns on repeatedly killing the same mage.
   *
   * Zero by default, because feeding your own mage to the enemy IS a legitimate
   * strategy and the design would rather measure it than guess at it. Three
   * structural pressures already push back: a dead mage costs you a whole unit
   * phase, it is the range origin for most red faces so losing it strands your
   * attack, and your golems feed the opponent too. tools/selfplay.js reports VP
   * from kills against VP from objectives per policy; if kills dominate, this
   * is the knob, and it is a knob rather than a rule because nobody knows yet.
   */
  mageVpDecay: 0,
});

export const vpConfig = (state) => state.config?.vp || VP_DEFAULTS;

/**
 * The once-only key for a scoring event.
 *
 * A gold objective is REPEATABLE, but scoring destroys the gold spell and sends
 * it to your discard, so you have to draw and replay it. `plays` counts how
 * many times this very card has been played, so the same uid coming back out of
 * the discard is a genuinely new opportunity while a face resolving twice
 * within one playing is not.
 */
export const stampOf = (spell, objId) => `${objId}@${spell.uid}#${spell.plays || 0}`;

/** Has this objective already paid out for this playing of this spell? */
export const alreadyScored = (state, p, spell, objId) =>
  !!state.players[p].objectives[stampOf(spell, objId)];

export function award(state, p, amount, source = {}) {
  if (!Number.isInteger(amount)) throw new Error(`VP must be an integer, got ${amount}`);
  if (amount <= 0) return 0;
  if (state.winner !== null) return 0;

  if (source.kind === 'objective') {
    if (!source.stamp) throw new Error('an objective award needs a stamp');
    if (state.players[p].objectives[source.stamp]) return 0;
    state.players[p].objectives[source.stamp] = { turn: state.turn, amount };
  }

  state.vp[p] += amount;
  state.scoreLog.push({
    p, amount, kind: source.kind || 'other', objId: source.objId || null,
    uid: source.uid ?? null, turn: state.turn, seq: ++state.actionSeq,
  });

  const L = state.players[p].ledger;
  if (source.kind === 'objective') { bump(L, 'objectivesScored'); bump(L, 'vpFromObjectives', amount); }
  else bump(L, 'vpFromKills', amount);

  fx(state, 'score', { p, amount, source: source.kind || 'other' });
  emit(state, 'afterScore', { p, amount, source: source.kind || 'other', objId: source.objId || null });

  // Checked HERE rather than at end of turn, so 15 VP landing in the middle of a
  // chain ends the game at that point. The chain loop reads state.winner and
  // stops; nothing after the winning point resolves.
  if (state.vp[p] >= vpConfig(state).target) {
    state.winner = p;
    state.reason = 'victory points';
    fx(state, 'win', { p, reason: state.reason });
  }
  return amount;
}

/** VP for a kill, with the mage's decay applied. Routed through `award`. */
export function awardKill(state, killer, victimKind, victimOwner, victim = null) {
  const cfg = vpConfig(state);
  const L = state.players[victimOwner].ledger;
  if (victimKind === 'mage') {
    const n = L.mageDeaths;              // already incremented by units.js
    const amount = Math.max(1, cfg.mage - cfg.mageVpDecay * Math.max(0, n - 1));
    bump(state.players[killer].ledger, 'magesKilled');
    return award(state, killer, amount, { kind: 'mage' });
  }
  bump(state.players[killer].ledger, 'golemsKilled');
  const amount = golemWorth(state, victim);
  // A kill worth nothing is still a kill (the ledger counts it for Reckoning),
  // but it writes no VP entry: the score log is for points that were scored.
  if (amount <= 0) return 0;
  return award(state, killer, amount, { kind: 'golem' });
}

/** What killing this golem unit pays, by its card's tier. */
export function golemWorth(state, unit) {
  const cfg = vpConfig(state);
  const tier = unit?.def ? state.defs[unit.def]?.tier : null;
  return cfg.golemByTier[tier] ?? 0;
}
