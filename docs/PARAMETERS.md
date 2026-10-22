# 参数手册

共 **92 个参数**，分 7 组。全部由 `src/params.js` 的 `PARAMS` 表驱动 —— UI 面板、URL 编码、JSON 导出、测试默认值都读同一张表，新增一个参数不需要改四处。

**标记说明**：`重建` = 改变该参数会重跑整条生成管线（Worker，防抖 90 ms）；`即时` = 只改 uniform，拖动无延迟。

---

## 1. 地形与板块（shape，17 个）

| 参数 | 范围 | 默认 | 影响 | 类型 |
|---|---|---|---|---|
| `seed` | 任意字符串 | `planet-forge` | 全部随机性的源头。同 seed 逐位复现 | 重建 |
| `autoLod` | 开关 | 开 | 相机距离自动切换细分级别 | 即时 |
| `detail` | 3–6 | 5 | 细分级别。L5=20 480 面，L6=81 920 面 | 重建 |
| `lodNear` | 1.4–4 | 2.3 | 相机距离小于该值（倍半径）升到 L6 | 即时 |
| `lodFar` | 4–20 | 7 | 相机距离大于该值降到 L5 | 即时 |
| `plateCount` | 4–40 | 14 | 板块数。越多山脊带越密、地形越碎 | 重建 |
| `plateHeight` | 0.002–0.06 | 0.022 | 板块间基准高差 | 重建 |
| `continentBias` | 0.1–0.9 | 0.52 | 陆地占比，**精确**控制海平面（误差 < 0.01%） | 重建 |
| `mountainHeight` | 0–0.12 | 0.056 | 汇聚边界山脊振幅 | 重建 |
| `ridgeSharpness` | 0–1 | 0.62 | 山脊锐度，越大越像刀刃 | 重建 |
| `riftDepth` | 0–0.08 | 0.028 | 离散边界裂谷深度 | 重建 |
| `noiseScale` | 0.8–5 | 2.1 | 细节噪声频率。越大细节越密 | 重建 |
| `warpStrength` | 0–1.5 | 0.42 | 域扭曲强度，让海岸线蜿蜒 | 重建 |
| `detailAmplitude` | 0–0.05 | 0.016 | 细节噪声振幅 | 重建 |
| `erosionIterations` | 0–80 | 26 | 热力侵蚀迭代，越大越平缓 | 重建 |
| `hydraulicIterations` | 0–6 | 2 | 水力侵蚀迭代。**0 = 完全无水系** | 重建 |
| `hydraulicStrength` | 0–1.5 | 0.55 | 河道下切深度 | 重建 |

### 水系的三个参数怎么配合

```
hydraulicIterations = 0        → 无河道，地形只有热力侵蚀的碎石坡
hydraulicIterations = 1~2      → 主干河道（推荐）
hydraulicIterations = 3~6      → 支流也显现，但洼地填充会一并抬高，细节变平
hydraulicStrength  = 0         → 有排水网但不下切（河道只在着色里可见）
hydraulicStrength  > 1.0       → 深峡谷，配合 ridgeSharpness 高值效果最好
riverStrength      = 0         → 隐藏河道染色（几何仍在）
```

L5（10 242 顶点）实测：`hydraulicIterations=2` 时 775 个河道顶点、1 023 个洼地被填、总下切量 0.26。

### 典型配置

| 目标 | 关键设置 |
|---|---|
| 类地行星 | `continentBias 0.4`、`plateCount 14`、`hydraulicIterations 2` |
| 群岛世界 | `continentBias 0.18`、`plateCount 26`、`mountainHeight 0.03`、`erosionIterations 60` |
| 干旱世界 | `continentBias 0.85`、`oceanEnabled 关`、`hydraulicIterations 1`、`cloudCoverage 0.05` |
| 年轻星球（锐利） | `erosionIterations 2`、`hydraulicIterations 0`、`ridgeSharpness 0.9` |
| 古老星球（平缓） | `erosionIterations 70`、`hydraulicIterations 4`、`mountainHeight 0.02` |

---

## 2. 地表配色（surface，18 个）

9 个分带色 + 3 个几何阈值 + 6 个纹理参数。所有颜色都是**即时**生效。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `colDeepWater` | 色 | `#0a1f38` | 深海（位于海平面以下最深色带） |
| `colShallow` | 色 | `#2b6f88` | 浅海 |
| `colBeach` | 色 | `#c8b58a` | 滩涂 |
| `colGrass` | 色 | `#4f7a3a` | 草地（低海拔陆地） |
| `colForest` | 色 | `#2c4a26` | 森林（中海拔） |
| `colRock` | 色 | `#7a6f63` | 岩石（陡坡或高海拔） |
| `colSnow` | 色 | `#eef2f5` | 积雪 |
| `colSeaBed` | 色 | `#16303d` | 海床（隔着水看到的地面） |
| `colIce` | 色 | `#dfe9ef` | 极冠 |
| `snowLine` | 0.01–0.09 | 0.038 | 雪线高度（相对星球半径） |
| `beachWidth` | 0.0005–0.012 | 0.003 | 滩涂宽度（高程带宽） |
| `iceCapLatitude` | 0.5–0.98 | 0.86 | 极冠起始纬度（\|y\| 阈值） |
| `biomeSharpen` | 0–1 | 0.22 | 色带对比。0=柔和过渡，1=硬边分带 |
| `detailStrength` | 0–1 | 0.42 | 微纹理强度。**0 = 纯色块** |
| `detailScale` | 20–400 | 110 | 微纹理频率。越大颗粒越细 |
| `sedimentStrength` | 0–1 | 0.45 | 沉积物：缓坡堆积、陡坡剥离 |
| `riverStrength` | 0–1 | 0.6 | 水系可见度。0 = 隐藏河道 |
| `riverColor` | 色 | `#1d3b46` | 河道色 |

**细节三件套的实测区别**（L4，高频邻域差异）：

```
detailStrength 0    → 2.504
detailStrength 0.42 → 2.610
detailStrength 0.9  → 2.764
```

单调递增。注意这个指标只能靠**局部高频差异**测量 —— 全局亮度 σ 对它是盲的，因为纹理是高频低振幅的。

---

## 3. 海洋（8 个）

| 参数 | 范围 | 默认 | 说明 |
|---|---|---|---|
| `oceanEnabled` | 开关 | 开 | 关掉后能看到海床 |
| `oceanColor` | 色 | `#08243d` | 深海色 |
| `oceanShallow` | 色 | `#2f7fa8` | 浅海色（浅水处更亮） |
| `oceanOpacity` | 0.35–1 | 0.88 | 不透明度。降低能看到水下地形 |
| `waveHeight` | 0–0.008 | 0.0022 | 波浪振幅（星球半径单位） |
| `waveSpeed` | 0–3 | 0.55 | 波浪速度 |
| `oceanRoughness` | 0–1 | 0.08 | 粗糙度。低值=镜面海 |
| `oceanSpecular` | 0–3 | 0.9 | 高光强度 |

海洋是独立球壳但**与地形同拓扑**，所以海岸线是两者的真实交线，不是贴图画出来的。

---

## 4. 云层（12 个）

v2 起是**体积云**：云带占据内、外两个球壳之间的有限厚度，逐像素光线步进。

| 参数 | 范围 | 默认 | 说明 |
|---|---|---|---|
| `cloudsEnabled` | 开关 | 开 | |
| `cloudCoverage` | 0–1 | 0.52 | 云量 = **实际天空覆盖比例**（分位数反演，实测线性误差 0） |
| `cloudDensity` | 0–1 | 0.72 | 云体光学厚度 |
| `cloudSharpness` | 0–1 | 0.35 | 边缘锐度 |
| `cloudAltitude` | 1.005–1.09 | 1.028 | 云底高度（倍半径） |
| `cloudSpeed` | 0–0.04 | 0.006 | 云层漂移速度 |
| `cloudBanding` | 0–1 | 0.35 | 纬度带状（极区云少） |
| `cloudThickness` | 0.004–0.06 | 0.022 | **云层厚度**。0.004≈平面云，0.06≈厚积云 |
| `cloudSteps` | 4–24 | 8 | 光线步进采样数。影响性能与层内细节 |
| `cloudSelfShadow` | 0–1 | 0.65 | 云内自阴影（沿太阳方向步进） |
| `cloudColor` | 色 | `#f4f6f8` | 受光面颜色 |
| `cloudShadow` | 色 | `#7d8a99` | 背光面颜色 |

**`cloudThickness` 与 `cloudSteps` 的关系**：厚度决定视觉层次，步数决定能否分辨出层次。厚度 0.05 配 8 步时，每步跨越 0.006 半径，足以看出顶部受光/底部阴暗；配 4 步就会糊成均匀块。实测盘面亮度：厚度 0.006 → 61.7，厚度 0.05 → 65.4（自阴影与遮蔽在起作用）。

---

## 5. 大气（9 个）

v2 起是**物理散射合成**，不是渐变贴图。

| 参数 | 范围 | 默认 | 说明 |
|---|---|---|---|
| `atmoEnabled` | 开关 | 开 | |
| `atmoRadius` | 1.04–1.35 | 1.16 | 大气层顶半径（倍行星半径） |
| `atmoIntensity` | 0–2.5 | 1 | 总强度 |
| `atmoRayleigh` | 色 | `#4a90ff` | 瑞利色（按 `1/λ⁴` 加权到 RGB） |
| `atmoMie` | 色 | `#ffd9b0` | 米氏色（暖色雾霭、晨昏带） |
| `atmoDensity` | 0.5–8 | 3.2 | 密度衰减系数，决定标高 |
| `atmoMieStrength` | 0–1 | 0.18 | 米氏权重，控制暖色占比 |
| `atmoMieG` | 0–0.95 | 0.76 | 前向散射集中度，越大迎光侧越亮越窄 |
| `atmoMultipleScattering` | 0–1 | 0.35 | 多次散射，决定**夜侧辉光强度** |

### 三个只在大气里才有的参数

- **`atmoMieG`**：米氏相函数的不对称因子。0.76 意味着前向散射为主 —— 所以迎光侧边缘很亮，背光侧几乎不散射。这是真实大气的行为（太阳附近天空最亮）。
- **`atmoMultipleScattering`**：用各向同性的衰减回波代替多次散射积分，且**故意不乘太阳可见性**。设 0 时夜侧边缘会黑到与深空无法区分；设 0.35 时采样得到 `[11,41,65]` 对背景 `[5,7,13]`。
- **`atmoDensity`**：不是"强度"，是标高倒数。调高会让大气变薄变锐利（更像火星），调低会让辉光扩散到大半个盘面。

---

## 6. 行星环（11 个）

| 参数 | 范围 | 默认 | 说明 |
|---|---|---|---|
| `ringsEnabled` | 开关 | 开 | |
| `ringInner` / `ringOuter` | 1.2–2 / 1.6–3.2 | 1.42 / 2.34 | 内外半径（倍行星半径） |
| `ringTilt` | −80–80 | 16 | 倾角 |
| `ringOpacity` | 0–1 | 0.86 | 不透明度 |
| `ringColorA` / `ringColorB` | 色 | `#d9cbb2` / `#9a8f7d` | 高光色 / 暗部色 |
| `ringBands` | 6–48 | 22 | 环带数量 |
| `ringGap` | 0–1 | 0.55 | 环缝深度 |
| `ringShadow` | 0–1 | 0.65 | 行星在环上的投影强度 |
| `ringDensityWave` | 0–1 | 0.35 | 密度波振幅 |

`ringInner` 必须小于 `ringOuter`，面板不做约束（改错了会看不到环，改回来即可）。

---

## 7. 星空（8 个）

| 参数 | 范围 | 默认 | 说明 |
|---|---|---|---|
| `starsEnabled` | 开关 | 开 | |
| `starCount` | 500–30 000 | 9 000 | 恒星数量 |
| `starSize` | 0.15–2 | 0.55 | 恒星尺寸倍率 |
| `starBrightness` | 0–2.5 | 1 | 亮度 |
| `starBand` | 0–1 | 0.55 | 银河带聚簇强度。0=均匀分布 |
| `starColorVariance` | 0–1 | 0.75 | 色温差异（蓝白到橙红） |
| `starTwinkle` | 0–1 | 0 | 闪烁。默认关闭（静止画面更干净） |
| `background` | 色 | `#05070d` | 深空底色 |

`starBand` 的实测效果（40% 星点预留给银河带，测 20° 带内比例）：

```
0     → 0.38（均匀基线 0.35）
0.25  → 0.55
0.55  → 0.78
0.9   → 0.96
1.0   → 1.00
```

场星始终保持在 0.35，说明只有带内参数生效，没有污染整个星场。

---

## 8. 光照与相机（light，9 个）

| 参数 | 范围 | 默认 | 说明 |
|---|---|---|---|
| `sunAzimuth` | 0–360 | 38 | 太阳方位角。**驱动地表、大气散射、云自阴影、环投影四处** |
| `sunElevation` | −80–80 | 14 | 太阳高度角 |
| `sunIntensity` | 0–6 | 2.6 | 太阳强度 |
| `sunColor` | 色 | `#fff5e6` | 太阳色 |
| `ambientIntensity` | 0–1.5 | 0.14 | 环境光强度（夜侧亮度） |
| `ambientColor` | 色 | `#2a3a52` | 环境光色（也影响大气夜侧辉光） |
| `autoRotate` | 开关 | 开 | 行星自转 |
| `rotateSpeed` | 0–1 | 0.12 | 自转速度 |
| `showRingsHint` | 开关 | 开 | HUD 环带提示 |

太阳方位是**唯一一处**同时影响四个子系统的参数：地表漫反射、大气散射相位、体积云自阴影方向、行星环投影。调它可以看到完整的昼夜过渡，而不只是地面变暗。

---

## 9. URL 编码

所有参数都可以编码进 URL：

```
?seed=my-planet&detail=6&continentBias=0.3&sunAzimuth=120
```

- 只编码与默认值**不同**的参数（短链接）。
- 数字保留 4 位有效小数，颜色用十六进制。
- 越界值会被钳制到合法范围，非法类型回落默认值。
- 解码在 `decodeParams()`，往返测试在 `test/params-export.test.js`。

链接即场景 —— 分享 URL 就能让对方看到完全一样的星球，因为种子与所有参数都在里面。
