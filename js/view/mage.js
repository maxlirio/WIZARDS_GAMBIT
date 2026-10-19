// The battle mage, built entirely in code.
//
// No model is loaded: the body is a few dozen primitives (lathes, capsules,
// spheres, boxes) placed in a bind pose, skinned by hand to a full humanoid
// skeleton and merged into ONE skinned geometry (plus a second, double-sided
// one for the cape). Every animation is a keyframe pose list authored below,
// turned into THREE.AnimationClips so the mixer can crossfade them. On top of
// the clips, `update()` layers procedural motion: breathing, a head that
// glances at `facingTarget`, cape and robe bones that lag the hips on springs,
// and a hat tip that wobbles with the head.
//
// Frame: the mage faces +Z at `root.rotation.y = 0`; `root.position` is at the
// feet; +X is its LEFT side; everything is in metres. The API is the one the
// arena already drives, with hit kinds, shove, tumble, burnOff
// and levitate added.

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const { DEG2RAD } = THREE.MathUtils;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const wrapAngle = (d) => Math.atan2(Math.sin(d), Math.cos(d));

/* ----------------------------------------------------------- skeleton */

// [name, parent, local offset]. Positions only: every bone is unrotated in
// the bind pose, so clip rotations are absolute and easy to read.
const BONES = [
  ['hips', null, 0, 0.95, 0],
  ['robe', 'hips', 0, 0, 0],            // procedural: skirt sway
  ['spine', 'hips', 0, 0.12, 0],
  ['spine2', 'spine', 0, 0.13, 0],
  ['chest', 'spine2', 0, 0.13, 0],
  ['neck', 'chest', 0, 0.16, 0],
  ['head', 'neck', 0, 0.10, 0],
  ['hat', 'head', 0, 0.17, 0],
  ['hatBrim', 'hat', 0, 0, 0],          // procedural
  ['hatTip', 'hat', 0, 0.14, 0],        // procedural: tip wobble
  ['clavL', 'chest', 0.06, 0.12, 0],
  ['uaL', 'clavL', 0.15, 0, 0],
  ['faL', 'uaL', 0, -0.27, 0],
  ['handL', 'faL', 0, -0.26, 0],
  ['clavR', 'chest', -0.06, 0.12, 0],
  ['uaR', 'clavR', -0.15, 0, 0],
  ['faR', 'uaR', 0, -0.27, 0],
  ['handR', 'faR', 0, -0.26, 0],
  ['staff', 'handR', 0, -0.06, 0.04],
  ['thL', 'hips', 0.10, -0.02, 0],
  ['shL', 'thL', 0, -0.45, 0],
  ['ftL', 'shL', 0, -0.42, 0],
  ['toeL', 'ftL', 0, -0.03, 0.11],
  ['thR', 'hips', -0.10, -0.02, 0],
  ['shR', 'thR', 0, -0.45, 0],
  ['ftR', 'shR', 0, -0.42, 0],
  ['toeR', 'ftR', 0, -0.03, 0.11],
  ['cape1', 'chest', 0, 0.12, -0.16],   // procedural chain
  ['cape2', 'cape1', 0, -0.30, -0.05],
  ['cape3', 'cape2', 0, -0.30, -0.05],
  ['cape4', 'cape3', 0, -0.30, -0.05],
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

/* ----------------------------------------------------------- skinning */

/** A bone's segment, bind-space, for distance weighting. */
const seg = (name, end) => ({ i: B[name], a: BP[name], b: end ? (Array.isArray(end) ? end : BP[end]) : BP[name] });
const SEG = {
  hips: seg('hips', 'spine'), spine: seg('spine', 'spine2'), spine2: seg('spine2', 'chest'), chest: seg('chest', 'neck'),
  neck: seg('neck', 'head'), head: seg('head', [0, 1.80, 0]),
  uaL: seg('uaL', 'faL'), faL: seg('faL', 'handL'), handL: seg('handL', [0.21, 0.78, 0]),
  uaR: seg('uaR', 'faR'), faR: seg('faR', 'handR'), handR: seg('handR', [-0.21, 0.78, 0]),
  thL: seg('thL', 'shL'), shL: seg('shL', 'ftL'), ftL: seg('ftL', 'toeL'), toeL: seg('toeL', [0.10, 0.03, 0.2]),
  thR: seg('thR', 'shR'), shR: seg('shR', 'ftR'), ftR: seg('ftR', 'toeR'), toeR: seg('toeR', [-0.10, 0.03, 0.2]),
  cape1: seg('cape1', 'cape2'), cape2: seg('cape2', 'cape3'), cape3: seg('cape3', 'cape4'), cape4: seg('cape4', [0, 0.25, -0.36]),
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
  skin: 0xefc39a, beard: 0xd9d3c7, eyeWhite: 0xf4f1ea, pupil: 0x1a1410, brow: 0x4d3a2a,
  leather: 0x4a3222, pouch: 0x6e4b2e, gold: 0xd2a84a, boot: 0x3a2a1e,
  wood: 0x5a3b22, woodDark: 0x40291a, iron: 0x7a7060,
};
const tmpColor = new THREE.Color();
const hash01 = (i) => { let h = (i + 1) * 2654435761; h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13; return (h >>> 0) / 4294967296; };

/**
 * Finish a primitive: paint it (hex or (x,y,z)=>hex), skin it (fn(x,y,z) ->
 * [[boneIndex, weight], ...]) and queue it for the merge.
 */
function part(list, geo, colour, weightFn, { noise = 0.07 } = {}) {
  const pos = geo.attributes.position, n = pos.count;
  const col = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    tmpColor.setHex(typeof colour === 'function' ? colour(x, y, z) : colour);
    const k = 1 + (hash01(i * 7 + n) - 0.5) * noise;
    col[i * 3] = tmpColor.r * k; col[i * 3 + 1] = tmpColor.g * k; col[i * 3 + 2] = tmpColor.b * k;
    const ws = weightFn(x, y, z);
    let sum = 0; for (const w of ws) sum += w[1];
    for (let j = 0; j < 4; j++) { si[i * 4 + j] = j < ws.length ? ws[j][0] : 0; sw[i * 4 + j] = j < ws.length ? ws[j][1] / sum : 0; }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  list.push(geo);
  return geo;
}
const lathe = (pts, segs = 20) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), segs);
const shade = (hex, k) => tmpColor.setHex(hex).multiplyScalar(k).getHex();
const lighten = (hex, k) => tmpColor.setHex(hex).lerp(new THREE.Color(0xffffff), k).getHex();

/** Body + cape geometries for a team, built once and shared by every mage of that team. */
const geoCache = new Map();
function buildGeometry(team, teamDark) {
  const key = `${team}:${teamDark}`;
  if (geoCache.has(key)) return geoCache.get(key);
  const body = [], cape = [];
  const robeCol = team, trimCol = shade(teamDark, 0.9), hatCol = shade(teamDark, 1.0), bandCol = team;
  const darkCol = shade(teamDark, 0.55);

  /* head + face */
  const HC = 1.66;   // head centre
  part(body, new THREE.SphereGeometry(0.12, 18, 14).scale(1, 1.1, 0.95).translate(0, HC, 0), COL.skin, solo('head'), { noise: 0.04 });
  part(body, new THREE.CylinderGeometry(0.05, 0.06, 0.16, 10).translate(0, HC - 0.13, 0), shade(COL.skin, 0.85), nearest([SEG.chest, SEG.neck, SEG.head]), { noise: 0.03 });
  for (const s of [1, -1]) {
    part(body, new THREE.SphereGeometry(0.024, 10, 8).translate(s * 0.046, HC + 0.015, 0.102), COL.eyeWhite, solo('head'), { noise: 0 });
    part(body, new THREE.SphereGeometry(0.013, 8, 6).translate(s * 0.046, HC + 0.015, 0.122), COL.pupil, solo('head'), { noise: 0 });
    part(body, new THREE.BoxGeometry(0.052, 0.015, 0.022).rotateZ(s * 14 * DEG2RAD).translate(s * 0.048, HC + 0.05, 0.108), COL.brow, solo('head'), { noise: 0 });
    part(body, new THREE.SphereGeometry(0.022, 8, 6).scale(1.7, 0.6, 0.8).translate(s * 0.03, HC - 0.028, 0.115), COL.beard, solo('head'), { noise: 0.05 });
  }
  part(body, new THREE.SphereGeometry(0.02, 8, 6).scale(1, 1.3, 1.25).translate(0, HC - 0.008, 0.126), shade(COL.skin, 0.95), solo('head'), { noise: 0 });
  part(body, new THREE.ConeGeometry(0.08, 0.24, 10).rotateX(Math.PI).scale(1, 1, 0.62).translate(0, HC - 0.11, 0.078), COL.beard, nearest([SEG.head, SEG.neck]), { noise: 0.06 });

  /* hat: crown (bent tip), band, buckle, brim */
  const HY = BP.hat[1];   // crown base
  const crown = lathe([[0, 0], [0.15, 0], [0.145, 0.03], [0.12, 0.08], [0.085, 0.13], [0.05, 0.175], [0.022, 0.215], [0.006, 0.235], [0, 0.24]], 22);
  {
    const p = crown.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (y > 0.08) { const k = y - 0.08; p.setZ(i, p.getZ(i) - k * k * 1.9); p.setY(i, y - k * k * 0.5); }
    }
    crown.computeVertexNormals();
    crown.translate(0, HY, 0);
  }
  part(body, crown, hatCol, (x, y) => { const k = smooth((y - HY - 0.07) / 0.1); return k < 0.02 ? [[B.hat, 1]] : [[B.hat, 1 - k], [B.hatTip, k]]; });
  part(body, new THREE.CylinderGeometry(0.154, 0.162, 0.05, 22, 1, true).translate(0, HY + 0.027, 0), bandCol, solo('hat'), { noise: 0.03 });
  part(body, new THREE.BoxGeometry(0.04, 0.04, 0.016).translate(0, HY + 0.027, 0.163), COL.gold, solo('hat'), { noise: 0 });
  // The brim curls up toward its edge so the eyes stay in the light.
  const brim = lathe([[0.13, -0.024], [0.19, -0.02], [0.23, -0.004], [0.248, 0.012], [0.24, 0.024], [0.19, 0.008], [0.13, 0.002]], 24);
  {
    const p = brim.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i), r = Math.hypot(x, z);
      p.setY(i, p.getY(i) + Math.sin(Math.atan2(z, x) * 3 + 0.6) * 0.012 * clamp((r - 0.13) / 0.11, 0, 1));
    }
    brim.computeVertexNormals();
    brim.translate(0, HY + 0.004, 0);
  }
  part(body, brim, (x, y, z) => (y < HY - 0.008 ? shade(hatCol, 0.7) : hatCol), solo('hatBrim'));

  /* robe: a lathe closed at the hem so the underside reads from below */
  const robe = lathe([[0, 0.13], [0.31, 0.115], [0.345, 0.10], [0.35, 0.13], [0.335, 0.21], [0.30, 0.36], [0.265, 0.56], [0.225, 0.76], [0.20, 0.90], [0.185, 1.00], [0.172, 1.10], [0.178, 1.20], [0.192, 1.33], [0.205, 1.42], [0.19, 1.47], [0.11, 1.52], [0.06, 1.53]], 28);
  robe.scale(1, 1, 0.86);
  const torsoW = nearest([SEG.hips, SEG.spine, SEG.spine2, SEG.chest]);
  part(body, robe, (x, y, z) => {
    if (y < 0.135) return shade(trimCol, 0.8);   // the lining, seen when the hem lifts
    if (y < 0.22) return trimCol;
    if (z > 0 && Math.abs(x) < 0.03 && y < 1.46) return trimCol;        // front sash
    if (y > 1.44) return trimCol;                                          // collar
    return shade(robeCol, 0.72 + 0.33 * smooth((y - 0.2) / 1.2));
  }, (x, y, z) => {
    if (y > 0.9) return torsoW(x, y, z);
    // The thighs carry the cloth over the knees; the hem keeps more of the
    // robe bone so the floor lift in update() can reach it.
    const k = y > 0.45 ? 0.72 * smooth((0.9 - y) / 0.45) : 0.72 - 0.3 * smooth((0.45 - y) / 0.35);
    const s = clamp(x / 0.09, -1, 1) * 0.5 + 0.5;
    return [[B.robe, 1 - k], [B.thL, k * s], [B.thR, k * (1 - s)]];
  });
  part(body, new THREE.TorusGeometry(0.095, 0.028, 7, 18).rotateX(Math.PI / 2).scale(1, 1, 0.85).translate(0, 1.495, 0), darkCol, nearest([SEG.chest, SEG.neck]), { noise: 0.03 });
  part(body, new THREE.BoxGeometry(0.045, 0.04, 0.02).translate(0, 1.465, 0.135), COL.gold, solo('chest'), { noise: 0 });

  /* shoulders, sleeves, hands */
  for (const s of [1, -1]) {
    const side = s > 0 ? 'L' : 'R';
    part(body, new THREE.SphereGeometry(0.095, 12, 10).scale(1, 0.72, 1).translate(s * 0.19, 1.465, 0), darkCol, solo('clav' + side), { noise: 0.04 });
    const sleeve = lathe([[0, -0.49], [0.10, -0.52], [0.118, -0.49], [0.098, -0.40], [0.08, -0.27], [0.078, -0.12], [0.088, -0.02], [0.06, 0.02], [0, 0.03]], 14);
    sleeve.translate(s * 0.21, 1.45, 0);
    part(body, sleeve, (x, y) => (y < 1.45 - 0.44 ? trimCol : shade(robeCol, 0.9 + 0.1 * smooth((y - 0.93) / 0.5))), nearest([SEG['ua' + side], SEG['fa' + side]]));
    const hand = new THREE.SphereGeometry(0.046, 10, 8).scale(1, 1.3, 0.75).translate(s * 0.21, 0.86, 0.01);
    part(body, hand, COL.skin, solo('hand' + side), { noise: 0.03 });
    part(body, new THREE.CapsuleGeometry(0.015, 0.045, 3, 6).rotateZ(s * 0.5).rotateX(-0.6).translate(s * 0.175, 0.875, 0.035), COL.skin, solo('hand' + side), { noise: 0.03 });
  }

  /* belt, buckle, pouches */
  part(body, new THREE.TorusGeometry(0.178, 0.022, 7, 28).rotateX(Math.PI / 2).scale(1, 1, 0.86).translate(0, 1.07, 0), COL.leather, nearest([SEG.hips, SEG.spine]), { noise: 0.04 });
  part(body, new THREE.BoxGeometry(0.06, 0.055, 0.022).translate(0, 1.07, 0.158), COL.gold, solo('spine'), { noise: 0 });
  for (const s of [1, -1]) {
    part(body, new THREE.BoxGeometry(0.08, 0.10, 0.055).rotateY(-s * 0.55).translate(s * 0.14, 0.985, 0.105), COL.pouch, solo('hips'), { noise: 0.05 });
    part(body, new THREE.BoxGeometry(0.085, 0.03, 0.06).rotateY(-s * 0.55).translate(s * 0.14, 1.03, 0.105), shade(COL.pouch, 0.7), solo('hips'), { noise: 0.05 });
  }

  /* legs and boots */
  for (const s of [1, -1]) {
    const side = s > 0 ? 'L' : 'R';
    part(body, new THREE.CylinderGeometry(0.052, 0.06, 0.46, 10).translate(s * 0.10, 0.70, 0), trimCol, nearest([SEG['th' + side], SEG['sh' + side]]), { noise: 0.04 });
    part(body, new THREE.CylinderGeometry(0.046, 0.054, 0.42, 10).translate(s * 0.10, 0.28, 0), trimCol, nearest([SEG['th' + side], SEG['sh' + side]]), { noise: 0.04 });
    part(body, new THREE.CylinderGeometry(0.058, 0.066, 0.29, 12).translate(s * 0.10, 0.205, 0), COL.boot, nearest([SEG['sh' + side], SEG['ft' + side]]), { noise: 0.05 });
    const foot = new THREE.CapsuleGeometry(0.052, 0.13, 4, 10).rotateX(Math.PI / 2).scale(1.05, 0.8, 1).translate(s * 0.10, 0.046, 0.075);
    part(body, foot, COL.boot, (x, y, z) => { const k = smooth((z - 0.08) / 0.08); return k < 0.02 ? [[B['ft' + side], 1]] : [[B['ft' + side], 1 - k], [B['toe' + side], k]]; }, { noise: 0.05 });
  }

  /* staff: shaft, knot, iron collar, three prongs, crystal */
  const sx = BP.staff[0], sy = BP.staff[1], sz = BP.staff[2];
  part(body, new THREE.CylinderGeometry(0.016, 0.023, 1.86, 8).translate(sx, sy + 0.07, sz), (x, y) => shade(COL.wood, 0.85 + 0.3 * hash01(Math.floor(y * 40))), solo('staff'), { noise: 0.1 });
  part(body, new THREE.SphereGeometry(0.03, 8, 6).scale(1, 1.4, 1).translate(sx + 0.005, sy + 0.42, sz), COL.woodDark, solo('staff'), { noise: 0.1 });
  part(body, new THREE.CylinderGeometry(0.034, 0.024, 0.07, 8).translate(sx, sy + 0.90, sz), COL.iron, solo('staff'), { noise: 0.05 });
  for (let k = 0; k < 3; k++) {
    const a = k * Math.PI * 2 / 3 + 0.4;
    const prong = new THREE.BoxGeometry(0.014, 0.13, 0.014).translate(0, 0.06, 0).rotateX(-0.42).rotateY(a).translate(sx + Math.sin(a) * 0.01, sy + 0.93, sz + Math.cos(a) * 0.01);
    part(body, prong, COL.iron, solo('staff'), { noise: 0.05 });
  }
  part(body, mergeVertices(new THREE.OctahedronGeometry(0.062, 0)).scale(1, 1.75, 1).translate(sx, sy + 1.0, sz), lighten(team, 0.45), solo('staff'), { noise: 0 });

  /* cape: a curved strip hanging off the shoulders, skinned to the chain */
  const capeGeo = new THREE.PlaneGeometry(1, 1, 8, 14);
  {
    const p = capeGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i), v = p.getY(i);
      const y = 1.45 - (0.5 - v) * 1.21;
      const w = 0.46 + (1.45 - y) * 0.16;
      const x = u * w;
      const z = -0.165 - (1.45 - y) * 0.165 - (x / 0.3) * (x / 0.3) * 0.07;
      p.setXYZ(i, x, y, z);
    }
    capeGeo.computeVertexNormals();
  }
  part(cape, capeGeo, (x, y) => shade(teamDark, 0.75 + 0.35 * smooth((y - 0.2) / 1.3)), nearest([SEG.cape1, SEG.cape2, SEG.cape3, SEG.cape4], 4), { noise: 0.05 });

  const out = { body: mergeGeometries(body, false), cape: mergeGeometries(cape, false) };
  for (const g of body) g.dispose();
  out.body.computeBoundingSphere(); out.cape.computeBoundingSphere();
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
const DIS_VERT_DECL = 'varying vec3 vDisP;';
const DIS_VERT_SET = 'vDisP = transformed;';
const DIS_FRAG_DECL = /* glsl */`
uniform float uDis; uniform vec3 uDisDir; uniform float uDisLo; uniform float uDisHi; uniform vec3 uDisTint; uniform float uDisGlow;
varying vec3 vDisP;
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
      // Ash on the rim, and the whole body greys as it goes (not when materialising: then the rim glows instead).
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, uDisTint, min(1.0, disEdge * 0.85 + uDis * 0.45 * (1.0 - min(uDisGlow, 1.0))));')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uDisTint * disEdge * uDisGlow;');
  }
}
const DIS_KEY_LIT = () => 'mage-dissolve-lit';
const DIS_KEY_DEPTH = () => 'mage-dissolve-depth';

/** One mage's materials: its own, so its dissolve is its own. */
function materials(U) {
  const body = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.02 });
  const cape = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
  for (const m of [body, cape]) { m.onBeforeCompile = (sh) => patchDissolve(sh, U, true); m.customProgramCacheKey = DIS_KEY_LIT; }
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (sh) => patchDissolve(sh, U, false); depth.customProgramCacheKey = DIS_KEY_DEPTH;
  return { body, cape, depth };
}

/* ----------------------------------------------------------- poses */

// The rest pose every key starts from. Degrees, XYZ order. Conventions (bone
// axes are world axes in bind): limbs point -Y, so -X swings a limb FORWARD,
// +X on a shin/forearm is knee/elbow flex... no: elbow flex (hand forward) is
// -X, knee flex (foot back) is +X. On the spine/head, +X bows forward, +Y
// turns to the left, +Z leans right. For the left arm +Z abducts, for the
// right arm -Z. The staff points up its own +Y; with the chain all about X,
// staff.x = -(uaR.x + faR.x) keeps it vertical.
const STAND = {
  pos: [0, 0, 0], hips: [0, 0, 0], spine: [3, 0, 0], spine2: [0, 0, 0], chest: [-2, 0, 0], neck: [2, 0, 0], head: [1, 0, 0], hat: [0, 0, 0],
  clavL: [0, 0, 0], uaL: [-6, 0, 14], faL: [-18, 0, 0], handL: [0, 0, 0],
  clavR: [0, 0, 0], uaR: [-8, 0, -14], faR: [-25, 0, 0], handR: [0, 0, 0], staff: [33, 0, 14],
  thL: [0, 0, 4], shL: [2, 0, 0], ftL: [-2, 0, -4], toeL: [0, 0, 0],
  thR: [0, 0, -4], shR: [2, 0, 0], ftR: [-2, 0, 4], toeR: [0, 0, 0],
};
// Flat on the back, where death ends and standUp/tumbleLand begin.
const LIE_BACK = {
  pos: [0, -0.80, -0.12], hips: [-86, 0, 0], spine: [4, 0, 0], chest: [4, 0, 0], neck: [10, 0, 0], head: [20, 0, 0], hat: [-20, 0, 0],
  uaL: [-15, 0, 55], faL: [-30, 0, 0], uaR: [-10, 0, -50], faR: [-25, 0, 0], staff: [35, 0, 0],
  thL: [-10, 0, 8], shL: [15, 0, 0], ftL: [25, 0, -8], thR: [-5, 0, -8], shR: [10, 0, 0], ftR: [25, 0, 8],
};
const CROUCH = {
  spine: [18, 0, 0], chest: [4, 0, 0], head: [-10, 0, 0], pos: [0, -0.22, 0],
  thL: [-48, 0, 6], shL: [75, 0, 0], ftL: [-27, 0, -6], thR: [-48, 0, -6], shR: [75, 0, 0], ftR: [-27, 0, 6],
};
// Off the back and onto the feet, from `t0`: sit up, crouch, half up, stand.
const GETUP = (t0) => [
  [t0 + 0.35, { pos: [0, -0.62, -0.1], hips: [-40, 0, 0], spine: [35, 0, 0], chest: [15, 0, 0], head: [0, 0, 0], neck: [0, 0, 0], hat: [-5, 0, 0],
    thL: [-70, 0, 8], shL: [95, 0, 0], ftL: [10, 0, -8], thR: [-65, 0, -8], shR: [90, 0, 0], ftR: [10, 0, 8],
    uaL: [10, 0, 30], faL: [-40, 0, 0], uaR: [20, 0, -30], faR: [-20, 0, 0], staff: [30, 0, 0] }],
  [t0 + 0.75, { pos: [0, -0.28, 0.02], hips: [10, 0, 0], spine: [25, 0, 0], chest: [5, 0, 0], head: [-20, 0, 0],
    thL: [-55, 0, 8], shL: [85, 0, 0], ftL: [-30, 0, -8], thR: [-55, 0, -8], shR: [85, 0, 0], ftR: [-30, 0, 8],
    uaL: [-30, 0, 25], faL: [-40, 0, 0], uaR: [-45, 0, -20], faR: [-30, 0, 0], staff: [75, 0, 14] }],
  [t0 + 1.15, { pos: [0, -0.1, 0], spine: [12, 0, 0], head: [-8, 0, 0],
    thL: [-25, 0, 6], shL: [40, 0, 0], ftL: [-15, 0, -6], thR: [-25, 0, -6], shR: [40, 0, 0], ftR: [-15, 0, 6],
    uaR: [-30, 0, -18], faR: [-30, 0, 0], staff: [60, 0, 14], uaL: [-10, 0, 20] }],
  [t0 + 1.6, {}],
];

// name -> [[time, pose, ease?], ...]. A loop's last key equals its first.
const CLIPS = {
  idle: [
    [0, {}],
    [1.3, { pos: [0.02, -0.01, 0], hips: [0, 0, 2], spine: [3, 0, -2], chest: [-2, 0, -1], head: [-4, 3, 2], uaL: [-6, 0, 16] }],
    [2.6, { pos: [-0.02, -0.01, 0], hips: [0, 0, -2], spine: [3, 0, 2], head: [-4, -3, -1], faR: [-28, 0, 0], staff: [36, 0, 14] }],
    [3.8, {}],
  ],
  fidget: [
    [0, {}],
    [0.45, { uaL: [-55, 0, 20], faL: [-75, 0, 0], uaR: [-45, 0, -10], faR: [-70, 0, 0], staff: [115, 0, 10], head: [8, 0, 0], spine: [5, 0, 0] }],
    [0.9, { uaL: [-60, 10, 15], faL: [-80, 0, 0], handL: [0, 60, 0], uaR: [-45, 0, -10], faR: [-70, 0, 0], staff: [115, 0, 10], head: [9, 4, 0], spine: [5, 0, 0] }],
    [1.4, { uaL: [-50, -10, 25], faL: [-70, 0, 0], handL: [0, -50, 0], uaR: [-45, 0, -10], faR: [-70, 0, 0], staff: [115, 0, 10], head: [8, -4, 0], spine: [5, 0, 0] }],
    [1.8, { uaL: [-55, 0, 20], faL: [-75, 0, 0], uaR: [-45, 0, -10], faR: [-70, 0, 0], staff: [115, 0, 10], head: [8, 0, 0], spine: [5, 0, 0] }],
    [2.2, {}],
  ],
  walk: [
    [0, { thL: [-24, 0, 4], shL: [6, 0, 0], ftL: [-8, 0, -4], thR: [16, 0, -4], shR: [18, 0, 0], ftR: [10, 0, 4], pos: [0, -0.015, 0], hips: [0, -4, 0], chest: [-2, 4, 0],
      uaL: [14, 0, 14], faL: [-15, 0, 0], uaR: [-18, 0, -14], faR: [-30, 0, 0], staff: [48, 0, 14] }],
    [0.25, { thL: [-6, 0, 4], shL: [8, 0, 0], ftL: [-2, 0, -4], thR: [-4, 0, -4], shR: [48, 0, 0], ftR: [14, 0, 4], pos: [0, 0.012, 0], uaL: [0, 0, 14] }],
    [0.5, { thR: [-24, 0, -4], shR: [6, 0, 0], ftR: [-8, 0, 4], thL: [16, 0, 4], shL: [18, 0, 0], ftL: [10, 0, -4], pos: [0, -0.015, 0], hips: [0, 4, 0], chest: [-2, -4, 0],
      uaL: [-20, 0, 14], faL: [-30, 0, 0], uaR: [2, 0, -14], faR: [-20, 0, 0], staff: [18, 0, 14] }],
    [0.75, { thR: [-6, 0, -4], shR: [8, 0, 0], ftR: [-2, 0, 4], thL: [-4, 0, 4], shL: [48, 0, 0], ftL: [14, 0, -4], pos: [0, 0.012, 0], uaL: [-10, 0, 14], faL: [-22, 0, 0] }],
    [1.0, { thL: [-24, 0, 4], shL: [6, 0, 0], ftL: [-8, 0, -4], thR: [16, 0, -4], shR: [18, 0, 0], ftR: [10, 0, 4], pos: [0, -0.015, 0], hips: [0, -4, 0], chest: [-2, 4, 0],
      uaL: [14, 0, 14], faL: [-15, 0, 0], uaR: [-18, 0, -14], faR: [-30, 0, 0], staff: [48, 0, 14] }],
  ],
  run: [
    [0, { thL: [-38, 0, 4], shL: [15, 0, 0], ftL: [-5, 0, -4], thR: [28, 0, -4], shR: [55, 0, 0], ftR: [20, 0, 4], pos: [0, -0.03, 0], hips: [0, -6, 0], spine: [12, 0, 0], chest: [0, 8, 0], head: [-10, 0, 0],
      uaL: [30, 0, 12], faL: [-70, 0, 0], uaR: [-45, 0, -14], faR: [-80, 0, 0], staff: [125, 0, 14] }],
    [0.15, { thL: [-5, 0, 4], shL: [40, 0, 0], ftL: [5, 0, -4], thR: [-10, 0, -4], shR: [85, 0, 0], ftR: [25, 0, 4], pos: [0, 0.05, 0], spine: [12, 0, 0], head: [-10, 0, 0],
      uaL: [-5, 0, 12], faL: [-70, 0, 0], uaR: [-25, 0, -14], faR: [-80, 0, 0], staff: [105, 0, 14] }],
    [0.31, { thR: [-38, 0, -4], shR: [15, 0, 0], ftR: [-5, 0, 4], thL: [28, 0, 4], shL: [55, 0, 0], ftL: [20, 0, -4], pos: [0, -0.03, 0], hips: [0, 6, 0], spine: [12, 0, 0], chest: [0, -8, 0], head: [-10, 0, 0],
      uaL: [-40, 0, 12], faL: [-70, 0, 0], uaR: [-5, 0, -14], faR: [-80, 0, 0], staff: [85, 0, 14] }],
    [0.46, { thR: [-5, 0, -4], shR: [40, 0, 0], ftR: [5, 0, 4], thL: [-10, 0, 4], shL: [85, 0, 0], ftL: [25, 0, -4], pos: [0, 0.05, 0], spine: [12, 0, 0], head: [-10, 0, 0],
      uaL: [-20, 0, 12], faL: [-70, 0, 0], uaR: [-25, 0, -14], faR: [-80, 0, 0], staff: [105, 0, 14] }],
    [0.62, { thL: [-38, 0, 4], shL: [15, 0, 0], ftL: [-5, 0, -4], thR: [28, 0, -4], shR: [55, 0, 0], ftR: [20, 0, 4], pos: [0, -0.03, 0], hips: [0, -6, 0], spine: [12, 0, 0], chest: [0, 8, 0], head: [-10, 0, 0],
      uaL: [30, 0, 12], faL: [-70, 0, 0], uaR: [-45, 0, -14], faR: [-80, 0, 0], staff: [125, 0, 14] }],
  ],
  castShoot: [
    [0, {}],
    [0.16, { chest: [0, -14, 0], spine: [0, -6, 0], uaR: [-30, 0, -30], faR: [-70, 0, 0], staff: [70, 0, 14], uaL: [-20, 0, 25], pos: [0, -0.02, -0.03], head: [-4, 10, 0] }, 'in'],
    [0.3, { chest: [4, 14, 0], spine: [4, 6, 0], uaR: [-78, 0, -6], faR: [-8, 0, 0], staff: [160, 0, 0], uaL: [25, 0, 20], faL: [-30, 0, 0], pos: [0, -0.03, 0.08],
      thL: [-16, 0, 4], shL: [10, 0, 0], thR: [12, 0, -4], shR: [8, 0, 0], ftR: [8, 0, 4], head: [-6, -6, 0] }, 'out'],
    [0.48, { chest: [4, 12, 0], spine: [4, 6, 0], uaR: [-72, 0, -8], faR: [-10, 0, 0], staff: [160, 0, 0], uaL: [25, 0, 20], faL: [-30, 0, 0], pos: [0, -0.03, 0.08],
      thL: [-16, 0, 4], shL: [10, 0, 0], thR: [12, 0, -4], shR: [8, 0, 0], ftR: [8, 0, 4], head: [-6, -6, 0] }],
    [0.75, {}],
  ],
  castRaise: [
    [0, {}],
    [0.28, { spine: [12, 0, 0], chest: [6, 0, 0], head: [6, 0, 0], pos: [0, -0.1, 0], thL: [-30, 0, 6], shL: [50, 0, 0], ftL: [-20, 0, -6], thR: [-30, 0, -6], shR: [50, 0, 0], ftR: [-20, 0, 6],
      uaL: [20, 0, 30], faL: [-20, 0, 0], uaR: [15, 0, -30], faR: [-20, 0, 0], staff: [5, 0, 14] }],
    [0.55, { spine: [-8, 0, 0], chest: [-10, 0, 0], head: [-18, 0, 0], pos: [0, 0.02, 0], thL: [0, 0, 10], thR: [0, 0, -10], ftL: [-2, 0, -10], ftR: [-2, 0, 10],
      uaL: [-160, 0, 20], faL: [-15, 0, 0], uaR: [-162, 0, -18], faR: [-12, 0, 0], staff: [178, 0, 0] }, 'out'],
    [0.9, { spine: [-8, 0, 0], chest: [-10, 0, 0], head: [-18, 0, 0], pos: [0, 0.02, 0], thL: [0, 0, 10], thR: [0, 0, -10], ftL: [-2, 0, -10], ftR: [-2, 0, 10],
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
  hitA: [
    [0, {}],
    [0.07, { chest: [-12, 0, -8], spine: [-6, 0, 0], head: [14, 0, 10], neck: [6, 0, 0], pos: [0, -0.02, -0.05], uaL: [-20, 0, 40], uaR: [-10, 0, -30], faR: [-40, 0, 0], staff: [50, 0, 14], thR: [10, 0, -4], shR: [12, 0, 0] }, 'out'],
    [0.22, { chest: [-6, 0, -4], head: [8, 0, 6], pos: [0, -0.01, -0.03], uaL: [-10, 0, 25], thR: [6, 0, -4], shR: [8, 0, 0] }],
    [0.5, {}],
  ],
  hitB: [
    [0, {}],
    [0.07, { chest: [-12, 0, 8], spine: [-6, 0, 0], head: [14, 0, -10], neck: [6, 0, 0], pos: [0, -0.02, -0.05], uaL: [-10, 0, 30], uaR: [-20, 0, -40], faR: [-40, 0, 0], staff: [60, 0, 14], thL: [10, 0, 4], shL: [12, 0, 0] }, 'out'],
    [0.22, { chest: [-6, 0, 4], head: [8, 0, -6], pos: [0, -0.01, -0.03], uaR: [-12, 0, -25], thL: [6, 0, 4], shL: [8, 0, 0] }],
    [0.5, {}],
  ],
  hitFire: [
    [0, {}],
    [0.1, { chest: [-14, 0, 0], spine: [-8, 0, 0], head: [-10, 0, 0], pos: [0, -0.02, -0.08], uaL: [-100, 0, 30], faL: [-90, 0, 0], uaR: [-80, 0, -30], faR: [-80, 0, 0], staff: [120, 0, 14], thR: [12, 0, -4], shR: [10, 0, 0] }, 'out'],
    [0.3, { chest: [-10, -10, 0], spine: [-8, 0, 0], head: [-8, 15, 0], pos: [0, -0.02, -0.08], uaL: [-130, 0, 50], faL: [-40, 0, 0], uaR: [-50, 0, -50], faR: [-60, 0, 0], staff: [100, 0, 14], thR: [12, 0, -4], shR: [10, 0, 0] }],
    [0.5, { chest: [-8, 10, 0], spine: [-6, 0, 0], head: [-6, -15, 0], pos: [0, -0.02, -0.06], uaL: [-70, 0, 60], faL: [-90, 0, 0], uaR: [-110, 0, -40], faR: [-30, 0, 0], staff: [130, 0, 14], thR: [12, 0, -4], shR: [10, 0, 0] }],
    [0.75, { spine: [20, 0, 0], chest: [10, 0, 0], head: [16, 0, 0], pos: [0, -0.05, -0.04], uaL: [-40, 0, 10], faL: [-25, 0, 0], uaR: [-35, 0, -15], faR: [-30, 0, 0], staff: [60, 0, 14] }],
    [0.95, { spine: [24, 0, 0], chest: [10, 0, 0], head: [16, 0, 0], pos: [0, -0.06, -0.04], uaL: [-15, 0, 12], faL: [-10, 0, 0], uaR: [-50, 0, -15], faR: [-20, 0, 0], staff: [70, 0, 14] }],
    [1.15, { spine: [20, 0, 0], chest: [10, 0, 0], head: [16, 0, 0], pos: [0, -0.05, -0.04], uaL: [-40, 0, 12], faL: [-25, 0, 0], uaR: [-30, 0, -15], faR: [-30, 0, 0], staff: [55, 0, 14] }],
    [1.5, {}],
  ],
  hitLightning: [
    [0, {}],
    [0.05, { spine: [-10, 0, 0], chest: [-8, 0, 0], head: [-18, 0, 0], neck: [-6, 0, 0], hat: [-15, 0, 0], pos: [0, 0.03, 0], uaL: [-25, 0, 85], faL: [-5, 0, 0], handL: [0, 0, 30], uaR: [-20, 0, -85], faR: [-5, 0, 0], handR: [0, 0, -30], staff: [25, 0, 0],
      thL: [-4, 0, 14], thR: [-4, 0, -14], shL: [0, 0, 0], shR: [0, 0, 0], ftL: [0, 0, -14], ftR: [0, 0, 14] }, 'out'],
    [0.12, { spine: [-10, 0, 0], chest: [-8, 0, 6], head: [-18, 0, 8], neck: [-6, 0, 0], hat: [-12, 0, 8], pos: [0, 0.03, 0], uaL: [-20, 0, 80], faL: [-5, 0, 0], handL: [0, 0, 30], uaR: [-28, 0, -88], faR: [-5, 0, 0], handR: [0, 0, -30], staff: [25, 0, 0],
      thL: [-4, 0, 14], thR: [-4, 0, -14], shL: [0, 0, 0], shR: [0, 0, 0], ftL: [0, 0, -14], ftR: [0, 0, 14] }, 'lin'],
    [0.19, { spine: [-10, 0, 0], chest: [-8, 0, -6], head: [-18, 0, -8], neck: [-6, 0, 0], hat: [-18, 0, -8], pos: [0, 0.03, 0], uaL: [-30, 0, 90], faL: [-5, 0, 0], handL: [0, 0, 30], uaR: [-16, 0, -80], faR: [-5, 0, 0], handR: [0, 0, -30], staff: [25, 0, 0],
      thL: [-4, 0, 14], thR: [-4, 0, -14], shL: [0, 0, 0], shR: [0, 0, 0], ftL: [0, 0, -14], ftR: [0, 0, 14] }, 'lin'],
    [0.26, { spine: [-10, 0, 0], chest: [-8, 0, 5], head: [-18, 0, 6], neck: [-6, 0, 0], hat: [-12, 0, 6], pos: [0, 0.03, 0], uaL: [-22, 0, 82], faL: [-5, 0, 0], handL: [0, 0, 30], uaR: [-26, 0, -86], faR: [-5, 0, 0], handR: [0, 0, -30], staff: [25, 0, 0],
      thL: [-4, 0, 14], thR: [-4, 0, -14], shL: [0, 0, 0], shR: [0, 0, 0], ftL: [0, 0, -14], ftR: [0, 0, 14] }, 'lin'],
    [0.33, { spine: [-10, 0, 0], chest: [-8, 0, -4], head: [-18, 0, -5], neck: [-6, 0, 0], hat: [-16, 0, -5], pos: [0, 0.03, 0], uaL: [-28, 0, 88], faL: [-5, 0, 0], handL: [0, 0, 30], uaR: [-18, 0, -82], faR: [-5, 0, 0], handR: [0, 0, -30], staff: [25, 0, 0],
      thL: [-4, 0, 14], thR: [-4, 0, -14], shL: [0, 0, 0], shR: [0, 0, 0], ftL: [0, 0, -14], ftR: [0, 0, 14] }, 'lin'],
    [0.5, { spine: [18, 0, 0], chest: [10, 0, 0], head: [16, 0, 0], pos: [0, -0.08, 0], uaL: [-10, 0, 20], faL: [-20, 0, 0], uaR: [-10, 0, -20], faR: [-30, 0, 0], staff: [40, 0, 14],
      thL: [-20, 0, 6], shL: [35, 0, 0], ftL: [-15, 0, -6], thR: [-20, 0, -6], shR: [35, 0, 0], ftR: [-15, 0, 6] }],
    [0.7, { spine: [10, 0, 0], chest: [6, 0, 0], head: [8, -25, 0], pos: [0, -0.04, 0], uaL: [-10, 0, 20], faL: [-20, 0, 0], uaR: [-10, 0, -20], faR: [-30, 0, 0], staff: [40, 0, 14],
      thL: [-10, 0, 6], shL: [18, 0, 0], ftL: [-8, 0, -6], thR: [-10, 0, -6], shR: [18, 0, 0], ftR: [-8, 0, 6] }],
    [0.85, { spine: [6, 0, 0], head: [6, 25, 0], pos: [0, -0.02, 0], thL: [-5, 0, 6], shL: [9, 0, 0], ftL: [-4, 0, -6], thR: [-5, 0, -6], shR: [9, 0, 0], ftR: [-4, 0, 6] }],
    [1.0, { head: [2, -10, 0] }],
    [1.2, {}],
  ],
  crush: [
    [0, {}],
    [0.1, { pos: [0, -0.78, -0.10], hips: [82, 0, 0], spine: [4, 0, 0], chest: [-6, 0, 0], head: [-30, 0, 0], neck: [-10, 0, 0], hat: [-10, 0, 0],
      uaL: [-10, 0, 70], faL: [-60, 0, 0], uaR: [-10, 0, -70], faR: [-60, 0, 0], staff: [0, 0, 0],
      thL: [-6, 0, 6], thR: [-6, 0, -6], shL: [8, 0, 0], shR: [8, 0, 0], ftL: [30, 0, 0], ftR: [30, 0, 0] }, 'out'],
    [0.7, { pos: [0, -0.78, -0.10], hips: [82, 0, 0], spine: [4, 0, 0], chest: [-6, 0, 0], head: [-35, 0, 0], neck: [-10, 0, 0], hat: [-10, 0, 0],
      uaL: [-10, 0, 70], faL: [-60, 0, 0], uaR: [-10, 0, -70], faR: [-60, 0, 0], staff: [0, 0, 0],
      thL: [-6, 0, 6], thR: [-6, 0, -6], shL: [8, 0, 0], shR: [8, 0, 0], ftL: [30, 0, 0], ftR: [30, 0, 0] }],
    [1.0, { pos: [0, -0.72, -0.10], hips: [70, 0, 0], spine: [4, 0, 0], chest: [-20, 0, 0], head: [-40, 0, 0], neck: [-10, 0, 0],
      uaL: [-70, 0, 30], faL: [-90, 0, 0], uaR: [-70, 0, -30], faR: [-90, 0, 0], staff: [20, 0, 0],
      thL: [-6, 0, 6], thR: [-6, 0, -6], shL: [8, 0, 0], shR: [8, 0, 0], ftL: [30, 0, 0], ftR: [30, 0, 0] }],
    [1.4, { pos: [0, -0.46, -0.05], hips: [20, 0, 0], spine: [10, 0, 0], chest: [-10, 0, 0], head: [-20, 0, 0],
      thL: [-40, 0, 6], shL: [115, 0, 0], ftL: [50, 0, 0], thR: [-40, 0, -6], shR: [115, 0, 0], ftR: [50, 0, 0],
      uaL: [-40, 0, 20], faL: [-40, 0, 0], uaR: [-30, 0, -25], faR: [-50, 0, 0], staff: [80, 0, 14] }],
    [1.8, { pos: [0, -0.22, 0], spine: [20, 0, 0], head: [-14, 0, 0],
      thL: [-45, 0, 6], shL: [70, 0, 0], ftL: [-25, 0, -6], thR: [-45, 0, -6], shR: [70, 0, 0], ftR: [-25, 0, 6],
      uaR: [-40, 0, -20], faR: [-30, 0, 0], staff: [70, 0, 14], uaL: [-20, 0, 25], faL: [-30, 0, 0] }],
    [2.4, {}],
  ],
  shove: [
    [0, {}],
    [0.12, { spine: [-12, 0, 0], chest: [-8, 0, 0], head: [-8, 0, 0], pos: [0, -0.02, -0.08], thR: [30, 0, -4], shR: [20, 0, 0], ftR: [10, 0, 4], thL: [-10, 0, 4],
      uaL: [-50, 0, 30], faL: [-30, 0, 0], uaR: [-40, 0, -30], faR: [-40, 0, 0], staff: [80, 0, 14] }, 'out'],
    [0.32, { spine: [-10, 0, 0], chest: [-6, 0, 0], head: [-6, 0, 0], pos: [0, -0.03, -0.17], thL: [28, 0, 4], shL: [25, 0, 0], ftL: [12, 0, -4], thR: [-5, 0, -4], shR: [10, 0, 0], ftR: [0, 0, 4],
      uaL: [-60, 0, 35], faL: [-30, 0, 0], uaR: [-50, 0, -30], faR: [-40, 0, 0], staff: [90, 0, 14] }],
    [0.5, { spine: [-4, 0, 0], pos: [0, -0.02, -0.2], thR: [20, 0, -4], shR: [15, 0, 0], thL: [-8, 0, 4], shL: [6, 0, 0],
      uaL: [-30, 0, 25], faL: [-25, 0, 0], uaR: [-25, 0, -20], faR: [-35, 0, 0], staff: [60, 0, 14] }],
    [0.85, { pos: [0, 0, -0.06], thL: [-10, 0, 4] }],
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
    [0.16, { ...CROUCH, uaL: [30, 0, 20], uaR: [25, 0, -20], faR: [-20, 0, 0], staff: [-5, 0, 14] }],
    [0.3, { spine: [-6, 0, 0], chest: [-6, 0, 0], head: [-8, 0, 0], pos: [0, 0.06, 0], thL: [-12, 0, 6], shL: [10, 0, 0], ftL: [20, 0, -6], thR: [-12, 0, -6], shR: [10, 0, 0], ftR: [20, 0, 6],
      uaL: [-140, 0, 30], faL: [-20, 0, 0], uaR: [-130, 0, -30], faR: [-20, 0, 0], staff: [150, 0, 14] }, 'out'],
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
    [0.14, { ...CROUCH, spine: [22, 0, 0], head: [-12, 0, 0], pos: [0, -0.24, 0], uaL: [-50, 0, 30], faL: [-40, 0, 0], uaR: [-40, 0, -30], faR: [-40, 0, 0], staff: [80, 0, 14] }, 'out'],
    [0.45, {}],
  ],
  tumble: [
    [0, { hips: [-25, 0, 0], spine: [-10, 0, 0], head: [-10, 0, 0], hat: [10, 0, 0], uaL: [-150, 0, 40], faL: [-40, 0, 0], uaR: [-30, 0, -60], faR: [-70, 0, 0], staff: [60, 0, 0],
      thL: [-50, 0, 10], shL: [40, 0, 0], thR: [10, 0, -10], shR: [70, 0, 0] }],
    [0.23, { hips: [-15, 10, 0], spine: [10, 0, 0], head: [-10, 0, 0], hat: [10, 0, 0], uaL: [-60, 0, 80], faL: [-90, 0, 0], uaR: [-150, 0, -40], faR: [-30, 0, 0], staff: [120, 0, 0],
      thL: [10, 0, 10], shL: [70, 0, 0], thR: [-50, 0, -10], shR: [40, 0, 0] }],
    [0.47, { hips: [-30, -10, 0], spine: [0, 0, 0], head: [15, 0, 0], hat: [10, 0, 0], uaL: [-100, 0, 30], faL: [-20, 0, 0], uaR: [-80, 0, -90], faR: [-80, 0, 0], staff: [90, 0, 0],
      thL: [-30, 0, 10], shL: [20, 0, 0], thR: [-20, 0, -10], shR: [90, 0, 0] }],
    [0.7, { hips: [-25, 0, 0], spine: [-10, 0, 0], head: [-10, 0, 0], hat: [10, 0, 0], uaL: [-150, 0, 40], faL: [-40, 0, 0], uaR: [-30, 0, -60], faR: [-70, 0, 0], staff: [60, 0, 0],
      thL: [-50, 0, 10], shL: [40, 0, 0], thR: [10, 0, -10], shR: [70, 0, 0] }],
  ],
  tumbleLand: [
    [0, { hips: [-25, 0, 0], spine: [-10, 0, 0], head: [-10, 0, 0], hat: [10, 0, 0], uaL: [-150, 0, 40], faL: [-40, 0, 0], uaR: [-30, 0, -60], faR: [-70, 0, 0], staff: [60, 0, 0],
      thL: [-50, 0, 10], shL: [40, 0, 0], thR: [10, 0, -10], shR: [70, 0, 0] }],
    [0.08, { ...LIE_BACK, pos: [0, -0.76, -0.12], uaL: [-30, 0, 70], uaR: [-25, 0, -65] }, 'out'],
    [0.2, { ...LIE_BACK, pos: [0, -0.81, -0.12] }],
    [0.6, { ...LIE_BACK, head: [26, 10, 0] }],
    ...GETUP(0.6),
  ],
  cheer: [
    [0, { uaL: [-150, 0, 25], faL: [-30, 0, 0], uaR: [-140, 0, -25], faR: [-20, 0, 0], staff: [175, 0, 0], head: [-10, 0, 0], spine: [-4, 0, 0], thL: [0, 0, 6], thR: [0, 0, -6] }],
    [0.3, { pos: [0, 0.1, 0], thL: [-20, 0, 6], shL: [30, 0, 0], ftL: [15, 0, -6], thR: [-20, 0, -6], shR: [30, 0, 0], ftR: [15, 0, 6],
      uaL: [-165, 0, 30], faL: [-30, 0, 0], uaR: [-160, 0, -30], faR: [-20, 0, 0], staff: [175, 0, 0], head: [-14, 0, 0], hat: [-6, 0, 0], spine: [-4, 0, 0] }],
    [0.55, { pos: [0, -0.04, 0], thL: [-15, 0, 6], shL: [25, 0, 0], ftL: [-10, 0, -6], thR: [-15, 0, -6], shR: [25, 0, 0], ftR: [-10, 0, 6],
      uaL: [-140, 0, 20], faL: [-30, 0, 0], uaR: [-130, 0, -20], faR: [-20, 0, 0], staff: [175, 0, 0], head: [-8, 0, 0], spine: [4, 0, 0] }],
    [0.9, { uaL: [-150, 0, 25], faL: [-30, 0, 0], uaR: [-140, 0, -25], faR: [-20, 0, 0], staff: [175, 0, 0], head: [-10, 0, 0], spine: [-4, 0, 0], thL: [0, 0, 6], thR: [0, 0, -6] }],
  ],
  death: [
    [0, {}],
    [0.12, { chest: [-14, 0, -6], head: [10, 0, 8], uaL: [-40, 0, 40], uaR: [-30, 0, -30], faR: [-40, 0, 0], staff: [50, 0, 14], pos: [0, -0.02, -0.04] }, 'out'],
    [0.45, { pos: [0, -0.3, -0.1], hips: [-10, 0, 0], spine: [10, 0, 0], chest: [-6, 0, 0], head: [-10, 0, 0],
      thL: [-40, 0, 6], shL: [80, 0, 0], ftL: [-20, 0, -6], thR: [-40, 0, -6], shR: [80, 0, 0], ftR: [-20, 0, 6],
      uaL: [-20, 0, 40], faL: [-20, 0, 0], uaR: [-15, 0, -35], faR: [-30, 0, 0], staff: [45, 0, 14] }],
    [0.75, { pos: [0, -0.55, -0.12], hips: [-50, 0, 0], spine: [0, 0, 0], chest: [0, 0, 0], head: [-10, 0, 0],
      thL: [-20, 0, 8], shL: [40, 0, 0], thR: [-15, 0, -8], shR: [35, 0, 0], uaL: [-40, 0, 60], uaR: [-30, 0, -50], staff: [40, 0, 0] }],
    [1.0, { ...LIE_BACK, pos: [0, -0.78, -0.12], head: [12, 0, 0] }, 'out'],
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
const LOOPS = new Set(['idle', 'fidget', 'walk', 'run', 'jumpHang', 'tumble', 'cheer', 'levitate']);

const EASE = {
  smooth,
  lin: (u) => u,
  in: (u) => u * u * u,
  out: (u) => 1 - Math.pow(1 - u, 3),
};
const tmpEuler = new THREE.Euler();
const tmpQ = new THREE.Quaternion();

/** Keys -> an AnimationClip of quaternion tracks (+ hips position), eased by sub-sampling. */
function buildClip(name, keys, { sub = 4 } = {}) {
  const full = keys.map(([t, p, e]) => [t, { ...STAND, ...p }, EASE[e] || smooth]);
  const times = [];
  const rot = {}; for (const b of ANIM_BONES) rot[b] = [];
  const pos = [];
  const push = (t, pa, pb, w) => {
    times.push(t);
    for (const b of ANIM_BONES) {
      const a = pa[b], c = pb ? pb[b] : a;
      tmpEuler.set((a[0] + (c[0] - a[0]) * w) * DEG2RAD, (a[1] + (c[1] - a[1]) * w) * DEG2RAD, (a[2] + (c[2] - a[2]) * w) * DEG2RAD, 'XYZ');
      tmpQ.setFromEuler(tmpEuler);
      rot[b].push(tmpQ.x, tmpQ.y, tmpQ.z, tmpQ.w);
    }
    const a = pa.pos, c = pb ? pb.pos : a;
    pos.push(BP.hips[0] + a[0] + (c[0] - a[0]) * w, BP.hips[1] + a[1] + (c[1] - a[1]) * w, BP.hips[2] + a[2] + (c[2] - a[2]) * w);
  };
  for (let i = 0; i < full.length - 1; i++) {
    const [t0, pa] = full[i], [t1, pb, ease] = full[i + 1];
    for (let j = 0; j < sub; j++) { const u = j / sub; push(t0 + (t1 - t0) * u, pa, pb, ease(u)); }
  }
  push(full[full.length - 1][0], full[full.length - 1][1], null, 0);
  const tracks = ANIM_BONES.map((b) => new THREE.QuaternionKeyframeTrack(`${b}.quaternion`, times, rot[b]));
  tracks.push(new THREE.VectorKeyframeTrack('hips.position', times, pos));
  return new THREE.AnimationClip(name, -1, tracks);
}
let clipCache = null;
function clips() {
  if (!clipCache) { clipCache = {}; for (const [name, keys] of Object.entries(CLIPS)) clipCache[name] = buildClip(name, keys); }
  return clipCache;
}

/* ----------------------------------------------------------- actor */

// walk covers ~1.2 m per 1.0 s cycle, run ~2.2 m per 0.62 s cycle.
const WALK_STRIDE = 1.2, RUN_STRIDE = 2.2;
const RUN_SPEED = 3;
const X_AXIS = new THREE.Vector3(1, 0, 0), Y_AXIS = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler();

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
  const mixer = new THREE.AnimationMixer(model);
  const actions = {};
  for (const [key, clip] of Object.entries(clips())) actions[key] = mixer.clipAction(clip);
  const durOf = (key) => actions[key]?.getClip().duration ?? 0;

  let current = null;
  /** Crossfade to a clip. A looping clip that is already up keeps playing. */
  function play(key, { loop = true, fade = 0.2, speed = 1, clamp: clampEnd = false, reps = Infinity } = {}) {
    const a = actions[key] || actions.idle;
    if (!a) return null;
    if (current === a && loop && reps === Infinity && a.isRunning()) { a.timeScale = speed; return a; }
    const restart = current === a;
    a.reset();
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, reps);
    a.clampWhenFinished = clampEnd || !loop || reps !== Infinity;
    a.timeScale = speed;
    a.enabled = true;
    a.setEffectiveWeight(1);
    if (restart) { /* same clip again: snap to its start */ }
    else if (current) a.crossFadeFrom(current, fade, false);
    else a.fadeIn(fade);
    a.play();
    current = a;
    return a;
  }

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
  function oneShot(key, { speed = 1, hold = 0, clamp: clampEnd = false, fade = 0.12 } = {}) {
    return run([{ key, speed, hold, clamp: clampEnd, fade }]);
  }

  let hitFlip = false;
  let fidgetAt = 0;
  let locoKey = null;
  let levitating = false;

  function locomotion(now) {
    if (levitating) { if (locoKey !== 'levitate') { play('levitate', { fade: 0.5 }); locoKey = 'levitate'; } return; }
    if (actor.moving) {
      const running = actor.speed > RUN_SPEED;
      const key = running ? 'run' : 'walk';
      const stride = running ? RUN_STRIDE : WALK_STRIDE;
      const speed = clamp(actor.speed * durOf(key) / stride, 0.75, 2.4);
      play(key, { speed, fade: locoKey ? 0.18 : 0.24 });
      locoKey = key;
      fidgetAt = now + 6000 + Math.random() * 6000;
      return;
    }
    if (locoKey !== 'idle') { play('idle', { fade: 0.28 }); locoKey = 'idle'; fidgetAt = now + 5000 + Math.random() * 7000; return; }
    if (now > fidgetAt && actor.fidgets) {
      run([{ key: 'fidget', loop: true, reps: 2, speed: 0.85, fade: 0.45 }], now);
      locoKey = null;
      fidgetAt = now + 9000 + Math.random() * 9000;
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
  const hemY = (phi) => { _v.set(0, -0.85 * Math.cos(phi), -0.85 * Math.sin(phi)).applyQuaternion(_hq); return _hp.y + _v.y; };
  const lastPos = new THREE.Vector3(), lastHeadQ = new THREE.Quaternion();
  // The mixer only writes a bone whose clip value changed since last frame, so
  // the bones we post-multiply are put back to the mixer's value first.
  const base = { chest: new THREE.Quaternion(), neck: new THREE.Quaternion(), head: new THREE.Quaternion() };
  function restoreOverlaid() { for (const k in base) bone[k].quaternion.copy(base[k]); }
  function saveOverlaid() { for (const k in base) base[k].copy(bone[k].quaternion); }
  let lastFacing = 0, lastFwd = 0, haveLast = false, headLook = 0;
  let fwdVel = 0, latVel = 0, upVel = 0, yawRate = 0, fwdAcc = 0;

  function overlays(dt, now) {
    const h = Math.min(dt, 1 / 30);
    // Velocity of the root in its own frame, smoothed.
    if (haveLast && dt > 0) {
      _v.copy(root.position).sub(lastPos).divideScalar(dt);
      const s = Math.sin(actor.facing), c = Math.cos(actor.facing);
      const f = _v.x * s + _v.z * c, l = _v.x * c - _v.z * s;
      const k = Math.min(1, dt * 12);
      fwdVel += (clamp(f, -8, 8) - fwdVel) * k; latVel += (clamp(l, -8, 8) - latVel) * k; upVel += (clamp(_v.y, -12, 12) - upVel) * k;
      yawRate += (clamp(wrapAngle(actor.facing - lastFacing) / dt, -12, 12) - yawRate) * k;
      fwdAcc = (fwdVel - lastFwd) / dt;
    }
    lastPos.copy(root.position); lastFacing = actor.facing; lastFwd = fwdVel; haveLast = true;

    // Breathing on the chest, a glance toward where we are turning to.
    const breath = Math.sin(now * 0.0021) * 0.022;
    bone.chest.quaternion.multiply(_q.setFromAxisAngle(X_AXIS, breath));
    bone.neck.quaternion.multiply(_q.setFromAxisAngle(X_AXIS, -breath * 0.6));
    const busy = !!step || actor.dead;
    const want = busy ? 0 : clamp(wrapAngle(actor.facingTarget - actor.facing), -0.6, 0.6) * 0.7 + Math.sin(now * 0.00045) * 0.09;
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
    hat.vx += ((-hat.x) * 140 - hat.vx * 9 - clamp(wx, -30, 30) * 0.9 - fwdAcc * 0.03) * h;
    hat.vz += ((-hat.z) * 140 - hat.vz * 9 - clamp(wz, -30, 30) * 0.9) * h;
    hat.x = clamp(hat.x + hat.vx * h, -0.5, 0.5); hat.z = clamp(hat.z + hat.vz * h, -0.5, 0.5);
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
    const glowWant = step && (step.key === 'fidget' || step.key === 'castLong') ? 1 : 0;
    palmK += (glowWant - palmK) * Math.min(1, dt * 4);
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
    kind: 'mage', root, model, mixer, orb, skeleton, height: 1.97, dead: false,
    ownsDeath: true,   // the arena leaves the fade to us: the body goes to dust (see dissolve)
    deathClipDur: durOf('death'),
    target: null, moving: false, speed: 2.6, facing: 0, facingTarget: 0, airY: 0,
    fidgets: true,   // the idle mage turns a glow over in his hands now and then
    play, oneShot,
    update(dt, now) {
      restoreOverlaid();
      mixer.update(dt);
      saveOverlaid();
      if (step && now >= busyUntil) {
        // Hang in the air until the arena brings us down.
        if (step.air && this.airY > 0.04 && now < busyUntil + 2500) busyUntil = now + 1;
        else if (queue.length) startStep(queue.shift(), now);
        else { step = null; locoKey = null; }
      }
      if (!this.dead && !step) locomotion(now);
      // Turn the short way round toward where we are going or looking.
      let d = this.facingTarget - this.facing;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.facing += d * Math.min(1, dt * 9);
      root.rotation.y = this.facing;
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
    /** A spell: 'shoot' is a quick bolt, 'raise' a big area spell, 'long' a ritual. */
    cast(kind = 'shoot') {
      if (this.dead) return;
      if (kind === 'raise') return run([{ key: 'castRaise', speed: 1.2, fade: 0.14 }]);
      if (kind === 'long') return run([{ key: 'castLong', speed: 1.1, fade: 0.18 }]);
      return run([{ key: 'castShoot', speed: 1.2, fade: 0.08 }]);
    },
    /** Took a hit: 'blow' flinches, 'fire' flails and pats, 'lightning' spasms, 'crush' slams flat. */
    hit(kind = 'blow') {
      if (this.dead) return;
      if (kind === 'fire') return run([{ key: 'hitFire', speed: 1.1, fade: 0.06 }]);
      if (kind === 'lightning') return run([{ key: 'hitLightning', speed: 1.1, fade: 0.04 }]);
      if (kind === 'crush') return run([{ key: 'crush', speed: 1.0, fade: 0.05 }]);
      hitFlip = !hitFlip;
      run([{ key: hitFlip ? 'hitA' : 'hitB', speed: 1.3, fade: 0.06 }]);
    },
    /** Pushed: stumble back a step or two. */
    shove() { if (!this.dead) run([{ key: 'shove', speed: 1.1, fade: 0.08 }]); },
    strike() { if (!this.dead) run([{ key: 'strike', speed: 1.15, fade: 0.1 }]); },
    summon() { if (!this.dead) run([{ key: 'castLong', speed: 1.15, fade: 0.18 }]); },
    /** Hurled into the air for `air` seconds: crouch-and-leap, hang, land. */
    jump(air = 0.95) {
      if (this.dead) return;
      const up = 0.3, land = 0.45;
      run([
        { key: 'jumpStart', speed: durOf('jumpStart') / up, fade: 0.06 },
        { key: 'jumpHang', loop: true, speed: 1, fade: 0.12, dur: Math.max(0.1, air - up - land * 0.4), air: true },
        { key: 'jumpLand', speed: durOf('jumpLand') / land, fade: 0.08 },
      ]);
    },
    /** Thrown off a ledge: flail for `air` seconds, crash on the back, get up. */
    tumble(air = 0.8) {
      if (this.dead) return;
      run([
        { key: 'tumble', loop: true, speed: 1.3, fade: 0.1, dur: Math.max(0.1, air), air: true },
        { key: 'tumbleLand', speed: 1.0, fade: 0.05 },
      ]);
    },
    /** Standing beside a fire: shield the face for a moment. */
    burnOff() { if (!this.dead && !step) run([{ key: 'burnOff', speed: 1.0, fade: 0.15 }]); },
    /** Float, robe swaying, until told to stop. */
    levitate(on = true) {
      if (this.dead) return;
      levitating = !!on;
      if (!on && locoKey === 'levitate') { locoKey = null; }
      if (on) { step = null; queue.length = 0; locoKey = null; }
    },
    cheer() { if (!this.dead) run([{ key: 'cheer', loop: true, reps: 3, speed: 1.1, fade: 0.2 }]); },
    die() {
      this.dead = true; this.moving = false; levitating = false;
      this.setDissolve(0);
      run([{ key: 'death', speed: 1.0, clamp: true, fade: 0.08 }]);
      busyUntil = Infinity;
    },
    /** Back from the dead: get up off the floor, then stand ready. */
    revive() {
      this.dead = false;
      run([{ key: 'standUp', speed: 1.3, fade: 0.25 }]);
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
    dispose() { mixer.stopAllAction(); root.removeFromParent(); orb.geometry.dispose(); halo.geometry.dispose(); palm.geometry.dispose(); mat.body.dispose(); mat.cape.dispose(); mat.depth.dispose(); },
  };
  play('idle', { fade: 0 });
  locoKey = 'idle';
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
