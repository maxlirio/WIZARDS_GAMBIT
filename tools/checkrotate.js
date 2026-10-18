#!/usr/bin/env node
// Milestone 1 gate: prove the orientation algebra and the vertex lattice.
//
// This is worth a whole harness because every other system reads the board
// through these two files, and a wrong formula here fails SILENTLY -- the wrong
// face resolves, or the wrong corner matches, and the game state stays
// perfectly legal. The expected tables below are worked out BY HAND from the
// printed card layout, independently of the implementation, which is the only
// way a test like this means anything.
//
//   node tools/checkrotate.js

import * as O from '../js/rules/orient.js';
import * as T from '../js/rules/table.js';

let pass = 0, fail = 0;
const ok  = (c, m) => (c ? (pass++, 0) : (fail++, console.log('  FAIL ' + m)));
const eq  = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${m}\n        got      ${JSON.stringify(a)}\n        expected ${JSON.stringify(b)}`);

/* ---------------------------------------------------------- 1. faces by hand */
// A card authored clockwise from the top: faces = [I, II, III, IV].
// Turning it LEFT (counter-clockwise) carries the top face to the left, and
// brings the RIGHT face up to the top. So, reading [top, right, bottom, left]:
const CARD = { faces: ['I', 'II', 'III', 'IV'], runes: ['a', 'b', 'c', 'd'] };
const BY_HAND = [
  ['I',   'II',  'III', 'IV' ],   // rot 0  as printed
  ['II',  'III', 'IV',  'I'  ],   // rot 1  one turn left
  ['III', 'IV',  'I',   'II' ],   // rot 2
  ['IV',  'I',   'II',  'III'],   // rot 3
];

console.log('faces at each position, per rotation');
for (let rot = 0; rot < 4; rot++) {
  const got = [O.POS.top, O.POS.right, O.POS.bottom, O.POS.left]
    .map((p) => O.faceAt(CARD, { rot }, p));
  eq(got, BY_HAND[rot], `rot ${rot}: [top,right,bottom,left]`);
}

/* ------------------------------------------- 2. the identity everything uses */
console.log('activeIndex === rot, and the active face is the TOP face');
for (let rot = 0; rot < 4; rot++) {
  ok(O.activeIndex({ rot }) === rot, `activeIndex({rot:${rot}}) === ${rot}`);
  ok(O.activeFace(CARD, { rot }) === O.faceAt(CARD, { rot }, O.POS.top),
    `rot ${rot}: activeFace is the top face`);
}
// A spell is played at rot 0, so side I is active when it lands.
ok(O.activeFace(CARD, { rot: 0 }) === 'I', 'a freshly played spell shows side I');

/* --------------------------------------------- 3. corners follow the same law */
console.log('corners use the same formula as faces');
const CORNERS_BY_HAND = [
  ['a', 'b', 'c', 'd'],   // rot 0: [TL, TR, BR, BL] as printed
  ['b', 'c', 'd', 'a'],   // rot 1: CCW carries TL -> BL, so TR comes up to TL
  ['c', 'd', 'a', 'b'],
  ['d', 'a', 'b', 'c'],
];
for (let rot = 0; rot < 4; rot++) {
  const got = [0, 1, 2, 3].map((p) => O.runeAt(CARD, { rot }, p));
  eq(got, CORNERS_BY_HAND[rot], `rot ${rot}: [TL,TR,BR,BL]`);
}

/* ------------------------------------------------------------- 4. turn() math */
console.log('turning');
eq(O.turned(0, 'left'), 1, 'left from 0');
eq(O.turned(3, 'left'), 0, 'left wraps 3 -> 0');
eq(O.turned(0, 'right'), 3, 'right from 0 wraps to 3');
eq(O.turned(1, 'right'), 0, 'right from 1');
for (let rot = 0; rot < 4; rot++) {
  ok(O.turned(O.turned(rot, 'left'), 'right') === rot, `rot ${rot}: left then right is identity`);
  ok(O.turned(rot, 'left', 4) === rot, `rot ${rot}: four left turns is a full revolution`);
}
// Fire Bolt's printed staircase: side I says "rotate this Spell left", and the
// card is written so that brings up side II.
ok(O.activeFace(CARD, { rot: O.turned(0, 'left') }) === 'II',
  'a left turn from side I brings up side II (the Fire Bolt ladder)');

/* -------------------------------------------------- 5. the lattice is sound */
console.log('vertex lattice');
eq(T.MATCH_SITES.length, 12, 'exactly 12 matchable vertices');
eq(T.INTERIOR_SITES.length, 4, 'exactly 4 interior vertices');
eq(T.VERTEX_CARDS.filter((c) => c.length === 1).length, 4, '4 dead outer corners');
eq(T.VERTEX_CARDS.filter((c) => c.length === 2).length, 8, '8 two-card edge vertices');
eq(T.VERTEX_CARDS.filter((c) => c.length === 4).length, 4, '4 four-card interior vertices');
ok(T.VERTEX_CARDS.every((c) => [1, 2, 4].includes(c.length)),
  'every vertex touches 1, 2 or 4 cards and nothing else');

// CORNER_OF and VERTEX_CARDS must be mutual inverses, or a rune can be read at
// a vertex it does not actually occupy.
let inverse = true;
for (let c = 0; c < T.CELLS; c++) {
  for (let pos = 0; pos < 4; pos++) {
    const v = T.CORNER_OF[c][pos];
    if (!T.VERTEX_CARDS[v].some((e) => e.cell === c && e.pos === pos)) inverse = false;
  }
}
ok(inverse, 'CORNER_OF -> VERTEX_CARDS');
let inverse2 = true;
T.VERTEX_CARDS.forEach((cards, v) => {
  for (const { cell, pos } of cards) if (T.CORNER_OF[cell][pos] !== v) inverse2 = false;
});
ok(inverse2, 'VERTEX_CARDS -> CORNER_OF');
ok(T.VERTEX_CARDS.every((c) => c.every((e, i) => i === 0 || c[i - 1].cell < e.cell)),
  'every vertex lists its cards in ascending cell order (lockstep needs the ORDER)');

// Diagonal neighbours must share exactly one vertex; orthogonal ones exactly two.
const shared = (a, b) => T.CORNER_OF[a].filter((v) => T.CORNER_OF[b].includes(v)).length;
eq(shared(0, 1), 2, 'orthogonal cells 0 and 1 share two vertices');
eq(shared(0, 4), 1, 'DIAGONAL cells 0 and 4 share one vertex (so diagonals match)');
eq(shared(0, 8), 0, 'opposite corners 0 and 8 share nothing');
eq(shared(1, 7), 0, 'cells 1 and 7 are not adjacent at all');

/* --------------------------------- 6. the colour layout's emergent structure */
// Not a tautology: this is a claim about the board that the design relies on.
console.log('what the colour layout gets from the geometry');
const kinds = (c) => {
  const n = T.CORNER_OF[c].map((v) => T.VERTEX_CARDS[v].length);
  return { interior: n.filter((x) => x === 4).length,
           edge:     n.filter((x) => x === 2).length,
           dead:     n.filter((x) => x === 1).length };
};
eq(kinds(4), { interior: 4, edge: 0, dead: 0 },
  'PURPLE (centre) touches all four interior vertices and no two-card vertex');
for (const [c, name] of [[1, 'RED'], [3, 'GREEN'], [5, 'BLUE'], [7, 'GOLD']]) {
  eq(kinds(c), { interior: 2, edge: 2, dead: 0 }, `${name} touches 2 interior + 2 edge`);
}
for (const c of T.HOME.artifact) {
  eq(kinds(c), { interior: 1, edge: 2, dead: 1 },
    `grey corner ${c} touches 1 interior + 2 edge + 1 dead`);
}
ok(T.INTERIOR_SITES.every((v) => T.VERTEX_CARDS[v].some((e) => e.cell === 4)),
  'every interior vertex touches the purple centre');

/* ------------------------------------------------------- 7. named neighbours */
console.log('named cell adjacency (printed cards address these by name)');
eq(T.above(4), 1, 'above centre is red');
eq(T.below(4), 7, 'below centre is gold');
eq(T.leftOf(4), 3, 'left of centre is green');
eq(T.rightOf(4), 5, 'right of centre is blue');
eq(T.above(1), null, 'nothing above the top row');
eq(T.leftOf(3), null, 'nothing left of the left column');
eq(T.rightOf(5), null, 'nothing right of the right column');
eq(T.orthoNeighbours(4).sort(), [1, 3, 5, 7], 'centre has four orthogonal neighbours');
eq(T.orthoNeighbours(0).sort(), [1, 3], 'a corner has two');
eq(T.cellAboveSlot(0), 6, 'golem slot 0 sits under cell 6');
eq(T.slotBelowCell(8), 2, 'cell 8 has golem slot 2 beneath it');
eq(T.slotBelowCell(4), null, 'the centre cell has no golem slot');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
