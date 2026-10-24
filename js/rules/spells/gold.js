// GOLD -- turning work into Victory Points. Home cell 7.
//
// Gold is the only school that scores from objectives, and that is structural
// rather than a convention: schema.js throws at load if any other school's face
// declares one. So the race lives in exactly one place, and balancing it means
// reading seven cards rather than auditing forty.
//
// Every objective is HARD: a real condition built over several turns, usually
// a price on top, and side IV holds the card's biggest one -- so a gold card
// has to be turned all the way round to pay out properly. Every objective here
// DESTROYS ITS OWN CARD on payout and sends it to the
// discard. That round trip -- draw it again, play it again, rebuild the gate --
// is the whole VP throttle. There is no per-turn cap because the cap is your
// deck, which is also why gold wants the discard to come back around and why
// drawing from an empty deck reshuffles.

import { card } from './registry.js';
import * as M from '../motifs.js';
import { SPIRAL, SHARD, WHEEL, LATTICE } from '../runes.js';

card({
  id: 'TALLY', name: 'Tally', school: 'gold',
  // Counting the cost, and finally collecting.
  runes: [SPIRAL, SHARD, LATTICE, SPIRAL],
  sigil: null,
  I:   { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  II:  { text: 'If 5 of your Spells were destroyed since this was played, discard a card and score 1 VP.',
         tag: 'break', cost: [{ id: 'discard', n: 1 }],
         objective: { gate: { id: 'ledgerAtLeast', key: 'spellsDestroyed', n: 5, since: true }, vp: { k: 'flat', n: 1 } } },
  III: { text: 'Draw a card.', ...M.drawCards({ n: 1 }) },
  IV:  { text: 'After 20 rotations since this was played, destroy a Spell you control and score 2 VP.',
         tag: 'turn', cost: [{ id: 'destroyFriendly', n: 1 }],
         objective: { gate: { id: 'ledgerAtLeast', key: 'rotations', n: 20, since: true }, vp: { k: 'flat', n: 2 } } },
});

card({
  id: 'RECKONING', name: 'Reckoning', school: 'gold',
  // The bill for a long chain.
  runes: [LATTICE, SHARD, SHARD, SPIRAL],
  sigil: null,
  I:   { text: 'Draw a card.', ...M.drawCards({ n: 1 }) },
  II:  { text: 'Destroy a Spell you control. Draw a card.', ...M.destroyASpell({ side: 'friendly', then: 'draw' }) },
  III: { text: 'If you killed 3 golem units since this was played, discard a card and score 2 VP.',
         tag: 'break', cost: [{ id: 'discard', n: 1 }],
         objective: { gate: { id: 'ledgerAtLeast', key: 'golemsKilled', n: 3, since: true }, vp: { k: 'flat', n: 2 } } },
  IV:  { text: 'If this chain has resolved 6 links, score 3 VP.',
         tag: 'turn', objective: { gate: { id: 'chainAtLeast', n: 6 }, vp: { k: 'flat', n: 3 } } },
});

card({
  id: 'HIGH_SEAT', name: 'High Seat', school: 'gold',
  // Take the heights and hold them.
  runes: [WHEEL, WHEEL, SPIRAL, WHEEL],
  sigil: ['SW', 'WW', 'S.'],
  I:   { text: 'Move a friendly unit to the nearest high ground.', ...M.toHighGround({ mm: 3000 }) },
  II:  { text: 'If your units climbed 4 times since this was played, score 1 VP.',
         tag: 'move', objective: { gate: { id: 'ledgerAtLeast', key: 'climbs', n: 4, since: true }, vp: { k: 'flat', n: 1 } } },
  III: { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  IV:  { text: 'High ground held: destroy a Spell you control and score 1 VP per unit on it, up to 3.',
         tag: 'move', cost: [{ id: 'destroyFriendly', n: 1 }],
         objective: { gate: { id: 'highGround' }, vp: { k: 'perHighGround', per: 1, cap: 3 } } },
});

card({
  id: 'LEDGER_OF_ASH', name: 'Ledger of Ash', school: 'gold',
  // Every spell you burned, written down and paid for.
  runes: [SHARD, LATTICE, SPIRAL, SHARD],
  sigil: ['S...', 'HSLH'],
  I:   { text: 'Destroy a Spell you control. Draw a card.', ...M.destroyASpell({ side: 'friendly', then: 'draw' }) },
  II:  { text: 'If your discard holds 8 cards, discard 2 cards and score 1 VP.',
         tag: 'draw', cost: [{ id: 'discard', n: 2 }],
         objective: { gate: { id: 'discardAtLeast', n: 8 }, vp: { k: 'flat', n: 1 } } },
  III: { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  IV:  { text: 'If you sacrificed 3 Spells since this was played, score 1 VP per 2 of them, up to 3.',
         tag: 'break', objective: { gate: { id: 'ledgerAtLeast', key: 'spellsSacrificed', n: 3, since: true }, vp: { k: 'perLedger', key: 'spellsSacrificed', div: 2, per: 1, cap: 3, since: true } } },
});

card({
  id: 'WARDEN_SEAL', name: 'Warden Seal', school: 'gold',
  // An army on the field, sealed into points.
  runes: [LATTICE, WHEEL, WHEEL, LATTICE],
  sigil: ['WLL', '..W', '..L'],
  I:   { text: 'Your units take 1 less damage, to a minimum of 1.', ...M.passiveShield({ n: 1 }) },
  II:  { text: "If you have 3 units, spend a unit's action and score 1 VP.",
         tag: 'move', cost: [{ id: 'spendUnitAction' }],
         objective: { gate: { id: 'unitsAtLeast', n: 3 }, vp: { k: 'flat', n: 1 } } },
  III: { text: 'Move a friendly unit to the nearest elevated position.', ...M.toHighGround({ mm: 3000 }) },
  IV:  { text: 'If you have 4 units on the battlefield, destroy a Spell you control and score 3 VP.',
         tag: 'draw', cost: [{ id: 'destroyFriendly', n: 1 }],
         objective: { gate: { id: 'unitsAtLeast', n: 4 }, vp: { k: 'flat', n: 3 } } },
});

card({
  id: 'BLOOD_TITHE', name: 'Blood Tithe', school: 'gold',
  // Blood owed, blood collected.
  runes: [SHARD, SHARD, WHEEL, SHARD],
  sigil: ['W.', 'HH', 'H.', 'H.'],
  I:   { text: 'Deal 1 damage to an enemy unit within 3m.', ...M.damage({ amount: 1, range: 3000 }) },
  II:  { text: 'Your mage takes 1 damage. Score 1 VP per 6 damage dealt since this was played, up to 2.',
         tag: 'break', cost: [{ id: 'mageWound', n: 1 }],
         objective: { gate: { id: 'ledgerAtLeast', key: 'damageDealt', n: 6, since: true }, vp: { k: 'perLedger', key: 'damageDealt', div: 6, per: 1, cap: 2, since: true } } },
  III: { text: 'Push an enemy unit within 3m with force 3.', ...M.push({ force: 3, range: 3000 }) },
  IV:  { text: 'If the enemy mage has lost 3 hit points, discard a card and score 3 VP.',
         tag: 'break', cost: [{ id: 'discard', n: 1 }],
         objective: { gate: { id: 'enemyMageHurt', n: 3 }, vp: { k: 'flat', n: 3 } } },
});

card({
  id: 'LAST_GAMBIT', name: 'Last Gambit', school: 'gold',
  // Everything on one throw, when you are losing.
  runes: [SHARD, SPIRAL, LATTICE, LATTICE],
  sigil: ['SLS', 'LH.'],
  I:   { text: 'Destroy this Spell. Draw 2 cards.', ...M.destroySelf({ then: 'draw' }) },
  II:  { text: 'If this Spell has 2 Keywords, score 2 VP.',
         tag: 'draw', objective: { gate: { id: 'keywordsAtLeast', n: 2 }, vp: { k: 'flat', n: 2 } } },
  III: { text: 'Discard 2 cards. Score 1 VP per 5 cards drawn since this was played, up to 2.',
         tag: 'draw', cost: [{ id: 'discard', n: 2 }],
         objective: { gate: { id: 'ledgerAtLeast', key: 'cardsDrawn', n: 5, since: true }, vp: { k: 'perLedger', key: 'cardsDrawn', div: 5, per: 1, cap: 2, since: true } } },
  IV:  { text: 'If you are 4 VP behind, score 4 VP.',
         tag: 'draw', objective: { gate: { id: 'behindBy', n: 4 }, vp: { k: 'flat', n: 4 } } },
});

card({
  id: 'ARCHIVE', name: 'Archive', school: 'gold',
  // A full table, catalogued.
  runes: [WHEEL, WHEEL, SPIRAL, LATTICE],
  sigil: ['.S', '.W', '.W', 'LL'],
  I:   { text: 'Move a friendly unit to the nearest elevated position.', ...M.toHighGround({ mm: 3000 }) },
  II:  { text: 'If you have 4 units on the battlefield, discard a card and score 2 VP.',
         tag: 'move', cost: [{ id: 'discard', n: 1 }],
         objective: { gate: { id: 'unitsAtLeast', n: 4 }, vp: { k: 'flat', n: 2 } } },
  III: { text: 'Rotate a Spell you control left.', ...M.turnASpell({ dir: 'left' }) },
  IV:  { text: 'If you control 6 Spells, score 4 VP.',
         tag: 'draw', objective: { gate: { id: 'spellsAtLeast', n: 6 }, vp: { k: 'flat', n: 4 } } },
});

card({
  id: 'FIRST_LIGHT', name: 'First Light', school: 'gold',
  // Dawn, then a long day of turning.
  runes: [LATTICE, SHARD, WHEEL, SPIRAL],
  sigil: ['.WL', 'HSS'],
  I:   { text: 'After you play a Spell, draw a card.', ...M.onPlayDraw({ n: 1 }) },
  II:  { text: 'At the start of your turn, deal 1 damage to an enemy within 3m.', ...M.onTurnStartDamage({ amount: 1, range: 3000 }) },
  III: { text: 'Push a terrain piece within 4m with force 3.', ...M.shoveTerrain({ force: 3, range: 4000 }) },
  IV:  { text: 'After 20 rotations since this was played, score 1 VP per 7 of them, up to 3.',
         tag: 'turn', objective: { gate: { id: 'ledgerAtLeast', key: 'rotations', n: 20, since: true }, vp: { k: 'perLedger', key: 'rotations', div: 7, per: 1, cap: 3, since: true } } },
});

card({
  id: 'RIPTIDE', name: 'Riptide', school: 'gold',
  // The gold card for the pulling player: every unit you drag or throw is a
  // mark in the ledger, and the ledger pays.
  runes: [WHEEL, WHEEL, LATTICE, WHEEL],
  sigil: ['WWWW', '.L..'],
  I:   { text: 'Pull an enemy unit within 3m toward you with force 2.', ...M.pull({ force: 2, range: 3000 }) },
  II:  { text: 'If 4 units were pushed since this was played, discard a card and score 1 VP.',
         tag: 'move', cost: [{ id: 'discard', n: 1 }],
         objective: { gate: { id: 'ledgerAtLeast', key: 'unitsPushed', n: 4, since: true }, vp: { k: 'flat', n: 1 } } },
  III: { text: 'Draw a card.', ...M.drawCards({ n: 1 }) },
  IV:  { text: 'After 8 units were pushed since this was played, destroy a Spell you control and score 2 VP.',
         tag: 'move', cost: [{ id: 'destroyFriendly', n: 1 }],
         objective: { gate: { id: 'ledgerAtLeast', key: 'unitsPushed', n: 8, since: true }, vp: { k: 'flat', n: 2 } } },
});
