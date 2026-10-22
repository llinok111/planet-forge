/**
 * Application entry point.
 *
 * Responsibilities, in order of importance:
 *   1. Keep a single `params` object that is the only source of truth; the URL,
 *      the panel, the export and the scene all read from it.
 *   2. Decide per parameter whether the change needs a geometry rebuild (shape)
 *      or can be applied live. Getting this wrong is the usual cause of a demo
 *      that either feels laggy or silently ignores its controls.
 *   3. Drive one rAF loop; all animation is time-based, so frame rate does not
 *      change the physics or the cloud drift speed.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PlanetScene } from './planet.js';
import { createPanel } from './ui.js';
import {
  defaultParams,
  decodeParams,
  encodeParams,
  PARAMS,
  paramDef,
  GROUPS,
} from './params.js';
import { exportGLB, buildSceneJSON, downloadBlob } from './io.js';

const REBUILD_KEYS = new Set(PARAMS.filter((p) => p.rebuild).map((p) => p.key));

const canvas = document.getElementById('scene');
const loadingEl = document.getElementById('loading');
const toastEl = document.getElementById('toast');

/** Params: URL first, then defaults. */
const params = decodeParams(window.location.search);
// `radius` is a library concern, not a UI slider; keep it fixed at 1.
params.radius = 1;

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;

let planet = null;
let controls = null;
let lastFrameTime = 0;
let frameCount = 0;
let fpsAccum = 0;
let lastGenMs = 0;
let lastLodCheck = 0;

function showToast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.classList.toggle('error', isError);
  toastEl.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

function setLoading(on) {
  if (on) {
    loadingEl.hidden = false;
    loadingEl.classList.remove('fade');
  } else {
    loadingEl.classList.add('fade');
    setTimeout(() => { loadingEl.hidden = true; }, 260);
  }
}

// ------------------------------------------------------------------ camera --

function setupControls(camera, domElement) {
  const c = new OrbitControls(camera, domElement);
  c.enableDamping = true;
  c.dampingFactor = 0.06;
  c.rotateSpeed = 0.62;
  c.zoomSpeed = 0.85;
  c.panSpeed = 0.5;
  c.minDistance = 1.22;
  c.maxDistance = 22;
  c.enablePan = true;
  c.autoRotate = false;
  return c;
}

// ------------------------------------------------------------------ sizing --

function resize() {
  if (!planet) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  planet.camera.aspect = w / h;
  planet.camera.updateProjectionMatrix();
  // Keep the atmosphere composer's offscreen target in step with the canvas.
  if (planet.atmospherePass) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    planet.atmospherePass.setSize(size.x, size.y, 1);
  }
  planet.pixelRatio = renderer.getPixelRatio();
}

// -------------------------------------------------------------- generation --

function buildPlanet({ initial = false } = {}) {
  const started = performance.now();
  const cameraPosition = planet ? planet.camera.position.clone() : null;

  if (planet) planet.dispose();
  planet = new PlanetScene(params, renderer);
  planet.pixelRatio = renderer.getPixelRatio();

  // Preserve the user's viewpoint across regenerations; only the first build
  // decides the framing.
  if (cameraPosition) planet.camera.position.copy(cameraPosition);
  else {
    planet.camera.position.set(0, 0.95, 3.35);
    planet.camera.lookAt(0, 0, 0);
  }

  if (controls) controls.dispose();
  controls = setupControls(planet.camera, renderer.domElement);

  lastGenMs = performance.now() - started;
  resize();
  updateHud(true);

  if (!initial) showToast(`已重新生成 · ${lastGenMs.toFixed(0)} ms`);
}

/**
 * Regenerate geometry without blocking the main thread.
 *
 * Generation runs in the terrain worker (or on the main thread if workers are
 * unavailable); only mesh assembly happens here. The camera and controls survive,
 * so the viewpoint is preserved across a rebuild.
 */
async function rebuildPlanetAsync() {
  const started = performance.now();

  if (!planet) {
    planet = new PlanetScene(params, renderer);
    planet.pixelRatio = renderer.getPixelRatio();
    planet.camera.position.set(0, 0.95, 3.35);
    planet.camera.lookAt(0, 0, 0);
  } else {
    // Keep the framing the user chose.
    await planet.regenerateAsync();
  }

  if (!controls) controls = setupControls(planet.camera, renderer.domElement);
  lastGenMs = performance.now() - started;
  resize();
  updateHud();
}

/** Regenerate after a shape change, yielding to the browser so the overlay paints. */
function regenerateShape(changedKey) {
  // `ready` must drop *before* the rebuild begins. Leaving it true lets an external
  // observer (the e2e harness) read the old scene while the new one is being built —
  // which produced a false "seed is not reproducible" failure during development.
  window.planetForge.ready = false;
  setLoading(true);
  requestAnimationFrame(() => {
    // Second rAF: guarantees the overlay has been painted before the sync work.
    requestAnimationFrame(async () => {
      try {
        await rebuildPlanetAsync();
        window.planetForge.ready = true;
        syncUrl();
        if (changedKey && paramDef(changedKey)) {
          // no-op: the toast from buildPlanet already reports timing
        }
      } catch (err) {
        console.error(err);
        showToast(`生成失败：${err.message}`, true);
        // Mark ready anyway so callers do not hang forever; the error is visible in
        // the toast and the console.
        window.planetForge.ready = true;
      } finally {
        setLoading(false);
      }
    });
  });
}

function applyLive() {
  if (!planet) return;
  planet.params = params;
  planet.applyLive();
  syncUrl();
}

// --------------------------------------------------------------------- URL --

let urlTimer = null;
function syncUrl() {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => {
    const query = encodeParams(params);
    const url = `${window.location.pathname}${query ? `?${query}` : ''}`;
    window.history.replaceState(null, '', url);
  }, 180);
}

// --------------------------------------------------------------------- HUD --

function updateHud(force = false) {
  if (!planet) return;
  const m = planet.measure();
  document.getElementById('hud-verts').textContent = m.vertices.toLocaleString('en-US');
  document.getElementById('hud-tris').textContent = m.triangles.toLocaleString('en-US');
  document.getElementById('hud-relief').textContent = m.relief.toFixed(4);
  document.getElementById('hud-land').textContent = `${(m.landFraction * 100).toFixed(1)}%`;
  document.getElementById('hud-plates').textContent = String(m.plateCount);
  document.getElementById('hud-clouds').textContent = `${(m.cloudCoverage * 100).toFixed(0)}%`;
  document.getElementById('hud-gen').textContent = `${lastGenMs.toFixed(0)} ms`;
  const lodEl = document.getElementById('hud-lod');
  if (lodEl) {
    const st = planet.heightField?.stats;
    lodEl.textContent = `L${m.detailLevel}${planet.params.autoLod ? ' 自动' : ''}`;
    void st;
  }
  const modeEl = document.getElementById('hud-mode');
  if (modeEl) modeEl.textContent = planet.workerClient?.usingWorker ? 'Worker' : '主线程';
  void force;
}

// ---------------------------------------------------------------- panel wire --

const panel = createPanel(document.getElementById('groups'), params, {
  onLive(key) {
    applyLive();
    if (key === 'sunAzimuth' || key === 'sunElevation') updateHud();
  },
  onRebuild() {
    regenerateShape(null);
  },
  onSeedChange(seed) {
    params.seed = seed;
    document.getElementById('seed-input').value = seed;
    regenerateShape('seed');
  },
});

document.getElementById('seed-input').value = params.seed;

// ---------------------------------------------------------------- DOM events --

document.getElementById('btn-apply-seed').addEventListener('click', () => {
  const value = document.getElementById('seed-input').value.trim();
  if (!value) return;
  params.seed = value;
  regenerateShape('seed');
});

document.getElementById('seed-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-apply-seed').click();
});

document.getElementById('btn-random').addEventListener('click', () => {
  const words = ['amber', 'vortex', 'tundra', 'cobalt', 'ember', 'lumen', 'basalt', 'cinder', 'drift', 'halcyon', 'quartz', 'vellum', 'osmium', 'sable', 'nimbus', 'verdant'];
  const seed = `${words[Math.floor(Math.random() * words.length)]}-${Math.floor(Math.random() * 9000 + 1000)}`;
  params.seed = seed;
  document.getElementById('seed-input').value = seed;
  panel.syncFromParams();
  regenerateShape('seed');
});

document.getElementById('btn-reset').addEventListener('click', () => {
  const fresh = defaultParams();
  fresh.radius = 1;
  Object.assign(params, fresh);
  document.getElementById('seed-input').value = params.seed;
  panel.syncFromParams();
  regenerateShape(null);
});

document.getElementById('btn-copy').addEventListener('click', async () => {
  const query = encodeParams(params);
  const url = `${window.location.origin}${window.location.pathname}${query ? `?${query}` : ''}`;
  try {
    await navigator.clipboard.writeText(url);
    showToast('分享链接已复制');
  } catch {
    showToast('复制失败，请手动复制地址栏', true);
  }
});

const panelEl = document.getElementById('panel');
const expandBtn = document.getElementById('btn-expand');

document.getElementById('btn-collapse').addEventListener('click', () => {
  panelEl.hidden = true;
  expandBtn.hidden = false;
});

expandBtn.addEventListener('click', () => {
  panelEl.hidden = false;
  expandBtn.hidden = true;
});

document.getElementById('btn-glb').addEventListener('click', async () => {
  try {
    showToast('正在导出 GLB…');
    const buffer = await exportGLB(planet);
    downloadBlob(new Blob([buffer], { type: 'model/gltf-binary' }), `planet-${params.seed}.glb`);
    showToast(`GLB 已导出 · ${(buffer.byteLength / 1048576).toFixed(2)} MB`);
  } catch (err) {
    console.error(err);
    showToast(`GLB 导出失败：${err.message}`, true);
  }
});

document.getElementById('btn-json').addEventListener('click', () => {
  const json = buildSceneJSON(planet);
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `planet-${params.seed}.scene.json`);
  showToast('场景 JSON 已导出');
});

document.getElementById('btn-png').addEventListener('click', () => {
  planet.renderInto(renderer);
  const dataUrl = renderer.domElement.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `planet-${params.seed}.png`;
  a.click();
  showToast('截图已保存');
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === 'r' || e.key === 'R') document.getElementById('btn-random').click();
});

window.addEventListener('resize', resize);

// --------------------------------------------------------------- main loop --

function animate(now) {
  requestAnimationFrame(animate);
  if (!planet) return;

  const seconds = now / 1000;
  const delta = lastFrameTime ? Math.min(0.1, seconds - lastFrameTime) : 0;
  lastFrameTime = seconds;

  controls.update();

  // Camera-distance LOD: checked a few times per second rather than every frame,
  // because each triggered switch costs a full regeneration.
  if (seconds - lastLodCheck > 0.6 && !planet.regenerating) {
    lastLodCheck = seconds;
    planet.updateLod().catch((err) => console.warn('LOD switch failed:', err));
  }

  planet.update(seconds, delta);
  // Route through the scene's own render entry point so the atmosphere composite
  // pass runs; calling renderer.render directly would bypass it.
  planet.renderInto(renderer);

  frameCount++;
  fpsAccum += delta;
  if (fpsAccum >= 0.5) {
    const fps = frameCount / fpsAccum;
    const fpsEl = document.getElementById('hud-fps');
    if (fpsEl) fpsEl.textContent = `${fps.toFixed(0)} fps`;
    frameCount = 0;
    fpsAccum = 0;
    updateHud();
  }
}

// ------------------------------------------------------------------- boot --

function boot() {
  setLoading(true);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      try {
        buildPlanet({ initial: true });
        panel.syncFromParams();
        syncUrl();
        // Compile shaders up front so the first visible frame is not a stall.
        renderer.compile(planet.three, planet.camera);
        setLoading(false);
        window.planetForge.ready = true;
        requestAnimationFrame(animate);
      } catch (err) {
        console.error(err);
        loadingEl.innerHTML = `<p style="color:#f0a184">初始化失败：${err.message}</p>`;
      }
    });
  });
}

// Expose for e2e tests and the console. `ready` flips only after the first
// successful build, so the test harness never races the scene graph.
window.planetForge = {
  get planet() { return planet; },
  params,
  renderer,
  controls: () => controls,
  regenerate: () => regenerateShape(null),
  applyLive,
  encodeParams,
  buildSceneJSON,
  exportGLB,
  GROUPS,
  REBUILD_KEYS,
  ready: false,
};

boot();
