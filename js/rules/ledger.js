// Per-player counters that persist for the whole duel.
//
// THE LINE: if it can be re-read off the board, it is DERIVED. If it counts
// history, it lives here.
//
// "A friendly golem on high ground" is derived -- look at the board. "Three or
// more of your spells have been destroyed this duel" cannot be: the spells are
// gone. Gold's whole job is converting the other schools' work into points, and
// work is a thing that happened, so gold reads this file.
//
// Every counter is declared HERE, in one object, and is:
//   - a non-negative integer
//   - MONOTONE: it only ever goes up
//   - written only from inside ops/field/score, never from a card
//
// tools/checkledger.js proves each counter is both written somewhere and read
// somewhere. A counter that nothing writes makes every gold face gated on it
// permanently unscoreable; a counter that nothing reads is dead weight that
// will drift. Both read as implemented, which is why the tool exists.

export function emptyLedger() {
  return {
    /* the spell table */
    spellsPlayed: 0,
    golemsPlayed: 0,
    artifactsPlayed: 0,
    rotations: 0,
    forcedRotations: 0,
    shifts: 0,
    spellsDestroyed: 0,       // yours, by any hand
    spellsSacrificed: 0,      // yours, to pay a cost
    enemySpellsDestroyed: 0,

    /* cards */
    cardsDrawn: 0,
    cardsDiscarded: 0,
    cardsFound: 0,
    reshuffles: 0,

    /* chains */
    chainsResolved: 0,
    chainLinks: 0,
    longestChain: 0,          // not monotone-by-addition, but never decreases
    keywordsCopied: 0,
    inertResolutions: 0,      // a face resolved with its gate unmet

    /* the battlefield */
    summons: 0,
    moves: 0,
    attacks: 0,
    damageDealt: 0,
    unitsPushed: 0,
    pushMm: 0,
    fallsCaused: 0,
    fallDamage: 0,
    terrainRemoved: 0,
    propsBroken: 0,           // terrain pieces you shattered
    firesLit: 0,              // pieces you set alight
    terrainPushMm: 0,         // how far you have shoved terrain, in total
    terrainImpacts: 0,        // units hit by a terrain piece you threw
    knockdowns: 0,            // enemy units you knocked flat
    unitsBurned: 0,           // units you set burning (the status, not the terrain)
    climbs: 0,
    highGroundEnds: 0,        // turns ended with a friendly unit on high ground

    /* kills and scoring */
    unitsLost: 0,             // YOUR units that died. Not kills you made.
    golemsKilled: 0,          // enemy golem units you killed
    magesKilled: 0,
    mageDeaths: 0,            // YOUR mage dying. The suicide-feeding instrument.
    golemCardsLost: 0,
    objectivesScored: 0,
    vpFromObjectives: 0,
    vpFromKills: 0,
  };
}

export const LEDGER_KEYS = Object.freeze(Object.keys(emptyLedger()));

/** Counters that may legitimately be set rather than incremented. */
export const HIGH_WATER = Object.freeze(['longestChain']);

/**
 * Counters that exist for the DESIGNER, not for the cards.
 *
 * A declared category rather than an exception. tools/checkledger.js insists
 * every counter be read by something, and the honest answer for these is that
 * nothing in the game reads them and nothing should: they are instruments.
 * `inertResolutions` says how often a chain forced somebody onto a face whose
 * gate was unmet, which is how you tell whether the gate rule is doing its job;
 * `vpFromObjectives` against `vpFromKills` is the suicide-feeding measurement
 * the whole mageVpDecay knob exists for.
 *
 * They are still CHECKED -- a diagnostic nothing reads is just overhead -- but
 * the reader has to be a tool, not a card.
 */
export const DIAGNOSTIC = Object.freeze([
  'reshuffles', 'cardsFound', 'inertResolutions', 'fallDamage',
  'golemCardsLost', 'objectivesScored', 'vpFromObjectives', 'vpFromKills',
  'unitsLost', 'mageDeaths', 'forcedRotations', 'artifactsPlayed', 'golemsPlayed',
  'spellsPlayed',
  // These were read by the Spellbook's find conditions until the Spellbook
  // became a sigil board (2026-10-20). Kept as instruments: selfplay reports
  // them, and a future gold gate may read any of them again.
  'shifts', 'enemySpellsDestroyed', 'cardsDiscarded', 'chainLinks', 'summons', 'moves',
  'attacks', 'unitsPushed', 'pushMm', 'fallsCaused', 'terrainPushMm', 'terrainImpacts',
  'knockdowns', 'unitsBurned', 'highGroundEnds', 'magesKilled',
]);

export const bump = (ledger, key, by = 1) => {
  if (!(key in ledger)) throw new Error(`no ledger counter '${key}' -- declare it in ledger.js`);
  ledger[key] += by;
};

export const high = (ledger, key, value) => {
  if (!HIGH_WATER.includes(key)) throw new Error(`'${key}' is not a high-water counter`);
  if (value > ledger[key]) ledger[key] = value;
};
