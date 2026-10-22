/**
 * Capture delivery screenshots at the largest useful size.
 *
 * The capture uses the real app (dev server) rather than a bespoke scene, so the
 * images prove what a user actually sees. Each shot pins every parameter it does
 * not intend to test, so re-running this script is deterministic.
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5180/';
const OUT = join(process.cwd(), 'docs', 'images');
mkdirSync(OUT, { recursive: true });

/** Parameter overlays for each shot. */
const SHOTS = [
  {
    name: 'hero',
    viewport: { width: 1600, height: 1000 },
    params: { sunAzimuth: 62, sunElevation: 16, ringTilt: 24, ringOpacity: 0.9, cloudCoverage: 0.5, starCount: 3500 },
    camera: [0, 1.15, 4.6],
    full: true,
  },
  {
    name: 'planet-day',
    viewport: { width: 1400, height: 1000 },
    params: { sunAzimuth: 96, sunElevation: 12, ringTilt: 30, cloudCoverage: 0.46, starsEnabled: true, starCount: 3000 },
    camera: [0, 0.9, 4.4],
    ui: false,
  },
  {
    name: 'planet-terminator',
    viewport: { width: 1400, height: 1000 },
    params: { sunAzimuth: 172, sunElevation: 8, ringTilt: 18, cloudCoverage: 0.55, starCount: 3000 },
    camera: [0, 0.7, 4.2],
    ui: false,
  },
  {
    name: 'no-rings',
    viewport: { width: 1200, height: 900 },
    params: { sunAzimuth: 110, sunElevation: 18, ringsEnabled: false, cloudCoverage: 0.3, starCount: 2000 },
    camera: [0, 0.8, 3.6],
    ui: false,
  },
  {
    name: 'ocean-world',
    viewport: { width: 1200, height: 900 },
    params: {
      sunAzimuth: 100, sunElevation: 20, ringsEnabled: true, ringTilt: 34,
      continentBias: 0.2, plateCount: 9, mountainHeight: 0.03, cloudCoverage: 0.62,
    },
    camera: [0, 0.8, 4.0],
    ui: false,
  },
  {
    name: 'arid-world',
    viewport: { width: 1200, height: 900 },
    params: {
      sunAzimuth: 80, sunElevation: 26, continentBias: 0.82, plateCount: 26,
      mountainHeight: 0.1, riftDepth: 0.05, cloudCoverage: 0.12, iceCapLatitude: 0.98, starCount: 2000,
      // Warm palette spread across ALL bands, not just grass/forest. Leaving the
      // snow/ice/rock bands at their cool defaults meant the high-albedo tops still
      // averaged blue and the preset did not read as arid.
      colGrass: '#8a7440', colForest: '#6d5a2c', colBeach: '#c0a070',
      colRock: '#8a7a5e', colSnow: '#d6c9a4', colIce: '#e0d4b0', colSeaBed: '#3a3020', colShallow: '#5a6b5c',
      // Deserts have no ocean to speak of and a thin atmosphere.
      oceanEnabled: false, atmoIntensity: 0.55, atmoDensity: 5.2,
    },
    camera: [0, 0.75, 3.9],
    ui: false,
  },
  {
    name: 'l6-detail',
    viewport: { width: 1200, height: 900 },
    params: { detail: 6, sunAzimuth: 118, sunElevation: 14, ringsEnabled: false, cloudCoverage: 0.25, starCount: 1500 },
    camera: [0, 0.5, 2.4],
    ui: false,
    noShadow: true,
  },
];

async function main() {
  /** Geometry + measurements captured alongside each screenshot. */
  const metaFiles = {};

  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });

  for (const shot of SHOTS) {
    const context = await browser.newContext({ viewport: shot.viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => window.planetForge && window.planetForge.ready === true, { timeout: 90000 });
    await page.waitForTimeout(900);

    await page.evaluate(async (cfg) => {
      const f = window.planetForge;
      const rebuildKeys = f.REBUILD_KEYS;
      let rebuild = false;
      for (const [k, v] of Object.entries(cfg.params)) {
        if (k === 'detail') rebuild = true;
        f.params[k] = v;
        if (rebuildKeys.has(k)) rebuild = true;
      }
      f.params.autoRotate = false;
      f.applyLive();
      if (rebuild) {
        f.planet.regenerate();
        await new Promise((res) => setTimeout(res, 1200));
      }
      const [x, y, z] = cfg.camera;
      f.planet.camera.position.set(x, y, z);
      f.controls().target.set(0, 0, 0);
      f.controls().update();
      if (cfg.ui === false) {
        // Hide the chrome so the screenshot shows only the render. Elements are
        // looked up defensively because the topbar has no id.
        for (const sel of ['#panel', '#hud', '.topbar', '.bottombar', '#btn-expand']) {
          const el = document.querySelector(sel);
          if (el) el.style.display = 'none';
        }
      }
    }, shot);

    await page.waitForTimeout(1200);

    // Record the projected disc geometry while the page is still live. The review
    // script consumes this instead of guessing the radius from the framing, which
    // is the only way to keep the measurements honest across camera changes.
    const meta = await page.evaluate(() => {
      const f = window.planetForge;
      const cam = f.planet.camera;
      const H = f.renderer.domElement.height;
      const R = 1.05; // planet radius + relief budget
      const d = cam.position.length();
      const halfAngle = Math.asin(Math.min(1, R / d));
      const screenRadius = Math.tan(halfAngle) / Math.tan((cam.fov * Math.PI) / 360) * (H / 2);
      const m = f.planet.measure();
      return {
        canvasHeight: H,
        canvasWidth: f.renderer.domElement.width,
        fov: cam.fov,
        cameraDistance: d,
        screenRadius,
        simulatedRadius: R,
        measurements: m,
        params: { ...f.params },
      };
    });
    metaFiles[shot.name] = meta;
    // `full` shots capture the whole window (including UI); the rest capture the
    // canvas only.
    const target = shot.full ? page : page.locator('#scene');
    await target.screenshot({ path: join(OUT, `${shot.name}.png`) });
    console.log('saved', shot.name);
    await context.close();
  }

  writeFileSync(join(OUT, 'capture-meta.json'), JSON.stringify(metaFiles, null, 2));
  console.log('meta written');
  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
