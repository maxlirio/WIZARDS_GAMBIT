// What must be true of a WIZARD'S GAMBIT state, always.
//
// Checked after every apply AND every choose, not at the end of a game. A
// corrupted state usually keeps playing for another twenty moves before it does
// anything visible, and by then the action that broke it is gone. Unit tests
// found none of the real bugs in GUDNAK; this did.
//
// Errors are COLLECTED and RETURNED, never thrown. A harness that dies on the
// first violation tells you about one bug per run.

import { CELLS, CELL_COLOR, MATCH_SITES } from '../js/rules/table.js';
import { everySpell, spellsOn, defOf } from '../js/rules/ops.js';
import { KEYWORD_NAMES, MAX_KEYWORDS } from '../js/rules/keywords.js';
import { LEDGER_KEYS } from '../js/rules/ledger.js';
import { TIER_CAP, SLOTS, SLOT_TIER } from '../js/rules/golems.js';
import { REVOLUTION } from '../js/rules/ops.js';
import { CHAIN_ASSERT } from '../js/rules/match.js';
import { heightAt, inBounds, BODY_R } from '../js/field/arena.js';
import { vpConfig } from '../js/rules/score.js';

export function invariants(state, where = '') {
  const bad = [];
  const say = (msg) => bad.push(`${where ? where + ': ' : ''}${msg}`);

  /* ------------------------------------------------------------ identity */
  const seen = new Map();
  for (const e of everySpell(state)) {
    const key = `${e.zone}${e.player}${e.cell ?? e.index ?? e.slot}`;
    if (seen.has(e.card.uid)) say(`uid ${e.card.uid} in two places (${seen.get(e.card.uid)} and ${key})`);
    seen.set(e.card.uid, key);
    if (e.card.uid > state.nextUid) say(`uid ${e.card.uid} above nextUid ${state.nextUid}`);
    if (!state.defs[e.card.def]) say(`uid ${e.card.uid} has unknown def '${e.card.def}'`);
  }

  for (let p = 0; p < 2; p++) {
    const pl = state.players[p];
    if (pl.table.length !== CELLS) say(`player ${p} table has ${pl.table.length} cells`);
    for (let c = 0; c < CELLS; c++) {
      if (pl.table[c].length > 1) say(`player ${p} cell ${c} holds ${pl.table[c].length} cards -- cards never stack`);
      for (let d = 0; d < pl.table[c].length; d++) {
        const sp = pl.table[c][d];
        if (sp.cell !== c) say(`uid ${sp.uid} sits in cell ${c} but says ${sp.cell}`);
        if (sp.owner !== p) say(`uid ${sp.uid} on table ${p} but owned by ${sp.owner}`);

        /* ------------------------------------------------------ rotation */
        if (![0, 1, 2, 3].includes(sp.rot)) say(`uid ${sp.uid} has rot ${sp.rot}`);
        if (sp.turnsThisAction > REVOLUTION) {
          say(`uid ${sp.uid} rotated ${sp.turnsThisAction} times in one action (cap ${REVOLUTION})`);
        }
        // A spell on a mismatched colour is a legal STATE -- it got there by
        // being shifted. What is illegal is the voluntary TRANSITION, so what
        // is asserted is that a spell still standing where it was PLAYED is on
        // its own colour. A mismatched one provably arrived by a shift.
        const def = defOf(state, sp);
        if (sp.playedTo === c) {
          const want = def.kind === 'artifact' ? 'grey' : def.school;
          if (CELL_COLOR[c] !== want) say(`uid ${sp.uid} (${def.id}, ${want}) was played onto ${CELL_COLOR[c]} cell ${c}`);
        }

        /* ------------------------------------------------------ keywords */
        const kws = sp.keywords || [];
        if (kws.length > MAX_KEYWORDS) say(`uid ${sp.uid} carries ${kws.length} copied keywords`);
        if (kws.join(',') !== [...new Set(kws)].sort().join(',')) {
          say(`uid ${sp.uid} keywords not unique+sorted: ${kws.join(',')}`);
        }
        for (const k of kws) if (!KEYWORD_NAMES.includes(k)) say(`uid ${sp.uid} has unregistered keyword '${k}'`);
      }
    }
    // A card off the table must not be carrying copied keywords: that is the
    // classic "+1 that never wears off", and it survives a trip through the
    // discard and back out onto the board.
    for (const zone of ['hand', 'deck', 'discard']) {
      for (const c of pl[zone]) {
        if ((c.keywords || []).length) say(`uid ${c.uid} in ${zone} still carries ${c.keywords.join(',')}`);
        if (c.cell !== null && c.cell !== undefined) say(`uid ${c.uid} in ${zone} still claims cell ${c.cell}`);
      }
    }

    /* ------------------------------------------------------------ ledger */
    for (const k of LEDGER_KEYS) {
      const v = pl.ledger[k];
      if (!Number.isInteger(v) || v < 0) say(`ledger ${p}.${k} is ${v}`);
    }

    /* ------------------------------------------------------------ golems */
    if (pl.golems.length !== SLOTS) say(`player ${p} has ${pl.golems.length} golem slots`);
    const defsSeen = new Set();
    for (let s = 0; s < SLOTS; s++) {
      const g = pl.golems[s];
      if (!g) continue;
      if (g.slot !== s) say(`golem ${g.uid} in slot ${s} says ${g.slot}`);
      if (defOf(state, g).tier !== SLOT_TIER[s]) say(`${defOf(state, g).tier}-tier golem ${g.def} sits in slot ${SLOT_TIER[s]}`);
      if (defsSeen.has(g.def)) say(`player ${p} has two ${g.def} golem cards`);
      defsSeen.add(g.def);
      const cap = TIER_CAP[defOf(state, g).tier];
      if (g.units.length > cap) say(`golem ${g.def} has ${g.units.length} units, tier cap ${cap}`);
      for (const id of g.units) {
        const u = state.field.units.find((x) => x.id === id);
        if (!u) say(`golem ${g.def} lists missing unit ${id}`);
        else if (u.dead) say(`golem ${g.def} lists dead unit ${id}`);
        else if (u.golemUid !== g.uid) say(`unit ${id} points at golem ${u.golemUid}, listed under ${g.uid}`);
      }
      // THE ATTRITION RULE. Exactly the sort of rule that silently stops
      // firing, so it is asserted rather than trusted.
      if (g.everDeployed && g.units.length === 0) {
        say(`golem ${g.def} deployed and empty but still in slot ${s}`);
      }
    }

    /* ------------------------------------------------------------ mage */
    const mages = state.field.units.filter((u) => u.owner === p && u.kind === 'mage');
    if (mages.length > 1) say(`player ${p} has ${mages.length} mages`);
    const m = mages[0];
    if (m && m.dead && pl.mage.respawnOnTurn === null) say(`player ${p}'s mage is dead with no respawn scheduled`);
    if (m && !m.dead && pl.mage.respawnOnTurn !== null) say(`player ${p}'s mage is alive with a respawn scheduled`);
  }

  /* ------------------------------------------------------------ chains */
  if (state.chainOverflow) say('chainOverflow fired -- the termination bound was exceeded');
  if (state.pumpOverflow) say('pumpOverflow fired -- an action did not settle');
  if (state.illegalRotations) say(`${state.illegalRotations} illegal rotations reached ops (legalActions disagrees with ops)`);
  if (!state.pending && state.chain !== null) say('a chain is live with no question outstanding');
  if (state.chain) {
    const sp = state.chain.spent;
    if (sp.length !== new Set(sp).size) say(`chain spent a vertex twice: ${sp.join(',')}`);
    if (sp.some((v) => !MATCH_SITES.includes(v))) say(`chain spent a non-matchable vertex: ${sp.join(',')}`);
    if (sp.length > MATCH_SITES.length) say(`chain is ${sp.length} links (bound ${MATCH_SITES.length})`);
    if (state.chain.resolutions > MATCH_SITES.length) say(`chain resolved ${state.chain.resolutions} faces`);
  }

  /* ------------------------------------------------------------ VP */
  // Re-summed INDEPENDENTLY here rather than calling score.js's own helper: a
  // check that shares an implementation with the thing it checks proves only
  // that the implementation is self-consistent.
  const sums = [0, 0];
  const stamps = new Set();
  for (const e of state.scoreLog) {
    if (!Number.isInteger(e.amount) || e.amount <= 0) say(`score log entry of ${e.amount}`);
    sums[e.p] += e.amount;
    if (e.kind === 'objective') {
      const def = e.objId ? state.defs[e.objId.split(':')[0]] : null;
      if (!def) say(`objective entry names unknown card '${e.objId}'`);
      else if (def.school !== 'gold') say(`objective VP from a ${def.school} card (${def.id})`);
    }
  }
  for (let p = 0; p < 2; p++) {
    if (state.vp[p] !== sums[p]) say(`vp[${p}] is ${state.vp[p]} but the log re-sums to ${sums[p]}`);
    for (const k of Object.keys(state.players[p].objectives)) {
      if (stamps.has(k)) say(`objective stamp '${k}' recorded twice`);
      stamps.add(k);
    }
  }
  const mageEntries = state.scoreLog.filter((e) => e.kind === 'mage').length;
  const mageKills = state.players[0].ledger.magesKilled + state.players[1].ledger.magesKilled;
  if (mageEntries !== mageKills) say(`${mageEntries} mage-kill score entries but ${mageKills} mage kills counted`);

  const target = vpConfig(state).target;
  if (state.winner !== null && state.winner >= 0 && state.vp[state.winner] < target) {
    say(`player ${state.winner} won with ${state.vp[state.winner]} VP (target ${target})`);
  }
  if (state.winner === null && (state.vp[0] >= target || state.vp[1] >= target)) {
    say(`${target} VP reached with no winner declared`);
  }

  /* ------------------------------------------------------------ turn */
  if (!['spell', 'unit', 'over'].includes(state.phase)) say(`phase is '${state.phase}'`);
  // Only while the game is still running. A game that ended mid-chain leaves
  // the phase exactly where the winning point landed, and that is correct --
  // the pump returns the moment a winner exists and advances nothing after it.
  if (state.winner === null && state.phase === 'spell' && state.spellActionUsed
      && !state.pending && !state.queue.length) {
    say('the spell action is used but the phase did not advance');
  }

  /* ------------------------------------------------------------ field */
  for (const u of state.field.units) {
    for (const k of ['x', 'y', 'z', 'hp']) {
      if (!Number.isSafeInteger(u[k])) say(`unit ${u.id}.${k} is ${u[k]}`);
    }
    if (u.dead) continue;
    if (!inBounds(state.arena, u.x, u.y)) say(`unit ${u.id} is out of bounds at ${u.x},${u.y}`);
    // Nobody inside the ground. One millimetre of slack for the bilinear
    // sample, which is exact at the nodes and interpolated between them.
    const ground = heightAt(state.arena, u.x, u.y);
    if (u.z < ground - 1) say(`unit ${u.id} is ${ground - u.z}mm inside the ground`);
    if (!u.support) say(`unit ${u.id} has no support`);
    else if (u.support.kind === 'prop' && !state.field.props.some((pr) => pr.id === u.support.id)) {
      say(`unit ${u.id} stands on missing prop '${u.support.id}'`);
    } else if (u.support.kind === 'prop' && !state.pending && !state.queue.length
      && state.field.props.find((pr) => pr.id === u.support.id)?.destroyed) {
      say(`unit ${u.id} stands on shattered prop '${u.support.id}'`);
    }
    if (u.hp > u.maxHp) say(`unit ${u.id} has ${u.hp}/${u.maxHp} hp`);
  }
  // Nothing in the sky. The highest legal thing is a lifted floater with a body
  // on top of it; anything far above that has been ratcheted there by a
  // support cycle (two boulders each standing on the other), which is how a
  // pump overflow looked from the inside before falls were capped.
  const CEILING = 12000;
  for (const b of [...state.field.units.filter((u) => !u.dead), ...state.field.props]) {
    if (b.z > CEILING) say(`${b.body || 'body'} ${b.id} is ${b.z}mm up -- a support cycle?`);
  }
  for (const pr of state.field.props) {
    if (!Number.isInteger(pr.hp) || pr.hp < 0) say(`prop ${pr.id} has hp ${pr.hp}`);
    if (pr.hp === 0 && !pr.destroyed) say(`prop ${pr.id} is at 0 hp but was not shattered`);
    if (pr.burning !== null && pr.burning !== undefined && !Number.isInteger(pr.burning)) say(`prop ${pr.id} burning is ${pr.burning}`);
    if (pr.support?.kind === 'prop') {
      const under = state.field.props.find((o) => o.id === pr.support.id);
      if (under?.support?.kind === 'prop' && under.support.id === pr.id) say(`props ${pr.id} and ${under.id} stand on each other`);
    }
  }
  if (!state.pending && !state.queue.length && state.field.pendingFalls.length) {
    say(`${state.field.pendingFalls.length} falls left unresolved at rest`);
  }

  /* ------------------------------------------------------------ errors */
  for (const e of state.derivationErrors || []) say(`derive error: ${e.def || e.gate} ${e.numeral || ''} ${e.error}`);
  for (const e of state.triggerErrors || []) say(`trigger error: ${e.event} ${e.error}`);
  for (const e of state.resolveErrors || []) say(`resolve error: ${e.def} ${e.numeral} ${e.error}`);

  return bad;
}

/**
 * Monotonicity has to be checked ACROSS states, so it gets its own pass.
 *
 * Compare only states AT REST (no outstanding question). An effect that parks is
 * replayed from a snapshot taken before it started, so answering a question
 * legitimately rolls every counter back to the pre-effect value and then forward
 * again. Comparing mid-replay would report that as a violation on every card
 * that asks anything.
 */
export function monotonic(prev, next, where = '') {
  const bad = [];
  if (!prev) return bad;
  for (let p = 0; p < 2; p++) {
    if (next.vp[p] < prev.vp[p]) bad.push(`${where}: vp[${p}] fell from ${prev.vp[p]} to ${next.vp[p]}`);
    for (const k of LEDGER_KEYS) {
      if (next.players[p].ledger[k] < prev.players[p].ledger[k]) {
        bad.push(`${where}: ledger ${p}.${k} fell from ${prev.players[p].ledger[k]} to ${next.players[p].ledger[k]}`);
      }
    }
  }
  if (next.scoreLog.length < prev.scoreLog.length) bad.push(`${where}: the score log got shorter`);
  return bad;
}
