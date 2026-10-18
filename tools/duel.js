#!/usr/bin/env node
// Play a match, or watch two AIs play one, in the terminal.
//
//   node tools/duel.js                        two AIs, narrated
//   node tools/duel.js --human 0              YOU play player 0 against the AI
//   node tools/duel.js --seed N --pool        a random corpus deck each
//   node tools/duel.js --quiet --to 20        just the result, or stop at a turn
//   node tools/duel.js --human 0 --book mine.json   keep a Spellbook across matches
//
// This is the first playable. There is no renderer yet and will not be one until
// the rules are finished, so this is how the game is read: the two spell tables
// drawn with their corner runes and active numerals, the arena as a height map
// with the units on it, and a narration of every action, match, chain link and
// point scored, taken straight off the engine's own note stream.
//
// The narration is built entirely from `state.fx`, which is the list the view
// layer will eventually read. So this file is also the proof that the note
// stream says enough to show the game -- if something here has to reach into
// the state to explain what happened, the notes are missing something.

import { createGame, legalActions, apply, choose, hashState } from '../js/engine.js';
import { chooseAction, answerFor } from '../js/ai/ai.js';
import { CARDS, randomDeck, allCards } from '../js/rules/spells/index.js';
import { spellsOn, topOf, defOf, stackAt } from '../js/rules/ops.js';
import { CELL_COLOR, CELLS } from '../js/rules/table.js';
import { activeIndex, NUMERALS, indexAt } from '../js/rules/orient.js';
import { runeAtCorner } from '../js/rules/match.js';
import { keywordsOf } from '../js/rules/keywords.js';
import { TIER_CAP } from '../js/rules/golems.js';
import { heightAt, propR, propTop, propSpec, propOnBoard, ARENA_W, ARENA_H } from '../js/field/arena.js';
import { livingUnits, mageOf } from '../js/field/query.js';
import { seedRng, pick } from '../js/rules/rng.js';
import { FINDS, FIND_IDS, spellbookPage } from '../js/rules/learn.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);

const SEED = Number(arg('seed', 7));
const A = arg('a', 'oneply');
const B = arg('b', 'oneply');
const TO = Number(arg('to', 0));
const QUIET = flag('quiet');
const BOARD = flag('board') || !QUIET;
const POOL = flag('pool');
const HUMAN = process.argv.includes('--human') ? Number(arg('human', 0)) : null;

/**
 * THE SPELLBOOK, persisted.
 *
 * `js/profile.js` is the engine-side home for this and it uses localStorage,
 * because it has to work in a browser and must not reach for the filesystem.
 * In a terminal there is no localStorage, so the file is kept HERE -- tools are
 * node-only by definition, and the engine stays unaware that persistence
 * exists at all. If it were not, a replay could depend on what the player
 * happens to have learned, and two machines in a lockstep game would diverge
 * on a difference between their save files.
 */
const BOOK = arg('book', HUMAN === null ? null : join(homedir(), '.wizards-gambit-spellbook.json'));
const loadBook = () => {
  if (!BOOK) return { learned: {}, matches: 0, wins: 0 };
  try { return { learned: {}, matches: 0, wins: 0, ...JSON.parse(readFileSync(BOOK, 'utf8')) }; }
  catch { return { learned: {}, matches: 0, wins: 0 }; }
};
const book = loadBook();

const C = {
  red: '\x1b[38;5;203m', blue: '\x1b[38;5;75m', green: '\x1b[38;5;114m',
  purple: '\x1b[38;5;177m', gold: '\x1b[38;5;221m', grey: '\x1b[38;5;247m',
  golem: '\x1b[38;5;180m',
  dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m',
  p0: '\x1b[38;5;81m', p1: '\x1b[38;5;210m',
};
const paint = (s, c) => `${c}${s}${C.off}`;
const RUNE_CH = { SPIRAL: 'S', SHARD: 'X', WHEEL: 'O', LATTICE: '#', WILD: '*' };

/* ---------------------------------------------------------------- the table */

/**
 * One cell as five lines.
 *
 * The CORNER RUNES are drawn in their actual corners, because that is the whole
 * game: a match is two cards showing the same rune where they touch, and a
 * rendering that hides the runes hides the only thing a player is looking at.
 */
function cellBox(state, p, cell) {
  const colour = CELL_COLOR[cell];
  const sp = topOf(state, p, cell);
  const tint = C[colour];
  const edge = (l) => paint(l, tint);
  const row = (inner) => paint('│', tint) + inner + paint('│', tint);
  if (!sp) {
    return [edge('┌─────┐'), row('     '), row(`  ${paint('·', C.dim)}  `), row('     '), row('     '), edge('└─────┘')];
  }
  const def = defOf(state, sp);
  // The CORNER RUNES go in their actual corners, because that is the whole
  // game: a match is two cards showing the same rune where they touch, and a
  // rendering that hides the runes hides the only thing a player looks at.
  const r = [0, 1, 2, 3].map((pos) => RUNE_CH[runeAtCorner(state, sp, pos)] || '?');
  const own = C[def.school] || C.grey;
  const buried = stackAt(state, p, cell).length - 1;
  const kw = keywordsOf(state, sp).length;
  const mark = buried > 0 ? String(buried) : kw > 0 ? '+'.repeat(Math.min(3, kw)) : '';
  return [
    edge('┌─────┐'),
    row(paint(r[0], own) + ' ' + paint(mark.padStart(1).slice(0, 1) || ' ', C.dim) + ' ' + paint(r[1], own)),
    row(paint(NUMERALS[activeIndex(sp)].padStart(4).padEnd(5), C.bold + own)),
    row(paint(def.name.slice(0, 5).padEnd(5), own)),
    row(paint(r[3], own) + '   ' + paint(r[2], own)),
    edge('└─────┘'),
  ];
}

/* ------------------------------------------------------------ the arena */

function tableLines(state, p) {
  const out = [];
  for (let row = 0; row < 3; row++) {
    const boxes = [0, 1, 2].map((col) => cellBox(state, p, row * 3 + col));
    for (let i = 0; i < 6; i++) out.push(boxes.map((b) => b[i]).join(''));
  }
  const pl = state.players[p];
  out.push(pl.golems.map((g) => {
    if (!g) return paint('[  --  ]', C.dim);
    const d = defOf(state, g);
    return paint(`[${d.name.slice(0, 7)} ${d.tier}${g.units.length}/${TIER_CAP[d.tier]}]`, C.golem);
  }).join(''));
  out.push(paint(`hand ${pl.hand.length}  deck ${pl.deck.length}  discard ${pl.discard.length}  learned ${pl.foundThisMatch.length}`, C.dim));
  return out;
}

/* ------------------------------------------------------------ the arena */

/**
 * The ground, read as relief rather than as absolute height.
 *
 * Mapped around the MEDIAN, not from the lowest point to the highest. On a
 * chasm arena nine tenths of the map is at zero and only the trench is below
 * it, and a ramp from min to max painted the whole board solid and the hole
 * blank -- technically correct and completely unreadable.
 */
const UP = '.-=+*#%@';
const DOWN = ':~ ';

function reliefChar(h, median, span) {
  if (h >= median) {
    const k = span > 0 ? Math.min(UP.length - 1, Math.round(((h - median) * (UP.length - 1)) / span)) : 0;
    return UP[k];
  }
  const d = median - h;
  return DOWN[Math.min(DOWN.length - 1, Math.round((d * (DOWN.length - 1)) / Math.max(1, span)))];
}

function arenaLines(state) {
  const cols = 60, rows = 20;
  const a = state.arena;
  let lo = 1e9, hi = -1e9;
  for (const h of a.hs) { if (h < lo) lo = h; if (h > hi) hi = h; }
  const span = Math.max(1, Math.max(hi - a.median, a.median - lo));

  // A PLAIN char grid first, coloured only where something is standing. One
  // escape sequence per character turned a twenty-line map into forty kilobytes
  // of terminal noise.
  const grid = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => {
    const x = Math.round((c + 0.5) * (ARENA_W / cols));
    const y = Math.round((r + 0.5) * (ARENA_H / rows));
    return reliefChar(heightAt(a, x, y), a.median, span);
  }));
  const ink = Array.from({ length: rows }, () => new Array(cols).fill(null));
  const put = (x, y, ch, colour) => {
    const c = Math.min(cols - 1, Math.max(0, Math.floor((x * cols) / ARENA_W)));
    const r = Math.min(rows - 1, Math.max(0, Math.floor((y * rows) / ARENA_H)));
    grid[r][c] = ch;
    ink[r][c] = colour;
  };
  for (const pr of state.field.props) {
    if (!propOnBoard(state, pr)) continue;
    const spec = propSpec(pr.kind);
    put(pr.x, pr.y, spec.floating ? '~' : pr.kind === 'pillar' ? '|' : pr.kind === 'wall' ? 'H' : 'o', C.grey);
  }
  for (const u of livingUnits(state)) {
    const tint = u.owner === 0 ? C.p0 : C.p1;
    put(u.x, u.y, u.kind === 'mage' ? (u.owner === 0 ? 'W' : 'M') : (u.owner === 0 ? 'g' : 'G'), C.bold + tint);
  }

  const out = grid.map((row, r) => paint('|', C.dim) + row.map((ch, c) => (ink[r][c] ? paint(ch, ink[r][c]) : ch)).join('') + paint('|', C.dim));
  out.unshift(paint('+' + '-'.repeat(cols) + '+', C.dim));
  out.push(paint('+' + '-'.repeat(cols) + '+', C.dim));
  out.push(paint(`${a.challenge}  ${ARENA_W / 1000}x${ARENA_H / 1000}m  relief ${lo}..${hi}mm, median ${a.median}`, C.dim));
  out.push(paint(`W/g = yours   M/G = theirs   | pillar  H wall  o rock  ~ floating rock   ${UP} rising   ${DOWN.trim()} below`, C.dim));
  return out;
}

function unitLines(state) {
  return livingUnits(state).sort((x, y) => x.id - y.id).map((u) => {
    const tint = u.owner === 0 ? C.p0 : C.p1;
    const name = u.kind === 'mage' ? 'mage' : (CARDS[u.def]?.name || 'golem');
    return paint(`  p${u.owner} ${name.padEnd(14)} ${String(u.hp).padStart(2)}/${u.maxHp} hp  at ${String(u.x).padStart(5)},${String(u.y).padStart(4)} z${String(u.z).padStart(5)}${u.poison ? `  poison ${u.poison}` : ''}${u.acted ? '  acted' : ''}`, tint);
  });
}

/* ------------------------------------------------------------ narration */

const name = (state, uid) => {
  for (let p = 0; p < 2; p++) {
    for (let c = 0; c < CELLS; c++) for (const s of stackAt(state, p, c)) if (s.uid === uid) return defOf(state, s).name;
    for (const z of ['hand', 'deck', 'discard']) for (const s of state.players[p][z]) if (s.uid === uid) return defOf(state, s).name;
    for (const g of state.players[p].golems) if (g && g.uid === uid) return defOf(state, g).name;
  }
  return `#${uid}`;
};
const unitName = (state, id) => {
  const u = state.field.units.find((x) => x.id === id);
  if (!u) return `unit#${id}`;
  return `p${u.owner} ${u.kind === 'mage' ? 'mage' : (CARDS[u.def]?.name || 'golem')}`;
};

/** Turn one note into a line of English, or null to say nothing about it. */
function narrate(state, f) {
  switch (f.kind) {
    case 'play': return `${paint(`p${f.p}`, f.p ? C.p1 : C.p0)} plays ${paint(name(state, f.uid), C.bold)} to ${CELL_COLOR[f.cell]} (cell ${f.cell})`;
    case 'golemCard': return `${paint(`p${f.p}`, f.p ? C.p1 : C.p0)} sets ${paint(name(state, f.uid), C.golem)} into slot ${f.slot}`;
    case 'rotate': return `  rotates ${name(state, f.uid)} ${f.dir} to ${NUMERALS[f.rot]}`;
    case 'shift': return `  shifts ${name(state, f.uid)} from cell ${f.from} to ${f.to}`;
    case 'destroy': return `  ${paint('destroys', C.red)} ${name(state, f.uid)}${f.by ? ` (${f.by})` : ''}`;
    case 'match': return `  ${paint('MATCH', C.bold + C.gold)} at junction ${f.vertex}: ${f.uids.map((u) => name(state, u)).join(' + ')} -> ${paint(name(state, f.chosen), C.bold)} turns`;
    case 'matchLocked': return `  match at junction ${f.vertex} is locked -- nothing can turn`;
    case 'matchExhausted': return `  junction ${f.vertex} has nothing left that may turn`;
    case 'resolveStart': return `    ${paint(`${CARDS[f.def]?.name || f.def} ${f.numeral}`, C.bold)}: ${CARDS[f.def]?.faces?.[NUMERALS.indexOf(f.numeral)]?.text || ''}`;
    case 'gateUnmet': return `      ${paint('inert', C.dim)} -- ${f.text || 'the gate is unmet'} (the rotation stands)`;
    case 'fizzle': return `      ${paint('fizzles', C.dim)} -- ${f.cost} was not paid`;
    case 'keywordCopy': return `      copies [${paint(f.kw, C.purple)}] from ${name(state, f.from)} to ${name(state, f.to)}`;
    case 'keywordGrant': return `      grants [${paint(f.kw, C.purple)}] to ${name(state, f.uid)}`;
    case 'damage': return `      ${paint(`${f.amount} damage`, C.red)} to ${unitName(state, f.id)}${f.cause !== 'spell' ? ` (${f.cause})` : ''}`;
    case 'push': return f.body === 'unit' ? `      pushes ${unitName(state, f.id)} ${f.mm}mm` : `      shoves terrain ${f.id} ${f.mm}mm`;
    case 'falls': return `      ${paint('FALLS', C.bold)}: ${f.landed.map((l) => `${l.key} drops ${l.drop}mm`).join(', ')}`;
    case 'kill': return `  ${paint('KILLED', C.bold + C.red)}: p${f.p}'s ${f.victim}${f.by !== null ? ` by p${f.by}` : ''}`;
    case 'score': return `  ${paint(`+${f.amount} VP`, C.bold + C.gold)} to p${f.p} (${f.source})`;
    case 'summon': return `  p${f.p} summons ${name(state, f.uid)}`;
    case 'strike': return `      strikes ${unitName(state, f.to)} for ${f.amount}${f.edge ? ' (+1 high ground)' : ''}`;
    case 'move': return `  ${unitName(state, f.id)} moves ${f.mm}mm`;
    case 'respawn': return `  p${f.p}'s mage ${paint('respawns', C.bold)}`;
    case 'found': return `  p${f.p} ${paint('learns', C.green)} ${CARDS[f.defId]?.name || f.defId} -- ${FINDS[f.why]?.text || f.why}`;
    case 'golemSpent': return `  ${name(state, f.uid)} is spent and goes to p${f.p}'s discard`;
    case 'terrainRemoved': return `      removes terrain ${f.id} until end of turn`;
    case 'levitate': return `      raises terrain ${f.id} by ${f.mm}mm`;
    case 'relocate': return `      relocates ${unitName(state, f.id)}`;
    case 'reshuffle': return `  p${f.p} shuffles their discard back into their deck`;
    case 'prohibited': return `      ${name(state, f.uid)} may not be rotated again this turn`;
    case 'win': return paint(`\n*** p${f.p} WINS -- ${f.reason} ***`, C.bold + C.gold);
    case 'draw': return paint(`\n*** a draw at the turn cap ***`, C.bold);
    case 'chainEnd': return f.resolutions > 1 ? paint(`  (a chain of ${f.resolutions})`, C.dim) : null;
    default: return null;
  }
}

/* ------------------------------------------------------------ playing it */

/**
 * The human seat.
 *
 * It goes through `legalActions` and `choose` like the AI does, which is the
 * whole point: there is no second copy of the rules anywhere, so a human cannot
 * be offered a move the engine would refuse, and the engine cannot have a move
 * it forgot to offer.
 */
import { createInterface } from 'node:readline';

const rl = HUMAN === null ? null : createInterface({ input: process.stdin, output: process.stdout });
const ask1 = (q) => new Promise((res) => rl.question(q, res));

/** Legal actions, grouped and numbered, with the reason each one is interesting. */
function describeAction(state, a) {
  if (a.type === 'play') {
    const c = state.players[state.active].hand.find((x) => x.uid === a.uid);
    const d = defOf(state, c);
    if (a.slot !== undefined) return `set ${paint(d.name, C.golem)} (tier ${d.tier}) into slot ${a.slot}`;
    return `play ${paint(d.name, C[d.school])} onto ${CELL_COLOR[a.cell]} cell ${a.cell}`;
  }
  if (a.type === 'rotate') {
    const sp = spellsOn(state, state.active).find((x) => x.uid === a.uid);
    const d = defOf(state, sp);
    const next = NUMERALS[(activeIndex(sp) + 1) & 3];
    return `rotate ${paint(d.name, C[d.school])} left (cell ${sp.cell}) -> ${paint(next, C.bold)}: ${d.faces[(activeIndex(sp) + 1) & 3].text}`;
  }
  if (a.type === 'shift') {
    const sp = spellsOn(state, state.active).find((x) => x.uid === a.uid);
    return `shift ${defOf(state, sp).name} from cell ${sp.cell} to ${a.cell} (${CELL_COLOR[a.cell]})`;
  }
  if (a.type === 'destroy') {
    const sp = spellsOn(state, state.active).find((x) => x.uid === a.uid);
    return `destroy your own ${defOf(state, sp).name} (cell ${sp.cell})`;
  }
  if (a.type === 'draw') return 'draw a card';
  if (a.type === 'unit') {
    const u = state.field.units.find((x) => x.id === a.id);
    const who = u.kind === 'mage' ? 'your mage' : (CARDS[u.def]?.name || 'golem') + ` #${u.id}`;
    if (a.act === 'move') return `${who}: move ${a.label} up to ${a.mm}mm`;
    if (a.act === 'strike') return `${who}: strike ${unitName(state, a.target)}`;
    if (a.act === 'summon') return `${who}: summon ${name(state, a.golem)}`;
    return `${who}: pass`;
  }
  return JSON.stringify(a);
}

function showHand(state, p) {
  const pl = state.players[p];
  if (!pl.hand.length) { console.log(paint('  (hand empty)', C.dim)); return; }
  console.log(paint(`  your hand (${pl.hand.length}):`, C.dim));
  for (const c of pl.hand) {
    const d = defOf(state, c);
    const kws = d.keywords.length ? paint(` [${d.keywords.join('] [')}]`, C.purple) : '';
    console.log(`    ${paint(d.name.padEnd(16), C[d.school])}${paint(d.school.padEnd(7), C.dim)}${kws}`);
    if (d.kind === 'golem') { console.log(paint(`      ${d.text}`, C.dim)); continue; }
    for (const f of d.faces) {
      console.log(paint(`      ${f.numeral.padEnd(4)}${RUNE_CH[d.runes[f.index]]}  ${f.text}`, C.dim));
    }
  }
}

async function humanAction(state) {
  const la = legalActions(state);
  if (!la.length) return null;
  showHand(state, state.active);
  console.log(paint(`\n  your ${state.phase === 'spell' ? 'SPELL ACTION (one only)' : 'UNIT PHASE'}:`, C.bold));
  la.forEach((a, i) => console.log(`   ${String(i).padStart(3)}) ${describeAction(state, a)}`));
  for (;;) {
    const line = (await ask1('  > ')).trim();
    if (line === 'q') { console.log('resigning.'); process.exit(0); }
    if (line === '?') { showHand(state, state.active); continue; }
    const i = Number(line);
    if (Number.isInteger(i) && i >= 0 && i < la.length) return la[i];
    console.log(paint(`  pick a number from 0 to ${la.length - 1}, or ? for your hand, or q to quit`, C.dim));
  }
}

async function humanAnswer(state) {
  const r = state.pending.request;
  console.log(paint(`\n  ${r.prompt || 'choose'}`, C.bold));
  if (r.type === 'confirm') {
    for (;;) {
      const line = (await ask1('  y/n > ')).trim().toLowerCase();
      if (line === 'y') return true;
      if (line === 'n') return false;
    }
  }
  const label = (o, i) => {
    if (r.labels && r.labels[i] !== undefined) return r.labels[i];
    if (r.kind === 'unit') return unitName(state, o);
    if (r.kind === 'prop') return `terrain ${o}`;
    if (r.kind === 'hand' || r.kind === 'target') return name(state, o);
    return String(o);
  };
  r.options.forEach((o, i) => console.log(`   ${String(i).padStart(3)}) ${label(o, i)}`));
  if (r.allowNone) console.log(`     -) decline`);
  if (r.type === 'some') {
    console.log(paint(`  choose ${r.count}, space-separated`, C.dim));
    for (;;) {
      const parts = (await ask1('  > ')).trim().split(/\s+/).map(Number);
      if (parts.length === r.count && parts.every((i) => i >= 0 && i < r.options.length)) {
        return parts.map((i) => r.options[i]);
      }
      console.log(paint(`  ${r.count} numbers, please`, C.dim));
    }
  }
  for (;;) {
    const line = (await ask1('  > ')).trim();
    if (line === '-' && r.allowNone) return null;
    const i = Number(line);
    if (Number.isInteger(i) && i >= 0 && i < r.options.length) return r.options[i];
    console.log(paint(`  pick a number from 0 to ${r.options.length - 1}`, C.dim));
  }
}

/* ------------------------------------------------------------ the match */

const rng = seedRng(SEED ^ 0xdeed);
const decks = POOL ? [randomDeck(rng, pick), randomDeck(rng, pick)] : null;
const state = createGame({ seed: SEED, decks });
const polFor = (p) => (p === 0 ? A : B);

console.log(paint(`\n WIZARD'S GAMBIT  seed ${SEED}  ${A} vs ${B}  arena: ${state.arena.challenge}`, C.bold));
console.log(paint(` p0 deck: ${state.players[0].deck.concat(state.players[0].hand).map((c) => defOf(state, c).name).sort().join(', ')}`, C.dim));
if (BOOK) {
  const known = Object.keys(book.learned).length;
  console.log(paint(` your Spellbook: ${known}/${FIND_IDS.length} ways known, ${book.matches} matches played, ${book.wins} won`, C.green));
  if (known && known < FIND_IDS.length) {
    // Three you already know, as a reminder of what you can aim this match at.
    // The Spellbook is knowledge, so showing it is the whole point of keeping it.
    const some = Object.entries(book.learned).slice(0, 3)
      .map(([cond, id]) => `${FINDS[cond]?.text || cond} -> ${CARDS[id]?.name || id}`);
    for (const line of some) console.log(paint(`   ${line}`, C.dim));
  }
}

function header() {
  const bar = (p) => paint(`${state.vp[p]}`, C.bold + C.gold);
  console.log(paint('\n' + '─'.repeat(74), C.dim));
  console.log(` turn ${paint(String(state.turn), C.bold)}   ${paint(`p${state.active}`, state.active ? C.p1 : C.p0)} to act   VP ${bar(0)} – ${bar(1)}   (first to 15)`);
  console.log(paint('─'.repeat(74), C.dim));
}

function showBoard() {
  const left = tableLines(state, 0), right = tableLines(state, 1);
  console.log(` ${paint('p0 spell table', C.p0)}${' '.repeat(10)}${paint('p1 spell table', C.p1)}`);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    // Padded by VISIBLE width: the strings are full of escape sequences, so
    // padEnd on the raw string lines nothing up.
    const l = left[i] || '';
    const vis = l.replace(/\x1b\[[0-9;]*m/g, '').length;
    console.log(` ${l}${' '.repeat(Math.max(0, 23 - vis))}  ${right[i] || ''}`);
  }
  console.log('');
  for (const l of arenaLines(state)) console.log(' ' + l);
  for (const l of unitLines(state)) console.log(l);
}

let fxSeen = 0, steps = 0, lastTurn = 0;
const flush = () => {
  for (const f of state.fx.slice(fxSeen)) {
    const line = narrate(state, f);
    if (line !== null && !QUIET) console.log(line);
  }
  fxSeen = state.fx.length;
};

if (BOARD) { header(); showBoard(); }

while (state.winner === null && steps < 9000) {
  steps++;
  if (state.turn !== lastTurn) {
    lastTurn = state.turn;
    if (BOARD && state.turn > 1) { header(); showBoard(); }
    if (TO && state.turn > TO) break;
  }
  try {
    if (state.pending) {
      const whose = state.pending.request.player ?? state.active;
      const answer = whose === HUMAN ? await humanAnswer(state) : answerFor(state, { policy: polFor(whose) });
      choose(state, answer);
    } else {
      const a = state.active === HUMAN ? await humanAction(state) : chooseAction(state, { policy: polFor(state.active) });
      if (!a) break;
      apply(state, a);
    }
  } catch (e) {
    console.log(paint(`\nthe engine threw: ${e.message}`, C.red));
    console.log(e.stack);
    break;
  }
  flush();
  // Between a human's action and the opponent's, redraw -- the board after your
  // chain has resolved is the thing you need to see before deciding again.
  if (HUMAN !== null && BOARD && !state.pending && state.active === HUMAN && state.phase === 'spell') {
    header(); showBoard();
  }
}
flush();
rl?.close();

console.log(paint('\n' + '─'.repeat(74), C.dim));
console.log(` final  VP ${state.vp[0]} – ${state.vp[1]}   turn ${state.turn}   ${state.winner === -1 ? 'a draw' : state.winner === null ? 'unfinished' : `p${state.winner} wins`}   hash ${hashState(state)}`);
if (BOOK) {
  // What this match taught you. Written AFTER the game, from the note stream,
  // so a find that happened inside an effect that was later replayed is not
  // recorded twice.
  const fresh = [];
  for (const f of state.fx) {
    if (f.kind !== 'found' || f.p !== HUMAN || !f.why) continue;
    if (book.learned[f.why] === f.defId) continue;
    book.learned[f.why] = f.defId;
    fresh.push(`${FINDS[f.why]?.text || f.why} -> ${CARDS[f.defId]?.name || f.defId}`);
  }
  book.matches++;
  if (state.winner === HUMAN) book.wins++;
  try {
    writeFileSync(BOOK, JSON.stringify(book, null, 1));
    console.log(paint(`\n your Spellbook (${BOOK}): ${Object.keys(book.learned).length}/${FIND_IDS.length} ways known`, C.green));
    for (const line of fresh) console.log(paint(`   learned: ${line}`, C.green));
    if (!fresh.length) console.log(paint('   nothing new this match', C.dim));
  } catch (e) {
    console.log(paint(` could not write the Spellbook to ${BOOK}: ${e.message}`, C.dim));
  }
}

for (let p = 0; p < 2; p++) {
  const L = state.players[p].ledger;
  console.log(paint(`  p${p}  ${L.chainsResolved} chains (longest ${L.longestChain})  ${L.rotations} rotations  ${L.spellsDestroyed} spells lost  ${L.damageDealt} damage  ${L.summons} summons  ${L.cardsFound} cards learned`, p ? C.p1 : C.p0));
  console.log(paint(`      VP: ${L.vpFromObjectives} from objectives, ${L.vpFromKills} from kills`, C.dim));
}
