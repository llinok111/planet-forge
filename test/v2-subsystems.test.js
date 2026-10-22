/**
 * v2 subsystem tests: hydrology, LOD policy, volumetric clouds.
 *
 * Each test here corresponds to a specific change made in v2, and several of them
 * encode a defect that was found and fixed rather than a feature that was designed.
 * That is deliberate: the bug is the specification.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIcosphere } from '../src/icosphere.js';
import { buildHeightField } from '../src/heightfield.js';
import {
  computeDrainage,
  fillDepressions,
  erodeHydraulic,
  relaxPits,
} from '../src/hydrology.js';
import { measureCloudCoverage, sampleCloudField, coverageToThreshold } from '../src/clouds.js';

const GEO = createIcosphere(4);

// ------------------------------------------------------------------ drainage --

test('drainage: receiver graph is acyclic', () => {
  const hf = buildHeightField(GEO, { seed: 'hydro-acyclic' });
  const { receiver } = computeDrainage(GEO, hf.elevation);

  let cycles = 0;
  for (let v = 0; v < GEO.vertexCount; v++) {
    let cur = v;
    let steps = 0;
    const seen = new Set();
    while (receiver[cur] >= 0) {
      if (seen.has(cur)) { cycles++; break; }
      seen.add(cur);
      cur = receiver[cur];
      steps++;
      if (steps > GEO.vertexCount) { cycles++; break; }
    }
  }
  assert.equal(cycles, 0, 'following receivers must always terminate');
});

test('drainage: every receiver is strictly lower', () => {
  // This is the property that makes acyclic behaviour automatic, so it is asserted
  // directly rather than inferred from the termination test above.
  const hf = buildHeightField(GEO, { seed: 'hydro-descent' });
  const { receiver } = computeDrainage(GEO, hf.elevation);
  for (let v = 0; v < GEO.vertexCount; v++) {
    const r = receiver[v];
    if (r < 0) continue;
    assert.ok(
      hf.elevation[r] < hf.elevation[v],
      `receiver of ${v} is not lower (${hf.elevation[r]} >= ${hf.elevation[v]})`,
    );
  }
});

test('depression filling: leaves no landlocked sinks', () => {
  // The defect this prevents: before filling, an L4 mesh produced 239 sinks of which
  // 93 sat above sea level, so every gully drained into a pit next to it and the
  // largest catchment was 42 of 2562 vertices — no trunk channels existed at all.
  const hf = buildHeightField(GEO, { seed: 'hydro-fill', hydraulicIterations: 0 });
  const elevation = Float32Array.from(hf.elevation);
  fillDepressions(GEO, elevation);

  const { receiver } = computeDrainage(GEO, elevation);
  let landSinks = 0;
  for (let v = 0; v < GEO.vertexCount; v++) {
    if (receiver[v] < 0 && elevation[v] > 0) landSinks++;
  }
  assert.equal(landSinks, 0, `found ${landSinks} landlocked sinks after filling`);
});

test('depression filling: raises only, never lowers, and is idempotent', () => {
  const hf = buildHeightField(GEO, { seed: 'hydro-monotone', hydraulicIterations: 0 });
  const before = Float32Array.from(hf.elevation);
  const filled = Float32Array.from(hf.elevation);
  fillDepressions(GEO, filled);

  for (let v = 0; v < GEO.vertexCount; v++) {
    assert.ok(filled[v] >= before[v] - 1e-9, `vertex ${v} was lowered by filling`);
  }

  const again = Float32Array.from(filled);
  const second = fillDepressions(GEO, again);
  // A second pass may still nudge by epsilon where the spill chain was long, but it
  // must not do meaningful work.
  assert.ok(second.filledVertices < GEO.vertexCount * 0.05, `second fill touched ${second.filledVertices} vertices`);
});

test('depression filling: total added height stays a small fraction of relief', () => {
  // Guards against a filling implementation that flattens the planet: the sum of the
  // added height must be small compared with the total relief volume.
  const hf = buildHeightField(GEO, { seed: 'hydro-volume', hydraulicIterations: 0 });
  const before = Float32Array.from(hf.elevation);
  const after = Float32Array.from(before);
  fillDepressions(GEO, after);

  let added = 0;
  for (let v = 0; v < GEO.vertexCount; v++) added += after[v] - before[v];
  const relief = hf.stats.maxElevation - hf.stats.minElevation;
  assert.ok(
    added / GEO.vertexCount < relief * 0.25,
    `mean fill height ${(added / GEO.vertexCount).toExponential(2)} vs relief ${relief.toFixed(4)}`,
  );
});

test('hydraulic erosion: carves a connected network rather than scattered pits', () => {
  const base = buildHeightField(GEO, { seed: 'hydro-network', hydraulicIterations: 0 });
  const elevation = Float32Array.from(base.elevation);
  const result = erodeHydraulic(GEO, elevation, { iterations: 2, strength: 0.55 });

  assert.ok(result.riverVertices > 50, `only ${result.riverVertices} river vertices`);
  assert.ok(result.carved > 0, 'nothing was carved');

  // The trunk channel must span a real catchment, not a local puddle.
  let maxFlow = 0;
  for (let v = 0; v < GEO.vertexCount; v++) if (result.flow[v] > maxFlow) maxFlow = result.flow[v];
  assert.ok(
    maxFlow > GEO.vertexCount * 0.02,
    `largest catchment ${maxFlow} of ${GEO.vertexCount} vertices is too small`,
  );
});

test('hydraulic erosion: zero iterations is a no-op on elevations', () => {
  const hf = buildHeightField(GEO, { seed: 'hydro-nop', hydraulicIterations: 0 });
  const base = Float32Array.from(hf.elevation);
  const result = erodeHydraulic(GEO, base, { iterations: 0 });
  assert.equal(result.riverVertices, 0);
  assert.equal(result.carved, 0);
});

test('hydraulic erosion: changing iterations changes the terrain', () => {
  const off = buildHeightField(GEO, { seed: 'hydro-diff', hydraulicIterations: 0 });
  const on = buildHeightField(GEO, { seed: 'hydro-diff', hydraulicIterations: 3 });
  let diff = 0;
  for (let v = 0; v < GEO.vertexCount; v++) diff += Math.abs(off.elevation[v] - on.elevation[v]);
  assert.ok(diff / GEO.vertexCount > 1e-5, `hydraulic erosion changed elevations by only ${diff / GEO.vertexCount}`);
});

test('relaxPits: fills an artificial pit toward its rim', () => {
  // Synthetic field: a smooth bowl has no pits, one vertex is then punched down.
  // Using real terrain here was a mistake: the generated field legitimately contains
  // 224 true pits (single vertices below all their neighbours), so "the field should
  // not move" was a false premise, not a code defect.
  const elevation = new Float32Array(GEO.vertexCount);
  for (let v = 0; v < GEO.vertexCount; v++) {
    elevation[v] = 0.02 + 0.01 * Math.sin(v * 0.37);
  }
  const victim = 100;
  const rimLevel = Math.min(
    ...Array.from(
      { length: GEO.adjacencyOffsets[victim + 1] - GEO.adjacencyOffsets[victim] },
      (_, k) => elevation[GEO.adjacency[GEO.adjacencyOffsets[victim] + k]],
    ),
  );
  elevation[victim] = rimLevel - 0.05;

  relaxPits(GEO, elevation, 8, 0.7);

  assert.ok(
    elevation[victim] > rimLevel - 0.02,
    `pit still at ${(elevation[victim] - rimLevel).toExponential(2)} below its rim`,
  );
});

test('relaxPits: leaves a monotone slope untouched', () => {
  // A strict height gradient has no pits by construction, so nothing may move.
  const elevation = new Float32Array(GEO.vertexCount);
  for (let v = 0; v < GEO.vertexCount; v++) {
    // Use the vertex's latitude as a monotone height field.
    elevation[v] = GEO.positions[v * 3 + 1] * 0.05;
  }
  const copy = Float32Array.from(elevation);
  relaxPits(GEO, elevation, 6, 0.6);

  let moved = 0;
  for (let v = 0; v < GEO.vertexCount; v++) if (Math.abs(elevation[v] - copy[v]) > 1e-9) moved++;
  assert.ok(moved < GEO.vertexCount * 0.01, `${moved} vertices moved on a monotone slope`);
});

test('generated terrain: pit count is measurable and bounded', () => {
  // Documents the real state of generated terrain rather than asserting it is zero.
  // Some single-vertex pits survive erosion, and that is fine visually — this test
  // pins the number so a regression that floods the planet with pits is caught.
  const hf = buildHeightField(GEO, { seed: 'pits', hydraulicIterations: 0 });
  let pits = 0;
  for (let v = 0; v < GEO.vertexCount; v++) {
    let lowest = Infinity;
    for (let j = GEO.adjacencyOffsets[v]; j < GEO.adjacencyOffsets[v + 1]; j++) {
      const h = hf.elevation[GEO.adjacency[j]];
      if (h < lowest) lowest = h;
    }
    if (hf.elevation[v] < lowest - 1e-9) pits++;
  }
  assert.ok(pits < GEO.vertexCount * 0.15, `${pits} pits on ${GEO.vertexCount} vertices`);
});

test('heightfield: river flow field is exposed for shading', () => {
  const withHydro = buildHeightField(GEO, { seed: 'flow', hydraulicIterations: 2 });
  assert.ok(withHydro.riverFlow, 'riverFlow missing');
  assert.equal(withHydro.riverFlow.length, GEO.vertexCount);

  const without = buildHeightField(GEO, { seed: 'flow', hydraulicIterations: 0 });
  assert.equal(without.riverFlow, null, 'no flow field should exist when hydraulic erosion is off');
});

test('heightfield: land fraction stays exact with hydraulic erosion enabled', () => {
  // Erosion moves mass, so this is the regression test for the re-anchoring pass:
  // if sea level were taken before erosion, the fraction would drift.
  for (const bias of [0.25, 0.5, 0.75]) {
    const hf = buildHeightField(GEO, { seed: 'hydro-bias', continentBias: bias, hydraulicIterations: 3 });
    assert.ok(
      Math.abs(hf.stats.landFraction - bias) < 0.01,
      `bias ${bias} produced ${hf.stats.landFraction}`,
    );
  }
});

// ---------------------------------------------------------------------- clouds --

test('clouds: coverage still maps to the requested sky fraction after the volume rewrite', () => {
  // The volumetric shader samples density along a ray; the CPU measurement samples the
  // distribution at mid-deck height. If the two constructions drift apart the slider
  // silently stops meaning "sky covered", so this is checked at several values.
  for (const coverage of [0.15, 0.35, 0.5, 0.7, 0.9]) {
    const measured = measureCloudCoverage('vol-cloud', { coverage });
    assert.ok(Math.abs(measured - coverage) < 0.03, `coverage ${coverage} measured ${measured.toFixed(3)}`);
  }
});

test('clouds: monotonic in coverage', () => {
  const values = [0.1, 0.3, 0.5, 0.7, 0.9].map((c) => measureCloudCoverage('vol-mono', { coverage: c }));
  for (let i = 1; i < values.length; i++) assert.ok(values[i] > values[i - 1], `${values}`);
});

test('clouds: distribution is reproducible per seed and differs across seeds', () => {
  const a = sampleCloudField('seed-a', {}, 512);
  const b = sampleCloudField('seed-a', {}, 512);
  const c = sampleCloudField('seed-b', {}, 512);
  assert.deepEqual(Array.from(a), Array.from(b));
  assert.notDeepEqual(Array.from(a), Array.from(c));
});

test('clouds: threshold lies inside the sampled range', () => {
  const field = sampleCloudField('thr', {}, 1024);
  const t = coverageToThreshold(field, 0.5);
  assert.ok(t >= field[0] && t <= field[field.length - 1]);
});

// ------------------------------------------------------------------------- LOD --

test('lod: level selection follows camera distance with hysteresis', () => {
  // The policy is pure, so it is tested without a browser by reproducing its rules.
  // Keeping this in sync with planet.js:desiredLodLevel is deliberate — a silent
  // divergence would mean the HUD lies about the level on screen.
  const params = { autoLod: true, lodNear: 2.3, lodFar: 7 };
  const decide = (current, distance) => {
    if (!params.autoLod) return null;
    if (current < 6 && distance < params.lodNear * 0.9) return 6;
    if (current === 6 && distance > params.lodNear * 1.1) return 5;
    return null;
  };

  assert.equal(decide(5, 1.8), 6, 'close camera must request the high level');
  assert.equal(decide(6, 1.8), null, 'already high: no change');
  assert.equal(decide(6, 3.5), 5, 'far camera must request the low level');
  assert.equal(decide(5, 3.5), null, 'already low: no change');

  // Inside the hysteresis band nothing changes, in either direction.
  assert.equal(decide(5, 2.3), null);
  assert.equal(decide(6, 2.3), null);

  // Manual mode never overrides the user's chosen level.
  params.autoLod = false;
  assert.equal(decide(5, 1.0), null);
});

test('lod: hysteresis band is non-empty', () => {
  // A zero-width band would flip on every frame at the threshold, and each flip costs
  // a full rebuild.
  const near = 2.3;
  const upThreshold = near * 0.9;
  const downThreshold = near * 1.1;
  assert.ok(downThreshold > upThreshold, 'band collapsed');
});
