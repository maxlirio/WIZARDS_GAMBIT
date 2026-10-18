// Gold's payout. The only place in the game that turns work into points.
//
// An objective is almost always PURE DATA -- a gate, a formula, and the implied
// cost of destroying itself -- so the common gold card needs no code at all.
// That matters more than it sounds: gold is the school that will grow to
// dozens of cards, every one of them a VP faucet, and a faucet with bespoke
// code is a faucet nobody can audit. One registry of formulas, and
// tools/verify-faces.js checks each card pays exactly what it prints.
//
// Objectives are REPEATABLE, and scoring DESTROYS THE GOLD SPELL and puts it in
// your discard. That round trip -- draw it again, play it again, set the gate up
// again -- is the entire VP throttle. There is no artificial per-turn cap,
// because the cap is the deck.

import { award, stampOf, alreadyScored } from './score.js';
import { spellsOn, defOf, destroy, fx } from './ops.js';
import { gateMet, gateText } from './gates.js';
import { keywordsOf } from './keywords.js';
import { bump } from './ledger.js';
import { livingUnits, unitsOf, onHighGround } from '../field/query.js';
import { LEDGER_KEYS } from './ledger.js';

const clampVp = (n, max) => (max ? Math.min(n, max) : n);

/**
 * How a gold face computes its points. A closed registry.
 *
 * Every formula is a pure function of (state, spell, spec) returning an integer.
 * `cap` is mandatory on anything that scales, because an uncapped per-counter
 * formula is a card that wins the game on turn forty without anybody noticing
 * it was the problem.
 */
export const VP_FORMULAS = Object.freeze({
  flat: {
    text: (f) => `${f.n} VP`,
    vp: (state, sp, f) => f.n,
  },

  /** The commonest gold shape: convert a counter into points. */
  perLedger: {
    text: (f) => `${f.per} VP per ${f.key} (max ${f.cap})`,
    vp: (state, sp, f) => clampVp(Math.floor(state.players[sp.owner].ledger[f.key] / (f.div || 1)) * f.per, f.cap),
  },

  perSpell: {
    text: (f) => `${f.per} VP per ${f.school || ''} Spell you control (max ${f.cap})`,
    vp: (state, sp, f) => clampVp(
      spellsOn(state, sp.owner).filter((s) => !f.school || defOf(state, s).school === f.school).length * f.per,
      f.cap,
    ),
  },

  perChain: {
    text: (f) => `${f.per} VP per link in this chain (max ${f.cap})`,
    vp: (state, sp, f) => clampVp((state.chain?.resolutions || 0) * f.per, f.cap),
  },

  perKeyword: {
    text: (f) => `${f.per} VP per Keyword on this Spell (max ${f.cap})`,
    vp: (state, sp, f) => clampVp(keywordsOf(state, sp).length * f.per, f.cap),
  },

  perUnit: {
    text: (f) => `${f.per} VP per friendly ${f.kind || 'unit'} (max ${f.cap})`,
    vp: (state, sp, f) => clampVp(
      unitsOf(state, sp.owner).filter((u) => !f.kind || u.kind === f.kind).length * f.per,
      f.cap,
    ),
  },

  perHighGround: {
    text: (f) => `${f.per} VP per friendly unit on the high ground (max ${f.cap})`,
    vp: (state, sp, f) => clampVp(
      unitsOf(state, sp.owner).filter((u) => onHighGround(state, u)).length * f.per,
      f.cap,
    ),
  },
});

export const VP_FORMULA_IDS = Object.freeze(Object.keys(VP_FORMULAS).sort());

export function validateObjective(cardId, numeral, obj) {
  if (!obj) return;
  if (!obj.vp) throw new Error(`${cardId} ${numeral}: objective has no vp formula`);
  const f = VP_FORMULAS[obj.vp.k];
  if (!f) throw new Error(`${cardId} ${numeral}: no such vp formula '${obj.vp.k}'`);
  if (obj.vp.k === 'flat') {
    if (!Number.isInteger(obj.vp.n) || obj.vp.n <= 0) throw new Error(`${cardId} ${numeral}: flat vp must be a positive integer`);
  } else {
    if (!Number.isInteger(obj.vp.cap) || obj.vp.cap <= 0) {
      throw new Error(`${cardId} ${numeral}: a scaling vp formula must declare a positive cap`);
    }
    if (obj.vp.k === 'perLedger' && !LEDGER_KEYS.includes(obj.vp.key)) {
      throw new Error(`${cardId} ${numeral}: objective reads unknown counter '${obj.vp.key}'`);
    }
  }
}

export const objectiveVp = (state, spell, obj) =>
  obj && obj.vp ? VP_FORMULAS[obj.vp.k].vp(state, spell, obj.vp) : 0;

export const objectiveText = (obj) =>
  obj ? `${VP_FORMULAS[obj.vp.k].text(obj.vp)}${obj.gate ? `, if ${gateText(obj.gate)}` : ''}` : '';

/**
 * Score it.
 *
 * Not a generator, and does not ask: by the time this runs the face's own cost
 * has already been paid and the gate already tested, so there is nothing left
 * to decide. The self-destroy happens AFTER the award, because a formula may
 * count the spells you control and this one is still one of them.
 */
export function scoreObjective(state, spell, face) {
  const obj = face.objective;
  if (!obj) return 0;
  if (obj.gate && !gateMet(state, spell, obj.gate)) {
    fx(state, 'objectiveGateUnmet', { uid: spell.uid, gate: obj.gate.id });
    return 0;
  }
  const objId = `${spell.def}:${face.numeral}`;
  if (alreadyScored(state, spell.owner, spell, objId)) return 0;

  const amount = objectiveVp(state, spell, obj);
  if (amount <= 0) return 0;
  const got = award(state, spell.owner, amount, {
    kind: 'objective', objId, uid: spell.uid, stamp: stampOf(spell, objId),
  });

  // "the reward part also destroys the spell and puts it in your discard, so
  // you have to wait." The throttle is the round trip, so this is not optional
  // and not a cost the player may decline.
  if (got > 0 && obj.keep !== true) destroy(state, spell.uid, { by: 'objective' });
  return got;
}
