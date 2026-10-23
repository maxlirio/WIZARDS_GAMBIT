#!/usr/bin/env node
// The shop: coins after a duel, packs that put a sigil in the Spellbook.
//
//   node tools/checkshop.js
//
// Checks js/rules/shop.js against the corpus and js/profile.js in memory (no
// localStorage in node, so the profile is its in-memory fallback -- exactly
// the path a private window takes). What it proves:
//   - every findable card has a measured power tier (js/rules/spells/rarity.js
//     names it) and every tier holds cards of MORE THAN ONE kind -- the user's
//     rule: "the packs have all the types of card in each"
//   - the three packs' odds sum to one and dearer packs pay better odds
//   - a pack never holds a sigil you know, never a card without a sigil; a
//     rolled tier with nothing left falls to the nearest tier, upward on a tie;
//     buying until the Spellbook is full never repeats and then sells out
//   - the purse: a watched duel pays nothing, an unfinished one pays nothing,
//     a win pays more than the same loss, the itemised lines sum to the total
//   - buyPack refuses a short purse and a full Spellbook, never charging for
//     a refusal
import { CARDS } from '../js/rules/spells/index.js';
import { RARITY } from '../js/rules/spells/rarity.js';
import { RARITIES, PACKS, rarityOf, packOf, tierContents, packContents, rollTier, openPack, coinsFor, PURSE } from '../js/rules/shop.js';
import * as profile from '../js/profile.js';
import { createGame, apply, choose, legalActions } from '../js/engine.js';
import { chooseAction, answerFor } from '../js/ai/ai.js';

let passed = 0, failed = 0;
const ok = (cond, what) => { if (cond) passed++; else { failed++; console.log(`  FAIL ${what}`); } };

const cards = Object.values(CARDS);
const findable = cards.filter((d) => d.sigil);
const kindOf = (d) => (d.kind === 'golem' ? 'golem' : d.kind === 'artifact' ? 'artifact' : d.kind === 'trap' ? 'trap' : d.school);

/* ------------------------------------------------------------ tiers */
for (const d of findable) ok(RARITIES.includes(rarityOf(d)), `${d.id} has a rarity`);
const unrated = findable.filter((d) => !RARITY[d.id]);
ok(unrated.length === 0, `every findable card is in the rating table (unrated: ${unrated.map((d) => d.id).join(', ') || 'none'} -- run tools/ratecards.js --write)`);
const stale = Object.keys(RARITY).filter((id) => !CARDS[id]?.sigil);
ok(stale.length === 0, `the rating table names only findable cards (stale: ${stale.join(', ') || 'none'})`);
const byTier = Object.fromEntries(RARITIES.map((r) => [r, findable.filter((d) => rarityOf(d) === r)]));
for (const r of RARITIES) {
  ok(byTier[r].length >= 5, `${r} has at least five sigils (${byTier[r].length})`);
  const kinds = new Set(byTier[r].map(kindOf));
  ok(kinds.size >= 3, `${r} holds more than one kind of card (${[...kinds].sort().join(', ')})`);
}
console.log(`  tiers: ${RARITIES.map((r) => `${r} ${byTier[r].length}`).join(', ')} of ${findable.length} findable`);

/* ------------------------------------------------------------ packs */
ok(PACKS.length === 3 && PACKS.every((k) => packOf(k.id) === k), 'three packs, each found by id');
ok(PACKS.every((k, i) => i === 0 || k.price > PACKS[i - 1].price), 'dearer packs down the list');
for (const k of PACKS) {
  ok(Math.abs(k.odds.reduce((s, x) => s + x, 0) - 1) < 1e-9 && k.odds.length === RARITIES.length && k.odds.every((x) => x >= 0), `${k.id} odds sum to one`);
}
const rareOdds = (k) => k.odds[2], notCommon = (k) => 1 - k.odds[0];
ok(PACKS.every((k, i) => i === 0 || (rareOdds(k) > rareOdds(PACKS[i - 1]) && notCommon(k) > notCommon(PACKS[i - 1]))), 'a dearer pack pays strictly better odds of rare and of not-common');
ok(packOf('archmage').odds[0] === 0, 'the Archmage pack never pays out a common card');
ok(packOf('nope') === null, 'an unknown pack id is null');

// rollTier: the roll lands by the odds, and settles on the nearest stocked tier.
const full = { common: 5, uncommon: 5, rare: 5 };
ok(rollTier(packOf('apprentice'), full, 0.0) === 'common' && rollTier(packOf('apprentice'), full, 0.79) === 'common', 'apprentice: 0..0.8 is common');
ok(rollTier(packOf('apprentice'), full, 0.81) === 'uncommon' && rollTier(packOf('apprentice'), full, 0.99) === 'rare', 'apprentice: then uncommon, then rare');
ok(rollTier(packOf('archmage'), full, 0.0) === 'uncommon' && rollTier(packOf('archmage'), full, 0.5) === 'rare', 'archmage: half uncommon, half rare');
ok(rollTier(packOf('apprentice'), { common: 0, uncommon: 3, rare: 3 }, 0.1) === 'uncommon', 'a rolled common with none left pays uncommon');
ok(rollTier(packOf('archmage'), { common: 3, uncommon: 0, rare: 0 }, 0.1) === 'common', 'a rolled uncommon with only commons left pays common');
ok(rollTier(packOf('adept'), { common: 3, uncommon: 0, rare: 3 }, 0.5) === 'rare', 'a tie between neighbours goes upward');
ok(rollTier(packOf('adept'), { common: 0, uncommon: 0, rare: 0 }, 0.5) === null, 'nothing left is null');

ok(packContents(cards, {}).length === findable.length, 'an empty Spellbook sees every sigil');
const known2 = Object.fromEntries(findable.slice(0, 2).map((d) => [d.id, 'sigil']));
ok(packContents(cards, known2).length === findable.length - 2 && !packContents(cards, known2).some((id) => known2[id]), 'packContents skips known sigils');
for (const r of RARITIES) ok(tierContents(cards, {}, r).every((id) => rarityOf(CARDS[id]) === r && CARDS[id].sigil), `tierContents(${r}) is that tier, with sigils`);
// openPack with a scripted rng: first call rolls the tier, second picks in it.
const seq = (...xs) => { let i = 0; return () => xs[i++ % xs.length]; };
ok(openPack(cards, {}, packOf('archmage'), seq(0.9, 0)) === tierContents(cards, {}, 'rare')[0], 'archmage rolled high opens the first rare');
ok(openPack(cards, {}, packOf('apprentice'), seq(0.1, 0.999999)) === tierContents(cards, {}, 'common').at(-1), 'apprentice rolled low opens the last common');
ok(openPack(cards, Object.fromEntries(findable.map((d) => [d.id, 'pack'])), packOf('adept'), seq(0.5)) === null, 'a full Spellbook opens nothing');
// Every kind of card can come out of every pack.
for (const k of PACKS) {
  const kinds = new Set();
  for (let i = 0; i < 400; i++) { const id = openPack(cards, {}, k, seq((i * 0.618) % 1, (i * 0.377) % 1)); kinds.add(kindOf(CARDS[id])); }
  ok(kinds.size >= 5, `${k.id} pays out many kinds of card (${[...kinds].sort().join(', ')})`);
}

/* ------------------------------------------------------------ the purse */
const seedRun = (seed, cap = 400) => {
  const S = createGame({ seed });
  let n = 0;
  while (S.winner === null && n++ < cap) {
    if (S.pending) choose(S, answerFor(S, { policy: 'greedy' }));
    else { const a = chooseAction(S, { policy: 'greedy' }) || legalActions(S)[0]; apply(S, a); }
  }
  return S;
};
const S = seedRun(11, 6000);
ok(S.winner !== null, `the purse duel finished (winner ${S.winner}, turn ${S.turn})`);
ok(coinsFor(S, null).total === 0 && coinsFor(S, null).lines.length === 0, 'watching pays nothing');
const unfinished = createGame({ seed: 12 });
ok(coinsFor(unfinished, 0).total === 0, 'an unfinished duel pays nothing');
for (const p of [0, 1]) {
  const c = coinsFor(S, p);
  ok(c.total === c.lines.reduce((s, l) => s + l.coins, 0), `seat ${p}: lines sum to the total`);
  ok(c.total >= PURSE.played, `seat ${p}: playing pays at least ${PURSE.played}`);
  ok(c.lines.every((l) => Number.isInteger(l.coins) && l.coins > 0 && typeof l.label === 'string'), `seat ${p}: every line is a positive integer with a label`);
  const won = S.winner === p;
  ok(c.lines.some((l) => l.label === 'Victory') === won, `seat ${p}: the victory line is there iff seat ${p} won`);
}
if (S.winner === 0 || S.winner === 1) {
  const w = coinsFor(S, S.winner), l = coinsFor(S, 1 - S.winner);
  ok(w.total - w.lines.find((x) => x.label === 'Victory').coins >= PURSE.played, 'the winner is paid for playing and VP as well as winning');
  console.log(`  purse: winner ${w.total} (${w.lines.map((x) => `${x.label} ${x.coins}`).join(', ')}), loser ${l.total}`);
}

/* ------------------------------------------------------------ profile */
profile.reset();
ok(profile.coins() === 0 && profile.known().length === 0, 'a fresh profile has no coins and no sigils');
let threw = null;
try { profile.buyPack(cards, 'apprentice', seq(0.3)); } catch (e) { threw = e.message; }
ok(threw !== null && profile.coins() === 0, `a short purse is refused without charge (${threw})`);
const rec = profile.recordMatch(S, 0);
ok(rec.coins === coinsFor(S, 0).total && profile.coins() === rec.coins, 'recordMatch banks the purse');
ok(Array.isArray(rec.lines) && typeof rec.learned === 'number', 'recordMatch returns learned, coins, lines');
// Fund the purse by recording the same duel again -- a harness is allowed to.
for (let i = 0; i < 200; i++) profile.recordMatch(S, 0);
const before = profile.coins();
const id = profile.buyPack(cards, 'archmage', seq(0.9, 0.42));
ok(CARDS[id] && rarityOf(CARDS[id]) === 'rare', `an archmage pack rolled high held a rare card (${id})`);
ok(profile.coins() === before - packOf('archmage').price, 'the pack was paid for');
ok(profile.load().learned[id] === 'pack' && profile.known().includes(id), 'the card is in the Spellbook as a pack');
ok(profile.learn(id, 'sigil') === false && profile.load().learned[id] === 'pack', 'binding it later keeps it a pack');
// Buy until the book is full: no repeats, then sold out.
const left = packContents(cards, profile.load().learned).length;
const bought = new Set([id]);
let rng = 0.123;
for (let i = 0; i < left; i++) {
  const r1 = rng = (rng * 9301 + 49297) % 233280 / 233280, r2 = rng = (rng * 9301 + 49297) % 233280 / 233280;
  const got = profile.buyPack(cards, 'apprentice', seq(r1, r2));
  ok(!bought.has(got), `pack ${i + 2} is a new sigil (${got})`);
  bought.add(got);
}
// (the recorded duel's own finds were already in the book, so `left` is less than 63)
ok(bought.size === left + 1 && packContents(cards, profile.load().learned).length === 0, 'every sigil left was bought exactly once and the Spellbook is full');
threw = null; const purse = profile.coins();
try { profile.buyPack(cards, 'apprentice', seq(0.5)); } catch (e) { threw = e.message; }
ok(threw !== null && profile.coins() === purse, `a full Spellbook is refused without charge (${threw})`);
threw = null;
try { profile.buyPack(cards, 'mythic', seq(0.5)); } catch (e) { threw = e.message; }
ok(threw !== null, 'an unknown pack is refused');
ok(profile.load().packs === left + 1 && profile.load().spent === packOf('archmage').price + left * packOf('apprentice').price, 'packs and spent are counted');
profile.reset();
ok(profile.coins() === 0 && profile.known().length === 0, 'reset empties the purse and the book');

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
