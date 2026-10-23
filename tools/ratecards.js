#!/usr/bin/env node
// Rate every findable card by how often decks holding it WIN.
//
//   node tools/ratecards.js [--games 600] [--seed 1] [--workers 2] [--write]
//
// User (2026-10-23): "The packs have all the types of card in each, just there
// are different power tiers. Some are better than others." So a card's rarity
// is its POWER, and power has to be measured, not guessed: a designer's hunch
// about which of sixty-three cards is strongest is exactly the kind of claim
// this project has learned to distrust.
//
// The instrument: random ten-card decks from the whole corpus (randomDeck --
// one of each school, an artifact, a golem, three more), greedy bot on both
// seats, hundreds of games. Every deck's cards share its result, so one game
// rates twenty cards at once and each card lands in ~N*20/63 decks. The
// rate is shrunk toward a half by a ten-game prior so a card seen rarely does
// not top the table on a lucky streak. Ranked, the top fifth are RARE, the
// next three tenths UNCOMMON, the rest COMMON; --write puts that table in
// js/rules/spells/rarity.js, which js/rules/shop.js reads.
//
// Workers: the games are split across child processes (niced -- the user's
// rule is one heavy process at a time, and two niced halves of a 25-minute
// run are the compromise); each child writes a JSON tally and the parent
// merges them. --child A B OUT is the child's own entry point.
import { execFile } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, apply, choose } from '../js/engine.js';
import { chooseAction, answerFor } from '../js/ai/ai.js';
import { CARDS, randomDeck } from '../js/rules/spells/index.js';
import { seedRng, pick } from '../js/rules/rng.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FINDABLE = Object.values(CARDS).filter((d) => d.sigil).map((d) => d.id).sort();
const SHARE = Object.freeze({ rare: 0.2, uncommon: 0.3 });   // of the ranked list, top down
const PRIOR = 10;

/* ------------------------------------------------------------ child */
function playRange(from, to, seed0) {
  const tally = {};
  for (const id of FINDABLE) tally[id] = { n: 0, w: 0 };
  let played = 0;
  for (let g = from; g < to; g++) {
    const seed = seed0 + g;
    const dRng = seedRng(seed ^ 0x5eed);
    const decks = [randomDeck(dRng, pick), randomDeck(dRng, pick)];
    let state;
    try { state = createGame({ seed, decks }); } catch { continue; }
    let steps = 0;
    try {
      while (state.winner === null && steps++ < 8000) {
        if (state.pending) choose(state, answerFor(state, { policy: 'greedy' }));
        else { const a = chooseAction(state, { policy: 'greedy' }); if (!a) break; apply(state, a); }
      }
    } catch { continue; }
    if (state.winner === null) continue;
    played++;
    for (let p = 0; p < 2; p++) {
      const share = state.winner === -1 ? 0.5 : state.winner === p ? 1 : 0;
      for (const id of new Set(decks[p])) if (tally[id]) { tally[id].n++; tally[id].w += share; }
    }
  }
  return { played, tally };
}

if (flag('child')) {
  const i = process.argv.indexOf('--child');
  const [from, to, out] = [Number(process.argv[i + 1]), Number(process.argv[i + 2]), process.argv[i + 3]];
  writeFileSync(out, JSON.stringify(playRange(from, to, Number(arg('seed', 1)))));
  process.exit(0);
}

/* ------------------------------------------------------------ parent */
const GAMES = Number(arg('games', 600));
const SEED0 = Number(arg('seed', 1));
const WORKERS = Math.max(1, Number(arg('workers', 2)));
const dir = mkdtempSync(join(tmpdir(), 'wg-rate-'));
const self = fileURLToPath(import.meta.url);
const t0 = Date.now();
console.log(`rating ${FINDABLE.length} findable cards over ${GAMES} pool games (${WORKERS} niced workers)…`);

const run = (w) => new Promise((resolve, reject) => {
  const from = Math.floor((GAMES * w) / WORKERS), to = Math.floor((GAMES * (w + 1)) / WORKERS);
  const out = join(dir, `w${w}.json`);
  execFile('nice', ['-n', '10', process.execPath, self, '--child', String(from), String(to), out, '--seed', String(SEED0)],
    { maxBuffer: 1 << 24 }, (err, _so, se) => (err ? reject(new Error(`worker ${w}: ${se || err.message}`)) : resolve(JSON.parse(readFileSync(out, 'utf8')))));
});

const parts = await Promise.all(Array.from({ length: WORKERS }, (_, w) => run(w)));
const tally = {};
for (const id of FINDABLE) tally[id] = { n: 0, w: 0 };
let played = 0;
for (const part of parts) { played += part.played; for (const id of FINDABLE) { tally[id].n += part.tally[id].n; tally[id].w += part.tally[id].w; } }

const rows = FINDABLE.map((id) => {
  const { n, w } = tally[id];
  return { id, n, w, raw: n ? w / n : 0.5, rate: (w + PRIOR / 2) / (n + PRIOR) };
}).sort((a, b) => b.rate - a.rate || a.id.localeCompare(b.id));
const nRare = Math.round(rows.length * SHARE.rare), nUnc = Math.round(rows.length * SHARE.uncommon);
rows.forEach((r, i) => { r.rarity = i < nRare ? 'rare' : i < nRare + nUnc ? 'uncommon' : 'common'; });

const kindOf = (d) => (d.kind === 'golem' ? `golem ${d.tier}` : d.kind === 'artifact' ? 'artifact' : d.kind === 'trap' ? 'trap' : `${d.school}`);
console.log(`\n${played} games finished in ${Math.round((Date.now() - t0) / 1000)} s; each card in ${Math.min(...rows.map((r) => r.n))}–${Math.max(...rows.map((r) => r.n))} decks\n`);
console.log('  rarity    rate   raw    decks  card');
for (const r of rows) console.log(`  ${r.rarity.padEnd(9)} ${r.rate.toFixed(3)}  ${r.raw.toFixed(3)}  ${String(r.n).padStart(5)}  ${r.id.padEnd(18)} ${CARDS[r.id].name} (${kindOf(CARDS[r.id])})`);
const seen = (rar) => rows.filter((r) => r.rarity === rar);
console.log(`\n  rare ${seen('rare').length}, uncommon ${seen('uncommon').length}, common ${seen('common').length}`);
const spread = rows[0].rate - rows.at(-1).rate;
console.log(`  spread top to bottom ${spread.toFixed(3)}; a card's standard error at ${Math.round(rows.reduce((s, r) => s + r.n, 0) / rows.length)} decks is about ${(0.5 / Math.sqrt(rows.reduce((s, r) => s + r.n, 0) / rows.length)).toFixed(3)}`);

if (flag('write')) {
  const path = join(ROOT, 'js/rules/spells/rarity.js');
  const lines = rows.map((r) => `  ${r.id}: '${r.rarity}',${' '.repeat(Math.max(1, 20 - r.id.length))}// ${r.rate.toFixed(3)} in ${r.n} decks  ${CARDS[r.id].name}`);
  writeFileSync(path, `// POWER TIERS -- generated by tools/ratecards.js, do not edit by hand.
//
//   node tools/ratecards.js --games ${GAMES} --seed ${SEED0} --write
//
// A card's rarity is how often decks holding it WON in ${played} random-deck
// games between greedy bots (rate = wins shrunk toward a half by a ten-game
// prior). The top fifth are rare, the next three tenths uncommon, the rest
// common. User: "there are different power tiers. Some are better than
// others" -- so the shop's packs, which hold every kind of card, pay out by
// this table (js/rules/shop.js). Measured ${new Date().toISOString().slice(0, 10)}.
export const RARITY = Object.freeze({
${lines.join('\n')}
});
`);
  console.log(`\n  wrote ${path}`);
}
