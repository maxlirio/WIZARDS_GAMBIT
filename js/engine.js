// The engine. createGame, legalActions, apply, choose, hashState, cloneState.
//
// THE PUMP is the central idea and it is worth reading before anything else.
// A player's action is not one mutation: playing a card can start a chain, the
// chain can resolve a face, the face can push a unit off a ledge, the fall can
// kill it, the kill can score the fifteenth point, and any of those steps can
// stop to ask a question. None of that can be a call stack, because a question
// parks the game as a SNAPSHOT plus RECORDED ANSWERS and replays from there --
// and you cannot snapshot a call stack.
//
// So all outstanding work lives in `state.queue` as plain serialisable items,
// and `pump` runs them one at a time in ONE BOUNDED LOOP with no recursion:
//
//   - an item that completes is shifted off and the loop continues
//   - an item that parks returns immediately, and `choose` resumes it
//   - an empty queue advances the clock (phase, end of turn) as far as it can
//     go without a player decision, and each advance may queue triggers, which
//     the next iteration drains
//
// Everything the engine does is therefore restartable from the state alone,
// which is what makes save/reload, lockstep and the AI's cloneState-and-try
// search all one mechanism instead of three.

import { runEffect, answerPending, ask } from './rules/driver.js';
import * as ops from './rules/ops.js';
import {
  spellsOn, topOf, stackAt, occupied, findSpell, defOf, canTurn, prohibited, homeCells, isTrap,
  playFromHand, deployGolem, turn, shift, destroy, draw, makeCard, fx,
} from './rules/ops.js';
import { CELLS, CELL_COLOR, orthoNeighbours, HOME } from './rules/table.js';
import { activeIndex, NUMERALS } from './rules/orient.js';
import { refresh, emptyDerived } from './rules/derive.js';
import { runChain, chainFrom, beginChain, endChain, findMatches, hasMatch } from './rules/match.js';
import { resolveSide, makeCtx } from './rules/resolve.js';
import { gateMet } from './rules/gates.js';
import { emptyLedger, bump } from './rules/ledger.js';
import { VP_DEFAULTS } from './rules/score.js';
import { emit, EVENTS } from './rules/triggers.js';
import { hurt, checkGolemAttrition } from './rules/combat.js';
import { fireFor } from './rules/keywords.js';
import { unitTargets } from './field/candidates.js';
import { findUnit } from './field/query.js';
import { TIER_CAP, SLOTS, slotForTier } from './rules/golems.js';
import { beginTurn, endTurn } from './rules/turn.js';
import { makeMage, unitActions, doUnitAction, pendingUnits, canMoveTo, settleMageLife } from './rules/units.js';
import { seedRng, save as saveRng, shuffle } from './rules/rng.js';
import { CARDS, STANDARD_DECK, FINDABLE } from './rules/spells/index.js';
import { emptyPouch, bindError, bind } from './rules/sigils.js';
import { makeArena, makeProps } from './field/arena.js';
import { resolveFalls, recheckSupport } from './field/move.js';


/**
 * Which actions check for a match afterwards.
 *
 * ops NEVER decides this; the action layer does, from this table. Printed
 * Precision I reads "rotate a Spell to any side. Do not trigger or resolve any
 * effects as a result of this rotation" -- and the moment a second site decides
 * for itself that a rotation implies a match check, that card is
 * unimplementable.
 */
// Which spell actions check the acting card for matches afterwards. A golem
// card goes to a slot and a destroy exposes the card beneath (which the pump
// picks up as fresh); the three that change a card on the table chain from it.
export const CHECKS_MATCHES = Object.freeze({
  play: true, rotate: true, shift: true, destroy: false, pass: false,
});

export const DEFAULT_CONFIG = Object.freeze({
  vp: VP_DEFAULTS,
  handSize: 5,
  turnCap: 160,
  /**
   * Open question, answered NO by default: when your effect moves an ENEMY
   * spell, no match check runs on their table. Otherwise you would be handing
   * your opponent a mandatory chain on your own turn, for free, which is a gift
   * no red card should be able to give. A card that wants otherwise says so.
   */
  enemyShiftChecksMatches: false,
  strict: false,
});

/* ------------------------------------------------------------ setup */

export function createGame(opts = {}) {
  const seed = opts.seed ?? 1;
  const config = { ...DEFAULT_CONFIG, ...(opts.config || {}) };
  const state = {
    seed,
    rng: seedRng(seed),
    defs: opts.defs || CARDS,
    derived: emptyDerived(),
    derivedStale: true,
    config,
    strict: !!config.strict,

    turn: 1,
    active: 0,
    phase: 'spell',
    spellActionUsed: false,
    bindUsed: false,          // one free bind a turn (sigils.js)
    actionSeq: 0,

    vp: [0, 0],
    scoreLog: [],
    chain: null,
    chainOverflow: false,
    tableDirty: [false, false],
    fresh: [[], []],             // which cards changed since the last chain, per player
    illegalRotations: 0,

    queue: [],
    pending: null,
    nextUid: 0,
    winner: null,
    reason: null,

    fx: [],
    derivationErrors: [],
    triggerErrors: [],
    resolveErrors: [],

    players: [null, null],
    /**
     * Which cards can be FOUND this match, and by doing what.
     *
     * On the state rather than imported where it is used, so a harness can
     * narrow it (or empty it) without touching the corpus -- and so the engine
     * has no opinion about which cards exist.
     */
    findable: opts.findable || FINDABLE.map((f) => ({ id: f.id, sigil: f.sigil })),
    arena: makeArena(seed),
    field: null,
  };
  delete state.pending;

  state.field = {
    props: makeProps(state.arena, seed).map((pr) => ({ ...pr, body: 'prop', support: null })),
    units: [],
    pendingFalls: [],
    nextUnitId: 0,
  };

  for (let p = 0; p < 2; p++) {
    state.players[p] = {
      table: Array.from({ length: CELLS }, () => []),
      golems: [null, null, null],
      hand: [], deck: [], discard: [],
      mage: { respawnOnTurn: null },
      ledger: emptyLedger(),
      objectives: {},
      foundThisMatch: [],
      runes: emptyPouch(),
    };
  }

  // Decks. The Spellbook is a record of WAYS to get cards, not an inventory, so
  // both players always start from the same standard list unless a harness says
  // otherwise. Found cards arrive in the discard during the match.
  const lists = opts.decks || [STANDARD_DECK, STANDARD_DECK];
  for (let p = 0; p < 2; p++) {
    for (const id of lists[p]) state.players[p].deck.push(makeCard(state, id, p));
    shuffle(state.rng, state.players[p].deck);
    draw(state, p, config.handSize);
  }

  for (let p = 0; p < 2; p++) makeMage(state, p);
  // Props are generated sitting on the ground; this is what gives each one a
  // `support` so the fall code can tell when it has lost it.
  for (const pr of state.field.props) pr.support = { kind: 'ground' };

  refresh(state);
  beginTurn(state);
  pump(state);
  return state;
}

/* ------------------------------------------------------------ legality */

export function legalActions(state) {
  if (state.winner !== null) return [];
  if (state.pending) return [];
  const p = state.active;
  if (state.phase === 'spell' && !state.spellActionUsed) return spellActions(state, p);
  if (state.phase === 'unit') return pendingUnits(state, p).flatMap((u) => unitActions(state, u));
  return [];
}

export function spellActions(state, p) {
  refresh(state);
  const pl = state.players[p];
  const out = [];

  for (const c of [...pl.hand].sort((a, b) => a.uid - b.uid)) {
    const def = defOf(state, c);
    if (def.kind === 'golem') {
      // EACH TIER HAS ITS OWN SLOT: an A-tier card can only go in slot A. So
      // "one of each type" needs no separate check -- a tier slot holds one
      // card, and the slot is the only question a golem card asks.
      const s = slotForTier(def.tier);
      if (s >= 0 && !pl.golems[s]) out.push({ type: 'play', uid: c.uid, slot: s });
    } else {
      // ONE CARD PER CELL. Cards never stack (user: "cards shouldn't be able
      // to go on top of each other"), so a home cell that is taken must be
      // cleared -- shifted aside or destroyed -- before the school plays again.
      for (const cell of homeCells(def)) if (!occupied(state, p, cell)) out.push({ type: 'play', uid: c.uid, cell });
    }
  }

  for (const sp of spellsOn(state, p)) {
    // A gated rotate is NOT OFFERED. The engine never proposes a move that
    // cannot do anything, and `fx('gateUnmet')` is how the UI explains why the
    // button is missing. The gate on the ACTIVE face is the one that restrains
    // you, which is the printed reading of "you may only rotate this Spell
    // if..." -- it is written on the side you are looking at.
    const face = defOf(state, sp).faces[activeIndex(sp)];
    if (canTurn(state, sp) && (!face?.gate || gateMet(state, sp, face.gate))) {
      out.push({ type: 'rotate', uid: sp.uid });
    }
    // A trap stays where it was set: no shift is offered (rotate is already
    // refused by canTurn). Destroying your own trap is as legal as ever.
    if (!isTrap(state, sp)) {
      for (const cell of orthoNeighbours(sp.cell)) if (!occupied(state, p, cell)) out.push({ type: 'shift', uid: sp.uid, cell });
    }
    out.push({ type: 'destroy', uid: sp.uid });
  }

  // Drawing is no longer an action -- every turn begins with one (turn.js) --
  // so a turn where nothing on the table is worth doing needs a way to decline.
  // Without it a player with an empty hand would be FORCED to destroy or shift
  // their own spells, which no rule asks for.
  out.push({ type: 'pass' });
  return out;
}

const sameAction = (a, b) => a.type === b.type && a.uid === b.uid && a.cell === b.cell
  && a.slot === b.slot && a.id === b.id && a.act === b.act && a.dir === b.dir
  && a.target === b.target && a.golem === b.golem && a.x === b.x && a.y === b.y;

/**
 * Is this action legal? Membership in `legalActions` for everything except a
 * unit MOVE, which goes anywhere inside the unit's move circle: the list only
 * samples that circle (it is what the AI searches), and the circle is the rule.
 */
function isLegal(state, action) {
  // A BIND lays any runes the pouch holds in any arrangement, so its space is
  // not enumerated either: once a turn, in either phase, judged structurally.
  if (action && action.type === 'bind') {
    if (state.bindUsed || (state.phase !== 'unit' && !(state.phase === 'spell' && !state.spellActionUsed))) return false;
    return bindError(state, state.active, action.cells) === null;
  }
  if (action && action.type === 'unit' && action.act === 'move'
      && Number.isInteger(action.x) && Number.isInteger(action.y)) {
    if (state.phase !== 'unit') return false;
    const u = pendingUnits(state, state.active).find((x) => x.id === action.id);
    return !!u && canMoveTo(state, u, action.x, action.y);
  }
  return legalActions(state).some((a) => sameAction(a, action));
}

/* ------------------------------------------------------------ acting */

export function apply(state, action) {
  if (state.pending) throw new Error('a question is outstanding; call choose()');
  if (state.winner !== null) return state;
  if (!isLegal(state, action)) {
    throw new Error(`illegal action: ${JSON.stringify(action)}`);
  }
  const p = state.active;

  if (action.type === 'unit') {
    state.queue.push({ kind: 'unit', action, seq: ++state.actionSeq });
    pump(state);
    return state;
  }
  if (action.type === 'bind') {
    // Free: it spends neither the unit phase nor the spell action, only the
    // turn's one bind. Whatever it finds is queued as a question.
    state.bindUsed = true;
    bind(state, p, action.cells);
    refresh(state);
    pump(state);
    return state;
  }

  state.spellActionUsed = true;
  let did = action.type;

  if (action.type === 'play') {
    const card = state.players[p].hand.find((c) => c.uid === action.uid);
    const def = defOf(state, card);
    if (def.kind === 'golem') { deployGolem(state, p, action.uid, action.slot); did = 'playGolem'; }
    else if (def.kind === 'trap') {
      // A TRAP is set face down: a full spell action, but it resolves nothing
      // and checks no matches -- it has no corners to match with. Its
      // placement is not even "fresh": the table is left exactly as it was.
      playFromHand(state, p, action.uid, action.cell);
      emit(state, 'afterPlay', { uid: action.uid, p, cell: action.cell });
      state.tableDirty[p] = false;
      if (state.fresh) state.fresh[p] = state.fresh[p].filter((u) => u !== action.uid);
      did = 'trapSet';
    } else {
      playFromHand(state, p, action.uid, action.cell);
      if (def.kind === 'artifact') bump(state.players[p].ledger, 'artifactsPlayed');
      emit(state, 'afterPlay', { uid: action.uid, p, cell: action.cell });
      // Playing a card RESOLVES the face it lands on -- side I -- and then THAT
      // card's matches chain (match.js). One work item does both.
      state.queue.push({ kind: 'played', uid: action.uid, p, seq: ++state.actionSeq });
      did = 'played';
    }
  } else if (action.type === 'rotate') {
    // Rotating a spell RESOLVES the face it brings to the top, and then that
    // card's matches chain, depth-first. Only the rotated card is checked.
    if (turn(state, action.uid, { dir: 'left' })) {
      state.queue.push({ kind: 'turned', uid: action.uid, p, seq: ++state.actionSeq });
    }
    did = 'rotated';
  } else if (action.type === 'shift') {
    if (shift(state, action.uid, action.cell)) {
      state.queue.push({ kind: 'shifted', uid: action.uid, p, seq: ++state.actionSeq });
    }
  } else if (action.type === 'destroy') {
    destroy(state, action.uid, { by: 'action' });
  }

  refresh(state);
  pump(state);
  return state;
}

export function choose(state, answer) {
  if (!state.pending) throw new Error('nothing is waiting for an answer');
  const r = answerPending(state, answer, resolveDescriptor, refresh);
  if (r.done) { if (state.queue.length) state.queue.shift(); pump(state); }
  return state;
}

/* ------------------------------------------------------------ the pump */

/** Turn one queue item into a generator. */
function runWork(state, item) {
  if (item.kind === 'chain') return runChain(state, item.p, item.cause);
  if (item.kind === 'unit') return doUnitAction(state, item.action);
  if (item.kind === 'trigger') return runTrigger(state, item);
  if (item.kind === 'onDestroy') return runOnDestroy(state, item);
  if (item.kind === 'sweep') return runSweep(state, item);
  if (item.kind === 'played' || item.kind === 'turned' || item.kind === 'shifted') return runChanged(state, item);
  if (item.kind === 'find') return runFind(state, item);
  throw new Error(`unknown work item '${item.kind}'`);
}

/**
 * A destroyed card's parting keywords -- [Unstable]'s blast.
 *
 * QUEUED by ops.destroy rather than fired there, for the same reason a trigger
 * may only queue: `destroy` runs in the middle of a cost being paid or a chain
 * link resolving, and the board is half-mutated. By the time this runs the card
 * is in the discard, so the context is built around the OWNER rather than
 * around the card.
 */
function* runOnDestroy(state, item) {
  const ctx = {
    state, p: item.p, spell: { uid: item.uid, owner: item.p, cell: null, keywords: [] },
    draw: (n) => draw(state, item.p, n),
    blast: (amount) => {
      const ids = unitTargets(state, item.p, 4000, { side: 'enemy' });
      if (!ids.length) return 0;
      const u = findUnit(state, ids[0]);
      return u ? hurt(state, u, amount, { cause: 'unstable', byP: item.p }) : 0;
    },
  };
  fireFor(item.keywords, 'onDestroy', ctx, {});
  return true;
}

/** A dead mage's spell table goes to the discard, once the board is whole again. */
function* runSweep(state, item) {
  ops.sweepTable(state, item.p);
  return true;
}

/** A Spellbook find: the finder chooses whether the card joins this duel. */
function* runFind(state, item) {
  const name = state.defs[item.defId]?.name || item.defId;
  const take = yield ask.by(item.p, ask.confirm(`You found ${name}. Add it to your deck for this duel?`));
  ops.found(state, item.p, item.defId, item.why, { take: take !== false });
  return true;
}

/**
 * The spell action's own card changed: a play or a rotation resolves the face
 * now on top, and then -- for a shift as well -- that ONE card's matches
 * chain, depth-first. The chain is opened and closed here, so a question
 * asked anywhere inside it parks and replays as one effect.
 */
function* runChanged(state, item) {
  const sp = findSpell(state, item.uid);
  if (!sp || sp.cell === null) return false;
  const own = beginChain(state, item.p, item.kind);
  if (item.kind !== 'shifted') {
    yield* resolveSide(state, sp, activeIndex(sp), { voluntary: true });
    refresh(state);
  }
  if (state.winner === null) yield* chainFrom(state, item.p, item.uid);
  if (own) endChain(state, item.p);
  return true;
}

function* runTrigger(state, item) {
  const sp = findSpell(state, item.uid);
  if (!sp || sp.cell === null) return false;
  const def = defOf(state, sp);
  const face = def.faces[item.index];
  // The card may have been rotated or destroyed between the event firing and
  // this item being reached -- a listener queues, it does not resolve, and the
  // whole point of that rule is that the board moves in between. A trigger whose
  // face is no longer showing does not fire.
  if (!face || activeIndex(sp) !== item.index) return false;
  const fn = face.on?.[item.event];
  if (!fn) return false;
  const ctx = makeCtx(state, sp, def, face, { triggered: true });
  yield* fn(ctx, item.payload);
  return true;
}

export function resolveDescriptor(state, d) {
  if (d.kind !== 'work') return null;
  const item = state.queue[0];
  if (!item) return null;
  return () => runWork(state, item);
}

/** The bound: no single action may take more than this many pump steps. */
export const PUMP_LIMIT = 2000;

export function pump(state) {
  for (let i = 0; i < PUMP_LIMIT; i++) {
    if (state.pending || state.winner !== null) return state;

    if (state.queue.length) {
      const item = state.queue[0];
      const r = runEffect(state, { kind: 'work' }, () => runWork(state, item));
      if (!r.done) return state;            // parked on a question
      state.queue.shift();
      // A finished work item may have left somebody's table changed -- a queued
      // trigger that rotated a card, for instance. A rotation means a match
      // check, and a trigger runs after the chain that queued it has already
      // ended, so the new match needs a NEW chain. The chain itself clears the
      // flag, so this cannot queue two for one change.
      if (item.kind !== 'chain') {
        for (let q = 0; q < 2; q++) {
          if (!state.tableDirty[q]) continue;
          // Only the acting player's own table checks. Handing your opponent a
          // mandatory chain on your own turn is a gift no card should give, and
          // the config knob says so out loud.
          if (q !== state.active && !state.config.enemyShiftChecksMatches) { state.tableDirty[q] = false; if (state.fresh) state.fresh[q] = []; continue; }
          state.queue.push({ kind: 'chain', p: q, cause: item.kind, seq: ++state.actionSeq });
          state.tableDirty[q] = false;
        }
      }
      continue;
    }

    // The queue is empty, so settle the world and then advance the clock as far
    // as it will go without needing a decision.
    refresh(state);
    checkGolemAttrition(state);
    settleMageLife(state);
    recheckSupport(state);
    if (state.field.pendingFalls.length) { resolveFalls(state, hurt); continue; }
    if (state.winner !== null) return state;
    // Units act first; when every unit has acted the spell action opens, and
    // the turn ends once that one action is spent.
    if (state.phase === 'unit' && !pendingUnits(state, state.active).length) { state.phase = 'spell'; continue; }
    if (state.phase === 'spell' && state.spellActionUsed) {
      if (state.turn >= state.config.turnCap) {
        // A declared draw, not a timeout. The harness treats a game that simply
        // stopped as a failure, so the engine has to say which kind of ending
        // this was.
        state.winner = -1;
        state.reason = 'turn cap';
        fx(state, 'draw', { turn: state.turn });
        return state;
      }
      endTurn(state);
      continue;
    }
    return state;                            // waiting for the player
  }
  state.pumpOverflow = true;
  return state;
}

/* ------------------------------------------------------------ clone + hash */

const NOT_CLONED = ['defs', 'derived', 'arena', 'fx', 'fxCards', 'derivedTouched'];

/**
 * A deep copy the AI can mutate freely.
 *
 * Shares `defs` and `arena` by reference, because both are frozen and both are
 * pure functions of inputs the copy carries anyway. `derived` is rebuilt rather
 * than copied -- it holds Sets and Maps of live uids and would be stale the
 * instant the copy was mutated.
 */
export function cloneState(state) {
  const rest = {};
  for (const k of Object.keys(state)) if (!NOT_CLONED.includes(k)) rest[k] = state[k];
  const out = structuredClone(rest);
  out.defs = state.defs;
  out.arena = state.arena;
  out.fx = [];
  out.derived = emptyDerived();
  out.derivedStale = true;
  refresh(out);
  return out;
}

const fnv = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h >>> 0;
};

/**
 * A hash of everything that can affect the future of the game.
 *
 * `fx` is excluded, deliberately: it is notes for the view, and including it
 * would make two engines that agree about the game disagree about the hash the
 * moment one of them re-rendered. Everything else goes in, and the ORDER is
 * fixed at every level, because an unordered fold over a Set is a hash that
 * depends on insertion history.
 */
export function hashState(state) {
  const parts = [`t${state.turn}a${state.active}p${state.phase}s${state.spellActionUsed ? 1 : 0}b${state.bindUsed ? 1 : 0}`];
  parts.push(`vp${state.vp[0]}/${state.vp[1]}`, `log${state.scoreLog.length}`);
  parts.push(`w${state.winner}`, `rng${saveRng(state.rng).join('.')}`);
  parts.push(`chain${state.chain ? state.chain.links + ':' + state.chain.resolutions : 'x'}`);
  parts.push(`fresh${(state.fresh || [[], []]).map((f) => f.join('.')).join('|')}`);
  parts.push(`q${state.queue.map((w) => `${w.kind}${w.uid ?? ''}${w.event ?? ''}`).join(',')}`);
  parts.push(`pend${state.pending ? state.pending.request.type + state.pending.answers.length : 'x'}`);

  for (let p = 0; p < 2; p++) {
    const pl = state.players[p];
    for (let c = 0; c < CELLS; c++) {
      const stack = pl.table[c];
      parts.push(`${p}.${c}[${stack.map((s) => `${s.def}:${s.rot}:${s.keywords.join('+')}:${s.noTurnUntil ?? '-'}${s.concealed ? ':C' : ''}`).join('|')}]`);
    }
    parts.push(`${p}g[${pl.golems.map((g) => (g ? `${g.def}:${g.everDeployed ? 1 : 0}:${g.units.join('.')}` : '-')).join('|')}]`);
    parts.push(`${p}h[${pl.hand.map((c) => c.def).join(',')}]`);
    parts.push(`${p}d[${pl.deck.map((c) => c.def).join(',')}]`);
    parts.push(`${p}x[${pl.discard.map((c) => c.def).join(',')}]`);
    parts.push(`${p}L[${Object.keys(pl.ledger).sort().map((k) => pl.ledger[k]).join(',')}]`);
    parts.push(`${p}O[${Object.keys(pl.objectives).sort().join(',')}]`);
    parts.push(`${p}R[${Object.keys(pl.runes).sort().map((k) => pl.runes[k]).join(',')}]`);
  }
  parts.push(hashField(state));
  return fnv(parts.join(';'));
}

export function hashField(state) {
  const us = [...state.field.units].sort((a, b) => a.id - b.id)
    .map((u) => `${u.id}:${u.owner}${u.kind[0]}:${u.x},${u.y},${u.z}:${u.hp}:${u.dead ? 'D' : ''}${u.acted ? 'A' : ''}:${u.poison || 0}:${u.burn || 0}:${(u.keywords || []).join('+')}:${u.support?.kind || '-'}${u.support?.id || ''}:${u.heldUntil ?? '-'}`);
  const ps = [...state.field.props].sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((pr) => `${pr.id}:${pr.x},${pr.y},${pr.z}:${pr.removedUntil ?? '-'}:${pr.hp}:${pr.burning ?? '-'}${pr.destroyed ? 'X' : ''}`);
  return `F[${us.join('|')}][${ps.join('|')}][${[...state.field.pendingFalls].sort().join(',')}]`;
}

export { ask, refresh, findMatches, hasMatch, resolveSide, legalActions as actions };
