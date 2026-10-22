/**
 * Live visual probes for the v2 subsystems.
 *
 * Kept as a file rather than inline shell snippets for two reasons: these probes
 * are re-run after every change to the shaders, and quoting a multi-line Playwright
 * script inside `node -e` is where most of this project's tooling mistakes came
 * from (one instance silently truncated the script and reported a false failure).
 *
 * Usage: node scripts/probe-v2.mjs [name]
 */

import { chromium } from 'playwright';

const URL = process.env.BASE_URL || 'http://127.0.0.1:5180/';

const probes = {
  /** High-frequency pixel variance: the only metric that sees surface micro-detail. */
  async detail(page) {
    return page.evaluate(() => {
      const f = window.planetForge;
      const s = f.planet;
      s.params.autoRotate = false;
      s.params.starsEnabled = false;
      s.params.ringsEnabled = false;
      f.controls().target.set(0, 0, 0);
      s.camera.position.set(0, 0, 1.9);
      f.controls().update();

      const gl = f.renderer.getContext();
      const w = f.renderer.domElement.width;
      const h = f.renderer.domElement.height;
      const px = new Uint8Array(w * h * 4);
      const cx = Math.floor(w / 2);
      const cy = Math.floor(h / 2);

      const hf = () => {
        s.renderInto(f.renderer);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let acc = 0, n = 0;
        for (let y = cy - 120; y <= cy + 120; y += 3) {
          for (let x = cx - 120; x <= cx + 120; x += 3) {
            if (Math.hypot(x - cx, y - cy) > 110) continue;
            const i = ((h - 1 - y) * w + x) * 4;
            const j = ((h - 1 - y) * w + (x + 3)) * 4;
            const a = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
            const b = 0.2126 * px[j] + 0.7152 * px[j + 1] + 0.0722 * px[j + 2];
            acc += Math.abs(a - b);
            n++;
          }
        }
        return Number((acc / n).toFixed(3));
      };

      const out = {};
      f.params.detailStrength = 0;
      f.params.sedimentStrength = 0;
      f.applyLive();
      out.off = hf();
      f.params.detailStrength = 0.42;
      f.applyLive();
      out.on = hf();
      f.params.detailStrength = 0.9;
      f.applyLive();
      out.max = hf();
      f.params.detailStrength = 0.42;
      return out;
    });
  },

  /** Radial profile through the disc centre: shows limb brightening and terminator. */
  async radial(page) {
    return page.evaluate(() => {
      const f = window.planetForge;
      const s = f.planet;
      s.params.autoRotate = false;
      s.params.starsEnabled = false;
      s.params.ringsEnabled = false;
      f.applyLive();
      f.controls().target.set(0, 0, 0);
      s.camera.position.set(0, 0, 2.6);
      f.controls().update();

      const gl = f.renderer.getContext();
      const w = f.renderer.domElement.width;
      const h = f.renderer.domElement.height;
      const px = new Uint8Array(w * h * 4);
      const cx = Math.floor(w / 2);
      const cy = Math.floor(h / 2);

      const sample = () => {
        s.renderInto(f.renderer);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const g = (d) => {
          const i = ((h - 1 - cy) * w + (cx + d)) * 4;
          return [px[i], px[i + 1], px[i + 2]];
        };
        return { centre: g(0), d80: g(80), d110: g(110), d120: g(120), d135: g(135), d155: g(155), sky: g(-cx + 4) };
      };

      const out = {};
      out.day = sample();
      s.atmospherePass.enabled = false;
      out.noAtmo = sample();
      s.atmospherePass.enabled = true;
      f.params.sunAzimuth = 200;
      f.applyLive();
      out.night = sample();
      return out;
    });
  },
};

async function main() {
  const only = process.argv[2];
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`));

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.planetForge && window.planetForge.ready === true, { timeout: 60000 });
  await page.waitForTimeout(900);

  for (const [name, fn] of Object.entries(probes)) {
    if (only && name !== only) continue;
    const result = await fn(page);
    console.log(name, JSON.stringify(result));
  }
  console.log('errors:', errors.length);
  if (errors.length) console.log(errors[0]);
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
