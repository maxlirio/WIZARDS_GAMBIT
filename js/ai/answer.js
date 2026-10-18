// Answering the engine's questions.
//
// Half the real decisions in this game are ANSWERS, not actions: which junction
// resonates first, which of the matched cards turns, which keyword to copy, which
// way to shove somebody. A search that stops at the first question is blind to
// the part of the turn a good player actually agonises over.
//
// So answers get the same one-ply treatment as actions. Inside a rollout they
// are picked heuristically, because a search that searched its own rollouts
// would be exponential in the length of a chain, and chains go twelve links.

import { cloneState, choose, legalActions } from '../engine.js';
import { evaluate } from './eval.js';
import { int } from '../rules/rng.js';

/** Every answer worth trying for a request. Bounded, and in a fixed order. */
export function candidates(request, limit = 10) {
  if (request.type === 'confirm') return [true, false];
  if (request.type === 'some') {
    const out = [];
    const n = request.count;
    // Every subset is 2^k, so take the prefixes of a few rotations of the
    // option list instead: enough variety to matter, bounded by `limit`.
    for (let off = 0; off < Math.min(limit, request.options.length || 1); off++) {
      const rot = [...request.options.slice(off), ...request.options.slice(0, off)];
      out.push(rot.slice(0, n));
    }
    return out.length ? out : [[]];
  }
  const opts = [...request.options];
  if (request.allowNone) opts.push(null);
  return opts.slice(0, limit);
}

/** The heuristic used INSIDE a rollout: cheap, deterministic, never searches. */
export function quickAnswer(state, request, rng) {
  if (request.type === 'confirm') return true;
  if (request.type === 'some') return request.options.slice(0, request.count);
  if (!request.options || !request.options.length) return null;
  // The first option, not a random one. A rollout whose answers were random
  // would make the same candidate action score differently on every call, and
  // a one-ply search over a noisy evaluation picks noise.
  return request.options[0];
}

/**
 * Run a cloned state forward until it needs a real decision again.
 *
 * `p` is whose rollout this is, but the questions may belong to either player
 * -- a chain on your turn is yours to answer, and nothing in this game asks the
 * opponent anything mid-chain, so the heuristic answers all of them.
 */
export function settle(state, rng, limit = 200) {
  for (let i = 0; i < limit && state.pending; i++) {
    choose(state, quickAnswer(state, state.pending.request, rng));
  }
  return state;
}

/** One-ply over the outstanding question. */
export function chooseAnswer(state, p, rng) {
  const request = state.pending.request;
  const opts = candidates(request);
  if (opts.length <= 1) return opts[0] ?? null;

  let best = opts[0], bestScore = -Infinity;
  for (const a of opts) {
    const c = cloneState(state);
    try {
      choose(c, a);
      settle(c, rng);
    } catch (e) {
      continue;                       // an answer the engine refuses is not one
    }
    const sc = evaluate(c, p);
    if (sc > bestScore) { bestScore = sc; best = a; }
  }
  return best;
}
