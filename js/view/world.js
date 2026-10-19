// The world around the arena: a real place on land.
//
// The engine's battlefield is a 12m x 9m rectangle of integer heights, and it
// stays exactly that -- every rule is measured inside it. What this file adds
// is everything OUTSIDE it: ground that keeps going to the horizon, hills that
// become ridges, a sky with a sun in it, a forest, rocks, grass, a ruin on a
// far hill, and the ward line that marks where the duel is fought. Nothing here
// is a rule; the engine never hears about any of it.
//
// Inside the ward the ground is the engine's heightfield, sampled exactly. In a
// margin outside it the two are blended, so there is no seam, and past that it
// is the landscape's own.
//
// Art direction: late afternoon, a low warm sun and a cool sky, long shadows,
// heavy materials, nothing cheerful. The arena is a worn fighting pit in a
// clearing; the forest frames it and the ridges close the horizon.

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { heightAt } from '../field/arena.js';
import { pickLod, meshParts } from './assets.js';

const MM = 1 / 1000;

/* ------------------------------------------------------------ noise */

/** Seeded value noise with smooth interpolation, plus a few octaves of it. */
export function makeNoise(seed) {
  const h = (x, y) => {
    let n = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 1013904223;
    n = (n ^ (n >>> 13)) * 1274126177;
    n = (n ^ (n >>> 16)) >>> 0;
    return n / 4294967296;
  };
  const sm = (t) => t * t * (3 - 2 * t);
  const v = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = sm(x - xi), fy = sm(y - yi);
    const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  };
  const fbm = (x, y, oct = 4, lac = 2.1, gain = 0.5) => {
    let s = 0, a = 1, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) { s += v(x * f + i * 13.7, y * f - i * 7.1) * a; norm += a; a *= gain; f *= lac; }
    return s / norm;
  };
  return { v, fbm, h };
}

/** A small seeded stream of 0..1, for scatter. */
function stream(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
}

/* ------------------------------------------------------------ the ground */

/**
 * A height function for the whole landscape, metres in and out.
 *
 * `inside` is the engine's own ground. `margin` metres beyond the ward the
 * engine's edge height is held and the landscape's relief fades in, so the
 * ground leaves the arena at the height it has there and only then starts to
 * roll. Far away the relief grows into ridges.
 */
export function makeLandscape(arena, seed) {
  const W = arena.w * MM, H = arena.h * MM;
  const noise = makeNoise(seed);
  const MARGIN = 7;
  const CLEAR = 1.5;    // a flat apron right outside the ward, where the stones stand

  const arena_lo = (v, lo, hi) => (v < lo ? lo - v : v > hi ? v - hi : 0);
  // Distance outside the arena rectangle (0 inside).
  const outside = (x, z) => {
    const dx = Math.max(arena_lo(x, 0, W), 0), dz = Math.max(arena_lo(z, 0, H), 0);
    return Math.hypot(dx, dz);
  };

  const engineH = (x, z) => heightAt(arena, Math.round(Math.min(Math.max(x, 0), W) / MM), Math.round(Math.min(Math.max(z, 0), H) / MM)) * MM;

  // The landscape's own relief: rolling ground near, ridges far. The clearing
  // itself is a shallow bowl, so the trees stand a little above the fight.
  const relief = (x, z) => {
    const cx = x - W / 2, cz = z - H / 2;
    const d = Math.hypot(cx, cz);
    const roll = (noise.fbm(x * 0.045, z * 0.045, 4) - 0.5) * 2;          // -1..1
    const ridge = Math.pow(noise.fbm(x * 0.018 + 40, z * 0.018 + 9, 5), 1.7);  // 0..1
    const far = Math.max(0, (d - 20) / 34);                                // 0 at 20m, 1 at 54m
    const bowl = Math.min(1, Math.max(0, (d - 9) / 14));                   // the clearing rim
    return roll * (0.8 + far * 2.2) + ridge * far * far * 15 + far * 1.4 + bowl * 0.9;
  };

  const height = (x, z) => {
    const o = outside(x, z);
    if (o <= 0) return engineH(x, z);
    const e = engineH(x, z);
    if (o <= CLEAR) return e;
    const t = Math.min(1, (o - CLEAR) / MARGIN);
    const s = t * t * (3 - 2 * t);
    return e * (1 - s) + (e + relief(x, z)) * s;
  };

  return { W, H, height, engineH, outside, relief, noise };
}

/* The palette, shared by the ground and the grass so they agree. */
const PAL = {
  grassDark: new THREE.Color(0x3f5224),
  grassMid: new THREE.Color(0x5e6f2c),
  grassDry: new THREE.Color(0x8d8a48),
  dirt: new THREE.Color(0x4d4237),
  dirtLight: new THREE.Color(0x7a6848),
  rock: new THREE.Color(0x56534e),
  rockDark: new THREE.Color(0x3a3835),
  wet: new THREE.Color(0x27301f),
  worn: new THREE.Color(0x5e5040),
  ash: new THREE.Color(0x4a443c),
};

/**
 * The colour of the ground at a point. `slope` is 1 - normal.y. Returns the
 * colour and how wet the ground is there (for roughness).
 */
function groundColor(L, arena, x, z, y, slope, out) {
  const n = L.noise;
  const c = out.c;
  const broad = n.fbm(x * 0.08 + 5, z * 0.08 + 2, 3);      // meadows vs dry patches, 6m scale
  const fine = n.fbm(x * 0.5, z * 0.5, 3);                 // 1m breakup
  c.copy(PAL.grassDark).lerp(PAL.grassMid, fine);
  c.lerp(PAL.grassDry, Math.max(0, broad - 0.5) * 0.9);
  let wet = 0;
  const o = L.outside(x, z);
  const median = arena.median * MM;
  if (o <= 0) {
    // The fighting pit: trampled to earth, more so toward the middle, with
    // grass surviving in the corners and along the edge.
    const cx = (x - L.W / 2) / (L.W / 2), cz = (z - L.H / 2) / (L.H / 2);
    const mid = 1 - Math.min(1, Math.hypot(cx, cz));
    const t = Math.min(1, 0.35 + 0.5 * mid + 0.25 * (n.fbm(x * 0.9, z * 0.9, 2) - 0.5));
    c.lerp(PAL.worn, t);
    c.lerp(PAL.dirtLight, Math.max(0, n.fbm(x * 1.6 + 9, z * 1.6, 2) - 0.6) * 1.2);
    if (y < median - 0.2) { const w = Math.min(1, (median - 0.2 - y) / 0.6); c.lerp(PAL.wet, 0.55 * w); wet = w; }
    if (y > median + 0.45) c.lerp(PAL.rock, Math.min(0.45, (y - median - 0.45) * 0.5));
  } else if (o < 1.6) {
    // The apron: a worn path round the ward.
    c.lerp(PAL.worn, 0.35 * (1 - o / 1.6));
  }
  if (slope > 0.18) c.lerp(PAL.dirt, Math.min(1, (slope - 0.18) * 2.6));
  if (slope > 0.42) c.lerp(PAL.rock, Math.min(1, (slope - 0.42) * 2.2));
  if (slope > 0.7) c.lerp(PAL.rockDark, Math.min(1, (slope - 0.7) * 2.0));
  // Wet hollows outside too.
  if (o > 0 && y < -0.6) { const w = Math.min(1, (-0.6 - y) / 1.2); c.lerp(PAL.wet, 0.5 * w); wet = Math.max(wet, w * 0.7); }
  // The slopes beyond the clearing: heath, with ash-grey and dry patches so
  // they are not one green.
  if (o > 6) {
    const heath = n.fbm(x * 0.035 + 17, z * 0.035 + 3, 3);
    const k = Math.min(1, (o - 6) / 10);
    c.lerp(PAL.ash, Math.max(0, heath - 0.46) * 2.2 * k);
    c.lerp(PAL.grassDry, Math.max(0, 0.42 - heath) * 1.4 * k);
    c.lerp(PAL.dirtLight, Math.max(0, n.fbm(x * 0.11 + 2, z * 0.11 + 9, 2) - 0.58) * 1.5 * k);
  }
  // The high ridges are bare stone and scree.
  if (y > 7) c.lerp(PAL.rock, Math.min(1, (y - 7) / 9));
  if (y > 14) c.lerp(PAL.rockDark, Math.min(0.5, (y - 14) / 20));
  c.multiplyScalar(0.9 + 0.2 * n.v(x * 1.9, z * 1.9));
  out.wet = wet;
  return out;
}

/**
 * The terrain mesh: one tensor grid, fine over the arena and its apron, coarse
 * further out and coarser still toward the horizon, with no seams because
 * every row and column runs the whole way.
 */
function buildTerrain(L, arena, { extent = 96, fine = 0.25, mid = 0.75, coarse = 2.0, far = 6.0, fineTo = 2, midTo = 12, farFrom = 36 } = {}) {
  const W = L.W, H = L.H;
  // Four zones out from the ward, symmetric: the ward and its apron sampled
  // at `fine` (the engine's heightfield is bilinear over 0.5m nodes, so this
  // keeps every ramp and cliff edge exact), the blended margin at `mid`, the
  // rolling ground at `coarse`, the ridges at `far`. Every row and column
  // still runs the whole way, so there are no seams, only long triangles.
  const axis = (lo, hi) => {
    const b = [lo - extent, lo - farFrom, lo - midTo, lo - fineTo, hi + fineTo, hi + midTo, hi + farFrom, hi + extent];
    const steps = [far, coarse, mid, fine, mid, coarse, far];
    const xs = [];
    for (let z = 0; z < steps.length; z++) for (let v = b[z]; v < b[z + 1] - 1e-6; v += steps[z]) xs.push(v);
    xs.push(hi + extent);
    return xs;
  };
  const xs = axis(0, W), zs = axis(0, H);
  const nx = xs.length, nz = zs.length;
  const pos = new Float32Array(nx * nz * 3);
  const col = new Float32Array(nx * nz * 3);
  const wetA = new Float32Array(nx * nz);
  const uv = new Float32Array(nx * nz * 2);
  const idx = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const x = xs[i], z = zs[j];
      const y = L.height(x, z);
      pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
      uv[k * 2] = x / 1.6; uv[k * 2 + 1] = z / 1.6;
    }
  }
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, cc = a + nx, d = cc + 1;
      idx.push(a, cc, b, b, cc, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const nrm = geo.attributes.normal;
  const out = { c: new THREE.Color(), wet: 0 };
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const x = xs[i], z = zs[j], y = pos[k * 3 + 1];
      const slope = 1 - nrm.getY(k);
      groundColor(L, arena, x, z, y, slope, out);
      col[k * 3] = out.c.r; col[k * 3 + 1] = out.c.g; col[k * 3 + 2] = out.c.b;
      wetA[k] = out.wet;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('wet', new THREE.BufferAttribute(wetA, 1));
  const tex = groundTexture();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: tex.map, normalMap: tex.normal, normalScale: new THREE.Vector2(0.38, 0.38), roughness: 0.96, metalness: 0 });
  // Two scales of the detail map so nothing visibly tiles, and wet ground is
  // smoother so it catches the low sun.
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float wet;\nvarying float vWet;\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWet = wet;\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNrm = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vWet; varying vec3 vWPos; varying vec3 vWNrm;')
      .replace('#include <map_pars_fragment>', `#include <map_pars_fragment>
        // Two scales of the detail map, so nothing visibly tiles.
        vec3 soil2(vec2 uv) {
          vec3 a = texture2D( map, uv ).rgb;
          vec3 b = texture2D( map, mat2(0.86, -0.5, 0.5, 0.86) * uv * 0.31 ).rgb;
          return a * b * 1.2;
        }`)
      .replace('#include <map_fragment>', `
        #ifdef USE_MAP
          // Triplanar: cliff faces take the texture from the side, not stretched down from above.
          vec3 bw = pow(abs(vWNrm), vec3(5.0)); bw /= (bw.x + bw.y + bw.z);
          vec3 soil = soil2(vWPos.xz / 1.6) * bw.y + soil2(vWPos.zy / 1.6) * bw.x + soil2(vWPos.xy / 1.6) * bw.z;
          diffuseColor.rgb *= soil;
        #endif`)
      .replace('mapN.xy *= normalScale;', 'mapN.xy *= normalScale * clamp(vWNrm.y * 1.6 - 0.45, 0.0, 1.0);')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.45, vWet);');
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.userData.pick = { kind: 'ground' };
  mesh.userData.tris = idx.length / 3;
  return mesh;
}

/**
 * Soil detail: a near-white albedo (so it modulates the vertex colours rather
 * than darkening them) with pebbles, clods and blade strokes, and a tangent
 * normal map built from a noise heightfield. Tiled every 1.6m.
 */
let _groundTex = null;
function groundTexture() {
  if (_groundTex) return _groundTex;
  const S = 1024;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const rnd = stream(777);
  const n = makeNoise(31);
  // Base: soft mottling.
  const img = g.createImageData(S, S);
  const hgt = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S * 8, v = y / S * 8;
      // Tileable by sampling a torus-ish blend of two offsets.
      const a = n.fbm(u, v, 5, 2.0, 0.55), b = n.fbm(u + 8, v, 5, 2.0, 0.55), c = n.fbm(u, v + 8, 5, 2.0, 0.55), d = n.fbm(u + 8, v + 8, 5, 2.0, 0.55);
      const fx = x / S, fy = y / S;
      const hv = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      hgt[y * S + x] = hv;
      const t = 212 + (hv - 0.5) * 90;
      const k = (y * S + x) * 4;
      img.data[k] = t + 8; img.data[k + 1] = t + 4; img.data[k + 2] = t - 6; img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // Clods and pebbles.
  for (let i = 0; i < 6000; i++) {
    const t = 130 + rnd() * 110, r = 1 + rnd() * 3;
    g.fillStyle = `rgba(${t},${t - 6},${t - 14},${0.18 + rnd() * 0.28})`;
    g.beginPath(); g.ellipse(rnd() * S, rnd() * S, r, r * (0.7 + rnd() * 0.3), rnd() * 3.14, 0, 6.3); g.fill();
  }
  // Blade strokes, dark and light.
  for (let i = 0; i < 7000; i++) {
    const x = rnd() * S, y = rnd() * S, l = 6 + rnd() * 14;
    g.strokeStyle = rnd() < 0.5 ? 'rgba(90,100,60,0.22)' : 'rgba(225,235,170,0.22)';
    g.lineWidth = 1 + rnd();
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 8, y - l); g.stroke();
  }
  const map = new THREE.CanvasTexture(cv);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;

  // Normal map from the heightfield plus the pebbles' bumps.
  const nc = document.createElement('canvas');
  nc.width = nc.height = S;
  const ng = nc.getContext('2d');
  const nimg = ng.createImageData(S, S);
  const bump = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) bump[i] = hgt[i] * 2.2;
  for (let i = 0; i < 1100; i++) {
    const cx = rnd() * S, cy = rnd() * S, r = 3 + rnd() * 7, hh = 0.3 + rnd() * 0.5;
    for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      const dd = Math.hypot(x - cx, y - cy) / r; if (dd > 1) continue;
      bump[((y + S) % S) * S + ((x + S) % S)] += Math.sqrt(1 - dd * dd) * hh;
    }
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const l = bump[y * S + (x + S - 1) % S], r = bump[y * S + (x + 1) % S];
      const u = bump[((y + S - 1) % S) * S + x], d = bump[((y + 1) % S) * S + x];
      const dx = (r - l) * 6, dy = (d - u) * 6;
      const len = Math.hypot(dx, dy, 1);
      const k = (y * S + x) * 4;
      nimg.data[k] = (-dx / len * 0.5 + 0.5) * 255; nimg.data[k + 1] = (dy / len * 0.5 + 0.5) * 255; nimg.data[k + 2] = (1 / len * 0.5 + 0.5) * 255; nimg.data[k + 3] = 255;
    }
  }
  ng.putImageData(nimg, 0, 0);
  const normal = new THREE.CanvasTexture(nc);
  normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
  normal.anisotropy = 8;
  _groundTex = { map, normal };
  return _groundTex;
}

/** A speckled stone albedo for the menhirs and whatever else wants rock. */
function stoneTexture() {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const n = makeNoise(77);
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const v = n.fbm(x / S * 6, y / S * 6, 5, 2.2, 0.55);
    const vein = Math.pow(Math.abs(n.fbm(x / S * 3 + 7, y / S * 3, 3) - 0.5) * 2, 0.5);
    const t = 150 + (v - 0.5) * 120 - (1 - vein) * 30;
    const k = (y * S + x) * 4;
    img.data[k] = t + 4; img.data[k + 1] = t; img.data[k + 2] = t - 4; img.data[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const rnd = stream(4242);
  for (let i = 0; i < 2500; i++) {
    const t = 70 + rnd() * 90;
    g.fillStyle = `rgba(${t},${t},${t},${0.3 + rnd() * 0.4})`;
    g.fillRect(rnd() * S, rnd() * S, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ------------------------------------------------------------ grass */

/** Six blades on a card, alpha-cut, dark at the root and pale at the tip. */
function bladeTexture() {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 256;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, 128, 256);
  const rnd = stream(1234);
  const blade = (x0, w, lean, top) => {
    g.beginPath();
    g.moveTo(x0 - w, 256);
    g.quadraticCurveTo(x0 + lean * 0.35 - w * 0.3, 256 - (256 - top) * 0.55, x0 + lean, top);
    g.quadraticCurveTo(x0 + lean * 0.35 + w * 0.3, 256 - (256 - top) * 0.55, x0 + w, 256);
    g.closePath();
    const gr = g.createLinearGradient(0, 256, 0, top);
    gr.addColorStop(0, 'rgba(70,90,40,1)'); gr.addColorStop(0.5, 'rgba(140,160,80,1)'); gr.addColorStop(1, 'rgba(215,220,150,1)');
    g.fillStyle = gr; g.fill();
    // A lighter midrib.
    g.strokeStyle = 'rgba(235,240,190,0.35)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x0, 256); g.quadraticCurveTo(x0 + lean * 0.35, 256 - (256 - top) * 0.55, x0 + lean, top); g.stroke();
  };
  const xs = [64, 22, 104, 42, 86, 10, 118];
  for (const x of xs) blade(x, 3.5 + rnd() * 2.5, (rnd() - 0.5) * 36, 10 + rnd() * 70);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * Grass as instanced blade cards (three, crossed at 60 degrees), swaying in the
 * vertex shader, shaded darker at the root. Dense near the arena, thinning
 * with distance, never on steep ground or in the spawn circles, thinned where
 * the fight is.
 */
function buildGrass(L, arena, seed, count) {
  // One segment per card: the sway shears the tips, which at the game
  // camera's distance reads the same as a bend for a third of the triangles.
  const geo = new THREE.PlaneGeometry(0.62, 0.55, 1, 1);
  geo.translate(0, 0.275, 0);
  const g2 = geo.clone().rotateY(Math.PI / 3);
  const g3 = geo.clone().rotateY(-Math.PI / 3);
  const merged = mergeGeos([geo, g2, g3]);
  const mat = new THREE.MeshStandardMaterial({ map: bladeTexture(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9, metalness: 0, vertexColors: true });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = { value: 0 };
    mat.userData.sh = sh;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <color_vertex>', '#include <color_vertex>\nvColor *= (0.55 + 0.55 * uv.y);')
      .replace('#include <begin_vertex>', `
        vec3 transformed = vec3(position);
        vec4 wp = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float gust = sin(uTime * 0.55 + wp.x * 0.12 - wp.z * 0.09) * 0.5 + 0.5;
        float sway = sin(uTime * 1.7 + wp.x * 0.9 + wp.z * 1.3) * 0.6 + sin(uTime * 2.9 + wp.z * 2.1 + wp.x * 0.4) * 0.25;
        float a = uv.y * uv.y * (0.07 + 0.11 * gust);
        transformed.x += sway * a + 0.05 * gust * uv.y;
        transformed.z += cos(uTime * 1.3 + wp.x * 1.7 + wp.z * 0.6) * a * 0.6;`);
  };
  // The grass normal points up, so the blades take the ground's light rather
  // than flipping dark on their back faces.
  const nrm = merged.attributes.normal;
  for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
  const inst = new THREE.InstancedMesh(merged, mat, count);
  const noise = L.noise;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const col = new Float32Array(count * 3);
  const c = new THREE.Color();
  const rnd = stream(seed ^ 0x9e3779b9);
  let n = 0;
  const W = L.W, H = L.H;
  const out = { c: new THREE.Color(), wet: 0 };
  for (let tries = 0; tries < count * 6 && n < count; tries++) {
    // Radial falloff around the arena centre: dense round the ward, thinning
    // with distance, none past the clearing where a blade is a pixel.
    const ang = rnd() * Math.PI * 2;
    const r = Math.pow(rnd(), 0.95) * 26;
    const x = W / 2 + Math.cos(ang) * r * 1.2, z = H / 2 + Math.sin(ang) * r;
    const o = L.outside(x, z);
    if (o > 18) continue;
    if (o > 8 && rnd() < (o - 8) / 12) continue;
    const y = L.height(x, z);
    const slope = Math.abs(L.height(x + 0.3, z) - L.height(x - 0.3, z)) + Math.abs(L.height(x, z + 0.3) - L.height(x, z - 0.3));
    if (slope > 0.42) continue;
    if (arena.spawns.some((sp) => Math.hypot(x - sp.x * MM, z - sp.y * MM) < sp.r * MM + 0.5)) continue;
    const inside = o <= 0;
    // Nothing over the ward line itself: the groove stays visible.
    const edge = inside ? Math.min(x, W - x, z, H - z) : o;
    if (edge < 0.45) continue;
    if (inside) {
      // Trampled: the middle is bare, the corners and edge keep a little.
      const cx = (x - W / 2) / (W / 2), cz = (z - H / 2) / (H / 2);
      const mid = 1 - Math.min(1, Math.hypot(cx, cz));
      if (rnd() < 0.55 + 0.42 * mid) continue;
      if (y < arena.median * MM - 0.2 && rnd() < 0.6) continue;
    } else if (o < 1.4 && rnd() < 0.5) continue;   // the path round the ward
    if (noise.fbm(x * 0.2, z * 0.2, 2) < 0.4 && rnd() < 0.55) continue;  // bare patches
    const h = (0.55 + rnd() * 0.75) * (inside ? 0.7 : 1);
    p.set(x, y - 0.02, z);
    q.setFromAxisAngle(up, rnd() * Math.PI);
    sc.set(0.8 + rnd() * 0.5, h, 0.8 + rnd() * 0.5);
    m.compose(p, q, sc);
    inst.setMatrixAt(n, m);
    groundColor(L, arena, x, z, y, 0, out);
    // The blades: the ground's hue, a touch brighter and greener, varied per clump.
    c.copy(out.c).multiplyScalar(1.25);
    c.offsetHSL((rnd() - 0.5) * 0.03, 0.08, 0.02 + rnd() * 0.06);
    col[n * 3] = c.r; col[n * 3 + 1] = c.g; col[n * 3 + 2] = c.b;
    n++;
  }
  inst.count = n;
  inst.instanceMatrix.needsUpdate = true;
  merged.setAttribute('color', new THREE.InstancedBufferAttribute(col, 3));
  inst.receiveShadow = true;
  inst.castShadow = false;
  inst.frustumCulled = false;
  inst.userData.tris = n * merged.index.count / 3;
  return inst;
}

function mergeGeos(geos) {
  const pos = [], uv = [], nrm = [], idx = [];
  let off = 0;
  for (const g of geos) {
    const p = g.attributes.position, u = g.attributes.uv, nn = g.attributes.normal, ix = g.index;
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); uv.push(u.getX(i), u.getY(i)); nrm.push(nn.getX(i), nn.getY(i), nn.getZ(i)); }
    for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + off);
    off += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setIndex(idx);
  return out;
}

/* ------------------------------------------------------------ forest and rocks */

/**
 * Trees, bushes and boulders scattered over the landscape, never inside the
 * ward or its clearing, clustered by noise so there are glades and thickets.
 * Instanced per sub-mesh of the chosen LOD, so a hundred trees are a handful
 * of draw calls: full detail for the ring of trees that frames the arena,
 * LOD1 beyond, LOD2 on the ridges.
 *
 * The HIGHGROUND bakes are authored at full size (an alder is 13m tall and
 * 12m across), so they are scaled down to a believable 6-10m and kept well
 * back from the ward, or the canopy would roof the fight.
 */
function buildForest(L, arena, seed, gltfs, { trees = 140, bushes = 90, rocks = 50, quality = 'high' } = {}) {
  const group = new THREE.Group();
  const noise = L.noise;
  const rnd = stream(seed ^ 0x5bd1e995);
  const W = L.W, H = L.H;
  let tris = 0;

  const place = (count, minOut, maxR, gap, test) => {
    const out = [];
    for (let tries = 0; tries < count * 10 && out.length < count; tries++) {
      const ang = rnd() * Math.PI * 2;
      const r = minOut + Math.pow(rnd(), 0.85) * maxR;
      const x = W / 2 + Math.cos(ang) * r * 1.15, z = H / 2 + Math.sin(ang) * r;
      const o = L.outside(x, z);
      if (o < minOut) continue;
      const slope = Math.abs(L.height(x + 0.5, z) - L.height(x - 0.5, z)) + Math.abs(L.height(x, z + 0.5) - L.height(x, z - 0.5));
      if (slope > 1.2) continue;
      if (!test(x, z, o)) continue;
      if (out.some((p) => Math.hypot(p.x - x, p.z - z) < gap)) continue;
      out.push({ x, z, y: L.height(x, z), o, rot: rnd() * Math.PI * 2, scale: 1 });
    }
    return out;
  };

  // A home camera sits behind EACH short end (x<0 for seat 0, x>W for seat
  // 1), ~10m up, looking across the middle of the arena: both those sides get
  // a deeper clearing, and nothing taller than knee height stands in the
  // corridor either camera looks down. The long sides keep the close ring.
  const corridor = (x, z) => (x < 0 || x > W) && Math.abs(z - H / 2) < 2.4;
  const clearance = (x, z, o) => o >= ((x < 0 || x > W) ? 9 : 6) && !(corridor(x, z) && o < 14);
  // Trees: clustered by noise so there are stands and glades, not a wall;
  // denser out on the slopes, sparse on the ridges (and half as many out
  // there: at that range in the haze a stand reads as a stand with half the
  // trunks).
  const treeSpots = place(trees, 6, 72, 4.6, (x, z, o) =>
    clearance(x, z, o) && (o < 42 || rnd() < 0.5) && (noise.fbm(x * 0.07 + 3, z * 0.07 + 7, 3) > 0.5 || rnd() < 0.05));
  for (const t of treeSpots) t.scale = 0.45 + rnd() * 0.35;
  // Dead trees: a few, never on the far ridges where their bare cards read as shards.
  const dead = treeSpots.filter((t) => t.o < 40 && noise.v(t.x * 0.3, t.z * 0.3) > 0.8);
  const live = treeSpots.filter((t) => !dead.includes(t));
  const bushSpots = place(bushes, 2.6, 45, 1.6, (x, z, o) => !corridor(x, z) && (noise.fbm(x * 0.09, z * 0.09, 3) > 0.42 || rnd() < 0.15));
  for (const b of bushSpots) b.scale = 0.28 + rnd() * 0.3;
  const rockSpots = place(rocks, 2.2, 50, 1.2, (x, z, o) => (o < 6 ? rnd() < 0.6 : noise.fbm(x * 0.12 + 11, z * 0.12 + 4, 2) > 0.45) && !(corridor(x, z) && o < 14));
  for (const r of rockSpots) r.scale = 0.3 + Math.pow(rnd(), 1.8) * 0.9;

  // Past 30m a tree is its canopy: the leaf cards of LOD2 over a six-sided
  // trunk made here (12 triangles) instead of the bake's 600-triangle one.
  const farTrunk = { geometry: new THREE.CylinderGeometry(0.28, 0.55, 4.6, 6, 1, false).translate(0, 2.3, 0), material: new THREE.MeshStandardMaterial({ color: 0x3e3127, roughness: 1 }), matrix: new THREE.Matrix4() };
  const instance = (gltf, lod, spots, { sink = 0.05, shadow = true, kind = 'tree', tint = null, canopyOnly = false } = {}) => {
    if (!spots.length) return;
    let parts = meshParts(pickLod(gltf, lod));
    if (canopyOnly) parts = [...parts.filter((p) => /leaves|cards/.test(p.material.name)), farTrunk];
    if (tint) for (const part of parts) { part.material = part.material.clone(); part.material.color.multiplyScalar(tint); part.material.roughness = 1; }
    const m = new THREE.Matrix4(), base = new THREE.Matrix4(), s = new THREE.Vector3();
    for (const part of parts) {
      const inst = new THREE.InstancedMesh(part.geometry, part.material, spots.length);
      spots.forEach((sp, i) => {
        base.makeRotationY(sp.rot).scale(s.set(sp.scale, sp.scale, sp.scale)).setPosition(sp.x, sp.y - sink * sp.scale, sp.z);
        if (sp.tilt) base.multiply(new THREE.Matrix4().makeRotationX(sp.tilt));
        m.multiplyMatrices(base, part.matrix);
        inst.setMatrixAt(i, m);
      });
      inst.instanceMatrix.needsUpdate = true;
      // Bounds from the instances (not the bake at the origin), so the
      // renderer and the shadow pass can cull a stand that is out of frame
      // without ever dropping one that is in it.
      inst.computeBoundingSphere();
      inst.castShadow = shadow;
      inst.receiveShadow = true;
      inst.userData.kind = kind;
      inst.userData.lod = lod;
      tris += (part.geometry.index ? part.geometry.index.count : part.geometry.attributes.position.count) / 3 * spots.length;
      group.add(inst);
    }
  };
  // Levels of detail by distance from the ward. The nearest tree is 6-9m off
  // the ward, 15-20m from a home camera: LOD1 (2.5k triangles) reads the same
  // there as LOD0 (8.5k) did, so LOD0 is never used; everything past the
  // ring is LOD2. Only the ring casts shadows: the shadow map is cropped to
  // the ward and its apron, so nothing further could land a shadow in it.
  const farFrom = quality === 'low' ? 15 : 30;
  const near = (t) => t.o < 15, mid = (t) => t.o >= 15 && t.o < farFrom, farr = (t) => t.o >= farFrom;
  const lodNear = quality === 'low' ? 2 : 1;
  instance(gltfs.alder, lodNear, live.filter(near));
  instance(gltfs.alder, 2, live.filter(mid), { shadow: false });
  instance(gltfs.alder, 2, live.filter(farr), { shadow: false, canopyOnly: true });
  // Dead trees (a handful), bushes and rocks: one group each, one level of
  // detail, so each is one draw call. The bushes and rocks are small enough
  // that LOD2 reads the same at 15m as at 60m; the dead trees are their
  // branches, so they keep LOD1.
  instance(gltfs.deadTree, 1, dead, { tint: 0.5 });
  // Bushes cast no shadow: knee-high, 3m+ off the ward, their shadows are
  // under themselves; the rocks' are not, so the rocks do.
  instance(gltfs.bush, 2, bushSpots, { kind: 'bush', shadow: false });
  // Rocks: the three boulders by turns, sunk into the ground and tilted.
  const bs = [gltfs.boulderA, gltfs.boulderB, gltfs.boulderC].filter(Boolean);
  if (bs.length) {
    for (const r of rockSpots) r.tilt = (rnd() - 0.5) * 0.5;
    bs.forEach((b, i) => instance(b, 2, rockSpots.filter((_, k) => k % bs.length === i), { sink: 0.3, kind: 'rock', tint: 0.62 }));
  }
  group.userData.tris = tris;
  group.userData.counts = { near: live.filter(near).length, mid: live.filter(mid).length, far: live.filter(farr).length, dead: dead.length, bushes: bushSpots.length, rocks: rockSpots.length };
  group.userData.spots = { trees: treeSpots, bushes: bushSpots, rocks: rockSpots };
  return group;
}

/**
 * A ruin on a far hill: a broken ring of standing stones, some fallen, on the
 * highest ground 26-40m from the arena, and a couple of lone stones nearer.
 * It says the ward is one of many, and the place is old.
 */
function buildRuins(L, seed, stoneMat) {
  const g = new THREE.Group();
  const rnd = stream(seed ^ 0x27d4eb2f);
  const W = L.W, H = L.H;
  let best = null;
  for (let i = 0; i < 48; i++) {
    const ang = i / 48 * Math.PI * 2;
    for (const r of [26, 31, 36, 41]) {
      const x = W / 2 + Math.cos(ang) * r * 1.15, z = H / 2 + Math.sin(ang) * r;
      const y = L.height(x, z);
      const flat = Math.abs(L.height(x + 3, z) - L.height(x - 3, z)) + Math.abs(L.height(x, z + 3) - L.height(x, z - 3));
      const score = y - flat * 1.5;
      if (!best || score > best.score) best = { x, z, y, score };
    }
  }
  // Every stone goes into ONE geometry: they share the granite, and the ruin
  // is one draw call (plus one in the shadow pass) instead of sixteen.
  const geos = [];
  const R = 4.2, n = 9;
  for (let i = 0; i < n; i++) {
    if (rnd() < 0.2) continue;                       // a gap in the ring
    const a = i / n * Math.PI * 2;
    const x = best.x + Math.cos(a) * R, z = best.z + Math.sin(a) * R;
    const h = 2.2 + rnd() * 1.6, r = 0.3 + rnd() * 0.15;
    const st = menhir(h, r, stoneMat, 100 + i * 7 + (seed & 255));
    st.position.set(x, L.height(x, z) - 0.15, z);
    st.rotation.y = a + Math.PI / 2;
    if (rnd() < 0.3) { st.rotation.z = (rnd() < 0.5 ? 1 : -1) * (1.25 + rnd() * 0.3); st.position.y += 0.15; }   // fallen
    else st.rotation.z = (rnd() - 0.5) * 0.16;
    geos.push(bakeTransform(st));
  }
  // Two lintels' worth of rubble at the centre.
  for (let i = 0; i < 4; i++) {
    const st = menhir(1.2 + rnd() * 0.8, 0.28, stoneMat, 300 + i);
    st.position.set(best.x + (rnd() - 0.5) * 2.5, best.y - 0.1, best.z + (rnd() - 0.5) * 2.5);
    st.rotation.set(1.45 + (rnd() - 0.5) * 0.3, rnd() * 6.28, 0);
    geos.push(bakeTransform(st));
  }
  // Lone stones nearer in, leaning, like markers on an old road.
  for (let i = 0; i < 3; i++) {
    const a = rnd() * Math.PI * 2, r = 12 + rnd() * 10;
    const x = W / 2 + Math.cos(a) * r * 1.15, z = H / 2 + Math.sin(a) * r;
    if (L.outside(x, z) < 5 || Math.abs(z - H / 2) < 2.6) continue;   // never in either camera's corridor
    const st = menhir(1.6 + rnd() * 1.2, 0.26, stoneMat, 400 + i);
    st.position.set(x, L.height(x, z) - 0.15, z);
    st.rotation.set(0, rnd() * 6.28, (rnd() - 0.5) * 0.3);
    geos.push(bakeTransform(st));
  }
  const m = new THREE.Mesh(mergeGeometries(geos), stoneMat);
  m.castShadow = true; m.receiveShadow = true;
  g.add(m);
  g.userData.at = best;
  return g;
}

/** A mesh's geometry with its local transform (and its parent chain's) baked in, for merging. */
function bakeTransform(mesh, parent = null) {
  mesh.updateMatrix();
  const m = parent ? parent.matrix.clone().multiply(mesh.matrix) : mesh.matrix;
  return mesh.geometry.applyMatrix4(m);
}

/* ------------------------------------------------------------ the ward */

/** A strip of runes, repeating along the ward line. */
function runeTexture() {
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 64;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, 1024, 64);
  const rnd = stream(555);
  g.strokeStyle = '#fff'; g.lineWidth = 9; g.lineCap = 'round';
  // A continuous thread, and a rune every 48px cut across it.
  g.beginPath(); g.moveTo(0, 32); g.lineTo(1024, 32); g.stroke();
  for (let x = 24; x < 1024; x += 48) {
    const k = Math.floor(rnd() * 6);
    g.lineWidth = 5;
    g.beginPath();
    if (k === 0) { g.moveTo(x - 8, 14); g.lineTo(x + 8, 50); g.moveTo(x + 8, 14); g.lineTo(x - 8, 50); }
    else if (k === 1) { g.moveTo(x, 12); g.lineTo(x, 52); g.moveTo(x - 9, 24); g.lineTo(x, 12); g.lineTo(x + 9, 24); }
    else if (k === 2) { g.moveTo(x - 9, 18); g.lineTo(x + 9, 18); g.lineTo(x, 50); g.closePath(); }
    else if (k === 3) { g.moveTo(x, 12); g.lineTo(x, 52); g.moveTo(x - 10, 40); g.lineTo(x + 10, 24); }
    else if (k === 4) { g.arc(x, 32, 12, 0, Math.PI * 2); g.moveTo(x, 20); g.lineTo(x, 44); }
    else { g.moveTo(x - 10, 50); g.lineTo(x, 12); g.lineTo(x + 10, 50); g.moveTo(x - 5, 34); g.lineTo(x + 5, 34); }
    g.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A soft glyph for the face of a standing stone. */
function stoneRuneTexture(k) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, 128, 128);
  g.strokeStyle = '#fff'; g.lineWidth = 7; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath();
  const forms = [
    () => { g.moveTo(64, 14); g.lineTo(64, 114); g.moveTo(34, 44); g.lineTo(64, 14); g.lineTo(94, 44); g.moveTo(40, 90); g.lineTo(88, 70); },
    () => { g.moveTo(30, 110); g.lineTo(64, 16); g.lineTo(98, 110); g.moveTo(44, 72); g.lineTo(84, 72); },
    () => { g.moveTo(40, 20); g.lineTo(88, 108); g.moveTo(88, 20); g.lineTo(40, 108); g.moveTo(64, 14); g.lineTo(64, 114); },
    () => { g.arc(64, 64, 38, 0, Math.PI * 2); g.moveTo(64, 26); g.lineTo(64, 102); g.moveTo(30, 64); g.lineTo(98, 64); },
    () => { g.moveTo(34, 18); g.lineTo(34, 110); g.moveTo(34, 40); g.lineTo(94, 18); g.moveTo(34, 80); g.lineTo(94, 102); },
    () => { g.moveTo(64, 14); g.lineTo(64, 114); g.moveTo(36, 50); g.lineTo(92, 50); g.moveTo(44, 84); g.lineTo(84, 84); },
    () => { g.moveTo(28, 100); g.lineTo(64, 24); g.lineTo(100, 100); g.closePath(); g.moveTo(64, 24); g.lineTo(64, 100); },
    () => { g.moveTo(40, 18); g.lineTo(40, 110); g.lineTo(90, 110); g.moveTo(40, 64); g.lineTo(84, 40); },
  ];
  forms[k % forms.length]();
  g.stroke();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * The ward line: a dark groove cut round the arena with a thread of runes
 * glowing in it and a soft halo over it, lifted to the ground along its
 * length, with standing stones at the corners and the midpoints. This is the
 * only thing that says "the duel is fought here", so it is bright but thin:
 * the gameplay rings drawn over it must still win.
 */
function buildWard(L, arena, stoneMat) {
  const g = new THREE.Group();
  const W = L.W, H = L.H;
  const edges = [[0, 0, W, 0], [W, 0, W, H], [W, H, 0, H], [0, H, 0, 0]];

  /** A strip along an edge, `w` wide, `lift` above the ground, with uv.x in metres / `rep`. */
  const strip = (w, lift, rep, mat) => {
    const v = [], uv = [], idx = [];
    let base = 0;
    for (const [ax, az, bx, bz] of edges) {
      const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz), nx = -dz / len * w, nz = dx / len * w;
      const seg = Math.ceil(len / 0.25);
      for (let i = 0; i <= seg; i++) {
        const t = i / seg, x = ax + dx * t, z = az + dz * t;
        const y = Math.max(L.height(x + nx, z + nz), L.height(x - nx, z - nz), L.height(x, z)) + lift;
        v.push(x + nx, y, z + nz, x - nx, y, z - nz);
        uv.push(len * t / rep, 0, len * t / rep, 1);
        if (i) idx.push(base + 2 * i - 2, base + 2 * i - 1, base + 2 * i, base + 2 * i - 1, base + 2 * i + 1, base + 2 * i);
      }
      base += (seg + 1) * 2;
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    bg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    bg.setIndex(idx);
    bg.computeVertexNormals();
    const mesh = new THREE.Mesh(bg, mat);
    mesh.renderOrder = 1;
    return mesh;
  };

  // The groove: dark, slightly glossy, as if cut into stone under the turf.
  const grooveMat = new THREE.MeshStandardMaterial({ color: 0x17130f, roughness: 0.55, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  g.add(strip(0.17, 0.012, 1, grooveMat));
  // The thread of runes: an unlit, over-white ribbon so bloom catches it.
  const runeTex = runeTexture();
  const runeMat = new THREE.MeshBasicMaterial({ map: runeTex, alphaMap: runeTex, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
  runeMat.color.setRGB(1.5, 0.95, 0.42);
  const runes = strip(0.085, 0.03, 2.6, runeMat);
  runes.renderOrder = 2;
  g.add(runes);
  // The halo: a wide, faint additive band that pulses.
  const haloMat = new THREE.MeshBasicMaterial({ color: 0xff9a3c, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, map: haloTexture() });
  const halo = strip(0.6, 0.02, 1, haloMat);
  halo.renderOrder = 2;
  g.add(halo);
  g.userData.band = haloMat;
  g.userData.runes = runeMat;

  // Standing stones: tapered, leaning in, a rune glowing on the face that
  // looks at the fight, and a warm light at the foot of each.
  // The short sides get a PAIR of stones flanking the midpoint, a gateway the
  // home camera looks through, rather than one stone on its axis.
  // All ten stones are one mesh, their rune faces one mesh over one atlas,
  // the scorch patches one, the foot-glow one: four draw calls, not forty.
  // The foot-light used to be a point light each; a warm additive pool on
  // the ground under the stone gives the same glow for free.
  const stones = [[0, 0], [W, 0], [W, H], [0, H], [W / 2, 0], [W / 2, H], [0, H / 2 - 2.2], [0, H / 2 + 2.2], [W, H / 2 - 2.2], [W, H / 2 + 2.2]];
  const stoneGeos = [], runeGeos = [], scorchGeos = [], glowGeos = [];
  const atlas = stoneRuneAtlas();
  stones.forEach(([x, z], i) => {
    const big = i < 4;
    const h = big ? 2.7 : 1.9, r = big ? 0.34 : 0.25;
    const dx = x <= 0 ? -1 : x >= W ? 1 : 0, dz = z <= 0 ? -1 : z >= H ? 1 : 0;
    const sx = x + dx * 0.9, sz = z + dz * 0.9;
    const stone = menhir(h, r, stoneMat, i * 17 + 3);
    stone.position.set(sx, L.height(sx, sz) - 0.12, sz);
    stone.rotation.y = Math.atan2(W / 2 - sx, H / 2 - sz);
    stone.rotation.z = (i % 2 ? 1 : -1) * 0.05;
    stone.rotation.x = 0.04;
    stone.updateMatrix();
    const rune = new THREE.Mesh(new THREE.PlaneGeometry(r * 1.3, r * 1.3));
    rune.position.set(0, h * 0.62, r * 0.88);
    // This stone's glyph: one cell of the atlas.
    const uv = rune.geometry.attributes.uv, cell = i % atlas.cells;
    for (let k = 0; k < uv.count; k++) uv.setX(k, (cell + uv.getX(k)) / atlas.cells);
    runeGeos.push(bakeTransform(rune, stone));
    stoneGeos.push(bakeTransform(stone));
    // A patch of scorched ground under it, and the pool of warm light.
    const y0 = L.height(sx, sz);
    const scorch = new THREE.Mesh(new THREE.CircleGeometry(r * 2.6, 14));
    scorch.rotation.x = -Math.PI / 2;
    scorch.position.set(sx, y0 + 0.015, sz);
    scorchGeos.push(bakeTransform(scorch));
    const glow = new THREE.Mesh(new THREE.CircleGeometry(big ? 2.2 : 1.6, 16));
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(sx + dx * 0.15, y0 + 0.025, sz + dz * 0.15);
    glowGeos.push(bakeTransform(glow));
  });
  const stoneMesh = new THREE.Mesh(mergeGeometries(stoneGeos), stoneMat);
  stoneMesh.castShadow = true; stoneMesh.receiveShadow = true;
  g.add(stoneMesh);
  const runeFaceMat = new THREE.MeshBasicMaterial({ map: atlas.tex, alphaMap: atlas.tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  runeFaceMat.color.setRGB(1.3, 0.85, 0.4);
  const runeMesh = new THREE.Mesh(mergeGeometries(runeGeos), runeFaceMat);
  runeMesh.renderOrder = 2;
  g.add(runeMesh);
  const scorchMesh = new THREE.Mesh(mergeGeometries(scorchGeos), new THREE.MeshBasicMaterial({ color: 0x0a0806, transparent: true, opacity: 0.5, depthWrite: false, map: scorchTexture() }));
  scorchMesh.renderOrder = 1;
  g.add(scorchMesh);
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xff9a40, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending, map: scorchTexture() });
  const glowMesh = new THREE.Mesh(mergeGeometries(glowGeos), glowMat);
  glowMesh.renderOrder = 2;
  g.add(glowMesh);
  g.userData.footGlow = glowMat;
  g.userData.stones = stones.length;
  return g;
}

/** The ten stones' glyphs side by side in one strip, so their faces share one material. */
let _runeAtlas = null;
function stoneRuneAtlas() {
  if (_runeAtlas) return _runeAtlas;
  const cells = 8;
  const cv = document.createElement('canvas');
  cv.width = 128 * cells; cv.height = 128;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, 128);
  for (let k = 0; k < cells; k++) g.drawImage(stoneRuneTexture(k).image, k * 128, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  _runeAtlas = { tex, cells };
  return _runeAtlas;
}

let _halo = null;
function haloTexture() {
  if (_halo) return _halo;
  const cv = document.createElement('canvas');
  cv.width = 4; cv.height = 64;
  const g = cv.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 64);
  gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.5, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 4, 64);
  _halo = new THREE.CanvasTexture(cv);
  _halo.wrapS = THREE.RepeatWrapping;
  return _halo;
}

let _scorch = null;
function scorchTexture() {
  if (_scorch) return _scorch;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 4, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.6, 'rgba(255,255,255,0.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  _scorch = new THREE.CanvasTexture(cv);
  return _scorch;
}

/** A standing stone: a jittered tapered prism with cylindrical UVs. */
export function menhir(h, r, mat, seed = 1) {
  const geo = new THREE.CylinderGeometry(r * 0.72, r, h, 7, 4);
  geo.translate(0, h / 2, 0);
  const p = geo.attributes.position;
  const rnd = stream(seed);
  const key = new Map();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(2)},${p.getY(i).toFixed(2)},${p.getZ(i).toFixed(2)}`;
    if (!key.has(k)) key.set(k, [(rnd() - 0.5) * r * 0.5, (rnd() - 0.5) * h * 0.05, (rnd() - 0.5) * r * 0.5]);
    const [dx, dy, dz] = key.get(k);
    if (p.getY(i) > 0.01) p.setXYZ(i, p.getX(i) + dx, p.getY(i) + dy, p.getZ(i) + dz);
  }
  // Scale the UVs so the stone texture reads at the same grain on every size.
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * r * 6, uv.getY(i) * h * 0.9);
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

/* ------------------------------------------------------------ sky */

function buildSky(scene, renderer, sunDir) {
  const sky = new Sky();
  sky.scale.setScalar(4000);
  // The preetham sky comes out far brighter than the lit ground at this
  // exposure; scale it down so the horizon is haze, not white.
  sky.material.fragmentShader = sky.material.fragmentShader.replace('gl_FragColor = vec4( retColor, 1.0 );', 'gl_FragColor = vec4( retColor * 0.42, 1.0 );');
  sky.material.needsUpdate = true;
  const u = sky.material.uniforms;
  u.turbidity.value = 3.6;
  u.rayleigh.value = 1.3;
  u.mieCoefficient.value = 0.003;
  u.mieDirectionalG.value = 0.8;
  u.sunPosition.value.copy(sunDir);
  scene.add(sky);
  // Environment light from the sky itself, so metal and glass have something to reflect.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(sky.clone());
  const env = pmrem.fromScene(envScene, 0.04).texture;
  scene.environment = env;
  scene.environmentIntensity = 0.3;
  pmrem.dispose();
  return sky;
}

/** Clouds: a few soft puffs with flat bellies, lit from the sun's side. */
function cloudTexture(seed) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 192;
  const g = cv.getContext('2d');
  const rnd = stream(seed);
  const puffs = [];
  const cx = 256, baseY = 130;
  for (let i = 0; i < 30; i++) {
    const x = cx + (rnd() - 0.5) * 300, r = 22 + rnd() * 48;
    const y = baseY - rnd() * 60 * (1 - Math.abs(x - cx) / 200);
    puffs.push({ x, y: Math.min(y, baseY), r });
  }
  // Shadowed body, then lit tops.
  for (const p of puffs) {
    const gr = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
    gr.addColorStop(0, 'rgba(205,195,190,0.55)'); gr.addColorStop(0.7, 'rgba(205,195,190,0.25)'); gr.addColorStop(1, 'rgba(205,195,190,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 512, 192);
  }
  for (const p of puffs) {
    const gr = g.createRadialGradient(p.x - p.r * 0.25, p.y - p.r * 0.35, 0, p.x - p.r * 0.2, p.y - p.r * 0.25, p.r * 0.8);
    gr.addColorStop(0, 'rgba(255,245,235,0.6)'); gr.addColorStop(0.6, 'rgba(255,245,235,0.2)'); gr.addColorStop(1, 'rgba(255,245,235,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 512, 192);
  }
  // Flat belly.
  g.globalCompositeOperation = 'destination-out';
  const fade = g.createLinearGradient(0, baseY + 10, 0, 192);
  fade.addColorStop(0, 'rgba(0,0,0,0)'); fade.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = fade; g.fillRect(0, baseY + 10, 512, 192 - baseY - 10);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ------------------------------------------------------------ build */

export function buildWorld(scene, renderer, arena, seed, gltfs, { quality = 'high' } = {}) {
  const L = makeLandscape(arena, seed);
  const W = L.W, H = L.H;
  const q = quality === 'low' ? 0.3 : quality === 'medium' ? 0.6 : 1;

  // Late afternoon: a low, warm sun from the south-west, long shadows that
  // fall away from the home camera so it sees the lit faces.
  const sunDir = new THREE.Vector3(-0.58, 0.47, -0.60).normalize();
  const sky = buildSky(scene, renderer, sunDir);
  // Fog the colour of the horizon haze, so the ridges fade into the sky.
  scene.fog = new THREE.Fog(0xb4b2ab, 30, 150);

  const sun = new THREE.DirectionalLight(0xffdcb0, 4.7);
  sun.position.copy(sunDir).multiplyScalar(70).add(new THREE.Vector3(W / 2, 0, H / 2));
  sun.target.position.set(W / 2, 0, H / 2);
  sun.castShadow = true;
  const sm = quality === 'low' ? 1024 : quality === 'medium' ? 1024 : 2048;
  sun.shadow.mapSize.set(sm, sm);
  // Cropped to the ward and its apron: that is where the fight is and where
  // the shadows are looked at. The ring of trees that shade it still casts
  // into it (the shadow camera's depth covers them); nothing past the ring
  // casts at all, so the shadow pass draws a few thousand triangles, not the
  // whole forest again.
  const sx = quality === 'low' ? Math.max(W, H) * 0.6 : Math.max(W, H) * 0.5 + 6;
  Object.assign(sun.shadow.camera, { left: -sx, right: sx, top: sx * 0.85, bottom: -sx * 0.85, near: 20, far: 140 });
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.025;
  sun.shadow.radius = quality === 'high' ? 3 : 2;
  scene.add(sun, sun.target);
  // Cool sky fill from above, warm bounce from the ground.
  const hemi = new THREE.HemisphereLight(0x8fa8d8, 0x5a4a34, 1.05);
  scene.add(hemi);
  scene.add(new THREE.AmbientLight(0x4a4a52, 0.25));

  const terrain = buildTerrain(L, arena, quality === 'low'
    ? { fine: 0.5, mid: 1.5, coarse: 3, far: 8 }
    : quality === 'medium' ? { fine: 0.25, mid: 1.0, coarse: 2.5, far: 8 } : { fine: 0.25, mid: 0.75, coarse: 2, far: 6 });
  scene.add(terrain);

  const grass = buildGrass(L, arena, seed, quality === 'low' ? 1800 : quality === 'medium' ? 5000 : 8500);
  scene.add(grass);

  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x8c8780, map: stoneTexture(), roughness: 0.86, metalness: 0.02, flatShading: true });
  const ward = buildWard(L, arena, stoneMat);
  scene.add(ward);

  const forest = buildForest(L, arena, seed, gltfs, { trees: Math.round(150 * q), bushes: Math.round(110 * q), rocks: Math.round(55 * q), quality });
  scene.add(forest);

  const ruins = buildRuins(L, seed, stoneMat);
  scene.add(ruins);

  const clouds = buildClouds(W, H, seed);
  scene.add(clouds);

  const stats = () => ({ terrain: terrain.userData.tris, grass: grass.userData.tris, forest: forest.userData.tris, counts: forest.userData.counts });

  return {
    L, terrain, grass, ward, forest, ruins, sun, sky, clouds, stoneMat, stats,
    heightAt: (x, z) => L.height(x, z),
    update(dt, now) {
      const sh = grass.material.userData.sh;
      if (sh) sh.uniforms.uTime.value = now / 1000;
      const pulse = 0.5 + 0.5 * Math.sin(now / 1400);
      ward.userData.band.opacity = 0.14 + pulse * 0.12;
      ward.userData.runes.color.setRGB(1.05 + pulse * 0.45, 0.68 + pulse * 0.28, 0.3 + pulse * 0.1);
      ward.userData.runes.map.offset.x = (now / 1000) * 0.012;
      ward.userData.footGlow.opacity = 0.2 + pulse * 0.06;
      clouds.material.uniforms.uTime.value = now / 1000;
    },
  };
}

/**
 * Drifting clouds, high and far, above the ridges, outside the fog: fourteen
 * camera-facing cards in ONE mesh, drifting in the vertex shader, over one
 * atlas of three cloud paintings. (They were fourteen sprites: fourteen
 * draw calls and fourteen position updates a frame, for the sky.)
 */
function buildClouds(W, H, seed) {
  const N = 14, ROWS = 3;
  const atlas = document.createElement('canvas');
  atlas.width = 512; atlas.height = 192 * ROWS;
  const ag = atlas.getContext('2d');
  [99, 173, 241].forEach((s, i) => ag.drawImage(cloudTexture(s).image, 0, i * 192));
  const tex = new THREE.CanvasTexture(atlas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const cr = stream(seed ^ 0x1f123bb5);
  const pos = new Float32Array(N * 4 * 3), corner = new Float32Array(N * 4 * 2), uv = new Float32Array(N * 4 * 2), drift = new Float32Array(N * 4 * 2), idx = [];
  const corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  for (let i = 0; i < N; i++) {
    const opacity = 0.5 + cr() * 0.3;
    const ang = (i / N) * Math.PI * 2 + cr() * 0.4, r = 120 + cr() * 90;
    const cx = W / 2 + Math.cos(ang) * r, cy = 34 + cr() * 26 + r * 0.12, cz = H / 2 + Math.sin(ang) * r;
    const s = 50 + cr() * 60;
    const speed = 0.25 + cr() * 0.35;
    const row = i % ROWS;
    for (let k = 0; k < 4; k++) {
      const v = i * 4 + k;
      pos[v * 3] = cx; pos[v * 3 + 1] = cy; pos[v * 3 + 2] = cz;
      corner[v * 2] = corners[k][0] * s; corner[v * 2 + 1] = corners[k][1] * s * 0.375;
      uv[v * 2] = corners[k][0] + 0.5; uv[v * 2 + 1] = (ROWS - 1 - row + corners[k][1] + 0.5) / ROWS;
      drift[v * 2] = speed; drift[v * 2 + 1] = opacity;
    }
    idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('drift', new THREE.BufferAttribute(drift, 2));
  geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: tex }, uTime: { value: 0 }, uColor: { value: new THREE.Color(0xe8ddd2) }, uWrap: { value: new THREE.Vector2(W / 2 - 230, 460) } },
    vertexShader: `
      attribute vec2 corner; attribute vec2 drift;
      uniform float uTime; uniform vec2 uWrap;
      varying vec2 vUv; varying float vOpacity;
      void main() {
        vUv = uv; vOpacity = drift.y;
        vec3 p = position;
        p.x = uWrap.x + mod(p.x - uWrap.x + drift.x * uTime, uWrap.y);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        mv.xy += corner;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D map; uniform vec3 uColor;
      varying vec2 vUv; varying float vOpacity;
      void main() {
        vec4 t = texture2D(map, vUv);
        gl_FragColor = vec4(t.rgb * uColor, t.a * vOpacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}
