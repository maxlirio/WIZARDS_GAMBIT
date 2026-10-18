#!/usr/bin/env node
// A static source gate. Cheapest, highest-value check in the suite.
//
// One Math.sqrt in a push, or one `document` reference reached from the rules,
// and lockstep or headless play breaks while every behavioural harness still
// reports green -- surfacing much later as an unexplained hash divergence. So
// these are structural rules enforced by grep, not conventions.
//
//   node tools/checksource.js

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
});

const RULES = [
  { // The determinism boundary.
    label: 'Math.* outside js/field/fixed.js',
    files: (p) => p.includes('/js/') && !p.endsWith('js/field/fixed.js'),
    re: /\bMath\s*\.\s*(random|sqrt|sin|cos|tan|atan2?|hypot|pow|cbrt|log|exp)\b/g,
    why: 'not bit-identical across JS engines; use js/field/fixed.js',
  },
  { // Wall-clock reads make a replay unreproducible.
    label: 'wall-clock time in the engine',
    files: (p) => p.includes('/js/rules/') || p.includes('/js/field/'),
    re: /\b(Date\s*\.\s*now|performance\s*\.\s*now|new\s+Date)\b/g,
    why: 'a replay must not depend on when it ran',
  },
  { // The layering rule: rules and field never reach outward.
    label: 'host globals reached from the engine',
    files: (p) => p.includes('/js/rules/') || p.includes('/js/field/'),
    re: /\b(document|window|localStorage|sessionStorage|fetch)\b/g,
    why: 'js/rules and js/field must run headless in node',
  },
  { // Only js/profile.js may persist anything.
    label: 'localStorage outside js/profile.js',
    files: (p) => p.includes('/js/') && !p.endsWith('js/profile.js'),
    re: /\blocalStorage\b/g,
    why: 'persistence lives in one file so the harness can fake it',
  },
];

let hits = 0, scanned = 0;
for (const path of walk(join(ROOT, 'js')).sort()) {
  const src = readFileSync(path, 'utf8');
  scanned++;
  // Strip comments first: these files DISCUSS Math.sqrt at length on purpose.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
  for (const rule of RULES) {
    if (!rule.files(path)) continue;
    for (const m of code.matchAll(rule.re)) {
      const line = code.slice(0, m.index).split('\n').length;
      console.log(`  FAIL ${relative(ROOT, path)}:${line}  ${m[0]}  [${rule.label}] -- ${rule.why}`);
      hits++;
    }
  }
}

/* ------------------------------------------------------- dead exports */
// An export nothing imports is code that is maintained, read, and trusted by
// nobody. Same discipline as checkderived and checkledger, one level up: those
// ask whether a bucket or a counter is used, this asks it of every function in
// the engine.
//
// `tools/` counts as a consumer -- a harness is a real reader, and several
// accessors exist precisely so a harness can look at something without
// reaching into the state. The public surface of js/engine.js is exempt,
// because that is what a view layer will import, and the view does not exist
// yet by deliberate choice.

const PUBLIC = new Set([
  // js/engine.js -- what a view or a netcode layer imports.
  'createGame', 'legalActions', 'apply', 'choose', 'hashState', 'cloneState',
  'hashField', 'pump', 'spellActions', 'resolveDescriptor', 'actions',
  'CHECKS_MATCHES', 'DEFAULT_CONFIG', 'PUMP_LIMIT',
]);

/**
 * Whole files exempt, with the reason.
 *
 * js/profile.js is the BROWSER's Spellbook writer and nothing in node imports
 * it: tools/duel.js keeps its own file instead, because the terminal has no
 * localStorage and the engine must not learn that persistence exists. So the
 * whole module is unimported until the view arrives, and that is correct rather
 * than dead.
 */
const EXEMPT_FILES = {
  'js/profile.js': 'the browser Spellbook writer; the view layer will import it',
};

const exportsOf = (code) => {
  const names = [];
  for (const m of code.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) names.push(m[1]);
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
    }
  }
  return names;
};

const sources = walk(join(ROOT, 'js')).sort();
const consumers = [...sources, ...walk(join(ROOT, 'tools')).sort()];
const bodies = new Map(consumers.map((p) => [p, readFileSync(p, 'utf8')]));
let dead = 0;
for (const path of sources) {
  const rel = relative(ROOT, path);
  if (EXEMPT_FILES[rel]) continue;
  const code = bodies.get(path);
  for (const name of exportsOf(code)) {
    if (PUBLIC.has(name)) continue;
    // A SECOND mention inside the defining file is a local use: `canTurn` calls
    // `onHomeColour`, `evaluate` calls `matchPotential`, `makeDef` reads
    // `KINDS`. Skipping the defining file entirely reported 24 of those as dead
    // on the first run, which is the sort of noise that gets a check switched
    // off rather than fixed.
    let used = (code.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length > 1;
    for (const [other, body] of bodies) {
      if (used) break;
      if (other === path) continue;
      // An import by name, or a namespace member access (`M.damage`, `ops.turn`).
      if (new RegExp(`\\b${name}\\b`).test(body)) { used = true; break; }
    }
    if (!used) {
      console.log(`  FAIL ${relative(ROOT, path)}  exports '${name}' and nothing imports it`
        + ` [dead export] -- delete it, or add it to PUBLIC in checksource.js if a view will need it`);
      dead++;
    }
  }
}
console.log(`\nscanned ${scanned} files, ${hits} violation${hits === 1 ? '' : 's'}, ${dead} dead export${dead === 1 ? '' : 's'}`);
process.exit(hits + dead ? 1 : 0);
