// The battle mage, built entirely in code.
//
// No model is loaded: the body is a few dozen primitives (lathes, capsules,
// spheres, boxes) placed in a bind pose, skinned by hand to a full humanoid
// skeleton and merged into ONE skinned geometry (plus a second, double-sided
// one for the cape). Cloth folds, fold shading and the per-part roughness and
// metalness are baked into vertex attributes, so cloth, leather, skin, wood
// and iron all draw in that one call. Every animation is a keyframe pose list
// authored below, turned into THREE.AnimationClips.
//
// Animation is a blend, never a switch. Idle, walk and run always run, weighted
// by the measured ground speed and phase-locked to each other; one-shot clips
// fade in over that tree and hand their last pose back by fading out; the
// casts and hits also exist as ADDITIVE upper-body clips that layer on top of
// locomotion when the mage is moving, so the feet keep walking. On top of all
// of it `update()` adds procedural motion: breathing, acceleration and turn
// leans, a head that glances at `facingTarget`, cape and robe bones that lag
// the hips on springs, and a hat tip that wobbles with the head.
//
// Frame: the mage faces +Z at `root.rotation.y = 0`; `root.position` is at the
// feet; +X is its LEFT side; everything is in metres.

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const { DEG2RAD } = THREE.MathUtils;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const wrapAngle = (d) => Math.atan2(Math.sin(d), Math.cos(d));
const _pq = new THREE.Quaternion(), _pq2 = new THREE.Quaternion(), _pe = new THREE.Euler();

/* ----------------------------------------------------------- skeleton */

// [name, parent, local offset]. Positions only: every bone is unrotated in
// the bind pose, so clip rotations are absolute and easy to read. About 7.5
// heads tall: hips at 0.98, shoulders at 1.47, the skull 1.57-1.80.
const BONES = [
  ['hips', null, 0, 0.98, 0],
  ['robe', 'hips', 0, 0, 0],            // procedural: skirt sway and floor lift
  ['spine', 'hips', 0, 0.11, 0],
  ['spine2', 'spine', 0, 0.12, 0],
  ['chest', 'spine2', 0, 0.12, 0],
  ['neck', 'chest', 0, 0.17, 0],
  ['head', 'neck', 0, 0.09, 0],
  ['hat', 'head', 0, 0.21, 0],
  ['hatBrim', 'hat', 0, 0, 0],          // procedural
  ['hatTip', 'hat', 0, 0.15, 0],        // procedural: tip wobble
  ['clavL', 'chest', 0.05, 0.14, 0],
  ['uaL', 'clavL', 0.15, 0, 0],
  ['faL', 'uaL', 0, -0.28, 0],
  ['handL', 'faL', 0, -0.26, 0],
  ['clavR', 'chest', -0.05, 0.14, 0],
  ['uaR', 'clavR', -0.15, 0, 0],
  ['faR', 'uaR', 0, -0.28, 0],
  ['handR', 'faR', 0, -0.26, 0],
  ['staff', 'handR', 0, -0.06, 0.04],
  ['thL', 'hips', 0.09, -0.03, 0],
  ['shL', 'thL', 0, -0.44, 0],
  ['ftL', 'shL', 0, -0.44, 0],
  ['toeL', 'ftL', 0, -0.03, 0.12],
  ['thR', 'hips', -0.09, -0.03, 0],
  ['shR', 'thR', 0, -0.44, 0],
  ['ftR', 'shR', 0, -0.44, 0],
  ['toeR', 'ftR', 0, -0.03, 0.12],
  ['cape1', 'chest', 0, 0.13, -0.14],   // procedural chain
  ['cape2', 'cape1', 0, -0.30, -0.04],
  ['cape3', 'cape2', 0, -0.30, -0.04],
  ['cape4', 'cape3', 0, -0.30, -0.04],
];
const B = {};                       // name -> bone index
const BP = {};                      // name -> bind position (world, root at origin)
BONES.forEach(([n, p, x, y, z], i) => {
  B[n] = i;
  const pp = p ? BP[p] : [0, 0, 0];
  BP[n] = [pp[0] + x, pp[1] + y, pp[2] + z];
});
// Bones the clips drive. Everything else is written by update() each frame.
const ANIM_BONES = ['hips', 'spine', 'spine2', 'chest', 'neck', 'head', 'hat', 'clavL', 'uaL', 'faL', 'handL', 'clavR', 'uaR', 'faR', 'handR', 'staff', 'thL', 'shL', 'ftL', 'toeL', 'thR', 'shR', 'ftR', 'toeR'];
// The upper body: what an additive overlay (a cast or a hit while walking) is allowed to move.
const UPPER_BONES = ['chest', 'neck', 'head', 'hat', 'clavL', 'uaL', 'faL', 'handL', 'clavR', 'uaR', 'faR', 'handR', 'staff'];

/* ----------------------------------------------------------- skinning */

/** A bone's segment, bind-space, for distance weighting. */
const seg = (name, end) => ({ i: B[name], a: BP[name], b: end ? (Array.isArray(end) ? end : BP[end]) : BP[name] });
const SEG = {
  hips: seg('hips', 'spine'), spine: seg('spine', 'spine2'), spine2: seg('spine2', 'chest'), chest: seg('chest', 'neck'),
  neck: seg('neck', 'head'), head: seg('head', [0, 1.82, 0]),
  clavL: seg('clavL', 'uaL'), clavR: seg('clavR', 'uaR'),
  uaL: seg('uaL', 'faL'), faL: seg('faL', 'handL'), handL: seg('handL', [0.20, 0.74, 0]),
  uaR: seg('uaR', 'faR'), faR: seg('faR', 'handR'), handR: seg('handR', [-0.20, 0.74, 0]),
  thL: seg('thL', 'shL'), shL: seg('shL', 'ftL'), ftL: seg('ftL', 'toeL'), toeL: seg('toeL', [0.09, 0.03, 0.22]),
  thR: seg('thR', 'shR'), shR: seg('shR', 'ftR'), ftR: seg('ftR', 'toeR'), toeR: seg('toeR', [-0.09, 0.03, 0.22]),
  cape1: seg('cape1', 'cape2'), cape2: seg('cape2', 'cape3'), cape3: seg('cape3', 'cape4'), cape4: seg('cape4', [0, 0.26, -0.30]),
};
function distSeg(x, y, z, s) {
  const ax = s.a[0], ay = s.a[1], az = s.a[2];
  const dx = s.b[0] - ax, dy = s.b[1] - ay, dz = s.b[2] - az;
  const l2 = dx * dx + dy * dy + dz * dz;
  let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / l2 : 0;
  t = clamp(t, 0, 1);
  const px = ax + dx * t - x, py = ay + dy * t - y, pz = az + dz * t - z;
  return Math.sqrt(px * px + py * py + pz * pz);
}
/** Weights: the two nearest of `segs`, blended by inverse cubed distance. */
function nearest(segs, power = 3) {
  return (x, y, z) => {
    let b1 = null, d1 = Infinity, b2 = null, d2 = Infinity;
    for (const s of segs) {
      const d = distSeg(x, y, z, s);
      if (d < d1) { b2 = b1; d2 = d1; b1 = s; d1 = d; } else if (d < d2) { b2 = s; d2 = d; }
    }
    if (!b2) return [[b1.i, 1]];
    const w1 = 1 / Math.pow(d1 + 0.012, power), w2 = 1 / Math.pow(d2 + 0.012, power);
    const k = w2 / (w1 + w2);
    return k < 0.03 ? [[b1.i, 1]] : [[b1.i, 1 - k], [b2.i, k]];
  };
}
const solo = (name) => () => [[B[name], 1]];

/* ----------------------------------------------------------- geometry */

const COL = {
  skin: 0xd8a383, skinDark: 0xb27c5e, beard: 0xd2cbbd, hair: 0xb5ad9e, eyeWhite: 0xe6e0d4, pupil: 0x16120e, brow: 0x857a69,
  leather: 0x4a3222, leatherLight: 0x6b4830, pouch: 0x5a3d27, gold: 0xc9a24a, boot: 0x2b1f17, trouser: 0x2a282c, under: 0x2d2a2c,
  wood: 0x4b3420, woodDark: 0x2f1f10, iron: 0x66615a, paper: 0xd9cdb0,
};
const tmpColor = new THREE.Color();
const hash01 = (i) => { let h = (i + 1) * 2654435761; h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13; return (h >>> 0) / 4294967296; };

/**
 * Finish a primitive: paint it (hex or (x,y,z)=>hex), skin it (fn(x,y,z) ->
 * [[boneIndex, weight], ...]), give it a material (roughness, metalness) and
 * queue it for the merge.
 */
function part(list, geo, colour, weightFn, { noise = 0.07, rough = 0.85, metal = 0 } = {}) {
  const pos = geo.attributes.position, n = pos.count;
  const col = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4), mat = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    tmpColor.setHex(typeof colour === 'function' ? colour(x, y, z) : colour);
    const k = 1 + (hash01(i * 7 + n) - 0.5) * noise;
    col[i * 3] = tmpColor.r * k; col[i * 3 + 1] = tmpColor.g * k; col[i * 3 + 2] = tmpColor.b * k;
    mat[i * 2] = rough; mat[i * 2 + 1] = metal;
    const ws = weightFn(x, y, z);
    let sum = 0; for (const w of ws) sum += w[1];
    for (let j = 0; j < 4; j++) { si[i * 4 + j] = j < ws.length ? ws[j][0] : 0; sw[i * 4 + j] = j < ws.length ? ws[j][1] / sum : 0; }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  geo.setAttribute('aMat', new THREE.BufferAttribute(mat, 2));
  if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  list.push(geo);
  return geo;
}
const lathe = (pts, segs = 20, phi0 = 0, phiLen = Math.PI * 2) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), segs, phi0, phiLen);
const shade = (hex, k) => tmpColor.setHex(hex).multiplyScalar(k).getHex();
const lighten = (hex, k) => tmpColor.setHex(hex).lerp(new THREE.Color(0xffffff), k).getHex();
const grey = (hex, k) => tmpColor.setHex(hex).lerp(new THREE.Color(0x7a7672), k).getHex();
/** Displace every vertex radially (about Y) by fn(theta, y, r) -> factor, and recompute normals. */
function ripple(geo, fn) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i), r = Math.hypot(x, z);
    if (r < 1e-4) continue;
    const k = fn(Math.atan2(x, z), p.getY(i), r);
    p.setX(i, x * k); p.setZ(i, z * k);
  }
  geo.computeVertexNormals();
  return geo;
}
const MATS = { cloth: { rough: 0.92 }, silk: { rough: 0.72 }, leather: { rough: 0.62 }, skin: { rough: 0.68 }, hair: { rough: 0.8 }, wood: { rough: 0.78 }, iron: { rough: 0.42, metal: 0.85 }, gold: { rough: 0.35, metal: 0.9 }, crystal: { rough: 0.2, metal: 0.1 }, eye: { rough: 0.25 } };
const M = (name, extra = {}) => ({ ...MATS[name], ...extra });

/** Body + cape geometries for a team, built once and shared by every mage of that team. */
const geoCache = new Map();
function buildGeometry(team, teamDark) {
  const key = `${team}:${teamDark}`;
  if (geoCache.has(key)) return geoCache.get(key);
  const body = [], cape = [];
  // The team colour, taken down to a dyed-wool register.
  const robeCol = grey(shade(team, 0.86), 0.28), hatCol = grey(teamDark, 0.12), mantleCol = grey(lighten(teamDark, 0.08), 0.18);
  const trimCol = shade(COL.gold, 0.8), darkCol = shade(teamDark, 0.5), capeCol = grey(shade(teamDark, 0.95), 0.1);
  const foldOf = (th, y) => Math.sin(th * 7 + 0.4 + y * 0.6) * 0.75 + Math.sin(th * 13 + 1.7) * 0.25;   // -1 .. 1

  /* head: skull, jaw, brow, sockets, eyes, nose, cheeks, ears, beard, hair */
  const HC = BP.head[1] + 0.09;   // centre of the skull
  const headW = solo('head');
  part(body, new THREE.SphereGeometry(0.105, 16, 12).scale(1, 1.14, 1.04).translate(0, HC, -0.005), (x, y, z) => (y > HC + 0.07 ? COL.hair : COL.skin), headW, M('skin', { noise: 0.04 }));
  part(body, new THREE.SphereGeometry(0.082, 14, 10).scale(1.0, 0.82, 1.0).translate(0, HC - 0.10, 0.012), COL.skin, headW, M('skin', { noise: 0.04 }));          // jaw
  part(body, new THREE.BoxGeometry(0.15, 0.028, 0.05).translate(0, HC + 0.036, 0.082), shade(COL.skin, 0.97), headW, M('skin', { noise: 0.03 }));                   // brow ridge
  for (const s of [1, -1]) {
    part(body, new THREE.SphereGeometry(0.024, 8, 6).scale(1.15, 0.9, 0.7).translate(s * 0.041, HC + 0.012, 0.086), shade(COL.skinDark, 0.55), headW, { noise: 0, rough: 0.9 }); // socket shadow
    part(body, new THREE.SphereGeometry(0.0125, 7, 5).translate(s * 0.040, HC + 0.011, 0.094), COL.eyeWhite, headW, M('eye', { noise: 0 }));
    part(body, new THREE.SphereGeometry(0.0065, 6, 5).translate(s * 0.040, HC + 0.011, 0.104), COL.pupil, headW, M('eye', { noise: 0 }));
    part(body, new THREE.BoxGeometry(0.04, 0.012, 0.016).rotateX(0.6).rotateZ(s * 0.28).translate(s * 0.047, HC + 0.04, 0.102), COL.brow, headW, M('hair', { noise: 0.14 }));   // bushy brow
    part(body, new THREE.SphereGeometry(0.02, 8, 6).scale(0.45, 1, 0.8).translate(s * 0.107, HC - 0.005, -0.005), shade(COL.skin, 0.95), headW, M('skin', { noise: 0.03 })); // ear
    part(body, new THREE.CapsuleGeometry(0.014, 0.05, 3, 7).rotateZ(s * 1.35).rotateY(-s * 0.35).translate(s * 0.036, HC - 0.047, 0.108), COL.beard, headW, M('hair', { noise: 0.12 })); // moustache
  }
  part(body, new THREE.CapsuleGeometry(0.011, 0.026, 3, 8).rotateX(-0.35).translate(0, HC - 0.002, 0.11), COL.skin, headW, M('skin', { noise: 0.03 }));   // nose bridge
  part(body, new THREE.SphereGeometry(0.019, 10, 8).scale(1.1, 0.9, 1).translate(0, HC - 0.032, 0.122), shade(COL.skin, 0.96), headW, M('skin', { noise: 0.03 }));   // nose tip
  // Hair under the hat, sides and back only.
  part(body, ripple(lathe([[0.09, HC - 0.095], [0.11, HC - 0.075], [0.122, HC - 0.03], [0.118, HC + 0.03], [0.08, HC + 0.07]], 16, 1.0, Math.PI * 2 - 2.0), (th, y) => 1 + Math.sin(th * 11) * 0.03), COL.hair, headW, M('hair', { noise: 0.14 }));
  // Beard: a full wedge with volume, roughened.
  const beard = lathe([[0, -0.30], [0.025, -0.27], [0.05, -0.21], [0.07, -0.14], [0.085, -0.06], [0.075, 0.01], [0, 0.02]], 14);
  ripple(beard, (th, y) => 1 + Math.sin(th * 9 + y * 20) * 0.05);
  beard.scale(1.1, 1.1, 0.72).translate(0, HC - 0.075, 0.045);
  part(body, beard, (x, y) => shade(COL.beard, 0.86 + 0.14 * smooth((y - 1.3) / 0.3)), nearest([SEG.head, SEG.neck]), M('hair', { noise: 0.14 }));
  part(body, new THREE.CylinderGeometry(0.048, 0.056, 0.14, 10).translate(0, HC - 0.145, -0.01), shade(COL.skin, 0.86), nearest([SEG.chest, SEG.neck, SEG.head]), M('skin', { noise: 0.03 }));

  /* hat: crown with a soft crease and a bent tip, band, buckle, worn brim */
  const HY = BP.hat[1];   // crown base
  const crown = lathe([[0, 0], [0.145, 0], [0.142, 0.03], [0.125, 0.07], [0.098, 0.115], [0.07, 0.16], [0.046, 0.20], [0.026, 0.235], [0.01, 0.26], [0, 0.27]], 26);
  ripple(crown, (th, y) => {
    // A crease on the left-front side, deepest a third of the way up, and a faint sag all round.
    const crease = Math.exp(-Math.pow(wrapAngle(th - 0.9) / 0.55, 2)) * Math.exp(-Math.pow((y - 0.08) / 0.045, 2)) * 0.22;
    return 1 - crease + Math.sin(th * 5 + 0.3) * 0.012 * smooth(y / 0.1);
  });
  {
    const p = crown.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (y > 0.09) { const k = y - 0.09; p.setZ(i, p.getZ(i) - k * k * 2.0); p.setX(i, p.getX(i) + k * k * 0.5); p.setY(i, y - k * k * 0.6); }
    }
    crown.computeVertexNormals();
    crown.translate(0, HY, 0);
  }
  part(body, crown, (x, y, z) => shade(hatCol, 0.82 + 0.18 * smooth((y - HY) / 0.2)), (x, y) => { const k = smooth((y - HY - 0.08) / 0.1); return k < 0.02 ? [[B.hat, 1]] : [[B.hat, 1 - k], [B.hatTip, k]]; }, M('cloth', { noise: 0.08 }));
  part(body, new THREE.CylinderGeometry(0.146, 0.154, 0.045, 26, 1, true).translate(0, HY + 0.025, 0), COL.leather, solo('hat'), M('leather', { noise: 0.04 }));
  part(body, new THREE.BoxGeometry(0.038, 0.038, 0.014).translate(0, HY + 0.025, 0.155), COL.gold, solo('hat'), M('gold', { noise: 0 }));
  // The brim sags with wear, curls a little toward its edge, and is thicker than paper.
  const brim = lathe([[0.125, -0.026], [0.20, -0.028], [0.26, -0.014], [0.285, 0.004], [0.275, 0.02], [0.20, 0.004], [0.125, 0.0]], 30);
  {
    const p = brim.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i), r = Math.hypot(x, z), th = Math.atan2(x, z);
      const edge = clamp((r - 0.125) / 0.15, 0, 1);
      p.setY(i, p.getY(i) + (Math.sin(th * 3 + 0.6) * 0.014 + Math.sin(th * 7 + 2.1) * 0.006 - 0.02 * edge * edge * (1 - 0.6 * Math.cos(th))) * edge);
    }
    brim.computeVertexNormals();
    brim.translate(0, HY + 0.003, 0);
  }
  part(body, brim, (x, y, z) => (y < HY - 0.008 ? shade(hatCol, 0.62) : shade(hatCol, 0.9)), solo('hatBrim'), M('cloth', { noise: 0.08 }));

  /* robe: a lathe with folds baked in, closed at the hem so the underside reads from below */
  const robe = lathe([[0, 0.23], [0.30, 0.21], [0.33, 0.235], [0.325, 0.34], [0.30, 0.50], [0.265, 0.68], [0.235, 0.84], [0.21, 0.95], [0.19, 1.02], [0.172, 1.09], [0.165, 1.16], [0.172, 1.24], [0.188, 1.33], [0.205, 1.41], [0.195, 1.47], [0.13, 1.52], [0.075, 1.545]], 36);
  ripple(robe, (th, y) => 1 + foldOf(th, y) * 0.05 * smooth((1.02 - y) / 0.55) + Math.sin(th * 4 + 2) * 0.01 * smooth((y - 1.1) / 0.3));
  robe.scale(1, 1, 0.84);
  const torsoW = nearest([SEG.hips, SEG.spine, SEG.spine2, SEG.chest]);
  part(body, robe, (x, y, z) => {
    const f = foldOf(Math.atan2(x, z / 0.84), y) * smooth((1.02 - y) / 0.55);
    const k = 0.74 + 0.26 * smooth((y - 0.2) / 1.2) + f * 0.14 - 0.05 * (1 - smooth((y - 0.23) / 0.12));
    if (y < 0.225) return shade(robeCol, 0.45);                           // the lining, seen when the hem lifts
    if (Math.abs(x) < 0.028 && z > 0 && y > 1.02 && y < 1.46) return shade(trimCol, 0.9 * k);   // front braid
    if (y > 1.455) return shade(darkCol, 0.9);                            // collar
    return shade(robeCol, k);
  }, (x, y, z) => {
    if (y > 0.95) return torsoW(x, y, z);
    // The thighs carry the cloth over the knees; the hem keeps more of the
    // robe bone so the floor lift in update() can reach it.
    const k = y > 0.48 ? 0.72 * smooth((0.95 - y) / 0.47) : 0.72 - 0.3 * smooth((0.48 - y) / 0.3);
    const s = clamp(x / 0.09, -1, 1) * 0.5 + 0.5;
    return [[B.robe, 1 - k], [B.thL, k * s], [B.thR, k * (1 - s)]];
  }, M('cloth', { noise: 0.06 }));

  /* mantle over the shoulders, scalloped hem, braided edge */
  const mantle = lathe([[0.1, 1.51], [0.135, 1.455], [0.215, 1.35], [0.262, 1.31], [0.275, 1.335], [0.23, 1.45], [0.15, 1.53], [0.085, 1.56]], 28);
  {
    const p = mantle.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i), y = p.getY(i), th = Math.atan2(x, z);
      if (y < 1.40) p.setY(i, y + Math.sin(th * 8) * 0.016 * smooth((1.40 - y) / 0.06));
    }
    mantle.computeVertexNormals();
    mantle.scale(1, 1, 0.84);
  }
  part(body, mantle, (x, y) => (y < 1.345 ? shade(trimCol, 0.85) : shade(mantleCol, 0.86 + 0.14 * smooth((y - 1.33) / 0.2))), nearest([SEG.chest, SEG.clavL, SEG.clavR, SEG.neck]), M('cloth', { noise: 0.07 }));
  part(body, new THREE.BoxGeometry(0.05, 0.045, 0.02).translate(0, 1.49, 0.14), COL.gold, solo('chest'), M('gold', { noise: 0 }));

  /* arms: bell sleeve to the elbow, fitted undersleeve to the wrist, hands with fingers */
  for (const s of [1, -1]) {
    const side = s > 0 ? 'L' : 'R';
    const SX = s * 0.20, SY = 1.47;
    const sleeve = lathe([[0.085, -0.24], [0.09, -0.34], [0.13, -0.385], [0.145, -0.37], [0.125, -0.30], [0.103, -0.18], [0.105, -0.06], [0.09, 0.04], [0, 0.05]], 16);
    ripple(sleeve, (th, y) => 1 + Math.sin(th * 5 + s) * 0.03 * smooth((-y - 0.1) / 0.2));
    sleeve.translate(SX, SY, 0);
    part(body, sleeve, (x, y) => (y < SY - 0.36 ? shade(robeCol, 0.5) : shade(robeCol, 0.86 + 0.1 * smooth((y - 1.1) / 0.4))), nearest([SEG['ua' + side], SEG['fa' + side]]), M('cloth', { noise: 0.06 }));
    part(body, new THREE.CylinderGeometry(0.047, 0.042, 0.33, 10).translate(SX, SY - 0.41, 0), COL.under, nearest([SEG['ua' + side], SEG['fa' + side], SEG['hand' + side]]), M('cloth', { noise: 0.05 }));
    part(body, new THREE.CylinderGeometry(0.05, 0.046, 0.08, 10).translate(SX, SY - 0.50, 0), COL.leatherLight, nearest([SEG['fa' + side], SEG['hand' + side]]), M('leather', { noise: 0.05 }));   // wrist cuff
    // Hand: palm, four fingers curled a little, thumb.
    const HX = SX, HY2 = BP['hand' + side][1];
    const handW = solo('hand' + side);
    part(body, new THREE.BoxGeometry(0.072, 0.085, 0.032).translate(HX, HY2 - 0.035, 0.008), COL.skin, handW, M('skin', { noise: 0.03 }));
    for (let f = 0; f < 4; f++) {
      const fx = HX + s * (0.022 - f * 0.0145), len = f === 0 || f === 3 ? 0.04 : 0.05;
      part(body, new THREE.CapsuleGeometry(0.0095, len, 2, 6).rotateX(-0.55).translate(fx, HY2 - 0.085 - len * 0.4, 0.02 + len * 0.3), shade(COL.skin, 0.96), handW, M('skin', { noise: 0.03 }));
    }
    part(body, new THREE.CapsuleGeometry(0.011, 0.04, 2, 6).rotateZ(s * 0.9).rotateX(-0.5).translate(HX + s * 0.045, HY2 - 0.035, 0.03), COL.skin, handW, M('skin', { noise: 0.03 }));
  }

  /* belt, buckle, pouches, a bound book on the right hip, a scroll on the left */
  part(body, new THREE.TorusGeometry(0.172, 0.02, 7, 30).rotateX(Math.PI / 2).scale(1, 1, 0.84).translate(0, 1.05, 0), COL.leather, nearest([SEG.hips, SEG.spine]), M('leather', { noise: 0.04 }));
  part(body, new THREE.BoxGeometry(0.055, 0.05, 0.02).translate(0, 1.05, 0.15), COL.gold, solo('spine'), M('gold', { noise: 0 }));
  for (const s of [1, -1]) {
    part(body, new THREE.BoxGeometry(0.075, 0.095, 0.05).rotateY(-s * 0.6).translate(s * 0.145, 0.965, 0.1), COL.pouch, solo('hips'), M('leather', { noise: 0.05 }));
    part(body, new THREE.BoxGeometry(0.08, 0.03, 0.056).rotateY(-s * 0.6).translate(s * 0.145, 1.01, 0.1), shade(COL.pouch, 0.7), solo('hips'), M('leather', { noise: 0.05 }));
  }
  part(body, new THREE.BoxGeometry(0.035, 0.13, 0.1).rotateY(0.2).translate(-0.17, 0.93, -0.03), shade(COL.leather, 1.1), solo('hips'), M('leather', { noise: 0.05 }));   // book
  part(body, new THREE.BoxGeometry(0.03, 0.12, 0.092).rotateY(0.2).translate(-0.171, 0.93, -0.03), COL.paper, solo('hips'), { noise: 0.1, rough: 0.95 });
  part(body, new THREE.CylinderGeometry(0.018, 0.018, 0.16, 8).rotateX(0.3).rotateZ(0.5).translate(0.16, 0.92, -0.05), COL.paper, solo('hips'), { noise: 0.1, rough: 0.95 });  // scroll

  /* legs and boots */
  for (const s of [1, -1]) {
    const side = s > 0 ? 'L' : 'R';
    part(body, new THREE.CylinderGeometry(0.058, 0.064, 0.46, 10).translate(s * 0.09, 0.72, 0), COL.trouser, nearest([SEG['th' + side], SEG['sh' + side]]), M('cloth', { noise: 0.04 }));
    part(body, new THREE.SphereGeometry(0.062, 10, 8).translate(s * 0.09, 0.51, 0.005), COL.trouser, nearest([SEG['th' + side], SEG['sh' + side]]), M('cloth', { noise: 0.04 }));   // knee
    part(body, new THREE.CylinderGeometry(0.05, 0.056, 0.30, 10).translate(s * 0.09, 0.36, 0), COL.trouser, nearest([SEG['th' + side], SEG['sh' + side]]), M('cloth', { noise: 0.04 }));
    part(body, new THREE.CylinderGeometry(0.06, 0.068, 0.30, 12).translate(s * 0.09, 0.21, 0), COL.boot, nearest([SEG['sh' + side], SEG['ft' + side]]), M('leather', { noise: 0.05 }));
    part(body, new THREE.TorusGeometry(0.062, 0.014, 6, 14).rotateX(Math.PI / 2).translate(s * 0.09, 0.345, 0), shade(COL.boot, 1.25), nearest([SEG['sh' + side]]), M('leather', { noise: 0.05 }));   // cuff
    const foot = new THREE.CapsuleGeometry(0.052, 0.14, 4, 10).rotateX(Math.PI / 2).scale(1.05, 0.78, 1).translate(s * 0.09, 0.045, 0.08);
    part(body, foot, COL.boot, (x, y, z) => { const k = smooth((z - 0.09) / 0.08); return k < 0.02 ? [[B['ft' + side], 1]] : [[B['ft' + side], 1 - k], [B['toe' + side], k]]; }, M('leather', { noise: 0.05 }));
    part(body, new THREE.BoxGeometry(0.09, 0.03, 0.07).translate(s * 0.09, 0.015, -0.01), shade(COL.boot, 0.7), solo('ft' + side), M('leather', { noise: 0.05 }));   // heel
  }

  // The height the HUD and the arena use: the top of the hat, not the staff.
  let bodyTop = 0;
  for (const g of body) { g.computeBoundingBox(); bodyTop = Math.max(bodyTop, g.boundingBox.max.y); }

  /* staff: gnarled shaft, two knots, iron collar, three prongs, crystal */
  const sx = BP.staff[0], sy = BP.staff[1], sz = BP.staff[2];
  const shaft = new THREE.CylinderGeometry(0.015, 0.024, 1.86, 10, 12);
  {
    const p = shaft.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i), th = Math.atan2(x, z);
      const k = 1 + Math.sin(y * 9 + th * 2) * 0.12 + Math.sin(y * 23) * 0.06;
      p.setX(i, x * k + Math.sin(y * 2.6 + 0.5) * 0.012); p.setZ(i, z * k + Math.cos(y * 3.1) * 0.008);
    }
    shaft.computeVertexNormals();
    shaft.translate(sx, sy + 0.07, sz);
  }
  part(body, shaft, (x, y) => shade(COL.wood, 0.8 + 0.3 * hash01(Math.floor(y * 40))), solo('staff'), M('wood', { noise: 0.12 }));
  part(body, new THREE.SphereGeometry(0.03, 8, 6).scale(1, 1.5, 1).translate(sx + 0.008, sy + 0.42, sz), COL.woodDark, solo('staff'), M('wood', { noise: 0.1 }));
  part(body, new THREE.SphereGeometry(0.026, 8, 6).scale(1, 1.4, 1).translate(sx - 0.006, sy - 0.25, sz + 0.004), COL.woodDark, solo('staff'), M('wood', { noise: 0.1 }));
  part(body, new THREE.CylinderGeometry(0.034, 0.024, 0.07, 8).translate(sx, sy + 0.90, sz), COL.iron, solo('staff'), M('iron', { noise: 0.05 }));
  part(body, new THREE.TorusGeometry(0.022, 0.006, 5, 10).translate(sx, sy - 0.7, sz), COL.iron, solo('staff'), M('iron', { noise: 0.05 }));
  for (let k = 0; k < 3; k++) {
    const a = k * Math.PI * 2 / 3 + 0.4;
    const prong = new THREE.BoxGeometry(0.014, 0.13, 0.014).translate(0, 0.06, 0).rotateX(-0.42).rotateY(a).translate(sx + Math.sin(a) * 0.01, sy + 0.93, sz + Math.cos(a) * 0.01);
    part(body, prong, COL.iron, solo('staff'), M('iron', { noise: 0.05 }));
  }
  part(body, mergeVertices(new THREE.OctahedronGeometry(0.062, 0)).scale(1, 1.75, 1).translate(sx, sy + 1.0, sz), lighten(team, 0.45), solo('staff'), M('crystal', { noise: 0 }));

  /* cape: a curved strip hanging off the shoulders, folds baked in, skinned to the chain */
  const capeGeo = new THREE.PlaneGeometry(1, 1, 10, 16);
  {
    const p = capeGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i), v = p.getY(i);
      const y = 1.47 - (0.5 - v) * 1.22;
      const d = (1.47 - y);
      const w = 0.44 + d * 0.18;
      const x = u * w;
      const z = -0.15 - d * 0.16 - (x / 0.3) * (x / 0.3) * 0.07 + Math.sin(u * Math.PI * 4 + 0.5) * 0.028 * smooth(d / 0.5);
      p.setXYZ(i, x, y, z);
    }
    capeGeo.computeVertexNormals();
  }
  part(cape, capeGeo, (x, y) => shade(capeCol, 0.72 + 0.3 * smooth((y - 0.2) / 1.3) + Math.sin((x / (0.44 + (1.47 - y) * 0.18)) * Math.PI * 4 + 0.5) * 0.08 * smooth((1.47 - y) / 0.5)), nearest([SEG.cape1, SEG.cape2, SEG.cape3, SEG.cape4], 4), M('cloth', { noise: 0.05 }));

  const out = { body: mergeGeometries(body, false), cape: mergeGeometries(cape, false) };
  for (const g of body) g.dispose();
  out.body.computeBoundingSphere(); out.cape.computeBoundingSphere();
  out.height = +bodyTop.toFixed(3);
  geoCache.set(key, out);
  return out;
}

/* ----------------------------------------------------------- dissolve */

// A dead mage goes to dust: fragments are cut away along a front that sweeps
// the body (feet to head, with a noise so it crumbles rather than wipes), an
// ashen rim just ahead of the front. The cut is in the SKINNED position, so
// it follows the pose, and the same cut goes into each mesh's depth material
// so the shadow crumbles with the body instead of lingering as a black mage.
// `uDis` 0 = whole, 1 = gone; run it 1 -> 0 with `uDisGlow` up to materialise.
const DIS_VERT_DECL = 'varying vec3 vDisP; attribute vec2 aMat; varying vec2 vMat;';
const DIS_VERT_SET = 'vDisP = transformed; vMat = aMat;';
const DIS_FRAG_DECL = /* glsl */`
uniform float uDis; uniform vec3 uDisDir; uniform float uDisLo; uniform float uDisHi; uniform vec3 uDisTint; uniform float uDisGlow;
varying vec3 vDisP; varying vec2 vMat;
float disEdge = 0.0;
float disHash(vec3 p) { p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float disNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(disHash(i), disHash(i + vec3(1.0, 0.0, 0.0)), f.x), mix(disHash(i + vec3(0.0, 1.0, 0.0)), disHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(disHash(i + vec3(0.0, 0.0, 1.0)), disHash(i + vec3(1.0, 0.0, 1.0)), f.x), mix(disHash(i + vec3(0.0, 1.0, 1.0)), disHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
void disCut() {
  if (uDis <= 0.0) return;
  float dk = clamp((dot(vDisP, uDisDir) - uDisLo) / (uDisHi - uDisLo), 0.0, 1.0);
  float nz = disNoise(vDisP * 9.0) * 0.7 + disNoise(vDisP * 31.0) * 0.3;
  float key = dk * 0.62 + nz * 0.38;
  float th = uDis * 1.1 - 0.05;
  if (key < th) discard;
  disEdge = 1.0 - smoothstep(th, th + 0.09, key);
}
`;
// The JS side of the same key, for picking where the dust comes off.
const DIS_KEY_MIX = 0.62, DIS_NOISE_MEAN = 0.38 * 0.5;
const disThreshold = (k) => k * 1.1 - 0.05;

function patchDissolve(shader, U, lit) {
  Object.assign(shader.uniforms, U);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${DIS_VERT_DECL}`)
    .replace('#include <skinning_vertex>', `#include <skinning_vertex>\n${DIS_VERT_SET}`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${DIS_FRAG_DECL}`)
    .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\ndisCut();');
  if (lit) {
    shader.fragmentShader = shader.fragmentShader
      // Per-vertex material: cloth, leather, skin, wood and iron in one draw.
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vMat.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vMat.y;')
      // Ash on the rim, and the whole body greys as it goes (not when materialising: then the rim glows instead).
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, uDisTint, min(1.0, disEdge * 0.85 + uDis * 0.45 * (1.0 - min(uDisGlow, 1.0))));')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uDisTint * disEdge * uDisGlow;');
  }
}
const DIS_KEY_LIT = () => 'mage-dissolve-lit';
const DIS_KEY_DEPTH = () => 'mage-dissolve-depth';

/** One mage's materials: its own, so its dissolve is its own. */
function materials(U) {
  const body = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1 });
  const cape = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1, side: THREE.DoubleSide });
  for (const m of [body, cape]) { m.onBeforeCompile = (sh) => patchDissolve(sh, U, true); m.customProgramCacheKey = DIS_KEY_LIT; }
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (sh) => patchDissolve(sh, U, false); depth.customProgramCacheKey = DIS_KEY_DEPTH;
  return { body, cape, depth };
}

/* ----------------------------------------------------------- poses */

// The rest pose every key starts from. Degrees, XYZ order. Conventions (bone
// axes are world axes in bind): limbs point -Y, so -X swings a limb FORWARD;
// elbow flex (hand forward) is -X, knee flex (foot back) is +X. On the
// spine/head, +X bows forward, +Y turns to the left, +Z leans right. For the
// left arm +Z abducts, for the right arm -Z. The staff points up its own +Y;
// with the chain all about X, staff.x = -(uaR.x + faR.x) keeps it vertical.
// Rotations compound down the chain: a thigh's world pitch is hips.x + th.x.
const STAND = {
  pos: [0, 0, 0], hips: [0, 0, 1.5], spine: [3, 0, -1], spine2: [1, 0, 0], chest: [-3, 0, 0], neck: [3, 0, 0], head: [-1, 0, 0], hat: [0, 0, 0],
  clavL: [0, 0, 0], uaL: [-5, 0, 13], faL: [-16, 0, 0], handL: [0, 0, 0],
  clavR: [0, 0, 0], uaR: [-7, 0, -12], faR: [-22, 0, 0], handR: [0, 0, 0], staff: [29, 0, 12],
  thL: [-3, 0, 5], shL: [4, 0, 0], ftL: [-1, 0, -5], toeL: [0, 0, 0],
  thR: [1, 0, -4], shR: [3, 0, 0], ftR: [-4, 0, 4], toeR: [0, 0, 0],
};
// Flat on the back, where death ends and standUp/tumbleLand begin.
const LIE_BACK = {
  pos: [0, -0.84, -0.12], hips: [-86, 0, 0], spine: [4, 0, 0], spine2: [0, 0, 0], chest: [4, 0, 0], neck: [10, 0, 0], head: [20, 0, 0], hat: [-6, 0, 0],
  uaL: [-15, 0, 55], faL: [-30, 0, 0], uaR: [-10, 0, -50], faR: [-25, 0, 0], staff: [35, 0, 0],
  thL: [-10, 0, 8], shL: [15, 0, 0], ftL: [25, 0, -8], thR: [-5, 0, -8], shR: [10, 0, 0], ftR: [25, 0, 8],
};
// Face down, where a forward knockdown lands.
const PRONE = {
  pos: [0, -0.80, 0.05], hips: [84, 0, 0], spine: [-4, 0, 0], spine2: [0, 0, 0], chest: [-6, 0, 0], neck: [-12, 0, 0], head: [-22, 0, 0], hat: [-6, 0, 0],
  uaL: [-40, 0, 45], faL: [-85, 0, 0], uaR: [-40, 0, -45], faR: [-85, 0, 0], staff: [125, 0, 0],
  thL: [2, 0, 5], shL: [8, 0, 0], ftL: [-45, 0, -5], thR: [2, 0, -5], shR: [8, 0, 0], ftR: [-45, 0, 5],
};
const CROUCH = {
  spine: [18, 0, 0], chest: [4, 0, 0], head: [-10, 0, 0], pos: [0, -0.2, 0],
  thL: [-48, 0, 6], shL: [75, 0, 0], ftL: [-27, 0, -6], thR: [-48, 0, -6], shR: [75, 0, 0], ftR: [-27, 0, 6],
};
// Off the back and onto the feet, from `t0`, over 1.6*k seconds: sit up, crouch, half up, stand.
const GETUP = (t0, k = 1) => [
  [t0 + 0.35 * k, { pos: [0, -0.64, -0.1], hips: [-40, 0, 0], spine: [35, 0, 0], chest: [15, 0, 0], head: [0, 0, 0], neck: [0, 0, 0], hat: [-3, 0, 0],
    thL: [-70, 0, 8], shL: [100, 0, 0], ftL: [10, 0, -8], thR: [-65, 0, -8], shR: [95, 0, 0], ftR: [10, 0, 8],
    uaL: [10, 0, 30], faL: [-40, 0, 0], uaR: [20, 0, -30], faR: [-20, 0, 0], staff: [30, 0, 0] }],
  [t0 + 0.55 * k, { pos: [0, -0.46, -0.02], hips: [-10, 0, 0], spine: [30, 0, 0], chest: [10, 0, 0], head: [-10, 0, 0],
    thL: [-75, 0, 8], shL: [105, 0, 0], ftL: [-10, 0, -8], thR: [-72, 0, -8], shR: [102, 0, 0], ftR: [-10, 0, 8],
    uaL: [-10, 0, 28], faL: [-40, 0, 0], uaR: [-30, 0, -25], faR: [-25, 0, 0], staff: [55, 0, 8] }],
  [t0 + 0.75 * k, { pos: [0, -0.30, 0.02], hips: [10, 0, 0], spine: [25, 0, 0], chest: [5, 0, 0], head: [-20, 0, 0],
    thL: [-55, 0, 8], shL: [85, 0, 0], ftL: [-30, 0, -8], thR: [-55, 0, -8], shR: [85, 0, 0], ftR: [-30, 0, 8],
    uaL: [-30, 0, 25], faL: [-40, 0, 0], uaR: [-45, 0, -20], faR: [-30, 0, 0], staff: [75, 0, 12] }],
  [t0 + 1.15 * k, { pos: [0, -0.1, 0], spine: [12, 0, 0], head: [-8, 0, 0],
    thL: [-25, 0, 6], shL: [40, 0, 0], ftL: [-15, 0, -6], thR: [-25, 0, -6], shR: [40, 0, 0], ftR: [-15, 0, 6],
    uaR: [-30, 0, -18], faR: [-30, 0, 0], staff: [60, 0, 12], uaL: [-10, 0, 20] }],
  [t0 + 1.6 * k, {}],
];
// Hanging in a deliberate drop: legs tucked, arms out for balance, looking at the landing.
const HANG = {
  spine: [6, 0, 0], chest: [2, 0, 0], head: [14, 0, 0], hat: [-6, 0, 0], pos: [0, -0.04, 0],
  thL: [-40, 0, 10], shL: [60, 0, 0], ftL: [20, 0, -10], thR: [-55, 0, -10], shR: [75, 0, 0], ftR: [25, 0, 10],
  uaL: [-30, 0, 85], faL: [-25, 0, 0], handL: [0, 0, 20], uaR: [-25, 0, -80], faR: [-20, 0, 0], staff: [45, 0, 0],
};
// Feet reaching for the ground just before contact.
const REACH = {
  spine: [10, 0, 0], chest: [2, 0, 0], head: [12, 0, 0], pos: [0, -0.02, 0],
  thL: [-22, 0, 8], shL: [30, 0, 0], ftL: [8, 0, -8], thR: [-25, 0, -8], shR: [32, 0, 0], ftR: [8, 0, 8],
  uaL: [-30, 0, 70], faL: [-25, 0, 0], uaR: [-25, 0, -65], faR: [-20, 0, 0], staff: [45, 0, 0],
};
// A rigid lightning jolt: arms clenched in, head back, feet planted wide.
const JOLT = planted({
  spine: [-10, 0, 0], chest: [-9, 0, 3], neck: [-6, 0, 0], head: [-16, 0, 5], hat: [-8, 0, 0], pos: [0, 0.02, -0.02],
  uaL: [-20, 0, 60], faL: [-110, 0, 0], handL: [-30, 0, 0], uaR: [-18, 0, -55], faR: [-100, 0, 0], handR: [-20, 0, 0], staff: [0, 0, 0],
  thL: [-3, 0, 9], thR: [1, 0, -9], ftL: [-1, 0, -9], ftR: [-4, 0, 9],
});

/** The pose with its staff kept upright: the staff's rotation undoes the chain it hangs from (hips to hand, pitch and roll). */
function planted(p) {
  const f = { ...STAND, ...p };
  _pq.identity();
  for (const b of ['hips', 'spine', 'spine2', 'chest', 'clavR', 'uaR', 'faR', 'handR']) {
    _pe.set(f[b][0] * DEG2RAD, f[b][1] * DEG2RAD, f[b][2] * DEG2RAD, 'XYZ');
    _pq.multiply(_pq2.setFromEuler(_pe));
  }
  _pe.setFromQuaternion(_pq.invert(), 'XYZ');
  return { ...p, staff: [_pe.x / DEG2RAD, _pe.y / DEG2RAD, _pe.z / DEG2RAD] };
}
const P = planted;

// name -> [[time, pose, ease?], ...]. A loop's last key equals its first.
const CLIPS = {
  idle: [
    [0, {}],
    [1.4, P({ pos: [0.025, -0.012, 0], hips: [0, 2, 3], spine: [3, -2, -3], chest: [-3, 1, -1], head: [-2, 4, 1], uaL: [-4, 0, 15], faL: [-14, 0, 0], thL: [-3, 0, 7], ftL: [-1, 0, -7], thR: [1, 0, -2], ftR: [-4, 0, 2] })],
    [2.8, P({ pos: [-0.02, -0.01, 0], hips: [0, -2, -2], spine: [3, 2, 2], chest: [-3, -1, 1], head: [-3, -4, -1], faR: [-25, 0, 0], thL: [-3, 0, 3], ftL: [-1, 0, -3], thR: [1, 0, -6], ftR: [-4, 0, 6] })],
    [4.2, {}],
  ],
  fidget: [
    [0, {}],
    [0.45, { uaL: [-55, 0, 20], faL: [-75, 0, 0], uaR: [-45, 0, -10], faR: [-70, 0, 0], staff: [115, 0, 10], head: [8, 0, 0], spine: [5, 0, 0] }],
    [0.9, { uaL: [-60, 10, 15], faL: [-80, 0, 0], handL: [0, 60, 0], uaR: [-45, 0, -10], faR: [-70, 0, 0], staff: [115, 0, 10], head: [9, 4, 0], spine: [5, 0, 0] }],
    [1.4, { uaL: [-50, -10, 25], faL: [-70, 0, 0], handL: [0, -50, 0], uaR: [-45, 0, -10], faR: [-70, 0, 0], staff: [115, 0, 10], head: [8, -4, 0], spine: [5, 0, 0] }],
    [1.8, { uaL: [-55, 0, 20], faL: [-75, 0, 0], uaR: [-45, 0, -10], faR: [-70, 0, 0], staff: [115, 0, 10], head: [8, 0, 0], spine: [5, 0, 0] }],
    [2.2, {}],
  ],
  // Heel strike at 0 and 0.5, the pelvis swinging with the stride and the chest countering it.
  walk: [
    [0, P({ thL: [-26, 0, 5], shL: [8, 0, 0], ftL: [-14, 0, -5], thR: [18, 0, -4], shR: [22, 0, 0], ftR: [18, 0, 4], toeR: [14, 0, 0], pos: [0, -0.012, 0], hips: [2, -5, 2], spine: [3, 2, 0], chest: [-3, 6, -2], head: [-1, -3, 0],
      uaL: [16, 0, 13], faL: [-14, 0, 0], uaR: [-18, 0, -12], faR: [-28, 0, 0] })],
    [0.25, P({ thL: [-8, 0, 5], shL: [10, 0, 0], ftL: [-2, 0, -5], thR: [-6, 0, -4], shR: [50, 0, 0], ftR: [16, 0, 4], pos: [0, 0.016, 0], hips: [2, 0, -3], spine: [3, 0, 2], chest: [-3, 0, 1], uaL: [2, 0, 13], faL: [-18, 0, 0], uaR: [-8, 0, -12], faR: [-24, 0, 0] })],
    [0.5, P({ thR: [-26, 0, -5], shR: [8, 0, 0], ftR: [-14, 0, 5], thL: [18, 0, 4], shL: [22, 0, 0], ftL: [18, 0, -4], toeL: [14, 0, 0], pos: [0, -0.012, 0], hips: [2, 5, -2], spine: [3, -2, 0], chest: [-3, -6, 2], head: [-1, 3, 0],
      uaL: [-20, 0, 13], faL: [-30, 0, 0], uaR: [4, 0, -12], faR: [-18, 0, 0] })],
    [0.75, P({ thR: [-8, 0, -5], shR: [10, 0, 0], ftR: [-2, 0, 5], thL: [-6, 0, 4], shL: [50, 0, 0], ftL: [16, 0, -4], pos: [0, 0.016, 0], hips: [2, 0, 3], spine: [3, 0, -2], chest: [-3, 0, -1], uaL: [-10, 0, 13], faL: [-24, 0, 0], uaR: [-8, 0, -12], faR: [-24, 0, 0] })],
    [1.0, P({ thL: [-26, 0, 5], shL: [8, 0, 0], ftL: [-14, 0, -5], thR: [18, 0, -4], shR: [22, 0, 0], ftR: [18, 0, 4], toeR: [14, 0, 0], pos: [0, -0.012, 0], hips: [2, -5, 2], spine: [3, 2, 0], chest: [-3, 6, -2], head: [-1, -3, 0],
      uaL: [16, 0, 13], faL: [-14, 0, 0], uaR: [-18, 0, -12], faR: [-28, 0, 0] })],
  ],
  // Forward lean, a flight phase at 0.15/0.46, the arms pumping (the staff carried forward).
  run: [
    [0, { thL: [-40, 0, 4], shL: [18, 0, 0], ftL: [-8, 0, -4], thR: [28, 0, -4], shR: [55, 0, 0], ftR: [20, 0, 4], toeR: [12, 0, 0], pos: [0, -0.035, 0], hips: [4, -7, 2], spine: [12, 3, 0], chest: [2, 9, -2], head: [-11, -4, 0],
      uaL: [32, 0, 10], faL: [-72, 0, 0], uaR: [-44, 0, -14], faR: [-82, 0, 0], staff: [124, 0, 14] }],
    [0.15, { thL: [-6, 0, 4], shL: [42, 0, 0], ftL: [6, 0, -4], thR: [-12, 0, -4], shR: [88, 0, 0], ftR: [26, 0, 4], pos: [0, 0.05, 0], hips: [4, 0, -2], spine: [12, 0, 0], chest: [2, 0, 0], head: [-11, 0, 0],
      uaL: [-6, 0, 10], faL: [-72, 0, 0], uaR: [-26, 0, -14], faR: [-82, 0, 0], staff: [106, 0, 14] }],
    [0.31, { thR: [-40, 0, -4], shR: [18, 0, 0], ftR: [-8, 0, 4], thL: [28, 0, 4], shL: [55, 0, 0], ftL: [20, 0, -4], toeL: [12, 0, 0], pos: [0, -0.035, 0], hips: [4, 7, -2], spine: [12, -3, 0], chest: [2, -9, 2], head: [-11, 4, 0],
      uaL: [-42, 0, 10], faL: [-72, 0, 0], uaR: [-4, 0, -14], faR: [-82, 0, 0], staff: [84, 0, 14] }],
    [0.46, { thR: [-6, 0, -4], shR: [42, 0, 0], ftR: [6, 0, 4], thL: [-12, 0, 4], shL: [88, 0, 0], ftL: [26, 0, -4], pos: [0, 0.05, 0], hips: [4, 0, 2], spine: [12, 0, 0], chest: [2, 0, 0], head: [-11, 0, 0],
      uaL: [-22, 0, 10], faL: [-72, 0, 0], uaR: [-26, 0, -14], faR: [-82, 0, 0], staff: [106, 0, 14] }],
    [0.62, { thL: [-40, 0, 4], shL: [18, 0, 0], ftL: [-8, 0, -4], thR: [28, 0, -4], shR: [55, 0, 0], ftR: [20, 0, 4], toeR: [12, 0, 0], pos: [0, -0.035, 0], hips: [4, -7, 2], spine: [12, 3, 0], chest: [2, 9, -2], head: [-11, -4, 0],
      uaL: [32, 0, 10], faL: [-72, 0, 0], uaR: [-44, 0, -14], faR: [-82, 0, 0], staff: [124, 0, 14] }],
  ],
  // The feet plant (left foot forward) before the bolt leaves; the hips drive the throw.
  castShoot: [
    [0, {}],
    [0.16, { chest: [0, -16, 0], spine: [0, -7, 0], hips: [0, -4, 0], uaR: [-30, 0, -30], faR: [-70, 0, 0], staff: [70, 0, 12], uaL: [-20, 0, 25], pos: [0, -0.03, -0.03], head: [-4, 12, 0],
      thL: [-14, 0, 5], shL: [8, 0, 0], ftL: [-4, 0, -5], thR: [10, 0, -4], shR: [8, 0, 0], ftR: [6, 0, 4] }, 'in'],
    [0.3, { chest: [5, 16, 0], spine: [5, 7, 0], hips: [0, 4, 0], uaR: [-80, 0, -6], faR: [-8, 0, 0], staff: [162, 0, 0], uaL: [25, 0, 20], faL: [-30, 0, 0], pos: [0, -0.04, 0.07],
      thL: [-20, 0, 5], shL: [14, 0, 0], ftL: [2, 0, -5], thR: [14, 0, -4], shR: [8, 0, 0], ftR: [10, 0, 4], head: [-6, -8, 0] }, 'out'],
    [0.5, { chest: [5, 13, 0], spine: [4, 6, 0], hips: [0, 3, 0], uaR: [-74, 0, -8], faR: [-10, 0, 0], staff: [160, 0, 0], uaL: [25, 0, 20], faL: [-30, 0, 0], pos: [0, -0.04, 0.07],
      thL: [-20, 0, 5], shL: [14, 0, 0], ftL: [2, 0, -5], thR: [14, 0, -4], shR: [8, 0, 0], ftR: [10, 0, 4], head: [-6, -8, 0] }],
    [0.8, {}],
  ],
  castRaise: [
    [0, {}],
    [0.28, { spine: [12, 0, 0], chest: [6, 0, 0], head: [6, 0, 0], pos: [0, -0.1, 0], thL: [-30, 0, 6], shL: [50, 0, 0], ftL: [-20, 0, -6], thR: [-30, 0, -6], shR: [50, 0, 0], ftR: [-20, 0, 6],
      uaL: [20, 0, 30], faL: [-20, 0, 0], uaR: [15, 0, -30], faR: [-20, 0, 0], staff: [5, 0, 12] }],
    [0.55, { spine: [-8, 0, 0], chest: [-10, 0, 0], head: [-18, 0, 0], pos: [0, 0.02, 0], thL: [-3, 0, 11], thR: [1, 0, -11], ftL: [-1, 0, -11], ftR: [-4, 0, 11],
      uaL: [-160, 0, 20], faL: [-15, 0, 0], uaR: [-162, 0, -18], faR: [-12, 0, 0], staff: [178, 0, 0] }, 'out'],
    [0.9, { spine: [-8, 0, 0], chest: [-10, 0, 0], head: [-18, 0, 0], pos: [0, 0.02, 0], thL: [-3, 0, 11], thR: [1, 0, -11], ftL: [-1, 0, -11], ftR: [-4, 0, 11],
      uaL: [-165, 0, 24], faL: [-15, 0, 0], uaR: [-166, 0, -22], faR: [-12, 0, 0], staff: [178, 0, 0] }],
    [1.3, {}],
  ],
  castLong: [
    [0, {}],
    [0.3, { uaR: [-35, 0, -8], faR: [-25, 0, 0], staff: [30, 0, 8], uaL: [-95, 0, 25], faL: [-35, 0, 0], head: [-6, 0, 0], spine: [4, 0, 0] }],
    [0.7, { uaR: [-35, 0, -8], faR: [-25, 0, 0], staff: [30, 0, 8], uaL: [-110, -10, 5], faL: [-45, 0, 0], handL: [0, 30, 0], chest: [0, 6, 0], pos: [0, -0.02, 0], head: [-8, 4, 0], spine: [4, 0, 0] }],
    [1.1, { uaR: [-35, 0, -8], faR: [-25, 0, 0], staff: [30, 0, 8], uaL: [-85, 10, 40], faL: [-30, 0, 0], chest: [0, -6, 0], pos: [0, -0.03, 0], head: [-6, -4, 0], spine: [4, 0, 0] }],
    [1.5, { uaR: [-40, 0, -8], faR: [-25, 0, 0], staff: [35, 0, 8], uaL: [-105, -5, 15], faL: [-50, 0, 0], chest: [0, 4, 0], pos: [0, -0.01, 0], head: [-8, 0, 0], spine: [4, 0, 0] }],
    [1.75, { uaR: [-35, 0, -8], faR: [-25, 0, 0], staff: [30, 0, 8], uaL: [-95, 0, 25], faL: [-35, 0, 0], head: [-6, 0, 0], spine: [4, 0, 0] }],
    [2.0, {}],
  ],
  // A blow: the shoulder turns away, the head snaps, the right foot steps back to catch the weight, recovers.
  hitA: [
    [0, {}],
    [0.06, P({ chest: [-14, 20, -10], spine: [-8, 6, 0], neck: [-5, 0, 0], head: [14, -22, 10], hat: [-5, 0, 0], pos: [0, -0.03, -0.09], uaL: [-28, 0, 42], faL: [-34, 0, 0], uaR: [-10, 0, -22], faR: [-30, 0, 0],
      thR: [24, 0, -4], shR: [18, 0, 0], ftR: [4, 0, 4], thL: [-8, 0, 5] }), 'out'],
    [0.2, P({ chest: [-6, 12, -5], spine: [-4, 4, 0], head: [8, -12, 5], pos: [0, -0.04, -0.18], uaL: [-14, 0, 28], faL: [-26, 0, 0], thR: [30, 0, -4], shR: [12, 0, 0], ftR: [-8, 0, 4], thL: [-14, 0, 5], shL: [10, 0, 0] })],
    [0.36, P({ chest: [-2, 4, -2], head: [3, -4, 2], pos: [0, -0.02, -0.1], thR: [14, 0, -4], shR: [8, 0, 0], thL: [-9, 0, 5], shL: [7, 0, 0] })],
    [0.55, {}],
  ],
  hitB: [
    [0, {}],
    [0.06, P({ chest: [-14, -20, 10], spine: [-8, -6, 0], neck: [-5, 0, 0], head: [14, 22, -10], hat: [-5, 0, 0], pos: [0, -0.03, -0.09], uaL: [-12, 0, 30], faL: [-26, 0, 0], uaR: [-22, 0, -36], faR: [-36, 0, 0],
      thL: [24, 0, 4], shL: [18, 0, 0], ftL: [4, 0, -4], thR: [-8, 0, -5] }), 'out'],
    [0.2, P({ chest: [-6, -12, 5], spine: [-4, -4, 0], head: [8, 12, -5], pos: [0, -0.04, -0.18], uaR: [-14, 0, -26], faR: [-30, 0, 0], thL: [30, 0, 4], shL: [12, 0, 0], ftL: [-8, 0, -4], thR: [-14, 0, -5], shR: [10, 0, 0] })],
    [0.36, P({ chest: [-2, -4, 2], head: [3, 4, -2], pos: [0, -0.02, -0.1], thL: [14, 0, 4], shL: [8, 0, 0], thR: [-9, 0, -5], shR: [7, 0, 0] })],
    [0.55, {}],
  ],
  // Fire: the arm comes up to shield the face, the head turns away, a step back.
  hitFire: [
    [0, {}],
    [0.07, P({ chest: [-10, -18, 5], spine: [-7, -5, 0], head: [-8, 24, -6], pos: [0, -0.03, -0.09], uaL: [-95, 0, 40], faL: [-115, 0, 0], handL: [0, 0, 20], uaR: [-18, 0, -24], faR: [-36, 0, 0],
      thR: [24, 0, -4], shR: [16, 0, 0], ftR: [4, 0, 4], thL: [-8, 0, 5] }), 'out'],
    [0.22, P({ chest: [-5, -13, 3], spine: [-5, -4, 0], head: [-5, 20, -4], pos: [0, -0.04, -0.17], uaL: [-85, 0, 35], faL: [-110, 0, 0], handL: [0, 0, 20], uaR: [-14, 0, -22], faR: [-32, 0, 0],
      thR: [30, 0, -4], shR: [12, 0, 0], ftR: [-8, 0, 4], thL: [-14, 0, 5], shL: [10, 0, 0] })],
    [0.4, P({ chest: [0, -4, 1], head: [-2, 6, -1], pos: [0, -0.02, -0.1], uaL: [-40, 0, 20], faL: [-60, 0, 0], uaR: [-10, 0, -16], faR: [-26, 0, 0],
      thR: [14, 0, -4], shR: [8, 0, 0], thL: [-9, 0, 5], shL: [7, 0, 0] })],
    [0.6, {}],
  ],
  // Lightning: a rigid jolt, shaking, feet planted; then the knees give a little and it passes.
  hitLightning: [
    [0, {}],
    [0.05, JOLT, 'out'],
    [0.11, P({ ...JOLT, chest: [-9, 0, -4], head: [-16, 0, -5], hat: [-8, 0, 6], uaL: [-24, 0, 64], uaR: [-14, 0, -50] }), 'lin'],
    [0.17, P({ ...JOLT, chest: [-9, 0, 4], head: [-16, 0, 5], hat: [-8, 0, -6], uaL: [-16, 0, 56], uaR: [-22, 0, -60] }), 'lin'],
    [0.23, P({ ...JOLT, chest: [-9, 0, -3], head: [-16, 0, -4], hat: [-8, 0, 4] }), 'lin'],
    [0.38, { spine: [10, 0, 0], chest: [6, 0, 0], head: [10, 0, 0], pos: [0, -0.05, -0.03], uaL: [-10, 0, 22], faL: [-40, 0, 0], uaR: [-10, 0, -20], faR: [-40, 0, 0], staff: [50, 0, 12],
      thL: [-12, 0, 7], shL: [20, 0, 0], ftL: [-8, 0, -7], thR: [-10, 0, -7], shR: [20, 0, 0], ftR: [-10, 0, 7] }],
    [0.6, {}],
  ],
  // A real crush (a rock on the unit): slammed flat on the back, a beat, up.
  crush: [
    [0, {}],
    [0.1, { pos: [0, -0.82, -0.10], hips: [-82, 0, 0], spine: [4, 0, 0], chest: [-6, 0, 0], head: [30, 0, 0], neck: [10, 0, 0], hat: [-6, 0, 0],
      uaL: [-10, 0, 70], faL: [-60, 0, 0], uaR: [-12, 0, -55], faR: [-25, 0, 0], staff: [35, 0, 0],
      thL: [-6, 0, 6], thR: [-6, 0, -6], shL: [8, 0, 0], shR: [8, 0, 0], ftL: [30, 0, 0], ftR: [30, 0, 0] }, 'out'],
    [0.7, { pos: [0, -0.82, -0.10], hips: [-82, 0, 0], spine: [4, 0, 0], chest: [-6, 0, 0], head: [35, 0, 0], neck: [10, 0, 0], hat: [-6, 0, 0],
      uaL: [-10, 0, 70], faL: [-60, 0, 0], uaR: [-12, 0, -55], faR: [-25, 0, 0], staff: [35, 0, 0],
      thL: [-6, 0, 6], thR: [-6, 0, -6], shL: [8, 0, 0], shR: [8, 0, 0], ftL: [30, 0, 0], ftR: [30, 0, 0] }],
    [1.0, { pos: [0, -0.76, -0.10], hips: [-70, 0, 0], spine: [4, 0, 0], chest: [20, 0, 0], head: [40, 0, 0], neck: [10, 0, 0],
      uaL: [-70, 0, 30], faL: [-90, 0, 0], uaR: [-30, 0, -40], faR: [-40, 0, 0], staff: [40, 0, 0],
      thL: [-18, 0, 6], thR: [-18, 0, -6], shL: [12, 0, 0], shR: [12, 0, 0], ftL: [30, 0, 0], ftR: [30, 0, 0] }],
    ...GETUP(1.0, 0.85),
  ],
  shove: [
    [0, {}],
    [0.12, P({ spine: [-12, 0, 0], chest: [-8, 0, 0], head: [-8, 0, 0], pos: [0, -0.02, -0.08], thR: [30, 0, -4], shR: [20, 0, 0], ftR: [10, 0, 4], thL: [-10, 0, 4],
      uaL: [-50, 0, 30], faL: [-30, 0, 0], uaR: [-40, 0, -30], faR: [-40, 0, 0] }), 'out'],
    [0.32, P({ spine: [-10, 0, 0], chest: [-6, 0, 0], head: [-6, 0, 0], pos: [0, -0.03, -0.17], thL: [28, 0, 4], shL: [25, 0, 0], ftL: [12, 0, -4], thR: [-5, 0, -4], shR: [10, 0, 0], ftR: [0, 0, 4],
      uaL: [-60, 0, 35], faL: [-30, 0, 0], uaR: [-50, 0, -30], faR: [-40, 0, 0] })],
    [0.5, P({ spine: [-4, 0, 0], pos: [0, -0.02, -0.2], thR: [20, 0, -4], shR: [15, 0, 0], thL: [-8, 0, 4], shL: [6, 0, 0],
      uaL: [-30, 0, 25], faL: [-25, 0, 0], uaR: [-25, 0, -20], faR: [-35, 0, 0] })],
    [0.85, P({ pos: [0, 0, -0.06], thL: [-10, 0, 4] })],
    [1.05, {}],
  ],
  strike: [
    [0, {}],
    [0.25, { chest: [0, -40, 0], spine: [0, -15, 0], head: [-4, 30, 0], hips: [0, -10, 0], pos: [0, -0.02, -0.03],
      uaR: [-75, 0, -25], faR: [-60, 0, 0], staff: [225, 0, 0], uaL: [-75, 0, -30], faL: [-50, 0, 0] }, 'in'],
    [0.42, { chest: [10, 40, 0], spine: [5, 15, 0], head: [0, -20, 0], hips: [0, 10, 0], pos: [0, -0.04, 0.08],
      uaR: [-80, 30, 20], faR: [-20, 0, 0], staff: [190, 0, 0], uaL: [-80, 25, -20], faL: [-30, 0, 0],
      thL: [-25, 0, 4], shL: [10, 0, 0], thR: [15, 0, -4], shR: [20, 0, 0], ftR: [12, 0, 4] }, 'out'],
    [0.6, { chest: [12, 50, 0], spine: [5, 15, 0], head: [0, -25, 0], hips: [0, 10, 0], pos: [0, -0.04, 0.08],
      uaR: [-70, 40, 30], faR: [-25, 0, 0], staff: [180, 0, 0], uaL: [-75, 35, -15], faL: [-30, 0, 0],
      thL: [-25, 0, 4], shL: [10, 0, 0], thR: [15, 0, -4], shR: [20, 0, 0], ftR: [12, 0, 4] }],
    [1.0, {}],
  ],
  jumpStart: [
    [0, {}],
    [0.16, { ...CROUCH, uaL: [30, 0, 20], uaR: [25, 0, -20], faR: [-20, 0, 0], staff: [-5, 0, 12] }],
    [0.3, { spine: [-6, 0, 0], chest: [-6, 0, 0], head: [-8, 0, 0], pos: [0, 0.06, 0], thL: [-12, 0, 6], shL: [10, 0, 0], ftL: [20, 0, -6], thR: [-12, 0, -6], shR: [10, 0, 0], ftR: [20, 0, 6],
      uaL: [-140, 0, 30], faL: [-20, 0, 0], uaR: [-130, 0, -30], faR: [-20, 0, 0], staff: [150, 0, 12] }, 'out'],
  ],
  jumpHang: [
    [0, { thL: [-35, 0, 8], shL: [60, 0, 0], ftL: [25, 0, -8], thR: [-25, 0, -8], shR: [50, 0, 0], ftR: [25, 0, 8], spine: [-4, 0, 0], head: [-6, 0, 0],
      uaL: [-60, 0, 70], faL: [-40, 0, 0], uaR: [-55, 0, -70], faR: [-40, 0, 0], staff: [100, 0, 0] }],
    [0.35, { thL: [-30, 0, 8], shL: [50, 0, 0], ftL: [25, 0, -8], thR: [-32, 0, -8], shR: [58, 0, 0], ftR: [25, 0, 8], spine: [-4, 0, 0], head: [-6, 0, 0],
      uaL: [-70, 0, 75], faL: [-40, 0, 0], uaR: [-60, 0, -72], faR: [-40, 0, 0], staff: [100, 0, 0] }],
    [0.7, { thL: [-35, 0, 8], shL: [60, 0, 0], ftL: [25, 0, -8], thR: [-25, 0, -8], shR: [50, 0, 0], ftR: [25, 0, 8], spine: [-4, 0, 0], head: [-6, 0, 0],
      uaL: [-60, 0, 70], faL: [-40, 0, 0], uaR: [-55, 0, -70], faR: [-40, 0, 0], staff: [100, 0, 0] }],
  ],
  jumpLand: [
    [0, { thL: [-15, 0, 6], shL: [10, 0, 0], ftL: [5, 0, -6], thR: [-15, 0, -6], shR: [10, 0, 0], ftR: [5, 0, 6], uaL: [-60, 0, 60], faL: [-30, 0, 0], uaR: [-50, 0, -60], faR: [-30, 0, 0], staff: [80, 0, 0] }],
    [0.14, { ...CROUCH, spine: [22, 0, 0], head: [-12, 0, 0], pos: [0, -0.22, 0], uaL: [-50, 0, 30], faL: [-40, 0, 0], uaR: [-40, 0, -30], faR: [-40, 0, 0], staff: [80, 0, 12] }, 'out'],
    [0.45, {}],
  ],
  // Thrown: pitched back, arms and legs reaching for anything.
  tumble: [
    [0, { hips: [-25, 0, 0], spine: [-10, 0, 0], head: [-10, 0, 0], hat: [6, 0, 0], uaL: [-150, 0, 40], faL: [-40, 0, 0], uaR: [-30, 0, -60], faR: [-70, 0, 0], staff: [60, 0, 0],
      thL: [-50, 0, 10], shL: [40, 0, 0], thR: [10, 0, -10], shR: [70, 0, 0] }],
    [0.23, { hips: [-15, 10, 0], spine: [10, 0, 0], head: [-10, 0, 0], hat: [6, 0, 0], uaL: [-60, 0, 80], faL: [-90, 0, 0], uaR: [-150, 0, -40], faR: [-30, 0, 0], staff: [120, 0, 0],
      thL: [10, 0, 10], shL: [70, 0, 0], thR: [-50, 0, -10], shR: [40, 0, 0] }],
    [0.47, { hips: [-30, -10, 0], spine: [0, 0, 0], head: [15, 0, 0], hat: [6, 0, 0], uaL: [-100, 0, 30], faL: [-20, 0, 0], uaR: [-80, 0, -90], faR: [-80, 0, 0], staff: [90, 0, 0],
      thL: [-30, 0, 10], shL: [20, 0, 0], thR: [-20, 0, -10], shR: [90, 0, 0] }],
    [0.7, { hips: [-25, 0, 0], spine: [-10, 0, 0], head: [-10, 0, 0], hat: [6, 0, 0], uaL: [-150, 0, 40], faL: [-40, 0, 0], uaR: [-30, 0, -60], faR: [-70, 0, 0], staff: [60, 0, 0],
      thL: [-50, 0, 10], shL: [40, 0, 0], thR: [10, 0, -10], shR: [70, 0, 0] }],
  ],
  tumbleLand: [
    [0, { hips: [-25, 0, 0], spine: [-10, 0, 0], head: [-10, 0, 0], hat: [6, 0, 0], uaL: [-150, 0, 40], faL: [-40, 0, 0], uaR: [-30, 0, -60], faR: [-70, 0, 0], staff: [60, 0, 0],
      thL: [-50, 0, 10], shL: [40, 0, 0], thR: [10, 0, -10], shR: [70, 0, 0] }],
    [0.08, { ...LIE_BACK, pos: [0, -0.80, -0.12], uaL: [-30, 0, 70], uaR: [-25, 0, -65] }, 'out'],
    [0.2, { ...LIE_BACK, pos: [0, -0.85, -0.12] }],
    [0.6, { ...LIE_BACK, head: [26, 10, 0] }],
    ...GETUP(0.6),
  ],
  // Knocked off the feet onto the back: a shove, the fall, a beat flat, up (1.6 s).
  knockBack: [
    [0, {}],
    [0.1, { spine: [-14, 0, 0], chest: [-10, 0, 0], neck: [-6, 0, 0], head: [-14, 0, 0], pos: [0, -0.04, -0.1], uaL: [-70, 0, 40], faL: [-40, 0, 0], uaR: [-60, 0, -40], faR: [-50, 0, 0], staff: [110, 0, 0],
      thL: [-20, 0, 5], shL: [10, 0, 0], thR: [16, 0, -4], shR: [14, 0, 0], ftR: [8, 0, 4] }, 'out'],
    [0.26, { pos: [0, -0.45, -0.3], hips: [-55, 0, 0], spine: [10, 0, 0], chest: [6, 0, 0], neck: [8, 0, 0], head: [18, 0, 0], uaL: [-60, 0, 60], faL: [-50, 0, 0], uaR: [-50, 0, -55], faR: [-55, 0, 0], staff: [100, 0, 0],
      thL: [-30, 0, 8], shL: [40, 0, 0], ftL: [10, 0, -8], thR: [-20, 0, -8], shR: [45, 0, 0], ftR: [15, 0, 8] }, 'in'],
    [0.38, { ...LIE_BACK, pos: [0, -0.80, -0.14], head: [28, 0, 0], neck: [12, 0, 0], uaL: [-20, 0, 65], faL: [-40, 0, 0], uaR: [-15, 0, -60], faR: [-35, 0, 0], staff: [40, 0, 0],
      thL: [-25, 0, 8], shL: [40, 0, 0], ftL: [30, 0, -8], thR: [-15, 0, -8], shR: [30, 0, 0], ftR: [30, 0, 8] }, 'lin'],
    [0.48, { ...LIE_BACK, pos: [0, -0.85, -0.14], uaL: [-10, 0, 60], uaR: [-8, 0, -55] }, 'out'],
    [0.8, { ...LIE_BACK, head: [26, 12, 0], uaL: [-12, 0, 58] }],
    ...GETUP(0.8, 0.5),
  ],
  // Knocked forward onto the face: hands out, the fall, a beat, push up to all fours, a knee, up (1.6 s).
  knockFront: [
    [0, {}],
    [0.1, { spine: [22, 0, 0], chest: [10, 0, 0], head: [-12, 0, 0], pos: [0, -0.05, 0.1], uaL: [-60, 0, 30], faL: [-30, 0, 0], uaR: [-55, 0, -30], faR: [-35, 0, 0], staff: [90, 0, 0],
      thL: [-10, 0, 5], thR: [20, 0, -4], shR: [20, 0, 0], ftR: [10, 0, 4] }, 'out'],
    [0.26, { pos: [0, -0.5, 0.3], hips: [60, 0, 0], spine: [-5, 0, 0], chest: [-8, 0, 0], neck: [-10, 0, 0], head: [-25, 0, 0], uaL: [-80, 0, 35], faL: [-30, 0, 0], uaR: [-75, 0, -35], faR: [-30, 0, 0], staff: [105, 0, 0],
      thL: [-30, 0, 5], shL: [40, 0, 0], ftL: [30, 0, -5], thR: [-20, 0, -5], shR: [45, 0, 0], ftR: [30, 0, 5] }, 'in'],
    [0.38, { ...PRONE, pos: [0, -0.82, 0.15], head: [-30, 0, 0], uaL: [-50, 0, 50], faL: [-70, 0, 0], uaR: [-45, 0, -50], faR: [-70, 0, 0], staff: [115, 0, 0] }, 'lin'],
    [0.48, PRONE, 'out'],
    [0.8, { ...PRONE, head: [-26, 10, 0] }],
    [1.0, { pos: [0, -0.54, 0.12], hips: [70, 0, 0], spine: [-10, 0, 0], chest: [-10, 0, 0], neck: [-10, 0, 0], head: [-30, 0, 0], uaL: [-85, 0, 20], faL: [-5, 0, 0], uaR: [-85, 0, -20], faR: [-5, 0, 0], staff: [90, 0, 0],
      thL: [-90, 0, 5], shL: [112, 0, 0], ftL: [-60, 0, -5], thR: [-90, 0, -5], shR: [112, 0, 0], ftR: [-60, 0, 5] }],
    [1.22, { pos: [0, -0.42, 0.06], hips: [15, 0, 0], spine: [15, 0, 0], chest: [4, 0, 0], head: [-14, 0, 0], uaL: [-30, 0, 20], faL: [-50, 0, 0], uaR: [-40, 0, -18], faR: [-30, 0, 0], staff: [70, 0, 12],
      thL: [-95, 0, 6], shL: [105, 0, 0], ftL: [-25, 0, -6], thR: [-15, 0, -6], shR: [90, 0, 0], ftR: [-60, 0, 6] }],
    [1.42, { pos: [0, -0.1, 0.02], spine: [12, 0, 0], head: [-6, 0, 0], thL: [-25, 0, 6], shL: [40, 0, 0], ftL: [-15, 0, -6], thR: [-25, 0, -6], shR: [40, 0, 0], ftR: [-15, 0, 6],
      uaR: [-30, 0, -18], faR: [-30, 0, 0], staff: [60, 0, 12], uaL: [-10, 0, 20] }],
    [1.6, {}],
  ],
  // A deliberate step off a ledge: a dip, the push, into the hang.
  dropStart: [
    [0, {}],
    [0.1, { spine: [10, 0, 0], chest: [4, 0, 0], head: [8, 0, 0], pos: [0, -0.1, 0.02], thL: [-30, 0, 5], shL: [40, 0, 0], ftL: [-12, 0, -5], thR: [-28, 0, -4], shR: [38, 0, 0], ftR: [-12, 0, 4],
      uaL: [20, 0, 20], faL: [-20, 0, 0], uaR: [15, 0, -18], faR: [-20, 0, 0], staff: [5, 0, 12] }],
    [0.22, HANG, 'out'],
  ],
  // Held in the air: a slow drift of the limbs, the eyes on the ground.
  dropHang: [
    [0, HANG],
    [0.45, { ...HANG, thL: [-48, 0, 10], shL: [66, 0, 0], thR: [-48, 0, -10], shR: [68, 0, 0], uaL: [-35, 0, 90], uaR: [-30, 0, -86], head: [16, 0, 0], spine: [8, 0, 0] }],
    [0.9, HANG],
  ],
  // Soft landing: the feet reach, the knees take it, up.
  landSoft: [
    [0, REACH],
    [0.1, { ...CROUCH, pos: [0, -0.22, 0.02], uaL: [-20, 0, 50], faL: [-30, 0, 0], uaR: [-15, 0, -45], faR: [-30, 0, 0], staff: [45, 0, 8] }, 'out'],
    [0.22, { spine: [10, 0, 0], head: [-4, 0, 0], pos: [0, -0.1, 0], thL: [-25, 0, 6], shL: [40, 0, 0], ftL: [-15, 0, -6], thR: [-25, 0, -6], shR: [40, 0, 0], ftR: [-15, 0, 6],
      uaL: [-10, 0, 25], faL: [-20, 0, 0], uaR: [-10, 0, -20], faR: [-25, 0, 0], staff: [32, 0, 12] }],
    [0.4, {}],
  ],
  // Hard landing: the feet touch, the body dives over the right shoulder and rolls, up onto the feet facing the same way.
  // The hips turn a full circle about X (so every key after the roll says 360, not 0).
  landRoll: [
    [0, REACH],
    [0.1, { pos: [0, -0.3, 0.05], hips: [25, 0, 0], spine: [30, 0, 0], chest: [10, 0, 0], neck: [10, 0, 0], head: [20, 0, 0], hat: [4, 0, 0],
      thL: [-70, 0, 6], shL: [100, 0, 0], ftL: [-20, 0, -6], thR: [-70, 0, -6], shR: [100, 0, 0], ftR: [-20, 0, 6],
      uaL: [-90, 0, 20], faL: [-20, 0, 0], uaR: [-90, 0, -20], faR: [-20, 0, 0], staff: [180, 0, 0] }, 'in'],
    [0.22, { pos: [0, -0.52, 0.25], hips: [110, 0, 0], spine: [35, 0, 0], chest: [25, 0, 0], neck: [20, 0, 0], head: [30, 0, 0], hat: [4, 0, 0],
      thL: [-110, 0, 6], shL: [120, 0, 0], ftL: [20, 0, -6], thR: [-110, 0, -6], shR: [120, 0, 0], ftR: [20, 0, 6],
      uaL: [-60, 0, 20], faL: [-80, 0, 0], uaR: [-60, 0, -20], faR: [-80, 0, 0], staff: [140, 0, 0] }, 'lin'],
    [0.36, { pos: [0, -0.58, 0.36], hips: [200, 0, 0], spine: [30, 0, 0], chest: [25, 0, 0], neck: [20, 0, 0], head: [30, 0, 0], hat: [4, 0, 0],
      thL: [-115, 0, 6], shL: [125, 0, 0], ftL: [20, 0, -6], thR: [-115, 0, -6], shR: [125, 0, 0], ftR: [20, 0, 6],
      uaL: [-50, 0, 20], faL: [-90, 0, 0], uaR: [-50, 0, -20], faR: [-90, 0, 0], staff: [140, 0, 0] }, 'lin'],
    [0.5, { pos: [0, -0.48, 0.44], hips: [290, 0, 0], spine: [20, 0, 0], chest: [15, 0, 0], neck: [10, 0, 0], head: [20, 0, 0],
      thL: [-100, 0, 6], shL: [110, 0, 0], ftL: [10, 0, -6], thR: [-100, 0, -6], shR: [110, 0, 0], ftR: [10, 0, 6],
      uaL: [-40, 0, 30], faL: [-60, 0, 0], uaR: [-40, 0, -30], faR: [-60, 0, 0], staff: [100, 0, 0] }, 'lin'],
    [0.62, { pos: [0, -0.3, 0.38], hips: [360, 0, 0], spine: [20, 0, 0], chest: [8, 0, 0], head: [-6, 0, 0],
      thL: [-55, 0, 6], shL: [85, 0, 0], ftL: [-30, 0, -6], thR: [-50, 0, -6], shR: [80, 0, 0], ftR: [-30, 0, 6],
      uaL: [-20, 0, 30], faL: [-40, 0, 0], uaR: [-30, 0, -25], faR: [-40, 0, 0], staff: [70, 0, 12] }, 'out'],
    [0.8, { pos: [0, -0.12, 0.22], hips: [360, 0, 1.5], spine: [8, 0, 0], head: [-4, 0, 0], thL: [-26, 0, 6], shL: [40, 0, 0], ftL: [-14, 0, -6], thR: [-26, 0, -6], shR: [40, 0, 0], ftR: [-14, 0, 6],
      uaL: [-10, 0, 20], faL: [-24, 0, 0], uaR: [-20, 0, -18], faR: [-30, 0, 0], staff: [50, 0, 12] }],
    [0.95, { hips: [360, 0, 1.5], pos: [0, 0, 0.08] }],
  ],
  cheer: [
    [0, { uaL: [-150, 0, 25], faL: [-30, 0, 0], uaR: [-140, 0, -25], faR: [-20, 0, 0], staff: [175, 0, 0], head: [-10, 0, 0], spine: [-4, 0, 0], thL: [-3, 0, 6], thR: [1, 0, -6] }],
    [0.3, { pos: [0, 0.1, 0], thL: [-20, 0, 6], shL: [30, 0, 0], ftL: [15, 0, -6], thR: [-20, 0, -6], shR: [30, 0, 0], ftR: [15, 0, 6],
      uaL: [-165, 0, 30], faL: [-30, 0, 0], uaR: [-160, 0, -30], faR: [-20, 0, 0], staff: [175, 0, 0], head: [-14, 0, 0], hat: [-4, 0, 0], spine: [-4, 0, 0] }],
    [0.55, { pos: [0, -0.04, 0], thL: [-15, 0, 6], shL: [25, 0, 0], ftL: [-10, 0, -6], thR: [-15, 0, -6], shR: [25, 0, 0], ftR: [-10, 0, 6],
      uaL: [-140, 0, 20], faL: [-30, 0, 0], uaR: [-130, 0, -20], faR: [-20, 0, 0], staff: [175, 0, 0], head: [-8, 0, 0], spine: [4, 0, 0] }],
    [0.9, { uaL: [-150, 0, 25], faL: [-30, 0, 0], uaR: [-140, 0, -25], faR: [-20, 0, 0], staff: [175, 0, 0], head: [-10, 0, 0], spine: [-4, 0, 0], thL: [-3, 0, 6], thR: [1, 0, -6] }],
  ],
  // Death: the hit lands, the knees go, down to the knees, over onto the back.
  death: [
    [0, {}],
    [0.12, { chest: [-14, 0, -6], head: [10, 0, 8], uaL: [-40, 0, 40], uaR: [-30, 0, -30], faR: [-40, 0, 0], staff: [50, 0, 12], pos: [0, -0.02, -0.04] }, 'out'],
    [0.45, { pos: [0, -0.32, -0.1], hips: [-10, 0, 0], spine: [10, 0, 0], chest: [-6, 0, 0], head: [-10, 0, 0],
      thL: [-40, 0, 6], shL: [80, 0, 0], ftL: [-20, 0, -6], thR: [-40, 0, -6], shR: [80, 0, 0], ftR: [-20, 0, 6],
      uaL: [-20, 0, 40], faL: [-20, 0, 0], uaR: [-15, 0, -35], faR: [-30, 0, 0], staff: [45, 0, 12] }],
    [0.75, { pos: [0, -0.58, -0.12], hips: [-50, 0, 0], spine: [0, 0, 0], chest: [0, 0, 0], head: [-10, 0, 0],
      thL: [-40, 0, 8], shL: [120, 0, 0], ftL: [20, 0, -8], thR: [-35, 0, -8], shR: [115, 0, 0], ftR: [20, 0, 8], uaL: [-40, 0, 60], uaR: [-30, 0, -50], staff: [40, 0, 0] }],
    [1.0, { ...LIE_BACK, pos: [0, -0.82, -0.12], head: [12, 0, 0] }, 'out'],
    [1.15, { ...LIE_BACK }],
    [1.5, { ...LIE_BACK, head: [20, 15, 0], uaL: [-15, 0, 60] }],
  ],
  standUp: [
    [0, { ...LIE_BACK, head: [20, 15, 0], uaL: [-15, 0, 60] }],
    ...GETUP(0),
  ],
  levitate: [
    [0, { pos: [0, 0.32, 0], spine: [-4, 0, 0], chest: [-4, 0, 0], head: [-6, 0, 0], thL: [-25, 0, 10], shL: [45, 0, 0], ftL: [25, 0, -10], thR: [-20, 0, -10], shR: [40, 0, 0], ftR: [28, 0, 10],
      uaL: [-35, 0, 55], faL: [-35, 0, 0], handL: [-20, 0, 0], uaR: [-30, 0, -45], faR: [-40, 0, 0], staff: [70, 0, 0] }],
    [1.3, { pos: [0, 0.40, 0], spine: [-2, 0, 0], chest: [-4, 0, 0], head: [-8, 3, 0], thL: [-22, 0, 10], shL: [40, 0, 0], ftL: [25, 0, -10], thR: [-24, 0, -10], shR: [44, 0, 0], ftR: [28, 0, 10],
      uaL: [-40, 0, 60], faL: [-35, 0, 0], handL: [-20, 0, 0], uaR: [-35, 0, -50], faR: [-40, 0, 0], staff: [70, 0, 0] }],
    [2.6, { pos: [0, 0.32, 0], spine: [-4, 0, 0], chest: [-4, 0, 0], head: [-6, 0, 0], thL: [-25, 0, 10], shL: [45, 0, 0], ftL: [25, 0, -10], thR: [-20, 0, -10], shR: [40, 0, 0], ftR: [28, 0, 10],
      uaL: [-35, 0, 55], faL: [-35, 0, 0], handL: [-20, 0, 0], uaR: [-30, 0, -45], faR: [-40, 0, 0], staff: [70, 0, 0] }],
  ],
  burnOff: [
    [0, {}],
    [0.15, { spine: [-8, 0, -5], chest: [-6, 0, 0], head: [12, -30, 0], neck: [4, 0, 0], pos: [0, -0.02, -0.06], uaL: [-110, 0, -5], faL: [-105, 0, 0], handL: [-20, 0, 0], uaR: [-85, 0, -5], faR: [-100, 0, 0], staff: [160, 0, 0], thR: [8, 0, -4], shR: [8, 0, 0] }, 'out'],
    [0.5, { spine: [-8, 0, -5], chest: [-6, 0, 0], head: [14, -32, 0], neck: [4, 0, 0], pos: [0, -0.02, -0.06], uaL: [-115, 0, 0], faL: [-105, 0, 0], handL: [-20, 0, 0], uaR: [-85, 0, -5], faR: [-100, 0, 0], staff: [160, 0, 0], thR: [8, 0, -4], shR: [8, 0, 0] }],
    [1.0, {}],
  ],
};
const LOOPS = new Set(['idle', 'fidget', 'walk', 'run', 'jumpHang', 'tumble', 'cheer', 'levitate', 'dropHang']);
// Clips that also exist as additive upper-body overlays (`<name>Up`), for playing over locomotion.
const UPPER_CLIPS = ['castShoot', 'castRaise', 'castLong', 'hitA', 'hitB', 'hitFire', 'hitLightning', 'strike', 'burnOff'];

const EASE = {
  smooth,
  lin: (u) => u,
  in: (u) => u * u * u,
  out: (u) => 1 - Math.pow(1 - u, 3),
};
const tmpEuler = new THREE.Euler();
const tmpQ = new THREE.Quaternion();
// Forward kinematics of one leg, for the floor pass: how far the lowest point
// of a foot would be below the floor in this (degrees) pose.
const _fq = new THREE.Quaternion(), _fp = new THREE.Vector3(), _fo = new THREE.Vector3();
const legOff = (name) => { const b = BONES[B[name]]; return _fo.set(b[2], b[3], b[4]); };
function floorSink(pose, posY) {
  let min = Infinity;
  for (const side of ['L', 'R']) {
    _fq.setFromEuler(tmpEuler.set(pose.hips[0] * DEG2RAD, pose.hips[1] * DEG2RAD, pose.hips[2] * DEG2RAD, 'XYZ'));
    _fp.set(0, BP.hips[1] + posY, 0);
    for (const [b, clear] of [['th' + side, 0], ['sh' + side, 0], ['ft' + side, 0.05], ['toe' + side, 0.015]]) {
      _fp.add(legOff(b).applyQuaternion(_fq));
      if (clear) min = Math.min(min, _fp.y - clear);
      const r = pose[b];
      _fq.multiply(tmpQ.setFromEuler(tmpEuler.set(r[0] * DEG2RAD, r[1] * DEG2RAD, r[2] * DEG2RAD, 'XYZ')));
    }
  }
  return min < 0 ? -min : 0;
}

/** Keys -> an AnimationClip of quaternion tracks (+ hips position), eased by sub-sampling. */
function buildClip(name, keys, { sub = 6, bonesOnly = null } = {}) {
  const full = keys.map(([t, p, e]) => [t, { ...STAND, ...p }, EASE[e] || smooth]);
  const bonesUsed = bonesOnly || ANIM_BONES;
  const times = [];
  const rot = {}; for (const b of bonesUsed) rot[b] = [];
  const pos = [];
  const cur = {};
  const push = (t, pa, pb, w) => {
    times.push(t);
    for (const b of ANIM_BONES) {
      const a = pa[b], c = pb ? pb[b] : a;
      cur[b] = [a[0] + (c[0] - a[0]) * w, a[1] + (c[1] - a[1]) * w, a[2] + (c[2] - a[2]) * w];
    }
    for (const b of bonesUsed) {
      const r = cur[b];
      tmpEuler.set(r[0] * DEG2RAD, r[1] * DEG2RAD, r[2] * DEG2RAD, 'XYZ');
      tmpQ.setFromEuler(tmpEuler);
      rot[b].push(tmpQ.x, tmpQ.y, tmpQ.z, tmpQ.w);
    }
    if (bonesOnly) return;
    const a = pa.pos, c = pb ? pb.pos : a;
    const py = a[1] + (c[1] - a[1]) * w;
    // The floor pass: a sample whose foot would be under the floor (a leg
    // straightening between two keys, mostly) is lifted until it is not.
    pos.push(BP.hips[0] + a[0] + (c[0] - a[0]) * w, BP.hips[1] + py + floorSink(cur, py), BP.hips[2] + a[2] + (c[2] - a[2]) * w);
  };
  for (let i = 0; i < full.length - 1; i++) {
    const [t0, pa] = full[i], [t1, pb, ease] = full[i + 1];
    for (let j = 0; j < sub; j++) { const u = j / sub; push(t0 + (t1 - t0) * u, pa, pb, ease(u)); }
  }
  push(full[full.length - 1][0], full[full.length - 1][1], null, 0);
  const tracks = bonesUsed.map((b) => new THREE.QuaternionKeyframeTrack(`${b}.quaternion`, times, rot[b]));
  if (!bonesOnly) tracks.push(new THREE.VectorKeyframeTrack('hips.position', times, pos));
  return new THREE.AnimationClip(name, -1, tracks);
}
let clipCache = null;
function clips() {
  if (!clipCache) {
    clipCache = {};
    for (const [name, keys] of Object.entries(CLIPS)) clipCache[name] = buildClip(name, keys);
    // The upper-body overlays: the same keys on the upper bones only, made
    // additive against their first key (STAND), so they ADD to whatever the
    // legs are doing.
    for (const name of UPPER_CLIPS) {
      const c = buildClip(name + 'Up', CLIPS[name], { bonesOnly: UPPER_BONES });
      THREE.AnimationUtils.makeClipAdditive(c);
      clipCache[name + 'Up'] = c;
    }
  }
  return clipCache;
}

/* ----------------------------------------------------------- actor */

// walk covers ~1.5 m per 1.0 s cycle, run ~2.6 m per 0.62 s cycle.
const WALK_STRIDE = 1.5, RUN_STRIDE = 2.6;
const RUN_SPEED = 3;
const X_AXIS = new THREE.Vector3(1, 0, 0), Y_AXIS = new THREE.Vector3(0, 1, 0), Z_AXIS = new THREE.Vector3(0, 0, 1);
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler();
const toward = (v, t, step) => (v < t ? Math.min(t, v + step) : Math.max(t, v - step));

export function makeMageActor({ team = 0x4fd2ff, teamDark = 0x1d4e78 } = {}) {
  const root = new THREE.Group();
  const model = new THREE.Group();
  root.add(model);

  /* skeleton */
  const bones = [], bone = {};
  for (const [n, p, x, y, z] of BONES) {
    const b = new THREE.Bone();
    b.name = n; b.position.set(x, y, z);
    if (p) bone[p].add(b);
    bones.push(b); bone[n] = b;
  }
  model.add(bone.hips);
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);

  /* skinned meshes */
  const geo = buildGeometry(team, teamDark);
  const DIS = {
    uDis: { value: 0 }, uDisDir: { value: new THREE.Vector3(0, 0.35, -1).normalize() }, uDisLo: { value: -1 }, uDisHi: { value: 1 },
    uDisTint: { value: new THREE.Color(0.55, 0.52, 0.49) }, uDisGlow: { value: 0 },
  };
  const mat = materials(DIS);
  const body = new THREE.SkinnedMesh(geo.body, mat.body);
  const capeMesh = new THREE.SkinnedMesh(geo.cape, mat.cape);
  for (const m of [body, capeMesh]) {
    m.castShadow = true; m.receiveShadow = false; m.frustumCulled = false;
    m.customDepthMaterial = mat.depth;
    model.add(m);
    m.bind(skeleton);
  }

  /* the orb in the staff's crystal: white core, additive halo, point light */
  const orb = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), new THREE.MeshBasicMaterial({ color: tmpColor.setHex(team).lerp(new THREE.Color(0xffffff), 0.65).getHex() }));
  const halo = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 12), new THREE.MeshBasicMaterial({ color: team, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
  orb.add(halo);
  const orbLight = new THREE.PointLight(team, 2.4, 3.2, 2);
  orb.add(orbLight);
  orb.position.set(0, 1.0, 0);
  bone.staff.add(orb);
  // A glow the idle mage turns over in his left hand.
  const palm = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), new THREE.MeshBasicMaterial({ color: team, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }));
  palm.position.set(0, -0.08, 0.06);
  palm.scale.setScalar(0.001); palm.visible = false;
  bone.handL.add(palm);
  let palmK = 0;

  /* ------------------------------------------------- animation */
  // Three layers on one mixer:
  //  - locomotion: idle, walk and run, always playing, weighted by speed and
  //    phase-locked (run's time follows walk's), under a master weight `locoW`;
  //  - a full-body STEP (one-shots and held poses), faded in over locomotion
  //    and faded out again when it ends, its last pose held while it goes;
  //  - an additive upper-body OVERLAY (a cast or a hit while moving).
  // Every one-shot clip has two actions, so re-triggering it fades from the
  // pose it is in rather than snapping to its first key.
  const mixer = new THREE.AnimationMixer(model);
  const CL = clips();
  const durOf = (key) => CL[key]?.duration ?? 0;
  const pool = {};
  function acquire(key) {
    let p = pool[key];
    if (!p) { const c = CL[key]; p = pool[key] = { acts: [mixer.clipAction(c), mixer.clipAction(c.clone())], i: 0 }; }
    p.i ^= 1;
    return p.acts[p.i];
  }
  const fading = new Set();
  function fadeOutAction(a, t) { if (!a) return; a.fadeOut(Math.max(0.01, t)); fading.add(a); }
  function reapFaded() { for (const a of fading) if (a.getEffectiveWeight() <= 0.0005) { a.stop(); fading.delete(a); } }

  const loco = { idle: mixer.clipAction(CL.idle), walk: mixer.clipAction(CL.walk), run: mixer.clipAction(CL.run) };
  for (const a of Object.values(loco)) { a.setLoop(THREE.LoopRepeat, Infinity); a.enabled = true; a.play(); }
  loco.walk.timeScale = 0; loco.run.timeScale = 0;
  loco.idle.setEffectiveWeight(1); loco.walk.setEffectiveWeight(0); loco.run.setEffectiveWeight(0);
  let locoW = 1, locoTarget = 1, locoRate = 4;
  let spd = 0;                 // the blended ground speed the legs believe in
  let idleS = 1, runS = 0;
  const walkDur = durOf('walk'), runDur = durOf('run');

  let step = null;             // the full-body one-shot / held pose
  const queue = [];
  let overlay = null;          // the additive upper-body one-shot
  let hitFlip = false;
  let fidgetAt = 0;
  let levitating = false;
  let dropping = false;
  let yawTarget = 0, yaw = 0;  // model yaw for a knockdown that turns into the fall

  function startStep(s, now) {
    const a = acquire(s.key);
    const fade = s.fade ?? 0.15;
    const prev = step?.action;
    a.reset();
    a.setLoop(s.loop ? THREE.LoopRepeat : THREE.LoopOnce, s.reps ?? Infinity);
    a.clampWhenFinished = true;
    a.timeScale = s.speed ?? 1;
    a.enabled = true;
    a.setEffectiveWeight(1);
    a.fadeIn(fade);
    a.play();
    if (prev && prev !== a) fadeOutAction(prev, fade);
    locoTarget = 0; locoRate = 1 / fade;
    const dur = s.dur ?? (durOf(s.key) / (s.speed ?? 1) * (s.reps && s.reps !== Infinity ? s.reps : 1));
    step = { ...s, action: a, started: now, until: s.held ? Infinity : now + (dur + (s.hold ?? 0)) * 1000 };
    return dur;
  }
  /** The step hands back to locomotion: its last pose fades out over `fade` while the legs fade in. */
  function endStep(now, fade = 0.25) {
    if (!step) return;
    if (queue.length) { startStep(queue.shift(), now); return; }
    const s = step;
    fadeOutAction(s.action, fade);
    step = null;
    locoTarget = 1; locoRate = 1 / fade;
    s.onEnd?.();
  }
  function run(steps, now = performance.now()) {
    queue.length = 0;
    for (let i = 1; i < steps.length; i++) queue.push(steps[i]);
    return startStep(steps[0], now);
  }
  function oneShot(key, { speed = 1, hold = 0, fade = 0.15 } = {}) {
    return run([{ key, speed, hold, fade }]);
  }
  /** Keep the old entry point: a loop is held until something replaces it, a one-shot runs once. */
  function play(key, { loop = LOOPS.has(key), fade = 0.2, speed = 1 } = {}) {
    return run([{ key, loop, held: loop, fade, speed }]);
  }
  function startOverlay(key, { speed = 1, fade = 0.1 } = {}, now = performance.now()) {
    const a = acquire(key + 'Up');
    const prev = overlay?.action;
    a.reset(); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.timeScale = speed; a.enabled = true;
    a.setEffectiveWeight(1); a.fadeIn(fade); a.play();
    if (prev && prev !== a) fadeOutAction(prev, fade);
    const dur = durOf(key) / speed;
    overlay = { key, action: a, until: now + dur * 1000, fadeAt: now + Math.max(0, dur - 0.2) * 1000, fading: false };
    return dur;
  }
  /** A clip the body can do on top of walking: overlay the upper body when moving, plant the feet when not. */
  function act(key, opts) {
    if (actor.moving && !step && CL[key + 'Up']) return startOverlay(key, opts);
    return run([{ key, ...opts }]);
  }

  /** Locomotion weights for this frame, from the ground speed the body is actually making. */
  function locomotion(dt, now) {
    const want = levitating || actor.dead || !actor.moving ? 0 : clamp(Math.max(groundSpeed, actor.speed * 0.5), 0, 8);
    spd += (want - spd) * Math.min(1, dt * (want > spd ? 9 : 7));
    if (spd < 0.01) spd = 0;
    idleS = clamp(1 - spd / 1.1, 0, 1);
    const runK = smooth((spd - RUN_SPEED) / 1.3);
    runS = runK * (1 - idleS);
    const walkS = 1 - idleS - runS;
    const stride = WALK_STRIDE + (RUN_STRIDE - WALK_STRIDE) * runK;
    const rate = spd > 0.05 ? clamp(spd / stride, 0.6, 2.6) : 0;   // stride cycles per second
    loco.walk.timeScale = rate * walkDur;
    loco.run.timeScale = rate * runDur;
    loco.run.time = (loco.walk.time / walkDur) * runDur;
    locoW = toward(locoW, locoTarget, dt * locoRate);
    loco.idle.setEffectiveWeight(locoW * idleS);
    loco.walk.setEffectiveWeight(locoW * walkS);
    loco.run.setEffectiveWeight(locoW * runS);
    if (!step && !actor.dead && !levitating) {
      if (actor.moving) fidgetAt = now + 6000 + Math.random() * 6000;
      else if (now > fidgetAt && actor.fidgets && idleS > 0.95 && !overlay) {
        run([{ key: 'fidget', loop: true, reps: 2, speed: 0.85, fade: 0.45 }], now);
        fidgetAt = now + 9000 + Math.random() * 9000;
      }
    }
  }

  /* ------------------------------------------------- procedural layers */
  // Cape chain: per bone a swing (about X) and a sway (about Z) angle, held
  // in the chest's frame, on springs toward "hanging down" plus the forcing
  // from how the hips move. Local rotations are the differences down the chain.
  const capeBones = [bone.cape1, bone.cape2, bone.cape3, bone.cape4];
  const cSwing = [0, 0, 0, 0], cSwingV = [0, 0, 0, 0], cSway = [0, 0, 0, 0], cSwayV = [0, 0, 0, 0];
  const C_K = [60, 40, 28, 20], C_D = [9, 7.5, 6, 5], C_COUPLE = 18;
  const hat = { x: 0, z: 0, vx: 0, vz: 0 };
  const robeS = { x: 0, z: 0, vx: 0, vz: 0 };
  let robeLift = 0;
  const _hq = new THREE.Quaternion(), _hp = new THREE.Vector3();
  // Height of the hem's centre if the robe bone were swung `phi` about X.
  const hemY = (phi) => { _v.set(0, -0.76 * Math.cos(phi), -0.76 * Math.sin(phi)).applyQuaternion(_hq); return _hp.y + _v.y; };
  const lastPos = new THREE.Vector3(), lastHeadQ = new THREE.Quaternion();
  // The mixer only writes a bone whose clip value changed since last frame, so
  // the bones we post-multiply are put back to the mixer's value first.
  const base = { hips: new THREE.Quaternion(), spine: new THREE.Quaternion(), chest: new THREE.Quaternion(), neck: new THREE.Quaternion(), head: new THREE.Quaternion() };
  function restoreOverlaid() { for (const k in base) bone[k].quaternion.copy(base[k]); }
  function saveOverlaid() { for (const k in base) base[k].copy(bone[k].quaternion); }
  let lastFacing = 0, lastFwd = 0, haveLast = false, headLook = 0;
  let fwdVel = 0, latVel = 0, upVel = 0, yawRate = 0, fwdAcc = 0, groundSpeed = 0;
  let leanX = 0, leanZ = 0;

  function overlays(dt, now) {
    const h = Math.min(dt, 1 / 30);
    // Velocity of the root in its own frame, smoothed.
    // A root that jumped more than 0.6 m in one frame was placed, not moved: keep the old velocities.
    if (haveLast && dt > 0 && _v.copy(root.position).sub(lastPos).length() < 0.6) {
      _v.divideScalar(dt);
      const s = Math.sin(actor.facing), c = Math.cos(actor.facing);
      const f = _v.x * s + _v.z * c, l = _v.x * c - _v.z * s;
      const k = Math.min(1, dt * 12);
      fwdVel += (clamp(f, -8, 8) - fwdVel) * k; latVel += (clamp(l, -8, 8) - latVel) * k; upVel += (clamp(_v.y, -12, 12) - upVel) * k;
      yawRate += (clamp(wrapAngle(actor.facing - lastFacing) / dt, -12, 12) - yawRate) * k;
      fwdAcc += ((fwdVel - lastFwd) / dt - fwdAcc) * Math.min(1, dt * 10);
      groundSpeed = Math.hypot(fwdVel, latVel);
    }
    lastPos.copy(root.position); lastFacing = actor.facing; lastFwd = fwdVel; haveLast = true;

    // Weight: a lean into an acceleration (the first step, a stop), a lean into a turn.
    const upright = !step && !actor.dead;
    leanX += ((upright ? clamp(fwdAcc * 0.014, -0.14, 0.14) : 0) - leanX) * Math.min(1, dt * 6);
    leanZ += ((upright ? clamp(-yawRate * Math.min(fwdVel, 4) * 0.02, -0.12, 0.12) : 0) - leanZ) * Math.min(1, dt * 6);
    bone.hips.quaternion.multiply(_q.setFromAxisAngle(Z_AXIS, leanZ * 0.4));
    bone.spine.quaternion.multiply(_q.setFromAxisAngle(X_AXIS, leanX * 0.55)).multiply(_q.setFromAxisAngle(Z_AXIS, leanZ * 0.6));
    // Breathing on the chest, a glance toward where we are turning to.
    const breath = Math.sin(now * 0.0021) * 0.022;
    bone.chest.quaternion.multiply(_q.setFromAxisAngle(X_AXIS, breath + leanX * 0.45));
    bone.neck.quaternion.multiply(_q.setFromAxisAngle(X_AXIS, -breath * 0.6 - leanX * 0.5));
    const lookK = actor.dead ? 0 : step ? 0.25 : 1;
    const want = (clamp(wrapAngle(actor.facingTarget - actor.facing), -0.6, 0.6) * 0.7 + Math.sin(now * 0.00045) * 0.09) * lookK;
    headLook += (want - headLook) * Math.min(1, dt * 5);
    bone.head.quaternion.multiply(_q.setFromAxisAngle(Y_AXIS, headLook));

    // Cape: hang direction in the chest's frame (one frame stale, fine).
    bone.chest.getWorldQuaternion(_q2);
    _v.set(0, -1, 0).applyQuaternion(_q2.invert());
    const hangX = Math.atan2(-_v.z, -_v.y), hangZ = Math.atan2(_v.x, -_v.y);
    const gust = Math.sin(now * 0.0013) * 0.05 + Math.sin(now * 0.0031 + 1) * 0.03;
    const lev = levitating ? 0.2 + Math.sin(now * 0.0017) * 0.12 : 0;
    const swingF = clamp(fwdVel * 0.09 - upVel * 0.12, -0.3, 0.9) + gust + lev;
    const swayF = clamp(latVel * 0.1 - yawRate * 0.08, -0.4, 0.4);
    for (let i = 0; i < 4; i++) {
      const depth = 1 + i * 0.35;
      let tx = hangX + swingF * depth * 0.4, tz = hangZ + swayF * depth * 0.35;
      // Never fold through the body, never swing a child far from its parent.
      const prevX = i ? cSwing[i - 1] : 0, prevZ = i ? cSway[i - 1] : 0;
      tx = Math.max(tx, prevX - 0.12);
      let ax = (tx - cSwing[i]) * C_K[i] - cSwingV[i] * C_D[i];
      let az = (tz - cSway[i]) * C_K[i] - cSwayV[i] * C_D[i];
      if (i) { ax += (cSwing[i - 1] - cSwing[i]) * C_COUPLE; az += (cSway[i - 1] - cSway[i]) * C_COUPLE; }
      if (i < 3) { ax += (cSwing[i + 1] - cSwing[i]) * C_COUPLE * 0.5; az += (cSway[i + 1] - cSway[i]) * C_COUPLE * 0.5; }
      cSwingV[i] += ax * h; cSwayV[i] += az * h;
      cSwing[i] = clamp(cSwing[i] + cSwingV[i] * h, prevX - 0.15, prevX + 0.9);
      cSway[i] = clamp(cSway[i] + cSwayV[i] * h, prevZ - 0.6, prevZ + 0.6);
      _e.set(cSwing[i] - prevX, 0, cSway[i] - prevZ, 'XYZ');
      capeBones[i].quaternion.setFromEuler(_e);
    }

    // Hat tip: a spring driven by how fast the head turns.
    bone.head.getWorldQuaternion(_q2);
    _q.copy(lastHeadQ).invert().multiply(_q2);      // head rotation since last frame, head-local
    lastHeadQ.copy(_q2);
    const wx = (_q.w < 0 ? -2 : 2) * _q.x / dt, wz = (_q.w < 0 ? -2 : 2) * _q.z / dt;
    hat.vx += ((-hat.x) * 160 - hat.vx * 10 - clamp(wx, -30, 30) * 0.8 - fwdAcc * 0.03) * h;
    hat.vz += ((-hat.z) * 160 - hat.vz * 10 - clamp(wz, -30, 30) * 0.8) * h;
    hat.x = clamp(hat.x + hat.vx * h, -0.4, 0.4); hat.z = clamp(hat.z + hat.vz * h, -0.4, 0.4);
    _e.set(hat.x, 0, hat.z, 'XYZ');
    bone.hatTip.quaternion.setFromEuler(_e);

    // Robe hem: a stiff pendulum under the hips.
    const rx = clamp(fwdVel * 0.1 - upVel * 0.06, -0.25, 0.25), rz = clamp(latVel * 0.1 - yawRate * 0.05, -0.2, 0.2);
    robeS.vx += ((rx - robeS.x) * 90 - robeS.vx * 8) * h; robeS.vz += ((rz - robeS.z) * 90 - robeS.vz * 8) * h;
    robeS.x = clamp(robeS.x + robeS.vx * h, -0.3, 0.3); robeS.z = clamp(robeS.z + robeS.vz * h, -0.3, 0.3);
    // Kneeling or sitting, swing the skirt so its hem stays off the floor.
    bone.hips.getWorldQuaternion(_hq); bone.hips.getWorldPosition(_hp);
    _hp.y -= root.position.y;
    if (hemY(robeLift) < 0.03) {
      // Swing toward the hips' forward side (over the knees; -X takes the
      // hem to +Z) unless that side points into the floor, as it does lying
      // face down.
      _v.set(0, 0, 1).applyQuaternion(_hq);
      robeLift = clamp(robeLift + (_v.y > -0.3 ? -1 : 1) * Math.min(0.12, dt * 4), -1.35, 1.35);
    } else if (Math.abs(robeLift) > 0.001 && hemY(robeLift * 0.9) > 0.03) robeLift *= 1 - Math.min(1, dt * 5);
    _e.set(robeS.x + robeLift, 0, robeS.z, 'XYZ');
    bone.robe.quaternion.setFromEuler(_e);

    // The palm glow comes up for the fidget and the ritual.
    const ritual = (step && (step.key === 'fidget' || step.key === 'castLong')) || (overlay && overlay.key === 'castLong');
    palmK += ((ritual ? 1 : 0) - palmK) * Math.min(1, dt * 4);
    if (palmK > 0.01) { palm.visible = true; palm.scale.setScalar(palmK * (0.9 + Math.sin(now * 0.009) * 0.15)); }
    else palm.visible = false;
  }

  let hidden = false;
  const FRONT_BONES = ['hips', 'spine', 'chest', 'neck', 'head', 'hat', 'hatTip', 'uaL', 'faL', 'handL', 'uaR', 'faR', 'handR', 'staff', 'thL', 'shL', 'ftL', 'thR', 'shR', 'ftR', 'cape1', 'cape2', 'cape3', 'cape4', 'robe'];
  const _w = new THREE.Vector3();
  const _m = new THREE.Vector3();
  /** A bone's position in the root's frame (the dissolve's frame). */
  const boneLocal = (name, out) => root.worldToLocal(bone[name].getWorldPosition(out));
  /** The span of the body along the dissolve direction, from the bones as they lie now. */
  function dissolveRange() {
    let lo = Infinity, hi = -Infinity;
    for (const n of FRONT_BONES) { const k = boneLocal(n, _m).dot(DIS.uDisDir.value); if (k < lo) lo = k; if (k > hi) hi = k; }
    DIS.uDisLo.value = lo - 0.12; DIS.uDisHi.value = hi + 0.22;
  }

  const actor = {
    kind: 'mage', root, model, mixer, orb, skeleton, height: geo.height, dead: false,
    ownsDeath: true,   // the arena leaves the fade to us: the body goes to dust (see dissolve)
    deathClipDur: durOf('death'),
    target: null, moving: false, speed: 2.6, facing: 0, facingTarget: 0, airY: 0,
    fidgets: true,   // the idle mage turns a glow over in his hands now and then
    play, oneShot,
    update(dt, now) {
      locomotion(dt, now);
      restoreOverlaid();
      mixer.update(dt);
      saveOverlaid();
      reapFaded();
      if (step && now >= step.until) {
        // Hang in the air until the arena brings us down.
        if (step.air && this.airY > 0.04 && now < step.until + 2500) step.until = now + 1;
        else endStep(now, step.outFade ?? 0.25);
      }
      // A drop nobody lands: come down on our own rather than hang forever.
      if (step && step.key === 'dropHang' && now - step.started > 4000) this.land(false);
      if (levitating && !step && !this.dead) run([{ key: 'levitate', loop: true, held: true, fade: 0.5 }], now);
      if (overlay) {
        if (!overlay.fading && now >= overlay.fadeAt) { fadeOutAction(overlay.action, 0.2); overlay.fading = true; }
        if (now >= overlay.until) overlay = null;
      }
      // Turn the short way round toward where we are going or looking.
      let d = this.facingTarget - this.facing;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.facing += d * Math.min(1, dt * 9);
      root.rotation.y = this.facing;
      yaw += wrapAngle(yawTarget - yaw) * Math.min(1, dt * 8);
      model.rotation.y = yaw;
      overlays(dt, now);
      const pulse = Math.sin(now / 260);
      const live = hidden ? 0 : 1 - DIS.uDis.value;
      orb.visible = live > 0.03;
      orb.scale.setScalar((1 + pulse * 0.1) * live);
      halo.scale.setScalar(1 + Math.sin(now / 170 + 1) * 0.16);
      orbLight.intensity = (2.2 + pulse * 0.5) * live;
      if (hidden) palm.visible = false;
    },
    lookAt(x, z) { this.facingTarget = Math.atan2(x - root.position.x, z - root.position.z); },
    /** A spell: 'shoot' is a quick bolt, 'raise' a big area spell, 'long' a ritual. On the move, the arms cast and the legs keep walking. */
    cast(kind = 'shoot') {
      if (this.dead) return;
      if (kind === 'raise') return act('castRaise', { speed: 1.2, fade: 0.14 });
      if (kind === 'long') return act('castLong', { speed: 1.1, fade: 0.18 });
      return act('castShoot', { speed: 1.2, fade: 0.1 });
    },
    /**
     * Took a hit. 'blow', 'fire' and 'lightning' are STAGGERS that never
     * leave the feet: a step back, a shoulder turn, the head snaps, recovered
     * in ~0.5 s and handed back to whatever the legs were doing (on the move
     * only the upper body flinches). 'crush' is the one that slams the body
     * flat: reserved for a real crush, a rock landing on the unit.
     */
    hit(kind = 'blow') {
      if (this.dead) return;
      if (kind === 'fire') return act('hitFire', { speed: 1.1, fade: 0.07 });
      if (kind === 'lightning') return act('hitLightning', { speed: 1.1, fade: 0.05 });
      if (kind === 'crush') return run([{ key: 'crush', speed: 1.0, fade: 0.06, outFade: 0.3 }]);
      hitFlip = !hitFlip;
      return act(hitFlip ? 'hitA' : 'hitB', { speed: 1.25, fade: 0.07 });
    },
    /**
     * Knocked off the feet by a slam. `dir` is the bearing the slam throws
     * the mage along, in its own frame (0 = its forward, +pi/2 = its left).
     * Thrown backwards-ish it turns its back to `dir` and goes down on its
     * back; thrown forwards-ish it goes down on its face. Down, a beat flat,
     * up again: 1.6 s, then back to locomotion, facing as before.
     */
    knockdown(dir = 0) {
      if (this.dead) return;
      const d = wrapAngle(dir);
      const back = Math.abs(wrapAngle(d + Math.PI)) <= 110 * DEG2RAD;
      yawTarget = back ? wrapAngle(d + Math.PI) : d;
      run([{ key: back ? 'knockBack' : 'knockFront', speed: 1.0, fade: 0.08, outFade: 0.3, onEnd: () => { yawTarget = 0; } }]);
    },
    /**
     * A deliberate step off a ledge: a dip and a push-off into a HELD airborne
     * pose (legs tucked, arms out, looking at the landing) that keeps
     * breathing and drifting until `land()` is called. Never crashes on its
     * own; after 4 s unlanded it lands soft by itself.
     */
    drop() {
      if (this.dead) return;
      dropping = true;
      run([
        { key: 'dropStart', speed: 1, fade: 0.1 },
        { key: 'dropHang', loop: true, held: true, fade: 0.14 },
      ]);
    },
    /**
     * Touch down from a drop. Soft (default): the feet reach, the knees take
     * it, up again in ~0.4 s, flowing into the next step. Hard (the fall did
     * damage): a landing roll forward over the shoulder, ~0.95 s, back on the
     * feet with the same facing (the roll itself carries the hips ~0.5 m
     * forward and settles back to ~0.1 m; the root does not move).
     */
    land(hard = false) {
      if (this.dead) return;
      dropping = false;
      if (hard) return run([{ key: 'landRoll', speed: 1.0, fade: 0.06, outFade: 0.3 }]);
      return run([{ key: 'landSoft', speed: 1.0, fade: 0.08, outFade: 0.22 }]);
    },
    get dropping() { return dropping; },
    /** Pushed: stumble back a step or two. */
    shove() { if (!this.dead) run([{ key: 'shove', speed: 1.1, fade: 0.08 }]); },
    strike() { if (!this.dead) act('strike', { speed: 1.15, fade: 0.1 }); },
    summon() { if (!this.dead) act('castLong', { speed: 1.15, fade: 0.18 }); },
    /** Hurled into the air for `air` seconds: crouch-and-leap, hang, land. */
    jump(air = 0.95) {
      if (this.dead) return;
      const up = 0.3, land = 0.45;
      run([
        { key: 'jumpStart', speed: durOf('jumpStart') / up, fade: 0.06 },
        { key: 'jumpHang', loop: true, speed: 1, fade: 0.12, dur: Math.max(0.1, air - up - land * 0.4), air: true },
        { key: 'jumpLand', speed: durOf('jumpLand') / land, fade: 0.08, outFade: 0.22 },
      ]);
    },
    /** Thrown or pushed off: flail in the air for `air` seconds, crash on the back, get up. */
    tumble(air = 0.8) {
      if (this.dead) return;
      run([
        { key: 'tumble', loop: true, speed: 1.3, fade: 0.1, dur: Math.max(0.1, air), air: true },
        { key: 'tumbleLand', speed: 1.0, fade: 0.05, outFade: 0.3 },
      ]);
    },
    /** Standing beside a fire: shield the face for a moment. */
    burnOff() { if (!this.dead && !step) act('burnOff', { speed: 1.0, fade: 0.15 }); },
    /** Float, robe swaying, until told to stop. */
    levitate(on = true) {
      if (this.dead) return;
      const was = levitating;
      levitating = !!on;
      if (on && !was) { queue.length = 0; run([{ key: 'levitate', loop: true, held: true, fade: 0.5 }]); }
      if (!on && was && step && step.key === 'levitate') endStep(performance.now(), 0.5);
    },
    cheer() { if (!this.dead) run([{ key: 'cheer', loop: true, reps: 3, speed: 1.1, fade: 0.2 }]); },
    die() {
      this.dead = true; this.moving = false; levitating = false; dropping = false; yawTarget = 0;
      this.setDissolve(0);
      queue.length = 0;
      run([{ key: 'death', speed: 1.0, held: true, fade: 0.08 }]);
    },
    /** Back from the dead: get up off the floor, then stand ready. */
    revive() {
      this.dead = false;
      run([{ key: 'standUp', speed: 1.3, fade: 0.25, outFade: 0.3 }]);
    },
    /**
     * How far gone the body is, 0 (whole) to 1 (nothing left). The front
     * sweeps feet to head. `glow` > 0 lights the rim in `tint` instead of
     * ashing it (a body forming, not one blowing away).
     */
    setDissolve(k, { tint = null, glow = 0 } = {}) {
      k = clamp(k, 0, 1);
      if (k > 0 && DIS.uDis.value === 0) dissolveRange();
      DIS.uDis.value = k;
      DIS.uDisGlow.value = glow;
      if (tint !== null) DIS.uDisTint.value.set(tint); else if (glow === 0) DIS.uDisTint.value.setRGB(0.55, 0.52, 0.49);
    },
    get dissolve() { return DIS.uDis.value; },
    /**
     * Up to `n` world points on the bones at the dissolve front: where the
     * dust comes off. Empty when the front is past the body.
     */
    dissolveFront(n = 4, out = []) {
      const th = disThreshold(DIS.uDis.value);
      const span = DIS.uDisHi.value - DIS.uDisLo.value;
      const near = [];
      for (const name of FRONT_BONES) {
        const key = (boneLocal(name, _m).dot(DIS.uDisDir.value) - DIS.uDisLo.value) / span * DIS_KEY_MIX + DIS_NOISE_MEAN;
        if (key > th - 0.22 && key < th + 0.1) near.push(name);
      }
      for (let i = 0; i < n && near.length; i++) {
        const name = near[Math.floor(Math.random() * near.length)];
        bone[name].getWorldPosition(_w);
        out.push(new THREE.Vector3(_w.x + (Math.random() - 0.5) * 0.16, _w.y + (Math.random() - 0.5) * 0.12, _w.z + (Math.random() - 0.5) * 0.16));
      }
      return out;
    },
    /** Off stage: nothing drawn, no light, the record still in place. */
    setHidden(on) {
      hidden = !!on;
      body.visible = capeMesh.visible = !hidden;
      if (hidden) { orb.visible = false; orbLight.intensity = 0; palm.visible = false; }
    },
    get hidden() { return hidden; },
    /** Where a bolt leaves from, in world space. */
    handPoint(out = new THREE.Vector3()) { orb.getWorldPosition(out); return out; },
    /** What the body is doing now, for the lab: the step key (or 'loco'), the overlay key, the speed the legs believe in. */
    get state() { return { step: step ? step.key : 'loco', overlay: overlay ? overlay.key : null, spd: +spd.toFixed(2), locoW: +locoW.toFixed(2), idleS: +idleS.toFixed(2), runS: +runS.toFixed(2) }; },
    dispose() { mixer.stopAllAction(); root.removeFromParent(); orb.geometry.dispose(); halo.geometry.dispose(); palm.geometry.dispose(); mat.body.dispose(); mat.cape.dispose(); mat.depth.dispose(); },
  };
  fidgetAt = performance.now() + 4000 + Math.random() * 6000;
  mixer.update(0);
  saveOverlaid();
  return actor;
}

/** Every clip and its length, for the lab. */
export function mageClipList() {
  const out = {};
  for (const [k, c] of Object.entries(clips())) out[k] = +c.duration.toFixed(2);
  return out;
}
