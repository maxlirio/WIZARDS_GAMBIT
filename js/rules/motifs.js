// Parameterised face behaviours.
//
// This file is the answer to "how do you get to hundreds of spells". Four faces
// per card times hundreds of cards is over a thousand effects, and a thousand
// hand-written generators is a thousand places for the targeting rule, the
// keyword funnel or the sorting discipline to be got slightly wrong.
//
// So a face is usually ONE LINE:
//
//   III: { text: 'Destroy a Spell you control.', ...M.destroyASpell() },
//
// Each motif declares its own `tag`, which is the verb class the corner rune is
// assigned from (runes.js), so classifying a card for checkrunes.js is free.
//
// Every motif reaches the world only through `ctx`. None of them imports ops,
// measures a distance, or tests for a keyword -- the context has already
// applied the keywords, the auras and the targeting widenings. That is what
// makes a keyword registered next month work on a face written today.

import { CELL_COLOR, orthoNeighbours } from './table.js';
import { NUMERALS } from './orient.js';

/* ============================================================ the table */

export const turnASpell = ({ dir = 'left', side = 'friendly', includeSelf = false } = {}) => ({
  tag: 'turn',
  *effect(ctx) {
    const opts = ctx.rotatable(ctx.spellTargets({ side, exceptSelf: !includeSelf }));
    if (!opts.length) return;
    const uid = opts.length === 1 ? opts[0]
      : yield ctx.ask.one(opts, { prompt: `Rotate a Spell ${dir}` });
    if (uid === null) return;
    ctx.turnSpell(uid, dir);
  },
});

export const turnSelf = ({ dir = 'left' } = {}) => ({
  tag: 'turn',
  *effect(ctx) { ctx.turnSpell(ctx.spell.uid, dir, { forced: true }); },
});

/**
 * Rotate a Spell to ANY side, triggering nothing.
 *
 * Printed Precision I. The "triggering nothing" half is why ops never decides
 * for itself whether a rotation means a match check -- if it did, this face
 * could not exist.
 */
export const setSideFreely = ({ side = 'friendly' } = {}) => ({
  tag: 'turn',
  *effect(ctx) {
    const opts = ctx.spellTargets({ side });
    if (!opts.length) return;
    const uid = opts.length === 1 ? opts[0] : yield ctx.ask.one(opts, { prompt: 'Rotate a Spell to any side' });
    if (uid === null) return;
    const i = yield ctx.ask.pick([0, 1, 2, 3], { prompt: 'To which side?', labels: NUMERALS });
    ctx.setSide(uid, i ?? 0, { forced: true });
  },
});

export const shiftASpell = ({ side = 'friendly' } = {}) => ({
  tag: 'turn',
  *effect(ctx) {
    const opts = ctx.spellTargets({ side });
    if (!opts.length) return;
    const uid = opts.length === 1 ? opts[0] : yield ctx.ask.one(opts, { prompt: 'Shift a Spell' });
    if (uid === null) return;
    const from = ctx.cellOf(uid);
    if (from === null) return;
    const cells = orthoNeighbours(from);
    const cell = yield ctx.ask.pick(cells, {
      prompt: 'Shift it where?', labels: cells.map((c) => `cell ${c} (${CELL_COLOR[c]})`),
    });
    if (cell === null) return;
    ctx.shiftSpell(uid, cell);
  },
});

export const shiftSelf = () => ({
  tag: 'turn',
  *effect(ctx) {
    const cells = orthoNeighbours(ctx.spell.cell);
    if (!cells.length) return;
    const cell = yield ctx.ask.pick(cells, {
      prompt: 'Shift this Spell where?', labels: cells.map((c) => `cell ${c} (${CELL_COLOR[c]})`),
    });
    if (cell === null) return;
    ctx.shiftSpell(ctx.spell.uid, cell);
  },
});

/* ============================================================ destruction */

export const destroyASpell = ({ side = 'friendly', then = null } = {}) => ({
  tag: 'break',
  *effect(ctx) {
    const opts = ctx.spellTargets({ side });
    if (!opts.length) return;
    const uid = opts.length === 1 ? opts[0] : yield ctx.ask.one(opts, { prompt: 'Destroy a Spell' });
    if (uid === null) return;
    ctx.destroySpell(uid);
    if (then === 'draw') ctx.draw(1);
  },
});

export const destroySelf = ({ then = null } = {}) => ({
  tag: 'break',
  *effect(ctx) {
    ctx.destroySpell(ctx.spell.uid);
    if (then === 'draw') ctx.draw(2);
  },
});

/* ============================================================ damage */

export const damage = ({ amount = 1, range = 3000, needLos = false } = {}) => ({
  tag: 'break',
  *effect(ctx) {
    const ids = ctx.enemyUnits(range, { needLos });
    if (!ids.length) return;
    const id = ids.length === 1 ? ids[0] : yield ctx.ask.one(ids, { prompt: `Deal ${amount} damage`, kind: 'unit' });
    if (id === null) return;
    ctx.hit(id, amount);
  },
});

export const damageAll = ({ amount = 1, range = 2500 } = {}) => ({
  tag: 'break',
  *effect(ctx) {
    // Sorted, and resolved against a SNAPSHOT of the list: a hit can kill, a
    // kill can score, and scoring can end the game, so re-querying mid-loop
    // would change which units are still in range half way through.
    for (const id of ctx.enemyUnits(range)) {
      if (ctx.state.winner !== null) break;
      ctx.hit(id, amount);
    }
  },
});

/** Damage that scales with something you have already spent. Gold-adjacent red. */
export const damagePerLedger = ({ key, per = 1, cap = 4, range = 3000 } = {}) => ({
  tag: 'break',
  *effect(ctx) {
    const n = Math.min(cap, ctx.state.players[ctx.p].ledger[key] * per);
    if (n <= 0) return;
    const ids = ctx.enemyUnits(range);
    if (!ids.length) return;
    const id = ids.length === 1 ? ids[0] : yield ctx.ask.one(ids, { prompt: `Deal ${n} damage`, kind: 'unit' });
    if (id === null) return;
    ctx.hit(id, n);
  },
});

/**
 * Damage, and then this Spell may not be rotated again this turn.
 *
 * Printed Fire Bolt III. A PROHIBITION, which is strictly stronger than a gate:
 * a gate lets a match rotate the card anyway and resolve it inert, while this
 * stops the rotation itself, so the matched junction is spent and nothing at all
 * happens. The rulebook names both because the difference decides what a chain
 * can do to you.
 */
export const damageAndLock = ({ amount = 3, range = 3000 } = {}) => ({
  tag: 'break',
  *effect(ctx) {
    const ids = ctx.enemyUnits(range);
    if (ids.length) {
      const id = ids.length === 1 ? ids[0] : yield ctx.ask.one(ids, { prompt: `Deal ${amount} damage`, kind: 'unit' });
      if (id !== null) ctx.hit(id, amount);
    }
    ctx.spell.noTurnUntil = ctx.state.turn;
    ctx.fx('prohibited', { uid: ctx.spell.uid, untilTurn: ctx.state.turn });
  },
});

/* ============================================================ the field */

export const push = ({ mm = 2000, range = 3000, side = 'enemy' } = {}) => ({
  tag: 'move',
  *effect(ctx) {
    const ids = side === 'enemy' ? ctx.enemyUnits(range) : ctx.anyUnits(range);
    if (!ids.length) return;
    const id = ids.length === 1 ? ids[0] : yield ctx.ask.one(ids, { prompt: 'Push which unit?', kind: 'unit' });
    if (id === null) return;
    const dirs = ctx.pushDirs(id);
    if (!dirs.length) return;
    const d = dirs.length === 1 ? dirs[0]
      : yield ctx.ask.pick(dirs, { prompt: 'Push it which way?', labels: dirs.map(ctx.dirLabel) });
    if (d === null) return;
    ctx.shove(id, d, mm);
  },
});

export const pushAway = ({ mm = 2000, range = 3000 } = {}) => ({
  tag: 'move',
  *effect(ctx) {
    const ids = ctx.enemyUnits(range);
    if (!ids.length) return;
    const id = ids.length === 1 ? ids[0] : yield ctx.ask.one(ids, { prompt: 'Push which unit away?', kind: 'unit' });
    if (id === null) return;
    ctx.shoveAway(id, mm);
  },
});

export const pull = ({ mm = 2000, range = 4000 } = {}) => ({
  tag: 'move',
  *effect(ctx) {
    const ids = ctx.enemyUnits(range);
    if (!ids.length) return;
    const id = ids.length === 1 ? ids[0] : yield ctx.ask.one(ids, { prompt: 'Pull which unit?', kind: 'unit' });
    if (id === null) return;
    ctx.pullIn(id, mm);
  },
});

export const relocate = ({ mm = 3000, range = 4000, side = 'friendly' } = {}) => ({
  tag: 'move',
  *effect(ctx) {
    const ids = side === 'friendly' ? ctx.friendlyUnits(range) : ctx.anyUnits(range);
    if (!ids.length) return;
    const id = ids.length === 1 ? ids[0] : yield ctx.ask.one(ids, { prompt: 'Relocate which unit?', kind: 'unit' });
    if (id === null) return;
    const pts = ctx.landingPoints(id, mm);
    if (!pts.length) return;
    const i = yield ctx.ask.pick(pts.map((_, k) => k), {
      prompt: 'Where?', labels: pts.map((pt) => `${ctx.dirLabel(pt.dir)} (${pt.x},${pt.y}) z${pt.z}`),
    });
    ctx.relocate(id, pts[i ?? 0]);
  },
});

/** Printed Levitation IV: "move it to the closest elevated position". */
export const toHighGround = ({ mm = 3000, range = 4000 } = {}) => ({
  tag: 'move',
  *effect(ctx) {
    const ids = ctx.friendlyUnits(range);
    if (!ids.length) return;
    const id = ids.length === 1 ? ids[0] : yield ctx.ask.one(ids, { prompt: 'Lift which unit?', kind: 'unit' });
    if (id === null) return;
    const pt = ctx.elevatedNear(id, mm);
    if (pt) ctx.relocate(id, pt);
  },
});

export const shoveTerrain = ({ mm = 2000, range = 4000 } = {}) => ({
  tag: 'move',
  *effect(ctx) {
    const ids = ctx.propsInRange(range, { pushableOnly: true });
    if (!ids.length) return;
    const id = ids.length === 1 ? ids[0] : yield ctx.ask.one(ids, { prompt: 'Push which terrain piece?', kind: 'prop' });
    if (id === null) return;
    const dirs = ctx.pushDirs(id);
    if (!dirs.length) return;
    const d = dirs.length === 1 ? dirs[0]
      : yield ctx.ask.pick(dirs, { prompt: 'Which way?', labels: dirs.map(ctx.dirLabel) });
    if (d === null) return;
    ctx.shove(id, d, mm);
  },
});

export const liftTerrain = ({ mm = 1500, range = 4000 } = {}) => ({
  tag: 'move',
  *effect(ctx) {
    const ids = ctx.propsInRange(range);
    if (!ids.length) return;
    const id = ids.length === 1 ? ids[0] : yield ctx.ask.one(ids, { prompt: 'Levitate which terrain piece?', kind: 'prop' });
    if (id === null) return;
    ctx.liftTerrain(id, mm);
  },
});

/** Printed Levitation I: remove a terrain piece from the battlefield this turn. */
export const banishTerrain = ({ range = 5000 } = {}) => ({
  tag: 'move',
  *effect(ctx) {
    const ids = ctx.propsInRange(range);
    if (!ids.length) return;
    const id = ids.length === 1 ? ids[0] : yield ctx.ask.one(ids, { prompt: 'Remove which terrain piece?', kind: 'prop' });
    if (id === null) return;
    ctx.banishTerrain(id);
  },
});

/* ============================================================ cards */

export const drawCards = ({ n = 1 } = {}) => ({
  tag: 'draw',
  *effect(ctx) { ctx.draw(n); },
});

export const drawThenDiscard = ({ draw: dn = 2, discard: xn = 1 } = {}) => ({
  tag: 'draw',
  *effect(ctx) {
    ctx.draw(dn);
    const hand = ctx.handUids();
    if (hand.length < xn) return;
    const chosen = yield ctx.ask.some(hand, xn, { prompt: `Discard ${xn}`, kind: 'hand' });
    for (const uid of [].concat(chosen || [])) ctx.state.players[ctx.p].discard.push(
      ctx.state.players[ctx.p].hand.splice(ctx.state.players[ctx.p].hand.findIndex((c) => c.uid === uid), 1)[0],
    );
  },
});

/* ============================================================ keywords */

export const grantKeyword = ({ kw, side = 'friendly' } = {}) => ({
  tag: 'draw',
  keywords: [kw],
  *effect(ctx) {
    const opts = ctx.spellTargets({ side, exceptSelf: false });
    if (!opts.length) return;
    const uid = opts.length === 1 ? opts[0] : yield ctx.ask.one(opts, { prompt: `Grant [${kw}]` });
    if (uid === null) return;
    ctx.grantKeyword(uid, kw);
  },
});

/**
 * Printed Spell Splice: "Resolve the effect of a friendly Spell, adding any
 * [Keywords] from adjacent Spells."
 *
 * The archetypal purple face, and the reason the keyword funnel exists at all:
 * it does not know what the other spell does, and it does not have to.
 */
export const spliceResolve = () => ({
  tag: 'draw',
  *effect(ctx) {
    const opts = ctx.friendlySpells();
    if (!opts.length) return;
    const uid = opts.length === 1 ? opts[0] : yield ctx.ask.one(opts, { prompt: "Resolve a friendly Spell's face" });
    if (uid === null) return;
    for (const kw of ctx.keywordsNear()) ctx.grantKeyword(uid, kw);
    yield* ctx.resolveActive(uid);
  },
});

/** Printed Rewind: "Resolve the I of a friendly Spell, regardless of orientation." */
export const rewind = ({ index = 0 } = {}) => ({
  tag: 'draw',
  *effect(ctx) {
    const opts = ctx.friendlySpells();
    if (!opts.length) return;
    const uid = opts.length === 1 ? opts[0] : yield ctx.ask.one(opts, {
      prompt: `Resolve the ${NUMERALS[index]} of a friendly Spell`,
    });
    if (uid === null) return;
    yield* ctx.resolve(uid, index);
  },
});

/* ============================================================ passives */
// A passive is live ONLY while its face is active, and writes ONLY into the
// buckets its face declares in `grants`. Both halves are checked: derive.js
// refuses an undeclared bucket in strict mode, and checkderived.js reports a
// declared bucket that is never written.

export const passiveRange = ({ mm = 1000 } = {}) => ({
  tag: 'draw', grants: ['rangeBonus'],
  passive: ({ p, d }) => { d.rangeBonus[p] += mm; },
});

export const passiveDamage = ({ n = 1 } = {}) => ({
  tag: 'draw', grants: ['damageBonus'],
  passive: ({ p, d }) => { d.damageBonus[p] += n; },
});

/** [Spell Mastery] as a passive: this card may be rotated on any colour. */
export const passiveFreeTurn = () => ({
  tag: 'turn', grants: ['freeTurn'],
  passive: ({ spell, d }) => { d.freeTurn.add(spell.uid); },
});

/** The corners of this card count as any corner. Printed Resonis Orb. */
export const passiveWildCorners = () => ({
  tag: 'turn', grants: ['wildCorners'],
  passive: ({ spell, d }) => { d.wildCorners.add(spell.uid); },
});

/**
 * Every corner of this card counts as one named rune.
 *
 * Which makes the card re-create its own match after every rotation, since all
 * four corners stay the same through a turn. That is the pathology the chain's
 * vertex bound exists to contain -- checkchains.js builds exactly this table on
 * purpose -- so it is a safe card to print, and a sharp one: it turns a corner
 * of the table into a junction that always resonates.
 */
export const passiveRuneSeal = ({ rune }) => ({
  tag: 'turn', grants: ['runeOverride'],
  passive: ({ spell, d }) => { d.runeOverride.set(spell.uid, [rune, rune, rune, rune]); },
});

/** Printed Link: the Spell to the left has the keywords of the Spell to the right. */
export const passiveLink = () => ({
  tag: 'draw', grants: ['grantedKeywords'],
  passive2: ({ state, spell, d }) => {
    const left = leftNeighbour(state, spell);
    const right = rightNeighbour(state, spell);
    if (!left || !right) return;
    const from = state.defs[right.def].keywords.concat(right.keywords || []);
    const have = d.grantedKeywords.get(left.uid) || [];
    d.grantedKeywords.set(left.uid, [...new Set([...have, ...from])].sort());
  },
});

export const passiveUnitMove = ({ mm = 1000 } = {}) => ({
  tag: 'move', grants: ['unitMoveBonus'],
  passive: ({ state, p, d }) => {
    for (const u of state.field.units) {
      if (u.owner === p && !u.dead) d.unitMoveBonus.set(u.id, (d.unitMoveBonus.get(u.id) || 0) + mm);
    }
  },
});

export const passiveShield = ({ n = 1 } = {}) => ({
  tag: 'draw', grants: ['shield'],
  passive: ({ state, p, d }) => {
    for (const u of state.field.units) {
      if (u.owner === p && !u.dead) d.shield.set(u.id, (d.shield.get(u.id) || 0) + n);
    }
  },
});

/**
 * The Spells either side of this one lose their Keywords.
 *
 * The counterpart to the whole keyword economy: purple spends a game building
 * a card up to four Keywords, and this takes them away for as long as it faces
 * this way. Derived, like everything continuous -- rotate off this face and the
 * Keywords are simply there again, because they were never removed from
 * anything, only subtracted at the point of asking.
 */
export const passiveSilence = () => ({
  tag: 'draw', grants: ['lostKeywords'],
  passive: ({ state, spell, d }) => {
    for (const n of [leftNeighbour(state, spell), rightNeighbour(state, spell)]) {
      if (!n) continue;
      const have = state.defs[n.def].keywords.concat(n.keywords || []);
      const was = d.lostKeywords.get(n.uid) || [];
      d.lostKeywords.set(n.uid, [...new Set([...was, ...have])].sort());
    }
  },
});

/** Your opponent may not choose your Spells. Grey's defensive face. */
export const passiveWard = () => ({
  tag: 'draw', grants: ['noTarget'],
  passive: ({ state, p, spell, d }) => {
    for (const s of state.players[p].table.map((st) => st[0]).filter(Boolean)) d.noTarget.add(s.uid);
  },
});

/** This Spell may not be rotated at all -- a PROHIBITION, not a gate. */
export const passiveLocked = () => ({
  tag: 'turn', grants: ['noTurn'],
  passive: ({ spell, d }) => { d.noTurn.add(spell.uid); },
});

/* ============================================================ triggers */

export const onDestroyedDraw = ({ n = 1 } = {}) => ({
  tag: 'draw',
  on: { afterDestroy: function* (ctx, payload) { if (payload.p === ctx.p) ctx.draw(n); } },
});

/** Printed Defrinol Orb: "after this Artifact is rotated, rotate a Spell left." */
export const onRotatedRotate = () => ({
  tag: 'turn',
  on: {
    afterRotate: function* (ctx, payload) {
      if (payload.uid !== ctx.spell.uid) return;
      const opts = ctx.rotatable(ctx.friendlySpells());
      if (!opts.length) return;
      const uid = opts.length === 1 ? opts[0] : yield ctx.ask.one(opts, { prompt: 'Rotate a Spell left' });
      if (uid !== null) ctx.turnSpell(uid, 'left');
    },
  },
});

export const onMatchDamage = ({ amount = 1, range = 3000 } = {}) => ({
  tag: 'break',
  on: {
    afterMatch: function* (ctx, payload) {
      if (payload.p !== ctx.p) return;
      const ids = ctx.enemyUnits(range);
      if (ids.length) ctx.hit(ids[0], amount);
    },
  },
});

export const onKillDraw = ({ n = 1 } = {}) => ({
  tag: 'draw',
  on: { afterKill: function* (ctx, payload) { if (payload.by === ctx.p) ctx.draw(n); } },
});

export const onPlayDraw = ({ n = 1 } = {}) => ({
  tag: 'draw',
  on: {
    afterPlay: function* (ctx, payload) {
      // Only YOUR plays, and not this card's own arrival -- a face that drew
      // when it was itself played would draw on every copy every time, which is
      // a card that reads "draw a card" with extra steps.
      if (payload.p !== ctx.p || payload.uid === ctx.spell.uid) return;
      ctx.draw(n);
    },
  },
});

export const onTurnStartDamage = ({ amount = 1, range = 3000 } = {}) => ({
  tag: 'break',
  on: {
    turnStart: function* (ctx, payload) {
      if (payload.p !== ctx.p) return;
      const ids = ctx.enemyUnits(range);
      if (ids.length) ctx.hit(ids[0], amount);
    },
  },
});

export const onChainEndDraw = ({ n = 1, minLinks = 1 } = {}) => ({
  tag: 'draw',
  on: {
    chainEnd: function* (ctx, payload) {
      if (payload.p !== ctx.p || payload.resolutions < minLinks) return;
      ctx.draw(n);
    },
  },
});

export const onMoveDamage = ({ amount = 1, range = 3000 } = {}) => ({
  tag: 'break',
  on: {
    afterMove: function* (ctx, payload) {
      if (payload.p !== ctx.p) return;
      const ids = ctx.enemyUnits(range);
      if (ids.length) ctx.hit(ids[0], amount);
    },
  },
});

/**
 * A REPLACEMENT effect: damage aimed at your mage lands on a golem instead.
 *
 * A pure function, not a generator, and it cannot ask a question -- it runs
 * inside `hurt`, where the board is mid-mutation and the driver may already be
 * parked on something else. That restriction is the reason the whole
 * replacement path exists separately from the trigger bus.
 */
export const replaceMageDamage = () => ({
  tag: 'draw',
  replace: {
    afterDamage: ({ state, p }, payload) => {
      const target = state.field.units.find((u) => u.id === payload.targetId);
      if (!target || target.owner !== p || target.kind !== 'mage') return payload;
      const shield = state.field.units
        .filter((u) => !u.dead && u.owner === p && u.kind === 'golem')
        .sort((a, b) => a.id - b.id)[0];
      if (!shield) return payload;
      return { ...payload, targetId: shield.id, cause: 'redirected' };
    },
  },
});

/* ------------------------------------------------------------ helpers */

const leftNeighbour = (state, spell) => {
  const c = spell.cell % 3 !== 0 ? spell.cell - 1 : null;
  return c === null ? null : state.players[spell.owner].table[c][0] || null;
};
const rightNeighbour = (state, spell) => {
  const c = spell.cell % 3 !== 2 ? spell.cell + 1 : null;
  return c === null ? null : state.players[spell.owner].table[c][0] || null;
};
