/**
 * Parameter schema.
 *
 * One declarative table drives the entire UI, the URL serialisation, the JSON
 * export and the test suite. Adding a parameter in one place makes it appear in
 * all four, which is the only way to keep "every slider actually changes the
 * planet" honest as the project grows.
 *
 * `rebuild` marks the parameters that require regenerating geometry (they change
 * the height field or vertex count). Cheap visual parameters are applied live
 * without a rebuild, so dragging a colour slider stays at 60fps.
 */

/** @typedef {'surface'|'ocean'|'clouds'|'atmosphere'|'rings'|'stars'|'light'|'camera'|'export'} GroupId */

export const GROUPS = [
  { id: 'shape', label: '地形与板块', hint: '改变这些参数会重建几何体' },
  { id: 'surface', label: '地表配色', hint: '按海拔/坡度分带，实时生效' },
  { id: 'ocean', label: '海洋', hint: '独立球壳，真实海岸线' },
  { id: 'clouds', label: '云层', hint: '3D 噪声，覆盖率线性可控' },
  { id: 'atmosphere', label: '大气', hint: '单次散射近似，随太阳方向变化' },
  { id: 'rings', label: '行星环', hint: '程序化环缝 + 互投影阴影' },
  { id: 'stars', label: '星空', hint: '恒星色温分布 + 银河带' },
  { id: 'light', label: '光照与相机', hint: '太阳方位、环境光、自动旋转' },
];

/**
 * @type {Array<{
 *   key: string, group: GroupId, label: string, type: 'seed'|'range'|'color'|'toggle'|'select',
 *   min?: number, max?: number, step?: number, default: any, rebuild?: boolean,
 *   options?: Array<{value: string|number, label: string}>, hint?: string
 * }>}
 */
export const PARAMS = [
  // --- shape (rebuild) -----------------------------------------------------
  { key: 'seed', group: 'shape', label: '随机种子', type: 'seed', default: 'planet-forge', rebuild: true, hint: '同一种子逐位复现同一星球' },
  { key: 'autoLod', group: 'shape', label: '自动细节', type: 'toggle', default: true, live: false, hint: '按相机距离自动切换细分级别' },
  { key: 'detail', group: 'shape', label: '细分级别', type: 'range', min: 3, max: 6, step: 1, default: 5, rebuild: true, hint: '关闭自动细节后生效；L5=20480 面，L6=81920' },
  { key: 'lodNear', group: 'shape', label: '近景距离', type: 'range', min: 1.4, max: 4, step: 0.05, default: 2.3, rebuild: false, live: true, hint: '相机近于此距离时升到最高细节' },
  { key: 'lodFar', group: 'shape', label: '远景距离', type: 'range', min: 4, max: 20, step: 0.5, default: 7, rebuild: false, live: true, hint: '远于此距离时降到最低细节' },
  { key: 'plateCount', group: 'shape', label: '板块数量', type: 'range', min: 4, max: 40, step: 1, default: 14, rebuild: true },
  { key: 'plateHeight', group: 'shape', label: '板块高差', type: 'range', min: 0.002, max: 0.06, step: 0.001, default: 0.022, rebuild: true },
  { key: 'continentBias', group: 'shape', label: '陆地占比', type: 'range', min: 0.1, max: 0.9, step: 0.01, default: 0.52, rebuild: true, hint: '精确控制海平面位置' },
  { key: 'mountainHeight', group: 'shape', label: '山脉高度', type: 'range', min: 0, max: 0.12, step: 0.002, default: 0.056, rebuild: true },
  { key: 'ridgeSharpness', group: 'shape', label: '山脊锐度', type: 'range', min: 0, max: 1, step: 0.01, default: 0.62, rebuild: true },
  { key: 'riftDepth', group: 'shape', label: '裂谷深度', type: 'range', min: 0, max: 0.08, step: 0.002, default: 0.028, rebuild: true },
  { key: 'noiseScale', group: 'shape', label: '噪声尺度', type: 'range', min: 0.8, max: 5, step: 0.05, default: 2.1, rebuild: true },
  { key: 'warpStrength', group: 'shape', label: '域扭曲', type: 'range', min: 0, max: 1.5, step: 0.01, default: 0.42, rebuild: true },
  { key: 'detailAmplitude', group: 'shape', label: '细节振幅', type: 'range', min: 0, max: 0.05, step: 0.001, default: 0.016, rebuild: true },
  { key: 'erosionIterations', group: 'shape', label: '热力侵蚀', type: 'range', min: 0, max: 80, step: 1, default: 26, rebuild: true, hint: '削平过陡坡面，形成碎石坡' },
  { key: 'hydraulicIterations', group: 'shape', label: '水力侵蚀', type: 'range', min: 0, max: 6, step: 1, default: 2, rebuild: true, hint: '0=无水系；越大河道越深' },
  { key: 'hydraulicStrength', group: 'shape', label: '河道下切', type: 'range', min: 0, max: 1.5, step: 0.05, default: 0.55, rebuild: true },

  // --- surface colours (live) ---------------------------------------------
  { key: 'colDeepWater', group: 'surface', label: '深海', type: 'color', default: '#0a1f38', live: true },
  { key: 'colShallow', group: 'surface', label: '浅海', type: 'color', default: '#2b6f88', live: true },
  { key: 'colBeach', group: 'surface', label: '沙滩', type: 'color', default: '#c8b58a', live: true },
  { key: 'colGrass', group: 'surface', label: '草地', type: 'color', default: '#4f7a3a', live: true },
  { key: 'colForest', group: 'surface', label: '森林', type: 'color', default: '#2c4a26', live: true },
  { key: 'colRock', group: 'surface', label: '岩石', type: 'color', default: '#7a6f63', live: true },
  { key: 'colSnow', group: 'surface', label: '积雪', type: 'color', default: '#eef2f5', live: true },
  { key: 'colSeaBed', group: 'surface', label: '海床', type: 'color', default: '#16303d', live: true },
  { key: 'colIce', group: 'surface', label: '极冠', type: 'color', default: '#dfe9ef', live: true },
  { key: 'snowLine', group: 'surface', label: '雪线高度', type: 'range', min: 0.01, max: 0.09, step: 0.001, default: 0.038, live: true },
  { key: 'beachWidth', group: 'surface', label: '滩涂宽度', type: 'range', min: 0.0005, max: 0.012, step: 0.0005, default: 0.003, live: true },
  { key: 'iceCapLatitude', group: 'surface', label: '极冠纬度', type: 'range', min: 0.5, max: 0.98, step: 0.01, default: 0.86, live: true, hint: '越大极冠越小' },
  { key: 'biomeSharpen', group: 'surface', label: '色带对比', type: 'range', min: 0, max: 1, step: 0.01, default: 0.22, live: true },
  { key: 'detailStrength', group: 'surface', label: '地表细节', type: 'range', min: 0, max: 1, step: 0.01, default: 0.42, live: true, hint: '近景微纹理强度' },
  { key: 'detailScale', group: 'surface', label: '细节尺度', type: 'range', min: 20, max: 400, step: 5, default: 110, live: true },
  { key: 'sedimentStrength', group: 'surface', label: '沉积物', type: 'range', min: 0, max: 1, step: 0.01, default: 0.45, live: true, hint: '缓坡堆积、陡坡剥离' },
  { key: 'riverStrength', group: 'surface', label: '水系可见度', type: 'range', min: 0, max: 1, step: 0.01, default: 0.6, live: true, hint: '0=隐藏河道' },
  { key: 'riverColor', group: 'surface', label: '河道色', type: 'color', default: '#1d3b46', live: true },

  // --- ocean (live) -------------------------------------------------------
  { key: 'oceanEnabled', group: 'ocean', label: '显示海洋', type: 'toggle', default: true, live: true },
  { key: 'oceanColor', group: 'ocean', label: '深海色', type: 'color', default: '#08243d', live: true },
  { key: 'oceanShallow', group: 'ocean', label: '浅海色', type: 'color', default: '#2f7fa8', live: true },
  { key: 'oceanOpacity', group: 'ocean', label: '不透明度', type: 'range', min: 0.35, max: 1, step: 0.01, default: 0.88, live: true },
  { key: 'waveHeight', group: 'ocean', label: '波高', type: 'range', min: 0, max: 0.008, step: 0.0002, default: 0.0022, live: true },
  { key: 'waveSpeed', group: 'ocean', label: '波速', type: 'range', min: 0, max: 3, step: 0.05, default: 0.55, live: true },
  { key: 'oceanRoughness', group: 'ocean', label: '粗糙度', type: 'range', min: 0, max: 1, step: 0.01, default: 0.08, live: true },
  { key: 'oceanSpecular', group: 'ocean', label: '高光强度', type: 'range', min: 0, max: 3, step: 0.05, default: 0.9, live: true },

  // --- clouds (live) ------------------------------------------------------
  { key: 'cloudsEnabled', group: 'clouds', label: '显示云层', type: 'toggle', default: true, live: true },
  { key: 'cloudCoverage', group: 'clouds', label: '云量', type: 'range', min: 0, max: 1, step: 0.01, default: 0.52, live: true, hint: '等于实际天空覆盖比例' },
  { key: 'cloudDensity', group: 'clouds', label: '云厚', type: 'range', min: 0, max: 1, step: 0.01, default: 0.72, live: true },
  { key: 'cloudSharpness', group: 'clouds', label: '边缘锐度', type: 'range', min: 0, max: 1, step: 0.01, default: 0.35, live: true },
  { key: 'cloudAltitude', group: 'clouds', label: '云层高度', type: 'range', min: 1.005, max: 1.09, step: 0.001, default: 1.028, live: true },
  { key: 'cloudSpeed', group: 'clouds', label: '云层漂移', type: 'range', min: 0, max: 0.04, step: 0.001, default: 0.006, live: true },
  { key: 'cloudBanding', group: 'clouds', label: '纬度带状', type: 'range', min: 0, max: 1, step: 0.01, default: 0.35, live: true },
  { key: 'cloudThickness', group: 'clouds', label: '云层厚度', type: 'range', min: 0.004, max: 0.06, step: 0.002, default: 0.022, live: true, hint: '0.004≈平面云，0.06≈厚积云' },
  { key: 'cloudSteps', group: 'clouds', label: '采样步数', type: 'range', min: 4, max: 24, step: 1, default: 8, live: true },
  { key: 'cloudSelfShadow', group: 'clouds', label: '云内自阴影', type: 'range', min: 0, max: 1, step: 0.01, default: 0.65, live: true },
  { key: 'cloudColor', group: 'clouds', label: '云色', type: 'color', default: '#f4f6f8', live: true },
  { key: 'cloudShadow', group: 'clouds', label: '云影色', type: 'color', default: '#7d8a99', live: true },

  // --- atmosphere (live) --------------------------------------------------
  { key: 'atmoEnabled', group: 'atmosphere', label: '显示大气', type: 'toggle', default: true, live: true },
  { key: 'atmoRadius', group: 'atmosphere', label: '大气层高度', type: 'range', min: 1.04, max: 1.35, step: 0.005, default: 1.16, live: true },
  { key: 'atmoIntensity', group: 'atmosphere', label: '强度', type: 'range', min: 0, max: 2.5, step: 0.05, default: 1.0, live: true },
  { key: 'atmoRayleigh', group: 'atmosphere', label: '瑞利色', type: 'color', default: '#4a90ff', live: true },
  { key: 'atmoMie', group: 'atmosphere', label: '米氏色', type: 'color', default: '#ffd9b0', live: true },
  { key: 'atmoDensity', group: 'atmosphere', label: '密度衰减', type: 'range', min: 0.5, max: 8, step: 0.1, default: 3.2, live: true },
  { key: 'atmoMieStrength', group: 'atmosphere', label: '米氏权重', type: 'range', min: 0, max: 1, step: 0.01, default: 0.18, live: true, hint: '控制暖色雾霭占比' },
  { key: 'atmoMieG', group: 'atmosphere', label: '前向散射', type: 'range', min: 0, max: 0.95, step: 0.01, default: 0.76, live: true, hint: '越大，迎光侧越集中' },
  { key: 'atmoMultipleScattering', group: 'atmosphere', label: '多次散射', type: 'range', min: 0, max: 1, step: 0.01, default: 0.35, live: true, hint: '让夜侧辉光非零' },

  // --- rings (live) -------------------------------------------------------
  { key: 'ringsEnabled', group: 'rings', label: '显示行星环', type: 'toggle', default: true, live: true },
  { key: 'ringInner', group: 'rings', label: '内半径', type: 'range', min: 1.2, max: 2, step: 0.01, default: 1.42, live: true },
  { key: 'ringOuter', group: 'rings', label: '外半径', type: 'range', min: 1.6, max: 3.2, step: 0.01, default: 2.34, live: true },
  { key: 'ringTilt', group: 'rings', label: '倾角', type: 'range', min: -80, max: 80, step: 1, default: 16, live: true },
  { key: 'ringOpacity', group: 'rings', label: '不透明度', type: 'range', min: 0, max: 1, step: 0.01, default: 0.86, live: true },
  { key: 'ringColorA', group: 'rings', label: '环高光色', type: 'color', default: '#d9cbb2', live: true },
  { key: 'ringColorB', group: 'rings', label: '环暗部色', type: 'color', default: '#9a8f7d', live: true },
  { key: 'ringBands', group: 'rings', label: '环带密度', type: 'range', min: 6, max: 48, step: 1, default: 22, live: true },
  { key: 'ringGap', group: 'rings', label: '环缝深度', type: 'range', min: 0, max: 1, step: 0.01, default: 0.55, live: true },
  { key: 'ringShadow', group: 'rings', label: '行星投影', type: 'range', min: 0, max: 1, step: 0.01, default: 0.65, live: true },
  { key: 'ringDensityWave', group: 'rings', label: '密度波', type: 'range', min: 0, max: 1, step: 0.01, default: 0.35, live: true },

  // --- stars (live, rebuild on count) ------------------------------------
  { key: 'starsEnabled', group: 'stars', label: '显示星空', type: 'toggle', default: true, live: true },
  { key: 'starCount', group: 'stars', label: '恒星数量', type: 'range', min: 500, max: 30000, step: 500, default: 9000, live: true },
  { key: 'starSize', group: 'stars', label: '恒星尺寸', type: 'range', min: 0.15, max: 2, step: 0.05, default: 0.55, live: true },
  { key: 'starBrightness', group: 'stars', label: '亮度', type: 'range', min: 0, max: 2.5, step: 0.05, default: 1.0, live: true },
  { key: 'starBand', group: 'stars', label: '银河带', type: 'range', min: 0, max: 1, step: 0.01, default: 0.55, live: true },
  { key: 'starColorVariance', group: 'stars', label: '色温差异', type: 'range', min: 0, max: 1, step: 0.01, default: 0.75, live: true },
  { key: 'starTwinkle', group: 'stars', label: '闪烁', type: 'range', min: 0, max: 1, step: 0.01, default: 0.0, live: true },
  { key: 'background', group: 'stars', label: '深空底色', type: 'color', default: '#05070d', live: true },

  // --- light + camera ----------------------------------------------------
  { key: 'sunAzimuth', group: 'light', label: '太阳方位角', type: 'range', min: 0, max: 360, step: 1, default: 38, live: true },
  { key: 'sunElevation', group: 'light', label: '太阳高度角', type: 'range', min: -80, max: 80, step: 1, default: 14, live: true },
  { key: 'sunIntensity', group: 'light', label: '太阳强度', type: 'range', min: 0, max: 6, step: 0.05, default: 2.6, live: true },
  { key: 'sunColor', group: 'light', label: '太阳色', type: 'color', default: '#fff5e6', live: true },
  { key: 'ambientIntensity', group: 'light', label: '环境光', type: 'range', min: 0, max: 1.5, step: 0.01, default: 0.14, live: true },
  { key: 'ambientColor', group: 'light', label: '环境光色', type: 'color', default: '#2a3a52', live: true },
  { key: 'autoRotate', group: 'light', label: '自动旋转', type: 'toggle', default: true, live: true },
  { key: 'rotateSpeed', group: 'light', label: '自转速度', type: 'range', min: 0, max: 1, step: 0.01, default: 0.12, live: true },
  { key: 'showRingsHint', group: 'light', label: '环带提示', type: 'toggle', default: true, live: true },
];

/** Build the default parameter object. */
export function defaultParams() {
  const out = {};
  for (const p of PARAMS) out[p.key] = p.default;
  return out;
}

/** Look up a parameter definition. */
export function paramDef(key) {
  return PARAMS.find((p) => p.key === key);
}

/**
 * Serialise parameters into a compact URL query string.
 * Colours drop the leading '#' to save three characters each.
 *
 * @param {object} params
 * @returns {string}
 */
export function encodeParams(params) {
  const usp = new URLSearchParams();
  for (const def of PARAMS) {
    const value = params[def.key];
    if (value === undefined) continue;
    if (value === def.default) continue;
    if (def.type === 'color') usp.set(def.key, String(value).replace('#', ''));
    else usp.set(def.key, String(value));
  }
  return usp.toString();
}

/**
 * Parse a URL query string back into a full parameter object, falling back to
 * defaults for anything missing or malformed.
 *
 * @param {string} query
 * @returns {object}
 */
export function decodeParams(query) {
  const out = defaultParams();
  const usp = new URLSearchParams(query);
  for (const def of PARAMS) {
    if (!usp.has(def.key)) continue;
    const raw = usp.get(def.key);
    if (def.type === 'color') {
      out[def.key] = raw.startsWith('#') ? raw : `#${raw}`;
    } else if (def.type === 'toggle') {
      out[def.key] = raw === 'true' || raw === '1';
    } else if (def.type === 'range') {
      const num = Number(raw);
      if (Number.isFinite(num)) {
        out[def.key] = Math.min(def.max, Math.max(def.min, num));
      }
    } else {
      out[def.key] = raw;
    }
  }
  return out;
}

/**
 * Collect only the parameters that require a geometry rebuild.
 *
 * @param {object} params
 * @returns {object}
 */
export function shapeParams(params) {
  return {
    seed: params.seed,
    detail: params.detail,
    plateCount: params.plateCount,
    plateHeight: params.plateHeight,
    continentBias: params.continentBias,
    mountainHeight: params.mountainHeight,
    ridgeSharpness: params.ridgeSharpness,
    riftDepth: params.riftDepth,
    noiseScale: params.noiseScale,
    warpStrength: params.warpStrength,
    detailAmplitude: params.detailAmplitude,
    erosionIterations: params.erosionIterations,
    hydraulicIterations: params.hydraulicIterations,
    hydraulicStrength: params.hydraulicStrength,
  };
}
