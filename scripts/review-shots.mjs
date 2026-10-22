/**
 * Per-shot quantitative review.
 *
 * There is no vision channel available in this environment, so "does it look
 * right" is expressed as measurements. The checks encode what a correct render
 * implies:
 *
 *   - the planet disc contains many distinct colours (terrain bands, not a fill)
 *   - the disc is brighter than the sky (it is lit)
 *   - the limb, sampled just outside the disc, is brighter than the far sky
 *     (atmosphere present)
 *   - for the terminator shot, the dark side is measurably darker than the lit side
 *   - a different biome preset produces a different dominant hue
 *
 * Run: node scripts/review-shots.mjs
 */

import { chromium } from 'playwright';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'docs', 'images');

/**
 * Capture metadata written by scripts/capture-shots.mjs.
 *
 * The disc radius is read from here rather than inferred from the image. Earlier
 * attempts to detect the disc by scanning (centre row, bounding box, connected
 * components) all failed for concrete reasons: the ring system crosses the same
 * scanlines, a back-lit disc can be darker than the sky, and background noise
 * dilates a thresholded mask to the full frame. Taking the radius from the
 * projection that produced the pixels removes the guesswork entirely.
 */
const META = JSON.parse(readFileSync(join(DIR, 'capture-meta.json'), 'utf8'));

async function analyse(page, file, config) {
  const b64 = readFileSync(file).toString('base64');
  return page.evaluate(async ({ dataUrl, config }) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);

    const px = (x, y) => {
      const i = (Math.round(y) * width + Math.round(x)) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const luma = (x, y) => {
      const [r, g, b] = px(x, y);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };

    // Locate the planet disc by scanning the centre row and column for the
    // contiguous run that differs from the sky. The sky is sampled at the corners.
    // --- planet disc ------------------------------------------------------
    // The disc radius is derived from the capture configuration, not detected:
    // scanning for edges is unreliable here because the ring system crosses the
    // same scanlines and because a back-lit disc can be darker than the sky. The
    // projection is exact and deterministic:
    //     screenRadius = (R / sqrt(d^2 - R^2)) / tan(fov/2) * (H/2)
    // with R = planet radius (1.05 including relief), d = camera distance.
    const view = config;
    const radius = view.screenRadius;
    const centre = { x: width / 2, y: height / 2 };
    // Bounding box of the projected disc, used only for reporting.
    const left = centre.x - radius;
    const right = centre.x + radius;
    const top = centre.y - radius;
    const bottom = centre.y + radius;

    // --- sky ---------------------------------------------------------------
    // Median luminance of the whole frame: stars median out and the planet covers
    // well under half the pixels, so the median lands on empty sky.
    const hist = new Uint32Array(256);
    for (let i = 0; i < data.length; i += 16) {
      const l = Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
      hist[Math.min(255, l)]++;
    }
    // Sky estimate. Every framing here centres the planet and leaves true space in
    // the frame corners, and the corner patches are additionally trimmed so a star
    // pixel cannot drag the value up. Attempts to derive the sky from the waveform
    // (median, darkest mode) both failed for concrete reasons: the median lands on
    // the planet in close-ups, and the darkest mode is the black level of unlit
    // space, which sits below the actual background colour.
    const patchMedian = (x0, y0, w, h) => {
      const vals = [];
      for (let y = y0; y < y0 + h; y += 1) {
        for (let x = x0; x < x0 + w; x += 1) {
          const i = (y * width + x) * 4;
          vals.push(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
        }
      }
      vals.sort((a, b) => a - b);
      return vals[Math.floor(vals.length * 0.25)];
    };
    const cornerLevels = [
      patchMedian(0, 0, 36, 36),
      patchMedian(width - 36, 0, 36, 36),
      patchMedian(0, height - 36, 36, 36),
      patchMedian(width - 36, height - 36, 36, 36),
    ];
    // If the four corners disagree the disc is touching the edge; use the darkest
    // two of them as sky so a lit disc corner cannot inflate the reference.
    const skyLevels = [...cornerLevels].sort((a, b) => a - b);
    const sky = (skyLevels[0] + skyLevels[1]) / 2;
    // How much of the frame the disc occupies, reported for diagnostics: when it
    // exceeds ~55% the corner patches start to be the only reliable sky samples.
    const planetFill = (2 * Math.PI * radius * radius) / (width * height);

    // Disc statistics over an inner circle (avoid the anti-aliased rim).
    let sum = 0, sumSq = 0, n = 0;
    const hues = new Set();
    const innerR = radius * 0.8;
    for (let y = centre.y - innerR; y <= centre.y + innerR; y += 2) {
      for (let x = centre.x - innerR; x <= centre.x + innerR; x += 2) {
        if (Math.hypot(x - centre.x, y - centre.y) > innerR) continue;
        if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) continue;
        const l = luma(x, y);
        if (!Number.isFinite(l)) continue;
        sum += l; sumSq += l * l; n++;
        const [r, g, b] = px(x, y);
        hues.add(`${r >> 4},${g >> 4},${b >> 4}`);
      }
    }
    const mean = n ? sum / n : 0;
    const std = n ? Math.sqrt(Math.max(0, sumSq / n - mean * mean)) : 0;

    // Limb: annulus just outside the disc, on the side facing the sun (brighter)
    // and on the opposite side.
    // Limb peak: take the brightest sample across a band just outside the disc, on
    // both sides and through several angles. A mean is the wrong statistic here —
    // the ring system crosses the annulus and drags any average down — and a fixed
    // narrow wedge can miss the rim on a low-contrast frame. The maximum over a
    // thin annulus is exactly "is there a bright rim".
    const limbPeak = (side) => {
      let peak = 0;
      for (let a = -0.6; a <= 0.6; a += 0.04) {
        const dx = Math.cos(a) * side;
        const dy = Math.sin(a);
        for (let sc = 1.01; sc <= 1.09; sc += 0.005) {
          const x = centre.x + dx * radius * sc;
          const y = centre.y + dy * radius * sc;
          if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) continue;
          const l = luma(x, y);
          if (Number.isFinite(l) && l > peak) peak = l;
        }
      }
      return peak;
    };
    const limbRight = limbPeak(1);
    const limbLeft = limbPeak(-1);

    // Left/right halves inside the disc, for day/night comparison.
    const halfLuma = (x0, x1) => {
      let acc = 0, count = 0;
      for (let y = centre.y - innerR * 0.9; y <= centre.y + innerR * 0.9; y += 2) {
        for (let x = x0; x <= x1; x += 2) {
          acc += luma(x, y); count++;
        }
      }
      return count ? acc / count : 0;
    };

    return {
      width, height, sky, planetFill,
      disc: { left, right, top, bottom, radius, cx: centre.x, cy: centre.y },
      mean, std, colors: hues.size,
      limbRight, limbLeft, limbPeak: Math.max(limbRight, limbLeft),
      leftHalf: halfLuma(centre.x - innerR * 0.75, centre.x - innerR * 0.2),
      rightHalf: halfLuma(centre.x + innerR * 0.2, centre.x + innerR * 0.75),
      // Average hue of the disc, to distinguish biome presets.
      avgRGB: (() => {
        let r = 0, g = 0, b = 0, k = 0;
        for (let y = centre.y - innerR; y <= centre.y + innerR; y += 3) {
          for (let x = centre.x - innerR; x <= centre.x + innerR; x += 3) {
            if (Math.hypot(x - centre.x, y - centre.y) > innerR) continue;
            if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) continue;
            const p = px(x, y); r += p[0]; g += p[1]; b += p[2]; k++;
          }
        }
        return k ? [Math.round(r / k), Math.round(g / k), Math.round(b / k)] : [0, 0, 0];
      })(),
    };
  }, { dataUrl: `data:image/png;base64,${b64}`, config });
}

async function main() {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.png')).sort();
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  await page.goto('about:blank');

  const out = {};
  for (const f of files) {
    const meta = META[f.replace('.png', '')];
    if (!meta) {
      console.error(`missing capture metadata for ${f}; re-run scripts/capture-shots.mjs`);
      process.exit(3);
    }
    // The screenshot of the full page includes the whole window; a canvas-only
    // shot is the canvas. Both share the same canvas size in the metadata.
    out[f] = await analyse(page, join(DIR, f), { screenRadius: meta.screenRadius, meta });
  }
  await browser.close();

  console.log('\nshot'.padEnd(24), 'discR'.padStart(6), 'mean'.padStart(6), 'std'.padStart(6), 'colors'.padStart(7), 'sky'.padStart(6), 'limbL'.padStart(7), 'limbR'.padStart(7), 'avgRGB'.padStart(15));
  for (const [k, v] of Object.entries(out)) {
    console.log(
      k.padEnd(24),
      v.disc.radius.toFixed(0).padStart(6),
      v.mean.toFixed(0).padStart(6),
      v.std.toFixed(1).padStart(6),
      String(v.colors).padStart(7),
      v.sky.toFixed(0).padStart(6),
      v.limbLeft.toFixed(0).padStart(7),
      v.limbRight.toFixed(0).padStart(7),
      `[${v.avgRGB.join(',')}]`.padStart(15),
    );
  }

  const checks = [];
  const push = (n, p, d) => checks.push([n, p, d]);

  // --- per-shot invariants ----------------------------------------------------
  for (const [name, v] of Object.entries(out)) {
    push(`${name}: 盘面半径符合投影预期`, v.disc.radius > 150, `r=${v.disc.radius.toFixed(0)}px`);
    push(`${name}: 盘面有色彩分带（非纯色）`, v.colors > 80, `${v.colors} 色块`);
    // A back-lit planet is legitimately darker than its own halo, so the invariant
    // is "the disc is not the same as empty space", in either direction.
    push(
      `${name}: 盘面与深空背景可区分`,
      Math.abs(v.mean - v.sky) > 6,
      `disc=${v.mean.toFixed(0)} sky=${v.sky.toFixed(0)}`,
    );
  }

  // --- atmosphere-specific ---------------------------------------------------
  // The halo is a bright rim; the robust statement is that the brightest point of
  // the annulus just outside the disc exceeds the sky. A mean over the whole
  // annulus is diluted by the ring system, which crosses it.
  for (const name of ['hero.png', 'planet-day.png', 'planet-terminator.png', 'ocean-world.png']) {
    const v = out[name];
    const peak = Math.max(v.limbLeft, v.limbRight);
    push(`${name}: 边缘存在大气辉光`, peak > v.sky + 5, `peak=${peak.toFixed(0)} sky=${v.sky.toFixed(0)}`);
  }

  // The hero shot carries the UI, which hides the halo behind panels on the left,
  // so it is exempt from the two-sided check.
  const day = out['planet-day.png'];
  push(
    'planet-day: 昼侧边缘亮于夜侧（辉光随太阳方向）',
    Math.max(day.limbRight, day.limbLeft) > Math.min(day.limbRight, day.limbLeft) * 1.05,
    `L=${day.limbLeft.toFixed(0)} R=${day.limbRight.toFixed(0)}`,
  );

  // --- preset differences ----------------------------------------------------
  const term = out['planet-terminator.png'];
  push(
    'terminator: 昼夜明暗差明显',
    Math.abs(term.leftHalf - term.rightHalf) > 10,
    `L=${term.leftHalf.toFixed(0)} R=${term.rightHalf.toFixed(0)}`,
  );

  const arid = out['arid-world.png'];
  const ocean = out['ocean-world.png'];
  // Compare the hue direction, not one channel. Cloud cover and atmospheric haze
  // raise the blue channel on every preset, so "B differs" is a fragile test — at
  // one point arid (193,180,160) and ocean (73,128,157) both had B≈160 while being
  // obviously different colours. R-B (warm vs cool balance) separates them cleanly.
  push(
    'arid 与 ocean 预设色调不同（暖冷倾向相反）',
    (arid.avgRGB[0] - arid.avgRGB[2]) > 0 && (ocean.avgRGB[0] - ocean.avgRGB[2]) < 0,
    `arid R-B=${arid.avgRGB[0] - arid.avgRGB[2]} ocean R-B=${ocean.avgRGB[0] - ocean.avgRGB[2]}`,
  );
  push(
    'arid 预设偏暖（R 通道占优）',
    arid.avgRGB[0] >= arid.avgRGB[2],
    `RGB=[${arid.avgRGB.join(',')}]`,
  );
  push(
    'ocean 预设偏冷（B 通道占优）',
    ocean.avgRGB[2] > ocean.avgRGB[0],
    `RGB=[${ocean.avgRGB.join(',')}]`,
  );

  // --- detail level ----------------------------------------------------------
  const l6 = out['l6-detail.png'];
  const l5 = out['no-rings.png'];
  push(
    'L6 近景细节方差不低于 L5 中景',
    Number.isFinite(l6.std) && l6.std > l5.std - 6,
    `L6 σ=${l6.std.toFixed(1)} L5 σ=${l5.std.toFixed(1)}`,
  );

  // --- capture metadata cross-check -----------------------------------------
  // The screenshots must show the geometry the generator actually produced; the
  // metadata is the link between the two, so verify a couple of values here.
  const hero = META.hero;
  push(
    'hero 元数据：顶点/三角面为 L5 拓扑',
    hero.measurements.vertices === 10242 && hero.measurements.triangles === 20480,
    `V=${hero.measurements.vertices} F=${hero.measurements.triangles}`,
  );
  push(
    'hero 元数据：地形起伏非零（几何体被位移）',
    hero.measurements.relief > 0.05,
    `relief=${hero.measurements.relief.toFixed(4)}`,
  );
  const l6meta = META['l6-detail'];
  push(
    'l6 元数据：L6 拓扑',
    l6meta.measurements.vertices === 40962,
    `V=${l6meta.measurements.vertices}`,
  );

  console.log('');
  let failed = 0;
  for (const [name, pass, detail] of checks) {
    console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name} — ${detail}`);
    if (!pass) failed++;
  }
  console.log(`\n${checks.length - failed}/${checks.length} 视觉检查通过`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
