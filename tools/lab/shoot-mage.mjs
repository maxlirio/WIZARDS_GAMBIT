#!/usr/bin/env node
// Photograph the mage in every state, close up, in headless Chrome over the
// DevTools protocol. Needs the dev server:
//
//   python3 tools/serve.py 8321 &
//   node tools/lab/shoot-mage.mjs [--port 8321] [--shots DIR] [--only walk,run] [--solo] [--w 960 --h 720]
//   node tools/lab/shoot-mage.mjs --strip walk,hitA,tr-walk-hit-walk [--strip all] [--strip clips] [--strip trans]
//
// --solo photographs one mage at the origin (the death/respawn rites read
// better without the second mage in the dust).
//
// --strip photographs a clip (or a sequence of states, for a transition) at
// evenly spaced times on the lab's stepped clock (?manual=1), composited into
// ONE wide PNG per strip with the time and the body's state on each cell, and
// prints the lowest foot height seen so a foot through the floor is caught.
// Two adjacent cells that do not look like neighbours are a pop.
//
// Prints the directory the PNGs went to. Exit 1 on any page exception.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const port = +arg('port', 8321);
const shots = arg('shots', '/private/tmp/claude-501/-Users-maxlirio/5f1f44e3-ffc5-42ab-b5dd-b5b2bc7ccebd/scratchpad/mage3/shots');
const only = arg('only', '') ? arg('only', '').split(',') : null;
const stripArg = arg('strip', '');
const W = +arg('w', 960), H = +arg('h', 720);
const solo = process.argv.includes('--solo') || !!stripArg;
mkdirSync(shots, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DBG = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', '--mute-audio', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
  `--window-size=${W},${H}`, '--force-device-scale-factor=1', `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'wgmage-'))}`, '--no-first-run',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tabs;
for (let k = 0; k < 50; k++) { try { tabs = await (await fetch(`http://127.0.0.1:${DBG}/json`)).json(); if (tabs.length) break; } catch { } await sleep(200); }
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const wait = new Map();
const errors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); return; }
  if (d.method === 'Runtime.exceptionThrown') { const e = d.params.exceptionDetails; errors.push(`EXCEPTION ${e.exception?.description || e.text} @ ${e.url || ''}:${e.lineNumber}`); }
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push('console.error ' + d.params.args.map((a) => a.value ?? a.description).join(' '));
  if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error' && !/favicon/.test(d.params.entry.url || '')) errors.push(`log ${d.params.entry.text} ${d.params.entry.url || ''}`);
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails)));
  return r.result?.result?.value;
};
let shotN = 0;
async function shot(name) {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  const f = join(shots, `mage3-${String(++shotN).padStart(2, '0')}_${name}.png`);
  writeFileSync(f, Buffer.from(s.result.data, 'base64'));
  console.log('  shot', f);
  return f;
}
async function boot(query) {
  await send('Page.navigate', { url: `http://localhost:${port}/tools/lab/mage.html${query}` });
  for (let k = 0; k < 150; k++) { if (await ev('!!(window.LAB && LAB.ready)')) break; await sleep(200); }
  if (!await ev('!!(window.LAB && LAB.ready)')) throw new Error('lab did not boot');
  await ev(`document.getElementById('bar').style.display='none'`);
}

// [name, state to trigger, camera view, ms to wait before the shot]. Several
// shots of one state catch it at different moments.
const PLAN = [
  ['idle-close', 'idle', 'close', 700],
  ['idle-face', 'idle', 'face', 400],
  ['idle-face-red', 'idle', 'face1', 400],
  ['idle-face0', 'idle', 'face0', 400],
  ['idle-staff', 'idle', 'staff', 400],
  ['idle-side', 'idle', 'side', 400],
  ['idle-sideclose', 'idle', 'sideclose', 400],
  ['idle-back', 'idle', 'back', 400],
  ['idle-quarter', 'idle', 'quarter', 400],
  ['idle-hd', 'idle', 'hd', 400],
  ['idle-far', 'idle', 'far', 400],
  ['walk-a', 'walk', 'close', 500],
  ['walk-b', 'walk', 'close', 350],
  ['walk-side', 'walk', 'side', 300],
  ['run-a', 'run', 'close', 500],
  ['run-b', 'run', 'close', 250],
  ['run-side', 'run', 'side', 200],
  ['fidget', 'fidget', 'close', 900],
  ['fidget-b', 'fidget', 'close', 1500],
  ['shoot-a', 'shoot', 'close', 250],
  ['shoot-b', 'shoot', 'quarter', 120],
  ['raise-a', 'raise', 'jump', 500],
  ['raise-b', 'raise', 'close', 250],
  ['long-a', 'long', 'close', 700],
  ['long-b', 'long', 'quarter', 1100],
  ['hit-a', 'hit', 'close', 120],
  ['hit-b', 'hit', 'close', 120],
  ['fire-a', 'fire', 'close', 250],
  ['fire-b', 'fire', 'close', 750],
  ['lightning-a', 'lightning', 'close', 150],
  ['lightning-b', 'lightning', 'close', 500],
  ['crush-a', 'crush', 'low', 250],
  ['crush-b', 'crush', 'low', 1500],
  ['crush-c', 'crush', 'low', 500],
  ['shove-a', 'shove', 'side', 250],
  ['shove-b', 'shove', 'side', 450],
  ['strike-a', 'strike', 'close', 300],
  ['strike-b', 'strike', 'close', 450],
  ['jump-start', 'jump', 'jump', 200],
  ['jump-air', 'jump', 'jump', 500],
  ['jump-land', 'jump', 'jump', 1000],
  ['jump-done', 'idle', 'close', 900],
  ['tumble-air', 'tumble', 'jump', 350],
  ['tumble-crash', 'tumble', 'low', 900],
  ['tumble-up', 'tumble', 'low', 900],
  ['tumble-done', 'idle', 'close', 1400],
  ['burn', 'burn', 'close', 400],
  ['levitate-a', 'levitate', 'close', 900],
  ['levitate-b', 'levitate', 'side', 1300],
  ['cheer', 'cheer', 'close', 700],
  ['cheer-b', 'cheer', 'jump', 400],
  ['die-a', 'die', 'low', 450],
  ['die-b', 'die', 'low', 400],
  ['die-rest', 'idle', 'low', 1200],
  ['revive-0', 'revive', 'low', 60],
  ['revive-a', 'revive', 'low', 500],
  ['revive-b', 'revive', 'low', 500],
  ['revive-done', 'idle', 'close', 1500],
  ['hit-twice', 'hit2', 'close', 150],
  ['hit-twice-done', 'idle', 'close', 900],
  ['turn', 'turn', 'close', 250],
  // The arena's death and respawn rites, start to finish (times add up along the sequence).
  ['death-fallen', 'death', 'low', 1900],
  ['death-dust-a', 'death', 'low', 550],
  ['death-dust-b', 'death', 'low', 300],
  ['death-gone', 'death', 'low', 1000],
  ['respawn-gather-a', 'respawn', 'low', 450],
  ['respawn-gather-b', 'respawn', 'low', 450],
  ['respawn-forming', 'respawn', 'low', 300],
  ['respawn-up', 'respawn', 'low', 700],
  ['respawn-risen', 'respawn', 'close', 1500],
];

// Strips. seq: [[seconds, state]] triggered on the stepped clock; from/dur:
// the window photographed; n cells evenly over it, or one every dt seconds.
const CLIP = (state, dur, extra = {}) => ({ seq: [[0, state]], from: 0, dur, n: 10, view: 'strip', ...extra });
const STRIPS = {
  idle: CLIP('idle', 4.2, { n: 8 }),
  walk: CLIP('walk', 1.0, { from: 1.5, view: 'stripside' }),
  walkfront: CLIP('walk', 1.0, { from: 1.5, view: 'stripfront' }),
  run: CLIP('run', 0.62, { from: 1.5, view: 'stripside' }),
  runfront: CLIP('run', 0.62, { from: 1.5, view: 'stripfront' }),
  hitA: CLIP('hit', 0.7),
  hitB: { seq: [[0, 'hit'], [1.0, 'hit']], from: 1.0, dur: 0.7, n: 10, view: 'strip' },
  hitFire: CLIP('fire', 0.8),
  hitLightning: CLIP('lightning', 0.8),
  knockdown: CLIP('knockdown', 2.0, { n: 12 }),
  knockdownF: CLIP('knockdownF', 2.0, { n: 12 }),
  knockdownL: CLIP('knockdownL', 2.0, { n: 12, view: 'stripfront' }),
  'drop-soft': { seq: [[0, 'drop'], [0.8, 'landsoft']], from: 0, dur: 1.7, n: 12, view: 'striphigh' },
  'drop-hard': { seq: [[0, 'drop'], [0.8, 'landhard']], from: 0, dur: 2.1, n: 12, view: 'striphigh' },
  'drop-hard-side': { seq: [[0, 'drop'], [0.8, 'landhard']], from: 0.7, dur: 1.4, n: 12, view: 'stripair' },
  tumble: CLIP('tumble', 3.4, { n: 12, view: 'striphigh' }),
  jump: CLIP('jump', 1.7, { n: 12, view: 'striphigh' }),
  cast: CLIP('shoot', 0.9),
  raise: CLIP('raise', 1.3),
  long: CLIP('long', 2.0),
  strike: CLIP('strike', 1.0),
  shove: CLIP('shove', 1.2),
  crush: CLIP('crush', 2.8, { n: 12 }),
  death: CLIP('die', 1.8),
  standUp: { seq: [[0, 'die'], [2.0, 'revive']], from: 2.0, dur: 1.5, n: 10, view: 'strip' },
  cheer: CLIP('cheer', 1.0),
  levitate: CLIP('levitate', 3.0, { n: 8 }),
  // Transitions, every 70 ms: a pop between two neighbours is a bug.
  'tr-idle-walk-stop': { seq: [[0.3, 'walk'], [1.7, 'stop']], from: 0.1, dur: 2.5, dt: 0.07, view: 'strip' },
  'tr-idle-run-stop': { seq: [[0.3, 'run'], [1.5, 'stop']], from: 0.1, dur: 2.2, dt: 0.07, view: 'strip' },
  'tr-walk-hit-walk': { seq: [[0, 'walk'], [1.2, 'hitmoving']], from: 1.0, dur: 1.3, dt: 0.07, view: 'strip' },
  'tr-walk-cast-walk': { seq: [[0, 'walk'], [1.2, 'shootmoving']], from: 1.0, dur: 1.3, dt: 0.07, view: 'strip' },
  'tr-walk-drop-land-walk': { seq: [[0, 'walk'], [1.0, 'drop'], [1.8, 'landsoft']], from: 0.8, dur: 2.0, dt: 0.07, view: 'striphigh' },
  'tr-walk-drop-roll-walk': { seq: [[0, 'walk'], [1.0, 'drop'], [1.8, 'landhard']], from: 0.8, dur: 2.5, dt: 0.07, view: 'striphigh' },
  'tr-run-knockdown-idle': { seq: [[0, 'run'], [1.0, 'knockmoving']], from: 0.8, dur: 2.4, dt: 0.07, view: 'strip' },
  'tr-idle-hit-hit-idle': { seq: [[0.2, 'hit'], [0.45, 'hit']], from: 0, dur: 1.4, dt: 0.05, view: 'strip' },
  'tr-walk-turn': { seq: [[0, 'walk'], [1.2, 'turnwalk']], from: 1.0, dur: 1.6, dt: 0.07, view: 'stripfront' },
  'tr-idle-cast-idle': { seq: [[0.2, 'shoot']], from: 0, dur: 1.4, dt: 0.05, view: 'strip' },
};
const stripList = !stripArg ? [] : stripArg === 'all' ? Object.keys(STRIPS) : stripArg === 'clips' ? Object.keys(STRIPS).filter((k) => !k.startsWith('tr-')) : stripArg === 'trans' ? Object.keys(STRIPS).filter((k) => k.startsWith('tr-')) : stripArg.split(',');

async function shootStrip(name) {
  const S = STRIPS[name];
  if (!S) throw new Error('no strip ' + name);
  await boot('?solo=1&manual=1');
  await ev(`LAB.follow = true; LAB.view(${JSON.stringify(S.view)}); LAB.advance(0)`);
  const times = [];
  if (S.n) for (let i = 0; i < S.n; i++) times.push(S.from + S.dur * i / (S.n - 1));
  else for (let t = S.from; t <= S.from + S.dur + 1e-6; t += S.dt) times.push(t);
  const cells = times.length, cols = Math.min(cells, S.n ? 5 : 8), rows = Math.ceil(cells / cols);
  const cw = S.n ? 384 : 300, ch = Math.round(cw * H / W);
  await ev(`LAB.strip(${cols}, ${rows}, ${cw}, ${ch})`);
  const events = [...S.seq].sort((a, b) => a[0] - b[0]);
  let frames = 0;
  const advanceTo = async (t) => { const n = Math.round(t * 60) - frames; if (n > 0) { await ev(`LAB.advance(${n / 60})`); frames += n; } };
  let minToe = Infinity, minToeAt = 0;
  const log = [];
  for (const g of times) {
    while (events.length && events[0][0] <= g + 1e-6) { const [t, st] = events.shift(); await advanceTo(t); await ev(`LAB.trigger(${JSON.stringify(st)})`); }
    await advanceTo(g);
    const m = await ev('LAB.measure()');
    if (m.toeY < minToe) { minToe = m.toeY; minToeAt = g; }
    log.push(`${g.toFixed(2)}:${m.step}${m.overlay ? '+' + m.overlay : ''}/${m.spd}/w${m.locoW}/toe${m.toeY}`);
    await ev(`LAB.grab(${JSON.stringify(`${name} ${g.toFixed(2)}s ${m.step}${m.overlay ? '+' + m.overlay : ''} spd${m.spd}`)})`);
  }
  const data = await ev('LAB.stripPNG()');
  const f = join(shots, `strip_${name}.png`);
  writeFileSync(f, Buffer.from(data.split(',')[1], 'base64'));
  console.log(`  strip ${f}\n    cells ${cells}  min toeY ${minToe} at ${minToeAt.toFixed(2)}s${minToe < -0.02 ? '  <-- FOOT THROUGH FLOOR' : ''}\n    ${log.join('  ')}`);
}

try {
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  if (stripList.length) {
    for (const name of stripList) await shootStrip(name);
  } else {
    await boot(solo ? '?solo=1' : '');
    await sleep(600);
    console.log('  measure', JSON.stringify(await ev('LAB.measure()')));
    console.log('  clips', JSON.stringify(await ev('LAB.clips')));
    let lastState = null;
    for (const [name, state, v, delay] of PLAN) {
      if (only && !only.some((o) => name.startsWith(o))) continue;
      await ev(`LAB.view(${JSON.stringify(v)})`);
      // Re-trigger one-shots for each shot so every frame is caught fresh; keep
      // loops (idle/walk/run/cheer) running between shots of the same state.
      const loops = ['idle', 'walk', 'run', 'hit2', 'levitate', 'jump', 'tumble', 'crush', 'die', 'death', 'respawn'];
      if (state !== lastState || !loops.includes(state)) {
        if (state === 'revive' && lastState === 'revive') { /* same stand-up, later */ }
        else if (state === 'idle' && (lastState === 'die' || lastState === 'revive')) { /* keep lying / finish standing */ }
        else await ev(`LAB.trigger(${JSON.stringify(state)})`);
      }
      lastState = state;
      await sleep(delay);
      const m = await ev('LAB.measure()');
      await shot(name);
      console.log(`    ${name}: top ${m.top} bottom ${m.bottom} orb ${m.orb} capeZ ${m.capeZ} toeY ${m.toeY} facing ${m.facing} tris ${m.tris} calls ${m.calls} height ${m.height} ${m.step}`);
    }
  }
} catch (e) {
  errors.push('harness: ' + e.message);
}
if (errors.length) console.log('ERRORS\n  ' + errors.slice(0, 10).join('\n  '));
console.log('shots in', shots);
chrome.kill();
process.exit(errors.length ? 1 : 0);
