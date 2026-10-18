#!/usr/bin/env node
// Milestone 1 gate: the integer math layer and the seeded generator.
//
//   node tools/checkmath.js

import * as F from '../js/field/fixed.js';
import * as R from '../js/rules/rng.js';

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, 0) : (fail++, console.log('  FAIL ' + m)));
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${m}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

console.log('integer division');
eq(F.idiv(7, 2), 3, 'idiv(7,2)');
eq(F.idiv(-7, 2), -4, 'idiv(-7,2) FLOORS (|0 would give -3 and break symmetry)');
eq(F.idiv(-8, 2), -4, 'idiv(-8,2)');
ok(F.idiv(-1, 2) === -1, 'idiv(-1,2) === -1');

console.log('isqrt');
eq(F.isqrt(0), 0, 'isqrt(0)');
eq(F.isqrt(1), 1, 'isqrt(1)');
eq(F.isqrt(2), 1, 'isqrt(2) floors');
eq(F.isqrt(1000000), 1000, 'isqrt(1e6)');
let mono = true;
for (let n = 0; n < 5000; n++) {
  const s = F.isqrt(n);
  if (s * s > n || (s + 1) * (s + 1) <= n) mono = false;
}
ok(mono, 'isqrt(n) is the exact floor of the real root for n in [0,5000)');

console.log('distance and the [Ignore Height] coefficient');
const a = { x: 0, y: 0, z: 0 }, b = { x: 3000, y: 4000, z: 12000 };
eq(F.dist2(a.x, a.y, b.x, b.y), 25000000, 'dist2 is 5m squared');
eq(F.dist3(a, b, 1), 25000000 + 144000000, 'dist3 includes the height term');
eq(F.dist3(a, b, 0), 25000000, 'heightK 0 removes it -- this IS [Ignore Height]');
ok(!F.within(a, b, F.mm(6), 1), '13m away in 3D is outside a 6m range');
ok(F.within(a, b, F.mm(6), 0), 'but inside it once height is ignored');
ok(F.within(a, { x: 6000, y: 0, z: 0 }, F.mm(6)), 'exactly at range is INSIDE (<=)');

console.log('directions, with no trig at runtime');
eq(F.DIR64.length, 64, '64 entries');
ok(F.DIR64.every(([x, y]) => Number.isSafeInteger(x) && Number.isSafeInteger(y)),
  'every component is an integer literal');
// x is EAST, y is NORTH. Mislabelling this leaves distances correct and every
// push prompt in the game wrong, so it is asserted rather than commented.
const named = Object.fromEntries(F.COMPASS.map((c) => [c.name, F.DIR64[c.dir]]));
eq(named.E, [1024, 0], 'E is +x');
eq(named.N, [0, 1024], 'N is +y (y is north, NOT screen coords)');
eq(named.W, [-1024, 0], 'W is -x');
eq(named.S, [0, -1024], 'S is -y');
eq(F.bearing(0, 0, 0, 500), F.COMPASS.find((c) => c.name === 'N').dir, 'bearing north agrees with COMPASS');
for (let d = 0; d < 64; d++) {
  const [x, y] = F.DIR64[d], [ox, oy] = F.DIR64[F.opposite(d)];
  ok(Math.abs(x + ox) <= 1 && Math.abs(y + oy) <= 1, `opposite(${d}) negates it`);
}
eq(F.step(0, 0, F.COMPASS.find((c) => c.name === 'N').dir, F.mm(4)), { x: 0, y: 4000 },
  'a 4m push north lands 4000mm north');

console.log('seeded generator');
const r1 = R.seedRng(1337), r2 = R.seedRng(1337);
const draw = (r, n) => Array.from({ length: n }, () => R.next(r));
eq(draw(r1, 8), draw(r2, 8), 'same seed, same stream');
ok(R.seedRng(0).some((w) => w !== 0), 'seed 0 does not produce the degenerate all-zero state');
const r3 = R.seedRng(0);
ok(draw(r3, 20).every((v) => v >= 0 && v < 1), 'seed 0 still yields values in [0,1)');
// The property the effect driver depends on: the dice are plain data, so a
// snapshot and restore reproduces the stream exactly.
const r4 = R.seedRng(99);
draw(r4, 5);
const snap = R.save(r4);
const after = draw(r4, 6);
R.load(r4, snap);
eq(draw(r4, 6), after, 'save/restore replays the identical stream (the driver needs this)');
ok(JSON.stringify(R.seedRng(1)) !== JSON.stringify(R.seedRng(2)), 'different seeds differ');

console.log('shuffle');
const r5 = R.seedRng(7), r6 = R.seedRng(7);
const l1 = R.shuffle(r5, [...Array(40).keys()]);
const l2 = R.shuffle(r6, [...Array(40).keys()]);
eq(l1, l2, 'same seed, same permutation');
eq([...l1].sort((p, q) => p - q), [...Array(40).keys()], 'shuffle is a permutation, loses nothing');
let moved = 0;
for (let s = 0; s < 50; s++) {
  const l = R.shuffle(R.seedRng(s), [...Array(20).keys()]);
  if (l.some((v, i) => v !== i)) moved++;
}
ok(moved >= 49, 'shuffle actually shuffles across seeds');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
