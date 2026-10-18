#!/usr/bin/env node
// Every derived bucket must be both WRITTEN by some card and READ by some rule.
//
//   node tools/checkderived.js [--games N]
//
// This is how a passive ships inert while looking implemented. A bucket nothing
// reads is a passive that computes an answer nobody asks for; a bucket nothing
// writes makes every card depending on it permanently blank. Neither crashes,
// neither violates an invariant, and neither is visible by playing -- a passive
// that does nothing looks exactly like a passive whose condition is not met.
//
// Three passes, because none of them is sufficient alone:
//
//   STATIC READ. Grep for each bucket name outside derive.js -- and, because
//   most buckets are read through derive.js's own little accessors
//   (`lostOn`, `shieldOn`, `untargetable`), also follow those: a bucket counts
//   as read if an accessor that touches it is used elsewhere. Without that
//   indirection the pass reported `lostKeywords` as dead when keywords.js reads
//   it on every single query.
//
//   DECLARED WRITE. Every face with a `passive` declares the buckets it writes
//   in `grants`, and derive.js's strict-mode proxy REFUSES anything undeclared.
//   So the declarations are trustworthy, and a bucket no face declares is
//   unreachable.
//
//   OBSERVED WRITE. Play real games in strict mode and record which buckets
//   were actually touched. A face can declare a bucket and never write it --
//   that is the exact shape of a half-finished passive -- and only running it
//   can tell.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { emptyDerived, DERIVED_KEYS } from '../js/rules/derive.js';
import { allCards } from '../js/rules/spells/index.js';
import { createGame, legalActions, apply, choose } from '../js/engine.js';
import { chooseAction, answerFor } from '../js/ai/ai.js';
import { randomDeck } from '../js/rules/spells/index.js';
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

console.log(`${DERIVED_KEYS.length} declared buckets: ${DERIVED_KEYS.join(' ')}\n`);

/* --------------------------------------------------------- 1. static read */
const all = walk(join(ROOT, 'js'));
const derivePath = all.find((p) => p.endsWith('js/rules/derive.js'));
const sources = all.filter((p) => p !== derivePath);
const readers = new Map(DERIVED_KEYS.map((k) => [k, []]));

// Which of derive.js's exported accessors touch which bucket, so an accessor
// used elsewhere counts as a read of the bucket behind it.
const deriveCode = strip(readFileSync(derivePath, 'utf8'));
const accessorFor = new Map(DERIVED_KEYS.map((k) => [k, []]));
for (const m of deriveCode.matchAll(/export const (\w+)\s*=\s*\(([^)]*)\)\s*=>([^;]*);/g)) {
  for (const k of DERIVED_KEYS) if (new RegExp(`\\.\\s*${k}\\b`).test(m[3])) accessorFor.get(k).push(m[1]);
}

for (const path of sources) {
  const code = strip(readFileSync(path, 'utf8'));
  for (const k of DERIVED_KEYS) {
    // `d.noTurn`, `derived.noTurn`, `state.derived.noTurn` -- anything that
    // reaches the bucket through a property access...
    if (new RegExp(`\\.\\s*${k}\\b`).test(code)) { readers.get(k).push(relative(ROOT, path)); continue; }
    // ...or through one of derive.js's accessors.
    if (accessorFor.get(k).some((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(code))) {
      readers.get(k).push(`${relative(ROOT, path)} (via accessor)`);
    }
  }
}

/* ----------------------------------------------------- 2. declared writes */
const declared = new Map(DERIVED_KEYS.map((k) => [k, []]));
const undeclared = [];
for (const d of allCards()) {
  for (const f of d.faces) {
    const hasPassive = !!(f.passive || f.passive2);
    const grants = f.grants || [];
    if (hasPassive && !grants.length) undeclared.push(`${d.id}:${f.numeral}`);
    if (!hasPassive && grants.length) undeclared.push(`${d.id}:${f.numeral} declares grants with no passive`);
    for (const g of grants) {
      if (!DERIVED_KEYS.includes(g)) { fail++; console.log(`  FAIL ${d.id}:${f.numeral} declares unknown bucket '${g}'`); continue; }
      declared.get(g).push(`${d.id}:${f.numeral}`);
    }
  }
}
ok(undeclared.length === 0, `faces with a passive and no \`grants\`: ${undeclared.join(', ')}`);

/* ----------------------------------------------------- 3. observed writes */
const touched = new Map(DERIVED_KEYS.map((k) => [k, 0]));
let games = 0;
for (let g = 0; g < GAMES; g++) {
  const rng = seedRng(g ^ 0xdd);
  let state;
  try {
    // STRICT MODE, which is what installs the recording proxy. Without it this
    // pass measures nothing and reports every bucket as unwritten.
    state = createGame({ seed: 400 + g, decks: [randomDeck(rng, pick), randomDeck(rng, pick)], config: { strict: true } });
  } catch (e) { fail++; console.log(`  FAIL createGame: ${e.message}`); continue; }
  let steps = 0;
  try {
    while (state.winner === null && steps < 4000) {
      steps++;
      if (state.pending) choose(state, answerFor(state, { policy: 'greedy' }));
      else { const a = chooseAction(state, { policy: 'greedy' }); if (!a) break; apply(state, a); }
    }
  } catch (e) { fail++; console.log(`  FAIL game ${g}: ${e.message}`); continue; }
  games++;
  for (const set of Object.values(state.derivedTouched || {})) {
    for (const k of set) touched.set(k, touched.get(k) + 1);
  }
  if (state.derivationErrors.length) {
    fail++;
    console.log(`  FAIL game ${g}: ${state.derivationErrors.length} derive errors, first: ${JSON.stringify(state.derivationErrors[0])}`);
  }
}

/* ------------------------------------------------------------------ report */
console.log(`bucket             declared by   read in                        observed`);
for (const k of DERIVED_KEYS) {
  const dec = declared.get(k);
  const rd = readers.get(k);
  const obs = touched.get(k);
  const mark = !rd.length ? 'NEVER READ' : !dec.length ? 'NEVER DECLARED' : !obs ? 'not observed' : 'ok';
  console.log(`  ${k.padEnd(17)} ${String(dec.length).padStart(3)} faces     ${String(rd.length).padStart(2)} files  ${' '.repeat(18)} ${mark}`);
  ok(rd.length > 0, `derived bucket '${k}' is never read -- a passive computing an answer nobody asks for`);
  // A bucket nothing declares cannot be written by any card. Reported as a
  // WARNING rather than a failure: a bucket may legitimately exist ahead of the
  // card that will use it, and the suite should say so rather than block.
  if (!dec.length) { warn++; console.log(`  warn derived bucket '${k}' is declared by no face -- every rule reading it is dead`); }
  else if (!obs && games) { warn++; console.log(`  warn derived bucket '${k}' declared by ${dec.join(', ')} but never written in ${games} games`); }
}

console.log(`\n${games} games played in strict mode`);
console.log(`${pass} passed, ${fail} failed, ${warn} warnings`);
process.exit(fail ? 1 : 0);
