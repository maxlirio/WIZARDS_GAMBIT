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

import * as THREE from '../../vendor/three/three.module.js';
import { OrbitControls } from '../../vendor/three/addons/controls/OrbitControls.js';
import { EffectComposer } from '../../vendor/three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../../vendor/three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../../vendor/three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../../vendor/three/addons/postprocessing/OutputPass.js';
import { heightAt, propSpec, propOnBoard, propBurning, FALL_SAFE } from '../field/arena.js';
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

export function createArena(host, state, handlers = {}) {
  const a = state.arena;
  const W = a.w * MM, H = a.h * MM;
  const quality = handlers.quality || 'high';

  const renderer = new THREE.WebGLRenderer({ antialias: quality !== 'high', preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  // A GPU that gives up (too little memory for the shadows and the grass on
  // an integrated chip, a driver reset) loses the context and the canvas goes
  // black with nothing thrown. Say so, where the player can read it.
  renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    window.__bootfail?.(`WebGL context lost: the graphics driver gave up (quality ${quality}). Retry on low graphics.`);
  });
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

  /**
   * A black battlefield diagnoses itself. A player on another machine got the
   * whole HUD over a black canvas, with nothing thrown: the renderer ran and
   * painted nothing. The canvas keeps its drawing buffer, so sample it once
   * the world is up. Black with the composer on: drop to a plain render
   * (bloom's float render targets are the usual GPU refusal) and look again.
   * Still black: put the GPU's name, the float-target extensions and the
   * renderer's own console errors on the screen, where they can be read out.
   */
  function blackCheck(stage) {
    let mean = -1;
    try {
      const c = renderer.domElement, t = document.createElement('canvas');
      t.width = 48; t.height = 27;
      const g = t.getContext('2d');
      g.drawImage(c, 0, 0, 48, 27);
      const d = g.getImageData(0, 0, 48, 27).data;
      let sum = 0; for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      mean = sum / (d.length / 4) / 3;
    } catch (e) { return; }
    if (mean > 2) return;
    if (stage === 0 && composer) {
      console.warn(`battlefield rendered black with post-processing (mean ${mean.toFixed(1)}); falling back to a plain render`);
      composer = null;
      setTimeout(() => blackCheck(1), 1500);
      return;
    }
    const gl = renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown GPU';
    const ext = ['EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'OES_texture_float_linear'].map((x) => `${x}:${gl.getExtension(x) ? 'yes' : 'no'}`).join(' ');
    const lost = gl.isContextLost() ? ' CONTEXT LOST' : '';
    window.__bootfail?.(`battlefield rendered black (mean ${mean.toFixed(1)}, pass ${stage})${lost} — ${gpu} — ${ext} — max texture ${gl.getParameter(gl.MAX_TEXTURE_SIZE)}`);
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
    setTimeout(() => blackCheck(0), 2500);
  }).catch((e) => { console.error(e); loading.innerHTML = `<span>Could not load the battlefield: ${e.message}</span>`; });

  // Ground height anywhere: the engine's inside the ward, the landscape's outside.
  const groundY = (x, y) => (world ? world.heightAt(x * MM, y * MM) : heightAt(a, Math.round(Math.min(a.w, Math.max(0, x))), Math.round(Math.min(a.h, Math.max(0, y)))) * MM);
  /**
   * What a body at scene (x, z) is standing on: the ground, or the top of a
   * standing piece of terrain whose footprint it is inside, if that top is
   * no higher than `maxY` (a boulder it is climbing onto, not a pillar it is
   * walking past). Scene metres.
   */
  function surfaceY(x, z, maxY) {
    let y = groundY(x / MM, z / MM);
    for (const m of propMeshes.values()) {
      if (!m.visible || m.userData.flying || m.userData.shattered) continue;
      const r = m.userData.r || 0, top = m.position.y + (m.userData.h || 0);
      if (top <= y || top > maxY) continue;
      const dx = x - m.position.x, dz = z - m.position.z;
      if (dx * dx + dz * dz <= r * r) y = top;
    }
    return y;
  }

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
    return { actor, base, label, unit: u, target: new THREE.Vector3(u.x * MM, u.z * MM, u.y * MM), vy: 0, airborne: false, falling: false, dyn: null, ride: null, crushedAt: -1e9, walk: null, landedAt: -1e9 };
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
          dynRelease(rec);
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
        else if (u.kind === 'golem') { rec.actor.rise?.(); fx.dust(u.x * MM, u.z * MM, u.y * MM, { n: 16, size: 0.6 }); }
        actors.set(u.id, rec);
      }
      rec.unit = u;
      // A walk the timeline has not reached yet (cues.moveHold) keeps the
      // target it was given; the sync would otherwise walk the body to where
      // the engine left it before the cues ahead of it had played.
      if (!rec.walk) rec.target.set(u.x * MM, u.z * MM, u.y * MM);
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
      if (!seen.has(id)) { dynRelease(rec); rec.gather?.cancel(); if (rec.burning) { rec.burning = false; fx.unburn(`u${id}`); } scene.remove(rec.actor.root); rec.label.remove(); rec.actor.dispose(); actors.delete(id); }
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
        if (pr.raised && pr.kind === 'earthwall') { fx.debris(pr.x * MM, pr.z * MM + 0.3, pr.y * MM, { n: 8, colour: 0x4a3a28, size: 0.1, spread: m.userData.r * 1.1, up: 3.5 }); fx.dust(pr.x * MM, pr.z * MM, pr.y * MM, { n: 36, size: 0.9, colour: 0x5a4a36, spread: 0.6, up: 1.6 }); fx.shake(0.08, 0.5); }
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
        fx.debris(pr.x * MM, pr.z * MM, pr.y * MM, { n: pr.kind === 'shard' ? 6 : 9, colour: pr.kind === 'shard' ? 0x7fdcff : pr.kind === 'tree' ? 0x2a1d12 : pr.kind === 'earthwall' ? 0x4a3a28 : 0x6b6358, size: m.userData.r * 0.45, spread: m.userData.r, up: 3 + m.userData.h });
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

  /* ---------------------------------------------------------- dynamics playback */
  // The engine's `dyn` note is a sampled rigid-body run: every body it moved,
  // its trajectory at 16 Hz, and the events along the way (a hit, a landing,
  // a rock coming down on somebody). Nothing here is physics; it is a
  // replay. A play owns the listed bodies' positions from the moment its
  // cue fires until the note's `ms` have elapsed, then hands them back to
  // the ordinary walk-to-target (whose target is where the engine put them,
  // which is where the last frame leaves them). Between the engine writing
  // the note and the cue's turn on the timeline the bodies are HELD at the
  // note's first frame (dynHold), or the sync would already have walked them
  // to where the rock ends up before the rock had moved.
  const dynPlays = [];
  const dynQueue = [];                 // notes held, not yet playing, in timeline order
  const _axis = new THREE.Vector3(), _dq = new THREE.Quaternion(), _dv = new THREE.Vector3();
  const PROP_COLOUR = (kind) => (kind === 'shard' ? 0x7fdcff : kind === 'tree' ? 0x2a1d12 : kind === 'earthwall' ? 0x4a3a28 : 0x6b6358);

  /** The note's body resolved to what draws it, or null if it is not on the field. */
  function dynBody(b) {
    if (b.body === 'unit') { const rec = actors.get(b.id); return rec ? { ...b, rec, unit: true } : null; }
    const m = propMeshes.get(b.id);
    return m ? { ...b, m, unit: false } : null;
  }
  const dynOwner = (d) => (d.unit ? d.rec.dyn : d.m.userData.dyn);
  const dynOwn = (d, owner) => { if (d.unit) d.rec.dyn = owner; else d.m.userData.dyn = owner; };
  /** A unit leaves the playback (it died, it was removed): nothing owns it any more. */
  function dynRelease(rec) { rec.dyn = null; rec.ride = null; }

  /** Freeze one body of `note` at the note's first frame until the note plays. */
  function dynHoldKey(note, key, hold) {
    const f0 = note.frames?.[0]?.p;
    if (!f0) return;
    const b = note.bodies.find((x) => x.key === key);
    if (b) {
      const d = dynBody(b);
      if (!d || dynOwner(d)) return;                 // on the field and not already in a play or an earlier hold
      const p = f0[key];
      if (!p) return;
      dynOwn(d, hold);
      // A unit keeps its height (a lift cue may still be raising it); a piece
      // of terrain takes the frame's, which is where it rests.
      // A unit still owed a walk (the move cue before this run) finishes
      // it first; the walk ends where the run begins.
      if (d.unit) { if (!d.rec.walk) { const pos = d.rec.actor.root.position; pos.x = p[0] * MM; pos.z = p[1] * MM; d.rec.actor.moving = false; } }
      else d.m.position.set(p[0] * MM, p[2] * MM, p[1] * MM);
      return;
    }
    // A rider: it is where it stands; it just must not walk off yet.
    const rec = actors.get(Number(key.slice(1)));
    if (rec && !rec.dyn) rec.dyn = hold;
  }
  /** Called the moment the note is read, ahead of its turn: nobody moves until the play starts. */
  function dynHold(note) {
    const hold = { note, hold: true };
    for (const b of note.bodies || []) dynHoldKey(note, b.key, hold);
    for (const c of note.carried || []) dynHoldKey(note, c.key, hold);
    dynQueue.push(note);
  }

  /** A unit leaving the ground flails until the engine says it landed. */
  function tumbleUntilLand(play, d, fromT) {
    const land = play.events.find((e) => e.key === d.key && e.kind === 'land' && e.t > fromT);
    const air = ((land ? land.t : play.ms) - fromT) / 1000;
    const a = d.rec.actor;
    // Thrown by its own side it is a leap, not a fall: it hangs in control and lands on its feet.
    if (d.self) { if (a.jump) a.jump(Math.max(0.3, air + 0.2)); return; }
    if (a.tumble) a.tumble(Math.max(0.15, air)); else a.hit();
  }
  /** The blue-white wake of a self-cast push: the body is carried by its own magic. */
  function dashTrail(x, y, z, vx, vz, sp) {
    fx.pools.soft.emit({ x, y: y + 0.8, z, n: 1, spread: 0.12, spreadY: 0.45, vx: -vx * 0.25, vz: -vz * 0.25, vy: 0.2, life: 0.3, lifeSpread: 0.1, size: 0.22, sizeEnd: 0.05, color: PUSH_HEX, colorEnd: 0x2a6a8a, alpha: 0.35, fade: 1.5 });
    fx.pools.sparks.emit({ x, y: y + 0.7, z, n: 3, spread: 0.22, vspread: 0.9, vx: -vx * 0.7, vz: -vz * 0.7, vy: 0.5, life: 0.45, size: 0.05, sizeEnd: 0.012, color: 0xffffff, colorEnd: PUSH_HEX, gravity: -3, drag: 0.8 });
    if (sp > 2 && Math.random() < 0.3) fx.dust(x, y, z, { n: 1, size: 0.3, up: 0.4 });
  }

  /** Start the replay: every body back to its first frame, then driven by the frame loop. */
  function dynPlay(note) {
    const qi = dynQueue.indexOf(note);
    if (qi >= 0) dynQueue.splice(qi, 1);
    const frames = note.frames || [];
    if (!frames.length) return;
    const play = { note, t0: performance.now(), ms: note.ms || 0, frames, fi: 0, events: (note.events || []).slice().sort((p, q) => p.t - q.t), ei: 0, bodies: [], byKey: new Map(), riders: [] };
    for (const b of note.bodies || []) {
      const d = dynBody(b);
      if (!d) continue;
      const p0 = frames[0].p[b.key];
      if (!p0) continue;
      d.x = p0[0] * MM; d.y = p0[2] * MM; d.z = p0[1] * MM;
      d.vx = d.vz = d.vy = d.speed = d.lean = d.travel = 0; d.air = false;
      dynOwn(d, play);
      play.bodies.push(d); play.byKey.set(b.key, d);
      const p1 = frames[1]?.p[b.key];
      const rises = p1 ? p1[2] > p0[2] + 1 : false;
      const moves = p1 ? Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) > 5 : false;
      if (d.unit) {
        const rec = d.rec;
        rec.ride = null; rec.carry = null; rec.airY = 0; rec.airborne = false; rec.falling = false; rec.vy = 0; rec.airApplied = 0;
        rec.actor.root.position.set(d.x, d.y, d.z);
        rec.actor.moving = false;
        // Thrown: it leaves along the ground stumbling, or leaves the ground
        // flailing. Thrown by its OWN side (`self`) it is a magical dash: it
        // leans into the run and goes, no stumble (user: "when I shove myself
        // my wizard will like fall over. Instead it should be like magic
        // causing him to go forward faster than normal").
        if (d.self && (moves || rises)) {
          const q = frames[1].p[b.key];
          const vx = q[0] - p0[0], vz = q[1] - p0[1];
          if (Math.hypot(vx, vz) > 1e-6) rec.actor.facingTarget = Math.atan2(vx, vz);
          fx.ring(d.x, d.y, d.z, 0.9, PUSH_HEX, { dur: 0.4, width: 0.1 });
          fx.motes(d.x, d.y, d.z, PUSH_HEX, { n: 16, up: 1.6, r: 0.3, life: 0.7 });
          fx.flash(d.x, d.y + 1, d.z, PUSH_HEX, 6, 0.25, 4);
          if (rises) { d.air = true; tumbleUntilLand(play, d, 0); }
        } else if (rises) { d.air = true; tumbleUntilLand(play, d, 0); }
        else if (moves) { if (rec.actor.shove) rec.actor.shove(); else rec.actor.hit(); }
      } else {
        d.m.position.set(d.x, d.y, d.z);
        if (d.sphere) {
          // A boulder ROLLS: the drawn rock turns about its own centre by
          // distance / r, its orientation kept from one shove to the next.
          const rock = d.m.userData.rock;
          if (rock) {
            if (!rock.userData.rest) rock.userData.rest = { q: rock.quaternion.clone(), p: rock.position.clone() };
            rock.userData.roll ||= new THREE.Quaternion();
            d.roll = rock.userData.roll;
            // The stone group's origin IS its centre when props.js says so.
            d.centre = rock.userData.centre ? rock.userData.centre.clone() : new THREE.Vector3(0, rock.userData.rest.p.y + d.m.userData.h * 0.5, 0);
          }
        }
        if (moves || rises) fx.dust(d.x, d.y, d.z, { n: 8, size: 0.45, spread: d.r * MM, up: 0.8 });
      }
    }
    for (const c of note.carried || []) {
      const rec = actors.get(Number(c.key.slice(1)));
      const on = play.byKey.get(c.on);
      if (!rec || !on) continue;
      rec.dyn = play; rec.ride = { on, off: [c.off[0] * MM, c.off[1] * MM], z: c.z * MM };
      rec.actor.brace?.();
      play.riders.push(rec);
    }
    dynPlays.push(play);
  }

  /** The replay is over: the bodies go back to the ordinary walk, or into the next note's hold. */
  function dynFinish(play) {
    const rehold = (key) => {
      const next = dynQueue.find((n) => (n.bodies || []).some((b) => b.key === key) || (n.carried || []).some((c) => c.key === key));
      if (next) dynHoldKey(next, key, { note: next, hold: true });
    };
    for (const d of play.bodies) {
      if (dynOwner(d) !== play) continue;
      if (d.unit) { d.rec.dyn = null; d.rec.ride = null; d.rec.airY = 0; d.rec.airborne = false; d.rec.falling = false; d.rec.vy = 0; d.rec.dashing = false; d.rec.actor.moving = false; }
      else d.m.userData.dyn = null;
      rehold(d.key);
    }
    for (const rec of play.riders) { if (rec.dyn === play) { rec.dyn = null; rec.ride = null; rehold(`u${rec.unit.id}`); } }
  }

  /** The slam itself at the point of contact `c`, the mover going `D`: flash, sparks, dust, the ground jumps. */
  function slam(c, D, dmg, colour = 0xe6fbff) {
    const hard = Math.min(1, 0.35 + dmg * 0.25);
    fx.flash(c.x, c.y + 0.8, c.z, colour, 8 + dmg * 5, 0.22, 4 + dmg);
    fx.pools.sparks.emit({ x: c.x, y: c.y + 0.7, z: c.z, n: 18 + dmg * 10, spread: 0.15, radial: 3 + dmg, radialSpread: 1.5, vx: -D.x * 2, vz: -D.z * 2, vy: 2, life: 0.55, lifeSpread: 0.2, size: 0.09, sizeEnd: 0.02, color: 0xffffff, colorEnd: PUSH_HEX, gravity: -9, drag: 0.6 });
    fx.pools.soft.emit({ x: c.x, y: c.y + 0.7, z: c.z, n: 1, life: 0.18, size: 0.9 + dmg * 0.4, sizeEnd: 0.2, color: 0xffffff, alpha: 0.9 * hard, fade: 0 });
    fx.ring(c.x, c.y, c.z, 0.9 + dmg * 0.35, 0xdff6ff, { dur: 0.4, width: 0.12 });
    fx.dust(c.x, c.y, c.z, { n: 3 + dmg * 4, size: 0.45, spread: 0.4, up: 0.8 + dmg * 0.3 });
    fx.shake(Math.min(0.2, 0.02 + 0.03 * dmg), 0.35);
  }
  /** What a struck body does: a unit reels (or is slammed flat), a piece of terrain shudders and chips. */
  function jolt(d, dmg, D, away) {
    if (d.unit) {
      const rec = d.rec;
      // A slam STAGGERS a body on its feet. Only the engine's knockdown note
      // puts it on the ground (cues.knockdown), and only a rock landing ON it
      // slams it flat (the crumple event, a topple's hits).
      if (performance.now() - rec.crushedAt > 1200) rec.actor.hit('blow');
      if (away) rec.actor.lookAt(d.x - D.x * 2, d.z - D.z * 2);
    } else {
      const m = d.m, inner = m.userData.inner;
      fx.tween(0.4, (t) => { const k = Math.sin(t * Math.PI) * (1 - t) * (0.06 + dmg * 0.03); inner.scale.set(1 + k, 1 - k * 1.4, 1 + k); }, () => inner.scale.setScalar(1));
      // Chips fly only when something actually cracked, and as many as the
      // damage says. A bump that did no harm is a shudder and a breath of
      // dust (user: "too many chips and rock dust stuff, it makes it look way
      // more dramatic than it actually is").
      if (dmg > 0) fx.debris(m.position.x, m.position.y + m.userData.h * 0.4, m.position.z, { n: 2 + dmg * 3, colour: PROP_COLOUR(m.userData.kind), size: 0.09, spread: m.userData.r, up: 2.5 + dmg });
      else fx.dust(m.position.x, m.position.y, m.position.z, { n: 3, size: 0.35, spread: m.userData.r * 0.6, up: 0.5 });
    }
  }

  /** One of the note's events, at its moment. */
  function dynEvent(play, ev) {
    const d = play.byKey.get(ev.key);
    const P = ev.at ? new THREE.Vector3(ev.at.x * MM, ev.at.z * MM, ev.at.y * MM) : d ? new THREE.Vector3(d.x, d.y, d.z) : null;
    if (!P) return;
    const r = d ? d.r * MM : 0.3;
    const dir = d && d.speed > 0.05 ? new THREE.Vector3(d.vx, 0, d.vz).normalize() : new THREE.Vector3(1, 0, 0);
    switch (ev.kind) {
      case 'hit': {
        const o = play.byKey.get(ev.into);
        const D = o && (o.x !== P.x || o.z !== P.z) ? new THREE.Vector3(o.x - P.x, 0, o.z - P.z).normalize() : dir;
        const c = P.clone().addScaledVector(D, r);
        const dmg = ev.dmg || 0;
        slam(c, D, dmg);
        if (d) jolt(d, dmg, D, false);
        if (o) jolt(o, dmg, D, true);
        else if (dmg > 0) fx.debris(c.x, c.y, c.z, { n: 1 + dmg, colour: 0x6b6358, size: 0.08, spread: 0.4, up: 2.5 });
        break;
      }
      case 'wall': case 'ward': {
        // Into a rise in the ground, or the ward's wall of light.
        const c = P.clone().addScaledVector(dir, r);
        const dmg = Math.min(4, Math.round((ev.speed || 0) / 1800));
        slam(c, dir, dmg, ev.kind === 'ward' ? 0xbfe8ff : 0xe6fbff);
        if (ev.kind === 'ward') fx.pools.sparks.emit({ x: c.x, y: c.y + 1.2, z: c.z, n: 24 + dmg * 8, spread: 0.3, vspread: 2.5, vy: 1, life: 0.7, size: 0.08, sizeEnd: 0.02, color: 0xffffff, colorEnd: 0x7fe0ff, gravity: -5 });
        else if (dmg > 0) fx.debris(c.x, c.y, c.z, { n: 1 + dmg, colour: 0x6b6358, size: 0.08, spread: 0.4, up: 2.5 });
        if (d) jolt(d, dmg, dir, false);
        break;
      }
      case 'edge':
        fx.dust(P.x, P.y, P.z, { n: 4, size: 0.4, spread: 0.3, up: 0.6 });
        if (d) { d.air = true; if (d.unit) tumbleUntilLand(play, d, ev.t); }
        break;
      case 'land': {
        const hard = Math.min(1, (ev.speed || 0) / 7000);
        const heavy = d ? Math.min(1, (d.mass || 1) / 3) : 0.5;
        if (d) d.air = false;
        // A dashing body comes down on its feet: a soft landing, a flare of its magic.
        if (d?.unit && d.self) { d.rec.actor.land?.(false); d.rec.landedAt = performance.now(); fx.ring(P.x, P.y, P.z, 0.8, PUSH_HEX, { dur: 0.35, width: 0.08 }); }
        fx.dust(P.x, P.y, P.z, { n: Math.round(4 + 18 * hard * heavy), size: 0.45 + 0.4 * hard, spread: 0.3 + r, up: 0.7 + 1.2 * hard });
        if (hard > 0.2) { fx.ring(P.x, P.y, P.z, 0.8 + 1.4 * hard, 0xd9c9a8, { dur: 0.5 }); fx.shake(0.03 + 0.14 * hard * heavy, 0.35); }
        if (d && !d.unit && hard > 0.6) fx.debris(P.x, P.y, P.z, { n: 3, colour: PROP_COLOUR(d.m.userData.kind), size: 0.08, spread: r, up: 2 });
        break;
      }
      case 'crumple': {
        // A rock comes down on a unit: slammed flat, squashed under it, and the ground jumps.
        if (!d?.unit) break;
        const rec = d.rec;
        rec.actor.hit('crush'); rec.crushedAt = performance.now();
        fx.shake(0.22, 0.5);
        fx.ring(P.x, P.y, P.z, 1.5, 0xd9c9a8, { dur: 0.55, width: 0.16 });
        fx.dust(P.x, P.y, P.z, { n: 22, size: 0.6, spread: 0.6, up: 1.4 });
        fx.flash(P.x, P.y + 0.8, P.z, 0xfff0d0, 10, 0.25, 5);
        fx.debris(P.x, P.y + 0.9, P.z, { n: 4, colour: 0x6b6358, size: 0.08, spread: 0.4, up: 2.5 });
        const sc = rec.actor.root.scale;
        fx.tween(0.6, (t) => { const k = t < 0.18 ? t / 0.18 : 1 - fx.ease.out((t - 0.18) / 0.82); sc.set(1 + 0.3 * k, 1 - 0.45 * k, 1 + 0.3 * k); }, () => sc.setScalar(1));
        break;
      }
      case 'rest':
        if (d && !d.unit && (d.mass || 0) >= 2 && d.travel > 0.2) fx.dust(P.x, P.y, P.z, { n: 3, size: 0.4, spread: r * 0.8, up: 0.4 });
        if (d?.unit) d.lean = 0;
        break;
      default: break;
    }
  }

  /** One frame of every replay: positions from the sampled frames, events as their moment comes. */
  function stepDyn(now) {
    for (let i = dynPlays.length - 1; i >= 0; i--) {
      const play = dynPlays[i];
      const e = now - play.t0;
      const fr = play.frames;
      while (play.fi < fr.length - 2 && fr[play.fi + 1].t <= e) play.fi++;
      const a = fr[play.fi], b = fr[Math.min(play.fi + 1, fr.length - 1)];
      const span = b.t - a.t;
      const k = span > 0 ? Math.min(1, Math.max(0, (e - a.t) / span)) : 1;
      for (const d of play.bodies) {
        if (dynOwner(d) !== play) continue;
        const pa = a.p[d.key], pb = b.p[d.key] || pa;
        if (!pa) continue;
        const x = (pa[0] + (pb[0] - pa[0]) * k) * MM, z = (pa[1] + (pb[1] - pa[1]) * k) * MM, y = (pa[2] + (pb[2] - pa[2]) * k) * MM;
        // Velocity over this pair of frames: mm per ms is m per s.
        const vx = span > 0 ? (pb[0] - pa[0]) / span : 0, vz = span > 0 ? (pb[1] - pa[1]) / span : 0, vy = span > 0 ? (pb[2] - pa[2]) / span : 0;
        const sp = Math.hypot(vx, vz);
        if (d.unit) {
          const rec = d.rec, pos = rec.actor.root.position;
          pos.set(x, y, z);
          rec.airY = 0;
          if (d.self) {
            // A self-cast dash: facing the way it goes, leaning into it, feet
            // skimming, its magic streaming off behind.
            if (sp > 0.4) rec.actor.facingTarget = Math.atan2(vx, vz);
            const want = d.air ? 0.12 : Math.min(0.3, sp * 0.06);
            d.lean += (want - d.lean) * 0.2;
            rec.actor.root.rotation.x = d.lean;
            rec.dashing = !d.air && sp > 0.3;
            if (sp > 0.5) dashTrail(x, y, z, vx, vz, sp);
          } else {
            // Stumbling backwards: it faces the way it came, shoulders leading the feet.
            if (!d.air && sp > 0.4) rec.actor.facingTarget = Math.atan2(-vx, -vz);
            const want = d.air ? 0 : Math.min(0.32, sp * 0.07);
            d.lean += (want - d.lean) * 0.25;
            rec.actor.root.rotation.x = -d.lean;
            if (!d.air && sp > 2 && Math.random() < 0.2) fx.dust(x, y, z, { n: 1, size: 0.3, up: 0.5 });
          }
        } else {
          const m = d.m;
          const dx = x - m.position.x, dz = z - m.position.z;
          const dist = Math.hypot(dx, dz);
          d.travel += dist;
          m.position.set(x, y, z);
          if (d.sphere && d.roll && dist > 1e-5) {
            // Rolling: about the axis up x v, by distance / r. In the air the
            // horizontal speed is what it was, so the spin is too.
            _axis.set(dz, 0, -dx).normalize();
            _dq.setFromAxisAngle(_axis, dist / Math.max(0.05, d.r * MM));
            d.roll.premultiply(_dq);
            const rock = m.userData.rock, rest = rock.userData.rest;
            rock.quaternion.copy(d.roll).multiply(rest.q);
            rock.position.copy(_dv.copy(rest.p).sub(d.centre).applyQuaternion(d.roll).add(d.centre));
          } else if (!d.sphere && !d.air && sp > 0.3 && Math.random() < 0.2) {
            // A sliding piece grinds along the ground.
            fx.dust(x - (vx / sp) * d.r * MM * 0.5, y, z - (vz / sp) * d.r * MM * 0.5, { n: 1, size: 0.4, up: 0.6 });
          }
        }
        d.speed = sp; d.vx = vx; d.vz = vz; d.vy = vy; d.x = x; d.y = y; d.z = z;
      }
      for (const rec of play.riders) {
        if (rec.dyn !== play || !rec.ride) continue;
        const on = rec.ride.on;
        rec.actor.root.position.set(on.x + rec.ride.off[0], on.y + rec.ride.z, on.z + rec.ride.off[1]);
        rec.airY = 0;
        rec.actor.moving = false;
      }
      while (play.ei < play.events.length && play.events[play.ei].t <= e) dynEvent(play, play.events[play.ei++]);
      if (e >= play.ms) { dynFinish(play); dynPlays.splice(i, 1); }
    }
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
      // Every blow STAGGERS the body on its feet; nothing here puts it on the
      // ground (user: "sometimes when you get attacked you just fall over").
      // Going down is the engine's call alone: its knockdown note, or a rock
      // landing on the unit (the crumple/topple cues), and a body those have
      // just floored, or one still landing from a fall, only takes the number.
      const kind = fiery ? 'fire' : cause === 'lightning' || cause === 'thunder' ? 'lightning' : 'blow';
      const now = performance.now();
      const floored = now - rec.crushedAt < 1200;
      const landing = cause === 'fall' && (rec.falling || now - rec.landedAt < 900);
      if (!floored && !landing) rec.actor.hit(kind);
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
     * The engine's rigid-body run (a `dyn` note). `dynHold` is called the
     * moment the note is read, so the bodies wait at the note's first frame
     * for their turn on the timeline; `dyn` starts the replay (see the
     * dynamics playback section above).
     */
    dynHold(note) { dynHold(note); },
    dyn(note) { dynPlay(note); },
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
      fx.dust(base.x, base.y, base.z, { n: 4, size: 0.4, spread: r });
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
        for (let i = 1; i <= 4; i++) { const s = (h * i) / 4; fx.dust(base.x + D.x * s, base.y, base.z + D.z * s, { n: 7, size: 0.6 + r, spread: r, up: 1.2 }); }
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
      const D = dirVec(dir);
      if (rec.actor.knockdown) rec.actor.knockdown(dir); else if (rec.actor.tumble) rec.actor.tumble(0.6); else rec.actor.hit('crush');
      rec.crushedAt = performance.now();
      fx.dust(p.x + D.x * 0.4, p.y, p.z + D.z * 0.4, { n: 8, size: 0.5, spread: 0.4 });
      fx.pools.stars.emit({ x: p.x, y: p.y + rec.actor.height * 0.9, z: p.z, n: 5, spread: 0.3, vy: 0.5, vspread: 0.3, life: 1.1, size: 0.2, sizeEnd: 0.05, color: 0xfff1a0, alpha: 1, fade: 2, spinJitter: 2 });
      fx.shake(0.05, 0.3);
    },
    /**
     * A unit's walk is coming (the engine has already moved it): the body
     * keeps its present target until `move` plays, so the cues ahead of the
     * walk on the timeline do not find it already gone.
     */
    moveHold(id, to) {
      const rec = actors.get(id);
      if (!rec) return;
      rec.walk = { to: new THREE.Vector3(to.x * MM, to.z * MM, to.y * MM) };
    },
    /** The walk itself: the body sets off for the engine's point; the frame loop walks it over the ground. */
    move(id, to) {
      const rec = actors.get(id);
      if (!rec) return;
      const T = rec.walk?.to || new THREE.Vector3(to.x * MM, to.z * MM, to.y * MM);
      rec.walk = { to: T };
      rec.target.copy(T);
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
          fx.dust(p.x, p.y, p.z, { n: 12 + drop / 200, size: 0.6 }); fx.ring(p.x, p.y, p.z, 1.4 + drop / 2000, 0xd9c9a8, { dur: 0.5 }); fx.shake(0.06 + drop / 30000, 0.35);
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
        fx.debris(B.x, B.y + 0.2, B.z, { n: 10, colour: 0x6b6358, size: 0.16, spread: 0.6, up: 5 });
        fx.debris(B.x, B.y + 0.2, B.z, { n: 6, colour: 0x3a2a20, size: 0.1, spread: 1.2, up: 3 });
        fx.dust(B.x, B.y, B.z, { n: 34, size: 1.0, spread: 0.8, up: 2.2, colour: 0x7a6a55 });
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
      fx.debris(P.x, P.y + 0.5, P.z, { n: 14, colour, size: 0.12, spread: 0.3, up: 4.5 });
      fx.pools.sparks.emit({ x: P.x, y: P.y + 0.6, z: P.z, n: 90, spread: 0.2, radial: 7, radialSpread: 3, vy: 1.5, life: 0.6, lifeSpread: 0.25, size: 0.07, sizeEnd: 0.02, color: 0xffffff, colorEnd: colour, gravity: -9, drag: 0.8 });
      fx.dust(P.x, P.y, P.z, { n: 20, size: 0.7, spread: 0.6, up: 1.4 });
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
      fx.dust(P.x, P.y, P.z, { n: 26, size: 0.6, spread: r * 0.5, up: 1.2 });
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
        fx.dust(B.x, B.y, B.z, { n: 8, size: 0.55 });
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
        fx.dust(p.x, p.y, p.z, { n: 16, size: 0.6 }); fx.ring(p.x, p.y, p.z, 1.6, 0xd9c9a8, { dur: 0.5 }); fx.shake(0.08, 0.35);
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
        fx.dust(B.x, B.y, B.z, { n: 20, size: 0.8, colour: 0x8a7b62 });
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
      fx.dust(pos.x, pos.y, pos.z, { n: 20, size: 0.6, spread: 0.8, up: 1.3 });
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
    stepDyn(now);

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
      if (rec.dyn && !(rec.dyn.hold && rec.walk)) {
        // A rigid-body replay owns the ground position and the height (or
        // its hold does, in which case the body waits where it stands -- or
        // finishes the walk it was owed first: the walk ends where the run begins).
        // A self-cast dash runs on its feet; everything else thrown is not walking.
        actor.moving = !!rec.dashing; rec.falling = false; rec.vy = 0;
      } else if (rec.carry) {
        // Carried along a straight run (a charge): the run owns the position, height included.
        const c = rec.carry;
        c.t += dt;
        const k = fx.ease.out(Math.min(1, c.t / c.dur));
        pos.x = c.from.x + (c.to.x - c.from.x) * k; pos.y = c.from.y + (c.to.y - c.from.y) * k; pos.z = c.from.z + (c.to.z - c.from.z) * k;
        if (c.t >= c.dur) rec.carry = null;
      } else {
        // Walk toward the engine's point on the ground plane. The HEIGHT
        // follows the ground under the feet, not the target: a body walking
        // off a plateau stays on top until the edge, steps off there, falls
        // and lands at the bottom (user: "when I move off of a mountain my
        // guy falls over ... they play at the wrong times"). Standing still,
        // the height is the engine's (a prop top, a lifted rock).
        const dx = tgt.x - pos.x, dz = tgt.z - pos.z;
        const dist = Math.hypot(dx, dz);
        const walking = dist > 0.02;
        if (walking) {
          const step = Math.min(dist, actor.speed * dt);
          pos.x += dx / dist * step; pos.z += dz / dist * step;
          actor.facingTarget = Math.atan2(dx, dz);
          actor.moving = true;
        } else { actor.moving = false; if (rec.walk && !rec.falling) rec.walk = null; }
        if (actor.root.rotation.x !== 0) actor.root.rotation.x = Math.abs(actor.root.rotation.x) < 1e-3 ? 0 : actor.root.rotation.x * (1 - Math.min(1, dt * 8));
        // The floor under the feet: the ground (or a climbable top no higher
        // than where this walk is going) on the way, the engine's height on arrival.
        let floor = walking ? surfaceY(pos.x, pos.z, Math.max(pos.y, tgt.y) + 0.4) : tgt.y;
        // The last stretch onto a raised target (a boulder's top) is the climb.
        if (walking && tgt.y > floor && dist < 0.5) floor = Math.max(floor, tgt.y - (tgt.y - floor) * (dist / 0.5));
        const dy = floor - pos.y;
        if (rec.airborne) {
          // A hurl or a Skyfall holds the height: nothing to do.
          rec.vy = 0;
        } else if (rec.falling) {
          // In the air: gravity, then the landing. Soft on the feet from a
          // step down; a roll when the drop was enough to hurt (the engine's
          // FALL_SAFE, the same rule its fall damage uses).
          rec.vy -= 9.8 * dt;
          pos.y += rec.vy * dt;
          if (pos.y <= floor) {
            pos.y = floor;
            // A walked descent (the engine climbs down; it never hurts) is
            // always on the feet; a drop it did not choose hurts past FALL_SAFE.
            const hard = !rec.walk && rec.fallFrom - floor > FALL_SAFE * MM;
            rec.vy = 0; rec.falling = false; rec.landedAt = now;
            if (actor.land) actor.land(hard); else if (hard && actor.tumble) actor.tumble(0.15);
            fx.dust(pos.x, pos.y, pos.z, { n: hard ? 12 : 4, size: hard ? 0.55 : 0.4, up: hard ? 1.1 : 0.6 });
            if (hard) { fx.ring(pos.x, pos.y, pos.z, 1.1, 0xd9c9a8, { dur: 0.45 }); fx.shake(0.05, 0.3); }
          }
        } else if (dy < -0.35) {
          // The ground has gone from under the feet (an edge, a rock shattered
          // beneath it): a deliberate push-off, held in the air until it lands.
          rec.falling = true; rec.vy = 0; rec.fallFrom = pos.y;
          // How far down it is going: the lowest ground within the next metre of the walk.
          let bottom = floor;
          if (walking) for (let k = 1; k <= 3; k++) bottom = Math.min(bottom, surfaceY(pos.x + dx / dist * 0.33 * k, pos.z + dz / dist * 0.33 * k, pos.y));
          const air = Math.sqrt(2 * Math.max(0.01, pos.y - bottom) / 9.8);
          if (actor.drop) actor.drop(air); else if (air > 0.4 && actor.jump) actor.jump(air);
          fx.dust(pos.x, pos.y, pos.z, { n: 2, size: 0.3, up: 0.4 });
        } else if (dy < 0) {
          // Downhill: the feet keep the ground, but no faster than a walking
          // descent (~50 degrees). Steeper than that and the ground falls
          // away under the body on the next frames, which is the edge above.
          const down = Math.max(1.5, actor.speed * 1.2) * dt;
          pos.y = walking ? Math.max(floor, pos.y - down) : pos.y + dy * Math.min(1, dt * 10);
          rec.vy = 0;
        } else {
          // Level or uphill: the feet are on the ground.
          rec.vy = 0;
          pos.y += dy * Math.min(1, dt * (walking ? 16 : 10));
        }
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
      if (m.userData.dyn) {
        // A rigid-body replay (or its hold) owns the position.
      } else if (m.userData.target && !m.userData.flying) {
        const d = m.position.distanceTo(m.userData.target);
        if (d > 0.01) { m.position.lerp(m.userData.target, 1 - Math.pow(0.0005, dt)); if (d > 0.3 && Math.random() < 0.25) fx.dust(m.position.x, m.position.y, m.position.z, { n: 1, size: 0.4 }); }
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
    /** Where a unit's body is right now, scene metres (labs wait on it; the engine's point is `S`). */
    bodyAt(id) { const p = unitPos(id); return p ? { x: p.x, y: p.y, z: p.z } : null; },
    /** How long the body will take to walk to the engine's point `to` from where it stands now, in ms. */
    walkMs(id, to, mm = 0) {
      const rec = actors.get(id);
      if (!rec) return (mm / 2600) * 1000 + 150;
      const p = rec.actor.root.position;
      const dist = Math.hypot(to.x * MM - p.x, to.y * MM - p.z);
      const dz = to.z * MM - p.y;
      // A drop on the way is a push-off, the fall and the landing; a climb is slower than a walk.
      return (dist / Math.max(0.5, rec.actor.speed)) * 1000 + (dz < -0.35 ? 350 + Math.sqrt(2 * -dz / 9.8) * 1000 : dz > 0.35 ? 250 : 0) + 150;
    },
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
