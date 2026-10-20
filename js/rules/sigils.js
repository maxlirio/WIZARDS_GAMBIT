// THE SIGIL BOARD -- how spells are FOUND.
//
// Every turn you are handed one rune at random and you set it on your own
// 4 x 4 sigil board, anywhere, over anything. Every findable card has a
// SIGIL: a small shape of runes printed in the Spellbook once you have found
// it. The moment the rune you set completes a sigil, in any of its four
// turns, the runes of the sigil are spent and the card is yours for the rest
// of the duel.
//
// That replaces the old Spellbook of earned conditions ("let your mage be
// wounded to half"), which the user rejected: a condition is a quest you
// must SEEK, and a quest that wins games is a rut every match falls into.
// A sigil is something you FIGURE OUT -- the board fills on its own, you
// discover patterns by making them, and the Spellbook remembers the ones
// you have made (user: "think minecraft table, but more intricate").
//
// Everything here is pure over plain data so it replays and hashes: the rune
// handed out comes from the match's rng at turn start, the placement is a
// question through the driver like any other, and the board lives on the
// player.

import { RUNES } from './runes.js';
import { fx } from './ops.js';
import { pick as rngPick, int as rngInt } from './rng.js';

export const BOARD_W = 4;
export const BOARD_H = 4;
export const BOARD_CELLS = BOARD_W * BOARD_H;

/** Sigil rows are written with one letter per rune; '.' is an empty cell. */
export const LETTER = Object.freeze({ S: 'SPIRAL', H: 'SHARD', W: 'WHEEL', L: 'LATTICE' });
export const LETTER_OF = Object.freeze({ SPIRAL: 'S', SHARD: 'H', WHEEL: 'W', LATTICE: 'L' });

export const emptyBoard = () => ({ cells: Array(BOARD_CELLS).fill(null), piece: null });

/* ------------------------------------------------------------ patterns */

/** Rows -> normalised sorted cells [{x, y, r}]. Throws on a bad sigil. */
export function parseSigil(rows, id = '?') {
  if (!Array.isArray(rows) || !rows.length) throw new Error(`${id}: a sigil is an array of rows`);
  const cells = [];
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === '.') return;
      if (!LETTER[ch]) throw new Error(`${id}: sigil letter '${ch}' is not S, H, W or L`);
      cells.push({ x, y, r: LETTER[ch] });
    });
  });
  if (cells.length < 2 || cells.length > 6) throw new Error(`${id}: a sigil has 2 to 6 runes, not ${cells.length}`);
  // Connected, four ways: a sigil is one shape, not two.
  const seen = new Set([0]); const stack = [0];
  while (stack.length) {
    const i = stack.pop();
    cells.forEach((c, j) => {
      if (seen.has(j)) return;
      if (Math.abs(c.x - cells[i].x) + Math.abs(c.y - cells[i].y) === 1) { seen.add(j); stack.push(j); }
    });
  }
  if (seen.size !== cells.length) throw new Error(`${id}: sigil is not one connected shape`);
  return normalise(cells);
}

function normalise(cells) {
  const mx = Math.min(...cells.map((c) => c.x)), my = Math.min(...cells.map((c) => c.y));
  return cells.map((c) => ({ x: c.x - mx, y: c.y - my, r: c.r })).sort((a, b) => a.y - b.y || a.x - b.x);
}

const cellKey = (cells) => cells.map((c) => `${c.x},${c.y}${LETTER_OF[c.r]}`).join(' ');

/** The four quarter-turns of a sigil, deduped (a symmetric shape has fewer). */
export function orientations(cells) {
  const out = []; const keys = new Set();
  let cur = cells;
  for (let k = 0; k < 4; k++) {
    const key = cellKey(cur);
    if (!keys.has(key)) { keys.add(key); out.push(cur); }
    cur = normalise(cur.map((c) => ({ x: c.y, y: -c.x, r: c.r })));
  }
  return out;
}

/** One key for a sigil however it is turned: the smallest of its orientations. */
export const canonical = (cells) => orientations(cells).map(cellKey).sort()[0];

/** Does `big` contain `small` in some orientation at some offset? */
export function contains(big, small) {
  if (small.length > big.length) return false;
  const at = new Map(big.map((c) => [`${c.x},${c.y}`, c.r]));
  for (const o of orientations(small)) {
    const ow = Math.max(...o.map((c) => c.x)), oh = Math.max(...o.map((c) => c.y));
    const bw = Math.max(...big.map((c) => c.x)), bh = Math.max(...big.map((c) => c.y));
    for (let dy = 0; dy + oh <= bh; dy++) for (let dx = 0; dx + ow <= bw; dx++) {
      if (o.every((c) => at.get(`${c.x + dx},${c.y + dy}`) === c.r)) return true;
    }
  }
  return false;
}

/** The rune multiset of a sigil, for the Spellbook's hint about an unfound card. */
export const sigilRunes = (cells) => cells.map((c) => c.r).sort();

/* ------------------------------------------------------------ the board */

/** Every placement of every orientation of `cells` that covers board cell `idx`. */
function* placementsOver(cells, idx) {
  const px = idx % BOARD_W, py = Math.floor(idx / BOARD_W);
  for (const o of orientations(cells)) {
    const ow = Math.max(...o.map((c) => c.x)), oh = Math.max(...o.map((c) => c.y));
    for (const anchor of o) {
      const dx = px - anchor.x, dy = py - anchor.y;
      if (dx < 0 || dy < 0 || dx + ow >= BOARD_W || dy + oh >= BOARD_H) continue;
      yield o.map((c) => ({ idx: (c.y + dy) * BOARD_W + c.x + dx, r: c.r }));
    }
  }
}

/**
 * The sigils this board completes through cell `idx`, largest first, ties by
 * id. `patterns` is [{id, cells}] in a fixed order, so the answer never
 * depends on anything the state could vary.
 */
export function completions(board, patterns, idx) {
  const out = [];
  for (const { id, cells } of patterns) {
    for (const pl of placementsOver(cells, idx)) {
      if (pl.every((c) => board.cells[c.idx] === c.r)) { out.push({ id, cells: pl.map((c) => c.idx).sort((a, b) => a - b) }); break; }
    }
  }
  return out.sort((a, b) => b.cells.length - a.cells.length || a.id.localeCompare(b.id));
}

/** The findable sigils still open to `p` this match, in id order. */
export function openPatterns(state, p) {
  const done = state.players[p].foundThisMatch;
  return (state.findable || [])
    .filter((f) => f.sigil && !done.includes(f.id))
    .map((f) => ({ id: f.id, cells: f.sigil }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Turn start: one rune from the match's dice, waiting to be set. */
export function drawPiece(state, p) {
  const b = state.players[p].sigils;
  b.piece = rngPick(state.rng, RUNES);
  fx(state, 'sigilDraw', { p, rune: b.piece });
  return b.piece;
}

/**
 * Set the waiting rune on cell `idx` (over whatever was there) and resolve
 * what it completes. Returns the completed sigil's card id, or null.
 */
export function placePiece(state, p, idx) {
  const pl = state.players[p];
  const b = pl.sigils;
  if (b.piece === null || idx < 0 || idx >= BOARD_CELLS) return null;
  const rune = b.piece;
  b.cells[idx] = rune;
  b.piece = null;
  fx(state, 'sigilPlace', { p, idx, rune });
  const done = completions(b, openPatterns(state, p), idx);
  if (!done.length) return null;
  const hit = done[0];
  for (const i of hit.cells) b.cells[i] = null;        // the runes are spent
  pl.foundThisMatch.push(hit.id);
  fx(state, 'sigil', { p, defId: hit.id, cells: hit.cells });
  state.queue.push({ kind: 'find', p, defId: hit.id, why: 'sigil', seq: ++state.actionSeq });
  return hit.id;
}

/**
 * The AI's placement: complete a sigil if one can be completed; otherwise
 * the cell that brings some open sigil nearest to completion, keeping what
 * is already set; ties broken by the AI's own dice, never the match's.
 */
export function bestPlacement(state, p, rng) {
  const b = state.players[p].sigils;
  const rune = b.piece;
  const patterns = openPatterns(state, p);
  let best = [], bestScore = -Infinity;
  for (let idx = 0; idx < BOARD_CELLS; idx++) {
    let score = b.cells[idx] === null ? 0 : -0.6;
    const trial = { cells: b.cells.slice() }; trial.cells[idx] = rune;
    const done = completions(trial, patterns, idx);
    if (done.length) score += 100 + done[0].cells.length * 10;
    else {
      let progress = 0;
      for (const { cells } of patterns) {
        for (const pl of placementsOver(cells, idx)) {
          if (pl.some((c) => c.idx === idx && c.r !== rune)) continue;
          let ok = 0, clash = false;
          for (const c of pl) { const have = trial.cells[c.idx]; if (have === c.r) ok++; else if (have !== null) { clash = true; break; } }
          if (clash) continue;
          progress = Math.max(progress, ok / pl.length + (ok === pl.length - 1 ? 0.5 : 0));
        }
      }
      score += progress * 10;
    }
    if (score > bestScore + 1e-9) { bestScore = score; best = [idx]; }
    else if (Math.abs(score - bestScore) < 1e-9) best.push(idx);
  }
  return best.length ? best[rngInt(rng, best.length)] : 0;
}
