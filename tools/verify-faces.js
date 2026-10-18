#!/usr/bin/env node
// Judge every face's CODE against its own PRINTED TEXT.
//
//   node tools/verify-faces.js [--selftest] [--card ID] [--verbose]
//
// This is the honest harness, and the only one that can catch a face that works
// perfectly and does the wrong thing. Everything else in the suite checks that
// the engine is self-consistent; this checks it against the card.
//
// HOW IT WORKS. Each face's text is parsed into CLAIMS -- "range 3m", "2 damage",
// "a Spell you control", "score 2 VP". Then an arena is staged in which every
// claim has something to be WRONG about: an enemy unit just inside the claimed
// range AND one just outside it, a friendly spell to target AND an enemy spell
// that must not be, a friendly unit that must not be hit. The face is forced to
// the rotation that makes it active and resolved through the real entry point.
//
// THE OFFERED SETS ARE INSPECTED, NOT JUST THE OUTCOME. Every `ask` request's
// options are recorded, and a range claim is checked by asserting that the
// out-of-range unit NEVER APPEARS as an option. Checking only the outcome would
// pass a face that offered an illegal target and then happened not to pick it,
// which is most of them under any fixed answer policy.
//
// THREE VERDICTS. A claim with no counter-example in reach is reported
// UNCHECKED, never as a pass. "Nothing was wrong" and "nothing could have been
// wrong" are different statements and conflating them is how a conformance
// suite becomes a rubber stamp.
//
// --selftest PLANTS FAULTS and fails if any escapes. A conformance checker that
// has never been shown to catch anything means nothing at all, and the faults
// planted here are the real ones: a face that ignores its range, one that hits
// its own side, one that rotates a card it may not, one that asks a question and
// does nothing, one that writes an undeclared derived bucket, one that declares
// a keyword it never grants, a blue face that awards VP, a gold face that scores
// without destroying itself, and -- unique to this game -- A FACE IMPLEMENTED
// UNDER THE WRONG NUMERAL.

import { createGame, hashState } from '../js/engine.js';
import { CARDS, allCards } from '../js/rules/spells/index.js';
import { resolveSide } from '../js/rules/resolve.js';
import { runEffect } from '../js/rules/driver.js';
import { makeCard, place, spellsOn, findSpell, defOf, prohibited } from '../js/rules/ops.js';
import { refresh, DERIVED_KEYS } from '../js/rules/derive.js';
import { HOME, CELL_COLOR, CELLS } from '../js/rules/table.js';
import { NUMERALS, activeIndex, rotFor } from '../js/rules/orient.js';
import { keywordsOf, KEYWORD_NAMES } from '../js/rules/keywords.js';
import { TIER_CAP } from '../js/rules/golems.js';
import { livingUnits, mageOf, findUnit } from '../js/field/query.js';
import { placeBody } from '../js/field/move.js';
import { M, mm } from '../js/field/fixed.js';

const flag = (n) => process.argv.includes(`--${n}`);
const argv = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : null; };
const SELFTEST = flag('selftest');
const ONLY = argv('card');
const VERBOSE = flag('verbose');

/* ============================================================ claim parsing */

/**
 * Turn printed text into checkable claims.
 *
 * Only the UNAMBIGUOUS parts. "Resolve a friendly Spell's face, adding adjacent
 * Keywords" claims `friendlyOnly` and nothing else, because what it then does
 * depends on a card this harness knows nothing about -- and a parser that
 * guessed would generate false failures, which is how a conformance suite gets
 * switched off.
 */
export function claimsOf(def, face) {
  const t = face.text;
  const c = [];
  const num = (s) => Math.round(parseFloat(s) * M);

  const range = t.match(/within ([\d.]+)m/);
  if (range) c.push({ kind: 'range', mm: num(range[1]) });

  const dmg = t.match(/[Dd]eal (\d+) damage/);
  if (dmg) c.push({ kind: 'damage', n: Number(dmg[1]) });

  // "Push a unit within 3m 2m." -- the first distance is the range, a second
  // bare distance is how far it goes.
  const dists = [...t.matchAll(/([\d.]+)m/g)].map((m) => num(m[1]));
  if (/[Pp]ush|[Pp]ull|[Rr]elocate|[Rr]aise/.test(t)) {
    const travel = range ? dists.filter((d) => d !== num(range[1])) : dists;
    if (travel.length) c.push({ kind: 'travel', mm: travel[travel.length - 1] });
  }

  const draw = t.match(/[Dd]raw (a|\d+) cards?/);
  if (draw) c.push({ kind: 'draws', n: draw[1] === 'a' ? 1 : Number(draw[1]) });

  // A SCALING payout and a FLAT one are different claims. "Score 1 VP per 3
  // damage you have dealt, up to 4" prints a 1 and pays up to 4, and reading
  // the 1 as the whole claim failed four gold faces for doing exactly what they
  // say.
  const vpScale = t.match(/score (\d+) VP per [^.]*?up to (\d+)/i);
  const vpFlat = t.match(/score (\d+) VP\.?$/i) || t.match(/score (\d+) VP[^p]/i);
  if (vpScale) c.push({ kind: 'vpScaling', per: Number(vpScale[1]), cap: Number(vpScale[2]) });
  else if (vpFlat) c.push({ kind: 'vp', n: Number(vpFlat[1]) });
  else if (/score \d+ VP/i.test(t)) c.push({ kind: 'vpAny' });
  if (/VP/.test(t)) c.push({ kind: 'goldOnly' });
  else c.push({ kind: 'neverScores' });

  if (/[Dd]estroy this (Spell|Artifact)/.test(t)) c.push({ kind: 'destroysSelf' });
  if (/score/i.test(t) && face.objective) c.push({ kind: 'scoringDestroys' });

  const rot = t.match(/[Rr]otate [^.]*? (left|right)/);
  if (rot) c.push({ kind: 'rotateDir', dir: rot[1] });

  // "a Spell you control" / "a friendly Spell" -- the enemy's table is off
  // limits unless the card carries [Spell Bane].
  if (/(Spell|Artifact)s? you control|friendly Spell/.test(t) && !def.keywords.includes('Spell Bane')) {
    c.push({ kind: 'friendlySpellsOnly' });
  }
  // A face that names BOTH sides -- "spend a friendly unit's action, deal 4
  // damage to an enemy" -- cannot have either side claim extracted from its
  // text, because the parser has no way to tell which clause belongs to the
  // cost and which to the effect. Claiming both failed the card for doing
  // exactly what it prints. Reported as unextractable rather than guessed.
  const saysFriendly = /friendly unit/.test(t);
  const saysEnemy = /enemy unit|enemy within|an enemy/.test(t);
  if (saysFriendly && !saysEnemy) c.push({ kind: 'friendlyUnitsOnly' });
  if (saysEnemy && !saysFriendly) c.push({ kind: 'enemyUnitsOnly' });
  if (/[Dd]estroy a (Spell|Artifact)/.test(t)) c.push({ kind: 'destroysSpell' });
  // Every face with an effect claims, at minimum, to DO something. A face that
  // asks a question, gets an answer, and leaves the board exactly as it was is
  // a half-written face, and it is invisible to every other check in the suite.
  if (face.effect) c.push({ kind: 'effectful' });

  const grant = t.match(/[Gg]rant a Spell \[([^\]]+)\]/);
  if (grant) c.push({ kind: 'grantsKeyword', kw: grant[1] });

  if (face.cost && face.cost.length) c.push({ kind: 'costPaid' });
  if (face.passive || face.passive2) c.push({ kind: 'passiveDeclared' });
  if (face.gate) c.push({ kind: 'gateBlocks' });
  if (/may not be rotated|not rotate this/.test(t)) c.push({ kind: 'prohibits' });

  return c;
}

/* ============================================================ the stage */

const FAR = 11000;   // a corner of the arena, out of every card's range

/**
 * Build a board in which every claim has something to be wrong about.
 *
 * The deliberate inclusions are the point: an enemy unit JUST OUTSIDE the
 * claimed range, an enemy spell on the opposing table, and a friendly unit --
 * none of which the face under test is allowed to touch. A stage that contained
 * only legal targets would pass a face that ignores its own restrictions.
 */
function stage(defs, cardId, numeral, opts = {}) {
  const def = defs[cardId];
  const faceIndex = NUMERALS.indexOf(numeral);
  const state = createGame({
    seed: 11, defs, decks: [[], []], findable: [],
    config: { strict: true },
  });

  // UIDS AND UNIT IDS ARE PUSHED HIGH, and this is not cosmetic.
  //
  // A request's options are plain numbers whatever they mean: a uid, a cell
  // index 0..8, a direction index 0..63, a position in a candidate list. The
  // range and side checks below work by asserting that a forbidden uid never
  // appears among the offered options -- and with uids starting at 1, `cell 3`
  // and `uid 3` are the same number. Seven faces were reported as offering the
  // enemy's Spells when what they had actually offered was a cell to shift to.
  for (const u of state.field.units) u.id += 500;
  state.field.nextUnitId += 500;
  state.nextUid += 1000;

  // The ledger is PRIMED, so a gold face's gate is met and its payout can
  // actually be observed. Left at zero, thirteen VP claims came back UNCHECKED
  // -- which is honest, but a conformance suite that cannot reach gold is not
  // checking the only school that scores.
  for (let p = 0; p < 2; p++) {
    for (const k of Object.keys(state.players[p].ledger)) state.players[p].ledger[k] = 20;
  }

  // The card under test, on a home cell, rotated so this face is on top.
  const cell = (HOME[def.kind === 'artifact' ? 'artifact' : def.school] || [4])[0];
  const card = makeCard(state, cardId, 0);
  card.rot = rotFor(faceIndex);
  card.playedTo = cell;
  card.plays = 1;
  place(state, 0, card, cell);

  // A friendly spell to be a legal target, ON ITS OWN HOME CELL so it is not
  // colour-locked -- a locked card is not rotatable, and with the friend parked
  // on a mismatched colour twenty `rotateDir` claims had no legal target and
  // came back UNCHECKED. Its school is chosen to differ from the card under
  // test so the two do not want the same cell.
  const friendId = opts.friendId || (def.school === 'green' ? 'SHOVE' : 'CHANGE');
  const friend = makeCard(state, friendId, 0);
  const friendCell = (HOME[defs[friendId].kind === 'artifact' ? 'artifact' : defs[friendId].school] || [3])[0];
  friend.playedTo = friendCell;
  friend.plays = 1;
  place(state, 0, friend, friendCell);

  const foeCard = makeCard(state, 'EMBER_LASH', 1);
  foeCard.playedTo = 1;
  foeCard.plays = 1;
  place(state, 1, foeCard, 1);

  // Hand cards, so a discard cost is payable and a draw has somewhere to come
  // from; deck cards so `draws` can be observed.
  for (let i = 0; i < 4; i++) state.players[0].hand.push(makeCard(state, 'SHOVE', 0));
  for (let i = 0; i < 6; i++) state.players[0].deck.push(makeCard(state, 'TALLY', 0));

  // Units. The mage is the range origin, so everything is measured from it.
  const mine = mageOf(state, 0);
  placeBody(state, mine, 2000, 4500);
  const theirs = mageOf(state, 1);

  const rangeClaim = claimsOf(def, def.faces[faceIndex]).find((x) => x.kind === 'range');
  const near = rangeClaim ? Math.max(600, rangeClaim.mm - 600) : 1500;
  const far = rangeClaim ? rangeClaim.mm + 2500 : FAR;
  // JUST INSIDE the claimed range...
  placeBody(state, theirs, mine.x + near, 4500);
  // ...and JUST OUTSIDE it. This body is the test.
  const outside = {
    body: 'unit', id: ++state.field.nextUnitId, owner: 1, kind: 'golem', def: 'CLAY_HAND', golemUid: null,
    hp: 9, maxHp: 9, move: 1000, atk: 1, reach: 900,
    x: Math.min(11000, mine.x + far), y: 1200, z: 0, support: { kind: 'ground' },
    acted: false, dead: false, poison: 0, keywords: [],
  };
  placeBody(state, outside, outside.x, outside.y);
  state.field.units.push(outside);
  // A friendly unit, which an enemy-only face must not touch.
  const ally = {
    body: 'unit', id: ++state.field.nextUnitId, owner: 0, kind: 'golem', def: 'CLAY_HAND', golemUid: null,
    hp: 9, maxHp: 9, move: 1000, atk: 1, reach: 900,
    x: mine.x + 400, y: 5600, z: 0, support: { kind: 'ground' },
    acted: false, dead: false, poison: 0, keywords: [],
  };
  placeBody(state, ally, ally.x, ally.y);
  state.field.units.push(ally);

  // Something for the faces that work on the PAST to work on: a spell in the
  // discard (recall, reanimate), a wounded mage (healing), and a rock beside
  // the enemy (Levitation drops one on them). Without these every such face
  // came back "nothing was in reach" and was never checked at all.
  state.players[0].discard.push(makeCard(state, 'EMBER_LASH', 0));
  mine.hp = Math.max(1, mine.hp - 2);
  state.field.props.push({ id: 'vrock', kind: 'boulder', x: theirs.x, y: 3300, z: 0,
    removedUntil: null, body: 'prop', support: { kind: 'ground' }, hp: 4, burning: null, litBy: null, destroyed: false });
  placeBody(state, state.field.props.at(-1), theirs.x, 3300);
  // And a tree beside them, so a fire face has something to set alight.
  state.field.props.push({ id: 'vtree', kind: 'tree', x: theirs.x + 700, y: 5300, z: 0,
    removedUntil: null, body: 'prop', support: { kind: 'ground' }, hp: 3, burning: null, litBy: null, destroyed: false });
  placeBody(state, state.field.props.at(-1), theirs.x + 700, 5300);

  refresh(state);
  state.tableDirty = [false, false];
  return { state, card, friend, foeCard, outside, ally, mine, theirs, cell, faceIndex, def };
}

/**
 * Resolve one face, recording every option set it ever offered.
 *
 * `policy` decides which option gets taken. Each face is run under TWO
 * policies, first-option and last-option, because one fixed policy makes the
 * difference between "this face cannot do anything" and "this face did nothing
 * with the particular answer it was handed". Printed Precision I rotates a
 * Spell to any side, and asked for a side it answered "I" -- which for a card
 * already showing I is a legal choice that correctly changes nothing.
 */
function runFace(st, policy = 'first') {
  const { state, card, faceIndex } = st;
  const offered = [];
  const before = snapshotOf(st);
  const descriptor = { kind: 'verify' };
  let r = runEffect(state, descriptor, () => resolveSide(state, card, faceIndex, {}));
  for (let i = 0; i < 60 && !r.done; i++) {
    offered.push({ ...r.pending, options: [...(r.pending.options || [])] });
    const req = r.pending;
    const answer = req.type === 'confirm' ? true
      : req.type === 'some' ? (policy === 'first' ? req.options.slice(0, req.count) : req.options.slice(-req.count))
      : policy === 'first' ? (req.options[0] ?? null)
      : (req.options[req.options.length - 1] ?? null);
    // Resumed through the driver directly, with the same descriptor, so the
    // replay path is exercised exactly as a real game exercises it.
    const { answerPending } = driverOf();
    r = answerPending(state, answer, () => () => resolveSide(state, card, faceIndex, {}), refresh);
  }
  refresh(state);
  return { offered, before, after: snapshotOf(st), done: r.done };
}

import { answerPending } from '../js/rules/driver.js';
const driverOf = () => ({ answerPending });

function snapshotOf(st) {
  const { state } = st;
  return {
    vp: [...state.vp],
    hand: state.players[0].hand.length,
    deck: state.players[0].deck.length,
    // THE CELL IS PART OF THE RECORD. Without it, a face that shifts a Spell
    // from one cell to another produced an identical snapshot -- `spellsOn`
    // returns the tops in cell order, so moving the only card from cell 3 to
    // cell 0 changes nothing about the list -- and three shifting faces were
    // reported as doing nothing at all.
    mySpells: spellsOn(state, 0).map((s) => `${s.uid}@${s.cell}:${s.def}:${s.rot}:${keywordsOf(state, s).join('+')}`),
    foeSpells: spellsOn(state, 1).map((s) => `${s.uid}@${s.cell}:${s.def}:${s.rot}`),
    units: Object.fromEntries(state.field.units.map((u) => [u.id, `${u.hp}:${u.x},${u.y},${u.z}:${u.dead ? 'D' : ''}`])),
    hp: Object.fromEntries(state.field.units.map((u) => [u.id, u.hp])),
    // `acted` and `poison` are part of the record because they are the only
    // trace some effects leave: the `spendUnitAction` cost spends an action and
    // touches nothing else, and [Stun] and [Poison] work the same way. Without
    // them, "declares a cost but nothing was spent" fired on a cost that was
    // paid perfectly.
    acted: Object.fromEntries(state.field.units.map((u) => [u.id, `${u.acted ? 'A' : ''}${u.poison || 0}`])),
    pos: Object.fromEntries(state.field.units.map((u) => [u.id, `${u.x},${u.y}`])),
    rots: Object.fromEntries(spellsOn(state, 0).concat(spellsOn(state, 1)).map((s) => [s.uid, s.rot])),
    scored: state.scoreLog.length,
    props: state.field.props.map((pr) => `${pr.id}:${pr.x},${pr.y},${pr.z}:${pr.removedUntil ?? '-'}:${pr.hp}:${pr.burning ?? '-'}${pr.destroyed ? 'X' : ''}`).join('|'),
    // The view notes, which say what the rules THINK they did. Used for the
    // claims where the board cannot show it -- granting a Keyword to a card
    // that already has it changes nothing observable, and three faces were
    // failed for doing exactly what they print.
    fx: (state.fx || []).length,
  };
}

/* ============================================================ the checks */

const PASS = 'PASS', FAIL = 'FAIL', UNCHECKED = 'UNCHECKED';

/**
 * NEGATIVE claims are restrictions: "never reaches past 3m", "never touches the
 * enemy's table". They must hold under EVERY answer, so a FAIL under either
 * policy is a FAIL.
 *
 * POSITIVE claims are capabilities: "deals 2 damage", "draws a card". They must
 * be DEMONSTRABLE, so a PASS under either policy is a PASS -- a face is not
 * broken because one particular legal answer happened to be a no-op.
 */
const POSITIVE = new Set([
  'damage', 'travel', 'draws', 'vp', 'vpScaling', 'vpAny',
  'rotateDir', 'grantsKeyword', 'destroysSpell', 'effectful',
]);

function judge(st, run, claim) {
  const { state, card, friend, foeCard, outside, ally, mine } = st;
  const { before, after, offered } = run;
  const allOptions = offered.flatMap((o) => o.options || []);
  const touchedUnits = Object.keys(after.hp).filter((id) => after.hp[id] !== before.hp[id]).map(Number);
  const movedUnits = Object.keys(after.pos).filter((id) => after.pos[id] !== before.pos[id]).map(Number);
  const rotated = Object.keys(after.rots).filter((u) => after.rots[u] !== before.rots[u]).map(Number);

  switch (claim.kind) {
    case 'range': {
      // The DECLARED reach the view draws must be the printed one.
      const declared = st.def.faces[st.faceIndex].reach;
      if (declared !== undefined && declared !== claim.mm) return [FAIL, `prints ${claim.mm}mm but declares a reach of ${declared}mm`];
      // The out-of-range body must never even be OFFERED. Checking only that it
      // was not hit would pass a face that offered it and happened not to pick
      // it, which is most of them under a fixed answer policy.
      if (!offered.length && !touchedUnits.length && !movedUnits.length) return [UNCHECKED, 'nothing was targeted'];
      if (allOptions.includes(outside.id)) return [FAIL, `offered the unit ${claim.mm + 2500}mm away as a target for a ${claim.mm}mm range`];
      if (touchedUnits.includes(outside.id) || movedUnits.includes(outside.id)) return [FAIL, 'reached a unit outside its range'];
      return [PASS, ''];
    }
    case 'damage': {
      if (!touchedUnits.length) return [UNCHECKED, 'nothing was damaged (no legal target in reach, or a cost was declined)'];
      const worst = Math.max(...touchedUnits.map((id) => before.hp[id] - after.hp[id]));
      // At least the printed amount: [Impact] and an aura may legitimately add.
      if (worst < claim.n) return [FAIL, `prints ${claim.n} damage but dealt ${worst}`];
      if (worst > claim.n + 2) return [FAIL, `prints ${claim.n} damage but dealt ${worst}`];
      return [PASS, ''];
    }
    case 'travel': {
      if (!movedUnits.length) return [UNCHECKED, 'nothing moved'];
      // Realised travel may be SHORT -- terrain -- but never long. A printed
      // "push 2m" that moved somebody 3m is a bug; one that moved them 1.2m is
      // the whole point of leaving the grid.
      for (const id of movedUnits) {
        const [bx, by] = before.pos[id].split(',').map(Number);
        const [ax, ay] = after.pos[id].split(',').map(Number);
        const d = Math.round(Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2));
        if (d > claim.mm + 150) return [FAIL, `prints ${claim.mm}mm of travel but moved unit ${id} ${d}mm`];
      }
      return [PASS, ''];
    }
    case 'draws': {
      const drew = after.hand - before.hand + Math.max(0, before.deck - after.deck - (after.hand - before.hand));
      const handGain = after.hand - before.hand;
      if (handGain === 0 && before.deck === after.deck) return [UNCHECKED, 'no cards moved (a cost may have been declined)'];
      if (handGain < claim.n && before.deck - after.deck < claim.n) {
        return [FAIL, `prints draw ${claim.n} but the hand gained ${handGain} and the deck lost ${before.deck - after.deck}`];
      }
      return [PASS, ''];
    }
    case 'vp': {
      const got = after.vp[0] - before.vp[0];
      if (got === 0) return [UNCHECKED, 'nothing was scored (the gate was probably unmet)'];
      if (got !== claim.n) return [FAIL, `prints ${claim.n} VP but awarded ${got}`];
      return [PASS, ''];
    }
    case 'vpScaling': {
      const got = after.vp[0] - before.vp[0];
      if (got === 0) return [UNCHECKED, 'nothing was scored (the gate was probably unmet)'];
      // A capped formula must respect its cap -- an uncapped one is a card that
      // wins on turn forty without anybody noticing it was the problem -- and
      // must pay at least one step of what it prints.
      if (got > claim.cap) return [FAIL, `prints a cap of ${claim.cap} VP but awarded ${got}`];
      if (got < claim.per) return [FAIL, `prints ${claim.per} VP per step but awarded ${got}`];
      return [PASS, ''];
    }
    case 'vpAny': {
      const got = after.vp[0] - before.vp[0];
      return got > 0 ? [PASS, ''] : [UNCHECKED, 'nothing was scored'];
    }
    case 'goldOnly':
      return st.def.school === 'gold' ? [PASS, ''] : [FAIL, `a ${st.def.school} face mentions VP`];
    case 'neverScores': {
      // KILLS are not the face scoring. With five-life mages a four-damage face
      // can kill on this stage, and the 2 VP for a mage is the kill rule paying
      // out, not the card -- so only objective entries count against it.
      const objective = state.scoreLog.slice(before.scored).filter((e) => e.kind === 'objective');
      if (objective.length) return [FAIL, `awarded ${objective.reduce((n, e) => n + e.amount, 0)} VP from an objective without printing any`];
      return [PASS, ''];
    }
    case 'destroysSelf':
      return after.mySpells.some((s) => s.startsWith(`${card.uid}@`))
        ? [FAIL, 'prints "destroy this Spell" but it is still on the table']
        : [PASS, ''];
    case 'scoringDestroys': {
      const got = after.vp[0] - before.vp[0];
      if (got === 0) return [UNCHECKED, 'it did not score, so the self-destroy could not be observed'];
      return after.mySpells.some((s) => s.startsWith(`${card.uid}@`))
        ? [FAIL, 'scored without destroying itself -- the VP throttle is gone']
        : [PASS, ''];
    }
    case 'rotateDir': {
      if (!rotated.length) return [UNCHECKED, 'nothing rotated'];
      for (const uid of rotated) {
        const d = ((after.rots[uid] - before.rots[uid]) % 4 + 4) % 4;
        // A left turn is +1 on `rot`, a right turn is -1 (which is +3).
        const want = claim.dir === 'left' ? 1 : 3;
        if (d !== want) return [FAIL, `prints a ${claim.dir} turn but uid ${uid} moved ${d} step(s) the other way`];
      }
      return [PASS, ''];
    }
    case 'friendlySpellsOnly': {
      if (allOptions.includes(foeCard.uid)) return [FAIL, 'offered an enemy Spell for a "you control" effect'];
      const foeChanged = JSON.stringify(before.foeSpells) !== JSON.stringify(after.foeSpells);
      if (foeChanged) return [FAIL, "changed the enemy's table"];
      return offered.length || rotated.length ? [PASS, ''] : [UNCHECKED, 'no Spell was chosen'];
    }
    case 'friendlyUnitsOnly': {
      if (allOptions.includes(st.theirs.id) || allOptions.includes(outside.id)) return [FAIL, 'offered an enemy unit for a friendly-only effect'];
      if (touchedUnits.includes(st.theirs.id)) return [FAIL, 'affected an enemy unit'];
      return [PASS, ''];
    }
    case 'enemyUnitsOnly': {
      if (allOptions.includes(ally.id) || allOptions.includes(mine.id)) return [FAIL, 'offered a friendly unit for an enemy-only effect'];
      // "Your mage takes 1 damage" is the COST, printed in the same sentence as
      // the effect; the mage paying it is not the effect hitting its own side.
      const paysInBlood = (st.def.faces[st.faceIndex].cost || []).some((c) => c.id === 'mageWound');
      // HURT, not touched: a drain heals your own mage, which is the point of it.
      const hurtOwn = (id) => after.hp[id] < before.hp[id];
      if (hurtOwn(ally.id) || (hurtOwn(mine.id) && !paysInBlood)) return [FAIL, 'hit its own side'];
      return offered.length || touchedUnits.length ? [PASS, ''] : [UNCHECKED, 'no enemy was in reach'];
    }
    case 'grantsKeyword': {
      if (!KEYWORD_NAMES.includes(claim.kw)) return [FAIL, `prints [${claim.kw}], which is not a registered Keyword`];
      // Read off the fx stream rather than diffed off the board. Granting a
      // Keyword to a card that already carries it is a legal and sometimes
      // deliberate play, and it changes nothing a board diff can see.
      const granted = (state.fx || []).slice(before.fx)
        .some((f) => f.kind === 'keywordGrant' && f.kw === claim.kw);
      if (granted) return [PASS, ''];
      const gained = after.mySpells.some((sp) => {
        const was = before.mySpells.find((b) => b.split(':')[0] === sp.split(':')[0]);
        return was && !was.includes(claim.kw) && sp.includes(claim.kw);
      });
      return gained ? [PASS, ''] : [FAIL, `prints "grant [${claim.kw}]" but no Spell gained it`];
    }
    case 'costPaid': {
      // A gold face whose objective condition is unmet resolves inert BEFORE
      // its cost is paid (the cost is the price of scoring, not a trap), so on
      // a stage where the condition is unmet there is nothing to observe.
      const inert = (state.fx || []).slice(before.fx).some((f) => f.kind === 'gateUnmet' && f.uid === card.uid);
      if (inert) return [UNCHECKED, 'its condition was unmet, so the cost was rightly not paid'];
      const spent = before.hand !== after.hand
        || before.mySpells.length !== after.mySpells.length
        || before.hp[mine.id] !== after.hp[mine.id]
        || before.deck !== after.deck
        || JSON.stringify(before.acted) !== JSON.stringify(after.acted)
        || JSON.stringify(before.rots) !== JSON.stringify(after.rots);
      // A face whose cost could not be paid fizzles, which is correct; the
      // stage is built so every cost in the corpus IS payable, so a fizzle here
      // means the pre-check and the payment disagree.
      return spent ? [PASS, ''] : [FAIL, 'declares a cost but nothing was spent'];
    }
    case 'passiveDeclared': {
      const grants = st.def.faces[st.faceIndex].grants || [];
      if (!grants.length) return [FAIL, 'has a passive and declares no buckets in `grants`'];
      for (const g of grants) if (!DERIVED_KEYS.includes(g)) return [FAIL, `declares unknown bucket '${g}'`];
      const touched = state.derivedTouched?.[`${st.def.id}:${NUMERALS[st.faceIndex]}`];
      if (!touched) return [UNCHECKED, 'the passive did not fire on this stage'];
      for (const g of grants) if (!touched.has(g)) return [FAIL, `declares '${g}' but never writes it`];
      return [PASS, ''];
    }
    case 'destroysSpell': {
      if (!offered.length) return [UNCHECKED, 'no Spell was offered to destroy'];
      const gone = before.mySpells.length + before.foeSpells.length
        > after.mySpells.length + after.foeSpells.length;
      return gone ? [PASS, ''] : [FAIL, 'prints "destroy a Spell" but nothing left the table'];
    }
    case 'effectful': {
      // `fx` is deliberately NOT part of the comparison: a face that leaves a
      // note for the view and changes nothing else has still done nothing.
      const keys = ['vp', 'hand', 'deck', 'mySpells', 'foeSpells', 'hp', 'pos', 'rots', 'scored', 'props', 'acted'];
      const changed = keys.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      if (changed) return [PASS, ''];
      // Answering null means the player declined, and declining must be
      // allowed to do nothing. Only a face that was GIVEN an answer and still
      // did nothing is a failure.
      const answered = offered.some((o) => (o.options || []).length > 0);
      if (!answered) return [UNCHECKED, 'nothing was in reach to act on'];
      return [FAIL, 'asked a question, was answered, and changed nothing'];
    }
    case 'gateBlocks':
      // Checked separately, below, by staging the gate as unmet.
      return [UNCHECKED, 'checked by the gate pass'];
    case 'prohibits':
      return prohibited(state, card) ? [PASS, ''] : [FAIL, 'prints a prohibition but the card can still be rotated'];
    default:
      return [UNCHECKED, 'no check for this claim'];
  }
}

/* ============================================================ planted faults */

/**
 * The faults --selftest plants. Each one must be CAUGHT, or this whole file is
 * decoration.
 */
const FAULTS = [
  {
    name: 'ignores its range',
    apply: (defs) => mutate(defs, 'EMBER_LASH', 'I', (f) => ({
      ...f,
      *effect(ctx) {
        // 20m: the whole arena. The out-of-range body is now offered.
        const ids = ctx.enemyUnits(20000);
        if (ids.length) ctx.hit(ids[ids.length - 1], 2);
      },
    })),
  },
  {
    name: 'hits its own side',
    apply: (defs) => mutate(defs, 'EMBER_LASH', 'I', (f) => ({
      ...f,
      *effect(ctx) {
        const ids = ctx.friendlyUnits(3000);
        if (ids.length) ctx.hit(ids[0], 2);
      },
    })),
  },
  {
    name: 'rotates an enemy Spell for a "you control" effect',
    apply: (defs) => mutate(defs, 'CHANGE', 'II', (f) => ({
      ...f,
      *effect(ctx) {
        const opts = ctx.enemySpells();
        if (opts.length) ctx.turnSpell(opts[0], 'left', { forced: true });
      },
    })),
  },
  {
    name: 'turns the wrong way',
    apply: (defs) => mutate(defs, 'CHANGE', 'II', (f) => ({
      ...f,
      *effect(ctx) {
        const opts = ctx.rotatable(ctx.friendlySpells());
        if (opts.length) ctx.turnSpell(opts[0], 'right');
      },
    })),
  },
  {
    name: 'asks and then does nothing',
    apply: (defs) => mutate(defs, 'CHANGE', 'III', (f) => ({
      ...f,
      *effect(ctx) {
        const opts = ctx.friendlySpells();
        if (opts.length) yield ctx.ask.one(opts, { prompt: 'Destroy a Spell' });
      },
    })),
  },
  {
    name: 'writes an undeclared derived bucket',
    apply: (defs) => mutate(defs, 'FOCUS_STONE', 'I', (f) => ({
      ...f, grants: ['rangeBonus'],
      passive: ({ p, d }) => { d.damageBonus[p] += 1; },
    })),
  },
  {
    name: 'declares a Keyword it never grants',
    apply: (defs) => mutate(defs, 'FUSE', 'I', (f) => ({
      ...f,
      *effect(ctx) { ctx.draw(1); },
    })),
  },
  {
    name: 'awards VP from a blue face',
    apply: (defs) => mutate(defs, 'SHOVE', 'I', (f) => ({
      ...f, text: 'Push a unit within 3m 2m. Score 2 VP.',
    })),
  },
  {
    name: 'a gold face that scores without destroying itself',
    apply: (defs) => mutate(defs, 'TALLY', 'IV', (f) => ({
      ...f, objective: { ...f.objective, keep: true },
    })),
  },
  {
    name: 'a face implemented under the wrong numeral',
    apply: (defs) => {
      // EMBER_LASH's I (2 damage) and II (1 damage to all) swapped. Nothing
      // crashes, no invariant breaks, the game state stays perfectly legal --
      // the wrong effect simply resolves. This is the fault unique to a
      // four-sided card and invisible to everything else in the suite.
      const d = defs.EMBER_LASH;
      const faces = [...d.faces];
      const [a, b] = [faces[0], faces[1]];
      faces[0] = { ...a, effect: b.effect, passive: b.passive, tag: b.tag };
      faces[1] = { ...b, effect: a.effect, passive: a.passive, tag: a.tag };
      return { ...defs, EMBER_LASH: Object.freeze({ ...d, faces: Object.freeze(faces) }) };
    },
  },
];

function mutate(defs, id, numeral, fn) {
  const d = defs[id];
  const i = NUMERALS.indexOf(numeral);
  const faces = [...d.faces];
  faces[i] = Object.freeze({ ...fn(faces[i]), numeral, index: i });
  return { ...defs, [id]: Object.freeze({ ...d, faces: Object.freeze(faces) }) };
}

/* ============================================================ the run */

function verify(defs, { quiet = false } = {}) {
  const results = [];
  for (const def of Object.keys(defs).sort().map((k) => defs[k])) {
    if (ONLY && def.id !== ONLY) continue;
    if (def.kind === 'golem') continue;
    for (const face of def.faces) {
      const claims = claimsOf(def, face);
      const runs = [];
      let threw = false;
      for (const policy of ['first', 'last']) {
        let st, run;
        try {
          st = stage(defs, def.id, face.numeral);
          run = runFace(st, policy);
        } catch (e) {
          results.push({ def: def.id, numeral: face.numeral, claim: 'threw', verdict: FAIL, why: `${policy}: ${e.message}` });
          threw = true;
          continue;
        }
        if (!run.done) {
          results.push({ def: def.id, numeral: face.numeral, claim: 'completes', verdict: FAIL, why: `${policy}: did not finish in 60 answers` });
        }
        for (const e of st.state.resolveErrors || []) {
          results.push({ def: def.id, numeral: face.numeral, claim: 'no errors', verdict: FAIL, why: e.error });
        }
        for (const e of st.state.derivationErrors || []) {
          results.push({ def: def.id, numeral: face.numeral, claim: 'derive', verdict: FAIL, why: e.error });
        }
        runs.push({ st, run, policy });
      }
      if (threw || !runs.length) continue;

      for (const claim of claims) {
        const verdicts = runs.map(({ st, run }) => {
          try { return judge(st, run, claim); }
          catch (e) { return [FAIL, `the check itself threw: ${e.message}`]; }
        });
        let verdict, why;
        if (POSITIVE.has(claim.kind)) {
          const win = verdicts.find((v) => v[0] === PASS);
          const lose = verdicts.find((v) => v[0] === FAIL);
          [verdict, why] = win || lose || verdicts[0];
        } else {
          const lose = verdicts.find((v) => v[0] === FAIL);
          const win = verdicts.find((v) => v[0] === PASS);
          [verdict, why] = lose || win || verdicts[0];
        }
        results.push({ def: def.id, numeral: face.numeral, claim: claim.kind, verdict, why });
      }
    }
  }
  return results;
}

/** A gate pass: stage the gate as unmet and insist nothing at all happens. */
function verifyGates(defs) {
  const out = [];
  for (const def of Object.keys(defs).sort().map((k) => defs[k])) {
    if (def.kind === 'golem') continue;
    for (const face of def.faces) {
      if (!face.gate) continue;
      let st;
      try { st = stage(defs, def.id, face.numeral); } catch { continue; }
      // Strip the board right back so nearly every gate fails: no units, no
      // other spells, an empty hand and discard.
      st.state.field.units = st.state.field.units.filter((u) => u.kind === 'mage' && u.owner === 0);
      st.state.players[0].hand = [];
      st.state.players[0].discard = [];
      // And the ledger back to zero: the main stage primes it so gold can be
      // observed scoring, which would meet every counter-based gate here.
      for (let p = 0; p < 2; p++) {
        for (const k of Object.keys(st.state.players[p].ledger)) st.state.players[p].ledger[k] = 0;
      }
      for (let c = 0; c < CELLS; c++) if (c !== st.cell) st.state.players[0].table[c] = [];
      refresh(st.state);
      const { gateMet } = gatesOf();
      if (gateMet(st.state, st.card, face.gate)) {
        out.push({ def: def.id, numeral: face.numeral, claim: 'gateBlocks', verdict: UNCHECKED, why: 'the gate was still met on a stripped board' });
        continue;
      }
      const before = snapshotOf(st);
      const run = runFace(st);
      const after = run.after;
      const changed = before.vp[0] !== after.vp[0] || before.hand !== after.hand
        || JSON.stringify(before.rots) !== JSON.stringify(after.rots)
        || JSON.stringify(before.hp) !== JSON.stringify(after.hp);
      out.push({
        def: def.id, numeral: face.numeral, claim: 'gateBlocks',
        verdict: changed ? FAIL : PASS,
        why: changed ? 'an unmet gate still did something' : '',
      });
    }
  }
  return out;
}
import { gateMet } from '../js/rules/gates.js';
const gatesOf = () => ({ gateMet });

/* ------------------------------------------------------------------ report */

const base = verify(CARDS);
const gates = verifyGates(CARDS);
const all = [...base.filter((r) => r.claim !== 'gateBlocks'), ...gates];

const counts = { PASS: 0, FAIL: 0, UNCHECKED: 0 };
for (const r of all) counts[r.verdict]++;
const fails = all.filter((r) => r.verdict === FAIL);
const unchecked = all.filter((r) => r.verdict === UNCHECKED);

console.log(`${all.length} claims across ${allCards().filter((d) => d.kind !== 'golem').length} cards`);
console.log(`  PASS ${counts.PASS}   FAIL ${counts.FAIL}   UNCHECKED ${counts.UNCHECKED}`);
for (const r of fails) console.log(`  FAIL ${r.def}:${r.numeral} [${r.claim}] ${r.why}`);
if (VERBOSE) for (const r of unchecked) console.log(`  unchecked ${r.def}:${r.numeral} [${r.claim}] ${r.why}`);
else {
  const byClaim = {};
  for (const r of unchecked) byClaim[r.claim] = (byClaim[r.claim] || 0) + 1;
  const list = Object.entries(byClaim).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} x${v}`).join(', ');
  if (list) console.log(`  unchecked (no counter-example in reach): ${list}`);
}

let selftestFails = 0;
if (SELFTEST) {
  console.log(`\n--selftest: ${FAULTS.length} planted faults`);
  for (const fault of FAULTS) {
    let caught = false, detail = '';
    try {
      const defs = fault.apply({ ...CARDS });
      const r = [...verify(defs), ...verifyGates(defs)];
      const newFails = r.filter((x) => x.verdict === FAIL);
      caught = newFails.length > fails.length;
      detail = newFails.slice(0, 2).map((x) => `${x.def}:${x.numeral} [${x.claim}]`).join(', ');
    } catch (e) {
      // A fault that makes the harness throw is still caught -- but noisily, so
      // say so rather than scoring it as a clean catch.
      caught = true;
      detail = `(the harness threw: ${e.message})`;
    }
    if (!caught) selftestFails++;
    console.log(`  ${caught ? 'caught ' : 'ESCAPED'} ${fault.name}${detail ? '  -> ' + detail : ''}`);
  }
}

const bad = counts.FAIL + selftestFails;
console.log(`\n${bad} failure${bad === 1 ? '' : 's'}`);
process.exit(bad ? 1 : 0);
