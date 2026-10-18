// The only file in the project allowed to persist anything.
//
// One file, so a harness can fake it, so a replay cannot depend on it, and so
// `tools/checksource.js` can enforce the rule with a one-line grep. Nothing in
// js/rules or js/field may reach `localStorage`, and that is checked rather
// than agreed.
//
// What persists is the SPELLBOOK: which find conditions you have discovered,
// and which card each one teaches. It is knowledge, not inventory -- your
// starting deck is the same ten cards in your first match and your thousandth.
// So this file can be deleted, corrupted or absent and the game still plays
// identically; you just stop knowing where the spells come from.

const KEY = 'wizards-gambit:profile:v1';

/**
 * In-memory fallback.
 *
 * Browser storage comes back empty in a private window, throws with site data
 * blocked, and does not exist at all in node -- where every harness runs. So
 * the store is always this object, and localStorage is only ever a mirror of
 * it. Reading through a try/catch that falls back to memory is the difference
 * between a Spellbook that is sometimes forgotten and a game that sometimes
 * will not start.
 */
let memory = { learned: {}, matches: 0, wins: 0 };

const host = () => {
  try { return typeof localStorage === 'undefined' ? null : localStorage; }
  catch { return null; }
};

export function load() {
  const h = host();
  if (h) {
    try {
      const raw = h.getItem(KEY);
      if (raw) memory = { learned: {}, matches: 0, wins: 0, ...JSON.parse(raw) };
    } catch { /* corrupt or blocked: memory keeps whatever it had */ }
  }
  return memory;
}

export function save() {
  const h = host();
  if (!h) return false;
  try { h.setItem(KEY, JSON.stringify(memory)); return true; }
  catch { return false; }
}

/** Learn that `cond` finds `cardId`. Idempotent. */
export function learn(cond, cardId) {
  const p = load();
  if (p.learned[cond] === cardId) return false;
  p.learned[cond] = cardId;
  save();
  return true;
}

/**
 * Read a finished match's finds into the Spellbook.
 *
 * Takes the state rather than being called from inside it: the engine must not
 * know this file exists, or a replay could depend on what the player happens to
 * have learned, and two machines in a lockstep game would diverge on a
 * difference in their save files.
 */
export function recordMatch(state, p) {
  const prof = load();
  prof.matches++;
  if (state.winner === p) prof.wins++;
  let learned = 0;
  for (const f of state.fx || []) {
    if (f.kind === 'found' && f.p === p && f.why) {
      if (prof.learned[f.why] !== f.defId) { prof.learned[f.why] = f.defId; learned++; }
    }
  }
  save();
  return learned;
}

export function reset() {
  memory = { learned: {}, matches: 0, wins: 0 };
  const h = host();
  try { h?.removeItem(KEY); } catch { /* nothing to do */ }
  return memory;
}

export const known = () => Object.keys(load().learned).sort();

/**
 * A one-time UI note -- "has this browser seen the rules yet?". Returns whether
 * it had, and records that it now has. Kept here so localStorage stays in one
 * file; it is not part of the Spellbook and a reset leaves it alone.
 */
export function seen(what) {
  const h = host();
  const key = `wizards-gambit:seen:${what}`;
  try {
    if (h?.getItem(key)) return true;
    h?.setItem(key, '1');
  } catch { /* blocked: behave as if never seen, which only re-shows a note */ }
  return false;
}

/**
 * A browser setting that is not part of the Spellbook: the graphics quality.
 * Here for the same reason `seen` is -- one file touches localStorage.
 */
export function setting(what, value) {
  const h = host();
  const key = `wizards-gambit:setting:${what}`;
  try {
    if (value !== undefined) { h?.setItem(key, String(value)); return value; }
    return h?.getItem(key) ?? null;
  } catch { return value === undefined ? null : value; }
}
