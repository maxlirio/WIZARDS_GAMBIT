// The view: the whole game, playable in a browser.
//
// It drives the engine exactly as tools/duel.js does -- legalActions, apply,
// choose -- so there is still no second copy of the rules anywhere. If the
// page offers a move, the engine generated it; if a card asks a question, this
// file only draws the question and hands the answer back.
//
// Everything the player SEES happening comes from `state.fx`, the engine's note
// stream, read after each step and turned into a short TIMELINE of cues for
// the battlefield: a bolt leaves the staff, lands, and only then does the
// damage number float up. The board itself is redrawn from the state every
// time.
//
// The HUD is laid out so that every control sits next to the thing it acts
// on: a selected spell gets a popover beside its cell with rotate / shift /
// destroy; a selected unit gets one over its head with strike / summon / hold;
// the only free-standing buttons are the turn-flow ones (skip, end turn).

import { createGame, legalActions, apply, choose, cloneState, hashState } from '../engine.js';
import { Net } from './net.js';
import { chooseAction, answerFor } from '../ai/ai.js';
import { CARDS, randomDeck } from '../rules/spells/index.js';
import { defOf, topOf, stackAt, findSpell } from '../rules/ops.js';
import { CELL_COLOR } from '../rules/table.js';
import { activeIndex, NUMERALS } from '../rules/orient.js';
import { runeAtCorner, findMatches } from '../rules/match.js';
import { SITE } from '../rules/table.js';
import { gateProgress, counted } from '../rules/gates.js';
import { keywordsOf, keywordSources, KEYWORDS } from '../rules/keywords.js';
import { TIER_CAP } from '../rules/golems.js';
import { spellbookPage } from '../rules/learn.js';
import { bindError, BOARD_W, BOARD_CELLS } from '../rules/sigils.js';
import { RUNES } from '../rules/runes.js';
import { seedRng, pick } from '../rules/rng.js';
import * as profile from '../profile.js';
import { makeCtx } from '../rules/resolve.js';
import { moveBudget, canMoveTo, moveReach } from '../rules/units.js';
import { rangeOrigins } from '../field/query.js';
import { cardSVG, centreSVG, faceListHTML, SCHOOL_INK, runeGlyphInline, cardBackSVG } from './cards.js';
import { createArena, SCHOOL_HEX } from './arena3d.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const params = new URLSearchParams(location.search);
const FAST = params.has('fast');

/* ================================================================ match */

let S = null;            // the game state
let HUMAN = 0;           // which seat is yours; null = watching two AIs
let POLICY = 'oneply';
let arena = null;
let fxSeen = 0;
let sel = null;          // {kind:'hand'|'spell'|'unit', uid|id}
let busy = false;
let someChosen = [];     // a multi-select prompt's picks so far
let matchOver = false;
let gameId = 0;
let timers = [];         // scheduled cues, cleared on a new match
let NET = null;          // the connection when playing online; the other seat is a person

function newMatch({ seed = Math.floor(Math.random() * 1e6), watch = false, pool = false, policy = 'oneply', seat = 0 } = {}) {
  gameId++;
  for (const t of timers) clearTimeout(t);
  timers = [];
  const rng = seedRng(seed ^ 0xdeed);
  const decks = pool ? [randomDeck(rng, pick), randomDeck(rng, pick)] : null;
  S = createGame({ seed, decks });
  HUMAN = watch ? null : seat;
  POLICY = policy;
  seatLayout();
  fxSeen = 0; sel = null; someChosen = []; matchOver = false;
  angles.clear();
  pendingTurns.clear();
  scratch.fill(null); picked = null;
  for (const p of [0, 1]) for (const el of document.querySelectorAll(`#table${p} .cell`)) el.dataset.uid = '';
  $('#log').innerHTML = '';
  arena?.dispose();
  arena = createArena($('#arena'), S, {
    onPickUnit, onPickMarker, onPickProp, onPickGround, onHover: onArenaHover,
    onPickNothing: () => {},
    isPickable: () => true,
    unitLabel: (u) => { const n = unitName(u.id); return n.charAt(0).toUpperCase() + n.slice(1); },
    quality: profile.setting('quality') || 'high',
    seat: HUMAN ?? 0,
  });
  $('#seed').textContent = `seed ${seed} · ${S.arena.challenge}`;
  history.replaceState(null, '', NET ? `?room=${NET.code}` : `?seed=${seed}${watch ? '&watch' : ''}${pool ? '&pool' : ''}${FAST ? '&fast' : ''}`);
  logLine(`<b>A new duel${NET ? ` in room ${esc(NET.code)}` : ''}.</b> Arena: <i>${esc(S.arena.challenge)}</i>. First to 15 VP.`, 'sys');
  flushFx();
  render();
  updateViewport();
  arena.whenReady.then(() => { if (S) { render(); updateViewport(); } });
  drive();
}

const FOE = () => (NET ? 'Opponent' : 'Enemy');
const whoseTurnName = (p) => (HUMAN === null ? `Player ${p + 1}` : p === HUMAN ? 'You' : FOE());

/**
 * Put YOUR table in the big panel and the other player's in the small one,
 * whichever seat you hold. Online, the guest is seat 1 and sees the match
 * from the other end of the field.
 */
function seatLayout() {
  const me = HUMAN ?? 0, them = 1 - me;
  const mine = $('#mine'), theirs = $('#theirs');
  // Lift the six boards out first; the headers are rebuilt and would take
  // the boards with them otherwise.
  const parts = {};
  for (const p of [0, 1]) for (const kind of ['table', 'golems', 'piles', 'sigils']) { const el = $(`#${kind}${p}`); parts[kind + p] = el; el.remove(); }
  mine.innerHTML = `<div class="shead p${me}">Your Spell Table <span id="mage${me}"></span></div>`;
  theirs.innerHTML = `<div class="shead p${them}">${FOE()} Spell Table <span id="mage${them}"></span></div>`;
  for (const [host, p, small] of [[mine, me, false], [theirs, them, true]]) {
    for (const kind of ['table', 'golems', 'piles', 'sigils']) {
      const el = parts[kind + p];
      el.classList.toggle('small', small && kind !== 'piles');
      host.appendChild(el);
    }
  }
}

/* ================================================================ driving */

/**
 * Let the AI play until it is the human's move.
 *
 * One step at a time with a pause between, sized by how much happened, so an
 * enemy chain is something you watch rather than something that has already
 * happened when the screen updates.
 */
async function drive() {
  if (busy) return;
  if (NET) { render(); if (S.winner !== null) endMatch(); return; }
  busy = true;
  const my = gameId;
  try {
    while (S.winner === null && my === gameId) {
      if (S.pending) {
        const whose = S.pending.request.player ?? S.active;
        if (whose === HUMAN) break;
        await sleep(FAST ? 0 : 380);
        if (my !== gameId) return;
        choose(S, answerFor(S, { policy: POLICY }));
      } else if (S.active !== HUMAN) {
        await sleep(FAST ? 0 : 420);
        if (my !== gameId) return;
        const a = chooseAction(S, { policy: POLICY });
        if (!a) break;
        apply(S, a);
      } else break;
      const ms = flushFx();
      render();
      // Long enough for a chain's turns to play out, one second each, so
      // the next move does not land on a card still spinning.
      await sleep(FAST ? 0 : Math.min(6000, 250 + ms));
    }
  } catch (e) {
    console.error(e);
    toast(`The engine threw: ${e.message}`, 'bad');
  } finally {
    busy = false;
  }
  if (my !== gameId) return;
  render();
  if (S.winner !== null) endMatch();
}

function act(a) {
  if (busy || !a) return;
  sel = null;
  try { apply(S, a); netSend({ act: a }); } catch (e) { console.error(e); toast(`The engine threw: ${e.message}`, 'bad'); }
  flushFx();
  render();
  drive();
}

function answer(v) {
  if (busy || !S.pending) return;
  someChosen = [];
  try { choose(S, v); netSend({ answer: v }); } catch (e) { console.error(e); toast(`The engine threw: ${e.message}`, 'bad'); }
  flushFx();
  render();
  drive();
}

/* ================================================================ online */

/** Every decision made here goes over the wire with the hash it produced. */
function netSend(move) {
  if (NET?.ready) NET.sendMove(move, hashState(S));
}

/** The other player decided something: apply it to our engine and compare. */
function onRemoteMove(msg) {
  if (!S || !NET) return;
  const mv = msg.move || {};
  try {
    if ('act' in mv) apply(S, mv.act); else choose(S, mv.answer);
  } catch (e) {
    console.error(e);
    toast(`The engine threw on your opponent's move: ${e.message}`, 'bad');
  }
  const mine = hashState(S);
  if (msg.hash !== mine) {
    toast('<b>Desync.</b> The two battlefields disagree — start a new duel from the host.', 'bad');
    NET.reportDesync({ seq: msg.seq, mine, theirs: msg.hash });
  }
  flushFx();
  render();
  if (S.winner !== null) endMatch();
}

function leaveRoom() {
  if (!NET) return;
  NET.close();
  NET = null;
  toast('Left the room.', '');
  $('#btn-online').textContent = 'Play online';
}

function startOnline(seed, pool) {
  // The host picks the seed; both sides build the same game from it and the
  // decks fall out of the seed too, so nothing but decisions ever crosses.
  if (NET.isHost) NET.sendSetup({ seed, pool });
  newMatch({ seed, pool, seat: NET.isHost ? 0 : 1 });
}

function openOnline() {
  const url = (code) => `${location.origin}${location.pathname}?room=${code}`;
  if (NET) {
    modal(`<h2>Room ${esc(NET.code)}</h2>
      <p>${NET.ready ? `Connected to your opponent. ${NET.isHost ? 'You are the host: you start the duels.' : 'The host starts the duels.'}` : 'Waiting for your opponent to join…'}</p>
      <p class="code">${esc(NET.code)}</p>
      <p class="dim">Share the code or this link: <input class="link" readonly value="${esc(url(NET.code))}"></p>
      <div class="mbtns">${NET.ready && NET.isHost ? '<button id="ol-new" class="primary">New duel</button>' : ''}<button id="ol-leave" class="ghost">Leave room</button><button id="close" class="ghost">Close</button></div>`);
    $('#ol-leave').onclick = () => { leaveRoom(); closeModal(); };
    const n = $('#ol-new'); if (n) n.onclick = () => { closeModal(); openNewGame(); };
    $('#close').onclick = closeModal;
    return;
  }
  modal(`<h2>Play online</h2>
    <p>Two browsers, one duel. One of you hosts and reads out the four-letter room code; the other joins with it. No account, no server of ours — the two browsers talk directly.</p>
    <div class="online-grid">
      <div><button id="ol-host" class="primary">Host a room</button><p class="dim">You get a code to share, and you start each duel.</p></div>
      <div><label>Room code <input id="ol-code" maxlength="4" placeholder="ABCD" autocapitalize="characters"></label><button id="ol-join">Join</button></div>
    </div>
    <p id="ol-msg" class="dim"></p>
    <div class="mbtns"><button id="close" class="ghost">Cancel</button></div>`);
  const say = (t, bad) => { const m = $('#ol-msg'); if (m) { m.innerHTML = t; m.classList.toggle('bad', !!bad); } };
  $('#close').onclick = closeModal;
  $('#ol-host').onclick = async () => {
    say('Opening a room…');
    const net = new Net();
    try { await net.host(); } catch (e) { say(esc(e.message), true); return; }
    bindNet(net);
    openOnline();
  };
  const join = async () => {
    const code = $('#ol-code').value.trim().toUpperCase();
    if (code.length !== 4) { say('A room code is four letters.', true); return; }
    say(`Joining ${esc(code)}…`);
    const net = new Net();
    try { await net.join(code); } catch (e) { say(esc(e.message), true); return; }
    bindNet(net);
    net.sendHello({ v: 1 });
    closeModal();
    toast(`Joined room <b>${esc(code)}</b>. Waiting for the host to start a duel.`, 'good');
  };
  $('#ol-join').onclick = join;
  $('#ol-code').onkeydown = (e) => { if (e.key === 'Enter') join(); };
  if (params.get('room')) { $('#ol-code').value = params.get('room').toUpperCase(); join(); }
}

function bindNet(net) {
  NET = net;
  $('#btn-online').textContent = `Room ${net.code}`;
  net.addEventListener('move', (e) => onRemoteMove(e.detail));
  net.addEventListener('setup', (e) => { closeModal(); startOnline(e.detail.seed, !!e.detail.pool); });
  net.addEventListener('hello', () => {
    // The guest is in. The host deals the first duel straight away.
    toast('Your opponent joined. Dealing…', 'good');
    closeModal();
    startOnline(Math.floor(Math.random() * 1e6), params.has('pool'));
  });
  net.addEventListener('joined', () => { if (!net.isHost) seatLayout(); });
  net.addEventListener('left', () => { toast('<b>Your opponent left.</b> The room is closed.', 'bad'); leaveRoom(); render(); });
  net.addEventListener('neterror', (e) => toast(esc(e.detail.message), 'bad'));
  net.addEventListener('desync', () => toast('<b>Desync</b> reported by your opponent — start a new duel from the host.', 'bad'));
}

const humanToMove = () => HUMAN !== null && S.winner === null && !S.pending && S.active === HUMAN && !busy;
const humanToAnswer = () => HUMAN !== null && S.winner === null && S.pending
  && (S.pending.request.player ?? S.active) === HUMAN;
const myActions = () => (humanToMove() ? legalActions(S) : []);

/** Progress toward each objective face on a gold card, for the pips. */
function questPips(sp, def) {
  if (def.kind === 'golem' || !def.faces) return [];
  const out = [];
  for (const f of def.faces) {
    if (!f.objective) continue;
    const g = f.objective.gate;
    const pct = gateProgress(S, sp, g);
    const have = g && g.n !== undefined && (g.id === 'ledgerAtLeast') ? Math.min(g.n, counted(S, sp, g)) : null;
    out.push({ numeral: f.numeral, pct, have, need: g?.n ?? null });
  }
  return out;
}

/* ================================================================ names */

function cardName(uid) {
  for (let p = 0; p < 2; p++) {
    const pl = S.players[p];
    for (const st of pl.table) for (const c of st) if (c.uid === uid) return defOf(S, c).name;
    for (const z of ['hand', 'deck', 'discard']) for (const c of pl[z]) if (c.uid === uid) return defOf(S, c).name;
    for (const g of pl.golems) if (g && g.uid === uid) return defOf(S, g).name;
  }
  return `#${uid}`;
}
function unitName(id) {
  const u = S.field.units.find((x) => x.id === id);
  if (!u) return `unit ${id}`;
  const who = HUMAN === null ? `P${u.owner + 1}` : u.owner === HUMAN ? 'your' : 'enemy';
  if (u.kind === 'mage') return `${who} mage`;
  return `${who} ${CARDS[u.def]?.name || 'golem'} ${golemNumber(u)}`;
}
function golemNumber(u) {
  const same = S.field.units.filter((x) => x.owner === u.owner && x.def === u.def && !x.dead).sort((a, b) => a.id - b.id);
  return same.length > 1 ? `#${same.indexOf(u) + 1}` : '';
}
const pName = (p) => (HUMAN === null ? `P${p + 1}` : p === HUMAN ? 'You' : FOE());
const pCls = (p) => `p${p}`;
const propName = (id) => { const pr = S.field.props.find((x) => x.id === id); return pr ? ({ boulder: 'boulder', pillar: 'standing stone', shard: 'crystal', wall: 'wall', floater: 'floating rock', tree: 'tree', earthwall: 'wall of earth' }[pr.kind] || pr.kind) : 'terrain'; };

/* ================================================================ fx */

/**
 * Read the notes the engine left since last time: write the log and turn
 * each into a cue on a timeline. Returns the timeline's length in ms, so the
 * AI's pause can match it.
 */
function flushFx() {
  let t = 0;
  const flash = new Map();
  const later = (ms, fn) => { const my = gameId; timers.push(setTimeout(() => { if (my === gameId && arena) fn(); }, FAST ? 0 : ms)); };
  let castCtx = null;        // the face resolving right now: {p, element, big, face}
  let holdDamage = 0;        // ms to delay the next damage cue (a rock still falling)
  let tMeteor = 0;           // when the last meteor strikes, so its boulder appears then
  const cues = () => arena.cues;
  // A rigid-body run (`dyn`) keeps its own clock. The engine writes the note
  // ahead of everything the run caused and stamps each of those notes with
  // `dynMs`, the moment inside the run it belongs to; such a note is
  // scheduled at the run's start plus its stamp, not at the running cursor,
  // so the number lands when the rock does and the knockdown when the hit
  // does. The cursor itself jumps past the whole run. A note from inside
  // the run that carries no stamp (a landing's fall damage, a slam into a
  // rise) is timed by the event that caused it, or by the timed note just
  // before it (a kill follows its damage).
  let dynStart = null, dynNote = null, dynUsed = null;
  let lastDynT = null;            // when the previous note was timed by the run, its moment
  const DYN_EVENTS = new Set(['hit', 'crumple', 'wall', 'ward', 'land']);
  const dynTimeOf = (f) => {
    if (dynStart === null) return null;
    if (f.dynMs !== undefined) return dynStart + f.dynMs;
    if (f.kind === 'damage' && (f.cause === 'fall' || f.cause === 'impact' || f.cause === 'rock')) {
      const key = `u${f.id}`;
      if (dynNote.bodies.some((b) => b.key === key)) {
        const i = dynNote.events.findIndex((e, j) => e.key === key && DYN_EVENTS.has(e.kind) && !dynUsed.has(j));
        if (i >= 0) { dynUsed.add(i); return dynStart + dynNote.events[i].t; }
      }
    }
    if (lastDynT !== null && (f.kind === 'kill' || f.kind === 'knockdown' || f.kind === 'propHit' || f.kind === 'shatter' || f.kind === 'absorb' || f.kind === 'damage')) return lastDynT;
    return null;
  };
  const fresh = S.fx.slice(fxSeen);
  fresh.forEach((f) => {
    const line = narrate(f);
    if (line) logLine(line, f.kind);
    // Inside a run: the note's own moment, and the cursor is put back after.
    const at = dynTimeOf(f);
    const keep = t;
    if (at !== null) t = at;
    lastDynT = at;
    switch (f.kind) {
      case 'match': t += 350; for (const u of f.uids) flash.set(u, 'match'); break;
      case 'resolveStart': {
        const sp = findSpell(S, f.uid);
        const d = CARDS[f.def];
        const face = d?.faces?.[NUMERALS.indexOf(f.numeral)];
        const p = sp ? sp.owner : S.active;
        const colour = SCHOOL_HEX[d?.school] ?? 0xc98bff;
        castCtx = { p, element: face?.element || null, big: f.numeral === 'IV', face, def: d };
        if (f.uid) flash.set(f.uid, 'resolve');
        later(t, () => cues().cast(p, colour, { big: f.numeral === 'IV' }));
        // Area faces get their own ground effect.
        if (face?.element === 'force' && face.reach) {
          const quake = /quake/i.test(face.text);
          const pp = p, r = face.reach;
          later(t + 200, () => (quake ? cues().quake(pp, r) : cues().nova(pp, r, 0x9fd8ff)));
        }
        t += 300;
        break;
      }
      // A TURN IS PLAYED, never snapped: the card lifts, glows in its
      // school's colour and spins a quarter over a second, the new numeral
      // pops as the face comes round, and only then does the chain go on
      // (user: "sometimes its hard to catch how fast it moves. Make it so
      // that there are cool animations for each spell as they turn").
      case 'rotate': { const note = f; pendingTurns.set(note.uid, (pendingTurns.get(note.uid) || 0) + 1); later(t, () => playTurn(note)); t += TURN_MS + 120; break; }
      case 'play': case 'golemCard': t += 150; break;
      case 'destroy': t += 150; break;
      case 'damage': {
        const { id, amount, cause } = f;
        const ctx = castCtx;
        const delay = t + holdDamage;
        holdDamage = 0;
        if ((cause === 'spell' || cause === 'unstable') && ctx) {
          const el = ctx.element || 'arcane';
          const big = ctx.big;
          later(delay, () => cues().bolt(ctx.p, id, { element: el, big, onArrive: () => cues().hit(id, amount, el === 'lightning' || el === 'fire' ? el : cause) }));
          t += el === 'lightning' ? 220 : 450;
        } else if (cause === 'strike') {
          later(delay + 320, () => cues().hit(id, amount, cause));
          t += 200;
        } else {
          later(delay, () => cues().hit(id, amount, cause));
          t += 160;
        }
        break;
      }
      case 'strike': { const { from, to } = f; later(t - 200, () => cues().strike(from ?? f.id, to)); t += 300; break; }
      case 'kill': { const id = f.id; later(t + 150, () => cues().kill(id)); t += 500; break; }
      // A rigid-body run: held at its first frame NOW (the sync has already
      // moved the engine's targets), played at its turn, and the cursor
      // jumps past it. The notes it caused follow, stamped with their moment.
      case 'dyn': {
        const note = f;
        dynStart = t; dynNote = note; dynUsed = new Set();
        cues().dynHold(note);
        later(t, () => cues().dyn(note));
        for (const line2 of narrateDyn(note)) logLine(line2, 'dyn');
        t += (note.ms || 0) + 150;
        break;
      }
      // A rider on a sliding piece: the run's playback carries it (the note's
      // `carried` list); the line in the log is all that is left to do.
      case 'carry': break;
      case 'topple': {
        const { id, dir, hits } = f;
        // Marked NOW, before render() syncs the destroyed piece away, so it
        // stays standing until its fall has played.
        cues().toppling(id);
        later(t, () => cues().topple(id, dir, hits || []));
        t += 1150;
        break;
      }
      case 'knockdown': { const { id, dir } = f; later(t, () => cues().knockdown(id, dir)); t += 500; break; }
      case 'falls': for (const l of f.landed || []) if (l.key[0] === 'u' && l.drop > 0) { const id = Number(l.key.slice(1)), drop = l.drop; later(t + 250, () => cues().fall(id, drop)); } t += 350; break;
      case 'hurl': { const { id, mm } = f; later(t, () => cues().hurl(id, mm)); holdDamage = 900; t += 1000; break; }
      case 'dropRock': { const { id, from, to, onto } = f; later(t, () => cues().dropRock(id, from, to, onto)); holdDamage = 1050; t += 1200; break; }
      case 'swap': { const { a, b } = f; later(t, () => cues().swap(a, b)); t += 500; break; }
      case 'raiseWall': t += 500; break;
      // A TRAP SPRINGS: the cell flashes, the real card is shown for a
      // moment, then it leaves for the discard. Everything after waits.
      case 'trapSpring': { const note = f; later(t, () => revealTrap(note)); t += 1700; break; }
      case 'snared': case 'sprung': case 'backlash': t += 150; break;
      case 'heal': { const { id, amount } = f; later(t, () => cues().heal(id, amount)); t += 250; break; }
      case 'poisoned': { const id = f.id; later(t, () => cues().poison(id)); t += 150; break; }
      case 'levitate': { const id = f.id; later(t, () => cues().levitate(id, f.mm)); t += 400; break; }
      case 'terrainRemoved': { const id = f.id; later(t, () => cues().terrainRemoved(id)); t += 300; break; }
      case 'ignite': { const id = f.id; later(t, () => cues().ignite(id)); t += 200; break; }
      // --- the red physical tranche. Payloads are documented at each engine fx() site.
      // A rock out of the sky: the streak takes 900ms, the hits land with it.
      case 'meteor': { const { at, radius } = f; tMeteor = t + 900; later(t, () => cues().meteorIncoming(at, radius)); holdDamage = 900; t += 1000; break; }
      // The new boulder appears at the moment of impact, not after the pushes it caused.
      case 'meteorLand': { const { id, at } = f; cues().meteorPending(id); later(tMeteor || t, () => cues().meteorLand(id, at)); break; }
      case 'shrapnel': { const { at, radius, id } = f; later(t, () => cues().shrapnel(id, at, radius)); t += 300; break; }
      case 'thunderclap': { const { p, at, radius } = f; later(t, () => cues().thunderclap(p, at, radius)); t += 350; break; }
      case 'charge': { const { id, from, to, dir, mm } = f; const dur = 250 + (mm / 1000) * 160; later(t, () => cues().charge(id, from, to, dir, mm, dur)); t += dur + 80; break; }
      case 'cannonade': { const { id, at } = f; later(t, () => cues().cannonade(id, at)); t += 250; break; }
      case 'burning': { const id = f.id; later(t, () => cues().burnUnit(id)); t += 200; break; }
      case 'burnOut': t += 100; break;
      case 'lift': { const { id, mm } = f; later(t, () => cues().lift(id, mm)); t += 450; break; }
      case 'flameLine': { const { p, radius } = f; later(t, () => cues().flameLine(p, radius)); t += 300; break; }
      case 'propHit': { const id = f.id; later(t, () => cues().propHit(id, f.amount)); t += 120; break; }
      case 'shatter': t += 400; break;
      case 'summon': { const id = f.id; later(t + 60, () => cues().summon(id)); t += 500; break; }
      case 'score': { const p = f.p; later(t, () => cues().score(p)); toast(`${pName(f.p)} +${f.amount} VP — ${SOURCE[f.source] || esc(f.source)}`, f.p === HUMAN ? 'good' : HUMAN === null ? 'good' : 'bad'); t += 500; break; }
      // A rune earned: its chip in the owner's pouch flares.
      case 'rune': { const { p, rune } = f; later(t, () => flashChip(p, rune)); t += 120; break; }
      // A BIND: the engine has already spent the hit runes and queued the
      // finds. On your board the hit cells flash gold with their runes still
      // showing, then the whole scratch empties (what was not hit never left
      // the pouch); a bind that hit nothing shakes the board instead.
      case 'bind': {
        const { p, hits } = f;
        if (p !== HUMAN) break;
        const cells = hits.flatMap((h) => h.cells);
        if (cells.length) { later(t, () => flashSigil(cells)); later(t + 1000, clearScratch); t += 1000; }
        else { later(t, () => { shakeBoard(); toast('Nothing bound — your runes return to the pouch', ''); }); later(t + 500, clearScratch); t += 500; }
        break;
      }
      case 'sigil': {
        const { p, defId } = f;
        toast(`✶ ${p === HUMAN ? 'Your' : HUMAN === null ? `${pName(p)}'s` : `${FOE()}'s`} sigil completes — <b>${esc(CARDS[defId]?.name || defId)}</b>`, p === HUMAN || HUMAN === null ? 'good' : 'bad');
        t += 300; break;
      }
      case 'found':
        if (f.p === HUMAN) {
          // Into the Spellbook NOW, not at the end of the match -- a player
          // who opens the book mid-duel should see what they just learned.
          profile.learn(f.defId, f.why);
          toast(`Learned <b>${esc(CARDS[f.defId]?.name || f.defId)}</b> — ${f.taken === false ? 'written in your Spellbook, not taken' : 'it goes to your discard'}`, 'learn');
        }
        t += 300; break;
      case 'turnStart': banner(f.p); break;
      case 'respawn': t += 400; break;
      case 'swept': t += 600; break;
      case 'win': { const p = f.p; later(t + 300, () => cues().cheer(p)); break; }
      case 'move': t += 120; break;
      default: break;
    }
    if (at !== null) t = Math.max(keep, t);
  });
  fxSeen = S.fx.length;
  pendingFlash = flash;
  return t;
}
let pendingFlash = new Map();
const SOURCE = { objective: 'an objective completed', mage: 'a mage slain', golem: 'a golem slain' };

/** The log lines a rigid-body run deserves: the slams, the crush, a body going over an edge. */
function narrateDyn(note) {
  const idOf = new Map((note.bodies || []).map((b) => [b.key, b]));
  const who = (key) => { const b = idOf.get(key); if (!b) return 'something'; return b.body === 'unit' ? esc(unitName(b.id)) : `a ${esc(propName(b.id))}`; };
  const pad = '&nbsp;&nbsp;&nbsp;&nbsp;';
  const out = [];
  for (const e of note.events || []) {
    if (e.kind === 'hit' && (e.dmg > 0 || idOf.get(e.into)?.body === 'unit')) out.push(`${pad}<b>${who(e.key)} slams into ${who(e.into)}</b>${e.dmg > 0 ? ` for <span class="red">${e.dmg}</span>` : ', no harm done'}`);
    else if (e.kind === 'crumple') out.push(`${pad}<b>${who(e.key)} is crushed under ${who(e.by)}</b>`);
    else if ((e.kind === 'wall' || e.kind === 'ward') && idOf.get(e.key)?.body === 'unit' && e.speed > 1500) out.push(`${pad}<b>${who(e.key)} is slammed against ${e.kind === 'ward' ? 'the ward' : 'a wall of rock'}</b>`);
    else if (e.kind === 'edge') out.push(`${pad}${who(e.key)} goes over the edge`);
  }
  return out;
}

function narrate(f) {
  const P = (p) => `<span class="${pCls(p)}">${pName(p)}</span>`;
  const N = (uid) => `<b>${esc(cardName(uid))}</b>`;
  const m = (mm) => `${(mm / 1000).toFixed(1)}m`;
  switch (f.kind) {
    case 'turnStart': return `<hr><span class="turn">Turn ${f.turn}</span> — ${P(f.p)}`;
    case 'play': {
      // A trap set by the other side is named only when it springs.
      const sp = findSpell(S, f.uid);
      if (sp && defOf(S, sp).kind === 'trap' && HUMAN !== null && f.p !== HUMAN) return `${P(f.p)} sets a <b>face-down TRAP</b> into a grey corner`;
      if (sp && defOf(S, sp).kind === 'trap') return `${P(f.p)} set${f.p === HUMAN ? '' : 's'} ${N(f.uid)} face down into the grey cell`;
      return `${P(f.p)} play${f.p === HUMAN ? '' : 's'} ${N(f.uid)} to the ${CELL_COLOR[f.cell]} cell`;
    }
    case 'trapSpring': return `<span class="gold">⚠ ${f.p === HUMAN ? 'Your' : HUMAN === null ? `${pName(f.p)}'s` : `${FOE()}'s`} trap springs: <b>${esc(f.name || f.def)}</b></span>`;
    case 'snared': return `&nbsp;&nbsp;&nbsp;&nbsp;${esc(unitName(f.id))} is snared`;
    case 'backlash': return `&nbsp;&nbsp;&nbsp;&nbsp;the backlash bites ${esc(unitName(f.id))} for ${f.amount}`;
    case 'held': return `&nbsp;&nbsp;&nbsp;&nbsp;${esc(unitName(f.id))} loses its next action`;
    case 'sprung': return `&nbsp;&nbsp;&nbsp;&nbsp;${esc(unitName(f.id))} is flung away from ${esc(unitName(f.from))}`;
    case 'golemCard': return `${P(f.p)} set${f.p === HUMAN ? '' : 's'} ${N(f.uid)} into golem slot ${'ABC'[f.slot] || f.slot}`;
    case 'rotate': return `↺ ${N(f.uid)} turns ${f.dir} to <b>${NUMERALS[f.rot]}</b>`;
    case 'shift': return `⇄ ${N(f.uid)} shifts from cell ${f.from} to ${f.to}`;
    case 'destroy': return `✕ ${N(f.uid)} is destroyed`;
    case 'match': return `<span class="gold">✦ MATCH</span> — ${f.uids.map(N).join(' + ')}`;
    case 'matchLocked': return `<i>a match is locked — nothing there may turn</i>`;
    case 'matchExhausted': return `<i>a match has nothing left that may turn</i>`;
    case 'resolveStart': {
      const d = CARDS[f.def];
      const face = d?.faces?.[NUMERALS.indexOf(f.numeral)];
      return `&nbsp;&nbsp;▸ <b>${esc(d?.name || f.def)} ${f.numeral}</b>: ${esc(face?.text || '')}`;
    }
    case 'gateUnmet': return `&nbsp;&nbsp;&nbsp;&nbsp;<i>inert — ${esc(f.text || 'its condition is unmet')}</i>`;
    case 'fizzle': return `&nbsp;&nbsp;&nbsp;&nbsp;<i>fizzles — the cost was not paid</i>`;
    case 'keywordCopy': return `&nbsp;&nbsp;&nbsp;&nbsp;<span class="kw">[${esc(f.kw)}]</span> resonates from ${N(f.from)} onto ${N(f.to)}`;
    case 'keywordGrant': return `&nbsp;&nbsp;&nbsp;&nbsp;grants <span class="kw">[${esc(f.kw)}]</span> to ${N(f.uid)}`;
    case 'damage': return `&nbsp;&nbsp;&nbsp;&nbsp;<span class="red">${f.amount} damage</span> to ${esc(unitName(f.id))}${f.cause && f.cause !== 'spell' ? ` (${esc(f.cause)})` : ''}`;
    case 'carry': return `&nbsp;&nbsp;&nbsp;&nbsp;${esc(unitName(f.id))} rides the ${esc(propName(f.on))} ${m(f.mm)}`;
    case 'scraped': return `&nbsp;&nbsp;&nbsp;&nbsp;${esc(unitName(f.id))} is scraped off the ${esc(propName(f.off))}`;
    case 'noOrigin': return `&nbsp;&nbsp;&nbsp;&nbsp;<span class="dim">nothing to pull toward or push from: ${f.p === HUMAN ? 'your' : HUMAN === null ? pName(f.p) + "'s" : 'the enemy'} mage is down</span>`;
    case 'dyn': return null;
    case 'topple': {
      const onto = (f.hits || []).map((id) => esc(unitName(id)));
      return `&nbsp;&nbsp;&nbsp;&nbsp;<b>the ${esc(propName(f.id))} topples</b>${onto.length ? ` onto ${onto.join(' and ')}` : ''}`;
    }
    case 'knockdown': return `&nbsp;&nbsp;&nbsp;&nbsp;${esc(unitName(f.id))} is knocked flat and loses its action`;
    case 'pushResult': return null;
    case 'falls': return `&nbsp;&nbsp;&nbsp;&nbsp;<b>falls</b>: ${(f.landed || []).map((l) => m(l.drop)).join(', ')}`;
    case 'kill': return `<span class="red">☠ ${esc(unitName(f.id))} slain</span>${f.by !== null && f.by !== undefined ? ` by ${P(f.by)}` : ''}`;
    case 'score': return `<span class="gold">+${f.amount} VP</span> to ${P(f.p)} — ${SOURCE[f.source] || esc(f.source)}`;
    case 'summon': return `${P(f.p)} summon${f.p === HUMAN ? '' : 's'} a ${N(f.uid)}`;
    case 'strike': return `&nbsp;&nbsp;⚔ ${esc(unitName(f.from ?? f.id))} strikes ${esc(unitName(f.to))} for ${f.amount}${f.edge ? ' (high ground)' : ''}`;
    case 'move': return null;
    case 'respawn': return `${P(f.p)} mage respawns`;
    case 'swept': return `<span class="red">${P(f.p)} spell table is swept into the discard</span> — ${f.uids.length} card${f.uids.length === 1 ? '' : 's'}`;
    case 'rune': return `&nbsp;&nbsp;&nbsp;&nbsp;${P(f.p)} earn${f.p === HUMAN ? '' : 's'} a ${runeGlyphInline(f.rune, RUNE_INK[f.rune])}<b>${RUNE_NAME[f.rune]}</b> rune${f.def ? ` (${esc(CARDS[f.def]?.name || f.def)}${f.numeral ? ` ${f.numeral}` : ''})` : ''}`;
    case 'bind': {
      const n = f.cells.length, s = f.p === HUMAN ? '' : 's';
      return f.hits.length ? `${P(f.p)} lay${s} ${n} rune${n === 1 ? '' : 's'} and bind${s}` : `${P(f.p)} lay${s} ${n} rune${n === 1 ? '' : 's'} and bind${s} <i>nothing</i> — they return to the pouch`;
    }
    case 'sigil': return `<span class="gold">✶ SIGIL</span> — <b>${esc(CARDS[f.defId]?.name || f.defId)}</b>'s sigil is bound`;
    case 'found': return `${P(f.p)} <span class="green">find${f.p === HUMAN ? '' : 's'} ${esc(CARDS[f.defId]?.name || f.defId)}</span>${f.taken === false ? ' <i>(not taken)</i>' : ''}`;
    case 'golemSpent': return `${N(f.uid)} is spent and goes to the discard`;
    case 'terrainRemoved': return `&nbsp;&nbsp;&nbsp;&nbsp;banishes a ${esc(propName(f.id))} until end of turn`;
    case 'levitate': return `&nbsp;&nbsp;&nbsp;&nbsp;lifts a ${esc(propName(f.id))} ${m(f.mm)}`;
    case 'relocate': return `&nbsp;&nbsp;&nbsp;&nbsp;relocates ${esc(unitName(f.id))}`;
    case 'reshuffle': return `${P(f.p)} shuffle${f.p === HUMAN ? '' : 's'} the discard back into the deck`;
    case 'handFull': return `<i>${P(f.p)} ${f.p === HUMAN ? 'hold' : 'holds'} five cards — nothing is drawn</i>`;
    case 'prohibited': return `&nbsp;&nbsp;&nbsp;&nbsp;${N(f.uid)} may not rotate again this turn`;
    case 'chainEnd': return f.resolutions > 1 ? `<i>a chain of ${f.resolutions}</i>` : null;
    case 'hurl': return `&nbsp;&nbsp;&nbsp;&nbsp;hurls ${esc(unitName(f.id))} ${(f.mm / 1000).toFixed(0)}m into the air`;
    case 'dropRock': return `&nbsp;&nbsp;&nbsp;&nbsp;drops a ${esc(propName(f.id))} on ${esc(unitName(f.onto))}`;
    case 'swap': return `&nbsp;&nbsp;&nbsp;&nbsp;${esc(unitName(f.a))} and ${esc(unitName(f.b))} swap places`;
    case 'raiseWall': return f.prop === 'earthwall' ? `&nbsp;&nbsp;&nbsp;&nbsp;<b>dirt heaves up into a wall</b> in the spell's path` : `&nbsp;&nbsp;&nbsp;&nbsp;a stone wall rises out of the ground`;
    case 'heal': return `&nbsp;&nbsp;&nbsp;&nbsp;<span class="green">${esc(unitName(f.id))} regains ${f.amount}</span>`;
    case 'recall': return `&nbsp;&nbsp;&nbsp;&nbsp;returns ${N(f.uid)} to hand`;
    case 'reanimate': return `&nbsp;&nbsp;&nbsp;&nbsp;${N(f.uid)} rises from the discard`;
    case 'poisoned': return `&nbsp;&nbsp;&nbsp;&nbsp;${esc(unitName(f.id))} is poisoned (${f.n})`;
    case 'mageLife': return `${P(f.p)} mage now has ${f.maxHp} life`;
    case 'ignite': return `&nbsp;&nbsp;&nbsp;&nbsp;<span class="red">a ${esc(propName(f.id))} catches fire</span>`;
    case 'meteor': return `&nbsp;&nbsp;&nbsp;&nbsp;<span class="red">☄ a meteor comes down</span>${f.hits?.length ? ` on ${f.hits.map((id) => esc(unitName(id))).join(', ')}` : ''}`;
    case 'meteorLand': return `&nbsp;&nbsp;&nbsp;&nbsp;a new boulder lies where it struck`;
    case 'shrapnel': return `&nbsp;&nbsp;&nbsp;&nbsp;<b>a ${esc(propName(f.id))} bursts into shrapnel</b>${f.hits?.length ? ` — ${f.hits.map((id) => esc(unitName(id))).join(', ')}` : ''}`;
    case 'thunderclap': return `&nbsp;&nbsp;&nbsp;&nbsp;<span class="red">⚡ THUNDERCLAP</span>${f.hits?.length ? ` — ${f.hits.map((id) => esc(unitName(id))).join(', ')} floored` : ' — nobody close enough'}`;
    case 'charge': return `&nbsp;&nbsp;&nbsp;&nbsp;${esc(unitName(f.id))} charges ${m(f.mm)}${f.hits?.length ? `, through ${f.hits.map((id) => esc(unitName(id))).join(', ')}` : ''}${f.rammed !== null && f.rammed !== undefined ? ` and rams ${esc(unitName(f.rammed))}` : ''}`;
    case 'cannonade': return `&nbsp;&nbsp;&nbsp;&nbsp;fires a ${esc(propName(f.id))} at ${esc(unitName(f.at))}`;
    case 'burning': return `&nbsp;&nbsp;&nbsp;&nbsp;<span class="red">${esc(unitName(f.id))} is set burning</span> (${f.turns} turn${f.turns === 1 ? '' : 's'})`;
    case 'burnOut': return `&nbsp;&nbsp;&nbsp;&nbsp;the fire on ${esc(unitName(f.id))} goes out`;
    case 'lift': return `&nbsp;&nbsp;&nbsp;&nbsp;lifts ${esc(unitName(f.id))} ${m(f.mm)} into the air`;
    case 'flameLine': return `&nbsp;&nbsp;&nbsp;&nbsp;<span class="red">fire runs through the trees</span>${f.lit?.length ? ` (${f.lit.length} alight)` : ''}`;
    case 'burntOut': return `&nbsp;&nbsp;&nbsp;&nbsp;a ${esc(f.kind)} burns away to ash`;
    case 'propHit': return `&nbsp;&nbsp;&nbsp;&nbsp;a ${esc(propName(f.id))} cracks (${f.amount})${f.hp <= 0 ? '' : `, ${f.hp} left`}`;
    case 'shatter': return `&nbsp;&nbsp;&nbsp;&nbsp;<b>a ${esc(f.kind === 'pillar' ? 'standing stone' : f.kind === 'shard' ? 'crystal' : f.kind === 'earthwall' ? 'wall of earth' : f.kind)} shatters</b>`;
    case 'win': return `<span class="gold big">★ ${P(f.p)} win${f.p === HUMAN ? '' : 's'} — ${esc(f.reason)}</span>`;
    case 'draw': return `<b>a draw at the turn cap</b>`;
    default: return null;
  }
}

/**
 * The moment a trap goes off, on the table: a flash on its corner, the real
 * card face up over the cell for a second and a half, then it slides away
 * to the discard. The engine has already moved the card, so this is an
 * overlay the table render does not touch.
 */
function revealTrap(f) {
  const cell = document.querySelector(`#table${f.p} .cell[data-cell="${f.cell}"]`);
  const def = CARDS[f.def];
  if (!cell || !def) return;
  cell.querySelectorAll('.trapreveal').forEach((e) => e.remove());
  const el = document.createElement('div');
  el.className = 'trapreveal';
  el.innerHTML = cardSVG(def);
  cell.appendChild(el);
  cell.classList.remove('flash-trap'); void cell.offsetWidth; cell.classList.add('flash-trap');
  toast(`${f.p === HUMAN ? 'Your' : HUMAN === null ? `${pName(f.p)}'s` : `${FOE()}'s`} trap springs — <b>${esc(def.name)}</b>`, f.p === HUMAN ? 'good' : 'bad');
  const my = gameId;
  timers.push(setTimeout(() => { if (my === gameId) el.remove(); }, FAST ? 0 : 1900));
}

function logLine(html, kind = '') {
  const el = document.createElement('div');
  el.className = `ll k-${kind}`;
  el.innerHTML = html;
  const log = $('#log');
  log.appendChild(el);
  while (log.children.length > 400) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}

function toast(html, cls = '') {
  const el = document.createElement('div');
  el.className = `toast ${cls}`;
  el.innerHTML = html;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), FAST ? 400 : 2600);
  setTimeout(() => el.remove(), FAST ? 700 : 3200);
}

function banner(p) {
  const el = $('#banner');
  el.className = `banner ${pCls(p)}`;
  el.textContent = HUMAN === null ? `Player ${p + 1}'s turn` : p === HUMAN ? 'Your turn' : `${FOE()}'s turn`;
  void el.offsetWidth;
  el.classList.add('show');
}

/* ================================================================ tables */

const angles = new Map();   // uid -> {rot, deg}: so a turn spins the short way

/** Advance a tracked angle to `rot` the short way round. */
function advanceAngle(a, rot) {
  if (a.rot === rot) return;
  const d = (((rot - a.rot) % 4) + 4) % 4;
  a.deg += d === 3 ? 90 : -90 * d;
  a.rot = rot;
}
/**
 * The angle a table card is DRAWN at. While a turn cue is still owed for
 * the card (the engine has already turned it; the timeline has not reached
 * that moment), the drawn angle waits for the cue, so a chain of three turns
 * is three turns on screen and not one snap.
 */
function bodyAngle(sp) {
  const a = angles.get(sp.uid);
  if (!a) { const deg = -90 * sp.rot; angles.set(sp.uid, { rot: sp.rot, deg }); return deg; }
  if (!pendingTurns.get(sp.uid)) advanceAngle(a, sp.rot);
  return a.deg;
}

/** How long one quarter-turn takes on screen. flushFx paces the chain by it. */
const TURN_MS = 1000;
const pendingTurns = new Map();   // uid -> turn cues not yet played

/**
 * One quarter-turn of a table card, as a cue. The card lifts and glows,
 * the body spins over TURN_MS, the centre swaps to the new face as it
 * comes round and the numeral pops; a ring sweeps the cell meanwhile.
 */
function playTurn(f) {
  const left = (pendingTurns.get(f.uid) || 1) - 1;
  if (left > 0) pendingTurns.set(f.uid, left); else pendingTurns.delete(f.uid);
  const sp = findSpell(S, f.uid);
  const a = angles.get(f.uid) || { rot: f.rot, deg: -90 * f.rot };
  angles.set(f.uid, a);
  advanceAngle(a, f.rot);
  if (!sp || sp.cell === null || sp.cell === undefined) return;
  const cell = document.querySelector(`#table${sp.owner} .cell[data-cell="${sp.cell}"]`);
  const card = cell?.querySelector('.card.on-table');
  const body = card?.querySelector('.cbody');
  if (!body) return;
  const def = defOf(S, sp);
  if (FAST) { body.style.transform = `rotate(${a.deg}deg)`; return; }
  const my = gameId;
  cell.classList.add('turning');
  card.classList.add('turning');
  card.style.setProperty('--turn-ms', `${TURN_MS}ms`);
  body.style.transition = `transform ${TURN_MS}ms cubic-bezier(.4,1.25,.45,1)`;
  body.style.transform = `rotate(${a.deg}deg)`;
  const ring = document.createElement('div');
  ring.className = 'turnring';
  ring.innerHTML = `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" pathLength="100"/></svg><div class="turnnum">${NUMERALS[f.rot]}</div>`;
  cell.appendChild(ring);
  // The face comes round: the centre shows the new side and its numeral pops.
  timers.push(setTimeout(() => {
    if (my !== gameId) return;
    const kws = kwList(sp);
    const printed = [0, 1, 2, 3].map((pos) => def.runes[(pos + f.rot) & 3]);
    const runes = a.rot === sp.rot ? [0, 1, 2, 3].map((pos) => runeAtCorner(S, sp, pos)) : printed;
    const centre = card.querySelector('.ccentre');
    if (centre) centre.innerHTML = centreSVG(def, f.rot & 3, { keywords: kws, runes, printed, quests: questPips(sp, def) });
    ring.classList.add('shown');
  }, TURN_MS * 0.45));
  timers.push(setTimeout(() => {
    cell.classList.remove('turning');
    card.classList.remove('turning');
    body.style.transition = '';
    ring.remove();
  }, TURN_MS + 150));
}

/** A card's Keywords for drawing: its own in gold, the resonating ones plain. */
function kwList(sp) {
  const { own, resonant } = keywordSources(S, sp);
  return [...own.map((kw) => ({ kw, own: true })), ...resonant.map((r) => ({ kw: r.kw, own: false, from: r.from }))]
    .sort((x, y) => x.kw.localeCompare(y.kw));
}

function buildTable(p) {
  const el = $(`#table${p}`);
  el.innerHTML = '';
  // The bonds overlay: a bridge between any two touching corners that match.
  const bonds = document.createElement('div');
  bonds.className = 'bonds';
  el.appendChild(bonds);
  for (let c = 0; c < 9; c++) {
    const cell = document.createElement('div');
    cell.className = `cell c-${CELL_COLOR[c]}`;
    cell.dataset.cell = c;
    cell.dataset.p = p;
    cell.innerHTML = `<div class="cellmark">${cellSigil(CELL_COLOR[c])}</div><div class="slot"></div><div class="badges"></div>`;
    cell.addEventListener('click', () => onCellClick(p, c));
    cell.addEventListener('contextmenu', (e) => { e.preventDefault(); const sp = topOf(S, p, c); if (sp) peekSpell(sp); else closePeek(); });
    cell.addEventListener('mouseenter', () => {
      const sp = topOf(S, p, c);
      if (!sp) return;
      inspectSpell(sp);
      hoverSpell = sp.uid;
      if (arena && S) arena.setRanges(rangePreview());
    });
    cell.addEventListener('mouseleave', () => {
      hideInspector();
      hoverSpell = null;
      if (arena && S) arena.setRanges(rangePreview());
    });
    el.appendChild(cell);
  }
  const gs = $(`#golems${p}`);
  gs.innerHTML = '';
  for (let s = 0; s < 3; s++) {
    const g = document.createElement('div');
    g.className = 'gslot';
    g.dataset.slot = s;
    g.addEventListener('click', () => onSlotClick(p, s));
    g.addEventListener('contextmenu', (e) => { e.preventDefault(); const gc = S.players[p].golems[s]; if (gc) peekMarkup(`<div class="card"><div class="cbody">${cardSVG(defOf(S, gc))}</div></div>`); });
    g.addEventListener('mouseenter', () => { const gc = S.players[p].golems[s]; if (gc) inspectDef(defOf(S, gc), 0, null, gc); });
    g.addEventListener('mouseleave', hideInspector);
    gs.appendChild(g);
  }
}

function cellSigil(colour) {
  const ink = SCHOOL_INK[colour];
  return `<svg viewBox="0 0 100 100"><g fill="none" stroke="${ink}" stroke-width="1.5" opacity=".55">
    <circle cx="50" cy="50" r="30"/><path d="M50 14 L86 50 L50 86 L14 50 Z"/><circle cx="50" cy="50" r="6"/></g></svg>`;
}

/**
 * Magically bound corners -- of the ACTIVE card only. The card the chain is
 * looking at right now (or, before the chain starts, the card just played,
 * rotated or shifted) gets a pulsing purple-blue bridge from each of its
 * matching corners to the neighbour's. Nothing is drawn for pairs that
 * merely sit matching: those do not fire, and drawing them said they would.
 */
const CORNER_FRAC = [[0.105, 0.105], [0.895, 0.105], [0.895, 0.895], [0.105, 0.895]];
function renderBonds(p) {
  const table = $(`#table${p}`);
  const layer = table?.querySelector('.bonds');
  if (!layer) return;
  const focus = S.chain && S.chain.p === p && S.chain.active !== null && S.chain.active !== undefined
    ? [S.chain.active] : (S.fresh?.[p] || []);
  const live = focus.length ? findMatches(S, p, S.chain?.spent || [], focus) : [];
  if (!live.length) { if (layer.childElementCount) layer.innerHTML = ''; return; }
  const tb = table.getBoundingClientRect();
  const cells = table.querySelectorAll('.cell');
  let html = '';
  for (const h of live) {
    const site = SITE[h.site];
    const pts = [0, 1].map((k) => {
      const b = cells[site.cells[k]].getBoundingClientRect();
      const [fx, fy] = CORNER_FRAC[site.pos[k]];
      return [b.left - tb.left + b.width * fx, b.top - tb.top + b.height * fy];
    });
    const dx = pts[1][0] - pts[0][0], dy = pts[1][1] - pts[0][1];
    const len = Math.hypot(dx, dy), ang = Math.atan2(dy, dx) * 180 / Math.PI;
    const cx = (pts[0][0] + pts[1][0]) / 2, cy = (pts[0][1] + pts[1][1]) / 2;
    const cls = 'bond';
    html += `<div class="${cls}" style="left:${pts[0][0]}px;top:${pts[0][1]}px;width:${len}px;transform:rotate(${ang}deg)"></div><div class="${cls} knot" style="left:${cx}px;top:${cy}px"></div>`;
  }
  if (layer.innerHTML !== html) layer.innerHTML = html;
}

function renderTable(p) {
  const pl = S.players[p];
  const cells = document.querySelectorAll(`#table${p} .cell`);
  const la = p === HUMAN ? myActions() : [];
  cells.forEach((cell, c) => {
    const sp = topOf(S, p, c);
    const slot = cell.querySelector('.slot');
    const badges = cell.querySelector('.badges');
    cell.classList.toggle('actable', !!sp && la.some((a) => a.uid === sp.uid && a.type !== 'play'));
    if (!sp) {
      if (cell.dataset.uid) { slot.innerHTML = ''; cell.dataset.uid = ''; }
      badges.innerHTML = '';
      cell.classList.remove('filled');
      return;
    }
    const def = defOf(S, sp);
    cell.classList.add('filled');
    if (def.kind === 'trap') {
      // A SET TRAP. The opponent sees a card back with the seal and nothing
      // to read; its owner sees the card dimmed, marked concealed. Both
      // engines hold the whole state -- what is hidden is hidden here.
      const hidden = sp.concealed && HUMAN !== null && p !== HUMAN;
      const key = `${sp.uid}:${hidden ? 'back' : 'face'}`;
      if (cell.dataset.uid !== key) {
        slot.innerHTML = `<div class="card on-table trap${hidden ? ' back' : ' mine'}"><div class="cbody">${hidden ? cardBackSVG() : cardSVG(def)}</div></div>`;
        cell.dataset.uid = key;
      }
      cell.classList.toggle('trap-set', true);
      badges.innerHTML = hidden ? '<span class="trapbadge" title="a face-down trap: it springs when you trigger it">TRAP</span>'
        : '<span class="trapbadge" title="face down; springs on its own during your opponent\'s turn">TRAP · concealed</span>';
      return;
    }
    cell.classList.remove('trap-set');
    if (cell.dataset.uid !== String(sp.uid)) {
      slot.innerHTML = `<div class="card on-table"><div class="cbody">${cardSVG(def, { rot: 0, centre: false, lit: false })}</div><div class="ccentre"></div></div>`;
      cell.dataset.uid = sp.uid;
    }
    const body = slot.querySelector('.cbody');
    body.style.transform = `rotate(${bodyAngle(sp)}deg)`;
    const kws = kwList(sp);
    const runes = [0, 1, 2, 3].map((pos) => runeAtCorner(S, sp, pos));
    const printed = [0, 1, 2, 3].map((pos) => def.runes[(pos + sp.rot) & 3]);
    const hot = (S.pending?.request?.match?.sites || []).flatMap((site) => site.corners).filter((c) => c.uid === sp.uid).map((c) => c.pos);
    const quests = questPips(sp, def);
    // Mid-turn the centre belongs to the cue: it swaps the face itself.
    if (!pendingTurns.get(sp.uid)) slot.querySelector('.ccentre').innerHTML = centreSVG(def, activeIndex(sp), { keywords: kws, runes, printed, hot, quests });
    const depth = stackAt(S, p, c).length - 1;
    const bits = [];
    if (depth > 0) bits.push(`<span title="cards buried beneath">▤${depth}</span>`);
    if (CELL_COLOR[c] !== def.school && def.kind !== 'artifact') bits.push('<span title="off its colour: cannot be rotated by you">⊘</span>');
    badges.innerHTML = bits.join('');
    const fl = pendingFlash.get(sp.uid);
    if (fl) { cell.classList.remove('flash-match', 'flash-resolve'); void cell.offsetWidth; cell.classList.add(`flash-${fl}`); }
  });

  document.querySelectorAll(`#golems${p} .gslot`).forEach((el, s) => {
    const g = pl.golems[s];
    if (!g) { el.innerHTML = `<span class="empty">${'ABC'[s]} slot<small>${['the giant', 'the warden', 'the swarm'][s]}</small></span>`; el.dataset.uid = ''; return; }
    const d = defOf(S, g);
    if (el.dataset.uid !== String(g.uid)) {
      el.innerHTML = `<div class="gcard">${cardSVG(d)}</div><div class="gcount"></div>`;
      el.dataset.uid = g.uid;
    }
    el.querySelector('.gcount').textContent = `${g.units.length}/${TIER_CAP[d.tier]} out`;
  });

  $(`#piles${p}`).innerHTML = `
    <span title="cards in deck">Deck <b>${pl.deck.length}</b></span>
    <span title="cards in discard — click to see" class="discard" data-p="${p}">Discard <b>${pl.discard.length}</b></span>
    <span>Hand <b>${pl.hand.length}</b></span>
    ${pl.foundThisMatch.length ? `<span class="green">Learned <b>${pl.foundThisMatch.length}</b></span>` : ''}`;
}

/* ================================================================ sigil board */

const RUNE_INK = { SPIRAL: '#c98bff', SHARD: '#ff6a52', WHEEL: '#52b6ff', LATTICE: '#5ee68f', WILD: '#e8dcc0' };

/* Your scratch board: what you have laid out of your pouch and not yet bound.
   HUD-only -- the engine sees a layout only when you press Bind, and nothing
   stays on the board between turns. `picked` is the chip you are laying with. */
const scratch = Array(BOARD_CELLS).fill(null);
let picked = null;

/** The runes laid on the scratch, as the engine's bind action wants them. */
const scratchCells = () => scratch.map((r, idx) => (r ? { idx, r } : null)).filter(Boolean);
/** How many of `r` the pouch still holds beyond what the scratch has laid. */
function available(r) {
  if (HUMAN === null || !S) return 0;
  let laid = 0;
  for (const x of scratch) if (x === r) laid++;
  return Math.max(0, (S.players[HUMAN].runes?.[r] || 0) - laid);
}
/** Is a bind yours to make right now (whatever is laid)? */
const canBindNow = () => humanToMove() && !S.bindUsed && (S.phase === 'unit' || (S.phase === 'spell' && !S.spellActionUsed));

/** The runes column's markup: a head, the pouch chips, the 4 x 4 scratch board, Bind/Clear, a hint. Built once a seat. */
function buildSigils(p) {
  const host = $(`#sigils${p}`);
  if (!host) return;
  host.innerHTML = `<div class="sighead">Runes</div>
    <div class="sigpouch">${RUNES.map((r) => `<button type="button" class="chip" data-r="${r}" title="${RUNE_NAME[r]}">${runeGlyphInline(r, RUNE_INK[r])}<b>0</b></button>`).join('')}</div>
    <div class="sigboard">${Array.from({ length: BOARD_CELLS }, (_, i) => `<div class="sigcell" data-idx="${i}" title="row ${Math.floor(i / BOARD_W) + 1}, column ${(i % BOARD_W) + 1}"></div>`).join('')}</div>
    <div class="sigbtns"><button type="button" id="bind${p}" class="primary" disabled>Bind</button><button type="button" class="ghost clear">Clear</button></div>
    <div class="sighint"></div>`;
  host.querySelectorAll('.chip').forEach((el) => el.addEventListener('click', () => onChipClick(p, el.dataset.r)));
  host.querySelectorAll('.sigcell').forEach((el, i) => el.addEventListener('click', () => onSigilCell(p, i)));
  host.querySelector(`#bind${p}`).addEventListener('click', () => onBind(p));
  host.querySelector('.clear').addEventListener('click', () => { if (p !== HUMAN) return; clearScratch(); });
}

function renderSigils(p) {
  const host = $(`#sigils${p}`);
  if (!host || !S) return;
  const mine = p === HUMAN;
  const pouch = S.players[p].runes || {};
  let total = 0;
  host.querySelectorAll('.chip').forEach((el) => {
    const r = el.dataset.r;
    const n = mine ? available(r) : (pouch[r] || 0);
    total += pouch[r] || 0;
    el.querySelector('b').textContent = n;
    el.classList.toggle('picked', mine && picked === r);
    el.classList.toggle('empty', n <= 0);
    el.disabled = !mine || n <= 0;
  });
  host.querySelectorAll('.sigcell').forEach((el, i) => {
    const r = mine ? scratch[i] : null;
    if (el.dataset.r !== (r || '')) { el.innerHTML = r ? runeGlyphInline(r, RUNE_INK[r]) : ''; el.dataset.r = r || ''; }
    el.classList.toggle('set', !!r);
    el.classList.toggle('open', mine && !r && !!picked);
  });
  const cells = mine ? scratchCells() : [];
  const err = mine && cells.length ? bindError(S, p, cells) : null;
  const legal = mine && cells.length > 0 && !err && canBindNow();
  host.querySelector(`#bind${p}`).disabled = !legal;
  host.querySelector('.clear').disabled = !mine || !cells.length;
  let hint = '';
  if (!mine) hint = HUMAN === null ? 'Watching' : '';
  else if (S.winner !== null) hint = 'The duel is over';
  else if (S.active !== HUMAN) hint = 'Not your turn';
  else if (S.bindUsed) hint = 'Bound this turn';
  else if (S.phase === 'spell' && S.spellActionUsed) hint = 'Your action is spent — bind next turn';
  else if (!total) hint = 'No runes yet — resolving faces earns them';
  else if (err) hint = err.charAt(0).toUpperCase() + err.slice(1);
  else hint = 'Lay runes from your pouch, then Bind — once a turn';
  host.querySelector('.sighint').textContent = hint;
}

/** Pick a chip to lay with; the picked chip again puts it down. */
function onChipClick(p, r) {
  if (p !== HUMAN || !S) return;
  if (picked === r) picked = null;
  else if (available(r) > 0) picked = r;
  else return;
  renderSigils(p);
}

/** Lay the picked rune, take a laid one back, or swap it for the picked one. */
function onSigilCell(p, i) {
  if (p !== HUMAN || !S) return;
  const cur = scratch[i];
  if (cur && (!picked || picked === cur)) scratch[i] = null;
  else if (picked && available(picked) > 0) { scratch[i] = picked; if (available(picked) <= 0) picked = null; }
  else return;
  renderSigils(p);
}

function onBind(p) {
  if (p !== HUMAN || !S) return;
  const cells = scratchCells();
  if (!cells.length || !canBindNow() || bindError(S, p, cells)) return;
  // The scratch stays laid: the bind's cue flashes the hits and then empties it.
  act({ type: 'bind', cells });
}

function clearScratch() {
  scratch.fill(null); picked = null;
  if (HUMAN !== null) renderSigils(HUMAN);
}

/** The gold flash of bound cells; the runes stay visible under it. */
function flashSigil(cells) {
  if (HUMAN === null) return;
  for (const i of cells) {
    const el = document.querySelector(`#sigils${HUMAN} .sigcell[data-idx="${i}"]`);
    if (!el) continue;
    el.classList.remove('flash-sigil'); void el.offsetWidth; el.classList.add('flash-sigil');
  }
}

function shakeBoard() {
  const el = HUMAN === null ? null : document.querySelector(`#sigils${HUMAN} .sigboard`);
  if (!el) return;
  el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
}

/** A rune earned: its chip flares once. */
function flashChip(p, rune) {
  const el = document.querySelector(`#sigils${p} .chip[data-r="${rune}"]`);
  if (!el) return;
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

/* ================================================================ hand */

function renderHand() {
  const el = $('#hand');
  const p = HUMAN ?? 0;
  const pl = S.players[p];
  const la = myActions();
  const playable = new Set(la.filter((a) => a.type === 'play').map((a) => a.uid));
  const ask = humanToAnswer() && S.pending.request.kind === 'hand' ? S.pending.request : null;
  el.innerHTML = '';
  // Cards keep their size; when there are too many for the strip they fan
  // over one another instead of shrinking into something unreadable.
  const n = pl.hand.length;
  const size = el.clientHeight - 20;
  const avail = el.clientWidth - 32;
  const ov = n > 1 ? Math.min(8, (avail - n * size) / (n - 1)) : 8;
  el.style.setProperty('--ov', `${Math.max(-size * 0.55, ov)}px`);
  if (HUMAN === null) {
    el.innerHTML = `<div class="watching">Watching two AIs — <button id="takeover">play a new match yourself</button></div>`;
    $('#takeover').onclick = () => newMatch({});
    return;
  }
  pl.hand.forEach((c, i) => {
    const d = defOf(S, c);
    const div = document.createElement('div');
    div.className = 'hcard';
    div.style.setProperty('--i', i);
    div.style.setProperty('--n', pl.hand.length);
    if (playable.has(c.uid)) div.classList.add('playable');
    if (sel?.kind === 'hand' && sel.uid === c.uid) div.classList.add('selected');
    if (ask && ask.options.includes(c.uid)) div.classList.add('askable');
    if (someChosen.includes(c.uid)) div.classList.add('chosen');
    div.innerHTML = cardSVG(d) + (playable.has(c.uid) && S.phase === 'spell' ? '<span class="ptag">PLAY</span>' : '');
    div.addEventListener('mouseenter', () => inspectDef(d, 0, null, c));
    div.addEventListener('mouseleave', hideInspector);
    div.addEventListener('click', () => onHandClick(c.uid));
    el.appendChild(div);
  });
  if (!pl.hand.length) el.innerHTML = '<div class="watching">Your hand is empty.</div>';
}

/* ================================================================ inspector */

let hideTimer = 0;
/**
 * The inspector shares the right column with the enemy table above it and
 * the tray and log below it. It is FITTED between them from measured
 * geometry, never from CSS guesses: on a short window the CSS top ran it
 * straight over the tray's buttons and the log (user: "a bunch of the text
 * boxes cover each other"). When the gap is too small to be useful it docks
 * beside the column instead, over the battlefield.
 */
function fitInspector() {
  const el = $('#inspector');
  const theirs = $('#theirs')?.getBoundingClientRect();
  const tray = $('#tray')?.getBoundingClientRect();
  const log = $('#logwrap')?.getBoundingClientRect();
  const hand = $('#hand')?.getBoundingClientRect();
  if (!theirs) return;
  const floorY = Math.min(tray && tray.height ? tray.top : Infinity, log && log.height ? log.top : Infinity,
    hand && hand.height ? hand.top : window.innerHeight) - 10;
  const top = theirs.bottom + 10;
  const room = floorY - top;
  if (room >= 240) {
    el.style.top = `${top}px`; el.style.right = ''; el.style.maxHeight = `${room}px`;
  } else {
    const side = Math.min(hand && hand.height ? hand.top : window.innerHeight, tray && tray.height && tray.left < theirs.left ? tray.top : Infinity) - 10;
    el.style.top = `${theirs.top}px`; el.style.right = `${window.innerWidth - theirs.left + 12}px`;
    el.style.maxHeight = `${Math.max(160, side - theirs.top)}px`;
  }
}
function showInspector() { clearTimeout(hideTimer); fitInspector(); $('#inspector').classList.add('show'); }
function hideInspector() { clearTimeout(hideTimer); hideTimer = setTimeout(() => $('#inspector').classList.remove('show'), 180); }

/* ------------------------------------------------------------ the peek */

/**
 * A right-clicked table card, drawn big in the middle of the screen exactly
 * as it sits on the table -- same frame, same turn, same runes, keywords
 * and quest pips -- so the small print can be read without leaning in (user:
 * "when you right click cards on your spell table they should also get
 * bigger"). An enemy's concealed trap shows its back. Any click, another
 * right-click or Esc puts it away.
 */
function peekSpell(sp) {
  const def = defOf(S, sp);
  if (sp.concealed && HUMAN !== null && sp.owner !== HUMAN) { peekMarkup(`<div class="card"><div class="cbody">${cardBackSVG()}</div></div>`); return; }
  if (def.kind === 'trap') { peekMarkup(`<div class="card"><div class="cbody">${cardSVG(def)}</div></div>`); return; }
  const kws = kwList(sp);
  const runes = [0, 1, 2, 3].map((pos) => runeAtCorner(S, sp, pos));
  const printed = [0, 1, 2, 3].map((pos) => def.runes[(pos + sp.rot) & 3]);
  const quests = questPips(sp, def);
  peekMarkup(`<div class="card"><div class="cbody" style="transform:rotate(${-90 * sp.rot}deg)">${cardSVG(def, { rot: 0, centre: false, lit: false })}</div>
    <div class="ccentre">${centreSVG(def, activeIndex(sp), { keywords: kws, runes, printed, quests })}</div></div>`);
}
function peekMarkup(html) {
  const el = $('#peek');
  el.innerHTML = html;
  el.hidden = false;
}
function closePeek() { const el = $('#peek'); if (el && !el.hidden) { el.hidden = true; el.innerHTML = ''; return true; } return false; }

function inspectSpell(sp) {
  const def = defOf(S, sp);
  if (sp.concealed && HUMAN !== null && sp.owner !== HUMAN) {
    // The enemy's trap: you may know a trap is there, not which.
    $('#inspector').innerHTML = `
      <div class="ibig">${cardBackSVG()}</div>
      <div class="ihead" style="color:${SCHOOL_INK.grey}">A concealed trap <small>face down · grey corner</small></div>
      <p>Set by your opponent. It springs on its own the first time you trigger it — a spell that would damage one of their units, a unit of yours walking up to theirs — and you read it as it goes off. Your "destroy an enemy Spell" effects can clear it unseen.</p>`;
    showInspector();
    return;
  }
  inspectDef(def, activeIndex(sp), kwList(sp), sp);
}

/**
 * `kws` are `{kw, own, from}` for a card on the table (its own Keywords in
 * gold, the resonating ones plain, with the card they come from), or plain
 * names for a card in the hand or the discard, which owns all it shows.
 */
function inspectDef(def, rot = 0, kws = null, card = null) {
  const keys = (kws || def.keywords || []).map((k) => (typeof k === 'string' ? { kw: k, own: true } : k));
  const kwHtml = keys.map((k) => `<div class="kwline"><span class="kw${k.own ? ' own' : ''}">[${esc(k.kw)}]</span> ${esc(KEYWORDS[k.kw]?.text || '')}${
    k.own ? '' : ` <i class="dim">— resonating${k.from !== null && k.from !== undefined ? ` from ${esc(cardName(k.from))}` : ' through this chain'}; it stays while the corners match</i>`}</div>`).join('');
  const school = def.kind === 'golem' ? 'golem' : def.school;
  let extra = '';
  if (card && card.cell !== undefined && card.cell !== null && card.owner !== undefined) {
    const depth = stackAt(S, card.owner, card.cell).length - 1;
    if (depth > 0) extra += `<div class="dim">${depth} card${depth > 1 ? 's' : ''} buried beneath.</div>`;
  }
  if (def.sigil) extra += `<div class="dim">Found by binding its sigil — lay its runes on your board.</div>`;
  $('#inspector').innerHTML = `
    <div class="ibig">${cardSVG(def, { rot, keywords: keys })}</div>
    <div class="ihead" style="color:${SCHOOL_INK[school]}">${esc(def.name)} <small>${def.kind === 'golem' ? `golem · tier ${def.tier}` : def.kind === 'artifact' ? 'artifact · grey corners' : def.kind === 'trap' ? 'trap · face down on a grey corner' : `${def.school} spell`}</small></div>
    <div class="faces">${faceListHTML(def, rot)}</div>
    ${kwHtml}${extra}`;
  showInspector();
}

function inspectUnit(u) {
  const d = u.kind === 'mage' ? null : CARDS[u.def];
  $('#inspector').innerHTML = `
    <div class="ihead ${pCls(u.owner)}">${esc(unitName(u.id))}</div>
    <div class="ustats">
      <div><b>${u.hp}</b>/${u.maxHp} hp</div><div>move <b>${(u.move / 1000).toFixed(1)}m</b></div>
      <div>strike <b>${u.atk}</b></div><div>reach <b>${(u.reach / 1000).toFixed(1)}m</b></div>
      <div>height <b>${(u.z / 1000).toFixed(2)}m</b></div>${u.poison ? `<div class="red">poison ${u.poison}</div>` : ''}
    </div>
    ${(u.keywords || []).map((k) => `<div class="kwline"><span class="kw">[${esc(k)}]</span> ${esc(KEYWORDS[k]?.text || '')}</div>`).join('')}
    ${d ? `<div class="dim">${esc(d.text)}</div>` : '<div class="dim">A mage is the range origin for most red spells. If slain, the killer scores 2 VP and it respawns at its circle.</div>'}`;
  showInspector();
}

function inspectProp(pr) {
  const spec = { boulder: 'A boulder. Can be climbed and stood on; whoever stands on it rides along when it is shoved.', pillar: 'A standing stone. Heavy; a quake can crack it.', shard: 'A crystal shard. Flies when pushed; lightning bursts it.', wall: 'A ruined wall. Can be stood on. Slides a little when shoved.', floater: 'A floating rock, held up by magic. Stand on it and ride it when it is shoved.', tree: 'A tree. It burns — and a burning tree bites everyone beside it at the start of every turn, then spreads.' }[pr.kind] || '';
  $('#inspector').innerHTML = `
    <div class="ihead">${esc(propName(pr.id))} <small>${pr.hp} hp${pr.burning !== null && pr.burning >= S.turn ? ' · <span class="red">burning</span>' : ''}</small></div>
    <div class="dim">${spec}</div>`;
  showInspector();
}

let hoverUnit = null;
function onArenaHover(hit) {
  const u = hit?.kind === 'unit' ? S.field.units.find((x) => x.id === hit.id) : null;
  const pr = hit?.kind === 'prop' ? S.field.props.find((x) => x.id === hit.id) : null;
  if (u) inspectUnit(u); else if (pr) inspectProp(pr); else if (hoverUnit !== null) hideInspector();
  hoverUnit = u ? u.id : pr ? pr.id : null;
  if (hit?.kind === 'ground' || (pr && hit.x !== undefined)) previewMove(hit.x, hit.y); else if (!u) arena.showGhost(null);
}

/* ================================================================ input */

function onHandClick(uid) {
  if (humanToAnswer()) { promptPick(uid); return; }
  if (!humanToMove()) return;
  const plays = myActions().filter((a) => a.type === 'play' && a.uid === uid);
  if (!plays.length) { toast(S.phase === 'spell' ? 'That card has nowhere to go right now.' : 'Cards are played in the spell phase.', ''); return; }
  sel = sel?.kind === 'hand' && sel.uid === uid ? null : { kind: 'hand', uid };
  render();
}

function onCellClick(p, c) {
  if (humanToAnswer()) {
    const r = S.pending.request;
    const sp = topOf(S, p, c);
    if (r.kind === 'target' && sp && r.options.includes(sp.uid)) return promptPick(sp.uid);
    if (r.show) {
      const i = r.show.findIndex((s) => s && s.cell === c && findSpell(S, s.uid)?.owner === p);
      if (i >= 0) return promptPick(r.options[i]);
    }
    return;
  }
  if (!humanToMove() || p !== HUMAN) { const sp = topOf(S, p, c); if (sp) inspectSpell(sp); return; }
  const la = myActions();
  if (sel?.kind === 'hand') {
    const a = la.find((x) => x.type === 'play' && x.uid === sel.uid && x.cell === c);
    if (a) return act(a);
  }
  if (sel?.kind === 'spell') {
    const a = la.find((x) => x.type === 'shift' && x.uid === sel.uid && x.cell === c);
    if (a) return act(a);
  }
  const sp = topOf(S, p, c);
  if (sp && la.some((x) => x.uid === sp.uid)) {
    sel = sel?.kind === 'spell' && sel.uid === sp.uid ? null : { kind: 'spell', uid: sp.uid };
  } else sel = null;
  render();
}

function onSlotClick(p, s) {
  if (!humanToMove() || p !== HUMAN) return;
  if (sel?.kind === 'hand') {
    const a = myActions().find((x) => x.type === 'play' && x.uid === sel.uid && x.slot === s);
    if (a) return act(a);
  }
}

function onPickUnit(id) {
  if (humanToAnswer()) {
    const r = S.pending.request;
    if ((r.kind === 'unit' || r.kind === 'body') && r.options.includes(id)) promptPick(id);
    return;
  }
  if (!humanToMove() || S.phase !== 'unit') return;
  const la = myActions();
  const strike = la.find((a) => a.type === 'unit' && a.act === 'strike' && a.target === id && (sel?.kind !== 'unit' || a.id === sel.id));
  if (strike) return act(strike);
  if (la.some((a) => a.type === 'unit' && a.id === id)) { sel = { kind: 'unit', id }; render(); }
}

function onPickProp(id, hit) {
  if (humanToAnswer()) {
    const r = S.pending.request;
    if ((r.kind === 'prop' || r.kind === 'body') && r.options.includes(id)) promptPick(id);
    return;
  }
  // A climbable rock is somewhere to stand: a click on it is a move there.
  if (hit && movingUnit()) onPickGround(hit.x, hit.y);
}

function movingUnit() {
  if (!humanToMove() || S.phase !== 'unit' || sel?.kind !== 'unit') return null;
  const u = S.field.units.find((x) => x.id === sel.id);
  return u && !u.dead && !u.acted ? u : null;
}

let lastPreview = 0, previewKey = '';
function previewMove(x, y) {
  const u = movingUnit();
  if (!u || !canMoveTo(S, u, x, y)) { arena.showGhost(null); return; }
  const now = performance.now();
  const key = `${Math.round(x / 50)},${Math.round(y / 50)}`;
  if (key === previewKey || now - lastPreview < 60) return;
  lastPreview = now; previewKey = key;
  const c = cloneState(S);
  try { apply(c, { type: 'unit', id: u.id, act: 'move', x, y }); } catch { arena.showGhost(null); return; }
  const v = c.field.units.find((k) => k.id === u.id);
  arena.showGhost(v ? { x: v.x, y: v.y, z: v.z } : null, u);
}

function onPickGround(x, y) {
  const u = movingUnit();
  if (!u) return;
  if (!canMoveTo(S, u, x, y)) { toast('Out of reach — click inside the blue circle.'); return; }
  act({ type: 'unit', id: u.id, act: 'move', x, y });
}

function onPickMarker(data) {
  if (!data) return;
  if (data.action) return act(data.action);
  if (data.answer !== undefined) return promptPick(data.answer);
}

/* ================================================================ prompts */

function optionLabel(r, o, i) {
  if (r.show?.[i] && r.show[i].x !== undefined) return `Spot ${i + 1}`;
  if (r.labels && r.labels[i] !== undefined && r.kind !== 'target' && !String(r.labels[i]).startsWith('junction')) return String(r.labels[i]);
  if (r.show?.[i]?.uids) return r.show[i].uids.map(cardName).join(' + ');
  if (r.kind === 'unit') return unitName(o);
  if (r.kind === 'prop') return propName(o);
  if (r.kind === 'body') return typeof o === 'number' ? unitName(o) : propName(o);
  if (r.kind === 'hand' || r.kind === 'target') {
    const sp = findSpell(S, o);
    if (sp && sp.cell !== null && sp.cell !== undefined) return `${cardName(o)} — ${sp.owner === HUMAN ? 'yours' : 'enemy'}, ${CELL_COLOR[sp.cell]} cell`;
    return cardName(o);
  }
  if (r.labels && r.labels[i] !== undefined) return String(r.labels[i]);
  return String(o);
}

function promptPick(v) {
  const r = S.pending?.request;
  if (!r) return;
  if (r.type === 'some') {
    if (!r.options.includes(v)) return;
    someChosen = someChosen.includes(v) ? someChosen.filter((x) => x !== v) : [...someChosen, v];
    if (r.exact && someChosen.length === r.count) { const out = someChosen; return answer(out); }
    render();
    return;
  }
  answer(v);
}

function renderPrompt() {
  const el = $('#prompt');
  if (!humanToAnswer()) { el.hidden = true; arena.endDrag(); return; }
  const r = S.pending.request;
  el.hidden = false;
  let html = `<div class="ptitle">${esc(r.prompt || 'Choose')}</div>`;
  if (r.kind !== 'dir') arena.endDrag();
  if (r.kind === 'dir') {
    renderDirPrompt(el, r, html);
    return;
  }
  if (r.type === 'confirm') {
    html += `<div class="pbtns"><button data-v="yes" class="primary">Yes</button><button data-v="no">No</button></div>`;
  } else {
    if (r.match) html += `<div class="phint match">${esc(matchSentence(r.match))}</div>`;
    const hint = r.kind === 'unit' ? 'Click a glowing unit on the field, or pick below.'
      : r.kind === 'target' ? 'Click a glowing spell, or pick below.'
      : r.kind === 'hand' ? `Click ${r.count > 1 ? `${r.count} cards` : 'a card'} in your hand, or pick below.`
      : r.kind === 'prop' ? 'Click a marked terrain piece, or pick below.'
      : r.kind === 'body' ? 'Click a glowing unit or a marked terrain piece, or pick below.'
      : r.show?.[0] && r.show[0].x !== undefined ? 'Click a marker on the field, or pick below.' : '';
    if (hint) html += `<div class="phint">${hint}</div>`;
    html += '<div class="pbtns">';
    r.options.forEach((o, i) => {
      html += `<button data-i="${i}" class="${someChosen.includes(o) ? 'chosen' : ''}">${esc(optionLabel(r, o, i))}</button>`;
    });
    if (r.allowNone) html += `<button data-v="none" class="ghost">Decline</button>`;
    if (r.type === 'some' && !r.exact) html += `<button data-v="done">Done (${someChosen.length})</button>`;
    html += '</div>';
  }
  el.innerHTML = html;
  el.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.v === 'yes') return answer(true);
      if (b.dataset.v === 'no') return answer(false);
      if (b.dataset.v === 'none') return answer(null);
      if (b.dataset.v === 'done') return answer(someChosen);
      promptPick(r.options[Number(b.dataset.i)]);
    };
    const i = b.dataset.i;
    if (i !== undefined && r.show?.[i]?.uids) {
      b.onmouseenter = () => r.show[i].uids.forEach((u) => markCell(u, 'hint'));
      b.onmouseleave = () => document.querySelectorAll('.cell.hint').forEach((c) => c.classList.remove('hint'));
    }
  });
}

/**
 * The drag-to-push question. The battlefield takes the drag itself
 * (arena.beginDrag); the panel explains it and offers the eight compass
 * bearings for anyone who would rather click, the engine's `preferred`
 * ones (away from the caster) first. Each button carries an arrow showing
 * where that bearing points ON THIS PLAYER'S SCREEN, read off the camera,
 * because a compass letter alone says nothing about which way is which.
 */
const SCREEN_ARROWS = ['→', '↗', '↑', '↖', '←', '↙', '↓', '↘'];
function screenArrow(d) {
  const a = arena.screenAngle(d);
  return SCREEN_ARROWS[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
}
function renderDirPrompt(el, r, html) {
  const label = (d) => { const i = r.options.indexOf(d); return i >= 0 && r.labels?.[i] !== undefined ? String(r.labels[i]) : String(d); };
  const answerDir = (d) => {
    if (r.options.includes(d)) return answer(d);
    // Off the menu: the nearest bearing that is on it.
    let best = r.options[0], bd = 64;
    for (const o of r.options) { const k = Math.abs(((o - d + 32) & 63) - 32); if (k < bd) { bd = k; best = o; } }
    answer(best);
  };
  const preferred = (r.preferred || []).filter((d) => r.options.includes(d));
  const compass = [0, 8, 16, 24, 32, 40, 48, 56].filter((d) => r.options.includes(d) && !preferred.includes(d));
  html += `<div class="phint drag">Drag on the battlefield from the ringed target in the direction to push (force ${esc(r.force)}), or pick a bearing below.</div>`;
  html += '<div class="pbtns compass">';
  for (const d of preferred) html += `<button data-d="${d}" class="primary"><i>${screenArrow(d)}</i> ${esc(label(d))} <small>away from your mage</small></button>`;
  for (const d of compass) html += `<button data-d="${d}"><i>${screenArrow(d)}</i> ${esc(label(d))}</button>`;
  html += '</div>';
  el.innerHTML = html;
  el.querySelectorAll('button[data-d]').forEach((b) => { b.onclick = () => answerDir(Number(b.dataset.d)); });
  if (r.target) arena.beginDrag({ body: r.target.body, id: r.target.id, force: r.force }, answerDir);
}

/** "Ember Lash and Shove meet at a corner, both showing the Wheel rune." */
const RUNE_NAME = { SPIRAL: 'Spiral', SHARD: 'Shard', WHEEL: 'Wheel', LATTICE: 'Lattice', WILD: 'wild' };
const CORNER_NAME = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
function matchSentence(m) {
  const me = cardName(m.uid);
  const parts = m.sites.map((site) => {
    const mine = site.corners.find((c) => c.uid === m.uid);
    const theirs = site.corners.find((c) => c.uid !== m.uid);
    if (!mine || !theirs) return null;
    const rune = mine.rune !== 'WILD' ? mine.rune : theirs.rune;
    return `${cardName(theirs.uid)} (its ${CORNER_NAME[theirs.pos]} corner against this card's ${CORNER_NAME[mine.pos]}, ${rune === 'WILD' ? 'wild' : RUNE_NAME[rune]})`;
  }).filter(Boolean);
  const names = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `${me} matches ${names}. Each neighbour will turn and resolve in the order you choose; the matched corners are ringed in gold.`;
}

function markCell(uid, cls) {
  const sp = findSpell(S, uid);
  if (!sp || sp.cell === null || sp.cell === undefined) return;
  document.querySelector(`#table${sp.owner} .cell[data-cell="${sp.cell}"]`)?.classList.add(cls);
}

/* ================================================================ the flow strip */

function renderFlow() {
  const el = $('#flow');
  if (S.winner !== null) { el.innerHTML = `<span class="turnno">Turn <b>${S.turn}</b></span><span class="step now"><i></i><span>Match over</span></span>`; return; }
  const mine = S.active === HUMAN;
  if (!mine) {
    el.innerHTML = `<span class="turnno">Turn <b>${S.turn}</b></span><span class="step enemy"><i></i><span>${HUMAN === null ? `Player ${S.active + 1}` : FOE()}'s turn — ${S.phase === 'spell' ? 'spell action' : 'units'}</span></span>`;
    return;
  }
  const steps = [
    { k: 'draw', label: 'Draw', state: 'done' },
    { k: 'unit', label: 'Units', state: S.phase === 'unit' ? 'now' : 'done' },
    { k: 'spell', label: 'Spell action', state: S.phase === 'spell' ? 'now' : '' },
    { k: 'end', label: 'End turn', state: '' },
  ];
  el.innerHTML = `<span class="turnno">Turn <b>${S.turn}</b></span>` + steps.map((s, i) => `${i ? '<span class="arrow">▸</span>' : ''}<span class="step ${s.state}"><i></i><span>${s.label}</span></span>`).join('');
}

/* ================================================================ the tray */

function renderTray() {
  const el = $('#tray');
  if (HUMAN === null || S.winner !== null) { el.innerHTML = ''; return; }
  if (S.active !== HUMAN && !humanToAnswer()) {
    el.innerHTML = `<div class="thinking"><span class="dots"><i></i><i></i><i></i></span> The enemy is ${S.pending ? 'choosing' : 'thinking'}…</div>`;
    return;
  }
  if (humanToAnswer()) { el.innerHTML = ''; return; }
  const la = myActions();
  let html = '';
  if (S.phase === 'spell') {
    if (sel?.kind === 'hand') {
      const plays = la.filter((a) => a.type === 'play' && a.uid === sel.uid);
      const hc = S.players[HUMAN].hand.find((c) => c.uid === sel.uid);
      const hd = hc && defOf(S, hc);
      const first = hd && hd.kind !== 'golem' ? hd.faces[0] : null;
      html += `<div class="hintline">Click a glowing ${plays[0]?.slot !== undefined ? 'golem slot' : 'cell'} to play <b>${esc(cardName(sel.uid))}</b>${first ? ` — it resolves <b>${first.numeral}</b> as it lands: ${esc(first.text)}` : ''}.</div>`;
      html += `<div class="units">${plays.length === 1 ? '<button data-a="play1" class="primary">Play it there</button>' : ''}<button data-a="cancel" class="ghost">Cancel</button></div>`;
    } else if (sel?.kind !== 'spell') {
      html += `<div class="hintline"><b>Spell action</b>: play a card from your hand, or click one of your spells to rotate, shift or destroy it.</div>`;
      if (la.some((a) => a.type === 'pass')) html += `<div class="units"><button data-a="skip" class="ghost" title="Take no spell action and end your turn">Skip spell action, end turn ▸</button></div>`;
    }
  } else if (S.phase === 'unit') {
    const mine = S.field.units.filter((u) => u.owner === HUMAN && !u.dead);
    const ready = mine.filter((u) => la.some((a) => a.type === 'unit' && a.id === u.id));
    if (sel?.kind !== 'unit' || !ready.some((u) => u.id === sel.id)) sel = ready[0] ? { kind: 'unit', id: ready[0].id } : null;
    const canMove = sel && la.some((x) => x.type === 'unit' && x.id === sel.id && x.act === 'move');
    html += `<div class="hintline"><b>Units</b>: ${canMove ? 'click inside the blue circle to walk' : 'the selected unit cannot move from here'}, or click a red-ringed enemy to strike it. ${ready.length} to go.</div>`;
    html += '<div class="units">';
    for (const u of ready) html += `<button data-unit="${u.id}" class="${sel?.id === u.id ? 'on' : ''}">${esc(unitName(u.id))}</button>`;
    if (sel) {
      const strikes = la.filter((x) => x.type === 'unit' && x.id === sel.id && x.act === 'strike');
      const summons = la.filter((x) => x.type === 'unit' && x.id === sel.id && x.act === 'summon');
      for (const a of strikes) html += `<button data-strike="${a.target}" class="danger">⚔ Strike ${esc(unitName(a.target))}</button>`;
      for (const a of summons) html += `<button data-summon="${a.golem}" class="primary" title="Spends the mage's action">✦ Summon ${esc(cardName(a.golem))}</button>`;
      html += `<button data-a="pass" class="ghost">Hold position</button>`;
    }
    html += `<button data-a="endturn" class="end">Done moving ▸</button></div>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      const la2 = myActions();
      const A = b.dataset.a;
      if (A === 'skip') return act(la2.find((a) => a.type === 'pass'));
      if (A === 'play1') return act(la2.find((a) => a.type === 'play' && a.uid === sel.uid));
      if (A === 'cancel') { sel = null; return render(); }
      if (A === 'endturn') return endTurn();
      if (A === 'pass') return act(la2.find((a) => a.type === 'unit' && a.id === sel.id && a.act === 'pass'));
      if (b.dataset.summon) return act(la2.find((a) => a.type === 'unit' && a.id === sel.id && a.act === 'summon' && String(a.golem) === b.dataset.summon));
      if (b.dataset.strike) return act(la2.find((a) => a.type === 'unit' && a.id === sel.id && a.act === 'strike' && String(a.target) === b.dataset.strike));
      if (b.dataset.unit) { sel = { kind: 'unit', id: Number(b.dataset.unit) }; return render(); }
    };
  });
}

/* ================================================================ the popover */

// A control sits next to the thing it acts on: a selected spell gets its
// actions beside its cell. Units get NO popover -- a box floating over the
// battlefield hid the very thing it was about -- their actions sit in the tray.
function renderPopover() {
  const el = $('#popover');
  if (!humanToMove()) { el.hidden = true; return; }
  const la = myActions();
  if (sel?.kind === 'spell') {
    const sp = findSpell(S, sel.uid);
    if (!sp) { el.hidden = true; return; }
    const def = defOf(S, sp);
    const rot = la.find((a) => a.type === 'rotate' && a.uid === sel.uid);
    const des = la.find((a) => a.type === 'destroy' && a.uid === sel.uid);
    const shifts = la.filter((a) => a.type === 'shift' && a.uid === sel.uid);
    const cur = def.faces[activeIndex(sp)];
    let html = `<div class="ptitle" style="color:${SCHOOL_INK[def.school]}">${esc(def.name)}</div><div class="psub">Showing <b>${cur.numeral}</b> — ${esc(cur.text)}</div><div class="acts">`;
    if (rot) {
      const next = def.faces[(activeIndex(sp) + 1) & 3];
      const r = reachOf(sp, (activeIndex(sp) + 1) & 3);
      html += `<button data-a="rotate" class="primary">↺ Rotate to <b>${next.numeral}</b> and resolve it<span class="sub">${esc(next.text)}${r ? ` · reach ${(r.mm / 1000).toFixed(1)}m, ${r.targets.length} enem${r.targets.length === 1 ? 'y' : 'ies'} in range` : ''}${next.cost?.length ? ' · has a cost' : ''}</span></button>`;
    } else html += `<div class="psub">Cannot be rotated by you right now${CELL_COLOR[sp.cell] !== def.school && def.kind !== 'artifact' ? ' — it is off its colour' : ''}.</div>`;
    if (shifts.length) html += `<div class="psub">⇄ Shift: click a glowing cell to move it there.</div>`;
    html += '<div class="row">';
    if (des) html += `<button data-a="destroy" class="danger">✕ Destroy</button>`;
    html += `<button data-a="cancel" class="ghost">Cancel</button></div></div>`;
    el.innerHTML = html;
    el.className = '';
    el.hidden = false;
    const cell = document.querySelector(`#table${HUMAN} .cell[data-cell="${sp.cell}"]`);
    const b = cell.getBoundingClientRect();
    el.style.left = `${b.right + 14}px`;
    el.style.top = `${Math.max(66, Math.min(window.innerHeight - el.offsetHeight - 12, b.top - 14))}px`;
  } else { el.hidden = true; return; }
  el.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      const la2 = myActions();
      const A = b.dataset.a;
      if (A === 'rotate') return act(la2.find((a) => a.type === 'rotate' && a.uid === sel.uid));
      if (A === 'destroy') return act(la2.find((a) => a.type === 'destroy' && a.uid === sel.uid));
      if (A === 'cancel') { sel = null; return render(); }
    };
  });
}

/** Hold every unit that has not acted. Each pass is a real engine action. */
async function endTurn() {
  if (!humanToMove() || S.phase !== 'unit') return;
  for (let guard = 0; guard < 20 && humanToMove() && S.phase === 'unit'; guard++) {
    const a = legalActions(S).find((x) => x.type === 'unit' && x.act === 'pass');
    if (!a) break;
    apply(S, a);
    netSend({ act: a });
    flushFx();
  }
  sel = null;
  render();
  drive();
}

/* ================================================================ highlights */

function renderHighlights() {
  document.querySelectorAll('.cell.target, .cell.selected, .cell.askable, .cell.hint, .gslot.target').forEach((e) => e.classList.remove('target', 'selected', 'askable', 'hint'));
  arena.clearMarkers();
  arena.highlightUnits({});
  arena.setMoveCircle(null);
  arena.setRanges(rangePreview());
  if (S.winner !== null) return;

  if (humanToAnswer()) {
    const r = S.pending.request;
    if (r.kind === 'target') r.options.forEach((u) => markCell(u, 'askable'));
    if (r.kind === 'unit' || r.kind === 'body') {
      arena.highlightUnits(Object.fromEntries(r.options.filter((id) => typeof id === 'number').map((id) => [id, 0xffe066])));
    }
    if (r.show) {
      const pts = [];
      r.show.forEach((s, i) => {
        if (!s) return;
        // No numbers on the field: the discs ARE the choices. The buttons
        // below carry the words for anyone who wants them.
        if (s.x !== undefined) pts.push({ x: s.x, y: s.y, z: s.z ?? 0, label: null, data: { answer: r.options[i] } });
        if (s.cell !== undefined) {
          const owner = findSpell(S, s.uid)?.owner ?? HUMAN;
          document.querySelector(`#table${owner} .cell[data-cell="${s.cell}"]`)?.classList.add('askable');
        }
        if (s.uids) s.uids.forEach((u) => markCell(u, 'hint'));
      });
      if (pts.length) arena.setMarkers(pts, 0xffe066);
    }
    if (r.kind === 'prop' || r.kind === 'body') {
      const pts = r.options.filter((id) => typeof id === 'string').map((id) => S.field.props.find((p) => p.id === id)).filter(Boolean)
        .map((pr) => ({ x: pr.x, y: pr.y, z: pr.z, label: propName(pr.id), data: { answer: pr.id } }));
      arena.setMarkers(pts, 0xffe066);
    }
    return;
  }
  if (!humanToMove()) return;
  const la = myActions();
  if (sel?.kind === 'hand') {
    for (const a of la.filter((x) => x.type === 'play' && x.uid === sel.uid)) {
      if (a.cell !== undefined) document.querySelector(`#table${HUMAN} .cell[data-cell="${a.cell}"]`)?.classList.add('target');
      if (a.slot !== undefined) document.querySelector(`#golems${HUMAN} .gslot[data-slot="${a.slot}"]`)?.classList.add('target');
    }
  }
  if (sel?.kind === 'spell') {
    markCell(sel.uid, 'selected');
    const sp = findSpell(S, sel.uid);
    const r = sp && reachOf(sp, (activeIndex(sp) + 1) & 3);
    if (r) arena.highlightUnits(Object.fromEntries(r.targets.map((id) => [id, 0xffa030])));
    for (const a of la.filter((x) => x.type === 'shift' && x.uid === sel.uid)) {
      document.querySelector(`#table${HUMAN} .cell[data-cell="${a.cell}"]`)?.classList.add('target');
    }
  }
  if (S.phase === 'unit' && sel?.kind === 'unit') {
    const u = S.field.units.find((x) => x.id === sel.id);
    if (u && la.some((a) => a.type === 'unit' && a.id === u.id && a.act === 'move')) {
      arena.setMoveCircle({ x: u.x, y: u.y, r: moveBudget(S, u), shape: moveReach(S, u) });
    }
    const hl = { [sel.id]: 0xffffff };
    for (const a of la.filter((x) => x.type === 'unit' && x.id === sel.id && x.act === 'strike')) hl[a.target] = 0xff3030;
    arena.highlightUnits(hl);
  }
}

/* ================================================================ range */

function reachOf(sp, index) {
  const def = defOf(S, sp);
  const face = def.faces[index];
  if (!face || face.reach === undefined) return null;
  const ctx = makeCtx(S, sp, def, face);
  const r = ctx.range(face.reach);
  return { mm: r.mm, numeral: face.numeral, targets: ctx.enemyUnits(face.reach) };
}

let hoverSpell = null;
function rangePreview() {
  const out = [];
  const add = (sp, index, colour, when) => {
    const r = reachOf(sp, index);
    if (!r) return;
    rangeOrigins(S, sp.owner).forEach((o, i) => {
      out.push({ x: o.x, y: o.y, r: r.mm, colour, label: i ? null : `${defOf(S, sp).name} ${r.numeral} · ${(r.mm / 1000).toFixed(1)}m ${when}` });
    });
  };
  const selSp = sel?.kind === 'spell' ? findSpell(S, sel.uid) : null;
  if (selSp) add(selSp, (activeIndex(selSp) + 1) & 3, 0xffcf5a, 'if rotated');
  else if (hoverSpell) {
    const sp = findSpell(S, hoverSpell);
    if (sp && sp.cell !== null && sp.cell !== undefined) {
      add(sp, activeIndex(sp), 0xc3cad6, 'now');
      if (sp.owner === HUMAN) add(sp, (activeIndex(sp) + 1) & 3, 0xffcf5a, 'if rotated');
    }
  }
  return out;
}

/* ================================================================ top bar */

function renderTop() {
  const vp = (p) => {
    const pct = Math.min(100, (S.vp[p] / 15) * 100);
    return `<div class="vp ${pCls(p)}"><span class="vpn">${pName(p)}</span><div class="vpbar"><i style="width:${pct}%"></i>${Array.from({ length: 14 }, (_, k) => `<s style="left:${((k + 1) / 15) * 100}%"></s>`).join('')}</div><b>${S.vp[p]}</b></div>`;
  };
  $('#vps').innerHTML = vp(0) + vp(1);
  for (const p of [0, 1]) {
    const m = S.field.units.find((u) => u.owner === p && u.kind === 'mage');
    const dead = !m || m.dead;
    $(`#mage${p}`).innerHTML = dead ? `<span class="red">mage slain — returns turn ${S.players[p].mage.respawnOnTurn ?? '?'}</span>` : '';
  }
  renderFlow();
}

/* ================================================================ viewport */

/** The clear part of the screen, so the camera frames the arena there. */
function updateViewport() {
  if (!arena) return;
  const hud = $('#hud');
  if (hud.classList.contains('hidden')) { arena.setViewport({ left: 0, top: 58, width: window.innerWidth, height: window.innerHeight - 58 }); return; }
  const mine = $('#mine').getBoundingClientRect();
  const theirs = $('#theirs').getBoundingClientRect();
  const hand = $('#hand').getBoundingClientRect();
  const left = window.innerWidth > 820 ? mine.right + 8 : 0;
  const right = window.innerWidth > 820 ? theirs.left - 8 : window.innerWidth;
  const top = 58, bottom = hand.top - 4;
  arena.setViewport({ left, top, width: Math.max(240, right - left), height: Math.max(200, bottom - top) });
}

/* ================================================================ render */

function render() {
  if (!S) return;
  renderTop();
  renderTable(0);
  renderTable(1);
  renderBonds(0);
  renderBonds(1);
  renderHand();
  renderSigils(0);
  renderSigils(1);
  renderPrompt();
  renderTray();
  arena.sync(S);
  renderHighlights();
  renderPopover();
  pendingFlash = new Map();
  window.WG.state = S;
}

/* ================================================================ end */

function endMatch() {
  if (matchOver) return;
  matchOver = true;
  let learned = 0;
  if (HUMAN !== null) learned = profile.recordMatch(S, HUMAN);
  const prof = profile.load();
  const won = S.winner === HUMAN;
  const title = S.winner === -1 ? 'A draw' : HUMAN === null ? `Player ${S.winner + 1} wins` : won ? 'Victory' : 'Defeat';
  setTimeout(() => modal(`<h2 class="${won ? 'gold' : ''}">${title}</h2>
    <p class="big">${S.vp[0]} – ${S.vp[1]} <small>after ${S.turn} turns · ${esc(S.reason || '')}</small></p>
    ${HUMAN !== null ? `<p>${learned ? `<b class="green">${learned} new sigil${learned > 1 ? 's' : ''}</b> written into your Spellbook.` : 'Nothing new for the Spellbook this time — binding runes on your board is how spells are found.'}<br>
      Spellbook: ${Object.keys(prof.learned).length}/${spellbookPage(Object.values(CARDS), prof.learned).length} sigils known · ${prof.matches} duel${prof.matches === 1 ? '' : 's'} · ${prof.wins} won</p>` : ''}
    ${ledgerTable()}
    <div class="mbtns"><button id="again" class="primary">New duel</button><button id="sb">Open Spellbook</button><button id="close" class="ghost">Look at the battlefield</button></div>`), FAST ? 0 : 1800);
  const hook = () => {
    const again = $('#again'); if (!again) { setTimeout(hook, 100); return; }
    again.onclick = () => {
      closeModal();
      if (NET) { if (NET.isHost) startOnline(Math.floor(Math.random() * 1e6), params.has('pool')); else toast('The host starts the next duel.', ''); return; }
      newMatch({ pool: params.has('pool'), policy: POLICY, watch: HUMAN === null });
    };
    $('#sb').onclick = openSpellbook;
    $('#close').onclick = closeModal;
  };
  setTimeout(hook, FAST ? 10 : 1850);
}

function ledgerTable() {
  const row = (label, f) => `<tr><td>${label}</td><td>${f(0)}</td><td>${f(1)}</td></tr>`;
  const L = (p) => S.players[p].ledger;
  return `<table class="ledger"><tr><th></th><th class="p0">${pName(0)}</th><th class="p1">${pName(1)}</th></tr>
    ${row('VP from objectives', (p) => L(p).vpFromObjectives)}
    ${row('VP from kills', (p) => L(p).vpFromKills)}
    ${row('Chains (longest)', (p) => `${L(p).chainsResolved} (${L(p).longestChain})`)}
    ${row('Rotations', (p) => L(p).rotations)}
    ${row('Spells lost', (p) => L(p).spellsDestroyed)}
    ${row('Damage dealt', (p) => L(p).damageDealt)}
    ${row('Terrain broken', (p) => L(p).propsBroken)}
    ${row('Fires lit', (p) => L(p).firesLit)}
    ${row('Cards learned', (p) => L(p).cardsFound)}</table>`;
}

/* ================================================================ modals */

function modal(html) {
  const m = $('#modal');
  m.innerHTML = `<div class="mbox">${html}</div>`;
  m.hidden = false;
  m.onclick = (e) => { if (e.target === m) closeModal(); };
}
function closeModal() { $('#modal').hidden = true; }

/** A sigil drawn small: its bounding box of cells, runes in the card's ink. */
function sigilMiniHTML(cells, ink) {
  const w = Math.max(...cells.map((c) => c.x)) + 1, h = Math.max(...cells.map((c) => c.y)) + 1;
  const at = new Map(cells.map((c) => [`${c.x},${c.y}`, c.r]));
  let out = `<div class="sgrid" style="grid-template-columns:repeat(${w},15px)">`;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const r = at.get(`${x},${y}`);
    out += r ? `<i>${runeGlyphInline(r, ink)}</i>` : '<i class="e"></i>';
  }
  return out + '</div>';
}

function openSpellbook() {
  const prof = profile.load();
  const page = spellbookPage(Object.values(CARDS), prof.learned);
  const known = page.filter((x) => x.known).length;
  const runeList = (x) => x.runes.map((r) => RUNE_NAME[r]).join(', ');
  modal(`<h2>The Spellbook</h2>
    <p class="dim">Spells are <b>found</b>, not earned. Every face you resolve earns a rune of its kind of work — Spiral for turning, Shard for breaking, Wheel for moving, Lattice for drawing — into your pouch. Once a turn, lay runes on your board and <b>Bind</b>: any card whose <b>sigil</b> you have laid, in any of its four turns, is found and its runes are spent; the rest go back to your pouch. The Spellbook remembers every shape you have made; for the rest it knows only which runes they take.</p>
    <p><b>${known}</b> of ${page.length} sigils known · ${prof.matches} duels · ${prof.wins} won</p>
    <div class="book sig">${page.map((x) => {
      if (!x.known) return `<div class="bk sg unknown"><span class="q">?</span><div><span class="bc">undiscovered</span><span class="bh">${x.size} runes: ${esc(runeList(x))}</span></div></div>`;
      const d = CARDS[x.id];
      const ink = SCHOOL_INK[d?.kind === 'golem' ? 'golem' : d?.school] || '#ccc';
      return `<div class="bk sg"><span class="sgbox">${sigilMiniHTML(x.sigil, ink)}</span><div><span class="bc" style="color:${ink}">${esc(x.name)}</span><span class="bh">${x.size} runes · ${d?.kind === 'golem' ? `golem, tier ${d.tier}` : d?.kind === 'artifact' ? 'artifact' : d?.kind === 'trap' ? 'trap' : `${d?.school} spell`}</span></div></div>`;
    }).join('')}</div>
    <div class="mbtns"><button id="close" class="primary">Close</button></div>`);
  $('#close').onclick = closeModal;
}

function openNewGame() {
  if (NET && !NET.isHost) { toast('The host starts duels in an online room. Leave the room to play the AI.', ''); return; }
  modal(`<h2>New duel${NET ? ` — room ${esc(NET.code)}` : ''}</h2>
    <label>Arena seed <input id="ng-seed" type="number" value="${Math.floor(Math.random() * 1e6)}"></label>
    <label>Opponent <select id="ng-ai"><option value="oneply">Adept (strongest)</option><option value="greedy">Apprentice</option><option value="random">Novice (random)</option></select></label>
    <label>Decks <select id="ng-deck"><option value="std">Standard ten-card deck</option><option value="pool">Random decks from all 60 cards</option></select></label>
    <label>Graphics <select id="ng-q"><option value="high">High (bloom, 4k shadows)</option><option value="medium">Medium</option><option value="low">Low (laptops)</option></select></label>
    <label class="row"><input id="ng-watch" type="checkbox"> Just watch two AIs</label>
    <div class="mbtns"><button id="ng-go" class="primary">Begin</button><button id="close" class="ghost">Cancel</button></div>`);
  if (NET) for (const id of ['ng-ai', 'ng-watch']) $('#' + id).closest('label').hidden = true;
  $('#ng-ai').value = POLICY;
  $('#ng-q').value = profile.setting('quality') || 'high';
  $('#ng-go').onclick = () => {
    const seed = Number($('#ng-seed').value) || 1;
    profile.setting('quality', $('#ng-q').value);
    closeModal();
    if (NET) { startOnline(seed, $('#ng-deck').value === 'pool'); return; }
    newMatch({ seed, policy: $('#ng-ai').value, pool: $('#ng-deck').value === 'pool', watch: $('#ng-watch').checked });
  };
  $('#close').onclick = closeModal;
}

function openRules() {
  const R = (r) => runeGlyphInline(r, '#e8dcc0');
  modal(`<h2>How to play</h2>
    <div class="rules">
    <p><b>Goal:</b> first to <b>15 VP</b>. Gold spells score by completing hard objectives (scoring sends the gold spell to your discard). Killing a mage is worth 2 VP; a golem, 1.</p>
    <p><b>Your turn</b> runs along the strip at the top: draw a card, take one <b>spell action</b>, then move your <b>units</b>, then end the turn.</p>
    <p><b>Spell actions</b> (pick one): play a card from your hand onto its colour · click one of your spells and <b>rotate</b> it — <b>its new top face resolves</b> · shift it to an adjacent cell · destroy it · or skip. Artifacts go on the grey corners; golem cards go in the slots beneath.</p>
    <p><b>The top face is active.</b> Cards land showing side I and resolve it as they are played; each left turn brings up the next face and resolves that. <b>Side IV is every card's payoff</b>; sides I–III build toward it, and most make you pay something to get there. Selecting a spell draws the range of the face it would turn to. You can only rotate a spell yourself while it sits on its own colour.</p>
    <p><b>Matches:</b> wherever two of your cards meet at a corner showing the <b>same rune</b>, they match. You must choose one of them; it rotates left and its new top face <b>resolves</b>. That can set off another match, and another — a chain. Each junction resonates once per chain, and a spell turns at most four times per action. A chain is mandatory, so it can hurt you.</p>
    <p class="runes">${R('SPIRAL')} Spiral — turning &amp; shifting &nbsp; ${R('SHARD')} Shard — destruction &amp; damage &nbsp; ${R('WHEEL')} Wheel — pushing &amp; terrain &nbsp; ${R('LATTICE')} Lattice — cards, keywords, scoring</p>
    <p><b>[Keywords]</b> resonate: on a match, each card's Keywords cross onto the other by themselves and stay there <b>as long as those corners match</b> — put [Ignore Height] on a push, [Poison] on a fireball. A card's own Keywords are printed in <span class="kw own">gold</span>; the ones resonating from a neighbour in <span class="kw">purple</span>, and they fade when the corners part.</p>
    <p><b>Units:</b> click a unit, then anywhere inside its blue circle to walk there; click a red-ringed enemy to strike; the mage can summon a golem beside itself. Mages have 5 life unless a passive raises it. Golem tiers cap how many are out at once: C three, B two, A one. A golem card that has deployed and then lost every unit is spent.</p>
    <p><b>Traps</b> are grey cards set <b>face down</b> into an empty grey corner. They have one side, no runes, never match and never turn. The first time its trigger is met on your <i>opponent's</i> turn — a spell about to hit your unit, an enemy walking up to your mage — the trap springs on its own: it is revealed, its reaction happens at once (an Earth Wall heaves up and takes the fireball instead of you), and it goes to your discard. Your opponent can see a trap is set, not which; their "destroy an enemy Spell" effects can clear it.</p>
    <p><b>Everything on the field can be affected.</b> Every rock, stone, crystal, wall and tree has weight and hit points: force spells throw them and crack them, fire lights the trees — and a burning tree bites everyone beside it each turn, then spreads. Climb walls, fall off ledges, shove rocks out from under people.</p>
    <p><b>Runes and sigils:</b> every face you resolve earns a rune of its kind of work into your <b>pouch</b> — Spiral for turning, Shard for breaking, Wheel for moving, Lattice for drawing. Once a turn, free, lay runes on your 4 × 4 board and <b>Bind</b>: every findable card has a <b>sigil</b>, a small shape of runes, and any sigil you have laid, in any of its four turns, is <b>found</b> — its runes are spent and the card goes to your discard for the rest of the duel. Whatever is not bound goes back to the pouch; nothing stays on the board.</p>
    <p><b>The Spellbook</b> remembers every sigil you have ever bound, across all your duels, and hints at which runes the rest take — the shape is yours to figure out.</p>
    <p class="dim">Camera: drag to orbit, wheel to zoom, right-drag to pan, <b>H</b> to go home. <b>Right-click</b> a table card to see it big. <b>Tab</b> hides the panels. <b>Esc</b> cancels.</p>
    </div>
    <div class="mbtns"><button id="close" class="primary">Got it</button></div>`);
  $('#close').onclick = closeModal;
}

function openDiscard(p) {
  const pl = S.players[p];
  modal(`<h2>${pName(p)} — discard (${pl.discard.length})</h2>
    <div class="pile">${pl.discard.map((c) => `<div class="pc">${cardSVG(defOf(S, c))}</div>`).join('') || '<p class="dim">Empty.</p>'}</div>
    <div class="mbtns"><button id="close" class="primary">Close</button></div>`);
  $('#close').onclick = closeModal;
}

/* ================================================================ boot */

window.WG = {
  state: null,
  act, answer, legal: () => legalActions(S),
  newMatch,
  hash: () => hashState(S),
  get net() { return NET ? { code: NET.code, isHost: NET.isHost, ready: NET.ready, seat: HUMAN } : null; },
  /** Test hook: let the AI make this seat's next decision through the real act/answer path. */
  auto(policy = 'greedy') {
    if (humanToAnswer()) { answer(answerFor(S, { policy })); return 'answer'; }
    if (humanToMove()) { const a = chooseAction(S, { policy }); if (a) { act(a); return 'act'; } }
    return null;
  },
  get busy() { return busy; },
  get arena() { return arena; },
  /** Test hook: play the trap-springing reveal on a cell (tools/lab/shoot-traps.mjs). */
  revealTrap, render,
};

function boot() {
  buildTable(0);
  buildTable(1);
  buildSigils(0);
  buildSigils(1);
  $('#btn-new').onclick = openNewGame;
  $('#btn-book').onclick = openSpellbook;
  $('#btn-rules').onclick = openRules;
  $('#btn-online').onclick = openOnline;
  $('#btn-log').onclick = () => { const w = $('#logwrap'); w.classList.toggle('collapsed'); $('#btn-log').textContent = w.classList.contains('collapsed') ? 'Expand' : 'Collapse'; $('#log').scrollTop = $('#log').scrollHeight; };
  $('#btn-hide').onclick = toggleHud;
  document.addEventListener('click', (e) => {
    const d = e.target.closest('.discard');
    if (d) openDiscard(Number(d.dataset.p));
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'Escape') { if (closePeek()) return; if (!$('#modal').hidden) closeModal(); else { sel = null; render(); } }
    if (e.key === 'Tab') { e.preventDefault(); toggleHud(); }
    if (e.key === 'h' || e.key === 'H') arena?.home();
    if (e.key === 'Enter' && humanToMove()) { if (S.phase === 'unit') endTurn(); else { const a = myActions().find((x) => x.type === 'pass'); if (a && !sel) act(a); } }
  });
  window.addEventListener('resize', () => { updateViewport(); render(); });
  $('#peek').addEventListener('click', closePeek);
  $('#peek').addEventListener('contextmenu', (e) => { e.preventDefault(); closePeek(); });
  const seed = params.has('seed') ? Number(params.get('seed')) : undefined;
  newMatch({ seed, watch: params.has('watch'), pool: params.has('pool'), policy: params.get('ai') || 'oneply' });
  if (params.has('room')) openOnline();
  else if (!params.has('seed') && !profile.seen('rules')) openRules();
}

function toggleHud() {
  const hud = $('#hud');
  hud.classList.toggle('hidden');
  $('#btn-hide').textContent = hud.classList.contains('hidden') ? 'Show HUD' : 'Hide HUD';
  updateViewport();
}

boot();
