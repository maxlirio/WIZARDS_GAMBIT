#!/usr/bin/env node
// Play whole matches with random legal actions and random answers, and check
// every invariant after EVERY decision.
//
//   node tools/playtest.js [--games N] [--seed S] [--cap T] [--verbose]
//
// This is the harness that finds real bugs. Unit tests never found one of the
// real bugs in GUDNAK: the failures are all in the interaction between a chain,
// a replayed question and a board that moved in between, and that only happens
// in a game that is actually being played.
//
// Two things it reports besides failures. COVERAGE PER FACE, because a card set
// where a quarter of the faces never resolved has not been tested; and HOW
// GAMES ENDED, because "finished at 15 VP" and "hit the turn cap" are different
// outcomes and a corpus that can only reach the cap is a balance bug wearing a
// green tick.

import { createGame, legalActions, apply, choose, hashState, cloneState } from '../js/engine.js';
import { allCards, STANDARD_DECK, randomDeck } from '../js/rules/spells/index.js';
import { seedRng, int, pick } from '../js/rules/rng.js';
import { invariants, monotonic } from './invariants.js';
import { NUMERALS } from '../js/rules/orient.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

const GAMES = arg('games', 60);
const SEED0 = arg('seed', 1);
const CAP = arg('cap', 4000);
const VERBOSE = flag('verbose');
// --pool draws random ten-card decks from the whole corpus instead of using the
// standard deck. A real match always uses the standard deck, so the default
// here matches a real match -- but with ten fixed cards only eight unique faces
// can ever resolve, and a coverage number from that is meaningless.
const POOL = flag('pool');

/** Answer a request at random, but only with answers the request allows. */
function answerFor(r, rng) {
  if (r.type === 'confirm') return int(rng, 2) === 1;
  if (r.type === 'some') {
    const pool = [...r.options];
    const out = [];
    for (let i = 0; i < r.count && pool.length; i++) out.push(pool.splice(int(rng, pool.length), 1)[0]);
    return out;
  }
  if (r.allowNone && int(rng, 6) === 0) return null;
  return r.options[int(rng, r.options.length)];
}

const coverage = new Map();     // 'CARD:III' -> count
const endings = new Map();
let failures = 0, games = 0, totalSteps = 0, totalTurns = 0;
let chainLinks = 0, longestChain = 0;
const vpFrom = { objective: 0, mage: 0, golem: 0 };

for (let g = 0; g < GAMES; g++) {
  const seed = SEED0 + g;
  const rng = seedRng(seed ^ 0xabcd);
  let state;
  try {
    const decks = POOL ? [randomDeck(rng, pick), randomDeck(rng, pick)] : null;
    state = createGame({ seed, decks, config: { strict: true } });
  } catch (e) {
    console.log(`  FAIL seed ${seed}: createGame threw: ${e.message}`);
    failures++;
    continue;
  }

  let steps = 0, prevAtRest = null, broke = false;
  // The fx cursor is per GAME, not per action. Most faces resolve during
  // `choose`, not during `apply` -- a chain asks which junction resonates, parks,
  // and everything after that happens while answers come in. Scanning only
  // inside apply() reported zero coverage across a thousand resolutions.
  let fxSeen = 0;
  const harvest = () => {
    for (const f of state.fx.slice(fxSeen)) {
      if (f.kind === 'resolveStart') coverage.set(`${f.def}:${f.numeral}`, (coverage.get(`${f.def}:${f.numeral}`) || 0) + 1);
      if (f.kind === 'match') chainLinks++;
      if (f.kind === 'chainEnd' && f.resolutions > longestChain) longestChain = f.resolutions;
    }
    fxSeen = state.fx.length;
  };
  const check = (where) => {
    const bad = invariants(state, `seed ${seed} step ${steps} ${where}`);
    if (!state.pending) {
      bad.push(...monotonic(prevAtRest, state, `seed ${seed} step ${steps}`));
      prevAtRest = cloneState(state);
    }
    if (bad.length) {
      for (const b of bad.slice(0, 6)) console.log(`  FAIL ${b}`);
      failures += bad.length;
      broke = true;
    }
    return bad.length === 0;
  };

  if (!check('after setup')) continue;

  while (state.winner === null && steps < CAP && !broke) {
    steps++;
    try {
      if (state.pending) {
        const r = state.pending.request;
        choose(state, answerFor(r, rng));
        harvest();
        if (!check(`after answering ${r.type}`)) break;
      } else {
        const la = legalActions(state);
        if (!la.length) {
          console.log(`  FAIL seed ${seed}: no legal actions at turn ${state.turn} phase ${state.phase}`);
          failures++;
          break;
        }
        const a = la[int(rng, la.length)];
        // Coverage is read off the fx stream rather than guessed at: the notes
        // say which face actually resolved, including ones a chain reached that
        // nobody chose.
        apply(state, a);
        harvest();
        if (!check(`after ${a.type}${a.act ? '/' + a.act : ''}`)) break;
      }
    } catch (e) {
      console.log(`  FAIL seed ${seed} step ${steps}: ${e.message}`);
      if (VERBOSE) console.log(e.stack);
      failures++;
      broke = true;
    }
  }

  if (broke) continue;
  games++;
  totalSteps += steps;
  totalTurns += state.turn;
  for (const e of state.scoreLog) if (e.kind in vpFrom) vpFrom[e.kind] += e.amount;

  const ending = state.winner === null ? `unfinished at step cap`
    : state.winner === -1 ? 'draw (turn cap)'
    : `player ${state.winner} on VP`;
  endings.set(ending, (endings.get(ending) || 0) + 1);
  if (state.winner === null) {
    console.log(`  FAIL seed ${seed}: hit the ${CAP}-step cap at turn ${state.turn} without ending`);
    failures++;
  }
}

/* ---------------------------------------------------------------- report */

const faces = [];
for (const d of allCards()) for (const f of d.faces) faces.push(`${d.id}:${f.numeral}`);
const hit = faces.filter((k) => coverage.has(k));
const cold = faces.filter((k) => !coverage.has(k));

console.log('');
console.log(`games completed      ${games}/${GAMES}`);
console.log(`mean steps/turns     ${games ? Math.round(totalSteps / games) : 0} / ${games ? Math.round(totalTurns / games) : 0}`);
console.log(`endings              ${[...endings].map(([k, v]) => `${k} x${v}`).join(', ') || '-'}`);
console.log(`VP by source         objectives ${vpFrom.objective}, mages ${vpFrom.mage}, golems ${vpFrom.golem}`);
console.log(`chain links / max    ${chainLinks} total, longest ${longestChain}`);
console.log(`face coverage        ${hit.length}/${faces.length} (${Math.round((hit.length * 100) / faces.length)}%)`);
if (cold.length && cold.length <= 40) console.log(`never resolved       ${cold.join(' ')}`);
else if (cold.length) console.log(`never resolved       ${cold.length} faces`);

console.log(`\n${failures} failure${failures === 1 ? '' : 's'}`);
process.exit(failures ? 1 : 0);
