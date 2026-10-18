// Replay a recorded move list and return the hash after every step.
//
// Its own module, for the same reason tools/fieldscript.js is: checklockstep.js
// runs it in a second node process, and a child that imported the harness would
// re-run the harness, which spawns another child.

import { createGame, legalActions, apply, choose, hashState } from '../js/engine.js';

/**
 * `moves` is a flat list of `{a: action}` and `{c: answer}` entries -- exactly
 * what crosses the wire in a lockstep game, and nothing else. No state, no
 * hashes, no derived anything: if the two engines agree on the rules, the move
 * list is enough.
 */
export function replay(setup, moves) {
  const state = createGame(setup);
  const hashes = [hashState(state)];
  for (const m of moves) {
    if ('a' in m) apply(state, m.a);
    else choose(state, m.c);
    hashes.push(hashState(state));
  }
  return { state, hashes, final: hashState(state) };
}
