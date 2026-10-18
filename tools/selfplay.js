#!/usr/bin/env node
// Thousands of headless matches, policy A against policy B, emitting numbers a
// balance decision can be made from.
//
//   node tools/selfplay.js [--games N] [--a oneply] [--b greedy] [--csv out.csv]
//                          [--seed S] [--pool] [--quiet]
//
// The numbers that matter, and why each one is here:
//
//   VP FROM OBJECTIVES vs FROM KILLS. The design intends gold to be the race
//   and kills to be a tax on bad positioning. If kills dominate, the answer is
//   `mageVpDecay`, which is a knob rather than a rule because nobody knew the
//   answer in advance.
//
//   TABLE OCCUPANCY. The spell table is the centrepiece, and if it sits nearly
//   empty then the chain mechanic -- the thing that makes this game this game --
//   is not happening. The first measurement of this came out at 1.66 cards under
//   random play, which is why it is reported on every run.
//
//   CHAIN LENGTH. Against checkrunes.js's prediction from the geometry alone.
//   A disagreement means the card text is doing something the runes did not
//   account for.
//
//   REALISED vs NOMINAL PUSH. A printed "push 3m" becomes 3m of travel resolved
//   against terrain, so the two differ, and by how much is the price of leaving
//   the grid.

import { createGame, legalActions, apply, choose, hashState } from '../js/engine.js';
import { chooseAction, answerFor, POLICIES } from '../js/ai/ai.js';
import { randomDeck, STANDARD_DECK, allCards } from '../js/rules/spells/index.js';
import { spellsOn } from '../js/rules/ops.js';
import { seedRng, pick } from '../js/rules/rng.js';
import { livingUnits } from '../js/field/query.js';
import { DIAGNOSTIC, LEDGER_KEYS } from '../js/rules/ledger.js';
import { writeFileSync } from 'node:fs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);

const GAMES = Number(arg('games', 50));
const A = arg('a', 'oneply');
const B = arg('b', 'greedy');
const SEED0 = Number(arg('seed', 1));
const CSV = arg('csv', null);
const POOL = flag('pool');
const QUIET = flag('quiet');
for (const pol of [A, B]) if (!POLICIES.includes(pol)) throw new Error(`unknown policy '${pol}'`);

const rows = [];
const tally = { a: 0, b: 0, draw: 0, unfinished: 0, errors: 0 };
/**
 * The instrument panel.
 *
 * Every counter in ledger.js's DIAGNOSTIC list is here, by name, because that
 * is what makes those counters worth their keep: they exist for the designer
 * rather than for the cards, so the designer's tool has to actually read them.
 * tools/checkledger.js insists on it -- a diagnostic nothing reads is pure
 * overhead on every mutation.
 */
const diag = Object.fromEntries(DIAGNOSTIC.map((k) => [k, 0]));
const agg = {
  vpObj: 0, vpMage: 0, vpGolem: 0, turns: 0, chains: 0, links: 0, longest: 0,
  occSum: 0, occN: 0, pushNominal: 0, pushReal: 0, falls: 0, found: 0, reshuffles: 0,
};

for (let g = 0; g < GAMES; g++) {
  const seed = SEED0 + g;
  // Seats are SWAPPED on alternate games. One policy always moving first is a
  // first-player advantage measurement dressed up as a policy comparison.
  const swap = g % 2 === 1;
  const polFor = (p) => ((p === 0) !== swap ? A : B);
  const dRng = seedRng(seed ^ 0x5eed);
  const decks = POOL ? [randomDeck(dRng, pick), randomDeck(dRng, pick)] : null;

  let state;
  try {
    state = createGame({ seed, decks });
  } catch (e) { tally.errors++; continue; }

  let steps = 0;
  try {
    while (state.winner === null && steps < 8000) {
      steps++;
      if (state.pending) {
        choose(state, answerFor(state, { policy: polFor(state.pending.request.player ?? state.active) }));
      } else {
        const a = chooseAction(state, { policy: polFor(state.active) });
        if (!a) break;
        apply(state, a);
        if (!state.pending && state.phase === 'spell') {
          for (let p = 0; p < 2; p++) { agg.occSum += spellsOn(state, p).length; agg.occN++; }
        }
      }
    }
  } catch (e) {
    tally.errors++;
    if (!QUIET) console.log(`  error seed ${seed}: ${e.message}`);
    continue;
  }

  const vp = [state.vp[0], state.vp[1]];
  const winner = state.winner;
  if (winner === null) tally.unfinished++;
  else if (winner === -1) tally.draw++;
  else if (polFor(winner) === A) tally.a++;
  else tally.b++;

  for (const e of state.scoreLog) {
    if (e.kind === 'objective') agg.vpObj += e.amount;
    else if (e.kind === 'mage') agg.vpMage += e.amount;
    else if (e.kind === 'golem') agg.vpGolem += e.amount;
  }
  agg.turns += state.turn;
  for (let p = 0; p < 2; p++) for (const k of DIAGNOSTIC) diag[k] += state.players[p].ledger[k];
  for (const f of state.fx) {
    if (f.kind === 'chainEnd') { agg.chains++; agg.links += f.resolutions; if (f.resolutions > agg.longest) agg.longest = f.resolutions; }
    if (f.kind === 'pushResult') { agg.pushReal += f.got; agg.pushNominal += f.want; }
    if (f.kind === 'falls') agg.falls += f.landed.length;
    if (f.kind === 'found') agg.found++;
    if (f.kind === 'reshuffle') agg.reshuffles++;
  }

  rows.push({
    seed, swap: swap ? 1 : 0, winner, reason: state.reason || '',
    vp0: vp[0], vp1: vp[1], turns: state.turn, steps,
    vpObj0: state.players[0].ledger.vpFromObjectives, vpObj1: state.players[1].ledger.vpFromObjectives,
    vpKill0: state.players[0].ledger.vpFromKills, vpKill1: state.players[1].ledger.vpFromKills,
    chains0: state.players[0].ledger.chainsResolved, chains1: state.players[1].ledger.chainsResolved,
    links0: state.players[0].ledger.chainLinks, links1: state.players[1].ledger.chainLinks,
    longest0: state.players[0].ledger.longestChain, longest1: state.players[1].ledger.longestChain,
    mageDeaths0: state.players[0].ledger.mageDeaths, mageDeaths1: state.players[1].ledger.mageDeaths,
    summons0: state.players[0].ledger.summons, summons1: state.players[1].ledger.summons,
    found0: state.players[0].ledger.cardsFound, found1: state.players[1].ledger.cardsFound,
    hash: hashState(state),
  });
  if (!QUIET && (g + 1) % 10 === 0) process.stderr.write(`  ${g + 1}/${GAMES}\r`);
}

const n = rows.length || 1;
const vpTotal = agg.vpObj + agg.vpMage + agg.vpGolem || 1;
console.log(`\n${A} vs ${B}   ${GAMES} games, seats swapped every other game`);
console.log(`  wins            ${A} ${tally.a}   ${B} ${tally.b}   draw ${tally.draw}   unfinished ${tally.unfinished}   errors ${tally.errors}`);
console.log(`  mean turns      ${(agg.turns / n).toFixed(1)}`);
console.log(`  VP source       objectives ${((agg.vpObj * 100) / vpTotal).toFixed(0)}%   mages ${((agg.vpMage * 100) / vpTotal).toFixed(0)}%   golems ${((agg.vpGolem * 100) / vpTotal).toFixed(0)}%`);
console.log(`                  (${agg.vpObj} / ${agg.vpMage} / ${agg.vpGolem} points)`);
console.log(`  table occupancy ${(agg.occSum / (agg.occN || 1)).toFixed(2)} spells`);
console.log(`  chains          ${agg.chains} total, ${(agg.links / (agg.chains || 1)).toFixed(2)} links each, longest ${agg.longest}`);
console.log(`  push realised   ${agg.pushNominal ? ((agg.pushReal * 100) / agg.pushNominal).toFixed(0) : '-'}% of nominal (${agg.pushReal}mm of ${agg.pushNominal}mm)`);
console.log(`  falls / found   ${agg.falls} falls, ${agg.found} cards found, ${agg.reshuffles} reshuffles`);

console.log(`\n  instruments (per game, both players)`);
for (const k of DIAGNOSTIC) {
  const v = diag[k] / n;
  const note = k === 'inertResolutions' ? '  how often a chain forced somebody onto a dead face'
    : k === 'mageDeaths' ? '  the suicide-feeding instrument: see score.js mageVpDecay'
    : k === 'golemCardsLost' ? '  golem cards spent by attrition'
    : k === 'unitsLost' ? '  units you lost, not kills you made'
    : k === 'fallDamage' ? '  damage taken from falling'
    : k === 'objectivesScored' ? '  separate payouts, not points'
    : k === 'forcedRotations' ? '  rotations a match made you take'
    : '';
  console.log(`    ${k.padEnd(20)} ${v.toFixed(2).padStart(8)}${note}`);
}

if (CSV) {
  const cols = Object.keys(rows[0] || { seed: 0 });
  writeFileSync(CSV, [cols.join(','), ...rows.map((r) => cols.map((c) => r[c]).join(','))].join('\n') + '\n');
  console.log(`  csv             ${CSV}`);
}

process.exit(tally.errors || tally.unfinished ? 1 : 0);
