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
//     There are exactly 12 matchable vertices on a 3x3 (8 edge vertices
//     touching two cards, 4 interior touching four; the 4 outer corners touch
//     one card and can never match). `spent` is append-only and grows by one on
//     EVERY iteration -- including when the group is locked, when the cost is
//     declined, and when the gate is unmet and the face resolves inert. So a
//     chain is at most 12 links BY CONSTRUCTION, whatever the effects do.
//
//     Keyed by VERTEX, not by card, so a spell shifted mid-chain cannot
//     resurrect a spent junction.
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
  MATCH_SITES, VERTEX_CARDS, INTERIOR_SITES, CORNER_OF,
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
 * Which cards at this vertex are part of SOME matching group.
 *
 * A wildcard joins every group, so a wild corner between a SPIRAL and a SHARD
 * matches both. Two wilds and nothing else match each other.
 *
 * Returning the union over all groups rather than "the biggest group" is the
 * faithful reading: the rule says cards showing the same rune match, and at a
 * four-card interior vertex there can be two independent pairs. Since only one
 * card rotates and the player chooses which, the union is exactly the set of
 * legal choices.
 */
function matchedAt(state, p, vertex) {
  const here = [];
  for (const { cell, pos } of VERTEX_CARDS[vertex]) {
    const sp = topOf(state, p, cell);
    if (sp) here.push({ sp, pos, rune: runeAtCorner(state, sp, pos) });
  }
  if (here.length < 2) return [];

  const wilds = here.filter((x) => x.rune === WILD);
  const groups = new Map();
  for (const x of here) {
    if (x.rune === WILD) continue;
    if (!groups.has(x.rune)) groups.set(x.rune, []);
    groups.get(x.rune).push(x);
  }

  const inMatch = new Set();
  for (const rune of [...groups.keys()].sort()) {
    const g = [...groups.get(rune), ...wilds];
    if (g.length < 2) continue;
    for (const x of g) inMatch.add(x.sp.uid);
  }
  // Two or more wildcards and no ordinary rune: they match each other.
  if (!groups.size && wilds.length >= 2) for (const x of wilds) inMatch.add(x.sp.uid);

  return [...inMatch].sort((a, b) => a - b);
}

/**
 * Every unspent vertex with a live match, in a FIXED ORDER.
 *
 * MATCH_SITES order, which is table.js's frozen ascending vertex id. Two engines
 * in lockstep must agree on the order the player's "which match?" options are
 * presented in, because the answer is recorded as a value and replayed.
 */
export function findMatches(state, p, spent = []) {
  const out = [];
  for (const v of MATCH_SITES) {
    if (spent.includes(v)) continue;
    const uids = matchedAt(state, p, v);
    if (uids.length < 2) continue;
    const spells = uids.map((u) => findSpell(state, u));
    out.push({
      vertex: v,
      uids,
      interior: INTERIOR_SITES.includes(v),
      // "If every card in a matched group is under a prohibition, the vertex is
      // spent and nothing happens." EVERY, not any: you choose which card
      // turns, so one prohibited card among three just means you choose one of
      // the other two. A colour lock is NOT a prohibition and never lands here.
      locked: spells.every((s) => prohibited(state, s)),
    });
  }
  return out;
}

/** Does the acting player have a match waiting? Used by legalActions and the AI. */
export const hasMatch = (state, p) => findMatches(state, p, state.chain?.spent || []).length > 0;

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
  state.chain = { p, cause, spent: [], resolutions: 0, links: 0 };
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

    const hits = findMatches(state, p, state.chain.spent);
    if (!hits.length) break;

    // Order matters to the player, so the player picks when there is a choice.
    // A single match resolves without asking -- and note a zero-option request
    // would park the game forever, which the driver answers null; that is the
    // other half of this and it lives in driver.js.
    const vertex = hits.length === 1 ? hits[0].vertex : yield ask.pick(
      hits.map((h) => h.vertex),
      {
        prompt: 'Which match resonates?',
        labels: hits.map((h) => `junction ${h.vertex}${h.interior ? ' (interior)' : ''}: ${h.uids.join(', ')}`),
        show: hits.map((h) => ({ uids: [...h.uids], vertex: h.vertex })),
      },
    );
    const hit = hits.find((h) => h.vertex === vertex) || hits[0];

    // PROGRESS, UNCONDITIONALLY, BEFORE anything is mutated. Everything below
    // this line may fail, be declined, or do nothing, and the chain still
    // shrinks its own bound. This single line is the termination proof.
    state.chain.spent.push(hit.vertex);
    state.chain.links++;
    bump(state.players[p].ledger, 'chainLinks');

    if (hit.locked) {
      fx(state, 'matchLocked', { vertex: hit.vertex, uids: hit.uids });
      continue;
    }

    // Rule B. A card that has already come full circle this chain is not
    // offered, and if that leaves nobody the junction is spent regardless --
    // spending rather than skipping is what keeps the loop monotone.
    const eligible = hit.uids
      .map((u) => findSpell(state, u))
      .filter((s) => s && !prohibited(state, s) && s.turnsThisAction < REVOLUTION)
      .map((s) => s.uid);
    if (!eligible.length) {
      fx(state, 'matchExhausted', { vertex: hit.vertex, uids: hit.uids });
      continue;
    }

    const which = eligible.length === 1 ? eligible[0] : yield ask.one(eligible, {
      prompt: 'Which Spell turns?',
      labels: eligible.map((u) => {
        const s = findSpell(state, u);
        return `${defOf(state, s).name} (cell ${s.cell})`;
      }),
    });
    const sp = findSpell(state, which);
    if (!sp) continue;

    // Mandatory and unconditional. A COLOUR LOCK DOES NOT STOP THIS -- the lock
    // restrains the player, not the board. Only a printed prohibition does, and
    // that was filtered out above.
    turn(state, which, { dir: 'left', forced: true, silent: true });
    bump(state.players[p].ledger, 'forcedRotations');
    refresh(state);
    noteCards(state, hit.uids);
    fx(state, 'match', { vertex: hit.vertex, uids: hit.uids, chosen: which, p });
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
  emit(state, 'chainEnd', summary);
  return summary;
}
