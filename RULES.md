# WIZARD'S GAMBIT — rules

The authoritative spec. The engine implements this file and `tools/verify-faces.js`
judges every card's implementation against its printed text, so wording here is
load-bearing. Where a rule exists to make something provable, it says so.

---

## 1. Winning

First player to **15 Victory Points**.

| source | VP |
|---|---|
| a gold spell's objective | as printed on the face |
| killing the enemy mage | 2 — and the mage respawns |
| killing an enemy golem unit | 1 |

**Only gold spells award objective VP.** Faces of other schools may carry gates, but
never a payout. `def()` throws at load if a non-gold face declares an objective, so
this is structural rather than a convention.

---

## 2. The Spell Table

A 3x3 of cells, each with a colour. Cells are numbered row-major in the owner's frame.

```
 grey      RED      grey        0 1 2    red     attack
GREEN    PURPLE     BLUE        3 4 5    blue    the battlefield
 grey     GOLD      grey        6 7 8    green   the spell table
                                         purple  combining Keywords
                                         gold    turning work into VP
                                         grey    artifacts
```

- A spell may only be **played** onto a cell matching its school. One home cell per
  school; **artifacts** may be played onto any of the four grey corners.
- Each cell is a **stack**; only the top card is in play. (Printed: *"Play a Spell on
  top of this Spell."*)
- Three **golem slots** sit beneath cells 6, 7 and 8, so "the slot above this
  creature" is a real relation.

### What the geometry gives you for free

The 3x3 has a 4x4 lattice of 16 grid vertices. 4 outer corners touch one card and can
never match; 8 edge vertices touch two cards; 4 interior vertices touch four. So
there are **12 match sites**. Working out which vertices each cell touches:

| cell | interior | edge | dead |
|---|---|---|---|
| PURPLE (4) | **4** | 0 | 0 |
| RED / GREEN / BLUE / GOLD | 2 | 2 | 0 |
| each grey corner | 1 | 2 | 1 |

**Purple is the only cell touching all four interior vertices and no two-card
vertex**, and every interior vertex touches purple. The combo school is combo-only by
geometry, not by fiat. Gold is reachable from purple and from two grey corners —
contested, as intended. Verified by `tools/checkrotate.js`, not assumed.

---

## 3. Cards

A spell card is square and carries:

- **Four faces**, sides I–IV, **clockwise from the top edge**. **The face at the TOP
  is active.**
- **Four corner runes**, clockwise from the **top-left** corner. A rune is a glyph at
  a corner; a face is an effect on a side. They are independent.
- Card-level **[Keywords]**.
- **No cost.** Mana does not exist in this game.

`rot` counts **left** (counter-clockwise) quarter turns. A left turn carries the top
edge to the left and the top-left corner to the bottom-left — in both vocabularies,
position `k` → position `k-1`. So table position `p` holds whatever was authored at
index `(p + rot) mod 4`, for faces and corners alike, giving the identity the engine
leans on:

```
activeFaceIndex === rot
```

**A spell is played at `rot = 0`, so it always lands showing side I.**

A **right** turn exists only as a card effect (printed `Change` IV, `[Reverse]`). The
player's once-per-turn rotate action is left only, and a match's forced rotation is
left only.

---

## 4. A turn

**One spell action**, then the **Unit Phase**.

The spell action is exactly one of:

| action | match check? |
|---|---|
| **play** a spell, artifact or golem card | yes |
| **rotate** a friendly spell left | yes |
| **shift** a friendly spell to an adjacent cell | yes |
| **destroy** a friendly spell | no |
| **draw** a card | no |

Then, in the Unit Phase, **each friendly unit acts once**:

- **mage** — move, attack an adjacent enemy, or summon a golem unit adjacent to itself
- **golem unit** — move, or attack an adjacent enemy

### Rotation lock

A spell sitting on a cell that does **not** match its colour cannot be rotated
**voluntarily**. It got there by being shifted. **A match can still rotate it** — the
lock restrains the player, not the board.

A printed **prohibition** is different and stronger. *"You may not rotate this Spell
again this turn"* (printed `Fire Bolt` III) means it cannot be rotated at all, by any
means, including a match.

### Costs

Playing a card costs your spell action and nothing else. Every other cost is printed
inside a face, where your own cards already put them: *"Destroy a Spell you
control."*, *"You may discard a card. If you do, rotate this Spell left."*

---

## 5. THE MATCH RULE

Checked after a **play**, a **rotate**, or a **shift** — on the acting player's own
table.

Two or more of your cards meeting at one grid vertex, showing the **same rune** at
that vertex, **match**.

When they do:

1. **Choose one** of the matched cards.
2. **Rotate it left one step.** This is mandatory and happens even if the card is
   colour-locked.
3. **Resolve the effect of its newly showing face** — the one now at the top.

Only the chosen card rotates, and the card you rotate is the card you resolve.

The rotation is unconditional; the **effect** is conditional on its cost. If you
cannot or will not pay, the rotation stands and the effect fizzles. That is why a
chain can hurt you: you can be forced off a face you wanted.

### Chains

Resolving a face can rotate or shift things, producing new matches. The chain
continues as long as matches remain. Two rules bound it:

> **Each junction resonates at most once per chain.**

There are exactly 12 match sites, and a chain spends one previously-unspent vertex
per link **before** it mutates anything — including when nothing resolves. So a chain
is **at most 12 links, by construction**, no matter what the effects do. This is a
proof, not a safety guard; the engine's `guard` is an assertion that must never fire.

> **No spell is rotated more than four times in one spell action.**

Four left turns return a spell to where it started, so a fifth brings up a face that
has already been up. This bounds *rotations*, which the link rule alone does not,
since a rotation does not have to come from a match — printed `Defrinol Orb` rotates
things without matching anything. At most 9 x 4 = 36 rotations an action.

It counts rotation **events**, not quarter-turns. Printed `Precision` I — *"rotate a
Spell to any side"* — moves a card up to three quarter-turns at once, and counting
quarter-turns let a card that had already turned twice reach five and blow the cap.
Counting events is what bounds the loop anyway, since the loop is driven by how many
times a trigger fires.

If every card in a matched group is under a prohibition, the vertex is spent and
nothing happens.

### Keywords on a match

Once per link, you may **copy one Keyword** from one matched card to another. The copy
is offered **before** the effect resolves, so putting `[Ignore Height]` on a push
changes the push you are about to make. That is the point of the mechanic.

---

## 6. Keywords

Printed Keywords are **card-level**. Copied ones live on the **instance**. Granted
ones are **derived** (printed `Link`: *"the Spell to the left of this Spell has the
keywords of the Spell to the right of this Spell"*).

A spell's Keywords are recomputed on every query — printed, plus copied, plus
granted, minus lost — and **never written onto the card**. An instance's copied list
is sorted, unique, capped at 4, and cleared when the spell leaves the table.

Effects never test for a Keyword by hand. They build a descriptor and pass it through
one funnel, so a new Keyword works on every existing face the day it is registered:

- `[Ignore Height]` sets the height coefficient in a range check to zero. That is its
  entire implementation.
- `[Crush]` turns a push's blocked remaining travel into damage.
- `[Stun]` spends the target's action.
- `[Channel]` marks a unit as a **range origin**.

The implemented set is **fifteen**, each with exactly one hook and no exceptions:

| Keyword | what it does | hook |
|---|---|---|
| `[Ignore Height]` | range ignores height | `range` |
| `[Reach]` | range +1m | `range` |
| `[Impact]` | damage +1 | `damage` |
| `[Crush]` | a blocked push deals the travel it lost as damage | `push` |
| `[Levitate]` | a push ignores terrain | `push` |
| `[Stun]` | spends the target's action | `hit` |
| `[Poison]` | 1 damage at the start of the target's turns | `hit` |
| `[Absorb]` | takes 1 less damage | `incoming` |
| `[Swift]` | moves 1m further | `unitMove` |
| `[Channel]` | this unit is a range origin | `origin` |
| `[Inevitable]` | resolves even with its gate unmet | `gate` |
| `[Spell Mastery]` | may be rotated on any colour | `turnLock` |
| `[Spell Bane]` | may target enemy Spells | `targets` |
| `[Consume]` | destroying a friendly Spell for a cost also draws a card | `cost` |
| `[Unstable]` | deals 1 damage to a unit in range when destroyed | `onDestroy` |

The hook list is **closed**, and `tools/checkcorpus.js` checks every hook from
both ends: registered by a Keyword that is actually on a card, **and** called by
the engine. That second check is not decoration — three Keywords failed it on its
first run and did nothing whatsoever.

Printed Keywords not carried over, and why: `Counterspell` and `Trap` need a
replacement effect that can ask a question, which the replacement path
deliberately cannot do (it runs inside `hurt`, mid-mutation); `Speed Cast` and
`Reverse N` belong to the mana economy that no longer exists; `Move +N` became
`[Swift]` and `Unstable N` became `[Unstable]`, because a numeric parameter on a
Keyword name is a second axis the matcher would have to understand.

**Purple** reads the Keyword set as *input* rather than modifying it — scale by
distinct Keyword count, fuse a neighbour's Keywords, require two at once. Printed
`Spell Splice` (*"Resolve the effect of a friendly Spell, adding any [Keywords] from
adjacent Spells"*) is the archetype.

---

## 7. Gates and objectives

A **gate** is a precondition printed on a face: *"You may only rotate this Spell
if…"*. Not every spell has one. A gate is a pure predicate, recomputed, never stored.

**Gates restrict voluntary rotation and voluntary use only.** A forced rotation from a
match happens regardless, and a face whose gate is unmet resolves as **inert** —
nothing happens, no VP — but the rotation stands.

This is deliberate on four counts: it keeps the chain's termination proof intact (a
gate that could block a forced rotation forces a *skip*, which is exactly the shape
that reintroduces loops); it makes chains dangerous, as intended; it needs no extra
question at resolution time; and it hands the defender a real line, since resolving
the inert card on purpose is how you defuse a chain.

An **objective** is a gold face's payout. Objectives are **repeatable**, but scoring
**destroys the gold spell** and puts it in your discard — so you must wait to draw it
again. That round trip is the VP throttle; there is no artificial per-turn cap.

Gold converts the other schools' work into points, so what it reads must be counted
over time. Those counters live in one declared place per player (spells destroyed,
units pushed, kills, cards discarded, chain links, longest chain, …). The rule:

> **If it can be re-read off the board, it is derived. If it counts history, it is a
> counter.**

---

## 8. Units

### The mage

Hit points, moves, attacks adjacent enemies, summons golem units adjacent to itself,
and acts as a **range origin** for most spells.

When a mage dies the killer scores **2 VP**, and the mage **respawns at its owner's
own starting circle at the start of that owner's next turn**, at full hit points.

So dying costs 2 VP, a Unit Phase, all the ground you had taken, and — because the
mage is a range origin — the reach of much of your spell table. Feeding your mage to
the enemy is a real strategy and the design treats it as a measurable question:
`mageVp` and `mageVpDecay` are knobs and `tools/selfplay.js` reports VP from kills
against VP from objectives.

### Golems

A **golem card** occupies one of your three golem slots; its **units** stand on the
battlefield. The card is the source, the units are the bodies.

- **You may have only one of each golem type at a time** — no duplicate golem cards
  across your slots.
- A golem card's **tier** caps how many of its units may be on the battlefield at
  once:

| tier | simultaneous units |
|---|---|
| **A** | 1 |
| **B** | 2 |
| **C** | 3 |

- Your mage summons a unit of a golem card adjacent to itself during the Unit Phase,
  up to that cap.
- Killing a golem unit scores the killer **1 VP**.
- **A golem card that has been deployed at least once, and now has zero units on the
  battlefield, is destroyed and placed in your discard**, freeing its slot.

Golem cards are therefore consumable: an A-tier golem is one body and then it is
gone, while a C-tier can lose two and keep working. A card that has never deployed is
safe in its slot.

---

## 9. The battlefield

A small seeded arena. Distance is **continuous**, not squares, and measured in integer
millimetres so that replays and lockstep are exact.

- Real elevation: climbable faces, ledges, high ground.
- **Addressable terrain pieces**, because printed `Levitation` I removes one from the
  battlefield until end of turn.
- Pushable props, including floating rocks, which fall when they lose support.
- **Range is measured from your mage or one of your golem units** (printed
  `[Channel]` marks an origin), in three dimensions — which is what `[Ignore Height]`
  switches off.
- A printed "N squares" of push or movement becomes N metres of travel resolved
  against the terrain, so broken ground genuinely changes the outcome.

Every continuous target is offered to the player as a **finite, ordered option list**
(eight named push bearings, a sampled ring of landing points). The engine's question
vocabulary is finite even though the world is not.

---

## 10. The Spellbook

The Spellbook is **a record of the ways to get cards** — your accumulating knowledge
of the game, not an inventory and not a deck list.

- **You always start a match with your standard 10-spell deck.**
- Doing certain things during a match **finds** a card, which goes into your
  **discard pile** for the rest of that match.
- **Spells, artifacts and golems can all be found.**
- The Spellbook records which conditions produce which cards, so the more you play,
  the more of the game you know. It persists between matches; your starting deck does
  not change.

This is the system that took mana's place, so it is a first-class subsystem rather
than a late addition.

---

## 11. Clarifications settled while building the engine

These were not decided in advance. Each came out of the engine or a harness, and
each is recorded here because it changes how cards should be designed.

### Side I is the LAST face a chain reaches, not the first

A spell is played at `rot = 0`, so **side I is what it shows when it lands**, and
a match rotates **left**, which brings up **side II**. So from the moment a card
hits the table, II is one rotation away, III is two, IV is three, and **I needs a
full revolution to come back round**.

So side I is the card's resting state, and it is the right place for a
**passive** or a long-term objective rather than for the effect you are hoping to
chain into. Printed `Rewind` II — *"resolve the I of a friendly Spell, regardless
of orientation"* — exists precisely because side I is otherwise the hard one to
reach, which is a good sign the printed set already knew this.

### Drawing from an empty deck reshuffles the discard

Otherwise the game simply runs out: the standard deck is ten cards, there is no
draw step, and a gold objective deliberately sends its own card to the discard
every time it scores. The round trip through the discard **is** the VP throttle,
so the discard has to come back around.

### Rule B is per spell ACTION, not per chain, and counts events

"No spell is rotated more than four times" is scoped to the whole spell action,
because a rotation does not have to come from a chain. Two `Defrinol
Orb`s — *"after this Artifact is rotated, rotate a Spell left"* — rotate each
other through **queued triggers**, which run after a chain has already ended.
Each individual chain is perfectly well bounded and the pair would still
ping-pong forever. Scoped to the action, the fifth rotation of a card is refused
by `ops.turn`, which is the one function every rotation in the game passes
through.

### A rotation from a queued trigger starts a NEW chain

Resolving a face can rotate things, and the live chain loop rescans and picks
those up. But a **listener may only queue, never resolve**, so a trigger runs
after its chain has ended. Any work item that leaves a table changed therefore
queues a chain for that table — and only for the **acting player's** table, so
your effect moving an enemy spell never hands your opponent a mandatory chain on
your own turn.

### A face's gate is tested at two moments

Printed as *"you may only rotate this Spell if…"* on one face, and it does two
things from that one declaration:

- while that face is **active**, it blocks the player's **voluntary** rotation of
  the card — the engine simply does not offer it;
- when that face **resolves**, an unmet gate makes it **inert** — nothing
  happens, no VP — and the rotation that brought it up still stands.

A **prohibition** (*"you may not rotate this Spell again this turn"*) is
stronger: it stops the rotation itself, so the matched junction is spent and
nothing at all happens.

### The three questions the plan left open, now answered

**Playing a golem card or an artifact is a full spell action.** `play` covers
spells, artifacts and golem cards alike, which keeps the one-action-per-turn rule
absolute and makes developing your golem line genuinely expensive.

**Summoning spends the mage's whole Unit-Phase action.** It is one of the mage's
three options, not a free extra, so a summoning mage neither moves nor strikes
that turn.

**Artifacts and golem cards sit inside the ten.** The standard deck is ten cards
and that is the whole deck: eight spells, one artifact, one golem card. There are
no separate piles. So choosing to spend your one action putting a golem card into
a slot is also choosing not to develop your table that turn.

**A found card arrives once per match, one copy.** The condition can only pay out
once per duel, and the card goes to your discard — not your hand, so you still
have to draw it.

### Golem cards are not four-sided

A golem card never sits on a cell, never rotates and never matches, so it has no
faces and no corner runes — the schema refuses to let one be authored with them.
It is a statline and a tier. Three quarters of a four-sided golem would be
unreachable by construction.
