// GOLD -- turning work into Victory Points. Home cell 7.
//
// Gold is the only school that scores from objectives, and that is structural
// rather than a convention: schema.js throws at load if any other school's face
// declares one. So the race lives in exactly one place, and balancing it means
// reading seven cards rather than auditing forty.
//
// Every objective here DESTROYS ITS OWN CARD on payout and sends it to the
// discard. That round trip -- draw it again, play it again, rebuild the gate --
// is the whole VP throttle. There is no per-turn cap because the cap is your
// deck, which is also why gold wants the discard to come back around and why
// drawing from an empty deck reshuffles.

import { card } from './registry.js';
import * as M from '../motifs.js';
import { SPIRAL, SHARD, WHEEL, LATTICE } from '../runes.js';

card({
  id: 'TALLY', name: 'Tally', school: 'gold',
  runes: [SHARD, LATTICE, SPIRAL, SPIRAL],
  found: null,
  I:   { text: 'If 3 of your Spells have been destroyed, score 2 VP.',
         tag: 'break',
         objective: { gate: { id: 'ledgerAtLeast', key: 'spellsDestroyed', n: 3 }, vp: { k: 'flat', n: 2 } } },
  II:  { text: 'Draw a card.', ...M.drawCards({ n: 1 }) },
  III: { text: 'Score 1 VP per 4 rotations you have made, up to 3.',
         tag: 'turn',
         objective: { vp: { k: 'perLedger', key: 'rotations', div: 4, per: 1, cap: 3 } } },
  IV:  { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
});

card({
  id: 'RECKONING', name: 'Reckoning', school: 'gold',
  runes: [SPIRAL, SHARD, SHARD, LATTICE],
  found: null,
  I:   { text: 'Score 1 VP per link resolved in this chain, up to 3.',
         tag: 'turn', objective: { vp: { k: 'perChain', per: 1, cap: 3 } } },
  II:  { text: 'Destroy a Spell you control. Draw a card.', ...M.destroyASpell({ side: 'friendly', then: 'draw' }) },
  III: { text: 'If you have killed a golem unit this duel, score 2 VP.',
         tag: 'break',
         objective: { gate: { id: 'ledgerAtLeast', key: 'golemsKilled', n: 1 }, vp: { k: 'flat', n: 2 } } },
  IV:  { text: 'Draw a card.', ...M.drawCards({ n: 1 }) },
});

card({
  id: 'HIGH_SEAT', name: 'High Seat', school: 'gold',
  runes: [WHEEL, WHEEL, WHEEL, SPIRAL],
  found: 'climbHigh',
  I:   { text: 'If you hold the high ground, score 1 VP per unit on it, up to 3.',
         tag: 'move',
         objective: { gate: { id: 'highGround' }, vp: { k: 'perHighGround', per: 1, cap: 3 } } },
  II:  { text: 'Move a friendly unit to the nearest elevated position.', ...M.toHighGround({ mm: 3000 }) },
  III: { text: 'If your units have climbed 3 times, score 3 VP.',
         tag: 'move',
         objective: { gate: { id: 'ledgerAtLeast', key: 'climbs', n: 3 }, vp: { k: 'flat', n: 3 } } },
  IV:  { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
});

card({
  id: 'LEDGER_OF_ASH', name: 'Ledger of Ash', school: 'gold',
  runes: [SHARD, SHARD, LATTICE, SPIRAL],
  found: 'ashes',
  I:   { text: 'Score 1 VP per Spell you have sacrificed, up to 4.',
         tag: 'break', objective: { vp: { k: 'perLedger', key: 'spellsSacrificed', per: 1, cap: 4 } } },
  II:  { text: 'Destroy a Spell you control. Draw a card.', ...M.destroyASpell({ side: 'friendly', then: 'draw' }) },
  III: { text: 'If your discard holds 6 cards, score 2 VP.',
         tag: 'draw',
         objective: { gate: { id: 'discardAtLeast', n: 6 }, vp: { k: 'flat', n: 2 } } },
  IV:  { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
});

card({
  id: 'WARDEN_SEAL', name: 'Warden Seal', school: 'gold',
  runes: [LATTICE, WHEEL, WHEEL, LATTICE],
  found: 'twoGolems',
  I:   { text: 'Score 1 VP per friendly golem unit, up to 3.',
         tag: 'draw', objective: { vp: { k: 'perUnit', kind: 'golem', per: 1, cap: 3 } } },
  II:  { text: 'If you have 2 units, score 2 VP.',
         tag: 'move',
         objective: { gate: { id: 'unitsAtLeast', n: 2 }, vp: { k: 'flat', n: 2 } } },
  III: { text: 'Move a friendly unit to the nearest elevated position.', ...M.toHighGround({ mm: 3000 }) },
  IV:  { text: 'Your units take 1 less damage.', ...M.passiveShield({ n: 1 }) },
});

card({
  id: 'BLOOD_TITHE', name: 'Blood Tithe', school: 'gold',
  runes: [SHARD, SHARD, SHARD, WHEEL],
  found: 'bleedThem',
  I:   { text: 'Score 1 VP per 3 damage you have dealt, up to 4.',
         tag: 'break', objective: { vp: { k: 'perLedger', key: 'damageDealt', div: 3, per: 1, cap: 4 } } },
  II:  { text: 'Deal 2 damage to an enemy unit within 3m.', ...M.damage({ amount: 2, range: 3000 }) },
  III: { text: 'If the enemy mage has lost 3 hit points, score 2 VP.',
         tag: 'break',
         objective: { gate: { id: 'enemyMageHurt', n: 3 }, vp: { k: 'flat', n: 2 } } },
  IV:  { text: 'Push an enemy unit within 3m 2m.', ...M.push({ mm: 2000, range: 3000 }) },
});

card({
  id: 'LAST_GAMBIT', name: 'Last Gambit', school: 'gold',
  runes: [LATTICE, LATTICE, LATTICE, SHARD],
  found: 'comeback',
  I:   { text: 'If you are 4 VP behind, score 4 VP.',
         tag: 'draw',
         objective: { gate: { id: 'behindBy', n: 4 }, vp: { k: 'flat', n: 4 } } },
  II:  { text: 'Score 1 VP per 8 cards you have drawn, up to 3.',
         tag: 'draw', objective: { vp: { k: 'perLedger', key: 'cardsDrawn', div: 8, per: 1, cap: 3 } } },
  III: { text: 'Score 1 VP per Keyword on this Spell, up to 3.',
         tag: 'draw', objective: { vp: { k: 'perKeyword', per: 1, cap: 3 } } },
  IV:  { text: 'Destroy this Spell. Draw 2 cards.', ...M.destroySelf({ then: 'draw' }) },
});

/* ------------------------------------------------------------ second tranche */

card({
  id: 'ARCHIVE', name: 'Archive', school: 'gold',
  runes: [LATTICE, WHEEL, WHEEL, SPIRAL],
  found: 'archived',
  // Gold scoring off the TABLE rather than off history, which is the one shape
  // the first seven gold cards never used: it pays most when you are developed
  // and the chain is dangerous, so holding it is as much a decision as playing it.
  I:   { text: 'Score 1 VP per Spell you control, up to 4.',
         tag: 'draw', objective: { vp: { k: 'perSpell', per: 1, cap: 4 } } },
  II:  { text: 'Move a friendly unit to the nearest elevated position.', ...M.toHighGround({ mm: 3000 }) },
  III: { text: 'If you have 3 units on the battlefield, score 2 VP.',
         tag: 'move',
         objective: { gate: { id: 'unitsAtLeast', n: 3 }, vp: { k: 'flat', n: 2 } } },
  IV:  { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
});

card({
  id: 'FIRST_LIGHT', name: 'First Light', school: 'gold',
  runes: [LATTICE, SHARD, SPIRAL, WHEEL],
  found: 'firstLight',
  I:   { text: 'After you play a Spell, draw a card.', ...M.onPlayDraw({ n: 1 }) },
  II:  { text: 'At the start of your turn, deal 1 damage to an enemy within 3m.',
         ...M.onTurnStartDamage({ amount: 1, range: 3000 }) },
  III: { text: 'If it is not the first turn, score 1 VP per 5 rotations you have made, up to 3.',
         tag: 'turn',
         objective: { gate: { id: 'notFirstTurn' }, vp: { k: 'perLedger', key: 'rotations', div: 5, per: 1, cap: 3 } } },
  IV:  { text: 'Push a terrain piece within 4m 2m.', ...M.shoveTerrain({ mm: 2000, range: 4000 }) },
});
