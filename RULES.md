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
- **A cell holds one card.** Cards never stack: a home cell that is taken must be
  cleared (shifted aside or destroyed) before that school can play again, and a shift
  only goes into an empty neighbouring cell.
- Three **golem slots** sit beneath cells 6, 7 and 8, so "the slot above this
  creature" is a real relation.

### What the geometry gives you for free

The 3x3 has a 4x4 lattice of 16 grid vertices. 4 outer corners touch one card and can
never match; 8 edge vertices touch two cards; 4 interior vertices touch four. Cards
match only with **orthogonal neighbours**, at the two corners that touch across the
shared edge — 12 adjacent pairs, two touching corners each, so **24 match sites**.
Working out which vertices each cell touches:

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

**A spell is played at `rot = 0`, so it always lands showing side I — and playing
it resolves side I**, the same way a rotation resolves the face it brings up.

### How a card is built: side IV is the payoff

Every spell has a **theme**, and its four faces climb toward **side IV, the most
powerful face on the card**. Sides I–III are the build-up: a weaker version of the
payoff, a step that makes you **pay** — discard a card, destroy one of your other
spells, mill your deck, rotate another spell, spend a unit's action, wound your own
mage — or a setup effect. Since a card lands on I and every left turn moves it one
face on, I → II → III → IV is literally the order you reach them in, so a card plays
like a ritual you charge up. Most spells, but not all, carry at least one such cost.

The payoffs are where the arena's physics live: Levitation IV drops a rock on an
enemy, Grave Well IV throws one into the air and lets the fall do the damage, Stone
Tide IV is a quake that throws back friend and foe alike, Fulcrum IV swaps two
units, Time Warp IV turns every other spell you own right, Grove Keeper IV turns them
all left, Confluence IV resolves the face showing on every other spell you control.

A **right** turn exists only as a card effect (`Precision` I, `Time Warp` I and IV). The
player's once-per-turn rotate action is left only, and a match's forced rotation is
left only.

---

## 4. A turn

The **Unit Phase** first, then **one spell action**. Units move before spells so
the spell is cast from where your mage now stands.

The spell action is exactly one of:

**Every turn begins with a draw** — except the very first turn of the duel, which is
how going first is paid for. Drawing is not an action.

| action | what happens |
|---|---|
| **play** a spell, artifact or golem card | **its top face (side I) resolves**, then the match check |
| **rotate** a friendly spell left | **its new top face resolves**, then the match check |
| **shift** a friendly spell to an adjacent cell | then the match check |
| **destroy** a friendly spell | — |
| **take no spell action** | — |

Rotating your own spell does something every time: the face it turns up resolves
(gate, cost, objective, effect — exactly as if a match had turned it), and only then
is the table checked for matches, which may chain as usual.

Before that, in the Unit Phase, **each friendly unit acts once**:

- **mage** — move, attack an adjacent enemy, or summon a golem unit adjacent to itself
- **golem unit** — move, or attack an adjacent enemy

**A move goes anywhere the unit can actually walk to within its move distance** (with
passives and keywords applied) — not to a set of chosen spots. The unit walks straight
for the point. A spot the straight walk cannot reach — behind a wall, up a cliff it
cannot climb, through another body — is not a legal move at all, and the lit shape on
the ground is exactly the walk's real reach, not a plain circle.

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

Two of your cards that are **orthogonally adjacent** (sharing an edge, never
diagonal) **match** when the corners that touch across that edge show the **same
rune**. A wild corner matches any rune.

**Only a card that just changed can set off a match.** The card you played, rotated
or shifted — and, inside a chain, every card the chain turns — is *fresh*; a site
fires only if one of its two cards is fresh. Two cards that have sat matching since
an earlier turn do not fire again every time something else on the table moves.

When a match fires:

1. **The other card turns** — the matched neighbour of the card that changed.
2. **It rotates left one step.** This is mandatory and happens even if the card is
   colour-locked.
3. **Resolve the effect of its newly showing face** — the one now at the top.
4. **Then that card's own matches run** — depth-first, to exhaustion — before you
   come back to the original card and look at its remaining corners (with whatever
   it shows now; an effect in between may have turned it).

Only the matched neighbour rotates, and the card that rotates is the card you
resolve. If a card matches several neighbours, you choose the order.

**Every rotation resolves.** A face that says "rotate a Spell left" turns that spell,
resolves its new face, and chains its matches, exactly as a match would — the one
exception is a face printed "trigger no effects from it" (Precision IV).

The rotation is unconditional; the **effect** is conditional on its cost. If you
cannot or will not pay, the rotation stands and the effect fizzles. That is why a
chain can hurt you: you can be forced off a face you wanted.

### Chains

Resolving a face can rotate or shift things, producing new matches. The chain
continues as long as matches remain. Two rules bound it:

> **Each junction resonates at most once per chain.**

There are exactly 24 match sites (a corner touching a corner across a shared edge),
and a chain spends one previously-unspent site per link **before** it mutates
anything — including when nothing resolves. So a chain is **at most 24 links, by
construction**, no matter what the effects do. This is a proof, not a safety guard;
the engine's `guard` is an assertion that must never fire.

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
- `[Crush]` doubles a push's impact damage.
- `[Stun]` spends the target's action.
- `[Channel]` marks a unit as a **range origin**.

The implemented set is **fifteen**, each with exactly one hook and no exceptions:

| Keyword | what it does | hook |
|---|---|---|
| `[Ignore Height]` | range ignores height | `range` |
| `[Reach]` | range +1m | `range` |
| `[Impact]` | damage +1 | `damage` |
| `[Crush]` | its impacts deal double damage | `push` |
| `[Levitate]` | a push ignores terrain | `push` |
| `[Stun]` | spends the target's action | `hit` |
| `[Poison]` | 1 damage at the start of the target's turns | `hit` |
| `[Absorb]` | takes 1 less damage | `incoming` |
| `[Swift]` | moves 1m further | `unitMove` |
| `[Channel]` | this unit is a range origin | `origin` |
| `[Inevitable]` | your opponent cannot destroy it | `destroy` |
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

The second count is not theoretical. `tools/selfplay.js` counts how often a chain
forces somebody onto a face whose gate is unmet: about **7 times a match** with
sixty-card decks, against 0.3 with the gate-light standard deck. So the more
gated your table, the more a mandatory chain costs you — which is the pressure
the rule was written to create.

An **objective** is a gold face's payout. Objectives are **repeatable**, but scoring
**destroys the gold spell** and puts it in your discard — so you must wait to draw it
again. That round trip is the VP throttle; there is no artificial per-turn cap.

**Objectives are hard on purpose.** Three rules make them so:

- **Progress is counted since the card was played.** *"After 20 rotations since this
  was played…"* reads the counter's growth since this gold card hit the table, so a
  payout needs fresh work every time the card comes back round. (With lifetime
  counters, one standard-deck face paid out about twice a game, forever.)
- **The objective's condition is checked before its cost.** An unmet condition makes
  the face inert and nothing is paid; the cost is the price of scoring, not a trap.
- **No keyword waives a gate or an objective's condition.** [Inevitable] protects
  the CARD from the opponent's destruction; it says nothing about the effect.
  (An earlier draft had it waive gates; copied onto a gold card by a match, that
  turned every objective into free points.)

And each gold card keeps its **biggest objective on side IV**.

Gold converts the other schools' work into points, so what it reads must be counted
over time. Those counters live in one declared place per player (spells destroyed,
units pushed, kills, cards discarded, chain links, longest chain, …). The rule:

> **If it can be re-read off the board, it is derived. If it counts history, it is a
> counter.**

---

## 8. Units

### The mage

**5 life**, unless an active **passive** raises it (Ward Lantern II: *"Your mage has
+2 life"*). Gaining the bonus gives that much life; losing it takes that much away,
never below 1 — turning a card away cannot kill your own mage. Moves 3m, attacks
adjacent enemies, summons golem units adjacent to itself, and acts as a **range
origin** for most spells.

When a mage dies the killer scores **2 VP**, and the mage **respawns at its owner's
own starting circle at the start of that owner's next turn**, at full hit points.

So dying costs 2 VP, a Unit Phase, all the ground you had taken, and — because the
mage is a range origin — the reach of much of your spell table. Feeding your mage to
the enemy is a real strategy and the design treats it as a measurable question:
`mageVp` and `mageVpDecay` are knobs and `tools/selfplay.js` reports VP from kills
against VP from objectives.

**Measured after the rules of 2026-10-18** (rotation resolves, a draw every turn,
5-life mages, hard gold): over 100 AI games with the standard deck a duel lasts
**44 turns** and VP comes **42% objectives / 30% mages / 27% golems** -- about
5.4 objective payouts a game between both players, the first usually around turn
16. With random sixty-card decks: 60 turns, **50% / 42% / 8%**. So killing now
outscores gold, because a 5-life mage dies three or four times a match. That is
the trade the 5-life rule makes, and `mageVpDecay` (or a smaller kill reward) is
the knob if objectives should lead again.

### Golems

A **golem card** occupies one of your three golem slots; its **units** stand on the
battlefield. The card is the source, the units are the bodies.

- **Each tier has its own slot.** Slot A (beneath cell 6) holds an A-tier card,
  slot B (cell 7) a B-tier, slot C (cell 8) a C-tier. A golem card can only be
  played into the slot of its tier, so you field at most one of each tier — and
  never two of the same golem.
- The **better golems are the higher tiers**: an A-tier is a single giant with the
  biggest statline, a C-tier is a swarm of small bodies. The tier caps how many
  of the card's units may be on the battlefield at once:

| tier | slot | simultaneous units | what it is |
|---|---|---|---|
| **A** | under cell 6 | 1 | the giant: most hit points and damage |
| **B** | under cell 7 | 2 | the warden class |
| **C** | under cell 8 | 3 | the swarm: cheap bodies |

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

### Everything on the field can be affected

Nothing on the battlefield is scenery. Every terrain piece — boulder, standing stone,
crystal shard, ruined wall, floating rock, tree — has **mass**, **hit points** and a
**material**, and the rules treat all of them the same way:

| piece | mass | hp | notes |
|---|---|---|---|
| crystal shard | 1 | 2 | flies when pushed; lightning bursts it outright |
| floating rock | 1 | 3 | held up by magic; whoever stands on it rides along when it is shoved |
| boulder | 2 | 4 | can be stood on and climbed |
| tree | 3 | 3 | **burns** |
| standing stone | 4 | 5 | a quake can crack it |
| wall | 6 | 6 | slides a hand's width, but it slides |

- **Pushed:** a push has a **force** (1–8) and a **direction you drag**. A body of
  mass *m* slides `force × 0.75m / m`: a mage (mass 1) the whole way, a boulder half,
  a standing stone a quarter, a wall a sixth. Golem units weigh their tier: A 3, B 2,
  C 1.
- **Impacts:** when a slide is stopped early, what is left of it is energy — mass ×
  remaining travel — and **both** the moving body and whatever stopped it take
  `energy / 1.5m` damage. Heavier things hit harder; things stopped sooner hit harder.
  Whatever was struck is shoved on with the leftover momentum, so a thrown mage can
  knock a golem into a pillar. A unit that takes 2+ from an impact is **knocked down**
  and loses its action this turn. `[Crush]` doubles impact damage.
- **Toppled:** a tall piece (standing stone, tree) pushed with enough force — or hit
  hard enough — **falls over along the push**, dealing 2 to every unit under its
  length, and is gone.
- **Smashed:** a piece at 0 hp **shatters** and is gone for good; whatever stood on it
  falls.
- **Burned:** fire faces light anything made of wood. A burning piece **bites at the
  start of every turn** (1 damage to every unit within 0.9m of its edge, whichever side
  it is on, credited to whoever lit it), **spreads** to wood within 1.2m, and after its
  second bite burns away to nothing. Fire takes no sides.
- **Elements.** A face declares what it does to terrain, and the engine applies it in
  one place (`ctx.sweep`), so no card has to know what wood is:
  - **fire** (Ember Lash, Cinder Rain, Firebrand, Ash Wraith): lights wood in the blast.
  - **lightning** (Storm Brand): lights wood and bursts crystal.
  - **force** (Shift, Thornwall's nova, Stone Tide's quake, Undertow's vortex, slams):
    throws every piece in reach the same way it throws units, and cracks it.

The arena kinds now include a **grove**, a stand of trees where fire is the game.
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

### Side I resolves when the card is played, and is the LAST face a chain reaches

A spell is played at `rot = 0`, so **side I is what it shows when it lands, and
playing the card resolves side I** — the play is the first rotation's worth of
effect, for free. A match rotates **left**, which brings up **side II**. So from
the moment a card hits the table, II is one rotation away, III is two, IV is
three, and **I needs a full revolution to come back round**.

So side I is the card's arrival effect and then its resting state: a small
effect on the way in, and the right place for a **passive** while it sits there
-- and side IV, three left turns away, is where the payoff goes (section 3).
Printed `Rewind` II — *"resolve the I of a friendly Spell, regardless of
orientation"* — exists precisely because side I is otherwise the hard one to
reach again, which is a good sign the printed set already knew this.

### Drawing from an empty deck reshuffles the discard

Otherwise the game simply runs out: the standard deck is ten cards, you draw one
every turn, and a gold objective deliberately sends its own card to the discard
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
