// The cards, drawn.
//
// The printed geometry is kept exactly: a 1:1 square, corner radius 0.040·S,
// a rim band 0.210·S deep carrying one face's text along each edge, and a rune
// disc 0.220·S across in each corner. Everything else is new: deep near-black
// ground, school-coloured line work that glows, and sigils with strict
// four-fold symmetry, because the card visibly spins and anything asymmetric
// is wrong three rotations out of four.
//
// A card on the table is TWO layers. The body -- frame, rim text, numerals,
// runes -- is one group that turns with `rot`, so a rotation is literally the
// card turning. The centre -- name, active numeral, active text -- stays
// upright, because that is the part a player reads.

import { NUMERALS } from '../rules/orient.js';

export const SCHOOL_INK = Object.freeze({
  red: '#ff6a52', blue: '#52b6ff', green: '#5ee68f', purple: '#c98bff',
  gold: '#ffcf5a', grey: '#c3cad6', golem: '#e0a46a',
});
export const SCHOOL_DEEP = Object.freeze({
  red: '#2a0b0a', blue: '#06182b', green: '#06200f', purple: '#1b0b2c',
  gold: '#261c05', grey: '#14171c', golem: '#22150a',
});

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ------------------------------------------------------------ the runes */
// Four silhouette classes, not four hues: curved, pointed, circular, square.
// Each is drawn as one quadrant and repeated four times, so C4 symmetry is
// structural rather than something a hand-drawn path has to get right.

const quad = (d) => [0, 90, 180, 270].map((a) => `<path d="${d}" transform="rotate(${a})"/>`).join('');

const GLYPHS = {
  SPIRAL: `<g fill="none" stroke-width="9" stroke-linecap="round">${quad('M0 -12 C 26 -14 40 -36 26 -58 C 18 -70 2 -66 4 -54')}</g><circle r="9"/>`,
  SHARD: `<path d="M0 -70 L14 -14 L70 0 L14 14 L0 70 L-14 14 L-70 0 L-14 -14 Z"/><path d="M0 -34 L8 -8 L34 0 L8 8 L0 34 L-8 8 L-34 0 L-8 -8 Z" fill="#000" opacity=".55"/>`,
  WHEEL: `<g fill="none" stroke-width="9"><circle r="58"/><circle r="22"/></g><g stroke-width="9" stroke-linecap="round">${quad('M0 -22 L0 -58')}</g>`,
  LATTICE: `<g fill="none" stroke-width="8"><rect x="-56" y="-56" width="112" height="112" rx="4"/><path d="M-19 -56 V56 M19 -56 V56 M-56 -19 H56 M-56 19 H56"/></g>`,
  WILD: `<path d="${[0, 45, 90, 135, 180, 225, 270, 315].map((a, i) => {
    const r1 = 68, r2 = 26, t = (a - 90) * Math.PI / 180, u = (a - 67.5) * Math.PI / 180;
    return `${i ? 'L' : 'M'}${(r1 * Math.cos(t)).toFixed(1)} ${(r1 * Math.sin(t)).toFixed(1)} L${(r2 * Math.cos(u)).toFixed(1)} ${(r2 * Math.sin(u)).toFixed(1)}`;
  }).join(' ')} Z"/>`,
};

/** A rune glyph centred at (x, y), scaled to `size` (its full width). */
export function runeGlyph(rune, x, y, size, ink) {
  const g = GLYPHS[rune] || '';
  const k = size / 150;
  return `<g transform="translate(${x} ${y}) scale(${k})" fill="${ink}" stroke="${ink}">${g}</g>`;
}

/* ------------------------------------------------------------ text */

/** Greedy word wrap into at most `max` lines of about `width` characters. */
export function wrap(text, width, max = 4) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > width) { lines.push(cur); cur = w; }
    else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  if (lines.length > max) { lines.length = max; lines[max - 1] = lines[max - 1].replace(/\s*\S*$/, '…'); }
  return lines;
}

/** One rim band, drawn as the TOP band; the caller rotates it into place. */
function rimBand(face, ink, active) {
  const lines = wrap(face.text, 34, 3);
  const y0 = 104 - (lines.length - 1) * 19;
  const txt = lines.map((l, i) =>
    `<text x="500" y="${y0 + i * 38}" text-anchor="middle" class="rim-t">${esc(l)}</text>`).join('');
  return `<g class="rim${active ? ' rim-on' : ''}">
    <text x="500" y="44" text-anchor="middle" class="rim-n" fill="${ink}">${face.numeral}</text>
    <g fill="${active ? '#fff6e0' : ink}" opacity="${active ? 1 : 0.62}">${txt}</g>
  </g>`;
}

/* ------------------------------------------------------------ a card */

let gid = 0;

/**
 * SVG markup for one card.
 *
 * `opts.rot` turns the body; `opts.runes` overrides the four corner runes in
 * SCREEN position (0 = top-left, clockwise), for the state-aware cases a
 * printed rune does not cover -- a wildcard, a seal.
 */
export function cardSVG(def, opts = {}) {
  const rot = opts.rot || 0;
  const school = def.kind === 'golem' ? 'golem' : def.school;
  const ink = SCHOOL_INK[school] || SCHOOL_INK.grey;
  const deep = SCHOOL_DEEP[school] || SCHOOL_DEEP.grey;
  const id = `c${++gid}`;
  const kws = (opts.keywords || def.keywords || []);

  const defs = `<defs>
    <radialGradient id="${id}g" cx="50%" cy="50%" r="70%">
      <stop offset="0" stop-color="${deep}" stop-opacity="1"/>
      <stop offset="0.7" stop-color="#07080b"/>
      <stop offset="1" stop-color="#020203"/>
    </radialGradient>
    <filter id="${id}f" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="9" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>`;

  // The frame: outer edge, the panel rule at the rim depth, and a sigil ring.
  const frame = `
    <rect x="6" y="6" width="988" height="988" rx="40" fill="url(#${id}g)" stroke="${ink}" stroke-width="7" filter="url(#${id}f)"/>
    <rect x="210" y="210" width="580" height="580" rx="10" fill="none" stroke="${ink}" stroke-width="12" opacity=".75"/>
    <rect x="232" y="232" width="536" height="536" rx="6" fill="none" stroke="${ink}" stroke-width="2" opacity=".35"/>
    <g fill="none" stroke="${ink}" opacity=".22" stroke-width="3">
      <circle cx="500" cy="500" r="250"/><circle cx="500" cy="500" r="200"/>
      ${[0, 45, 90, 135].map((a) => `<path d="M500 248 L500 300" transform="rotate(${a} 500 500)"/><path d="M500 752 L500 700" transform="rotate(${a} 500 500)"/>`).join('')}
      <path d="M500 300 L700 500 L500 700 L300 500 Z"/>
    </g>`;

  // FACE DOWN: what the opponent sees of a set trap. The frame, the TRAP
  // seal, and nothing to read -- no name, no text, no runes.
  if (opts.back) return cardBackSVG({ ink, deep, id, defs, frame });

  let body = '';
  if (def.kind === 'golem') {
    // Golem cards are not four-sided: a statline and a tier, drawn as a seal.
    body = `<g transform="translate(500 500)" fill="none" stroke="${ink}" stroke-width="10" opacity=".8">${quad('M0 -395 L55 -340 L0 -285 L-55 -340 Z')}</g>`;
  } else if (def.kind === 'trap') {
    // A trap has one side and no corners: its text on the top band, the
    // seal where the runes would be, and the centre reads the whole thing.
    body = `<g transform="rotate(0 500 500)">${rimBand(def.faces[0], ink, opts.lit !== false)}</g>${trapSeal(ink, 0.55, { inner: false })}`;
  } else {
    const bands = def.faces.map((f, p) =>
      `<g transform="rotate(${p * 90} 500 500)">${rimBand(f, ink, opts.lit !== false && p === (rot & 3))}</g>`).join('');
    const corners = [[105, 105], [895, 105], [895, 895], [105, 895]];
    const discs = corners.map(([x, y], c) => `
      <circle cx="${x}" cy="${y}" r="98" fill="#05060a" stroke="${ink}" stroke-width="6"/>
      <circle cx="${x}" cy="${y}" r="80" fill="none" stroke="${ink}" stroke-width="2" opacity=".4"/>
      ${runeGlyph(def.runes[c], x, y, 132, ink)}`).join('');
    body = bands + `<g filter="url(#${id}f)">${discs}</g>`;
  }

  // Screen-position overrides: a ring and a glyph above the printed one.
  let over = '';
  if (opts.runes) {
    const corners = [[105, 105], [895, 105], [895, 895], [105, 895]];
    opts.runes.forEach((r, pos) => {
      if (!r || r === opts.printed?.[pos]) return;
      const [x, y] = corners[pos];
      over += `<circle cx="${x}" cy="${y}" r="100" fill="#05060a" stroke="#fff" stroke-width="8"/>${runeGlyph(r, x, y, 132, '#fff')}`;
    });
  }

  const centre = opts.centre === false ? '' : centreMarkup(def, rot, kws, ink);
  return `<svg viewBox="0 0 1000 1000" class="card-svg" xmlns="http://www.w3.org/2000/svg">${defs}
    <g class="card-body" style="transform: rotate(${-90 * rot}deg)">${frame}${body}</g>
    ${over}
    <g class="card-centre">${centre}</g>
  </svg>`;
}

/**
 * Just the upright centre, as its own SVG, for a card on the table: the body
 * underneath spins with a CSS transition and this layer does not.
 */
export function centreSVG(def, rot, opts = {}) {
  const school = def.kind === 'golem' ? 'golem' : def.school;
  const ink = SCHOOL_INK[school] || SCHOOL_INK.grey;
  const corners = [[105, 105], [895, 105], [895, 895], [105, 895]];
  let over = '';
  // The active edge, lit: the top band is always the one that resolves.
  if (def.kind !== 'golem') {
    over += `<path d="M215 18 H785" stroke="${ink}" stroke-width="16" stroke-linecap="round" opacity=".95" class="active-edge"/>`;
  }
  (opts.runes || []).forEach((r, pos) => {
    if (!r || r === opts.printed?.[pos]) return;
    const [x, y] = corners[pos];
    over += `<circle cx="${x}" cy="${y}" r="100" fill="#05060a" stroke="#fff" stroke-width="8"/>${runeGlyph(r, x, y, 132, '#fff')}`;
  });
  // Quest pips: a gold objective's progress as three dots that fill, with the
  // count beside them, so a player can see how close a payout is at a glance.
  // ONE row in a band of its own (QUEST_Y), under everything the centre
  // prints -- centreMarkup keeps its text above the band -- and drawn after
  // the text so nothing can print over it (Tally's four-line faces did).
  let quests = '';
  const qs = opts.quests || [];
  // One or two objectives get numeral, pips and the count; three (Last
  // Gambit) drop the count so all three fit in the band.
  const count = qs.length < 3;
  const gap = qs.length < 3 ? 300 : 190;
  qs.forEach((q, i) => {
    const cx = 500 + (i - (qs.length - 1) / 2) * gap - (count ? 0 : -20);
    const filled = Math.max(0, Math.min(3, Math.round((q.pct / 100) * 3)));
    let row = `<text x="${cx - 84}" y="${QUEST_Y + 10}" text-anchor="end" class="qn" fill="#ffd166">${q.numeral}</text>`;
    for (let k = 0; k < 3; k++) {
      const on = k < filled;
      row += `<circle cx="${cx - 54 + k * 40}" cy="${QUEST_Y}" r="13" fill="${on ? '#ffd166' : 'none'}" stroke="#ffd166" stroke-width="5" opacity="${on ? 1 : 0.55}"/>`;
    }
    if (count) row += `<text x="${cx + 44}" y="${QUEST_Y + 10}" text-anchor="start" class="qn" fill="#ffd166">${q.have !== null ? `${q.have}/${q.need}` : (q.pct >= 100 ? 'ready' : '')}</text>`;
    quests += `<g class="quest${q.pct >= 100 ? ' ready' : ''}">${row}</g>`;
  });
  // A corner that is part of the match being asked about: a hot ring round
  // the disc, so the player can SEE which two runes met.
  (opts.hot || []).forEach((pos) => {
    const [x, y] = corners[pos];
    over += `<circle cx="${x}" cy="${y}" r="118" fill="none" stroke="#ffd166" stroke-width="14" class="hot-corner"/>`;
  });
  return `<svg viewBox="0 0 1000 1000" class="card-svg" xmlns="http://www.w3.org/2000/svg">${over}
    <g class="card-centre">${centreMarkup(def, rot, opts.keywords || def.keywords || [], ink, { quests: qs.length > 0 })}</g>${quests}</svg>`;
}

/* ------------------------------------------------------------ traps */

/** The TRAP seal: four jaws closing on a point, with C4 symmetry like a rune. */
function trapSeal(ink, opacity = 0.8, { inner = true } = {}) {
  // The jaws sit OUTSIDE the panel on a face-up card (where a golem's seal
  // goes), so they never cross the text; the back has the room to close them
  // in on the word.
  return `<g transform="translate(500 500)" fill="none" stroke="${ink}" stroke-width="12" stroke-linejoin="round" opacity="${opacity}">
    ${inner ? [0, 180].map((a) => `<path d="M0 -300 L70 -215 L0 -150 L-70 -215 Z" transform="rotate(${a})"/>`).join('') : quad('M0 -395 L55 -340 L0 -285 L-55 -340 Z')}
    ${quad('M-330 -330 L-250 -330 L-330 -250 Z')}
    <circle r="372" stroke-width="4" opacity=".6"/>
  </g>`;
}

/**
 * A face-down card: what the opponent sees of a trap in a grey corner. The
 * same frame as any card, then the seal and the word, big, and nothing else.
 * `parts` lets cardSVG pass its frame in; called bare it builds a grey one.
 */
export function cardBackSVG(parts = null) {
  const ink = parts?.ink || SCHOOL_INK.grey;
  const deep = parts?.deep || SCHOOL_DEEP.grey;
  const id = parts?.id || `b${++gid}`;
  const defs = parts?.defs || `<defs>
    <radialGradient id="${id}g" cx="50%" cy="50%" r="70%">
      <stop offset="0" stop-color="${deep}" stop-opacity="1"/><stop offset="0.7" stop-color="#07080b"/><stop offset="1" stop-color="#020203"/>
    </radialGradient>
    <filter id="${id}f" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="9" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>`;
  const frame = parts?.frame || `
    <rect x="6" y="6" width="988" height="988" rx="40" fill="url(#${id}g)" stroke="${ink}" stroke-width="7" filter="url(#${id}f)"/>
    <rect x="210" y="210" width="580" height="580" rx="10" fill="none" stroke="${ink}" stroke-width="12" opacity=".75"/>`;
  // A woven back: diagonal hatching inside the panel, so it reads as a back
  // and not as a blank face.
  const weave = `<g stroke="${ink}" stroke-width="2" opacity=".14">${Array.from({ length: 23 }, (_, i) => `<path d="M${232 + i * 24} 232 L232 ${232 + i * 24}"/><path d="M${768 - i * 24} 768 L768 ${768 - i * 24}"/>`).join('')}</g>`;
  return `<svg viewBox="0 0 1000 1000" class="card-svg card-back" xmlns="http://www.w3.org/2000/svg">${defs}
    <g class="card-body">${frame}${weave}${trapSeal(ink, 0.9)}
      <text x="500" y="548" text-anchor="middle" class="trap-word" fill="${ink}">TRAP</text>
      <text x="500" y="120" text-anchor="middle" class="rim-n" fill="${ink}" opacity=".7">CONCEALED</text>
    </g></svg>`;
}

/** The quest-pip band's centre line; the centre text must end above it. */
export const QUEST_Y = 736;
/** The keyword line, when there is one; it sits in the last band of the panel. */
const KW_Y = 790;

function centreMarkup(def, rot, kws, ink, { quests = false } = {}) {
  const active = def.kind === 'golem' ? null : def.faces[rot & 3];
  let centre = `<text x="500" y="${active ? 288 : 330}" text-anchor="middle" class="nm" fill="${ink}" ${def.name.length > 13 ? 'textLength="520" lengthAdjust="spacingAndGlyphs"' : ''}>${esc(def.name)}</text>`;
  if (def.kind === 'trap') {
    // One side, read whole: the word, then the trigger and reaction.
    centre += `<text x="500" y="372" text-anchor="middle" class="trap-word sm" fill="${ink}">TRAP</text>`;
    wrap(def.faces[0].text.replace(/^TRAP:\s*/, ''), 24, 5).forEach((l, i) => {
      centre += `<text x="500" y="${440 + i * 50}" text-anchor="middle" class="ctr now">${esc(l)}</text>`;
    });
  } else if (def.kind === 'golem') {
    const u = def.unit || {};
    centre += `<text x="500" y="470" text-anchor="middle" class="big" fill="${ink}">${def.tier}</text>
      <text x="500" y="560" text-anchor="middle" class="ctr">${u.hp} hp · ${u.move / 1000}m · ${u.atk} dmg</text>`;
    wrap(def.text.replace(/^Tier .\.\s*/, ''), 26, 3).forEach((l, i) => {
      centre += `<text x="500" y="${640 + i * 50}" text-anchor="middle" class="ctr dim">${esc(l)}</text>`;
    });
  } else {
    centre += `<text x="500" y="360" text-anchor="middle" class="big" fill="${ink}">${active.numeral}</text>`;
    // The face showing now, then what ONE LEFT TURN brings up. A match or a
    // rotate always turns left, so the next face is the one strategy hangs on
    // (user: "an arrow that shows their NEXT SIDE'S text so it isn't a pain to
    // figure out strategy").
    const lines = wrap(active.text, 22, 4);
    // A four-line face leads a little tighter so the next face and the quest
    // band still fit beneath it.
    const y0 = 418, step = lines.length >= 4 ? 48 : 54;
    lines.forEach((l, i) => {
      centre += `<text x="500" y="${y0 + i * step}" text-anchor="middle" class="ctr now">${esc(l)}</text>`;
    });
    const next = def.faces[(rot + 1) & 3];
    if (next) {
      // A rule, then one small centred row -- a rotate-left glyph and
      // "next · N" -- then the next face's text, dim and smaller so the
      // current face stays the thing you read first.
      const yd = y0 + lines.length * step - 22;          // the rule
      const yh = yd + 34;                                 // the row's centre line
      // As many next-face lines as fit above whatever sits below: the quest
      // band, else the keyword line, else the panel's foot. Never none.
      const floor = quests ? QUEST_Y - 34 : kws.length ? KW_Y - 40 : 800;
      const room = Math.floor((floor - (yh + 54)) / 42) + 1;
      const nl = wrap(next.text, 30, Math.max(1, Math.min(3, room)));
      const cx = 412, r = 13;
      centre += `<line x1="330" y1="${yd}" x2="670" y2="${yd}" stroke="${ink}" stroke-width="3" opacity=".35"/>
        <g fill="none" stroke="${ink}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" opacity=".8">
          <path d="M ${cx} ${yh - r} A ${r} ${r} 0 1 0 ${cx + r} ${yh}"/>
          <path d="M ${cx + 7} ${yh - r - 8} L ${cx - 8} ${yh - r} L ${cx + 7} ${yh - r + 8}" fill="${ink}" stroke="none"/></g>
        <text x="${cx + 26}" y="${yh + 10}" class="nxl" fill="${ink}">next · ${next.numeral}</text>`;
      nl.forEach((l, i) => {
        centre += `<text x="500" y="${yh + 54 + i * 42}" text-anchor="middle" class="ctr nxt">${esc(l)}</text>`;
      });
    }
  }
  if (kws.length) {
    centre += `<text x="500" y="${def.kind === 'golem' ? 760 : KW_Y}" text-anchor="middle" class="ckw">${esc(kws.map((k) => `[${k}]`).join(' '))}</text>`;
  }

  return centre;
}

/** A face list for the inspector: all four, the active one lit. */
export function faceListHTML(def, rot = 0) {
  if (def.kind === 'golem') return `<p>${esc(def.text)}</p>`;
  if (def.kind === 'trap') {
    const f = def.faces[0];
    return `<div class="face on"><span class="fn">TRAP</span><span class="ft">${esc(f.text.replace(/^TRAP:\s*/, ''))}</span></div>
      <p class="dim">Set face down into an empty grey corner. It springs on its own, the first time its trigger is met on your opponent's turn, then goes to your discard.</p>`;
  }
  return def.faces.map((f) => `<div class="face${f.index === (rot & 3) ? ' on' : f.index === ((rot + 1) & 3) ? ' next' : ''}">
    <span class="fn">${f.numeral}</span><span class="fr">${runeGlyphInline(def.runes[f.index], SCHOOL_INK[def.school])}</span>
    <span class="ft">${esc(f.text)}${f.reach ? ` <em class="fr-m">${(f.reach / 1000).toFixed(1)}m</em>` : ''}${f.cost?.length ? ' <em class="fr-c">cost</em>' : ''}${f.element ? ` <em class="fr-e ${f.element}">${f.element}</em>` : ''}</span></div>`).join('');
}

export function runeGlyphInline(rune, ink) {
  return `<svg viewBox="-80 -80 160 160" class="rune-i">${runeGlyph(rune, 0, 0, 150, ink)}</svg>`;
}

export { NUMERALS };
