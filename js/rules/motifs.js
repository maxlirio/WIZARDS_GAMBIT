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
      show: cells.map((c) => ({ cell: c, uid })),
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
      show: cells.map((c) => ({ cell: c, uid: ctx.spell.uid })),
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

export const damage = ({ amount = 1, range = 3000, needLos = false, element = null } = {}) => ({
  tag: 'break', reach: range, element,
  *effect(ctx) {
    const ids = ctx.enemyUnits(range, { needLos });
    if (!ids.length) return;
    const id = ids.length === 1 ? ids[0] : yield ctx.ask.one(ids, { prompt: `Deal ${amount} damage`, kind: 'unit' });
    if (id === null) return;
    const t = ctx.unit(id);
    ctx.hit(id, amount);
    // An elemental bolt scorches what the target was standing beside.
    if (element && t) ctx.sweep(t.x, t.y, SCORCH, element, { amount: 1 });
  },
});

/** How far a single elemental hit reaches into the terrain around its target. */
export const SCORCH = 700;

export const damageAll = ({ amount = 1, range = 2500, element = null } = {}) => ({
  tag: 'break', reach: range, element,
  *effect(ctx) {
    // Sorted, and resolved against a SNAPSHOT of the list: a hit can kill, a
    // kill can score, and scoring can end the game, so re-querying mid-loop
    // would change which units are still in range half way through.
    for (const id of ctx.enemyUnits(range)) {
      if (ctx.state.winner !== null) break;
      ctx.hit(id, amount);
    }
    // Rain of cinders over the whole radius: every tree in it catches.
    const o = ctx.origin();
    if (element && o) ctx.sweep(o.x, o.y, ctx.range(range).mm, element, { amount });
  },
});

/** Damage that scales with something you have already spent. Gold-adjacent red. */
export const damagePerLedger = ({ key, per = 1, cap = 4, range = 3000 } = {}) => ({
  tag: 'break', reach: range,
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
export const damageAndLock = ({ amount = 3, range = 3000, element = null } = {}) => ({
  tag: 'break', reach: range, element,
  *effect(ctx) {
    const ids = ctx.enemyUnits(range);
    if (ids.length) {
      const id = ids.length === 1 ? ids[0] : yield ctx.ask.one(ids, { prompt: `Deal ${amount} damage`, kind: 'unit' });
      if (id !== null) {
        const t = ctx.unit(id);
        ctx.hit(id, amount);
        if (element && t) ctx.sweep(t.x, t.y, SCORCH, element, { amount: 1 });
      }
    }
    ctx.spell.noTurnUntil = ctx.state.turn;
    ctx.fx('prohibited', { uid: ctx.spell.uid, untilTurn: ctx.state.turn });
  },
});

/* ============================================================ the field */

export const push = ({ mm = 2000, range = 3000, side = 'enemy' } = {}) => ({
  tag: 'move', reach: range,
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
  tag: 'move', reach: range,
  *effect(ctx) {
    const ids = ctx.enemyUnits(range);
    if (!ids.length) return;
    const id = ids.length === 1 ? ids[0] : yield ctx.ask.one(ids, { prompt: 'Push which unit away?', kind: 'unit' });
    if (id === null) return;
    ctx.shoveAway(id, mm);
  },
});

export const pull = ({ mm = 2000, range = 4000 } = {}) => ({
  tag: 'move', reach: range,
  *effect(ctx) {
    const ids = ctx.enemyUnits(range);
    if (!ids.length) return;
    const id = ids.length === 1 ? ids[0] : yield ctx.ask.one(ids, { prompt: 'Pull which unit?', kind: 'unit' });
    if (id === null) return;
    ctx.pullIn(id, mm);
  },
});

export const relocate = ({ mm = 3000, range = 4000, side = 'friendly' } = {}) => ({
  tag: 'move', reach: range,
  *effect(ctx) {
    const ids = side === 'friendly' ? ctx.friendlyUnits(range) : ctx.anyUnits(range);
    if (!ids.length) return;
    const id = ids.length === 1 ? ids[0] : yield ctx.ask.one(ids, { prompt: 'Relocate which unit?', kind: 'unit' });
    if (id === null) return;
    const pts = ctx.landingPoints(id, mm);
    if (!pts.length) return;
    const i = yield ctx.ask.pick(pts.map((_, k) => k), {
      prompt: 'Where?', labels: pts.map((pt) => `${ctx.dirLabel(pt.dir)} (${pt.x},${pt.y}) z${pt.z}`),
      show: pts.map(({ x, y, z }) => ({ x, y, z })),
    });
    ctx.relocate(id, pts[i ?? 0]);
  },
});

/** Printed Levitation IV: "move it to the closest elevated position". */
export const toHighGround = ({ mm = 3000, range = 4000 } = {}) => ({
  tag: 'move', reach: range,
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
  tag: 'move', reach: range,
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
  tag: 'move', reach: range,
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
  tag: 'move', reach: range,
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

/* ============================================================ the payoffs */
// The big faces. A card's side IV is its payoff, and these are the shapes the
// payoffs take: things that happen to MANY units, to the terrain, to the whole
// table at once -- the effects a card is worth charging up for.

/** Fireball: a hit, and a splash on every other enemy near the one it hit. */
export const fireball = ({ amount = 3, splash = 1, radius = 1500, range = 4000, element = 'fire' } = {}) => ({
  tag: 'break', reach: range, element,
  *effect(ctx) {
    const ids = ctx.enemyUnits(range);
    if (!ids.length) return;
    const id = ids.length === 1 ? ids[0] : yield ctx.ask.one(ids, { prompt: `Fireball: ${amount} damage`, kind: 'unit' });
    if (id === null) return;
    const t = ctx.unit(id);
    const tx = t.x, ty = t.y;
    const near = ctx.enemyUnits(99000)
      .map((k) => ctx.unit(k))
      .filter((u) => u.id !== id && (u.x - t.x) ** 2 + (u.y - t.y) ** 2 <= radius * radius)
      .map((u) => u.id);
    ctx.hit(id, amount);
    for (const k of near) { if (ctx.state.winner !== null) break; ctx.hit(k, splash); }
    // The blast lights everything in the splash radius.
    ctx.sweep(tx, ty, radius, element, { amount: splash });
  },
});

/** Damage and a knock-back on every enemy around the origin. */
export const nova = ({ amount = 2, mm = 1500, range = 2500, element = 'force' } = {}) => ({
  tag: 'break', reach: range, element,
  *effect(ctx) {
    const o = ctx.origin();
    if (!o) return;
    for (const id of ctx.enemyUnits(range)) {
      if (ctx.state.winner !== null) break;
      ctx.hit(id, amount);
      const u = ctx.unit(id);
      if (u && !u.dead) ctx.pushFrom(id, o.x, o.y, mm);
    }
    // And the terrain goes with them: rocks shoved, crystals cracked.
    ctx.sweep(o.x, o.y, ctx.range(range).mm, element, { amount, mm });
  },
});

/** Push every enemy within range directly away from the origin. */
export const repel = ({ mm = 2500, range = 3000, element = 'force' } = {}) => ({
  tag: 'move', reach: range, element,
  *effect(ctx) {
    const o = ctx.origin();
    if (!o) return;
    for (const id of ctx.enemyUnits(range)) ctx.pushFrom(id, o.x, o.y, mm);
    ctx.sweep(o.x, o.y, ctx.range(range).mm, element, { amount: 0, mm });
  },
});

/** Pull every enemy within range toward the origin. */
export const vortex = ({ mm = 2000, range = 5000, element = 'force' } = {}) => ({
  tag: 'move', reach: range, element,
  *effect(ctx) {
    const o = ctx.origin();
    if (!o) return;
    for (const id of ctx.enemyUnits(range)) ctx.pullTo(id, o.x, o.y, mm);
    // Loose stone is dragged in too. Pulled toward the mage, not past it.
    for (const id of ctx.propsNear(o.x, o.y, ctx.range(range).mm)) ctx.pullTo(id, o.x, o.y, mm);
  },
});

/** A quake: EVERY unit near the origin is thrown back, yours included. */
export const quake = ({ mm = 2000, range = 3000, element = 'force' } = {}) => ({
  tag: 'move', reach: range, element,
  *effect(ctx) {
    const o = ctx.origin();
    if (!o) return;
    for (const id of ctx.anyUnits(range)) {
      const u = ctx.unit(id);
      if (!u || (u.x === o.x && u.y === o.y)) continue;   // the epicentre stays put
      ctx.pushFrom(id, o.x, o.y, mm);
    }
    // The ground heaves: standing stones crack, crystals shatter, and what
    // was standing on a boulder is on the ground now.
    ctx.sweep(o.x, o.y, ctx.range(range).mm, element, { amount: 2, mm });
  },
});

/** Shove one enemy away and hit it. With crush, the wall it hits is the hit. */
export const slam = ({ mm = 4000, range = 3000, amount = 0, crush = false, element = 'force' } = {}) => ({
  tag: 'move', reach: range, element,
  *effect(ctx) {
    const ids = ctx.enemyUnits(range);
    if (!ids.length) return;
    const id = ids.length === 1 ? ids[0] : yield ctx.ask.one(ids, { prompt: 'Slam which unit?', kind: 'unit' });
    if (id === null) return;
    const o = ctx.origin();
    if (o) ctx.pushFrom(id, o.x, o.y, mm, { crush });
    const u = ctx.unit(id);
    if (amount > 0 && u && !u.dead) ctx.hit(id, amount);
  },
});

/** Lightning: one bolt, then it arcs to the nearest enemy it has not hit. */
export const chainLightning = ({ amount = 2, jumps = 2, hop = 2500, range = 5000, element = 'lightning' } = {}) => ({
  tag: 'break', reach: range, element,
  *effect(ctx) {
    const ids = ctx.enemyUnits(range);
    if (!ids.length) return;
    let id = ids.length === 1 ? ids[0] : yield ctx.ask.one(ids, { prompt: 'Strike which unit first?', kind: 'unit' });
    const hitSet = [];
    for (let k = 0; k <= jumps && id !== null && id !== undefined; k++) {
      if (ctx.state.winner !== null) break;
      const from = ctx.unit(id);
      const fx0 = from.x, fy0 = from.y;
      hitSet.push(id);
      ctx.hit(id, amount);
      ctx.sweep(fx0, fy0, SCORCH, element, { amount });
      // The arc goes to the NEAREST enemy not yet struck, ties to the lowest
      // id, so the path is a function of the board and nothing else.
      const next = ctx.enemyUnits(99000).map((n) => ctx.unit(n))
        .filter((u) => u && !u.dead && !hitSet.includes(u.id) && (u.x - fx0) ** 2 + (u.y - fy0) ** 2 <= hop * hop)
        .sort((a, b) => ((a.x - fx0) ** 2 + (a.y - fy0) ** 2) - ((b.x - fx0) ** 2 + (b.y - fy0) ** 2) || a.id - b.id)[0];
      id = next ? next.id : null;
    }
  },
});

/** Damage that lingers: a hit, then poison. */
export const envenom = ({ amount = 2, poison = 2, range = 5000 } = {}) => ({
  tag: 'break', reach: range,
  *effect(ctx) {
    const ids = ctx.enemyUnits(range);
    if (!ids.length) return;
    const id = ids.length === 1 ? ids[0] : yield ctx.ask.one(ids, { prompt: 'Envenom which unit?', kind: 'unit' });
    if (id === null) return;
    ctx.hit(id, amount);
    const u = ctx.unit(id);
    if (u && !u.dead) { u.poison = (u.poison || 0) + poison; ctx.fx('poisoned', { id, n: u.poison }); }
  },
});

/** Damage, and your mage drinks what it dealt. */
export const drain = ({ amount = 3, range = 4000 } = {}) => ({
  tag: 'break', reach: range,
  *effect(ctx) {
    const ids = ctx.enemyUnits(range);
    if (!ids.length) return;
    const id = ids.length === 1 ? ids[0] : yield ctx.ask.one(ids, { prompt: `Drain ${amount}`, kind: 'unit' });
    if (id === null) return;
    const dealt = ctx.hit(id, amount);
    if (dealt > 0) ctx.mend(dealt);
  },
});

export const mend = ({ n = 2 } = {}) => ({
  tag: 'draw',
  *effect(ctx) { ctx.mend(n); },
});

/**
 * Levitation's payoff: lift a rock from beside an enemy and drop it on them.
 * The rock must be NEAR THE TARGET, not near you -- you are reaching across the
 * arena, and the arena has to have put a stone there for you.
 */
export const dropRock = ({ amount = 3, range = 4000, near = 3000 } = {}) => ({
  tag: 'move', reach: range,
  *effect(ctx) {
    const rocksNear = (id) => {
      const u = ctx.unit(id);
      return ctx.propsInRange(99000, { pushableOnly: true }).filter((r) => {
        const pr = ctx.prop(r);
        return (pr.x - u.x) ** 2 + (pr.y - u.y) ** 2 <= near * near;
      });
    };
    const ids = ctx.enemyUnits(range).filter((id) => rocksNear(id).length);
    if (!ids.length) return;
    const id = ids.length === 1 ? ids[0] : yield ctx.ask.one(ids, { prompt: 'Drop a rock on whom?', kind: 'unit' });
    if (id === null) return;
    const rocks = rocksNear(id);
    const rock = rocks.length === 1 ? rocks[0] : yield ctx.ask.one(rocks, { prompt: 'Which rock?', kind: 'prop' });
    if (rock === null) return;
    ctx.dropRock(rock, id, amount);
  },
});

/** Throw an enemy into the air. The fall does the rest. */
export const hurl = ({ mm = 3000, range = 4000 } = {}) => ({
  tag: 'move', reach: range,
  *effect(ctx) {
    const ids = ctx.enemyUnits(range);
    if (!ids.length) return;
    const id = ids.length === 1 ? ids[0] : yield ctx.ask.one(ids, { prompt: 'Hurl which unit?', kind: 'unit' });
    if (id === null) return;
    ctx.hurl(id, mm);
  },
});

/** Two units trade places. Any two, either side. */
export const swapUnits = ({ range = 5000 } = {}) => ({
  tag: 'move', reach: range,
  *effect(ctx) {
    const ids = ctx.anyUnits(range);
    if (ids.length < 2) return;
    const a = yield ctx.ask.one(ids, { prompt: 'Swap which unit…', kind: 'unit' });
    if (a === null) return;
    const rest = ids.filter((x) => x !== a);
    const b = rest.length === 1 ? rest[0] : yield ctx.ask.one(rest, { prompt: '…with which?', kind: 'unit' });
    if (b === null) return;
    ctx.swapUnits(a, b);
  },
});

/** Raise a stone wall out of the ground near the caster. */
export const raiseWall = ({ mm = 2000 } = {}) => ({
  tag: 'move', reach: mm,
  *effect(ctx) {
    const o = ctx.origin();
    if (!o) return;
    const pts = ctx.landingPoints(o.id, mm);
    if (!pts.length) return;
    const i = pts.length === 1 ? 0 : yield ctx.ask.pick(pts.map((_, k) => k), {
      prompt: 'Raise the wall where?', labels: pts.map((pt) => ctx.dirLabel(pt.dir)),
      show: pts.map(({ x, y, z }) => ({ x, y, z })),
    });
    ctx.raiseWall(pts[i ?? 0]);
  },
});

/** Every other spell of yours turns. Time Warp turns them back. */
export const turnAll = ({ dir = 'right' } = {}) => ({
  tag: 'turn',
  *effect(ctx) {
    for (const uid of ctx.friendlySpells()) ctx.turnSpell(uid, dir, { forced: true });
  },
});

/** Rotate up to N of your spells, one at a time. */
export const turnSeveral = ({ n = 2, dir = 'left' } = {}) => ({
  tag: 'turn',
  *effect(ctx) {
    const done = [];
    for (let k = 0; k < n; k++) {
      const opts = ctx.rotatable(ctx.friendlySpells()).filter((u) => !done.includes(u));
      if (!opts.length) return;
      const uid = yield ctx.ask.one(opts, { prompt: `Rotate a Spell ${dir} (${k + 1} of ${n})`, allowNone: k > 0 });
      if (uid === null) return;
      done.push(uid);
      ctx.turnSpell(uid, dir);
    }
  },
});

/** A card from your discard back into your hand. */
export const recall = () => ({
  tag: 'draw',
  *effect(ctx) {
    const opts = ctx.discardUids();
    if (!opts.length) return;
    const uid = opts.length === 1 ? opts[0] : yield ctx.ask.one(opts, { prompt: 'Return which card to your hand?', kind: 'hand' });
    if (uid !== null) ctx.recall(uid);
  },
});

/** A destroyed spell rises again onto an empty cell of its colour. */
export const reanimate = () => ({
  tag: 'draw',
  *effect(ctx) {
    const st = ctx.state;
    const pl = st.players[ctx.p];
    const emptyHome = (c) => ctx.homeCellsOf(c.def).filter((cell) => !pl.table[cell].length);
    const opts = pl.discard.filter((c) => st.defs[c.def].kind !== 'golem' && emptyHome(c).length)
      .map((c) => c.uid).sort((a, b) => a - b);
    if (!opts.length) return;
    const uid = opts.length === 1 ? opts[0] : yield ctx.ask.one(opts, { prompt: 'Raise which Spell?', kind: 'hand' });
    if (uid === null) return;
    const cells = emptyHome(pl.discard.find((c) => c.uid === uid));
    const cell = cells.length === 1 ? cells[0] : yield ctx.ask.pick(cells, {
      prompt: 'Onto which cell?', labels: cells.map((c) => `cell ${c} (${CELL_COLOR[c]})`),
    });
    if (cell === null) return;
    ctx.reanimate(uid, cell);
  },
});

/** An enemy spell is frozen: it may not rotate through its owner's next turn. */
export const hexSpell = () => ({
  tag: 'turn',
  *effect(ctx) {
    const opts = ctx.enemySpells();
    if (!opts.length) return;
    const uid = opts.length === 1 ? opts[0] : yield ctx.ask.one(opts, { prompt: 'Hex which enemy Spell?' });
    if (uid !== null) ctx.hex(uid);
  },
});

/** Every spell of yours gains a Keyword. */
export const grantAll = ({ kw } = {}) => ({
  tag: 'draw',
  keywords: [kw],
  *effect(ctx) {
    for (const uid of ctx.friendlySpells({ exceptSelf: false })) ctx.grantKeyword(uid, kw);
  },
});

/** Choose ANY registered Keyword and grant it. */
export const grantChosen = () => ({
  tag: 'draw',
  *effect(ctx) {
    const opts = ctx.friendlySpells({ exceptSelf: false });
    if (!opts.length) return;
    const uid = opts.length === 1 ? opts[0] : yield ctx.ask.one(opts, { prompt: 'Grant a Keyword to which Spell?' });
    if (uid === null) return;
    const names = ctx.keywordNames();
    const i = yield ctx.ask.pick(names.map((_, k) => k), { prompt: 'Which Keyword?', labels: names });
    if (i === null) return;
    ctx.grantKeyword(uid, names[i]);
  },
});

/** Every Keyword anywhere on your table, gathered onto one spell. */
export const gatherKeywords = () => ({
  tag: 'draw',
  *effect(ctx) {
    const opts = ctx.friendlySpells({ exceptSelf: false });
    if (!opts.length) return;
    const uid = opts.length === 1 ? opts[0] : yield ctx.ask.one(opts, { prompt: 'Gather Keywords onto which Spell?' });
    if (uid === null) return;
    const all = [...new Set(opts.flatMap((u) => ctx.keywordsOf(u)))].sort();
    for (const kw of all) ctx.grantKeyword(uid, kw);
  },
});

/** This spell's Keywords, split like light across every spell you control. */
export const spreadKeywords = () => ({
  tag: 'draw',
  *effect(ctx) {
    const mine = ctx.keywords();
    for (const uid of ctx.friendlySpells()) for (const kw of mine) ctx.grantKeyword(uid, kw);
  },
});

/** Resolve the face now showing on EVERY other spell you control, in cell order. */
export const resolveAll = () => ({
  tag: 'draw',
  *effect(ctx) {
    const order = ctx.friendlySpells().map((u) => [u, ctx.cellOf(u)]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
    for (const uid of order) {
      if (ctx.state.winner !== null) break;
      if (ctx.cellOf(uid) === null) continue;
      yield* ctx.resolveActive(uid);
    }
  },
});

/** Resolve the faces of N friendly spells, adding adjacent Keywords to each. */
export const spliceMany = ({ n = 2 } = {}) => ({
  tag: 'draw',
  *effect(ctx) {
    const done = [];
    for (let k = 0; k < n; k++) {
      const opts = ctx.friendlySpells().filter((u) => !done.includes(u));
      if (!opts.length) return;
      const uid = opts.length === 1 ? opts[0] : yield ctx.ask.one(opts, { prompt: `Resolve a friendly Spell's face (${k + 1} of ${n})` });
      if (uid === null) return;
      done.push(uid);
      for (const kw of ctx.keywordsNear()) ctx.grantKeyword(uid, kw);
      yield* ctx.resolveActive(uid);
    }
  },
});

/** Damage that grows with every Keyword on your table. */
export const keywordBolt = ({ per = 1, cap = 5, range = 4000 } = {}) => ({
  tag: 'break', reach: range,
  *effect(ctx) {
    const kws = ctx.friendlySpells({ exceptSelf: false }).reduce((n, u) => n + ctx.keywordsOf(u).length, 0);
    const n = Math.min(cap, kws * per);
    if (n <= 0) return;
    const ids = ctx.enemyUnits(range);
    if (!ids.length) return;
    const id = ids.length === 1 ? ids[0] : yield ctx.ask.one(ids, { prompt: `Deal ${n} damage`, kind: 'unit' });
    if (id !== null) ctx.hit(id, n);
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

export const passiveMageLife = ({ n = 2 } = {}) => ({
  tag: 'draw', grants: ['mageLife'],
  passive: ({ p, d }) => { d.mageLife[p] += n; },
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
  tag: 'break', reach: range,
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
  tag: 'break', reach: range,
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
  tag: 'break', reach: range,
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
