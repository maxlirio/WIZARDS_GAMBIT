// The arena, in three dimensions.
//
// This file READS the field and never writes it. Everything it draws is a
// function of `state.arena` (the static ground) and `state.field` (the bodies),
// and the only thing it hands back is what the player clicked. Positions are
// tweened toward the engine's numbers each frame, so a push or a fall is seen
// travelling rather than teleporting -- but the engine's number is always the
// destination, never something the view accumulates.
//
// Engine millimetres -> scene metres: X = x, Z = y, Y = z (height).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { heightAt, propSpec, propOnBoard } from '../field/arena.js';

const MM = 1 / 1000;
const TEAM = [0x4fd2ff, 0xff5d5d];
const TEAM_CSS = ['#4fd2ff', '#ff6b6b'];

export function createArena(host, state, handlers = {}) {
  const a = state.arena;
  const W = a.w * MM, H = a.h * MM;

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);
  const labels = document.createElement('div');
  labels.className = 'labels3d';
  host.appendChild(labels);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07080c);
  scene.fog = new THREE.FogExp2(0x07080c, 0.035);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  // Behind your own mage, over the shoulder, looking down the arena at the
  // enemy: a board you can read whole, framed like a third-person shot.
  const HOME = { pos: new THREE.Vector3(-6.4, 11.4, H / 2), tgt: new THREE.Vector3(W / 2 + 0.1, -1.3, H / 2) };
  camera.position.copy(HOME.pos);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(HOME.tgt);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.44;
  controls.minDistance = 4;
  controls.maxDistance = 26;
  controls.update();

  /* ---------------------------------------------------------- light */
  scene.add(new THREE.HemisphereLight(0x5a6c99, 0x1a1208, 0.55));
  const key = new THREE.DirectionalLight(0xffd7a8, 2.1);
  key.position.set(W * 0.2, 14, -4);
  key.target.position.set(W / 2, 0, H / 2);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 1, far: 40 });
  key.shadow.bias = -0.0006;
  scene.add(key, key.target);
  const rim = new THREE.DirectionalLight(0x7aa0ff, 0.7);
  rim.position.set(W, 6, H + 8);
  scene.add(rim);

  /* ---------------------------------------------------------- ground */
  const STEPMM = 250;
  const nx = Math.round(a.w / STEPMM) + 1, ny = Math.round(a.h / STEPMM) + 1;
  const geo = new THREE.PlaneGeometry(W, H, nx - 1, ny - 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(W / 2, 0, H / 2);
  const pos = geo.attributes.position;
  const lo = Math.min(...a.hs), hi = Math.max(...a.hs);
  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k) / MM, y = pos.getZ(k) / MM;
    pos.setY(k, heightAt(a, Math.round(x), Math.round(y)) * MM);
  }
  geo.computeVertexNormals();
  const col = new Float32Array(pos.count * 3);
  const nrm = geo.attributes.normal;
  const c = new THREE.Color();
  for (let k = 0; k < pos.count; k++) {
    const h = pos.getY(k) / MM;
    const t = hi > lo ? (h - lo) / (hi - lo) : 0.5;
    const steep = 1 - nrm.getY(k);
    // Low ground is cold slate, high ground warm sandstone, faces dark rock.
    c.setRGB(0.20 + 0.34 * t, 0.19 + 0.27 * t, 0.21 + 0.17 * t);
    if (h < a.median - 200) c.lerp(new THREE.Color(0x1a1030), 0.55);
    c.multiplyScalar(1 - Math.min(0.65, steep * 1.3));
    col.set([c.r, c.g, c.b], k * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const groundMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: groundTexture(), roughness: 0.92, metalness: 0.04 });
  const ground = new THREE.Mesh(geo, groundMat);
  ground.receiveShadow = true;
  ground.castShadow = true;
  ground.userData.pick = { kind: 'ground' };
  scene.add(ground);

  // Anything sunk well below the median -- a chasm, a pit -- glows from
  // underneath, so a hole reads as a hazard rather than as a missing texture.
  if (lo < a.median - 500) {
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.02, H - 0.02),
      new THREE.MeshBasicMaterial({ color: 0x6a2cff, transparent: true, opacity: 0.55 }));
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(W / 2, lo * MM + 0.06, H / 2);
    scene.add(glow);
    // A handful of lights, spread along the low ground. Every point light
    // costs every lit fragment in the scene, so this is capped hard.
    const low = [];
    for (let k = 0; k < a.hs.length; k++) if (a.hs[k] <= lo + 100) low.push(k);
    for (let n = 0; n < Math.min(5, low.length); n++) {
      const k = low[Math.floor(((n + 0.5) / Math.min(5, low.length)) * low.length)];
      const l = new THREE.PointLight(0x8a4dff, 5, 5, 1.6);
      l.position.set((k % a.nx) * a.node * MM, lo * MM + 0.6, Math.floor(k / a.nx) * a.node * MM);
      scene.add(l);
    }
  }

  // A skirt down to the abyss, following the ground's own edge, so the arena
  // reads as a slab of rock and nothing beneath the surface shows at the sides.
  const skirtMat = new THREE.MeshStandardMaterial({ color: 0x15130f, roughness: 1, side: THREE.DoubleSide });
  const edge = (pts) => {
    const g = new THREE.BufferGeometry();
    const v = [], idx = [];
    pts.forEach(([x, y], k) => {
      v.push(x * MM, heightAt(a, x, y) * MM, y * MM, x * MM, lo * MM - 6, y * MM);
      if (k) idx.push(2 * k - 2, 2 * k - 1, 2 * k, 2 * k - 1, 2 * k + 1, 2 * k);
    });
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    scene.add(new THREE.Mesh(g, skirtMat));
  };
  const along = (n, f) => Array.from({ length: n }, (_, k) => f(k));
  edge(along(nx, (k) => [k * STEPMM, 0]));
  edge(along(nx, (k) => [k * STEPMM, a.h]));
  edge(along(ny, (k) => [0, k * STEPMM]));
  edge(along(ny, (k) => [a.w, k * STEPMM]));

  // A low parapet and gothic pylons with braziers. Scenery: nothing in the
  // engine knows these exist, and they stand outside the arena bounds.
  const stone = new THREE.MeshStandardMaterial({ color: 0x3b3833, roughness: 0.95 });
  const darkStone = new THREE.MeshStandardMaterial({ color: 0x22201d, roughness: 1 });
  const parapet = (x, z, w, d) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.45, d), stone);
    m.position.set(x, 0.2, z); m.castShadow = m.receiveShadow = true; scene.add(m);
  };
  parapet(W / 2, -0.2, W + 0.8, 0.4); parapet(W / 2, H + 0.2, W + 0.8, 0.4);
  parapet(-0.2, H / 2, 0.4, H); parapet(W + 0.2, H / 2, 0.4, H);
  const flames = [];
  const pylon = (x, z) => {
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.9), darkStone);
    base.position.y = 0.25;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.34, 3.4, 8), stone);
    shaft.position.y = 2.2;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.28, 0.35, 8), darkStone);
    cap.position.y = 4.05;
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.7, 6), darkStone);
    spike.position.y = 0.9; spike.position.x = 0;
    const fire = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffa040 }));
    fire.position.y = 4.4; fire.scale.y = 1.6;
    const light = new THREE.PointLight(0xff8a30, 6, 9, 1.6);
    light.position.y = 4.6;
    for (const m of [base, shaft, cap]) { m.castShadow = true; m.receiveShadow = true; }
    g.add(base, shaft, cap, fire, light);
    g.position.set(x, 0, z);
    scene.add(g);
    flames.push({ fire, light, seed: Math.random() * 10 });
  };
  for (const [x, z] of [[W + 1.2, -1.2], [W + 1.2, H + 1.2], [W / 2, -1.4], [W / 2, H + 1.4], [-1.6, -1.6], [-1.6, H + 1.6]]) pylon(x, z);

  // The abyss floor and distant ruins, swallowed by fog.
  const abyss = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x0b0a0d, roughness: 1 }));
  abyss.rotation.x = -Math.PI / 2; abyss.position.y = -7;
  scene.add(abyss);
  for (let i = 0; i < 26; i++) {
    const ang = (i / 26) * Math.PI * 2, r = 17 + (i * 7919 % 9);
    const h = 4 + (i * 104729 % 9);
    const m = new THREE.Mesh(new THREE.BoxGeometry(1.2 + (i % 3), h, 1.2), darkStone);
    m.position.set(W / 2 + Math.cos(ang) * r, -7 + h / 2, H / 2 + Math.sin(ang) * r);
    m.rotation.y = ang;
    scene.add(m);
  }

  // Spawn circles.
  a.spawns.forEach((s, p) => {
    const ring = new THREE.Mesh(new THREE.RingGeometry(s.r * MM - 0.06, s.r * MM, 48),
      new THREE.MeshBasicMaterial({ color: TEAM[p], transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(s.x * MM, heightAt(a, s.x, s.y) * MM + 0.015, s.y * MM);
    scene.add(ring);
    const inner = new THREE.Mesh(new THREE.RingGeometry(s.r * MM * 0.55, s.r * MM * 0.58, 4),
      new THREE.MeshBasicMaterial({ color: TEAM[p], transparent: true, opacity: 0.3, side: THREE.DoubleSide }));
    inner.rotation.x = -Math.PI / 2; inner.rotation.z = Math.PI / 4;
    inner.position.copy(ring.position);
    scene.add(inner);
  });

  /* ---------------------------------------------------------- props */
  const propMeshes = new Map();
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x6b645a, roughness: 0.9, flatShading: true });
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x57524a, roughness: 0.85 });
  const crystalMat = new THREE.MeshStandardMaterial({ color: 0x6fe3ff, emissive: 0x1b8fb8, emissiveIntensity: 1.2, roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.92, flatShading: true });
  const floatMat = new THREE.MeshStandardMaterial({ color: 0x5d5868, roughness: 0.85, flatShading: true });

  function makeProp(pr) {
    const spec = propSpec(pr.kind);
    const r = spec.r * MM, h = spec.h * MM;
    const g = new THREE.Group();
    let m;
    if (pr.kind === 'boulder') {
      m = new THREE.Mesh(new THREE.DodecahedronGeometry(1, 1), rockMat);
      jitter(m.geometry, 0.13, hashStr(pr.id));
      m.scale.set(r, h / 2, r * 0.9); m.position.y = h / 2;
    } else if (pr.kind === 'pillar') {
      m = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.78, r, h, 10), pillarMat);
      shaft.position.y = h / 2;
      const cap = new THREE.Mesh(new THREE.BoxGeometry(r * 2.1, 0.2, r * 2.1), pillarMat);
      cap.position.y = h - 0.1;
      const foot = new THREE.Mesh(new THREE.BoxGeometry(r * 2.2, 0.25, r * 2.2), pillarMat);
      foot.position.y = 0.12;
      m.add(shaft, cap, foot);
    } else if (pr.kind === 'shard') {
      m = new THREE.Group();
      const s = hashStr(pr.id);
      for (let i = 0; i < 3; i++) {
        const k = i === 0 ? 1 : 0.55;
        const cr = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), crystalMat);
        cr.scale.set(r * 0.6 * k, h / 2 * k, r * 0.6 * k);
        cr.position.set(i ? Math.cos(s + i * 2.1) * r * 0.7 : 0, h / 2 * k, i ? Math.sin(s + i * 2.1) * r * 0.7 : 0);
        cr.rotation.z = i ? (i === 1 ? 0.35 : -0.3) : 0;
        m.add(cr);
      }
      const glow = new THREE.PointLight(0x5fd8ff, 2.2, 3.5, 2);
      glow.position.y = h * 0.6;
      m.add(glow);
    } else if (pr.kind === 'wall') {
      m = new THREE.Group();
      const wallMat = new THREE.MeshStandardMaterial({ color: 0x625b50, roughness: 0.95, flatShading: true });
      const main = new THREE.Mesh(new THREE.BoxGeometry(r * 2, h, 0.45), wallMat);
      main.position.y = h / 2;
      const broken = new THREE.Mesh(new THREE.BoxGeometry(r * 0.7, h * 0.35, 0.5), wallMat);
      broken.position.set(r * 0.55, h + h * 0.17, 0);
      m.add(main, broken);
      m.rotation.y = (hashStr(pr.id) % 4) * 0.5;
    } else if (pr.kind === 'floater') {
      m = new THREE.Group();
      const top = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.85, h * 0.45, 9), floatMat);
      top.position.y = h * 0.78;
      const under = new THREE.Mesh(new THREE.ConeGeometry(r * 0.85, h * 1.4, 9), floatMat);
      under.rotation.x = Math.PI; under.position.y = h * 0.55 - h * 0.7 + h * 0.0;
      jitter(under.geometry, 0.08, hashStr(pr.id));
      const sigil = new THREE.Mesh(new THREE.RingGeometry(r * 0.5, r * 0.62, 6),
        new THREE.MeshBasicMaterial({ color: 0xb88bff, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
      sigil.rotation.x = Math.PI / 2; sigil.position.y = -h * 0.7;
      const glow = new THREE.PointLight(0xa070ff, 3, 4, 2);
      glow.position.y = -h * 0.4;
      m.add(top, under, sigil, glow);
      m.userData.bob = true;
    }
    m.traverse?.((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
    g.add(m);
    // An invisible hitbox for picking.
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(r, r, Math.max(h, 0.4), 8), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = Math.max(h, 0.4) / 2;
    hit.userData.pick = { kind: 'prop', id: pr.id };
    g.add(hit);
    g.userData.h = h;
    scene.add(g);
    return g;
  }

  /* ---------------------------------------------------------- units */
  const unitMeshes = new Map();

  function makeMage(owner) {
    const g = new THREE.Group();
    const cloth = new THREE.MeshStandardMaterial({ color: owner ? 0x5a1418 : 0x13314f, roughness: 0.8 });
    const trim = new THREE.MeshStandardMaterial({ color: 0xb08a4a, roughness: 0.4, metalness: 0.7 });
    const skin = new THREE.MeshStandardMaterial({ color: 0x8a6a55, roughness: 0.7 });
    const robe = new THREE.Mesh(new THREE.ConeGeometry(0.34, 1.25, 12, 1, true), cloth);
    robe.position.y = 0.62;
    const belt = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.03, 6, 16), trim);
    belt.rotation.x = Math.PI / 2; belt.position.y = 1.02;
    const chest = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.22, 0.42, 10), cloth);
    chest.position.y = 1.28;
    const pauldL = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), trim);
    pauldL.position.set(-0.2, 1.46, 0); pauldL.scale.y = 0.7;
    const pauldR = pauldL.clone(); pauldR.position.x = 0.2;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 10), skin);
    head.position.y = 1.62;
    const hood = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.42, 12), cloth);
    hood.position.y = 1.72;
    const staff = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.028, 1.95, 6), new THREE.MeshStandardMaterial({ color: 0x3a2716, roughness: 0.9 }));
    staff.position.set(0.32, 0.98, 0.06);
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 10), new THREE.MeshBasicMaterial({ color: TEAM[owner] }));
    orb.position.set(0.32, 2.0, 0.06);
    const orbLight = new THREE.PointLight(TEAM[owner], 2.5, 3.5, 2);
    orbLight.position.copy(orb.position);
    for (const m of [robe, belt, chest, pauldL, pauldR, head, hood, staff]) { m.castShadow = true; }
    g.add(robe, belt, chest, pauldL, pauldR, head, hood, staff, orb, orbLight);
    g.userData.orb = orb;
    return { g, height: 2.05 };
  }

  function makeGolem(owner, def) {
    const g = new THREE.Group();
    const s = def?.tier === 'A' ? 1.45 : def?.tier === 'B' ? 1.1 : 0.8;
    const rock = new THREE.MeshStandardMaterial({ color: def?.id === 'IRON_COLOSSUS' ? 0x55585e : 0x7a6a55, roughness: 0.9, flatShading: true, metalness: def?.id === 'IRON_COLOSSUS' ? 0.5 : 0 });
    const eye = new THREE.MeshBasicMaterial({ color: TEAM[owner] });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.6, 0.4), rock);
    body.position.y = 0.85; body.rotation.y = 0.05;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.24, 0.26), rock);
    head.position.y = 1.3;
    const e1 = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.02), eye);
    e1.position.set(-0.06, 1.32, 0.135);
    const e2 = e1.clone(); e2.position.x = 0.06;
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.07), eye);
    core.position.set(0, 0.9, 0.21);
    const armL = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.62, 0.2), rock);
    armL.position.set(-0.38, 0.78, 0); armL.rotation.z = 0.12;
    const armR = armL.clone(); armR.position.x = 0.38; armR.rotation.z = -0.12;
    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.55, 0.22), rock);
    legL.position.set(-0.14, 0.28, 0);
    const legR = legL.clone(); legR.position.x = 0.14;
    for (const m of [body, head, armL, armR, legL, legR]) m.castShadow = true;
    g.add(body, head, e1, e2, core, armL, armR, legL, legR);
    g.scale.setScalar(s);
    return { g, height: 1.45 * s };
  }

  function makeUnit(u) {
    const made = u.kind === 'mage' ? makeMage(u.owner) : makeGolem(u.owner, state.defs[u.def]);
    const root = new THREE.Group();
    root.add(made.g);
    const base = new THREE.Mesh(new THREE.RingGeometry(0.27, 0.34, 32),
      new THREE.MeshBasicMaterial({ color: TEAM[u.owner], transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
    base.rotation.x = -Math.PI / 2; base.position.y = 0.02;
    root.add(base);
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, made.height, 8), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = made.height / 2;
    hit.userData.pick = { kind: 'unit', id: u.id };
    root.add(hit);
    // Face the enemy end of the arena.
    made.g.rotation.y = u.owner === 0 ? Math.PI / 2 : -Math.PI / 2;
    const label = document.createElement('div');
    label.className = `ulabel p${u.owner}`;
    labels.appendChild(label);
    root.userData = { base, label, height: made.height, model: made.g };
    root.position.set(u.x * MM, u.z * MM, u.y * MM);
    scene.add(root);
    return root;
  }

  /* ---------------------------------------------------------- sync */
  let cur = state;
  function sync(s) {
    cur = s;
    const seen = new Set();
    for (const u of s.field.units) {
      if (u.dead) continue;
      seen.add(u.id);
      let m = unitMeshes.get(u.id);
      if (!m) { m = makeUnit(u); unitMeshes.set(u.id, m); }
      m.userData.target = new THREE.Vector3(u.x * MM, u.z * MM, u.y * MM);
      const name = handlers.unitLabel ? handlers.unitLabel(u) : u.kind === 'mage' ? 'Mage' : (s.defs[u.def]?.name || 'Golem');
      const pips = Array.from({ length: u.maxHp }, (_, i) => `<i class="${i < u.hp ? 'f' : ''}"></i>`).join('');
      m.userData.label.innerHTML = `<b>${name}</b><span class="hp">${pips}</span>${u.poison ? `<em>☠${u.poison}</em>` : ''}${u.acted && s.active === u.owner && s.phase === 'unit' ? '<em>done</em>' : ''}`;
      m.userData.label.classList.toggle('acted', !!u.acted && s.active === u.owner);
    }
    for (const [id, m] of unitMeshes) {
      if (!seen.has(id)) { scene.remove(m); m.userData.label.remove(); unitMeshes.delete(id); }
    }
    for (const pr of s.field.props) {
      let m = propMeshes.get(pr.id);
      if (!m) { m = makeProp(pr); propMeshes.set(pr.id, m); m.position.set(pr.x * MM, pr.z * MM, pr.y * MM); }
      m.userData.target = new THREE.Vector3(pr.x * MM, pr.z * MM, pr.y * MM);
      m.visible = propOnBoard(s, pr);
    }
  }

  /* ---------------------------------------------------------- markers */
  const markerGroup = new THREE.Group();
  scene.add(markerGroup);
  let markers = [];
  const highlights = new Map();   // unit id -> colour

  function clearMarkers() {
    for (const m of markers) { markerGroup.remove(m.obj); m.label?.remove(); }
    markers = [];
  }

  /**
   * Clickable spots on the ground. Each is {x, y, z (mm), label, data, from?}.
   * `from` draws a line from a unit to the spot -- a move preview.
   */
  function setMarkers(list, colour = 0x7fe0ff) {
    clearMarkers();
    for (const mk of list) {
      const g = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.26, 24),
        new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.35, depthWrite: false }));
      disc.rotation.x = -Math.PI / 2;
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.26, 0.32, 32),
        new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.6, 12), new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.y = 0.3;
      hit.userData.pick = { kind: 'marker', index: -1 };
      g.add(disc, ring, hit);
      g.position.set(mk.x * MM, mk.z * MM + 0.03, mk.y * MM);
      markerGroup.add(g);
      if (mk.from) {
        const pts = [];
        const A = new THREE.Vector3(mk.from.x * MM, mk.from.z * MM + 0.08, mk.from.y * MM);
        const B = g.position.clone().setY(g.position.y + 0.05);
        for (let i = 0; i <= 16; i++) {
          const t = i / 16;
          const p = A.clone().lerp(B, t);
          p.y += Math.sin(t * Math.PI) * 0.35;
          pts.push(p);
        }
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineDashedMaterial({ color: colour, dashSize: 0.12, gapSize: 0.08, transparent: true, opacity: 0.8 }));
        line.computeLineDistances();
        markerGroup.add(line);
        markers.push({ obj: line, data: null, isLine: true });
      }
      let label = null;
      if (mk.label) {
        label = document.createElement('div');
        label.className = 'mlabel';
        label.textContent = mk.label;
        labels.appendChild(label);
      }
      // The index is taken HERE, after any preview line was pushed: taken at
      // creation it pointed at the line, whose data is null, and every move
      // marker in the game silently did nothing when clicked.
      hit.userData.pick.index = markers.length;
      markers.push({ obj: g, data: mk.data, label, pos: g.position.clone(), ring });
    }
  }

  function highlightUnits(map) {
    highlights.clear();
    for (const [id, colour] of Object.entries(map || {})) highlights.set(Number(id), colour);
  }

  /* ---------------------------------------------------------- floating text */
  const floaters = [];
  function floatText(x, y, z, text, cls = '') {
    const el = document.createElement('div');
    el.className = `float3d ${cls}`;
    el.textContent = text;
    labels.appendChild(el);
    floaters.push({ el, p: new THREE.Vector3(x * MM, z * MM + 2.1, y * MM), t0: performance.now() });
  }
  function floatAtUnit(id, text, cls) {
    const m = unitMeshes.get(id);
    if (m) floaters.push({ el: Object.assign(document.createElement('div'), { className: `float3d ${cls || ''}`, textContent: text }), p: m.position.clone().setY(m.position.y + m.userData.height + 0.3), t0: performance.now() }), labels.appendChild(floaters.at(-1).el);
  }

  // A shockwave ring on the ground: a hit, a push, a fall.
  const pulses = [];
  function pulse(x, y, z, colour = 0xffffff, size = 1.2) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.28, 40),
      new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 1, side: THREE.DoubleSide, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x * MM, z * MM + 0.05, y * MM);
    scene.add(m);
    pulses.push({ m, t0: performance.now(), size });
  }
  function pulseUnit(id, colour, size) {
    const m = unitMeshes.get(id);
    if (m) pulse(m.position.x / MM, m.position.z / MM, m.position.y / MM, colour, size);
  }

  /* ---------------------------------------------------------- picking */
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return;
    const hit = pickAt(e.clientX, e.clientY);
    if (!hit) { handlers.onPickNothing?.(); return; }
    if (hit.kind === 'marker') handlers.onPickMarker?.(markers[hit.index]?.data);
    else if (hit.kind === 'unit') handlers.onPickUnit?.(hit.id);
    else if (hit.kind === 'prop') handlers.onPickProp?.(hit.id);
    else if (hit.kind === 'ground') handlers.onPickGround?.(hit.x, hit.y);
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    const hit = pickAt(e.clientX, e.clientY);
    renderer.domElement.style.cursor = hit && (hit.kind === 'marker' || (hit.kind === 'unit' && handlers.isPickable?.(hit))
      || (hit.kind === 'ground' && moveCircle && insideMove(hit.x, hit.y))) ? 'pointer' : '';
    handlers.onHover?.(hit);
  });

  function pickAt(cx, cy) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const objs = [];
    markerGroup.traverse((o) => { if (o.userData.pick) objs.push(o); });
    for (const m of unitMeshes.values()) m.traverse((o) => { if (o.userData.pick) objs.push(o); });
    for (const m of propMeshes.values()) if (m.visible) m.traverse((o) => { if (o.userData.pick) objs.push(o); });
    objs.push(ground);
    const hits = ray.intersectObjects(objs, false);
    // Markers win over the unit standing behind them; anything wins over the
    // bare ground.
    const mk = hits.find((h) => h.object.userData.pick.kind === 'marker');
    const solid = hits.find((h) => h.object.userData.pick.kind !== 'ground');
    const h = mk || solid || hits[0];
    if (!h) return null;
    if (h.object.userData.pick.kind === 'ground') {
      return { kind: 'ground', x: Math.round(h.point.x / MM), y: Math.round(h.point.z / MM) };
    }
    return h.object.userData.pick;
  }

  /* ---------------------------------------------------------- rings */
  // A ring drawn ON the terrain: sampled round the circle, each point lifted to
  // the ground height there, so a range reads true over a plateau or a pit.
  function terrainRing(cx, cy, r, colour, { opacity = 0.95, fill = 0.10, dashed = false } = {}) {
    const g = new THREE.Group();
    const pts = [];
    const n = Math.max(48, Math.round(r / 60));
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * Math.PI * 2;
      const x = cx + Math.cos(t) * r, y = cy + Math.sin(t) * r;
      const cxl = Math.min(a.w, Math.max(0, x)), cyl = Math.min(a.h, Math.max(0, y));
      pts.push(new THREE.Vector3(x * MM, heightAt(a, Math.round(cxl), Math.round(cyl)) * MM + 0.05, y * MM));
    }
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color: colour, dashSize: 0.18, gapSize: 0.1, transparent: true, opacity })
      : new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity });
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
    if (dashed) line.computeLineDistances();
    g.add(line);
    if (fill > 0) {
      const disc = new THREE.Mesh(new THREE.CircleGeometry(r * MM, 64),
        new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: fill, depthWrite: false, side: THREE.DoubleSide }));
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(cx * MM, heightAt(a, Math.round(Math.min(a.w, Math.max(0, cx))), Math.round(Math.min(a.h, Math.max(0, cy)))) * MM + 0.03, cy * MM);
      g.add(disc);
    }
    return g;
  }

  const rangeGroup = new THREE.Group();
  scene.add(rangeGroup);
  let rangeLabels = [];
  /** Range rings: [{x, y, r, label, colour}] in mm. */
  function setRanges(list) {
    rangeGroup.clear();
    for (const l of rangeLabels) l.el.remove();
    rangeLabels = [];
    for (const rg of list || []) {
      rangeGroup.add(terrainRing(rg.x, rg.y, rg.r, rg.colour ?? 0xffcf5a, { fill: 0.07, dashed: true }));
      if (rg.label) {
        const el = document.createElement('div');
        el.className = 'rlabel';
        el.textContent = rg.label;
        labels.appendChild(el);
        rangeLabels.push({ el, p: new THREE.Vector3(rg.x * MM, heightAt(a, rg.x, Math.max(0, rg.y - rg.r)) * MM, Math.max(0, rg.y - rg.r) * MM) });
      }
    }
  }

  // The move circle: where the selected unit may be told to walk. The ghost is
  // where it would actually END -- the engine's answer, walls and all.
  let moveCircle = null;
  const moveGroup = new THREE.Group();
  scene.add(moveGroup);
  const ghost = new THREE.Group();
  {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.3, 32),
      new THREE.MeshBasicMaterial({ color: 0x7fe0ff, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.22, 24),
      new THREE.MeshBasicMaterial({ color: 0x7fe0ff, transparent: true, opacity: 0.35, depthWrite: false }));
    dot.rotation.x = -Math.PI / 2;
    ghost.add(ring, dot);
    ghost.visible = false;
    scene.add(ghost);
  }
  let ghostLine = null;
  const insideMove = (x, y) => !!moveCircle && (x - moveCircle.x) ** 2 + (y - moveCircle.y) ** 2 <= moveCircle.r ** 2;
  function setMoveCircle(c) {
    moveGroup.clear();
    moveCircle = c;
    showGhost(null);
    if (!c) return;
    moveGroup.add(terrainRing(c.x, c.y, c.r, 0x7fe0ff, { fill: 0.12 }));
  }
  function showGhost(p, from) {
    if (ghostLine) { scene.remove(ghostLine); ghostLine = null; }
    if (!p) { ghost.visible = false; return; }
    ghost.visible = true;
    ghost.position.set(p.x * MM, p.z * MM + 0.04, p.y * MM);
    if (from) {
      const A = new THREE.Vector3(from.x * MM, from.z * MM + 0.08, from.y * MM);
      const B = ghost.position.clone().setY(ghost.position.y + 0.04);
      const pts = [];
      for (let i = 0; i <= 16; i++) { const t = i / 16; const q = A.clone().lerp(B, t); q.y += Math.sin(t * Math.PI) * 0.3; pts.push(q); }
      ghostLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineDashedMaterial({ color: 0x7fe0ff, dashSize: 0.12, gapSize: 0.08 }));
      ghostLine.computeLineDistances();
      scene.add(ghostLine);
    }
  }

  /* ---------------------------------------------------------- frame */
  const v = new THREE.Vector3();
  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = w + 'px';
    renderer.domElement.style.height = h + 'px';
    // The action tray covers the bottom of the stage, so the picture is
    // rendered as the lower part of a taller frame: the arena sits up out of
    // the way without the camera having to look somewhere else. The aspect is
    // the TALLER frame's -- given the visible one, the picture stretched.
    const lift = Math.min(130, h * 0.2);
    camera.aspect = w / (h + lift);
    camera.setViewOffset(w, h + lift, 0, lift, w, h);
    // A narrow stage needs the camera further back to keep all 9m in frame.
    camera.fov = camera.aspect < 1.0 ? 46 + (1.0 - camera.aspect) * 30 : 46;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(host);
  resize();

  function place(el, p, dy = 0) {
    v.copy(p); v.y += dy; v.project(camera);
    const w = host.clientWidth, h = host.clientHeight;
    const vis = v.z < 1 && v.x > -1.2 && v.x < 1.2;
    el.style.display = vis ? '' : 'none';
    el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const k = 1 - Math.pow(0.0008, dt);
    for (const m of unitMeshes.values()) {
      if (m.userData.target) {
        // A short hop when a unit travels, so a move reads as a move.
        const d = m.position.distanceTo(m.userData.target);
        m.position.lerp(m.userData.target, k);
        m.userData.model.position.y = Math.min(0.25, d * 0.12);
      }
      const hl = highlights.get([...unitMeshes.entries()].find(([, x]) => x === m)?.[0]);
      const base = m.userData.base;
      if (hl !== undefined) {
        base.material.color.setHex(hl);
        base.scale.setScalar(1.25 + Math.sin(now / 160) * 0.18);
      } else {
        base.scale.setScalar(1);
      }
      place(m.userData.label, m.position, m.userData.height + 0.35);
    }
    for (const [id, m] of unitMeshes) {
      if (!highlights.has(id)) {
        const u = cur.field.units.find((x) => x.id === id);
        if (u) m.userData.base.material.color.setHex(TEAM[u.owner]);
      }
      if (m.userData.model.userData.orb) m.userData.model.userData.orb.scale.setScalar(1 + Math.sin(now / 300 + id) * 0.15);
    }
    for (const m of propMeshes.values()) {
      if (m.userData.target) m.position.lerp(m.userData.target, k);
      const inner = m.children[0];
      if (inner?.userData.bob) inner.position.y = Math.sin(now / 900 + m.position.x) * 0.06;
    }
    for (const mk of markers) {
      if (mk.isLine) continue;
      mk.ring.scale.setScalar(1 + Math.sin(now / 220) * 0.08);
      if (mk.label) place(mk.label, mk.pos, 0.55);
    }
    for (const l of rangeLabels) place(l.el, l.p, 0.2);
    if (ghost.visible) ghost.children[0].scale.setScalar(1 + Math.sin(now / 200) * 0.1);
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      const t = (now - f.t0) / 1400;
      if (t >= 1) { f.el.remove(); floaters.splice(i, 1); continue; }
      place(f.el, f.p, t * 0.9);
      f.el.style.opacity = String(1 - t * t);
    }
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      const t = (now - p.t0) / 700;
      if (t >= 1) { scene.remove(p.m); pulses.splice(i, 1); continue; }
      p.m.scale.setScalar(1 + t * p.size * 4);
      p.m.material.opacity = 1 - t;
    }
    for (const f of flames) {
      const n = Math.sin(now / 90 + f.seed) * 0.5 + Math.sin(now / 37 + f.seed * 3) * 0.3;
      f.light.intensity = 6 + n * 1.5;
      f.fire.scale.set(1 + n * 0.08, 1.6 + n * 0.2, 1 + n * 0.08);
    }
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  sync(state);
  requestAnimationFrame(frame);

  return {
    sync, setMarkers, clearMarkers, highlightUnits, floatText, floatAtUnit, pulse, pulseUnit,
    setRanges, setMoveCircle, showGhost, insideMove: (x, y) => insideMove(x, y),
    camera, controls, renderer,
    project(x, y, z) {
      v.set(x * MM, z * MM, y * MM).project(camera);
      return [((v.x + 1) / 2) * host.clientWidth, ((1 - v.y) / 2) * host.clientHeight];
    },
    /** Screen positions of the clickable markers, for a harness to click. */
    markerScreens() {
      return markers.filter((m) => !m.isLine).map((m) => {
        v.copy(m.pos).project(camera);
        return [((v.x + 1) / 2) * host.clientWidth, ((1 - v.y) / 2) * host.clientHeight];
      });
    },
    home() { camera.position.copy(HOME.pos); controls.target.copy(HOME.tgt); },
    dispose() { renderer.dispose(); host.innerHTML = ''; },
  };
}

/* ------------------------------------------------------------ helpers */

function hashStr(s) { let h = 7; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h); }

function jitter(geo, amt, seed) {
  const p = geo.attributes.position;
  let s = seed || 1;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  const key = new Map();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    if (!key.has(k)) key.set(k, 1 + rnd() * amt * 2);
    const f = key.get(k);
    p.setXYZ(i, p.getX(i) * f, p.getY(i) * f, p.getZ(i) * f);
  }
  geo.computeVertexNormals();
}

/** Flagstone texture with a faint metre grid, so distance is legible. */
function groundTexture() {
  const cv = document.createElement('canvas');
  cv.width = 1536; cv.height = 1152;
  const g = cv.getContext('2d');
  g.fillStyle = '#9a958c';
  g.fillRect(0, 0, cv.width, cv.height);
  let s = 12345;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  // Flagstones: half-metre slabs with jittered tone.
  const slab = 64;
  for (let y = 0; y < cv.height; y += slab) {
    const off = (y / slab) % 2 ? slab / 2 : 0;
    for (let x = -off; x < cv.width; x += slab) {
      const t = 120 + rnd() * 60;
      g.fillStyle = `rgb(${t},${t - 4},${t - 10})`;
      g.fillRect(x + 2, y + 2, slab - 4, slab - 4);
    }
  }
  for (let i = 0; i < 9000; i++) {
    const t = rnd() * 255;
    g.fillStyle = `rgba(${t},${t},${t},0.05)`;
    g.fillRect(rnd() * cv.width, rnd() * cv.height, 2 + rnd() * 3, 2 + rnd() * 3);
  }
  // The metre grid: the board-game half of the look.
  g.strokeStyle = 'rgba(210,190,140,0.55)';
  g.lineWidth = 2;
  for (let x = 0; x <= cv.width; x += 128) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, cv.height); g.stroke(); }
  for (let y = 0; y <= cv.height; y += 128) { g.beginPath(); g.moveTo(0, y); g.lineTo(cv.width, y); g.stroke(); }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export { TEAM_CSS };
