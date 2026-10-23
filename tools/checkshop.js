#!/usr/bin/env node
// The shop: coins after a duel, packs that put a sigil in the Spellbook.
//
//   node tools/checkshop.js
//
// Checks js/rules/shop.js against the corpus and js/profile.js in memory (no
// localStorage in node, so the profile is its in-memory fallback -- exactly
// the path a private window takes). What it proves:
//   - every findable card has exactly one rarity and every rarity has a pack
//   - the rarity split is the sigil split: common/uncommon 4 runes, rare 5
//   - a pack never holds a sigil you know, never holds a card without a
//     sigil, and buying every pack of a rarity empties it without repeating
//   - the purse: a watched duel pays nothing, an unfinished one pays nothing,
//     a win pays more than the same loss, the itemised lines sum to the total
//   - buyPack refuses a short purse and a known-out rarity, and never charges
//     for a refusal
import { CARDS } from '../js/rules/spells/index.js';
import { RARITIES, PACKS, rarityOf, packOf, packContents, openPack, coinsFor, PURSE } from '../js/rules/shop.js';
import * as profile from '../js/profile.js';
import { createGame, apply, choose, legalActions } from '../js/engine.js';
import { chooseAction, answerFor } from '../js/ai/ai.js';

let passed = 0, failed = 0;
const ok = (cond, what) => { if (cond) passed++; else { failed++; console.log(`  FAIL ${what}`); } };

const cards = Object.values(CARDS);
const findable = cards.filter((d) => d.sigil);

/* ------------------------------------------------------------ rarities */
for (const d of findable) ok(RARITIES.includes(rarityOf(d)), `${d.id} has a rarity`);
for (const r of RARITIES) ok(packOf(r) && packOf(r).price > 0, `a ${r} pack exists with a price`);
ok(PACKS.length === RARITIES.length, 'one pack per rarity');
ok(PACKS.every((k, i) => i === 0 || k.price > PACKS[i - 1].price), 'rarer packs cost more');
const byRarity = Object.fromEntries(RARITIES.map((r) => [r, findable.filter((d) => rarityOf(d) === r)]));
for (const r of RARITIES) ok(byRarity[r].length >= 5, `${r} has at least five sigils (${byRarity[r].length})`);
ok(byRarity.common.every((d) => d.sigil.length === 4) && byRarity.uncommon.every((d) => d.sigil.length === 4), 'common and uncommon sigils are four runes');
ok(byRarity.rare.every((d) => d.sigil.length === 5), 'rare sigils are five runes');
console.log(`  rarities: ${RARITIES.map((r) => `${r} ${byRarity[r].length}`).join(', ')} of ${findable.length} findable`);

/* ------------------------------------------------------------ packs */
for (const r of RARITIES) {
  const all = packContents(cards, {}, r);
  ok(all.length === byRarity[r].length, `an empty Spellbook sees every ${r} sigil`);
  ok(all.every((id) => CARDS[id].sigil), `${r} pack only holds cards with sigils`);
  const known = Object.fromEntries(all.slice(0, 2).map((id) => [id, 'sigil']));
  ok(!packContents(cards, known, r).some((id) => known[id]), `${r} pack skips known sigils`);
  ok(openPack(cards, known, r, 0) === packContents(cards, known, r)[0], `${r} rng 0 opens the first unknown`);
  ok(openPack(cards, known, r, 0.999999) === packContents(cards, known, r).at(-1), `${r} rng ~1 opens the last unknown`);
  ok(openPack(cards, Object.fromEntries(all.map((id) => [id, 'pack'])), r, 0.5) === null, `${r} pack is empty once every sigil is known`);
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
try { profile.buyPack(cards, 'common', 0.3); } catch (e) { threw = e.message; }
ok(threw !== null && profile.coins() === 0, `a short purse is refused without charge (${threw})`);
const rec = profile.recordMatch(S, 0);
ok(rec.coins === coinsFor(S, 0).total && profile.coins() === rec.coins, 'recordMatch banks the purse');
ok(Array.isArray(rec.lines) && typeof rec.learned === 'number', 'recordMatch returns learned, coins, lines');
// Fund the purse by recording the same duel again -- a harness is allowed to.
for (let i = 0; i < 40; i++) profile.recordMatch(S, 0);
const before = profile.coins();
// The duel may have bound rare sigils in play; the shop sells only the rest.
const rareLeft = packContents(cards, profile.load().learned, 'rare').length;
ok(rareLeft >= 3, `rare sigils left to buy after the duel: ${rareLeft}`);
const id = profile.buyPack(cards, 'rare', 0.42);
ok(CARDS[id] && rarityOf(CARDS[id]) === 'rare', `a rare pack held a rare card (${id})`);
ok(profile.coins() === before - packOf('rare').price, 'the pack was paid for');
ok(profile.load().learned[id] === 'pack' && profile.known().includes(id), 'the card is in the Spellbook as a pack');
ok(profile.learn(id, 'sigil') === false && profile.load().learned[id] === 'pack', 'binding it later keeps it a pack');
// Buy every rare pack: no repeats, then the rarity sells out.
const bought = new Set([id]);
for (let i = 0; i < rareLeft - 1; i++) {
  const got = profile.buyPack(cards, 'rare', (i * 0.37) % 1);
  ok(!bought.has(got), `rare pack ${i + 2} is a new sigil (${got})`);
  bought.add(got);
}
ok(bought.size === rareLeft && packContents(cards, profile.load().learned, 'rare').length === 0, 'every rare sigil left was bought exactly once');
threw = null; const left = profile.coins();
try { profile.buyPack(cards, 'rare', 0.5); } catch (e) { threw = e.message; }
ok(threw !== null && profile.coins() === left, `a sold-out rarity is refused without charge (${threw})`);
threw = null;
try { profile.buyPack(cards, 'mythic', 0.5); } catch (e) { threw = e.message; }
ok(threw !== null, 'an unknown rarity is refused');
ok(profile.load().packs === rareLeft && profile.load().spent === rareLeft * packOf('rare').price, 'packs and spent are counted');
profile.reset();
ok(profile.coins() === 0 && profile.known().length === 0, 'reset empties the purse and the book');

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
