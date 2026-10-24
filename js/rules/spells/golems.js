// GOLEM CARDS. They go into one of your three slots, never onto a cell.
//
// A golem card is NOT a four-sided spell, and the schema refuses to let it be
// one: it has no runes, no faces, never rotates and never matches. Three
// quarters of a four-sided golem would be unreachable by construction, so the
// card is what it actually is -- a statline and a tier.
//
// The TIER is both how wide the card is and how deep: it caps simultaneous
// bodies, and the attrition rule destroys a card that has deployed at least once
// the moment its last body dies. So an A-tier is one irreplaceable giant and a
// C-tier is a swarm you can afford to lose two of. A card that has never
// deployed is safe in its slot indefinitely, which makes holding one back real.

import { card } from './registry.js';

card({
  id: 'CLAY_HAND', name: 'Clay Hand', school: 'golem', kind: 'golem', tier: 'C',
  unit: { hp: 3, move: 2000, atk: 1, reach: 900 },
  text: 'Tier C. Three at a time. 3 hit points, 2m move, 1 damage.',
  sigil: null,
});

card({
  id: 'STONE_WARDEN', name: 'Stone Warden', school: 'golem', kind: 'golem', tier: 'B',
  unit: { hp: 5, move: 1800, atk: 2, reach: 900 },
  keywords: ['Absorb'],
  text: 'Tier B. [Absorb]. 5 hit points, 1.8m move, 2 damage.',
  sigil: ['..H', 'LHH', '..L'],
});

card({
  id: 'IRON_COLOSSUS', name: 'Iron Colossus', school: 'golem', kind: 'golem', tier: 'A',
  unit: { hp: 9, move: 1500, atk: 3, reach: 1100 },
  keywords: ['Crush'],
  text: 'Tier A. One only. [Crush]. 9 hit points, 1.5m move, 3 damage.',
  sigil: ['.S.', 'HS.', '.SW'],
});

card({
  id: 'SPARK_WISP', name: 'Spark Wisp', school: 'golem', kind: 'golem', tier: 'C',
  unit: { hp: 2, move: 3000, atk: 1, reach: 800 },
  keywords: ['Channel', 'Swift'],
  text: 'Tier C. [Channel] [Swift]. 2 hit points, 3m move, 1 damage.',
  sigil: ['.W..', 'WHHH'],
});

card({
  id: 'GLASS_SENTINEL', name: 'Glass Sentinel', school: 'golem', kind: 'golem', tier: 'B',
  unit: { hp: 4, move: 2000, atk: 2, reach: 1000 },
  keywords: ['Channel'],
  text: 'Tier B. [Channel]. 4 hit points, 2m move, 2 damage.',
  sigil: ['SW.', '.SW', '..L'],
});

card({
  id: 'EMBER_HOUND', name: 'Ember Hound', school: 'golem', kind: 'golem', tier: 'C',
  unit: { hp: 2, move: 2800, atk: 2, reach: 800 },
  keywords: ['Unstable', 'Swift'],
  text: 'Tier C. [Unstable] [Swift]. 2 hit points, 2.8m move, 2 damage.',
  sigil: ['SL.', 'WLS'],
});

card({
  id: 'BOG_CRAWLER', name: 'Bog Crawler', school: 'golem', kind: 'golem', tier: 'C',
  unit: { hp: 3, move: 2200, atk: 1, reach: 900 },
  keywords: ['Stun'],
  text: 'Tier C. [Stun]. 3 hit points, 2.2m move, 1 damage.',
  sigil: ['SWS', '.WL'],
});

card({
  id: 'GRANITE_RAM', name: 'Granite Ram', school: 'golem', kind: 'golem', tier: 'B',
  unit: { hp: 5, move: 2200, atk: 2, reach: 1000 },
  keywords: ['Impact'],
  text: 'Tier B. [Impact]. 5 hit points, 2.2m move, 2 damage.',
  sigil: ['WW.', 'LLL'],
});

card({
  id: 'OBSIDIAN_TITAN', name: 'Obsidian Titan', school: 'golem', kind: 'golem', tier: 'A',
  unit: { hp: 8, move: 1800, atk: 3, reach: 1100 },
  keywords: ['Channel', 'Absorb'],
  text: 'Tier A. One only. [Channel] [Absorb]. 8 hit points, 1.8m move, 3 damage.',
  sigil: ['W.', 'SW', 'LS'],
});
