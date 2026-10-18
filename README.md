# WIZARD'S GAMBIT

The digital version of the printed card game. A duel between two wizards: a 3x3
**Spell Table** of four-sided rotating cards, and a small seeded arena where the
distances are real.

**[RULES.md](RULES.md) is the authoritative spec.** It is the only place this
game's rules exist as text, and the engine implements it.

Nothing renders yet, by design. The build order puts every rule and every
harness before the first pixel, because a four-sided card whose third face is
implemented under the wrong numeral does not crash, violates no invariant, and
leaves a perfectly legal game state — and it is invisible behind a renderer.

## Watch a game

```sh
node tools/duel.js --seed 7                 # two AIs, narrated, with the board drawn
node tools/duel.js --seed 7 --pool          # random decks from the whole corpus
node tools/duel.js --seed 7 --quiet         # just the result
node tools/duel.js --seed 7 --to 20         # stop after turn 20
```

The spell table is drawn with each card's **corner runes in its actual corners**
and the active numeral in the middle, because a match is two cards showing the
same rune where they touch. The arena is drawn as relief around the median
height: `.-=+*#%@` rising, `:~` below, `W`/`g` your mage and golems, `M`/`G`
theirs.

## Check everything

```sh
tools/check.sh                              # the full suite
tools/check.sh --quick                      # skips the long sweeps
```

| harness | what it proves |
|---|---|
| `checksource` | no `Math.sqrt` outside `fixed.js`, no host globals in the engine |
| `checkmath` | integer arithmetic, the 64-direction table, the seeded rng |
| `checkrotate` | the orientation algebra and the 16-vertex lattice |
| `checkrunes` | rune distribution, and the chain-length curve against table occupancy |
| `checkchains` | **the gate**: chains terminate under adversarial tables, and replay identically |
| `verify-faces` | **the gate**: every face against its own printed text. `--selftest` plants 10 faults |
| `checkderived` | every derived bucket is both written by a card and read by a rule |
| `checkledger` | every ledger counter is both written and read |
| `checkfield` | field determinism across processes, round-trip drift, falls, candidate stability |
| `playtest` | whole matches with every invariant checked after **every decision** |
| `checklockstep` | two engines, the same moves, identical hash after every move |

And two instruments rather than tests:

```sh
node tools/selfplay.js --games 200 --a oneply --b greedy --csv out.csv
node tools/checkrunes.js --tables 200000
```

`selfplay` is the balance panel: VP from objectives against VP from kills, table
occupancy, chain length, realised push distance against nominal, and every
diagnostic counter.

## Layout

```
RULES.md               the spec. Authoritative.
js/engine.js           createGame, legalActions, apply, choose, hashState, cloneState
js/rules/
  driver.js            generator effects; a parked effect is a snapshot + recorded answers
  table.js orient.js   the 3x3 and the 4x4 vertex lattice as DATA; the rotation algebra
  runes.js schema.js   the four corner runes; the card schema, validated at load
  ops.js               the ONLY path a card moves, rotates or changes zone
  triggers.js          closed event list; a listener may only QUEUE, never resolve
  derive.js            continuous effects, into a DECLARED bucket set, never stored
  keywords.js          [Keywords] as descriptor hooks. [Ignore Height] is one line
  gates.js costs.js    closed registries of pure predicates and payable things
  objectives.js        gold's payout formulas
  score.js             award() is the ONLY way VP changes
  match.js             THE MATCH RULE and the chain, with both termination rules
  resolve.js           resolveSide(state, spell, INDEX) + the context cards are written against
  motifs.js            parameterised face behaviours; most faces are one line
  turn.js units.js     the turn structure; the unit phase
  combat.js golems.js  damage and death; the tier table and the attrition rule
  learn.js             the Spellbook: 38 find conditions
  spells/              the corpus, one file per school
js/field/
  fixed.js             integer millimetres. THE ONLY FILE ALLOWED Math.*
  arena.js             seeded heightfield + terrain pieces
  query.js             range, line of sight, support. No mutation anywhere
  move.js push.js      walk, climb, fall; the bounded push solver
  candidates.js        the continuum turned into finite sorted option lists
js/ai/                 eval.js answer.js ai.js -- one ply, but the whole chain
js/profile.js          the only file allowed to persist anything
tools/                 the harnesses, plus duel.js and selfplay.js
```

## The four decisions everything hangs off

**The chain is an effect, not a loop.** It asks questions, so it parks on
`state.pending` as a pre-effect snapshot plus the answers so far, and replays
from that snapshot on every answer — like any card. All of its bookkeeping is
therefore plain serialisable data on `state.chain`.

**Termination is structural, not a guard.** Two real rules, each teachable in a
sentence: *each junction resonates at most once per chain* (12 junctions, and a
chain spends one **before** it mutates anything, so 12 links by construction),
and *no spell is rotated more than four times in one spell action*. The engine's
`guard` is an assertion that must never fire.

**`resolveSide` takes the INDEX, not the orientation.** The printed corpus forces
it: `Rewind` II resolves *"the I of a friendly Spell, regardless of
orientation"*. Designed the other way round, that card is unimplementable, and
you find out at card ninety.

**`ops` never checks for matches; the action layer decides.** Printed `Precision`
I rotates a Spell *"to any side. Trigger no effects from it."* The moment a
second site decides for itself that a rotation implies a match check, that card
is impossible.

## Where this is most likely to break

**The chain crossing `pending`.** It mutates rotations, keywords, VP, ledger
counters, unit positions and in-flight falls, and every one must be reproducible
from snapshot plus recorded answers — which is why `field.pendingFalls` lives in
the state and why `state.replaying` has to stop a replay *writing* a view note
**and** stop a restore *resurrecting* one. Both halves; the second is the one
everyone forgets.

**Side-numeral misalignment.** `verify-faces --selftest` plants it, because
nothing else in the suite can see it.

**The field's determinism boundary.** One `Math.sqrt`, one float accumulated into
a `z`, one candidate list ordered by Set insertion, and lockstep dies while every
other tool reports green. Hence the grep as a build gate, `DIR64` instead of
trig, `z` always recomputed from `support`, and `sort()` at every iteration site.

## Not done yet

The **view layer**. Deferred deliberately, and the art direction is recorded in
the plan rather than guessed at here: Chaos Gate-style arena and characters,
luminous-ink sigil cards keeping the printed geometry, strict four-fold symmetry
once anything is drawn, and the four runes needing C4 rotational symmetry and
distinct *silhouettes* rather than distinct hues.
