// Continuous effects. NOTHING here is ever stored on a card.
//
// The rule, and it is the single most important one in the engine: a passive is
// recomputed from the board on every mutation, into a DECLARED set of buckets.
// Writing a copied [Poison] or a granted +1 onto the card itself is the classic
// bug that never wears off -- the aura leaves, the card keeps the bonus, and
// nothing in the game can tell you why.
//
// Only the ACTIVE face's passive is live. That is the derive layer's whole
// identity in this game: a card has four passives and three of them are facing
// sideways. A derive pass that read all four would make every card four times
// as strong and every rotation meaningless.
//
// Each face DECLARES which buckets it writes (`grants: ['noTurn']`). In strict
// mode the buckets are handed over behind a proxy that records what was touched
// and refuses anything undeclared, so "this face writes a bucket it never
// mentions" and "this face declares a bucket it never writes" are both
// detectable -- the second being how a passive ships inert while reading as
// implemented.

import { allInPlay, defOf } from './ops.js';
import { activeIndex } from './orient.js';
import { gateMet } from './gates.js';

/**
 * Every derived bucket, declared in one place.
 *
 * checkderived.js reads these keys and proves each is both WRITTEN by some card
 * and READ by some rule. A bucket nothing writes makes every card that depends
 * on it inert; a bucket nothing reads is a passive that computes an answer
 * nobody asks for. Both read as implemented from the outside.
 *
 * Three buckets were deleted on the harness's first run -- vpBonus, extraDraw
 * and unitKeywords -- because nothing read them and no card wrote them. They
 * were declared speculatively, for cards that might want them later, and that
 * is exactly the dead weight this list is checked for: a bucket waiting for its
 * card drifts out of step with the engine around it, and the card that finally
 * arrives has to debug it. The hook goes in WITH the card that needs it.
 */
export function emptyDerived() {
  return {
    /* the spell table */
    noTurn: new Set(),            // may not be rotated at all, even by a match
    freeTurn: new Set(),          // may be rotated voluntarily off its colour
    noTarget: new Set(),          // may not be chosen by an opponent's effect
    runeOverride: new Map(),      // uid -> [4 runes], replacing the printed ones
    wildCorners: new Set(),       // every corner of this card matches anything
    grantedKeywords: new Map(),   // uid -> [keyword]
    lostKeywords: new Map(),      // uid -> [keyword]

    /* the player */
    rangeBonus: [0, 0],           // mm added to every range check
    damageBonus: [0, 0],
    mageLife: [0, 0],             // extra life for the player's mage

    /* the battlefield */
    unitMoveBonus: new Map(),     // unitId -> mm
    shield: new Map(),            // unitId -> damage reduction
  };
}

export const DERIVED_KEYS = Object.freeze(Object.keys(emptyDerived()));

/**
 * Recompute everything. Called after every mutation, which is affordable
 * because there are at most eighteen in-play cards and one pass over them.
 */
/**
 * Recompute only if something has changed since the last pass.
 *
 * `ops.markDirty` sets the flag; every reader of a bucket calls this first. The
 * alternative -- calling refresh from inside ops after each mutation -- means a
 * chain that rotates, copies a keyword and destroys a card runs three full
 * derive passes per link for no benefit, and it puts a derive pass in the middle
 * of `destroy`, where the board is half-mutated.
 *
 * The reentrancy guard is not optional: a passive is free to ask what keywords
 * a card has, `keywordsOf` asks for a fresh derive, and without the guard that
 * is a derive pass starting inside a derive pass, forever.
 */
export function ensureFresh(state) {
  if (state._deriving) return state.derived;
  if (state.derived && !state.derivedStale) return state.derived;
  return refresh(state);
}

export function refresh(state) {
  state._deriving = true;
  state.derivedStale = false;
  const d = emptyDerived();
  state.derived = d;
  state.derivationErrors = state.derivationErrors || [];

  for (const sp of allInPlay(state)) {
    const def = defOf(state, sp);
    const face = def.faces[activeIndex(sp)];
    if (!face || !face.passive) continue;
    // A gate restrains voluntary use, and it silences a passive too: an unmet
    // gate means the face is inert, and a passive that kept working would be
    // the one way an unmet gate still did something.
    if (face.gate && !gateMet(state, sp, face.gate)) continue;
    const view = state.strict ? watched(d, state, sp, face) : d;
    try {
      face.passive({ state, spell: sp, def, face, p: sp.owner, d: view });
    } catch (e) {
      state.derivationErrors.push({ uid: sp.uid, def: def.id, numeral: face.numeral, error: String(e && e.message || e) });
    }
  }
  // Second pass, so a passive can read the first pass's keyword grants without
  // the answer depending on which cell it happens to sit in. One extra pass, not
  // a fixpoint loop: an aura that feeds another aura that feeds the first has no
  // defined answer, and pretending otherwise with "iterate until stable" is how
  // a hang gets shipped.
  for (const sp of allInPlay(state)) {
    const def = defOf(state, sp);
    const face = def.faces[activeIndex(sp)];
    if (!face || !face.passive2) continue;
    if (face.gate && !gateMet(state, sp, face.gate)) continue;
    // The WATCHED view here too. Running the second pass against the raw
    // buckets meant every passive2 write went unrecorded, and
    // tools/checkderived.js reported Link's grantedKeywords as never written
    // while it was in fact working perfectly.
    const view = state.strict ? watched(d, state, sp, face) : d;
    try { face.passive2({ state, spell: sp, def, face, p: sp.owner, d: view }); }
    catch (e) {
      state.derivationErrors.push({ uid: sp.uid, def: def.id, numeral: face.numeral, error: String(e && e.message || e) });
    }
  }
  state._deriving = false;
  return d;
}

/**
 * Hand a face a view of the buckets that records what it touched and refuses
 * anything it did not declare. Strict mode only -- the proxy is cheap but
 * refresh runs after every mutation, and a harness-only check should not be in
 * the hot path of a real game.
 */
function watched(d, state, spell, face) {
  const declared = new Set(face.grants || []);
  const touched = (state.derivedTouched ||= {});
  return new Proxy(d, {
    get(t, k) {
      if (typeof k !== 'string') return t[k];
      if (!(k in t)) throw new Error(`no derived bucket '${k}' -- declare it in derive.js`);
      if (!declared.has(k)) throw new Error(`face writes undeclared bucket '${k}' (declare it in \`grants\`)`);
      (touched[`${spell.def}:${face.numeral}`] ||= new Set()).add(k);
      return t[k];
    },
  });
}

/* --------------------------------------------------- reading the buckets */

export const bonusRange = (state, p) => state.derived.rangeBonus[p] || 0;
export const bonusDamage = (state, p) => state.derived.damageBonus[p] || 0;
export const bonusMageLife = (state, p) => state.derived.mageLife[p] || 0;
export const grantedOn = (state, uid) => state.derived.grantedKeywords.get(uid) || [];
export const lostOn = (state, uid) => state.derived.lostKeywords.get(uid) || [];
export const unitMove = (state, u) => u.move + (state.derived.unitMoveBonus.get(u.id) || 0);
export const shieldOn = (state, u) => state.derived.shield.get(u.id) || 0;
export const untargetable = (state, uid) => state.derived.noTarget.has(uid);
