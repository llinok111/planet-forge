/**
 * Planet height field synthesis.
 *
 * This is the module that makes the planet a displaced mesh rather than a
 * textured sphere. Every slider in the UI terminates here: the value changes a
 * number that is written into a per-vertex elevation, and the elevation changes
 * the vertex radius. Nothing is faked with a normal map or a colour ramp alone.
 *
 * Height convention: elevations are stored in planet radii (1.0 = sea level).
 * `elevation[v]` is the final signed offset in radii, so the rendered radius is
 * `1 + elevation[v]`. Keeping it normalized means the same parameters produce
 * the same *shape* at any planet radius, and the ocean mask is a simple
 * comparison against zero.
 */

import { createNoise3D, fbm3, ridged3, warp3, mulberry32 } from './noise3d.js';
import { deriveSeed } from './seed.js';
import { growPlates, classifyBoundaries } from './plates.js';
import { erodeHydraulic } from './hydrology.js';

/**
 * Default shape parameters. These are the single source of truth: the UI schema
 * is derived from the same names, and tests assert that each of them measurably
 * changes the output.
 */
export const DEFAULT_SHAPE = {
  seed: 'planet-forge',
  detail: 5,
  radius: 1,
  plateCount: 14,
  plateHeight: 0.022,
  continentBias: 0.52,
  mountainHeight: 0.055,
  ridgeSharpness: 0.62,
  riftDepth: 0.028,
  noiseScale: 2.1,
  warpStrength: 0.42,
  detailAmplitude: 0.016,
  erosionIterations: 26,
  erosionRate: 0.36,
  hydraulicIterations: 2,
  hydraulicStrength: 0.55,
};

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Build the full planet elevation field.
 *
 * Pipeline, in order:
 *   1. Plates: grow Voronoi-like regions on the vertex graph.
 *   2. Baseline: each plate gets an elevation from a seeded constant plus a
 *      domain-warped low-frequency field, biased toward ocean or continent.
 *   3. Boundaries: convergent edges raise a ridged belt, divergent edges cut a
 *      rift. Which is which comes from comparing plate centroids.
 *   4. Detail: fBm at a higher frequency, scaled by a slope-independent amplitude.
 *   5. Erosion: thermal relaxation that moves material from steep vertices to
 *      their lowest neighbours, which is what forms talus slopes and valley floors.
 *
 * @param {object} geometry Result of createIcosphere.
 * @param {object} [shape] Partial overrides of DEFAULT_SHAPE.
 * @returns {{
 *   elevation: Float32Array,
 *   oceanMask: Uint8Array,
 *   plateOf: Uint16Array,
 *   boundary: Float32Array,
 *   seaLevel: number,
 *   stats: object
 * }}
 */
export function buildHeightField(geometry, shape = {}) {
  const cfg = { ...DEFAULT_SHAPE, ...shape };
  const { vertexCount, positions } = geometry;
  const radius = cfg.radius;

  const tectonicSeed = deriveSeed(cfg.seed, 'tectonics');
  const detailSeed = deriveSeed(cfg.seed, 'detail');
  const erosionSeed = deriveSeed(cfg.seed, 'erosion');

  const noiseTectonic = createNoise3D(tectonicSeed);
  const noiseDetail = createNoise3D(detailSeed);
  const noiseRidge = createNoise3D(erosionSeed);
  const rng = mulberry32(deriveSeed(cfg.seed, 'scatter'));

  // --- 1. plates -----------------------------------------------------------
  const plates = growPlates(geometry, cfg.plateCount, tectonicSeed);
  const bounds = classifyBoundaries(geometry, plates.plateOf, plates.plateCount);

  // Per-plate motion vector: the direction the plate drifts in. Random but seeded.
  const plateMotion = new Float64Array(plates.plateCount * 3);
  for (let p = 0; p < plates.plateCount; p++) {
    let mx = rng() * 2 - 1;
    let my = rng() * 2 - 1;
    let mz = rng() * 2 - 1;
    const len = Math.hypot(mx, my, mz) || 1;
    mx /= len; my /= len; mz /= len;
    plateMotion[p * 3] = mx;
    plateMotion[p * 3 + 1] = my;
    plateMotion[p * 3 + 2] = mz;
  }

  // Per-plate baseline: continental plates above sea level, oceanic below, with
  // a seeded per-plate jitter so not every continent sits at the same height.
  const plateBaseline = new Float64Array(plates.plateCount);
  for (let p = 0; p < plates.plateCount; p++) {
    const oceanic = plates.plateIsOceanic[p] === 1;
    const jitter = (rng() - 0.5) * 0.5;
    // continentBias shifts the balance: 0 = mostly ocean, 1 = mostly land.
    const oceanShare = 1 - clamp(cfg.continentBias, 0, 1);
    const base = oceanic
      ? -cfg.plateHeight * (0.55 + oceanShare * 0.9) + jitter * cfg.plateHeight
      : cfg.plateHeight * (0.55 + cfg.continentBias * 0.9) + jitter * cfg.plateHeight;
    plateBaseline[p] = base;
  }

  const elevation = new Float32Array(vertexCount);
  const nScale = cfg.noiseScale;

  // --- 2 + 3. baseline and boundaries --------------------------------------
  const converge = new Float32Array(vertexCount);

  for (let v = 0; v < vertexCount; v++) {
    const ux = positions[v * 3];
    const uy = positions[v * 3 + 1];
    const uz = positions[v * 3 + 2];

    const p = plates.plateOf[v];
    let h = plateBaseline[p];

    // Low-frequency continental shape, domain-warped so coastlines meander
    // instead of following plate borders.
    const warped = warp3(noiseTectonic, ux * nScale, uy * nScale, uz * nScale, cfg.warpStrength);
    const macro = fbm3(noiseTectonic, warped.x, warped.y, warped.z, 4, 2, 0.5);
    h += macro * cfg.plateHeight * 0.85;

    // Boundary interaction.
    const bRatio = bounds.boundary[v];
    if (bRatio > 0) {
      const other = bounds.neighbourPlate[v];
      let kind = 0; // +1 convergent, -1 divergent, 0 transform
      if (other >= 0 && other < plates.plateCount) {
        // Relative motion of the two plates projected onto the line joining them.
        // Moving toward each other => convergent.
        let cx = plates.plateCenters[other * 3] - plates.plateCenters[p * 3];
        let cy = plates.plateCenters[other * 3 + 1] - plates.plateCenters[p * 3 + 1];
        let cz = plates.plateCenters[other * 3 + 2] - plates.plateCenters[p * 3 + 2];
        const clen = Math.hypot(cx, cy, cz) || 1;
        cx /= clen; cy /= clen; cz /= clen;
        const relx = plateMotion[p * 3] - plateMotion[other * 3];
        const rely = plateMotion[p * 3 + 1] - plateMotion[other * 3 + 1];
        const relz = plateMotion[p * 3 + 2] - plateMotion[other * 3 + 2];
        const dot = relx * cx + rely * cy + relz * cz;
        kind = dot > 0.1 ? 1 : dot < -0.1 ? -1 : 0;
        converge[v] = dot;
      }

      // Ridged noise gives the belt its crease structure.
      const ridge = ridged3(
        noiseRidge,
        ux * nScale * 3.1,
        uy * nScale * 3.1,
        uz * nScale * 3.1,
        4,
        2.1,
        0.5,
      );
      const belt = Math.pow(bRatio, 0.75);
      if (kind > 0) {
        const sharp = clamp(cfg.ridgeSharpness, 0, 1);
        h += belt * cfg.mountainHeight * (0.35 + 0.65 * ridge) * (1 + sharp * 0.9);
      } else if (kind < 0) {
        // Rift valley: subtract, and deepen toward the boundary core.
        h -= belt * cfg.riftDepth * (0.4 + 0.6 * (1 - ridge));
      } else {
        // Transform boundary: slight uplift, no belt.
        h += belt * cfg.mountainHeight * 0.18 * ridge;
      }
    }

    // --- 4. detail -------------------------------------------------------
    const detail = fbm3(
      noiseDetail,
      ux * nScale * 7.5,
      uy * nScale * 7.5,
      uz * nScale * 7.5,
      4,
      2.05,
      0.52,
    );

    elevation[v] = h;
    // Keep detail for after normalization so it scales with the final range.
    converge[v] = detail;
  }

  // Normalize the tectonic component to a known range, then add detail. Without
  // this step, plateHeight / mountainHeight changes would be non-comparable
  // between seeds because fBm output range varies with frequency.
  let maxAbs = 0;
  for (let v = 0; v < vertexCount; v++) {
    const a = Math.abs(elevation[v]);
    if (a > maxAbs) maxAbs = a;
  }
  const budget = cfg.plateHeight + cfg.mountainHeight + cfg.detailAmplitude;
  const rescale = maxAbs > 1e-9 ? budget / maxAbs : 1;

  for (let v = 0; v < vertexCount; v++) {
    elevation[v] = elevation[v] * rescale + converge[v] * cfg.detailAmplitude;
  }

  // Sea level is chosen *after* detail is added, and directly from the sorted
  // field, so `continentBias` hits its target land fraction instead of
  // approximately landing near it. (Choosing it before detail was added left the
  // land fraction off by ~3% because detail noise is symmetric but bounded.)
  const oceanFraction = 1 - clamp(cfg.continentBias, 0.02, 0.98);
  const sorted = Float32Array.from(elevation).sort();
  const seaLevel = sorted[Math.min(vertexCount - 1, Math.floor(oceanFraction * vertexCount))];
  for (let v = 0; v < vertexCount; v++) elevation[v] -= seaLevel;

  // --- 5. thermal erosion ---------------------------------------------------
  if (cfg.erosionIterations > 0) {
    erodeThermal(geometry, elevation, cfg.erosionIterations, cfg.erosionRate);
  }

  // --- 5b. hydraulic erosion ------------------------------------------------
  // Ordered after the thermal pass on purpose: thermal relaxation produces the
  // gentle slopes that rivers follow, so running it first gives the drainage
  // network something to settle into instead of carving across fresh noise.
  let hydraulic = null;
  if (cfg.hydraulicIterations > 0) {
    hydraulic = erodeHydraulic(geometry, elevation, {
      iterations: cfg.hydraulicIterations,
      strength: cfg.hydraulicStrength,
    });
  }

  // Re-anchor sea level after erosion. Erosion redistributes mass and therefore
  // shifts the height distribution; without this second pass the land fraction
  // drifts away from `continentBias` by several percent (measured: 0.52 -> 0.511,
  // 0.20 -> 0.166 before this fix).
  {
    const targetOcean = 1 - clamp(cfg.continentBias, 0.02, 0.98);
    const post = Float32Array.from(elevation).sort();
    const idx = Math.min(vertexCount - 1, Math.floor(targetOcean * vertexCount));
    const settle = post[idx];
    for (let v = 0; v < vertexCount; v++) elevation[v] -= settle;
  }

  // Ocean mask: strictly below sea level. Sea level is exactly 0 after recentring.
  const oceanMask = new Uint8Array(vertexCount);
  let landCount = 0;
  for (let v = 0; v < vertexCount; v++) {
    const isOcean = elevation[v] < 0;
    oceanMask[v] = isOcean ? 1 : 0;
    if (!isOcean) landCount++;
  }

  // Scale from radii to world units once, at the end.
  if (radius !== 1) {
    for (let v = 0; v < vertexCount; v++) elevation[v] *= radius;
  }

  let minH = Infinity, maxH = -Infinity, sumH = 0;
  for (let v = 0; v < vertexCount; v++) {
    const h = elevation[v];
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
    sumH += h;
  }

  return {
    elevation,
    oceanMask,
    plateOf: plates.plateOf,
    plateCount: plates.plateCount,
    plateIsOceanic: plates.plateIsOceanic,
    boundary: bounds.boundary,
    seaLevel: 0,
    detail: geometryDetail(geometry),
    // Catchment area per vertex, so shading can darken river beds and tests can
    // assert a connected network exists.
    riverFlow: hydraulic?.flow ?? null,
    stats: {
      minElevation: minH,
      maxElevation: maxH,
      meanElevation: sumH / vertexCount,
      landFraction: landCount / vertexCount,
      boundaryFractions: bounds.boundaryVertices / geometry.vertexCount,
      plateCount: plates.plateCount,
      seed: cfg.seed,
      riverVertices: hydraulic?.riverVertices ?? 0,
      hydraulicCarved: hydraulic?.carved ?? 0,
      depressionsFilled: hydraulic?.fillInfo?.filledVertices ?? 0,
    },
  };
}

function geometryDetail(geometry) {
  return { vertexCount: geometry.vertexCount, triangleCount: geometry.triangleCount, level: geometry.level };
}

/**
 * Thermal erosion (talus relaxation).
 *
 * For each vertex, compare its elevation with each neighbour. Where the slope
 * exceeds a threshold, move a fraction of the difference from the higher vertex
 * to the lower one. Iterating this forms talus slopes and flat valley floors.
 *
 * The slope threshold is expressed in elevation units per unit arc length and is
 * derived from the mesh edge length, so results stay consistent across
 * subdivision levels rather than getting smoother simply because the triangles
 * got smaller.
 *
 * @param {object} geometry
 * @param {Float32Array} elevation Mutated in place.
 * @param {number} iterations
 * @param {number} rate 0..1 fraction of the excess moved per pass.
 * @returns {{movedMass: number}} Diagnostics for tests.
 */
export function erodeThermal(geometry, elevation, iterations, rate) {
  const { vertexCount, adjacency, adjacencyOffsets, triangleCount } = geometry;
  const edgeLength = Math.sqrt((4 * Math.PI) / (triangleCount * 1.5));
  const talus = edgeLength * 0.55;
  const transfer = 0.5 * clamp(rate, 0, 1);
  const delta = new Float32Array(vertexCount);
  let movedMass = 0;

  for (let iter = 0; iter < iterations; iter++) {
    delta.fill(0);
    movedMass = 0;
    for (let v = 0; v < vertexCount; v++) {
      const hv = elevation[v];
      let lowest = Infinity;
      let lowestIdx = -1;
      for (let k = adjacencyOffsets[v]; k < adjacencyOffsets[v + 1]; k++) {
        const nb = adjacency[k];
        const hn = elevation[nb];
        if (hn < lowest) { lowest = hn; lowestIdx = nb; }
      }
      if (lowestIdx < 0) continue;
      const drop = hv - lowest;
      if (drop <= talus) continue;
      const move = (drop - talus) * transfer;
      delta[v] -= move;
      delta[lowestIdx] += move;
      movedMass += move;
    }
    for (let v = 0; v < vertexCount; v++) elevation[v] += delta[v];
  }

  return { movedMass, talus, edgeLength };
}

/**
 * Recompute vertex normals analytically from the displaced geometry.
 *
 * Why not let three.js do it: BufferGeometry.computeVertexNormals() averages face
 * normals, which on a displaced sphere produces shading seams where the
 * subdivision changed (visible as pinching near the poles). Deriving the normal
 * from the position vector and the local elevation gradient keeps the shading
 * continuous and gives cliffs the correct slope.
 *
 * The gradient is estimated in world units (height drop over world-space tangent
 * distance), not in "per neighbour" units, so the resulting normal is
 * dimensionless and looks the same at every subdivision level.
 *
 * @param {object} geometry
 * @param {Float32Array} positions Displaced world positions (xyz interleaved).
 * @returns {Float32Array} Unit normals.
 */
export function computeDisplacedNormals(geometry, positions) {
  const { vertexCount, adjacency, adjacencyOffsets } = geometry;
  const normals = new Float32Array(vertexCount * 3);

  for (let v = 0; v < vertexCount; v++) {
    const px = positions[v * 3], py = positions[v * 3 + 1], pz = positions[v * 3 + 2];
    const plen = Math.hypot(px, py, pz) || 1;
    const ux = px / plen, uy = py / plen, uz = pz / plen;

    // Tangential gradient accumulator: sum of (dHeight / dTangentialDistance) * unitTangent.
    let gx = 0, gy = 0, gz = 0;
    let count = 0;
    for (let k = adjacencyOffsets[v]; k < adjacencyOffsets[v + 1]; k++) {
      const nb = adjacency[k];
      const qx = positions[nb * 3], qy = positions[nb * 3 + 1], qz = positions[nb * 3 + 2];
      const qlen = Math.hypot(qx, qy, qz) || 1;
      const dh = qlen - plen;
      // Tangent direction to the neighbour, projected into the tangent plane.
      let dx = qx / qlen - ux;
      let dy = qy / qlen - uy;
      let dz = qz / qlen - uz;
      const dlen = Math.hypot(dx, dy, dz);
      if (dlen < 1e-12) continue;
      dx /= dlen; dy /= dlen; dz /= dlen;
      // World-space distance along the surface, so dh/ds is a true slope.
      const ds = dlen * Math.min(plen, qlen);
      if (ds < 1e-12) continue;
      const slope = dh / ds;
      gx += dx * slope;
      gy += dy * slope;
      gz += dz * slope;
      count++;
    }
    if (count === 0) {
      normals[v * 3] = ux; normals[v * 3 + 1] = uy; normals[v * 3 + 2] = uz;
      continue;
    }
    gx /= count; gy /= count; gz /= count;

    // n ∝ up - gradient (up is the unit radial direction for a radial displacement).
    const nx = ux - gx;
    const ny = uy - gy;
    const nz = uz - gz;
    const nlen = Math.hypot(nx, ny, nz) || 1;
    normals[v * 3] = nx / nlen;
    normals[v * 3 + 1] = ny / nlen;
    normals[v * 3 + 2] = nz / nlen;
  }

  return normals;
}
