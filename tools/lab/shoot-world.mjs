#!/usr/bin/env node
// Photograph tools/lab/world.html in headless Chrome from several views and
// seeds, and print the PNG paths plus the triangle / draw-call counts.
//
//   python3 tools/serve.py 8321 &
//   node tools/lab/shoot-world.mjs [--port 8321] [--shots DIR] [--seeds 7,3] [--views home,wide,...] [--q high] [--w 1440 --h 900]

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const port = +arg('port', 8321);
const shots = arg('shots', join(tmpdir(), 'wg-world'));
const seeds = arg('seeds', '7,3').split(',').map(Number);
const views = arg('views', 'home,wide,low,corner,stone,ward,tree,sky').split(',');
const quality = arg('q', 'high');
const W = +arg('w', 1440), H = +arg('h', 900);
mkdirSync(shots, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DBG = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', '--mute-audio', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
  `--window-size=${W},${H}`, '--force-device-scale-factor=1', `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'wgworld-'))}`, '--no-first-run',
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
async function shot(name) {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  const f = join(shots, `${name}.png`);
  writeFileSync(f, Buffer.from(s.result.data, 'base64'));
  console.log('  shot', f);
  return f;
}

let ok = true;
try {
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  for (const seed of seeds) {
    await send('Page.navigate', { url: `http://localhost:${port}/tools/lab/world.html?seed=${seed}&q=${quality}` });
    let booted = false;
    for (let k = 0; k < 200; k++) { if (await ev('!!(window.LAB && LAB.ready)')) { booted = true; break; } await sleep(200); }
    if (!booted) { console.log('FAIL  lab did not boot for seed', seed); ok = false; continue; }
    console.log(`  seed ${seed} q ${quality} geometry`, await ev('JSON.stringify(LAB.world.stats())'));
    for (const v of views) {
      await ev(`LAB.view(${JSON.stringify(v)})`);
      const f0 = await ev('LAB.frames');
      for (let k = 0; k < 40; k++) { if (await ev('LAB.frames') >= f0 + 3) break; await sleep(50); }
      await sleep(150);
      await shot(`s${seed}_${v}`);
      const info = await ev('JSON.stringify(LAB.info())');
      console.log(`    seed ${seed} view ${v} ${info}`);
    }
  }
} catch (e) {
  console.log('FAIL  harness', e.message);
  ok = false;
}
if (errors.length) { console.log('page errors:\n   ' + errors.slice(0, 8).join('\n   ')); ok = false; }
chrome.kill();
process.exit(ok ? 0 : 1);
