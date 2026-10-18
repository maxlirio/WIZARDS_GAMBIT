#!/usr/bin/env node
// The chain, attacked on purpose.
//
//   node tools/checkchains.js [--fuzz N]
//
// Random decks will essentially NEVER build the board that breaks termination.
// The pathological tables are specific -- a card sharing one rune on all four
// corners, two Defrinol Orbs side by side, a wildcard touching everything --
// and the chance of a random game assembling one is small enough that a clean
// playtest run says nothing about it. So they are built here by hand.
//
// This is the milestone gate. Everything downstream assumes chains terminate.
//
// What is asserted, and why each one is a real failure mode:
//
//   MONOTONE PROGRESS. `spent` grows by exactly one on every iteration,
//   including when the group is locked, the cost is declined, or the gate is
//   unmet and the face resolves inert. That single property IS the termination
//   proof; everything else about the chain can be wrong and it will still halt.
//
//   THE REVOLUTION CAP, scoped to the spell ACTION rather than the chain. Two
//   Defrinol Orbs rotate each other through QUEUED TRIGGERS, which run after a
//   chain has ended, so every individual chain can be perfectly bounded while
//   the pair ping-pongs forever.
//
//   REPLAY IDENTITY. A chain parked on a question is replayed from a snapshot on
//   every answer. Feeding the same answers to a cold clone must produce a
//   bit-identical state, or the netcode and every save file are wrong.
//
//   THE WILDCARD IS SEEN. Resonis Orb's "counts as any corner" is invisible to
//   any matcher that reads `def.runes` directly, and the failure is silent: the
//   card looks implemented and never matches.

import { createGame, legalActions, apply, choose, hashState, cloneState } from '../js/engine.js';
import { CARDS } from '../js/rules/spells/index.js';
import { makeDef } from '../js/rules/schema.js';
import { SPIRAL, SHARD, WHEEL, LATTICE } from '../js/rules/runes.js';
import { findMatches, runeAtCorner, CHAIN_ASSERT } from '../js/rules/match.js';
import { MATCH_SITES, INTERIOR_SITES, HOME, CELL_COLOR } from '../js/rules/table.js';
import { makeCard, place, spellsOn, findSpell, REVOLUTION } from '../js/rules/ops.js';
import { refresh } from '../js/rules/derive.js';
import { seedRng, int } from '../js/rules/rng.js';
import * as M from '../js/rules/motifs.js';
import { invariants } from './invariants.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const FUZZ = arg('fuzz', 400);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${msg}`); } };

/* ------------------------------------------------------- adversarial cards */
// These exist ONLY here. They are not in the corpus, because schema.js refuses
// an all-one-rune card -- which is exactly the constraint being tested, so the
// test has to go round it and build the def by hand.

function forge(spec) {
  const d = makeDef(spec);
  return d;
}

const ADVERSARIAL = {};
const addAdv = (spec) => { const d = forge(spec); ADVERSARIAL[d.id] = d; return d; };

// A card whose four corners all carry one rune: it re-creates its own match
// after every rotation. schema.js bans this; the engine must survive it anyway.
addAdv({
  id: 'XX_MONOTONE', name: 'Monotone', school: 'green',
  runes: [SPIRAL, SPIRAL, SPIRAL, LATTICE],
  I: { text: 'Nothing.', tag: 'turn' }, II: { text: 'Nothing.', tag: 'turn' },
  III: { text: 'Nothing.', tag: 'turn' }, IV: { text: 'Nothing.', tag: 'turn' },
});
// The same, built past the validator by patching the frozen array's source.
ADVERSARIAL.XX_ALLSAME = Object.freeze({
  ...ADVERSARIAL.XX_MONOTONE, id: 'XX_ALLSAME', name: 'All Same',
  runes: Object.freeze([SPIRAL, SPIRAL, SPIRAL, SPIRAL]),
});

// Rotates something else every time it is rotated, and matches nothing by
// itself. The Defrinol loop.
addAdv({
  id: 'XX_PINGPONG', name: 'Ping Pong', school: 'green',
  runes: [SPIRAL, SHARD, SPIRAL, SHARD],
  I: { text: 'After this is rotated, rotate a Spell left.', ...M.onRotatedRotate() },
  II: { text: 'After this is rotated, rotate a Spell left.', ...M.onRotatedRotate() },
  III: { text: 'After this is rotated, rotate a Spell left.', ...M.onRotatedRotate() },
  IV: { text: 'After this is rotated, rotate a Spell left.', ...M.onRotatedRotate() },
});

// Every corner matches everything.
addAdv({
  id: 'XX_WILD', name: 'Wildcard', school: 'grey', kind: 'artifact',
  runes: [SPIRAL, SHARD, WHEEL, LATTICE],
  I: { text: 'Corners count as any corner.', ...M.passiveWildCorners() },
  II: { text: 'Corners count as any corner.', ...M.passiveWildCorners() },
  III: { text: 'Corners count as any corner.', ...M.passiveWildCorners() },
  IV: { text: 'Corners count as any corner.', ...M.passiveWildCorners() },
});

// Cannot be rotated at all, by anything. A PROHIBITION, which is what makes a
// matched group `locked`.
addAdv({
  id: 'XX_LOCKED', name: 'Locked', school: 'red',
  runes: [SPIRAL, SPIRAL, SHARD, LATTICE],
  I: { text: 'This Spell may not be rotated.', ...M.passiveLocked() },
  II: { text: 'This Spell may not be rotated.', ...M.passiveLocked() },
  III: { text: 'This Spell may not be rotated.', ...M.passiveLocked() },
  IV: { text: 'This Spell may not be rotated.', ...M.passiveLocked() },
});

// Shifts a card out from under a junction mid-chain, which is what Rule A's
// keying by VERTEX rather than by card exists to survive.
addAdv({
  id: 'XX_SHIFTER', name: 'Shifter', school: 'blue',
  runes: [SPIRAL, SPIRAL, SPIRAL, LATTICE],
  I: { text: 'Shift this Spell.', ...M.shiftSelf() },
  II: { text: 'Shift this Spell.', ...M.shiftSelf() },
  III: { text: 'Shift this Spell.', ...M.shiftSelf() },
  IV: { text: 'Shift a Spell you control.', ...M.shiftASpell() },
});

// Reverses the direction, so the table turns the wrong way.
addAdv({
  id: 'XX_REVERSE', name: 'Reverse', school: 'purple',
  runes: [SPIRAL, SPIRAL, SPIRAL, LATTICE],
  I: { text: 'Rotate a Spell right.', ...M.turnASpell({ dir: 'right' }) },
  II: { text: 'Rotate a Spell right.', ...M.turnASpell({ dir: 'right' }) },
  III: { text: 'Rotate a Spell right.', ...M.turnASpell({ dir: 'right' }) },
  IV: { text: 'Rotate a Spell right.', ...M.turnASpell({ dir: 'right' }) },
});

// A face that cannot pay for itself, so every resolution fizzles -- and the
// chain must still make progress, because progress cannot depend on an effect
// succeeding.
addAdv({
  id: 'XX_UNPAYABLE', name: 'Unpayable', school: 'gold',
  runes: [SPIRAL, SPIRAL, SPIRAL, LATTICE],
  I: { text: 'Discard 9 cards. Score 9 VP.', tag: 'turn', cost: [{ id: 'discard', n: 9 }], objective: { vp: { k: 'flat', n: 9 } } },
  II: { text: 'Discard 9 cards. Score 9 VP.', tag: 'turn', cost: [{ id: 'discard', n: 9 }], objective: { vp: { k: 'flat', n: 9 } } },
  III: { text: 'Discard 9 cards. Score 9 VP.', tag: 'turn', cost: [{ id: 'discard', n: 9 }], objective: { vp: { k: 'flat', n: 9 } } },
  IV: { text: 'Nothing.', tag: 'draw' },
});

// A face whose gate can never be met, so every resolution is INERT -- and the
// rotation must stand anyway, which is the half of the gate rule that keeps the
// termination proof intact.
addAdv({
  id: 'XX_GATED', name: 'Gated', school: 'green',
  runes: [SPIRAL, SPIRAL, SPIRAL, LATTICE],
  I: { text: 'If you control 9 Spells, rotate a Spell left.', tag: 'turn', gate: { id: 'spellsAtLeast', n: 9 }, ...M.turnASpell({ dir: 'left' }) },
  II: { text: 'If you control 9 Spells, rotate a Spell left.', tag: 'turn', gate: { id: 'spellsAtLeast', n: 9 }, ...M.turnASpell({ dir: 'left' }) },
  III: { text: 'If you control 9 Spells, rotate a Spell left.', tag: 'turn', gate: { id: 'spellsAtLeast', n: 9 }, ...M.turnASpell({ dir: 'left' }) },
  IV: { text: 'Nothing.', tag: 'draw' },
});

const DEFS = Object.freeze({ ...CARDS, ...ADVERSARIAL });

/* -------------------------------------------------------------- scaffolding */

/** A game with a table built to order, and nothing random about it. */
function staged(layout, { seed = 5, extraHand = [] } = {}) {
  const state = createGame({ seed, defs: DEFS, decks: [[], []], findable: [], config: { strict: true } });
  for (const [cell, defId, rot] of layout) {
    const card = makeCard(state, defId, 0);
    card.rot = rot || 0;
    // `playedTo` is left NULL unless the cell actually matches the card's
    // colour. A spell on a mismatched colour is a legal state -- it got there by
    // being shifted -- and `playedTo === cell` is precisely the claim "this card
    // was PLAYED here", which the invariants then hold to the colour rule.
    // Staging a card onto the wrong colour and claiming it was played there is
    // the harness lying about how the board was reached.
    const legal = (HOME[CARDS[defId]?.kind === 'artifact' || DEFS[defId].kind === 'artifact' ? 'artifact' : DEFS[defId].school] || []).includes(cell);
    card.playedTo = legal ? cell : null;
    card.plays = 1;
    place(state, 0, card, cell);
  }
  for (const id of extraHand) state.players[0].hand.push(makeCard(state, id, 0));
  refresh(state);
  state.tableDirty = [false, false];
  return state;
}

/**
 * Start a chain by hand and answer it, recording what it did.
 *
 * `answers` is a function so the policy can be varied: first option, last
 * option, round-robin. Order is one of the few things the chain lets the player
 * decide, so each policy is a different chain.
 */
function runChainBy(state, policy, cap = 400) {
  state.queue.push({ kind: 'chain', p: 0, cause: 'test', seq: ++state.actionSeq });
  const spentLog = [];
  let answers = 0;
  // The pump drives the chain; `choose` answers it. Bounded, and the bound is
  // an assertion -- the whole point is that the chain cannot need more.
  const { pump } = pumpOf();
  pump(state);
  for (let i = 0; i < cap && state.pending; i++) {
    if (state.chain) spentLog.push([...state.chain.spent]);
    const r = state.pending.request;
    choose(state, policy(r, answers++));
  }
  return { spentLog, answers, overflow: !!state.chainOverflow || !!state.pumpOverflow };
}

// `pump` is not exported from engine.js as part of its public surface by
// accident -- it is, and this keeps the import in one place so the dependency
// is obvious if it ever stops being.
import { pump } from '../js/engine.js';
const pumpOf = () => ({ pump });

const firstPolicy = (r) => (r.type === 'confirm' ? true : r.type === 'some' ? r.options.slice(0, r.count) : (r.options[0] ?? null));
const lastPolicy = (r) => (r.type === 'confirm' ? false : r.type === 'some' ? r.options.slice(-r.count) : (r.options[r.options.length - 1] ?? null));
const rrPolicy = (n) => (r, i) => (r.type === 'confirm' ? (i % 2 === 0) : r.type === 'some' ? r.options.slice(0, r.count) : (r.options.length ? r.options[(i * n + i) % r.options.length] : null));

/**
 * Split an observation log into one segment per chain.
 *
 * ONE SPELL ACTION CAN START SEVERAL CHAINS. A queued trigger that rotates
 * something runs after the chain that queued it has ended, and the new match
 * needs a new chain -- which begins with `spent` empty again. Checking
 * monotonicity across the whole log therefore reports a violation on any table
 * that triggers twice, which is what the real corpus did on its first run.
 *
 * A segment boundary is `spent` getting SHORTER, which only a new chain can do.
 */
function segments(spentLog) {
  const out = [];
  let cur = [];
  for (const obs of spentLog) {
    if (cur.length && obs.length < cur[cur.length - 1].length) { out.push(cur); cur = []; }
    cur.push(obs);
  }
  if (cur.length) out.push(cur);
  return out;
}

function checkMonotone(label, spentLog) {
  const segs = segments(spentLog);
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si];
    const tag = segs.length === 1 ? label : `${label} chain ${si + 1}/${segs.length}`;
    let good = true;
    for (let i = 1; i < seg.length; i++) {
      const prev = seg[i - 1], cur = seg[i];
      // Every observation must be an extension of the one before: same prefix,
      // and never shorter. A chain that re-scanned and lost a vertex is a chain
      // that is not making progress, and the bound stops holding.
      if (cur.length < prev.length) { good = false; break; }
      for (let k = 0; k < prev.length; k++) if (cur[k] !== prev[k]) { good = false; break; }
    }
    ok(good, `${tag}: spent is not monotone (${seg.map((x) => x.join('.')).join(' -> ')})`);
    const last = seg[seg.length - 1] || [];
    ok(last.length === new Set(last).size, `${tag}: a vertex was spent twice (${last.join(',')})`);
    ok(last.every((v) => MATCH_SITES.includes(v)), `${tag}: a non-matchable vertex was spent (${last.join(',')})`);
    ok(last.length <= MATCH_SITES.length, `${tag}: ${last.length} links exceeds the bound of ${MATCH_SITES.length}`);
  }
}

function checkState(label, state) {
  const bad = invariants(state, label);
  for (const b of bad.slice(0, 4)) { console.log(`  FAIL ${b}`); fail++; }
  if (!bad.length) pass++;
  ok(!state.chainOverflow, `${label}: chainOverflow fired`);
  ok(!state.pumpOverflow, `${label}: pumpOverflow fired`);
  for (const sp of spellsOn(state, 0)) {
    ok(sp.turnsThisAction <= REVOLUTION, `${label}: ${sp.def} rotated ${sp.turnsThisAction} times in one action`);
  }
}

/* ----------------------------------------------------------------- the cases */

const CASES = [
  ['all four corners one rune, three of them adjacent',
   [[3, 'XX_ALLSAME', 0], [4, 'XX_ALLSAME', 1], [1, 'XX_ALLSAME', 2]]],
  ['a full table of one-rune cards',
   [[0, 'XX_ALLSAME', 0], [1, 'XX_ALLSAME', 1], [2, 'XX_ALLSAME', 2], [3, 'XX_ALLSAME', 3],
    [4, 'XX_ALLSAME', 0], [5, 'XX_ALLSAME', 1], [6, 'XX_ALLSAME', 2], [7, 'XX_ALLSAME', 3],
    [8, 'XX_ALLSAME', 0]]],
  ['two Defrinol-style ping-pong cards adjacent',
   [[3, 'XX_PINGPONG', 0], [4, 'XX_PINGPONG', 0]]],
  ['ping-pong beside a one-rune card',
   [[3, 'XX_PINGPONG', 0], [4, 'XX_ALLSAME', 0], [1, 'XX_ALLSAME', 1]]],
  ['a wildcard touching everything',
   [[0, 'XX_WILD', 0], [1, 'XX_ALLSAME', 0], [3, 'XX_ALLSAME', 1], [4, 'XX_ALLSAME', 2]]],
  ['four wildcards at an interior junction',
   [[0, 'XX_WILD', 0], [2, 'XX_WILD', 1], [6, 'XX_WILD', 2], [8, 'XX_WILD', 3],
    [1, 'XX_WILD', 0], [3, 'XX_WILD', 1], [4, 'XX_WILD', 2], [5, 'XX_WILD', 3], [7, 'XX_WILD', 0]]],
  ['a locked card in every matched group',
   [[1, 'XX_LOCKED', 0], [4, 'XX_ALLSAME', 0], [3, 'XX_ALLSAME', 1]]],
  ['nothing but locked cards',
   [[1, 'XX_LOCKED', 0], [4, 'XX_LOCKED', 0], [3, 'XX_LOCKED', 1], [5, 'XX_LOCKED', 2]]],
  ['a card that shifts itself mid-chain',
   [[5, 'XX_SHIFTER', 0], [4, 'XX_ALLSAME', 0], [1, 'XX_ALLSAME', 1], [3, 'XX_ALLSAME', 2]]],
  ['a table that rotates the wrong way',
   [[4, 'XX_REVERSE', 0], [3, 'XX_ALLSAME', 0], [1, 'XX_ALLSAME', 1], [5, 'XX_ALLSAME', 2]]],
  ['every resolution fizzles on an unpayable cost',
   [[7, 'XX_UNPAYABLE', 0], [4, 'XX_ALLSAME', 0], [3, 'XX_ALLSAME', 1], [1, 'XX_ALLSAME', 2]]],
  ['every resolution is inert on an unmet gate',
   [[3, 'XX_GATED', 0], [4, 'XX_ALLSAME', 0], [1, 'XX_ALLSAME', 1], [5, 'XX_ALLSAME', 2]]],
  ['the real corpus, interior junction crowded',
   [[4, 'FUSE', 0], [1, 'EMBER_LASH', 0], [3, 'CHANGE', 0], [5, 'SHOVE', 0], [7, 'TALLY', 0],
    [0, 'FOCUS_STONE', 0], [2, 'RESONIS_ORB', 0], [6, 'DEFRINOL_ORB', 0], [8, 'ECHO_BELL', 0]]],
];

console.log(`${CASES.length} adversarial tables x 3 answer policies\n`);
for (const [label, layout] of CASES) {
  for (const [pname, policy] of [['first', firstPolicy], ['last', lastPolicy], ['round-robin', rrPolicy(3)]]) {
    const state = staged(layout);
    const tag = `${label} [${pname}]`;
    let r;
    try { r = runChainBy(state, policy); }
    catch (e) { console.log(`  FAIL ${tag}: threw ${e.message}`); fail++; continue; }
    checkMonotone(tag, r.spentLog);
    checkState(tag, state);
    ok(state.chain === null, `${tag}: the chain did not finish`);
  }
}

/* ------------------------------------------------- the wildcard is visible */
{
  // Resonis Orb's wildcard is invisible to any matcher that reads def.runes
  // directly, and the failure is silent. So: a table whose runes CANNOT match,
  // plus a wildcard, must produce a match -- and without the wildcard, must not.
  const noMatch = staged([[1, 'XX_LOCKED', 0], [3, 'XX_GATED', 1]]);
  const withWild = staged([[1, 'XX_LOCKED', 0], [3, 'XX_GATED', 1], [0, 'XX_WILD', 0]]);
  const before = findMatches(noMatch, 0, []);
  const after = findMatches(withWild, 0, []);
  ok(after.length > before.length, `the wildcard created no match (${before.length} -> ${after.length})`);
  const wild = spellsOn(withWild, 0).find((s) => s.def === 'XX_WILD');
  ok(runeAtCorner(withWild, wild, 0) === 'WILD', 'runeAtCorner does not report the wildcard');
  ok(runeAtCorner(withWild, wild, 2) === 'WILD', 'runeAtCorner reports the wildcard at only some corners');
}

/* ------------------------------------------------------- replay identity */
{
  // A parked chain is replayed from a snapshot on every answer. Feeding the
  // same answers to a COLD CLONE taken before the chain started must land on a
  // bit-identical state -- if it does not, every save file and the netcode are
  // both wrong, and nothing else in the suite would notice.
  let mismatches = 0, tested = 0;
  for (const [label, layout] of CASES) {
    const live = staged(layout);
    const cold = cloneState(live);
    const given = [];
    live.queue.push({ kind: 'chain', p: 0, cause: 'test', seq: ++live.actionSeq });
    pump(live);
    for (let i = 0; i < 400 && live.pending; i++) {
      const a = firstPolicy(live.pending.request);
      given.push(a);
      choose(live, a);
    }
    cold.queue.push({ kind: 'chain', p: 0, cause: 'test', seq: ++cold.actionSeq });
    pump(cold);
    for (const a of given) { if (!cold.pending) break; choose(cold, a); }
    tested++;
    if (hashState(live) !== hashState(cold)) {
      mismatches++;
      console.log(`  FAIL replay of "${label}" diverged (${hashState(live)} vs ${hashState(cold)})`);
    }
  }
  ok(mismatches === 0, `${mismatches}/${tested} staged chains did not replay identically`);
  if (!mismatches) console.log(`replay identity        ${tested}/${tested} staged chains`);
}

/* ------------------------------------------------------------------- fuzz */
{
  // Random tables drawn from the adversarial pool, answered at random. The
  // hand-built cases cover the shapes that were thought of; this covers the
  // ones that were not.
  const rng = seedRng(0xfeed);
  const pool = Object.keys(ADVERSARIAL).sort().concat(Object.keys(CARDS).filter((k) => CARDS[k].kind !== 'golem').sort());
  let worstChain = 0, worstAction = 0, broken = 0;
  for (let i = 0; i < FUZZ; i++) {
    const layout = [];
    for (let c = 0; c < 9; c++) {
      if (int(rng, 4) === 0) continue;
      // Deliberately ignores colour legality. A shifted card can legally sit on
      // the wrong colour, so the matcher has to cope with any card on any cell.
      layout.push([c, pool[int(rng, pool.length)], int(rng, 4)]);
    }
    const state = staged(layout, { seed: 100 + i });
    try {
      const r = runChainBy(state, (req, k) => {
        if (req.type === 'confirm') return int(rng, 2) === 1;
        if (req.type === 'some') return req.options.slice(0, req.count);
        return req.options.length ? req.options[int(rng, req.options.length)] : null;
      });
      // Per CHAIN and per ACTION are different numbers and only the first one
      // is bounded by the twelve junctions: one spell action can start several
      // chains, because a queued trigger that rotates something runs after the
      // chain that queued it has ended and the new match needs a new chain.
      // Conflating them reported a 13-link chain against a bound of 12.
      const perChain = Math.max(0, ...segments(r.spentLog).map((seg) => (seg[seg.length - 1] || []).length));
      worstChain = Math.max(worstChain, perChain);
      worstAction = Math.max(worstAction, state.players[0].ledger.chainLinks);
      if (perChain > MATCH_SITES.length) { broken++; console.log(`  FAIL fuzz ${i}: a single chain spent ${perChain} vertices`); }
      if (r.overflow) { broken++; console.log(`  FAIL fuzz ${i}: overflow`); }
      const bad = invariants(state, `fuzz ${i}`);
      if (bad.length) { broken++; for (const b of bad.slice(0, 3)) console.log(`  FAIL fuzz ${i}: ${b}`); }
    } catch (e) {
      broken++;
      console.log(`  FAIL fuzz ${i}: threw ${e.message}`);
    }
  }
  ok(broken === 0, `${broken}/${FUZZ} fuzzed chains broke`);
  console.log(`fuzz                   ${FUZZ} random adversarial tables`);
  console.log(`  longest single chain ${worstChain} links (bound ${MATCH_SITES.length})`);
  console.log(`  most links one action ${worstAction} (several chains per action is legal)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
