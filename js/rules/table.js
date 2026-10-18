// The Spell Table: a 3x3 of cells, and the 4x4 lattice of grid vertices where
// corners meet. Topology lives here AS DATA, computed once from the geometry and
// frozen, so no other file does index arithmetic on the board.
//
// Cells are row-major 0..8, in the owning player's own frame:
//
//      grey    RED    grey          0 1 2
//     GREEN  PURPLE   BLUE    =     3 4 5
//      grey   GOLD    grey          6 7 8
//
// A spell may only be PLAYED onto a cell matching its school; artifacts may be
// played onto any of the four grey corners. A spell shifted onto a mismatched
// colour cannot be rotated VOLUNTARILY (but a match can still rotate it).

export const GREY = 'grey', RED = 'red', BLUE = 'blue';
export const GOLD = 'gold', GREEN = 'green', PURPLE = 'purple';

export const CELL_COLOR = Object.freeze([
  GREY,  RED,    GREY,
  GREEN, PURPLE, BLUE,
  GREY,  GOLD,   GREY,
]);

/** Which cells a school may be played onto. Artifacts take the four corners. */
export const HOME = Object.freeze({
  red: [1], blue: [5], gold: [7], green: [3], purple: [4],
  artifact: [0, 2, 6, 8],
});

export const CELLS = 9;
export const rowOf = (c) => (c - c % 3) / 3;
export const colOf = (c) => c % 3;

/* ------------------------------------------------------------ cell adjacency */
// Printed cards address neighbours by name ("destroy the spell above this one",
// "the slot above this creature"), so these are first-class, not derived at the
// call site. null means "off the table" — a real answer, not an error.

export const above   = (c) => (c >= 3 ? c - 3 : null);
export const below   = (c) => (c <= 5 ? c + 3 : null);
export const leftOf  = (c) => (c % 3 !== 0 ? c - 1 : null);
export const rightOf = (c) => (c % 3 !== 2 ? c + 1 : null);

/** The three golem slots sit beneath the bottom row: slot i under cell 6+i. */
export const cellAboveSlot = (slot) => slot + 6;
export const slotBelowCell = (c) => (c >= 6 ? c - 6 : null);

export const orthoNeighbours = (c) =>
  [above(c), below(c), leftOf(c), rightOf(c)].filter((n) => n !== null);

/* ------------------------------------------------- the 4x4 vertex lattice */
// Corner positions on a card, CLOCKWISE FROM TOP-LEFT, matching the printed
// corner numerals I-IV:
//
//        0 ---- 1          0 = top-left     2 = bottom-right
//        |      |          1 = top-right    3 = bottom-left
//        3 ---- 2
//
// A cell at (row, col) puts those corners at lattice vertices (i=col, j=row):
//   TL (col,   row  )   TR (col+1, row  )   BR (col+1, row+1)   BL (col, row+1)
// Vertex id = j * 4 + i, so ids run 0..15 reading left-to-right, top-to-bottom.

export const VERTEX_COUNT = 16;
export const vertexId = (i, j) => j * 4 + i;

/** [cell][cornerPos] -> vertex id. */
export const CORNER_OF = Object.freeze(
  Array.from({ length: CELLS }, (_, c) => {
    const r = rowOf(c), k = colOf(c);
    return Object.freeze([
      vertexId(k,     r    ),   // 0 top-left
      vertexId(k + 1, r    ),   // 1 top-right
      vertexId(k + 1, r + 1),   // 2 bottom-right
      vertexId(k,     r + 1),   // 3 bottom-left
    ]);
  }),
);

/**
 * [vertex] -> [{cell, pos}, ...], ascending by cell.
 *
 * Ascending order is not cosmetic: two engines running lockstep must agree on
 * the ORDER a vertex's occupants are visited, not merely on the set. GUDNAK had
 * to be taught that twice (adjacentTo, then voidSquaresOf).
 */
export const VERTEX_CARDS = Object.freeze(
  Array.from({ length: VERTEX_COUNT }, (_, v) => {
    const out = [];
    for (let c = 0; c < CELLS; c++) {
      for (let pos = 0; pos < 4; pos++) if (CORNER_OF[c][pos] === v) out.push({ cell: c, pos });
    }
    out.sort((a, b) => a.cell - b.cell);
    return Object.freeze(out.map(Object.freeze));
  }),
);

/**
 * The vertices where a match can happen: those touched by 2 or more cells.
 *
 * On a 3x3 that is exactly 12 of the 16 — the 8 edge vertices (2 cells each)
 * and the 4 interior vertices (4 cells each). The 4 outer corners touch one
 * card and can never match.
 *
 * This 12 is the chain's termination bound: a chain spends each vertex at most
 * once, so it cannot exceed 12 links. See match.js.
 */
export const MATCH_SITES = Object.freeze(
  VERTEX_CARDS.map((cards, v) => (cards.length >= 2 ? v : -1)).filter((v) => v >= 0),
);

export const INTERIOR_SITES = Object.freeze(
  VERTEX_CARDS.map((cards, v) => (cards.length === 4 ? v : -1)).filter((v) => v >= 0),
);

/** The vertices this cell shares with at least one other cell. */
export const matchSitesOf = (c) => CORNER_OF[c].filter((v) => VERTEX_CARDS[v].length >= 2);
