#!/usr/bin/env node
// Photograph the rigid-body push in the push lab with headless Chrome: a
// boulder mid-roll (three shots 300 ms apart), the moment a boulder comes
// down on a mage (the crumple), a mage thrown into a ruined wall (the slam),
// and the drag arrow. Every scene is a REAL push through js/field/push.js;
// the shots are timed from the engine's own event stamps. Prints the PNG paths.
//
//   python3 tools/serve.py 8321 &
//   node tools/lab/shoot-push.mjs [--port 8321] [--shots DIR] [--only roll,slam] [--seed 11] [--hold 500]
//
// Exit code 1 if the page threw, a scene did not produce its event (no
// crumple, no hit), or the drag stroke did not answer a bearing.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const port = +arg('port', 8321);
const shots = arg('shots', join(tmpdir(), 'wg-push'));
const W = +arg('w', 1440), H = +arg('h', 900);
const seed = +arg('seed', 11);
const hold = +arg('hold', 0);          // ms the note is held before it plays; a shot is taken mid-hold
mkdirSync(shots, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DBG = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', '--mute-audio', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
  `--window-size=${W},${H}`, '--force-device-scale-factor=1', `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'wgdyn-'))}`, '--no-first-run',
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
async function shot(name) {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  const f = join(shots, `${name}.png`);
  writeFileSync(f, Buffer.from(s.result.data, 'base64'));
  console.log('  shot', f);
  return f;
}
/** Take shots at the given ms after `t0`, each named by its moment. */
async function shotsAt(step, t0, times) {
  const out = [];
  for (const ms of times) {
    const d = t0 + ms - Date.now();
    if (d > 0) await sleep(d);
    out.push(await shot(`${step}_${ms}`));
  }
  return out;
}

// Each scene, and when to look relative to the event the engine stamped.
const PLAN = [
  { step: 'roll', at: () => [150, 450, 750, 1400] },
  { step: 'crumple', event: 'crumple', at: (t) => [t - 120, t + 60, t + 450] },
  { step: 'slam', event: 'hit', at: (t) => [t - 120, t + 60, t + 520] },
  { step: 'drag', at: () => [300] },
  { step: 'dragUp', at: () => [200] },
];
const only = arg('only', '') ? arg('only', '').split(',') : null;
const files = [];

try {
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://localhost:${port}/tools/lab/push.html?seed=${seed}${hold ? '&hold=' + hold : ''}` });
  for (let k = 0; k < 200; k++) { if (await ev('!!(window.LAB && LAB.ready)')) break; await sleep(250); }
  if (!(await ev('!!(window.LAB && LAB.ready)'))) throw new Error('the lab did not boot');
  await sleep(1500);
  for (const { step, event, at } of PLAN) {
    if (only && !only.includes(step)) continue;
    if (step !== 'dragUp') { await ev('LAB.step("reset")'); await sleep(700); }
    const t0 = Date.now();
    const run = await ev(`JSON.stringify(LAB.step(${JSON.stringify(step)}))`).then((s) => (s ? JSON.parse(s) : null));
    if (run) {
      console.log(`  ${step}: ${run.ms} ms, ${run.frames} frames, bodies ${run.bodies.join(' ')}`);
      for (const e of run.events) console.log(`    ${String(e.t).padStart(5)} ms  ${e.kind} ${e.key}${e.into ? ' > ' + e.into : ''}${e.by ? ' < ' + e.by : ''}${e.speed ? ` speed ${e.speed}` : ''}${e.dmg ? ` dmg ${e.dmg}` : ''}`);
      console.log(`    notes: ${run.notes.join(' ')}`);
    }
    let tEv = 0;
    if (event) {
      const e = run?.events.find((x) => x.kind === event);
      if (!e) { errors.push(`${step}: the engine produced no '${event}' event`); continue; }
      tEv = e.t;
    }
    const times = run ? at(tEv).map((ms) => ms + hold) : at(tEv);
    if (run && hold) times.unshift(Math.round(hold / 2));
    files.push(...await shotsAt(step, t0, times));
    if (step === 'dragUp') {
      const d = await ev('LAB.picked');
      console.log(`  drag answered bearing ${d}`);
      if (typeof d !== 'number') errors.push('the drag stroke did not answer a bearing');
    }
    if (run) await sleep(Math.max(0, hold + run.ms + 800 - (Date.now() - t0)));
    else await sleep(600);
  }
} catch (e) {
  errors.push('harness: ' + e.message);
}
chrome.kill();
console.log('\nPNGs:');
for (const f of files) console.log(f);
if (errors.length) { console.log('\nERRORS:'); for (const e of errors) console.log('  ' + e); }
process.exit(errors.length ? 1 : 0);
