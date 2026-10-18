#!/usr/bin/env node
// Photograph every terrain piece on its own, close up, in every state, through
// headless Chrome over the DevTools protocol. Prints the PNG paths.
//
//   python3 tools/serve.py 8321 &
//   node tools/lab/shoot-props.mjs [--port 8321] [--shots DIR] [--states normal,burning,damaged] [--kinds boulder,tree] [--dist 2.6] [--quality high|low] [--eval 'JS']
//
// Exit code 1 if the page threw.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const port = +arg('port', 8321);
const shots = arg('shots', join(tmpdir(), 'wg-props'));
const states = arg('states', 'normal,burning,damaged').split(',');
const kinds = arg('kinds', 'boulder,pillar,shard,wall,floater,tree').split(',');
const dist = +arg('dist', 2.8);
const W = +arg('w', 900), H = +arg('h', 700);
mkdirSync(shots, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DBG = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', '--mute-audio', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
  `--window-size=${W},${H}`, '--force-device-scale-factor=1', `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'wgprops-'))}`, '--no-first-run',
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
let ok = true;
try {
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://localhost:${port}/tools/lab/props.html?quality=${arg('quality', 'high')}` });
  for (let k = 0; k < 150; k++) { if (await ev('!!(window.LAB && LAB.ready)')) break; await sleep(200); }
  if (!(await ev('!!(window.LAB && LAB.ready)'))) throw new Error('lab did not become ready');
  await sleep(800);
  if (arg('eval')) console.log(JSON.stringify(await ev(arg('eval')), null, 1));
  for (const state of states) {
    await ev(`LAB.setState(${JSON.stringify(state)})`);
    // Let the burn/char ramps and shimmer settle to a representative frame.
    await ev(`(()=>{ LAB.paused = true; for (let i = 0; i < 90; i++) LAB.step(1/30, 20000 + i * 33); })()`);
    await ev('LAB.wide()'); await ev('LAB.step(0, 23000)'); await sleep(100);
    await shot(`${state}_wide`);
    for (const kind of kinds) {
      await ev(`LAB.frame(${JSON.stringify(kind)}, ${dist}, 0.6)`); await ev('LAB.step(0, 23000)'); await sleep(80);
      await shot(`${state}_${kind}`);
    }
    await ev('LAB.paused = false');
  }
} catch (e) {
  ok = false;
  console.log('FAIL', e.message);
}
if (errors.length) { ok = false; console.log('PAGE ERRORS\n  ' + errors.slice(0, 10).join('\n  ')); }
chrome.kill();
process.exit(ok ? 0 : 1);
