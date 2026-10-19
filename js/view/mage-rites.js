// The mage's last rites, and its first: what the arena shows when a mage
// dies and when it comes back.
//
// Death: the body falls (the mage's own `death` clip), lies still for a
// moment, then goes to dust: the dissolve front (mage.js) sweeps it feet to
// head while ash motes stream off the front and blow away downwind. When the
// last of it is gone the caller removes the actor.
//
// Respawn: nothing of the mage shows at first. Magic gathers on its circle,
// motes converging and rising into a swelling glow over the team sigil, then
// a flash, and the body forms (the dissolve run backwards, its rim lit) and
// stands up.
//
// Everything is driven by the caller's clock (`deathStep` takes the seconds
// since `die()`); the gather rides fx's tween clock. Both the arena and the
// mage lab use this, so the sequence lives in one place.

import * as THREE from 'three';

/** One wind for the whole arena: dust leaves along +x, drifting a little to +z. */
export const WIND = new THREE.Vector3(1, 0, 0.22).normalize();
/** Seconds the body lies still after the death clip, then how long the dust takes. */
export const DEATH_STILL = 0.8, DEATH_DISSOLVE = 1.2;
/** Seconds the magic gathers before the body shows, then how long it takes to form. */
export const GATHER_DUR = 1.0, FORM_DUR = 0.6;

const ASH = 0x9a948c, ASH_DARK = 0x66615b;

export function createMageRites(fx) {
  const soft = fx.pools.soft, stars = fx.pools.stars, dust = fx.pools.dust, smoke = fx.pools.smoke;

  /**
   * Advance a dead mage: `t` is the time since `actor.die()`. Returns true
   * once the body is entirely gone (remove the actor then).
   */
  function deathStep(actor, t, dt) {
    const t0 = actor.deathClipDur + DEATH_STILL;
    if (t < t0) return false;
    const k = Math.min(1, (t - t0) / DEATH_DISSOLVE);
    actor.setDissolve(k);
    if (k >= 1) return true;
    // Ash off the front, carried downwind with a little lift and spread.
    const pts = actor.dissolveFront(Math.round(dt * 140) + 1);
    for (const p of pts) {
      dust.emit({ x: p.x, y: p.y, z: p.z, n: 1, spread: 0.03, vx: WIND.x * 1.5, vy: 0.45, vz: WIND.z * 1.5, vspread: 0.35, vspreadY: 0.3,
        life: 1.7, lifeSpread: 0.6, size: 0.07, sizeEnd: 0.17, sizeJitter: 0.6, color: ASH, colorEnd: ASH_DARK, colorJitter: 0.3, alpha: 0.55, fade: 2,
        gravity: -0.15, drag: 0.25, turb: 0.5, rotJitter: 3.14, spinJitter: 1.2 });
    }
    // Now and then a wisp of finer ash that hangs and thins.
    if (pts.length && Math.random() < 0.45) {
      const p = pts[0];
      smoke.emit({ x: p.x, y: p.y + 0.05, z: p.z, n: 1, vx: WIND.x * 1.1, vy: 0.3, vz: WIND.z * 1.1, vspread: 0.2, life: 1.9, lifeSpread: 0.5,
        size: 0.2, sizeEnd: 0.55, color: 0x8c8780, colorEnd: 0x6c6862, alpha: 0.16, fade: 1, drag: 0.3, turb: 0.4, rotJitter: 3.14, spinJitter: 0.6 });
    }
    return false;
  }

  /**
   * Magic forms on the circle at (x, y, z) in `colour`; `onAppear` fires
   * when the body should show. Returns a handle with `cancel()`.
   */
  function gather(x, y, z, colour, { dur = GATHER_DUR, onAppear = null } = {}) {
    fx.sigil(x, y, z, colour, { dur: dur + FORM_DUR + 0.6, r: 1.1 });
    let live = true, acc = 0;
    fx.tween(dur, (t, dt) => {
      if (!live) return;
      // Motes converge from a ring round the circle, rising as they come,
      // thicker as the moment nears; each one is aimed to arrive somewhere
      // up the body's height.
      acc += dt * (28 + 110 * t);
      while (acc >= 1) {
        acc -= 1;
        const ang = Math.random() * 6.283, rr = 1.0 + Math.random() * 0.9;
        const px = x + Math.cos(ang) * rr, pz = z + Math.sin(ang) * rr, py = y + Math.random() * 0.35;
        const life = 0.5 + Math.random() * 0.25;
        const ty = y + 0.25 + Math.random() * 1.3;
        const v = { vx: (x - px) / life, vy: (ty - py) / life, vz: (z - pz) / life };
        soft.emit({ x: px, y: py, z: pz, n: 1, ...v, life, size: 0.1, sizeEnd: 0.03, color: colour, alpha: 0.9, fade: 2 });
        if (Math.random() < 0.25) stars.emit({ x: px, y: py, z: pz, n: 1, ...v, life, size: 0.18, sizeEnd: 0.05, color: colour, alpha: 1, fade: 3, spinJitter: 2 });
      }
      // A glow at the heart of it, swelling as the motes arrive.
      soft.emit({ x, y: y + 0.45 + t * 0.45, z, n: 1, size: 0.3 + t * 1.4, life: 0.12, color: colour, alpha: 0.22 + t * 0.45, fade: 0 });
    }, () => {
      if (!live) return;
      live = false;
      fx.flash(x, y + 1.0, z, 0xffffff, 11, 0.35, 6);
      fx.burst(x, y + 0.3, z, colour, { n: 34, r: 0.6, up: 1.8 });
      onAppear?.();
    });
    return { cancel() { live = false; } };
  }

  /**
   * The body forms where the actor stands (hidden, already placed): shown
   * with its rim lit in the team colour, the dissolve runs back head to feet,
   * and the mage gets up.
   */
  function materialise(actor, colour, { dur = FORM_DUR } = {}) {
    const tint = new THREE.Color(colour).lerp(new THREE.Color(0xffffff), 0.5).getHex();
    actor.setHidden(false);
    actor.setDissolve(1, { tint, glow: 2.5 });
    actor.revive();
    fx.tween(dur, (t) => { actor.setDissolve(1 - t, { tint, glow: 2.5 * (1 - t * 0.5) }); }, () => actor.setDissolve(0));
  }

  return { deathStep, gather, materialise };
}
