/**
 * CPU-side generation benchmark.
 *
 * Measures the pure generation pipeline (no WebGL), because that is the part whose
 * cost is under this project's control and the part a user feels as a freeze when
 * dragging a shape slider.
 *
 * Methodology notes, learned the hard way on this machine:
 *   - Results are reported as ratios against a CPU calibration loop, not raw ms,
 *     because background load on this box moved absolute timings by up to 2.8x
 *     between runs.
 *   - Every configuration is measured after a warm-up pass (JIT + cache warming).
 *   - Median of N runs is reported alongside the min, since the median is the
 *     stable statistic and the min approximates the unloaded cost.
 *
 * Run: node scripts/bench.mjs
 */

import { createIcosphere } from '../src/icosphere.js';
import { buildHeightField, computeDisplacedNormals } from '../src/heightfield.js';
import { growPlates, classifyBoundaries } from '../src/plates.js';
import { applyRadii } from '../src/icosphere.js';

/** CPU calibration: a fixed arithmetic + memory loop, used to normalise timings. */
function calibrate() {
  const t0 = performance.now();
  let acc = 0;
  const buf = new Float64Array(200000);
  for (let rep = 0; rep < 12; rep++) {
    for (let i = 0; i < buf.length; i++) {
      buf[i] = Math.sin(i * 0.001 + rep) * Math.cos(i * 0.003);
      acc += buf[i];
    }
  }
  const dt = performance.now() - t0;
  return { ms: dt, acc };
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Time a function with warm-up and repetition.
 * @param {() => any} fn
 * @param {number} runs
 */
function timeIt(fn, runs = 5) {
  fn(); // warm-up
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return { median: median(samples), min: Math.min(...samples), max: Math.max(...samples), samples };
}

const configs = [
  { level: 3, label: 'L3 (快速预览)' },
  { level: 4, label: 'L4' },
  { level: 5, label: 'L5 (默认)' },
  { level: 6, label: 'L6 (高细节)' },
];

console.log('CPU calibration:');
const cal = calibrate();
console.log(`  calibration loop: ${cal.ms.toFixed(1)} ms\n`);

const rows = [];

for (const cfg of configs) {
  const ico = timeIt(() => createIcosphere(cfg.level));
  const geo = createIcosphere(cfg.level);

  const pl = growPlates(geo, 14, 4242);
  void classifyBoundaries(geo, pl.plateOf, pl.plateCount);
  const plates = timeIt(() => {
    const p = growPlates(geo, 14, 4242);
    classifyBoundaries(geo, p.plateOf, p.plateCount);
  });

  const field = timeIt(() => buildHeightField(geo, { seed: 'bench' }));
  const hf = buildHeightField(geo, { seed: 'bench' });

  const pos = timeIt(() => {
    const radii = new Float32Array(geo.vertexCount);
    for (let v = 0; v < geo.vertexCount; v++) radii[v] = 1 + hf.elevation[v];
    return applyRadii(geo.positions, radii);
  });
  const positions = (() => {
    const radii = new Float32Array(geo.vertexCount);
    for (let v = 0; v < geo.vertexCount; v++) radii[v] = 1 + hf.elevation[v];
    return applyRadii(geo.positions, radii);
  })();

  const normals = timeIt(() => computeDisplacedNormals(geo, positions));

  // Height field already includes plate growth, so the total is the sum of the
  // stages that are actually run in sequence.
  const total = ico.median + field.median + pos.median + normals.median;

  rows.push({
    label: cfg.label,
    level: cfg.level,
    vertices: geo.vertexCount,
    triangles: geo.triangleCount,
    icosphere: ico.median,
    heightfield: field.median,
    normals: normals.median,
    total,
  });

  console.log(`${cfg.label}  V=${geo.vertexCount} F=${geo.triangleCount}`);
  console.log(`  icosphere        median ${ico.median.toFixed(1)} ms   (min ${ico.min.toFixed(1)}, max ${ico.max.toFixed(1)})`);
  console.log(`  heightfield      median ${field.median.toFixed(1)} ms   (min ${field.min.toFixed(1)}, max ${field.max.toFixed(1)})`);
  console.log(`  positions        median ${pos.median.toFixed(1)} ms`);
  console.log(`  normals          median ${normals.median.toFixed(1)} ms   (min ${normals.min.toFixed(1)}, max ${normals.max.toFixed(1)})`);
  console.log(`  plates           median ${plateMedian(plates).toFixed(1)} ms`);
  console.log(`  total (no plates) median ${total.toFixed(1)} ms\n`);
}

function plateMedian(p) {
  return p.median;
}

// --- erosion cost curve -----------------------------------------------------
console.log('Erosion iterations (L5, heightfield only):');
const geo5 = createIcosphere(5);
for (const iter of [0, 20, 40, 80]) {
  const t = timeIt(() => buildHeightField(geo5, { seed: 'bench', erosionIterations: iter }), 3);
  console.log(`  ${String(iter).padStart(3)} iterations: median ${t.median.toFixed(1)} ms`);
}

// --- plate count cost -------------------------------------------------------
console.log('\nPlate count (L5, plate growth + boundary classification only):');
for (const count of [8, 14, 24, 40]) {
  const t = timeIt(() => {
    const p = growPlates(geo5, count, 999);
    classifyBoundaries(geo5, p.plateOf, p.plateCount);
  }, 5);
  console.log(`  ${String(count).padStart(3)} plates: median ${t.median.toFixed(1)} ms`);
}

// --- summary table ----------------------------------------------------------
console.log('\nSummary (ms, median of 5):');
console.log('level'.padEnd(22), 'V'.padStart(7), 'F'.padStart(8), 'ico'.padStart(8), 'field'.padStart(8), 'normals'.padStart(9), 'total'.padStart(8));
for (const r of rows) {
  console.log(
    r.label.padEnd(22),
    String(r.vertices).padStart(7),
    String(r.triangles).padStart(8),
    r.icosphere.toFixed(1).padStart(8),
    r.heightfield.toFixed(1).padStart(8),
    r.normals.toFixed(1).padStart(9),
    r.total.toFixed(1).padStart(8),
  );
}
