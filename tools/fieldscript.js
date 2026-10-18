// One scripted exercise of every field code path, as a PURE FUNCTION OF A SEED.
//
// In its own module on purpose. tools/checkfield.js runs this in a second node
// process and compares hashes, and a child that imported the harness would
// re-run the harness's top level -- which spawns another child, which spawns
// another. The first version of this did exactly that and had to be killed.
//
// Pure in the seed is the other half of the contract: if the script itself
// varied, the comparison would be testing the script instead of the engine.

import { createGame, hashField } from '../js/engine.js';
import { livingUnits, propsOnBoard } from '../js/field/query.js';
import { walk, resolveFalls, recheckSupport } from '../js/field/move.js';
import { push, levitate, removeTerrain } from '../js/field/push.js';
import { hurt } from '../js/rules/combat.js';

export function exercise(seed) {
  const state = createGame({ seed, decks: [[], []], findable: [] });
  const log = [];
  const bodies = () => [...livingUnits(state)].sort((a, b) => a.id - b.id);
  const props = () => [...propsOnBoard(state)].sort((a, b) => (a.id < b.id ? -1 : 1));

  // Walk both mages a fixed circuit, push everything pushable, drop a
  // levitated rock and remove a terrain piece: every path, in a fixed order.
  for (const d of [0, 8, 16, 24, 32, 40, 48, 56]) {
    for (const u of bodies()) {
      const r = walk(state, u, d, 1200, { allowFall: false, climb: true });
      log.push(`w${u.id}d${d}:${r.mm}:${u.x},${u.y},${u.z}`);
    }
  }
  for (const pr of props()) {
    const r = push(state, pr, 0, 1500, { byP: 0 });
    log.push(`p${pr.id}:${r.mm}:${pr.x},${pr.y},${pr.z}`);
  }
  for (const u of bodies()) {
    const r = push(state, u, 48, 2500, { byP: 1, crush: true });
    log.push(`u${u.id}:${r.mm}:${u.x},${u.y},${u.z}:${u.hp}`);
  }
  const first = props()[0];
  if (first) { levitate(state, first, 1500); log.push(`lev:${first.z}`); }
  const second = props()[1];
  if (second) { removeTerrain(state, second, state.turn); log.push(`rm:${second.id}`); }
  recheckSupport(state);
  resolveFalls(state, hurt);
  log.push(`falls:${state.field.pendingFalls.length}`);
  return { state, log, hash: hashField(state) };
}
