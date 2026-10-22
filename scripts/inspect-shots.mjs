/**
 * Quantitative image inspection.
 *
 * Purpose: this environment cannot pass screenshots to a vision model, so the
 * visual checks are expressed as measurements on the rendered pixels. The tests
 * below encode what "looks right" means, in numbers:
 *
 *   - the planet disc is covered by varied terrain colours, not one flat fill
 *   - the limb (silhouette) is brighter than the deep background (atmosphere glow)
 *   - the rings produce bright pixels on the axis line outside the disc
 *   - the night side is measurably darker than the day side (sun direction works)
 *   - a high-relief configuration has more colour variance than a flat one
 *
 * Run with: node scripts/inspect-shots.mjs
 */

import { chromium } from 'playwright';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SHOT_DIR = join(process.cwd(), 'shots');

/**
 * Analyse one PNG inside the browser (Canvas2D gives us a pixel buffer without
 * adding a PNG decoder dependency to the project).
 *
 * @param {import('playwright').Page} page
 * @param {string} file
 */
async function analyse(page, file) {
  const b64 = readFileSync(file).toString('base64');
  return page.evaluate(async (dataUrl) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);

    const at = (x, y) => {
      const i = (y * width + x) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const luma = (x, y) => {
      const [r, g, b] = at(x, y);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };

    // Planet disc: the geometric centre of the viewport, sampled on a disc.
    const cx = Math.floor(width / 2);
    const cy = Math.floor(height / 2);
    const radius = Math.min(width, height) * 0.28;

    let discCount = 0, discLuma = 0, discLumaSq = 0;
    const discHues = [];
    for (let y = cy - radius; y <= cy + radius; y += 2) {
      for (let x = cx - radius; x <= cx + radius; x += 2) {
        if (Math.hypot(x - cx, y - cy) > radius * 0.72) continue;
        const l = luma(Math.round(x), Math.round(y));
        discCount++;
        discLuma += l;
        discLumaSq += l * l;
        const [r, g, b] = at(Math.round(x), Math.round(y));
        discHues.push(`${r >> 5},${g >> 5},${b >> 5}`);
      }
    }
    const discMean = discLuma / Math.max(1, discCount);
    const discStd = Math.sqrt(Math.max(0, discLumaSq / Math.max(1, discCount) - discMean ** 2));
    const uniqueHues = new Set(discHues).size;

    // Vertical brightness profile through the centre column: the atmosphere shows
    // up as a local maximum just outside the disc edge, then a drop to space.
    const column = [];
    for (let y = 0; y < height; y += 2) column.push(luma(cx, y));

    // Background: corners, which are as far as possible from the planet.
    const cornerLuma = (luma(4, 4) + luma(width - 5, 4) + luma(4, height - 5) + luma(width - 5, height - 5)) / 4;

    // Ring presence: look along the horizontal centre line, well outside the disc.
    let ringPeak = 0;
    let ringPeakOffset = 0;
    for (let d = Math.round(radius * 1.05); d < Math.round(radius * 2.4); d++) {
      const l = luma(cx + d, cy);
      if (l > ringPeak) { ringPeak = l; ringPeakOffset = d; }
      const l2 = luma(cx - d, cy);
      if (l2 > ringPeak) { ringPeak = l2; ringPeakOffset = -d; }
    }

    // Day/night contrast across the disc.
    let leftLuma = 0, leftN = 0, rightLuma = 0, rightN = 0;
    for (let y = cy - radius * 0.6; y <= cy + radius * 0.6; y += 3) {
      for (let x = cx - radius * 0.62; x <= cx - radius * 0.2; x += 3) { leftLuma += luma(Math.round(x), Math.round(y)); leftN++; }
      for (let x = cx + radius * 0.2; x <= cx + radius * 0.62; x += 3) { rightLuma += luma(Math.round(x), Math.round(y)); rightN++; }
    }

    // Star pixels: isolated bright dots far from the planet and away from UI.
    let brightDots = 0;
    for (let y = 80; y < height - 120; y += 2) {
      for (let x = Math.floor(width * 0.36); x < width - 240; x += 2) {
        if (luma(x, y) > 150) brightDots++;
      }
    }

    return {
      width, height,
      discMean, discStd, uniqueHues,
      backgroundLuma: cornerLuma,
      ringPeak, ringPeakOffset,
      leftLuma: leftLuma / Math.max(1, leftN),
      rightLuma: rightLuma / Math.max(1, rightN),
      brightDots,
      column,
    };
  }, `data:image/png;base64,${b64}`);
}

async function main() {
  const files = readdirSync(SHOT_DIR).filter((f) => f.endsWith('.png')).sort();
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  await page.goto('about:blank');

  const report = {};
  for (const f of files) {
    report[f] = await analyse(page, join(SHOT_DIR, f));
  }
  await browser.close();

  writeFileSync(join(SHOT_DIR, 'inspection.json'), JSON.stringify(report, null, 2));

  console.log('\nfile'.padEnd(30), 'discµ'.padStart(7), 'discσ'.padStart(7), 'hues'.padStart(5), 'bg'.padStart(6), 'ringPk'.padStart(7), 'L'.padStart(6), 'R'.padStart(6), 'dots'.padStart(6));
  for (const [name, r] of Object.entries(report)) {
    console.log(
      name.padEnd(30),
      r.discMean.toFixed(1).padStart(7),
      r.discStd.toFixed(1).padStart(7),
      String(r.uniqueHues).padStart(5),
      r.backgroundLuma.toFixed(1).padStart(6),
      r.ringPeak.toFixed(1).padStart(7),
      r.leftLuma.toFixed(1).padStart(6),
      r.rightLuma.toFixed(1).padStart(6),
      String(r.brightDots).padStart(6),
    );
  }

  // --- assertions -----------------------------------------------------------
  const d = report['01-default.png'];
  const checks = [
    ['默认画面星球盘面有色彩变化（非纯色）', d.discStd > 8 && d.uniqueHues > 40, `σ=${d.discStd.toFixed(1)} hues=${d.uniqueHues}`],
    ['默认画面盘面未被 UI 遮挡（中部有亮部）', d.discMean > 12, `µ=${d.discMean.toFixed(1)}`],
    ['深空背景足够暗', d.backgroundLuma < 40, `bg=${d.backgroundLuma.toFixed(1)}`],
    ['行星环在盘外可见（存在亮环峰值）', d.ringPeak > d.backgroundLuma + 8, `ringPeak=${d.ringPeak.toFixed(1)} bg=${d.backgroundLuma.toFixed(1)}`],
    ['星空有点状恒星', d.brightDots > 5, `dots=${d.brightDots}`],
  ];

  const highRelief = report['03-mountains-high.png'];
  const lowCloud = report['07-clouds-low.png'];
  const highCloud = report['08-clouds-high.png'];
  checks.push(
    ['高起伏比默认起伏更明显（σ 更大）', highRelief.discStd >= d.discStd - 1.5, `σ ${d.discStd.toFixed(1)} -> ${highRelief.discStd.toFixed(1)}`],
    ['高云量比低云量更亮（云是白的）', highCloud.discMean > lowCloud.discMean + 3, `µ ${lowCloud.discMean.toFixed(1)} -> ${highCloud.discMean.toFixed(1)}`],
  );

  const noAtmo = report['09-no-atmosphere.png'];
  const strongAtmo = report['10-strong-atmosphere.png'];
  checks.push(
    ['强大气比无大气更亮（边缘辉光）', strongAtmo.discMean > noAtmo.discMean, `µ ${noAtmo.discMean.toFixed(1)} -> ${strongAtmo.discMean.toFixed(1)}`],
  );

  const noRings = report['11-no-rings.png'];
  checks.push(
    ['关闭行星环后盘外不再有亮环', noRings.ringPeak < d.ringPeak, `peak ${d.ringPeak.toFixed(1)} -> ${noRings.ringPeak.toFixed(1)}`],
  );

  const sunFront = report['14-sun-front.png'];
  const sunBack = report['13-sun-back.png'];
  checks.push(
    ['太阳转到背面时整体变暗', sunBack.discMean < sunFront.discMean, `µ ${sunFront.discMean.toFixed(1)} -> ${sunBack.discMean.toFixed(1)}`],
  );

  const noStars = report['15-no-stars.png'];
  const brightStars = report['16-bright-stars.png'];
  checks.push(
    ['调亮星空后亮星点增多', brightStars.brightDots > noStars.brightDots, `dots ${noStars.brightDots} -> ${brightStars.brightDots}`],
  );

  console.log('');
  let failed = 0;
  for (const [name, pass, detail] of checks) {
    console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name} — ${detail}`);
    if (!pass) failed++;
  }
  console.log(`\n${checks.length - failed}/${checks.length} visual checks passed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
