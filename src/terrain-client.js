/**
 * Async terrain bridge with graceful fallback.
 *
 * Wraps the terrain worker so the rest of the app can `await generate(shape)`
 * without caring where the work happened. If `Worker` is unavailable (older
 * browsers, some embedded webviews) the same code path runs on the main thread —
 * slower, but identical results, because both sides call `generateTerrain`.
 *
 * A monotonically increasing request id is used to drop stale results: while a
 * slider is being dragged, several requests can be in flight and only the newest
 * one may be adopted.
 */

import { generateTerrain } from './terrain-worker.js';

export class TerrainWorkerClient {
  constructor() {
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
    this.supported = typeof Worker !== 'undefined';
    if (this.supported) {
      try {
        this.worker = new Worker(new URL('./terrain-worker.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e) => this.#onMessage(e);
        this.worker.onerror = (e) => {
          // A worker that fails to load must not break generation; fall back.
          console.warn('terrain worker failed, falling back to main thread:', e.message);
          this.#failAll(e.message ?? 'worker error');
          this.worker = null;
          this.supported = false;
        };
      } catch (err) {
        console.warn('terrain worker unavailable, using main thread:', err);
        this.worker = null;
        this.supported = false;
      }
    }
  }

  #onMessage(event) {
    const { id, ok, result, error } = event.data;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (ok) entry.resolve(result);
    else entry.reject(new Error(error));
  }

  #failAll(message) {
    for (const { reject } of this.pending.values()) reject(new Error(message));
    this.pending.clear();
  }

  /**
   * Generate terrain asynchronously.
   *
   * @param {object} shape Shape parameters.
   * @returns {Promise<object>}
   */
  async generate(shape) {
    const id = this.nextId++;

    if (this.worker) {
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        // Copy the shape: the params object is shared with the UI and may be mutated
        // between posting and handling.
        this.worker.postMessage({ id, shape: { ...shape } });
      });
    }

    // Main-thread fallback. Yield first so the caller can paint a loading state
    // before the synchronous work begins.
    await new Promise((r) => requestAnimationFrame(() => r()));
    return generateTerrain({ ...shape });
  }

  /**
   * Whether the off-main-thread path is active. Surfaced in the HUD so it is visible
   * which code path a user is actually on.
   */
  get usingWorker() {
    return Boolean(this.worker);
  }

  dispose() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.#failAll('disposed');
  }
}
