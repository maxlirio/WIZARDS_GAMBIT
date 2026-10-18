// The trigger bus.
//
// Two hard rules, both of them load-bearing:
//
// 1. The EVENT LIST IS CLOSED. A card that wants to listen for something not in
//    this list is a request to add it here, deliberately, once. The alternative
//    is cards inventing event names, and a listener keyed on a typo is a card
//    that reads as implemented and never fires.
//
// 2. A LISTENER MAY ONLY QUEUE, NEVER RESOLVE. `emit` is called from inside
//    ops, in the middle of a card moving, and from inside the chain, in the
//    middle of a face resolving. Running another effect there means reentering
//    the generator driver while it is parked, which cannot work, and it means a
//    trigger observing a half-finished board. So a listener appends a work item
//    and the pump runs it once the current work is complete.
//
// Payloads are PLAIN DATA -- uids, cells, numbers. A queue entry is cloned by
// the driver's snapshot on every question, so a payload holding a card object
// would be deep-copied and lose its identity against the live board.

import { allInPlay, defOf } from './ops.js';
import { activeIndex } from './orient.js';
import { gateMet } from './gates.js';

export const EVENTS = Object.freeze([
  'turnStart', 'turnEnd',
  'afterPlay', 'afterRotate', 'afterShift', 'afterDestroy',
  'afterDraw', 'afterDiscard', 'afterFound',
  'afterMatch', 'afterResolve', 'chainEnd',
  'afterMove', 'afterPush', 'afterFall', 'afterDamage', 'afterKill', 'afterSummon',
  'afterScore',
]);

const EVENT_SET = new Set(EVENTS);

/** Faces that are listening for `event` right now, in a fixed order. */
function listeners(state, event) {
  const out = [];
  for (const sp of allInPlay(state)) {
    const def = defOf(state, sp);
    const face = def.faces[activeIndex(sp)];
    if (!face) continue;
    if (!face.on || !face.on[event]) continue;
    // A gate restricts voluntary use AND silences a trigger: an unmet gate
    // means the face is inert, and a trigger that fired from an inert face
    // would be the one way an unmet gate still did something.
    if (face.gate && !gateMet(state, sp, face.gate)) continue;
    out.push({ uid: sp.uid, p: sp.owner, index: activeIndex(sp) });
  }
  return out;
}

/**
 * Announce something that happened. Returns the number of listeners queued.
 *
 * Fires during a replay as well: the queue is part of the state, so the items
 * it appends have to be appended identically every time the effect is replayed
 * from its snapshot, or the two runs diverge. Only the VIEW notes are
 * suppressed during a replay, never the game's own bookkeeping.
 */
export function emit(state, event, payload = {}) {
  if (!EVENT_SET.has(event)) throw new Error(`unknown event '${event}'`);
  if (!state.queue) return 0;
  let n = 0;
  for (const l of listeners(state, event)) {
    state.queue.push({
      kind: 'trigger', uid: l.uid, p: l.p, index: l.index,
      event, payload, seq: ++state.actionSeq,
    });
    n++;
  }
  return n;
}

/**
 * Run an event through every REPLACEMENT handler and return the final payload,
 * or null if one of them cancelled it.
 *
 * Replacements are plain functions, not generators -- they CANNOT ask a
 * question. That is a real restriction and it is chosen: a replacement runs
 * inside `destroy` or inside a damage resolution, where the board is
 * mid-mutation and the driver may already be parked on something else. A card
 * that needs to ask before replacing has to be written as a listener instead.
 *
 * Handlers are applied in a fixed order (player 0's table ascending by cell,
 * then player 1's) so two engines in lockstep compose them identically.
 */
export function replaceEvent(state, event, payload) {
  if (!EVENT_SET.has(event)) throw new Error(`unknown event '${event}'`);
  let cur = payload;
  for (const sp of allInPlay(state)) {
    if (cur === null) break;
    const def = defOf(state, sp);
    const face = def.faces[activeIndex(sp)];
    const fn = face?.replace?.[event];
    if (!fn) continue;
    if (face.gate && !gateMet(state, sp, face.gate)) continue;
    try {
      cur = fn({ state, spell: sp, def, face, p: sp.owner }, cur);
    } catch (e) {
      (state.triggerErrors ||= []).push({ event, uid: sp.uid, error: String(e && e.message || e) });
    }
  }
  return cur;
}
