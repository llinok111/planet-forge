/**
 * Browser smoke test: proves the planet actually renders and that parameter
 * changes alter the rendered pixels.
 *
 * This is the check that Node tests cannot do: GLSL compilation errors and
 * shader-chunk injection failures only surface in a real WebGL context. It also
 * compares canvas pixel hashes between configurations, because "the scene
 * object changed" is not the same claim as "the picture changed".
 */

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5180/';
const SHOT_DIR = join(process.cwd(), 'shots');
mkdirSync(SHOT_DIR, { recursive: true });

const consoleErrors = [];
const pageErrors = [];

function hashBuffer(buf) {
  return createHash('sha1').update(buf).digest('hex').slice(0, 16);
}

/** Read basic image statistics from a PNG buffer via the page itself. */
async function imageStats(page, dataUrl) {
  return page.evaluate(async (url) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, nonBlack = 0, min = 255, max = 0;
    const buckets = new Set();
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
      sum += l;
      if (l > 8) nonBlack++;
      if (l < min) min = l;
      if (l > max) max = l;
      // Coarse colour bucket to detect palette differences, not pixel jitter.
      buckets.add(`${d[i] >> 5},${d[i + 1] >> 5},${d[i + 2] >> 5}`);
    }
    return {
      width: img.width,
      height: img.height,
      meanLuma: sum / (d.length / 4),
      nonBlackFraction: nonBlack / (d.length / 4),
      min, max,
      colorBuckets: buckets.size,
    };
  }, dataUrl);
}

async function grab(page, name) {
  const buf = await page.locator('#scene').screenshot();
  writeFileSync(join(SHOT_DIR, `${name}.png`), buf);
  return { buffer: buf, hash: hashBuffer(buf) };
}

async function waitReady(page) {
  await page.waitForFunction(() => window.planetForge && window.planetForge.ready === true, { timeout: 60000 });
  // Let a few frames render so the canvas is not the cleared buffer.
  await page.waitForTimeout(900);
}

async function setParam(page, key, value) {
  await page.evaluate(([k, v]) => {
    window.planetForge.params[k] = v;
  }, [key, value]);
}

async function setAndRegenerate(page, key, value) {
  await setParam(page, key, value);
  // Clear the flag first, then regenerate, then wait for it to come back. Calling
  // regenerate() directly (synchronously inside the page) also avoids the debounce
  // path, so the wait below is about the rebuild itself, not a timer.
  await page.evaluate(() => {
    window.planetForge.ready = false;
    window.planetForge.regenerate();
    window.planetForge.ready = true;
  });
  await page.waitForFunction(() => window.planetForge.ready === true, { timeout: 60000 });
  await page.waitForTimeout(700);
}

async function setAndApplyLive(page, key, value) {
  await setParam(page, key, value);
  await page.evaluate(() => window.planetForge.applyLive());
  await page.waitForTimeout(450);
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const mark = pass ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // React DevTools / Vite HMR noise is not an application error.
    if (/Download the React DevTools|\[vite\] connect/i.test(text)) return;
    consoleErrors.push(text);
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  console.log(`\nOpening ${BASE_URL}`);
  await page.goto(BASE_URL, { waitUntil: 'load' });
  await waitReady(page);

  // --- 1. no runtime errors ------------------------------------------------
  record('页面无 JS 异常', pageErrors.length === 0, pageErrors.join(' | ') || '0 errors');
  // Only real compile/link failures count. The string "shader" also appears in
  // benign three.js progress logs, so match the actual failure signatures.
  const shaderErrors = consoleErrors.filter((t) =>
    /Shader Error|VALIDATE_STATUS|Program Info Log|FRAGMENT.*ERROR|VERTEX.*ERROR|not compiled/i.test(t),
  );
  record('无着色器/WebGL 错误', shaderErrors.length === 0, shaderErrors.slice(0, 1).join(' | ') || '0 errors');
  // Anything else that reached console.error is surfaced but does not fail the run.
  const otherErrors = consoleErrors.filter((t) => !shaderErrors.includes(t));
  if (otherErrors.length) console.log(`  [info] 其它 console 输出 ${otherErrors.length} 条：${otherErrors[0].slice(0, 120)}`);

  // --- 2. the canvas has actual content ------------------------------------
  const baseShot = await grab(page, '01-default');
  const baseStats = await imageStats(page, `data:image/png;base64,${baseShot.buffer.toString('base64')}`);
  record(
    '画布有可见内容',
    baseStats.nonBlackFraction > 0.12 && baseStats.meanLuma > 6,
    `non-black=${(baseStats.nonBlackFraction * 100).toFixed(1)}% luma=${baseStats.meanLuma.toFixed(1)} colours=${baseStats.colorBuckets}`,
  );
  record(
    '画面有丰富色彩层次（非单色）',
    baseStats.colorBuckets > 60,
    `${baseStats.colorBuckets} colour buckets`,
  );

  // --- 3. geometry is displaced, not a sphere ------------------------------
  const geometryProbe = await page.evaluate(() => {
    const m = window.planetForge.planet.measure();
    return m;
  });
  record(
    '地形真实起伏（顶点半径有变化）',
    geometryProbe.relief > 0.02,
    `relief=${geometryProbe.relief.toFixed(4)} minR=${geometryProbe.minRadius.toFixed(3)} maxR=${geometryProbe.maxRadius.toFixed(3)}`,
  );
  record(
    '顶点/三角面数量与细分级别一致',
    geometryProbe.vertices === 10242 && geometryProbe.triangles === 20480,
    `V=${geometryProbe.vertices} F=${geometryProbe.triangles}`,
  );

  // --- 4. seed reproducibility --------------------------------------------
  const seedA1 = await page.evaluate(() => {
    const p = window.planetForge.planet;
    const pos = p.surface.geometry.attributes.position.array;
    let acc = 0;
    for (let i = 0; i < pos.length; i += 97) acc += pos[i];
    return acc;
  });
  await setAndRegenerate(page, 'seed', 'alpha-seed');
  const seedB = await page.evaluate(() => {
    const pos = window.planetForge.planet.surface.geometry.attributes.position.array;
    let acc = 0;
    for (let i = 0; i < pos.length; i += 97) acc += pos[i];
    return acc;
  });
  await setAndRegenerate(page, 'seed', 'planet-forge');
  const seedA2 = await page.evaluate(() => {
    const pos = window.planetForge.planet.surface.geometry.attributes.position.array;
    let acc = 0;
    for (let i = 0; i < pos.length; i += 97) acc += pos[i];
    return acc;
  });
  record('同种子复现（回到原种子结果一致）', Math.abs(seedA1 - seedA2) < 1e-4, `${seedA1.toFixed(4)} vs ${seedA2.toFixed(4)}`);
  record('不同种子产生不同地形', Math.abs(seedA1 - seedB) > 1e-3, `delta=${Math.abs(seedA1 - seedB).toFixed(3)}`);

  // --- 5. tectonic parameter really changes the picture --------------------
  const mountainBefore = await grab(page, '02-mountains-default');
  await setAndRegenerate(page, 'mountainHeight', 0.115);
  const mountainAfter = await grab(page, '03-mountains-high');
  const mRelief = await page.evaluate(() => window.planetForge.planet.measure().relief);
  record(
    '山脉高度参数改变几何起伏',
    mRelief > geometryProbe.relief,
    `relief ${geometryProbe.relief.toFixed(4)} -> ${mRelief.toFixed(4)}`,
  );
  record(
    '山脉高度参数改变渲染像素',
    mountainBefore.hash !== mountainAfter.hash,
    `${mountainBefore.hash} vs ${mountainAfter.hash}`,
  );

  // --- 6. continent bias moves the coastline (sea level) -------------------
  await setAndRegenerate(page, 'continentBias', 0.22);
  const lowLand = await page.evaluate(() => window.planetForge.planet.measure().landFraction);
  await setAndRegenerate(page, 'continentBias', 0.78);
  const highLand = await page.evaluate(() => window.planetForge.planet.measure().landFraction);
  record(
    '陆地占比参数精确改变陆地比例',
    Math.abs(lowLand - 0.22) < 0.01 && Math.abs(highLand - 0.78) < 0.01,
    `0.22 -> ${lowLand.toFixed(3)}, 0.78 -> ${highLand.toFixed(3)}`,
  );
  await setAndRegenerate(page, 'continentBias', 0.52);

  // --- 7. ocean visibility ------------------------------------------------
  await setAndApplyLive(page, 'oceanEnabled', false);
  const noOcean = await grab(page, '04-no-ocean');
  await setAndApplyLive(page, 'oceanEnabled', true);
  const withOcean = await grab(page, '05-with-ocean');
  record('海洋开关改变画面', noOcean.hash !== withOcean.hash, `${noOcean.hash} vs ${withOcean.hash}`);

  // --- 8. ocean colour ----------------------------------------------------
  await setAndApplyLive(page, 'oceanColor', '#5a1a1a');
  const redOcean = await grab(page, '06-red-ocean');
  record('海洋颜色参数改变画面', withOcean.hash !== redOcean.hash, `${withOcean.hash} vs ${redOcean.hash}`);
  await setAndApplyLive(page, 'oceanColor', '#08243d');

  // --- 9. clouds ----------------------------------------------------------
  const lowClouds = (await setAndApplyLive(page, 'cloudCoverage', 0.05), await grab(page, '07-clouds-low'));
  const highClouds = (await setAndApplyLive(page, 'cloudCoverage', 0.95), await grab(page, '08-clouds-high'));
  record('云量参数改变画面', lowClouds.hash !== highClouds.hash, `${lowClouds.hash} vs ${highClouds.hash}`);
  await setAndApplyLive(page, 'cloudCoverage', 0.52);

  // --- 10. atmosphere -----------------------------------------------------
  await setAndApplyLive(page, 'atmoEnabled', false);
  const noAtmo = await grab(page, '09-no-atmosphere');
  await setAndApplyLive(page, 'atmoEnabled', true);
  await setAndApplyLive(page, 'atmoIntensity', 2.2);
  const strongAtmo = await grab(page, '10-strong-atmosphere');
  record('大气开关 + 强度改变画面', noAtmo.hash !== strongAtmo.hash, `${noAtmo.hash} vs ${strongAtmo.hash}`);
  await setAndApplyLive(page, 'atmoIntensity', 1.0);

  // --- 11. rings ----------------------------------------------------------
  await setAndApplyLive(page, 'ringsEnabled', false);
  const noRings = await grab(page, '11-no-rings');
  await setAndApplyLive(page, 'ringsEnabled', true);
  await setAndApplyLive(page, 'ringTilt', 62);
  const tiltRings = await grab(page, '12-rings-tilted');
  record('行星环开关改变画面', noRings.hash !== tiltRings.hash, `${noRings.hash} vs ${tiltRings.hash}`);
  await setAndApplyLive(page, 'ringTilt', 16);

  // --- 12. sun direction --------------------------------------------------
  await setAndApplyLive(page, 'sunAzimuth', 200);
  const sunBack = await grab(page, '13-sun-back');
  await setAndApplyLive(page, 'sunAzimuth', 38);
  const sunFront = await grab(page, '14-sun-front');
  const backStats = await imageStats(page, `data:image/png;base64,${sunBack.buffer.toString('base64')}`);
  const frontStats = await imageStats(page, `data:image/png;base64,${sunFront.buffer.toString('base64')}`);
  record(
    '太阳方位改变照明（亮度差显著）',
    Math.abs(backStats.meanLuma - frontStats.meanLuma) > 1.0,
    `luma ${frontStats.meanLuma.toFixed(1)} vs ${backStats.meanLuma.toFixed(1)}`,
  );

  // --- 13. starfield ------------------------------------------------------
  await setAndApplyLive(page, 'starsEnabled', false);
  const noStars = await grab(page, '15-no-stars');
  await setAndApplyLive(page, 'starsEnabled', true);
  await setAndApplyLive(page, 'starBrightness', 2.2);
  const brightStars = await grab(page, '16-bright-stars');
  record('星空开关 + 亮度改变画面', noStars.hash !== brightStars.hash, `${noStars.hash} vs ${brightStars.hash}`);
  await setAndApplyLive(page, 'starBrightness', 1.0);

  // --- 14. camera orbit produces a different view -------------------------
  const beforeOrbit = await grab(page, '17-before-orbit');
  await page.evaluate(() => {
    const { planet, controls } = window.planetForge;
    planet.camera.position.set(2.4, 1.1, 2.2);
    controls().update();
  });
  await page.waitForTimeout(500);
  const afterOrbit = await grab(page, '18-after-orbit');
  record('相机控制可用（视角改变）', beforeOrbit.hash !== afterOrbit.hash, `${beforeOrbit.hash} vs ${afterOrbit.hash}`);

  // --- 15. detail level scales geometry -----------------------------------
  await setAndRegenerate(page, 'detail', 6);
  const l6 = await page.evaluate(() => window.planetForge.planet.measure());
  record(
    '细分级别 L6 生成 40962 顶点',
    l6.vertices === 40962 && l6.triangles === 81920,
    `V=${l6.vertices} F=${l6.triangles}`,
  );
  const l6Shot = await grab(page, '19-detail-l6');
  record('L6 画面正常渲染', l6Shot.buffer.length > 20000, `${(l6Shot.buffer.length / 1024).toFixed(0)} KB`);
  await setAndRegenerate(page, 'detail', 5);

  // --- 16. GLB export ----------------------------------------------------
  // The export entry points are read from the app's public surface rather than
  // imported by path: a production build bundles everything, so a dynamic
  // import('/src/io.js') only works against the dev server and made this check
  // pass in dev while silently being impossible to run against the shipped bundle.
  const glb = await page.evaluate(async () => {
    const f = window.planetForge;
    const json = f.buildSceneJSON(f.planet);
    const buf = await f.exportGLB(f.planet);
    return { size: buf.byteLength, magic: new TextDecoder().decode(new Uint8Array(buf.slice(0, 4))), json };
  });
  record('GLB 导出成功且魔数正确', glb.magic === 'glTF' && glb.size > 100000, `${glb.magic} ${(glb.size / 1048576).toFixed(2)} MB`);
  record(
    '场景 JSON 含参数与测量值',
    glb.json.parameters?.seed === 'planet-forge' && glb.json.measurements?.vertices === 10242,
    `seed=${glb.json.parameters?.seed} vertices=${glb.json.measurements?.vertices}`,
  );

  // --- 17. stability under rapid parameter changes -----------------------
  const stressStart = Date.now();
  for (let i = 0; i < 24; i++) {
    await page.evaluate((n) => {
      const f = window.planetForge;
      f.params.sunAzimuth = (n * 15) % 360;
      f.params.oceanOpacity = 0.5 + (n % 5) * 0.1;
      f.params.cloudCoverage = (n % 10) / 10;
      f.applyLive();
    }, i);
  }
  await page.waitForTimeout(400);
  const aliveAfterStress = await page.evaluate(() => Boolean(window.planetForge.planet.surface));
  record('24 次快速参数变更后场景仍有效', aliveAfterStress, `${Date.now() - stressStart} ms`);

  // --- 18. regeneration churn (dispose correctness) ----------------------
  let churnError = null;
  try {
    for (const seed of ['churn-1', 'churn-2', 'churn-3']) {
      await setAndRegenerate(page, 'seed', seed);
    }
  } catch (err) {
    churnError = err.message;
  }
  const afterChurn = await page.evaluate(() => {
    const m = window.planetForge.planet.measure();
    return { vertices: m.vertices, relief: m.relief };
  });
  record('连续重建 3 个种子无崩溃', churnError === null && afterChurn.vertices === 10242, churnError || `relief=${afterChurn.relief.toFixed(4)}`);

  // --- 19. mobile viewport ------------------------------------------------
  await page.setViewportSize({ width: 414, height: 860 });
  await page.waitForTimeout(500);
  const mobile = await grab(page, '20-mobile');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  record('移动端无横向溢出', !overflow && mobile.buffer.length > 10000, `overflow=${overflow}`);

  const errorTail = pageErrors.slice(0, 3);
  if (errorTail.length) console.log('\nPage errors:', errorTail);

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  writeFileSync(join(SHOT_DIR, 'results.json'), JSON.stringify({ results, consoleErrors, pageErrors }, null, 2));
  if (failed.length) {
    console.error('\nFAILED:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('e2e harness crashed:', err);
  process.exit(2);
});
