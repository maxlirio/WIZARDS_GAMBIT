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
import { DIR64, DIR_SCALE, bearing } from '../field/fixed.js';
import { loadAll, pickLod } from './assets.js';
import { buildWorld, menhir } from './world.js';
import { createPropFactory } from './props.js';
import { createFx } from './fx.js';
import { makeMageActor } from './mage.js';
import { createMageRites } from './mage-rites.js';
import { makeGolemActor } from './golems.js';

const MM = 1 / 1000;
const TEAM = [0x4fd2ff, 0xff5d5d];
const TEAM_DARK = [0x1d4e78, 0x6a1a1a];
const TEAM_CSS = ['#4fd2ff', '#ff6b6b'];
export const SCHOOL_HEX = { red: 0xff6a52, blue: 0x52b6ff, green: 0x5ee68f, purple: 0xc98bff, gold: 0xffcf5a, grey: 0xc3cad6 };
/** The pushing school's blue-white: the propulsion behind a shoved body, the drag arrow. */
const PUSH_HEX = 0x7fe0ff;

/**
 * How long a push's slide takes on screen, in ms. The engine's `speed`
 * (0..100) is the launch speed; the slide eases out from it, so a hard push
 * covers the same distance faster rather than further. main.js uses this to
 * time the impact after the slide, so the number lives in one place.
 */
export function pushSlideMs(mm, speed = 50) {
  const d = Math.max(0.2, mm * MM);
  const v0 = 3 + speed * 0.09;            // m/s at launch, 3..12
  // A cubic ease-out leaves at three times the mean speed: T = 3d / v0.
  return Math.round(Math.max(300, Math.min(1500, (3 * d / v0) * 1000)));
}

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
  const rites = createMageRites(fx);   // a mage's death to dust and its forming again

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
  const fallen = new Set();     // mage ids that have died: their next appearance is a respawn, not a summon

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
    // Yaw first, then pitch: a lean set on rotation.x is then in the body's
    // own frame (forward/back) whichever way the actor faces.
    actor.root.rotation.order = 'YXZ';
    actor.facing = actor.facingTarget = u.owner === 0 ? Math.PI / 2 : -Math.PI / 2;
    const label = document.createElement('div');
    label.className = `ulabel p${u.owner}`;
    labels.appendChild(label);
    scene.add(actor.root);
    return { actor, base, label, unit: u, target: new THREE.Vector3(u.x * MM, u.z * MM, u.y * MM), vy: 0, airborne: false, slide: null, crushedAt: -1e9 };
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
          if (rec.slide) { endSlide(rec.slide); rec.slide = null; }
          if (rec.burning) { rec.burning = false; fx.unburn(`u${u.id}`); }
          rec.actor.die();
          const kept = rec;
          actors.delete(u.id);
          dying.push({ rec: kept, t: 0 });
          kept.label.classList.add('gone');
          if (u.kind === 'mage') fallen.add(u.id);
        }
        continue;
      }
      seen.add(u.id);
      if (!rec) {
        // A dead actor coming back is a respawn; a brand-new one a summon.
        const back = dying.find((d) => d.rec.unit.id === u.id);
        if (back) { dying.splice(dying.indexOf(back), 1); rec = back.rec; rec.actor.root.position.set(u.x * MM, u.z * MM, u.y * MM); rec.actor.root.rotation.x = 0; }
        else rec = makeUnitActor(u);
        if (u.kind === 'mage' && (back || fallen.has(u.id))) {
          // A mage's respawn, whether its dust is still blowing or long gone:
          // nothing of it shows yet. Magic gathers on the circle, then the
          // body forms there and gets up. The record is live meanwhile
          // (unitPos, labels and highlights find it); only the body waits.
          fallen.delete(u.id);
          const r = rec, x = u.x * MM, y = u.z * MM, z = u.y * MM, colour = TEAM[u.owner];
          r.actor.setHidden(true); r.base.visible = false; r.label.classList.add('gone');
          r.gather = rites.gather(x, y, z, colour, { onAppear() { r.gather = null; r.base.visible = true; r.label.classList.remove('gone'); rites.materialise(r.actor, colour); } });
        } else if (back) { rec.actor.revive(); rec.label.classList.remove('gone'); fx.sigil(u.x * MM, u.z * MM, u.y * MM, TEAM[u.owner], { dur: 1.4, r: 1.1 }); }
        else if (u.kind === 'golem') { rec.actor.rise?.(); fx.dust(u.x * MM, u.z * MM, u.y * MM, { n: 26, size: 0.6 }); }
        actors.set(u.id, rec);
      }
      rec.unit = u;
      rec.target.set(u.x * MM, u.z * MM, u.y * MM);
      const name = handlers.unitLabel ? handlers.unitLabel(u) : u.kind === 'mage' ? 'Mage' : (s.defs[u.def]?.name || 'Golem');
      const pips = Array.from({ length: u.maxHp }, (_, i) => `<i class="${i < u.hp ? 'f' : ''}"></i>`).join('');
      const html = `<b>${name}</b><span class="hp">${pips}</span>${u.poison ? `<em class="poi">☠${u.poison}</em>` : ''}${u.burn > 0 ? `<em class="poi" style="color:#ff9a3a">🔥${u.burn}</em>` : ''}${u.acted && s.active === u.owner && s.phase === 'unit' ? '<em>done</em>' : ''}`;
      if (rec.label.innerHTML !== html) rec.label.innerHTML = html;
      rec.label.classList.toggle('acted', !!u.acted && s.active === u.owner);
      // A burning UNIT (Immolate): small flames ride on the body while the
      // status lasts, driven off the state like a burning tree's.
      const alight = u.burn > 0;
      if (alight && !rec.burning) {
        rec.burning = true;
        const p0 = rec.actor.root.position;
        fx.burn(`u${u.id}`, p0.x, p0.y + 0.3, p0.z, 0.22, rec.actor.height * 0.6, { rate: 0.45 });
      } else if (!alight && rec.burning) { rec.burning = false; fx.unburn(`u${u.id}`); }
    }
    for (const [id, rec] of actors) {
      if (!seen.has(id)) { if (rec.slide) endSlide(rec.slide); rec.gather?.cancel(); if (rec.burning) { rec.burning = false; fx.unburn(`u${id}`); } scene.remove(rec.actor.root); rec.label.remove(); rec.actor.dispose(); actors.delete(id); }
    }
    for (const pr of s.field.props) {
      let m = propMeshes.get(pr.id);
      if (!m) {
        m = makeProp(pr);
        scene.add(m);
        propMeshes.set(pr.id, m);
        m.position.set(pr.x * MM, pr.z * MM, pr.y * MM);
        if (pr.raised) { m.scale.y = 0.01; fx.tween(0.7, (t) => { m.scale.y = 0.01 + fx.ease.out(t) * 0.99; }); fx.dust(pr.x * MM, pr.z * MM, pr.y * MM, { n: 30, size: 0.8 }); fx.shake(0.05, 0.4); }
        // Earth heaving up throws clods and a darker dust than stone does.
        if (pr.raised && pr.kind === 'earthwall') { fx.debris(pr.x * MM, pr.z * MM + 0.3, pr.y * MM, { n: 14, colour: 0x4a3a28, size: 0.1, spread: m.userData.r * 1.1, up: 3.5 }); fx.dust(pr.x * MM, pr.z * MM, pr.y * MM, { n: 36, size: 0.9, colour: 0x5a4a36, spread: 0.6, up: 1.6 }); fx.shake(0.08, 0.5); }
      }
      m.userData.target = new THREE.Vector3(pr.x * MM, pr.z * MM, pr.y * MM);
      // The engine has already written the piece off, but its fall has not
      // played yet: it stays up, whole and unburst, until the topple cue ends.
      if (topplePending.has(pr.id)) continue;
      // A meteor's boulder is on the engine's field before its streak has
      // played: it stays out of sight until the cue puts it down.
      if (meteorPending.has(pr.id)) { m.visible = false; continue; }
      const on = propOnBoard(s, pr);
      if (m.visible && !on && pr.destroyed && !m.userData.shattered) {
        m.userData.shattered = true;
        fx.debris(pr.x * MM, pr.z * MM, pr.y * MM, { n: pr.kind === 'shard' ? 8 : 12, colour: pr.kind === 'shard' ? 0x7fdcff : pr.kind === 'tree' ? 0x2a1d12 : pr.kind === 'earthwall' ? 0x4a3a28 : 0x6b6358, size: m.userData.r * 0.45, spread: m.userData.r, up: 3 + m.userData.h });
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
      // Only a piece a SPELL lifted glows. A floating rock is terrain: it
      // hangs there the way a cliff stands there, with nothing underneath.
      if (pr.levitated) {
        if (!m.userData.lev) { m.userData.lev = true; fx.levitating(pr.id + ':lev', pr.x * MM, pr.z * MM - m.userData.h * 0.9, pr.y * MM, m.userData.r); }
      }
    }
  }
  const stumps = [];
  const topplePending = new Set();   // prop ids whose topple cue is scheduled but not finished
  const meteorPending = new Set();   // boulder ids whose meteor streak has not landed yet

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

  /* ---------------------------------------------------------- slides */
  // A pushed body does not walk: it is THROWN, with a propulsion streaming
  // out behind it that fades as it decelerates. One slide record per body,
  // stepped by the frame loop; the plume is a pair of additive cones so no
  // light is spent on it.
  function startSlide(A, B, D, dur, force, extra) {
    fx.ring(A.x, A.y, A.z, 0.9 + force * 0.2, PUSH_HEX, { dur: 0.45, width: 0.14 });
    fx.flash(A.x, A.y + 0.8, A.z, PUSH_HEX, 6 + force * 1.5, 0.3, 4 + force * 0.5);
    fx.pools.sparks.emit({ x: A.x - D.x * 0.3, y: A.y + 0.6, z: A.z - D.z * 0.3, n: 10 + force * 4, spread: 0.2, vx: -D.x * 4, vz: -D.z * 4, vspread: 2, vy: 1, life: 0.5, size: 0.08, sizeEnd: 0.02, color: 0xffffff, colorEnd: PUSH_HEX, gravity: -4 });
    fx.dust(A.x, A.y, A.z, { n: 10 + force * 2, size: 0.45 });
    const plume = makePlume(force);
    scene.add(plume);
    return { from: A, to: B, D, dur, t: 0, force, plume, acc: 0, travelled: 0, lastX: A.x, lastZ: A.z, ...extra };
  }
  /** One frame of the propulsion behind a sliding body at (x, y, z); `thrust` 1..0 as it dies. */
  function plumeStep(sl, x, y, z, groundY, thrust, dt) {
    const { D, force, plume } = sl;
    plume.position.set(x - D.x * 0.25, y, z - D.z * 0.25);
    plume.rotation.y = Math.atan2(D.z, -D.x);
    const flick = 0.85 + 0.15 * Math.sin(performance.now() * 0.05);
    plume.scale.set(0.3 + thrust * flick, 0.5 + thrust * 0.5, 0.5 + thrust * 0.5);
    plume.children[0].material.opacity = 0.5 * thrust;
    plume.children[1].material.opacity = 0.8 * thrust;
    // The nozzle itself: a hot glow where the magic meets the body.
    fx.pools.soft.emit({ x: x - D.x * 0.2, y, z: z - D.z * 0.2, n: 1, life: 0.08, size: (0.5 + force * 0.08) * (0.5 + thrust * 0.5), color: 0xffffff, alpha: 0.7 * thrust, fade: 0 });
    // Motes streaming back out of the nozzle, and the ground scuffed as it goes.
    sl.acc += dt * (70 + force * 25) * thrust;
    const v = 3 + force * 0.7;
    while (sl.acc >= 1) {
      sl.acc -= 1;
      fx.pools.soft.emit({ x: x - D.x * 0.3, y: y + (Math.random() - 0.5) * 0.3, z: z - D.z * 0.3, n: 1, spread: 0.12, vx: -D.x * v, vz: -D.z * v, vspread: 0.9, vy: 0.3, life: 0.4, lifeSpread: 0.15, size: 0.22, sizeEnd: 0.05, color: 0xdffbff, colorEnd: PUSH_HEX, alpha: 0.85, fade: 1, drag: 1.5 });
      if (Math.random() < 0.3) fx.pools.sparks.emit({ x: x - D.x * 0.2, y: y - 0.2, z: z - D.z * 0.2, n: 1, spread: 0.1, vx: -D.x * v * 0.7, vz: -D.z * v * 0.7, vspread: 1.2, vy: 1.2, life: 0.6, size: 0.06, sizeEnd: 0.015, color: 0xffffff, colorEnd: PUSH_HEX, gravity: -6 });
    }
    sl.travelled += Math.hypot(x - sl.lastX, z - sl.lastZ);
    sl.lastX = x; sl.lastZ = z;
    if (sl.travelled > 0.14) { sl.travelled = 0; fx.dust(x - D.x * 0.2, groundY, z - D.z * 0.2, { n: 3, size: 0.4, up: 0.8 }); }
  }
  function endSlide(sl) {
    scene.remove(sl.plume);
    for (const c of sl.plume.children) { c.geometry.dispose(); c.material.dispose(); }
  }

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
      const crushing = cause === 'crush' || cause === 'rock' || cause === 'impact' || cause === 'topple' || cause === 'shrapnel';
      const fiery = cause === 'fire' || cause === 'burn' || cause === 'charge';
      const kind = fiery ? 'fire' : cause === 'lightning' || cause === 'thunder' ? 'lightning' : crushing ? 'crush' : 'blow';
      // A slam's cue (impact, topple) has just thrown the body down; the
      // damage note that follows it only adds the number, not a second fall.
      if (performance.now() - rec.crushedAt > 1200) rec.actor.hit(kind);
      const p = rec.actor.root.position;
      const col = fiery ? 0xff7a20 : cause === 'lightning' || cause === 'thunder' ? 0xb8ecff : cause === 'poison' ? 0x7fe04a : cause === 'fall' || crushing ? 0xd9c9a8 : 0xff4040;
      fx.pools.sparks.emit({ x: p.x, y: p.y + rec.actor.height * 0.5, z: p.z, n: 14, spread: 0.2, vspread: 3, vy: 1.5, life: 0.5, size: 0.1, sizeEnd: 0.02, color: 0xffffff, colorEnd: col, gravity: -8 });
      floatAtUnit(id, `−${amount}`, fiery ? 'dmg fire' : 'dmg');
      if (cause === 'fall' || crushing) fx.shake(0.05, 0.3);
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
    /**
     * A push: the body is thrown from `from` to `to` along DIR64 `dir` with
     * a propulsion streaming out behind it. `force` (1-8) sizes the plume,
     * `speed` (0-100) the launch; both are the engine's numbers. The sync has
     * already moved the engine's target, so the body is set back to `from`
     * and slid from there -- the slide is the cue, not the walk.
     */
    push(id, body, mm, from, dir = 0, force = 1, speed = 50, to = null) {
      const D = dirVec(dir);
      const dur = pushSlideMs(mm, speed) / 1000;
      if (body === 'unit') {
        const rec = actors.get(id);
        if (!rec) return;
        const pos = rec.actor.root.position;
        const A = new THREE.Vector3(from ? from.x * MM : pos.x, pos.y, from ? from.y * MM : pos.z);
        const B = to ? new THREE.Vector3(to.x * MM, to.z * MM, to.y * MM) : rec.target.clone();
        pos.x = A.x; pos.z = A.z;
        if (rec.actor.shove) rec.actor.shove(); else rec.actor.hit();
        rec.pushed = true;
        // Face the pusher and stumble backwards, the top of the body leaning
        // into the slide (the feet are dragged, the shoulders lead).
        rec.slide = startSlide(A, B, D, dur, force, { facing: Math.atan2(-D.x, -D.z), lean: 0.1 + 0.03 * force });
      } else {
        const m = propMeshes.get(id);
        if (!m) return;
        const A = new THREE.Vector3(from ? from.x * MM : m.position.x, m.position.y, from ? from.y * MM : m.position.z);
        const B = to ? new THREE.Vector3(to.x * MM, to.z * MM, to.y * MM) : m.userData.target.clone();
        m.position.x = A.x; m.position.z = A.z;
        m.userData.slide = startSlide(A, B, D, dur, force, { axis: perpAxis(dir), tilt: 0.06 + 0.02 * force });
      }
    },
    /**
     * A rider carried along on a shoved prop: the same slide, same clock, no
     * plume and no stumble -- it is standing on the thing that moves.
     */
    carry(id, mm, from, dir = 0, speed = 50, to = null) {
      const rec = actors.get(id);
      if (!rec) return;
      const pos = rec.actor.root.position;
      const dur = pushSlideMs(mm, speed) / 1000;
      const A = new THREE.Vector3(from ? from.x * MM : pos.x, from ? from.z * MM : pos.y, from ? from.y * MM : pos.z);
      const B = to ? new THREE.Vector3(to.x * MM, to.z * MM, to.y * MM) : rec.target.clone();
      pos.set(A.x, A.y, A.z);
      rec.carry = { from: A, to: B, dur, t: 0 };
      rec.actor.brace?.();
    },
    /**
     * The moving body hit something: `into` is what, `at` where (engine mm),
     * `dmg` what both sides take. Numbers come from the damage notes after
     * this; here is the slam itself.
     */
    impact(note) {
      const { id, body, into, dmg = 0, at, dir = 0 } = note;
      const D = dirVec(dir);
      const p = at ? new THREE.Vector3(at.x * MM, at.z * MM, at.y * MM)
        : (body === 'unit' ? unitPos(id) : propMeshes.get(id)?.position.clone());
      if (!p) return;
      const r = body === 'unit' ? 0.3 : (propMeshes.get(id)?.userData.r || 0.4);
      // The point of contact: the leading edge of the mover.
      const c = p.clone().addScaledVector(D, r);
      const hard = Math.min(1, 0.35 + dmg * 0.25);
      fx.flash(c.x, c.y + 0.8, c.z, 0xe6fbff, 8 + dmg * 5, 0.22, 4 + dmg);
      fx.pools.sparks.emit({ x: c.x, y: c.y + 0.7, z: c.z, n: 18 + dmg * 10, spread: 0.15, radial: 3 + dmg, radialSpread: 1.5, vx: -D.x * 2, vz: -D.z * 2, vy: 2, life: 0.55, lifeSpread: 0.2, size: 0.09, sizeEnd: 0.02, color: 0xffffff, colorEnd: PUSH_HEX, gravity: -9, drag: 0.6 });
      fx.pools.soft.emit({ x: c.x, y: c.y + 0.7, z: c.z, n: 1, life: 0.18, size: 0.9 + dmg * 0.4, sizeEnd: 0.2, color: 0xffffff, alpha: 0.9 * hard, fade: 0 });
      fx.ring(c.x, c.y, c.z, 0.9 + dmg * 0.35, 0xdff6ff, { dur: 0.4, width: 0.12 });
      fx.dust(c.x, c.y, c.z, { n: 12 + dmg * 6, size: 0.5, spread: 0.4, up: 1 + dmg * 0.3 });
      fx.shake(Math.min(0.2, 0.04 + 0.03 * dmg), 0.35);
      const jolt = (kind, bid, away) => {
        if (kind === 'unit') {
          const rec = actors.get(bid);
          if (!rec) return;
          if (dmg >= 2) { rec.actor.hit('crush'); rec.crushedAt = performance.now(); } else rec.actor.hit();
          if (away) rec.actor.lookAt(c.x - D.x * 2, c.z - D.z * 2);
        } else if (kind === 'prop') {
          const m = propMeshes.get(bid);
          if (!m) return;
          const inner = m.userData.inner;
          fx.tween(0.4, (t) => { const k = Math.sin(t * Math.PI) * (1 - t) * (0.06 + dmg * 0.03); inner.scale.set(1 + k, 1 - k * 1.4, 1 + k); }, () => inner.scale.setScalar(1));
          // Rock chips fly on ANY bump, harder with damage: stone meeting stone is loud even when nothing cracks.
          fx.debris(m.position.x, m.position.y + m.userData.h * 0.4, m.position.z, { n: 6 + dmg * 4, colour: m.userData.kind === 'shard' ? 0x7fdcff : m.userData.kind === 'tree' ? 0x2a1d12 : 0x6b6358, size: 0.09, spread: m.userData.r, up: 2.5 + dmg });
        }
      };
      jolt(body, id, false);
      if (into) {
        if (into.kind === 'unit' || into.kind === 'prop') jolt(into.kind, into.id, true);
        else fx.debris(c.x, c.y, c.z, { n: 3 + dmg, colour: 0x6b6358, size: 0.08, spread: 0.4, up: 2.5 });   // the ward, a wall, a rise: the ground gives a little
      }
    },
    /** A topple is coming for this prop: keep it standing until the cue plays. */
    toppling(propId) { topplePending.add(propId); },
    /**
     * A tall piece falls over along `dir`, pivoting on the edge of its base,
     * lands with a thud on everything in `hits`, and is gone. The engine's
     * shatter for it is swallowed (`topplePending`) so it does not burst twice.
     */
    topple(propId, dir = 0, hits = []) {
      const m = propMeshes.get(propId);
      if (!m) { topplePending.delete(propId); return; }
      const D = dirVec(dir), axis = perpAxis(dir);
      const { r, h, inner } = m.userData;
      const base = m.position.clone();
      m.visible = true;
      // Rotating about the base's far edge, not its centre: the pivot point
      // stays put, so the piece is translated by what the rotation did to it.
      const pivot = D.clone().multiplyScalar(r);
      const q = new THREE.Quaternion();
      const swung = new THREE.Vector3();
      let creak = 0;
      fx.dust(base.x, base.y, base.z, { n: 8, size: 0.4, spread: r });
      fx.tween(0.72, (t) => {
        const ang = -Math.PI / 2 * t;
        q.setFromAxisAngle(axis, ang);
        inner.quaternion.copy(q);
        inner.position.copy(pivot).sub(swung.copy(pivot).applyQuaternion(q));
        // Grit from the footing as it tears loose.
        creak += t;
        if (creak > 0.6) { creak = 0; fx.pools.dust.emit({ x: base.x - D.x * r * 0.5, y: base.y + 0.1, z: base.z - D.z * r * 0.5, n: 1, spread: r * 0.5, vy: 0.6, life: 0.8, size: 0.25, sizeEnd: 0.7, color: 0x8a7b62, alpha: 0.35, drag: 2, fade: 1, rotJitter: 3.14 }); }
      }, () => {
        // The thud: dust the whole length of the fallen piece, a ring where
        // its middle landed, and the ground jumps.
        for (let i = 1; i <= 4; i++) { const s = (h * i) / 4; fx.dust(base.x + D.x * s, base.y, base.z + D.z * s, { n: 14, size: 0.6 + r, spread: r, up: 1.2 }); }
        const mid = base.clone().addScaledVector(D, h * 0.5);
        fx.ring(mid.x, base.y, mid.z, h * 0.55, 0xd9c9a8, { dur: 0.55, width: 0.15 });
        fx.debris(base.x + D.x * h, base.y, base.z + D.z * h, { n: 5, colour: m.userData.kind === 'tree' ? 0x2a1d12 : 0x6b6358, size: r * 0.3, spread: r, up: 2.5 });
        fx.shake(Math.min(0.2, 0.08 + h * 0.03), 0.45);
        for (const uid of hits) { const rec = actors.get(uid); if (rec) { rec.actor.hit('crush'); rec.crushedAt = performance.now(); } }
        if (m.userData.burning) { m.userData.burning = false; fx.unburn(propId); m.userData.setBurning?.(false); }
        // Lie there a moment, then fade: what remains is the engine's rubble.
        const mats = [];
        m.traverse((o) => { if (o.material && !o.userData.pick) { o.material = o.material.clone?.() || o.material; o.material.transparent = true; mats.push(o.material); } });
        fx.tween(1.1, (t) => { const k = Math.max(0, 1 - Math.max(0, t - 0.45) / 0.55); for (const mt of mats) mt.opacity = k; }, () => {
          m.visible = false;
          m.userData.shattered = true;
          topplePending.delete(propId);
          inner.quaternion.identity(); inner.position.set(0, 0, 0);
        });
      }, (t) => t * t);
    },
    /** Slammed hard enough to lose its action: the unit goes down and gets up. */
    knockdown(id, dir = 0) {
      const rec = actors.get(id);
      if (!rec) return;
      const p = rec.actor.root.position;
      if (rec.actor.tumble) rec.actor.tumble(0.6); else rec.actor.hit('crush');
      rec.crushedAt = performance.now();
      const D = dirVec(dir);
      fx.dust(p.x + D.x * 0.4, p.y, p.z + D.z * 0.4, { n: 16, size: 0.5, spread: 0.4 });
      fx.pools.stars.emit({ x: p.x, y: p.y + rec.actor.height * 0.9, z: p.z, n: 5, spread: 0.3, vy: 0.5, vspread: 0.3, life: 1.1, size: 0.2, sizeEnd: 0.05, color: 0xfff1a0, alpha: 1, fade: 2, spinJitter: 2 });
      fx.shake(0.05, 0.3);
    },
    fall(id, drop) {
      const rec = actors.get(id);
      if (rec && drop > 300) floatAtUnit(id, `fell ${(drop / 1000).toFixed(1)}m`, 'fall');
      // A body a Skyfall held in the air comes down now: gravity, then a thump.
      if (rec && rec.airborne && rec.airY > 0) {
        const h0 = rec.airY, dur = Math.max(0.3, Math.sqrt(2 * h0 / 9.8));
        if (rec.actor.tumble) rec.actor.tumble(dur);
        fx.tween(dur, (t) => { rec.airY = h0 * (1 - t * t); }, () => {
          rec.airY = 0; rec.airborne = false;
          const p = rec.actor.root.position;
          fx.dust(p.x, p.y, p.z, { n: 26 + drop / 100, size: 0.7 }); fx.ring(p.x, p.y, p.z, 1.4 + drop / 2000, 0xd9c9a8, { dur: 0.5 }); fx.shake(0.06 + drop / 30000, 0.35);
        });
      }
    },
    /** Skyfall: the unit is hauled `mm` straight up and hangs there until it is thrown and falls. */
    lift(id, mm) {
      const rec = actors.get(id);
      if (!rec) return;
      const h = mm * MM;
      rec.airborne = true;
      if (rec.actor.jump) rec.actor.jump(10);
      fx.tween(0.45, (t) => { rec.airY = fx.ease.out(t) * h; }, () => { rec.airY = h; });
      const p = rec.actor.root.position;
      fx.motes(p.x, p.y, p.z, 0xffa64a, { n: 30, up: 3.5, r: 0.4 });
      fx.ring(p.x, p.y, p.z, 1.2, 0xffa64a, { dur: 0.5, width: 0.1 });
      fx.flash(p.x, p.y + 1, p.z, 0xffa64a, 8, 0.4, 5);
    },
    /**
     * Meteor Call: a glowing rock streaks down out of the sky onto `at`
     * (engine mm), explodes, cracks the ground and throws dust and stone.
     * The engine's boulder is revealed by meteorLand at the same moment.
     */
    meteorIncoming(at, radius = 1000) {
      const B = new THREE.Vector3(at.x * MM, at.z * MM, at.y * MM);
      // From high and to one side, so the streak crosses the frame rather
      // than dropping straight down out of the sky the camera cannot see.
      const A = B.clone().add(new THREE.Vector3(-7, 8.5, 4));
      fx.bolt(A, B, { colour: 0xff7a1a, dur: 0.85, size: 0.7, arc: 0.3, trail: 'fire', light: 24, onArrive: () => {
        const r = Math.max(1.2, radius * MM * 1.4);
        fx.explosion(B.x, B.y, B.z, { r, colour: 0xff8a2a });
        fx.ring(B.x, B.y, B.z, r * 2.4, 0xffd090, { dur: 0.55, width: 0.2 });
        fx.debris(B.x, B.y + 0.2, B.z, { n: 18, colour: 0x6b6358, size: 0.16, spread: 0.6, up: 5 });
        fx.debris(B.x, B.y + 0.2, B.z, { n: 10, colour: 0x3a2a20, size: 0.1, spread: 1.2, up: 3 });
        fx.dust(B.x, B.y, B.z, { n: 60, size: 1.1, spread: 0.8, up: 2.2, colour: 0x7a6a55 });
        fx.scorch(B.x, B.y, B.z, r * 1.1);
        fx.shake(0.22, 0.6);
      } });
    },
    meteorPending(propId) { meteorPending.add(propId); },
    meteorLand(propId, at) {
      meteorPending.delete(propId);
      const m = propMeshes.get(propId);
      if (!m) return;
      m.visible = true;
      m.position.set(at.x * MM, at.z * MM, at.y * MM);
      // Hot from the fall: a glow that cools, and a settle as it beds in.
      const inner = m.userData.inner;
      inner.scale.set(1.25, 0.8, 1.25);
      fx.tween(0.5, (t) => { const k = 1 - fx.ease.out(t); inner.scale.set(1 + 0.25 * k, 1 - 0.2 * k, 1 + 0.25 * k); }, () => inner.scale.setScalar(1));
      fx.burn(propId + ':hot', m.position.x, m.position.y, m.position.z, m.userData.r * 0.8, m.userData.h * 0.5, { rate: 0.6 });
      fx.tween(2.2, () => {}, () => fx.unburn(propId + ':hot'));
    },
    /** Stoneburst: the piece bursts outward, chips flying at everyone near it. */
    shrapnel(propId, at, radius = 1500) {
      const m = propMeshes.get(propId);
      const P = m ? m.position.clone() : new THREE.Vector3(at.x * MM, at.z * MM, at.y * MM);
      const r = radius * MM;
      const colour = m?.userData.kind === 'shard' ? 0x7fdcff : m?.userData.kind === 'tree' ? 0x2a1d12 : 0x6b6358;
      fx.flash(P.x, P.y + 0.8, P.z, 0xfff0d0, 18, 0.3, 7);
      fx.ring(P.x, P.y, P.z, r * 1.3, 0xd9c9a8, { dur: 0.45, width: 0.14 });
      fx.debris(P.x, P.y + 0.5, P.z, { n: 28, colour, size: 0.12, spread: 0.3, up: 4.5 });
      fx.pools.sparks.emit({ x: P.x, y: P.y + 0.6, z: P.z, n: 90, spread: 0.2, radial: 7, radialSpread: 3, vy: 1.5, life: 0.6, lifeSpread: 0.25, size: 0.07, sizeEnd: 0.02, color: 0xffffff, colorEnd: colour, gravity: -9, drag: 0.8 });
      fx.dust(P.x, P.y, P.z, { n: 40, size: 0.8, spread: 0.6, up: 1.6 });
      fx.shake(0.14, 0.4);
    },
    /** Thunderclap: a crack of light at the caster and a shock ring that floors the circle. */
    thunderclap(p, at, radius = 2000) {
      const m = mageOf(p);
      const P = m ? m.actor.root.position.clone() : new THREE.Vector3(at.x * MM, at.z * MM, at.y * MM);
      const r = radius * MM;
      m?.actor.cast('raise');
      fx.lightning(P.clone().add(new THREE.Vector3(0.3, 7, -0.2)), P.clone().add(new THREE.Vector3(0, 1.6, 0)), { colour: 0xcfeeff });
      fx.flash(P.x, P.y + 1.6, P.z, 0xdff6ff, 40, 0.35, r * 2.5, { flicker: 0.6 });
      fx.ring(P.x, P.y, P.z, r, 0xdff6ff, { dur: 0.45, width: 0.12 });
      fx.ring(P.x, P.y, P.z, r * 0.8, 0xffffff, { dur: 0.7, width: 0.5, opacity: 0.5, thin: false });
      fx.burst(P.x, P.y + 1.2, P.z, 0xbfe8ff, { n: 40, r: 0.5, up: 2 });
      fx.dust(P.x, P.y, P.z, { n: 50, size: 0.7, spread: r * 0.5, up: 1.4 });
      fx.shake(0.16, 0.45);
    },
    /**
     * Blazing Charge: the mage dashes from `from` to `to` over `dur` ms with
     * fire streaming off it. The sync has already put the engine's target at
     * `to`; the body is set back and run from there.
     */
    charge(id, from, to, dir = 0, mm = 3000, dur = 700) {
      const rec = actors.get(id);
      if (!rec) return;
      const pos = rec.actor.root.position;
      const A = new THREE.Vector3(from.x * MM, from.z * MM, from.y * MM);
      const B = new THREE.Vector3(to.x * MM, to.z * MM, to.y * MM);
      pos.set(A.x, A.y, A.z);
      rec.actor.lookAt(B.x, B.z);
      fx.flash(A.x, A.y + 1, A.z, 0xff9a3a, 14, 0.4, 6);
      fx.ring(A.x, A.y, A.z, 1.0, 0xff9a3a, { dur: 0.4, width: 0.12 });
      rec.carry = { from: A, to: B, dur: dur / 1000, t: 0 };
      rec.actor.moving = true;
      let acc = 0;
      fx.tween(dur / 1000, (t, dt) => {
        acc += dt * 160;
        const x = A.x + (B.x - A.x) * t, y = A.y + (B.y - A.y) * t, z = A.z + (B.z - A.z) * t;
        while (acc >= 1) {
          acc -= 1;
          fx.pools.fire.emit({ x, y: y + 0.5 + Math.random() * 0.8, z, n: 1, spread: 0.2, vy: 1.2, vspread: 0.5, life: 0.45, lifeSpread: 0.15, size: 0.45, sizeEnd: 0.9, color: 0xffd0a0, colorEnd: 0x4a1206, alpha: 0.8, drag: 1.5, fade: 2, anim: 1, rotJitter: 0.4, spinJitter: 1 });
          if (Math.random() < 0.5) fx.pools.sparks.emit({ x, y: y + 0.6, z, n: 1, spread: 0.2, vy: 1.5, vspread: 1.2, life: 0.8, size: 0.05, sizeEnd: 0.015, color: 0xfff0b0, colorEnd: 0xff4a10, gravity: -4, drag: 0.6 });
        }
        if (Math.random() < 0.35) fx.dust(x, y, z, { n: 2, size: 0.35, up: 0.6 });
      }, () => {
        fx.scorch(A.x + (B.x - A.x) * 0.5, A.y, A.z + (B.z - A.z) * 0.5, 0.5);
        fx.dust(B.x, B.y, B.z, { n: 16, size: 0.6 });
        fx.flash(B.x, B.y + 1, B.z, 0xff9a3a, 12, 0.3, 5);
        fx.shake(0.05, 0.3);
      });
    },
    /** Cannonade: the caster takes aim; the shot itself is the push cue that follows. */
    cannonade(propId, targetId) {
      const m = propMeshes.get(propId);
      const t = unitTop(targetId);
      if (!m || !t) return;
      const owner = mageOf(cur?.active ?? 0);
      owner?.actor.lookAt(m.position.x, m.position.z);
      owner?.actor.cast('shoot');
      fx.beam(m.position.clone().add(new THREE.Vector3(0, m.userData.h * 0.5, 0)), t, 0xffb070, { dur: 0.35, width: 0.06 });
      fx.flash(m.position.x, m.position.y + m.userData.h * 0.5, m.position.z, 0xffb070, 10, 0.3, 5);
      fx.ring(m.position.x, m.position.y, m.position.z, m.userData.r * 2.2, 0xffb070, { dur: 0.35, width: 0.1 });
    },
    /** Immolate: a unit catches fire. The flames themselves are driven by the sync. */
    burnUnit(id) {
      const p = unitPos(id);
      if (!p) return;
      fx.explosion(p.x, p.y, p.z, { r: 0.55 });
      floatAtUnit(id, 'burning', 'dmg fire');
    },
    /** Flame Line: a wave of fire rolls out from the caster through the trees. */
    flameLine(p, radius = 3000) {
      const m = mageOf(p);
      if (!m) return;
      const P = m.actor.root.position;
      const r = radius * MM;
      m.actor.cast('raise');
      fx.ring(P.x, P.y, P.z, r, 0xff8a2a, { dur: 0.8, width: 0.35, opacity: 0.8, thin: false });
      fx.flash(P.x, P.y + 1, P.z, 0xff9a3a, 22, 0.5, r * 2, { flicker: 0.4 });
      fx.pools.fire.emit({ x: P.x, y: P.y + 0.4, z: P.z, n: 120, spread: 0.3, radial: r * 1.8, radialSpread: r * 0.6, vy: 1.2, life: 0.7, lifeSpread: 0.25, size: 0.5, sizeEnd: 1.0, color: 0xffcc90, colorEnd: 0x3a0e06, alpha: 0.75, drag: 2.5, gravity: 0.6, fade: 2, anim: 1, rotJitter: 0.5, spinJitter: 1.5 });
      fx.shake(0.06, 0.4);
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
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (drag) {
      // A direction is being asked: any press on the canvas starts the stroke.
      if (e.button !== 0) return;
      down = null;
      drag.stroke = { id: e.pointerId };
      try { renderer.domElement.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer cannot be captured */ }
      strokeMove(e.clientX, e.clientY);
      e.preventDefault();
      return;
    }
    down = [e.clientX, e.clientY];
  });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (drag) { if (drag.stroke) strokeEnd(e.clientX, e.clientY); return; }
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return;
    const hit = pickAt(e.clientX, e.clientY);
    if (!hit) { handlers.onPickNothing?.(); return; }
    if (hit.kind === 'marker') handlers.onPickMarker?.(markers[hit.index]?.data);
    else if (hit.kind === 'unit') handlers.onPickUnit?.(hit.id);
    else if (hit.kind === 'prop') handlers.onPickProp?.(hit.id, hit);
    else if (hit.kind === 'ground') handlers.onPickGround?.(hit.x, hit.y);
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (drag) { if (drag.stroke) strokeMove(e.clientX, e.clientY); return; }
    const hit = pickAt(e.clientX, e.clientY);
    renderer.domElement.style.cursor = hit && (hit.kind === 'marker' || (hit.kind === 'unit' && handlers.isPickable?.(hit))
      || ((hit.kind === 'ground' || hit.kind === 'prop') && moveCircle && insideMove(hit.x, hit.y))) ? 'pointer' : '';
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
    // Every hit carries the ground point under it: a click ON a rock is a
    // move onto the rock when a unit is moving (user: "it's not letting me
    // move on top of the rock").
    return { ...h.object.userData.pick, x: Math.round(h.point.x / MM), y: Math.round(h.point.z / MM) };
  }

  /* ---------------------------------------------------------- the drag */
  // The direction prompt. While a request is parked here the canvas belongs
  // to it: the camera stops orbiting, a press anywhere starts a stroke, an
  // arrow grows from the target to the pointer's ground point, and the
  // release hands back the engine's DIR64 bearing of that arrow. Clicks on
  // units and markers never reach their handlers in the meantime.
  let drag = null;
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function targetPos() {
    if (!drag) return null;
    return drag.body === 'unit' ? unitPos(drag.id) : propMeshes.get(drag.id)?.position.clone() || null;
  }
  /** Where the pointer touches the ground, falling back to the target's level off the terrain. */
  function groundPointAt(cx, cy) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = world ? ray.intersectObject(world.terrain, false)[0] : null;
    if (hit) return hit.point.clone();
    const T = targetPos();
    dragPlane.constant = -(T ? T.y : 0);
    const out = new THREE.Vector3();
    return ray.ray.intersectPlane(dragPlane, out) ? out : null;
  }
  function beginDrag(target, cb) {
    const key = `${target.body}:${target.id}:${target.force}`;
    if (drag && drag.key === key) { drag.cb = cb; return; }
    endDrag();
    drag = { ...target, cb, key, stroke: null, arrow: makeArrow(), ring: null, label: null, tip: new THREE.Vector3(), len: 0 };
    drag.arrow.visible = false;
    scene.add(drag.arrow);
    // The thing that will be pushed wears a pulsing ring.
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.6, 48),
      new THREE.MeshBasicMaterial({ color: PUSH_HEX, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 20;
    scene.add(ring);
    drag.ring = ring;
    const label = document.createElement('div');
    label.className = 'dlabel';
    label.style.display = 'none';
    labels.appendChild(label);
    drag.label = label;
    controls.enableRotate = false; controls.enablePan = false;
    renderer.domElement.style.cursor = 'crosshair';
    showGhost(null);
  }
  function endDrag() {
    if (!drag) return;
    scene.remove(drag.arrow); scene.remove(drag.ring);
    drag.arrow.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    drag.ring.geometry.dispose(); drag.ring.material.dispose();
    drag.label.remove();
    drag = null;
    controls.enableRotate = true; controls.enablePan = true;
    renderer.domElement.style.cursor = '';
  }
  function strokeMove(cx, cy) {
    const T = targetPos(), G = groundPointAt(cx, cy);
    if (!T || !G) return;
    const dx = G.x - T.x, dz = G.z - T.z;
    const len = Math.hypot(dx, dz);
    drag.len = len;
    const a = drag.arrow;
    a.visible = len > 0.08;
    a.position.set(T.x, T.y + 0.1, T.z);
    // Local +X is the arrow's length; a yaw of atan2(-dz, dx) lays it on (dx, dz).
    a.rotation.y = Math.atan2(-dz, dx);
    const HEAD = 0.55;
    a.children[0].scale.x = Math.max(0.01, len - HEAD * 0.8);
    a.children[1].position.x = Math.max(0, len - HEAD);
    // Too short a stroke means nothing: the arrow says so by staying dim.
    const live = len > 0.3;
    a.children[0].material.opacity = live ? 0.75 : 0.3;
    a.children[1].material.opacity = live ? 0.9 : 0.35;
    drag.tip.set(G.x, T.y + 0.1, G.z);
    drag.label.style.display = live ? '' : 'none';
    drag.label.textContent = `force ${drag.force} →  ≈ ${(drag.force * 0.75).toFixed(1)} m for a mage`;
  }
  function strokeEnd(cx, cy) {
    const T = targetPos(), G = groundPointAt(cx, cy);
    const cb = drag.cb;
    drag.stroke = null;
    drag.arrow.visible = false;
    drag.label.style.display = 'none';
    if (!T || !G) return;
    if (Math.hypot(G.x - T.x, G.z - T.z) <= 0.3) return;
    // Engine millimetres: x is x, y is our z.
    cb(bearing(Math.round(T.x / MM), Math.round(T.z / MM), Math.round(G.x / MM), Math.round(G.z / MM)));
  }
  function cancelStroke() {
    if (!drag?.stroke) return;
    drag.stroke = null;
    drag.arrow.visible = false;
    drag.label.style.display = 'none';
  }
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelStroke(); });
  /** Where DIR64 `d` points on the player's screen, in radians: 0 is right, pi/2 is up. */
  function screenAngle(d) {
    const D = dirVec(d);
    const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    return Math.atan2(D.dot(fwd), D.dot(right));
  }

  /* ---------------------------------------------------------- rings */
  /**
   * A ring (and optional disc) draped over the ground and drawn ON TOP of it.
   *
   * Depth testing is off and the render order is high on purpose: a move
   * circle that runs into a plateau used to vanish behind the cliff face,
   * which is exactly where the player most needs to see where the circle
   * ends. The disc is a radial mesh -- many rings of vertices, each at its
   * own ground height -- rather than a fan from the centre, so it hugs a
   * cliff instead of cutting straight through it.
   */
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
      ? new THREE.LineDashedMaterial({ color: colour, dashSize: 0.18, gapSize: 0.1, transparent: true, opacity, depthTest: false, depthWrite: false })
      : new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity, depthTest: false, depthWrite: false });
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
    if (dashed) line.computeLineDistances();
    line.renderOrder = 50;
    g.add(line);
    if (fill > 0) {
      const rings = Math.max(4, Math.round(r / 400));
      const v = [];
      for (let k = 0; k <= rings; k++) {
        const rr = (k / rings) * r;
        for (let i = 0; i <= n; i++) {
          const t = (i / n) * Math.PI * 2;
          const x = cx + Math.cos(t) * rr, y = cy + Math.sin(t) * rr;
          v.push(x * MM, groundY(x, y) + 0.04, y * MM);
        }
      }
      const idx = [];
      const row = n + 1;
      for (let k = 0; k < rings; k++) {
        for (let i = 0; i < n; i++) {
          const a = k * row + i, b = a + 1, c = a + row, d = c + 1;
          idx.push(a, c, d, a, d, b);
        }
      }
      const dg = new THREE.BufferGeometry();
      dg.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
      dg.setIndex(idx);
      const disc = new THREE.Mesh(dg, new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: fill, depthWrite: false, depthTest: false, side: THREE.DoubleSide }));
      disc.renderOrder = 49;
      g.add(disc);
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
  // Inside the move SHAPE: within the walk's reach along the nearest sampled
  // heading, or within the plain circle when no shape was given.
  function insideMove(x, y) {
    if (!moveCircle) return false;
    const dx = x - moveCircle.x, dy = y - moveCircle.y, d2 = dx * dx + dy * dy;
    if (d2 > moveCircle.r ** 2) return false;
    const sh = moveCircle.shape;
    if (!sh || !sh.length) return true;
    const i = Math.round((Math.atan2(dy, dx) / (Math.PI * 2)) * sh.length + sh.length) % sh.length;
    const p = sh[i], px = p.x - moveCircle.x, py = p.y - moveCircle.y;
    return d2 <= px * px + py * py + 50 * 50;
  }
  function setMoveCircle(c) {
    moveGroup.clear();
    moveCircle = c;
    showGhost(null);
    if (!c) return;
    if (c.shape && c.shape.length) moveGroup.add(terrainShape(c.x, c.y, c.shape, 0x7fe0ff, { fill: 0.1, opacity: 0.8 }));
    else moveGroup.add(terrainRing(c.x, c.y, c.r, 0x7fe0ff, { fill: 0.1 }));
  }
  const moveShape = () => (moveCircle?.shape || []).map((p) => ({ x: p.x, y: p.y, z: p.z }));

  /**
   * A draped region bounded by `shape`: one reach point per heading, in
   * heading order around `cx,cy`. Outline plus a ringed fan fill, like
   * terrainRing but with a different radius on every spoke, drawn through
   * the terrain like the rings (depthTest off).
   */
  function terrainShape(cx, cy, shape, colour, { opacity = 0.95, fill = 0.10 } = {}) {
    const g = new THREE.Group();
    const n = shape.length;
    // The walk's reach on every heading, as a radius. The drawn outline is
    // SMOOTHED -- a spoke that stops at a rock between two that run on made
    // the raw polygon a thicket of spikes (user: "this looks buns") -- but
    // never drawn PAST the true reach: every smoothed radius is capped by the
    // raw one on that heading, so the shape only ever shrinks into legal
    // ground. Clicks are still judged on the raw shape (insideMove).
    const raw = shape.map((p) => Math.hypot(p.x - cx, p.y - cy));
    let rad = raw.slice();
    for (let pass = 0; pass < 4; pass++) {
      const nx = rad.slice();
      for (let i = 0; i < n; i++) {
        const a = rad[(i + n - 1) % n], b = rad[i], c = rad[(i + 1) % n];
        nx[i] = Math.min(raw[i], (a + 2 * b + c) / 4);
      }
      rad = nx;
    }
    // Resample round the shape, SUB points per spoke, through a Catmull-Rom
    // curve in radius, capped by the chord of the two raw radii so a curve
    // overshoot cannot leave the reach either.
    const SUB = 4, m = n * SUB;
    const ang = (i) => Math.atan2(shape[i % n].y - cy, shape[i % n].x - cx);
    const ring = [];
    for (let i = 0; i < n; i++) {
      const r0 = rad[(i + n - 1) % n], r1 = rad[i], r2 = rad[(i + 1) % n], r3 = rad[(i + 2) % n];
      const a1 = ang(i); let a2 = ang(i + 1); if (a2 < a1) a2 += Math.PI * 2;
      for (let s = 0; s < SUB; s++) {
        const t = s / SUB, t2 = t * t, t3 = t2 * t;
        let r = 0.5 * ((2 * r1) + (-r0 + r2) * t + (2 * r0 - 5 * r1 + 4 * r2 - r3) * t2 + (-r0 + 3 * r1 - 3 * r2 + r3) * t3);
        r = Math.max(0, Math.min(r, raw[i] + (raw[(i + 1) % n] - raw[i]) * t));
        const a = a1 + (a2 - a1) * t;
        ring.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      }
    }
    const at = (i, f) => { const [x, y] = ring[i % m]; return [cx + (x - cx) * f, cy + (y - cy) * f]; };
    const pts = [];
    for (let i = 0; i <= m; i++) { const [x, y] = at(i, 1); pts.push(new THREE.Vector3(x * MM, groundY(x, y) + 0.06, y * MM)); }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity, depthTest: false, depthWrite: false }));
    line.renderOrder = 50;
    g.add(line);
    if (fill > 0) {
      // The fill drapes on the ground in fine rings and is depth-tested, so
      // a slope hides the part behind it instead of showing as a hanging
      // sheet; the outline still shows through everything. Its alpha fades
      // toward the rim, so the edge reads as a soft limit rather than a
      // cut-out.
      const rings = 24, v = [], col = [], idx = [], row = m + 1;
      const C = new THREE.Color(colour);
      for (let k = 0; k <= rings; k++) {
        const f = k / rings, a = 1 - f * f * 0.75;
        for (let i = 0; i <= m; i++) { const [x, y] = at(i, f); v.push(x * MM, groundY(x, y) + 0.05, y * MM); col.push(C.r * a, C.g * a, C.b * a); }
      }
      for (let k = 0; k < rings; k++) for (let i = 0; i < m; i++) {
        const a = k * row + i, b = a + 1, c = a + row, d = c + 1;
        idx.push(a, c, d, a, d, b);
      }
      const dg = new THREE.BufferGeometry();
      dg.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
      dg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      dg.setIndex(idx);
      const disc = new THREE.Mesh(dg, new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, opacity: fill * 1.6, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide }));
      disc.renderOrder = 49;
      g.add(disc);
    }
    return g;
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
      // The air offset (a hurl, a skyfall) sits on top of the ground height
      // and is taken off again first thing each frame, so it never
      // accumulates: `pos` IS the root position, and adding airY to it every
      // frame sent a lifted body climbing out of the scene by its own height
      // sixty times a second.
      pos.y -= rec.airApplied || 0;
      rec.airApplied = 0;
      const tgt = rec.target;
      // Walk toward the engine's point on the ground plane; height follows
      // the ground or falls.
      const dx = tgt.x - pos.x, dz = tgt.z - pos.z;
      const dist = Math.hypot(dx, dz);
      const speed = rec.pushed ? 7 : actor.speed;
      if (rec.carry) {
        // Riding: the prop's slide owns the position, height included.
        const c = rec.carry;
        c.t += dt;
        const k = fx.ease.out(Math.min(1, c.t / c.dur));
        pos.x = c.from.x + (c.to.x - c.from.x) * k; pos.y = c.from.y + (c.to.y - c.from.y) * k; pos.z = c.from.z + (c.to.z - c.from.z) * k;
        actor.moving = false;
        if (c.t >= c.dur) rec.carry = null;
        continue;
      }
      if (rec.slide) {
        // Thrown: the slide owns the ground position, the facing and the lean.
        const sl = rec.slide;
        sl.t += dt;
        const k = fx.ease.out(Math.min(1, sl.t / sl.dur));
        pos.x = sl.from.x + (sl.to.x - sl.from.x) * k; pos.z = sl.from.z + (sl.to.z - sl.from.z) * k;
        actor.facingTarget = sl.facing;
        actor.moving = false;
        const thrust = (1 - k) * Math.min(1, sl.t / 0.08);
        actor.root.rotation.x = -sl.lean * thrust;
        plumeStep(sl, pos.x, pos.y + actor.height * 0.45, pos.z, pos.y, thrust, dt);
        if (sl.t >= sl.dur) { endSlide(sl); rec.slide = null; }
      } else if (dist > 0.02) {
        const step = Math.min(dist, speed * dt);
        pos.x += dx / dist * step; pos.z += dz / dist * step;
        actor.facingTarget = Math.atan2(dx, dz);
        actor.moving = !rec.pushed;
        if (rec.pushed && Math.random() < 0.5) fx.dust(pos.x, pos.y, pos.z, { n: 2, size: 0.35 });
      } else { actor.moving = false; rec.pushed = false; }
      if (!rec.slide && actor.root.rotation.x !== 0) actor.root.rotation.x = Math.abs(actor.root.rotation.x) < 1e-3 ? 0 : actor.root.rotation.x * (1 - Math.min(1, dt * 8));
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
      rec.airApplied = actor.airY;
      actor.root.position.y = pos.y + actor.airY;
      actor.update(dt, now);
      if (rec.burning) fx.moveEmitter(`u${id}`, pos.x, actor.root.position.y + 0.3, pos.z);
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
      if (d.rec.actor.kind === 'mage') {
        // Falls, lies still, goes to dust on the wind; the ring under it fades with the body.
        const gone = rites.deathStep(d.rec.actor, d.t, dt);
        d.rec.base.material.opacity = 0.75 * (1 - d.rec.actor.dissolve);
        if (gone) { scene.remove(d.rec.actor.root); d.rec.label.remove(); d.rec.actor.dispose(); dying.splice(i, 1); }
        continue;
      }
      if (d.t > 2.6 && !d.rec.actor.ownsDeath) {
        d.rec.actor.root.traverse((o) => { if (o.material && !o.userData.pick) { o.material = o.material.clone?.() || o.material; o.material.transparent = true; o.material.opacity = Math.max(0, 1 - (d.t - 2.6) / 0.8); } });
      }
      if (d.t > 3.5) { scene.remove(d.rec.actor.root); d.rec.label.remove(); d.rec.actor.dispose(); dying.splice(i, 1); }
    }
    for (const [pid, m] of propMeshes) {
      const sl = m.userData.slide;
      if (sl) {
        sl.t += dt;
        const k = fx.ease.out(Math.min(1, sl.t / sl.dur));
        m.position.lerpVectors(sl.from, sl.to, k);
        const thrust = (1 - k) * Math.min(1, sl.t / 0.08);
        // Tipped back against the motion while the thrust is on it.
        m.userData.inner.quaternion.setFromAxisAngle(sl.axis, sl.tilt * thrust);
        plumeStep(sl, m.position.x, m.position.y + m.userData.h * 0.4, m.position.z, m.position.y, thrust, dt);
        if (sl.t >= sl.dur) { endSlide(sl); m.userData.slide = null; m.userData.inner.quaternion.identity(); }
      } else if (m.userData.target && !m.userData.flying) {
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
    if (drag) {
      const T = targetPos();
      if (T) {
        drag.ring.position.set(T.x, T.y + 0.06, T.z);
        drag.ring.scale.setScalar(1 + Math.sin(now / 180) * 0.12);
        drag.ring.material.opacity = 0.7 + Math.sin(now / 180) * 0.25;
      }
      if (drag.arrow.visible) {
        // Light runs down the shaft toward the head: the arrow has a direction even when it stands still.
        drag.arrow.children[2].position.x = (now / 600) % 1 * Math.max(0.1, drag.len - 0.4);
        drag.arrow.children[2].visible = drag.len > 0.3;
      }
      if (drag.label.style.display !== 'none') place(drag.label, drag.tip, 0.5);
    }
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
    setRanges, setMoveCircle, showGhost, insideMove: (x, y) => insideMove(x, y), moveShape, setViewport,
    beginDrag, endDrag, screenAngle,
    camera, controls, renderer, scene, fx, cues,
    get ready() { return ready; }, whenReady: readyPromise,
    project(x, y, z) {
      v.set(x * MM, z * MM, y * MM).project(camera);
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

/** DIR64 index -> unit vector in scene space (engine x -> x, engine y -> z). */
function dirVec(d) { const [ux, uy] = DIR64[d & 63]; return new THREE.Vector3(ux / DIR_SCALE, 0, uy / DIR_SCALE); }
/**
 * The horizontal axis perpendicular to `d`, signed so that a POSITIVE
 * rotation about it tips the top of a body AGAINST the direction (and a
 * negative one lays it down along it): for east, +Z, about which +Y swings
 * to -X.
 */
function perpAxis(d) { const [ux, uy] = DIR64[d & 63]; return new THREE.Vector3(-uy / DIR_SCALE, 0, ux / DIR_SCALE); }

/**
 * The propulsion behind a pushed body: an outer cone of the push's blue and
 * a hot white core, additive, nozzle at the group's origin and the tail
 * along local +X. Scaled per frame by the thrust left in the slide.
 */
function makePlume(force) {
  const g = new THREE.Group();
  const len = 0.7 + force * 0.22, rad = 0.18 + force * 0.025;
  const mk = (r, l, colour, opacity) => {
    const geo = new THREE.ConeGeometry(r, l, 14, 1, true);
    // Additive black is nothing: painting the vertices from the colour at
    // the nozzle to black at the tail makes the cone a streak that dies out
    // instead of a hard-edged paper dart.
    const c = new THREE.Color(colour);
    const pos = geo.attributes.position, col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) { const k = (l / 2 - pos.getY(i)) / l; const k2 = k * k; col[i * 3] = c.r * k2; col[i * 3 + 1] = c.g * k2; col[i * 3 + 2] = c.b * k2; }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.Mesh(geo,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    // A cone's apex is +Y: turned so the apex (the tail) points down +X, base at the nozzle.
    m.rotation.z = -Math.PI / 2;
    m.position.x = l / 2;
    m.renderOrder = 8;
    return m;
  };
  g.add(mk(rad, len, PUSH_HEX, 0.32), mk(rad * 0.5, len * 0.7, 0xeafdff, 0.55));
  return g;
}

/**
 * The drag arrow, flat on the ground: a shaft that widens from its tail to
 * the neck (child 0, scaled in x to the length), a head (child 1, moved to
 * the end) and a running spark (child 2). Local +X is its direction.
 */
function makeArrow() {
  const g = new THREE.Group();
  const mat = (opacity) => new THREE.MeshBasicMaterial({ color: PUSH_HEX, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
  const quad = (pts) => { const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)); return geo; };
  const shaft = new THREE.Mesh(quad([0, 0, -0.05, 1, 0, -0.17, 1, 0, 0.17, 0, 0, -0.05, 1, 0, 0.17, 0, 0, 0.05]), mat(0.75));
  const head = new THREE.Mesh(quad([0, 0, -0.42, 0.55, 0, 0, 0, 0, 0.42]), mat(0.9));
  const spark = new THREE.Mesh(new THREE.CircleGeometry(0.16, 16), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
  spark.rotation.x = -Math.PI / 2;
  spark.position.y = 0.01;
  for (const m of [shaft, head, spark]) m.renderOrder = 21;
  g.add(shaft, head, spark);
  return g;
}

export { TEAM_CSS };
