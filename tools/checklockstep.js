#!/usr/bin/env node
// Two engines, the same ordered moves, the same hash after EVERY move.
//
//   node tools/checklockstep.js [--games N] [--seed S] [--pool]
//
// A desync is the worst bug class this project can ship, because it is invisible
// until it is catastrophic: both machines play on happily, diverge by one
// millimetre or one Set iteration order, and forty moves later one of them
// thinks a card is somewhere the other does not. No behavioural harness notices,
// because each engine is individually correct.
//
// Three comparisons, in increasing strength:
//
//   SAME PROCESS. A fresh engine fed the recorded move list must match hash for
//   hash. Catches anything that depends on state left over from a previous game
//   -- a module-scope counter, a cached Map, a uid allocated outside the state.
//
//   MID-GAME CLONE. `cloneState` at a random point, then both copies fed the
//   rest of the moves. Catches anything the clone fails to carry, which is the
//   failure mode the AI's one-ply search would hit on every single evaluation.
//
//   SEPARATE PROCESS. The same move list replayed by a different node process.
//   The weakest guarantee of real engine independence available without a second
//   machine, and the one that would catch a Math.sqrt that got past the grep.
//
// The hash deliberately EXCLUDES `fx` -- the notes for the view -- because two
// engines that agree about the game must not be able to disagree about the hash
// just because one of them rendered.

import { execFileSync } from 'node:child_process';
import { createGame, legalActions, apply, choose, hashState, cloneState } from '../js/engine.js';
import { chooseAction, answerFor } from '../js/ai/ai.js';
import { randomDeck } from '../js/rules/spells/index.js';
import { seedRng, int, pick } from '../js/rules/rng.js';
import { replay } from './replay.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const GAMES = arg('games', 60);
const SEED0 = arg('seed', 1);
const POOL = flag('pool');
const CHILD_GAMES = arg('child', 6);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${msg}`); } };

/** Play one game with the AI, recording the move list and the hash trail. */
function record(setup, policy) {
  const state = createGame(setup);
  const moves = [];
  const hashes = [hashState(state)];
  let steps = 0;
  while (state.winner === null && steps < 6000) {
    steps++;
    if (state.pending) {
      const c = answerFor(state, { policy });
      moves.push({ c });
      choose(state, c);
    } else {
      const a = chooseAction(state, { policy });
      if (!a) break;
      moves.push({ a });
      apply(state, a);
    }
    hashes.push(hashState(state));
  }
  return { state, moves, hashes };
}

const setups = [];
for (let g = 0; g < GAMES; g++) {
  const seed = SEED0 + g;
  const rng = seedRng(seed ^ 0xbeef);
  setups.push({ seed, decks: POOL ? [randomDeck(rng, pick), randomDeck(rng, pick)] : null });
}

let desyncs = 0, cloneDesyncs = 0, totalMoves = 0, finished = 0;
const records = [];

for (let g = 0; g < setups.length; g++) {
  const setup = setups[g];
  const policy = g % 3 === 0 ? 'oneply' : g % 3 === 1 ? 'greedy' : 'random';
  let rec;
  try { rec = record(setup, policy); }
  catch (e) { fail++; console.log(`  FAIL seed ${setup.seed}: ${e.message}`); continue; }
  totalMoves += rec.moves.length;
  if (rec.state.winner !== null) finished++;
  records.push({ setup, rec, policy });

  /* ------------------------------------------------- 1. same process */
  let r2;
  try { r2 = replay(setup, rec.moves); }
  catch (e) { desyncs++; console.log(`  FAIL seed ${setup.seed}: the replay threw at some point: ${e.message}`); continue; }
  let first = -1;
  for (let i = 0; i < rec.hashes.length; i++) {
    if (rec.hashes[i] !== r2.hashes[i]) { first = i; break; }
  }
  if (first >= 0) {
    desyncs++;
    const m = rec.moves[first - 1];
    console.log(`  FAIL seed ${setup.seed} (${policy}): diverged at move ${first} of ${rec.moves.length}`);
    console.log(`       the move was ${JSON.stringify(m)}`);
    console.log(`       ${rec.hashes[first]} vs ${r2.hashes[first]}`);
  }

  /* --------------------------------------------- 2. mid-game clone */
  // The AI clones a live state on EVERY candidate action it considers, so a
  // clone that fails to carry something is not a rare bug, it is every
  // evaluation the bot ever makes.
  if (rec.moves.length > 6) {
    const cut = 1 + int(seedRng(setup.seed), rec.moves.length - 2);
    const live = createGame(setup);
    for (let i = 0; i < cut; i++) {
      const m = rec.moves[i];
      if ('a' in m) apply(live, m.a); else choose(live, m.c);
    }
    const copy = cloneState(live);
    if (hashState(copy) !== hashState(live)) {
      cloneDesyncs++;
      console.log(`  FAIL seed ${setup.seed}: cloneState changed the hash at move ${cut}`);
    } else {
      // Both carry on from here and must stay together.
      let diverged = -1;
      for (let i = cut; i < rec.moves.length; i++) {
        const m = rec.moves[i];
        try {
          if ('a' in m) { apply(live, m.a); apply(copy, m.a); }
          else { choose(live, m.c); choose(copy, m.c); }
        } catch (e) { diverged = i; break; }
        if (hashState(live) !== hashState(copy)) { diverged = i; break; }
      }
      if (diverged >= 0) {
        cloneDesyncs++;
        console.log(`  FAIL seed ${setup.seed}: a clone taken at move ${cut} diverged at move ${diverged}`);
      }
    }
  }
}

ok(desyncs === 0, `${desyncs}/${setups.length} games desynced on replay`);
ok(cloneDesyncs === 0, `${cloneDesyncs}/${setups.length} games desynced after a mid-game clone`);
console.log(`same process         ${setups.length} games, ${totalMoves} moves, ${setups.length - desyncs} identical`);
console.log(`mid-game clone       ${setups.length - cloneDesyncs}/${setups.length} clones stayed in step`);

/* ------------------------------------------------- 3. separate process */
{
  const here = new URL('./replay.js', import.meta.url).pathname;
  const batch = records.slice(0, CHILD_GAMES);
  if (batch.length) {
    const payload = JSON.stringify(batch.map(({ setup, rec }) => ({ setup, moves: rec.moves })));
    let theirs;
    try {
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { replay } from ${JSON.stringify(here)};
        const jobs = JSON.parse(process.env.WG_JOBS);
        console.log(JSON.stringify(jobs.map((j) => replay(j.setup, j.moves).hashes)));
      `], { encoding: 'utf8', env: { ...process.env, WG_JOBS: payload }, maxBuffer: 64 * 1024 * 1024 });
      theirs = JSON.parse(out.trim().split('\n').pop());
    } catch (e) {
      fail++;
      console.log(`  FAIL the child process could not replay: ${(e.stderr || e.message || '').toString().slice(0, 400)}`);
      theirs = null;
    }
    if (theirs) {
      let bad = 0;
      for (let i = 0; i < batch.length; i++) {
        const mine = batch[i].rec.hashes;
        for (let k = 0; k < mine.length; k++) {
          if (mine[k] !== theirs[i][k]) {
            bad++;
            console.log(`  FAIL seed ${batch[i].setup.seed}: a separate process diverged at move ${k}`);
            break;
          }
        }
      }
      ok(bad === 0, `${bad}/${batch.length} games differed across processes`);
      console.log(`separate process     ${batch.length - bad}/${batch.length} games identical in a second node process`);
    }
  }
}

console.log(`\ngames that finished  ${finished}/${setups.length}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
