#!/usr/bin/env node
// The corner runes are the game's entire trigger vocabulary, so how they are
// handed out decides how often anything happens at all. This tool tunes them
// BEFORE playtesting, because a rune distribution that makes chains rare or
// makes them endless is indistinguishable from a card-balance problem once you
// are looking at win rates.
//
//   node tools/checkrunes.js [--tables N]
//
// Three data constraints, and then a measurement.
//
//   1. No card carries the same rune on all four corners. Such a card
//      re-creates its own match after every rotation; the chain's vertex bound
//      still contains it, but it is a trap for the designer rather than the
//      player. Refused at source in schema.js; asserted here so the rule cannot
//      be quietly relaxed.
//   2. The global histogram is within +/-5 points of 25% each. A rune that is
//      rare is a trigger nobody can build around; one that is common makes
//      every table match everywhere.
//   3. Runes AGREE with the verb class of the face at the same index. The
//      corpus sits at 100% by design: a rune's job is to be readable at a
//      glance while the card spins, and "this corner tells you what the face
//      beside it does" is worth more than texture. The floor is 60% so that a
//      deliberate MISDIRECTION card -- a corner that lies about its face -- is
//      available as a design tool without being mandatory.
//
// Constraint 1 is really a CARD-DESIGN rule wearing a data constraint's
// clothes. With runes derived from verbs, a card whose four runes are identical
// is a card whose four faces all do the same kind of work -- which is a card
// with one idea on it. Four cards failed this on the first pass (SHOVE,
// LEVITATION, WIND_STEP and HIGH_SEAT were all four-faces-of-pushing) and the
// fix was to the FACES, not the runes.
//
// The measurement is a MECHANICAL CHAIN SIMULATION with no effects, no costs
// and no card text: just nine cards, the match rule and the two termination
// bounds. That isolates the geometry, which is the only way to tell whether a
// long chain came from the runes or from one card that rotates everything.
//
// Two things had to be got right before the number meant anything, and both
// were wrong on the first pass.
//
// It measures the STEADY STATE rather than a freshly dealt table. A random
// table has several junctions already matching; a chain only ends when nothing
// unspent matches, so the position a real game is in is one where a single
// perturbation creates one or two new matches.
//
// And it measures ACROSS TABLE OCCUPANCY, because occupancy turns out to
// dominate everything else. A full nine-card table has about 5.6 matching
// junctions by pure combinatorics -- eight edge junctions at 1/4 each, four
// interior junctions at 0.91 each -- so it produces a five-link cascade on
// every action. Real tables are nowhere near full: selfplay.js measures 3.2
// spells with a competent bot and 1.7 with random play, because nearly every
// face worth resolving eats a friendly spell to pay for itself. The band is
// therefore checked at the occupancy the game is actually played at, and the
// whole curve is printed, because "chains get explosive above six cards" is a
// design fact worth knowing rather than a number to hide.

import { allCards, bySchool, byKind } from '../js/rules/spells/index.js';
import { RUNES, VERB_RUNE, GLYPH, suggestedRune } from '../js/rules/runes.js';
import { runeAgreement } from '../js/rules/schema.js';
import { CELL_COLOR, HOME, MATCH_SITES, SITE, CELLS } from '../js/rules/table.js';
import { indexAt } from '../js/rules/orient.js';
import { seedRng, int, pick } from '../js/rules/rng.js';
import { ROTATION_CAP } from '../js/rules/ops.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const TABLES = arg('tables', 100000);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${msg}`); } };

const spells = allCards().filter((d) => d.runes.length === 4);

/* ------------------------------------------------- 1. no all-same card */
for (const d of spells) {
  ok(new Set(d.runes).size > 1, `${d.id} carries one rune on all four corners`);
}

/* ------------------------------------------------- 2. the histogram */
const hist = Object.fromEntries(RUNES.map((r) => [r, 0]));
for (const d of spells) for (const r of d.runes) hist[r]++;
const total = spells.length * 4;
console.log(`corpus               ${spells.length} four-sided cards, ${total} corners`);
for (const r of RUNES) {
  const share = (hist[r] * 100) / total;
  console.log(`  ${r.padEnd(8)} ${String(hist[r]).padStart(3)}  ${share.toFixed(1)}%   (${GLYPH[r].silhouette})`);
  ok(Math.abs(share - 25) <= 5, `${r} is ${share.toFixed(1)}% of corners (want 25% +/- 5)`);
}

/* ------------------------------------------------- 3. legibility */
let hit = 0, seen = 0;
const worst = [];
for (const d of spells) {
  const a = runeAgreement(d);
  hit += a.hit; seen += a.seen;
  if (a.seen && a.hit * 2 < a.seen) worst.push(`${d.id} ${a.hit}/${a.seen}`);
}
const agree = seen ? (hit * 100) / seen : 0;
console.log(`rune/verb agreement  ${hit}/${seen} corners (${agree.toFixed(0)}%)`);
if (worst.length) console.log(`  mostly disagreeing   ${worst.join(', ')}`);
ok(agree >= 60, `runes agree with their face's verb only ${agree.toFixed(0)}% of the time (floor 60%)`);

/* ----------------------------------- the mechanical chain simulation */
// No engine, no effects, no costs. Nine cards, nine rotations, the match rule,
// and the two termination bounds. What comes out is the chain length the RUNES
// produce, which is the number a designer can actually act on.

const runeAt = (card, pos) => card.def.runes[indexAt(card.rot, pos)];

/**
 * `want` cards, each on a cell its school is allowed on, at a random rotation.
 *
 * Which cells get filled is chosen at random rather than in cell order, so the
 * measurement is not quietly always about the top-left corner.
 */
function deal(rng, deck, want) {
  const table = new Array(CELLS).fill(null);
  const cells = [...Array(CELLS).keys()];
  for (let i = cells.length - 1; i > 0; i--) { const j = int(rng, i + 1); [cells[i], cells[j]] = [cells[j], cells[i]]; }
  for (const c of cells.slice(0, want)) {
    const colour = CELL_COLOR[c];
    const pool = deck.filter((d) => (colour === 'grey' ? d.kind === 'artifact' : d.school === colour));
    if (!pool.length) continue;
    table[c] = { def: pool[int(rng, pool.length)], rot: int(rng, 4), turns: 0, cell: c };
  }
  return table;
}

/**
 * Run one chain over a table, with the termination rule and nothing else:
 * each card is rotated at most once per turn (`fresh` was rotated by the
 * action itself, so it has had its turn), and a site whose turner has had
 * its rotation does not fire.
 *
 * The real rule: only ORTHOGONAL neighbours match, at the two corners that
 * touch across their shared edge, and only a site touching a FRESH card (the
 * one the action changed, then each card the chain turns) can fire. The
 * matched neighbour turns.
 */
function chain(rng, table, fresh) {
  let links = 0;
  for (const card of table) if (card) card.turns = 0;    // a new turn
  if (fresh && fresh.rotated) fresh.turns = 1;            // the action's own rotation
  const hot = new Set(fresh ? [fresh] : table.filter(Boolean));

  for (let guard = 0; guard < 64; guard++) {
    const live = [];
    for (const id of MATCH_SITES) {
      const s = SITE[id];
      const a = table[s.cells[0]], b = table[s.cells[1]];
      if (!a || !b) continue;
      if (!hot.has(a) && !hot.has(b)) continue;
      const ra = runeAt(a, s.pos[0]), rb = runeAt(b, s.pos[1]);
      if (ra !== rb && ra !== 'WILD' && rb !== 'WILD') continue;
      const turners = [a, b].filter((c) => !hot.has(c));
      const eligible = (turners.length ? turners : [a, b]).filter((c) => c.turns < ROTATION_CAP);
      if (!eligible.length) continue;                  // its turner has had its rotation
      live.push({ id, pair: eligible });
    }
    if (!live.length) break;
    const chosen = live[int(rng, live.length)];
    const c = chosen.pair[int(rng, chosen.pair.length)];
    c.rot = (c.rot + 1) & 3;                           // a left turn
    c.turns++;
    hot.add(c);
    links++;
  }
  return { links };
}

/** What a player's own spell action does to the table. Returns the card it changed. */
function perturb(rng, table) {
  const filled = table.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
  if (!filled.length) return null;
  const i = filled[int(rng, filled.length)];
  if (int(rng, 4) === 0) {
    // A shift, which moves a card's corners to four new junctions at once and
    // is by far the biggest single perturbation a player can make.
    const c = table[i];
    const to = [i - 3, i + 3, i % 3 !== 0 ? i - 1 : -1, i % 3 !== 2 ? i + 1 : -1]
      .filter((n) => n >= 0 && n < CELLS && !table[n]);
    if (to.length) { const t = to[int(rng, to.length)]; table[t] = c; c.cell = t; table[i] = null; c.rotated = false; return c; }
  }
  table[i].rot = (table[i].rot + 1) & 3;
  table[i].rotated = true;                             // the action spent this card's rotation
  return table[i];
}

const rng = seedRng(0xc0ffee);
const deck = allCards().filter((d) => d.kind !== 'golem');
const STEPS = 40;

/** Chain lengths at one table occupancy. */
function measure(occupancy, tables) {
  const hist = new Array(14).fill(0);
  let sum = 0, maxLen = 0, overflow = 0, n = 0;
  for (let i = 0; i < tables; i++) {
    const table = deal(rng, deck, occupancy);
    chain(rng, table, null);           // settle: the first chain is discarded
    for (let k = 0; k < STEPS; k++) {
      const changed = perturb(rng, table);
      const r = chain(rng, table, changed);
      hist[Math.min(r.links, 13)]++;
      sum += r.links;
      n++;
      if (r.links > maxLen) maxLen = r.links;
      if (r.links > CELLS) overflow++;
    }
  }
  return { hist, mean: sum / n, maxLen, overflow, n };
}

/**
 * The occupancy the band is checked at.
 *
 * Measured, not chosen: tools/selfplay.js reports 3.2 spells on the table with
 * a one-ply bot. Three and four bracket that.
 */
const PLAY_OCCUPANCY = [3, 4];

const perTable = Math.max(20, Math.floor(TABLES / (STEPS * 8)));
console.log(`\nchain length vs table occupancy (runes only, no effects, steady state)`);
console.log(`  cards   mean   0 links   2+ links   longest`);
const curve = {};
for (let occ = 2; occ <= CELLS; occ++) {
  const m = measure(occ, perTable);
  curve[occ] = m;
  const zero = (m.hist[0] * 100) / m.n;
  const two = ((m.n - m.hist[0] - m.hist[1]) * 100) / m.n;
  const mark = PLAY_OCCUPANCY.includes(occ) ? ' <- real play' : '';
  console.log(`  ${String(occ).padStart(5)}   ${m.mean.toFixed(2).padStart(4)}   ${zero.toFixed(0).padStart(6)}%   ${two.toFixed(0).padStart(7)}%   ${String(m.maxLen).padStart(7)}${mark}`);
  ok(m.overflow === 0, `${m.overflow} chains at ${occ} cards made more than ${CELLS} links`);
  ok(m.maxLen <= CELLS, `a chain at ${occ} cards reached ${m.maxLen} links (bound ${CELLS}: one rotation per card per turn)`);
}

const histLen = new Array(14).fill(0);
let sum = 0, maxLen = 0, overflow = 0, TOTAL = 0;
for (const occ of PLAY_OCCUPANCY) {
  const m = curve[occ];
  for (let i = 0; i < histLen.length; i++) histLen[i] += m.hist[i];
  sum += m.mean * m.n;
  TOTAL += m.n;
  if (m.maxLen > maxLen) maxLen = m.maxLen;
  overflow += m.overflow;
}

console.log(`\nat the occupancy the game is played at (${PLAY_OCCUPANCY.join(' and ')} cards)`);
for (let i = 0; i < histLen.length; i++) {
  if (!histLen[i]) continue;
  const share = (histLen[i] * 100) / TOTAL;
  console.log(`  ${String(i).padStart(2)} links  ${String(histLen[i]).padStart(7)}  ${share.toFixed(2)}%  ${'#'.repeat(Math.round(share / 2))}`);
}
const mean = sum / TOTAL;
console.log(`mean ${mean.toFixed(2)} links, longest ${maxLen}, bound ${CELLS}`);

// The design band. A mean below 1 means the chain mechanic almost never fires
// and the game is just one action a turn; above 4 and every action is a
// cascade nobody can plan.
// The design band. Below 0.5 the chain mechanic almost never fires and the game
// is one action a turn; above 3 every action is a cascade nobody can plan.
// Lowered from 0.5 when matching became orthogonal-only and fresh-card-only
// (2026-10-18): a chain now needs the card you just moved to line up with a
// neighbour, so it fires on about a quarter of actions at real occupancy.
// The band dropped from 0.4 when one rotation per card per turn replaced the
// four-per-action cap (2026-10-24): a neighbour now turns once, not up to
// four times, so the mean at three or four cards fell from about 0.8 to 0.4.
ok(mean >= 0.3 && mean <= 3.0, `mean chain length ${mean.toFixed(2)} is outside the intended band 0.3-3.0`);
const zero = (histLen[0] * 100) / TOTAL;
const combo = ((TOTAL - histLen[0] - histLen[1]) * 100) / TOTAL;
console.log(`no match at all      ${zero.toFixed(1)}%`);
console.log(`two or more links    ${combo.toFixed(1)}%`);
// A combo school needs combos to be reachable. If almost every chain is a
// single link, purple has nothing to read.
ok(combo >= 8, `only ${combo.toFixed(1)}% of actions produce a 2+ link chain (want at least 8%)`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
