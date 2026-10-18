// The view: the whole game, playable in a browser.
//
// It drives the engine exactly as tools/duel.js does -- legalActions, apply,
// choose -- so there is still no second copy of the rules anywhere. If the
// page offers a move, the engine generated it; if a card asks a question, this
// file only draws the question and hands the answer back.
//
// Everything the player SEES happening comes from `state.fx`, the engine's note
// stream, read after each step: the log, the floating damage, the flashing
// match. The board itself is redrawn from the state every time.

import { createGame, legalActions, apply, choose, cloneState } from '../engine.js';
import { chooseAction, answerFor } from '../ai/ai.js';
import { CARDS, randomDeck } from '../rules/spells/index.js';
import { defOf, topOf, stackAt, findSpell } from '../rules/ops.js';
import { CELL_COLOR } from '../rules/table.js';
import { activeIndex, NUMERALS } from '../rules/orient.js';
import { runeAtCorner } from '../rules/match.js';
import { keywordsOf, KEYWORDS } from '../rules/keywords.js';
import { TIER_CAP } from '../rules/golems.js';
import { FINDS, FIND_IDS, spellbookPage } from '../rules/learn.js';
import { seedRng, pick } from '../rules/rng.js';
import * as profile from '../profile.js';
import { makeCtx } from '../rules/resolve.js';
import { moveBudget, canMoveTo } from '../rules/units.js';
import { rangeOrigins } from '../field/query.js';
import { cardSVG, centreSVG, faceListHTML, SCHOOL_INK, runeGlyphInline } from './cards.js';
import { createArena } from './arena3d.js';

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

function newMatch({ seed = Math.floor(Math.random() * 1e6), watch = false, pool = false, policy = 'oneply' } = {}) {
  gameId++;
  const rng = seedRng(seed ^ 0xdeed);
  const decks = pool ? [randomDeck(rng, pick), randomDeck(rng, pick)] : null;
  S = createGame({ seed, decks });
  HUMAN = watch ? null : 0;
  POLICY = policy;
  fxSeen = 0; sel = null; someChosen = []; matchOver = false;
  angles.clear();
  for (const p of [0, 1]) for (const el of document.querySelectorAll(`#table${p} .cell`)) el.dataset.uid = '';
  $('#log').innerHTML = '';
  arena?.dispose();
  arena = createArena($('#arena'), S, {
    onPickUnit, onPickMarker, onPickProp, onPickGround, onHover: onArenaHover,
    onPickNothing: () => { if (sel?.kind === 'unit') return; },
    isPickable: () => true,
    unitLabel: (u) => { const n = unitName(u.id); return n.charAt(0).toUpperCase() + n.slice(1); },
  });
  $('#seed').textContent = `seed ${seed} · ${S.arena.challenge}`;
  history.replaceState(null, '', `?seed=${seed}${watch ? '&watch' : ''}${pool ? '&pool' : ''}${FAST ? '&fast' : ''}`);
  logLine(`<b>A new duel.</b> Arena: <i>${esc(S.arena.challenge)}</i>. First to 15 VP.`, 'sys');
  flushFx();
  render();
  drive();
}

const opp = (p) => 1 - p;
const whoseTurnName = (p) => (HUMAN === null ? `Player ${p + 1}` : p === HUMAN ? 'You' : 'Enemy');

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
      const weight = flushFx();
      render();
      await sleep(FAST ? 0 : Math.min(2400, 250 + weight * 200));
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
  try { apply(S, a); } catch (e) { console.error(e); toast(`The engine threw: ${e.message}`, 'bad'); }
  flushFx();
  render();
  drive();
}

function answer(v) {
  if (busy || !S.pending) return;
  someChosen = [];
  try { choose(S, v); } catch (e) { console.error(e); toast(`The engine threw: ${e.message}`, 'bad'); }
  flushFx();
  render();
  drive();
}

const humanToMove = () => HUMAN !== null && S.winner === null && !S.pending && S.active === HUMAN && !busy;
const humanToAnswer = () => HUMAN !== null && S.winner === null && S.pending
  && (S.pending.request.player ?? S.active) === HUMAN;
const myActions = () => (humanToMove() ? legalActions(S) : []);

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
/** Golems of one card are told apart by a number that stays with the body. */
function golemNumber(u) {
  const same = S.field.units.filter((x) => x.owner === u.owner && x.def === u.def && !x.dead).sort((a, b) => a.id - b.id);
  return same.length > 1 ? `#${same.indexOf(u) + 1}` : '';
}
const pName = (p) => (HUMAN === null ? `P${p + 1}` : p === HUMAN ? 'You' : 'Enemy');
const pCls = (p) => `p${p}`;

/* ================================================================ fx */

/**
 * Read the notes the engine left since last time: write the log, fire the
 * effects, and return how much happened so the AI's pause can match it.
 */
function flushFx() {
  let weight = 0;
  const flash = new Map();
  for (const f of S.fx.slice(fxSeen)) {
    const line = narrate(f);
    if (line) logLine(line, f.kind);
    switch (f.kind) {
      case 'match': weight += 2; for (const u of f.uids) flash.set(u, 'match'); break;
      case 'resolveStart': weight += 2; if (f.uid) flash.set(f.uid, 'resolve'); break;
      case 'rotate': weight += 1; break;
      case 'play': case 'golemCard': weight += 1; break;
      case 'destroy': weight += 1; break;
      case 'damage': weight += 1; arena.floatAtUnit(f.id, `−${f.amount}`, 'dmg'); arena.pulseUnit(f.id, 0xff4040, 0.6); break;
      case 'strike': weight += 1; break;
      case 'kill': weight += 3; arena.floatAtUnit(f.id, 'SLAIN', 'kill'); break;
      case 'push': weight += 1; if (f.body === 'unit') arena.pulseUnit(f.id, 0x9fd8ff, 0.8); break;
      case 'falls': weight += 2; for (const l of f.landed || []) if (l.key[0] === 'u' && l.drop > 0) arena.floatAtUnit(Number(l.key.slice(1)), `fell ${(l.drop / 1000).toFixed(1)}m`, 'fall'); break;
      case 'move': weight += 0.6; break;
      case 'summon': weight += 1; break;
      case 'score': weight += 3; toast(`${pName(f.p)} +${f.amount} VP — ${SOURCE[f.source] || esc(f.source)}`, f.p === HUMAN ? 'good' : HUMAN === null ? 'good' : 'bad'); break;
      case 'found': weight += 2; if (f.p === HUMAN) toast(`Learned <b>${esc(CARDS[f.defId]?.name || f.defId)}</b> — it goes to your discard`, 'learn'); break;
      case 'turnStart': banner(f.p); break;
      case 'respawn': weight += 1; break;
      case 'hurl': weight += 2; arena.floatAtUnit(f.id, 'HURLED', 'fall'); break;
      case 'dropRock': weight += 2; arena.floatAtUnit(f.onto, 'CRASH', 'kill'); break;
      case 'heal': weight += 1; arena.floatAtUnit(f.id, `+${f.amount}`, 'heal'); break;
      case 'raiseWall': case 'swap': weight += 1.5; break;
      default: break;
    }
  }
  fxSeen = S.fx.length;
  pendingFlash = flash;
  return weight;
}
let pendingFlash = new Map();
const SOURCE = { objective: 'an objective completed', mage: 'a mage slain', golem: 'a golem slain' };

function narrate(f) {
  const P = (p) => `<span class="${pCls(p)}">${pName(p)}</span>`;
  const N = (uid) => `<b>${esc(cardName(uid))}</b>`;
  switch (f.kind) {
    case 'turnStart': return `<hr><span class="turn">Turn ${f.turn}</span> — ${P(f.p)}`;
    case 'play': return `${P(f.p)} play${f.p === HUMAN ? '' : 's'} ${N(f.uid)} to the ${CELL_COLOR[f.cell]} cell`;
    case 'golemCard': return `${P(f.p)} set${f.p === HUMAN ? '' : 's'} ${N(f.uid)} into golem slot ${'ABC'[f.slot] || f.slot}`;
    case 'rotate': return `↺ ${N(f.uid)} turns ${f.dir} to <b>${NUMERALS[f.rot]}</b>`;
    case 'shift': return `⇄ ${N(f.uid)} shifts from cell ${f.from} to ${f.to}`;
    case 'destroy': return `✕ ${N(f.uid)} is destroyed`;
    case 'match': return `<span class="gold">✦ MATCH</span> — ${f.uids.map(N).join(' + ')}${f.chosen ? `; ${N(f.chosen)} turns` : ''}`;
    case 'matchLocked': return `<i>a match is locked — nothing there may turn</i>`;
    case 'matchExhausted': return `<i>a match has nothing left that may turn</i>`;
    case 'resolveStart': {
      const d = CARDS[f.def];
      const face = d?.faces?.[NUMERALS.indexOf(f.numeral)];
      return `&nbsp;&nbsp;▸ <b>${esc(d?.name || f.def)} ${f.numeral}</b>: ${esc(face?.text || '')}`;
    }
    case 'gateUnmet': return `&nbsp;&nbsp;&nbsp;&nbsp;<i>inert — ${esc(f.text || 'its condition is unmet')}</i>`;
    case 'fizzle': return `&nbsp;&nbsp;&nbsp;&nbsp;<i>fizzles — the cost was not paid</i>`;
    case 'keywordCopy': return `&nbsp;&nbsp;&nbsp;&nbsp;copies <span class="kw">[${esc(f.kw)}]</span> onto ${N(f.to)}`;
    case 'keywordGrant': return `&nbsp;&nbsp;&nbsp;&nbsp;grants <span class="kw">[${esc(f.kw)}]</span> to ${N(f.uid)}`;
    case 'damage': return `&nbsp;&nbsp;&nbsp;&nbsp;<span class="red">${f.amount} damage</span> to ${esc(unitName(f.id))}${f.cause && f.cause !== 'spell' ? ` (${esc(f.cause)})` : ''}`;
    case 'push': return f.body === 'unit' ? `&nbsp;&nbsp;&nbsp;&nbsp;pushes ${esc(unitName(f.id))} ${(f.mm / 1000).toFixed(1)}m` : `&nbsp;&nbsp;&nbsp;&nbsp;shoves a ${esc(S.field.props.find((p) => p.id === f.id)?.kind || 'rock')} ${(f.mm / 1000).toFixed(1)}m`;
    case 'falls': return `&nbsp;&nbsp;&nbsp;&nbsp;<b>falls</b>: ${(f.landed || []).map((l) => `${(l.drop / 1000).toFixed(1)}m`).join(', ')}`;
    case 'kill': return `<span class="red">☠ ${esc(unitName(f.id))} slain</span>${f.by !== null && f.by !== undefined ? ` by ${P(f.by)}` : ''}`;
    case 'score': return `<span class="gold">+${f.amount} VP</span> to ${P(f.p)} — ${SOURCE[f.source] || esc(f.source)}`;
    case 'summon': return `${P(f.p)} summon${f.p === HUMAN ? '' : 's'} a ${N(f.uid)}`;
    case 'strike': return `&nbsp;&nbsp;⚔ ${esc(unitName(f.from ?? f.id))} strikes ${esc(unitName(f.to))} for ${f.amount}${f.edge ? ' (high ground)' : ''}`;
    case 'move': return null;
    case 'respawn': return `${P(f.p)} mage respawns`;
    case 'found': return `${P(f.p)} <span class="green">learn${f.p === HUMAN ? '' : 's'} ${esc(CARDS[f.defId]?.name || f.defId)}</span> — ${esc(FINDS[f.why]?.text || f.why)}`;
    case 'golemSpent': return `${N(f.uid)} is spent and goes to the discard`;
    case 'terrainRemoved': return `&nbsp;&nbsp;&nbsp;&nbsp;removes terrain until end of turn`;
    case 'levitate': return `&nbsp;&nbsp;&nbsp;&nbsp;raises terrain ${(f.mm / 1000).toFixed(1)}m`;
    case 'relocate': return `&nbsp;&nbsp;&nbsp;&nbsp;relocates ${esc(unitName(f.id))}`;
    case 'reshuffle': return `${P(f.p)} shuffle${f.p === HUMAN ? '' : 's'} the discard back into the deck`;
    case 'prohibited': return `&nbsp;&nbsp;&nbsp;&nbsp;${N(f.uid)} may not rotate again this turn`;
    case 'chainEnd': return f.resolutions > 1 ? `<i>a chain of ${f.resolutions}</i>` : null;
    case 'hurl': return `&nbsp;&nbsp;&nbsp;&nbsp;hurls ${esc(unitName(f.id))} ${(f.mm / 1000).toFixed(0)}m into the air`;
    case 'dropRock': return `&nbsp;&nbsp;&nbsp;&nbsp;drops a rock on ${esc(unitName(f.onto))}`;
    case 'swap': return `&nbsp;&nbsp;&nbsp;&nbsp;${esc(unitName(f.a))} and ${esc(unitName(f.b))} swap places`;
    case 'raiseWall': return `&nbsp;&nbsp;&nbsp;&nbsp;a stone wall rises out of the ground`;
    case 'heal': return `&nbsp;&nbsp;&nbsp;&nbsp;<span class="green">${esc(unitName(f.id))} regains ${f.amount}</span>`;
    case 'recall': return `&nbsp;&nbsp;&nbsp;&nbsp;returns ${N(f.uid)} to hand`;
    case 'reanimate': return `&nbsp;&nbsp;&nbsp;&nbsp;${N(f.uid)} rises from the discard`;
    case 'poisoned': return `&nbsp;&nbsp;&nbsp;&nbsp;${esc(unitName(f.id))} is poisoned (${f.n})`;
    case 'mageLife': return `${P(f.p)} mage now has ${f.maxHp} life`;
    case 'win': return `<span class="gold big">★ ${P(f.p)} win${f.p === HUMAN ? '' : 's'} — ${esc(f.reason)}</span>`;
    case 'draw': return `<b>a draw at the turn cap</b>`;
    default: return null;
  }
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
  el.textContent = HUMAN === null ? `Player ${p + 1}'s turn` : p === HUMAN ? 'Your turn' : "Enemy's turn";
  void el.offsetWidth;
  el.classList.add('show');
}

/* ================================================================ tables */

const angles = new Map();   // uid -> {rot, deg}: so a turn spins the short way

function bodyAngle(sp) {
  const a = angles.get(sp.uid);
  if (!a) { const deg = -90 * sp.rot; angles.set(sp.uid, { rot: sp.rot, deg }); return deg; }
  if (a.rot !== sp.rot) {
    const d = (((sp.rot - a.rot) % 4) + 4) % 4;
    a.deg += d === 3 ? 90 : -90 * d;
    a.rot = sp.rot;
  }
  return a.deg;
}

function buildTable(p) {
  const el = $(`#table${p}`);
  el.innerHTML = '';
  for (let c = 0; c < 9; c++) {
    const cell = document.createElement('div');
    cell.className = `cell c-${CELL_COLOR[c]}`;
    cell.dataset.cell = c;
    cell.dataset.p = p;
    cell.innerHTML = `<div class="cellmark">${cellSigil(CELL_COLOR[c])}</div><div class="slot"></div><div class="badges"></div>`;
    cell.addEventListener('click', () => onCellClick(p, c));
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

function renderTable(p) {
  const pl = S.players[p];
  const cells = document.querySelectorAll(`#table${p} .cell`);
  cells.forEach((cell, c) => {
    const sp = topOf(S, p, c);
    const slot = cell.querySelector('.slot');
    const badges = cell.querySelector('.badges');
    if (!sp) {
      if (cell.dataset.uid) { slot.innerHTML = ''; cell.dataset.uid = ''; }
      badges.innerHTML = '';
      cell.classList.remove('filled');
      return;
    }
    const def = defOf(S, sp);
    cell.classList.add('filled');
    if (cell.dataset.uid !== String(sp.uid)) {
      slot.innerHTML = `<div class="card on-table"><div class="cbody">${cardSVG(def, { rot: 0, centre: false, lit: false })}</div><div class="ccentre"></div></div>`;
      cell.dataset.uid = sp.uid;
    }
    const body = slot.querySelector('.cbody');
    body.style.transform = `rotate(${bodyAngle(sp)}deg)`;
    const kws = keywordsOf(S, sp);
    const runes = [0, 1, 2, 3].map((pos) => runeAtCorner(S, sp, pos));
    const printed = [0, 1, 2, 3].map((pos) => def.runes[(pos + sp.rot) & 3]);
    slot.querySelector('.ccentre').innerHTML = centreSVG(def, activeIndex(sp), { keywords: kws, runes, printed });
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
    if (!g) { el.innerHTML = `<span class="empty">slot ${'ABC'[s]}</span>`; el.dataset.uid = ''; return; }
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

/* ================================================================ hand */

function renderHand() {
  const el = $('#hand');
  const p = HUMAN ?? 0;
  const pl = S.players[p];
  const la = myActions();
  const playable = new Set(la.filter((a) => a.type === 'play').map((a) => a.uid));
  const ask = humanToAnswer() && S.pending.request.kind === 'hand' ? S.pending.request : null;
  el.innerHTML = '';
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
    div.innerHTML = cardSVG(d);
    div.addEventListener('mouseenter', () => inspectDef(d, 0, null, c));
    div.addEventListener('mouseleave', hideInspector);
    div.addEventListener('click', () => onHandClick(c.uid));
    el.appendChild(div);
  });
  if (!pl.hand.length) el.innerHTML = '<div class="watching">Your hand is empty.</div>';
}

/* ================================================================ inspector */

let hideTimer = 0;
function showInspector() { clearTimeout(hideTimer); $('#inspector').classList.add('show'); }
function hideInspector() { clearTimeout(hideTimer); hideTimer = setTimeout(() => $('#inspector').classList.remove('show'), 180); }

function inspectSpell(sp) {
  const def = defOf(S, sp);
  inspectDef(def, activeIndex(sp), keywordsOf(S, sp), sp);
}

function inspectDef(def, rot = 0, kws = null, card = null) {
  const keys = kws || def.keywords || [];
  const kwHtml = keys.map((k) => `<div class="kwline"><span class="kw">[${esc(k)}]</span> ${esc(KEYWORDS[k]?.text || '')}</div>`).join('');
  const school = def.kind === 'golem' ? 'golem' : def.school;
  let extra = '';
  if (card && card.cell !== undefined && card.cell !== null && card.owner !== undefined) {
    const depth = stackAt(S, card.owner, card.cell).length - 1;
    if (depth > 0) extra += `<div class="dim">${depth} card${depth > 1 ? 's' : ''} buried beneath.</div>`;
  }
  if (def.found) extra += `<div class="dim">Found by: ${esc(FINDS[def.found]?.text || def.found)}</div>`;
  $('#inspector').innerHTML = `
    <div class="ibig">${cardSVG(def, { rot, keywords: keys })}</div>
    <div class="ihead" style="color:${SCHOOL_INK[school]}">${esc(def.name)} <small>${def.kind === 'golem' ? `golem · tier ${def.tier}` : def.kind === 'artifact' ? 'artifact · grey corners' : `${def.school} spell`}</small></div>
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

let hoverUnit = null;
function onArenaHover(hit) {
  const u = hit?.kind === 'unit' ? S.field.units.find((x) => x.id === hit.id) : null;
  if (u) inspectUnit(u); else if (hoverUnit !== null) hideInspector();
  hoverUnit = u ? u.id : null;
  if (hit?.kind === 'ground') previewMove(hit.x, hit.y); else if (!u) arena.showGhost(null);
}

/* ================================================================ input */

function onHandClick(uid) {
  if (humanToAnswer()) { promptPick(uid); return; }
  if (!humanToMove()) return;
  const plays = myActions().filter((a) => a.type === 'play' && a.uid === uid);
  if (!plays.length) { toast('That card has nowhere to go right now.', ''); return; }
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
    if (r.kind === 'unit' && r.options.includes(id)) promptPick(id);
    return;
  }
  if (!humanToMove() || S.phase !== 'unit') return;
  const la = myActions();
  const strike = la.find((a) => a.type === 'unit' && a.act === 'strike' && a.target === id && (sel?.kind !== 'unit' || a.id === sel.id));
  if (strike) return act(strike);
  if (la.some((a) => a.type === 'unit' && a.id === id)) { sel = { kind: 'unit', id }; render(); }
}

function onPickProp(id) {
  if (humanToAnswer()) {
    const r = S.pending.request;
    if (r.kind === 'prop' && r.options.includes(id)) promptPick(id);
  }
}

/** The selected unit, if the player is choosing where it walks. */
function movingUnit() {
  if (!humanToMove() || S.phase !== 'unit' || sel?.kind !== 'unit') return null;
  const u = S.field.units.find((x) => x.id === sel.id);
  return u && !u.dead && !u.acted ? u : null;
}

/**
 * Where would the unit END if told to walk to (x, y)? Asked of the engine on a
 * copy -- a wall, a ledge or another body can stop it short, and those are
 * rules. Throttled, because a copy is a few milliseconds and the mouse moves
 * every frame.
 */
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
  // A place on the field is named by the number on its marker.
  if (r.show?.[i] && r.show[i].x !== undefined) return `Spot ${i + 1}`;
  if (r.labels && r.labels[i] !== undefined && r.kind !== 'target' && !String(r.labels[i]).startsWith('junction')) return String(r.labels[i]);
  if (r.show?.[i]?.uids) return r.show[i].uids.map(cardName).join(' + ');
  if (r.kind === 'unit') return unitName(o);
  if (r.kind === 'prop') { const pr = S.field.props.find((x) => x.id === o); return pr ? `${pr.kind} (${pr.id})` : String(o); }
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
  if (!humanToAnswer()) { el.hidden = true; return; }
  const r = S.pending.request;
  el.hidden = false;
  let html = `<div class="ptitle">${esc(r.prompt || 'Choose')}</div>`;
  if (r.type === 'confirm') {
    html += `<div class="pbtns"><button data-v="yes">Yes</button><button data-v="no">No</button></div>`;
  } else {
    const hint = r.kind === 'unit' ? 'Click a glowing unit on the field, or pick below.'
      : r.kind === 'target' ? 'Click a glowing spell, or pick below.'
      : r.kind === 'hand' ? `Click ${r.count > 1 ? `${r.count} cards` : 'a card'} in your hand, or pick below.`
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

function markCell(uid, cls) {
  const sp = findSpell(S, uid);
  if (!sp || sp.cell === null || sp.cell === undefined) return;
  document.querySelector(`#table${sp.owner} .cell[data-cell="${sp.cell}"]`)?.classList.add(cls);
}

/* ================================================================ action tray */

// The engine labels moves by compass point, which means nothing from behind
// the mage's shoulder; the marker already shows where it goes.
const describeMove = (a) => (a.label.endsWith('+') ? 'climb ' : '');

function renderTray() {
  const el = $('#tray');
  const head = $('#phase');
  const phaseName = S.phase === 'spell' ? 'Spell phase' : S.phase === 'unit' ? 'Unit phase' : S.phase;
  head.innerHTML = S.winner !== null ? '<b>Match over</b>'
    : `<span class="${pCls(S.active)}">${whoseTurnName(S.active)}</span> · ${phaseName}`;
  if (HUMAN === null || S.winner !== null) { el.innerHTML = ''; return; }
  if (S.active !== HUMAN && !humanToAnswer()) {
    el.innerHTML = `<div class="thinking"><span class="dots"><i></i><i></i><i></i></span> The enemy is ${S.pending ? 'choosing' : 'thinking'}…</div>`;
    return;
  }
  if (humanToAnswer()) { el.innerHTML = ''; return; }
  const la = myActions();
  let html = '';
  if (S.phase === 'spell') {
    html += '<div class="hintline">Take <b>one</b> spell action: play a card, or click one of your spells to <b>rotate</b> it (its new top face resolves), shift or destroy it.</div><div class="btns">';
    if (la.some((a) => a.type === 'pass')) html += `<button data-a="skip" class="ghost" title="You drew at the start of your turn; you may take no spell action">Skip spell action</button>`;
    if (sel?.kind === 'spell') {
      const sp = findSpell(S, sel.uid);
      const def = defOf(S, sp);
      const rot = la.find((a) => a.type === 'rotate' && a.uid === sel.uid);
      const des = la.find((a) => a.type === 'destroy' && a.uid === sel.uid);
      const shifts = la.filter((a) => a.type === 'shift' && a.uid === sel.uid);
      if (rot) {
        const next = def.faces[(activeIndex(sp) + 1) & 3];
        const r = reachOf(sp, (activeIndex(sp) + 1) & 3);
        html += `<button data-a="rotate" class="primary" title="${esc(next.text)}">Rotate left → <b>${next.numeral}</b> resolves: ${esc(next.text)}${r ? ` <span class="reach">· reach ${(r.mm / 1000).toFixed(1)}m, ${r.targets.length} enemy in range</span>` : ''}</button>`;
      } else html += `<span class="note">${esc(def.name)} cannot be rotated by you right now.</span>`;
      if (des) html += `<button data-a="destroy" class="danger">Destroy ${esc(def.name)}</button>`;
      if (shifts.length) html += `<span class="note">…or click a glowing cell to shift it.</span>`;
      html += `<button data-a="cancel" class="ghost">Cancel</button>`;
    } else if (sel?.kind === 'hand') {
      const plays = la.filter((a) => a.type === 'play' && a.uid === sel.uid);
      html += `<span class="note">Click a glowing ${plays[0]?.slot !== undefined ? 'golem slot' : 'cell'} to play ${esc(cardName(sel.uid))}.</span>`;
      if (plays.length === 1) html += `<button data-a="play1" class="primary">Play it</button>`;
      html += `<button data-a="cancel" class="ghost">Cancel</button>`;
    }
    html += '</div>';
  } else if (S.phase === 'unit') {
    const mine = S.field.units.filter((u) => u.owner === HUMAN && !u.dead);
    const ready = mine.filter((u) => la.some((a) => a.type === 'unit' && a.id === u.id));
    if (sel?.kind !== 'unit' || !ready.some((u) => u.id === sel.id)) sel = ready[0] ? { kind: 'unit', id: ready[0].id } : null;
    html += '<div class="hintline">Each unit may <b>move</b>, <b>strike</b> an adjacent enemy, or (the mage) <b>summon</b> a golem. Click anywhere inside the blue circle to move there; click a red-ringed enemy to strike.</div><div class="btns">';
    for (const u of ready) {
      html += `<button data-unit="${u.id}" class="${sel?.id === u.id ? 'on' : ''}">${esc(unitName(u.id))}</button>`;
    }
    if (sel?.kind === 'unit') {
      for (const a of la.filter((x) => x.type === 'unit' && x.id === sel.id && x.act === 'summon')) {
        html += `<button data-summon="${a.golem}" class="primary">Summon ${esc(cardName(a.golem))}</button>`;
      }
      const strikes = la.filter((x) => x.type === 'unit' && x.id === sel.id && x.act === 'strike');
      for (const a of strikes) html += `<button data-strike="${a.target}" class="danger">Strike ${esc(unitName(a.target))}</button>`;
      html += `<button data-a="pass" class="ghost">Hold this unit</button>`;
    }
    html += `<button data-a="endturn" class="end">End turn</button></div>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      const la2 = myActions();
      const A = b.dataset.a;
      if (A === 'skip') return act(la2.find((a) => a.type === 'pass'));
      if (A === 'rotate') return act(la2.find((a) => a.type === 'rotate' && a.uid === sel.uid));
      if (A === 'destroy') return act(la2.find((a) => a.type === 'destroy' && a.uid === sel.uid));
      if (A === 'play1') return act(la2.find((a) => a.type === 'play' && a.uid === sel.uid));
      if (A === 'cancel') { sel = null; return render(); }
      if (A === 'pass') return act(la2.find((a) => a.type === 'unit' && a.id === sel.id && a.act === 'pass'));
      if (A === 'endturn') return endTurn();
      if (b.dataset.unit) { sel = { kind: 'unit', id: Number(b.dataset.unit) }; return render(); }
      if (b.dataset.summon) return act(la2.find((a) => a.type === 'unit' && a.id === sel.id && a.act === 'summon' && String(a.golem) === b.dataset.summon));
      if (b.dataset.strike) return act(la2.find((a) => a.type === 'unit' && a.id === sel.id && a.act === 'strike' && String(a.target) === b.dataset.strike));
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
    if (r.kind === 'unit') arena.highlightUnits(Object.fromEntries(r.options.map((id) => [id, 0xffe066])));
    if (r.show) {
      const pts = [];
      r.show.forEach((s, i) => {
        if (!s) return;
        if (s.x !== undefined) pts.push({ x: s.x, y: s.y, z: s.z ?? 0, label: String(i + 1), data: { answer: r.options[i] } });
        if (s.cell !== undefined) {
          const owner = findSpell(S, s.uid)?.owner ?? HUMAN;
          document.querySelector(`#table${owner} .cell[data-cell="${s.cell}"]`)?.classList.add('askable');
        }
        if (s.uids) s.uids.forEach((u) => markCell(u, 'hint'));
      });
      if (pts.length) arena.setMarkers(pts, 0xffe066);
    }
    if (r.kind === 'prop') {
      const pts = r.options.map((id) => S.field.props.find((p) => p.id === id)).filter(Boolean)
        .map((pr) => ({ x: pr.x, y: pr.y, z: pr.z, label: pr.kind, data: { answer: pr.id } }));
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
      arena.setMoveCircle({ x: u.x, y: u.y, r: moveBudget(S, u) });
    }
    const hl = { [sel.id]: 0xffffff };
    for (const a of la.filter((x) => x.type === 'unit' && x.id === sel.id && x.act === 'strike')) hl[a.target] = 0xff3030;
    arena.highlightUnits(hl);
  }
}

/* ================================================================ range */

/**
 * How far a face of this spell reaches right now, and which enemies are in it.
 * Built from the engine's own context, so [Reach], Focus Stone, [Ignore
 * Height] and every other modifier are already in -- the ring is the rule.
 */
function reachOf(sp, index) {
  const def = defOf(S, sp);
  const face = def.faces[index];
  if (!face || face.reach === undefined) return null;
  const ctx = makeCtx(S, sp, def, face);
  const r = ctx.range(face.reach);
  return { mm: r.mm, numeral: face.numeral, targets: ctx.enemyUnits(face.reach) };
}

/** The rings to draw: the face a rotation would bring up, from every origin. */
let hoverSpell = null;
function rangePreview() {
  const out = [];
  const add = (sp, index, colour, when) => {
    const r = reachOf(sp, index);
    if (!r) return;
    // A ring from EVERY origin -- golems project range too -- but one label.
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
  $('#turn').textContent = `Turn ${S.turn}`;
  for (const p of [0, 1]) {
    const m = S.field.units.find((u) => u.owner === p && u.kind === 'mage');
    const dead = !m || m.dead;
    $(`#mage${p}`).innerHTML = dead ? `<span class="red">mage slain — returns turn ${S.players[p].mage.respawnOnTurn ?? '?'}</span>` : '';
  }
}

/* ================================================================ render */

function render() {
  if (!S) return;
  renderTop();
  renderTable(0);
  renderTable(1);
  renderHand();
  renderPrompt();
  renderTray();
  arena.sync(S);
  renderHighlights();
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
  modal(`<h2 class="${won ? 'gold' : ''}">${title}</h2>
    <p class="big">${S.vp[0]} – ${S.vp[1]} <small>after ${S.turn} turns · ${esc(S.reason || '')}</small></p>
    ${HUMAN !== null ? `<p>${learned ? `<b class="green">${learned} new way${learned > 1 ? 's' : ''} to find spells</b> written into your Spellbook.` : 'Nothing new for the Spellbook this time.'}<br>
      Spellbook: ${Object.keys(prof.learned).length}/${FIND_IDS.length} ways known · ${prof.matches} duel${prof.matches === 1 ? '' : 's'} · ${prof.wins} won</p>` : ''}
    ${ledgerTable()}
    <div class="mbtns"><button id="again" class="primary">New duel</button><button id="sb">Open Spellbook</button><button id="close" class="ghost">Look at the board</button></div>`);
  $('#again').onclick = () => { closeModal(); newMatch({ pool: params.has('pool'), policy: POLICY, watch: HUMAN === null }); };
  $('#sb').onclick = openSpellbook;
  $('#close').onclick = closeModal;
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

function openSpellbook() {
  const prof = profile.load();
  const page = spellbookPage(prof.learned);
  const known = page.filter((x) => x.known).length;
  modal(`<h2>The Spellbook</h2>
    <p class="dim">A record of the <b>ways</b> spells are found. Every duel starts from the same ten cards; what you keep is knowing what to do to find the rest. Do one of these things in a duel and the card goes into your discard for that match.</p>
    <p><b>${known}</b> of ${page.length} ways known · ${prof.matches} duels · ${prof.wins} won</p>
    <div class="book">${page.map((x) => {
      if (!x.known) return `<div class="bk unknown"><span>— undiscovered —</span></div>`;
      const d = CARDS[x.card];
      return `<div class="bk"><span class="bt">${esc(x.text)}</span><span class="bc" style="color:${SCHOOL_INK[d?.kind === 'golem' ? 'golem' : d?.school] || '#ccc'}">→ ${esc(d?.name || x.card)}</span></div>`;
    }).join('')}</div>
    <div class="mbtns"><button id="close" class="primary">Close</button></div>`);
  $('#close').onclick = closeModal;
}

function openNewGame() {
  modal(`<h2>New duel</h2>
    <label>Arena seed <input id="ng-seed" type="number" value="${Math.floor(Math.random() * 1e6)}"></label>
    <label>Opponent <select id="ng-ai"><option value="oneply">Adept (strongest)</option><option value="greedy">Apprentice</option><option value="random">Novice (random)</option></select></label>
    <label>Decks <select id="ng-deck"><option value="std">Standard ten-card deck</option><option value="pool">Random decks from all 60 cards</option></select></label>
    <label class="row"><input id="ng-watch" type="checkbox"> Just watch two AIs</label>
    <div class="mbtns"><button id="ng-go" class="primary">Begin</button><button id="close" class="ghost">Cancel</button></div>`);
  $('#ng-ai').value = POLICY;
  $('#ng-go').onclick = () => {
    const seed = Number($('#ng-seed').value) || 1;
    closeModal();
    newMatch({ seed, policy: $('#ng-ai').value, pool: $('#ng-deck').value === 'pool', watch: $('#ng-watch').checked });
  };
  $('#close').onclick = closeModal;
}

function openRules() {
  const R = (r) => runeGlyphInline(r, '#e8dcc0');
  modal(`<h2>How to play</h2>
    <div class="rules">
    <p><b>Goal:</b> first to <b>15 VP</b>. Gold spells score by completing hard objectives (scoring sends the gold spell to your discard). Killing a mage is worth 2 VP; a golem, 1.</p>
    <p><b>Your turn</b>: draw a card, take one <b>spell action</b>, then a <b>unit phase</b>.</p>
    <p><b>Spell actions</b> (pick one): play a card onto its colour · <b>rotate</b> one of your spells left — <b>its new top face resolves</b> · shift a spell to an adjacent cell · destroy one of your spells · or skip. Artifacts go on the grey corners; golem cards go in the slots beneath.</p>
    <p><b>The top face is active.</b> Cards land showing side I, and each left turn brings up the next face. <b>Side IV is every card's payoff</b>; sides I–III build toward it, and most make you pay something to get there. Select a spell to see the range of the face it would turn to. You can only rotate a spell yourself while it sits on its own colour.</p>
    <p><b>Matches:</b> wherever two of your cards meet at a corner showing the <b>same rune</b>, they match. You must choose one of them; it rotates left and its new top face <b>resolves</b>. That can set off another match, and another — a chain. Each junction resonates once per chain, and a spell turns at most four times per action. A chain is mandatory, so it can hurt you.</p>
    <p class="runes">${R('SPIRAL')} Spiral — turning &amp; shifting &nbsp; ${R('SHARD')} Shard — destruction &amp; damage &nbsp; ${R('WHEEL')} Wheel — pushing &amp; terrain &nbsp; ${R('LATTICE')} Lattice — cards, keywords, scoring</p>
    <p><b>[Keywords]</b> are copied onto the other card on a match — put [Ignore Height] on a push, [Poison] on a fireball.</p>
    <p><b>Units:</b> each may move anywhere inside its blue move circle, strike an adjacent enemy, or (the mage) summon a golem beside itself. Mages have 5 life unless a passive raises it. Golem tiers cap how many are out at once: C three, B two, A one. A golem card that has deployed and then lost every unit is spent.</p>
    <p><b>The field is real distance.</b> Climb walls slowly, fall off ledges for damage, shove rocks out from under people.</p>
    <p><b>The Spellbook</b> remembers the ways you've found new spells, across every duel.</p>
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
  get busy() { return busy; },
  get arena() { return arena; },
};

function boot() {
  buildTable(0);
  buildTable(1);
  $('#btn-new').onclick = openNewGame;
  $('#btn-book').onclick = openSpellbook;
  $('#btn-rules').onclick = openRules;
  document.addEventListener('click', (e) => {
    const d = e.target.closest('.discard');
    if (d) openDiscard(Number(d.dataset.p));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (!$('#modal').hidden) closeModal(); else { sel = null; render(); } }
  });
  const seed = params.has('seed') ? Number(params.get('seed')) : undefined;
  newMatch({ seed, watch: params.has('watch'), pool: params.has('pool'), policy: params.get('ai') || 'oneply' });
  if (!params.has('seed') && !profile.seen('rules')) openRules();
}

boot();
