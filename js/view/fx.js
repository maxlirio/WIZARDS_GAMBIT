// Effects: particles, bolts, lightning, rings, debris, decals and shakes.
//
// The engine leaves notes ("a fireball hit unit 3", "prop s4 shattered") and
// the arena turns each into one of these. Nothing here knows a rule; it knows
// how fire looks. Everything is time-based off the frame clock, and every
// effect ends on its own, so a burst of forty notes from a long chain cannot
// leave anything behind.
//
// Sizes are metres: a particle of size 1 covers about a metre of ground at any
// camera distance (the vertex shader scales by the viewport height). Lights
// come from a fixed pool that is always in the scene, so a flash never makes
// three.js recompile every lit material.

import * as THREE from 'three';

/* ------------------------------------------------------------ sprites */

function seeded(seed) {
  let s = seed | 0 || 1;
  return () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
}

function canvasTex(draw, w = 64, h = w) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false;                 // gl_PointCoord and the canvas share a top-left origin
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  return t;
}

function radial(g, x, y, r, stops) {
  const gr = g.createRadialGradient(x, y, 0, x, y, r);
  for (const [k, c] of stops) gr.addColorStop(k, c);
  g.fillStyle = gr;
  return gr;
}

/** One frame of fire: a hot core low down and a few licking tongues above it. */
function drawFlame(g, s, seed) {
  const rnd = seeded(seed);
  g.clearRect(0, 0, s, s);
  g.globalCompositeOperation = 'lighter';
  const nT = 3 + Math.floor(rnd() * 3);
  for (let i = 0; i < nT; i++) {
    const w = s * (0.11 + rnd() * 0.11);
    const bx = s * (0.5 + (rnd() - 0.5) * 0.3), by = s * (0.72 + rnd() * 0.08);
    const tx = s * (0.5 + (rnd() - 0.5) * 0.55), ty = s * (0.04 + rnd() * 0.3);
    const lg = g.createLinearGradient(0, by, 0, ty);
    lg.addColorStop(0, 'rgba(255,215,120,.95)');
    lg.addColorStop(0.45, 'rgba(255,120,25,.8)');
    lg.addColorStop(0.8, 'rgba(210,35,0,.4)');
    lg.addColorStop(1, 'rgba(120,0,0,0)');
    g.fillStyle = lg;
    const my = (by + ty) / 2, bend = (rnd() - 0.5) * s * 0.25;
    g.beginPath();
    g.moveTo(bx - w, by);
    g.bezierCurveTo(bx - w * 1.3 + bend, my, tx - w * 0.15, ty + (by - ty) * 0.25, tx, ty);
    g.bezierCurveTo(tx + w * 0.15, ty + (by - ty) * 0.25, bx + w * 1.3 + bend, my, bx + w, by);
    g.arc(bx, by, w, 0, Math.PI, false);
    g.closePath();
    g.fill();
  }
  // Hot core.
  radial(g, s * 0.5, s * 0.7, s * 0.32, [[0, 'rgba(255,255,240,1)'], [0.3, 'rgba(255,240,170,.9)'], [0.65, 'rgba(255,160,50,.4)'], [1, 'rgba(255,90,20,0)']]);
  g.beginPath(); g.ellipse(s * 0.5, s * 0.7, s * 0.32, s * 0.28, 0, 0, Math.PI * 2); g.fill();
  // Soften the silhouette so sprites never show a hard edge.
  g.globalCompositeOperation = 'destination-in';
  radial(g, s * 0.5, s * 0.55, s * 0.5, [[0, 'rgba(0,0,0,1)'], [0.7, 'rgba(0,0,0,1)'], [1, 'rgba(0,0,0,0)']]);
  g.fillRect(0, 0, s, s);
  g.globalCompositeOperation = 'source-over';
}

/** A rune: a short random polyline, the kind of mark a sigil is ringed with. */
function drawRune(g, x, y, size, rnd) {
  const n = 3 + Math.floor(rnd() * 3);
  g.beginPath();
  let px = x + (rnd() - 0.5) * size, py = y + (rnd() - 0.5) * size;
  g.moveTo(px, py);
  for (let i = 0; i < n; i++) { px = x + (rnd() - 0.5) * size; py = y + (rnd() - 0.5) * size; g.lineTo(px, py); }
  g.stroke();
  if (rnd() < 0.5) { g.beginPath(); g.arc(x + (rnd() - 0.5) * size * 0.5, y + (rnd() - 0.5) * size * 0.5, size * 0.12, 0, Math.PI * 2); g.stroke(); }
}

const SPRITES = {};
export const FLAME_FRAMES = { cols: 4, rows: 2 };
function sprite(kind) {
  if (SPRITES[kind]) return SPRITES[kind];
  let t;
  if (kind === 'soft') {
    t = canvasTex((g, s) => {
      radial(g, s / 2, s / 2, s / 2, [[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,255,255,.6)'], [0.7, 'rgba(255,255,255,.12)'], [1, 'rgba(255,255,255,0)']]);
      g.fillRect(0, 0, s, s);
    }, 64);
  } else if (kind === 'spark') {
    t = canvasTex((g, s) => {
      radial(g, s / 2, s / 2, s / 2, [[0, 'rgba(255,255,255,1)'], [0.18, 'rgba(255,255,255,.95)'], [0.4, 'rgba(255,255,255,.2)'], [1, 'rgba(255,255,255,0)']]);
      g.fillRect(0, 0, s, s);
    }, 32);
  } else if (kind === 'star') {
    // A four-point twinkle with a soft heart.
    t = canvasTex((g, s) => {
      radial(g, s / 2, s / 2, s * 0.22, [[0, 'rgba(255,255,255,1)'], [0.5, 'rgba(255,255,255,.5)'], [1, 'rgba(255,255,255,0)']]);
      g.fillRect(0, 0, s, s);
      g.globalCompositeOperation = 'lighter';
      for (const [dx, dy, len, wid] of [[1, 0, 0.5, 0.045], [0, 1, 0.5, 0.045], [0.707, 0.707, 0.28, 0.03], [0.707, -0.707, 0.28, 0.03]]) {
        const lg = g.createLinearGradient(s / 2 - dx * s * len, s / 2 - dy * s * len, s / 2 + dx * s * len, s / 2 + dy * s * len);
        lg.addColorStop(0, 'rgba(255,255,255,0)'); lg.addColorStop(0.5, 'rgba(255,255,255,.9)'); lg.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = lg;
        g.save(); g.translate(s / 2, s / 2); g.rotate(Math.atan2(dy, dx));
        g.beginPath(); g.moveTo(-s * len, 0); g.lineTo(0, -s * wid); g.lineTo(s * len, 0); g.lineTo(0, s * wid); g.closePath(); g.fill();
        g.restore();
      }
    }, 64);
  } else if (kind === 'smoke') {
    t = canvasTex((g, s) => {
      // Overlapping blobs with a lit upper-left: a puff, not a disc.
      const rnd = seeded(3);
      for (let i = 0; i < 11; i++) {
        const x = s / 2 + (rnd() - 0.5) * s * 0.5, y = s / 2 + (rnd() - 0.5) * s * 0.5, rr = s * (0.16 + rnd() * 0.17);
        const lit = 0.55 + 0.45 * Math.max(0, (0.5 - (x + y) / (2 * s)) * 2 + 0.5);
        const v = Math.round(255 * lit);
        radial(g, x, y, rr, [[0, `rgba(${v},${v},${v},.42)`], [1, `rgba(${v},${v},${v},0)`]]);
        g.fillRect(0, 0, s, s);
      }
    }, 128);
  } else if (kind === 'dust') {
    t = canvasTex((g, s) => {
      const rnd = seeded(11);
      for (let i = 0; i < 9; i++) {
        const x = s / 2 + (rnd() - 0.5) * s * 0.45, y = s / 2 + (rnd() - 0.5) * s * 0.45, rr = s * (0.2 + rnd() * 0.16);
        const lit = 0.62 + 0.38 * Math.max(0, Math.min(1, 0.5 - (x + y - s) / s));
        const v = Math.round(255 * lit);
        radial(g, x, y, rr, [[0, `rgba(${v},${v},${v},.6)`], [0.5, `rgba(${v},${v},${v},.22)`], [1, `rgba(${v},${v},${v},0)`]]);
        g.fillRect(0, 0, s, s);
      }
    }, 128);
  } else if (kind === 'flame') {
    const { cols, rows } = FLAME_FRAMES;
    const cell = 128;
    t = canvasTex((g) => {
      for (let f = 0; f < cols * rows; f++) {
        g.save();
        g.translate((f % cols) * cell, Math.floor(f / cols) * cell);
        g.beginPath(); g.rect(0, 0, cell, cell); g.clip();
        drawFlame(g, cell, 17 + f * 101);
        g.restore();
      }
    }, cell * cols, cell * rows);
  } else if (kind === 'ring') {
    // A shock front: bright thin leading edge, softer trailing body.
    t = canvasTex((g, s) => {
      radial(g, s / 2, s / 2, s / 2, [[0, 'rgba(255,255,255,0)'], [0.55, 'rgba(255,255,255,0)'], [0.8, 'rgba(255,255,255,.35)'], [0.93, 'rgba(255,255,255,1)'], [1, 'rgba(255,255,255,0)']]);
      g.fillRect(0, 0, s, s);
    }, 256);
  } else if (kind === 'ringThin') {
    t = canvasTex((g, s) => {
      radial(g, s / 2, s / 2, s / 2, [[0, 'rgba(255,255,255,0)'], [0.8, 'rgba(255,255,255,0)'], [0.9, 'rgba(255,255,255,.5)'], [0.95, 'rgba(255,255,255,1)'], [1, 'rgba(255,255,255,0)']]);
      g.fillRect(0, 0, s, s);
    }, 256);
  } else if (kind === 'scorch') {
    t = canvasTex((g, s) => {
      const rnd = seeded(29);
      radial(g, s / 2, s / 2, s / 2, [[0, 'rgba(0,0,0,.95)'], [0.45, 'rgba(0,0,0,.75)'], [0.8, 'rgba(0,0,0,.2)'], [1, 'rgba(0,0,0,0)']]);
      g.fillRect(0, 0, s, s);
      for (let i = 0; i < 14; i++) {
        const a = rnd() * Math.PI * 2, d = s * (0.22 + rnd() * 0.26), rr = s * (0.06 + rnd() * 0.12);
        radial(g, s / 2 + Math.cos(a) * d, s / 2 + Math.sin(a) * d, rr, [[0, 'rgba(0,0,0,.7)'], [1, 'rgba(0,0,0,0)']]);
        g.fillRect(0, 0, s, s);
      }
      // A few glowing cracks near the centre.
      g.globalCompositeOperation = 'source-over';
      g.strokeStyle = 'rgba(255,120,30,.55)'; g.lineWidth = s * 0.012; g.lineCap = 'round';
      for (let i = 0; i < 6; i++) {
        const a = rnd() * Math.PI * 2;
        g.beginPath(); g.moveTo(s / 2 + Math.cos(a) * s * 0.05, s / 2 + Math.sin(a) * s * 0.05);
        let x = s / 2, y = s / 2;
        for (let k = 0; k < 4; k++) { x += Math.cos(a + (rnd() - 0.5)) * s * 0.07; y += Math.sin(a + (rnd() - 0.5)) * s * 0.07; g.lineTo(x, y); }
        g.stroke();
      }
    }, 256);
  } else if (kind === 'sigilOuter') {
    t = canvasTex((g, s) => {
      const rnd = seeded(7);
      const c = s / 2;
      g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineCap = 'round'; g.lineJoin = 'round';
      g.lineWidth = s * 0.012; g.beginPath(); g.arc(c, c, s * 0.485, 0, Math.PI * 2); g.stroke();
      g.lineWidth = s * 0.005; g.beginPath(); g.arc(c, c, s * 0.46, 0, Math.PI * 2); g.stroke();
      g.lineWidth = s * 0.006; g.beginPath(); g.arc(c, c, s * 0.385, 0, Math.PI * 2); g.stroke();
      // Runes in the band, ticks between them.
      const N = 24;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        g.save(); g.translate(c + Math.cos(a) * s * 0.4225, c + Math.sin(a) * s * 0.4225); g.rotate(a + Math.PI / 2);
        g.lineWidth = s * 0.006;
        drawRune(g, 0, 0, s * 0.045, rnd);
        g.restore();
        const b = a + Math.PI / N;
        g.lineWidth = s * 0.004;
        g.beginPath(); g.moveTo(c + Math.cos(b) * s * 0.39, c + Math.sin(b) * s * 0.39); g.lineTo(c + Math.cos(b) * s * 0.455, c + Math.sin(b) * s * 0.455); g.stroke();
      }
      // Four cardinal nodes.
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        g.beginPath(); g.arc(c + Math.cos(a) * s * 0.485, c + Math.sin(a) * s * 0.485, s * 0.02, 0, Math.PI * 2); g.fill();
      }
    }, 512);
  } else if (kind === 'sigilInner') {
    t = canvasTex((g, s) => {
      const c = s / 2, R = s * 0.34;
      g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineJoin = 'round';
      g.lineWidth = s * 0.007; g.beginPath(); g.arc(c, c, R, 0, Math.PI * 2); g.stroke();
      // Hexagram.
      g.lineWidth = s * 0.008;
      for (let k = 0; k < 2; k++) {
        g.beginPath();
        for (let i = 0; i < 3; i++) { const a = -Math.PI / 2 + k * Math.PI / 3 + (i / 3) * Math.PI * 2; const x = c + Math.cos(a) * R, y = c + Math.sin(a) * R; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
        g.closePath(); g.stroke();
      }
      // Vertex nodes and a small inner circle with spokes.
      for (let i = 0; i < 6; i++) { const a = -Math.PI / 2 + (i / 6) * Math.PI * 2; g.beginPath(); g.arc(c + Math.cos(a) * R, c + Math.sin(a) * R, s * 0.016, 0, Math.PI * 2); g.fill(); }
      g.lineWidth = s * 0.006; g.beginPath(); g.arc(c, c, R * 0.38, 0, Math.PI * 2); g.stroke();
      for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 + Math.PI / 6; g.beginPath(); g.moveTo(c + Math.cos(a) * R * 0.38, c + Math.sin(a) * R * 0.38); g.lineTo(c + Math.cos(a) * R * 0.95, c + Math.sin(a) * R * 0.95); g.stroke(); }
      g.beginPath(); g.arc(c, c, s * 0.03, 0, Math.PI * 2); g.fill();
    }, 512);
  }
  SPRITES[kind] = t;
  return t;
}

/* ------------------------------------------------------------ particles */

const VERT = `
  attribute float psize; attribute float palpha; attribute vec3 pcolor; attribute float prot; attribute float pframe;
  uniform float viewH;
  varying float vAlpha; varying vec3 vColor; varying float vRot; varying float vFrame;
  void main() {
    vAlpha = palpha; vColor = pcolor; vRot = prot; vFrame = pframe;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float px = psize * viewH * projectionMatrix[1][1] * 0.5 / max(0.05, -mv.z);
    gl_PointSize = clamp(px, 1.0, 500.0);
    gl_Position = projectionMatrix * mv;
  }`;
const FRAG = `
  uniform sampler2D map; uniform vec2 atlas;
  varying float vAlpha; varying vec3 vColor; varying float vRot; varying float vFrame;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float c = cos(vRot), s = sin(vRot);
    uv = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y) + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
    float f = floor(vFrame + 0.5);
    vec2 cell = vec2(mod(f, atlas.x), floor(f / atlas.x));
    vec4 t = texture2D(map, (uv + cell) / atlas);
    gl_FragColor = vec4(vColor * t.rgb, t.a * vAlpha);
    if (gl_FragColor.a < 0.004) discard;
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

/**
 * One pool of point sprites with one blend mode and one texture. Particles
 * are simulated on the CPU -- a few thousand is nothing -- and written into
 * the attributes each frame. Nothing is allocated after construction.
 */
export class Particles {
  constructor(scene, { max = 2500, texture = 'soft', additive = true, depthWrite = false, frames = 1, atlas = null } = {}) {
    this.max = max;
    this.n = 0;
    this.frames = frames;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.rot = new Float32Array(max);
    this.frame = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.age = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.size1 = new Float32Array(max);
    this.col0 = new Float32Array(max * 3);
    this.col1 = new Float32Array(max * 3);
    this.alpha0 = new Float32Array(max);
    this.fade = new Float32Array(max);   // 0 out; 1 in-then-out; 2 pop in, hold, out; 3 flicker
    this.spin = new Float32Array(max);
    this.turb = new Float32Array(max);
    this.seed = new Float32Array(max);
    this.anim = new Float32Array(max);   // frame cycles over the life (0 = hold a random frame)
    this.frame0 = new Float32Array(max);
    this.vec3s = [this.pos, this.col, this.vel, this.col0, this.col1];
    this.scalars = [this.size, this.alpha, this.rot, this.frame, this.life, this.age, this.grav, this.drag, this.size0, this.size1, this.alpha0, this.fade, this.spin, this.turb, this.seed, this.anim, this.frame0];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('psize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('palpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('prot', new THREE.BufferAttribute(this.rot, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('pframe', new THREE.BufferAttribute(this.frame, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    this.geo = geo;
    this.attrs = [geo.attributes.position, geo.attributes.pcolor, geo.attributes.psize, geo.attributes.palpha, geo.attributes.prot, geo.attributes.pframe];
    const at = atlas || (texture === 'flame' ? FLAME_FRAMES : { cols: 1, rows: 1 });
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: sprite(texture) }, atlas: { value: new THREE.Vector2(at.cols, at.rows) }, viewH: { value: 900 } },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite, depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 20 : 10;
    scene.add(this.points);
    this.c0 = new THREE.Color();
    this.c1 = new THREE.Color();
  }

  /**
   * Spawn `n` particles. All units are metres and seconds.
   * {x,y,z, spread, spreadY, vx,vy,vz, vspread, vspreadY, radial, radialSpread,
   *  life, lifeSpread, size, sizeEnd, sizeJitter, color, colorEnd, colorJitter,
   *  gravity, drag, alpha, fade, rot, rotJitter, spin, spinJitter, turb, anim}
   * `radial` adds a speed in a random direction (a burst); `turb` is a gentle
   * wandering acceleration; `anim` plays the sprite sheet over the life.
   */
  emit(s) {
    const n = s.n ?? 1;
    const c0 = this.c0.set(s.color ?? 0xffffff);
    const c1 = s.colorEnd !== undefined ? this.c1.set(s.colorEnd) : this.c1.copy(c0);
    const sp = s.spread ?? 0, spY = s.spreadY ?? sp;
    const vs = s.vspread ?? 0, vsY = s.vspreadY ?? vs;
    const rad = s.radial ?? 0, radS = s.radialSpread ?? 0;
    const base = s.size ?? 0.3;
    const jit = s.colorJitter ?? 0;
    for (let k = 0; k < n; k++) {
      // Replace the oldest when full: an effect never fails to show, it
      // just cuts the tail of the previous one short.
      const i = this.n < this.max ? this.n++ : this.oldest();
      this.pos[i * 3] = s.x + (Math.random() - 0.5) * 2 * sp;
      this.pos[i * 3 + 1] = s.y + (Math.random() - 0.5) * 2 * spY;
      this.pos[i * 3 + 2] = s.z + (Math.random() - 0.5) * 2 * sp;
      let vx = (s.vx ?? 0) + (Math.random() - 0.5) * 2 * vs;
      let vy = (s.vy ?? 0) + (Math.random() - 0.5) * 2 * vsY;
      let vz = (s.vz ?? 0) + (Math.random() - 0.5) * 2 * vs;
      if (rad || radS) {
        // Uniform direction on the sphere, scaled by a jittered speed.
        const u = Math.random() * 2 - 1, ph = Math.random() * Math.PI * 2, rr = Math.sqrt(1 - u * u);
        const sp2 = rad + (Math.random() - 0.5) * 2 * radS;
        vx += rr * Math.cos(ph) * sp2; vy += u * sp2 * (s.radialFlat ? 0.15 : 1); vz += rr * Math.sin(ph) * sp2;
      }
      this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
      const life = (s.life ?? 1) + (Math.random() - 0.5) * 2 * (s.lifeSpread ?? 0);
      this.life[i] = Math.max(0.05, life);
      this.age[i] = 0;
      this.grav[i] = s.gravity ?? 0;
      this.drag[i] = s.drag ?? 0;
      const sz = base * (1 + (Math.random() - 0.5) * (s.sizeJitter ?? 0.4));
      this.size0[i] = sz;
      this.size1[i] = s.sizeEnd !== undefined ? s.sizeEnd * (sz / base) : sz;
      this.size[i] = sz;
      const cj = jit ? 1 + (Math.random() - 0.5) * jit : 1;
      this.col0[i * 3] = c0.r * cj; this.col0[i * 3 + 1] = c0.g * cj; this.col0[i * 3 + 2] = c0.b * cj;
      this.col1[i * 3] = c1.r; this.col1[i * 3 + 1] = c1.g; this.col1[i * 3 + 2] = c1.b;
      this.alpha0[i] = s.alpha ?? 1;
      this.alpha[i] = 0;
      this.fade[i] = s.fade ?? 0;
      this.rot[i] = (s.rot ?? 0) + (Math.random() - 0.5) * 2 * (s.rotJitter ?? 0);
      this.spin[i] = (s.spin ?? 0) + (Math.random() - 0.5) * 2 * (s.spinJitter ?? 0);
      this.turb[i] = s.turb ?? 0;
      this.seed[i] = Math.random() * 6.283;
      this.anim[i] = s.anim ?? 0;
      this.frame0[i] = Math.floor(Math.random() * this.frames);
      this.frame[i] = this.frame0[i];
    }
  }

  oldest() {
    let best = 0, bestT = -1;
    for (let i = 0; i < this.n; i++) { const t = this.age[i] / this.life[i]; if (t > bestT) { bestT = t; best = i; } }
    return best;
  }

  update(dt) {
    let i = 0;
    const frames = this.frames;
    while (i < this.n) {
      const age = (this.age[i] += dt);
      const life = this.life[i];
      if (age >= life) { this.swapOut(i); continue; }
      const t = age / life;
      const d = this.drag[i] ? Math.max(0, 1 - this.drag[i] * dt) : 1;
      let vx = this.vel[i * 3] * d, vz = this.vel[i * 3 + 2] * d;
      const tb = this.turb[i];
      if (tb) { const sd = this.seed[i]; vx += Math.sin(age * 4.3 + sd) * tb * dt; vz += Math.cos(age * 3.1 + sd * 1.7) * tb * dt; }
      this.vel[i * 3] = vx; this.vel[i * 3 + 2] = vz;
      const vy = this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d + this.grav[i] * dt;
      this.pos[i * 3] += vx * dt;
      this.pos[i * 3 + 1] += vy * dt;
      this.pos[i * 3 + 2] += vz * dt;
      this.size[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * t;
      const f = this.fade[i];
      let a;
      if (f === 1) a = Math.sin(t * Math.PI);
      else if (f === 2) a = t < 0.12 ? t / 0.12 : t > 0.6 ? (1 - t) / 0.4 : 1;
      else if (f === 3) a = (1 - t * t) * (0.55 + 0.45 * Math.sin(age * 23 + this.seed[i] * 4));
      else a = 1 - t;
      this.alpha[i] = this.alpha0[i] * a;
      this.col[i * 3] = this.col0[i * 3] + (this.col1[i * 3] - this.col0[i * 3]) * t;
      this.col[i * 3 + 1] = this.col0[i * 3 + 1] + (this.col1[i * 3 + 1] - this.col0[i * 3 + 1]) * t;
      this.col[i * 3 + 2] = this.col0[i * 3 + 2] + (this.col1[i * 3 + 2] - this.col0[i * 3 + 2]) * t;
      this.rot[i] += this.spin[i] * dt;
      if (frames > 1) { const an = this.anim[i]; this.frame[i] = an ? (this.frame0[i] + Math.floor(t * an * frames)) % frames : this.frame0[i]; }
      i++;
    }
    this.geo.setDrawRange(0, this.n);
    for (let k = 0; k < this.attrs.length; k++) this.attrs[k].needsUpdate = true;
  }

  swapOut(i) {
    const j = --this.n;
    if (i === j) return;
    for (let k = 0; k < this.vec3s.length; k++) { const a = this.vec3s[k]; a[i * 3] = a[j * 3]; a[i * 3 + 1] = a[j * 3 + 1]; a[i * 3 + 2] = a[j * 3 + 2]; }
    for (let k = 0; k < this.scalars.length; k++) { const a = this.scalars[k]; a[i] = a[j]; }
  }
}

/* ------------------------------------------------------------ the effects */

const ease = {
  out: (t) => 1 - (1 - t) ** 3,
  in: (t) => t * t * t,
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  arc: (t) => Math.sin(t * Math.PI),
  outBack: (t) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2,
};

export function createFx(scene, { quality = 'high' } = {}) {
  const q = quality === 'low' ? 0.35 : quality === 'medium' ? 0.7 : 1;
  const fire = new Particles(scene, { max: Math.round(3000 * Math.max(0.5, q)), texture: 'flame', additive: true, frames: FLAME_FRAMES.cols * FLAME_FRAMES.rows });
  const sparks = new Particles(scene, { max: Math.round(2600 * Math.max(0.5, q)), texture: 'spark', additive: true });
  const soft = new Particles(scene, { max: Math.round(2600 * Math.max(0.5, q)), texture: 'soft', additive: true });
  const stars = new Particles(scene, { max: 900, texture: 'star', additive: true });
  const smoke = new Particles(scene, { max: Math.round(1600 * Math.max(0.5, q)), texture: 'smoke', additive: false });
  const dustp = new Particles(scene, { max: 1400, texture: 'dust', additive: false });
  dustp.points.renderOrder = 11;
  const POOLS = [smoke, dustp, fire, soft, sparks, stars];

  const tweens = [];
  const meshes = [];      // temporary meshes: rings, bolts, debris, decals
  const emitters = new Map();
  let shakeAmt = 0, shakeT = 0, shakeDur = 0;
  let clock = 0;          // ms, from update(now)
  let viewH = 0;          // device pixels; 0 = follow the window
  const V = new THREE.Vector3(), V2 = new THREE.Vector3(), V3 = new THREE.Vector3();

  /** Run `fn(t, dt)` for `dur` seconds, t in 0..1, then `done()`. */
  function tween(dur, fn, done, easing = null) {
    const tw = { t0: null, dur, fn, done, easing };
    tweens.push(tw);
    return tw;
  }

  /** Tell the particles how tall the framebuffer is (device pixels) so sizes are true metres. */
  function setViewHeight(px) { viewH = px; }

  /* -------------------------------------------- lights */

  // A fixed pool, always in the scene at zero intensity, handed out to
  // flashes and held by emitters. Adding/removing lights would make three.js
  // rebuild every shader in the scene mid-effect.
  const LIGHT_MAX = quality === 'low' ? 4 : 8;
  const lights = [];
  for (let i = 0; i < LIGHT_MAX; i++) {
    const l = new THREE.PointLight(0xffffff, 0, 1, 1.8);
    l.position.set(0, -100, 0);
    scene.add(l);
    lights.push({ l, busy: false, held: false, t: 0, dur: 0, i0: 0, flicker: 0, colour: 0 });
  }
  function acquireLight(held = false) {
    let pick = null;
    for (const r of lights) if (!r.busy) { pick = r; break; }
    if (!pick) {
      // Steal the flash closest to ending; never a held one.
      let best = -1;
      for (const r of lights) if (!r.held) { const k = r.t / r.dur; if (k > best) { best = k; pick = r; } }
      if (!pick) return null;
    }
    pick.busy = true; pick.held = held; pick.t = 0;
    return pick;
  }
  function freeLights() { let k = 0; for (let i = 0; i < lights.length; i++) if (!lights[i].busy) k++; return k; }
  function releaseLight(r) {
    if (!r) return;
    r.busy = false; r.held = false; r.l.intensity = 0; r.l.position.set(0, -100, 0);
  }
  /** A light that blooms and dies. `flicker` (0..1) adds a strobe to the decay. */
  function flash(x, y, z, colour, intensity = 8, dur = 0.3, dist = 7, { flicker = 0 } = {}) {
    const r = acquireLight(false);
    if (!r) return null;
    r.l.color.set(colour); r.l.intensity = intensity; r.l.distance = dist; r.l.position.set(x, y, z);
    r.dur = dur; r.i0 = intensity; r.flicker = flicker;
    return r;
  }

  function addMesh(m, life, fn) {
    scene.add(m);
    meshes.push({ m, t: 0, life, fn });
    return m;
  }

  /* -------------------------------------------- shared materials */

  const addMat = (map, colour, opacity = 1) => new THREE.MeshBasicMaterial({ map, color: colour, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
  const PLANE = new THREE.PlaneGeometry(2, 2);
  const debrisMats = new Map();
  const debrisMat = (colour) => {
    let m = debrisMats.get(colour);
    if (!m) { m = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.92, flatShading: true }); debrisMats.set(colour, m); }
    return m;
  };
  const DEBRIS_GEOS = [new THREE.DodecahedronGeometry(1, 0), new THREE.TetrahedronGeometry(1.1, 0), new THREE.BoxGeometry(1.4, 0.9, 1.1), new THREE.OctahedronGeometry(1, 0)];

  /* -------------------------------------------- recipes */

  /** A puff of dust at a point: pushes, landings, summons. Soft, lit, settles. */
  function dust(x, y, z, { n = 18, size = 0.5, colour = 0x8a7b62, spread = 0.3, up = 1.2 } = {}) {
    const k = Math.round(n * q);
    dustp.emit({ x, y: y + 0.3, z, n: Math.round(k * 1.4), spread, spreadY: 0.15, vy: up * 0.8, vspread: 0, vspreadY: up * 0.4, radial: 0.9 + up * 0.5, radialSpread: 0.6, radialFlat: true,
      life: 1.1, lifeSpread: 0.4, size: size * 0.45, sizeEnd: size * 1.5, color: colour, colorEnd: colour, colorJitter: 0.35, alpha: 0.42, sizeJitter: 0.8, drag: 2.2, gravity: -0.5, fade: 1,
      rotJitter: 3.14, spinJitter: 1.4, turb: 0.6 });
    // Grit: a few sharp specks that fall out of the cloud.
    sparks.emit({ x, y: y + 0.15, z, n: Math.max(2, Math.round(k * 0.35)), spread: spread * 0.6, vy: up * 1.6, vspreadY: up * 0.6, radial: 1.4, radialSpread: 0.8, radialFlat: true,
      life: 0.6, lifeSpread: 0.25, size: 0.045, sizeEnd: 0.02, color: 0x6a5a44, colorEnd: 0x4a4034, alpha: 0.9, gravity: -7, drag: 0.8 });
  }

  /** Fire: a burst at a point (a fireball landing). */
  function explosion(x, y, z, { r = 1.2, colour = 0xff8a2a } = {}) {
    const k = Math.max(0.5, r);
    // White-hot core that blooms and dies in a quarter second.
    soft.emit({ x, y: y + r * 0.45, z, n: 1, size: r * 0.8, sizeEnd: r * 2.4, life: 0.26, color: 0xffe8b8, colorEnd: colour, alpha: 0.7 });
    soft.emit({ x, y: y + r * 0.45, z, n: Math.round(4 * q) + 1, spread: r * 0.25, size: r * 0.4, sizeEnd: r * 1.1, life: 0.4, lifeSpread: 0.1, radial: r * 1.5, color: 0xffd090, colorEnd: 0xff6a20, alpha: 0.5, drag: 4 });
    // The fireball: flame sprites thrown outward and up, tumbling.
    fire.emit({ x, y: y + r * 0.35, z, n: Math.round(55 * q * k), spread: r * 0.2, radial: r * 2.6, radialSpread: r * 1.4, vy: 1.4 + r,
      life: 0.55, lifeSpread: 0.22, size: r * 0.5, sizeEnd: r * 1.05, color: 0xffcc90, colorEnd: 0x3a0e06, alpha: 0.75, drag: 3.6, gravity: 1.2, fade: 2, anim: 1, rotJitter: 0.5, spinJitter: 1.5 });
    // A rising column a beat later.
    fire.emit({ x, y: y + r * 0.2, z, n: Math.round(22 * q * k), spread: r * 0.3, vy: 3 + r, vspreadY: 1, vspread: 0.4,
      life: 0.7, lifeSpread: 0.2, size: r * 0.45, sizeEnd: r * 0.9, color: 0xffd0a0, colorEnd: 0x2a0a04, alpha: 0.75, drag: 2.2, fade: 2, anim: 1, rotJitter: 0.3, spinJitter: 0.8 });
    // Embers: fast ones thrown out, slow ones that hang and flicker.
    sparks.emit({ x, y: y + r * 0.5, z, n: Math.round(60 * q * k), spread: r * 0.15, radial: 5 + r * 2, radialSpread: 3, vy: 3,
      life: 0.9, lifeSpread: 0.4, size: 0.07, sizeEnd: 0.02, color: 0xfff0b0, colorEnd: 0xff4a10, gravity: -9.8, drag: 0.7, fade: 3 });
    sparks.emit({ x, y: y + r * 0.6, z, n: Math.round(28 * q * k), spread: r * 0.4, radial: 0.8, vy: 1.2, vspreadY: 0.6, turb: 1.8,
      life: 2.4, lifeSpread: 0.9, size: 0.05, sizeEnd: 0.015, color: 0xffd080, colorEnd: 0xff3000, gravity: -0.5, drag: 0.9, fade: 3 });
    // Smoke, dark then thinning.
    smoke.emit({ x, y: y + r * 0.7, z, n: Math.round(14 * q * k), spread: r * 0.3, vy: 1.8, vspreadY: 0.9, radial: 1.0, drag: 1.6, gravity: 0.25,
      life: 2.0, lifeSpread: 0.7, size: r * 0.5, sizeEnd: r * 1.7, color: 0x1c1714, colorEnd: 0x4a4440, alpha: 0.42, fade: 1, rotJitter: 3.14, spinJitter: 0.8, turb: 0.5 });
    // Ground dust pushed out along the floor.
    dustp.emit({ x, y: y + r * 0.3, z, n: Math.round(18 * q * k), spread: r * 0.3, spreadY: r * 0.1, radial: 3 * r, radialSpread: r, radialFlat: true, vy: 0.8,
      life: 1.3, lifeSpread: 0.4, size: r * 0.3, sizeEnd: r * 0.9, color: 0x7a6a55, colorEnd: 0x7a6a55, colorJitter: 0.3, alpha: 0.42, sizeJitter: 0.8, drag: 2.5, gravity: -0.5, fade: 1, rotJitter: 3.14, spinJitter: 1 });
    flash(x, y + r * 0.8, z, 0xffc070, 36 * k, 0.4, r * 9, { flicker: 0.25 });
    ring(x, y, z, r * 2.6, 0xffc080, { dur: 0.45, width: 0.3, opacity: 0.9 });
    ring(x, y, z, r * 1.7, 0xffe8c0, { dur: 0.75, width: 0.6, opacity: 0.45, thin: false });
    scorch(x, y, z, r * 0.95);
    shake(0.08 * r, 0.35);
  }

  /** An expanding shock ring on the ground. `thin` draws a sharper front. */
  function ring(x, y, z, radius, colour, { dur = 0.6, width = 0.1, opacity = 0.9, thin = width < 0.2 } = {}) {
    const m = new THREE.Mesh(PLANE, addMat(sprite(thin ? 'ringThin' : 'ring'), colour, opacity));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y + 0.05, z);
    m.scale.setScalar(0.05);
    m.renderOrder = 6;
    return addMesh(m, dur, (t) => { const e = ease.out(t); m.scale.setScalar(0.05 + e * radius); m.material.opacity = opacity * (1 - t) ** 1.4; });
  }

  /** A dark mark that fades over a long time. */
  function scorch(x, y, z, r) {
    const m = new THREE.Mesh(PLANE, new THREE.MeshBasicMaterial({ map: sprite('scorch'), transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    m.rotation.x = -Math.PI / 2; m.rotation.z = Math.random() * 6.28;
    m.position.set(x, y + 0.02, z);
    m.scale.setScalar(r);
    m.renderOrder = 2;
    return addMesh(m, 40, (t) => { m.material.opacity = 0.85 * (1 - t); });
  }

  /**
   * A bolt flying from A to B over `dur` seconds along a low arc, with a
   * trail. `onArrive` fires at the end -- the damage number waits for it.
   */
  function bolt(a, b, { colour = 0xff9a3a, dur = 0.45, size = 0.22, arc = 0.8, trail = 'fire', onArrive = null, light = 12 } = {}) {
    const head = new THREE.Group();
    const core = new THREE.Mesh(new THREE.SphereGeometry(size * 0.55, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: sprite('soft'), color: colour, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
    halo.scale.setScalar(size * 5);
    const glint = new THREE.Sprite(new THREE.SpriteMaterial({ map: sprite('star'), color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    glint.scale.setScalar(size * 6);
    head.add(core, halo, glint);
    head.position.copy(a);
    scene.add(head);
    const lr = acquireLight(true);
    if (lr) { lr.l.color.set(colour); lr.l.distance = 7; lr.l.intensity = light; }
    const pool = trail === 'fire' ? fire : trail === 'spark' ? sparks : soft;
    const A = a.clone(), B = b.clone();
    const prev = A.clone();
    const spawnStep = size * 0.35;
    let ang = 0;
    tween(dur, (t, dt) => {
      V.lerpVectors(A, B, t);
      V.y += ease.arc(t) * arc;
      head.position.copy(V);
      if (lr) lr.l.position.copy(V);
      glint.material.rotation += dt * 6;
      halo.scale.setScalar(size * (4.6 + Math.sin(clock * 0.03) * 0.8));
      // Lay the trail down along the path actually flown, so speed never leaves gaps.
      const d = V2.subVectors(V, prev).length();
      const steps = Math.min(24, Math.max(1, Math.ceil(d / spawnStep)));
      for (let i = 1; i <= steps; i++) {
        V3.lerpVectors(prev, V, i / steps);
        if (trail === 'fire') {
          fire.emit({ x: V3.x, y: V3.y, z: V3.z, n: 1, spread: size * 0.25, vspread: 0.5, vy: 0.8, life: 0.32, lifeSpread: 0.08, size: size * 2.2, sizeEnd: size * 0.5,
            color: 0xffffff, colorEnd: 0x401006, alpha: 0.9, drag: 2, fade: 0, anim: 1, rotJitter: 0.4, spinJitter: 2 });
          if (i === steps) sparks.emit({ x: V3.x, y: V3.y, z: V3.z, n: Math.random() < 0.6 * q ? 1 : 0, vspread: 1.2, vy: 0.5, life: 0.7, lifeSpread: 0.3, size: 0.05, sizeEnd: 0.015, color: 0xffe0a0, colorEnd: colour, gravity: -6, drag: 0.5, fade: 3 });
          if (i === steps && Math.random() < 0.35 * q) smoke.emit({ x: V3.x, y: V3.y, z: V3.z, n: 1, vy: 0.5, vspread: 0.3, life: 0.9, size: size * 1.5, sizeEnd: size * 4, color: 0x2a2220, colorEnd: 0x3a3634, alpha: 0.3, fade: 1, rotJitter: 3.14, spinJitter: 1 });
        } else {
          pool.emit({ x: V3.x, y: V3.y, z: V3.z, n: 1, spread: size * 0.3, vspread: 0.3, life: 0.38, lifeSpread: 0.1, size: size * 2.4, sizeEnd: size * 0.3,
            color: 0xffffff, colorEnd: colour, alpha: 0.85, drag: 2 });
        }
      }
      if (trail !== 'fire') {
        // Two motes orbiting the head, shed as twinkles.
        ang += dt * 22;
        for (let o = 0; o < 2; o++) {
          const ph = ang + o * Math.PI;
          stars.emit({ x: V.x + Math.cos(ph) * size * 1.6, y: V.y + Math.sin(ph * 0.7) * size * 1.2, z: V.z + Math.sin(ph) * size * 1.6, n: 1, life: 0.3, size: size * 1.4, sizeEnd: size * 0.3, color: colour, alpha: 0.9, fade: 0 });
        }
      }
      prev.copy(V);
    }, () => {
      scene.remove(head);
      core.geometry.dispose();
      releaseLight(lr);
      onArrive?.(b);
    });
  }

  /* --- lightning: a jagged main strand with side forks, drawn in sprites so it
     is thick, glows and restrikes. The path buffer is reused between strikes. */
  const PATH = new Float32Array(3 * 2048);
  let pathN = 0;
  const dirV = new THREE.Vector3(), sideA = new THREE.Vector3(), sideB = new THREE.Vector3();
  function strand(ax, ay, az, bx, by, bz, jitter, depth, out) {
    // Midpoint displacement: the start index of this strand in PATH is returned.
    const start = pathN;
    if (pathN + 3 * (1 << depth) + 3 > PATH.length) return start;
    const n = 1 << depth;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      PATH[(pathN + i) * 3] = ax + (bx - ax) * t; PATH[(pathN + i) * 3 + 1] = ay + (by - ay) * t; PATH[(pathN + i) * 3 + 2] = az + (bz - az) * t;
    }
    dirV.set(bx - ax, by - ay, bz - az);
    const len = dirV.length() || 1;
    dirV.divideScalar(len);
    sideA.set(0, 1, 0); if (Math.abs(dirV.y) > 0.9) sideA.set(1, 0, 0);
    sideA.cross(dirV).normalize(); sideB.crossVectors(dirV, sideA);
    let amp = jitter * len;
    for (let step = n / 2; step >= 1; step /= 2) {
      for (let i = step; i < n; i += step * 2) {
        const i0 = pathN + i;
        const u = (Math.random() - 0.5) * 2 * amp, w = (Math.random() - 0.5) * 2 * amp;
        PATH[i0 * 3] += sideA.x * u + sideB.x * w; PATH[i0 * 3 + 1] += sideA.y * u + sideB.y * w; PATH[i0 * 3 + 2] += sideA.z * u + sideB.z * w;
      }
      amp *= 0.55;
    }
    pathN += n + 1;
    out.push(start, n + 1);
    return start;
  }
  const segs = [];
  function drawStrand(start, count, coreSize, glowSize, colour, alpha, life) {
    const spacing = coreSize * 0.28;
    for (let i = 0; i + 1 < count; i++) {
      const x0 = PATH[(start + i) * 3], y0 = PATH[(start + i) * 3 + 1], z0 = PATH[(start + i) * 3 + 2];
      const x1 = PATH[(start + i + 1) * 3], y1 = PATH[(start + i + 1) * 3 + 1], z1 = PATH[(start + i + 1) * 3 + 2];
      const d = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
      const k = Math.max(1, Math.ceil(d / spacing));
      for (let j = 0; j < k; j++) {
        const u = j / k, x = x0 + (x1 - x0) * u, y = y0 + (y1 - y0) * u, z = z0 + (z1 - z0) * u;
        sparks.emit({ x, y, z, n: 1, life, size: coreSize, sizeJitter: 0, color: 0xffffff, alpha, fade: 0 });
        if (j % 3 === 0) soft.emit({ x, y, z, n: 1, life: life * 1.4, size: glowSize, sizeJitter: 0.3, color: colour, alpha: alpha * 0.33, fade: 0 });
      }
    }
  }
  function strike(a, b, colour, strength, branches) {
    pathN = 0; segs.length = 0;
    const len = a.distanceTo(b);
    strand(a.x, a.y, a.z, b.x, b.y, b.z, 0.16, 5, segs);
    const mainStart = segs[0], mainN = segs[1];
    drawStrand(mainStart, mainN, 0.13 * (0.6 + strength * 0.5), 0.55, colour, strength, 0.1);
    for (let f = 0; f < branches; f++) {
      const i = 4 + Math.floor(Math.random() * (mainN - 10));
      const px = PATH[(mainStart + i) * 3], py = PATH[(mainStart + i) * 3 + 1], pz = PATH[(mainStart + i) * 3 + 2];
      // Fork away from the strand, roughly in the strand's direction.
      const bl = len * (0.15 + Math.random() * 0.25);
      dirV.set(b.x - a.x, b.y - a.y, b.z - a.z).normalize();
      V.set((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5)).normalize().multiplyScalar(0.9).add(dirV).normalize();
      const n0 = segs.length;
      strand(px, py, pz, px + V.x * bl, py + V.y * bl, pz + V.z * bl, 0.2, 3, segs);
      if (segs.length > n0) drawStrand(segs[n0], segs[n0 + 1], 0.065, 0.3, colour, strength * 0.6, 0.08);
      if (Math.random() < 0.5 && segs.length > n0) {
        const s2 = segs[n0], c2 = segs[n0 + 1], j = 2 + Math.floor(Math.random() * (c2 - 3));
        const qx = PATH[(s2 + j) * 3], qy = PATH[(s2 + j) * 3 + 1], qz = PATH[(s2 + j) * 3 + 2];
        V2.set((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5)).normalize().multiplyScalar(0.8).add(V).normalize();
        const n1 = segs.length;
        strand(qx, qy, qz, qx + V2.x * bl * 0.5, qy + V2.y * bl * 0.5, qz + V2.z * bl * 0.5, 0.25, 2, segs);
        if (segs.length > n1) drawStrand(segs[n1], segs[n1 + 1], 0.04, 0.2, colour, strength * 0.4, 0.07);
      }
    }
  }

  /** Lightning between two points: a thick forking bolt that restrikes, a flash, sparks at the foot. */
  function lightning(a, b, { colour = 0xbfe8ff, dur = 0.3 } = {}) {
    const A = a.clone(), B = b.clone();
    let lastPhase = -1;
    const branches = Math.round((3 + Math.random() * 3) * Math.max(0.4, q));
    tween(dur, (t) => {
      const phase = Math.floor(t * dur / 0.075);
      if (phase !== lastPhase) {
        lastPhase = phase;
        const strength = phase === 0 ? 1 : 0.75 * (1 - t) ** 0.6;
        strike(A, B, colour, strength, phase === 0 ? branches : Math.max(1, branches - phase));
      }
    });
    // Sky-side glow at the source, a big soft bloom at the foot.
    soft.emit({ x: A.x, y: A.y, z: A.z, n: 1, life: 0.18, size: 1.4, color: colour, alpha: 0.6 });
    soft.emit({ x: B.x, y: B.y + 0.25, z: B.z, n: 1, life: 0.22, size: 1.2, sizeEnd: 2.2, color: 0xffffff, colorEnd: colour, alpha: 0.9 });
    flash(B.x, B.y + 0.6, B.z, colour, 34, dur + 0.12, 9, { flicker: 0.7 });
    // Sparks skitter off the strike point; a few twinkles hang in the air.
    sparks.emit({ x: B.x, y: B.y + 0.2, z: B.z, n: Math.round(34 * q), spread: 0.15, radial: 4.5, radialSpread: 2.5, vy: 2.5, life: 0.6, lifeSpread: 0.25, size: 0.06, sizeEnd: 0.015, color: 0xffffff, colorEnd: colour, gravity: -9.8, drag: 0.6, fade: 3 });
    stars.emit({ x: B.x, y: B.y + 0.5, z: B.z, n: Math.round(8 * q), spread: 0.4, vy: 0.6, vspread: 0.4, life: 0.5, lifeSpread: 0.2, size: 0.25, sizeEnd: 0.05, color: colour, alpha: 0.9, fade: 3 });
    ring(B.x, B.y, B.z, 1.3, colour, { dur: 0.35, width: 0.12, opacity: 0.8 });
    dustp.emit({ x: B.x, y: B.y + 0.1, z: B.z, n: Math.round(8 * q), radial: 1.6, radialFlat: true, vy: 0.5, life: 0.9, size: 0.3, sizeEnd: 0.9, color: 0x6a6258, alpha: 0.45, drag: 2.5, gravity: -0.6, fade: 1, rotJitter: 3.14 });
    scorch(B.x, B.y, B.z, 0.35);
    shake(0.035, 0.25);
  }

  /**
   * Motes rising from a body: healing (green), poison (sick green), levitation (violet).
   * `drip: true` makes them fall instead (poison dripping); `star` is the share
   * drawn as twinkles.
   */
  function motes(x, y, z, colour, { n = 24, up = 1.4, r = 0.4, life = 1.2, size = 0.14, drip = false, star = 0.3, turb = 0.9 } = {}) {
    const k = Math.round(n * q);
    if (drip) {
      soft.emit({ x, y: y + 0.9, z, n: k, spread: r, spreadY: 0.4, vy: -0.2, vspread: 0.1, life: life * 0.6, lifeSpread: 0.2, size: size * 0.7, sizeEnd: size * 1.1,
        color: colour, colorEnd: colour, alpha: 0.9, gravity: -3, drag: 0.3, fade: 2 });
      dustp.emit({ x, y: y + 0.1, z, n: Math.round(k * 0.3), spread: r, vy: 0.3, life: 1, size: 0.2, sizeEnd: 0.5, color: colour, alpha: 0.3, fade: 1, rotJitter: 3.14 });
      return;
    }
    const ns = Math.round(k * star);
    soft.emit({ x, y: y + 0.2, z, n: k - ns, spread: r, spreadY: 0.3, vy: up, vspread: 0.25, vspreadY: up * 0.3, life, lifeSpread: life * 0.3,
      size, sizeEnd: size * 0.3, color: colour, colorEnd: colour, colorJitter: 0.2, alpha: 0.9, fade: 1, turb, drag: 0.4 });
    stars.emit({ x, y: y + 0.3, z, n: ns, spread: r, spreadY: 0.35, vy: up * 0.75, vspread: 0.2, life: life * 0.9, lifeSpread: life * 0.3,
      size: size * 1.8, sizeEnd: size * 0.5, color: colour, alpha: 0.9, fade: 3, turb: turb * 0.6, spinJitter: 1.5 });
  }

  /** A magic circle under a caster: the spell is resolving. */
  function sigil(x, y, z, colour, { dur = 1.2, r = 0.9 } = {}) {
    const g = new THREE.Group();
    const outer = new THREE.Mesh(PLANE, addMat(sprite('sigilOuter'), colour, 1));
    const inner = new THREE.Mesh(PLANE, addMat(sprite('sigilInner'), colour, 1));
    const glow = new THREE.Mesh(PLANE, addMat(sprite('soft'), colour, 0.45));
    outer.scale.setScalar(r); inner.scale.setScalar(r); glow.scale.setScalar(r * 1.15);
    inner.position.z = 0.01; outer.position.z = 0.02;
    g.add(glow, inner, outer);
    g.rotation.x = -Math.PI / 2;
    g.position.set(x, y + 0.05, z);
    g.renderOrder = 5;
    const lr = flash(x, y + 1.0, z, colour, 7, dur, r * 5);
    if (lr) lr.held = true;
    let acc = 0;
    addMesh(g, dur, (t, dt) => {
      const a = Math.min(1, t * 5) * Math.min(1, (1 - t) * 4) ** 0.8;
      g.scale.setScalar(0.55 + 0.45 * ease.outBack(Math.min(1, t * 2.5)));
      const spin = t * 1.6 + ease.in(t) * 5;
      outer.rotation.z = spin; inner.rotation.z = -spin * 1.5;
      outer.material.opacity = a; inner.material.opacity = a * 0.95; glow.material.opacity = 0.45 * a * (0.75 + 0.25 * Math.sin(clock * 0.012));
      if (lr) { lr.t = 0; lr.l.intensity = 7 * a * (0.8 + 0.2 * Math.sin(clock * 0.02)); }
      // Motes rise from the ring edge for as long as it is lit.
      acc += dt * 26 * q * a;
      while (acc >= 1) {
        acc -= 1;
        const ang = Math.random() * 6.283, rr = r * (0.5 + Math.random() * 0.5);
        soft.emit({ x: x + Math.cos(ang) * rr, y: y + 0.1, z: z + Math.sin(ang) * rr, n: 1, vy: 1.2, vspreadY: 0.5, life: 0.8, lifeSpread: 0.3, size: 0.09, sizeEnd: 0.02, color: colour, alpha: 0.9, fade: 1, turb: 0.6 });
        if (Math.random() < 0.3) stars.emit({ x: x + Math.cos(ang) * rr, y: y + 0.2, z: z + Math.sin(ang) * rr, n: 1, vy: 0.9, life: 0.7, size: 0.16, sizeEnd: 0.04, color: colour, alpha: 1, fade: 3 });
      }
      if (t >= 1 && lr) releaseLight(lr);
    });
    // A pillar of light at the start.
    soft.emit({ x, y: y + 0.6, z, n: Math.round(6 * q) + 1, spreadY: 0.5, size: r * 1.1, sizeEnd: r * 0.4, life: 0.5, lifeSpread: 0.15, vy: 1.5, color: colour, alpha: 0.35, fade: 1 });
  }

  /** Chunks of a shattered thing flying apart: they tumble, bounce, and sink away. */
  function debris(x, y, z, { n = 10, colour = 0x6b6358, size = 0.18, spread = 0.5, up = 4 } = {}) {
    const mat = debrisMat(colour);
    const count = Math.round(n * q) + 2;
    for (let i = 0; i < count; i++) {
      const s = size * (0.45 + Math.random() * 0.9);
      const m = new THREE.Mesh(DEBRIS_GEOS[i % DEBRIS_GEOS.length], mat);
      m.scale.set(s * (0.7 + Math.random() * 0.6), s * (0.6 + Math.random() * 0.6), s * (0.7 + Math.random() * 0.6));
      m.castShadow = true;
      m.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
      m.position.set(x + (Math.random() - 0.5) * spread, y + 0.3 + Math.random() * spread, z + (Math.random() - 0.5) * spread);
      const ang = Math.random() * 6.283, sp = 1.5 + Math.random() * 3.5;
      const v = new THREE.Vector3(Math.cos(ang) * sp, up * (0.5 + Math.random()), Math.sin(ang) * sp);
      const w = new THREE.Vector3((Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16);
      const floor = y;
      const radius = s * 0.7;
      let settled = false, bounces = 0;
      const life = 5 + Math.random() * 2;
      addMesh(m, life, (t, dt) => {
        if (!settled) {
          v.y -= 9.8 * dt;
          m.position.addScaledVector(v, dt);
          m.rotation.x += w.x * dt; m.rotation.y += w.y * dt; m.rotation.z += w.z * dt;
          if (m.position.y <= floor + radius) {
            m.position.y = floor + radius;
            const speed = Math.abs(v.y);
            if (speed > 1.2 && bounces < 3) {
              v.y = speed * 0.4; v.x *= 0.55; v.z *= 0.55; w.multiplyScalar(0.5); bounces++;
              if (speed > 2.5) dustp.emit({ x: m.position.x, y: floor + 0.05, z: m.position.z, n: 2, radial: 0.6, radialFlat: true, vy: 0.4, life: 0.7, size: s * 1.2, sizeEnd: s * 3, color: 0x7a6d5c, alpha: 0.4, drag: 2.5, fade: 1, rotJitter: 3.14 });
            } else { settled = true; v.set(0, 0, 0); }
          }
        }
        // Sink into the ground over the last stretch instead of popping out.
        if (t > 0.8) m.position.y = floor + radius - (t - 0.8) / 0.2 * radius * 2.2;
      });
    }
    // Finer fragments as sparks of the same colour, and the dust of the break.
    sparks.emit({ x, y: y + 0.4, z, n: Math.round(16 * q), spread: spread * 0.5, radial: 3, radialSpread: 1.5, vy: up * 0.6, life: 0.9, lifeSpread: 0.3, size: 0.05, sizeEnd: 0.03, color: colour, colorJitter: 0.3, alpha: 1, gravity: -9.8, drag: 0.5 });
    dust(x, y, z, { n: 20, size: 0.6, colour: 0x7a6d5c, spread: spread * 0.6, up: 1.4 });
  }

  /** Camera shake: amplitude in metres, decaying over `dur`. The arena applies the offset. */
  function shake(amt, dur = 0.4) {
    const k = shakeAmt > 0 ? Math.max(0, 1 - shakeT / shakeDur) : 0;
    if (amt > shakeAmt * k * k) { shakeAmt = amt; shakeDur = dur; shakeT = 0; }
  }
  function shakeOffset(out) {
    if (shakeAmt <= 0) { out.set(0, 0, 0); return out; }
    const k = Math.max(0, 1 - shakeT / shakeDur);
    const a = shakeAmt * k * k;
    // Smooth noise at 5-8 Hz: a shudder rather than a 60 Hz buzz.
    const t = clock * 0.001;
    out.set(
      a * (Math.sin(t * 31.0) * 0.6 + Math.sin(t * 47.3 + 1.3) * 0.4),
      a * 0.7 * (Math.sin(t * 37.7 + 2.1) * 0.6 + Math.sin(t * 53.1 + 0.7) * 0.4),
      a * (Math.sin(t * 29.3 + 4.2) * 0.6 + Math.sin(t * 41.9 + 3.3) * 0.4));
    return out;
  }

  /** A sustained glowing link between two points: splices, confluences, siphons. */
  function beam(a, b, colour = 0x9fd8ff, { dur = 0.8, width = 0.12 } = {}) {
    const A = a.clone(), B = b.clone();
    const len = A.distanceTo(B);
    const la = flash(A.x, A.y, A.z, colour, 5, dur, 4), lb = flash(B.x, B.y, B.z, colour, 5, dur, 4);
    if (la) la.held = true; if (lb) lb.held = true;
    const dir = B.clone().sub(A).normalize();
    const heart = new THREE.Color(colour).lerp(new THREE.Color(0xffffff), 0.55).getHex();
    let acc = 0;
    tween(dur, (t, dt) => {
      const a0 = Math.min(1, t * 6) * Math.min(1, (1 - t) * 5);
      const pulse = 0.8 + 0.2 * Math.sin(clock * 0.03);
      if (la) { la.t = 0; la.l.intensity = 5 * a0 * pulse; } if (lb) { lb.t = 0; lb.l.intensity = 5 * a0 * pulse; }
      // The core, laid down fresh each frame with a short life so it dies with the beam.
      const spacing = width * 0.3, k = Math.ceil(len / spacing);
      for (let i = 0; i <= k; i++) {
        const u = i / k;
        V.lerpVectors(A, B, u);
        const wave = 0.75 + 0.25 * Math.sin(u * 40 - clock * 0.025);
        sparks.emit({ x: V.x, y: V.y, z: V.z, n: 1, life: 0.1, size: width * 0.5 * wave, color: heart, alpha: 0.32 * a0, fade: 0 });
        if (i % 4 === 0) soft.emit({ x: V.x, y: V.y, z: V.z, n: 1, life: 0.14, size: width * 3.5 * wave, color: colour, alpha: 0.24 * a0, fade: 0 });
      }
      // Motes streaming along it, and twinkles at the anchors.
      acc += dt * 50 * q * a0;
      while (acc >= 1) {
        acc -= 1;
        const spd = 5 + Math.random() * 3;
        soft.emit({ x: A.x, y: A.y, z: A.z, n: 1, spread: width * 1.5, vx: dir.x * spd, vy: dir.y * spd, vz: dir.z * spd, life: len / spd, size: width * 0.9, sizeEnd: width * 0.3, color: colour, alpha: 0.7, fade: 1, turb: 1.5 });
        if (Math.random() < 0.25) stars.emit({ x: Math.random() < 0.5 ? A.x : B.x, y: (Math.random() < 0.5 ? A.y : B.y) + 0.1, z: Math.random() < 0.5 ? A.z : B.z, n: 1, spread: 0.2, vy: 0.6, life: 0.5, size: 0.22, sizeEnd: 0.05, color: colour, alpha: 1, fade: 3 });
      }
      soft.emit({ x: A.x, y: A.y, z: A.z, n: 1, life: 0.1, size: width * 5 * pulse, color: colour, alpha: 0.4 * a0 });
      soft.emit({ x: B.x, y: B.y, z: B.z, n: 1, life: 0.1, size: width * 5 * pulse, color: colour, alpha: 0.4 * a0 });
      if (t >= 1) { releaseLight(la); releaseLight(lb); }
    });
    burst(B.x, B.y, B.z, colour, { n: 14, r: 0.3 });
  }

  /** A generic sparkle burst: score, keyword grant, a buff landing. */
  function burst(x, y, z, colour = 0xffd27a, { n = 30, r = 0.5, up = 1.5 } = {}) {
    const k = Math.round(n * q);
    soft.emit({ x, y, z, n: 1, size: r * 1.0, sizeEnd: r * 2.6, life: 0.3, color: colour, colorEnd: colour, alpha: 0.7 });
    stars.emit({ x, y, z, n: Math.round(k * 0.5), spread: r * 0.2, radial: 2.2 + r * 2, radialSpread: 1.2, vy: up, life: 0.8, lifeSpread: 0.3, size: 0.26, sizeEnd: 0.05, color: colour, alpha: 1, drag: 3, gravity: -2, fade: 3, spinJitter: 2 });
    soft.emit({ x, y, z, n: Math.round(k * 0.5), spread: r * 0.2, radial: 1.6 + r, radialSpread: 0.8, vy: up * 0.8, life: 0.9, lifeSpread: 0.3, size: 0.16, sizeEnd: 0.04, color: colour, colorEnd: colour, alpha: 0.8, drag: 3, gravity: -1.5, fade: 1, turb: 1 });
    flash(x, y + 0.3, z, colour, 8, 0.3, 4);
    ring(x, y - 0.0, z, r * 1.8, colour, { dur: 0.4, width: 0.3, opacity: 0.5 });
  }

  /** The ground heaves: staggered rings, a wall of dust, pebbles, a long shake. */
  function quake(x, y, z, { r = 3, dur = 0.9, colour = 0xd9b48a } = {}) {
    let fired = 0;
    tween(0.45, (t) => {
      const want = Math.min(3, Math.floor(t * 3) + 1);
      while (fired < want) { ring(x, y, z, r * (0.6 + fired * 0.25), colour, { dur: 0.8, width: 0.35, opacity: 0.7 }); fired++; }
    });
    dust(x, y, z, { n: 80, size: 0.9, spread: r * 0.6, up: 1.2 });
    debris(x, y, z, { n: 6, colour: 0x6b6358, size: 0.07, spread: r * 0.8, up: 2.5 });
    shake(0.22, dur);
  }

  /* -------------------------------------------- continuous emitters */

  /** Something is burning. `pos` is the base; `h` its height; `r` its radius. */
  function burn(key, x, y, z, r, h, { rate = 1 } = {}) {
    const old = emitters.get(key);
    if (old?.light) releaseLight(old.light);
    emitters.set(key, { kind: 'fire', x, y, z, r, h, rate, acc: 0, light: null, seed: Math.random() * 100 });
  }
  function unburn(key) {
    const e = emitters.get(key);
    if (e?.light) releaseLight(e.light);
    emitters.delete(key);
  }
  /** A thing hanging in the air by magic: violet motes drifting down beneath it. */
  function levitating(key, x, y, z, r) {
    const old = emitters.get(key);
    if (old?.light) releaseLight(old.light);
    emitters.set(key, { kind: 'lev', x, y, z, r, acc: 0, light: null, seed: Math.random() * 100 });
  }
  function moveEmitter(key, x, y, z) {
    const e = emitters.get(key);
    if (e) { e.x = x; e.y = y; e.z = z; }
  }

  function stepEmitters(dt, now) {
    for (const e of emitters.values()) {
      if (e.kind === 'fire') {
        const k = 0.55 + e.r * 0.9;                   // bigger things burn with bigger tongues
        e.acc += dt * (60 + 45 * e.h) * e.rate * q;
        while (e.acc >= 1) {
          e.acc -= 1;
          const ang = Math.random() * Math.PI * 2, rr = e.r * (0.2 + 0.85 * Math.random());
          const hy = Math.random() ** 0.75 * e.h * 0.85;
          const px = e.x + Math.cos(ang) * rr, pz = e.z + Math.sin(ang) * rr, py = e.y + hy;
          fire.emit({ x: px, y: py, z: pz, n: 1, spread: 0.06, vy: 1.0 + Math.random() * 1.3, vspread: 0.3, life: 0.55, lifeSpread: 0.2,
            size: 0.6 * k, sizeEnd: 1.05 * k, sizeJitter: 0.5, color: 0xffd0a0, colorEnd: 0x5a1606, alpha: 0.8, drag: 0.9, fade: 2, anim: 1, rotJitter: 0.35, spinJitter: 0.6, turb: 0.9 });
          const roll = Math.random();
          if (roll < 0.1) soft.emit({ x: px, y: py - 0.1, z: pz, n: 1, vy: 0.8, life: 0.3, size: 0.4 * k, sizeEnd: 0.15 * k, color: 0xffd070, alpha: 0.45, fade: 1 });
          else if (roll < 0.34) sparks.emit({ x: px, y: py + 0.2, z: pz, n: 1, vy: 1.6 + Math.random() * 1.8, vspread: 0.8, life: 1.8, lifeSpread: 0.8, size: 0.05, sizeEnd: 0.015, color: 0xffd27a, colorEnd: 0xff3a00, gravity: -0.6, drag: 0.4, fade: 3, turb: 2.2 });
          if (roll > 0.9) smoke.emit({ x: px, y: e.y + e.h * (0.7 + Math.random() * 0.35), z: pz, n: 1, spread: 0.1, vy: 1.0 + Math.random() * 0.8, vspread: 0.25, life: 2.8, lifeSpread: 0.9,
            size: 0.5 * k, sizeEnd: 1.8 * k, color: 0x221d1a, colorEnd: 0x4c4642, alpha: 0.36, drag: 0.7, fade: 1, rotJitter: 3.14, spinJitter: 0.6, turb: 0.9 });
        }
        if (!e.light) { e.light = acquireLight(true); if (e.light) { e.light.l.color.set(0xff7a20); e.light.l.distance = 6 + e.r * 3 + e.h; } }
        if (e.light) {
          e.light.l.position.set(e.x, e.y + e.h * 0.55, e.z);
          const s = e.seed;
          e.light.l.intensity = (9 + 4 * e.h * e.rate) * (0.8 + 0.12 * Math.sin(now / 61 + s) + 0.08 * Math.sin(now / 23 + s * 2) + 0.06 * Math.sin(now / 9.7 + s));
        }
      } else if (e.kind === 'lev') {
        e.acc += dt * 12 * q;
        while (e.acc >= 1) {
          e.acc -= 1;
          const ang = Math.random() * Math.PI * 2, rr = Math.random() * e.r * 0.9;
          const x = e.x + Math.cos(ang) * rr, z = e.z + Math.sin(ang) * rr;
          if (Math.random() < 0.25) stars.emit({ x, y: e.y - 0.05, z, n: 1, vy: -0.45, life: 1.2, lifeSpread: 0.4, size: 0.15, sizeEnd: 0.04, color: 0xd2b4ff, alpha: 0.9, fade: 3, spinJitter: 1 });
          else soft.emit({ x, y: e.y - 0.1, z, n: 1, vy: -0.6, vspread: 0.1, life: 1.5, lifeSpread: 0.5, size: 0.12, sizeEnd: 0.03, color: 0xb98bff, colorEnd: 0x6a3cff, alpha: 0.85, fade: 1, turb: 0.5 });
        }
        if (!e.light && freeLights() > 3) { e.light = acquireLight(true); if (e.light) { e.light.l.color.set(0x9a6cff); e.light.l.distance = 3 + e.r * 2; } }
        if (e.light) { e.light.l.position.set(e.x, e.y - 0.2, e.z); e.light.l.intensity = 2.5 + 0.6 * Math.sin(now / 150 + e.seed); }
      }
    }
  }

  /* -------------------------------------------- frame */

  function update(dt, now) {
    clock = now;
    const vh = viewH || ((typeof window !== 'undefined' ? window.innerHeight : 900) * Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    for (let k = 0; k < POOLS.length; k++) POOLS[k].mat.uniforms.viewH.value = vh;
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i];
      if (tw.t0 === null) tw.t0 = now;
      let t = (now - tw.t0) / 1000 / tw.dur;
      if (t >= 1) { tw.fn(1, dt); tweens.splice(i, 1); tw.done?.(); continue; }
      if (tw.easing) t = tw.easing(t);
      tw.fn(t, dt);
    }
    for (let i = 0; i < lights.length; i++) {
      const r = lights[i];
      if (!r.busy || r.held) continue;
      r.t += dt;
      if (r.t >= r.dur) { releaseLight(r); continue; }
      const k = 1 - r.t / r.dur;
      r.l.intensity = r.i0 * k * k * (r.flicker ? 1 - r.flicker * 0.5 * (1 + Math.sin(now * 0.07 + i)) * (1 - k) : 1);
    }
    for (let i = meshes.length - 1; i >= 0; i--) {
      const r = meshes[i];
      r.t += dt;
      const t = Math.min(1, r.t / r.life);
      r.fn?.(t, dt);
      if (r.t >= r.life) { scene.remove(r.m); disposeDeep(r.m); meshes.splice(i, 1); }
    }
    if (shakeAmt > 0) { shakeT += dt; if (shakeT >= shakeDur) shakeAmt = 0; }
    stepEmitters(dt, now);
    for (let k = 0; k < POOLS.length; k++) POOLS[k].update(dt);
  }

  function disposeDeep(o) {
    // Per-effect geometries and materials go; the shared plane, debris shapes,
    // debris materials and canvas textures stay.
    o.traverse?.((c) => {
      if (c.geometry && c.geometry !== PLANE && !DEBRIS_GEOS.includes(c.geometry)) c.geometry.dispose();
      if (c.material && !debrisMats.has(c.material.color?.getHex?.()) && c.material.dispose) c.material.dispose();
    });
  }

  return {
    tween, flash, dust, explosion, ring, scorch, bolt, lightning, motes, sigil, debris, shake, shakeOffset,
    beam, burst, quake, setViewHeight,
    burn, unburn, levitating, moveEmitter, update, ease, pools: { fire, sparks, soft, smoke, stars, dust: dustp },
  };
}
