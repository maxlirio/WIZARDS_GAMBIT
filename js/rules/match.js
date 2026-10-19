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
// rotations indefinitely. So termination is PROVED, from two rules that are
// both real rules a player can be taught, not from a loop guard.
//
//   RULE A -- each junction resonates at most once per chain.
//
//     A junction is a SITE: two orthogonally adjacent cells and one of the two
//     corners that touch across their shared edge. There are exactly 24 on a
//     3x3 (table.js). `spent` is append-only and grows by one on EVERY
//     iteration -- including when the pair is locked, when the cost is
//     declined, and when the gate is unmet and the face resolves inert. So a
//     chain is at most 24 links BY CONSTRUCTION, whatever the effects do.
//
//     Keyed by SITE, not by card, so a spell shifted mid-chain cannot
//     resurrect a spent junction.
//
//   THE TRIGGER -- only a card that just changed sets off a match.
//
//     The card the action played, rotated or shifted is FRESH, and so is every
//     card the chain turns. A site fires only if one of its cards is fresh, and
//     it is the OTHER card -- the matched neighbour -- that turns. Without this,
//     two cards that matched three turns ago fire again on every action.
//
//   RULE B -- no spell is rotated more than four times per spell ACTION.
//
//     Four left turns return a card to where it started, so a fifth brings up a
//     face that has already been up. This bounds ROTATIONS, which Rule A alone
//     does not, since a rotation does not have to come from a match: at most
//     9 x 4 = 36 an action. Scoped to the action rather than the chain because
//     one action can start several chains -- a queued trigger that rotates
//     something runs after the chain that queued it has ended. It counts
//     rotation EVENTS, not quarter-turns; see ops.js.
//
// What makes this a proof rather than a hope is that progress depends on NO
// player choice, NO cost being payable and NO effect succeeding. `state.guard`
// below is an ASSERTION. If it ever fires, something above is wrong; it must
// never be the thing that decides a game.

import { ask } from './driver.js';
import {
  MATCH_SITES, SITE, VERTEX_CARDS, INTERIOR_SITES, CORNER_OF,
} from './table.js';
import { indexAt, activeIndex } from './orient.js';
import { WILD } from './runes.js';
import { topOf, spellsOn, defOf, findSpell, turn, prohibited, fx, noteCards, REVOLUTION } from './ops.js';
import { refresh, ensureFresh } from './derive.js';
import { offerCopy } from './keywords.js';
import { resolveSide } from './resolve.js';
import { bump, high } from './ledger.js';
import { emit } from './triggers.js';

/** A chain may not exceed this many links. An ASSERTION, never a rule. */
export const CHAIN_ASSERT = 64;

export { REVOLUTION };

/**
 * THE state-aware rune accessor. Nothing outside this file reads `def.runes`.
 *
 * Printed Resonis Orb -- "the corners of this Artifact count as any corner" --
 * is invisible to any matcher that goes straight to the data, and the failure
 * is silent: the card sits there looking implemented and simply never matches.
 * orient.js says so in its header and verify-faces.js plants exactly this fault.
 */
export function runeAtCorner(state, spell, pos) {
  const d = ensureFresh(state);
  if (d.wildCorners.has(spell.uid)) return WILD;
  const runes = d.runeOverride.get(spell.uid) || defOf(state, spell).runes;
  return runes[indexAt(spell.rot, pos)];
}

/**
 * Do two touching corners match? A wildcard matches anything, including
 * another wildcard.
 */
const runesMatch = (a, b) => a === WILD || b === WILD || a === b;

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
 * Returned in site order, never sorted by anything the state could vary.
 */
export function findMatches(state, p, spent = [], fresh = null) {
  const out = [];
  for (const id of MATCH_SITES) {
    if (spent.includes(id)) continue;
    const site = SITE[id];
    const a = topOf(state, p, site.cells[0]);
    const b = topOf(state, p, site.cells[1]);
    if (!a || !b) continue;
    if (fresh && !fresh.includes(a.uid) && !fresh.includes(b.uid)) continue;
    const ra = runeAtCorner(state, a, site.pos[0]);
    const rb = runeAtCorner(state, b, site.pos[1]);
    if (!runesMatch(ra, rb)) continue;
    out.push({
      site: id,
      vertex: site.vertex,
      uids: [a.uid, b.uid],
      cells: [a.cell, b.cell],
      interior: INTERIOR_SITES.includes(id),
      // The card that did NOT just change is the one the match turns. If both
      // changed (an effect turned the neighbour of the card you played), or
      // nothing is marked fresh, the player chooses.
      turners: fresh ? [a, b].filter((s) => !fresh.includes(s.uid)).map((s) => s.uid) : [],
      locked: [a, b].every((s) => prohibited(state, s)),
    });
  }
  return out;
}

/** Does the acting player have a match waiting? Used by legalActions and the AI. */
export const hasMatch = (state, p) =>
  findMatches(state, p, state.chain?.spent || [], state.chain?.fresh ?? freshOf(state, p)).length > 0;

/** What has changed on this table since the last chain -- the match trigger set. */
const freshOf = (state, p) => (state.fresh?.[p]?.length ? state.fresh[p] : null);

/**
 * Run the chain to exhaustion.
 *
 * A generator, because it asks questions, so it is parked on `state.pending`
 * and REPLAYED FROM A SNAPSHOT on every answer like any other effect. All of
 * its bookkeeping is therefore plain serialisable data on `state.chain`; a
 * closure variable here would not roll back with the snapshot and the replay
 * would diverge from the original run.
 */
export function* runChain(state, p, cause) {
  // `fresh` starts as whatever the action changed and grows with every card
  // the chain turns. Only sites touching a fresh card can fire.
  state.chain = { p, cause, spent: [], resolutions: 0, links: 0, fresh: [...(state.fresh?.[p] || [])].sort((a, b) => a - b) };
  // Rule B's counter is NOT cleared here. It is per spell ACTION, and one
  // action can produce several chains -- a trigger queued by the first chain
  // rotates something, which starts a second. Clearing it per chain would hand
  // the ping-pong a fresh budget on every lap, which is exactly the loop the
  // rule exists to close.

  for (let guard = 0; ; ) {
    if (++guard > CHAIN_ASSERT) {
      // Unreachable if Rule A holds. Recorded rather than thrown so the harness
      // reports WHICH game did it instead of dying inside it.
      state.chainOverflow = true;
      fx(state, 'chainOverflow', { p, spent: [...state.chain.spent] });
      break;
    }
    if (state.winner !== null) break;

    const hits = findMatches(state, p, state.chain.spent, state.chain.fresh.length ? state.chain.fresh : null);
    if (!hits.length) break;

    // Order matters to the player, so the player picks when there is a choice.
    // A single match resolves without asking -- and note a zero-option request
    // would park the game forever, which the driver answers null; that is the
    // other half of this and it lives in driver.js.
    const siteId = hits.length === 1 ? hits[0].site : yield ask.pick(
      hits.map((h) => h.site),
      {
        prompt: 'Which match resonates first?',
        labels: hits.map((h) => h.uids.map((u) => defOf(state, findSpell(state, u)).name).join(' + ')),
        show: hits.map((h) => ({ uids: [...h.uids], vertex: h.vertex, site: h.site })),
      },
    );
    const hit = hits.find((h) => h.site === siteId) || hits[0];

    // PROGRESS, UNCONDITIONALLY, BEFORE anything is mutated. Everything below
    // this line may fail, be declined, or do nothing, and the chain still
    // shrinks its own bound. This single line is the termination proof.
    state.chain.spent.push(hit.site);
    state.chain.links++;
    bump(state.players[p].ledger, 'chainLinks');

    if (hit.locked) {
      fx(state, 'matchLocked', { vertex: hit.vertex, site: hit.site, uids: hit.uids });
      continue;
    }

    // The matched NEIGHBOUR turns: the card that just changed is the trigger,
    // the other card of the pair is what it sets off. Only when both cards
    // changed (or nothing is marked fresh) is there a choice to make.
    //
    // Rule B. A card that has already come full circle this action is not
    // offered, and if that leaves nobody the site is spent regardless --
    // spending rather than skipping is what keeps the loop monotone.
    const eligible = (hit.turners.length ? hit.turners : hit.uids)
      .map((u) => findSpell(state, u))
      .filter((s) => s && !prohibited(state, s) && s.turnsThisAction < REVOLUTION)
      .map((s) => s.uid);
    if (!eligible.length) {
      fx(state, 'matchExhausted', { vertex: hit.vertex, site: hit.site, uids: hit.uids });
      continue;
    }

    // The question names the junction: which cards meet there, at which of
    // their corners, showing which rune. Without it a player who just played
    // a card is asked about two OTHER cards and cannot see why -- a diagonal
    // pair meets at a single point, and the point is easy to miss.
    const corners = VERTEX_CARDS[hit.vertex]
      .map(({ cell, pos }) => ({ sp: topOf(state, p, cell), pos }))
      .filter((x) => x.sp && hit.uids.includes(x.sp.uid))
      .map((x) => ({ uid: x.sp.uid, pos: x.pos, rune: runeAtCorner(state, x.sp, x.pos) }));
    const which = eligible.length === 1 ? eligible[0] : yield ask.one(eligible, {
      prompt: 'Which Spell turns?',
      labels: eligible.map((u) => {
        const s = findSpell(state, u);
        return `${defOf(state, s).name} (cell ${s.cell})`;
      }),
      match: { vertex: hit.vertex, corners },
    });
    const sp = findSpell(state, which);
    if (!sp) continue;

    // Mandatory and unconditional. A COLOUR LOCK DOES NOT STOP THIS -- the lock
    // restrains the player, not the board. Only a printed prohibition does, and
    // that was filtered out above.
    turn(state, which, { dir: 'left', forced: true, silent: true });
    if (!state.chain.fresh.includes(which)) { state.chain.fresh.push(which); state.chain.fresh.sort((a, b) => a - b); }
    bump(state.players[p].ledger, 'forcedRotations');
    refresh(state);
    noteCards(state, hit.uids);
    fx(state, 'match', { vertex: hit.vertex, site: hit.site, uids: hit.uids, chosen: which, p });
    emit(state, 'afterMatch', { vertex: hit.vertex, uids: hit.uids, chosen: which, p });

    // The keyword copy comes BEFORE the effect, because the point of the
    // mechanic is that putting [Ignore Height] on a push changes the push you
    // are about to make. Offered after, it could only ever matter next turn.
    yield* offerCopy(state, hit.uids);
    refresh(state);

    state.chain.resolutions++;
    yield* resolveSide(state, sp, activeIndex(sp), { chained: true });
    refresh(state);
  }

  const L = state.players[p].ledger;
  bump(L, 'chainsResolved');
  high(L, 'longestChain', state.chain.resolutions);
  fx(state, 'chainEnd', { p, links: state.chain.links, resolutions: state.chain.resolutions });
  const summary = { p, links: state.chain.links, resolutions: state.chain.resolutions };
  state.chain = null;
  state.tableDirty[p] = false;
  if (state.fresh) state.fresh[p] = [];
  emit(state, 'chainEnd', summary);
  return summary;
}
