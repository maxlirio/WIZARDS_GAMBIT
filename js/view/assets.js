// Loading the models, once, and handing out copies.
//
// Everything drawn on the battlefield that is not generated in code comes
// through here: the rigged mage, the trees, the bushes, the boulders. Each file
// is fetched once and cached; `clone()` hands out a fresh scene graph that
// shares geometry and (unless asked otherwise) materials, so a hundred trees
// cost one set of buffers.
//
// Nothing in the rules knows these exist. The engine says "a tree at x,y"; this
// file knows what a tree looks like.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skelClone } from 'three/addons/utils/SkeletonUtils.js';

const BASE = new URL('../../assets/models/', import.meta.url).href;

const MODELS = {
  mage: 'mage.glb',
  alder: 'alder.glb',
  deadTree: 'dead_tree.glb',
  bush: 'bush.glb',
  boulderA: 'boulder_a.glb',
  boulderB: 'boulder_b.glb',
  boulderC: 'boulder_c.glb',
};

const loader = new GLTFLoader();
const cache = new Map();

/** Load one model (cached). Resolves to the GLTF result. */
export function load(name) {
  if (!cache.has(name)) {
    cache.set(name, new Promise((resolve, reject) => {
      loader.load(BASE + MODELS[name], (gltf) => {
        prepare(gltf.scene, name);
        resolve(gltf);
      }, undefined, reject);
    }));
  }
  return cache.get(name);
}

/** Load everything the battlefield needs. Resolves to {name: gltf}. */
export async function loadAll(onProgress) {
  const names = Object.keys(MODELS);
  const out = {};
  let done = 0;
  await Promise.all(names.map(async (n) => {
    out[n] = await load(n);
    done++;
    onProgress?.(done / names.length, n);
  }));
  return out;
}

/**
 * One pass over a freshly loaded scene: shadows on, the baked trees' leaf
 * cards double-sided and alpha-tested, and every material's colour space
 * right. The HIGHGROUND bakes come in with LOD levels as separate nodes;
 * `pickLod` chooses one.
 */
function prepare(root, name) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    const m = o.material;
    if (!m) return;
    if (m.alphaTest || m.transparent || /leaves|twigs/.test(m.name)) {
      m.alphaTest = Math.max(m.alphaTest || 0, 0.4);
      m.transparent = false;
      m.side = THREE.DoubleSide;
      m.depthWrite = true;
    }
    if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
    if (/baked/.test(m.name)) { m.roughness = Math.min(1, (m.roughness ?? 1)); m.metalness = 0; }
    if (name === 'mage' && m.map) {
      // The KayKit palette is crisp pixels; let it stay crisp.
      m.map.magFilter = THREE.NearestFilter;
      m.map.minFilter = THREE.LinearMipMapLinearFilter;
    }
  });
}

/**
 * A copy of a model's scene graph. Rigged models go through SkeletonUtils so
 * the bones are duplicated too; static ones through plain clone.
 */
export function clone(gltf, { rigged = false } = {}) {
  return rigged ? skelClone(gltf.scene) : gltf.scene.clone(true);
}

/**
 * The HIGHGROUND bakes carry three levels of detail as sibling nodes named
 * `<thing>_LOD0`, `_LOD1`, `_LOD2` (and `<thing>_cards_LODn` for the leaves).
 * Returns a group holding only the requested level, so a forest of a hundred
 * trees can use the cheap one and the tree beside your mage the full one.
 */
export function pickLod(gltf, lod = 0) {
  const g = new THREE.Group();
  const want = new RegExp(`_LOD${lod}$`);
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    // The mesh itself is named after its data; its PARENT node carries the LOD tag.
    const node = o.parent?.name?.match(/_LOD\d$/) ? o.parent : o;
    if (!want.test(node.name)) return;
    const m = o.clone();
    m.castShadow = true;
    m.receiveShadow = true;
    // The world matrix, so the copy sits exactly where the original did.
    o.updateWorldMatrix(true, false);
    m.matrixAutoUpdate = false;
    m.matrix.copy(o.matrixWorld);
    g.add(m);
  });
  // A model with no LOD tags at all comes through whole.
  if (!g.children.length) gltf.scene.traverse((o) => { if (o.isMesh) { const m = o.clone(); o.updateWorldMatrix(true, false); m.matrixAutoUpdate = false; m.matrix.copy(o.matrixWorld); g.add(m); } });
  return g;
}

/** Every mesh in a group as [{geometry, material, matrix}], for instancing. */
export function meshParts(group) {
  const out = [];
  group.updateMatrixWorld(true);
  group.traverse((o) => { if (o.isMesh) out.push({ geometry: o.geometry, material: o.material, matrix: o.matrixWorld.clone() }); });
  return out;
}
