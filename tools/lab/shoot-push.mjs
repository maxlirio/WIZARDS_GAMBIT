#!/usr/bin/env node
// Photograph the push cues in the push lab with headless Chrome: the slide
// with its plume mid-flight, the slam, the stone mid-topple and down, the
// knockdown, and the drag arrow. Prints the PNG paths.
//
//   python3 tools/serve.py 8321 &
//   node tools/lab/shoot-push.mjs [--port 8321] [--shots DIR] [--only push,drag] [--cam close|side|game] [--seed 11]
//
// Exit code 1 if the page threw, or the drag stroke did not answer a bearing.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const port = +arg('port', 8321);
const shots = arg('shots', join(tmpdir(), 'wg-push'));
const W = +arg('w', 1440), H = +arg('h', 900);
const cam = arg('cam', 'close');
const seed = +arg('seed', 11);
mkdirSync(shots, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DBG = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', '--mute-audio', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
  `--window-size=${W},${H}`, '--force-device-scale-factor=1', `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'wgpush-'))}`, '--no-first-run',
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
  { step: 'push', at: [140, 320, 900] },
  { step: 'impact', at: [90, 400] },
  { step: 'topple', at: [380, 760, 1100] },
  { step: 'knockdown', at: [250, 700] },
  { step: 'reset', at: [600] },
  { step: 'pushProp', at: [160, 420] },
  { step: 'drag', at: [300] },
  { step: 'dragUp', at: [200] },
];
const only = arg('only', '') ? arg('only', '').split(',') : null;
const files = [];

try {
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://localhost:${port}/tools/lab/push.html?seed=${seed}&cam=${cam}` });
  for (let k = 0; k < 200; k++) { if (await ev('!!(window.LAB && LAB.ready)')) break; await sleep(250); }
  if (!(await ev('!!(window.LAB && LAB.ready)'))) throw new Error('the lab did not boot');
  await sleep(1500);
  for (const { step, at } of PLAN) {
    if (only && !only.includes(step)) continue;
    await ev(`LAB.step(${JSON.stringify(step)})`);
    let t = 0;
    for (const ms of at) { await sleep(ms - t); t = ms; files.push(await shot(`${step}_${ms}${cam === 'close' ? '' : '_' + cam}`)); }
    if (step === 'dragUp') {
      const d = await ev('LAB.picked');
      console.log(`  drag answered bearing ${d}`);
      if (typeof d !== 'number') errors.push('the drag stroke did not answer a bearing');
    }
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
