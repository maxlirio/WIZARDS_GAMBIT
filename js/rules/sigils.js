// SIGILS -- how spells are FOUND.
//
// Every face you RESOLVE earns you one rune of its kind of work: a Spiral for
// turning, a Shard for breaking, a Wheel for moving, a Lattice for drawing
// (the verb taxonomy in runes.js). Runes bank up in your POUCH across turns.
// Every findable card has a SIGIL: a small shape of four runes (five for a
// gold card or a golem), printed in the Spellbook once you have made it.
// Once a turn, free, you may lay runes from your pouch on a 4 x 4 board and
// BIND: whatever sigils the board completes, laid exactly as drawn, are
// found -- their runes are spent and the card goes to your discard for the
// rest of the duel -- and every other rune goes back to the pouch. Nothing
// stays on the board between turns; the board is a scratch surface the HUD
// draws, and the engine sees only the bind.
//
// That replaced two earlier Spellbooks. The first was EARNED conditions ("let
// your mage be wounded to half"): a quest you must SEEK, and a quest that
// wins games is a rut every match falls into. The second handed you one random
// rune a turn to set on a persistent board, which the user found too wide to
// ever close ("too many combinations to find out a spell for sure") and
// impossible to clear. Now the runes come from what you actually do, you keep
// them until you choose to use them, and a sigil is something you FIGURE OUT
// -- the Spellbook hints at which runes a card takes, the shape is yours to
// find (user: "think minecraft table, but more intricate").
//
// Everything here is pure over plain data so it replays and hashes: the pouch
// lives on the player, a bind is an action like any other.

import { RUNES } from './runes.js';
import { fx } from './ops.js';
import { bump } from './ledger.js';

export const BOARD_W = 4;
export const BOARD_H = 4;
export const BOARD_CELLS = BOARD_W * BOARD_H;

/** Sigil rows are written with one letter per rune; '.' is an empty cell. */
export const LETTER = Object.freeze({ S: 'SPIRAL', H: 'SHARD', W: 'WHEEL', L: 'LATTICE' });
export const LETTER_OF = Object.freeze({ SPIRAL: 'S', SHARD: 'H', WHEEL: 'W', LATTICE: 'L' });

/** The pouch: how many of each rune a player holds. */
export const emptyPouch = () => ({ SPIRAL: 0, SHARD: 0, WHEEL: 0, LATTICE: 0 });

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

/**
 * ORIENTATION MATTERS (user: "orientation should matter"): a sigil is the
 * shape exactly as drawn, never its turns. So the key of a sigil is its one
 * normalised form, a rotated copy is a different sigil, and a layout must be
 * laid the way the Spellbook shows it.
 */
export const canonical = (cells) => cellKey(normalise(cells));

/** Does `big` contain `small`, as drawn, at some offset? */
export function contains(big, small) {
  if (small.length > big.length) return false;
  const at = new Map(big.map((c) => [`${c.x},${c.y}`, c.r]));
  const ow = Math.max(...small.map((c) => c.x)), oh = Math.max(...small.map((c) => c.y));
  const bw = Math.max(...big.map((c) => c.x)), bh = Math.max(...big.map((c) => c.y));
  for (let dy = 0; dy + oh <= bh; dy++) for (let dx = 0; dx + ow <= bw; dx++) {
    if (small.every((c) => at.get(`${c.x + dx},${c.y + dy}`) === c.r)) return true;
  }
  return false;
}

/** The rune multiset of a sigil, for the Spellbook's hint about an unfound card. */
export const sigilRunes = (cells) => cells.map((c) => c.r).sort();

/** The findable sigils still open to `p` this match, in id order. */
export function openPatterns(state, p) {
  const done = state.players[p].foundThisMatch;
  return (state.findable || [])
    .filter((f) => f.sigil && !done.includes(f.id))
    .map((f) => ({ id: f.id, cells: f.sigil }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/* ------------------------------------------------------------ the pouch */

/** A resolved face pays its rune into the owner's pouch. */
export function earnRune(state, p, rune, why = {}) {
  if (!RUNES.includes(rune)) return;
  const pl = state.players[p];
  pl.runes[rune]++;
  bump(pl.ledger, 'runesEarned');
  fx(state, 'rune', { p, rune, ...why });
}

/** The runes `cells` would take, as a pouch-shaped count. */
export function runesNeeded(cells) {
  const need = emptyPouch();
  for (const c of cells) need[c.r]++;
  return need;
}

export const canAfford = (pouch, cells) => {
  const need = runesNeeded(cells);
  return RUNES.every((r) => need[r] <= (pouch[r] || 0));
};

/**
 * Why `cells` is not a bind `p` may make now, or null when it is. The cells
 * are [{idx, r}] on the 4 x 4 board; the whole layout must come out of the
 * pouch. Structural, so a human's arbitrary layout can be checked without
 * enumerating every layout there is.
 */
export function bindError(state, p, cells) {
  if (!Array.isArray(cells) || !cells.length) return 'nothing is laid on the board';
  if (cells.length > BOARD_CELLS) return 'more runes than the board has cells';
  const seen = new Set();
  for (const c of cells) {
    if (!c || !Number.isInteger(c.idx) || c.idx < 0 || c.idx >= BOARD_CELLS) return 'a rune is off the board';
    if (!RUNES.includes(c.r)) return `'${c?.r}' is not a rune`;
    if (seen.has(c.idx)) return 'two runes on one cell';
    seen.add(c.idx);
  }
  if (!canAfford(state.players[p].runes, cells)) return 'the pouch does not hold those runes';
  return null;
}

/**
 * The sigils a layout completes: every open pattern, as drawn, at every
 * offset, largest first and ties by id, each rune spent by at most one
 * sigil. Pure, so a harness can ask it about a layout it has not sent.
 */
export function bindHits(patterns, cells) {
  const at = new Map(cells.map((c) => [c.idx, c.r]));
  const used = new Set();
  const hits = [];
  const sorted = [...patterns].sort((a, b) => b.cells.length - a.cells.length || a.id.localeCompare(b.id));
  for (const { id, cells: shape } of sorted) {
    let hit = null;
    const ow = Math.max(...shape.map((c) => c.x)), oh = Math.max(...shape.map((c) => c.y));
    for (let dy = 0; dy + oh < BOARD_H && !hit; dy++) for (let dx = 0; dx + ow < BOARD_W && !hit; dx++) {
      const idxs = shape.map((c) => (c.y + dy) * BOARD_W + c.x + dx);
      if (shape.every((c, i) => at.get(idxs[i]) === c.r && !used.has(idxs[i]))) hit = idxs.sort((a, b) => a - b);
    }
    if (hit) { for (const i of hit) used.add(i); hits.push({ id, cells: hit }); }
  }
  return hits;
}

/**
 * BIND: lay `cells` from `p`'s pouch, find what they complete, spend those
 * runes, return the rest. Each find is queued as a question to the finder.
 * Returns the hits.
 */
export function bind(state, p, cells) {
  const pl = state.players[p];
  const hits = bindHits(openPatterns(state, p), cells);
  const at = new Map(cells.map((c) => [c.idx, c.r]));
  for (const hit of hits) {
    for (const i of hit.cells) pl.runes[at.get(i)]--;
    pl.foundThisMatch.push(hit.id);
  }
  fx(state, 'bind', { p, cells: cells.map((c) => ({ idx: c.idx, r: c.r })), hits: hits.map((h) => ({ id: h.id, cells: [...h.cells] })) });
  for (const hit of hits) {
    fx(state, 'sigil', { p, defId: hit.id, cells: hit.cells });
    state.queue.push({ kind: 'find', p, defId: hit.id, why: 'sigil', seq: ++state.actionSeq });
  }
  return hits;
}

/**
 * One bind action per open sigil the pouch can pay for, laid at the board's
 * corner, in id order. What the AI and the harnesses enumerate; a player lays
 * whatever they like and `bindError` judges it.
 */
export function bindActions(state, p) {
  const pouch = state.players[p].runes;
  return openPatterns(state, p)
    .filter(({ cells }) => canAfford(pouch, cells))
    .map(({ id, cells }) => ({ type: 'bind', id, cells: cells.map((c) => ({ idx: c.y * BOARD_W + c.x, r: c.r })) }));
}
