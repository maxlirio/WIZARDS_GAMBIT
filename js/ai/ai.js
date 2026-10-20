// The opponent. Three files, one ply, and it cannot cheat.
//
// It enumerates with the ENGINE'S OWN legalActions and answers through the
// engine's own choose. That is not a convenience, it is the only way to be sure
// the bot is playing the same game: a second copy of the legality rules inside
// the AI is a second copy that will disagree, and the disagreement shows up as
// a bot that plays an illegal line and wins with it.
//
// ONE PLY, BUT THE WHOLE CHAIN. For each candidate action: clone, apply, then
// drive every resulting question to completion and evaluate the position that
// comes out. Evaluating the state right after `apply` would be evaluating a
// board in the middle of a cascade -- which is to say, a board that will never
// exist.
//
// Its dice come from (state.seed, ply), NEVER from state.rng. If deliberation
// consumed the game's randomness, then one side thinking harder than the other
// would desync a lockstep game, and the bug would look like a netcode bug.

import { legalActions, apply, cloneState } from '../engine.js';
import { evaluate } from './eval.js';
import { settle, chooseAnswer, quickAnswer } from './answer.js';
import { seedRng, int, shuffle } from '../rules/rng.js';
import { bindActions } from '../rules/sigils.js';

/** How many sigils the bot walks in knowing. A player learns theirs across duels; the bot is handed a few. */
export const AI_KNOWN_SIGILS = 10;

export const POLICIES = Object.freeze(['oneply', 'greedy', 'random']);

export function aiRng(state) {
  return seedRng(((state.seed | 0) * 1103515245 + state.actionSeq * 12345) | 0);
}

/**
 * Pick an action.
 *
 * `policy` exists so selfplay.js can measure one against another. 'greedy'
 * evaluates the board straight after the action without driving the chain,
 * which is the specific mistake worth having a baseline for: if 'oneply' does
 * not beat it, the chain terms in the evaluator are not earning their keep.
 */
/**
 * The sigils this seat KNOWS: a fixed handful dealt from the match's seed,
 * never the whole book. A bot that bound every sigil it could afford would be
 * reading the Spellbook's answers; a human finds them one duel at a time.
 */
export function knownSigils(state, p) {
  const ids = (state.findable || []).filter((f) => f.sigil).map((f) => f.id).sort();
  const rng = seedRng(((state.seed | 0) * 2654435761 + (p + 1) * 40503) | 0);
  return new Set(shuffle(rng, ids).slice(0, AI_KNOWN_SIGILS));
}

export function chooseAction(state, { policy = 'oneply', budget = 64 } = {}) {
  const p = state.active;
  const rng = aiRng(state);
  // A bind is free and never costs the turn anything, so a known sigil the
  // pouch can pay for is simply made, before the real decision.
  if (!state.bindUsed) {
    const known = knownSigils(state, p);
    const b = bindActions(state, p).find((a) => known.has(a.id));
    if (b) return b;
  }
  const la = legalActions(state);
  if (!la.length) return null;
  if (policy === 'random') return la[int(rng, la.length)];

  const tried = la.length <= budget ? la : trim(la, budget, rng);
  let best = tried[0], bestScore = -Infinity;
  for (const a of tried) {
    const c = cloneState(state);
    try {
      apply(c, a);
      if (policy === 'oneply') settle(c, rng);
    } catch (e) {
      continue;
    }
    const sc = evaluate(c, p);
    if (sc > bestScore) { bestScore = sc; best = a; }
  }
  return best;
}

/**
 * Keep the branching bounded without throwing away a kind of move.
 *
 * Shifts explode -- every spell times every neighbour -- so a naive cut by
 * array order drops `draw` and every unit action off the end of the list. This
 * keeps at least a few of each action type, then fills up.
 */
function trim(la, budget, rng) {
  const byType = new Map();
  for (const a of la) {
    const k = `${a.type}${a.act || ''}`;
    if (!byType.has(k)) byType.set(k, []);
    byType.get(k).push(a);
  }
  const keys = [...byType.keys()].sort();
  const out = [];
  const perType = Math.max(2, Math.floor(budget / keys.length));
  for (const k of keys) out.push(...byType.get(k).slice(0, perType));
  for (const k of keys) {
    for (const a of byType.get(k).slice(perType)) { if (out.length >= budget) break; out.push(a); }
  }
  return out;
}

/** Answer the outstanding question. The decisions a chain asks are the game. */
export function answerFor(state, { policy = 'oneply' } = {}) {
  const rng = aiRng(state);
  const request = state.pending.request;
  if (policy === 'random') {
    if (request.type === 'confirm') return int(rng, 2) === 1;
    if (request.type === 'some') return request.options.slice(0, request.count);
    return request.options.length ? request.options[int(rng, request.options.length)] : null;
  }
  if (policy === 'greedy') return quickAnswer(state, request, rng);
  return chooseAnswer(state, state.pending.request.player ?? state.active, rng);
}
