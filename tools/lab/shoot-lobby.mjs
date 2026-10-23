#!/usr/bin/env node
// Photograph the LOBBY and the SHOP through headless Chrome over the DevTools
// protocol: the front screen at desktop and phone widths, a pack reveal
// mid-flip and after it, and the end-of-match modal with its coin lines.
// Prints every PNG path.
//
//   python3 tools/serve.py 8326 &
//   node tools/lab/shoot-lobby.mjs [--port 8326] [--out DIR] [--profile DIR] [--seed 7] [--no-end]
//
// `--no-end` skips the end-of-match modal, which plays a whole fast duel
// through the page (a minute or so). Exit code 1 if the page threw.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const port = +arg('port', 8326);
const out = arg('out', join(tmpdir(), 'wg-lobby'));
const seed = +arg('seed', 7);
const W = 1440, H = 900;
mkdirSync(out, { recursive: true });
// Each run gets its own Chrome profile: another session on this machine runs
// its own headless Chrome, and two instances on one profile fight over it.
const profileRoot = arg('profile', join(tmpdir(), 'wg-lobby-chrome'));
mkdirSync(profileRoot, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DBG = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', '--mute-audio', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
  `--window-size=${W},${H}`, '--force-device-scale-factor=1', `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${mkdtempSync(join(profileRoot, 'p-'))}`, '--no-first-run',
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
  const f = join(out, `${name}.png`);
  writeFileSync(f, Buffer.from(s.result.data, 'base64'));
  console.log('  shot', f);
  return f;
}
const booted = async () => {
  for (let k = 0; k < 100; k++) { if (await ev('!!(window.WG && WG.state)')) break; await sleep(200); }
  for (let k = 0; k < 200; k++) { if (await ev('!!(WG.arena && WG.arena.ready)')) break; await sleep(250); }
};
/** A purse and a few known sigils, so the shop has something to sell and the book something to show. */
const FUND = `(()=>{ const K='wizards-gambit:profile:v1'; const p=JSON.parse(localStorage.getItem(K)||'{}');
  p.coins=640; p.matches=p.matches||7; p.wins=p.wins||4; p.learned=Object.assign({ FIREBRAND:'sigil', TIDE_PULL:'pack' }, p.learned||{});
  localStorage.setItem(K, JSON.stringify(p)); return p.coins })()`;

let ok = true;
try {
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://localhost:${port}/` });
  await booted();
  await ev(FUND);
  await ev('WG.lobby.open()');
  await sleep(1200);
  console.log('  lobby', await ev('JSON.stringify({ visible: WG.lobby.visible, hud: getComputedStyle(document.querySelector("#hud")).display, packs: document.querySelectorAll(".pack").length })'));
  await shot('lobby-1440x900');

  // The phone: 390 wide, the cards in one column, nothing poking out sideways.
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await ev('dispatchEvent(new Event("resize"))');
  await sleep(700);
  console.log('  phone overflow', await ev('JSON.stringify([document.documentElement.scrollWidth, innerWidth, document.querySelector("#lobby").scrollWidth])'));
  await shot('lobby-390x844');
  await ev('document.querySelector("#lb-shopcard").scrollIntoView({ block: "start" })');
  await sleep(300);
  await shot('lobby-390x844-shop');
  await send('Emulation.clearDeviceMetricsOverride');
  await ev('dispatchEvent(new Event("resize"))');
  await sleep(500);

  // The reveal: a rare pack torn open, caught mid-flip and once it has settled.
  await ev('document.querySelector("#lb-shopcard").scrollIntoView({ block: "center" })');
  const t0 = Date.now();
  const bought = await ev(`WG.shop.buy('rare')`);
  console.log('  bought', bought);
  await sleep(Math.max(0, 520 - (Date.now() - t0)));
  await shot('shop-reveal-mid');
  await sleep(1400);
  await shot('shop-reveal-after');
  await ev('document.querySelector("#lb-shopcard .reveal")?.remove()');
  await sleep(200);
  await shot('shop-after-buy');

  if (!process.argv.includes('--no-end')) {
    // The end of a duel: play one through the page, fast, with the AI in both seats.
    await send('Page.navigate', { url: `http://localhost:${port}/?seed=${seed}&fast` });
    await booted();
    const res = await ev(`(async()=>{ const AI = await import('./js/ai/ai.js'); const t0 = performance.now(); let steps = 0;
      while (WG.state.winner === null && steps < 6000 && performance.now() - t0 < 150000) {
        while (WG.busy) await new Promise(r => setTimeout(r, 5));
        const S = WG.state; if (S.winner !== null) break;
        if (S.pending) { if ((S.pending.request.player ?? S.active) === 0) WG.answer(AI.answerFor(S, { policy: 'greedy' })); else await new Promise(r => setTimeout(r, 5)); }
        else if (S.active === 0) WG.act(AI.chooseAction(S, { policy: 'greedy' })); else await new Promise(r => setTimeout(r, 5));
        steps++; await new Promise(r => setTimeout(r, 0));
      } return { winner: WG.state.winner, turn: WG.state.turn, steps }; })()`);
    console.log('  duel', JSON.stringify(res));
    for (let k = 0; k < 40; k++) { if (await ev('!document.querySelector("#modal").hidden')) break; await sleep(100); }
    await sleep(500);
    await shot('end-modal');
  }
} catch (e) { ok = false; console.error(e.message); }
if (errors.length) { ok = false; for (const e of errors) console.error(e); }
chrome.kill();
process.exit(ok ? 0 : 1);
