#!/usr/bin/env node
// Photograph the TRAP system on the real page through headless Chrome: a
// face-down enemy trap on the enemy table (and its inspector), your own set
// trap dimmed and badged, then an Earth Wall springing -- the reveal on the
// table and the wall of earth heaved up on the field.
//
//   python3 tools/serve.py 8321 &
//   node tools/lab/shoot-traps.mjs [--port 8321] [--shots DIR] [--seed 7]
//
// Exit code 1 if the page threw.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const port = +arg('port', 8321);
const shots = arg('shots', join(tmpdir(), 'wg-traps'));
const seed = +arg('seed', 7);
const W = +arg('w', 1440), H = +arg('h', 900);
mkdirSync(shots, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DBG = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', '--mute-audio', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
  `--window-size=${W},${H}`, '--force-device-scale-factor=1', `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'wgtrap-'))}`, '--no-first-run',
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
const rect = (sel) => ev(`(()=>{const b=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return {x:b.x,y:b.y,width:b.width,height:b.height}})()`);
async function shot(name, clip) {
  const s = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  const f = join(shots, `${name}.png`);
  writeFileSync(f, Buffer.from(s.result.data, 'base64'));
  console.log('  shot', f);
  return f;
}
let ok = true;
try {
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  // Not `&fast`: the reveal overlay is timed, and fast mode removes it at once.
  await send('Page.navigate', { url: `http://localhost:${port}/?seed=${seed}` });
  for (let k = 0; k < 100; k++) { if (await ev('!!(window.WG && WG.state)')) break; await sleep(200); }
  for (let k = 0; k < 200; k++) { if (await ev('!!(WG.arena && WG.arena.ready)')) break; await sleep(250); }
  await sleep(1200);
  // Set the traps straight into the live state (the page's modules are
  // singletons, so the engine's own ops place them) and re-render.
  await ev(`(async () => {
    const ops = await import('/js/rules/ops.js');
    const S = WG.state;
    const set = (p, cell, id) => { if (S.players[p].table[cell].length) return false; const c = ops.makeCard(S, id, p); c.playedTo = cell; c.plays = 1; c.concealed = true; ops.place(S, p, c, cell); return true; };
    set(1, 0, 'SNARE'); set(1, 8, 'BACKLASH'); set(0, 2, 'EARTH_WALL');
    S.tableDirty = [false, false]; S.fresh = [[], []];
    WG.render();
    return true;
  })()`);
  await sleep(400);
  await shot('traps-page');
  await shot('enemy-table-facedown', await rect('#theirs'));
  await shot('my-table-concealed', await rect('#mine'));
  // Hover the enemy's face-down trap: the inspector must not name it.
  const c = await rect('#table1 .cell[data-cell="0"]');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x + c.width / 2, y: c.y + c.height / 2 });
  await sleep(500);
  await shot('enemy-trap-inspector');
  const insp = await ev(`document.querySelector('#inspector').textContent`);
  console.log('  inspector says:', insp.replace(/\\s+/g, ' ').slice(0, 90));
  if (/Snare/.test(insp)) { ok = false; console.log('FAIL the inspector named the enemy trap'); }
  // Spring the Earth Wall: the enemy's spell damage into our mage, through hurt().
  await ev(`(async () => {
    const ops = await import('/js/rules/ops.js'); const q = await import('/js/field/query.js'); const mv = await import('/js/field/move.js'); const cb = await import('/js/rules/combat.js');
    const S = WG.state;
    const m0 = q.mageOf(S, 0), m1 = q.mageOf(S, 1);
    // Both on the far spawn circle: flat, prop-free ground on every seed,
    // with open arena on the camera's side.
    mv.placeBody(S, m0, 15300, 6000);
    mv.placeBody(S, m1, 13500, 6300);
    S.active = 1;
    cb.hurt(S, m0, 2, { cause: 'spell', byP: 1 });
    S.active = 0;
    const wall = S.field.props.find((pr) => pr.kind === 'earthwall');
    WG.revealTrap({ p: 0, cell: 2, def: 'EARTH_WALL', name: 'Earth Wall' });
    WG.render();
    // Look at the wall from behind our mage.
    const cam = WG.arena.camera, ctl = WG.arena.controls;
    // From the ENEMY'S side of the wall, looking back at our mage behind it:
    // the wall stands between the camera and the body it shielded.
    // High enough to clear the forest's canopy on a wooded seed.
    // Side on: the enemy mage on one side, ours on the other, the wall between.
    if (wall) { ctl.target.set(wall.x / 1000, 0.5, wall.y / 1000); cam.position.set(wall.x / 1000 + 0.3, 2.4, wall.y / 1000 + 4.6); ctl.update(); }
    return wall ? [wall.id, wall.hp, wall.x, wall.y, m0.hp] : null;
  })()`).then((r) => console.log('  earth wall:', r));
  await sleep(350);
  await shot('earth-wall-reveal', await rect('#mine'));
  // Then the field alone: panels hidden, pointer parked, the wall risen.
  await ev(`document.querySelector('#btn-hide').click(); document.querySelector('#inspector').classList.remove('show'); true`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  await sleep(1100);
  await shot('earth-wall-field');
} catch (e) { ok = false; console.error(e.message); }
if (errors.length) { ok = false; for (const e of errors) console.error(e); }
chrome.kill();
process.exit(ok ? 0 : 1);
