#!/usr/bin/env node
// Photograph the mage in every state, close up, in headless Chrome over the
// DevTools protocol. Needs the dev server:
//
//   python3 tools/serve.py 8321 &
//   node tools/lab/shoot-mage.mjs [--port 8321] [--shots DIR] [--only walk,run]
//
// Prints the directory the PNGs went to. Exit 1 on any page exception.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const port = +arg('port', 8321);
const shots = arg('shots', join(tmpdir(), 'wg-mage-shots'));
const only = arg('only', '') ? arg('only', '').split(',') : null;
const W = +arg('w', 960), H = +arg('h', 720);
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
  if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') errors.push(`log ${d.params.entry.text} ${d.params.entry.url || ''}`);
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
  const f = join(shots, `${String(++shotN).padStart(2, '0')}_${name}.png`);
  writeFileSync(f, Buffer.from(s.result.data, 'base64'));
  console.log('  shot', f);
  return f;
}

// [name, state to trigger, camera view, ms to wait before the shot]. Several
// shots of one state catch it at different moments.
const PLAN = [
  ['idle-close', 'idle', 'close', 700],
  ['idle-face', 'idle', 'face', 400],
  ['idle-face-red', 'idle', 'face1', 400],
  ['idle-staff', 'idle', 'staff', 400],
  ['idle-back', 'idle', 'back', 400],
  ['idle-far', 'idle', 'far', 400],
  ['fidget', 'fidget', 'close', 900],
  ['walk-a', 'walk', 'close', 500],
  ['walk-b', 'walk', 'close', 350],
  ['walk-side', 'walk', 'side', 300],
  ['run-a', 'run', 'close', 500],
  ['run-b', 'run', 'close', 250],
  ['shoot-a', 'shoot', 'close', 250],
  ['shoot-b', 'shoot', 'close', 300],
  ['raise-a', 'raise', 'close', 500],
  ['raise-b', 'raise', 'close', 500],
  ['long-a', 'long', 'close', 700],
  ['long-b', 'long', 'close', 700],
  ['hit-a', 'hit', 'close', 180],
  ['hit-b', 'hit', 'close', 180],
  ['strike-a', 'strike', 'close', 300],
  ['strike-b', 'strike', 'close', 300],
  ['jump-start', 'jump', 'jump', 200],
  ['jump-air', 'jump', 'jump', 500],
  ['jump-land', 'jump', 'jump', 1000],
  ['jump-done', 'idle', 'close', 900],
  ['cheer', 'cheer', 'close', 700],
  ['cheer-b', 'cheer', 'close', 600],
  ['die-a', 'die', 'low', 450],
  ['die-rest', 'idle', 'low', 1200],
  ['revive-0', 'revive', 'low', 60],
  ['revive-a', 'revive', 'low', 600],
  ['revive-b', 'revive', 'low', 1100],
  ['revive-done', 'idle', 'close', 1500],
  ['hit-twice', 'hit2', 'close', 150],
  ['hit-twice-done', 'idle', 'close', 900],
];

try {
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://localhost:${port}/tools/lab/mage.html` });
  for (let k = 0; k < 150; k++) { if (await ev('!!(window.LAB && LAB.ready)')) break; await sleep(200); }
  if (!await ev('!!(window.LAB && LAB.ready)')) throw new Error('lab did not boot');
  await ev(`document.getElementById('bar').style.display='none'`);
  await sleep(600);
  console.log('  measure', JSON.stringify(await ev('LAB.measure()')));
  let lastState = null;
  for (const [name, state, v, delay] of PLAN) {
    if (only && !only.some((o) => name.startsWith(o))) continue;
    await ev(`LAB.view(${JSON.stringify(v)})`);
    // Re-trigger one-shots for each shot so every frame is caught fresh; keep
    // loops (idle/walk/run/cheer) running between shots of the same state.
    const loops = ['idle', 'walk', 'run', 'hit2'];
    if (state !== lastState || !loops.includes(state)) {
      if (state === 'revive' && lastState === 'revive') { /* same stand-up, later */ }
      else if (state === 'idle' && (lastState === 'die' || lastState === 'revive')) { /* keep lying / finish standing */ }
      else await ev(`LAB.trigger(${JSON.stringify(state)})`);
    }
    lastState = state;
    await sleep(delay);
    const m = await ev('LAB.measure()');
    await shot(name);
    console.log(`    ${name}: top ${m.top} orb ${m.orb} capeZ ${m.capeZ} facing ${m.facing}`);
  }
} catch (e) {
  errors.push('harness: ' + e.message);
}
if (errors.length) console.log('ERRORS\n  ' + errors.slice(0, 10).join('\n  '));
console.log('shots in', shots);
chrome.kill();
process.exit(errors.length ? 1 : 0);
