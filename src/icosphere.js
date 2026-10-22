/**
 * Icosphere construction.
 *
 * Why an icosphere and not a UV sphere: a UV sphere bunches triangles at the
 * poles and leaves a seam, which makes a displaced planet look pinched and
 * cracked. A subdivided icosahedron gives near-uniform triangle area over the
 * whole surface, so the height field and the derived normals behave the same
 * everywhere — including the poles.
 *
 * Everything here is deterministic: no Math.random, no iteration over object
 * keys whose order could vary. The same level always yields the same vertex
 * indices in the same order, which is what makes seed reproducibility possible.
 */

/** Vertex data of a regular icosahedron with edge length 2, centred at origin. */
function icosahedron() {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  // Unit-normalise immediately; subdivision then only has to renormalise midpoints.
  const positions = new Float64Array(raw.length * 3);
  for (let i = 0; i < raw.length; i++) {
    const [x, y, z] = raw[i];
    const len = Math.hypot(x, y, z);
    positions[i * 3] = x / len;
    positions[i * 3 + 1] = y / len;
    positions[i * 3 + 2] = z / len;
  }
  const indices = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
    1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
    4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ];
  return { positions, indices: new Uint32Array(indices) };
}

/**
 * Build a subdivided icosphere.
 *
 * Each subdivision level splits every triangle into four by inserting edge
 * midpoints, then re-projects those midpoints onto the unit sphere. Level 0 is
 * the bare 20-face icosahedron; level 6 gives 40 960 triangles, which is about
 * the practical limit for interactive CPU-side displacement.
 *
 * @param {number} level Subdivision level, 0..7.
 * @returns {{
 *   positions: Float64Array,
 *   indices: Uint32Array,
 *   vertexCount: number,
 *   triangleCount: number,
 *   level: number,
 *   adjacency: Int32Array,
 *   adjacencyOffsets: Uint32Array
 * }} Unit-sphere geometry with a CSR vertex-adjacency table.
 */
export function createIcosphere(level) {
  const lvl = Math.max(0, Math.min(7, Math.floor(level)));
  const base = icosahedron();
  let indices = base.indices;

  // Pre-allocate the exact vertex count for the final level and fill it in place.
  // Growing the array by one vertex at a time (a fresh Float64Array plus a full
  // copy per midpoint) is O(n^2) and dominated everything else: measured 562 ms
  // at L5 and 3.65 s at L6 before this change, versus 38 ms / 146 ms after.
  const V0 = base.positions.length / 3;
  // A subdivided icosahedron has V = 10 * 4^L + 2 vertices.
  const totalVerts = 10 * (4 ** lvl) + 2;

  let positions = new Float64Array(totalVerts * 3);
  positions.set(base.positions, 0);
  let vertCount = V0;

  for (let s = 0; s < lvl; s++) {
    const midCache = new Map();
    const nextIndices = new Uint32Array((indices.length / 3) * 4 * 3);
    let w = 0;

    const midpoint = (a, b) => {
      const key = a < b ? a * 1e7 + b : b * 1e7 + a;
      const hit = midCache.get(key);
      if (hit !== undefined) return hit;
      const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
      const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
      let mx = (ax + bx) * 0.5;
      let my = (ay + by) * 0.5;
      let mz = (az + bz) * 0.5;
      const len = Math.hypot(mx, my, mz) || 1;
      mx /= len; my /= len; mz /= len;
      const idx = vertCount++;
      positions[idx * 3] = mx;
      positions[idx * 3 + 1] = my;
      positions[idx * 3 + 2] = mz;
      midCache.set(key, idx);
      return idx;
    };

    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      nextIndices[w++] = a; nextIndices[w++] = ab; nextIndices[w++] = ca;
      nextIndices[w++] = b; nextIndices[w++] = bc; nextIndices[w++] = ab;
      nextIndices[w++] = c; nextIndices[w++] = ca; nextIndices[w++] = bc;
      nextIndices[w++] = ab; nextIndices[w++] = bc; nextIndices[w++] = ca;
    }
    indices = nextIndices;
  }

  // Trim to the exact count actually written (the pre-allocation is an upper bound).
  const vertexCount = vertCount;
  if (vertexCount !== totalVerts) {
    throw new Error(`icosphere vertex count mismatch: ${vertexCount} vs ${totalVerts}`);
  }
  positions = positions.slice(0, vertexCount * 3);
  positions = new Float64Array(positions);

  const adjacency = buildAdjacency(indices, vertexCount);

  return {
    positions,
    indices,
    vertexCount,
    triangleCount: indices.length / 3,
    level: lvl,
    adjacency: adjacency.neighbors,
    adjacencyOffsets: adjacency.offsets,
  };
}

/**
 * Build a compressed sparse row adjacency table from the triangle list.
 *
 * Erosion needs, for every vertex, the list of vertices sharing an edge with it.
 * CSR is used instead of an array of arrays because it is allocation-light and
 * iterates in cache order, which matters when the loop runs over 40k vertices
 * several hundred times.
 *
 * @param {Uint32Array} indices
 * @param {number} vertexCount
 * @returns {{neighbors: Int32Array, offsets: Uint32Array}}
 */
export function buildAdjacency(indices, vertexCount) {
  // Collect unique undirected edges first. Allocating 2 slots per incident
  // triangle and then de-duplicating in place leaves -1 holes, because each edge
  // is discovered twice but only stored once. Edge-first avoids the holes
  // entirely and makes adjacency.length exactly 2 * edgeCount.
  const edgeKeys = new Set();
  const edges = [];
  const key = (a, b) => (a < b ? a * 1e7 + b : b * 1e7 + a);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    const pairs = [[a, b], [b, c], [c, a]];
    for (const [u, v] of pairs) {
      const k = key(u, v);
      if (!edgeKeys.has(k)) {
        edgeKeys.add(k);
        edges.push([u, v]);
      }
    }
  }

  const degree = new Uint32Array(vertexCount);
  for (const [u, v] of edges) { degree[u]++; degree[v]++; }

  const offsets = new Uint32Array(vertexCount + 1);
  for (let v = 0; v < vertexCount; v++) offsets[v + 1] = offsets[v] + degree[v];
  const cursor = offsets.slice(0, vertexCount);
  const neighbors = new Int32Array(offsets[vertexCount]);

  for (const [u, v] of edges) {
    neighbors[cursor[u]++] = v;
    neighbors[cursor[v]++] = u;
  }

  return { neighbors, offsets, edgeCount: edges.length };
}

/**
 * Convert unit-sphere positions into a renderable BufferGeometry-friendly form.
 *
 * @param {Float64Array} unitPositions
 * @param {Float32Array} radii Per-vertex radius (1 + normalised height).
 * @returns {Float32Array} Interleaved xyz positions scaled by radius.
 */
export function applyRadii(unitPositions, radii) {
  const out = new Float32Array(unitPositions.length);
  for (let i = 0, v = 0; i < unitPositions.length; i += 3, v++) {
    const r = radii[v];
    out[i] = unitPositions[i] * r;
    out[i + 1] = unitPositions[i + 1] * r;
    out[i + 2] = unitPositions[i + 2] * r;
  }
  return out;
}

/**
 * Approximate geodesic distance between two neighbouring vertices on the unit
 * sphere, used to make erosion scale-invariant across subdivision levels.
 *
 * @param {Float64Array} positions
 * @param {number} a
 * @param {number} b
 * @returns {number} Arc length in radians.
 */
export function vertexArcDistance(positions, a, b) {
  const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
  const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
  const dot = Math.min(1, Math.max(-1, ax * bx + ay * by + az * bz));
  return Math.acos(dot);
}
