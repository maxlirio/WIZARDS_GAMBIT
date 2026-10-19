// Golem tiers. One table, imported by everything that cares, so the cap cannot
// be written down twice and drift.
//
// The tier is simultaneously how wide a golem card is (how many bodies at once)
// and how deep (how many deaths before the card itself is spent), because the
// attrition rule destroys a deployed card the moment its last unit dies. Those
// are the same number on purpose: a big golem is a single irreplaceable body, a
// small one is a swarm you can afford to lose.

export const TIER_CAP = Object.freeze({ A: 1, B: 2, C: 3 });
export const TIERS = Object.freeze(['A', 'B', 'C']);
export const SLOTS = 3;

/**
 * EACH TIER HAS ITS OWN SLOT. Slot A (under cell 6) takes an A-tier card, slot
 * B a B-tier, slot C a C-tier. So a player fields at most one giant, one
 * warden-class golem and one swarm at a time, and the question a golem card
 * asks is never "which slot" but "is my slot free". The better golems are the
 * A tier: one body, but the body that decides fights.
 */
export const SLOT_TIER = Object.freeze(['A', 'B', 'C']);
export const slotForTier = (tier) => SLOT_TIER.indexOf(tier);
