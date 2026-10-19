#!/usr/bin/env node
// Photograph the red tranche's cues in the red lab with headless Chrome: the
// meteor streaking down and its boulder landing, the shrapnel burst, the
// thunderclap ring, the charge's fire trail, a burning unit, the skyfall and
// the flame line. Prints the PNG paths.
//
//   python3 tools/serve.py 8321 &
//   node tools/lab/shoot-red.mjs [--port 8321] [--shots DIR] [--only meteor,charge] [--cam close|side|game] [--seed 11]
//
// Exit code 1 if the page threw.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const port = +arg('port', 8321);
const shots = arg('shots', join(tmpdir(), 'wg-red'));
const W = +arg('w', 1440), H = +arg('h', 900);
const cam = arg('cam', 'close');
const seed = +arg('seed', 11);
mkdirSync(shots, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DBG = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', '--mute-audio', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
  `--window-size=${W},${H}`, '--force-device-scale-factor=1', `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'wgred-'))}`, '--no-first-run',
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
async function shot(name) {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  const f = join(shots, `${name}.png`);
  writeFileSync(f, Buffer.from(s.result.data, 'base64'));
  console.log('  shot', f);
  return f;
}

// Each cue and the moments after its trigger worth a picture, in ms.
const PLAN = [
  { step: 'meteor', at: [350, 950, 1500] },
  { step: 'shrapnel', at: [120, 400] },
  { step: 'thunderclap', at: [800, 1050, 1500] },
  { step: 'charge', at: [600, 850, 1300] },
  { step: 'burn', at: [250, 1400] },
  { step: 'burnOut', at: [300] },
  { step: 'skyfall', at: [450, 900, 1500, 2200] },
  { step: 'flameLine', at: [250, 700, 2000] },
];
const only = arg('only', '') ? arg('only', '').split(',') : null;
const files = [];

try {
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://localhost:${port}/tools/lab/red.html?seed=${seed}&cam=${cam}` });
  for (let k = 0; k < 200; k++) { if (await ev('!!(window.LAB && LAB.ready)')) break; await sleep(250); }
  if (!(await ev('!!(window.LAB && LAB.ready)'))) throw new Error('the lab did not boot');
  await sleep(1500);
  for (const { step, at } of PLAN) {
    if (only && !only.includes(step)) continue;
    await ev(`LAB.step(${JSON.stringify(step)})`);
    let t = 0;
    for (const ms of at) { await sleep(ms - t); t = ms; files.push(await shot(`${step}_${ms}${cam === 'close' ? '' : '_' + cam}`)); }
    await sleep(900);
  }
} catch (e) {
  errors.push('harness: ' + e.message);
}
chrome.kill();
console.log('\nPNGs:');
for (const f of files) console.log(f);
if (errors.length) { console.log('\nERRORS:'); for (const e of errors) console.log('  ' + e); }
process.exit(errors.length ? 1 : 0);
