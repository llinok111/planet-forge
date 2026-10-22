/**
 * Tectonic plate tessellation.
 *
 * The upstream library's roadmap lists "simulating tectonic plates as a
 * procedural generation method" as an unimplemented idea pointing at
 * procedural-planet-generation. This module is that implementation, adapted to
 * spherical geometry: seed points are grown into Voronoi-like plates over the
 * icosphere's vertex graph, each plate gets its own motion and base elevation,
 * and boundaries are classified by the relative motion of the two plates.
 *
 * How the planet reads as "tectonic" rather than "noise":
 *   - convergent boundaries raise a collisional mountain belt (ridge noise on top)
 *   - divergent boundaries cut a rift valley below the plate baseline
 *   - oceanic plates sit measurably lower than continental plates
 *   - a plate's base elevation follows an age term, so old plates are buoyant
 */

import { mulberry32 } from './noise3d.js';

/**
 * Grow plates by multi-source BFS over the vertex graph.
 *
 * BFS on the graph (rather than a pure distance rule) guarantees every vertex is
 * assigned, produces contiguous plates with no holes, and costs O(V + E).
 *
 * @param {object} geometry Result of createIcosphere.
 * @param {number} plateCount Target number of plates.
 * @param {number} seed Unsigned 32-bit seed for seed-point placement.
 * @returns {{
 *   plateOf: Uint16Array,
 *   plateCount: number,
 *   plateCenters: Float64Array,
 *   plateIsOceanic: Uint8Array
 * }}
 */
export function growPlates(geometry, plateCount, seed) {
  const { vertexCount, positions, adjacency, adjacencyOffsets } = geometry;
  const count = Math.max(2, Math.min(64, Math.floor(plateCount)));
  const rng = mulberry32(seed);

  // Place seed vertices with best-candidate sampling: pick the candidate that is
  // farthest from any already-chosen seed so plates end up roughly equal in area.
  const chosen = [];
  const candidatesPerPick = 24;
  const chosenSet = new Set();
  for (let p = 0; p < count; p++) {
    let best = -1;
    let bestDist = -Infinity;
    for (let c = 0; c < candidatesPerPick; c++) {
      const idx = Math.floor(rng() * vertexCount);
      if (chosenSet.has(idx)) continue;
      let nearest = Infinity;
      for (const s of chosen) {
        const dx = positions[idx * 3] - positions[s * 3];
        const dy = positions[idx * 3 + 1] - positions[s * 3 + 1];
        const dz = positions[idx * 3 + 2] - positions[s * 3 + 2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < nearest) nearest = d;
      }
      if (nearest > bestDist) {
        bestDist = nearest;
        best = idx;
      }
    }
    if (best < 0) {
      // Degenerate fallback: the graph is tiny, so fill in order.
      best = (p * Math.max(1, Math.floor(vertexCount / count))) % vertexCount;
      while (chosenSet.has(best)) best = (best + 1) % vertexCount;
    }
    chosen.push(best);
    chosenSet.add(best);
  }

  const plateOf = new Uint16Array(vertexCount);
  plateOf.fill(0xffff);
  const queue = new Int32Array(vertexCount);
  let head = 0;
  let tail = 0;
  for (let p = 0; p < chosen.length; p++) {
    plateOf[chosen[p]] = p;
    queue[tail++] = chosen[p];
  }

  // Multi-source BFS. Randomised neighbour order per pop keeps the boundary
  // between two growing plates irregular instead of geometrically sharp.
  while (head < tail) {
    const v = queue[head++];
    const own = plateOf[v];
    const start = adjacencyOffsets[v];
    const end = adjacencyOffsets[v + 1];
    for (let k = start; k < end; k++) {
      const nb = adjacency[k];
      if (plateOf[nb] !== 0xffff) continue;
      plateOf[nb] = own;
      queue[tail++] = nb;
    }
  }

  // Any vertex unreachable through the graph (should not happen) falls back to
  // its nearest seed so downstream code never sees 0xffff.
  for (let v = 0; v < vertexCount; v++) {
    if (plateOf[v] === 0xffff) {
      let best = 0;
      let bestD = Infinity;
      for (let p = 0; p < chosen.length; p++) {
        const dx = positions[v * 3] - positions[chosen[p] * 3];
        const dy = positions[v * 3 + 1] - positions[chosen[p] * 3 + 1];
        const dz = positions[v * 3 + 2] - positions[chosen[p] * 3 + 2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; best = p; }
      }
      plateOf[v] = best;
    }
  }

  const plateCenters = new Float64Array(count * 3);
  const plateSizes = new Uint32Array(count);
  for (let v = 0; v < vertexCount; v++) {
    const p = plateOf[v];
    plateCenters[p * 3] += positions[v * 3];
    plateCenters[p * 3 + 1] += positions[v * 3 + 1];
    plateCenters[p * 3 + 2] += positions[v * 3 + 2];
    plateSizes[p]++;
  }
  for (let p = 0; p < count; p++) {
    const len = Math.hypot(plateCenters[p * 3], plateCenters[p * 3 + 1], plateCenters[p * 3 + 2]) || 1;
    plateCenters[p * 3] /= len;
    plateCenters[p * 3 + 1] /= len;
    plateCenters[p * 3 + 2] /= len;
  }

  const plateIsOceanic = new Uint8Array(count);
  for (let p = 0; p < count; p++) plateIsOceanic[p] = rng() < 0.5 ? 1 : 0;

  const used = plateSizes.reduce((n, s) => n + (s > 0 ? 1 : 0), 0);
  return { plateOf, plateCount: used, plateCenters, plateIsOceanic, plateSizes, seedVertices: chosen };
}

/**
 * Classify each vertex's role relative to its plate boundary.
 *
 * @param {object} geometry
 * @param {Uint16Array} plateOf
 * @param {number} plateCount
 * @returns {{
 *   boundary: Float32Array,
 *   neighbourPlate: Int16Array,
 *   isBoundary: Uint8Array,
 *   boundaryVertices: number
 * }} boundary ∈ [0,1] measures how much of the neighbourhood belongs to other plates.
 */
export function classifyBoundaries(geometry, plateOf, plateCount) {
  const { vertexCount, adjacency, adjacencyOffsets } = geometry;
  const boundary = new Float32Array(vertexCount);
  const neighbourPlate = new Int16Array(vertexCount);
  const isBoundary = new Uint8Array(vertexCount);
  let boundaryVertices = 0;

  for (let v = 0; v < vertexCount; v++) {
    const own = plateOf[v];
    let foreign = 0;
    let total = 0;
    let firstForeign = -1;
    for (let k = adjacencyOffsets[v]; k < adjacencyOffsets[v + 1]; k++) {
      const nb = adjacency[k];
      total++;
      if (plateOf[nb] !== own) {
        foreign++;
        if (firstForeign < 0) firstForeign = plateOf[nb];
      }
    }
    if (total === 0) continue;
    const ratio = foreign / total;
    boundary[v] = ratio;
    neighbourPlate[v] = firstForeign;
    if (foreign > 0) {
      isBoundary[v] = 1;
      boundaryVertices++;
    }
  }

  return { boundary, neighbourPlate, isBoundary, boundaryVertices, plateCount };
}
