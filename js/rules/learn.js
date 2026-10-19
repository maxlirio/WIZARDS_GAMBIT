// THE SPELLBOOK -- the system that took mana's place.
//
// The Spellbook is a record of THE WAYS TO GET CARDS. It is your accumulating
// knowledge of the game, not an inventory and not a deck list. You always start
// a match with the same ten-card deck; what a long Spellbook buys you is knowing
// which conditions find which spells, and being able to aim a turn at one.
//
// So a FIND is a condition, and the card is what the condition teaches you.
// Doing the thing puts the card in your DISCARD for the rest of that match --
// not your hand, so you have to earn the draw as well.
//
// Every condition is a pure predicate over the ledger and the board, checked
// once per action at rest. No new machinery: that was the design test for the
// trigger bus and the ledger, and if the Spellbook had needed its own event
// system it would have meant the closed event list from the start was wrong.
// It did not.

import { spellsOn, defOf } from './ops.js';
import { livingUnits, unitsOf, onHighGround, rangeOrigins, mageOf } from '../field/query.js';
import { keywordsOf } from './keywords.js';
import { CELLS } from './table.js';
import { within } from '../field/fixed.js';

const L = (state, p) => state.players[p].ledger;

/**
 * The closed registry of find conditions.
 *
 * `text` is what the Spellbook page says, so it is written in the second person
 * and in the language of the table rather than of the code. A player reading
 * their Spellbook is reading these strings.
 */
export const FINDS = Object.freeze({
  /* ---------------------------------------------------------------- red */
  burnBright:   { text: 'Deal 5 damage in one duel.', test: (s, p) => L(s, p).damageDealt >= 14 },
  wideBurn:     { text: 'Deal 25 damage and strike eight times.', test: (s, p) => L(s, p).damageDealt >= 25 && L(s, p).attacks >= 8 },
  breakTwo:     { text: 'Destroy two enemy Spells in one duel.', test: (s, p) => L(s, p).enemySpellsDestroyed >= 4 },
  payInBlood:   { text: 'Let your own mage be wounded to half its hit points.', test: (s, p) => { const m = mageOf(s, p); return !!m && !m.dead && m.hp * 2 <= m.maxHp; } },
  slamHome:     { text: 'Push units a total of 30m.', test: (s, p) => L(s, p).pushMm >= 30000 },
  poisonTwo:    { text: 'Have two units poisoned at once.', test: (s, p) => livingUnits(s).filter((u) => u.owner !== p && u.poison >= 2).length >= 2 },

  /* ---------------------------------------------------------------- blue */
  liftThree:    { text: 'Move terrain six times in one duel.', test: (s, p) => L(s, p).terrainRemoved >= 6 },
  dragThem:     { text: 'Cause two enemy units to fall.', test: (s, p) => L(s, p).fallsCaused >= 2 },
  moveEarth:    { text: 'Push terrain and then push a unit into it.', test: (s, p) => L(s, p).terrainRemoved >= 2 && L(s, p).unitsPushed >= 8 },
  runFar:       { text: 'Move your units a total of 70 times.', test: (s, p) => L(s, p).moves >= 70 },
  holdHeight:   { text: 'End twelve turns holding the high ground.', test: (s, p) => L(s, p).highGroundEnds >= 12 },
  leverage:     { text: 'Shift Spells eighteen times in one duel.', test: (s, p) => L(s, p).shifts >= 18 },

  /* ---------------------------------------------------------------- green */
  turnFive:     { text: 'Rotate Spells fifty times in one duel.', test: (s, p) => L(s, p).rotations >= 50 },
  drainTwo:     { text: 'Sacrifice six Spells and discard four cards.', test: (s, p) => L(s, p).spellsSacrificed >= 6 && L(s, p).cardsDiscarded >= 4 },
  rewindOnce:   { text: 'Resolve a chain of six links.', test: (s, p) => L(s, p).longestChain >= 6 },
  offColour:    { text: 'Hold a Spell on a cell that is not its colour.', test: (s, p) => spellsOn(s, p).filter((sp) => sp.playedTo !== null && sp.playedTo !== sp.cell).length >= 2 },
  tableFull:    { text: 'Control seven Spells at once.', test: (s, p) => spellsOn(s, p).length >= 7 },
  banedThem:    { text: 'Destroy two enemy Spells.', test: (s, p) => L(s, p).enemySpellsDestroyed >= 2 },

  /* ---------------------------------------------------------------- purple */
  spliceTwice:  { text: 'Copy five Keywords in one duel.', test: (s, p) => L(s, p).keywordsCopied >= 5 },
  linked:       { text: 'Control a Spell carrying three Keywords.', test: (s, p) => spellsOn(s, p).some((sp) => keywordsOf(s, sp).length >= 4) },
  copyThree:    { text: 'Copy twelve Keywords in one duel.', test: (s, p) => L(s, p).keywordsCopied >= 12 },
  prismatic:    { text: 'Control Spells of four different schools at once.', test: (s, p) => new Set(spellsOn(s, p).map((sp) => defOf(s, sp).school)).size >= 5 },
  threeKeywords:{ text: 'Resolve a chain of four links.', test: (s, p) => L(s, p).longestChain >= 4 },

  /* ---------------------------------------------------------------- gold */
  climbHigh:    { text: 'Climb twenty-five times in one duel.', test: (s, p) => L(s, p).climbs >= 25 },
  ashes:        { text: 'Have eighteen of your Spells destroyed.', test: (s, p) => L(s, p).spellsDestroyed >= 18 },
  twoGolems:    { text: 'Have two golem units on the battlefield at once.', test: (s, p) => unitsOf(s, p).filter((u) => u.kind === 'golem').length >= 3 },
  bleedThem:    { text: 'Deal 40 damage in one duel.', test: (s, p) => L(s, p).damageDealt >= 40 },
  comeback:     { text: 'Be 7 Victory Points behind.', test: (s, p) => s.vp[1 - p] - s.vp[p] >= 7 },

  /* ---------------------------------------------------------------- grey */
  wildMatch:    { text: 'Resolve forty chain links in one duel.', test: (s, p) => L(s, p).chainLinks >= 40 },
  longChain:    { text: 'Resolve a chain of seven links.', test: (s, p) => L(s, p).longestChain >= 7 },
  warded:       { text: 'Lose ten Spells to an opponent.', test: (s, p) => L(s, p).spellsDestroyed - L(s, p).spellsSacrificed >= 10 },
  keyed:        { text: 'Resolve two chains in a single turn.', test: (s, p) => L(s, p).chainsResolved >= 25 },
  sealed:       { text: 'Hold a Spell that cannot be rotated.', test: (s, p) => spellsOn(s, p).some((sp) => sp.noTurnUntil !== null || s.derived.noTurn.has(sp.uid)) },
  echoes:       { text: 'Score from four different gold objectives.', test: (s, p) => new Set(Object.keys(s.players[p].objectives).map((k) => k.split('@')[0])).size >= 4 },

  /* ---------------------------------------------------------------- golems */
  heldLine:     { text: 'Summon twelve golem units in one duel.', test: (s, p) => L(s, p).summons >= 12 },
  colossal:     { text: 'Kill eight enemy units.', test: (s, p) => L(s, p).golemsKilled + L(s, p).magesKilled >= 8 },
  reachOut:     { text: 'Measure range from a golem unit.', test: (s, p) => rangeOrigins(s, p).some((u) => u.kind === 'golem') },
  secondOrigin: { text: 'Have a mage and three golem units alive at once.', test: (s, p) => unitsOf(s, p).length >= 4 },

  /* ------------------------------------------- the second card tranche */
  unstableEnd:  { text: 'Have four of your own Spells destroyed by an opponent.', test: (s, p) => L(s, p).spellsDestroyed - L(s, p).spellsSacrificed >= 4 },
  besieged:     { text: 'Deal 20 damage with your Spells and units.', test: (s, p) => L(s, p).damageDealt >= 20 },
  tideTurn:     { text: 'Move your units 40 times.', test: (s, p) => L(s, p).moves >= 40 },
  anchored:     { text: 'Remove terrain from the battlefield twice.', test: (s, p) => L(s, p).terrainRemoved >= 2 },
  woven:        { text: 'Be forced into 30 rotations by matches.', test: (s, p) => L(s, p).forcedRotations >= 30 },
  spired:       { text: 'Control five Spells at once.', test: (s, p) => spellsOn(s, p).length >= 5 },
  hollowed:     { text: 'Reshuffle your discard into your deck twice.', test: (s, p) => L(s, p).reshuffles >= 2 },
  consumed:     { text: 'Draw 30 cards in one duel.', test: (s, p) => L(s, p).cardsDrawn >= 30 },
  chorused:     { text: 'Resolve 25 chain links in one duel.', test: (s, p) => L(s, p).chainLinks >= 25 },
  archived:     { text: 'Score 6 Victory Points.', test: (s, p) => s.vp[p] >= 6 },
  firstLight:   { text: 'Play eight Spells in one duel.', test: (s, p) => L(s, p).spellsPlayed >= 8 },
  tithed:       { text: 'Have a golem card spent by attrition.', test: (s, p) => L(s, p).golemCardsLost >= 1 },
  aegis:        { text: 'Let your mage be killed twice.', test: (s, p) => L(s, p).mageDeaths >= 2 },
  houndPack:    { text: 'Summon eight golem units in one duel.', test: (s, p) => L(s, p).summons >= 8 },

  /* ---------------------------------------------------------------- traps */
  // Found by being in the situation the trap punishes: the Spellbook teaches
  // you the snare after you have been cornered yourself.
  snared:       { text: 'Have an enemy unit within 2m of your mage.', test: (s, p) => { const m = mageOf(s, p); return !!m && !m.dead && livingUnits(s).some((u) => u.owner !== p && within(u, m, 2000)); } },
  mirrored:     { text: 'Have two Spells of yours destroyed by the opponent.', test: (s, p) => L(s, p).spellsDestroyed - L(s, p).spellsSacrificed >= 2 },
  ambushed:     { text: 'Have an enemy unit within 1.5m of one of your golem units.', test: (s, p) => unitsOf(s, p).some((g) => g.kind === 'golem' && livingUnits(s).some((u) => u.owner !== p && within(u, g, 1500))) },

  /* ------------------------------------------- red, the physical tranche */
  starfall:     { text: 'Shove terrain a total of 12m.', test: (s, p) => L(s, p).terrainPushMm >= 12000 },
  rubble:       { text: 'Shatter two terrain pieces and deal 15 damage.', test: (s, p) => L(s, p).propsBroken >= 2 && L(s, p).damageDealt >= 15 },
  floored:      { text: 'Knock three enemy units flat in one duel.', test: (s, p) => L(s, p).knockdowns >= 3 },
  hotFooted:    { text: 'Move your units 25 times and deal 10 damage.', test: (s, p) => L(s, p).moves >= 25 && L(s, p).damageDealt >= 10 },
  ballista:     { text: 'Hit a unit with a thrown terrain piece twice.', test: (s, p) => L(s, p).terrainImpacts >= 2 },
  kindled:      { text: 'Set three units ablaze in one duel.', test: (s, p) => L(s, p).unitsBurned >= 3 },
  wildfire:     { text: 'Light five fires in one duel.', test: (s, p) => L(s, p).firesLit >= 5 },
  skyborne:     { text: 'Cause four falls in one duel.', test: (s, p) => L(s, p).fallsCaused >= 4 },
});

export const FIND_IDS = Object.freeze(Object.keys(FINDS).sort());

/**
 * Validate the corpus against this registry at load.
 *
 * A card whose `found` names a condition that does not exist can never be
 * found by anybody, and nothing about the card would look wrong. Two cards
 * sharing a condition is also refused: the Spellbook is a mapping from ways to
 * cards, and an entry that produces two spells is a page the player cannot act
 * on.
 */
export function validateFinds(cards) {
  const used = new Map();
  for (const d of cards) {
    if (!d.found) continue;
    if (!FINDS[d.found]) throw new Error(`${d.id}: no such find condition '${d.found}'`);
    if (used.has(d.found)) throw new Error(`find condition '${d.found}' is claimed by both ${used.get(d.found)} and ${d.id}`);
    used.set(d.found, d.id);
  }
  // The other direction matters just as much and is the easier one to forget: a
  // condition nothing claims is a watcher that runs every action forever and
  // can never do anything.
  const orphans = FIND_IDS.filter((k) => !used.has(k));
  if (orphans.length) throw new Error(`find conditions claimed by no card: ${orphans.join(', ')}`);
  return used;
}

/**
 * Check every condition for both players and hand out whatever was earned.
 *
 * Called from the pump when the board is at rest, never mid-effect: a condition
 * that fired while a chain was half way through resolving would be reading a
 * board that does not exist yet, and the card would arrive in the discard in
 * the middle of a replay.
 *
 * Once per card per match. `foundThisMatch` is on the player, so it rolls back
 * with a snapshot like everything else -- a find that happened inside an effect
 * that was then replayed does not happen twice.
 */
export function checkFinds(state) {
  const pool = state.findable;
  if (!pool || !pool.length) return 0;
  let n = 0;
  for (let p = 0; p < 2; p++) {
    const pl = state.players[p];
    for (const { id, found: cond } of pool) {
      if (pl.foundThisMatch.includes(id)) continue;
      let met = false;
      try { met = !!FINDS[cond].test(state, p); }
      catch (e) { (state.derivationErrors ||= []).push({ find: cond, error: String(e && e.message || e) }); }
      if (!met) continue;
      // Learned the moment the condition is met -- that is what the Spellbook
      // records -- but whether the card joins this duel's deck is the player's
      // choice, asked as a work item so the question parks and replays like
      // any other. `foundThisMatch` is marked here so the pump never queues
      // the same find twice.
      pl.foundThisMatch.push(id);
      state.queue.push({ kind: 'find', p, defId: id, why: cond, seq: ++state.actionSeq });
      n++;
    }
  }
  return n;
}

/** What the player has learned, for the Spellbook page. Sorted. */
export const spellbookPage = (learned) =>
  FIND_IDS
    .map((k) => ({ cond: k, text: FINDS[k].text, known: !!learned?.[k], card: learned?.[k] || null }))
    .sort((a, b) => a.cond.localeCompare(b.cond));
