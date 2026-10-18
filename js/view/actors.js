// The bodies on the field: a rigged, animated mage.
//
// An actor owns a scene-graph root and knows how to walk, cast, take a hit,
// strike, be thrown and die. It never reads game state: the arena tells it
// where to be and what just happened, and it moves itself there with the
// right animation. Positions here are scene metres.
//
// The mage is the KayKit Adventurers Mage (CC0). Its single texture is a
// palette of 8x4 gradient swatches: the hat, robe and sleeves all map onto one
// purple swatch, the cape onto a magenta one, the hat band and belt onto an
// orange one, the staff's crystal onto a green one. Team colours are made by
// repainting those four swatches, so
// the whole outfit reads as "the blue mage" from ten metres and still shades
// like the pack's own art up close.
//
// The model faces +Z in its own frame, so `root.rotation.y = 0` looks down +Z
// and the arena's facing convention needs no correction.

import * as THREE from 'three';
import { clone } from './assets.js';

/* ------------------------------------------------------------ the mage */

// Hat tip at ~1.95 m (the rig is 2.68 m tall at scale 1).
const MAGE_SCALE = 0.725;

// Every clip the mage uses, by the name it has in the GLB.
const CLIPS = {
  idle: 'Idle',
  fidget: 'Spellcasting',
  walk: 'Walking_A',
  run: 'Running_A',
  castShoot: 'Spellcast_Shoot',
  castRaise: 'Spellcast_Raise',
  castLong: 'Spellcast_Long',
  hitA: 'Hit_A',
  hitB: 'Hit_B',
  strike: '2H_Melee_Attack_Slice',
  spin: '2H_Melee_Attack_Spin',
  jumpStart: 'Jump_Start',
  jumpIdle: 'Jump_Idle',
  jumpLand: 'Jump_Land',
  death: 'Death_A',        // lands on the back, where Lie_StandUp picks up from
  standUp: 'Lie_StandUp',
  cheer: 'Cheer',
};

// Walking_A covers ~1.6 m per cycle, Running_A ~3.6 m; scale the clips so the
// feet roughly keep up with the ground without going cartoonish.
const WALK_STRIDE = 1.6, RUN_STRIDE = 3.6;
const RUN_SPEED = 3;

/* ------------------------------------------------- team-coloured skins */

// Palette swatches, in texture pixels (1024x1024, 8 columns x 4 rows).
const SW = 128, SH = 256;
const SWATCHES = {
  outfit: { x: 0, y: SH, w: SW * 2 },   // hat, robe, sleeves (c0r1 + c1r1)
  cape: { x: SW * 2, y: SH, w: SW },    // the cape (c2r1)
  trim: { x: SW * 5, y: 0, w: SW },     // hat band, belt (c5r0)
  gem: { x: SW * 6, y: SH * 2, w: SW },  // the staff's crystal (c6r2)
};
const skins = new Map();   // "team:teamDark" -> {material, capeMaterial}
const tmpCol = new THREE.Color();

function gradient(ctx, x, y, w, h, hex, top = 0.22, bottom = -0.42) {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  const c = tmpCol.setHex(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  const stop = (k, l) => `hsl(${(hsl.h * 360).toFixed(1)} ${(hsl.s * 100).toFixed(1)}% ${(Math.min(1, Math.max(0.04, hsl.l + l)) * 100).toFixed(1)}%)`;
  g.addColorStop(0, stop(0, top));
  g.addColorStop(0.55, stop(0.55, (top + bottom) * 0.35));
  g.addColorStop(1, stop(1, bottom));
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
}

/** The pack's texture with the three outfit swatches repainted for a team. */
function teamSkin(baseMat, team, teamDark) {
  const key = `${team}:${teamDark}`;
  if (skins.has(key)) return skins.get(key);
  const src = baseMat.map;
  const img = src.image;
  const canvas = document.createElement('canvas');
  canvas.width = img.width || 1024; canvas.height = img.height || 1024;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const kx = canvas.width / 1024, ky = canvas.height / 1024;
  gradient(ctx, SWATCHES.outfit.x * kx, SWATCHES.outfit.y * ky, SWATCHES.outfit.w * kx, SH * ky, team, 0.16, -0.36);
  gradient(ctx, SWATCHES.cape.x * kx, SWATCHES.cape.y * ky, SWATCHES.cape.w * kx, SH * ky, team, 0.08, -0.34);
  gradient(ctx, SWATCHES.trim.x * kx, SWATCHES.trim.y * ky, SWATCHES.trim.w * kx, SH * ky, teamDark, 0.12, -0.1);
  gradient(ctx, SWATCHES.gem.x * kx, SWATCHES.gem.y * ky, SWATCHES.gem.w * kx, SH * ky, team, 0.3, -0.05);
  const map = new THREE.CanvasTexture(canvas);
  map.flipY = src.flipY;
  map.colorSpace = THREE.SRGBColorSpace;
  map.magFilter = THREE.NearestFilter;
  map.minFilter = THREE.LinearMipMapLinearFilter;
  map.anisotropy = 4;
  map.wrapS = src.wrapS; map.wrapT = src.wrapT;
  const material = new THREE.MeshStandardMaterial({ map, roughness: 0.92, metalness: 0 });
  const capeMaterial = material.clone();
  capeMaterial.side = THREE.DoubleSide;
  const skin = { material, capeMaterial };
  skins.set(key, skin);
  return skin;
}

/* ------------------------------------------------------------ actor */

export function makeMageActor(gltf, { team = 0x4fd2ff, teamDark = 0x1d4e78 } = {}) {
  const root = new THREE.Group();
  const model = clone(gltf, { rigged: true });
  model.scale.setScalar(MAGE_SCALE);
  root.add(model);

  // The pack ships every weapon it knows; this mage carries a staff. The
  // outfit is repainted in the team's colours once per team, then shared.
  let staff = null, baseMat = null;
  model.traverse((o) => { if (o.isMesh && o.material?.map && !baseMat) baseMat = o.material; });
  const skin = baseMat ? teamSkin(baseMat, team, teamDark) : null;
  model.traverse((o) => {
    if (o.name === '1H_Wand' || o.name === 'Spellbook' || o.name === 'Spellbook_open') o.visible = false;
    if (o.name === '2H_Staff') staff = o;
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = false;
      o.frustumCulled = false;    // skinned bounds lag the pose; never let a cast clip
      if (skin) o.material = o.name === 'Mage_Cape' ? skin.capeMaterial : skin.material;
    }
  });

  // The staff's crystal is the team's colour; inside it sits a lit orb: a hot
  // white core, a soft additive halo and a point light. `handPoint()` is the
  // orb, so bolts leave from the crystal. The staff is a child of the right
  // hand, so all of it moves with every cast. (Sizes are in the staff's own
  // frame, before the model scale.)
  const orb = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 10), new THREE.MeshBasicMaterial({ color: tmpCol.setHex(team).lerp(new THREE.Color(0xffffff), 0.6).getHex() }));
  const halo = new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 12), new THREE.MeshBasicMaterial({ color: team, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
  orb.add(halo);
  const orbLight = new THREE.PointLight(team, 2.4, 3.2, 2);
  orb.add(orbLight);
  if (staff) { orb.position.set(0.04, 1.05, 0); staff.add(orb); }
  else { orb.position.set(0.3, 1.9, 0.1); model.add(orb); }

  /* ------------------------------------------------- animation */
  const mixer = new THREE.AnimationMixer(model);
  const actions = {};
  for (const [key, name] of Object.entries(CLIPS)) {
    const clip = gltf.animations.find((c) => c.name === name);
    if (clip) actions[key] = mixer.clipAction(clip);
  }
  const durOf = (key) => actions[key]?.getClip().duration ?? 0;

  let current = null;
  /** Crossfade to a clip. A looping clip that is already up keeps playing. */
  function play(key, { loop = true, fade = 0.2, speed = 1, clamp = false, reps = Infinity } = {}) {
    const a = actions[key] || actions.idle;
    if (!a) return null;
    if (current === a && loop && reps === Infinity && a.isRunning()) { a.timeScale = speed; return a; }
    const restart = current === a;
    a.reset();
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, reps);
    // Anything that ends must hold its last frame until the next clip fades
    // in; otherwise the mixer drops it to the bind pose for a frame.
    a.clampWhenFinished = clamp || !loop || reps !== Infinity;
    a.timeScale = speed;
    a.enabled = true;
    a.setEffectiveWeight(1);
    if (restart) { /* same clip again (a second hit): snap to its start, no dip to weight 0 */ }
    else if (current) a.crossFadeFrom(current, fade, false);
    else a.fadeIn(fade);
    a.play();
    current = a;
    return a;
  }

  // A one-shot (or a queued chain of them) owns the body until `busyUntil`;
  // then locomotion takes over again. Steps: {key, speed, fade, loop, dur,
  // clamp, hold}. `dur` is seconds of real time; a looping step with `air`
  // set keeps going while the actor is still in the air.
  const queue = [];
  let busyUntil = 0;
  let step = null;
  function startStep(s, now) {
    step = s;
    const a = play(s.key, { loop: !!s.loop, fade: s.fade ?? 0.12, speed: s.speed ?? 1, clamp: !!s.clamp, reps: s.reps ?? Infinity });
    const dur = s.dur ?? (a ? durOf(s.key) / (s.speed ?? 1) * (s.reps && s.reps !== Infinity ? s.reps : 1) : 0);
    busyUntil = now + (dur + (s.hold ?? 0)) * 1000;
    return dur;
  }
  function run(steps, now = performance.now()) {
    queue.length = 0;
    for (let i = 1; i < steps.length; i++) queue.push(steps[i]);
    return startStep(steps[0], now);
  }
  /** Play one clip once, then go back to idle/walk. Returns its seconds. */
  function oneShot(key, { speed = 1, hold = 0, clamp = false, fade = 0.12 } = {}) {
    return run([{ key, speed, hold, clamp, fade }]);
  }

  let hitFlip = false;
  let fidgetAt = 0;
  let locoKey = null;

  function locomotion(now, dt) {
    if (actor.moving) {
      const running = actor.speed > RUN_SPEED;
      const key = running ? 'run' : 'walk';
      const stride = running ? RUN_STRIDE : WALK_STRIDE;
      const speed = THREE.MathUtils.clamp(actor.speed * durOf(key) / stride, 0.85, 1.6);
      play(key, { speed, fade: locoKey ? 0.18 : 0.24 });
      locoKey = key;
      fidgetAt = now + 6000 + Math.random() * 6000;
      return;
    }
    if (locoKey !== 'idle') { play('idle', { fade: 0.28 }); locoKey = 'idle'; fidgetAt = now + 5000 + Math.random() * 7000; return; }
    if (now > fidgetAt && actions.fidget) {
      // Every so often the idle mage turns a little magic over in his hands.
      run([{ key: 'fidget', loop: true, reps: 2, speed: 0.85, fade: 0.45 }], now);
      locoKey = null;
      fidgetAt = now + 9000 + Math.random() * 9000;
    }
  }

  const actor = {
    kind: 'mage', root, model, mixer, orb, height: 1.95, dead: false,
    target: null, moving: false, speed: 2.6, facing: 0, facingTarget: 0, airY: 0,
    play, oneShot,
    update(dt, now) {
      mixer.update(dt);
      if (step && now >= busyUntil) {
        // Hang in the air until the arena brings us down.
        if (step.air && this.airY > 0.04 && now < busyUntil + 2500) busyUntil = now + 1;
        else if (queue.length) startStep(queue.shift(), now);
        else { step = null; locoKey = null; }
      }
      if (!this.dead && !step) locomotion(now, dt);
      // Turn the short way round toward where we are going or looking.
      let d = this.facingTarget - this.facing;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.facing += d * Math.min(1, dt * 9);
      root.rotation.y = this.facing;
      const pulse = Math.sin(now / 260);
      orb.scale.setScalar(1 + pulse * 0.1);
      halo.scale.setScalar(1 + Math.sin(now / 170 + 1) * 0.16);
      orbLight.intensity = 2.2 + pulse * 0.5;
    },
    lookAt(x, z) { this.facingTarget = Math.atan2(x - root.position.x, z - root.position.z); },
    /** A spell: 'shoot' is a quick bolt, 'raise' a big area spell, 'long' a ritual. */
    cast(kind = 'shoot') {
      if (this.dead) return;
      if (kind === 'raise') return run([{ key: 'castRaise', speed: 1.35, fade: 0.14 }]);
      if (kind === 'long') return run([{ key: 'castLong', speed: 1.2, fade: 0.18 }]);
      return run([{ key: 'castShoot', speed: 1.25, fade: 0.08 }]);
    },
    hit() {
      if (this.dead) return;
      hitFlip = !hitFlip;
      run([{ key: hitFlip ? 'hitA' : 'hitB', speed: 1.35, fade: 0.06 }]);
    },
    strike() { if (!this.dead) run([{ key: 'strike', speed: 1.2, fade: 0.1 }]); },
    summon() { if (!this.dead) run([{ key: 'castLong', speed: 1.15, fade: 0.18 }]); },
    /** Hurled into the air for `air` seconds: crouch-and-leap, hang, land. */
    jump(air = 0.95) {
      if (this.dead) return;
      const up = 0.32, land = 0.5;
      run([
        { key: 'jumpStart', speed: durOf('jumpStart') / up, fade: 0.06 },
        { key: 'jumpIdle', loop: true, speed: 1, fade: 0.12, dur: Math.max(0.1, air - up - land * 0.4), air: true },
        { key: 'jumpLand', speed: durOf('jumpLand') / land, fade: 0.08 },
      ]);
    },
    cheer() { if (!this.dead) run([{ key: 'cheer', loop: true, reps: 3, speed: 1.1, fade: 0.2 }]); },
    die() {
      this.dead = true; this.moving = false;
      run([{ key: 'death', speed: 0.95, clamp: true, fade: 0.08 }]);
      busyUntil = Infinity;
    },
    /** Back from the dead: get up off the floor, then stand ready. */
    revive() {
      this.dead = false;
      if (actions.standUp) run([{ key: 'standUp', speed: 1.5, fade: 0.25 }]);
      else { step = null; locoKey = null; play('idle', { fade: 0.4 }); }
    },
    /** Where a bolt leaves from, in world space. */
    handPoint(out = new THREE.Vector3()) { orb.getWorldPosition(out); return out; },
    dispose() { mixer.stopAllAction(); root.removeFromParent(); },
  };
  play('idle', { fade: 0 });
  locoKey = 'idle';
  fidgetAt = performance.now() + 4000 + Math.random() * 6000;
  return actor;
}
