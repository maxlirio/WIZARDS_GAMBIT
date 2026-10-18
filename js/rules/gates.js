// Gates: the preconditions printed on a face. "You may only rotate this Spell
// if you control a Spell on each of the four corners."
//
// A CLOSED REGISTRY of PURE PREDICATES, recomputed on every query and never
// stored. Closed because a gate written as an inline arrow on a card is a gate
// the AI cannot reason about, the UI cannot explain, and verify-faces cannot
// check -- and the first two of those matter at the table.
//
// THE RULE THAT MATTERS MOST, and the one that keeps the chain's termination
// proof intact:
//
//   A gate restricts VOLUNTARY rotation and voluntary use only. A forced
//   rotation from a match happens regardless, and a face whose gate is unmet
//   resolves as INERT -- nothing happens, no VP -- but the rotation stands.
//
// Four reasons, and the first is structural. If a gate could block a forced
// rotation, the chain would have to SKIP that vertex, and skip is exactly the
// shape that reintroduces loops -- the bound depends on every link spending a
// vertex whatever happens. Second, it makes chains dangerous, which is the
// point of them being mandatory. Third, it asks no extra question, so there is
// no new replay surface. Fourth, it hands the defender a real line: resolving
// the inert card on purpose is how you defuse a chain, and that is skill
// expression generated for free.
//
// A PROHIBITION is a different and stronger thing -- "you may not rotate this
// Spell again this turn" -- and lives in ops.js::prohibited, not here.

import { topOf, spellsOn, defOf, occupied, stackAt } from './ops.js';
import { CELL_COLOR, CELLS, above, below, leftOf, rightOf, orthoNeighbours } from './table.js';
import { keywordsOf, apply as applyKeywords } from './keywords.js';
import { LEDGER_KEYS } from './ledger.js';
import { unitsOf, enemiesOf, livingUnits, mageOf, onHighGround, rangeOrigins, unitHas } from '../field/query.js';
import { dist3 } from '../field/fixed.js';

const pct = (have, want) => (want <= 0 ? 100 : Math.min(100, Math.floor((have * 100) / want)));
const L = (state, spell) => state.players[spell.owner].ledger;

/**
 * Every gate in the game.
 *
 * `test` is pure. `progress` returns 0..100 and exists for the AI: a bot that
 * cannot see it is two spells away from a scoring condition plays gold like a
 * blank card, and "how close am I" is not something you can read off a boolean.
 * `text` is the phrasing, used by the UI to say WHY a rotate is not on offer.
 */
export const GATES = Object.freeze({
  always: {
    text: '',
    test: () => true,
    progress: () => 100,
  },

  /** Counts history. The whole reason ledger.js exists. */
  ledgerAtLeast: {
    text: (g) => `${g.key} at least ${g.n} this duel`,
    test: (state, sp, g) => L(state, sp)[g.key] >= g.n,
    progress: (state, sp, g) => pct(L(state, sp)[g.key], g.n),
  },

  /** Reads the board. */
  spellsAtLeast: {
    text: (g) => `you control ${g.n} or more Spells${g.school ? ` of ${g.school}` : ''}`,
    test: (state, sp, g) => countSpells(state, sp.owner, g.school) >= g.n,
    progress: (state, sp, g) => pct(countSpells(state, sp.owner, g.school), g.n),
  },

  spellsAtMost: {
    text: (g) => `you control ${g.n} or fewer Spells`,
    test: (state, sp, g) => countSpells(state, sp.owner, null) <= g.n,
    progress: (state, sp, g) => (countSpells(state, sp.owner, null) <= g.n ? 100 : 0),
  },

  /** A named neighbour holds something. Printed Spell Drain's above/right/below. */
  neighbourFilled: {
    text: (g) => `the cell ${g.where} of this Spell is occupied`,
    test: (state, sp, g) => {
      const c = neighbour(sp.cell, g.where);
      return c !== null && occupied(state, sp.owner, c);
    },
    progress: (state, sp, g) => (GATES.neighbourFilled.test(state, sp, g) ? 100 : 0),
  },

  neighbourEmpty: {
    text: (g) => `the cell ${g.where} of this Spell is empty`,
    test: (state, sp, g) => {
      const c = neighbour(sp.cell, g.where);
      return c !== null && !occupied(state, sp.owner, c);
    },
    progress: (state, sp, g) => (GATES.neighbourEmpty.test(state, sp, g) ? 100 : 0),
  },

  /** This card is carrying enough [Keywords]. Purple's bread and butter. */
  keywordsAtLeast: {
    text: (g) => `this Spell has ${g.n} or more Keywords`,
    test: (state, sp, g) => keywordsOf(state, sp).length >= g.n,
    progress: (state, sp, g) => pct(keywordsOf(state, sp).length, g.n),
  },

  hasKeyword: {
    text: (g) => `this Spell has [${g.kw}]`,
    test: (state, sp, g) => keywordsOf(state, sp).includes(g.kw),
    progress: (state, sp, g) => (keywordsOf(state, sp).includes(g.kw) ? 100 : 0),
  },

  handAtLeast: {
    text: (g) => `you have ${g.n} or more cards in hand`,
    test: (state, sp, g) => state.players[sp.owner].hand.length >= g.n,
    progress: (state, sp, g) => pct(state.players[sp.owner].hand.length, g.n),
  },

  discardAtLeast: {
    text: (g) => `your discard holds ${g.n} or more cards`,
    test: (state, sp, g) => state.players[sp.owner].discard.length >= g.n,
    progress: (state, sp, g) => pct(state.players[sp.owner].discard.length, g.n),
  },

  /* ------------------------------------------------- the battlefield */

  mageAlive: {
    text: () => 'your mage is alive',
    test: (state, sp) => !!mageOf(state, sp.owner) && !mageOf(state, sp.owner).dead,
    progress: (state, sp) => (GATES.mageAlive.test(state, sp) ? 100 : 0),
  },

  unitsAtLeast: {
    text: (g) => `you have ${g.n} or more units on the battlefield`,
    test: (state, sp, g) => countUnits(state, sp.owner, g.kind) >= g.n,
    progress: (state, sp, g) => pct(countUnits(state, sp.owner, g.kind), g.n),
  },

  /** A friendly unit on the high ground. Derived -- look at the board. */
  highGround: {
    text: () => 'a friendly unit holds the high ground',
    test: (state, sp) => unitsOf(state, sp.owner).some((u) => onHighGround(state, u)),
    progress: (state, sp) => (GATES.highGround.test(state, sp) ? 100 : 0),
  },

  enemyInRange: {
    text: (g) => `an enemy unit is within ${g.mm / 1000}m`,
    test: (state, sp, g) => {
      const os = rangeOrigins(state, sp.owner);
      return enemiesOf(state, sp.owner).some((e) => os.some((o) => dist3(o, e, 1) <= g.mm * g.mm));
    },
    progress: (state, sp, g) => (GATES.enemyInRange.test(state, sp, g) ? 100 : 0),
  },

  enemyMageHurt: {
    text: (g) => `the enemy mage has lost ${g.n} or more hit points`,
    test: (state, sp, g) => {
      const m = mageOf(state, 1 - sp.owner);
      return !!m && (m.maxHp - m.hp) >= g.n;
    },
    progress: (state, sp, g) => {
      const m = mageOf(state, 1 - sp.owner);
      return m ? pct(m.maxHp - m.hp, g.n) : 0;
    },
  },

  /* ------------------------------------------------- the race */

  /** Comeback gates. A board state, so derived, and it reads off `state.vp`. */
  behindBy: {
    text: (g) => `you are behind by ${g.n} or more Victory Points`,
    test: (state, sp, g) => state.vp[1 - sp.owner] - state.vp[sp.owner] >= g.n,
    progress: (state, sp, g) => pct(state.vp[1 - sp.owner] - state.vp[sp.owner], g.n),
  },

  chainAtLeast: {
    text: (g) => `this chain has resolved ${g.n} or more links`,
    test: (state, sp, g) => (state.chain?.resolutions || 0) >= g.n,
    progress: (state, sp, g) => pct(state.chain?.resolutions || 0, g.n),
  },

  notFirstTurn: {
    text: () => 'it is not the first turn',
    test: (state) => state.turn > 1,
    progress: (state) => (state.turn > 1 ? 100 : 0),
  },
});

export const GATE_IDS = Object.freeze(Object.keys(GATES).sort());

/* ---------------------------------------------------------------- helpers */

const countSpells = (state, p, school) =>
  spellsOn(state, p).filter((s) => !school || defOf(state, s).school === school).length;

const countUnits = (state, p, kind) =>
  livingUnits(state).filter((u) => u.owner === p && (!kind || u.kind === kind)).length;

const neighbour = (cell, where) => {
  if (cell === null || cell === undefined) return null;
  if (where === 'above') return above(cell);
  if (where === 'below') return below(cell);
  if (where === 'left') return leftOf(cell);
  if (where === 'right') return rightOf(cell);
  throw new Error(`bad neighbour '${where}'`);
};

/**
 * Validate a gate at CARD LOAD TIME.
 *
 * A gate referring to a counter that does not exist would read `undefined >= 3`
 * -- false, forever, silently. Every gold face behind it would be permanently
 * unscoreable and the card would still look implemented.
 */
export function validateGate(cardId, numeral, gate) {
  if (!gate) return;
  const g = GATES[gate.id];
  if (!g) throw new Error(`${cardId} ${numeral}: no such gate '${gate.id}'`);
  if (gate.id === 'ledgerAtLeast' && !LEDGER_KEYS.includes(gate.key)) {
    throw new Error(`${cardId} ${numeral}: gate reads unknown ledger counter '${gate.key}'`);
  }
  if (gate.where && !['above', 'below', 'left', 'right'].includes(gate.where)) {
    throw new Error(`${cardId} ${numeral}: bad neighbour '${gate.where}'`);
  }
}

/** Is this face's gate satisfied right now? [Inevitable] says yes regardless. */
export function gateMet(state, spell, gate) {
  if (!gate) return true;
  const over = applyKeywords(state, spell, 'gate', { ignore: false });
  if (over.ignore) return true;
  const g = GATES[gate.id];
  if (!g) return false;
  try { return !!g.test(state, spell, gate); }
  catch (e) { (state.derivationErrors ||= []).push({ gate: gate.id, error: String(e && e.message || e) }); return false; }
}

/** 0..100. For the AI, and for a UI that wants to show a progress bar. */
export function gateProgress(state, spell, gate) {
  if (!gate) return 100;
  const g = GATES[gate.id];
  if (!g) return 0;
  try { return g.progress(state, spell, gate); } catch { return 0; }
}

export function gateText(gate) {
  if (!gate) return '';
  const g = GATES[gate.id];
  if (!g) return `(unknown gate ${gate.id})`;
  return typeof g.text === 'function' ? g.text(gate) : g.text;
}
