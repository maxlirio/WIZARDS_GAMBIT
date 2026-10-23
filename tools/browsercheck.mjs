#!/usr/bin/env node
// Drive the REAL page in headless Chrome over the DevTools protocol: load it,
// take screenshots, click through a spell action and a unit phase the way a
// player would, then play the rest of a match through the page's own act/answer
// and report every page exception and console error.
//
//   python3 tools/serve.py 8321 &      (or any static server on that port)
//   node tools/browsercheck.mjs [--port 8321] [--shots DIR] [--seed 7] [--turns 30]
//
// Exit code 1 if the page threw, or a match driven through the UI did not finish.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const port = +arg('port', 8321);
const shots = arg('shots', join(tmpdir(), 'wg-shots'));
const seed = +arg('seed', 7);
const W = +arg('w', 1440), H = +arg('h', 900);
mkdirSync(shots, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DBG = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', '--mute-audio', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
  `--window-size=${W},${H}`, '--force-device-scale-factor=1', `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'wgqa-'))}`, '--no-first-run',
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
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
async function click(x, y) { await mouse('mouseMoved', x, y, { buttons: 0 }); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(300); }
async function clickSel(sel) {
  const r = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; e.scrollIntoView({block:'center'}); const b=e.getBoundingClientRect(); return b.width? [b.x+b.width/2,b.y+b.height/2] : null})()`);
  if (!r) return false;
  await click(r[0], r[1]);
  return true;
}
let shotN = 0;
async function shot(name, clip) {
  const s = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  const f = join(shots, `${String(++shotN).padStart(2, '0')}_${name}.png`);
  writeFileSync(f, Buffer.from(s.result.data, 'base64'));
  console.log('  shot', f);
  return f;
}
const results = [];
const cam = () => ev(`(()=>{const c=WG.arena.camera.position; const t=WG.arena.controls.target; return [c.x,c.y,c.z,t.x,t.y,t.z].map(v=>+v.toFixed(2)).join(',')})()`);
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };
const waitIdle = async (ms = 20000) => {
  for (let t = 0; t < ms; t += 100) {
    if (await ev(`!WG.busy && (WG.state.winner !== null || (!WG.state.pending && WG.state.active === 0) || (WG.state.pending && (WG.state.pending.request.player ?? WG.state.active) === 0))`)) return true;
    await sleep(100);
  }
  return false;
};

const PROFILE_KEY = 'wizards-gambit:profile:v1';
const purse = () => ev(`(JSON.parse(localStorage.getItem(${JSON.stringify(PROFILE_KEY)}) || '{}').coins | 0)`);

try {
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');

  // THE LOBBY. A bare visit is the front screen: the HUD gone, no AI
  // thinking behind it; it fits a phone; the shop sells a pack through the
  // same path as its Buy button and the Spellbook then shows the sigil.
  await send('Page.navigate', { url: `http://localhost:${port}/` });
  for (let k = 0; k < 100; k++) { if (await ev('!!(window.WG && WG.state)')) break; await sleep(200); }
  const lob = await ev(`JSON.stringify({ lobby: !!(WG.lobby && WG.lobby.visible) && !document.querySelector('#lobby').hidden, hud: getComputedStyle(document.querySelector('#hud')).display, busy: WG.busy })`);
  check('a bare visit shows the lobby and hides the HUD', JSON.parse(lob).lobby && JSON.parse(lob).hud === 'none' && !JSON.parse(lob).busy, lob);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await ev('dispatchEvent(new Event("resize"))');
  await sleep(500);
  const mob = await ev(`[document.documentElement.scrollWidth, innerWidth, document.querySelector('#lobby').scrollWidth]`);
  check('the lobby fits a 390 px phone without horizontal overflow', mob[0] <= mob[1] && mob[2] <= mob[1], `scrollWidth ${mob[0]}, lobby ${mob[2]} vs ${mob[1]}`);
  await shot('lobby-phone');
  await send('Emulation.clearDeviceMetricsOverride');
  await ev('dispatchEvent(new Event("resize"))');
  await sleep(400);
  await shot('lobby');
  // Fund the purse (a duel pays 20 or so; packs cost 50 / 100 / 200) and buy.
  await ev(`(()=>{ const K=${JSON.stringify(PROFILE_KEY)}; const p=JSON.parse(localStorage.getItem(K)||'{}'); p.coins=400; localStorage.setItem(K, JSON.stringify(p)); })()`);
  await ev('WG.lobby.open()');
  const funded = await purse();
  const unknownBefore = await ev(`(async()=>{ const { CARDS } = await import('./js/rules/spells/index.js'); const { packContents } = await import('./js/rules/shop.js');
    return packContents(Object.values(CARDS), JSON.parse(localStorage.getItem(${JSON.stringify(PROFILE_KEY)})).learned) })()`);
  const bought = await ev(`(()=>{ try { return { id: WG.shop.buy('apprentice') }; } catch (e) { return { error: e.message }; } })()`);
  const prof = await ev(`JSON.parse(localStorage.getItem(${JSON.stringify(PROFILE_KEY)}))`);
  check('buying an Apprentice pack charges 50 and writes the card into the Spellbook as a pack',
    !!bought.id && prof.coins === funded - 50 && prof.learned?.[bought.id] === 'pack' && unknownBefore.includes(bought.id), `${JSON.stringify(bought)} coins ${funded} -> ${prof.coins}`);
  // The Archmage pack never pays a common card -- while any stronger one is
  // left to find. Until tools/ratecards.js has rated the corpus every card
  // is common, so the tier claim is only made when a stronger tier exists.
  const arch = await ev(`(async()=>{ const { CARDS } = await import('./js/rules/spells/index.js'); const { tierContents, rarityOf, packContents } = await import('./js/rules/shop.js');
    const cards = Object.values(CARDS); const learned = JSON.parse(localStorage.getItem(${JSON.stringify(PROFILE_KEY)})).learned;
    const stronger = tierContents(cards, learned, 'uncommon').length + tierContents(cards, learned, 'rare').length;
    const before = packContents(cards, learned); let id, error; try { id = WG.shop.buy('archmage'); } catch (e) { error = e.message; }
    const after = packContents(cards, JSON.parse(localStorage.getItem(${JSON.stringify(PROFILE_KEY)})).learned);
    return { id, error, tier: id && rarityOf(CARDS[id]), stronger, wasUnknown: before.includes(id), nowKnown: !after.includes(id), coins: JSON.parse(localStorage.getItem(${JSON.stringify(PROFILE_KEY)})).coins } })()`);
  check('an Archmage pack (200) pays an unknown card, never a common one while stronger ones are left',
    !!arch.id && arch.wasUnknown && arch.nowKnown && arch.coins === funded - 250 && (arch.stronger === 0 || arch.tier !== 'common'), JSON.stringify(arch));
  await ev(`document.querySelector('#lb-shopcard .reveal')?.remove()`);
  await sleep(1300);
  await shot('shop-reveal');
  await ev(`document.querySelector('#lb-shopcard .reveal')?.remove(); document.querySelector('#lb-openbook').click()`);
  const inBook = await ev(`(async()=>{ const { CARDS } = await import('./js/rules/spells/index.js'); const name = CARDS[${JSON.stringify(bought.id || '')}]?.name;
    const e = [...document.querySelectorAll('#modal .bk.sg:not(.unknown)')].find(x => x.querySelector('.bc')?.firstChild?.textContent?.trim() === name);
    return { name, shown: !!e, sigil: !!e?.querySelector('.sgrid i .rune-i') } })()`);
  check('the Spellbook modal shows the bought card with its sigil drawn', inBook.shown && inBook.sigil, JSON.stringify(inBook));
  await shot('spellbook-after-pack');
  await ev('document.querySelector("#modal").hidden = true');

  await send('Page.navigate', { url: `http://localhost:${port}/?seed=${seed}&fast${arg('extra', '')}` });
  for (let k = 0; k < 100; k++) { if (await ev('!!(window.WG && WG.state)')) break; await sleep(200); }
  check('page boots and exposes WG', await ev('!!(window.WG && WG.state)'));
  const lobSeeded = await ev(`JSON.stringify({ lobby: !!(WG.lobby && WG.lobby.visible), hud: getComputedStyle(document.querySelector('#hud')).display })`);
  check('?seed= goes straight into the duel, no lobby', !JSON.parse(lobSeeded).lobby && JSON.parse(lobSeeded).hud !== 'none', lobSeeded);
  const coinsBefore = await purse();
  for (let k = 0; k < 200; k++) { if (await ev('!!(WG.arena && WG.arena.ready)')) break; await sleep(250); }
  check('the battlefield loads its models', await ev('!!(WG.arena && WG.arena.ready)'));
  await sleep(1500);
  await shot('start');
  const ow = await ev(`[document.documentElement.scrollWidth, innerWidth, [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 4).map(e => e.id || e.className).join(' | ')]`);
  check('no horizontal overflow', ow[0] <= ow[1], `scrollWidth ${ow[0]} vs ${ow[1]} ${ow[2]}`);
  console.log('  camera at start', await cam());

  // The table, close up.
  const tb = await ev(`(()=>{const b=document.querySelector('#mine').getBoundingClientRect(); return {x:b.x,y:b.y,width:b.width,height:b.height}})()`);
  await shot('table-closeup', tb);

  // The turn opens with the UNIT PHASE (units move before the spell action):
  // markers should be on the field, the mage walks, then 'Done moving'.
  // The runes column: an empty pouch, a 4 x 4 scratch board, Bind disabled
  // until something is laid.
  const cells = await ev(`document.querySelectorAll('#sigils0 .sigboard .sigcell').length`);
  check('the runes column shows a 4 x 4 scratch board', cells === 16, `${cells} cells`);
  check('Bind is disabled with an empty pouch and nothing laid', await ev(`!!document.querySelector('#bind0')?.disabled`));
  const phase = await ev('WG.state.phase');
  if (phase === 'unit' && !(await ev('!!WG.state.pending'))) {
    await sleep(600);
    await shot('unit-phase');
    const u0 = await ev(`(()=>{const u=WG.state.field.units.find(u=>u.owner===0&&u.kind==='mage'); return [u.x,u.y,u.z]})()`);
    const circ = await ev(`WG.arena.insideMove(${u0[0]} + 1000, ${u0[1]})`);
    check('unit phase shows the move circle', circ === true);
    // Click OPEN GROUND inside the circle, off to one side so the mage itself is not under the cursor.
    // The circle is a SHAPE now (what the walk can really reach), so the
    // click goes two thirds of the way out along a spoke the shape vouches for.
    const pos = await ev(`(()=>{const sh=WG.arena.moveShape(); const u=[${u0[0]},${u0[1]}];
      let best=null; for (const p of sh) { const d=Math.hypot(p.x-u[0],p.y-u[1]); if (d>=1500 && (!best||d>best.d)) best={...p,d}; }
      const t = best ? [u[0]+(best.x-u[0])*0.66, u[1]+(best.y-u[1])*0.66] : [u[0]+900, u[1]-1600];
      const p=WG.arena.project(t[0], t[1], ${u0[2]}); const b=document.querySelector('#arena').getBoundingClientRect(); return [b.x+p[0], b.y+p[1]]})()`);
    if (pos) { await mouse('mouseMoved', pos[0], pos[1], { buttons: 0 }); await sleep(250); await shot('move-preview'); }
    if (pos) {
      const before = await ev(`JSON.stringify(WG.state.field.units.filter(u=>u.owner===0).map(u=>[u.x,u.y]))`);
      await click(pos[0], pos[1]);
      await sleep(400);
      const after = await ev(`JSON.stringify(WG.state.field.units.filter(u=>u.owner===0).map(u=>[u.x,u.y]))`);
      check('clicking inside the circle moves the unit there', before !== after, after);
      console.log('  camera after marker click', await cam());
    }
    await clickSel('#tray button.end');
    await waitIdle();
  }
  // Now the spell action. Hover a hand card, then play it by clicking: hand -> glowing cell.
  const handN = await ev(`document.querySelectorAll('#hand .hcard.playable').length`);
  check('hand shows playable cards', handN > 0, `${handN} playable`);
  await clickSel('#hand .hcard.playable');
  const targets = await ev(`document.querySelectorAll('.cell.target, .gslot.target').length`);
  check('selecting a hand card lights its legal cells', targets > 0, `${targets} targets`);
  await shot('card-selected');
  await clickSel('.cell.target, .gslot.target');
  await waitIdle();
  const played = await ev(`WG.state.fx.some(f => f.kind === 'play' || f.kind === 'golemCard')`);
  check('clicking a lit cell plays the card', played);

  await sleep(300);
  await sleep(500);
  await shot('after-enemy-turn');

  // Mid-game: play a dozen turns, then look closely at a busy table and hand.
  await ev(`(async()=>{ const AI = await import('./js/ai/ai.js');
    for (let k = 0; k < 3000 && WG.state.winner === null && WG.state.turn < ${+arg('mid', 13)}; k++) {
      while (WG.busy) await new Promise(r => setTimeout(r, 5));
      const S = WG.state; if (S.winner !== null) break;
      if (S.pending) { if ((S.pending.request.player ?? S.active) === 0) WG.answer(AI.answerFor(S, { policy: 'oneply' })); else await new Promise(r => setTimeout(r, 5)); }
      else if (S.active === 0) WG.act(AI.chooseAction(S, { policy: 'oneply' })); else await new Promise(r => setTimeout(r, 5));
      await new Promise(r => setTimeout(r, 0));
    } })()`);
  await waitIdle();
  await sleep(1200);
  await shot('midgame');
  console.log('  camera at midgame', await cam());
  await shot('midgame-table', await ev(`(()=>{const b=document.querySelector('#table0').getBoundingClientRect(); return {x:b.x,y:b.y,width:b.width,height:b.height}})()`));
  await shot('midgame-arena', await ev(`(()=>{const b=document.querySelector('#arena').getBoundingClientRect(); return {x:b.x,y:b.y,width:b.width,height:b.height}})()`));
  await ev(`document.querySelector('#hand .hcard')?.dispatchEvent(new MouseEvent('mouseenter'))`);
  await sleep(300);
  await shot('inspector', await ev(`(()=>{const b=document.querySelector('#arena').getBoundingClientRect(); return {x:b.x,y:b.y,width:b.width,height:b.height}})()`));
  await ev(`document.querySelector('#hand .hcard')?.dispatchEvent(new MouseEvent('mouseleave'))`);

  // The range preview: reach a spell phase where one of my spells would rotate
  // into a face with a reach, click it, and photograph the ring.
  const target = await ev(`(async()=>{ const AI = await import('./js/ai/ai.js');
    const R = await import('./js/rules/orient.js');
    const pick = () => { const S = WG.state; if (S.pending || S.active !== 0 || S.phase !== 'spell') return null;
      const la = WG.legal(); for (const a of la) if (a.type === 'rotate') { const sp = S.players[0].table.flat().find(c => c.uid === a.uid);
        const f = S.defs[sp.def].faces[(R.activeIndex(sp) + 1) & 3]; if (f.reach) return sp.cell; } return null; };
    for (let k = 0; k < 3000 && WG.state.winner === null; k++) {
      while (WG.busy) await new Promise(r => setTimeout(r, 5));
      const c = pick(); if (c !== null) return c;
      const S = WG.state;
      // Steer toward the thing under test: with no ranged rotate in reach, play a ranged card first.
      const ranged = (!S.pending && S.active === 0 && S.phase === 'spell') ? WG.legal().find(a => a.type === 'play' && S.defs[S.players[0].hand.find(h => h.uid === a.uid)?.def]?.faces?.some(f => f.reach)) : null;
      if (ranged) WG.act(ranged);
      else if (S.pending) { if ((S.pending.request.player ?? S.active) === 0) WG.answer(AI.answerFor(S, { policy: 'oneply' })); else await new Promise(r => setTimeout(r, 5)); }
      else if (S.active === 0) WG.act(AI.chooseAction(S, { policy: 'oneply' })); else await new Promise(r => setTimeout(r, 5));
      await new Promise(r => setTimeout(r, 0));
    } return null; })()`);
  if (target !== null) {
    await clickSel(`#table0 .cell[data-cell="${target}"]`);
    await sleep(700);
    await shot('range-preview');
    const rings = await ev(`document.querySelectorAll('.rlabel').length`);
    check('selecting a spell draws the range of the face it would rotate to', rings > 0, `${rings} ring label(s)`);
  } else check('reached a rotate with a ranged face', false);

  // Step until the game asks the human something, and photograph the question.
  const asked = await ev(`(async()=>{ const AI = await import('./js/ai/ai.js');
    for (let k = 0; k < 3000 && WG.state.winner === null; k++) {
      while (WG.busy) await new Promise(r => setTimeout(r, 5));
      const S = WG.state; if (S.winner !== null) break;
      if (S.pending && (S.pending.request.player ?? S.active) === 0) return S.pending.request.prompt;
      if (!S.pending && S.active === 0) WG.act(AI.chooseAction(S, { policy: 'oneply' })); else await new Promise(r => setTimeout(r, 5));
      await new Promise(r => setTimeout(r, 0));
    } return null; })()`);
  if (asked) { await sleep(900); await shot('prompt'); console.log('  camera at prompt', await cam()); }
  check('the human is asked a question and it is drawn', !!asked && await ev(`!document.querySelector('#prompt').hidden`), asked || 'never asked');

  // Play the rest of the match through the page, using the AI's own choices for
  // the human seat, so every prompt the UI can be asked gets rendered.
  const turns = +arg('turns', 400);
  const out = await ev(`(async()=>{
    const AI = await import('./js/ai/ai.js');
    const t0 = performance.now(); let steps = 0, prompts = 0;
    while (WG.state.winner === null && WG.state.turn < ${turns} && steps < 6000 && performance.now() - t0 < 120000) {
      while (WG.busy) await new Promise(r => setTimeout(r, 5));
      const S = WG.state;
      if (S.winner !== null) break;
      if (S.pending) {
        if ((S.pending.request.player ?? S.active) !== 0) { await new Promise(r => setTimeout(r, 5)); continue; }
        prompts++;
        if (!document.querySelector('#prompt') || document.querySelector('#prompt').hidden) return { error: 'a human prompt was not shown: ' + S.pending.request.prompt };
        WG.answer(AI.answerFor(S, { policy: 'greedy' }));
      } else if (S.active === 0) {
        WG.act(AI.chooseAction(S, { policy: 'greedy' }));
      } else { await new Promise(r => setTimeout(r, 5)); continue; }
      steps++;
      await new Promise(r => setTimeout(r, 0));
    }
    return { winner: WG.state.winner, turn: WG.state.turn, vp: WG.state.vp, steps, prompts };
  })()`);
  check('a whole match plays through the page', out && !out.error && (out.winner !== null || out.turn >= turns), JSON.stringify(out));
  await sleep(800);
  // The pouch chips read what the engine holds (nothing is laid on the scratch).
  const pouch = await ev(`(()=>{const p=WG.state.players[0].runes; const c={}; for (const el of document.querySelectorAll('#sigils0 .chip')) c[el.dataset.r]=+el.querySelector('b').textContent; return JSON.stringify({ pouch: p, chips: c, same: Object.keys(p).every(r => p[r] === c[r]) })})()`);
  check('the pouch chips match the engine pouch', JSON.parse(pouch).same, pouch);
  // The duel paid: the end modal itemises the coins and the purse grew.
  for (let k = 0; k < 30; k++) { if (await ev('!document.querySelector("#modal").hidden')) break; await sleep(100); }
  const endText = await ev(`document.querySelector('#modal').hidden ? '' : document.querySelector('#modal .mbox').innerText`);
  check('the end-of-match modal itemises the coins earned', /coins/i.test(endText) && /Duel played/.test(endText), endText.split('\n').filter((l) => /coins|played/i.test(l)).join(' | ') || 'no modal');
  const coinsAfter = await purse();
  check('the purse grew by what the duel paid', coinsAfter > coinsBefore, `${coinsBefore} -> ${coinsAfter}`);
  await shot('end');
} catch (e) {
  check('harness ran', false, e.message);
}
check('no page errors', errors.length === 0, errors.slice(0, 8).join('\n   '));
chrome.kill();
process.exit(results.every((r) => r.ok) ? 0 : 1);
