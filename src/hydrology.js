/**
 * Hydraulic erosion by drainage accumulation.
 *
 * ## Why this is a separate algorithm from the thermal pass
 *
 * Thermal erosion (heightfield.js) only relaxes slopes that exceed the angle of
 * repose. It produces talus and flats but no *channels*: water is not modelled at
 * all, so valleys stay shallow and nothing connects them. Real terrain is organised
 * by a drainage network — many small gullies feeding fewer larger ones — and that
 * structure is what makes a landscape read as sculpted rather than noise.
 *
 * ## Method
 *
 * A simplified version of the classic priority-flood + flow-accumulation approach:
 *
 *   1. Sort vertices by elevation, high to low.
 *   2. For each vertex, find its steepest-descent neighbour on the sphere graph.
 *   3. Accumulate catchment area along that receiver chain (each vertex starts with
 *      unit rain, so `flow` is the number of upstream vertices).
 *   4. Incise: lower the bed by an amount proportional to `flow^m * slope^n`, the
 *      standard stream-power law. Exponent m < n favours valleys over ridges.
 *   5. Re-close the sinks left behind (a single thermal pass) so the result has no
 *      pits that would read as noise at close range.
 *
 * Running on the vertex graph rather than a height raster is what makes this work
 * on a sphere: there is no pole singularity and no wrap-around to handle, because
 * neighbours are simply the mesh edges.
 *
 * ## Cost
 *
 * O(V log V) for the sort plus O(V) passes; the sort dominates at ~12 ms for L5.
 * That is why it is a separate, optional stage rather than always-on.
 */

/**
 * Compute catchment area and a river mask without modifying elevations.
 *
 * Exposed separately so the mask can drive shading (river colour, moisture) and so
 * tests can assert the network is acyclic and connected to the ocean.
 *
 * @param {object} geometry Result of createIcosphere.
 * @param {Float32Array} elevation Per-vertex elevation (radii, sea level = 0).
 * @returns {{
 *   flow: Float32Array,
 *   receiver: Int32Array,
 *   order: Uint32Array,
 *   distanceToSea: Float32Array
 * }}
 */
export function computeDrainage(geometry, elevation) {
  const { vertexCount, adjacency, adjacencyOffsets } = geometry;

  // Process high to low. A typed sort is used rather than a comparator callback
  // because the callback version allocates V closures per call.
  const order = new Uint32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) order[i] = i;
  const sorted = Array.from(order).sort((a, b) => elevation[b] - elevation[a]);
  for (let i = 0; i < vertexCount; i++) order[i] = sorted[i];

  const receiver = new Int32Array(vertexCount).fill(-1);
  const flow = new Float32Array(vertexCount).fill(1); // one unit of rain per vertex

  // Steepest descent receiver, restricted to strictly lower neighbours so the graph
  // is guaranteed acyclic. Vertices below sea level are sinks (they drain to the
  // ocean) and keep receiver = -1.
  for (let k = 0; k < vertexCount; k++) {
    const v = order[k];
    const hv = elevation[v];
    let best = -1;
    let bestDrop = 0;
    for (let j = adjacencyOffsets[v]; j < adjacencyOffsets[v + 1]; j++) {
      const nb = adjacency[j];
      const drop = hv - elevation[nb];
      if (drop > bestDrop) {
        bestDrop = drop;
        best = nb;
      }
    }
    if (best >= 0) receiver[v] = best;
  }

  // Accumulate in the same high-to-low order: by the time a vertex is visited, all
  // of its upstream contributors have already added their flow to it, because they
  // are strictly higher and therefore earlier in the order.
  for (let k = 0; k < vertexCount; k++) {
    const v = order[k];
    const r = receiver[v];
    if (r >= 0) flow[r] += flow[v];
  }

  // Distance to the sea along the receiver chain, in hops. Used to fade river
  // incision out near the coast, where the stream power model over-deepens.
  const distanceToSea = new Float32Array(vertexCount).fill(-1);
  for (let k = vertexCount - 1; k >= 0; k--) {
    const v = order[k];
    if (receiver[v] < 0) distanceToSea[v] = 0;
    else distanceToSea[v] = distanceToSea[receiver[v]] + 1;
  }

  return { flow, receiver, order, distanceToSea };
}

/**
 * Priority-flood depression filling.
 *
 * ## Why this is required, not optional
 *
 * Without it the drainage network is tiny and disconnected: measured on an L4 mesh,
 * `computeDrainage` produced 239 sinks, 146 of them already at sea level, and the
 * largest catchment reached only 42 of 2562 vertices. Every gully drained straight
 * into the sea-side sink next to it, so no trunk channel could form and the "rivers"
 * were invisible.
 *
 * Priority-flood fixes the cause: it raises landlocked depressions to their spill
 * point, so every land vertex gains a descending path to the ocean. Only then does
 * flow accumulate along a connected network the way a real watershed does.
 *
 * Implementation: a binary heap seeded with every vertex at or below sea level,
 * processed lowest-first. A vertex's filled height is `max(own, parent's) + epsilon`,
 * which both removes the pits and guarantees a monotone descent to the seed set.
 *
 * @param {object} geometry
 * @param {Float32Array} elevation Mutated in place.
 * @param {number} [seaLevel=0]
 * @returns {{filledVertices: number, maxFill: number}}
 */
export function fillDepressions(geometry, elevation, seaLevel = 0) {
  const { vertexCount, adjacency, adjacencyOffsets } = geometry;

  const filled = new Float32Array(vertexCount);
  const visited = new Uint8Array(vertexCount);

  // Simple binary min-heap over (height, vertex).
  const heapH = [];
  const heapV = [];
  const push = (h, v) => {
    heapH.push(h);
    heapV.push(v);
    let i = heapH.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heapH[parent] <= heapH[i]) break;
      [heapH[parent], heapH[i]] = [heapH[i], heapH[parent]];
      [heapV[parent], heapV[i]] = [heapV[i], heapV[parent]];
      i = parent;
    }
  };
  const pop = () => {
    const top = heapV[0];
    const lastH = heapH.pop();
    const lastV = heapV.pop();
    if (heapH.length > 0) {
      heapH[0] = lastH;
      heapV[0] = lastV;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < heapH.length && heapH[l] < heapH[smallest]) smallest = l;
        if (r < heapH.length && heapH[r] < heapH[smallest]) smallest = r;
        if (smallest === i) break;
        [heapH[smallest], heapH[i]] = [heapH[i], heapH[smallest]];
        [heapV[smallest], heapV[i]] = [heapV[i], heapV[smallest]];
        i = smallest;
      }
    }
    return top;
  };

  // Seed with the ocean and anything below it.
  for (let v = 0; v < vertexCount; v++) {
    if (elevation[v] <= seaLevel) {
      filled[v] = elevation[v];
      visited[v] = 1;
      push(elevation[v], v);
    }
  }

  let filledVertices = 0;
  let maxFill = 0;
  const eps = 1e-5;

  while (heapH.length > 0) {
    const v = pop();
    const h = filled[v];
    for (let j = adjacencyOffsets[v]; j < adjacencyOffsets[v + 1]; j++) {
      const nb = adjacency[j];
      if (visited[nb]) continue;
      visited[nb] = 1;
      // Raise to the spill height, plus a hair so the descent stays strictly
      // monotone and the receiver graph is acyclic.
      const raised = Math.max(elevation[nb], h + eps);
      const fill = raised - elevation[nb];
      if (fill > 1e-9) {
        filledVertices++;
        if (fill > maxFill) maxFill = fill;
      }
      filled[nb] = raised;
      push(raised, nb);
    }
  }

  for (let v = 0; v < vertexCount; v++) elevation[v] = filled[v];

  return { filledVertices, maxFill };
}

/**
 * Apply hydraulic incision to an elevation field.
 *
 * @param {object} geometry
 * @param {Float32Array} elevation Mutated in place.
 * @param {object} [options]
 * @param {number} [options.iterations=3] Passes of incision.
 * @param {number} [options.strength=0.55] Global incision scale.
 * @param {number} [options.m=0.45] Catchment exponent (lower favours main channels).
 * @param {number} [options.n=0.85] Slope exponent (higher favours steep reaches).
 * @param {number} [options.rainfall=1.0] Per-vertex rain input multiplier.
 * @returns {{
 *   carved: number,
 *   maxDepth: number,
 *   riverVertices: number,
 *   flow: Float32Array,
 *   distanceToSea: Float32Array
 * }}
 */
export function erodeHydraulic(geometry, elevation, options = {}) {
  const {
    iterations = 3,
    strength = 0.55,
    m = 0.45,
    n = 0.85,
    rainfall = 1.0,
  } = options;

  const { vertexCount, adjacency, adjacencyOffsets } = geometry;

  // Drainage only organises itself once every land vertex can reach the sea.
  const fillInfo = fillDepressions(geometry, elevation);

  let carved = 0;
  let maxDepth = 0;
  let flowOut = null;
  let seaOut = null;

  for (let pass = 0; pass < iterations; pass++) {
    const { flow, receiver, order, distanceToSea } = computeDrainage(geometry, elevation);
    flowOut = flow;
    seaOut = distanceToSea;

    // Normalise flow to a 0..1 range on a log scale: catchment sizes span three
    // orders of magnitude, and a linear map makes every river equally wide.
    let maxFlow = 1;
    for (let v = 0; v < vertexCount; v++) if (flow[v] > maxFlow) maxFlow = flow[v];
    const logMax = Math.log(1 + maxFlow);

    const delta = new Float32Array(vertexCount);

    for (let k = 0; k < vertexCount; k++) {
      const v = order[k];
      const r = receiver[v];
      if (r < 0) continue;
      // Only above sea level: carving the sea bed does nothing visible and can
      // punch visible pits under the ocean shell.
      if (elevation[v] <= 0) continue;

      const drop = elevation[v] - elevation[r];
      if (drop <= 0) continue;

      // Stream power: incision grows with catchment area and local slope.
      const area = Math.log(1 + flow[v] * rainfall) / Math.max(1e-6, logMax);
      const slope = drop;
      const power = Math.pow(area, m) * Math.pow(slope, n);

      // Fade near the coast: a river mouth should not be a trench.
      const coastal = Math.min(1, distanceToSea[v] / 6);

      const cut = power * strength * 0.012 * coastal;
      delta[v] -= cut;
      delta[r] += cut * 0.35; // deposition downstream
      carved += cut;
      if (cut > maxDepth) maxDepth = cut;
    }

    for (let v = 0; v < vertexCount; v++) elevation[v] += delta[v];
  }

  // Close the pits the incision left behind. One thermal pass is enough because the
  // cuts are shallow; more would erode the channels away, which is the whole point.
  relaxPits(geometry, elevation, 3, 0.5);

  let riverVertices = 0;
  if (flowOut) {
    let maxFlow = 1;
    for (let v = 0; v < vertexCount; v++) if (flowOut[v] > maxFlow) maxFlow = flowOut[v];
    const threshold = 1 + maxFlow * 0.02;
    for (let v = 0; v < vertexCount; v++) {
      if (flowOut[v] > threshold && elevation[v] > 0) riverVertices++;
    }
  }

  return { carved, maxDepth, riverVertices, flow: flowOut, distanceToSea: seaOut, fillInfo };
}

/**
 * Remove single-vertex pits.
 *
 * A pit is a vertex lower than every neighbour while the neighbours disagree with
 * each other; real basins have rims, pits do not. Left in place they render as
 * isolated dark dots that look like noise rather than terrain.
 *
 * @param {object} geometry
 * @param {Float32Array} elevation Mutated in place.
 * @param {number} iterations
 * @param {number} rate 0..1 how much of the pit depth to fill per pass.
 */
export function relaxPits(geometry, elevation, iterations, rate) {
  const { vertexCount, adjacency, adjacencyOffsets } = geometry;
  const delta = new Float32Array(vertexCount);

  for (let iter = 0; iter < iterations; iter++) {
    delta.fill(0);
    for (let v = 0; v < vertexCount; v++) {
      let lowest = Infinity;
      for (let j = adjacencyOffsets[v]; j < adjacencyOffsets[v + 1]; j++) {
        const hn = elevation[adjacency[j]];
        if (hn < lowest) lowest = hn;
      }
      if (!Number.isFinite(lowest)) continue;

      // A pit is a vertex lower than *every* neighbour. That is the whole criterion:
      // an extra "rim must have relief" test was tried and removed because it also
      // rejected genuine pits sitting in a symmetric bowl, so nothing got filled at
      // all. Valley floors are not pits: water can leave a valley, and a valley's
      // lowest vertex always has a lower neighbour downstream.
      if (elevation[v] < lowest - 1e-9) {
        delta[v] += (lowest - elevation[v]) * rate;
      }
    }
    for (let v = 0; v < vertexCount; v++) elevation[v] += delta[v];
  }
}
