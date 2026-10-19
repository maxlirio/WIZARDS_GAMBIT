#!/usr/bin/env node
// The battlefield's determinism boundary, and the places integer geometry can
// still drift even when every number is an integer.
//
//   node tools/checkfield.js [--seeds N]
//
// The static grep -- no Math.sqrt/sin/cos/pow outside fixed.js, no host globals
// in the engine -- lives in tools/checksource.js and runs first in check.sh.
// This file tests the behaviour that survives that grep:
//
//   CROSS-PROCESS IDENTITY. The same seed and the same scripted pushes run in a
//   SEPARATE node process must produce a bit-identical field hash. Running it
//   twice in one process proves almost nothing: the whole class of bug being
//   hunted is one that only appears across engines, and a second process is the
//   cheapest thing that is genuinely not the first one.
//
//   ROUND-TRIP DRIFT. Push a prop east, then west, by the same distance, and it
//   must come home EXACTLY. `idiv` floors, so a pair of opposite moves of the
//   same length are not automatically inverses -- and the error is systematic,
//   not random, so a body shoved back and forth walks slowly across the arena.
//   Reported as a number rather than merely asserted, because the size of the
//   residue is a design fact.
//
//   SUPPORT COHERENCE. `z` is recomputed from `support` and never accumulated.
//   The test is the one that would catch the opposite: walk a long path and
//   assert the height at the end equals the height computed fresh from the
//   position.
//
//   THE FALL QUEUE DRAINS. `pendingFalls` is plain data in the state so that a
//   cascade survives a question. A cascade that does not finish is a board left
//   mid-fall for the rest of the game.

import { execFileSync } from 'node:child_process';
import { createGame, hashField, hashState } from '../js/engine.js';
import { makeArena, makeProps, heightAt, inBounds, propTop, propR, propSpec, flatEnough, STEP, FALL_SAFE, QUANT, CHALLENGES } from '../js/field/arena.js';
import { surfaceAt, settle, supported, livingUnits, mageOf, hasLos, findProp, propsOnBoard } from '../js/field/query.js';
import { walk, resolveFalls, recheckSupport, placeBody, fallDamageFor, CLIMB_RATE } from '../js/field/move.js';
import { push, levitate, removeTerrain } from '../js/field/push.js';
import { ringPoints, pushDirs, trialWalk, moveDirs } from '../js/field/candidates.js';
import { COMPASS, DIR64, idiv, iabs, isqrt, dist2 } from '../js/field/fixed.js';
import { hurt } from '../js/rules/combat.js';
// In its own module so the child process below can import it WITHOUT re-running
// this harness's top level -- which would spawn another child, and another.
import { exercise } from './fieldscript.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const SEEDS = arg('seeds', 24);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${msg}`); } };

/* ------------------------------------------------- 1. cross-process identity */
{
  // The child imports the SCRIPT module, not this file, so the two runs cannot
  // drift apart in the script -- only in the engine.
  const here = new URL('./fieldscript.js', import.meta.url).pathname;
  let mismatches = 0;
  const seeds = Array.from({ length: Math.min(SEEDS, 12) }, (_, i) => i + 1);
  const mine = seeds.map((s) => exercise(s).hash);
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { exercise } from ${JSON.stringify(here)};
    const seeds = ${JSON.stringify(seeds)};
    console.log(JSON.stringify(seeds.map((s) => exercise(s).hash)));
  `], { encoding: 'utf8' });
  const theirs = JSON.parse(out.trim().split('\n').pop());
  for (let i = 0; i < seeds.length; i++) {
    if (mine[i] !== theirs[i]) { mismatches++; console.log(`  FAIL seed ${seeds[i]}: field hash differs across processes`); }
  }
  ok(mismatches === 0, `${mismatches}/${seeds.length} field exercises differed across processes`);
  console.log(`cross-process        ${seeds.length} scripted field exercises identical in a separate node process`);
}

/* ------------------------------------------------------- 2. round-trip drift */
{
  // DRIFT and BLOCKING are two different things and the first version of this
  // test conflated them: it reported a 1414mm "drift", which is exactly one
  // diagonal metre -- a prop whose return leg ran into something, not an
  // arithmetic residue. So the only legs counted are the ones where BOTH
  // directions travelled their full nominal distance. Blocked round trips are
  // reported separately, because they are a game outcome rather than a bug.
  let worst = 0, worstWhere = '';
  let exact = 0, clean = 0, blocked = 0;
  const residues = new Map();
  for (let seed = 1; seed <= SEEDS; seed++) {
    const state = createGame({ seed, decks: [[], []], findable: [] });
    for (const pr of [...state.field.props].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (!propSpec(pr.kind).pushable) continue;
      const home = { x: pr.x, y: pr.y, z: pr.z };
      // Out and back along each axis, then each diagonal. The diagonals are the
      // interesting case: their unit vectors are not whole numbers of
      // millimetres, so `idiv` has something to round.
      for (const [out, back] of [[0, 32], [16, 48], [8, 40], [24, 56]]) {
        pr.x = home.x; pr.y = home.y; pr.z = home.z;
        const a = push(state, pr, out, 0, { mm: 1000, byP: 0 });
        const b = push(state, pr, back, 0, { mm: 1000, byP: 0 });
        if (a.mm < 1000 || b.mm < 1000) { blocked++; continue; }
        clean++;
        const dx = iabs(pr.x - home.x), dy = iabs(pr.y - home.y);
        const res = dx + dy;
        residues.set(res, (residues.get(res) || 0) + 1);
        if (res === 0) exact++;
        if (res > worst) { worst = res; worstWhere = `seed ${seed} prop ${pr.id} dir ${out}/${back}`; }
      }
      pr.x = home.x; pr.y = home.y; pr.z = home.z;
    }
  }
  const spread = [...residues.keys()].sort((x, y) => x - y).map((k) => `${k}mm x${residues.get(k)}`).join(', ');
  console.log(`round-trip drift     ${exact}/${clean} exact returns (${blocked} legs blocked and not counted)`);
  console.log(`  residues           ${spread || 'none'}`);
  if (worst) console.log(`  worst              ${worst}mm at ${worstWhere}`);
  // One movement step is 100mm, the engine's own resolution. A residue at or
  // above that is a body that walks when shoved back and forth, and it
  // compounds.
  ok(worst < STEP, `a prop pushed out and back drifted ${worst}mm, which is a whole movement step or more`);
}

/* --------------------------------------------------- 3. support coherence */
{
  let bad = 0, checked = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const state = createGame({ seed, decks: [[], []], findable: [] });
    for (const u of livingUnits(state)) {
      for (const d of [0, 11, 22, 33, 44, 55]) {
        walk(state, u, d, 2000, { allowFall: false, climb: true });
        recheckSupport(state);
        resolveFalls(state, hurt);
        checked++;
        // z must equal the surface recomputed from scratch at this position.
        // If z were accumulated rather than re-derived, a long path would end
        // somewhere the ground is not.
        // Capped at a climbable rise above the body's feet, exactly as the
        // walk itself samples it: a floating rock overhead is not the
        // surface a unit standing under it is on. Drift in either direction
        // still shows -- a z that crept up finds the real ground below it,
        // and one that sank finds the ground above it.
        const fresh = surfaceAt(state, u.x, u.y, { maxZ: u.z + CLIMB_RATE });
        if (u.z !== fresh.z) { bad++; if (bad <= 3) console.log(`  FAIL seed ${seed} unit ${u.id} at ${u.x},${u.y} has z ${u.z}, surface says ${fresh.z}`); }
        if (!inBounds(state.arena, u.x, u.y)) { bad++; console.log(`  FAIL unit ${u.id} walked out of bounds`); }
        if (!supported(state, u)) { bad++; if (bad <= 3) console.log(`  FAIL seed ${seed} unit ${u.id} is unsupported at rest`); }
      }
    }
  }
  ok(bad === 0, `${bad}/${checked} positions had z disagreeing with the surface under them`);
  console.log(`support coherence    ${checked} walked positions, z always re-derived from support`);
}

/* ------------------------------------------------------ 4. the fall queue */
{
  let stuck = 0, drops = 0, damaged = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const state = createGame({ seed, decks: [[], []], findable: [] });
    // Stand every unit on the highest ground we can find, then shove it off.
    const a = state.arena;
    let best = { h: -1e9, x: 0, y: 0 };
    for (let j = 1; j < a.ny - 1; j++) {
      for (let i = 1; i < a.nx - 1; i++) {
        const h = a.hs[j * a.nx + i];
        if (h > best.h) best = { h, x: i * a.node, y: j * a.node };
      }
    }
    for (const u of livingUnits(state)) {
      for (const d of COMPASS.map((c) => c.dir)) {
        placeBody(state, u, best.x, best.y);
        u.hp = u.maxHp;
        const z0 = u.z;
        push(state, u, d, 4, { byP: 1 - u.owner });
        if (state.field.pendingFalls.length) stuck++;
        if (u.z < z0) { drops++; if (u.hp < u.maxHp) damaged++; }
      }
    }
  }
  ok(stuck === 0, `${stuck} pushes left the fall queue undrained`);
  console.log(`falls                ${drops} drops from the high ground, ${damaged} of them hurt`);
  // A high-ground push that can never hurt anybody makes height decoration.
  ok(drops === 0 || damaged > 0, 'no push off the high ground ever dealt damage -- height is decorative');
  ok(fallDamageFor(FALL_SAFE) === 0 && fallDamageFor(FALL_SAFE + 1) === 1, 'the fall damage curve does not start at the safe drop');
}

/* --------------------------------------------- 5. candidate lists are stable */
{
  let bad = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const state = createGame({ seed, decks: [[], []], findable: [] });
    const u = mageOf(state, 0);
    for (const n of [0, 1, 2]) {
      // Called repeatedly, the same list must come back in the same order --
      // the player's answer is an index into it, so an order that varies with
      // iteration order means the same answer means two different things on
      // two machines.
      const a = JSON.stringify(ringPoints(state, u, 2000 + n * 500));
      const b = JSON.stringify(ringPoints(state, u, 2000 + n * 500));
      if (a !== b) { bad++; console.log(`  FAIL ringPoints is not stable on seed ${seed}`); }
      const pa = JSON.stringify(pushDirs(state, 0, u));
      const pb = JSON.stringify(pushDirs(state, 0, u));
      if (pa !== pb) { bad++; console.log(`  FAIL pushDirs is not stable on seed ${seed}`); }
      const sorted = pushDirs(state, 0, u);
      if (sorted.join() !== [...sorted].sort((x, y) => x - y).join()) { bad++; console.log('  FAIL pushDirs is not sorted'); }
    }
    // A trial walk must leave NOTHING behind: the AI calls it for every
    // direction of every unit on every candidate action it considers.
    const before = hashState(state);
    for (const d of COMPASS.map((c) => c.dir)) trialWalk(state, u, d, 2500);
    moveDirs(state, u);
    if (hashState(state) !== before) { bad++; console.log(`  FAIL seed ${seed}: a trial walk changed the state`); }
  }
  ok(bad === 0, `${bad} candidate-list instabilities`);
  console.log(`candidate lists      stable, sorted, and probe-free`);
}

/* ------------------------------------------------- 6. every arena is playable */
{
  const seen = new Set();
  let bad = 0;
  for (let seed = 0; seed < Math.max(SEEDS, 200); seed++) {
    const a = makeArena(seed);
    seen.add(a.challenge);
    // Both spawn circles must be flat and in bounds, or a respawning mage
    // materialises inside a cliff.
    for (const s of a.spawns) {
      if (heightAt(a, s.x, s.y) !== 0) { bad++; console.log(`  FAIL seed ${seed}: spawn is at height ${heightAt(a, s.x, s.y)}`); }
      if (!inBounds(a, s.x, s.y)) { bad++; console.log(`  FAIL seed ${seed}: spawn out of bounds`); }
    }
    // And the two spawns must not be the same place.
    ok(dist2(a.spawns[0].x, a.spawns[0].y, a.spawns[1].x, a.spawns[1].y) > 4000 * 4000, `seed ${seed}: the spawns are too close`);
    const props = makeProps(a, seed);
    if (!props.length) { bad++; console.log(`  FAIL seed ${seed}: an arena with no terrain at all`); }
    for (const pr of props) {
      if (!inBounds(a, pr.x, pr.y)) { bad++; console.log(`  FAIL seed ${seed}: prop ${pr.id} out of bounds`); }
    }
  }
  ok(bad === 0, `${bad} unplayable arenas`);
  ok(seen.size === CHALLENGES.length, `only ${seen.size}/${CHALLENGES.length} arena challenges ever generated: ${[...seen].sort().join(' ')}`);
  console.log(`arenas               all ${CHALLENGES.length} challenges reachable, spawns flat and far apart`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
