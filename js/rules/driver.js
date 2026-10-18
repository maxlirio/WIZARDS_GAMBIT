// Running effects that have to stop and ask.
//
// Copied near-verbatim from GUDNAK's js/rules/driver.js, including its comments,
// because every one of them records a bug that shipped. The only changes are
// the NOT_CLONED list and the request vocabulary's `labels`.
//
// "Destroy a friendly Spell." "Choose which match to resolve." "Choose which of
// the matched cards turns." "You may discard a card; if you do..." An effect
// cannot be a single function call.
//
// Effects are GENERATORS. They yield a request; the driver answers it from a
// recorded list or parks the game on `state.pending`. Because a paused
// generator cannot be serialised -- and this one has to survive a reload and a
// lockstep peer -- a pending effect stores a snapshot of the state from BEFORE
// it started plus the answers so far, and each new answer RE-RUNS the whole
// effect from that snapshot, feeding the recorded answers back in.
//
// Effects must therefore be deterministic given their answers. They are,
// because every random choice goes through the seeded rng that lives on the
// state, which is exactly why rng.js keeps its words as plain data.

/**
 * What a snapshot must NOT capture, and a restore must NOT roll back.
 *
 * `defs` is the rulebook: shared, frozen, and identity-compared, so cloning it
 * would both cost a fortune and break `def === state.defs[id]`.
 *
 * `derived` holds live Sets and Maps rebuilt from the board on every mutation.
 * Cloning it is waste, and restoring a stale copy is worse.
 *
 * `arena` is a pure function of the seed -- 475 integers of heightfield that
 * cannot change. It is rebuilt rather than carried.
 *
 * `fx` is here for a different and sharper reason: it is the list of notes for
 * the VIEW, not part of the game, and rolling it back RESURRECTS moments that
 * have already been shown. A pending effect re-runs from its snapshot on every
 * answer; `state.replaying` stops a replay from WRITING a note, and keeping
 * `fx` out of the snapshot stops a restore from bringing an old one back. Both
 * halves are needed and the second one is the one everybody forgets.
 */
const NOT_CLONED = ['defs', 'derived', 'arena', 'fx', 'fxCards', 'derivedTouched'];

function snapshot(state) {
  const rest = {};
  for (const k of Object.keys(state)) if (!NOT_CLONED.includes(k)) rest[k] = state[k];
  return structuredClone(rest);
}

function restore(state, snap, refresh) {
  const keep = {};
  for (const k of NOT_CLONED) keep[k] = state[k];
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, structuredClone(snap));
  for (const k of NOT_CLONED) if (keep[k] !== undefined) state[k] = keep[k];
  refresh?.(state);
}

/**
 * Run an effect to completion, or park it awaiting an answer.
 *
 * `descriptor` is a small serialisable thing that says which effect this is, so
 * it can be found again on resume: {kind, uid, index, ...}.
 */
export function runEffect(state, descriptor, makeGenerator, answers = []) {
  const snap = snapshot(state);
  return drive(state, descriptor, makeGenerator, answers, snap);
}

function drive(state, descriptor, makeGenerator, answers, snap) {
  const gen = makeGenerator();
  let i = 0;
  let sent;

  for (;;) {
    // A pending effect RE-RUNS from its snapshot every time it is answered,
    // feeding the recorded answers back in. Everything that happens during that
    // replay has happened before, so the notes it leaves for the view must not
    // be left again.
    state.replaying = i < answers.length;
    const stepped = gen.next(sent);
    state.replaying = false;
    if (stepped.done) {
      delete state.pending;
      return { done: true, value: stepped.value };
    }
    const request = stepped.value;

    if (i < answers.length) {
      sent = answers[i++];
      continue;
    }

    // Nothing left to feed: park and wait for a real answer.
    //
    // A request with NO options is answered null immediately, whether or not it
    // is "required" -- there is nothing to choose, and parking on it means the
    // effect re-runs from its snapshot and asks the same impossible question
    // forever.
    if (request.options && request.options.length === 0) {
      sent = null;
      i++;
      answers.push(null);
      continue;
    }

    state.pending = { descriptor, answers: [...answers], request, snapshot: snap };
    return { done: false, pending: request };
  }
}

/** Answer the outstanding request and carry on. */
export function answerPending(state, answer, resolveDescriptor, refresh) {
  const p = state.pending;
  if (!p) throw new Error('nothing is waiting for an answer');

  const answers = [...p.answers, answer];
  const snap = p.snapshot;
  restore(state, snap, refresh);

  const made = resolveDescriptor(state, p.descriptor);
  if (!made) { delete state.pending; return { done: true }; }
  return drive(state, p.descriptor, made, answers, snap);
}

/* ------------------------------------------------------------ requests */
//
// The vocabulary an effect can ask in. Each is a plain object so it can cross
// the wire and be rendered by one piece of UI. Five shapes cover the whole game,
// which is the reason the view layer can be deferred this long without risk.

export const ask = {
  /** Pick one of `options` (uids, cells, direction indices). */
  one: (options, { prompt = '', kind = 'target', required = true, allowNone = false, labels = null } = {}) =>
    ({ type: 'one', kind, options, prompt, labels, required: required && !allowNone, allowNone }),

  /**
   * Pick `count` of `options` -- but never more of them than exist.
   *
   * "Destroy 2 friendly Spells" with one spell on the table asked for a pair
   * that could not be assembled, and an exact request with no satisfying answer
   * PARKS THE GAME: the table offers one card, the player cannot make two of
   * it, and there is nothing else to click. Clamped HERE rather than at each
   * call site, because every harness clamps on the ANSWERING side and so always
   * answers the impossible question possibly.
   */
  some: (options, count, { prompt = '', exact = true, kind = 'target', labels = null } = {}) =>
    ({
      type: 'some', kind, options, count: Math.min(count, options.length),
      exact, prompt, labels, required: exact,
    }),

  /** A named choice from a fixed list -- a direction, a keyword, a formula. */
  /**
   * `show` is for the VIEW only: per option, what it refers to -- a point on
   * the field ({x, y, z}) or a set of cards ({uids}) -- so a choice of "where"
   * can be drawn where it is instead of read off a coordinate in a label.
   */
  pick: (options, { prompt = '', labels = null, show = null } = {}) =>
    ({ type: 'pick', kind: 'option', options, prompt, labels, show, required: true }),

  /** Yes or no -- "you may". */
  confirm: (prompt = '') => ({ type: 'confirm', kind: 'confirm', prompt, required: false }),

  /** Which player must answer, when it is not the active one. */
  by: (player, request) => ({ ...request, player }),
};
