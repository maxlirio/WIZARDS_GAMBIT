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
import { FORCE_MM } from '../js/field/push.js';
import { TIER_CAP } from '../js/rules/golems.js';
import { livingUnits, mageOf, findUnit } from '../js/field/query.js';
import { placeBody } from '../js/field/move.js';
import { M, mm, within } from '../js/field/fixed.js';
import { apply } from '../js/engine.js';
import { springTrap } from '../js/rules/ops.js';
import { hurt } from '../js/rules/combat.js';
import { propSpec } from '../js/field/arena.js';

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

  // The RANGE is the first "within Xm" that is measured from the caster. A
  // "within 1m of the run" (Blazing Charge) or "within 1.5m of it"
  // (Stoneburst) is a radius around something else, and is not the reach.
  const range = t.match(/within ([\d.]+)m(?! of (the run|it|one|a burning))/);
  if (range) c.push({ kind: 'range', mm: num(range[1]) });

  const dmg = t.match(/[Dd]eal (\d+) damage/);
  if (dmg) c.push({ kind: 'damage', n: Number(dmg[1]) });

  // "Push a unit within 3m with force 4." -- the distance is the range; the
  // force buys a mass-1 body force x FORCE_MM of travel, and nothing may travel
  // further than that. "Relocate ... up to 3m" / "Raise ... by 1m" still
  // print a bare distance.
  const force = t.match(/with force (\d)/);
  if (force) c.push({ kind: 'travel', mm: Number(force[1]) * FORCE_MM });
  // WHICH WAY. "toward you" / "to you" / "toward your mage" means every body
  // that moved ended nearer the caster's mage; "away from you(r mage)" means
  // farther. A pull that went the other way passed every other claim.
  if (/\b(toward|to) (you|your mage)\b/.test(t)) c.push({ kind: 'direction', way: 'in' });
  else if (/\baway from (you|your mage)\b/.test(t)) c.push({ kind: 'direction', way: 'out' });
  else {
    const dists = [...t.matchAll(/([\d.]+)m/g)].map((m) => num(m[1]));
    if (/[Pp]ush|[Pp]ull|[Rr]elocate|[Rr]aise/.test(t)) {
      const travel = range ? dists.filter((d) => d !== num(range[1])) : dists;
      if (travel.length) c.push({ kind: 'travel', mm: travel[travel.length - 1] });
    }
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
  const saysEnemy = /enemy unit|enemy within|an enemy(?! Spell)/.test(t);
  if (saysFriendly && !saysEnemy) c.push({ kind: 'friendlyUnitsOnly' });
  if (saysEnemy && !saysFriendly) c.push({ kind: 'enemyUnitsOnly' });
  // "an enemy Spell": only the other table is offered, and only its
  // unprotected cards -- the stage plants an [Inevitable] enemy card that must
  // never be in the option list.
  if (/enemy Spell/.test(t)) c.push({ kind: 'enemySpellsOnly', destroys: /[Dd]estroy/.test(t) });
  if (/[Dd]estroy an? (enemy )?(Spell|Artifact)/.test(t)) c.push({ kind: 'destroysSpell' });
  // Every face with an effect claims, at minimum, to DO something. A face that
  // asks a question, gets an answer, and leaves the board exactly as it was is
  // a half-written face, and it is invisible to every other check in the suite.
  if (face.effect) c.push({ kind: 'effectful' });

  const grant = t.match(/[Gg]rant a Spell \[([^\]]+)\]/);
  if (grant) c.push({ kind: 'grantsKeyword', kw: grant[1] });

  // The physical red tranche. Each phrase names an event the engine leaves a
  // note for, or a status the board shows, so each is checkable rather than
  // taken on trust.
  if (/[Kk]nock (down|each of them down|.*flat)/.test(t)) c.push({ kind: 'knocks' });
  if (/set it burning|catches fire/.test(t)) c.push({ kind: 'burns' });
  if (/[Ii]gnite/.test(t)) c.push({ kind: 'ignites' });
  const crack = t.match(/[Cc]rack a terrain piece[^.]* for (\d)/);
  if (crack) c.push({ kind: 'propDamage', n: Number(crack[1]) });
  if (/[Ss]hatter a terrain piece/.test(t)) c.push({ kind: 'shatters' });
  if (/[Ii]t falls|[Tt]he fall hurts/.test(t)) c.push({ kind: 'falls' });
  if (/[Dd]rop a boulder/.test(t)) c.push({ kind: 'spawnsBoulder' });

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
  const friendId = opts.friendId || (def.school === 'green' ? 'SHIFT' : 'CHANGE');
  const friend = makeCard(state, friendId, 0);
  const friendCell = (HOME[defs[friendId].kind === 'artifact' ? 'artifact' : defs[friendId].school] || [3])[0];
  friend.playedTo = friendCell;
  friend.plays = 1;
  place(state, 0, friend, friendCell);

  const foeCard = makeCard(state, 'EMBER_LASH', 1);
  foeCard.playedTo = 1;
  foeCard.plays = 1;
  place(state, 1, foeCard, 1);
  // An enemy card that carries [Inevitable]: an effect that destroys enemy
  // Spells must never offer it.
  const wardCard = makeCard(state, 'CHANGE', 1);
  wardCard.playedTo = 3;
  wardCard.plays = 1;
  place(state, 1, wardCard, 3);

  // Hand cards, so a discard cost is payable and a draw has somewhere to come
  // from; deck cards so `draws` can be observed.
  for (let i = 0; i < 4; i++) state.players[0].hand.push(makeCard(state, 'SHIFT', 0));
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
  // A second enemy BESIDE the first, not burning: the fire-spreading faces
  // need someone within 1m of a burning enemy to catch it, and a face that
  // says "an enemy" has two to choose between. Created BEFORE the out-of-range
  // body so that body keeps the highest id -- the "ignores its range" planted
  // fault hits the last id it is offered, and must still reach it.
  const bystander = {
    body: 'unit', id: ++state.field.nextUnitId, owner: 1, kind: 'golem', def: 'CLAY_HAND', golemUid: null,
    hp: 9, maxHp: 9, move: 1000, atk: 1, reach: 900,
    x: theirs.x + 600, y: 5100, z: 0, support: { kind: 'ground' },
    acted: false, dead: false, poison: 0, keywords: [],
  };
  placeBody(state, bystander, bystander.x, bystander.y);
  state.field.units.push(bystander);
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
  // And a tree beside them, so a fire face has something to set alight. Just
  // INSIDE the claimed range (the enemy sits at range - 600) and within a
  // scorch of the enemy, so "ignite within 3m" has a tree to light and a
  // fire bolt's splash reaches it.
  state.field.props.push({ id: 'vtree', kind: 'tree', x: theirs.x - 600, y: 5200, z: 0,
    removedUntil: null, body: 'prop', support: { kind: 'ground' }, hp: 3, burning: null, litBy: null, destroyed: false });
  placeBody(state, state.field.props.at(-1), theirs.x - 600, 5200);
  // The in-range enemy is ALREADY burning (one turn left) and so is the
  // out-of-range one: a face that feeds on burning units has something to
  // feed on, a face that sets units burning must ADD to it to be seen, and a
  // "burning enemies within 4m" face has one outside 4m it must not touch.
  theirs.burn = 1; theirs.burnBy = 0;
  outside.burn = 2; outside.burnBy = 0;


  refresh(state);
  state.tableDirty = [false, false];
  return { state, card, friend, foeCard, wardCard, outside, ally, mine, theirs, bystander, cell, faceIndex, def };
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
    acted: Object.fromEntries(state.field.units.map((u) => [u.id, `${u.acted ? 'A' : ''}${u.poison || 0}b${u.burn || 0}`])),
    burn: Object.fromEntries(state.field.units.map((u) => [u.id, u.burn || 0])),
    pos: Object.fromEntries(state.field.units.map((u) => [u.id, `${u.x},${u.y}`])),
    // A hex leaves only a prohibition behind, so it is part of the record too.
    rots: Object.fromEntries(spellsOn(state, 0).concat(spellsOn(state, 1)).map((s) => [s.uid, `${s.rot}${s.noTurnUntil !== null && s.noTurnUntil !== undefined ? 'H' : ''}`])),
    scored: state.scoreLog.length,
    fxAt: (state.fx || []).length,
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
  'damage', 'travel', 'draws', 'vp', 'vpScaling', 'vpAny', 'enemySpellsOnly',
  'rotateDir', 'grantsKeyword', 'destroysSpell', 'effectful',
  'knocks', 'burns', 'ignites', 'propDamage', 'shatters', 'falls', 'spawnsBoulder', 'direction',
]);

/** Damage causes that are the battlefield's doing, not the face's own targeting. */
const PHYSICS = new Set(['impact', 'topple', 'fall']);

/**
 * Bodies whose motion in this run was not their own: struck by another body
 * (`into` of a hit), or deflected off a wall, the ward or another body. Their
 * distance and direction are the collision's, not the face's. Keys as the
 * dyn notes write them (u5, pb0), and the bare ids too.
 */
function deflected(state, fxAt) {
  const out = new Set();
  for (const f of (state.fx || []).slice(fxAt)) {
    if (f.kind !== 'dyn') continue;
    for (const e of f.events || []) {
      if (e.kind === 'hit') { out.add(e.into); out.add(e.key); }
      // Over an edge: it flew, and nothing slows a body in the air.
      if (e.kind === 'wall' || e.kind === 'ward' || e.kind === 'edge') out.add(e.key);
    }
  }
  for (const k of [...out]) out.add(k[0] === 'u' ? Number(k.slice(1)) : k.slice(1));
  return out;
}

function judge(st, run, claim) {
  const { state, card, friend, foeCard, wardCard, outside, ally, mine } = st;
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
      // A face that works on terrain (ignite, crack) leaves its mark on the
      // props record instead of on a unit; that is a targeting too.
      if (!offered.length && !touchedUnits.length && !movedUnits.length && before.props === after.props) return [UNCHECKED, 'nothing was targeted'];
      if (allOptions.includes(outside.id)) return [FAIL, `offered the unit ${claim.mm + 2500}mm away as a target for a ${claim.mm}mm range`];
      // Reached DIRECTLY. A rock the face threw rolling into the far unit, or
      // a thrown body sliding into it, is physics the card set in motion, not
      // the face choosing a target out of its range.
      const direct = (state.fx || []).slice(before.fxAt).some((f) => f.kind === 'damage' && f.id === outside.id && !PHYSICS.has(f.cause));
      if (direct) return [FAIL, 'reached a unit outside its range'];
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
      // Terrain travels too: a pushed rock is held to the printed force
      // exactly as a pushed unit is (mass only ever SHORTENS the slide).
      const propPos = (snap) => Object.fromEntries(snap.props.split('|').filter(Boolean).map((e) => { const [id, xyz] = e.split(':'); return [id, xyz]; }));
      const pb = propPos(before), pa = propPos(after);
      const movedProps = Object.keys(pa).filter((id) => pb[id] && pb[id] !== pa[id]);
      for (const id of movedProps) {
        const [bx, by] = pb[id].split(',').map(Number);
        const [ax, ay] = pa[id].split(',').map(Number);
        const d = Math.round(Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2));
        // The force buys SLIDING travel. A boulder ROLLS on the same launch
        // (rolling resistance is a fifth of sliding friction) and a floating
        // rock glides, so those may go further -- but never without limit.
        const pr = state.field.props.find((p) => p.id === id);
        const loose = pr && pr.kind === 'boulder' ? 8 : pr && pr.kind === 'floater' ? 3 : 1;
        if (d > claim.mm * loose + 150) return [FAIL, `prints ${claim.mm}mm of travel but moved terrain ${id} ${d}mm${loose > 1 ? ` (a ${pr.kind} may roll ${loose}x)` : ''}`];
      }
      if (!movedUnits.length) return movedProps.length ? [PASS, ''] : [UNCHECKED, 'nothing moved'];
      // Realised travel may be SHORT -- terrain -- but never long. A printed
      // "push 2m" that moved somebody 3m is a bug; one that moved them 1.2m is
      // the whole point of leaving the grid.
      const struck = deflected(state, before.fxAt);
      for (const id of movedUnits) {
        if (struck.has(id)) continue;                  // knocked on by another body: not the force's travel
        const [bx, by] = before.pos[id].split(',').map(Number);
        const [ax, ay] = after.pos[id].split(',').map(Number);
        const d = Math.round(Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2));
        // A tenth over: the launch speed rounds up and the ground is not flat.
        if (d > claim.mm + Math.round(claim.mm / 10) + 150) return [FAIL, `prints ${claim.mm}mm of travel but moved unit ${id} ${d}mm`];
      }
      return [PASS, ''];
    }
    case 'direction': {
      // Every body that moved, unit or terrain, measured from the caster's
      // mage where it stood AFTER (a pull toward a mage that itself slid is
      // still a pull toward where it ended).
      const [mx, my] = after.pos[mine.id].split(',').map(Number);
      const [bmx, bmy] = before.pos[mine.id].split(',').map(Number);
      const propPos = (snap) => Object.fromEntries(snap.props.split('|').filter(Boolean).map((e) => { const [id, xyz] = e.split(':'); return [id, xyz.split(',').map(Number)]; }));
      const pb = propPos(before), pa = propPos(after);
      const moved = [];
      // A unit RIDING a piece of terrain went where the terrain went (and a
      // floater that bounced off a tree carried its rider the wrong way): not
      // the face's direction.
      const ridden = new Set((state.fx || []).slice(before.fxAt).filter((f) => f.kind === 'carry').map((f) => f.id));
      // Judged on the body's FIRST movement: where it was when it had first
      // gone 40 mm (a weak pull up a slope reverses within 100), before
      // anything deflected it. A pulled rock that bounces
      // off a tree, or rolls back down the hill it was pulled up, ends up
      // further away, and that is the hill's doing, not the face's. Read off
      // the dyn trajectories; a body that never went 40 mm clear is a nudge
      // and is not judged.
      const dyns = (state.fx || []).slice(before.fxAt).filter((f) => f.kind === 'dyn');
      const firstClear = (key) => {
        for (const d of dyns) {
          if (!d.bodies.some((b) => b.key === key)) continue;
          const stop = Math.min(...d.events.filter((e) => e.t > 0 && (e.key === key || e.into === key) && (e.kind === 'hit' || e.kind === 'wall' || e.kind === 'ward')).map((e) => e.t), Infinity);
          const p0 = d.frames[0].p[key];
          if (!p0) continue;
          for (const fr of d.frames) {
            if (fr.t > stop) break;
            const p = fr.p[key]; if (!p) break;
            if (Math.hypot(p[0] - p0[0], p[1] - p0[1]) >= 40) return { b: p0, a: p };
          }
        }
        return null;
      };
      for (const id of movedUnits) { if (id === mine.id || ridden.has(id)) continue; const m = firstClear(`u${id}`); if (m) moved.push({ id, ...m }); }
      for (const id of Object.keys(pa)) { if (!pb[id] || (pb[id][0] === pa[id][0] && pb[id][1] === pa[id][1])) continue; const m = firstClear(`p${id}`); if (m) moved.push({ id, ...m }); }
      if (process.env.WG_DEBUG) console.error('DIR DEBUG', st.def.id, 'mage', [bmx, bmy], 'moved', JSON.stringify(moved), 'dyns', JSON.stringify(dyns.map((d) => ({ bodies: d.bodies.map((b) => b.key), events: d.events.map((e) => `${e.t}:${e.kind}:${e.key}${e.into ? '>' + e.into : ''}`), f: d.frames.slice(0, 6).map((fr) => [fr.t, fr.p]) }))));
      if (!moved.length) return [UNCHECKED, 'nothing moved'];
      for (const m of moved) {
        const was = Math.hypot(m.b[0] - bmx, m.b[1] - bmy), now = Math.hypot(m.a[0] - bmx, m.a[1] - bmy);
        if (claim.way === 'in' && now >= was) return [FAIL, `prints "toward you" but ${m.id} went from ${Math.round(was)}mm to ${Math.round(now)}mm from your mage`];
        if (claim.way === 'out' && now <= was) return [FAIL, `prints "away from you" but ${m.id} went from ${Math.round(was)}mm to ${Math.round(now)}mm from your mage`];
      }
      return [PASS, ''];
    }
    case 'draws': {
      const drew = after.hand - before.hand + Math.max(0, before.deck - after.deck - (after.hand - before.hand));
      const handGain = after.hand - before.hand;
      if (handGain === 0 && before.deck === after.deck) return [UNCHECKED, 'no cards moved (a cost may have been declined)'];
      // The hand holds five: a face that prints "draw 3" into a hand of four
      // may legitimately draw one. The claim is the cards the hand had ROOM for.
      const room = Math.max(0, 5 - before.hand);
      const want = Math.min(claim.n, room);
      if (want === 0) return [UNCHECKED, 'the hand was already full'];
      if (handGain < want && before.deck - after.deck < want) {
        return [FAIL, `prints draw ${claim.n} (room for ${want}) but the hand gained ${handGain} and the deck lost ${before.deck - after.deck}`];
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
      // And only THIS card's objective: a face that rotates a neighbouring
      // gold card now resolves that card's face too, and if that pays out it
      // is the gold card scoring, as printed on it.
      const thisFace = `${st.def.id}:${st.def.faces[st.faceIndex].numeral}`;
      const objective = state.scoreLog.slice(before.scored).filter((e) => e.kind === 'objective' && e.objId === thisFace);
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
      // The face's OWN turn is the first `rotate` note it left for each card.
      // A rotated card then resolves and chains, and a match may turn it (or
      // its neighbour) again, silently; those later turns are the chain's,
      // not the face's, and are judged by checkchains.
      const notes = (state.fx || []).slice(before.fxAt).filter((f) => f.kind === 'rotate');
      for (const uid of rotated) {
        const own = notes.find((f) => f.uid === uid);
        if (own) {
          if (own.dir !== claim.dir) return [FAIL, `prints a ${claim.dir} turn but turned uid ${uid} ${own.dir}`];
          continue;
        }
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
      // And hurt BY THE FACE, not by the battlefield: a tree pulled toward
      // your mage topples onto it, a unit thrown into your golem slams it --
      // that is physics doing what the card set in motion, not the face
      // choosing its own side as a target. Only the damage the face dealt
      // directly counts.
      const collateral = new Set(['impact', 'topple', 'fall']);
      const hurtOwn = (id) => (state.fx || []).slice(before.fxAt)
        .some((f) => f.kind === 'damage' && f.id === id && !collateral.has(f.cause));
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
    case 'enemySpellsOnly': {
      if (allOptions.some((o) => before.mySpells.includes(o))) return [FAIL, 'offered a friendly Spell for an enemy-Spell effect'];
      // Only destruction is warded. A hex or a shift may pick the [Inevitable] card.
      if (claim.destroys && allOptions.includes(wardCard.uid)) return [FAIL, 'offered an enemy [Inevitable] Spell'];
      const mineChanged = JSON.stringify(before.mySpells) !== JSON.stringify(after.mySpells);
      if (mineChanged) return [FAIL, 'changed its own table'];
      return offered.length ? [PASS, ''] : [UNCHECKED, 'no enemy Spell was chosen'];
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
    case 'knocks': {
      // A knockdown leaves a note AND a spent action on an enemy.
      const notes = (state.fx || []).slice(before.fxAt).filter((f) => f.kind === 'knockdown');
      const enemyFloored = notes.some((f) => { const u = findUnit(state, f.id); return u && u.owner !== 0; });
      if (!enemyFloored) return touchedUnits.length || offered.length ? [FAIL, 'prints a knockdown but no enemy was floored'] : [UNCHECKED, 'nothing was in reach to knock down'];
      for (const f of notes) { const u = findUnit(state, f.id); if (u && u.owner !== 0 && !u.acted) return [FAIL, `knocked unit ${f.id} down but it still has its action`]; }
      if (allOptions.includes(ally.id) || allOptions.includes(mine.id)) return [FAIL, 'offered a friendly unit to knock down'];
      return [PASS, ''];
    }
    case 'burns': {
      // Set burning: an ENEMY's burn count went up (the stage has one already alight).
      const lit = Object.keys(after.burn).map(Number).filter((id) => after.burn[id] > before.burn[id]);
      if (lit.some((id) => id === ally.id || id === mine.id)) return [FAIL, 'set its own side burning'];
      if (lit.length) return [PASS, ''];
      return touchedUnits.length || offered.length ? [FAIL, 'prints "burning" but no enemy burn count rose'] : [UNCHECKED, 'nothing was in reach to burn'];
    }
    case 'ignites': {
      const lit = (state.fx || []).slice(before.fxAt).some((f) => f.kind === 'ignite');
      if (lit) return [PASS, ''];
      return offered.length ? [FAIL, 'prints "ignite" but nothing caught fire'] : [UNCHECKED, 'no burnable piece was in reach'];
    }
    case 'propDamage': {
      const hpOf = (snap) => Object.fromEntries(snap.props.split('|').filter(Boolean).map((e) => { const f = e.split(':'); return [f[0], Number(f[3])]; }));
      const hb = hpOf(before), ha = hpOf(after);
      const cracked = Object.keys(hb).filter((id) => ha[id] !== undefined && ha[id] < hb[id]);
      if (!cracked.length) return offered.length ? [FAIL, `prints "crack for ${claim.n}" but no terrain lost hit points`] : [UNCHECKED, 'no terrain in reach'];
      const worst = Math.max(...cracked.map((id) => hb[id] - ha[id]));
      return worst >= claim.n ? [PASS, ''] : [FAIL, `prints "crack for ${claim.n}" but took ${worst}`];
    }
    case 'shatters': {
      const gone = (state.fx || []).slice(before.fxAt).some((f) => f.kind === 'shatter');
      if (gone) return [PASS, ''];
      return offered.length ? [FAIL, 'prints "shatter" but no terrain piece was destroyed'] : [UNCHECKED, 'no terrain in reach'];
    }
    case 'falls': {
      // A hurl or a skyfall must end in a landing note with a real drop.
      const notes = (state.fx || []).slice(before.fxAt);
      const fell = notes.some((f) => f.kind === 'hurl' && f.mm > 0) || notes.some((f) => f.kind === 'falls' && (f.landed || []).some((l) => l.drop > 0))
        || notes.some((f) => f.kind === 'dyn' && (f.events || []).some((e) => e.kind === 'land' && e.drop > 0))
        || notes.some((f) => f.kind === 'damage' && f.cause === 'fall');
      if (fell) return [PASS, ''];
      return offered.length ? [FAIL, 'prints a fall but nothing fell'] : [UNCHECKED, 'no unit was in reach to drop'];
    }
    case 'spawnsBoulder': {
      const nb = (snap) => snap.props.split('|').filter((e) => e.startsWith('m')).length;
      if (nb(after) > nb(before)) return [PASS, ''];
      return offered.length ? [FAIL, 'prints "drop a boulder" but no new boulder is on the field'] : [UNCHECKED, 'nowhere to drop it'];
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
    name: 'pulls the wrong way',
    apply: (defs) => mutate(defs, 'METEOR_CALL', 'II', (f) => ({
      ...f,
      *effect(ctx) {
        // Printed "to you"; shoved away instead.
        const ids = ctx.propsInRange(4000, { pushableOnly: true });
        if (ids.length) ctx.shoveAway(ids[0], 2);          // 2: below every tipping force, so it slides rather than topples
      },
    })),
  },
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
        if (opts.length) yield* ctx.turnSpell(opts[0], 'left', { forced: true });
      },
    })),
  },
  {
    name: 'turns the wrong way',
    apply: (defs) => mutate(defs, 'CHANGE', 'II', (f) => ({
      ...f,
      *effect(ctx) {
        const opts = ctx.rotatable(ctx.friendlySpells());
        if (opts.length) yield* ctx.turnSpell(opts[0], 'right');
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
    name: 'offers an enemy [Inevitable] Spell for destruction',
    apply: (defs) => mutate(defs, 'UNRAVEL', 'IV', (f) => ({
      ...f,
      *effect(ctx) {
        const opts = ctx.spellTargets({ side: 'enemy' });   // not destroyTargets
        const uid = opts.length === 1 ? opts[0] : yield ctx.ask.one(opts, { prompt: 'Destroy a Spell' });
        if (uid !== null) ctx.destroySpell(uid);
      },
    })),
  },
  {
    name: 'awards VP from a blue face',
    apply: (defs) => mutate(defs, 'SHIFT', 'I', (f) => ({
      ...f, text: 'Push anything within 3m 2m. Score 2 VP.',
    })),
  },
  {
    name: 'a gold face that scores without destroying itself',
    apply: (defs) => mutate(defs, 'TALLY', 'IV', (f) => ({
      ...f, objective: { ...f.objective, keep: true },
    })),
  },
  {
    name: 'a thunderclap that hurts but never floors anyone',
    apply: (defs) => mutate(defs, 'THUNDERCLAP', 'IV', (f) => ({
      ...f,
      *effect(ctx) { for (const id of ctx.enemyUnits(2000)) ctx.hit(id, 2); },
    })),
  },
  {
    name: 'an immolation that never sets anyone burning',
    apply: (defs) => mutate(defs, 'IMMOLATE', 'I', (f) => ({
      ...f,
      *effect(ctx) {
        const ids = ctx.enemyUnits(3000);
        if (ids.length) ctx.hit(ids[0], 1);
      },
    })),
  },
  {
    name: 'a meteor that hurts but leaves no boulder',
    apply: (defs) => mutate(defs, 'METEOR_CALL', 'IV', (f) => ({
      ...f,
      *effect(ctx) {
        const pts = ctx.skyPoints(5000);
        if (!pts.length) return;
        const i = yield ctx.ask.pick(pts.map((_, k) => k), { prompt: 'where?' });
        if (i === null) return;
        for (const id of ctx.unitsNear(pts[i].x, pts[i].y, 1000)) ctx.hit(id, 3);
      },
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

// The two trap faults, appended so the list above reads as it did.
FAULTS.push(
  {
    name: 'a trap that springs on its owner\'s own action',
    apply: (defs) => mutate(defs, 'SNARE', 'I', (f) => ({
      ...f,
      on: {
        // No "is it the opponent acting" guard: the owner's own golem walking
        // up to the owner's mage sets it off.
        afterMove: function* (ctx, payload) {
          const mover = findUnit(ctx.state, payload.id), mage = mageOf(ctx.state, ctx.p);
          if (!mover || !mage || !within(mover, mage, 2000)) return;
          springTrap(ctx.state, ctx.spell.uid);
          hurt(ctx.state, mover, 1, { cause: 'spell', byP: ctx.p });
        },
      },
    })),
  },
  {
    name: 'a trap that never springs',
    apply: (defs) => mutate(defs, 'BACKLASH', 'I', (f) => ({
      ...f,
      replace: { afterDamage: (ctx, payload) => payload },
    })),
  },
);

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
    if (def.kind === 'trap') continue;             // judged by verifyTraps, through its trigger
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
    if (def.kind === 'golem' || def.kind === 'trap') continue;
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

/* ============================================================ traps */

/**
 * A TRAP is judged through its TRIGGER, not by resolving its face: the face
 * has no effect to resolve. Each trap is staged twice through the real entry
 * points -- an enemy damage spell resolved against the owner's mage, or an
 * enemy unit walking up to it through `apply` -- once as the OPPONENT'S
 * action, where it must spring and its printed reaction must be visible on
 * the board, and once as the OWNER'S OWN action meeting the same geometry,
 * where it must stay set. A trap that springs on its owner is the fault
 * `--selftest` plants, and one that never springs is the other.
 */
function stageTrap(defs, cardId) {
  const state = createGame({ seed: 11, defs, decks: [[], []], findable: [], config: { strict: true } });
  for (const u of state.field.units) u.id += 500;
  state.field.nextUnitId += 500;
  state.nextUid += 1000;
  const trap = makeCard(state, cardId, 0);
  trap.playedTo = 0; trap.plays = 1; trap.concealed = true;
  place(state, 0, trap, 0);
  // A damage face for either side: the first red card whose side I bolts an
  // enemy unit, so the stage does not depend on one card's current numbers.
  const boltId = Object.keys(defs).sort().find((k) => defs[k].school === 'red' && defs[k].kind === 'spell'
    && /^Deal (\d+) damage to an enemy unit within/.test(defs[k].faces[0].text));
  if (!boltId) throw new Error('no red "Deal N damage to an enemy unit" side I to stage with');
  const bolt = Number(defs[boltId].faces[0].text.match(/^Deal (\d+)/)[1]);
  const foeCard = makeCard(state, boltId, 1); foeCard.playedTo = 1; foeCard.plays = 1; place(state, 1, foeCard, 1);
  // Everyone on player 1's flattened spawn circle, so a walk is never
  // stopped short by a rock the seed happened to put there.
  const mine = mageOf(state, 0), theirs = mageOf(state, 1);
  placeBody(state, mine, 13300, 6000);
  placeBody(state, theirs, 14800, 6000);
  const ally = {
    body: 'unit', id: ++state.field.nextUnitId, owner: 0, kind: 'golem', def: 'CLAY_HAND', golemUid: null,
    hp: 9, maxHp: 9, move: 2000, atk: 1, reach: 900,
    x: 13300, y: 8200, z: 0, support: { kind: 'ground' },
    acted: false, dead: false, poison: 0, keywords: [],
  };
  placeBody(state, ally, ally.x, ally.y);
  state.field.units.push(ally);
  refresh(state);
  state.tableDirty = [false, false];
  return { state, trap, foeCard, bolt, mine, theirs, ally, def: defs[cardId] };
}

/** Resolve a face with every question answered first-option, like a real duel. */
function resolveFully(state, card, index) {
  let r = runEffect(state, { kind: 'verify' }, () => resolveSide(state, card, index, {}));
  for (let i = 0; i < 40 && !r.done; i++) {
    const req = r.pending;
    const answer = req.type === 'confirm' ? true : req.type === 'some' ? req.options.slice(0, req.count) : (req.options[0] ?? null);
    r = answerPending(state, answer, () => () => resolveSide(state, card, index, {}), refresh);
  }
  refresh(state);
  return r.done;
}

const sprungIn = (st) => (st.state.fx || []).some((f) => f.kind === 'trapSpring' && f.uid === st.trap.uid);
const stillSet = (st) => { const t = findSpell(st.state, st.trap.uid); return !!t && t.cell === 0 && t.concealed === true; };
const inDiscard = (st) => st.state.players[0].discard.some((c) => c.uid === st.trap.uid && !c.concealed);

/** What each trap's printed reaction must leave on the board. */
const TRAP_REACTION = {
  EARTH_WALL: (st, before) => {
    const wall = st.state.field.props.find((pr) => pr.kind === 'earthwall');
    if (!wall) return [FAIL, 'no earth wall was raised'];
    if (wall.hp >= propSpec('earthwall').hp && !wall.destroyed) return [FAIL, 'the wall rose but took no damage'];
    if (st.mine.hp !== before.mineHp) return [FAIL, `the wall rose but the unit still took ${before.mineHp - st.mine.hp}`];
    const dSrc = Math.hypot(wall.x - st.theirs.x, wall.y - st.theirs.y), dVic = Math.hypot(wall.x - st.mine.x, wall.y - st.mine.y);
    if (dVic > 1800 || dSrc > Math.hypot(st.theirs.x - st.mine.x, st.theirs.y - st.mine.y)) return [FAIL, 'the wall is not between the spell and its target'];
    return [PASS, ''];
  },
  BACKLASH: (st, before) => {
    if (before.mineHp - st.mine.hp !== st.bolt) return [FAIL, `the hit should still land but the mage took ${before.mineHp - st.mine.hp} of ${st.bolt}`];
    if (before.theirsHp - st.theirs.hp !== 1) return [FAIL, `prints "the enemy mage takes 1 damage" but it took ${before.theirsHp - st.theirs.hp}`];
    return [PASS, ''];
  },
  SNARE: (st, before) => {
    if (before.theirsHp - st.theirs.hp !== 1) return [FAIL, `prints 1 damage but the mover took ${before.theirsHp - st.theirs.hp}`];
    if (!(st.theirs.heldUntil > st.state.turn)) return [FAIL, 'prints "loses its next action" but no hold was set'];
    return [PASS, ''];
  },
  SPRING_TRAP: (st, before) => {
    const was = Math.hypot(before.theirsX - st.mine.x, before.theirsY - st.mine.y);
    const now = Math.hypot(st.theirs.x - st.mine.x, st.theirs.y - st.mine.y);
    if (now <= was + 300) return [FAIL, `prints "flung away" but the mover is ${Math.round(now)}mm away, was ${Math.round(was)}`];
    if (now - was > 4 * FORCE_MM + 150) return [FAIL, `force 4 buys ${4 * FORCE_MM}mm but the mover travelled ${Math.round(now - was)}`];
    return [PASS, ''];
  },
  DRAG_LINE: (st, before) => {
    // The spring trap's mirror: the mover must end NEARER the owner's unit,
    // and no further than its force buys. It started 1.2 m away, so a drag
    // of up to 3 m stops at the body it is dragged to.
    const was = Math.hypot(before.theirsX - st.mine.x, before.theirsY - st.mine.y);
    const now = Math.hypot(st.theirs.x - st.mine.x, st.theirs.y - st.mine.y);
    if (now >= was - 150) return [FAIL, `prints "dragged toward it" but the mover is ${Math.round(now)}mm away, was ${Math.round(was)}`];
    if (was - now > 3 * FORCE_MM + 150) return [FAIL, `force 3 buys ${3 * FORCE_MM}mm but the mover travelled ${Math.round(was - now)}`];
    return [PASS, ''];
  },
};

function verifyTraps(defs) {
  const out = [];
  const say = (def, claim, verdict, why = '') => out.push({ def: def.id, numeral: 'I', claim, verdict, why });
  for (const def of Object.keys(defs).sort().map((k) => defs[k])) {
    if (def.kind !== 'trap') continue;
    const face = def.faces[0];
    const byDamage = !!face.replace?.afterDamage;
    const byMove = !!face.on?.afterMove;
    if (!byDamage && !byMove) { say(def, 'springs', FAIL, 'has neither a damage nor a move trigger'); continue; }

    /* -------- the opponent acts: it must spring, and react as printed */
    let st;
    try {
      st = stageTrap(defs, def.id);
      const { state, foeCard, mine, theirs } = st;
      const before = { mineHp: mine.hp, theirsHp: theirs.hp, theirsX: theirs.x, theirsY: theirs.y };
      state.active = 1;
      if (byDamage) {
        state.phase = 'spell';
        resolveFully(state, foeCard, 0);
      } else {
        // The enemy mage walks up to 1.2m from the owner's mage -- inside
        // every move trap's printed distance -- through the real action.
        state.phase = 'unit';
        theirs.acted = false;
        apply(state, { type: 'unit', id: theirs.id, act: 'move', x: mine.x + 1200, y: mine.y });
      }
      // A question parks and REPLAYS from a snapshot, which replaces every
      // unit object: read the bodies back by id before judging them.
      st.mine = findUnit(state, mine.id); st.theirs = findUnit(state, theirs.id); st.ally = findUnit(state, st.ally.id);
      if (!sprungIn(st)) say(def, 'springs', FAIL, byDamage ? 'an enemy spell damaged the owner\'s mage and the trap stayed set' : 'an enemy unit ended its move beside the owner\'s mage and the trap stayed set');
      else if (stillSet(st) || !inDiscard(st)) say(def, 'springs', FAIL, 'sprang but did not leave for the discard revealed');
      else {
        say(def, 'springs', PASS);
        const judge = TRAP_REACTION[def.id];
        if (judge) { const [v, why] = judge(st, before); say(def, 'reaction', v, why); }
        else say(def, 'reaction', UNCHECKED, 'no printed-reaction check for this trap');
      }
      for (const e of state.triggerErrors || []) say(def, 'no errors', FAIL, e.error);
    } catch (e) { say(def, 'springs', FAIL, `threw: ${e.message}`); }

    /* -------- the owner acts, same geometry: it must stay set */
    try {
      st = stageTrap(defs, def.id);
      const { state, mine, ally } = st;
      state.active = 0;
      if (byDamage) {
        // The owner's own spell wounds the owner's own mage (a cost, a
        // redirected blast): every point of damage passes through here.
        state.phase = 'spell';
        hurt(state, mine, 1, { cause: 'spell', byP: 0 });
      } else {
        state.phase = 'unit';
        ally.acted = false; mine.acted = true;
        apply(state, { type: 'unit', id: ally.id, act: 'move', x: mine.x, y: mine.y + 900 });
      }
      st.mine = findUnit(state, mine.id);
      if (sprungIn(st) || !stillSet(st)) say(def, 'ownActionSafe', FAIL, 'sprang on its owner\'s own action');
      else say(def, 'ownActionSafe', PASS);
    } catch (e) { say(def, 'ownActionSafe', FAIL, `threw: ${e.message}`); }

    /* -------- the opponent acts but the condition is NOT met: still set */
    if (byMove) {
      try {
        st = stageTrap(defs, def.id);
        const { state, theirs } = st;
        state.active = 1; state.phase = 'unit'; theirs.acted = false;
        apply(state, { type: 'unit', id: theirs.id, act: 'move', x: theirs.x, y: theirs.y - 1500 });
        if (sprungIn(st)) say(def, 'conditionNeeded', FAIL, 'sprang on an enemy move that ended out of its printed distance');
        else say(def, 'conditionNeeded', PASS);
      } catch (e) { say(def, 'conditionNeeded', FAIL, `threw: ${e.message}`); }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ report */

const base = verify(CARDS);
const gates = verifyGates(CARDS);
const traps = verifyTraps(CARDS);
const all = [...base.filter((r) => r.claim !== 'gateBlocks'), ...gates, ...traps];

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
      const r = [...verify(defs), ...verifyGates(defs), ...verifyTraps(defs)];
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
