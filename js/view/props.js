// The terrain pieces, drawn: boulders, standing stones, crystal shards,
// ruined walls, floating rocks and trees.
//
// The engine knows each piece as a cylinder with a radius and a height. This
// file knows what it looks like. `makeProp(pr)` returns a group whose origin
// is the piece's base at ground level, with an invisible pick cylinder of the
// engine's exact size, and `userData` {h, r, kind, inner} for the arena. The
// arena adds it to the scene and moves it; nothing here reads game state.
//
// Three optional hooks on `group.userData` let the arena change how a piece
// looks without knowing how it is built:
//   setBurning(bool)   wood chars, leaves blacken and thin out, embers glow
//   setDamage(frac)    0 = pristine, 1 = about to shatter: cracks, a lean,
//                      chunks falling away, a crystal's glow going out
//   update(dt, now)    per-frame life: crystal shimmer, sigil spin, ember pulse
//
// The arena bobs `inner.position.y` (floaters) and shakes `inner.rotation.z`
// (hits), so everything a piece does to ITSELF happens on a `body` group one
// level further down, and `inner` stays at rest.
//
// Any material a piece changes at runtime is its own (cloned), because one
// burning tree must char without the forest going black with it.

import * as THREE from '../../vendor/three/three.module.js';
import { mergeGeometries, mergeVertices } from '../../vendor/three/addons/utils/BufferGeometryUtils.js';
import { propSpec, propR, propH } from '../field/arena.js';
import { pickLod } from './assets.js';
import { menhir } from './world.js';

const MM = 1 / 1000;
const RUNE = 0xb98bff;      // the game's arcane purple
const CRYSTAL = 0x5fd8ff;   // the game's crystal cyan

export function createPropFactory({ gltfs, quality = 'high' }) {
  const high = quality === 'high';
  const stoneTex = stoneTexture();
  const mats = {
    stone: new THREE.MeshStandardMaterial({ map: stoneTex, bumpMap: stoneTex, bumpScale: 0.5, color: 0xd6d0c6, roughness: 0.9, metalness: 0.02 }),
    dark: new THREE.MeshStandardMaterial({ map: stoneTex, bumpMap: stoneTex, bumpScale: 0.5, color: 0x8a847a, roughness: 0.95, metalness: 0.02 }),
    mortar: new THREE.MeshStandardMaterial({ color: 0x4a443b, roughness: 1 }),
    moss: new THREE.MeshStandardMaterial({ color: 0x4f7030, roughness: 1 }),
    ivy: new THREE.MeshStandardMaterial({ color: 0x3f7a2c, roughness: 0.9, side: THREE.DoubleSide }),
    lump: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }),   // moss, chips, rubble: one mesh per piece
  };
  const MOSS = 0x4f7030, CHIP = 0x5c5750;
  mats.wall = mats.stone.clone(); mats.wall.vertexColors = true;
  const sigilTex = sigilTexture();
  const haloTex = haloTexture();
  const bounds = {};

  /** One LOD0 copy of a HIGHGROUND bake, with its footprint measured once. */
  function rockModel(which, { solo = false } = {}) {
    // LOD0 only on high: LOD1 keeps the silhouette at a third of the triangles.
    const g = pickLod(gltfs[which], high ? 0 : 1);
    if (solo) {
      // The bare rock: the bake's grass tufts and companion pebble are
      // separate islands of triangles, and a rock that FLOATS cannot carry
      // grass in the air under it. Keep the largest island only.
      g.traverse((o) => { if (o.isMesh) o.geometry = soloIsland(o.geometry); });
      const key = `${which}:solo`;
      if (!bounds[key]) bounds[key] = new THREE.Box3().setFromObject(g);
      return { g, box: bounds[key] };
    }
    if (!bounds[which]) bounds[which] = new THREE.Box3().setFromObject(g);
    return { g, box: bounds[which] };
  }

  /**
   * The largest connected island of an indexed geometry, with vertices welded
   * by position so split normals and seams do not split the rock. Cached per
   * source geometry.
   */
  const soloCache = new WeakMap(), restCache = new WeakMap();
  function soloIsland(geo, { rest = false } = {}) {
    const cache = rest ? restCache : soloCache;
    if (cache.has(geo)) return cache.get(geo);
    const idx = geo.index ? geo.index.array : null;
    const pos = geo.attributes.position.array;
    const nv = pos.length / 3;
    if (!idx) { soloCache.set(geo, geo); return geo; }
    const key = new Map(); const rep = new Int32Array(nv);
    for (let v = 0; v < nv; v++) {
      const k = `${pos[3 * v].toFixed(4)},${pos[3 * v + 1].toFixed(4)},${pos[3 * v + 2].toFixed(4)}`;
      if (!key.has(k)) key.set(k, v);
      rep[v] = key.get(k);
    }
    const par = new Int32Array(nv); for (let i = 0; i < nv; i++) par[i] = i;
    const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) par[a] = b; };
    for (let t = 0; t < idx.length; t += 3) { uni(rep[idx[t]], rep[idx[t + 1]]); uni(rep[idx[t + 1]], rep[idx[t + 2]]); }
    const size = new Map(); let best = -1, bestN = 0;
    for (let t = 0; t < idx.length; t += 3) { const r = find(rep[idx[t]]); const n = (size.get(r) || 0) + 1; size.set(r, n); if (n > bestN) { bestN = n; best = r; } }
    const keep = [];
    for (let t = 0; t < idx.length; t += 3) if ((find(rep[idx[t]]) === best) !== rest) keep.push(idx[t], idx[t + 1], idx[t + 2]);
    const out = geo.clone();
    out.setIndex(keep);
    out.computeBoundingBox(); out.computeBoundingSphere();
    cache.set(geo, out);
    return out;
  }

  /**
   * A CLOSED rock from a bake's top shell: the shell mirrored across the
   * plane where it is widest, squashed a little, so the stone has an
   * underside and can come to rest on any face (user: "they need entire
   * meshes, not just on the top"). The mirror reads as the same rock
   * continued, with the same texture; its winding is flipped and the whole
   * thing is welded and re-lit as one surface.
   */
  const closedCache = new WeakMap();
  function closedRock(geo, { k = 0.85, waist = 0.22 } = {}) {
    if (closedCache.has(geo)) return closedCache.get(geo);
    const src = geo.index ? geo : geo.toNonIndexed();
    const pos = src.attributes.position, uv = src.attributes.uv;
    const idx = src.index ? Array.from(src.index.array) : Array.from({ length: pos.count }, (_, i) => i);
    let ymin = Infinity, ymax = -Infinity;
    for (let i = 0; i < pos.count; i++) { ymin = Math.min(ymin, pos.getY(i)); ymax = Math.max(ymax, pos.getY(i)); }
    // The mirror plane sits where the rock is widest, not at its base: the
    // bakes narrow a little in their bottom band (and their texture darkens
    // there), and mirrored at the base that band became a waist with a dark
    // crease round it. Everything below the plane is pressed up onto it --
    // those faces end up inside the closed stone, unseen.
    const plane = ymin + (ymax - ymin) * waist;
    const n = pos.count;
    const P = new Float32Array(n * 6), U = uv ? new Float32Array(n * 4) : null;
    for (let i = 0; i < n; i++) {
      const x = pos.getX(i), y = Math.max(plane, pos.getY(i)), z = pos.getZ(i);
      P.set([x, y, z], i * 3);
      P.set([x, plane - (y - plane) * k, z], (n + i) * 3);
      if (U) { U.set([uv.getX(i), uv.getY(i)], i * 2); U.set([uv.getX(i), uv.getY(i)], (n + i) * 2); }
    }
    const I = new Uint32Array(idx.length * 2);
    for (let t = 0; t < idx.length; t += 3) {
      I.set([idx[t], idx[t + 1], idx[t + 2]], t);
      I.set([n + idx[t], n + idx[t + 2], n + idx[t + 1]], idx.length + t);   // flipped
    }
    let out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(P, 3));
    if (U) out.setAttribute('uv', new THREE.BufferAttribute(U, 2));
    out.setIndex(new THREE.BufferAttribute(I, 1));
    // Welded along the seam (same position, same uv) and re-lit, or the
    // equator shows as a crease where the shell's normals meet the mirror's.
    out = mergeVertices(out);
    out.computeVertexNormals();
    out.computeBoundingBox(); out.computeBoundingSphere();
    closedCache.set(geo, out);
    return out;
  }

  /**
   * The whole stone of a boulder, closed and fitted to the engine's sphere:
   * as wide as the diameter and a little proud of it, centred on the group's
   * origin so the arena can turn it about its centre when it rolls.
   */
  function wholeStone(which, r, tint) {
    const { g } = rockModel(which, { solo: true });
    g.traverse((o) => { if (o.isMesh) { o.geometry = closedRock(o.geometry); o.material = o.material.clone(); o.material.color.setHex(tint); } });
    g.scale.set(1, 1, 1); g.position.set(0, 0, 0);
    const box = new THREE.Box3().setFromObject(g);
    const size = box.getSize(new THREE.Vector3());
    const sxz = (2 * r * 1.18) / Math.max(size.x, size.z);
    const sy = THREE.MathUtils.clamp((2 * r * 1.1) / size.y, sxz * 0.8, sxz * 1.25);
    g.scale.set(sxz, sy, sxz);
    const c = box.getCenter(new THREE.Vector3());
    g.position.set(-c.x * sxz, -c.y * sy, -c.z * sxz);
    return g;
  }

  /**
   * A bake fitted to the engine's cylinder: the footprint to the diameter
   * (a little proud of it, so it reads as the solid thing the cylinder stands
   * for), the height to h, with the stretch between them clamped so the rock
   * still looks like the rock. Centred on its footprint, base at y = 0. Its
   * materials are cloned so the tint and the char are this piece's own.
   */
  function fittedRock(which, r, h, { wide = 1.25, tall = 1.05, tint = 0xffffff, solo = false } = {}) {
    const { g, box } = rockModel(which, { solo });
    const size = box.getSize(new THREE.Vector3());
    const sxz = (2 * r * wide) / Math.max(size.x, size.z);
    const sy = THREE.MathUtils.clamp((h * tall) / size.y, sxz * 0.8, sxz * 1.5);
    g.scale.set(sxz, sy, sxz);
    const c = box.getCenter(new THREE.Vector3());
    g.position.set(-c.x * sxz, -box.min.y * sy, -c.z * sxz);
    g.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.color.setHex(tint); } });
    return g;
  }

  const builders = { boulder, pillar, shard, wall, floater, tree, earthwall };

  function makeProp(pr) {
    const r = propR(pr) * MM, h = propH(pr) * MM;
    const g = new THREE.Group();
    const seed = hashStr(pr.id);
    const rnd = rng(seed);
    const inner = new THREE.Group();
    const body = new THREE.Group();
    inner.add(body);
    // What the builder fills in: the hooks, and how far the piece leans when
    // whole (base) and how much further it leans as it breaks (extra).
    const P = { r, h, seed, rnd, body, inner, rock: null, lean: { base: 0, extra: 0 }, burning: null, damage: null, update: null };
    const leanAxis = new THREE.Vector3(Math.cos(rnd() * 6.28), 0, Math.sin(rnd() * 6.28)).normalize();
    const applyLean = (frac) => body.quaternion.setFromAxisAngle(leanAxis, P.lean.base + P.lean.extra * frac);

    builders[pr.kind]?.(P);

    body.traverse((o) => { if (o.isMesh && !o.userData.noShadow) { o.castShadow = true; o.receiveShadow = true; } });
    applyLean(0);
    g.add(inner);
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(r, r, Math.max(h, 0.4), 8), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = Math.max(h, 0.4) / 2;
    hit.userData.pick = { kind: 'prop', id: pr.id };
    g.add(hit);
    Object.assign(g.userData, {
      h, r, kind: pr.kind, inner, rock: P.rock || null,
      setBurning: (on) => P.burning?.(!!on),
      setDamage: (frac) => { frac = THREE.MathUtils.clamp(frac || 0, 0, 1); applyLean(frac); P.damage?.(frac); },
      update: (dt, now) => P.update?.(dt, now),
    });
    return g;
  }

  /* ------------------------------------------------------------ earthwall */

  /**
   * A berm of PACKED EARTH heaved up by the Earth Wall trap: a rough slab,
   * widest at the foot, in dark soil tones with stones and roots showing
   * through the broken face and sods of turf along the crest. Built from
   * jittered blocks and lumps so no two are the same; it rises through the
   * arena's `raised` scale tween, and as it breaks its clods fall away.
   */
  function earthwall(P) {
    const { r, h, rnd, body } = P;
    const len = r * 2, thick = r * 0.62;
    const soil = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    const col = new THREE.Color();
    const fixed = [];
    // The slab: a slanted heap of coarse blocks, each one leaning out a
    // little, dark wet earth at the base shading to drier dust at the top.
    const rows = 4, rowH = h / rows;
    for (let row = 0; row < rows; row++) {
      const w = len * (1.04 - row * 0.09), d = thick * (1.1 - row * 0.14);
      let x = -w / 2;
      while (x < w / 2 - 0.05) {
        const bw = Math.min(0.26 + rnd() * 0.3, w / 2 - x);
        const bh = rowH * (0.85 + rnd() * 0.35);
        const geo = new THREE.BoxGeometry(bw, bh, d * (0.85 + rnd() * 0.3), 2, 2, 2);
        jitter(geo, 0.22, Math.floor(rnd() * 1e6) + 1);
        const t = row / (rows - 1);
        // sRGB hex, not setRGB: linear values this dark render as tan.
        // Wet umber at the foot, drier and dustier toward the crest.
        col.setHex([0x3b2a1c, 0x4a3524, 0x5a4330, 0x6a5440][row]).offsetHSL(0, 0, (rnd() - 0.5) * 0.06);
        paint(geo, col);
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(x + bw / 2, row * rowH + bh / 2 - 0.02, (rnd() - 0.5) * 0.08),
          new THREE.Quaternion().setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.18, (rnd() - 0.5) * 0.12, (rnd() - 0.5) * 0.14)),
          new THREE.Vector3(1, 1, 1));
        fixed.push(geo.applyMatrix4(m));
        x += bw * 0.92;
      }
    }
    // Stones caught in the dirt, and pale roots torn through the face.
    for (let i = 0; i < 9; i++) {
      const g = blobGeo(0.07 + rnd() * 0.1, rnd, { x: (rnd() - 0.5) * len * 0.9, y: 0.1 + rnd() * h * 0.8, z: (rnd() < 0.5 ? -1 : 1) * thick * 0.5, flat: 0.8 });
      fixed.push(paint(g, col.setHex([0x6e675d, 0x7d7569, 0x8c8478, 0x5f5952][Math.floor(rnd() * 4)])));
    }
    for (let i = 0; i < 5; i++) {
      const root = new THREE.CylinderGeometry(0.012, 0.03, 0.25 + rnd() * 0.3, 5);
      root.rotateZ(1.2 + rnd() * 0.8); root.rotateY(rnd() * 6.28);
      root.translate((rnd() - 0.5) * len * 0.8, 0.15 + rnd() * h * 0.5, (rnd() < 0.5 ? -1 : 1) * thick * 0.52);
      fixed.push(paint(root, col.setHex(0xa8906a)));
    }
    body.add(new THREE.Mesh(mergeGeometries(fixed.map((g) => (g.index ? g.toNonIndexed() : g))), soil));
    // Sods of turf along the crest, grass side up, and the loose clods at
    // the foot that the heave threw out -- shown one by one as it breaks.
    const specs = [];
    for (let i = 0; i < 6; i++) specs.push([0x55702e, 0.09 + rnd() * 0.08, { x: (rnd() - 0.5) * len * 0.85, y: h - 0.02, z: (rnd() - 0.5) * thick * 0.6, flat: 0.35 }]);
    const fixedN = specs.length;
    for (let i = 0; i < 6; i++) specs.push([0x3a2d1f, 0.06 + rnd() * 0.07, { x: (rnd() - 0.5) * len * 1.3, y: 0.03, z: (rnd() < 0.5 ? -1 : 1) * (thick * 0.6 + rnd() * 0.3) }]);
    const lump = lumps(mats.lump, specs, rnd, fixedN);
    body.add(lump);
    P.lean.base = 0;
    P.lean.extra = 0.1;
    P.damage = (f) => { let n = 0; for (let i = 0; i < 6; i++) if (f > 0.1 + i * 0.15) n = i + 1; lump.userData.show(n); };
  }

  /* ------------------------------------------------------------ boulder */

  /** The bake, settled into the ground, tinted by seed: plain, mossy, lichened or cold. */
  function boulder(P) {
    const { r, h, seed, rnd, body } = P;
    const which = ['boulderA', 'boulderB', 'boulderC'][seed % 3];
    const tint = [0xf2efe8, 0xcfdcbd, 0xe3d6b8, 0xc9cfd8][(seed >> 3) % 4];
    // The bake is the stone plus its companions (grass tufts, a pebble),
    // separate islands of triangles. The STONE -- closed, so it has an
    // underside to come to rest on -- goes into a group the arena turns
    // about its centre when the boulder rolls, with the moss that grows on
    // it; the companions keep the bake's fit and stay in `body`, on the
    // grass, or they would orbit the rolling rock.
    const rock = wholeStone(which, r, tint);
    rock.rotation.y = (seed % 7) * 0.9;
    const tufts = fittedRock(which, r, h, { tint });
    tufts.rotation.y = rock.rotation.y;
    tufts.traverse((o) => { if (o.isMesh) o.geometry = soloIsland(o.geometry, { rest: true }); });
    const roll = new THREE.Group();
    const cy = r * 0.92;                       // the sphere's centre, settled in a little
    roll.position.y = cy;
    roll.add(rock);
    roll.userData.centre = roll.position.clone();
    body.add(roll);
    tufts.position.y -= h * 0.07;
    body.add(tufts);
    P.rock = roll;
    // Moss on the shaded side of a mossy rock; the chips knocked off it
    // (shown one by one as the damage mounts) lie on the ground around.
    if (tint === 0xcfdcbd) {
      const moss = [];
      for (let i = 0; i < 4; i++) moss.push([MOSS, r * (0.22 + rnd() * 0.12), { x: (rnd() - 0.5) * r * 1.2, y: h * (0.3 + rnd() * 0.5) - cy, z: -r * 0.75 - rnd() * 0.15, flat: 0.35 }]);
      roll.add(lumps(mats.lump, moss, rnd));
    }
    const chips = [];
    for (let i = 0; i < 5; i++) chips.push([CHIP, 0.05 + rnd() * 0.06, { x: Math.cos(i * 1.3 + seed) * r * (1.2 + rnd() * 0.5), y: 0.03, z: Math.sin(i * 1.3 + seed) * r * (1.2 + rnd() * 0.5) }]);
    const lump = lumps(mats.lump, chips, rnd, 0);
    body.add(lump);
    P.lean.base = 0.02 + rnd() * 0.03;
    P.lean.extra = 0.14;
    P.damage = (f) => { let n = 0; for (let i = 0; i < 5; i++) if (f > 0.15 + i * 0.17) n = i + 1; lump.userData.show(n); };
  }

  /* ------------------------------------------------------------ pillar */

  /** A tall weathered menhir with a column of carved runes lit from within. */
  function pillar(P) {
    const { r, h, seed, rnd, body } = P;
    const skin = pillarSkin(seed);
    const mat = new THREE.MeshStandardMaterial({
      map: skin.map, bumpMap: skin.map, bumpScale: 0.9, emissiveMap: skin.runes, emissive: RUNE, emissiveIntensity: 2.4,
      color: 0xd8d2c8, roughness: 0.88, metalness: 0.02,
    });
    const stone = menhir(h, r, mat, seed);
    // The menhir's UVs are tiled for the ward's granite; this skin is one
    // picture of one stone, so stretch them back to 0..1 (the geometry is ours).
    normaliseUv(stone.geometry);
    body.add(stone);
    // The runes' light on the grass: an additive pool at the foot (a point
    // light here made every lit pixel in the scene dearer).
    const pool = halo(haloTex, RUNE, r * 2.4, 0.28);
    body.add(pool);
    const specs = [];
    for (let i = 0; i < 6; i++) { const a = rnd() * 6.28, d = r * (0.8 + rnd() * 0.35); specs.push([MOSS, r * (0.25 + rnd() * 0.2), { x: Math.cos(a) * d, y: 0.02, z: Math.sin(a) * d, flat: 0.3 }]); }
    for (let i = 0; i < 3; i++) { const a = rnd() * 6.28; specs.push([CHIP, 0.04 + rnd() * 0.05, { x: Math.cos(a) * r * 1.4, y: 0.03, z: Math.sin(a) * r * 1.4 }]); }
    body.add(lumps(mats.lump, specs, rnd));
    body.rotation.y = (seed % 9) * 0.7;
    P.lean.base = rnd() * 0.05;
    P.lean.extra = 0.12;
    let dim = 1;
    const phase = rnd() * 6.28;
    P.damage = (f) => { dim = 1 - f * 0.7; skin.redraw(f); };
    P.update = (dt, now) => {
      const k = dim * (0.85 + 0.15 * Math.sin(now / 700 + phase)) * (dim < 0.6 && Math.random() < 0.08 ? 0.5 : 1);
      mat.emissiveIntensity = 2.4 * k;
      pool.material.opacity = 0.28 * k;
    };
  }

  /* ------------------------------------------------------------ shard */

  /** A faceted crystal cluster: one spire, two leaning companions, a litter of small ones, all lit from a core. */
  function shard(P) {
    const { r, h, seed, rnd, body } = P;
    // No transmission: a transmissive material makes three.js render the
    // whole scene a second time into a texture every frame. Glassiness comes
    // from the sky reflection, the emissive heart and a little see-through.
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0x6fd0f4, emissive: 0x1a7aa8, emissiveIntensity: 0.9, roughness: 0.18, metalness: 0,
      transparent: true, opacity: 0.86, flatShading: true, envMapIntensity: 1.4, clearcoat: high ? 0.6 : 0, clearcoatRoughness: 0.15,
    });
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xd8f6ff });
    // Every crystal in ONE geometry, the big ones first and the small litter
    // last, so damage can hide the litter by shortening the draw range.
    const geos = [], smallGeos = [];
    const place = (rad, hgt, x, z, tiltRad, yaw, small) => {
      const c = new THREE.Mesh(crystalGeo(rad, hgt, rnd));
      c.position.set(x, 0, z);
      c.rotation.set(0, yaw, 0);
      c.rotateOnAxis(new THREE.Vector3(1, 0, 0), tiltRad);
      c.updateMatrix();
      (small ? smallGeos : geos).push(c.geometry.applyMatrix4(c.matrix));
      return c;
    };
    place(r * 0.55, h, 0, 0, 0.04, rnd() * 6.28, false);
    const core = new THREE.Mesh(crystalGeo(r * 0.28, h * 0.6, rnd), coreMat);
    core.position.y = h * 0.1; core.userData.noShadow = true;
    body.add(core);
    for (let i = 0; i < 2; i++) { const a = seed * 0.3 + i * 3.1 + rnd() * 0.8; place(r * 0.32, h * (0.45 + rnd() * 0.15), Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55, 0.35 + rnd() * 0.2, a + Math.PI / 2, false); }
    for (let i = 0; i < 5; i++) { const a = rnd() * 6.28; const d = r * (0.6 + rnd() * 0.5); place(r * (0.12 + rnd() * 0.1), h * (0.14 + rnd() * 0.12), Math.cos(a) * d, Math.sin(a) * d, 0.5 + rnd() * 0.4, a + Math.PI / 2, true); }
    // The litter, ordered by how long it survives (longest first), so the
    // survivors are always a prefix.
    const order = smallGeos.map((g, i) => ({ g, at: 0.3 + (i % 3) * 0.25 })).sort((a, b) => b.at - a.at);
    const counts = order.map(({ g }) => g.index ? g.index.count : g.attributes.position.count);
    const cluster = new THREE.Mesh(mergeGeometries([...geos, ...order.map((o) => o.g)]), mat);
    const bigN = geos.reduce((s, g) => s + (g.index ? g.index.count : g.attributes.position.count), 0);
    body.add(cluster);
    const halo = new THREE.Mesh(new THREE.CircleGeometry(r * 1.9, 24), new THREE.MeshBasicMaterial({ map: haloTex, color: CRYSTAL, transparent: true, opacity: 0.42, blending: THREE.AdditiveBlending, depthWrite: false }));
    halo.rotation.x = -Math.PI / 2; halo.position.y = 0.012; halo.userData.noShadow = true;
    body.add(halo);
    P.lean.base = 0.03;
    P.lean.extra = 0.18;
    let dim = 1;
    const phase = rnd() * 6.28;
    P.damage = (f) => {
      dim = 1 - f * 0.8;
      // The litter goes first, a shard at a time.
      let keep = 0;
      for (let i = 0; i < order.length; i++) { if (f < order[i].at) keep = i + 1; else break; }
      cluster.geometry.setDrawRange(0, bigN + counts.slice(0, keep).reduce((s, c) => s + c, 0));
      coreMat.color.setHex(0xd8f6ff).lerp(new THREE.Color(0x2b5566), f * 0.85);
      mat.color.setHex(0x6fd0f4).lerp(new THREE.Color(0x4e6a74), f * 0.6);
    };
    P.update = (dt, now) => {
      const s = 0.8 + 0.2 * Math.sin(now / 420 + phase) + 0.08 * Math.sin(now / 95 + phase * 2);
      mat.emissiveIntensity = 0.9 * dim * s;
      halo.material.opacity = 0.42 * dim * s;
      core.scale.setScalar(0.96 + 0.05 * s);
    };
  }

  /* ------------------------------------------------------------ wall */

  /** Ashlar blocks on a mortar core with a broken top, rubble, moss at the foot and ivy up one end. */
  function wall(P) {
    const { r, h, seed, rnd, body } = P;
    const len = r * 2, thick = 0.44;
    const rows = 4, rowH = h / rows, gap = 0.022;
    const fixed = [], loose = [], cores = [], tops = [];
    const topAt = (px) => tops.reduce((m, [a, b, y]) => (px >= a - 0.02 && px <= b + 0.02 ? Math.max(m, y) : m), 0);
    const col = new THREE.Color();
    const brokenEnd = rnd() < 0.5 ? -1 : 1;
    for (let row = 0; row < rows; row++) {
      let x = -len / 2, half = row % 2 ? 0.18 : 0;
      const top = row === rows - 1;
      // How far from the whole end this row's blocks run without a gap: the
      // mortar core behind them is only as long as that, so a missing block
      // leaves sky, not a black slab.
      const present = [];
      while (x < len / 2 - 0.01) {
        // The last block in a row runs to the end, so no row leaves a sliver of core showing.
        let bw = half || Math.min(0.3 + rnd() * 0.22, len / 2 - x);
        if (len / 2 - (x + bw) < 0.12) bw = len / 2 - x;
        half = 0;
        const endness = Math.max(0, brokenEnd * (x + bw / 2) / (len / 2));    // 0 at the whole end, 1 at the broken end
        const missing = (top && rnd() < 0.25 + endness * 0.5) || (row === rows - 2 && endness > 0.7 && rnd() < 0.5);
        if (!missing) {
          const chipped = (top || endness > 0.6) && rnd() < 0.5;
          const bh = rowH * (chipped ? 0.5 + rnd() * 0.3 : 0.96);
          const geo = new THREE.BoxGeometry(bw - gap, bh - gap, thick * (0.92 + rnd() * 0.16));
          const grey = 0.82 + rnd() * 0.22;
          col.setRGB(grey, grey * (0.97 + rnd() * 0.03), grey * (0.92 + rnd() * 0.05));
          if (row === 0) col.lerp(new THREE.Color(0.55, 0.72, 0.42), 0.35 + rnd() * 0.3);
          if (row === 1 && rnd() < 0.4) col.lerp(new THREE.Color(0.6, 0.72, 0.5), 0.2);
          paint(geo, col);
          const m = new THREE.Matrix4().compose(new THREE.Vector3(x + bw / 2, row * rowH + bh / 2, (rnd() - 0.5) * 0.03), new THREE.Quaternion().setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.02, (rnd() - 0.5) * 0.05, (rnd() - 0.5) * 0.02)), new THREE.Vector3(1, 1, 1));
          const isLoose = top || (row === rows - 2 && endness > 0.5);
          if (isLoose) loose.push({ geo, m }); else { fixed.push(geo.applyMatrix4(m)); present.push([x, x + bw]); }
          tops.push([x, x + bw, row * rowH + bh]);
        }
        x += bw;
      }
      // Whole rows run the whole length; the mortar is shy of the blocks all round.
      let cover = -brokenEnd * len / 2;
      if (brokenEnd > 0) { for (const [s0, s1] of present) { if (s0 > cover + 0.2) break; cover = Math.max(cover, s1); } }
      else { for (let i = present.length - 1; i >= 0; i--) { const [s0, s1] = present[i]; if (s1 < cover - 0.2) break; cover = Math.min(cover, s0); } }
      const a = Math.min(-brokenEnd * len / 2, cover), b = Math.max(-brokenEnd * len / 2, cover);
      if (b - a > 0.1) {
        const cg = new THREE.BoxGeometry(b - a - 0.06, rowH * 0.9, thick * 0.72);
        cg.translate((a + b) / 2, row * rowH + rowH * 0.45, 0);
        cores.push(cg);
      }
    }
    // Rubble, thickest at the broken end, painted and merged into the ashlar
    // mesh (it shares the granite); moss where the wall meets the grass, one mesh.
    for (let i = 0; i < 7; i++) {
      const x = brokenEnd * (len / 2) * (0.2 + rnd() * 1.1) - brokenEnd * len * 0.25 * rnd();
      const dark = rnd() >= 0.3;
      const g = blobGeo(0.05 + rnd() * 0.08, rnd, { x, y: 0.03, z: (rnd() - 0.5) * 1.1 });
      fixed.push(paint(g, col.setRGB(dark ? 0.62 : 1, dark ? 0.6 : 0.98, dark ? 0.56 : 0.94)));
    }
    const merged = new THREE.Mesh(mergeGeometries(fixed.map((g) => (g.index ? g.toNonIndexed() : g))), mats.wall);
    body.add(merged);
    const mossSpecs = [];
    for (let i = 0; i < 6; i++) mossSpecs.push([MOSS, 0.07 + rnd() * 0.09, { x: (rnd() - 0.5) * len, y: 0.02, z: (rnd() < 0.5 ? -1 : 1) * (thick * 0.5 + rnd() * 0.1), flat: 0.3 }]);
    body.add(lumps(mats.lump, mossSpecs, rnd));
    // Loose blocks stand on the wall until the damage knocks them down to a
    // fallen twin. The standing ones are one mesh and the fallen ones another;
    // since they fall in order, the standing set is always a prefix of the
    // one and the fallen set a suffix of the other, drawn by range.
    const ups = [], downs = [], upN = [], downN = [];
    // Reversed: the block that falls LAST comes first, so the standing set is a prefix.
    const byFall = loose.slice().reverse();
    const ats = byFall.map((_, k) => { const i = loose.length - 1 - k; return 0.25 + (i / Math.max(1, loose.length - 1)) * 0.65; });
    byFall.forEach(({ geo, m }, i) => {
      const up = geo.clone().applyMatrix4(m);
      const p = new THREE.Vector3().setFromMatrixPosition(m);
      const down = new THREE.Mesh(geo.clone());
      down.position.set(p.x + (rnd() - 0.5) * 0.3, 0.09, (rnd() < 0.5 ? -1 : 1) * (thick * 0.6 + rnd() * 0.35));
      down.rotation.set((rnd() - 0.5) * 0.6, rnd() * 6.28, 0.9 + rnd() * 0.5);
      down.updateMatrix();
      ups.push(up); downs.push(down.geometry.applyMatrix4(down.matrix));
      upN.push(up.index.count); downN.push(downs[i].index.count);
    });
    const upMesh = ups.length ? new THREE.Mesh(mergeGeometries(ups), mats.wall) : null;
    const downMesh = downs.length ? new THREE.Mesh(mergeGeometries(downs), mats.wall) : null;
    if (upMesh) body.add(upMesh);
    if (downMesh) { downMesh.geometry.setDrawRange(0, 0); body.add(downMesh); }
    const upTotal = upN.reduce((s, n) => s + n, 0);
    // Ivy: a vine climbing the whole end of the front face, leaves flat against the stone, one merged mesh.
    const ivyX = -brokenEnd * len * 0.3;
    const ivyTop = topAt(ivyX) - 0.02;
    const leaves = [];
    const vine = [];
    for (let i = 0; i < 28; i++) {
      const t = i / 27;
      const y = 0.04 + t * (ivyTop - 0.04);
      const vx = ivyX + Math.sin(t * 7) * 0.09 + (rnd() - 0.5) * 0.04;
      vine.push(new THREE.Vector3(vx, y, thick / 2 + 0.008));
      const leaf = new THREE.CircleGeometry(0.028 + rnd() * 0.022, 5);
      leaf.rotateZ(rnd() * 6.28); leaf.rotateX((rnd() - 0.5) * 0.3); leaf.rotateY((rnd() - 0.5) * 0.3);
      leaf.translate(vx + (rnd() - 0.5) * 0.12, y + (rnd() - 0.5) * 0.04, thick / 2 + 0.012 + rnd() * 0.01);
      leaves.push(leaf);
      if (t > 0.75 && rnd() < 0.6) {       // the vine spills over the top
        const over = new THREE.CircleGeometry(0.03 + rnd() * 0.02, 5);
        over.rotateX(-Math.PI / 2); over.rotateY(rnd() * 6.28);
        over.translate(vx + (rnd() - 0.5) * 0.16, ivyTop + 0.03, (rnd() - 0.5) * thick * 0.8);
        leaves.push(over);
      }
    }
    body.add(new THREE.Mesh(mergeGeometries(leaves), mats.ivy));
    // The vine's stem is mortar-coloured too: it goes in with the core.
    cores.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(vine), 24, 0.008, 4, false));
    body.add(new THREE.Mesh(mergeGeometries(cores), mats.mortar));
    body.rotation.y = (seed % 4) * 0.4 - 0.6;
    P.lean.base = 0;
    P.lean.extra = 0.06;
    P.damage = (f) => {
      let standing = 0;
      for (let i = 0; i < ats.length; i++) { if (f < ats[i]) standing = i + 1; else break; }
      let upCount = 0;
      for (let i = 0; i < standing; i++) upCount += upN[i];
      let downStart = 0;
      for (let i = 0; i < standing; i++) downStart += downN[i];
      upMesh?.geometry.setDrawRange(0, upCount);
      downMesh?.geometry.setDrawRange(downStart, Infinity);
      if (upMesh) upMesh.visible = upCount > 0;
      if (downMesh) downMesh.visible = standing < ats.length;
    };
    if (upMesh) upMesh.geometry.setDrawRange(0, upTotal);
  }

  /* ------------------------------------------------------------ floater */

  /**
   * A rock that floats. JUST a rock: no earthen underside, no roots (user:
   * "the rock should just float, not have dirt under it"). Sizes vary per
   * piece (the engine's `scale`).
   */
  function floater(P) {
    const { r, h, seed, body } = P;
    const which = ['boulderB', 'boulderC', 'boulderA'][seed % 3];
    const rock = fittedRock(which, r, h, { wide: 1.1, tall: 1.15, tint: 0xe8e4dc, solo: true });
    rock.rotation.y = (seed % 5) * 1.1;
    body.add(rock);
    // No sigil, no ring, no pool of light, no bobbing: a floating rock is
    // TERRAIN. It hangs there the way a cliff stands there. (A piece a spell
    // lifts gets its glow from arena3d's levitating fx, not from here.)
    P.lean.base = 0.02;
    P.lean.extra = 0.2;
  }

  /* ------------------------------------------------------------ tree */

  /** The alder, young (3.2 m), with its own bark and leaf materials so it can char alone. */
  function tree(P) {
    const { h, seed, rnd, body } = P;
    // LOD1 (2.5k triangles): at 3.2m tall and 10m+ from the camera it reads
    // as LOD0 (8.5k) did, and it is drawn twice (once into the shadow map).
    const tr = pickLod(gltfs.alder, quality === 'low' ? 2 : 1);
    tr.scale.setScalar(h / 12.69);
    tr.rotation.y = (seed % 11) * 0.55;
    let bark = null, leaves = null;
    tr.traverse((o) => {
      if (!o.isMesh) return;
      o.material = o.material.clone();
      if (/leaves|cards/.test(o.material.name + o.name)) leaves = o.material; else bark = o.material;
    });
    body.add(tr);
    P.inner.userData.tree = tr;
    const leafAlpha = leaves ? leaves.alphaTest : 0.5;
    const barkCol = bark ? bark.color.clone() : new THREE.Color(1, 1, 1);
    const leafCol = leaves ? leaves.color.clone() : new THREE.Color(1, 1, 1);
    let burning = false, char = 0, damage = 0;
    const apply = () => {
      if (bark) {
        bark.color.copy(barkCol).lerp(new THREE.Color(0x14100c), char);
        bark.emissive.setHex(0xff5a10);     // embers through the bark's own grain, faint: not a red tree
        bark.emissiveMap = bark.map;
        bark.roughness = 1 - char * 0.1;
      }
      if (leaves) {
        leaves.color.copy(leafCol).lerp(new THREE.Color(0x120d09), char);
        leaves.emissive.setHex(0xff6a20);
        leaves.emissiveMap = leaves.map;
        leaves.alphaTest = Math.min(0.98, leafAlpha + char * 0.42 + damage * 0.12);
      }
    };
    P.lean.base = rnd() * 0.03;
    P.lean.extra = 0.16;
    P.burning = (on) => { burning = on; };
    P.damage = (f) => { damage = f; apply(); };
    P.update = (dt, now) => {
      // Char comes on over a couple of seconds and never goes away; the embers die with the fire.
      if (burning && char < 1) { char = Math.min(1, char + dt / 2.5); apply(); }
      const ember = burning ? char * (0.24 + 0.1 * Math.sin(now / 260 + seed) + 0.06 * Math.sin(now / 71)) : 0;
      if (bark) bark.emissiveIntensity = ember;
      if (leaves) leaves.emissiveIntensity = ember * 0.6;
      // Leaves rustle: the crown sways a hair, more when there is fire under it.
      tr.rotation.z = Math.sin(now / 1300 + seed) * 0.008 * (1 + ember * 3);
    };
  }

  return makeProp;
}

/* ------------------------------------------------------------ helpers */

function hashStr(s) { let h = 7; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h); }

function rng(seed) { let s = (seed % 2147483646) + 1; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; }

/** Scale every unique vertex radially by a seeded amount: a lumpy rock from a smooth primitive. */
function jitter(geo, amt, seed) {
  const p = geo.attributes.position;
  const rnd = rng(seed);
  const key = new Map();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    if (!key.has(k)) key.set(k, 1 + (rnd() - 0.5) * amt * 2);
    const f = key.get(k);
    p.setXYZ(i, p.getX(i) * f, p.getY(i) * f, p.getZ(i) * f);
  }
  geo.computeVertexNormals();
}

/** A small lump: moss, a pebble, a chip of stone. `flat` squashes it into a cushion. Returns the placed geometry. */
function blobGeo(size, rnd, { x = 0, y = 0, z = 0, flat = 0.7 } = {}) {
  const geo = new THREE.DodecahedronGeometry(size, 0);
  jitter(geo, 0.25, Math.floor(rnd() * 1e6) + 1);
  const m = new THREE.Mesh(geo);
  m.position.set(x, y, z);
  m.scale.set(1, flat, 1);
  m.rotation.set(rnd() * 6.28, rnd() * 6.28, 0);
  m.updateMatrix();
  return geo.applyMatrix4(m.matrix);
}

/**
 * Lumps in ONE mesh, vertex-coloured, no shadow (they are moss and chips on
 * the ground). `specs` are [colour, size, placement]; the first `fixedN`
 * always show, and `userData.show(k)` adds the next k, for chips that
 * appear one by one as damage mounts.
 */
function lumps(mat, specs, rnd, fixedN = specs.length) {
  const geos = [], counts = [];
  const c = new THREE.Color();
  for (const [colour, size, at] of specs) { const g = paint(blobGeo(size, rnd, at), c.setHex(colour)); geos.push(g); counts.push(g.attributes.position.count); }
  const m = new THREE.Mesh(mergeGeometries(geos), mat);
  m.userData.noShadow = true;
  m.userData.show = (k) => { let n = 0; for (let i = 0; i < fixedN + k && i < specs.length; i++) n += counts[i]; m.geometry.setDrawRange(0, n); m.visible = n > 0; };
  m.userData.show(0);
  return m;
}

/** A soft additive disc of light on the ground: what a point light used to put there. */
function halo(tex, colour, radius, opacity) {
  const m = new THREE.Mesh(new THREE.CircleGeometry(radius, 20), new THREE.MeshBasicMaterial({ map: tex, color: colour, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.014; m.userData.noShadow = true;
  m.renderOrder = 1;
  return m;
}

/** Stretch a geometry's UVs to span exactly 0..1 in both axes. */
function normaliseUv(geo) {
  const uv = geo.attributes.uv;
  if (!uv) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < uv.count; i++) { const x = uv.getX(i), y = uv.getY(i); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const sx = x1 > x0 ? 1 / (x1 - x0) : 1, sy = y1 > y0 ? 1 / (y1 - y0) : 1;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) - x0) * sx, (uv.getY(i) - y0) * sy);
  uv.needsUpdate = true;
}

/** Fill a geometry's colour attribute with one colour (for the merged wall). */
function paint(geo, col) {
  const n = geo.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = col.r; a[i * 3 + 1] = col.g; a[i * 3 + 2] = col.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return geo;
}

/** A crystal: a six-sided prism tapering to a point, each vertex nudged so no two shards are the same. */
function crystalGeo(rad, hgt, rnd) {
  const bodyG = new THREE.CylinderGeometry(rad * 0.62, rad * 0.9, hgt * 0.7, 6, 1, true);
  bodyG.translate(0, hgt * 0.35, 0);
  const tip = new THREE.ConeGeometry(rad * 0.62, hgt * 0.3, 6, 1, true);
  tip.translate(0, hgt * 0.85, 0);
  const foot = new THREE.ConeGeometry(rad * 0.9, hgt * 0.08, 6, 1, true);
  foot.rotateX(Math.PI); foot.translate(0, -hgt * 0.04, 0);
  const geo = mergeGeometries([bodyG, tip, foot]);
  jitter(geo, 0.1, Math.floor(rnd() * 1e6) + 1);
  return geo;
}

/** Granite: light grey noise with darker veins and strata, tiled on walls and rubble. */
function stoneTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const g = cv.getContext('2d');
  paintStone(g, 256, 256, rng(4242));
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function paintStone(g, w, h, rnd) {
  g.fillStyle = '#a39d93'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < (w * h) / 7; i++) {
    const t = 120 + rnd() * 110;
    g.fillStyle = `rgba(${t},${t - 4},${t - 10},0.4)`;
    g.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 4, 1 + rnd() * 4);
  }
  // Larger weathered patches.
  for (let i = 0; i < (w * h) / 2600; i++) {
    const t = 100 + rnd() * 120;
    g.fillStyle = `rgba(${t},${t - 2},${t - 12},0.18)`;
    g.beginPath(); g.ellipse(rnd() * w, rnd() * h, 6 + rnd() * 18, 4 + rnd() * 10, rnd() * 3, 0, 6.3); g.fill();
  }
  g.strokeStyle = 'rgba(40,36,32,0.4)'; g.lineWidth = 1.5;
  for (let i = 0; i < (w * h) / 4700; i++) {
    g.beginPath(); let x = rnd() * w, y = rnd() * h; g.moveTo(x, y);
    for (let k = 0; k < 8; k++) { x += (rnd() - 0.5) * 40; y += (rnd() - 0.5) * 40; g.lineTo(x, y); }
    g.stroke();
  }
}

/** A rune: a few straight strokes on a three-by-three grid with a stem, like something cut with a chisel. */
function drawGlyph(g, x, y, s, rnd) {
  g.beginPath();
  const n = 2 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const a = [Math.floor(rnd() * 3), Math.floor(rnd() * 3)], b = [Math.floor(rnd() * 3), Math.floor(rnd() * 3)];
    if (a[0] === b[0] && a[1] === b[1]) b[1] = (b[1] + 1) % 3;
    g.moveTo(x + a[0] * s / 2, y + a[1] * s / 2); g.lineTo(x + b[0] * s / 2, y + b[1] * s / 2);
  }
  g.moveTo(x + s / 2, y); g.lineTo(x + s / 2, y + s);
  g.stroke();
}

/**
 * The skin of one standing stone: weathered granite with moss creeping up
 * from the foot, a column of runes cut into one face (map), and the same
 * runes alone on black (emissive map), so they glow from inside the cuts.
 * `redraw(frac)` adds cracks from the top as the stone takes damage.
 */
function pillarSkin(seed) {
  const W = 256, H = 512;
  const base = document.createElement('canvas'); base.width = W; base.height = H;
  const g = base.getContext('2d');
  const rnd = rng(seed);
  paintStone(g, W, H, rnd);
  // Strata: faint horizontal bands, the way a cut stone weathers.
  for (let i = 0; i < 14; i++) { const y = rnd() * H; g.fillStyle = `rgba(60,55,50,${0.06 + rnd() * 0.1})`; g.fillRect(0, y, W, 2 + rnd() * 5); }
  // Moss, creeping up from the foot.
  for (let i = 0; i < 260; i++) {
    const y = H - Math.pow(rnd(), 2.2) * H * 0.3, x = rnd() * W;
    const gr = 90 + rnd() * 60;
    g.fillStyle = `rgba(${gr - 40},${gr},${gr - 60},${0.35 + rnd() * 0.4})`;
    g.beginPath(); g.ellipse(x, y, 3 + rnd() * 9, 2 + rnd() * 5, rnd() * 3, 0, 6.3); g.fill();
  }
  // The runes: cut in (dark groove with a lit upper edge), and glowing.
  const glyphRnd = rng(seed * 7 + 3);
  const runes = document.createElement('canvas'); runes.width = W; runes.height = H;
  const e = runes.getContext('2d');
  e.fillStyle = '#000'; e.fillRect(0, 0, W, H);
  const strokes = [];
  for (const cx of [W * 0.17, W * 0.5, W * 0.83]) {
    const y0 = 60 + glyphRnd() * 40, n = 5 + Math.floor(glyphRnd() * 3);
    for (let k = 0; k < n; k++) { const s = 20 + glyphRnd() * 6; strokes.push([cx - s / 2, y0 + k * 42, s]); }
  }
  const drawAll = (ctx, dx, dy) => { const r2 = rng(seed * 7 + 3); for (const [x, y, s] of strokes) drawGlyph(ctx, x + dx, y + dy, s, r2); };
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.strokeStyle = 'rgba(255,250,240,0.35)'; g.lineWidth = 6; drawAll(g, 1, 2);
  g.strokeStyle = '#2a2420'; g.lineWidth = 5; drawAll(g, 0, 0);
  e.lineCap = 'round'; e.lineJoin = 'round';
  e.shadowColor = '#c9a2ff'; e.shadowBlur = 7;
  e.strokeStyle = '#e8d2ff'; e.lineWidth = 3.2; drawAll(e, 0, 0);
  // The live map canvas: the base plus whatever cracks the damage has added.
  const live = document.createElement('canvas'); live.width = W; live.height = H;
  const l = live.getContext('2d');
  l.drawImage(base, 0, 0);
  const map = new THREE.CanvasTexture(live);
  map.wrapS = map.wrapT = THREE.RepeatWrapping; map.colorSpace = THREE.SRGBColorSpace;
  const em = new THREE.CanvasTexture(runes);
  em.wrapS = em.wrapT = THREE.RepeatWrapping; em.colorSpace = THREE.SRGBColorSpace;
  const crackRnd = rng(seed + 99);
  const cracks = [];
  for (let i = 0; i < 5; i++) {
    const pts = []; let x = crackRnd() * W, y = crackRnd() * H * 0.15;
    for (let k = 0; k < 14; k++) { pts.push([x, y]); x += (crackRnd() - 0.5) * 30; y += 14 + crackRnd() * 26; }
    cracks.push(pts);
  }
  return {
    map, runes: em,
    redraw(frac) {
      l.drawImage(base, 0, 0);
      if (frac > 0) {
        l.lineCap = 'round'; l.lineJoin = 'round';
        const n = Math.ceil(frac * cracks.length);
        for (let c = 0; c < n; c++) {
          const pts = cracks[c], len = Math.max(2, Math.round(pts.length * Math.min(1, frac * 1.3)));
          l.strokeStyle = 'rgba(255,250,240,0.3)'; l.lineWidth = 4; l.beginPath(); l.moveTo(pts[0][0] + 1, pts[0][1] + 1); for (let i = 1; i < len; i++) l.lineTo(pts[i][0] + 1, pts[i][1] + 1); l.stroke();
          l.strokeStyle = '#1c1816'; l.lineWidth = 2.5; l.beginPath(); l.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < len; i++) l.lineTo(pts[i][0], pts[i][1]); l.stroke();
        }
      }
      map.needsUpdate = true;
    },
  };
}

/** A soft disc of light, white fading to black, for the glow a crystal throws on the grass. */
function haloTexture() {
  const S = 128;
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, '#fff'); grad.addColorStop(0.35, '#999'); grad.addColorStop(1, '#000');
  g.fillStyle = grad; g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A sigil: two rings, a hexagram and a circle of small runes, white on black for an additive plane. */
function sigilTexture() {
  const S = 256;
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  g.strokeStyle = '#fff'; g.lineCap = 'round'; g.lineJoin = 'round';
  g.shadowColor = '#fff'; g.shadowBlur = 4;
  const c = S / 2;
  g.lineWidth = 3; g.beginPath(); g.arc(c, c, 118, 0, 6.3); g.stroke();
  g.lineWidth = 1.5; g.beginPath(); g.arc(c, c, 100, 0, 6.3); g.stroke();
  g.lineWidth = 2; g.beginPath(); g.arc(c, c, 62, 0, 6.3); g.stroke();
  for (const off of [0, Math.PI]) {
    g.lineWidth = 2.2; g.beginPath();
    for (let i = 0; i < 3; i++) { const a = off + i * (Math.PI * 2 / 3) - Math.PI / 2; const x = c + Math.cos(a) * 98, y = c + Math.sin(a) * 98; i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.closePath(); g.stroke();
  }
  const rnd = rng(77);
  g.lineWidth = 1.8;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    g.save(); g.translate(c + Math.cos(a) * 109, c + Math.sin(a) * 109); g.rotate(a + Math.PI / 2);
    drawGlyph(g, -5, -5, 10, rnd);
    g.restore();
  }
  g.fillStyle = '#fff'; g.beginPath(); g.arc(c, c, 8, 0, 6.3); g.fill();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
