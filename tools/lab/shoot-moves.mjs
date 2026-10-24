#!/usr/bin/env node
// Photograph bodies IN MOTION in the moves lab with headless Chrome: a mage
// walking off a plateau, one being struck, one slammed into a wall, one
// knocked down, a self-cast dash beside an enemy shove, a spell bolt, a
// killing strike, the respawn after it and an Earth Wall taking a bolt --
// every scene a real engine call, played through the view's cues as main.js
// plays them.
// Each scene is shot every STEP ms for its whole length, and the frames are
// laid out on one contact sheet per scene (drawn by the page itself), so a
// whole motion can be judged at a glance, adjacent frames for pops.
//
//   python3 tools/serve.py 8321 &
//   node tools/lab/shoot-moves.mjs [--port 8321] [--shots DIR] [--only walkDown,struck] [--seed 3] [--step 100]
//
// Exit code 1 if the page threw or a scene did not run.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const port = +arg('port', 8321);
const shots = arg('shots', join(tmpdir(), 'wg-moves'));
const W = +arg('w', 1280), H = +arg('h', 800);
const seed = +arg('seed', 3);
const STEP = +arg('step', 100);
const frames = arg('frames', '') === 'all';
mkdirSync(shots, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DBG = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', '--mute-audio', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
  `--window-size=${W},${H}`, '--force-device-scale-factor=1', `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'wgmoves-'))}`, '--no-first-run',
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
const send = (method, params = {}) => new Promise((r, rej) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (wait.has(i)) { wait.delete(i); rej(new Error(`${method} timed out -- did Chrome go away?`)); } }, 30000); });
ws.onclose = () => { for (const r of wait.values()) r({ error: 'closed' }); wait.clear(); };
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails)));
  return r.result?.result?.value;
};
const grab = async (clip) => (await send('Page.captureScreenshot', { format: 'jpeg', quality: 80, ...(clip ? { clip: { ...clip, scale: 1 }, captureBeyondViewport: true } : {}) })).result.data;

// Each scene and how long to watch it (ms past the engine's own length).
const PLAN = [
  { step: 'walkDown', extra: 900, cols: 6 },
  { step: 'struck', extra: 1500, cols: 6 },
  { step: 'slam', extra: 1400, cols: 6 },
  { step: 'knockdown', extra: 1600, cols: 6 },
  { step: 'dash', extra: 1200, cols: 6 },
  // The ORDER tranche (user: "the animations sometimes play before something
  // happens"): the pips must still be full while the bolt flies, the number
  // and the drop come together at the impact, a fall comes after, a kill is
  // a death and a respawn a materialisation, and an earth wall blocks.
  { step: 'bolt', extra: 1400, cols: 6 },
  { step: 'kill', extra: 3600, cols: 6 },
  { step: 'respawn', extra: 2600, cols: 6 },
  { step: 'wall', extra: 1400, cols: 6 },
  { step: 'blink', extra: 900, cols: 6 },
];
const only = arg('only', '') ? arg('only', '').split(',') : null;
const files = [];

try {
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://localhost:${port}/tools/lab/moves.html?seed=${seed}` });
  for (let k = 0; k < 200; k++) { if (await ev('!!(window.LAB && LAB.ready)')) break; await sleep(250); }
  if (!(await ev('!!(window.LAB && LAB.ready)'))) throw new Error('the lab did not boot');
  await sleep(1500);
  for (const { step, extra, cols } of PLAN) {
    if (only && !only.includes(step)) continue;
    await ev('LAB.unsheet(); LAB.step("reset")'); await sleep(900);
    // Place the bodies and let the view walk them into position, then frame the shot on them.
    const clip = await ev(`JSON.stringify(LAB.prep(${JSON.stringify(step)}))`).then((s) => (s ? JSON.parse(s) : null));
    for (let k = 0; k < 40; k++) { if (await ev('LAB.settled()')) break; await sleep(250); }
    if (!(await ev('LAB.settled()'))) errors.push(`${step}: the bodies never settled into place`);
    await sleep(600);
    { const f = join(shots, `${step}_full.jpg`); writeFileSync(f, Buffer.from(await grab(), 'base64')); }
    const t0 = Date.now();
    const run = await ev(`JSON.stringify(LAB.step(${JSON.stringify(step)}))`).then((s) => (s ? JSON.parse(s) : null));
    if (!run) { errors.push(`${step}: the scene did not run`); continue; }
    console.log(`  ${step}: ${run.label} -- ${run.ms} ms; ${run.notes.join(' ')}`);
    for (const l of run.lines) console.log('    ' + l);
    const total = run.ms + extra;
    const urls = [], labels = [];
    for (let ms = 0; ms <= total; ms += STEP) {
      const d = t0 + ms - Date.now();
      if (d > 0) await sleep(d);
      const data = await grab(clip);
      const at = Date.now() - t0;
      urls.push('data:image/jpeg;base64,' + data); labels.push(`${at}ms`);
      if (frames) { const f = join(shots, `${step}_${String(at).padStart(4, '0')}.jpg`); writeFileSync(f, Buffer.from(data, 'base64')); }
    }
    // The contact sheet, drawn by the page: one row of `cols`, frames in order.
    const tile = clip ? [300, Math.round(300 * clip.height / clip.width)] : [300, Math.round(300 * H / W)];
    const [sw, sh] = await ev(`LAB.sheet(${JSON.stringify(urls)}, ${cols}, ${tile[0]}, ${tile[1]}, ${JSON.stringify(labels)})`);
    await sleep(200);
    const rows = Math.ceil(urls.length / cols);
    for (let r0 = 0; r0 < rows; r0 += 3) {
      const h = Math.min(3, rows - r0) * tile[1];
      const data = await grab({ x: 0, y: r0 * tile[1], width: sw, height: h });
      const f = join(shots, `${step}_sheet${rows > 3 ? '_' + (r0 / 3 + 1) : ''}.jpg`);
      writeFileSync(f, Buffer.from(data, 'base64'));
      files.push(f);
      console.log('  sheet', f);
    }
    await ev('LAB.unsheet()');
  }
} catch (e) {
  errors.push('harness: ' + e.message);
}
chrome.kill();
console.log('\nSheets:');
for (const f of files) console.log(f);
if (errors.length) { console.log('\nERRORS:'); for (const e of errors) console.log('  ' + e); }
process.exit(errors.length ? 1 : 0);
