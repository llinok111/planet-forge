/**
 * Height field tests — the core claim of the project.
 *
 * The premise being defended: the planet is real displaced geometry, and every
 * shape parameter measurably changes that geometry. Each test therefore compares
 * *vertex data*, not parameter objects.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIcosphere } from '../src/icosphere.js';
import { buildHeightField, computeDisplacedNormals, erodeThermal, DEFAULT_SHAPE } from '../src/heightfield.js';
import { growPlates, classifyBoundaries } from '../src/plates.js';

const GEO = createIcosphere(4); // 2562 vertices: fast but detailed enough

/** Root-mean-square difference between two equal-length arrays. */
function rms(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum / a.length);
}

/** Sum of |a-b| divided by length: a robust "did anything change" measure. */
function meanAbsDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

// ------------------------------------------------------------------ plates --

test('plates: every vertex is assigned exactly one valid plate', () => {
  const plates = growPlates(GEO, 12, 1234);
  assert.equal(plates.plateOf.length, GEO.vertexCount);
  for (let v = 0; v < GEO.vertexCount; v++) {
    assert.ok(plates.plateOf[v] < plates.plateCount, `vertex ${v} has plate ${plates.plateOf[v]}`);
  }
});

test('plates: plates are contiguous (each plate occupies one connected region)', () => {
  // Contiguity follows from the BFS construction; this test guards against a future
  // refactor to distance-based assignment, where plates can become speckled.
  const plates = growPlates(GEO, 10, 77);
  const seen = new Uint8Array(GEO.vertexCount);
  let regions = 0;
  for (let start = 0; start < GEO.vertexCount; start++) {
    if (seen[start]) continue;
    regions++;
    const label = plates.plateOf[start];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const v = stack.pop();
      for (let k = GEO.adjacencyOffsets[v]; k < GEO.adjacencyOffsets[v + 1]; k++) {
        const nb = GEO.adjacency[k];
        if (!seen[nb] && plates.plateOf[nb] === label) {
          seen[nb] = 1;
          stack.push(nb);
        }
      }
    }
  }
  assert.equal(regions, plates.plateCount, `expected ${plates.plateCount} connected regions, found ${regions}`);
});

test('plates: requested count is honoured and sizes are balanced', () => {
  for (const count of [4, 8, 16, 32]) {
    const plates = growPlates(GEO, count, 2024);
    assert.equal(plates.plateCount, count);
    const sizes = Array.from(plates.plateSizes).slice(0, count);
    const min = Math.min(...sizes);
    const max = Math.max(...sizes);
    // Best-candidate seeding should keep the largest plate within ~4x the smallest.
    assert.ok(max / min < 4, `plate sizes unbalanced for ${count}: ${min}..${max}`);
  }
});

test('plates: boundary count grows with plate count', () => {
  const seen = [];
  for (const count of [6, 14, 30]) {
    const plates = growPlates(GEO, count, 555);
    const bounds = classifyBoundaries(GEO, plates.plateOf, plates.plateCount);
    seen.push(bounds.boundaryVertices);
  }
  assert.ok(seen[0] < seen[1] && seen[1] < seen[2], `boundary vertices should increase: ${seen}`);
});

// -------------------------------------------------------------- determinism --

test('heightfield: identical seed and shape give bit-identical elevations', () => {
  const a = buildHeightField(GEO, { seed: 'determinism' });
  const b = buildHeightField(GEO, { seed: 'determinism' });
  assert.equal(a.elevation.length, b.elevation.length);
  let identical = true;
  for (let i = 0; i < a.elevation.length; i++) {
    if (a.elevation[i] !== b.elevation[i]) { identical = false; break; }
  }
  assert.ok(identical, 'elevation must be bit-identical, not merely close');
  assert.equal(a.stats.landFraction, b.stats.landFraction);
});

test('heightfield: a different seed gives a different planet', () => {
  const a = buildHeightField(GEO, { seed: 'alpha' });
  const b = buildHeightField(GEO, { seed: 'beta' });
  const diff = meanAbsDiff(a.elevation, b.elevation);
  assert.ok(diff > 0.005, `seeds should diverge, mean |diff| was ${diff}`);
});

test('heightfield: shape params of different names do not alias', () => {
  // Two names that share a prefix must not resolve to the same stream.
  const a = buildHeightField(GEO, { seed: 'seed' });
  const b = buildHeightField(GEO, { seed: 'seed2' });
  assert.ok(meanAbsDiff(a.elevation, b.elevation) > 0.002);
});

// ------------------------------------------------------ parameter sensitivity --

const SENSITIVITY = [
  { key: 'plateCount', value: 30, min: 0.002 },
  { key: 'plateHeight', value: 0.055, min: 0.0005 },
  { key: 'mountainHeight', value: 0.11, min: 0.0005 },
  { key: 'ridgeSharpness', value: 0.98, min: 0.0002 },
  { key: 'riftDepth', value: 0.07, min: 0.0002 },
  { key: 'noiseScale', value: 4.4, min: 0.001 },
  { key: 'warpStrength', value: 1.4, min: 0.001 },
  { key: 'detailAmplitude', value: 0.045, min: 0.001 },
  { key: 'erosionIterations', value: 0, min: 0.0002 },
];

const BASELINE = buildHeightField(GEO, { seed: 'sensitivity' });

for (const { key, value, min } of SENSITIVITY) {
  test(`heightfield: "${key}" measurably changes vertex elevations`, () => {
    const alt = buildHeightField(GEO, { seed: 'sensitivity', [key]: value });
    const diff = meanAbsDiff(BASELINE.elevation, alt.elevation);
    assert.ok(diff > min, `"${key}" changed elevations by only ${diff} (expected > ${min})`);
  });
}

test('heightfield: continentBias controls the land fraction precisely', () => {
  for (const bias of [0.15, 0.35, 0.5, 0.72, 0.9]) {
    const hf = buildHeightField(GEO, { seed: 'bias', continentBias: bias });
    // Tolerance is one vertex (1/2562 = 0.04%), plus rounding.
    assert.ok(
      Math.abs(hf.stats.landFraction - bias) < 0.005,
      `bias ${bias} produced land fraction ${hf.stats.landFraction}`,
    );
  }
});

test('heightfield: continentBias is monotonic in land coverage', () => {
  const values = [0.2, 0.4, 0.6, 0.8].map(
    (bias) => buildHeightField(GEO, { seed: 'mono', continentBias: bias }).stats.landFraction,
  );
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i] > values[i - 1], `land fraction not increasing: ${values}`);
  }
});

test('heightfield: erosion reduces the relief budget', () => {
  // Thermal erosion moves material downhill and removes spikes, so the peak-to-
  // trough range after erosion must be smaller than before it.
  const none = buildHeightField(GEO, { seed: 'erode', erosionIterations: 0 });
  const heavy = buildHeightField(GEO, { seed: 'erode', erosionIterations: 60 });
  const relief = (hf) => hf.stats.maxElevation - hf.stats.minElevation;
  assert.ok(relief(heavy) < relief(none), `relief ${relief(none)} -> ${relief(heavy)}`);
});

test('heightfield: oceanMask agrees with elevation sign', () => {
  const hf = buildHeightField(GEO, { seed: 'mask' });
  for (let v = 0; v < GEO.vertexCount; v++) {
    const expected = hf.elevation[v] < 0 ? 1 : 0;
    assert.equal(hf.oceanMask[v], expected, `vertex ${v}`);
  }
});

test('heightfield: sea level is zero after re-anchoring', () => {
  const hf = buildHeightField(GEO, { seed: 'anchor', continentBias: 0.62 });
  assert.equal(hf.seaLevel, 0);
  // Land fraction must equal the fraction strictly above zero.
  let above = 0;
  for (let v = 0; v < GEO.vertexCount; v++) if (hf.elevation[v] > 0) above++;
  assert.ok(Math.abs(above / GEO.vertexCount - hf.stats.landFraction) < 0.002);
});

test('heightfield: elevations are finite everywhere', () => {
  const hf = buildHeightField(GEO, { seed: 'finite' });
  for (let v = 0; v < GEO.vertexCount; v++) {
    assert.ok(Number.isFinite(hf.elevation[v]), `vertex ${v} elevation is ${hf.elevation[v]}`);
  }
});

// ---------------------------------------------------------------- normals --

test('normals: unit length and pointing outward everywhere', () => {
  const hf = buildHeightField(GEO, { seed: 'normals' });
  const positions = new Float32Array(GEO.vertexCount * 3);
  for (let v = 0; v < GEO.vertexCount; v++) {
    const r = 1 + hf.elevation[v];
    positions[v * 3] = GEO.positions[v * 3] * r;
    positions[v * 3 + 1] = GEO.positions[v * 3 + 1] * r;
    positions[v * 3 + 2] = GEO.positions[v * 3 + 2] * r;
  }
  const normals = computeDisplacedNormals(GEO, positions);
  let minDot = 1;
  for (let v = 0; v < GEO.vertexCount; v++) {
    const len = Math.hypot(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
    assert.ok(Math.abs(len - 1) < 1e-5, `normal ${v} length ${len}`);
    const dot =
      normals[v * 3] * GEO.positions[v * 3] +
      normals[v * 3 + 1] * GEO.positions[v * 3 + 1] +
      normals[v * 3 + 2] * GEO.positions[v * 3 + 2];
    minDot = Math.min(minDot, dot);
  }
  assert.ok(minDot > 0.2, `normals should point outward, min dot ${minDot}`);
});

test('normals: flat terrain yields radial normals', () => {
  // No relief at all: every normal must equal the radial direction.
  const positions = new Float32Array(GEO.vertexCount * 3);
  for (let v = 0; v < GEO.vertexCount; v++) {
    positions[v * 3] = GEO.positions[v * 3];
    positions[v * 3 + 1] = GEO.positions[v * 3 + 1];
    positions[v * 3 + 2] = GEO.positions[v * 3 + 2];
  }
  const normals = computeDisplacedNormals(GEO, positions);
  for (let v = 0; v < GEO.vertexCount; v++) {
    const dot =
      normals[v * 3] * GEO.positions[v * 3] +
      normals[v * 3 + 1] * GEO.positions[v * 3 + 1] +
      normals[v * 3 + 2] * GEO.positions[v * 3 + 2];
    assert.ok(dot > 0.9999, `flat terrain normal should be radial, dot ${dot}`);
  }
});

// ---------------------------------------------------------------- erosion --

test('erosion: conserves mass approximately', () => {
  // Every transfer moves value from one vertex to another, so the total must stay
  // (numerically) constant. This catches an accumulator bug that silently creates
  // or destroys terrain.
  const g = createIcosphere(3);
  const elevation = new Float32Array(g.vertexCount);
  for (let v = 0; v < g.vertexCount; v++) {
    elevation[v] = Math.sin(v * 0.37) * 0.05 + Math.cos(v * 0.11) * 0.02;
  }
  const before = elevation.reduce((a, b) => a + b, 0);
  erodeThermal(g, elevation, 20, 0.4);
  const after = elevation.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(after - before) < 1e-4, `mass changed from ${before} to ${after}`);
});

test('erosion: zero iterations leaves the field untouched', () => {
  const g = createIcosphere(3);
  const elevation = new Float32Array(g.vertexCount).map((_, i) => Math.sin(i) * 0.01);
  const copy = Float32Array.from(elevation);
  erodeThermal(g, elevation, 0, 0.5);
  for (let i = 0; i < elevation.length; i++) assert.equal(elevation[i], copy[i]);
});

test('DEFAULT_SHAPE covers every documented default', () => {
  // Guards against a parameter being added to the UI without a sane default.
  for (const key of ['seed', 'detail', 'plateCount', 'continentBias', 'mountainHeight']) {
    assert.ok(key in DEFAULT_SHAPE, `missing default for ${key}`);
  }
  assert.ok(DEFAULT_SHAPE.continentBias > 0 && DEFAULT_SHAPE.continentBias < 1);
});

void rms;
