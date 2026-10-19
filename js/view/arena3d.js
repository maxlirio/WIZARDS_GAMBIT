// The battlefield, in three dimensions.
//
// This file READS the field and never writes it. Everything it draws is a
// function of `state.arena` (the static ground) and `state.field` (the bodies),
// and the only thing it hands back is what the player clicked. Bodies travel
// toward the engine's numbers each frame, so a push or a fall is seen
// happening rather than teleporting -- but the engine's number is always the
// destination, never something the view accumulates.
//
// Engine millimetres -> scene metres: X = x, Z = y, Y = z (height).
//
// The world beyond the ward, the actors and the effects live in their own
// files; this one owns the camera, the picking, the markers and rings, and the
// mapping from "the engine says X happened" to "show X".

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { heightAt, propSpec, propOnBoard, propBurning } from '../field/arena.js';
import { loadAll, pickLod } from './assets.js';
import { buildWorld, menhir } from './world.js';
import { createPropFactory } from './props.js';
import { createFx } from './fx.js';
import { makeMageActor } from './mage.js';
import { makeGolemActor } from './golems.js';

const MM = 1 / 1000;
const TEAM = [0x4fd2ff, 0xff5d5d];
const TEAM_DARK = [0x1d4e78, 0x6a1a1a];
const TEAM_CSS = ['#4fd2ff', '#ff6b6b'];
export const SCHOOL_HEX = { red: 0xff6a52, blue: 0x52b6ff, green: 0x5ee68f, purple: 0xc98bff, gold: 0xffcf5a, grey: 0xc3cad6 };

export function createArena(host, state, handlers = {}) {
  const a = state.arena;
  const W = a.w * MM, H = a.h * MM;
  const quality = handlers.quality || 'high';

  const renderer = new THREE.WebGLRenderer({ antialias: quality !== 'high', preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  // A Retina display at full ratio is four times the pixels of a 1x one and
  // bloom, shadows and the sky all scale with it: 1.5 keeps the edges crisp
  // and the frame time sane. Low quality renders at 1x.
  renderer.setPixelRatio(Math.min(quality === 'low' ? 1 : quality === 'medium' ? 1.25 : 1.5, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);
  const labels = document.createElement('div');
  labels.className = 'labels3d';
  host.appendChild(labels);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fa6c4);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.2, 400);
  // Seat 0 looks along +x from the west end; seat 1 is the same view from the
  // east end, so each player sees their own mage nearest the camera.
  const seat = handlers.seat || 0;
  const HOME = seat === 0
    ? { pos: new THREE.Vector3(-7.6, 11.4, H / 2 + 0.01), tgt: new THREE.Vector3(W / 2 + 0.8, 0.2, H / 2) }
    : { pos: new THREE.Vector3(W + 7.6, 11.4, H / 2 + 0.01), tgt: new THREE.Vector3(W / 2 - 0.8, 0.2, H / 2) };
  camera.position.copy(HOME.pos);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(HOME.tgt);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.46;
  controls.minPolarAngle = Math.PI * 0.08;
  controls.minDistance = 4;
  controls.maxDistance = 34;
  controls.enablePan = true;
  controls.panSpeed = 0.6;
  controls.update();

  const fx = createFx(scene, { quality });

  /* ---------------------------------------------------------- post */
  let composer = null;
  if (quality !== 'low') {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.38, 0.55, 0.88);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
  }

  /* ---------------------------------------------------------- loading */
  let world = null;
  let gltfs = null;
  let ready = false;
  const whenReady = [];
  const loading = document.createElement('div');
  loading.className = 'loading3d';
  loading.innerHTML = '<div class="lbar"><i></i></div><span>Raising the battlefield…</span>';
  host.appendChild(loading);
  const readyPromise = loadAll((p) => { loading.querySelector('i').style.width = `${Math.round(p * 100)}%`; }).then((g) => {
    gltfs = g;
    world = buildWorld(scene, renderer, a, a.seed, gltfs, { quality });
    makeProp = createPropFactory({ gltfs, quality });
    ready = true;
    loading.classList.add('out');
    setTimeout(() => loading.remove(), 600);
    for (const f of whenReady) f();
    whenReady.length = 0;
  }).catch((e) => { console.error(e); loading.innerHTML = `<span>Could not load the battlefield: ${e.message}</span>`; });

  // Ground height anywhere: the engine's inside the ward, the landscape's outside.
  const groundY = (x, y) => (world ? world.heightAt(x * MM, y * MM) : heightAt(a, Math.round(Math.min(a.w, Math.max(0, x))), Math.round(Math.min(a.h, Math.max(0, y)))) * MM);

  /* ---------------------------------------------------------- spawn circles */
  const spawnRings = [];
  a.spawns.forEach((s, p) => {
    const ring = new THREE.Mesh(new THREE.RingGeometry(s.r * MM - 0.05, s.r * MM, 64),
      new THREE.MeshBasicMaterial({ color: TEAM[p], transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(s.x * MM, heightAt(a, s.x, s.y) * MM + 0.02, s.y * MM);
    scene.add(ring);
    const sig = new THREE.Mesh(new THREE.RingGeometry(s.r * MM * 0.5, s.r * MM * 0.54, 6),
      new THREE.MeshBasicMaterial({ color: TEAM[p], transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }));
    sig.rotation.x = -Math.PI / 2; sig.rotation.z = Math.PI / 6;
    sig.position.copy(ring.position);
    scene.add(sig);
    spawnRings.push(sig);
  });

  /* ---------------------------------------------------------- props */
  const propMeshes = new Map();
  let makeProp = null;
  const charMat = new THREE.MeshStandardMaterial({ color: 0x120e0b, roughness: 1 });
  /* ---------------------------------------------------------- units */
  const actors = new Map();     // unit id -> {actor, label, unit}
  const dying = [];

  function makeUnitActor(u) {
    const actor = u.kind === 'mage'
      ? makeMageActor({ team: TEAM[u.owner], teamDark: TEAM_DARK[u.owner] })
      : makeGolemActor(gltfs, u.def, { team: TEAM[u.owner] });
    const base = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.37, 40),
      new THREE.MeshBasicMaterial({ color: TEAM[u.owner], transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
    base.rotation.x = -Math.PI / 2; base.position.y = 0.03;
    actor.root.add(base);
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, actor.height, 8), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = actor.height / 2;
    hit.userData.pick = { kind: 'unit', id: u.id };
    actor.root.add(hit);
    actor.root.position.set(u.x * MM, u.z * MM, u.y * MM);
    actor.facing = actor.facingTarget = u.owner === 0 ? Math.PI / 2 : -Math.PI / 2;
    const label = document.createElement('div');
    label.className = `ulabel p${u.owner}`;
    labels.appendChild(label);
    scene.add(actor.root);
    return { actor, base, label, unit: u, target: new THREE.Vector3(u.x * MM, u.z * MM, u.y * MM), vy: 0, airborne: false };
  }

  /* ---------------------------------------------------------- sync */
  let cur = state;
  function sync(s) {
    cur = s;
    if (!ready) { whenReady.push(() => sync(cur)); return; }
    const seen = new Set();
    for (const u of s.field.units) {
      let rec = actors.get(u.id);
      if (u.dead) {
        if (rec && !rec.actor.dead) {
          rec.actor.die();
          const kept = rec;
          actors.delete(u.id);
          dying.push({ rec: kept, t: 0 });
          kept.label.classList.add('gone');
        }
        continue;
      }
      seen.add(u.id);
      if (!rec) {
        // A dead actor coming back is a respawn; a brand-new one a summon.
        const back = dying.find((d) => d.rec.unit.id === u.id);
        if (back) { dying.splice(dying.indexOf(back), 1); rec = back.rec; rec.actor.revive(); rec.label.classList.remove('gone'); rec.actor.root.position.set(u.x * MM, u.z * MM, u.y * MM); fx.sigil(u.x * MM, u.z * MM, u.y * MM, TEAM[u.owner], { dur: 1.4, r: 1.1 }); }
        else { rec = makeUnitActor(u); if (u.kind === 'golem') { rec.actor.rise?.(); fx.dust(u.x * MM, u.z * MM, u.y * MM, { n: 26, size: 0.6 }); } }
        actors.set(u.id, rec);
      }
      rec.unit = u;
      rec.target.set(u.x * MM, u.z * MM, u.y * MM);
      const name = handlers.unitLabel ? handlers.unitLabel(u) : u.kind === 'mage' ? 'Mage' : (s.defs[u.def]?.name || 'Golem');
      const pips = Array.from({ length: u.maxHp }, (_, i) => `<i class="${i < u.hp ? 'f' : ''}"></i>`).join('');
      const html = `<b>${name}</b><span class="hp">${pips}</span>${u.poison ? `<em class="poi">☠${u.poison}</em>` : ''}${u.acted && s.active === u.owner && s.phase === 'unit' ? '<em>done</em>' : ''}`;
      if (rec.label.innerHTML !== html) rec.label.innerHTML = html;
      rec.label.classList.toggle('acted', !!u.acted && s.active === u.owner);
    }
    for (const [id, rec] of actors) {
      if (!seen.has(id)) { scene.remove(rec.actor.root); rec.label.remove(); rec.actor.dispose(); actors.delete(id); }
    }
    for (const pr of s.field.props) {
      let m = propMeshes.get(pr.id);
      if (!m) {
        m = makeProp(pr);
        scene.add(m);
        propMeshes.set(pr.id, m);
        m.position.set(pr.x * MM, pr.z * MM, pr.y * MM);
        if (pr.raised) { m.scale.y = 0.01; fx.tween(0.7, (t) => { m.scale.y = 0.01 + fx.ease.out(t) * 0.99; }); fx.dust(pr.x * MM, pr.z * MM, pr.y * MM, { n: 30, size: 0.8 }); fx.shake(0.05, 0.4); }
      }
      m.userData.target = new THREE.Vector3(pr.x * MM, pr.z * MM, pr.y * MM);
      const on = propOnBoard(s, pr);
      if (m.visible && !on && pr.destroyed && !m.userData.shattered) {
        m.userData.shattered = true;
        fx.debris(pr.x * MM, pr.z * MM, pr.y * MM, { n: pr.kind === 'shard' ? 8 : 12, colour: pr.kind === 'shard' ? 0x7fdcff : pr.kind === 'tree' ? 0x2a1d12 : 0x6b6358, size: m.userData.r * 0.45, spread: m.userData.r, up: 3 + m.userData.h });
        fx.shake(0.06, 0.35);
        fx.unburn(pr.id);
        if (pr.kind === 'tree') {
          // A burnt tree leaves a charred stump.
          const stump = menhir(0.55, 0.22, charMat, hashStr(pr.id));
          stump.position.copy(m.position);
          scene.add(stump);
          stumps.push(stump);
        }
      }
      m.visible = on;
      // Fire.
      const burning = propBurning(s, pr);
      if (burning && !m.userData.burning) {
        m.userData.burning = true;
        fx.burn(pr.id, pr.x * MM, pr.z * MM, pr.y * MM, m.userData.r * 0.9, m.userData.h, { rate: 1 });
        fx.flash(pr.x * MM, pr.z * MM + 1, pr.y * MM, 0xff8a30, 14, 0.5, 6);
        m.userData.setBurning?.(true);
      } else if (!burning && m.userData.burning) {
        m.userData.burning = false;
        fx.unburn(pr.id);
        m.userData.setBurning?.(false);
      }
      // Cracks, leans and dimming glows as the hit points go.
      const maxHp = propSpec(pr.kind).hp;
      const dmg = maxHp > 0 ? 1 - Math.max(0, pr.hp) / maxHp : 0;
      if (m.userData.damage !== dmg) { m.userData.damage = dmg; m.userData.setDamage?.(dmg); }
      if (pr.kind === 'floater' || pr.levitated) {
        if (!m.userData.lev) { m.userData.lev = true; fx.levitating(pr.id + ':lev', pr.x * MM, pr.z * MM - m.userData.h * 0.9, pr.y * MM, m.userData.r); }
      }
    }
  }
  const stumps = [];

  /* ---------------------------------------------------------- markers */
  const markerGroup = new THREE.Group();
  scene.add(markerGroup);
  let markers = [];
  const highlights = new Map();

  function clearMarkers() {
    for (const m of markers) { markerGroup.remove(m.obj); m.label?.remove(); }
    markers = [];
  }

  function setMarkers(list, colour = 0x7fe0ff) {
    clearMarkers();
    for (const mk of list) {
      const g = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.3, 24),
        new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.3, depthWrite: false }));
      disc.rotation.x = -Math.PI / 2;
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.37, 32),
        new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.8, 12), new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.y = 0.4;
      hit.userData.pick = { kind: 'marker', index: -1 };
      g.add(disc, ring, hit);
      g.position.set(mk.x * MM, (mk.z ?? groundY(mk.x, mk.y) / MM) * MM + 0.04, mk.y * MM);
      markerGroup.add(g);
      let label = null;
      if (mk.label) {
        label = document.createElement('div');
        label.className = 'mlabel';
        label.textContent = mk.label;
        labels.appendChild(label);
      }
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
    const rec = actors.get(id) || dying.find((d) => d.rec.unit.id === id)?.rec;
    if (!rec) return;
    const el = Object.assign(document.createElement('div'), { className: `float3d ${cls || ''}`, textContent: text });
    labels.appendChild(el);
    floaters.push({ el, p: rec.actor.root.position.clone().setY(rec.actor.root.position.y + rec.actor.height + 0.3), t0: performance.now() });
  }

  function pulse(x, y, z, colour = 0xffffff, size = 1.2) { fx.ring(x * MM, z * MM, y * MM, size * 1.6, colour, { dur: 0.6 }); }
  function pulseUnit(id, colour, size) {
    const rec = actors.get(id);
    if (rec) fx.ring(rec.actor.root.position.x, rec.actor.root.position.y, rec.actor.root.position.z, (size || 1) * 1.4, colour, { dur: 0.55 });
  }

  /* ---------------------------------------------------------- cues */
  // What the engine's notes become. main.js decides WHEN; these decide HOW.
  const unitPos = (id) => { const rec = actors.get(id) || dying.find((d) => d.rec.unit.id === id)?.rec; return rec ? rec.actor.root.position.clone() : null; };
  const unitTop = (id) => { const rec = actors.get(id); const p = unitPos(id); if (p && rec) p.y += rec.actor.height * 0.55; return p; };
  const mageOf = (p) => [...actors.values()].find((r) => r.unit.owner === p && r.unit.kind === 'mage');

  const cues = {
    /** A spell resolving at the caster. */
    cast(p, colour, { big = false } = {}) {
      const m = mageOf(p);
      if (!m) return;
      const pos = m.actor.root.position;
      fx.sigil(pos.x, pos.y, pos.z, colour, { dur: big ? 1.6 : 1.1, r: big ? 1.3 : 0.9 });
      m.actor.cast(big ? 'raise' : 'shoot');
    },
    /** A bolt from the caster's hand to a unit. `onArrive` runs when it lands. */
    bolt(p, targetId, { element = 'fire', colour = null, onArrive = null, big = false } = {}) {
      const m = mageOf(p);
      const to = unitTop(targetId);
      if (!to) { onArrive?.(); return; }
      const from = m ? m.actor.handPoint() : to.clone().add(new THREE.Vector3(0, 3, 0));
      if (m) m.actor.lookAt(to.x, to.z);
      const col = colour ?? (element === 'fire' ? 0xff8a2a : element === 'lightning' ? 0xbfe8ff : element === 'force' ? 0x9fd8ff : 0xc98bff);
      if (element === 'lightning') { fx.lightning(from, to, { colour: col }); onArrive?.(); return; }
      fx.bolt(from, to, { colour: col, dur: big ? 0.55 : 0.4, size: big ? 0.3 : 0.18, trail: element === 'fire' ? 'fire' : 'soft', onArrive: () => {
        if (element === 'fire') fx.explosion(to.x, to.y - 0.6, to.z, { r: big ? 1.4 : 0.7 });
        else { fx.flash(to.x, to.y, to.z, col, 10, 0.3, 5); fx.ring(to.x, to.y - 0.6, to.z, 1.2, col, { dur: 0.4 }); }
        onArrive?.();
      } });
    },
    lightning(fromId, toId) {
      const a = fromId !== null && fromId !== undefined ? unitTop(fromId) : null;
      const b = unitTop(toId);
      if (!b) return;
      fx.lightning(a || b.clone().add(new THREE.Vector3(0, 4, 0)), b);
    },
    hit(id, amount, cause = 'spell') {
      const rec = actors.get(id);
      if (!rec) return;
      // The body reacts to WHAT hit it: a flinch, a flail of burning robes, a
      // stiff spasm, or being slammed flat.
      const kind = cause === 'fire' ? 'fire' : cause === 'lightning' ? 'lightning' : cause === 'crush' || cause === 'rock' ? 'crush' : 'blow';
      rec.actor.hit(kind);
      const p = rec.actor.root.position;
      const col = cause === 'fire' ? 0xff7a20 : cause === 'lightning' ? 0xb8ecff : cause === 'poison' ? 0x7fe04a : cause === 'fall' || cause === 'crush' || cause === 'rock' ? 0xd9c9a8 : 0xff4040;
      fx.pools.sparks.emit({ x: p.x, y: p.y + rec.actor.height * 0.5, z: p.z, n: 14, spread: 0.2, vspread: 3, vy: 1.5, life: 0.5, size: 0.1, sizeEnd: 0.02, color: 0xffffff, colorEnd: col, gravity: -8 });
      floatAtUnit(id, `−${amount}`, cause === 'fire' ? 'dmg fire' : 'dmg');
      if (cause === 'fall' || cause === 'crush' || cause === 'rock') fx.shake(0.05, 0.3);
    },
    heal(id, amount) { const p = unitPos(id); if (p) fx.motes(p.x, p.y, p.z, 0x6cf09a, { n: 28 }); floatAtUnit(id, `+${amount}`, 'heal'); },
    poison(id) { const p = unitPos(id); if (p) fx.motes(p.x, p.y + 1.2, p.z, 0x86e03a, { n: 18, up: 0.6, size: 0.18, drip: true }); },
    kill(id) {
      const p = unitPos(id);
      if (p) { fx.motes(p.x, p.y, p.z, 0xffffff, { n: 40, up: 2.2, r: 0.5, life: 1.8, size: 0.16 }); fx.flash(p.x, p.y + 1, p.z, 0xffffff, 10, 0.5, 6); }
      floatAtUnit(id, 'SLAIN', 'kill');
    },
    strike(fromId, toId) {
      const f = actors.get(fromId), t = unitPos(toId);
      if (f && t) { f.actor.lookAt(t.x, t.z); f.actor.strike(); }
    },
    push(id, body, mm, from) {
      if (body === 'unit') { const rec = actors.get(id); if (rec) { if (rec.actor.shove) rec.actor.shove(); else rec.actor.hit(); rec.pushed = true; } }
      const p = body === 'unit' ? unitPos(id) : propMeshes.get(id)?.position.clone();
      if (p) fx.dust(p.x, p.y, p.z, { n: 14, size: 0.45 });
    },
    fall(id, drop) {
      const rec = actors.get(id);
      if (rec && drop > 300) floatAtUnit(id, `fell ${(drop / 1000).toFixed(1)}m`, 'fall');
    },
    hurl(id, mm) {
      const rec = actors.get(id);
      if (!rec) return;
      rec.actor.jump();
      const h = mm * MM;
      rec.airborne = true;
      fx.tween(0.95, (t) => { rec.airY = Math.sin(t * Math.PI) * h; }, () => {
        rec.airY = 0; rec.airborne = false;
        const p = rec.actor.root.position;
        fx.dust(p.x, p.y, p.z, { n: 30, size: 0.7 }); fx.ring(p.x, p.y, p.z, 1.6, 0xd9c9a8, { dur: 0.5 }); fx.shake(0.08, 0.35);
      });
      const p = rec.actor.root.position;
      fx.motes(p.x, p.y, p.z, 0xb98bff, { n: 24, up: 3, r: 0.4 });
    },
    dropRock(propId, from, to, ontoId) {
      const m = propMeshes.get(propId);
      if (!m) return;
      const A = new THREE.Vector3(from.x * MM, m.position.y, from.y * MM);
      const B = new THREE.Vector3(to.x * MM, groundY(to.x, to.y), to.y * MM);
      m.userData.flying = true;
      fx.levitating(propId + ':fly', A.x, A.y, A.z, m.userData.r);
      fx.tween(1.1, (t) => {
        const k = t < 0.45 ? t / 0.45 : 1;
        const lift = t < 0.45 ? fx.ease.out(k) * 3.2 : 3.2 * (1 - fx.ease.in((t - 0.45) / 0.55));
        m.position.lerpVectors(A, B, t < 0.45 ? 0 : fx.ease.inOut((t - 0.45) / 0.55));
        m.position.y = (t < 0.45 ? A.y : B.y) + lift;
        m.rotation.y += 0.02;
        fx.moveEmitter(propId + ':fly', m.position.x, m.position.y - m.userData.h * 0.5, m.position.z);
      }, () => {
        m.userData.flying = false;
        fx.unburn(propId + ':fly');
        fx.dust(B.x, B.y, B.z, { n: 36, size: 0.9, colour: 0x8a7b62 });
        fx.ring(B.x, B.y, B.z, 2.2, 0xd9c9a8, { dur: 0.5, width: 0.15 });
        fx.shake(0.14, 0.45);
        const rec = actors.get(ontoId);
        if (rec) rec.actor.hit('crush');
      });
    },
    swap(aId, bId) {
      for (const id of [aId, bId]) { const p = unitPos(id); if (p) { fx.sigil(p.x, p.y, p.z, 0x52b6ff, { dur: 0.9, r: 0.8 }); fx.motes(p.x, p.y, p.z, 0x9fd8ff, { n: 30, up: 2.5 }); } }
    },
    levitate(propId, mm) {
      const m = propMeshes.get(propId);
      if (!m) return;
      fx.motes(m.position.x, m.position.y, m.position.z, 0xb98bff, { n: 30, up: 1.2, r: m.userData.r });
      fx.levitating(propId + ':lev', m.position.x, m.position.y - 0.1, m.position.z, m.userData.r);
      m.userData.lev = true;
    },
    terrainRemoved(propId) {
      const m = propMeshes.get(propId);
      if (m) { fx.motes(m.position.x, m.position.y, m.position.z, 0xc98bff, { n: 40, up: 2, r: m.userData.r, size: 0.2 }); fx.flash(m.position.x, m.position.y + 1, m.position.z, 0xc98bff, 10, 0.4, 6); }
    },
    ignite(propId) {
      const m = propMeshes.get(propId);
      if (m) fx.explosion(m.position.x, m.position.y, m.position.z, { r: 0.6 });
    },
    propHit(propId, amount) {
      const m = propMeshes.get(propId);
      if (!m) return;
      fx.debris(m.position.x, m.position.y + m.userData.h * 0.4, m.position.z, { n: 3, colour: m.userData.kind === 'shard' ? 0x7fdcff : 0x6b6358, size: 0.08, spread: m.userData.r, up: 2 });
      const inner = m.userData.inner;
      fx.tween(0.35, (t) => { const k = Math.sin(t * Math.PI * 3) * (1 - t) * 0.06; inner.rotation.z = k; }, () => { inner.rotation.z = 0; });
    },
    nova(p, r, colour = 0xffb347) {
      const m = mageOf(p);
      if (!m) return;
      const pos = m.actor.root.position;
      fx.ring(pos.x, pos.y, pos.z, r * MM, colour, { dur: 0.7, width: 0.08 });
      fx.dust(pos.x, pos.y, pos.z, { n: 40, size: 0.7, spread: 0.8, up: 1.5 });
      fx.flash(pos.x, pos.y + 1, pos.z, colour, 24, 0.4, r * MM * 1.5);
      m.actor.cast('raise');
      fx.shake(0.07, 0.4);
    },
    quake(p, r) {
      const m = mageOf(p);
      if (!m) return;
      const pos = m.actor.root.position;
      fx.quake(pos.x, pos.y, pos.z, { r: r * MM });
      m.actor.cast('raise');
    },
    summon(id) { const p = unitPos(id); if (p) { fx.sigil(p.x, p.y, p.z, 0xe0a46a, { dur: 1.2, r: 0.9 }); } const m = mageOf(actors.get(id)?.unit.owner ?? 0); m?.actor.summon(); },
    score(p) { const m = mageOf(p); if (m) { const pos = m.actor.root.position; fx.burst(pos.x, pos.y + 0.5, pos.z, 0xffcf5a, { n: 50, r: 0.6, up: 2.5 }); fx.flash(pos.x, pos.y + 1.5, pos.z, 0xffcf5a, 14, 0.6, 7); } },
    /** A link between two spells' casters: Spell Splice, Confluence, keyword copies. */
    link(p, colour = 0xc98bff) { const m = mageOf(p); if (m) { const a = m.actor.handPoint(); fx.beam(a, a.clone().add(new THREE.Vector3(0, 1.6, 0)), colour, { dur: 0.6, width: 0.1 }); } },
    cheer(p) { mageOf(p)?.actor.cheer(); },
    fireTick(id) { cues.hit(id, 1, 'fire'); },
  };

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
    for (const rec of actors.values()) rec.actor.root.traverse((o) => { if (o.userData.pick) objs.push(o); });
    for (const m of propMeshes.values()) if (m.visible) m.traverse((o) => { if (o.userData.pick) objs.push(o); });
    if (world) objs.push(world.terrain);
    const hits = ray.intersectObjects(objs, false);
    const mk = hits.find((h) => h.object.userData.pick?.kind === 'marker');
    const solid = hits.find((h) => h.object.userData.pick && h.object.userData.pick.kind !== 'ground');
    const h = mk || solid || hits[0];
    if (!h) return null;
    if (h.object.userData.pick.kind === 'ground') {
      return { kind: 'ground', x: Math.round(h.point.x / MM), y: Math.round(h.point.z / MM) };
    }
    return h.object.userData.pick;
  }

  /* ---------------------------------------------------------- rings */
  function terrainRing(cx, cy, r, colour, { opacity = 0.95, fill = 0.10, dashed = false } = {}) {
    const g = new THREE.Group();
    const pts = [];
    const n = Math.max(48, Math.round(r / 60));
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * Math.PI * 2;
      const x = cx + Math.cos(t) * r, y = cy + Math.sin(t) * r;
      pts.push(new THREE.Vector3(x * MM, groundY(x, y) + 0.06, y * MM));
    }
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color: colour, dashSize: 0.18, gapSize: 0.1, transparent: true, opacity })
      : new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity });
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
    if (dashed) line.computeLineDistances();
    g.add(line);
    if (fill > 0) {
      // A filled disc draped on the ground: a fan of triangles, each vertex at its own ground height.
      const v = [cx * MM, groundY(cx, cy) + 0.04, cy * MM];
      const idx = [];
      for (let i = 0; i <= n; i++) { const p = pts[i]; v.push(p.x, p.y - 0.02, p.z); if (i) idx.push(0, i, i + 1); }
      const dg = new THREE.BufferGeometry();
      dg.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
      dg.setIndex(idx);
      g.add(new THREE.Mesh(dg, new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: fill, depthWrite: false, side: THREE.DoubleSide })));
    }
    return g;
  }

  const rangeGroup = new THREE.Group();
  scene.add(rangeGroup);
  let rangeLabels = [];
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
        rangeLabels.push({ el, p: new THREE.Vector3(rg.x * MM, groundY(rg.x, rg.y - rg.r), (rg.y - rg.r) * MM) });
      }
    }
  }

  let moveCircle = null;
  const moveGroup = new THREE.Group();
  scene.add(moveGroup);
  const ghost = new THREE.Group();
  {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.26, 0.34, 32),
      new THREE.MeshBasicMaterial({ color: 0x7fe0ff, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.26, 24),
      new THREE.MeshBasicMaterial({ color: 0x7fe0ff, transparent: true, opacity: 0.3, depthWrite: false }));
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
    moveGroup.add(terrainRing(c.x, c.y, c.r, 0x7fe0ff, { fill: 0.1 }));
  }
  function showGhost(p, from) {
    if (ghostLine) { scene.remove(ghostLine); ghostLine = null; }
    if (!p) { ghost.visible = false; return; }
    ghost.visible = true;
    ghost.position.set(p.x * MM, p.z * MM + 0.05, p.y * MM);
    if (from) {
      const A = new THREE.Vector3(from.x * MM, from.z * MM + 0.1, from.y * MM);
      const B = ghost.position.clone().setY(ghost.position.y + 0.05);
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
  const shakeV = new THREE.Vector3();
  // The clear rectangle of the host, in CSS px, that the arena should be framed in.
  let viewport = null;
  function setViewport(vp) { viewport = vp; resize(); }
  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    composer?.setSize(w, h);
    renderer.domElement.style.width = w + 'px';
    renderer.domElement.style.height = h + 'px';
    // The HUD covers parts of the canvas. The picture is framed for the clear
    // part: the camera's natural frame IS that rectangle, and the canvas shows
    // the frame plus whatever lies around it.
    const vp = viewport || { left: 0, top: 0, width: w, height: h };
    const cw = Math.max(200, vp.width), ch = Math.max(200, vp.height);
    camera.aspect = cw / ch;
    camera.setViewOffset(cw, ch, -vp.left, -vp.top, w, h);
    camera.fov = camera.aspect < 1.1 ? 44 + (1.1 - camera.aspect) * 28 : 44;
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
    if (world) world.update(dt, now);
    fx.update(dt, now);

    for (const [id, rec] of actors) {
      const { actor } = rec;
      const pos = actor.root.position;
      const tgt = rec.target;
      // Walk toward the engine's point on the ground plane; height follows
      // the ground or falls.
      const dx = tgt.x - pos.x, dz = tgt.z - pos.z;
      const dist = Math.hypot(dx, dz);
      const speed = rec.pushed ? 7 : actor.speed;
      if (dist > 0.02) {
        const step = Math.min(dist, speed * dt);
        pos.x += dx / dist * step; pos.z += dz / dist * step;
        actor.facingTarget = Math.atan2(dx, dz);
        actor.moving = !rec.pushed;
        if (rec.pushed && Math.random() < 0.5) fx.dust(pos.x, pos.y, pos.z, { n: 2, size: 0.35 });
      } else { actor.moving = false; rec.pushed = false; }
      const dy = tgt.y - pos.y;
      if (dy < -0.35 && !rec.airborne) {
        // A drop: gravity, then a thump. A body going over a real edge
        // flails on the way down and picks itself up at the bottom.
        if (!rec.falling) { rec.falling = true; if (dy < -0.9 && actor.tumble) actor.tumble(Math.sqrt(2 * -dy / 9.8)); }
        rec.vy -= 9.8 * dt;
        pos.y = Math.max(tgt.y, pos.y + rec.vy * dt);
        if (pos.y <= tgt.y + 0.001) { pos.y = tgt.y; if (rec.vy < -3) { fx.dust(pos.x, pos.y, pos.z, { n: 22, size: 0.6 }); fx.shake(0.04, 0.25); } rec.vy = 0; rec.falling = false; }
      } else if (!rec.airborne) {
        rec.vy = 0;
        pos.y += dy * Math.min(1, dt * 10);
      }
      actor.airY = rec.airY || 0;
      actor.root.position.y = pos.y + actor.airY;
      actor.update(dt, now);
      const hl = highlights.get(id);
      if (hl !== undefined) { rec.base.material.color.setHex(hl); rec.base.scale.setScalar(1.25 + Math.sin(now / 160) * 0.18); rec.base.material.opacity = 1; }
      else { rec.base.material.color.setHex(TEAM[rec.unit.owner]); rec.base.scale.setScalar(1); rec.base.material.opacity = 0.75; }
      place(rec.label, actor.root.position, actor.height + 0.3);
    }
    for (let i = dying.length - 1; i >= 0; i--) {
      const d = dying[i];
      d.t += dt;
      d.rec.actor.update(dt, now);
      if (d.rec.actor.kind === 'golem' && !d.rec.actor.ownsDeath) {
        // Rocks tumble apart.
        for (const part of d.rec.actor.parts) {
          if (!part.userData.v) { part.userData.v = new THREE.Vector3((Math.random() - 0.5) * 2, 2 + Math.random() * 2, (Math.random() - 0.5) * 2); part.userData.w = (Math.random() - 0.5) * 6; }
          part.userData.v.y -= 9.8 * dt;
          part.position.addScaledVector(part.userData.v, dt / Math.max(0.3, d.rec.actor.body.scale.x));
          part.rotation.x += part.userData.w * dt;
          if (part.position.y < -0.6) { part.position.y = -0.6; part.userData.v.set(0, 0, 0); part.userData.w = 0; }
        }
      }
      d.rec.label.style.display = 'none';
      if (d.t > 2.6 && !d.rec.actor.ownsDeath) {
        d.rec.actor.root.traverse((o) => { if (o.material && !o.userData.pick) { o.material = o.material.clone?.() || o.material; o.material.transparent = true; o.material.opacity = Math.max(0, 1 - (d.t - 2.6) / 0.8); } });
      }
      if (d.t > 3.5) { scene.remove(d.rec.actor.root); d.rec.label.remove(); d.rec.actor.dispose(); dying.splice(i, 1); }
    }
    for (const [pid, m] of propMeshes) {
      if (m.userData.target && !m.userData.flying) {
        const d = m.position.distanceTo(m.userData.target);
        if (d > 0.01) { m.position.lerp(m.userData.target, 1 - Math.pow(0.0005, dt)); if (d > 0.3 && Math.random() < 0.4) fx.dust(m.position.x, m.position.y, m.position.z, { n: 2, size: 0.4 }); }
      }
      const inner = m.userData.inner;
      if (inner?.userData.bob) inner.position.y = Math.sin(now / 900 + m.position.x) * 0.07;
      if (m.visible) m.userData.update?.(dt, now);
      if (m.userData.lev) fx.moveEmitter(pid + ':lev', m.position.x, m.position.y - m.userData.h * 0.9, m.position.z);
    }
    for (const mk of markers) {
      mk.ring.scale.setScalar(1 + Math.sin(now / 220) * 0.08);
      if (mk.label) place(mk.label, mk.pos, 0.55);
    }
    for (const l of rangeLabels) place(l.el, l.p, 0.2);
    if (ghost.visible) ghost.children[0].scale.setScalar(1 + Math.sin(now / 200) * 0.1);
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      const t = (now - f.t0) / 1500;
      if (t >= 1) { f.el.remove(); floaters.splice(i, 1); continue; }
      place(f.el, f.p, t * 0.9);
      f.el.style.opacity = String(1 - t * t);
    }
    spawnRings.forEach((r, i) => { r.rotation.z += dt * 0.15 * (i ? -1 : 1); });
    controls.update();
    fx.shakeOffset(shakeV);
    camera.position.add(shakeV);
    if (composer) composer.render(); else renderer.render(scene, camera);
    camera.position.sub(shakeV);
    requestAnimationFrame(frame);
  }
  sync(state);
  requestAnimationFrame(frame);

  return {
    sync, setMarkers, clearMarkers, highlightUnits, floatText, floatAtUnit, pulse, pulseUnit,
    setRanges, setMoveCircle, showGhost, insideMove: (x, y) => insideMove(x, y), setViewport,
    camera, controls, renderer, scene, fx, cues,
    get ready() { return ready; }, whenReady: readyPromise,
    project(x, y, z) {
      v.set(x * MM, z * MM, y * MM).project(camera);
      return [((v.x + 1) / 2) * host.clientWidth, ((1 - v.y) / 2) * host.clientHeight];
    },
    /** Where a unit's head is on screen, for a popover. */
    unitScreen(id) {
      const rec = actors.get(id);
      if (!rec) return null;
      v.copy(rec.actor.root.position); v.y += rec.actor.height + 0.4; v.project(camera);
      return [((v.x + 1) / 2) * host.clientWidth, ((1 - v.y) / 2) * host.clientHeight];
    },
    markerScreens() {
      return markers.map((m) => {
        v.copy(m.pos).project(camera);
        return [((v.x + 1) / 2) * host.clientWidth, ((1 - v.y) / 2) * host.clientHeight];
      });
    },
    home() { camera.position.copy(HOME.pos); controls.target.copy(HOME.tgt); },
    dispose() { renderer.dispose(); host.innerHTML = ''; },
  };
}

/* ------------------------------------------------------------ helpers */

function hashStr(s) { let h = 7; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h); }

export { TEAM_CSS };
