#!/usr/bin/env node
// Photograph every golem in every state, close up, in headless Chrome.
//
//   python3 tools/serve.py 8321 &
//   node tools/lab/shoot-golems.mjs [--port 8321] [--shots DIR] [--only EMBER_HOUND] [--team 1]
//
// Drives tools/lab/golems.html?manual=1 over the DevTools protocol: the page's
// clock only moves when we say so, so each shot lands at an exact moment of an
// animation. Prints the PNG paths; exit 1 on any page error.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const port = +arg('port', 8321);
const shots = arg('shots', join(tmpdir(), 'wg-golems'));
const only = arg('only', '');
const team = arg('team', '0');
const W = +arg('w', 900), H = +arg('h', 900);
mkdirSync(shots, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DBG = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', '--mute-audio', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
  `--window-size=${W},${H}`, '--force-device-scale-factor=1', `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'wglab-'))}`, '--no-first-run',
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
  const f = join(shots, `${String(++shotN).padStart(2, '0')}_${name}.png`);
  writeFileSync(f, Buffer.from(s.result.data, 'base64'));
  console.log(f);
  return f;
}
const adv = (ms) => ev(`LAB.advance(${ms})`);
const focus = (i, o = {}) => ev(`LAB.focus(${i}, ${JSON.stringify(o)})`);

try {
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://localhost:${port}/tools/lab/golems.html?manual=1&team=${team}${only ? '&only=' + only : ''}` });
  for (let k = 0; k < 150; k++) { if (await ev('!!(window.LAB && LAB.ready)')) break; await sleep(200); }
  if (!(await ev('!!(window.LAB && LAB.ready)'))) throw new Error('lab never became ready');
  const ids = await ev('LAB.ids');
  const strikeDur = { CLAY_HAND: 0.8, STONE_WARDEN: 0.9, IRON_COLOSSUS: 1.3, SPARK_WISP: 0.6, GLASS_SENTINEL: 0.8, EMBER_HOUND: 0.7, BOG_CRAWLER: 0.7, GRANITE_RAM: 0.9, OBSIDIAN_TITAN: 1.3 };
  // Everyone faces the camera, settles into idle, and the line-up is photographed wide.
  await ev(`LAB.set('all', { moving: false, facing: 0 })`);
  await adv(1500);
  await ev('LAB.wide()');
  await adv(16);
  await shot('lineup');
  for (let i = 0; i < ids.length; i++) {
    const n = ids[i];
    await focus(i);
    await adv(400);
    await shot(`${n}_idle`);
    await focus(i, { yaw: 1.5 });
    await shot(`${n}_idle_side`);
    await focus(i);
    // Walk in place: two moments a quarter cycle apart, then a side view.
    await ev(`LAB.set(${i}, { moving: true })`);
    await adv(1400);
    await shot(`${n}_walk_a`);
    await adv(180);
    await shot(`${n}_walk_b`);
    await focus(i, { yaw: 1.45 });
    await adv(120);
    await shot(`${n}_walk_side`);
    await focus(i);
    await ev(`LAB.set(${i}, { moving: false })`);
    await adv(700);
    // Strike: wind-up, then the moment of impact.
    const sd = strikeDur[n] * 1000;
    await focus(i, { yaw: 1.1, dist: 3.4 + (await ev(`LAB.golems[${i}].height`)) * 1.1 });
    await ev(`LAB.trigger('strike', ${i})`);
    await adv(sd * 0.36);
    await shot(`${n}_strike_windup`);
    await adv(sd * 0.16);
    await shot(`${n}_strike_impact`);
    await adv(sd * 0.6 + 300);
    await focus(i);
    await ev(`LAB.trigger('hit', ${i})`);
    await adv(130);
    await shot(`${n}_hit`);
    await adv(600);
    await ev(`LAB.trigger('rise', ${i})`);
    await adv(350);
    await shot(`${n}_rise_a`);
    await adv(450);
    await shot(`${n}_rise_b`);
    await adv(900);
    await ev(`LAB.trigger('die', ${i})`);
    await adv(320);
    await shot(`${n}_die_a`);
    await adv(1900);
    await shot(`${n}_die_settled`);
    await ev(`LAB.trigger('revive', ${i})`);
    await adv(1800);
  }
  await ev('LAB.wide()');
  await adv(200);
  await shot('lineup_after');
} catch (e) {
  errors.push('harness: ' + e.message);
}
if (errors.length) { console.log('ERRORS:\n  ' + errors.slice(0, 12).join('\n  ')); }
chrome.kill();
process.exit(errors.length ? 1 : 0);
