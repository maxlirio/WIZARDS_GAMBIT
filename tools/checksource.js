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
console.log(`\nscanned ${scanned} files, ${hits} violation${hits === 1 ? '' : 's'}`);
process.exit(hits ? 1 : 0);
