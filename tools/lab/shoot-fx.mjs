#!/usr/bin/env node
// Photograph every effect in the FX lab with headless Chrome, from the game
// camera and close up, at the moment each looks its best. Prints the PNG paths.
//
//   python3 tools/serve.py 8321 &
//   node tools/lab/shoot-fx.mjs [--port 8321] [--shots DIR] [--only explosion,burn] [--q low|medium|high] [--w 1440] [--h 900]
//
// Exit code 1 if the page threw.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const port = +arg('port', 8321);
const shots = arg('shots', join(tmpdir(), 'wg-fx'));
const W = +arg('w', 1440), H = +arg('h', 900);
mkdirSync(shots, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DBG = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', '--mute-audio', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
  `--window-size=${W},${H}`, '--force-device-scale-factor=1', `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'wgfx-'))}`, '--no-first-run',
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

// When to press the shutter after the trigger, in ms, per effect and camera.
const WHEN = {
  burn: { game: 2500, close: 2500 },
  explosion: { game: 230, close: 200 },
  lightning: { game: 70, close: 70 },
  sigil: { game: 650, close: 650 },
  bolt: { game: 300, close: 280 },
  dust: { game: 380, close: 380 },
  debris: { game: 320, close: 420 },
  motes: { game: 700, close: 700 },
  ring: { game: 220, close: 220 },
  quake: { game: 450, close: 450 },
  beam: { game: 500, close: 500 },
  burst: { game: 260, close: 260 },
};
const only = arg('only', '');
const qual = arg('q', 'high');
const names = only ? only.split(',') : Object.keys(WHEN);
const files = [];

try {
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  for (const name of names) {
    await send('Page.navigate', { url: `http://localhost:${port}/tools/lab/fx.html?fx=${name}&cam=game&period=0&q=${qual}` });
    for (let k = 0; k < 100; k++) { if (await ev('!!(window.LAB && LAB.ready)')) break; await sleep(200); }
    if (!(await ev('!!(window.LAB && LAB.ready)'))) { errors.push(`lab did not boot for ${name}`); continue; }
    await sleep(600);
    for (const cam of ['game', 'close']) {
      await ev(`LAB.setCam(${JSON.stringify(cam)}, ${JSON.stringify(name)})`);
      if (name !== 'burn' || cam === 'game') {
        // Let the previous instance die, then fire fresh for this camera.
        if (name !== 'burn') await sleep(1200);
        await ev(`LAB.fire(${JSON.stringify(name)})`);
      }
      await sleep(WHEN[name][cam]);
      files.push(await shot(`${name}_${cam}${qual === 'high' ? '' : '_' + qual}`));
      // A second look later in the life for the ones that evolve.
      if (name === 'explosion' || name === 'bolt' || name === 'lightning' || name === 'debris') {
        await sleep(name === 'lightning' ? 160 : 500);
        files.push(await shot(`${name}_${cam}_late`));
      }
    }
    const fps = await ev(`document.querySelector('#info').textContent`);
    console.log(`  ${name}: ${fps}`);
  }
} catch (e) {
  errors.push('harness: ' + e.message);
}
chrome.kill();
console.log('\nPNGs:');
for (const f of files) console.log(f);
if (errors.length) { console.log('\nERRORS:'); for (const e of errors) console.log('  ' + e); }
process.exit(errors.length ? 1 : 0);
