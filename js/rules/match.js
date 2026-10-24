// THE MATCH RULE and the chain. The heart of the game, and the one file whose
// correctness nothing downstream can survive being wrong about.
//
//   Two or more of your cards meeting at one grid vertex, showing the SAME RUNE
//   there, match. When they do: choose one of them, rotate it left, and resolve
//   the effect of its newly showing face.
//
// Only the chosen card rotates, and the card you rotate is the card you resolve.
// One decision, not two.
//
// The rotation is UNCONDITIONAL; the effect is conditional on its cost. If you
// cannot or will not pay, the rotation stands and the effect fizzles. That
// asymmetry is the whole reason a mandatory chain can hurt you -- it can turn
// you off a face you wanted and give you nothing for it.
//
// ============================== TERMINATION ==============================
//
// A rotate-driven chain genuinely loops. Two cards sharing a rune on every
// corner re-create their own match after every rotation, and a card that
// rotates something else without matching anything (printed Defrinol Orb:
// "after this Artifact is rotated, rotate a Spell left") can ping-pong
// rotations indefinitely. So termination is PROVED, from ONE rule a player can
// be taught, not from a loop guard:
//
//   EACH SPELL IS ROTATED AT MOST ONCE PER TURN.
//
//     User (2026-10-24): "each spell can only be rotated once per turn. Its
//     faces can be resolved more times (like Fuse resolving its face that's
//     active) but it can only be rotated once." Every rotation in the game --
//     a match, a face that says "rotate a Spell", a trigger, the player's own
//     action -- passes through ops.turn/setRot, which refuse a second one
//     (ops.ROTATION_CAP). A chain link IS a rotation of the matched neighbour,
//     so a chain is at most nine links a turn by construction, and a match
//     whose neighbour has had its rotation simply does not fire. Resolving a
//     face without turning (Fuse, Rewind, Echo) is unlimited.
//
//     This replaced two older bounds -- a junction resonating once per chain,
//     and four rotations per action -- which together let a square of three-
//     rune cards resolve five faces every turn (user: "isn't that an infinite
//     combo?"). Now the same square turns each of its four cards once.
//
//   THE TRIGGER -- only a card that just changed sets off a match.
//
//     The card the action played, rotated or shifted is FRESH, and so is every
//     card the chain turns. A site fires only if one of its cards is fresh, and
//     it is the OTHER card -- the matched neighbour -- that turns. Without this,
//     two cards that matched three turns ago fire again on every action.
//
// What makes this a proof rather than a hope is that progress depends on NO
// player choice, NO cost being payable and NO effect succeeding: every loop
// iteration below turns a card that could still turn, and afterwards it
// cannot. `state.guard` is an ASSERTION. If it ever fires, something above is
// wrong; it must never be the thing that decides a game.

import { ask } from './driver.js';
import {
  MATCH_SITES, SITE, VERTEX_CARDS, INTERIOR_SITES, CORNER_OF,
} from './table.js';
import { activeIndex } from './orient.js';
import { topOf, spellsOn, defOf, findSpell, turn, prohibited, fx, noteCards, ROTATION_CAP } from './ops.js';
import { refresh } from './derive.js';
import { runeAtCorner, runesMatch } from './corners.js';
import { resonate, keywordsOf } from './keywords.js';
import { resolveSide } from './resolve.js';
import { bump, high } from './ledger.js';
import { emit } from './triggers.js';

/** A chain may not exceed this many links. An ASSERTION, never a rule. */
export const CHAIN_ASSERT = 64;

export { ROTATION_CAP };

export { runeAtCorner, runesMatch, touching } from './corners.js';

/**
 * Every site that matches right now.
 *
 * `fresh` is the list of uids that have CHANGED since the chain began (the card
 * played, rotated or shifted, and every card the chain has turned since). When
 * it is given, only sites touching a fresh card count: a pair that has sat
 * matching since three turns ago does not fire again every time something
 * else on the table moves. `null` means "any pair" -- the AI's potential term
 * and the adversarial harness want that reading.
 *
 * `live` says whether the match can FIRE: the card that would turn (the
 * non-fresh one, or either when nothing is fresh) still has its one rotation
 * this turn and is under no prohibition. A match that is not live is shown
 * but never fires.
 *
 * Returned in site order, never sorted by anything the state could vary.
 */
export function findMatches(state, p, fresh = null) {
  const out = [];
  for (const id of MATCH_SITES) {
    const site = SITE[id];
    const a = topOf(state, p, site.cells[0]);
    const b = topOf(state, p, site.cells[1]);
    if (!a || !b) continue;
    if (fresh && !fresh.includes(a.uid) && !fresh.includes(b.uid)) continue;
    const ra = runeAtCorner(state, a, site.pos[0]);
    const rb = runeAtCorner(state, b, site.pos[1]);
    if (!runesMatch(ra, rb)) continue;
    // The card that did NOT just change is the one the match turns. If both
    // changed (an effect turned the neighbour of the card you played), or
    // nothing is marked fresh, the player chooses.
    const turners = fresh ? [a, b].filter((s) => !fresh.includes(s.uid)).map((s) => s.uid) : [];
    const candidates = turners.length ? [a, b].filter((s) => turners.includes(s.uid)) : [a, b];
    out.push({
      site: id,
      vertex: site.vertex,
      uids: [a.uid, b.uid],
      cells: [a.cell, b.cell],
      interior: INTERIOR_SITES.includes(id),
      turners,
      live: candidates.some((s) => mayTurn(state, s)),
      locked: [a, b].every((s) => prohibited(state, s)),
    });
  }
  return out;
}

/** May a match still turn this card: no prohibition, and its rotation this turn unspent. */
export const mayTurn = (state, sp) => !prohibited(state, sp) && (sp.turnsThisTurn | 0) < ROTATION_CAP;

/** Does the acting player have a match waiting? Used by legalActions and the AI. */
export const hasMatch = (state, p) =>
  findMatches(state, p, freshOf(state, p)).some((h) => h.live);

/** What has changed on this table since the last chain -- the match trigger set. */
const freshOf = (state, p) => (state.fresh?.[p]?.length ? state.fresh[p] : null);

/**
 * THE CHAIN, depth-first, from one card.
 *
 * Only the card that just changed is checked for matches -- never the whole
 * table. For each site where one of its touching corners matches a
 * neighbour's, the NEIGHBOUR turns left, its new face resolves, and then THAT
 * card's own matches run to exhaustion before we come back here and look at
 * this card again (with whatever corners it shows now -- an effect may have
 * turned it meanwhile). A neighbour that has had its one rotation this turn
 * does not fire again, which is what ends the chain.
 *
 * A generator, because it asks questions, so it is parked on `state.pending`
 * and REPLAYED FROM A SNAPSHOT on every answer like any other effect. All of
 * its bookkeeping is therefore plain serialisable data on `state.chain`.
 */
export function* chainFrom(state, p, uid) {
  // `active` is the card whose corners are being looked at right now, for the
  // HUD's bonds. Plain data on the chain, so it parks and replays with it.
  const prevActive = state.chain.active ?? null;
  state.chain.active = uid;
  for (let guard = 0; ; ) {
    if (++guard > CHAIN_ASSERT) {
      // Unreachable while every link turns a card. Recorded rather than
      // thrown so the harness reports WHICH game did it instead of dying inside it.
      state.chainOverflow = true;
      fx(state, 'chainOverflow', { p, links: state.chain.links });
      break;
    }
    if (state.winner !== null) break;
    const sp = findSpell(state, uid);
    if (!sp || sp.cell === null || sp.owner !== p) break;

    // Only matches whose neighbour can still turn. A locked or spent
    // neighbour is noted once for the log and otherwise ignored; it is the
    // filter, not a spent list, that makes every iteration below a rotation.
    const all = findMatches(state, p, [uid]);
    for (const h of all) {
      if (h.live || state.chain.noted.includes(h.site)) continue;
      state.chain.noted.push(h.site);
      fx(state, 'matchLocked', { vertex: h.vertex, site: h.site, uids: h.uids });
    }
    const hits = all.filter((h) => h.live);
    if (!hits.length) break;

    // Two or more NEIGHBOURS match this card: the order is the player's. One
    // option per neighbour, not per site -- a neighbour touching at both of
    // its corners is still one card to turn first (user: "it should only say
    // 1 shift"); its sites go in table order. A single neighbour resolves
    // without asking -- and note a zero-option request would park the game
    // forever, which the driver answers null.
    const otherOf = (h) => h.uids.find((u) => u !== uid);
    const neighbours = [...new Set(hits.map(otherOf))];
    const firstOf = (o) => hits.find((h) => otherOf(h) === o);
    const chosen = neighbours.length === 1 ? neighbours[0] : yield ask.pick(
      neighbours,
      {
        prompt: `${defOf(state, sp).name} matches two neighbours — which first?`,
        labels: neighbours.map((o) => defOf(state, findSpell(state, o)).name),
        show: neighbours.map((o) => ({ uids: [...firstOf(o).uids], vertex: firstOf(o).vertex, site: firstOf(o).site })),
        match: { uid, sites: hits.map((h) => ({ uids: [...h.uids], corners: cornersOf(state, p, h) })) },
      },
    );
    const hit = (chosen !== null && firstOf(chosen)) || hits[0];

    state.chain.links++;
    bump(state.players[p].ledger, 'chainLinks');

    // THE NEIGHBOUR TURNS. The card that changed is the trigger; the other
    // card of the pair is what it sets off. It is live (filtered above), so
    // the turn below succeeds and spends its rotation for the turn -- THAT is
    // the progress every iteration makes. If it somehow did not, stop rather
    // than spin: the assertion above would catch the loop otherwise.
    const other = hit.uids.find((u) => u !== uid);
    const s2 = findSpell(state, other);
    if (!s2 || !mayTurn(state, s2)) { fx(state, 'matchLocked', { vertex: hit.vertex, site: hit.site, uids: hit.uids }); break; }

    // The corners as they MET, read before the turn changes them, so the
    // HUD can ring the two runes that agreed.
    noteCards(state, hit.uids);
    fx(state, 'match', { vertex: hit.vertex, site: hit.site, uids: hit.uids, chosen: other, p, corners: cornersOf(state, p, hit) });

    // RESONANCE. The Keywords of each matched card are already on the other
    // -- keywords.js derives that from the corners, nothing is asked and
    // nothing is written -- so here the link only NOTES what crossed, for
    // the log and the ledger. Then the neighbour's Keywords, as it stands
    // matched, are CARRIED through the effect it is about to resolve: the
    // turn will part the corners that met, and putting [Ignore Height] on a
    // push must still change the push about to be made. (user: "it copies
    // keywords AFTER the spell turns. It should be before")
    resonate(state, hit.uids);
    state.chain.carry = { uid: other, keywords: keywordsOf(state, s2) };

    // Mandatory and unconditional. A COLOUR LOCK DOES NOT STOP THIS -- the lock
    // restrains the player, not the board. Only a printed prohibition does.
    // Not silent: the HUD plays every turn the chain makes (user: "sometimes
    // its hard to catch how fast it moves").
    if (!turn(state, other, { dir: 'left', forced: true })) break;
    bump(state.players[p].ledger, 'forcedRotations');
    refresh(state);
    emit(state, 'afterMatch', { vertex: hit.vertex, site: hit.site, uids: hit.uids, chosen: other, p });

    state.chain.resolutions++;
    yield* resolveSide(state, s2, activeIndex(s2), { chained: true });
    state.chain.carry = null;
    refresh(state);
    if (state.winner !== null) break;

    // DEPTH FIRST: everything the neighbour sets off runs before we return
    // to this card and look at its remaining corners.
    yield* chainFrom(state, p, other);
    state.chain.active = uid;
  }
  state.chain.active = prevActive;
  settled(state, p, uid);
}

/** Which corners of a matched pair touch, for the HUD. */
function cornersOf(state, p, hit) {
  return VERTEX_CARDS[hit.vertex]
    .map(({ cell, pos }) => ({ sp: topOf(state, p, cell), pos }))
    .filter((x) => x.sp && hit.uids.includes(x.sp.uid))
    .map((x) => ({ uid: x.sp.uid, pos: x.pos, rune: runeAtCorner(state, x.sp, x.pos) }));
}

/** This card's matches have been looked at: it is no longer fresh. */
function settled(state, p, uid) {
  if (!state.fresh?.[p]) return;
  const i = state.fresh[p].indexOf(uid);
  if (i >= 0) state.fresh[p].splice(i, 1);
}

/**
 * Open a chain for this spell action, if one is not already running. The
 * rotation budget is NOT touched here: it is per TURN (turn.js beginTurn),
 * and one action can run several chains (a queued trigger that rotates
 * something runs after the chain that queued it has ended). Returns whether
 * this call opened it, so the same caller closes it.
 */
export function beginChain(state, p, cause) {
  if (state.chain) return false;
  state.chain = { p, cause, resolutions: 0, links: 0, active: null, noted: [] };
  return true;
}

export function endChain(state, p) {
  if (!state.chain) return;
  const L = state.players[p].ledger;
  bump(L, 'chainsResolved');
  high(L, 'longestChain', state.chain.resolutions);
  fx(state, 'chainEnd', { p, links: state.chain.links, resolutions: state.chain.resolutions });
  const summary = { p, links: state.chain.links, resolutions: state.chain.resolutions };
  state.chain = null;
  state.tableDirty[p] = false;
  if (state.fresh) state.fresh[p] = [];
  emit(state, 'chainEnd', summary);
}

/**
 * A rotation that RESOLVES: the face it brings up fires, and then the card's
 * matches chain, depth-first. Every rotation in the game goes through here
 * except the one printed "trigger no effects" (ops.setRot with `quiet`).
 */
export function* turnAndResolve(state, uid, { dir = 'left', forced = false, silent = false, cause = 'effect' } = {}) {
  if (!turn(state, uid, { dir, forced, silent })) return false;
  const sp = findSpell(state, uid);
  if (!sp || sp.cell === null) return false;
  const p = sp.owner;
  const own = beginChain(state, p, cause);
  refresh(state);
  yield* resolveSide(state, sp, activeIndex(sp), { chained: true });
  refresh(state);
  if (state.winner === null) yield* chainFrom(state, p, uid);
  if (own) endChain(state, p);
  return true;
}

/**
 * The pump's chain: everything that changed on this table since the last
 * chain (a trigger that turned a card, a card exposed by a destruction) gets
 * its matches looked at, in uid order. With nothing marked fresh -- the
 * adversarial harness stages a table and asks for a chain -- every card is.
 */
export function* runChain(state, p, cause) {
  const fresh = state.fresh?.[p]?.length ? [...state.fresh[p]] : spellsOn(state, p).map((s) => s.uid).sort((a, b) => a - b);
  const own = beginChain(state, p, cause);
  for (const uid of fresh) {
    if (state.winner !== null) break;
    yield* chainFrom(state, p, uid);
  }
  if (own) endChain(state, p);
}

