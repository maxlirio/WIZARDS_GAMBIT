# WIZARD'S GAMBIT

The digital version of the printed card game. A duel between two wizards: a 3x3
**Spell Table** of four-sided rotating cards, and a small seeded arena where the
distances are real.

**[RULES.md](RULES.md) is the authoritative spec.** It is the only place this
game's rules exist as text, and the engine implements it.

## Play it in a browser

```sh
python3 tools/serve.py 8321        # then open http://localhost:8321
```

`index.html` + `js/view/` is the whole UI. The battlefield fills the screen: a
real place on land — ground that keeps going to the hills, a forest, a sky with
a sun in it — and a glowing **ward line** with standing stones marking the
16m x 12m where the duel is actually fought. Your Spell Table sits bottom-left,
the enemy's top-right, your hand (big enough to read) along the bottom, and the
**turn-flow strip** at the top says what you are doing now: draw → units →
spell action → end turn. Every control sits next to what it acts on: click one of
your spells and a popover beside its cell offers rotate (with the face it would
turn to, its reach, and how many enemies are in range), shift and destroy;
click a unit and the tray offers strike, summon and hold, while the blue shape
on the ground shows exactly where it can walk (what a wall or a cliff cuts off is
not lit). When a card asks a
question, the answers glow on the table or the field and are listed under the
question. Hover anything to read it in the inspector; right-click a table card to
see it big. Pushes are rigid-body motion: boulders roll, fly off edges and land on people. **Tab** hides the panels,
**H** homes the camera, **Esc** cancels.

The mage is an original character built and rigged in code (`js/view/mage.js`:
a full skeleton, every animation authored as keyframes — walking, casting,
flinching, burning, being shocked, being crushed, thrown, falling, dying, getting
up); golems are built out of rock and animated the same way; fire burns,
lightning arcs, quakes shake the camera, and
every rock, stone, crystal, wall and tree on the field is something a spell can
throw, crack or set alight (see `RULES.md` §9). **Traps** (`RULES.md` §12) are
grey cards set face down into a corner that spring on their own during the
opponent's turn — an Earth Wall heaves dirt up in front of your mage and takes
the fireball instead. URL options: `?seed=N`,
`?watch` (two AIs), `?pool` (random decks from the whole corpus), `?ai=greedy|random`,
`?fast` (no pauses between enemy steps), `?room=CODE` (join an online room).
Graphics quality is in the New-duel dialog.

**Playing a friend:** *Play online* → *Host a room* gives you a four-letter code;
the other player enters it (or opens the `?room=CODE` link). Both browsers run
the same deterministic engine and only decisions cross the wire (PeerJS data
channels, no server of ours); the state hash is compared after every move, so a
desync is reported the moment it happens. The host starts each duel and sits in
seat 0; the guest sees the field from the other end. The live build is at
https://maxlirio.github.io/WIZARDS_GAMBIT/ — it is served straight from `main`,
so pushing is deploying.

The view drives the engine exactly as `tools/duel.js` does — `legalActions`,
`apply`, `choose` — so it cannot offer a move the rules would refuse. Where a
move ends is asked of the engine on a cloned state, never guessed. `js/view` is
the one part of `js/` allowed `Math.*`: nothing it computes feeds back.

`tools/browsercheck.mjs` drives the real page in headless Chrome: plays a card
by clicking, moves by clicking a marker, answers a prompt, plays a whole match
through the page, and fails on any page error or horizontal overflow.
Screenshots land in `--shots DIR`.

The engine was built before the first pixel on purpose, because a four-sided
card whose third face is implemented under the wrong numeral does not crash,
violates no invariant, and leaves a perfectly legal game state — and it is
invisible behind a renderer.

## Watch a game

```sh
node tools/duel.js --seed 7                 # two AIs, narrated, with the board drawn
node tools/duel.js --seed 7 --pool          # random decks from the whole corpus
node tools/duel.js --seed 7 --quiet         # just the result
node tools/duel.js --seed 7 --to 20         # stop after turn 20
node tools/duel.js --human 0                # YOU play, against the AI
```

The human seat goes through `legalActions` and `choose` exactly as the bot does,
which is the point: there is no second copy of the rules anywhere, so you cannot
be offered a move the engine would refuse, and it cannot have one it forgot to
offer. Type a number, `?` for your hand with all four faces of every card, `q`
to resign.

With `--human` it also keeps a **Spellbook** at
`~/.wizards-gambit-spellbook.json` (or `--book <path>`): which cards' sigils you
have bound, so their shapes can be shown. Type `b SH. .H.` (rows of S/H/W/L
and `.`) to lay runes from your pouch and bind, once a turn. That file is the only thing that
persists between matches — your starting deck is the same ten cards in your
first match and your thousandth. It lives in the tool rather than the engine on
purpose: if the engine knew about it, a replay could depend on what the player
happens to have learned, and two machines in a lockstep game would diverge on a
difference between their save files.

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
| `checkcorpus` | every gate, cost, Keyword, VP formula, event and motif is on a card — or declared reserved with a reason |
| `checkshop` | coins, pack odds and the measured power tiers; a pack never sells a sigil you know, never charges on a refusal |
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
node tools/ratecards.js --games 800 --workers 3 --write   # rank every card by deck win rate -> spells/rarity.js
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
  sigils.js learn.js   the Spellbook: the rune pouch, the bind action and the 75 sigils that find cards
  shop.js              coins paid by a finished duel, and the packs that buy a sigil into the Spellbook
  spells/rarity.js     every findable card's power tier, measured by tools/ratecards.js
  spells/              the corpus, one file per school (84 cards, 293 faces)
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

## Adding a card

Most faces are one line, which is the whole answer to scaling to hundreds of
spells. A face is authored **by printed numeral**, never by array index.

```js
card({
  id: 'ASH_VEIL', name: 'Ash Veil', school: 'red',
  keywords: ['Crush'],
  runes: [SHARD, SHARD, WHEEL, LATTICE],   // clockwise from TOP-LEFT
  sigil: ['HH', 'W.'],                     // the shape of runes that FINDS it (S/H/W/L), as drawn; 4 for a spell
  I:   { text: 'Deal 2 damage to an enemy unit within 3m.', ...M.damage({ amount: 2, range: 3000 }) },
  II:  { text: 'Push an enemy unit within 3m 2m away.',     ...M.pushAway({ mm: 2000, range: 3000 }) },
  III: { text: 'Destroy a Spell you control. Draw a card.', ...M.destroyASpell({ side: 'friendly', then: 'draw' }) },
  IV:  { text: 'Your damage is increased by 1.',            ...M.passiveDamage({ n: 1 }) },
});
```

Then run `tools/check.sh --quick`. It will tell you, at load time or in a
harness, if: a numeral is missing, a face key is misspelled, a non-gold face
declares an objective, the four runes are identical (which means all four faces
do the same kind of work — a card with one idea on it), the rune distribution
has drifted off 25%, a gate names a counter that does not exist, two cards share
a sigil or one sigil contains another, a passive writes a bucket it
did not declare, the printed text and the code disagree, or a Keyword you used
has a hook the engine never calls.

Two things the harnesses taught about writing these, both from real failures:

- **Say which side you mean.** "Deal 2 damage to a unit within 3m" cannot be
  checked, because the checker cannot tell whether hitting your own side is a
  bug. "to an **enemy** unit" can.
- **Side IV is the end of the road.** A card lands showing I and a match rotates
  left, so a permanent prohibition on III makes IV unreachable — a 400-game
  sweep found exactly one face in the corpus that never resolved, and that was
  why.

Faces are authored **clockwise from the top edge** and runes **clockwise from
the top-left corner**, matching the printed card. A spell lands showing side I
**and playing it resolves side I**; a match rotates **left** — so side II is the
first face a chain can reach and side I the last. Side I is the card's arrival
effect and then its resting state, and the right place for a passive.

## The four decisions everything hangs off

**The chain is an effect, not a loop.** It asks questions, so it parks on
`state.pending` as a pre-effect snapshot plus the answers so far, and replays
from that snapshot on every answer — like any card. All of its bookkeeping is
therefore plain serialisable data on `state.chain`.

**Termination is structural, not a guard.** Two real rules, each teachable in a
sentence: *each junction resonates at most once per chain* (24 corner-contact
sites between orthogonal neighbours, and a chain spends one **before** it mutates
anything, so 24 links by construction),
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

## The view, file by file

```
js/view/
  main.js              the HUD and the game loop: drives the engine, turns fx notes into a timeline of cues
  arena3d.js           the battlefield: camera, picking, rings, markers, and the cue -> effect mapping
  world.js             the land beyond the ward: terrain, sky, sun, grass, forest, the ward line
  props.js             the terrain pieces, drawn (boulder, standing stone, crystal, wall, floater, tree)
  mage.js              the mage: skeleton, skinned body, every animation clip, team colours, the staff orb
  net.js               online play: room codes over PeerJS, moves + state hashes, in-order delivery
  golems.js            golems assembled from rock and animated procedurally
  fx.js                particles, bolts, lightning, rings, debris, decals, camera shake
  assets.js            GLB loading, cloning, LOD picking
  cards.js             the SVG cards (the printed geometry, luminous ink)
assets/models/         this author's own HIGHGROUND tree/bush/boulder bakes (see assets/CREDITS.md); no third-party models
tools/lab/             one page per module to look at it alone, with a headless screenshot script
```

Art direction: Chaos Gate-style battlefield and characters, luminous-ink sigil
cards keeping the printed geometry, strict four-fold symmetry on anything drawn
on a card, and the four runes with C4 rotational symmetry and distinct
*silhouettes* rather than distinct hues.
