import { chromium } from 'playwright';

const URL = 'https://llinok111.github.io/planet-forge/';
const b = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const p = await (await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })).newPage();

const errs = [];
const failed = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 220)); });
p.on('pageerror', (e) => errs.push('PE ' + e.message.slice(0, 220)));
p.on('requestfailed', (r) => failed.push(r.url() + ' :: ' + (r.failure()?.errorText ?? '')));
p.on('response', (r) => { if (r.status() >= 400) failed.push(r.status() + ' ' + r.url()); });

await p.goto(URL, { waitUntil: 'load', timeout: 90000 });
try {
  await p.waitForFunction(() => window.planetForge && window.planetForge.ready === true, { timeout: 120000 });
} catch {
  console.log('NOT READY');
  console.log('errors:', errs.slice(0, 3));
  console.log('failed:', failed.slice(0, 5));
  await b.close();
  process.exit(1);
}
await p.waitForTimeout(2500);

const r = await p.evaluate(() => {
  const f = window.planetForge;
  const s = f.planet;
  const m = s.measure();
  const st = s.heightField?.stats ?? {};

  // Layered measurement: the atmosphere pass must actually change the frame.
  const gl = f.renderer.getContext();
  const w = f.renderer.domElement.width;
  const h = f.renderer.domElement.height;
  const px = new Uint8Array(w * h * 4);
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  s.params.autoRotate = false;
  s.params.starsEnabled = false;
  s.params.ringsEnabled = false;
  f.applyLive();
  const snap = () => {
    s.renderInto(f.renderer);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const at = (d) => {
      const i = ((h - 1 - cy) * w + (cx + d)) * 4;
      return [px[i], px[i + 1], px[i + 2]];
    };
    return { centre: at(0), edge: at(140), corner: at(-cx + 6) };
  };
  const withPass = snap();
  s.atmospherePass.enabled = false;
  const noPass = snap();
  s.atmospherePass.enabled = true;

  return {
    vertices: m.vertices,
    triangles: m.triangles,
    relief: +m.relief.toFixed(4),
    landFraction: +m.landFraction.toFixed(3),
    level: m.detailLevel,
    rivers: st.riverVertices ?? 0,
    depressionsFilled: st.depressionsFilled ?? 0,
    worker: s.workerClient?.usingWorker ?? null,
    children: s.planetGroup.children.map((c) => c.name),
    hasAtmospherePass: !!s.atmospherePass,
    passTarget: s.atmospherePass ? [s.atmospherePass.target.width, s.atmospherePass.target.height] : null,
    withPass,
    noPass,
  };
});

console.log('LIVE v2 OK');
console.log('V=' + r.vertices, 'F=' + r.triangles, 'L' + r.level, 'relief=' + r.relief, 'land=' + r.landFraction);
console.log('rivers=' + r.rivers, 'depressionsFilled=' + r.depressionsFilled, 'worker=' + r.worker);
console.log('children:', r.children.join(','));
console.log('atmospherePass=' + r.hasAtmospherePass, 'target=' + JSON.stringify(r.passTarget));
console.log('withPass:', JSON.stringify(r.withPass));
console.log('noPass  :', JSON.stringify(r.noPass));
console.log('console errors:', errs.length, '| failed requests:', failed.length);
if (failed.length) console.log(failed.slice(0, 4));
if (errs.length) console.log(errs.slice(0, 2));

await p.screenshot({ path: 'docs/images/live-v2.png' });
await b.close();
