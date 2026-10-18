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

> **No spell completes more than one full revolution during a chain.**

Four left turns return a spell to where it started, so further rotation is provably
pointless. This bounds *rotations* (which the link rule alone does not, since printed
`Defrinol Orb` rotates things without matching anything): at most 9 x 4 = 36.

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

Starting vocabulary, from your printed cards: `Inevitable, Crush, Stun, Unstable N,
Spell Mastery, Channel, Spell Bane, Counterspell, Consume, Reverse N, Ignore Height,
Absorb, Impact N, Move +N, Speed Cast, Trap`.

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
