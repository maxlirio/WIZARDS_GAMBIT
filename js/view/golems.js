// Golems, built out of rock.
//
// There is no golem model; each one is assembled from the boulder bakes (and,
// for the Glass Sentinel, from crystal shards generated here) -- a pelvis, a
// torso, a head, limbs on pivots -- and animated in code. The arena drives it
// through the same actor API the mage has (see mage.js): it sets
// `root.position`, `moving` and `facingTarget`, and calls `update(dt, now)`
// each frame. `root.rotation.y` is the facing (0 = facing +Z); the ground is
// y = 0 of `root`; everything is in metres.
//
// Animation is layered, not switched, so nothing pops: an idle layer (breath,
// head turns, weight shifts, core pulse) is always on; a walk layer is scaled
// by a smoothed `walkK`; and actions (strike, hit, rise, jump, cast) are
// keyframe tracks that start and end at zero and are ADDED to the pose for
// their duration, so two can overlap and any of them can land mid-walk.
//
// DEATH: the actor owns it (`actor.ownsDeath === true`). `die()` detaches every
// rock into root space, throws them apart from the core, lets them fall,
// bounce once and settle, darkens the core and eyes, and fades the whole thing
// out after 2.6 s. `actor.parts` is emptied at that moment, so an arena that
// still runs its own tumble over `parts` finds nothing to move. `revive()`
// puts the rocks back on their pivots and plays the rise.

import * as THREE from '../../vendor/three/three.module.js';
import { pickLod } from './assets.js';

const TAU = Math.PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOutCubic = (u) => 1 - Math.pow(1 - u, 3);

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
let instanceN = 0;

/**
 * A keyframe track: [[k, value], ...] with k in 0..1, smoothstepped between
 * keys. Every action track starts and ends at 0 so it blends in and out.
 */
function track(k, keys) {
  if (k <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const t1 = keys[i][0];
    if (k <= t1) {
      const t0 = keys[i - 1][0], v0 = keys[i - 1][1], v1 = keys[i][1];
      const u = (k - t0) / (t1 - t0);
      return v0 + (v1 - v0) * u * u * (3 - 2 * u);
    }
  }
  return keys[keys.length - 1][1];
}

/* ------------------------------------------------------------- parts */

/**
 * A boulder model, pre-rotated by one of a few fixed rotations (so the same
 * bake yields differently shaped lumps), centred, and normalised to a UNIT
 * BOX per axis: a limb is then "a rock filling this box" and nothing has to
 * know how the bake was sized.
 */
const VARIANTS = [[0, 0, 0], [0, 1.7, 0], [0.4, 0.9, 0.2], [0, 3.3, 0.35], [1.57, 0, 0.5], [0.2, 4.4, 1.57]];
const partCache = new Map();
const cleanGeo = new Map();
/**
 * The bakes carry tufts of grass as flat cards: long thin triangles whose
 * vertex normals equal the face normal, where every rock facet has smoothed
 * normals. A golem's limb has no grass on it, so those cards are dropped.
 */
function stripSlivers(geo) {
  if (cleanGeo.has(geo)) return cleanGeo.get(geo);
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.attributes.position, nrm = g.attributes.normal;
  const n = pos.count / 3;
  const keep = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3(), fn = new THREE.Vector3(), vn = new THREE.Vector3();
  for (let t = 0; t < n; t++) {
    a.fromBufferAttribute(pos, t * 3); b.fromBufferAttribute(pos, t * 3 + 1); c.fromBufferAttribute(pos, t * 3 + 2);
    fn.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
    const area = fn.length() / 2;
    const mx = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
    const asp = area / (mx * mx);
    let flat = true;
    if (nrm) {
      fn.normalize();
      vn.set(0, 0, 0);
      for (let k = 0; k < 3; k++) { ab.fromBufferAttribute(nrm, t * 3 + k); vn.add(ab); }
      flat = Math.abs(fn.dot(vn.normalize())) > 0.985;
    }
    if (!(asp < 0.13 && flat) && asp >= 0.03) keep.push(t);
  }
  let out = g;
  if (keep.length !== n) {
    out = new THREE.BufferGeometry();
    for (const name in g.attributes) {
      const src = g.attributes[name], k = src.itemSize;
      const arr = new src.array.constructor(keep.length * 3 * k);
      keep.forEach((t, i) => { for (let v = 0; v < 3; v++) for (let j = 0; j < k; j++) arr[(i * 3 + v) * k + j] = src.array[(t * 3 + v) * k + j]; });
      out.setAttribute(name, new THREE.BufferAttribute(arr, k));
    }
  }
  cleanGeo.set(geo, out);
  return out;
}
/**
 * Returns {geometry, local}: the bake's (sliver-stripped) geometry and the
 * matrix that turns it into that unit box. A golem's rocks of one bake are
 * drawn as ONE instanced mesh, each instance = pivot's matrix * size * local.
 */
function rockPart(gltfs, which, variant = 0, lod = 2) {
  const key = `${which}:${variant}:${lod}`;
  if (partCache.has(key)) return partCache.get(key);
  const g = pickLod(gltfs[which], lod);
  let mesh = null;
  g.traverse((o) => { if (o.isMesh && !mesh) { o.geometry = stripSlivers(o.geometry); mesh = o; } });
  const rot = new THREE.Group();
  rot.rotation.set(...VARIANTS[variant % VARIANTS.length]);
  rot.add(g);
  const box = new THREE.Box3().setFromObject(rot);
  const size = new THREE.Vector3(); box.getSize(size);
  const centre = new THREE.Vector3(); box.getCenter(centre);
  rot.position.copy(centre).negate();
  const holder = new THREE.Group();
  holder.add(rot);
  holder.scale.set(1 / size.x, 1 / size.y, 1 / size.z);
  holder.updateMatrixWorld(true);
  const out = { geometry: mesh.geometry, local: mesh.matrixWorld.clone() };
  partCache.set(key, out);
  return out;
}

function bakeMaterial(gltfs, which) {
  let m = null;
  gltfs[which].scene.traverse((o) => { if (!m && o.isMesh) m = o.material; });
  return m;
}

/** A crystal shard: an irregular bipyramid filling a unit box, waist at `waist` (0..1 of the height). */
const shardCache = new Map();
function shardGeo(variant = 0, waist = 0.5) {
  const key = `${variant}:${waist}`;
  if (shardCache.has(key)) return shardCache.get(key);
  const rnd = mulberry32(900 + variant);
  const n = 5 + (variant % 3);
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rnd() * 0.5, r = 0.5 * (0.78 + rnd() * 0.44);
    ring.push([Math.cos(a) * r, waist - 0.5 + (rnd() - 0.5) * 0.12, Math.sin(a) * r]);
  }
  const top = [(rnd() - 0.5) * 0.16, 0.5, (rnd() - 0.5) * 0.16];
  const bot = [(rnd() - 0.5) * 0.1, -0.5, (rnd() - 0.5) * 0.1];
  const pos = [];
  const tri = (a, b, c) => {
    // Wind every face outward.
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3, cz = (a[2] + b[2] + c[2]) / 3;
    if (nx * cx + ny * (cy - (waist - 0.5)) + nz * cz < 0) pos.push(...a, ...c, ...b); else pos.push(...a, ...b, ...c);
  };
  for (let i = 0; i < n; i++) { tri(ring[i], ring[(i + 1) % n], top); tri(ring[i], ring[(i + 1) % n], bot); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  shardCache.set(key, geo);
  return geo;
}

/* ---------------------------------------------------------- textures */

let glowTex = null;
function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.2, 'rgba(255,255,255,0.6)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.14)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}
function glow(color, size, opacity = 0.8) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
  s.scale.set(size, size, 1);
  s.userData.size = size;
  s.userData.opacity = opacity;
  return s;
}

/** Glowing veins on black, used as an emissive map so cracks shine through the rock. */
let crackTex = null;
function crackTexture() {
  if (crackTex) return crackTex;
  const N = 512;
  const c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, N, N);
  g.lineCap = 'round'; g.lineJoin = 'round';
  const rnd = mulberry32(7);
  for (let i = 0; i < 18; i++) {
    let x = rnd() * N, y = rnd() * N, a = rnd() * TAU;
    const pts = [[x, y]];
    const segs = 6 + Math.floor(rnd() * 10);
    for (let s = 0; s < segs; s++) { a += (rnd() - 0.5) * 1.6; const L = 8 + rnd() * 24; x += Math.cos(a) * L; y += Math.sin(a) * L; pts.push([x, y]); }
    for (const [w, col] of [[6, 'rgba(255,80,20,0.3)'], [2.6, 'rgba(255,140,50,0.9)'], [1.0, '#fff2c0']]) {
      g.strokeStyle = col; g.lineWidth = w; g.beginPath();
      pts.forEach(([px, py], j) => (j ? g.lineTo(px, py) : g.moveTo(px, py)));
      g.stroke();
    }
  }
  crackTex = new THREE.CanvasTexture(c);
  crackTex.wrapS = crackTex.wrapT = THREE.RepeatWrapping;
  crackTex.colorSpace = THREE.SRGBColorSpace;
  return crackTex;
}

/* ------------------------------------------------------------- looks */

const LOOKS = {
  CLAY_HAND:      { kind: 'biped', tint: 0xd9a060, rough: 1.0, metal: 0, core: 0xffb347, height: 1.6, speed: 2.2 },
  STONE_WARDEN:   { kind: 'biped', tint: 0x9d9c98, rough: 0.95, metal: 0, core: 0x7fd4ff, height: 2.1, speed: 1.9 },
  IRON_COLOSSUS:  { kind: 'biped', tint: 0x6b7280, rough: 0.5, metal: 0.65, env: 2.0, core: 0xff5a2a, cracks: 0xff3a00, crackI: 0.3, height: 2.6, speed: 1.6 },
  SPARK_WISP:     { kind: 'wisp', core: 0xfff1a0, height: 1.5, speed: 3.4 },
  GLASS_SENTINEL: { kind: 'biped', glass: true, core: 0x5fd8ff, height: 2.25, speed: 2.2 },
  EMBER_HOUND:    { kind: 'hound', tint: 0x3a2b24, rough: 0.9, metal: 0, core: 0xff6a1a, cracks: 0xff4a10, crackI: 1.1, height: 1.15, speed: 3.2 },
  // Newer cards: their own colours on a peer's body plan (BODY_OF below).
  BOG_CRAWLER:    { kind: 'hound', tint: 0x3d4a2c, rough: 1.0, metal: 0, core: 0x9fe05a, cracks: 0x6fae2a, crackI: 0.6, height: 1.0, speed: 2.4 },
  GRANITE_RAM:    { kind: 'biped', tint: 0x7d7468, rough: 0.9, metal: 0.1, core: 0xffc04a, height: 2.0, speed: 2.1 },
  OBSIDIAN_TITAN: { kind: 'biped', tint: 0x1c1a22, rough: 0.25, metal: 0.4, env: 2.2, core: 0xb46bff, cracks: 0x9b4bff, crackI: 0.6, height: 2.5, speed: 1.7 },
};
/** Which body plan a newer golem borrows. */
const BODY_OF = { GRANITE_RAM: 'STONE_WARDEN', OBSIDIAN_TITAN: 'IRON_COLOSSUS' };

/* ------------------------------------------------------ biped specs */
// Sizes are [w, h, d] boxes in metres; `at` positions are relative to the
// pivot named in the comment. The REST pose (hunch, armX...) is what idle
// starts from; walk and actions add to it.

// A limb rock on a pivot: L is pivot-to-pivot; the rock runs 15% past the
// pivot into its parent so the joint reads as one body, not beads on a string.
const limb = (which, w, d, L, variant) => [which, [w, L * 1.2, d], [0, -L * 0.42, 0], variant];

const BIPEDS = {
  CLAY_HAND: {
    hipY: 0.64, pelvis: ['boulderB', [0.52, 0.34, 0.44], [0, 0.02, 0], 1],
    torsoPivotY: 0.12,
    torso: [['boulderC', [0.82, 0.66, 0.62], [0, 0.3, 0], 0], ['boulderA', [0.3, 0.22, 0.26], [0.26, 0.46, 0.14], 2], ['boulderA', [0.26, 0.2, 0.22], [-0.28, 0.2, 0.2], 3], ['boulderA', [0.4, 0.24, 0.32], [0.04, 0.56, -0.2], 1]],
    neck: [0, 0.5, 0.12], head: [['boulderA', [0.36, 0.3, 0.34], [0, 0.1, 0.02], 4]], eyes: [[-0.07, 0.0, 0.16], [0.07, 0.0, 0.16]], eyeR: 0.03,
    shoulder: [0.36, 0.5, 0.04], upper: limb('boulderA', 0.24, 0.24, 0.34, 2), upperLen: 0.34,
    fore: limb('boulderB', 0.26, 0.26, 0.36, 1), hand: ['boulderA', [0.42, 0.34, 0.4], [0, -0.4, 0.04], 5],
    hipW: 0.15, hipDrop: -0.04, thigh: limb('boulderA', 0.27, 0.28, 0.3, 3), thighLen: 0.3,
    shin: limb('boulderB', 0.26, 0.27, 0.29, 2), foot: ['boulderA', [0.3, 0.14, 0.36], [0, -0.26, 0.05], 0],
    legLen: 0.6, core: [0, 0.22, 0.3], coreR: 0.08, lightI: 2.0,
    hunch: 0.14, armX: -0.1, armZ: 0.2, elbowX: -0.3, legX: -0.12, kneeX: 0.24,
    lean: 0.1, bob: 0.035, stride: 0.5, kneeBend: 0.9, armSwing: 0.45, elbowSwing: 0.35, breathHz: 1.5, coreHz: 4,
    strike: 'punch',
  },
  STONE_WARDEN: {
    hipY: 0.88, pelvis: ['boulderB', [0.7, 0.4, 0.52], [0, 0.02, 0], 0],
    torsoPivotY: 0.14,
    torso: [['boulderC', [1.1, 0.84, 0.66], [0, 0.36, 0], 0], ['boulderB', [0.74, 0.34, 0.24], [0, 0.5, 0.26], 4], ['boulderA', [0.5, 0.32, 0.46], [0.44, 0.7, 0], 1], ['boulderA', [0.5, 0.32, 0.46], [-0.44, 0.7, 0], 3]],
    neck: [0, 0.72, 0.04], head: [['boulderA', [0.42, 0.36, 0.42], [0, 0.1, 0], 0], ['boulderB', [0.46, 0.14, 0.26], [0, 0.2, 0.12], 4]], eyes: [[-0.09, -0.02, 0.19], [0.09, -0.02, 0.19]], eyeR: 0.032,
    shoulder: [0.5, 0.62, 0.02], upper: limb('boulderA', 0.32, 0.32, 0.46, 2), upperLen: 0.46,
    fore: limb('boulderB', 0.34, 0.34, 0.46, 1), hand: ['boulderA', [0.32, 0.28, 0.32], [0, -0.5, 0.02], 5],
    hipW: 0.24, hipDrop: -0.04, thigh: limb('boulderA', 0.36, 0.38, 0.44, 3), thighLen: 0.44,
    shin: limb('boulderB', 0.34, 0.36, 0.4, 2), foot: ['boulderA', [0.38, 0.16, 0.48], [0, -0.36, 0.06], 0],
    legLen: 0.84, core: [0, 0.26, 0.33], coreR: 0.09, lightI: 2.2,
    hunch: 0.05, armX: -0.05, armZ: 0.22, elbowX: -0.25, legX: 0, kneeX: 0.08,
    shieldArm: { armX: -0.35, elbowX: -1.15, armZ: 0.05, swing: 0.3 },
    shield: ['boulderC', [0.8, 1.0, 0.14], [0, -0.5, 0.06], 0],
    lean: 0.08, bob: 0.045, stride: 0.45, kneeBend: 0.85, armSwing: 0.35, elbowSwing: 0.3, breathHz: 1.2, coreHz: 3,
    strike: 'bash',
  },
  IRON_COLOSSUS: {
    hipY: 1.0, pelvis: ['boulderB', [1.0, 0.54, 0.78], [0, 0.02, 0], 0],
    torsoPivotY: 0.18,
    torso: [['boulderC', [1.8, 1.3, 1.15], [0, 0.55, 0.1], 0], ['boulderC', [1.3, 0.7, 0.9], [0, 1.0, -0.2], 1], ['boulderA', [0.84, 0.56, 0.8], [0.8, 0.95, 0.1], 2], ['boulderA', [0.84, 0.56, 0.8], [-0.8, 0.95, 0.1], 3], ['boulderB', [0.6, 0.54, 0.24], [0.5, 0.5, 0.58], 4], ['boulderB', [0.6, 0.54, 0.24], [-0.5, 0.5, 0.58], 4]],
    neck: [0, 0.95, 0.55], head: [['boulderA', [0.56, 0.46, 0.56], [0, 0.1, 0.12], 0]], eyes: [[-0.12, 0.0, 0.3], [0.12, 0.0, 0.3]], eyeR: 0.045,
    shoulder: [0.86, 0.92, 0.12], upper: limb('boulderA', 0.52, 0.52, 0.8, 2), upperLen: 0.8,
    fore: limb('boulderB', 0.58, 0.58, 0.9, 1), hand: ['boulderA', [0.66, 0.52, 0.66], [0, -0.92, 0.04], 5],
    hipW: 0.36, hipDrop: -0.08, thigh: limb('boulderA', 0.54, 0.56, 0.5, 3), thighLen: 0.5,
    shin: limb('boulderB', 0.52, 0.54, 0.42, 2), foot: ['boulderA', [0.56, 0.24, 0.72], [0, -0.34, 0.08], 0],
    legLen: 0.92, core: [0, 0.42, 0.62], coreR: 0.15, lightI: 3.0,
    hunch: 0.32, armX: -0.3, armZ: 0.16, elbowX: -0.15, legX: -0.05, kneeX: 0.1,
    lean: 0.08, bob: 0.06, stride: 0.4, kneeBend: 0.7, armSwing: 0.22, elbowSwing: 0.2, breathHz: 0.8, coreHz: 2.2,
    strike: 'slam',
  },
  GLASS_SENTINEL: {
    shards: true,
    hipY: 1.0, pelvis: ['shard', [0.36, 0.3, 0.26], [0, 0, 0], 0, 0.5],
    torsoPivotY: 0.14,
    torso: [['shard', [0.6, 0.72, 0.36], [0, 0.3, 0], 1, 0.74], ['shard', [0.14, 0.52, 0.14], [0.42, 0.78, 0], 2, 0.6, [0, 0, -0.55]], ['shard', [0.14, 0.52, 0.14], [-0.42, 0.78, 0], 3, 0.6, [0, 0, 0.55]]],
    neck: [0, 0.9, 0], head: [['shard', [0.26, 0.4, 0.26], [0, 0.04, 0], 4, 0.6]], eyes: [[-0.06, -0.02, 0.12], [0.06, -0.02, 0.12]], eyeR: 0.025,
    shoulder: [0.38, 0.54, 0], upper: ['shard', [0.15, 0.56, 0.15], [0, -0.24, 0], 5, 0.55], upperLen: 0.52,
    fore: ['shard', [0.13, 0.54, 0.13], [0, -0.23, 0], 6, 0.5], hand: ['shard', [0.17, 0.3, 0.17], [0, -0.62, 0], 7, 0.5],
    hipW: 0.17, hipDrop: -0.05, thigh: ['shard', [0.17, 0.58, 0.17], [0, -0.24, 0], 8, 0.5], thighLen: 0.5,
    shin: ['shard', [0.14, 0.5, 0.14], [0, -0.2, 0], 9, 0.45], foot: null,
    legLen: 0.95, core: [0, 0.3, 0], coreR: 0.11, lightI: 2.4,
    hunch: 0, armX: -0.1, armZ: 0.16, elbowX: -0.2, legX: 0, kneeX: 0.05,
    lean: 0.04, bob: 0.02, stride: 0.5, kneeBend: 0.8, armSwing: 0.25, elbowSwing: 0.25, breathHz: 1.0, coreHz: 3.5,
    orbiters: 3, strike: 'thrust',
  },
};

/* ------------------------------------------------------ action tracks */
// Every track starts and ends at 0; k runs 0..1 over `dur` seconds.

const sides = (ch, keys) => ({ [ch + '0']: keys, [ch + '1']: keys });

const BIPED_ACTS = {
  hit: { dur: 0.5, tracks: {
    tx: [[0, 0], [0.15, -0.42], [0.5, -0.18], [1, 0]], nx: [[0, 0], [0.12, -0.45], [1, 0]], hx: [[0, 0], [0.2, -0.15], [1, 0]],
    ...sides('ax', [[0, 0], [0.15, -1.1], [1, 0]]), ...sides('az', [[0, 0], [0.15, 0.6], [1, 0]]), ...sides('ex', [[0, 0], [0.15, -0.5], [1, 0]]),
    bz: [[0, 0], [0.25, -0.22], [1, 0]], hy: [[0, 0], [0.3, -0.06], [1, 0]], ...sides('kx', [[0, 0], [0.3, 0.3], [1, 0]]), ...sides('lx', [[0, 0], [0.3, -0.15], [1, 0]]),
    core: [[0, 0], [0.1, -0.6], [0.3, 0.3], [1, 0]] } },
  slam: { dur: 1.3, tracks: {
    ...sides('ax', [[0, 0], [0.4, -2.8], [0.52, -0.55], [0.75, -0.55], [1, 0]]), ...sides('ex', [[0, 0], [0.4, -1.0], [0.52, -0.1], [0.75, -0.1], [1, 0]]), ...sides('az', [[0, 0], [0.4, 0.3], [0.52, -0.1], [0.75, -0.1], [1, 0]]),
    tx: [[0, 0], [0.4, -0.35], [0.52, 0.55], [0.75, 0.5], [1, 0]], hy: [[0, 0], [0.4, 0.05], [0.52, -0.2], [0.75, -0.2], [1, 0]],
    ...sides('kx', [[0, 0], [0.52, 0.4], [0.75, 0.4], [1, 0]]), ...sides('lx', [[0, 0], [0.52, -0.2], [0.75, -0.2], [1, 0]]),
    bz: [[0, 0], [0.4, -0.12], [0.52, 0.28], [0.75, 0.28], [1, 0]], nx: [[0, 0], [0.4, -0.35], [0.52, 0.3], [0.75, 0.3], [1, 0]],
    core: [[0, 0], [0.42, 0.2], [0.5, 1], [0.65, 0.3], [1, 0]] } },
  punch: { dur: 0.8, tracks: {
    ty: [[0, 0], [0.35, 0.7], [0.5, -0.55], [0.75, -0.45], [1, 0]], hyaw: [[0, 0], [0.35, 0.3], [0.5, -0.3], [1, 0]],
    ax1: [[0, 0], [0.35, 0.9], [0.5, -1.65], [0.75, -1.45], [1, 0]], ex1: [[0, 0], [0.35, -1.2], [0.5, -0.25], [0.75, -0.3], [1, 0]], az1: [[0, 0], [0.35, 0.5], [0.5, 0.1], [1, 0]],
    ax0: [[0, 0], [0.35, -0.6], [0.5, 0.45], [1, 0]], ex0: [[0, 0], [0.35, -0.9], [0.5, -0.4], [1, 0]],
    tx: [[0, 0], [0.35, -0.2], [0.5, 0.35], [0.75, 0.3], [1, 0]], bz: [[0, 0], [0.35, -0.1], [0.5, 0.3], [0.75, 0.25], [1, 0]],
    lx1: [[0, 0], [0.5, 0.35], [1, 0]], lx0: [[0, 0], [0.5, -0.4], [1, 0]], kx0: [[0, 0], [0.5, 0.4], [1, 0]],
    core: [[0, 0], [0.45, 0.8], [0.7, 0], [1, 0]] } },
  bash: { dur: 0.9, tracks: {
    ax0: [[0, 0], [0.35, 0.5], [0.5, -1.3], [0.75, -1.2], [1, 0]], ex0: [[0, 0], [0.35, -0.3], [0.5, 0.55], [0.75, 0.5], [1, 0]],
    ty: [[0, 0], [0.35, -0.5], [0.5, 0.45], [0.75, 0.4], [1, 0]], tx: [[0, 0], [0.35, -0.2], [0.5, 0.4], [0.75, 0.35], [1, 0]],
    bz: [[0, 0], [0.35, -0.15], [0.5, 0.4], [0.75, 0.35], [1, 0]], hy: [[0, 0], [0.5, -0.12], [0.75, -0.1], [1, 0]],
    ax1: [[0, 0], [0.35, -0.5], [0.5, 0.8], [0.75, 0.7], [1, 0]], ex1: [[0, 0], [0.35, -0.8], [0.5, -0.2], [1, 0]],
    lx0: [[0, 0], [0.5, -0.5], [0.75, -0.45], [1, 0]], kx0: [[0, 0], [0.5, 0.5], [0.75, 0.45], [1, 0]], lx1: [[0, 0], [0.5, 0.3], [0.75, 0.25], [1, 0]],
    core: [[0, 0], [0.5, 0.7], [1, 0]] } },
  thrust: { dur: 0.8, tracks: {
    ax1: [[0, 0], [0.3, 0.7], [0.45, -1.55], [0.7, -1.45], [1, 0]], ex1: [[0, 0], [0.3, -1.3], [0.45, 0], [1, 0]], az1: [[0, 0], [0.3, 0.3], [0.45, -0.1], [1, 0]],
    ty: [[0, 0], [0.3, 0.5], [0.45, -0.45], [0.7, -0.4], [1, 0]], ax0: [[0, 0], [0.3, -0.4], [0.45, 0.9], [0.7, 0.8], [1, 0]], ex0: [[0, 0], [0.3, -0.9], [0.45, -0.3], [1, 0]],
    tx: [[0, 0], [0.3, -0.15], [0.45, 0.25], [0.7, 0.2], [1, 0]], bz: [[0, 0], [0.3, -0.1], [0.45, 0.35], [0.7, 0.3], [1, 0]],
    lx1: [[0, 0], [0.45, -0.45], [0.7, -0.4], [1, 0]], kx1: [[0, 0], [0.45, 0.4], [0.7, 0.35], [1, 0]], lx0: [[0, 0], [0.45, 0.35], [0.7, 0.3], [1, 0]],
    core: [[0, 0], [0.4, 1], [0.6, 0.3], [1, 0]], hand: [[0, 0], [0.4, 1], [0.7, 1], [1, 0]] } },
  rise: { dur: 1.3, tracks: {
    hy: [[0, -0.3], [0.75, 0.05], [1, 0]], tx: [[0, 0.55], [0.8, -0.05], [1, 0]], nx: [[0, 0.5], [0.7, -0.15], [1, 0]],
    ...sides('ax', [[0, 0.9], [0.75, -0.25], [1, 0]]), ...sides('az', [[0, 0.5], [0.8, 0], [1, 0]]), ...sides('ex', [[0, -0.6], [0.8, 0], [1, 0]]),
    ...sides('kx', [[0, 0.9], [0.85, 0], [1, 0]]), ...sides('lx', [[0, -0.45], [0.85, 0], [1, 0]]),
    core: [[0, -1], [0.55, -1], [0.8, 1], [1, 0]] } },
  jump: { dur: 0.9, tracks: {
    hy: [[0, 0], [0.2, -0.1], [0.4, 0.05], [0.8, -0.08], [1, 0]], ...sides('kx', [[0, 0], [0.2, 0.5], [0.45, 0.9], [0.7, 0.3], [1, 0]]), ...sides('lx', [[0, 0], [0.45, -0.6], [0.7, -0.1], [1, 0]]),
    ...sides('ax', [[0, 0], [0.2, 0.6], [0.45, -1.5], [0.75, 0.2], [1, 0]]), tx: [[0, 0], [0.2, 0.3], [0.45, -0.1], [1, 0]] } },
  cast: { dur: 0.9, tracks: {
    ...sides('ax', [[0, 0], [0.3, -1.6], [0.7, -1.5], [1, 0]]), ...sides('az', [[0, 0], [0.3, 0.4], [0.7, 0.4], [1, 0]]), ...sides('ex', [[0, 0], [0.3, -0.6], [0.7, -0.5], [1, 0]]),
    nx: [[0, 0], [0.3, -0.3], [1, 0]], core: [[0, 0], [0.3, 1], [0.7, 1], [1, 0]], hand: [[0, 0], [0.3, 1], [0.7, 1], [1, 0]] } },
};

const HOUND_ACTS = {
  bite: { dur: 0.7, tracks: {
    by: [[0, 0], [0.3, -0.12], [0.45, 0.06], [0.7, 0], [1, 0]], bz: [[0, 0], [0.3, -0.2], [0.45, 0.45], [0.7, 0.4], [1, 0]],
    sx: [[0, 0], [0.3, 0.25], [0.45, -0.3], [1, 0]], nx: [[0, 0], [0.3, -0.5], [0.45, 0.35], [0.7, 0.3], [1, 0]],
    jaw: [[0, 0], [0.3, 0.8], [0.45, 0.75], [0.52, 0.02], [1, 0]],
    f0u: [[0, 0], [0.3, 0.4], [0.45, -0.9], [0.7, -0.8], [1, 0]], f1u: [[0, 0], [0.3, 0.4], [0.45, -0.9], [0.7, -0.8], [1, 0]],
    f0l: [[0, 0], [0.3, 0.8], [0.45, 0.1], [1, 0]], f1l: [[0, 0], [0.3, 0.8], [0.45, 0.1], [1, 0]],
    h0u: [[0, 0], [0.3, -0.5], [0.45, 0.5], [0.7, 0.4], [1, 0]], h1u: [[0, 0], [0.3, -0.5], [0.45, 0.5], [0.7, 0.4], [1, 0]],
    h0l: [[0, 0], [0.3, 0.6], [0.45, 0], [1, 0]], h1l: [[0, 0], [0.3, 0.6], [0.45, 0], [1, 0]],
    core: [[0, 0], [0.4, 1], [0.6, 0.2], [1, 0]] } },
  hit: { dur: 0.5, tracks: {
    bz: [[0, 0], [0.2, -0.3], [1, 0]], by: [[0, 0], [0.25, -0.1], [1, 0]], bx: [[0, 0], [0.2, -0.2], [1, 0]],
    nx: [[0, 0], [0.15, -0.6], [1, 0]], jaw: [[0, 0], [0.15, 0.6], [0.5, 0.1], [1, 0]], sx: [[0, 0], [0.2, -0.2], [1, 0]],
    f0u: [[0, 0], [0.2, -0.5], [1, 0]], f1u: [[0, 0], [0.2, -0.5], [1, 0]], h0u: [[0, 0], [0.2, 0.4], [1, 0]], h1u: [[0, 0], [0.2, 0.4], [1, 0]],
    tl: [[0, 0], [0.2, -0.8], [1, 0]], core: [[0, 0], [0.1, -0.6], [0.3, 0.3], [1, 0]] } },
  rise: { dur: 1.2, tracks: {
    by: [[0, -0.3], [0.8, 0.04], [1, 0]], f0u: [[0, -0.8], [0.8, 0]], f1u: [[0, -0.8], [0.8, 0]], f0l: [[0, 1.0], [0.8, 0]], f1l: [[0, 1.0], [0.8, 0]],
    h0u: [[0, 0.6], [0.8, 0]], h1u: [[0, 0.6], [0.8, 0]], h0l: [[0, 0.8], [0.8, 0]], h1l: [[0, 0.8], [0.8, 0]],
    nx: [[0, 0.6], [0.7, -0.25], [1, 0]], jaw: [[0, 0], [0.6, 0], [0.75, 0.5], [0.95, 0]], core: [[0, -1], [0.6, -1], [0.85, 1], [1, 0]] } },
  jump: { dur: 0.9, tracks: {
    by: [[0, 0], [0.2, -0.12], [0.5, 0.04], [1, 0]], f0u: [[0, 0], [0.2, 0.3], [0.5, -0.9], [0.8, 0.1], [1, 0]], f1u: [[0, 0], [0.2, 0.3], [0.5, -0.9], [0.8, 0.1], [1, 0]],
    h0u: [[0, 0], [0.2, -0.5], [0.5, 0.7], [1, 0]], h1u: [[0, 0], [0.2, -0.5], [0.5, 0.7], [1, 0]], sx: [[0, 0], [0.2, 0.3], [0.5, -0.3], [1, 0]] } },
  cast: { dur: 0.8, tracks: { nx: [[0, 0], [0.3, -0.5], [0.7, -0.5], [1, 0]], jaw: [[0, 0], [0.3, 0.6], [0.7, 0.6], [1, 0]], core: [[0, 0], [0.3, 1], [0.7, 1], [1, 0]] } },
};

const WISP_ACTS = {
  strike: { dur: 0.6, tracks: { flare: [[0, 0], [0.25, 1], [0.4, 0.6], [1, 0]], bz: [[0, 0], [0.25, -0.15], [0.4, 0.5], [0.7, 0.45], [1, 0]], orbit: [[0, 0], [0.25, -0.6], [0.4, 0.8], [1, 0]], spin: [[0, 0], [0.3, 6], [0.6, 2], [1, 0]] } },
  hit: { dur: 0.5, tracks: { bz: [[0, 0], [0.2, -0.3], [1, 0]], y: [[0, 0], [0.15, -0.2], [0.5, 0.1], [1, 0]], flare: [[0, 0], [0.1, -0.6], [0.25, 0.5], [0.4, -0.4], [0.6, 0.2], [1, 0]], orbit: [[0, 0], [0.2, 0.8], [1, 0]] } },
  cast: { dur: 0.9, tracks: { flare: [[0, 0], [0.3, 1.2], [0.7, 1.2], [1, 0]], orbit: [[0, 0], [0.3, 0.8], [0.7, 0.8], [1, 0]], spin: [[0, 0], [0.3, 5], [0.7, 5], [1, 0]] } },
  rise: { dur: 1.2, tracks: { y: [[0, -1.3], [0.7, 0.1], [1, 0]], flare: [[0, -0.9], [0.6, 0.1], [0.8, 1], [1, 0]], orbit: [[0, 2.5], [0.8, 0], [1, 0]], spin: [[0, 3], [0.8, 0], [1, 0]] } },
  jump: { dur: 0.9, tracks: { y: [[0, 0], [0.5, 0.3], [1, 0]] } },
};

/* ------------------------------------------------------------ actor */

export function makeGolemActor(gltfs, defId, { team = 0x4fd2ff } = {}) {
  const look = LOOKS[defId] || LOOKS.CLAY_HAND;
  const rnd = mulberry32(hash(defId) + instanceN++);
  const sp = rnd() * TAU;    // a phase offset so a pack does not breathe in unison
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const parts = [];          // every rock, for the death tumble
  const myMats = [];         // everything this golem owns and must dispose
  const glows = [];
  const myGeos = [];
  const rig = {};

  /* materials */
  const mats = new Map();
  function matFor(which) {
    if (mats.has(which)) return mats.get(which);
    const src = bakeMaterial(gltfs, which);
    const m = src ? src.clone() : new THREE.MeshStandardMaterial();
    m.color = new THREE.Color(look.tint);
    m.roughness = look.rough ?? 1; m.metalness = look.metal ?? 0;
    if (look.metal) { m.metalnessMap = null; m.envMapIntensity = look.env || 1.5; }   // the bake's metal channel is zero
    if (look.cracks) { m.emissive = new THREE.Color(look.cracks); m.emissiveMap = crackTexture(); m.emissiveIntensity = look.crackI; }
    m.userData.emissiveI = m.emissiveIntensity;
    mats.set(which, m); myMats.push(m);
    return m;
  }
  let glassMat = null;
  if (look.glass) {
    // No transmission (it would re-render the whole scene into a texture
    // every frame): glass here is sky reflection, a lit heart and a little
    // see-through.
    glassMat = new THREE.MeshPhysicalMaterial({ color: 0x9fdcf5, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.62, flatShading: true, emissive: 0x0e4a63, emissiveIntensity: 0.8, envMapIntensity: 1.6, clearcoat: 0.5, clearcoatRoughness: 0.1 });
    glassMat.userData.emissiveI = 0.8;
    myMats.push(glassMat);
  }
  const coreColor = new THREE.Color(look.core);
  const coreMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, emissive: look.core, emissiveIntensity: 1.8, roughness: 0.25, metalness: 0.2 });
  coreMat.userData.emissiveI = 1.8;
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x101010, emissive: team, emissiveIntensity: 2.2, roughness: 0.3 });
  eyeMat.userData.emissiveI = 2.2;
  myMats.push(coreMat, eyeMat);

  /* part makers */
  // Every rock of one bake is an instance of one InstancedMesh under `root`;
  // `part` is its pivot (an empty group), and each frame the pivot's matrix
  // relative to the root is written into the instance. Twenty rocks, three
  // draw calls (and three in the shadow pass) instead of twenty each.
  const instanced = new Map();    // which -> [{part, pre}]
  function rock(spec, parent, extraRot) {
    const [which, size, at, variant = 0, waist = 0.5, rot = null] = spec;
    const part = new THREE.Group();
    if (which === 'shard') {
      const inner = new THREE.Mesh(shardGeo(variant, waist), glassMat);
      inner.castShadow = true; inner.receiveShadow = true;
      inner.scale.set(size[0], size[1], size[2]);
      part.add(inner);
    } else {
      const rp = rockPart(gltfs, which, variant);
      const pre = new THREE.Matrix4().makeScale(size[0], size[1], size[2]).multiply(rp.local);
      if (!instanced.has(which)) instanced.set(which, []);
      instanced.get(which).push({ part, pre });
    }
    part.position.set(at[0], at[1], at[2]);
    const r = rot || extraRot;
    if (r) part.rotation.set(r[0], r[1], r[2]);
    part.userData.r = Math.min(size[0], size[1], size[2]) * 0.42;
    part.userData.size = size;
    parent.add(part);
    parts.push(part);
    return part;
  }
  function eye(at, r, parent) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), eyeMat);
    myGeos.push(e.geometry);
    e.position.set(at[0], at[1], at[2]);
    const g = glow(team, r * 4.5, 0.5);
    e.add(g); glows.push(g);
    parent.add(e);
    return e;
  }
  function core(at, r, parent, lightI) {
    const c = new THREE.Mesh(new THREE.OctahedronGeometry(r, 0), coreMat);
    myGeos.push(c.geometry);
    c.position.set(at[0], at[1], at[2]);
    const g = glow(look.core, r * (look.glass ? 5 : 7), 0.7);
    g.material.depthTest = false;   // the halo sits half inside the rock; let it bloom over it
    c.add(g); glows.push(g);
    parent.add(c);
    rig.core = c; rig.coreGlow = g; rig.light = pool(look.core, look.height * 0.55, lightI); rig.lightI = lightI;
    return c;
  }
  /**
   * The core's light on the ground: an additive disc under the golem that
   * stands in for the point light each one used to carry (a point light
   * taxes every lit pixel in the scene). `intensity` drives its opacity on
   * the light's old scale.
   */
  function pool(color, radius, lightI) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(radius, 20), new THREE.MeshBasicMaterial({ map: glowTexture(), color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
    m.rotation.x = -Math.PI / 2; m.position.y = 0.03; m.renderOrder = 1;
    body.add(m);
    myMats.push(m.material);
    m.material.userData.pool = true;
    return { mesh: m, k: 0.3 / Math.max(0.5, lightI), set intensity(v) { m.material.opacity = Math.min(0.75, Math.max(0, v * this.k)); }, get intensity() { return m.material.opacity / this.k; }, position: m.position };
  }
  const G = (parent, at) => { const g = new THREE.Group(); g.position.set(at[0], at[1], at[2]); parent.add(g); return g; };

  /* ------------------------------------------------ build: biped */
  let P = null;
  if (look.kind === 'biped') {
    // A golem card with no look of its own (a new card) borrows the Clay
    // Hand's, body plan and all -- the look fell back already, the build did
    // not, and a summon threw.
    P = BIPEDS[defId] || BIPEDS[BODY_OF[defId]] || BIPEDS.CLAY_HAND;
    const hips = G(body, [0, P.hipY, 0]);
    rock(P.pelvis, hips);
    const torsoP = G(hips, [0, P.torsoPivotY, 0]);
    const torsoRocks = P.torso.map((s) => rock(s, torsoP));
    const headP = G(torsoP, P.neck);
    const headRocks = P.head.map((s) => rock(s, headP));
    // Eyes live on the head rock, so they tumble with it on death.
    for (const e of P.eyes) eye([e[0] - P.head[0][2][0], e[1] - P.head[0][2][1], e[2] - P.head[0][2][2]], P.eyeR, headRocks[0]);
    rig.hips = hips; rig.torso = torsoP; rig.head = headP; rig.arms = []; rig.legs = []; rig.hands = [];
    for (const sx of [-1, 1]) {
      const sh = G(torsoP, [sx * P.shoulder[0], P.shoulder[1], P.shoulder[2]]);
      rock(P.upper, sh);
      const elbow = G(sh, [0, -P.upperLen, 0]);
      rock(P.fore, elbow);
      const hand = P.hand ? rock(P.hand, elbow) : null;
      const arm = { sh, elbow, hand, sx, i: sx < 0 ? 0 : 1, armX: P.armX, elbowX: P.elbowX, armZ: P.armZ, swing: 1 };
      if (P.shieldArm && sx < 0) {
        Object.assign(arm, P.shieldArm);
        // A punch-shield: the slab stands at the fist, vertical and facing forward at rest.
        if (hand) { elbow.remove(hand); parts.splice(parts.indexOf(hand), 1); arm.hand = null; }
        const slab = rock(P.shield, elbow);
        slab.rotation.x = -(arm.armX + arm.elbowX);
      }
      rig.arms.push(arm);
      if (arm.hand) rig.hands.push(arm.hand);
    }
    for (const sx of [-1, 1]) {
      const hip = G(hips, [sx * P.hipW, P.hipDrop, 0]);
      rock(P.thigh, hip);
      const knee = G(hip, [0, -P.thighLen, 0]);
      rock(P.shin, knee);
      const foot = P.foot ? rock(P.foot, knee) : null;
      rig.legs.push({ hip, knee, foot, sx });
    }
    // The core sits on the main torso rock so it falls with it.
    core([P.core[0] - P.torso[0][2][0], P.core[1] - P.torso[0][2][1], P.core[2] - P.torso[0][2][2]], P.coreR, torsoRocks[0], P.lightI);
    if (look.glass) { rig.coreGlow.position.z = 0.22; }
    if (P.orbiters) {
      // Loose shards circling the chest: it is a channel, and this is what it channels through.
      rig.orbit = G(body, [0, P.hipY + P.torsoPivotY + 0.45, 0]);
      rig.orbiters = [];
      for (let i = 0; i < P.orbiters; i++) {
        const a = (i / P.orbiters) * TAU;
        const s = rock(['shard', [0.08, 0.18, 0.08], [Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5], 10 + i, 0.5], rig.orbit);
        rig.orbiters.push({ s, a });
      }
    }
  }

  /* ------------------------------------------------ build: hound */
  if (look.kind === 'hound') {
    const hips = G(body, [0, 0.7, -0.28]);                       // the rump
    rock(['boulderB', [0.46, 0.42, 0.66], [0, 0, 0.02], 0], hips);
    const chest = G(hips, [0, 0.02, 0.36]);
    const chestRock = rock(['boulderC', [0.52, 0.5, 0.62], [0, -0.02, 0.06], 1], chest);
    rock(['boulderA', [0.34, 0.28, 0.4], [0, 0.1, -0.1], 5], chest);          // the spine, bridging the two
    rock(['boulderA', [0.26, 0.18, 0.26], [0.2, 0.2, 0.1], 2], chest);
    rock(['boulderA', [0.26, 0.18, 0.26], [-0.2, 0.2, 0.1], 3], chest);
    const neck = G(chest, [0, 0.16, 0.36]);
    rock(['boulderA', [0.24, 0.24, 0.3], [0, 0.02, 0.1], 5], neck);
    const head = rock(['boulderA', [0.34, 0.3, 0.4], [0, 0.08, 0.3], 4], neck);
    rock(['boulderB', [0.22, 0.16, 0.3], [0, -0.02, 0.52], 4], neck);          // muzzle
    rock(['boulderA', [0.09, 0.15, 0.07], [0.11, 0.22, 0.2], 1, 0.5, [-0.55, 0, 0.3]], neck);
    rock(['boulderA', [0.09, 0.15, 0.07], [-0.11, 0.22, 0.2], 1, 0.5, [-0.55, 0, -0.3]], neck);
    const jawP = G(neck, [0, -0.06, 0.3]);
    rock(['boulderB', [0.2, 0.1, 0.3], [0, -0.03, 0.2], 4], jawP);
    eye([-0.1, 0.04, 0.15], 0.03, head);
    eye([0.1, 0.04, 0.15], 0.03, head);
    rig.hips = hips; rig.chest = chest; rig.neck = neck; rig.jaw = jawP; rig.legs = []; rig.head = head;
    for (const [sx, fore] of [[-1, true], [1, true], [-1, false], [1, false]]) {
      const u = fore ? G(chest, [sx * 0.2, -0.14, 0.26]) : G(hips, [sx * 0.2, -0.1, -0.1]);
      rock(fore ? limb('boulderA', 0.18, 0.2, 0.3, 2) : limb('boulderA', 0.2, 0.26, 0.32, 3), u);
      const l = G(u, [0, fore ? -0.3 : -0.32, 0]);
      rock(limb('boulderB', 0.14, 0.16, fore ? 0.28 : 0.3, 1), l);
      const paw = rock(['boulderA', [0.16, 0.09, 0.22], [0, fore ? -0.27 : -0.29, 0.04], 0], l);
      rig.legs.push({ u, l, paw, sx, key: (fore ? 'f' : 'h') + (sx < 0 ? 0 : 1), fore });
    }
    rig.tail = [];
    let tp = G(hips, [0, 0.12, -0.24]);
    for (let j = 0; j < 3; j++) {
      rock(['boulderA', [0.14 - j * 0.02, 0.12 - j * 0.02, 0.22], [0, 0, -0.09], j], tp);
      rig.tail.push(tp);
      tp = G(tp, [0, 0, -0.17]);
    }
    core([0, -0.08, 0.26], 0.07, chestRock, 1.8);
    rig.light.position.z = 0.2;
  }

  /* ------------------------------------------------ build: wisp */
  if (look.kind === 'wisp') {
    const c = new THREE.Group();
    c.position.y = 1.1;
    const inner = glow(0xffffff, 0.26, 1);
    const g1 = glow(look.core, 0.8, 0.55), g2 = glow(team, 0.42, 0.5);
    c.add(inner, g1, g2); glows.push(inner, g1, g2);
    body.add(c);
    parts.push(c);
    rig.core = c; rig.coreGlow = g1; rig.coreGlow2 = g2; rig.inner = inner; rig.light = pool(look.core, 0.9, 3.0); rig.lightI = 3.0;
    rig.orbiters = [];
    // Three sparks per orbit (each is a sprite, a draw call of its own).
    for (let i = 0; i < 4; i++) {
      const plane = new THREE.Group();
      plane.rotation.set((rnd() - 0.5) * 1.6, rnd() * TAU, (rnd() - 0.5) * 1.2);
      c.add(plane);
      const trail = [];
      for (let j = 0; j < 3; j++) { const s = glow(team, 0.17 * Math.pow(0.75, j), 0.85 * Math.pow(0.55, j)); plane.add(s); trail.push(s); }
      rig.orbiters.push({ plane, trail, r: 0.32 + rnd() * 0.18, spd: (2.2 + rnd() * 1.6) * (rnd() < 0.5 ? 1 : -1), off: rnd() * TAU });
    }
  }

  /* ------------------------------------------------ the instanced rocks */
  const instMeshes = [];
  for (const [which, list] of instanced) {
    const rp = rockPart(gltfs, which, 0);
    const im = new THREE.InstancedMesh(rp.geometry, matFor(which), list.length);
    im.castShadow = true; im.receiveShadow = true;
    im.frustumCulled = false;       // its bounds are its instances', which move
    root.add(im);
    instMeshes.push({ im, list });
  }
  const rootInv = new THREE.Matrix4(), instM = new THREE.Matrix4();
  /** Write every rock's pivot matrix (relative to the root) into its instance. */
  function syncInstances() {
    if (!instMeshes.length) return;
    root.updateMatrixWorld(true);
    rootInv.copy(root.matrixWorld).invert();
    for (const { im, list } of instMeshes) {
      for (let i = 0; i < list.length; i++) {
        instM.multiplyMatrices(rootInv, list[i].part.matrixWorld).multiply(list[i].pre);
        im.setMatrixAt(i, instM);
      }
      im.instanceMatrix.needsUpdate = true;
    }
  }

  /* ------------------------------------------------ homes (for rise / revive) */
  root.updateMatrixWorld(true);
  const allParts = parts.slice();
  const wp = new THREE.Vector3();
  for (const p of allParts) {
    p.getWorldPosition(wp);
    p.userData.home = { parent: p.parent, p: p.position.clone(), q: p.quaternion.clone(), wy: wp.y };
  }

  /* ------------------------------------------------ animation state */
  const height = look.height;
  let phase = rnd() * TAU;
  let walkK = 0;
  let acts = [];           // {tracks, t0, dur}
  let riseT0 = null, riseDur = 1.2;
  let dead = false, deathT = 0;
  let debris = null;
  const pose = {};
  const g = (c) => pose[c] || 0;
  const add = (c, v) => { pose[c] = (pose[c] || 0) + v; };
  const ACTS = look.kind === 'biped' ? BIPED_ACTS : look.kind === 'hound' ? HOUND_ACTS : WISP_ACTS;
  const start = (name) => { const a = ACTS[name]; if (!a || dead) return; acts.push({ tracks: a.tracks, t0: null, dur: a.dur }); };
  const tmpQ = new THREE.Quaternion(), tmpV = new THREE.Vector3(), tmpA = new THREE.Vector3();

  function layerActs(now) {
    for (let i = acts.length - 1; i >= 0; i--) {
      const a = acts[i];
      if (a.t0 === null) a.t0 = now;
      const k = (now - a.t0) / 1000 / a.dur;
      if (k >= 1) { acts.splice(i, 1); continue; }
      for (const ch in a.tracks) add(ch, track(k, a.tracks[ch]));
    }
  }

  function layerRise(now) {
    if (riseT0 === null || look.kind === 'wisp') return;
    if (riseT0 < 0) riseT0 = now;
    const k = clamp01((now - riseT0) / 1000 / riseDur);
    for (const p of allParts) {
      const h = p.userData.home, s = p.userData.riseStart;
      if (!s) continue;
      const e = easeOutCubic(clamp01((k - s.delay) / (1 - s.delay)));
      p.position.lerpVectors(s.p, h.p, e);
      p.quaternion.slerpQuaternions(s.q, h.q, e);
    }
    if (k >= 1) { riseT0 = null; for (const p of allParts) p.userData.riseStart = null; }
  }

  function coreLook(t, flare) {
    const pulse = 0.5 + 0.5 * Math.sin(t * (P ? P.coreHz : 3) + sp);
    const f = Math.max(-1, flare);
    const k = Math.max(0.05, 1 + pulse * 0.15 + f * 0.9);
    rig.core.scale.setScalar(k);
    rig.core.rotation.y = t * 1.3; rig.core.rotation.x = t * 0.7;
    rig.coreGlow.scale.setScalar(rig.coreGlow.userData.size * Math.max(0.05, 1 + pulse * 0.25 + f * 0.9));
    rig.coreGlow.material.opacity = Math.min(1, Math.max(0, 0.6 + 0.3 * pulse + f * 0.3));
    rig.light.intensity = rig.lightI * Math.max(0, 0.8 + 0.4 * pulse + f * 1.6);
    for (const m of myMats) if (m.userData.emissiveI) m.emissiveIntensity = m.userData.emissiveI * (0.75 + 0.5 * pulse + Math.max(0, f) * 1.5);
    for (const gl of glows) if (gl !== rig.coreGlow) gl.material.opacity = gl.userData.opacity * (0.8 + 0.25 * pulse);
  }

  /* biped layers */
  function bipedIdle(t) {
    const b = Math.sin(t * P.breathHz + sp);
    add('tx', 0.022 * b); add('hy', 0.006 * b);
    add('ax0', 0.025 * b); add('ax1', 0.025 * b); add('az0', 0.02 * b); add('az1', 0.02 * b);
    const lookY = Math.sin(t * 0.37 + sp) * 0.6 + Math.sin(t * 0.91 + sp * 2.3) * 0.4;
    add('ny', 0.45 * lookY * (1 - walkK)); add('nx', 0.05 * Math.sin(t * 0.53 + sp) + 0.03);
    const ws = Math.sin(t * 0.45 + sp);
    add('hz', 0.02 * ws); add('hxo', 0.012 * ws); add('ty', -0.03 * ws);
  }
  function bipedWalk(ph, w) {
    if (w < 0.001) return;
    add('hy', P.bob * (Math.abs(Math.cos(ph)) - 0.64) * w);
    add('hyaw', 0.1 * Math.sin(ph) * w); add('ty', -0.16 * Math.sin(ph) * w); add('hz', 0.05 * Math.sin(ph) * w); add('tz', -0.04 * Math.sin(ph) * w);
    add('tx', P.lean * w); add('nx', (-P.lean * 0.6 + 0.03 * Math.sin(2 * ph)) * w);
    for (let i = 0; i < 2; i++) {
      const phi = ph + (i ? Math.PI : 0);
      const s = Math.sin(phi), c = Math.cos(phi);
      add('lx' + i, -P.stride * s * w);
      add('kx' + i, (P.kneeBend * Math.max(0, c) + 0.12 * Math.max(0, -c)) * w);
      add('ax' + i, P.armSwing * s * w);
      add('ex' + i, -P.elbowSwing * Math.max(0, -s) * w);
    }
  }
  function bipedApply(t, dt) {
    rig.hips.position.set(g('hxo'), P.hipY + g('hy'), g('bz'));
    rig.hips.rotation.set(g('hx'), g('hyaw'), g('hz'));
    rig.torso.rotation.set(P.hunch + g('tx'), g('ty'), g('tz'));
    rig.head.rotation.set(g('nx'), g('ny'), 0);
    for (const a of rig.arms) {
      a.sh.rotation.set(a.armX + g('ax' + a.i) * a.swing, 0, a.sx * (a.armZ + g('az' + a.i)));
      a.elbow.rotation.x = a.elbowX + g('ex' + a.i);
    }
    rig.legs.forEach((l, i) => {
      l.hip.rotation.set(P.legX + g('lx' + i), 0, l.sx * g('lz' + i));
      l.knee.rotation.x = P.kneeX + g('kx' + i);
      if (l.foot) l.foot.rotation.x = -(l.hip.rotation.x + l.knee.rotation.x) * 0.75;
    });
    if (rig.orbit) {
      rig.orbit.rotation.y = t * (0.9 + g('core') * 4);
      rig.orbiters.forEach((o, i) => { o.s.position.y = Math.sin(t * 1.7 + i * 2.1) * 0.12; o.s.rotation.y += dt * 2; o.s.rotation.x = Math.sin(t + i) * 0.4; });
    }
    if (look.glass) for (const h of rig.hands) h.rotation.y += dt * (1.5 + g('hand') * 30);
    coreLook(t, g('core'));
  }

  /* hound layers */
  function houndIdle(t) {
    const b = Math.sin(t * 2.2 + sp);
    add('sx', 0.025 * b); add('by', 0.006 * b);
    add('jaw', 0.14 + 0.06 * Math.sin(t * 5.5 + sp));                     // panting
    const lookY = Math.sin(t * 0.5 + sp) * 0.6 + Math.sin(t * 1.3 + sp * 2) * 0.4;
    add('ny', 0.5 * lookY * (1 - walkK)); add('nx', 0.08 * Math.sin(t * 0.7 + sp));
    add('tl', 0.5 * Math.sin(t * 4.5 + sp) * (1 - walkK) + 0.25 * Math.sin(t * 9) * walkK);
    add('byaw', 0.02 * Math.sin(t * 0.45 + sp));
  }
  function houndGallop(ph, w) {
    if (w < 0.001) return;
    // Rotary gallop: hinds drive together (a little apart), fores reach half a cycle later.
    const legs = { h0: ph, h1: ph + 0.45, f0: ph + Math.PI + 0.1, f1: ph + Math.PI + 0.55 };
    for (const key in legs) {
      const phi = legs[key], s = Math.sin(phi), c = Math.cos(phi);
      const hind = key[0] === 'h';
      add(key + 'u', (hind ? -0.85 * s : -0.75 * s) * w);
      add(key + 'l', (hind ? 0.7 * Math.max(0, c) + 0.45 * Math.max(0, -s) : 1.0 * Math.max(0, c) + 0.2 * Math.max(0, -s)) * w);
    }
    add('sx', 0.28 * Math.sin(ph + 0.3) * w);
    add('bx', -0.14 * Math.sin(ph + 0.8) * w);
    add('by', (0.07 * Math.sin(ph + 1.9) + 0.02) * w);
    add('nx', -0.2 * Math.sin(ph + 0.3) * w + 0.1 * w);
    add('tl', 0);
  }
  function houndApply(t, dt) {
    rig.hips.position.set(0, 0.7 + g('by'), -0.28 + g('bz'));
    rig.hips.rotation.set(g('bx'), g('byaw'), 0);
    rig.chest.rotation.x = g('sx');
    rig.neck.rotation.set(-0.15 + g('nx'), g('ny'), 0);
    rig.jaw.rotation.x = g('jaw');
    for (const l of rig.legs) {
      const u = (l.fore ? 0.05 : -0.3) + g(l.key + 'u');
      const lo = (l.fore ? 0.05 : 0.55) + g(l.key + 'l');
      l.u.rotation.x = u; l.l.rotation.x = lo;
      l.paw.rotation.x = -(u + lo) * 0.8;
    }
    rig.tail.forEach((tp, j) => { tp.rotation.y = g('tl') * 0.5; tp.rotation.x = 0.45 - j * 0.1 + Math.sin(t * 3 + j) * 0.08; });
    coreLook(t, g('core'));
  }

  /* wisp */
  function wispApply(t, dt) {
    const hover = 1.1 + 0.1 * Math.sin(t * 2.1 + sp) + 0.04 * Math.sin(t * 3.7 + sp);
    rig.core.position.set(0.03 * Math.sin(t * 1.3 + sp), hover + g('y'), g('bz'));
    const flare = g('flare');
    const pulse = 0.5 + 0.5 * Math.sin(t * 7 + sp);
    const k = Math.max(0.05, 1 + pulse * 0.12 + flare * 1.4);
    rig.coreGlow.scale.setScalar(0.8 * k); rig.coreGlow2.scale.setScalar(0.42 * k * (1 + 0.2 * Math.sin(t * 11)));
    rig.inner.scale.setScalar(0.26 * Math.max(0.05, 1 + flare * 0.8));
    rig.light.intensity = rig.lightI * Math.max(0, 0.85 + 0.3 * pulse + flare * 2.5);
    const orbitK = Math.max(0.1, 1 + g('orbit'));
    const spin = 1 + walkK * 0.8 + g('spin');
    const gap = 0.16 + walkK * 0.14 + Math.max(0, flare) * 0.1;
    for (const o of rig.orbiters) {
      const a0 = t * o.spd * spin + o.off;
      o.trail.forEach((s, j) => {
        const a = a0 - j * gap * Math.sign(o.spd);
        s.position.set(Math.cos(a) * o.r * orbitK, 0, Math.sin(a) * o.r * orbitK);
        s.material.opacity = s.userData.opacity * Math.max(0, 1 + flare * 0.5);
      });
    }
  }

  /* ------------------------------------------------ death */
  function beginDeath() {
    root.updateMatrixWorld(true);
    const c = rig.core.getWorldPosition(new THREE.Vector3());
    debris = [];
    const inv = root.matrixWorld.clone().invert();
    const cl = c.clone().applyMatrix4(inv);
    for (const p of allParts) {
      root.attach(p);
      const d = p.position.clone().sub(cl);
      d.y = 0;
      if (d.lengthSq() < 1e-4) d.set(rnd() - 0.5, 0, rnd() - 0.5);
      d.normalize();
      const v = d.multiplyScalar(0.2 + rnd() * 0.8).add(new THREE.Vector3((rnd() - 0.5) * 0.6, 0.5 + rnd() * 1.8, (rnd() - 0.5) * 0.6));
      const w = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize().multiplyScalar(2 + rnd() * 5);
      debris.push({ o: p, v, w, r: p.userData.r, rest: false, settle: -1 });
    }
    actor.parts = [];
  }
  function stepDeath(dt, t) {
    deathT += dt;
    if (look.kind === 'wisp') {
      const k = clamp01(deathT / 0.7);
      rig.coreGlow.scale.setScalar(Math.max(0.01, 1 - k) * 0.9); rig.coreGlow2.scale.setScalar(Math.max(0.01, 1 - k) * 0.5);
      rig.inner.scale.setScalar(0.26 * Math.max(0.01, 1 - k));
      rig.light.intensity = rig.lightI * (1 - k) * 2;
      for (const o of rig.orbiters) o.trail.forEach((s, j) => {
        if (!s.userData.v) s.userData.v = new THREE.Vector3((rnd() - 0.5) * 3, 1 + rnd() * 2, (rnd() - 0.5) * 3);
        s.userData.v.y -= 5 * dt;
        s.position.addScaledVector(s.userData.v, dt);
        s.material.opacity = s.userData.opacity * clamp01(1 - deathT / 1.4);
      });
      return;
    }
    for (const d of debris) {
      if (d.rest) {
        // Settled: ease onto the flattest face.
        if (d.settle < 0) {
          const size = d.o.userData.size || [1, 1, 1];
          const ax = size.indexOf(Math.min(...size));
          const e = tmpA.set(ax === 0 ? 1 : 0, ax === 1 ? 1 : 0, ax === 2 ? 1 : 0).applyQuaternion(d.o.quaternion);
          tmpV.set(0, e.y >= 0 ? 1 : -1, 0);
          d.q0 = d.o.quaternion.clone();
          d.q1 = new THREE.Quaternion().setFromUnitVectors(e, tmpV).multiply(d.q0);
          d.settle = 0;
        }
        if (d.settle < 1) { d.settle = Math.min(1, d.settle + dt / 0.45); const u = d.settle; d.o.quaternion.slerpQuaternions(d.q0, d.q1, u * u * (3 - 2 * u)); }
        continue;
      }
      d.v.y -= 9.8 * dt;
      d.o.position.addScaledVector(d.v, dt);
      const wl = d.w.length();
      if (wl > 1e-3) { tmpQ.setFromAxisAngle(tmpA.copy(d.w).divideScalar(wl), wl * dt); d.o.quaternion.premultiply(tmpQ); }
      if (d.o.position.y < d.r) {
        d.o.position.y = d.r;
        if (d.v.y < -1.2) { d.v.y *= -0.28; d.v.x *= 0.55; d.v.z *= 0.55; d.w.multiplyScalar(0.5); }
        else { d.v.y = 0; d.v.x *= 0.6; d.v.z *= 0.6; d.w.multiplyScalar(0.55); if (d.v.lengthSq() < 0.01 && d.w.lengthSq() < 0.05) d.rest = true; }
      }
    }
    // The core goes dark, the eyes with it.
    const k = clamp01(deathT / 0.7);
    coreMat.emissive.copy(coreColor).lerp(new THREE.Color(0x0a0806), k);
    rig.core.scale.setScalar(1 - 0.6 * k);
    eyeMat.emissive.setHex(team).lerp(new THREE.Color(0x101010), k);
    rig.light.intensity = rig.lightI * (1 - k) * (1 + 1.5 * Math.sin(deathT * 30) * (1 - k));
    for (const gl of glows) gl.material.opacity = gl.userData.opacity * (1 - k);
    for (const m of myMats) if (m.userData.emissiveI) m.emissiveIntensity = m.userData.emissiveI * (1 - k);
    if (deathT > 2.6) {
      const o = clamp01(1 - (deathT - 2.6) / 0.8);
      for (const m of myMats) { if (m.userData.pool) { m.opacity = Math.min(m.opacity, o * 0.3); continue; } m.transparent = true; m.opacity = o; m.depthWrite = o > 0.5; }
    }
  }

  /* ------------------------------------------------ the actor */
  const actor = {
    kind: 'golem', root, body, height, dead: false, parts, team, ownsDeath: true,
    target: null, moving: false, speed: look.speed, facing: 0, facingTarget: 0, airY: 0,
    update(dt, now) {
      dt = Math.min(dt, 0.05);
      let d = this.facingTarget - this.facing;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.facing += d * Math.min(1, dt * 7);
      root.rotation.y = this.facing;
      const t = now / 1000;
      if (dead) { stepDeath(dt, t); syncInstances(); return; }
      walkK += ((this.moving ? 1 : 0) - walkK) * Math.min(1, dt * 7);
      for (const c in pose) pose[c] = 0;
      if (look.kind === 'biped') {
        const stepHz = this.speed / (4 * P.legLen * Math.sin(P.stride));
        phase += dt * TAU * stepHz * walkK;
        bipedIdle(t); bipedWalk(phase, walkK); layerActs(now); layerRise(now);
        bipedApply(t, dt);
      } else if (look.kind === 'hound') {
        phase += dt * TAU * (this.speed / 1.3) * walkK;
        houndIdle(t); houndGallop(phase, walkK); layerActs(now); layerRise(now);
        houndApply(t, dt);
      } else {
        layerActs(now); layerRise(now);
        wispApply(t, dt);
      }
      syncInstances();
    },
    lookAt(x, z) { this.facingTarget = Math.atan2(x - root.position.x, z - root.position.z); },
    cast() { start('cast'); },
    hit() { start('hit'); },
    strike() { start(look.kind === 'biped' ? P.strike : look.kind === 'hound' ? 'bite' : 'strike'); },
    jump() { start('jump'); },
    summon() {},
    rise() {
      if (dead) return;
      riseT0 = -1; riseDur = ACTS.rise.dur;
      for (const p of allParts) {
        const h = p.userData.home;
        p.userData.riseStart = {
          p: h.p.clone().add(new THREE.Vector3((rnd() - 0.5) * 0.6, -(h.wy + p.userData.size?.[1] * 0.5 + 0.25 + rnd() * 0.5) || -1.2, (rnd() - 0.5) * 0.6)),
          q: new THREE.Quaternion().setFromEuler(new THREE.Euler((rnd() - 0.5) * 3, rnd() * TAU, (rnd() - 0.5) * 3)),
          delay: clamp01(h.wy / height) * 0.5,
        };
        p.position.copy(p.userData.riseStart.p); p.quaternion.copy(p.userData.riseStart.q);
      }
      acts = [];
      start('rise');
    },
    die() {
      if (dead) return;
      dead = this.dead = true; this.moving = false; deathT = 0; acts = []; riseT0 = null;
      if (look.kind !== 'wisp') beginDeath(); else actor.parts = [];
    },
    revive() {
      if (!dead) return;
      dead = this.dead = false; deathT = 0; debris = null;
      for (const p of allParts) { p.userData.home.parent.add(p); p.position.copy(p.userData.home.p); p.quaternion.copy(p.userData.home.q); }
      this.parts = allParts.slice();
      for (const m of myMats) { if (m.userData.pool || m === glassMat) continue; m.transparent = false; m.opacity = 1; m.depthWrite = true; if (m.userData.emissiveI) m.emissiveIntensity = m.userData.emissiveI; }
      if (glassMat) { glassMat.opacity = 0.62; glassMat.depthWrite = true; glassMat.emissiveIntensity = glassMat.userData.emissiveI; }
      coreMat.emissive.copy(coreColor); eyeMat.emissive.setHex(team);
      for (const gl of glows) { gl.material.opacity = gl.userData.opacity; gl.scale.set(gl.userData.size, gl.userData.size, 1); if (gl.userData.v) { gl.userData.v = null; } }
      if (look.kind === 'wisp') { rig.inner.scale.setScalar(0.26); for (const o of rig.orbiters) o.trail.forEach((s) => s.position.set(0, 0, 0)); }
      this.rise();
    },
    handPoint(out = new THREE.Vector3()) {
      const h = rig.hands?.[rig.hands.length - 1] || rig.head || rig.core;
      if (h) { h.getWorldPosition(out); return out; }
      root.getWorldPosition(out); out.y += height * 0.6; return out;
    },
    dispose() {
      for (const m of myMats) m.dispose();
      for (const gl of glows) gl.material.dispose();
      for (const ge of myGeos) ge.dispose();
    },
  };
  return actor;
}
