// Zone primitives: the ONLY way a card moves, rotates or changes zone.
//
// Nothing outside this file touches `player.table`, `player.hand`, `player.deck`
// or `player.discard`. That is not tidiness. Every zone change has to mark the
// table dirty, fire the trigger bus, and count itself into the ledger, and the
// moment there are two places a card can move from, one of them will forget.
// GUDNAK learned this with "after this fighter moves OR IS RELOCATED", a printed
// clause on several cards that nothing ever announced because being shoved took
// a different code path from walking.
//
// One deliberate asymmetry lives here: ops NEVER checks for matches. The action
// layer decides. A card that says "do not trigger any effects as a result of
// this rotation" (printed Precision I) is unimplementable the moment a second
// site decides for itself that a rotation means a match check.

import { CELL_COLOR, CELLS, HOME, orthoNeighbours } from './table.js';
import { turned } from './orient.js';
import { shuffle } from './rng.js';
// A real cycle: triggers must read the board, and the board may only be read
// through ops. Both sides only call each other from inside function bodies, and
// `export function` is hoisted, so the cycle resolves. Do not move either
// import into module-evaluation code.
import { emit } from './triggers.js';
import { ensureFresh } from './derive.js';
import { keywordsOf, applyFor } from './keywords.js';

/**
 * RULE B. NO SPELL MAY BE ROTATED MORE THAN FOUR TIMES IN ONE SPELL ACTION.
 *
 * Four left turns return a card to where it started, so the fifth brings up a
 * face that has already been up this action. Scoped to the ACTION rather than
 * to the chain, because a rotation does not have to come from a chain: two
 * Defrinol Orbs ("after this Artifact is rotated, rotate a Spell left") sitting
 * next to each other rotate each other through QUEUED TRIGGERS, which run after
 * a chain has ended and would otherwise ping-pong forever with each individual
 * chain perfectly well bounded.
 *
 * It counts ROTATION EVENTS, not quarter-turns, and that distinction is not
 * cosmetic. `setRot` -- printed Precision I, "rotate a Spell to any side" --
 * moves a card up to three quarter-turns at once, so counting quarter-turns let
 * a card that had already turned twice reach five and blow the cap. A 140-game
 * sweep found it; twenty games had not. Counting events is what actually bounds
 * the ping-pong anyway, since the loop is driven by how many times a trigger
 * fires, and "four turns is a revolution" survives as the flavour.
 *
 * Enforced HERE, in the one function every rotation passes through, rather than
 * in the chain. The chain also filters on it so it never offers a dead choice,
 * but the chain is not the only caller and a bound that only the chain honours
 * is not a bound.
 */
export const REVOLUTION = 4;

/* ------------------------------------------------------------ view notes */

/**
 * Leave a note for the VIEW. Plain data, not part of the hash, cannot change
 * the game. Only the rules know this destroy was a sacrifice to a gate rather
 * than an enemy's doing, so only the rules can say so.
 */
export function fx(state, kind, data = {}) {
  // An effect that parks is REPLAYED from its snapshot on every answer, so a
  // note left during that replay describes a moment the player has already been
  // shown. Writing it again makes the same bolt strike three times.
  if (state.replaying) return;
  // `kind` goes in LAST, so a payload field of the same name cannot overwrite
  // the event name. It did: `fx(state, 'push', { kind: body.body, ... })` wrote
  // a note of kind 'unit', every push note in the game was mislabelled, and
  // selfplay.js reported realised push distance as 0% of nominal while the
  // ledger counted 66 metres of it. Payload fields are now named so they cannot
  // collide, and this ordering makes the next one harmless rather than silent.
  (state.fx ||= []).push({ ...data, kind });
}

/** Name the actual cards an effect touched, so the view can draw the real ones. */
export function noteCards(state, uids) {
  if (state.replaying) return;
  const list = [].concat(uids).filter(Boolean);
  if (list.length) (state.fxCards ||= []).push(...list);
}

/* ------------------------------------------------------------ reading */

/**
 * A card instance stores its definition's ID, not the definition.
 *
 * The effect driver parks a pending effect as a structuredClone of the state, so
 * anything reachable from a card is cloned on every question. A def reference
 * would be deep-copied -- expensive, and worse, the copy would no longer be
 * identity-equal to the shared frozen original, so `def === state.defs[id]`
 * would start returning false after the first answer. The rulebook lives in
 * `state.defs`, which the driver never clones, and cards point into it by name.
 */
export const defOf = (state, card) => state.defs[card.def];

export const stackAt = (state, p, cell) => state.players[p].table[cell] || [];
export const topOf = (state, p, cell) => stackAt(state, p, cell)[0] || null;
export const occupied = (state, p, cell) => stackAt(state, p, cell).length > 0;

/** The in-play spells of one player, ASCENDING BY CELL. */
export function spellsOn(state, p) {
  const out = [];
  for (let c = 0; c < CELLS; c++) {
    const s = topOf(state, p, c);
    if (s) out.push(s);
  }
  return out;
}

/** Every in-play spell on both tables, player 0 first, then ascending by cell. */
export function allInPlay(state) {
  return [...spellsOn(state, 0), ...spellsOn(state, 1)];
}

/** Every spell object anywhere, including buried ones. Ordered, for hashing. */
export function* everySpell(state) {
  for (let p = 0; p < 2; p++) {
    const pl = state.players[p];
    for (let c = 0; c < CELLS; c++) {
      const stack = pl.table[c] || [];
      for (let d = 0; d < stack.length; d++) yield { card: stack[d], zone: 'table', player: p, cell: c, depth: d };
    }
    for (const zone of ['hand', 'deck', 'discard']) {
      const list = pl[zone];
      for (let i = 0; i < list.length; i++) yield { card: list[i], zone, player: p, index: i };
    }
    for (let s = 0; s < 3; s++) {
      const g = pl.golems[s];
      if (g) yield { card: g, zone: 'slot', player: p, slot: s };
    }
  }
}

export function findSpell(state, uid) {
  for (const e of everySpell(state)) if (e.card.uid === uid) return e.card;
  return null;
}

export function locate(state, uid) {
  for (const e of everySpell(state)) if (e.card.uid === uid) return e;
  return null;
}

/* ------------------------------------------------------------ legality */

/** The cells a card of this def may be PLAYED onto. */
export function homeCells(def) {
  if (def.kind === 'golem') return [];
  return HOME[def.kind === 'artifact' ? 'artifact' : def.school] || [];
}

export const onHomeColour = (state, spell) => {
  const def = defOf(state, spell);
  const want = def.kind === 'artifact' ? 'grey' : def.school;
  return CELL_COLOR[spell.cell] === want;
};

/**
 * A PROHIBITION blocks every rotation, including the forced one from a match.
 *
 * Printed Fire Bolt III: "You may not rotate this Spell again this turn." That
 * is strictly stronger than the colour lock below, and the difference decides
 * what a chain can do to you, so the two live in separate predicates and the
 * rulebook names both.
 */
export function prohibited(state, spell) {
  if (!spell) return true;
  if (spell.noTurnUntil !== null && spell.noTurnUntil >= state.turn) return true;
  return !!ensureFresh(state)?.noTurn?.has(spell.uid);
}

/**
 * Whether the PLAYER may choose to rotate this spell.
 *
 * A spell on a cell that does not match its colour got there by being shifted,
 * and cannot be rotated voluntarily. A match rotates it anyway -- the lock
 * restrains the player, not the board.
 */
export function canTurn(state, spell) {
  if (prohibited(state, spell)) return false;
  if (ensureFresh(state)?.freeTurn?.has(spell.uid)) return true;
  // Through the keyword funnel as well, not only the derived bucket. [Spell
  // Mastery] registers the `turnLock` hook and nothing called it, so the
  // passive form of this worked and the keyword form silently did not.
  if (applyFor(keywordsOf(state, spell), 'turnLock', { free: false }).free) return true;
  return onHomeColour(state, spell);
}

/* ------------------------------------------------------------ making cards */

/**
 * uids come from `state.nextUid`, never from module scope.
 *
 * A counter in module scope is shared by every game in the process and resets
 * when the module reloads, so two machines in a lockstep game disagree about
 * which card is which. GUDNAK shipped that bug.
 */
export function makeCard(state, defId, owner) {
  const def = state.defs[defId];
  if (!def) throw new Error(`no such card '${defId}'`);
  if (def.kind === 'golem') {
    return { uid: ++state.nextUid, def: defId, owner, slot: null, everDeployed: false, units: [] };
  }
  return {
    uid: ++state.nextUid, def: defId, owner,
    cell: null, rot: 0, playedTo: null,
    plays: 0,                // how many times this very card has been played
    keywords: [],            // COPIED keywords only. Printed ones live on the def.
    noTurnUntil: null,
    turnsThisAction: 0,
  };
}

/* ------------------------------------------------------------ extract/place */

export function extract(state, uid) {
  const at = locate(state, uid);
  if (!at) return null;
  const pl = state.players[at.player];
  if (at.zone === 'table') return pl.table[at.cell].splice(at.depth, 1)[0];
  if (at.zone === 'slot') { pl.golems[at.slot] = null; return at.card; }
  return pl[at.zone].splice(at.index, 1)[0];
}

/** Put a spell onto a cell. `under` buries it beneath what is already there. */
export function place(state, p, spell, cell, { under = false } = {}) {
  const stack = state.players[p].table[cell];
  spell.cell = cell;
  spell.owner = p;
  if (under) stack.push(spell); else stack.unshift(spell);
  markDirty(state, p);
  return true;
}

/** The table changed, so the one live chain loop should rescan. */
export const markDirty = (state, p) => {
  state.tableDirty[p] = true;
  // Derived buckets are now one mutation stale. Marked rather than recomputed:
  // a derive pass in the middle of `destroy` would run every passive against a
  // half-mutated board.
  state.derivedStale = true;
};

/**
 * Which keywords have something to say when their carrier is destroyed.
 *
 * Computed from the registry rather than listed, so a new keyword with an
 * `onDestroy` hook works without editing this file.
 */
import { KEYWORDS } from './keywords.js';
const KEYWORDS_ON_DESTROY = new Set(
  Object.keys(KEYWORDS).filter((k) => typeof KEYWORDS[k].onDestroy === 'function'),
);

/* ------------------------------------------------------------ actions */

export function playFromHand(state, p, uid, cell) {
  const card = extract(state, uid);
  if (!card) return null;
  if (defOf(state, card).kind === 'golem') throw new Error('golem cards go to slots -- use deployGolem');
  card.rot = 0;                 // every spell lands showing side I
  card.playedTo = cell;
  card.turnsThisAction = 0;
  card.plays = (card.plays || 0) + 1;
  card.keywords = [];
  // What the owner's counters read at this moment, so a gold objective can ask
  // for work done SINCE this card arrived (gates.js counted). Plain numbers.
  card.ledgerAtPlay = { ...state.players[p].ledger };
  place(state, p, card, cell);
  state.players[p].ledger.spellsPlayed++;
  fx(state, 'play', { uid, p, cell });
  return card;
}

export function deployGolem(state, p, uid, slot) {
  const card = extract(state, uid);
  if (!card) return null;
  card.slot = slot;
  state.players[p].golems[slot] = card;
  state.players[p].ledger.golemsPlayed++;
  fx(state, 'golemCard', { uid, p, slot });
  return card;
}

/**
 * Rotate a spell.
 *
 * `forced` is what a match uses. Without it the rotation is the player's own,
 * and an ILLEGAL one is recorded rather than silently performed: legalActions
 * is supposed to have filtered it out already, so `state.illegalRotations`
 * staying zero across thousands of games is the proof that the two agree.
 * Refusing quietly would make that disagreement invisible.
 */
export function turn(state, uid, { dir = 'left', steps = 1, forced = false, silent = false } = {}) {
  const sp = findSpell(state, uid);
  if (!sp || sp.cell === null) return false;
  if (forced ? prohibited(state, sp) : !canTurn(state, sp)) {
    if (!forced) state.illegalRotations = (state.illegalRotations || 0) + 1;
    return false;
  }
  if (sp.turnsThisAction >= REVOLUTION) { fx(state, 'revolutionSpent', { uid }); return false; }
  sp.rot = turned(sp.rot, dir, steps);
  sp.turnsThisAction++;
  state.players[sp.owner].ledger.rotations++;
  markDirty(state, sp.owner);
  if (!silent) fx(state, 'rotate', { uid, dir, rot: sp.rot });
  emit(state, 'afterRotate', { uid, dir, forced, p: sp.owner });
  return true;
}

/** Set a spell's rotation outright. Printed Precision I: "rotate to any side." */
export function setRot(state, uid, rot, { forced = false } = {}) {
  const sp = findSpell(state, uid);
  if (!sp || sp.cell === null) return false;
  if (forced ? prohibited(state, sp) : !canTurn(state, sp)) {
    if (!forced) state.illegalRotations = (state.illegalRotations || 0) + 1;
    return false;
  }
  if (sp.turnsThisAction >= REVOLUTION) { fx(state, 'revolutionSpent', { uid }); return false; }
  sp.rot = rot & 3;
  sp.turnsThisAction++;
  state.players[sp.owner].ledger.rotations++;
  markDirty(state, sp.owner);
  emit(state, 'afterRotate', { uid, dir: 'set', forced, p: sp.owner });
  return true;
}

export function shift(state, uid, cell) {
  const sp = findSpell(state, uid);
  if (!sp || sp.cell === null) return false;
  if (!orthoNeighbours(sp.cell).includes(cell)) return false;
  const from = sp.cell, p = sp.owner;
  const card = extract(state, uid);
  if (!card) return false;
  place(state, p, card, cell);
  state.players[p].ledger.shifts++;
  fx(state, 'shift', { uid, from, to: cell });
  emit(state, 'afterShift', { uid, from, to: cell, p });
  return true;
}

/** Destroy a card on the table. It goes to its owner's discard. */
export function destroy(state, uid, { by = null } = {}) {
  const at = locate(state, uid);
  if (!at || at.zone !== 'table') return null;
  // Captured BEFORE the card leaves the table: copied keywords are cleared on
  // the way out, and a derived grant stops applying the moment it is gone.
  const parting = keywordsOf(state, at.card).filter((k) => KEYWORDS_ON_DESTROY.has(k));
  const card = extract(state, uid);
  card.cell = null;
  card.rot = 0;
  card.keywords = [];        // copied keywords do not survive leaving the table
  card.noTurnUntil = null;
  card.turnsThisAction = 0;
  state.players[card.owner].discard.push(card);
  state.players[card.owner].ledger.spellsDestroyed++;
  markDirty(state, at.player);
  fx(state, 'destroy', { uid, p: at.player, cell: at.cell, by });
  if (parting.length && state.queue) {
    state.queue.push({
      kind: 'onDestroy', uid, p: at.player, keywords: parting, seq: ++state.actionSeq,
    });
  }
  emit(state, 'afterDestroy', { uid, p: at.player, cell: at.cell, by });
  return card;
}

/* ------------------------------------------------------------ hand/deck */

/**
 * Draw. An empty deck is RESHUFFLED from the discard first.
 *
 * Without this the game simply runs out: the standard deck is ten cards, there
 * is no draw step, and a gold objective deliberately sends its own card to the
 * discard every time it scores. The round trip through the discard IS the VP
 * throttle, so the discard has to be able to come back.
 */
export function draw(state, p, n = 1) {
  const pl = state.players[p];
  const got = [];
  for (let i = 0; i < n; i++) {
    if (!pl.deck.length) {
      if (!pl.discard.length) break;
      pl.deck = shuffle(state.rng, pl.discard);
      pl.discard = [];
      pl.ledger.reshuffles++;
      fx(state, 'reshuffle', { p });
    }
    const c = pl.deck.shift();
    pl.hand.push(c);
    got.push(c);
  }
  if (got.length) {
    pl.ledger.cardsDrawn += got.length;
    emit(state, 'afterDraw', { p, n: got.length });
  }
  return got;
}

export function discardFromHand(state, p, uid) {
  const at = locate(state, uid);
  if (!at || at.zone !== 'hand') return null;
  const card = extract(state, uid);
  state.players[p].discard.push(card);
  state.players[p].ledger.cardsDiscarded++;
  fx(state, 'discard', { uid, p });
  emit(state, 'afterDiscard', { uid, p });
  return card;
}

/** Put a card into a player's discard from nowhere -- a FOUND card. */
export function found(state, p, defId, why) {
  const card = makeCard(state, defId, p);
  state.players[p].discard.push(card);
  state.players[p].ledger.cardsFound++;
  state.players[p].foundThisMatch.push(defId);
  fx(state, 'found', { p, defId, why });
  emit(state, 'afterFound', { p, defId, why });
  return card;
}

/**
 * NOTE for the next person who wants a card that bounces a Spell.
 *
 * `toHand` and `toDeck` were written here and then deleted, because no card
 * used them and tools/checksource.js reports a dead export. They belong with
 * the card that needs them -- and when you write them, remember that a card
 * leaving the table must have `cell` nulled, `rot` reset, copied keywords
 * cleared and `markDirty` called, exactly as `destroy` does.
 */

export function mill(state, p, n = 1) {
  const pl = state.players[p];
  const out = [];
  for (let i = 0; i < n && pl.deck.length; i++) out.push(pl.deck.shift());
  pl.discard.push(...out);
  return out;
}
