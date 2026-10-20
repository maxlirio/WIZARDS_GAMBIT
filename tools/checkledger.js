#!/usr/bin/env node
// Every ledger counter must be both WRITTEN by the rules and READ by something.
//
//   node tools/checkledger.js [--games N]
//
// This is how a gold card ships permanently unscoreable. A gate reading a
// counter nothing ever increments evaluates `0 >= 3` forever -- false, silent,
// and indistinguishable from "you have not done that yet". The card looks
// implemented, the harness plays a thousand games, and nobody notices the
// objective is unreachable because nobody got there anyway.
//
// The other direction is the quieter one. A counter nothing reads is a line of
// bookkeeping in `ops` that costs something on every mutation and buys nothing,
// and it will drift out of step with the rule it was supposed to be measuring.
//
// So: static scan for writers and readers, then real games to see which
// counters actually move. All three are needed. A counter can be written by a
// `bump` that no reachable code path reaches -- which is what "written but
// never observed" means, and it is the shape of a rule that stopped firing.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { emptyLedger, LEDGER_KEYS, HIGH_WATER, DIAGNOSTIC } from '../js/rules/ledger.js';
import { allCards, randomDeck } from '../js/rules/spells/index.js';
import { createGame, apply, choose } from '../js/engine.js';
import { chooseAction, answerFor } from '../js/ai/ai.js';
import { seedRng, pick } from '../js/rules/rng.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const GAMES = arg('games', 12);

const ROOT = new URL('..', import.meta.url).pathname;
const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
});
const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

let pass = 0, fail = 0, warn = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${msg}`); } };

/* ---------------------------------------------------------- static passes */
const ledgerPath = walk(join(ROOT, 'js')).find((p) => p.endsWith('js/rules/ledger.js'));
// `tools/` is scanned too, because a DIAGNOSTIC counter's only legitimate
// reader is a tool. Writers are still only ever looked for in js/: a harness
// that incremented a game counter would be a harness changing the game.
const files = [...walk(join(ROOT, 'js')), ...walk(join(ROOT, 'tools'))]
  .filter((p) => p !== ledgerPath && !p.endsWith('tools/checkledger.js'));
const writers = new Map(LEDGER_KEYS.map((k) => [k, []]));
const readers = new Map(LEDGER_KEYS.map((k) => [k, []]));
const toolReaders = new Map(LEDGER_KEYS.map((k) => [k, []]));

for (const path of files) {
  const code = strip(readFileSync(path, 'utf8'));
  const rel = relative(ROOT, path);
  for (const k of LEDGER_KEYS) {
    // A write goes through bump/high with the name as a string literal, or is a
    // direct `ledger.key +=`. There is deliberately no third way: `bump` throws
    // on an unknown counter, which is why the string form is safe to grep for.
    const isTool = rel.startsWith('tools/');
    if (!isTool && (new RegExp(`(bump|high)\\s*\\([^)]*['"\`]${k}['"\`]`).test(code)
        || new RegExp(`ledger\\s*\\.\\s*${k}\\s*(\\+=|=|\\+\\+)`).test(code))) { writers.get(k).push(rel); continue; }
    // A read is any other mention of the property, or the name as a gate's or
    // an objective's `key:` parameter in the card data.
    if (new RegExp(`\\.\\s*${k}\\b`).test(code) || new RegExp(`key:\\s*['"\`]${k}['"\`]`).test(code)) {
      (isTool ? toolReaders : readers).get(k).push(rel);
    }
  }
}

/**
 * DIAGNOSTIC counters are consumed in bulk.
 *
 * tools/selfplay.js imports the list and prints every counter in it, so the
 * read is `ledger[k]` over a loop rather than `.fallDamage` -- which no
 * property grep can see. So the contract is checked structurally instead: some
 * tool must import DIAGNOSTIC and index a ledger by it, and membership of the
 * list is then the read. That is also the truthful statement of the contract:
 * these counters are read by whatever iterates the list.
 */
const bulkReaders = files.filter((path) => {
  if (!relative(ROOT, path).startsWith('tools/')) return false;
  const code = strip(readFileSync(path, 'utf8'));
  return /\bDIAGNOSTIC\b/.test(code) && /ledger\s*\[/.test(code);
}).map((path) => relative(ROOT, path));

// Card data reads counters by NAME through a gate or a VP formula, which the
// scan above sees, but it is worth naming the cards so a failure says which
// card breaks.
const cardReaders = new Map(LEDGER_KEYS.map((k) => [k, []]));
for (const d of allCards()) {
  for (const f of d.faces) {
    for (const g of [f.gate, f.objective?.gate]) {
      if (g?.id === 'ledgerAtLeast' && g.key) cardReaders.get(g.key).push(`${d.id}:${f.numeral}`);
    }
    if (f.objective?.vp?.k === 'perLedger' && f.objective.vp.key) cardReaders.get(f.objective.vp.key).push(`${d.id}:${f.numeral}`);
  }
}
// The Spellbook used to read counters too (its finds were conditions); it
// is sigils bound from a rune pouch now and reads none.
const findReaders = new Map(LEDGER_KEYS.map((k) => [k, []]));

/* ------------------------------------------------------------- real games */
const moved = new Map(LEDGER_KEYS.map((k) => [k, 0]));
let games = 0;
for (let g = 0; g < GAMES; g++) {
  const rng = seedRng(g ^ 0x1ed);
  let state;
  try { state = createGame({ seed: 700 + g, decks: [randomDeck(rng, pick), randomDeck(rng, pick)] }); }
  catch (e) { fail++; console.log(`  FAIL createGame: ${e.message}`); continue; }
  let steps = 0;
  try {
    while (state.winner === null && steps < 5000) {
      steps++;
      if (state.pending) choose(state, answerFor(state, { policy: 'greedy' }));
      else { const a = chooseAction(state, { policy: 'greedy' }); if (!a) break; apply(state, a); }
    }
  } catch (e) { fail++; console.log(`  FAIL game ${g}: ${e.message}`); continue; }
  games++;
  for (let p = 0; p < 2; p++) for (const k of LEDGER_KEYS) if (state.players[p].ledger[k] > 0) moved.set(k, moved.get(k) + 1);
}

/* ------------------------------------------------------------------ report */
console.log(`${LEDGER_KEYS.length} counters, ${games} games\n`);
console.log(`diagnostics consumed in bulk by: ${bulkReaders.join(', ') || 'NOBODY'}`);
ok(bulkReaders.length > 0, 'no tool iterates DIAGNOSTIC, so every instrument counter is unread overhead');
console.log(`counter                writers  rules  cards  finds  tools  moved`);
for (const k of LEDGER_KEYS) {
  const w = writers.get(k), r = readers.get(k), c = cardReaders.get(k), fr = findReaders.get(k), t = toolReaders.get(k);
  const diag = DIAGNOSTIC.includes(k);
  const gameReaders = r.length + c.length + fr.length;
  const mv = moved.get(k);
  console.log(`  ${k.padEnd(22)} ${String(w.length).padStart(3)}      ${String(r.length).padStart(3)}   ${String(c.length).padStart(4)}   ${String(fr.length).padStart(4)}   ${String(t.length).padStart(4)}  ${String(mv).padStart(3)}/${games * 2}${diag ? '  (diagnostic)' : ''}`);
  ok(w.length > 0, `counter '${k}' is never written -- every gate and objective reading it is permanently unreachable`);
  if (diag) {
    ok(t.length + r.length + bulkReaders.length > 0,
      `diagnostic counter '${k}' is read by no tool -- it is pure overhead`);
  }
  else ok(gameReaders > 0, `counter '${k}' is read by no rule, card or find condition. If it is an instrument, say so in ledger.js's DIAGNOSTIC list`);
  if (w.length && !mv && games) {
    warn++;
    console.log(`  warn '${k}' is written in ${w.join(', ')} but never moved in ${games} games -- the rule may have stopped firing`);
  }
}

// HIGH_WATER counters are not incremented, they are set, so `bump` would be
// wrong for them and the grep above has to see `high(` instead. Checked
// explicitly so the two lists cannot drift apart.
for (const k of HIGH_WATER) {
  ok(LEDGER_KEYS.includes(k), `HIGH_WATER names '${k}', which is not a counter`);
}

console.log(`\n${pass} passed, ${fail} failed, ${warn} warnings`);
process.exit(fail ? 1 : 0);
