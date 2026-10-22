/**
 * Terrain generation worker.
 *
 * ## Why a worker, given generation is only ~70-180 ms
 *
 * 70 ms is already a dropped frame budget four times over. On L6 with hydraulic
 * erosion the pipeline measures ~180 ms, which drags a slider and leaves the page
 * unresponsive. The loading overlay hides the visual gap but the main thread is
 * genuinely blocked, so input is queued and the composite pass stalls.
 *
 * ## Design constraints
 *
 * Everything from `icosphere.js` down is free of three.js and of DOM access, so it
 * runs here unchanged. Results cross the boundary as transferable typed arrays, which
 * is why the pipeline was written to produce `Float32Array`/`Uint32Array` rather than
 * object graphs.
 *
 * A request id is echoed back so stale results can be discarded: dragging a slider
 * fires several requests and the UI must not adopt an older planet than the one it
 * last asked for.
 */

import { createIcosphere } from '../src/icosphere.js';
import { buildHeightField, computeDisplacedNormals } from '../src/heightfield.js';
import { applyRadii } from '../src/icosphere.js';

/**
 * Run the full generation pipeline and return transferable-looking plain objects.
 *
 * @param {object} shape Shape parameters (see params.shapeParams).
 * @returns {object}
 */
export function generateTerrain(shape) {
  const started = (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // The icosphere is cached per level: dragging a tectonic slider keeps the same
  // topology, and rebuilding it costs ~30 ms at L5 for no reason.
  const ico = getIcosphere(shape.detail);
  const field = buildHeightField(ico, shape);
  const radius = shape.radius ?? 1;

  const radii = new Float32Array(ico.vertexCount);
  for (let v = 0; v < ico.vertexCount; v++) radii[v] = radius + field.elevation[v];
  const positions = applyRadii(ico.positions, radii);
  const normals = computeDisplacedNormals(ico, positions);

  const elevAttr = new Float32Array(ico.vertexCount);
  for (let v = 0; v < ico.vertexCount; v++) elevAttr[v] = field.elevation[v] / radius;

  // Normalised catchment area for river shading.
  const riverAttr = new Float32Array(ico.vertexCount);
  if (field.riverFlow) {
    let maxFlow = 1;
    for (let v = 0; v < ico.vertexCount; v++) if (field.riverFlow[v] > maxFlow) maxFlow = field.riverFlow[v];
    const logMax = Math.log(1 + maxFlow);
    for (let v = 0; v < ico.vertexCount; v++) {
      const above = Math.min(1, Math.max(0, 1 - Math.exp(-field.riverFlow[v] / (maxFlow * 0.08))));
      riverAttr[v] = (Math.log(1 + field.riverFlow[v]) / logMax) * above;
    }
  }

  const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started;

  return {
    positions,
    normals,
    elevAttr,
    riverAttr,
    indices: ico.indices,
    unitPositions: ico.positions,
    elevation: field.elevation,
    oceanMask: field.oceanMask,
    vertexCount: ico.vertexCount,
    triangleCount: ico.triangleCount,
    level: ico.level,
    stats: field.stats,
    plateCount: field.plateCount,
    genMs: elapsed,
  };
}

/** Per-level icosphere cache, keyed by subdivision level. */
const icoCache = new Map();

function getIcosphere(level) {
  const hit = icoCache.get(level);
  if (hit) return hit;
  const ico = createIcosphere(level);
  // Keep at most two levels: a third would hold ~60k vertices of geometry for
  // nothing, and LOD only ever toggles between two adjacent levels.
  if (icoCache.size >= 2) icoCache.delete(icoCache.keys().next().value);
  icoCache.set(level, ico);
  return ico;
}

// --- worker entry ----------------------------------------------------------

const isWorker = typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined';

if (isWorker) {
  self.onmessage = (event) => {
    const { id, shape } = event.data;
    try {
      const result = generateTerrain(shape);
      // Transfer the big buffers instead of copying them. The structured clone of a
      // 40k-vertex planet is ~1.5 MB; transferring is effectively free.
      const transfer = [
        result.positions.buffer,
        result.normals.buffer,
        result.elevAttr.buffer,
        result.riverAttr.buffer,
        result.indices.buffer,
        result.unitPositions.buffer,
        result.elevation.buffer,
        result.oceanMask.buffer,
      ];
      self.postMessage({ id, ok: true, result }, transfer);
    } catch (err) {
      self.postMessage({ id, ok: false, error: err?.message ?? String(err) });
    }
  };
}
