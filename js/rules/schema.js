// The card data schema, and the one validator every card passes through.
//
// Four faces per card is the thing that makes this game interesting and the
// thing most likely to ship broken, because a face implemented under the WRONG
// NUMERAL does not crash, violates no invariant, and leaves a perfectly legal
// game state -- the wrong effect simply resolves. Chains make that nearly
// impossible to notice by playing. So cards are authored BY NUMERAL ('I', 'II',
// 'III', 'IV'), never by array index, and this file is where that is enforced.
//
// Everything here runs at load time and THROWS. A malformed card is a bug in
// the corpus, not a condition to be handled; the alternative is a card that
// silently does nothing, which is exactly the failure mode GUDNAK shipped.

import { RUNES, isRune, suggestedRune } from './runes.js';
import { NUMERALS } from './orient.js';

// 'golem' is a pseudo-school: golem cards go into slots, not onto cells, so
// HOME has no entry for it and CELL_COLOR can never equal it.
export const SCHOOLS = Object.freeze(['red', 'blue', 'green', 'purple', 'gold', 'grey', 'golem']);
export const KINDS = Object.freeze(['spell', 'artifact', 'golem']);
export const TIERS = Object.freeze(['A', 'B', 'C']);

/**
 * Every key a face may carry. A CLOSED list, checked, because a typo in an
 * optional key ('passve', 'gates') is otherwise a face that quietly does
 * nothing while reading as implemented.
 */
export const ELEMENTS = Object.freeze(['fire', 'lightning', 'force']);

export const FACE_KEYS = Object.freeze([
  'text',       // the printed text. verify-faces.js judges the code against THIS.
  'tag',        // verb class: turn | break | move | draw. Usually set by the motif.
  'effect',     // generator(ctx) -- resolves when a match turns this face up
  'passive',    // (ctx) => void -- live ONLY while this face is active
  'passive2',   // a second derive pass, for a passive that READS the first one's
                // keyword grants. Two passes, not a fixpoint: an aura feeding an
                // aura feeding the first has no defined answer, and "iterate
                // until stable" is how that becomes a hang instead of a bug.
  'on',         // { eventName: generator(ctx, payload) } -- queue-only listeners
  'replace',    // { eventName: (ctx, payload) => payload|null } -- replacement effects
  'cost',       // [cost descriptors] paid before `effect` runs
  'gate',       // { id, ...params } into the closed gate registry
  'objective',  // GOLD ONLY: { gate?, vp, cost } -- the payout
  'grants',     // declared derived buckets this face writes. checkderived.js reads it.
  'keywords',   // keywords this face GRANTS while active (declared, for verify-faces)
  'element',    // fire | lightning | force: what this face does to the TERRAIN it
                // touches. Fire lights wood, lightning bursts crystal, force cracks
                // and throws stone. Set by the motif from the card's option.
  'reach',      // mm this face reaches from your range origins, BEFORE keywords and
                // auras. Set by the motif; the view draws it and verify-faces holds
                // it to the printed "within Xm", so the drawn range cannot drift.
]);

const CARD_KEYS = Object.freeze([
  'id', 'name', 'school', 'kind', 'keywords', 'runes', 'tier', 'unit', 'found',
  'faces', 'text', 'flavour',
]);

function bad(id, msg) {
  throw new Error(`card ${id}: ${msg}`);
}

/**
 * Turn an authored spec into a frozen definition.
 *
 * `spec` carries the card-level fields plus the four numerals as keys. The
 * numerals are lifted into `faces[0..3]` here, in exactly one place, so no
 * other file ever has to know which index 'III' is.
 */
export function makeDef(spec) {
  const id = spec.id;
  if (!id || typeof id !== 'string') throw new Error('card: missing id');

  for (const k of Object.keys(spec)) {
    if (!CARD_KEYS.includes(k) && !NUMERALS.includes(k)) bad(id, `unknown card key '${k}'`);
  }

  if (!spec.name) bad(id, 'missing name');
  const kind = spec.kind || 'spell';
  if (!KINDS.includes(kind)) bad(id, `bad kind '${kind}'`);

  const school = spec.school;
  if (!SCHOOLS.includes(school)) bad(id, `bad school '${school}'`);

  // kind and school are two views of one fact and must not be able to disagree.
  // A 'spell' on grey would be playable nowhere (grey cells take artifacts), and
  // a golem authored as red would be summonable from a cell that has no slot.
  if (kind === 'artifact' && school !== 'grey') bad(id, 'artifacts must be grey');
  if (kind === 'spell' && (school === 'grey' || school === 'golem')) {
    bad(id, `a ${school} card cannot be a plain spell`);
  }
  if ((kind === 'golem') !== (school === 'golem')) bad(id, 'kind and school disagree about golem');

  /* ------------------------------------------------------------- golems */
  // A golem card is NOT a four-sided spell. It never sits on a cell, never
  // rotates and never matches, so demanding four faces and four runes of it
  // would be three quarters of a card authored to be unreachable.
  if (kind === 'golem') {
    if (!TIERS.includes(spec.tier)) bad(id, `golem needs tier A, B or C (got '${spec.tier}')`);
    if (!spec.unit) bad(id, 'golem needs a `unit` block');
    for (const f of ['hp', 'move', 'atk', 'reach']) {
      if (!Number.isInteger(spec.unit[f])) bad(id, `golem unit.${f} must be an integer`);
    }
    if (!spec.text) bad(id, 'golem needs `text`');
    if (spec.runes || spec.faces) bad(id, 'a golem card has no runes or faces');
    for (const n of NUMERALS) if (spec[n]) bad(id, `a golem card has no side ${n}`);
    return Object.freeze({
      id, name: spec.name, school, kind, tier: spec.tier,
      unit: Object.freeze({ ...spec.unit }),
      keywords: Object.freeze([...new Set(spec.keywords || [])].sort()),
      text: spec.text, faces: Object.freeze([]), runes: Object.freeze([]),
      found: spec.found || null, flavour: spec.flavour || null,
    });
  }
  if (spec.tier || spec.unit) bad(id, 'tier/unit are golems only');

  /* ---------------------------------------------------------------- runes */
  const runes = spec.runes;
  if (!Array.isArray(runes) || runes.length !== 4) bad(id, 'runes must be 4 entries');
  for (const r of runes) if (!isRune(r)) bad(id, `bad rune '${r}' (want one of ${RUNES})`);
  // A card with one rune on all four corners re-creates its own match after
  // every rotation. The chain's vertex bound still contains it, but the card is
  // a trap for the designer rather than the player, so it is refused at source
  // instead of being left for the engine to survive.
  if (new Set(runes).size === 1) bad(id, 'all four runes identical -- see checkrunes.js');

  /* ---------------------------------------------------------------- faces */
  const faces = NUMERALS.map((n) => {
    const f = spec[n];
    if (!f) bad(id, `missing side ${n}`);
    for (const k of Object.keys(f)) {
      if (!FACE_KEYS.includes(k)) bad(id, `side ${n}: unknown key '${k}'`);
    }
    if (!f.text) bad(id, `side ${n}: missing text`);
    if (f.objective && school !== 'gold') {
      // Structural, not a convention: only gold converts work into points, and
      // a blue face that could score is a whole school's identity leaking.
      bad(id, `side ${n}: only gold faces may carry an objective`);
    }
    if (f.tag && !['turn', 'break', 'move', 'draw'].includes(f.tag)) {
      bad(id, `side ${n}: bad tag '${f.tag}'`);
    }
    if (f.element && !ELEMENTS.includes(f.element)) bad(id, `side ${n}: bad element '${f.element}'`);
    return Object.freeze({ ...f, numeral: n, index: NUMERALS.indexOf(n) });
  });

  const def = {
    id, name: spec.name, school, kind,
    keywords: Object.freeze([...new Set(spec.keywords || [])].sort()),
    runes: Object.freeze([...runes]),
    faces: Object.freeze(faces),
    found: spec.found || null,
    flavour: spec.flavour || null,
  };
  return Object.freeze(def);
}

/**
 * Which faces have printed text but no behaviour.
 *
 * Computed, never declared. "Implemented" has to be something the corpus can be
 * measured for rather than something a to-do list claims, which is the whole
 * reason GUDNAK's two dead cards survived a full release.
 */
export const inertFaces = (def) =>
  def.faces
    .filter((f) => !f.effect && !f.passive && !f.passive2 && !f.on && !f.replace && !f.objective)
    .map((f) => f.numeral);

/** How often a card's runes agree with the work of the face at the same index. */
export function runeAgreement(def) {
  let hit = 0, seen = 0;
  for (let i = 0; i < 4; i++) {
    const want = suggestedRune(def.faces[i]);
    if (!want) continue;
    seen++;
    if (def.runes[i] === want) hit++;
  }
  return { hit, seen };
}
