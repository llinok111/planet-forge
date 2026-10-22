/**
 * Core geometry and noise tests.
 *
 * These run in Node with no DOM and no WebGL, which is why the generation pipeline
 * is kept free of three.js imports: reproducibility and topology can then be
 * verified headlessly and in CI.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIcosphere, buildAdjacency } from '../src/icosphere.js';
import { createNoise3D, fbm3, ridged3, mulberry32, warp3 } from '../src/noise3d.js';
import { deriveSeed, hashString, STREAMS } from '../src/seed.js';

// ------------------------------------------------------------------ icosphere --

test('icosphere: vertex and triangle counts match 10*4^L+2 / 20*4^L', () => {
  for (let level = 0; level <= 6; level++) {
    const g = createIcosphere(level);
    assert.equal(g.vertexCount, 10 * 4 ** level + 2, `vertex count at L${level}`);
    assert.equal(g.triangleCount, 20 * 4 ** level, `triangle count at L${level}`);
  }
});

test('icosphere: Euler characteristic is 2 at every level (closed manifold)', () => {
  for (let level = 0; level <= 5; level++) {
    const g = createIcosphere(level);
    const edges = (g.triangleCount * 3) / 2;
    assert.equal(g.vertexCount - edges + g.triangleCount, 2, `Euler characteristic at L${level}`);
  }
});

test('icosphere: every vertex lies exactly on the unit sphere', () => {
  const g = createIcosphere(5);
  let worst = 0;
  for (let i = 0; i < g.vertexCount; i++) {
    const r = Math.hypot(g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]);
    worst = Math.max(worst, Math.abs(r - 1));
  }
  assert.ok(worst < 1e-9, `max radial error ${worst}`);
});

test('icosphere: adjacency is exact — 2E entries, no holes, no self-loops, no duplicates', () => {
  for (const level of [1, 3, 5]) {
    const g = createIcosphere(level);
    const edges = (g.triangleCount * 3) / 2;
    assert.equal(g.adjacency.length, edges * 2, `adjacency size at L${level}`);
    for (let v = 0; v < g.vertexCount; v++) {
      const start = g.adjacencyOffsets[v];
      const end = g.adjacencyOffsets[v + 1];
      const seen = new Set();
      for (let k = start; k < end; k++) {
        const nb = g.adjacency[k];
        assert.ok(nb >= 0 && nb < g.vertexCount, `neighbour out of range at L${level} v${v}`);
        assert.notEqual(nb, v, `self-loop at L${level} v${v}`);
        assert.ok(!seen.has(nb), `duplicate neighbour at L${level} v${v}`);
        seen.add(nb);
      }
    }
  }
});

test('icosphere: adjacency is symmetric', () => {
  const g = createIcosphere(3);
  for (let v = 0; v < g.vertexCount; v++) {
    for (let k = g.adjacencyOffsets[v]; k < g.adjacencyOffsets[v + 1]; k++) {
      const nb = g.adjacency[k];
      let back = false;
      for (let j = g.adjacencyOffsets[nb]; j < g.adjacencyOffsets[nb + 1]; j++) {
        if (g.adjacency[j] === v) { back = true; break; }
      }
      assert.ok(back, `edge ${v}->${nb} has no reverse`);
    }
  }
});

test('icosphere: buildAdjacency ignores duplicate triangles', () => {
  // Triangles (0,1,2) and (1,3,2) share edge (1,2). The unique edge set is
  // {(0,1),(1,2),(2,0),(1,3),(3,2)} = 5 edges, so 10 directed entries.
  // A duplicated triangle must not add entries.
  const indices = new Uint32Array([0, 1, 2, 0, 1, 2, 1, 3, 2]);
  const { neighbors, offsets } = buildAdjacency(indices, 4);
  assert.equal(neighbors.length, 10, 'five unique edges => ten directed entries');
  assert.equal(offsets[4], 10);
  // Vertex 2 is adjacent to 0, 1 and 3 (three neighbours), not four.
  assert.equal(offsets[3] - offsets[2], 3);
});

// ---------------------------------------------------------------------- noise --

test('noise3d: same seed gives the same field, different seeds diverge', () => {
  const a = createNoise3D(1234);
  const b = createNoise3D(1234);
  const c = createNoise3D(1235);
  let identical = 0;
  let differing = 0;
  for (let i = 0; i < 400; i++) {
    const x = Math.sin(i * 1.7) * 3;
    const y = Math.cos(i * 2.3) * 3;
    const z = Math.sin(i * 0.9 + 1) * 3;
    if (a(x, y, z) === b(x, y, z)) identical++;
    if (Math.abs(a(x, y, z) - c(x, y, z)) > 1e-9) differing++;
  }
  assert.equal(identical, 400, 'same seed must reproduce bit-for-bit');
  assert.ok(differing > 380, `different seeds must diverge, only ${differing}/400 differed`);
});

test('noise3d: range is inside [-1, 1] and roughly zero-centred', () => {
  const n = createNoise3D(7);
  let min = Infinity, max = -Infinity, sum = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const x = ((i * 0.6180339887) % 1) * 20 - 10;
    const y = ((i * 0.7548776662) % 1) * 20 - 10;
    const z = ((i * 0.4142135623) % 1) * 20 - 10;
    const v = n(x, y, z);
    min = Math.min(min, v);
    max = Math.max(max, v);
    sum += v;
  }
  assert.ok(min >= -1.0001 && max <= 1.0001, `range [${min}, ${max}]`);
  assert.ok(Math.abs(sum / N) < 0.03, `mean ${sum / N} should be near zero`);
});

test('noise3d: no exact zeros at lattice coordinates (offset applied)', () => {
  // 3D simplex is identically zero on integer lattice points; the sampler shifts
  // the domain so a sphere sample can never land there.
  const n = createNoise3D(99);
  for (const p of [[1, 2, 3], [0, 0, 0], [1.5, 2.5, 3.5], [-4, 5, -6]]) {
    assert.ok(Math.abs(n(...p)) > 1e-6, `lattice point ${p} returned ${n(...p)}`);
  }
});

test('noise3d: fbm and ridged stay in range and vary', () => {
  const n = createNoise3D(3);
  let fmin = Infinity, fmax = -Infinity;
  let rmin = Infinity, rmax = -Infinity;
  for (let i = 0; i < 2000; i++) {
    const t = i * 0.031;
    const f = fbm3(n, t, t * 1.3, t * 0.7, 5);
    const r = ridged3(n, t, t * 1.3, t * 0.7, 4);
    fmin = Math.min(fmin, f); fmax = Math.max(fmax, f);
    rmin = Math.min(rmin, r); rmax = Math.max(rmax, r);
  }
  assert.ok(fmin >= -1.001 && fmax <= 1.001, `fbm range [${fmin}, ${fmax}]`);
  assert.ok(rmin >= -0.001 && rmax <= 1.001, `ridged range [${rmin}, ${rmax}]`);
  assert.ok(fmax - fmin > 0.4, 'fbm should span a useful range');
});

test('noise3d: warp actually displaces the sample point', () => {
  const n = createNoise3D(11);
  const w = warp3(n, 0.3, 0.4, 0.5, 0.8);
  const moved = Math.hypot(w.x - 0.3, w.y - 0.4, w.z - 0.5);
  assert.ok(moved > 1e-4, `warp displacement ${moved}`);
});

test('mulberry32: deterministic stream in [0,1)', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 1000; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1, `value out of range: ${v}`);
  }
});

// ----------------------------------------------------------------------- seed --

test('seed: same string => same stream seed; different strings differ', () => {
  for (const stream of STREAMS) {
    assert.equal(deriveSeed('alpha', stream), deriveSeed('alpha', stream));
    assert.notEqual(deriveSeed('alpha', stream), deriveSeed('beta', stream), `stream ${stream}`);
  }
});

test('seed: streams are independent within one master seed', () => {
  const seen = new Set();
  for (const stream of STREAMS) seen.add(deriveSeed('planet-forge', stream));
  assert.equal(seen.size, STREAMS.length, 'each subsystem must get a distinct sub-seed');
});

test('seed: hashString is stable and avalanche-ish', () => {
  assert.equal(hashString('planet-forge'), hashString('planet-forge'));
  const a = hashString('seed-a');
  const b = hashString('seed-b');
  assert.notEqual(a, b);
  // A one-bit input change should flip roughly half the output bits; require at
  // least a third of them to move so the check is not flaky.
  const diffBits = (x, y) => {
    let xv = x ^ y;
    let count = 0;
    while (xv) { count += xv & 1; xv >>>= 1; }
    return count;
  };
  assert.ok(diffBits(a, b) > 10, `only ${diffBits(a, b)}/32 bits changed`);
});

test('seed: numeric seeds are hashed, not fused with string seeds', () => {
  // Documented contract: a number is used as its own 32-bit value, while a string
  // is FNV-1a hashed first. So the string '12345' and the number 12345 are
  // deliberately *different* planets. This is asserted rather than assumed because
  // silently equating them would make two unrelated seeds collide.
  assert.notEqual(deriveSeed('12345', 'tectonics'), deriveSeed(12345, 'tectonics'));
  // And a numeric seed is still deterministic.
  assert.equal(deriveSeed(12345, 'tectonics'), deriveSeed(12345, 'tectonics'));
});
