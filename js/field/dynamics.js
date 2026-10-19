// Rigid-body motion for everything that gets shoved, thrown or dropped.
//
// The push used to be a walk: a body stepped along a bearing until its budget
// ran out or something stood in the way, and the view slid it from A to B.
// The user wanted the real thing -- "you push a rock and it rolls by physics,
// it can fall on a mage and the mage gets crumpled" -- so this is a small
// rigid-body simulation, and it is the ONLY place in the game where bodies
// have velocity.
//
// What it is: integer, fixed-step, bounded, deterministic. Positions are mm,
// velocities mm/s, 32 steps a second, never more than STEPS_MAX steps, every
// pair of bodies visited in a fixed order. Two engines fed the same push get
// the same trajectory to the millimetre, which is what lockstep multiplayer
// needs and the reason nothing here is a float (checkfield's grep gate).
//
// What it is not: a physics engine. Spheres roll (boulders), everything else
// slides; there is no rotation state, no stacking solver, no resting contact
// between leaning bodies. Collisions are impulses along the line between
// centres with a restitution per pair, damage comes off momentum, and a body
// that drops onto a unit from above CRUMPLES it -- the hit the user asked for.
//
// Bodies in a simulation:
//   SPHERES  boulders. Centre at z + r. Roll downhill (5/7 g, a solid ball),
//            lose speed to rolling resistance, bounce off walls and the ward,
//            go ballistic over a cliff edge and land with a thump.
//   SLIDERS  units (a capsule: radius BODY_R, height BODY_H, feet at z) and
//            the other props (base at z). Slide with friction -- a unit
//            tumbles to a stop, a wall grinds, a floater glides -- and never
//            climb: a rise too tall is a wall, and hitting it hurts.
//   STATIC   whatever is not pushable (an earth wall). Infinite mass.
//
// The force law is the printed one: force f on mass m buys f x 750 / m mm of
// SLIDING on the flat (travelFor). Launch speed is derived from that through
// the sliding friction, so a unit still lands where the card says; a sphere,
// which only loses speed to rolling resistance, goes several times further
// and keeps going downhill. That is the "pushing things harder" the user
// asked for: force matters, and a hard shove on a rock is an event.
//
// THE VIEW NOTE. One `dyn` note per simulation, spliced in BEFORE every
// damage note the simulation caused: the bodies, their sampled trajectories,
// and the events (hit, crumple, land, bounce, wall, ward, rest) with their
// time in ms. Every note written during the simulation (damage, knockdown,
// propHit, shatter, topple, kill) is stamped `dynMs`, the moment it belongs
// to, so the view can land the number when the rock does. See js/view for
// the playback.

import { idiv, imin, imax, iabs, isqrt, clamp, dist2, bearing, DIR64, DIR_SCALE } from './fixed.js';
import { BODY_R, STEP, STEP_UP, FALL_SAFE, propSpec, propR, propH, heightAt, propOnBoard, inBounds } from './arena.js';
import { BODY_H, findUnit, findProp, surfaceAt } from './query.js';
import { fallDamageFor, isUnitBody, queueFall, recheckSupport, resolveFalls } from './move.js';
import { hurt } from '../rules/combat.js';
import { fx } from '../rules/ops.js';
import { bump } from '../rules/ledger.js';
// push.js imports this module and this module calls back into it. Only ever
// at call time, never during module evaluation, so the cycle is harmless.
import { bodyMass, travelFor, topple, smashProp, knockDown, ridersOf, KNOCKDOWN_DMG } from './push.js';

/* ------------------------------------------------------------ constants */

/** Steps per second. A power of two so the integrator's divisions are exact. */
export const HZ = 32;
/** Never more than this many steps: ten seconds of motion. */
export const STEPS_MAX = 320;
/** Gravity, mm/s^2. */
export const G = 9800;
/** Sliding friction (mm/s^2): a unit, a wall, a shard, a pillar grinding along. */
export const DEC_SLIDE = 4500;
/** Rolling resistance (mm/s^2): a boulder keeps going. */
export const DEC_ROLL = 900;
/** A floating rock glides on its magic. */
export const DEC_GLIDE = 2500;
/** Restitution, per cent, for the pairs that bounce. */
const REST_SPHERE = 45, REST_WARD = 50, REST_WALL = 30, REST_LAND = 25;
/** Momentum (mass x mm/s) per point of impact damage. */
export const HIT_K = 2500;
/** Momentum per point when a rock comes DOWN on somebody. Harder than a side-on hit. */
export const CRUMPLE_K = 3500;
/** Nothing takes more than this from one impact. */
const HIT_CAP = 5;
/** A pair hurts each other at most once per this many steps. */
const HIT_COOLDOWN = 10;
/** A landing faster than this cracks a rock. */
const CRACK_VZ = 6500;
/** Below this speed on the ground a body is at rest. */
const REST_SPEED = 160;
/** How many steps between recorded frames. 16 samples a second. */
const FRAME_EVERY = 2;

const keyOf = (b) => (isUnitBody(b) ? `u${b.id}` : `p${b.id}`);
/**
 * Division that treats -a exactly as a: round to nearest, sign restored.
 * `idiv` floors, and flooring a negative velocity every step biased a body
 * going one way against the same body coming back -- checkfield's round
 * trips drifted up to 222 mm.
 */
const sdiv = (a, b) => (a < 0 ? -idiv(2 * -a + b, 2 * b) : idiv(2 * a + b, 2 * b));
/** Scale a velocity to a new speed, symmetrically. */
const rescale = (rec, ns, sp) => { rec.vx = sdiv(rec.vx * ns, sp); rec.vy = sdiv(rec.vy * ns, sp); };
const isSphere = (b) => !isUnitBody(b) && b.kind === 'boulder';

/** Friction for a body on the ground. */
function decelOf(rec) {
  if (rec.sphere) return DEC_ROLL;
  if (!rec.unit && propSpec(rec.b.kind).floating) return DEC_GLIDE;
  return DEC_SLIDE;
}

/** Launch speed that slides `mm` on the flat against this body's friction, rounded up. */
export const speedForTravel = (rec, mm) => (mm <= 0 ? 0 : isqrt(2 * decelOf(rec) * mm) + 1);

/* ------------------------------------------------------------ records */

function recordOf(state, b) {
  const unit = isUnitBody(b);
  const spec = unit ? null : propSpec(b.kind);
  return {
    b, unit, key: keyOf(b), id: b.id,
    sphere: isSphere(b),
    r: unit ? BODY_R : propR(b),
    h: unit ? BODY_H : propH(b),
    m: bodyMass(state, b),
    pushable: unit ? true : !!spec.pushable,
    floating: unit ? false : !!spec.floating,
    x: b.x, y: b.y, z: b.z,
    vx: 0, vy: 0, vz: 0,
    ax: 0, ay: 0, az: 0,          // sub-step remainders, so a step never loses a millimetre
    air: false, airZ: b.z,
    rest: true, lastHit: new Map(), hit: 0,
  };
}

/* ------------------------------------------------------------ the sim */

/**
 * One simulation: the bodies launched into it and everything they hit.
 *
 * `launch(body, vx, vy, vz)` puts a body in motion; `run()` integrates until
 * everything is at rest (or STEPS_MAX), writes the bodies back to the field,
 * splices the `dyn` note in, and returns what happened to the body that was
 * launched first: how far it went and what stopped it.
 */
export function createSim(state, { byP = null, crush = false } = {}) {
  const recs = [];                  // in launch/contact order, then sorted by key each step
  const byKey = new Map();
  const events = [];
  const fxStart = (state.fx || []).length;
  const arena = state.arena;

  function get(b) {
    const k = keyOf(b);
    if (byKey.has(k)) return byKey.get(k);
    const rec = recordOf(state, b);
    recs.push(rec); byKey.set(k, rec);
    return rec;
  }

  function launch(b, vx, vy, vz = 0, { air = false } = {}) {
    const rec = get(b);
    rec.vx += vx; rec.vy += vy; rec.vz += vz;
    rec.rest = false;
    if (air || vz > 0) { rec.air = true; rec.airZ = rec.z; }
    // Whatever stood on a rock that is now rolling is thrown off it; whatever
    // stands on a sliding piece rides it (handled after the run).
    if (!rec.unit && rec.sphere) {
      for (const u of ridersOf(state, b)) {
        const ur = get(u);
        ur.vx += idiv(vx, 2); ur.vy += idiv(vy, 2); ur.vz += 1200;
        ur.rest = false; ur.air = true; ur.airZ = ur.z;
        fx(state, 'scraped', { id: u.id, off: b.id });
      }
    }
    return rec;
  }

  /** The surface a body rests on at (x, y): never higher than it could step onto. */
  const groundAt = (rec, x, y) => {
    const s = surfaceAt(state, x, y, { ignore: rec.unit ? null : rec.id, maxZ: rec.z + (rec.sphere ? idiv(rec.r, 2) : STEP_UP * 2) });
    return s.z;
  };

  /** Slope under a sphere, as a gradient x1024 per axis. */
  function slope(x, y) {
    const d = 150;
    const gx = idiv((heightAt(arena, x + d, y) - heightAt(arena, x - d, y)) * 1024, 2 * d);
    const gy = idiv((heightAt(arena, x, y + d) - heightAt(arena, x, y - d)) * 1024, 2 * d);
    return [gx, gy];
  }

  const speedOf = (rec) => isqrt(rec.vx * rec.vx + rec.vy * rec.vy);
  const at = (rec) => ({ x: rec.x, y: rec.y, z: rec.z });
  const note = (t, kind, rec, extra = {}) => events.push({ t: idiv(t * 1000, HZ), kind, key: rec.key, at: at(rec), ...extra });

  /** Everything written to state.fx during a step belongs to that moment. */
  function stamp(t) {
    const ms = idiv(t * 1000, HZ);
    const f = state.fx || [];
    for (let i = f.length - 1; i >= fxStart; i--) { if (f[i].dynMs !== undefined) break; f[i].dynMs = ms; }
  }

  /** Damage from an impact, through the one funnel. */
  function wound(t, rec, dmg, cause, dir) {
    if (dmg <= 0) return;
    dmg = imin(HIT_CAP, dmg);
    if (rec.unit) {
      hurt(state, rec.b, dmg, { cause, byP });
      if (dmg >= KNOCKDOWN_DMG && !rec.b.dead) knockDown(state, rec.b, dir, { byP });
      if (rec.b.dead) { rec.rest = true; rec.vx = rec.vy = rec.vz = 0; }
    } else {
      smashProp(state, rec.b, dmg, { byP, cause: 'impact' });
      if (rec.b.destroyed) { rec.rest = true; rec.vx = rec.vy = rec.vz = 0; }
    }
  }

  /* -------- one body, one step */
  function integrate(rec, t) {
    if (rec.rest) return;
    if (rec.unit && rec.b.dead) { rec.rest = true; return; }
    if (!rec.unit && (rec.b.destroyed || !propOnBoard(state, rec.b))) { rec.rest = true; return; }

    if (rec.floating) {
      // Held up by magic: it glides at its height, over anything lower, and
      // never falls. Friction only.
      const sp = speedOf(rec);
      if (sp > 0) rescale(rec, imax(0, sp - idiv(decelOf(rec), HZ)), sp);
      rec.air = false;
    } else if (rec.air) {
      rec.vz -= idiv(G, HZ);
    } else {
      // On the ground: slope (spheres only) and friction.
      if (rec.sphere) {
        const [gx, gy] = slope(rec.x, rec.y);
        rec.vx -= idiv(G * 5 * gx, 7 * 1024 * HZ);
        rec.vy -= idiv(G * 5 * gy, 7 * 1024 * HZ);
      }
      const sp = speedOf(rec);
      if (sp > 0) {
        const ns = imax(0, sp - idiv(decelOf(rec), HZ));
        rescale(rec, ns, sp);
      }
    }

    // Move by the whole millimetres of v/HZ and carry the remainder, the same
    // way in both directions.
    const stepOf = (v, acc) => { const a = acc + v; const mv = sdiv(a, HZ); return [mv, a - mv * HZ]; };
    const [mx, rx] = stepOf(rec.vx, rec.ax); rec.ax = rx;
    const [my, ry] = stepOf(rec.vy, rec.ay); rec.ay = ry;
    let nx = rec.x + mx, ny = rec.y + my;
    let nz = rec.z;
    if (rec.air) { const [mz, rz] = stepOf(rec.vz, rec.az); rec.az = rz; nz = rec.z + mz; }

    // THE WARD. The arena's edge is a wall of light: a rock bounces off it, a
    // unit is slammed against it.
    const rb = rec.r;
    let warded = false;
    if (nx < rb) { nx = rb; rec.vx = -rec.vx; warded = true; }
    if (ny < rb) { ny = rb; rec.vy = -rec.vy; warded = true; }
    if (nx > arena.w - rb) { nx = arena.w - rb; rec.vx = -rec.vx; warded = true; }
    if (ny > arena.h - rb) { ny = arena.h - rb; rec.vy = -rec.vy; warded = true; }
    if (warded) {
      const sp = speedOf(rec);
      if (rec.unit) {
        note(t, 'ward', rec, { speed: sp });
        wound(t, rec, idiv(rec.m * sp, HIT_K), 'impact', bearing(0, 0, rec.vx, rec.vy));
        rec.vx = rec.vy = 0;
      } else {
        rec.vx = idiv(rec.vx * REST_WARD, 100); rec.vy = idiv(rec.vy * REST_WARD, 100);
        note(t, 'ward', rec, { speed: sp });
      }
    }

    if (rec.floating) { rec.x = nx; rec.y = ny; return; }
    const gz = groundAt(rec, nx, ny);
    if (rec.air) {
      if (nz <= gz) {
        // LANDING.
        const vdown = -rec.vz;
        nz = gz;
        rec.air = false;
        const drop = rec.airZ - gz;
        note(t, 'land', rec, { speed: vdown, drop });
        if (rec.unit) {
          const dmg = fallDamageFor(drop);
          if (dmg > 0) {
            hurt(state, rec.b, dmg, { cause: 'fall', byP, drop });
            if (rec.b.dead) { rec.rest = true; rec.vx = rec.vy = rec.vz = 0; }
          }
          if (drop > FALL_SAFE && byP !== null) bump(state.players[byP].ledger, 'fallsCaused');
          rec.vz = 0;
          rec.vx = idiv(rec.vx * 30, 100); rec.vy = idiv(rec.vy * 30, 100);
        } else if (rec.sphere) {
          if (vdown > CRACK_VZ) wound(t, rec, 1, 'impact', 0);
          rec.vx = idiv(rec.vx * 85, 100); rec.vy = idiv(rec.vy * 85, 100);
          const up = idiv(vdown * REST_LAND, 100);
          if (up > 900) { rec.vz = up; rec.air = true; rec.airZ = gz; } else rec.vz = 0;
        } else {
          rec.vz = 0;
          rec.vx = idiv(rec.vx * 40, 100); rec.vy = idiv(rec.vy * 40, 100);
        }
      }
      rec.x = nx; rec.y = ny; rec.z = nz;
      return;
    }

    // On the ground. Where is the ground at the new spot?
    const dz = gz - rec.z;
    const climbLimit = rec.sphere ? rec.r : STEP_UP * 2;
    if (dz > climbLimit) {
      // A WALL. The ground rises faster than the body can follow.
      const sp = speedOf(rec);
      const [gx, gy] = slope(rec.x, rec.y);
      const dir = bearing(0, 0, rec.vx, rec.vy);
      note(t, 'wall', rec, { speed: sp });
      if (rec.sphere) {
        // Bounce back along the uphill normal, losing most of the speed.
        const gl = isqrt(gx * gx + gy * gy) || 1;
        const nxn = idiv(gx * 1024, gl), nyn = idiv(gy * 1024, gl);          // uphill, x1024
        const vn = idiv(rec.vx * nxn + rec.vy * nyn, 1024);                  // speed into the wall
        if (vn > 0) { rec.vx -= idiv(vn * nxn * (100 + REST_WALL), 1024 * 100); rec.vy -= idiv(vn * nyn * (100 + REST_WALL), 1024 * 100); }
        else { rec.vx = -idiv(rec.vx * REST_WALL, 100); rec.vy = -idiv(rec.vy * REST_WALL, 100); }
        if (sp > 4500) wound(t, rec, 1, 'impact', dir);
      } else {
        wound(t, rec, idiv(rec.m * sp, HIT_K), 'impact', dir);
        rec.vx = rec.vy = 0;
      }
      return;                                            // stays where it was
    }
    if (dz > 0) {
      // A rise it can take: the climb costs speed. v^2 -= 2 g dz (x5/7 rolling).
      const v2 = rec.vx * rec.vx + rec.vy * rec.vy;
      const cost = rec.sphere ? idiv(2 * G * dz * 5, 7) : 2 * G * dz;
      if (v2 <= cost) { rec.vx = rec.vy = 0; return; }   // not enough: stops at the foot of it
      const nv = isqrt(v2 - cost), ov = isqrt(v2) || 1;
      rescale(rec, nv, ov);
      rec.x = nx; rec.y = ny; rec.z = gz;
      return;
    }
    if (-dz <= STEP_UP * 2) {
      // Gentle descent: follow the ground.
      rec.x = nx; rec.y = ny; rec.z = gz;
      return;
    }
    // The ground falls away: over the edge.
    rec.air = true; rec.airZ = rec.z; rec.vz = 0;
    rec.x = nx; rec.y = ny;
    note(t, 'edge', rec, { speed: speedOf(rec) });
  }

  /* -------- contacts */
  function contact(a, b, t) {
    if (a.rest && b.rest) return;
    if (a.unit && a.b.dead) return;
    if (b.unit && b.b.dead) return;
    if (!a.unit && (a.b.destroyed || !propOnBoard(state, a.b))) return;
    if (!b.unit && (b.b.destroyed || !propOnBoard(state, b.b))) return;
    const R = a.r + b.r;
    const d2 = dist2(a.x, a.y, b.x, b.y);
    if (d2 >= R * R) return;
    // Vertical spans: a sphere spans [z, z+2r], a unit [z, z+BODY_H], a prop [z, z+h].
    const aTop = a.z + (a.sphere ? 2 * a.r : a.h), bTop = b.z + (b.sphere ? 2 * b.r : b.h);
    if (a.z >= bTop || b.z >= aTop) return;

    // Something coming DOWN on a unit: a crumple.
    for (const [s, u] of [[a, b], [b, a]]) {
      if (!u.unit || !s.air || s.vz >= -900) continue;
      if (s.z < u.z + idiv(u.h, 2)) continue;
      const vdown = -s.vz;
      const dmg = imax(1, idiv(s.m * vdown, CRUMPLE_K));
      note(t, 'crumple', u, { by: s.key, speed: vdown, dmg });
      wound(t, u, dmg, 'impact', bearing(s.x, s.y, u.x, u.y));
      stamp(t);
      // The rock bounces off, away from the body it landed on.
      const dir = d2 > 0 ? bearing(u.x, u.y, s.x, s.y) : bearing(0, 0, s.vx || 1, s.vy);
      const [ux, uy] = DIR64[dir];
      s.vz = imax(900, idiv(vdown * 30, 100));
      s.vx += idiv(ux * 1400, DIR_SCALE); s.vy += idiv(uy * 1400, DIR_SCALE);
      s.air = true; s.airZ = s.z;
      a.lastHit.set(b.key, t); b.lastHit.set(a.key, t);
      return;
    }

    // Side on. Normal from b to a (horizontal), scaled x1024.
    const d = isqrt(d2);
    let nx, ny;
    if (d === 0) { const [ux, uy] = DIR64[bearing(0, 0, a.vx - b.vx || 1, a.vy - b.vy)]; nx = ux; ny = uy; }
    else { nx = idiv((a.x - b.x) * 1024, d); ny = idiv((a.y - b.y) * 1024, d); }
    const vrel = idiv((a.vx - b.vx) * nx + (a.vy - b.vy) * ny, 1024);   // >0: separating
    // Pull them apart first, the lighter (or the moving) one giving way.
    const overlap = R - d + 10;
    const mover = a.rest ? b : b.rest ? a : (a.m <= b.m ? a : b);
    const sgn = mover === a ? 1 : -1;
    mover.x = clamp(mover.x + sgn * sdiv(nx * overlap, 1024), mover.r, arena.w - mover.r);
    mover.y = clamp(mover.y + sgn * sdiv(ny * overlap, 1024), mover.r, arena.h - mover.r);
    if (vrel >= 0) return;

    const aStatic = !a.pushable, bStatic = !b.pushable;
    const speed = -vrel;
    const dir = bearing(0, 0, -nx, -ny);                 // the way a was travelling into b
    const recent = (t - (a.lastHit.get(b.key) ?? -999)) < HIT_COOLDOWN;
    const e = a.sphere && b.sphere ? REST_SPHERE : REST_WALL;

    // Topples: a tall piece struck with enough momentum goes over.
    for (const [s, p] of [[a, b], [b, a]]) {
      if (p.unit || !propSpec(p.b.kind).tippable) continue;
      if (s.m * speed < propSpec(p.b.kind).tipEnergy) continue;
      const pushDir = bearing(s.x, s.y, p.x, p.y);
      note(t, 'hit', s, { into: p.key, speed, dmg: 0 });
      topple(state, p.b, pushDir, { byP });
      stamp(t);
      p.rest = true;
      s.vx = idiv(s.vx * 50, 100); s.vy = idiv(s.vy * 50, 100);
      return;
    }

    if (!recent) {
      // Damage: each side takes the OTHER's momentum, a static thing hits
      // you with your own. [Crush] doubles what the pushed body deals.
      const ma = aStatic ? b.m : a.m, mb = bStatic ? a.m : b.m;
      let dmgToA = idiv(mb * speed, HIT_K), dmgToB = idiv(ma * speed, HIT_K);
      if (crush) { if (a.hit) dmgToB *= 2; if (b.hit) dmgToA *= 2; }
      note(t, 'hit', a, { into: b.key, speed, dmg: imin(HIT_CAP, imax(dmgToA, dmgToB)) });
      wound(t, a, dmgToA, 'impact', dir);
      wound(t, b, dmgToB, 'impact', dir);
      stamp(t);
      a.lastHit.set(b.key, t); b.lastHit.set(a.key, t);
    }

    // The impulse, along the normal.
    if (aStatic && bStatic) return;
    let j;
    if (aStatic) j = idiv(-(100 + e) * vrel * b.m, 100);
    else if (bStatic) j = idiv(-(100 + e) * vrel * a.m, 100);
    else j = idiv(-(100 + e) * vrel * a.m * b.m, 100 * (a.m + b.m));
    if (!aStatic) { a.vx += idiv(j * nx, 1024 * a.m); a.vy += idiv(j * ny, 1024 * a.m); a.rest = false; }
    if (!bStatic) { b.vx -= idiv(j * nx, 1024 * b.m); b.vy -= idiv(j * ny, 1024 * b.m); b.rest = false; }
  }

  /* -------- the run */
  function run() {
    const first = recs[0] || null;
    const start = first ? { x: first.x, y: first.y } : null;
    let blockedBy = null;
    const frames = [];
    const order = () => [...recs].sort((p, q) => (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));
    let t = 0;
    for (; t < STEPS_MAX; t++) {
      const list = order();
      if (t % FRAME_EVERY === 0) frames.push({ t: idiv(t * 1000, HZ), p: Object.fromEntries(list.map((r) => [r.key, [r.x, r.y, r.z]])) });
      for (const rec of list) integrate(rec, t);
      stamp(t);                       // a ward slam, a wall, a landing: this step's moment
      // Anything that moved this step may now be inside something else.
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) contact(list[i], list[j], t);
      // New contacts: bodies not yet in the sim that a moving body now overlaps.
      for (const rec of list) {
        if (rec.rest) continue;
        for (const u of state.field.units) {
          if (u.dead || byKey.has(`u${u.id}`)) continue;
          if (dist2(u.x, u.y, rec.x, rec.y) < (rec.r + BODY_R) ** 2 && u.z < rec.z + (rec.sphere ? 2 * rec.r : rec.h) && rec.z < u.z + BODY_H) { get(u); }
        }
        for (const pr of state.field.props) {
          if (pr.destroyed || !propOnBoard(state, pr) || byKey.has(`p${pr.id}`)) continue;
          if (dist2(pr.x, pr.y, rec.x, rec.y) < (rec.r + propR(pr)) ** 2 && pr.z < rec.z + (rec.sphere ? 2 * rec.r : rec.h) && rec.z < pr.z + propH(pr)) { get(pr); }
        }
      }
      // Rest.
      let moving = false;
      for (const rec of recs) {
        if (rec.rest) continue;
        if (!rec.air && speedOf(rec) < REST_SPEED && iabs(rec.vz) < REST_SPEED) {
          let slip = false;
          if (rec.sphere) { const [gx, gy] = slope(rec.x, rec.y); slip = isqrt(gx * gx + gy * gy) * 5 * G > DEC_ROLL * 7 * 1024; }
          if (!slip) { rec.rest = true; rec.vx = rec.vy = rec.vz = 0; note(t, 'rest', rec); continue; }
        }
        moving = true;
      }
      if (!moving) { t++; break; }
    }
    // Out of time: whatever is still moving stops where it is.
    for (const rec of recs) if (!rec.rest) { rec.rest = true; rec.vx = rec.vy = rec.vz = 0; }
    const list = order();
    frames.push({ t: idiv(t * 1000, HZ), p: Object.fromEntries(list.map((r) => [r.key, [r.x, r.y, r.z]])) });

    // Write the bodies back and find their footing.
    for (const rec of list) {
      const b = rec.b;
      if (rec.unit && b.dead) continue;
      if (!rec.unit && b.destroyed) continue;
      // Inside the ward, whatever the last step did.
      rec.x = clamp(rec.x, imax(rec.r, BODY_R), arena.w - imax(rec.r, BODY_R));
      rec.y = clamp(rec.y, imax(rec.r, BODY_R), arena.h - imax(rec.r, BODY_R));
      b.x = rec.x; b.y = rec.y;
      const s = surfaceAt(state, rec.x, rec.y, { ignore: rec.unit ? null : rec.id, maxZ: rec.z + STEP_UP });
      if (rec.floating) { /* a floater keeps its height */ } else { b.z = s.z; b.support = s.support; }
      if (rec.air) queueFall(state, b);
    }
    // Riders of sliding pieces come along, keeping their place on top.
    const carried = [];
    for (const rec of list) {
      if (rec.unit || rec.sphere) continue;
      const from = frames[0].p[rec.key];
      if (!from) continue;
      const dx = rec.x - from[0], dy = rec.y - from[1];
      if (dx === 0 && dy === 0) continue;
      for (const u of state.field.units) {
        if (u.dead || byKey.has(`u${u.id}`) || u.support?.kind !== 'prop' || u.support.id !== rec.id) continue;
        const nx = u.x + dx, ny = u.y + dy;
        const s = inBounds(arena, nx, ny) ? surfaceAt(state, nx, ny) : null;
        if (s && s.support.kind === 'prop' && s.support.id === rec.id) {
          const off = [u.x - from[0], u.y - from[1]];
          u.x = nx; u.y = ny; u.z = s.z; u.support = s.support;
          carried.push({ key: `u${u.id}`, on: rec.key, off, z: s.z - rec.z });
          fx(state, 'carry', { id: u.id, on: rec.id, mm: isqrt(dx * dx + dy * dy), from: { x: nx - dx, y: ny - dy, z: u.z }, to: { x: nx, y: ny, z: s.z } });
        } else { queueFall(state, u); fx(state, 'scraped', { id: u.id, off: rec.id }); }
      }
    }
    recheckSupport(state);
    resolveFalls(state, hurt);

    // What the first body did.
    let mm = 0;
    if (first) {
      mm = isqrt(dist2(start.x, start.y, first.x, first.y));
      const hit = events.find((e) => e.key === first.key && (e.kind === 'hit' || e.kind === 'wall' || e.kind === 'ward'));
      if (hit) blockedBy = hit.kind === 'hit' ? { kind: hit.into[0] === 'u' ? 'unit' : 'prop', id: hit.into[0] === 'u' ? Number(hit.into.slice(1)) : hit.into.slice(1) } : { kind: hit.kind };
    }

    // THE NOTE, ahead of everything it caused.
    if (!state.replaying) {
      const bodies = list.map((r) => ({ key: r.key, body: r.unit ? 'unit' : 'prop', id: r.id, r: r.r, h: r.h, sphere: r.sphere, mass: r.m }));
      const dyn = { kind: 'dyn', hz: HZ / FRAME_EVERY, ms: idiv(t * 1000, HZ), bodies, frames, events, carried };
      (state.fx ||= []).splice(fxStart, 0, dyn);
    }
    return { mm, blockedBy, steps: t, events };
  }

  return { launch, run, get, events };
}

/**
 * Throw a body along a bearing with `force`. The one entry point every push
 * in the game uses: Shift's drag, a quake, a rock hurled by a meteor.
 *
 *   mm        exact flat travel instead of the force (the drift harness,
 *             momentum handed on by an older caller)
 *   lift      launched upward this much as well (Skyfall, a levitating push)
 *   air       it is already off the ground (its z was raised by the caller)
 */
export function throwBody(state, body, dir, force, {
  byP = null, crush = false, mm = null, lift = 0, air = false, cap = null,
} = {}) {
  if (!body || body.dead || body.destroyed) return { mm: 0, blockedBy: null, steps: 0, events: [] };
  const sim = createSim(state, { byP, crush });
  const rec = sim.get(body);
  rec.hit = 1;
  let travel = mm !== null ? mm : travelFor(force, rec.m);
  if (cap !== null) travel = imin(travel, imax(0, cap));
  const vz = lift > 0 ? isqrt(2 * G * lift) : 0;
  // Thrown UP as well: nothing slows it in the air, so the printed travel is
  // covered in flight -- speed = travel / time aloft (2 vz / g).
  const v = vz > 0 ? idiv(travel * G, 2 * vz) : speedForTravel(rec, travel);
  if (v <= 0 && vz <= 0) return { mm: 0, blockedBy: null, steps: 0, events: [] };
  const [ux, uy] = DIR64[dir & 63];
  sim.launch(body, idiv(ux * v, DIR_SCALE), idiv(uy * v, DIR_SCALE), vz, { air });
  return sim.run();
}
