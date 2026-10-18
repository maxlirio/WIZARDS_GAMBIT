#!/usr/bin/env node
// Every card-facing registry must be USED by the corpus, or declared reserved.
//
//   node tools/checkcorpus.js
//
// The same discipline as checkderived and checkledger, pointed at the other
// direction. Those two ask "is this bucket read and written". This asks "is this
// gate, cost, keyword, formula and motif attached to an actual card" -- because
// a registry entry no card uses is machinery that looks finished, gets
// maintained, drifts out of step with the engine around it, and then has to be
// debugged by whoever finally writes the card that needs it.
//
// RESERVED is a real category and it is declared, not inferred. `ask.by` exists
// for a request the opponent answers and no card asks one yet; `replace` exists
// because some effects have to be intercepted before they happen and cannot ask
// a question while doing it. Those are load-bearing shapes kept deliberately
// empty. Everything else has to be on a card.
//
// It also checks the keyword HOOKS from both ends, which is where it earned its
// keep on the first run. A hook must be REGISTERED by a keyword that is on a
// card, and CALLED by the engine. Three keywords failed the second test and did
// nothing whatsoever: [Absorb]'s `incoming` hook was never invoked, so a golem
// printed with it took full damage; [Spell Mastery]'s `turnLock` was never
// consulted, so the passive form worked and the keyword form did not; and
// [Unstable]'s `onDestroy` was never fired. All three read as implemented from
// every other angle.
//
// It also reports the DISTRIBUTION -- faces per school, how many carry a gate, a
// cost, a passive, a trigger, an objective -- because "purple has no cards with
// costs" is a design fact that no individual card review can see.

import { allCards, CARDS } from '../js/rules/spells/index.js';
import { GATE_IDS, GATES } from '../js/rules/gates.js';
import { COST_IDS, COSTS } from '../js/rules/costs.js';
import { VP_FORMULA_IDS } from '../js/rules/objectives.js';
import { KEYWORD_NAMES, HOOKS, KEYWORDS } from '../js/rules/keywords.js';
import { FIND_IDS } from '../js/rules/learn.js';
import { EVENTS } from '../js/rules/triggers.js';
import { SCHOOLS, FACE_KEYS } from '../js/rules/schema.js';
import * as MOTIFS from '../js/rules/motifs.js';

let pass = 0, fail = 0, warn = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${msg}`); } };

/**
 * Deliberately unused, with the reason. A shape kept empty on purpose is fine;
 * one kept empty by accident is the thing this file exists to find, and the
 * difference has to be written down somewhere.
 */
const RESERVED = {
  gates: {
    always: 'the explicit no-op gate. A face with no gate is the normal way to say this, so nothing uses it -- kept because a generated or data-driven face needs something to write',
  },
  costs: {},
  formulas: {},
  keywords: {},
  events: {
    afterDraw: 'nothing triggers off drawing yet; the event exists so the one card that will does not have to add a new event',
    afterDiscard: 'as above',
    afterFound: 'the Spellbook announces itself for the view, not for cards',
    afterShift: 'ops fires it; no card listens yet',
    afterPush: 'the field fires it; no card listens yet',
    afterFall: 'the field fires it; no card listens yet',
    afterSummon: 'units.js fires it; no card listens yet',
    afterScore: 'score.js fires it; no card listens yet',
    turnEnd: 'turn.js fires it; no card listens yet',
    afterDamage: 'combat.js fires it AND routes every point of damage through its replacement path, which [Absorb] uses',
    afterResolve: 'resolve.js fires it; no card listens yet',
  },
  faceKeys: {
    replace: 'the replacement path. combat.js runs every point of damage through it so [Absorb] works; no card declares one yet, and a card that wants to needs a pure function because the board is mid-mutation',
    text: 'every face has one',
    tag: 'set by the motif',
    numeral: 'added by the schema',
    index: 'added by the schema',
  },
  motifs: {},
};

/* ---------------------------------------------------------------- scan */
const used = {
  gates: new Map(), costs: new Map(), formulas: new Map(), keywords: new Map(),
  events: new Map(), faceKeys: new Map(), finds: new Map(), hooks: new Map(),
  motifs: new Map(),
};
const note = (bag, key, where) => {
  if (!used[bag].has(key)) used[bag].set(key, []);
  used[bag].get(key).push(where);
};

const cards = allCards();
for (const d of cards) {
  if (d.found) note('finds', d.found, d.id);
  for (const k of d.keywords) note('keywords', k, `${d.id} (printed)`);
  for (const f of d.faces) {
    const where = `${d.id}:${f.numeral}`;
    for (const k of Object.keys(f)) note('faceKeys', k, where);
    for (const g of [f.gate, f.objective?.gate]) if (g) note('gates', g.id, where);
    for (const c of f.cost || []) note('costs', c.id, where);
    if (f.objective) note('formulas', f.objective.vp.k, where);
    for (const e of Object.keys(f.on || {})) note('events', e, where);
    for (const e of Object.keys(f.replace || {})) note('events', e, `${where} (replace)`);
    for (const k of f.keywords || []) note('keywords', k, `${where} (granted)`);
    // A keyword named in a face's text counts: grantKeyword declares it, but a
    // face that merely benefits from one does not.
    for (const k of KEYWORD_NAMES) if (f.text.includes(`[${k}]`)) note('keywords', k, where);
  }
}
for (const k of used.keywords.keys()) {
  for (const h of Object.keys(KEYWORDS[k] || {})) if (h !== 'text') note('hooks', h, k);
}

// The motifs: scanned off the SOURCE, because a motif is spread into a face and
// leaves no trace on the def that says which one it was.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const ROOT = new URL('..', import.meta.url).pathname;
const corpusSrc = readdirSync(join(ROOT, 'js/rules/spells'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(join(ROOT, 'js/rules/spells', f), 'utf8')).join('\n');
const MOTIF_NAMES = Object.keys(MOTIFS).filter((k) => typeof MOTIFS[k] === 'function').sort();
for (const m of MOTIF_NAMES) if (new RegExp(`M\\.${m}\\s*\\(`).test(corpusSrc)) note('motifs', m, 'corpus');

/* --------------------------------------------------------------- report */
function section(label, bag, all, reserved) {
  const unused = all.filter((k) => !used[bag].has(k));
  const orphan = unused.filter((k) => !reserved[k]);
  const held = unused.filter((k) => reserved[k]);
  console.log(`${label.padEnd(14)} ${all.length - unused.length}/${all.length} used${held.length ? `, ${held.length} reserved` : ''}`);
  for (const k of orphan) {
    fail++;
    console.log(`  FAIL ${label}: '${k}' is registered and no card uses it. Attach it to a card, delete it, or declare it RESERVED in checkcorpus.js with the reason`);
  }
  for (const k of held) console.log(`  reserved  ${k}: ${reserved[k]}`);
  if (!orphan.length) pass++;
}

section('gates', 'gates', GATE_IDS, RESERVED.gates);
section('costs', 'costs', COST_IDS, RESERVED.costs);
section('vp formulas', 'formulas', VP_FORMULA_IDS, RESERVED.formulas);
section('keywords', 'keywords', KEYWORD_NAMES, RESERVED.keywords);
section('events', 'events', [...EVENTS], RESERVED.events);
section('face keys', 'faceKeys', [...FACE_KEYS], RESERVED.faceKeys);
section('motifs', 'motifs', MOTIF_NAMES, RESERVED.motifs);

// Find conditions are checked the other way round too: learn.js already throws
// at load if a condition is claimed by two cards or by none.
ok(used.finds.size === FIND_IDS.length, `${FIND_IDS.length - used.finds.size} find conditions are claimed by no card`);

/* ------------------------------------------------- the hooks, from both ends */
// REGISTERED by a keyword on a card, and CALLED by the engine. The second half
// is the one that found three keywords doing nothing at all.
const engineSrc = (function walk(d) {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const full = join(d, e.name);
    return e.isDirectory() ? walk(full) : e.name.endsWith('.js') && !full.endsWith('keywords.js') ? [readFileSync(full, 'utf8')] : [];
  });
})(join(ROOT, 'js')).join('\n');

console.log('');
for (const h of HOOKS) {
  const registered = used.hooks.has(h);
  // apply / applyFor / applyKw / fire / fireFor / fireKw, with the hook name as
  // a string literal. There is deliberately no other way to reach a hook.
  const called = new RegExp(`(apply|fire)[A-Za-z]*\\s*\\([^;]{0,200}?['"\`]${h}['"\`]`, 's').test(engineSrc)
    || new RegExp(`['"\`]${h}['"\`]\\s*,`).test(engineSrc) && h === 'origin';
  const state = !registered && !called ? 'NEITHER' : !registered ? 'no keyword uses it' : !called ? 'THE ENGINE NEVER CALLS IT' : 'ok';
  console.log(`  hook ${h.padEnd(11)} ${registered ? 'registered' : '          '}  ${called ? 'called' : '      '}   ${state}`);
  ok(called, `keyword hook '${h}' is registered but the engine never calls it -- every keyword using it does nothing`);
  if (!registered) { warn++; console.log(`  warn no keyword on a card registers '${h}'`); }
}

/* ------------------------------------------------------- the distribution */
console.log(`\ncorpus: ${cards.length} cards, ${cards.reduce((n, d) => n + d.faces.length, 0)} faces`);
console.log(`school    cards  faces   gate  cost  passive  trigger  objective`);
for (const s of [...SCHOOLS].sort()) {
  const ds = cards.filter((d) => d.school === s);
  if (!ds.length) continue;
  const fs = ds.flatMap((d) => d.faces);
  const n = (f) => fs.filter(f).length;
  console.log(`  ${s.padEnd(9)}${String(ds.length).padStart(4)}${String(fs.length).padStart(7)}${String(n((f) => f.gate)).padStart(7)}${String(n((f) => f.cost)).padStart(6)}${String(n((f) => f.passive || f.passive2)).padStart(9)}${String(n((f) => f.on || f.replace)).padStart(9)}${String(n((f) => f.objective)).padStart(11)}`);
}

console.log(`\n${pass} passed, ${fail} failed, ${warn} warnings`);
process.exit(fail ? 1 : 0);
