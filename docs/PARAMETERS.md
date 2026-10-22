# 参数手册

参数表在 `src/params.js` 中定义，是 UI、URL、导出与测试的**单一真相源**。新增一个参数只需在该文件中加一行，面板、分享链接、场景 JSON 自动包含它。

标记为 **重建** 的参数会重新生成几何（L5 约 71 ms，L6 约 326 ms，滑块带 90 ms 防抖）；其余参数即时生效（< 1 ms）。

---

## 1. 地形与板块（重建）

| 参数 | 范围 / 默认 | 实际作用 |
|---|---|---|
| `seed` | 字符串 / `planet-forge` | 全部随机性的根。同种子逐位复现；数字与同形字符串 seed 视为不同星球 |
| `detail` | 3–6 / 5 | 细分级别。L5 = 10 242 顶点、20 480 面；L6 = 40 962 / 81 920 |
| `plateCount` | 4–40 / 14 | 板块数。越多 → 山脊带越密、地块越碎。6→40 时边界顶点占比 8.7% → 23.1% |
| `plateHeight` | 0.002–0.06 / 0.022 | 板块基线起伏（海陆高差）。越大，大陆更"厚"、边缘更陡 |
| `continentBias` | 0.1–0.9 / 0.52 | 陆地占比。**精确**控制：0.2 → 20.01%，0.85 → 85.00% |
| `mountainHeight` | 0–0.12 / 0.056 | 汇聚边界山脊带振幅 |
| `ridgeSharpness` | 0–1 / 0.62 | 山脊锐度。0 = 圆缓丘陵，1 = 刀刃状脊线 |
| `riftDepth` | 0–0.08 / 0.028 | 离散边界裂谷深度。与 `mountainHeight` 独立，可造"海沟型"地貌 |
| `noiseScale` | 0.8–5 / 2.1 | 主噪声频率。小 = 大陆块状，大 = 碎片群岛 |
| `warpStrength` | 0–1.5 / 0.42 | 域扭曲。0 = 海岸线贴合板块边界，1.5 = 高度蜿蜒 |
| `detailAmplitude` | 0–0.05 / 0.016 | 高频细节振幅。作用于最后，不影响海平面定位 |
| `erosionIterations` | 0–80 / 26 | 热力侵蚀迭代。0 = 原始尖锐地形，60+ = 圆润、谷底开阔 |

### 典型配置

| 想得到 | 做法 |
|---|---|
| 地球样（大陆 + 岛弧） | 默认即可；`plateCount` 12–16，`continentBias` 0.5 |
| 海洋世界 | `continentBias` 0.15–0.25，`plateCount` 8，`mountainHeight` 0.03 |
| 干旱行星 | `continentBias` 0.8，`mountainHeight` 0.1，`cloudCoverage` 0.1，草地/森林色改黄 |
| 冰封行星 | `iceCapLatitude` 0.4，`colSnow` 与 `colIce` 拉近，`colGrass` 改灰 |
| 破碎群岛 | `plateCount` 36，`noiseScale` 4.2，`erosionIterations` 60 |
| 火星样（峡谷 + 高地） | `riftDepth` 0.07，`mountainHeight` 0.04，`warpStrength` 0.8 |

---

## 2. 地表配色（即时）

分带在片元着色器中按**海拔 + 坡度**计算，与顶点密度无关。

| 参数 | 默认 | 说明 |
|---|---|---|
| `colDeepWater` | `#0a1f38` | 海床深处（透过半透明海洋可见） |
| `colShallow` | `#2b6f88` | 海床浅处 |
| `colBeach` | `#c8b58a` | 滩涂 |
| `colGrass` | `#4f7a3a` | 低地植被 |
| `colForest` | `#2c4a26` | 高地植被 |
| `colRock` | `#7a6f63` | 裸岩（高海拔与陡坡共用） |
| `colSnow` | `#eef2f5` | 积雪 |
| `colSeaBed` | `#16303d` | 深海海床 |
| `colIce` | `#dfe9ef` | 极冠 |
| `snowLine` | 0.038 | 雪线高度（相对起伏预算） |
| `beachWidth` | 0.003 | 滩涂宽度。过大会让每条海岸都像沙滩带 |
| `iceCapLatitude` | 0.86 | 极冠起始纬度（`|sin(lat)|`）。越大极冠越小 |
| `biomeSharpen` | 0.22 | 色带对比增强 |

---

## 3. 海洋（即时）

独立球壳，与地形**同拓扑**，所以海岸线是真实交线。

| 参数 | 默认 | 说明 |
|---|---|---|
| `oceanEnabled` | true | 关闭后可见裸露海床，用于检查地形 |
| `oceanColor` | `#08243d` | 深海色 |
| `oceanShallow` | `#2f7fa8` | 浅海色（深度由地形高程驱动） |
| `oceanOpacity` | 0.5–1 / 0.88 | 低于 1 时可见海床细节 |
| `waveHeight` | 0.0022 | 三层非公度重力波叠加的位移振幅 |
| `waveSpeed` | 0.55 | 波速（时间驱动，与帧率无关） |
| `oceanRoughness` | 0.08 | 越低越像镜面 |
| `oceanSpecular` | 0.9 | 高光强度 |

---

## 4. 云层（即时）

| 参数 | 默认 | 说明 |
|---|---|---|
| `cloudsEnabled` | true | |
| `cloudCoverage` | 0.52 | **等于实际天空覆盖比例**（阈值取自噪声场分位数，实测线性误差 0） |
| `cloudDensity` | 0.72 | 不透明度乘数 |
| `cloudSharpness` | 0.35 | 边缘软硬 |
| `cloudAltitude` | 1.028 | 云壳高度（相对于星球半径） |
| `cloudSpeed` | 0.006 | 绕自转轴漂移速度 |
| `cloudBanding` | 0.35 | 纬度带状聚簇（类似哈德莱环流） |
| `cloudColor` / `cloudShadow` | — | 云体亮部 / 云底暗部 |

**为什么用分位数而不是固定阈值**：fBm 输出集中在均值附近，固定阈值会让"云量"滑块变成开关（实测 0.52 → 37% 天空，0.70 → 88%）。

---

## 5. 大气（即时）

| 参数 | 默认 | 说明 |
|---|---|---|
| `atmoEnabled` | true | |
| `atmoRadius` | 1.16 | 大气层外缘半径 |
| `atmoIntensity` | 1.0 | 总强度 |
| `atmoRayleigh` | `#4a90ff` | 瑞利散射色（短波，薄路径主导） |
| `atmoMie` | `#ffd9b0` | 米氏散射色（长路径与背离太阳侧） |
| `atmoDensity` | 3.2 | 高度衰减系数。越大，大气越"薄"越贴地 |
| `atmoSteps` | 4–28 / 14 | 积分步数。**只影响噪点/带宽，不影响亮度**（亮度已与步数解耦） |

实现：沿视线在壳层内积分光学深度，太阳可见度按采样点自身法线判定；输出为加法混合，因此夜侧保留由环境光驱动的微弱蓝环（否则夜侧边缘与深空无法区分）。

---

## 6. 行星环（即时）

| 参数 | 默认 | 说明 |
|---|---|---|
| `ringsEnabled` | true | |
| `ringInner` / `ringOuter` | 1.42 / 2.34 | 内外半径（相对星球半径） |
| `ringTilt` | −80–80 / 16 | 环面倾角（度） |
| `ringOpacity` | 0.86 | |
| `ringColorA` / `ringColorB` | — | 环高光 / 环暗部 |
| `ringBands` | 6–48 / 22 | 环带密度 |
| `ringGap` | 0–1 / 0.55 | 环缝深度（5 条种子化深缝） |
| `ringShadow` | 0–1 / 0.65 | 行星投影到环上的强度 |
| `ringDensityWave` | 0–1 / 0.35 | 密度波（环带边缘的螺旋扰动） |

---

## 7. 星空（即时）

| 参数 | 默认 | 说明 |
|---|---|---|
| `starsEnabled` | true | |
| `starCount` | 500–30 000 / 9 000 | 恒星数。含 40% 银河带星 |
| `starSize` | 0.15–2 / 0.55 | 点精灵尺寸 |
| `starBrightness` | 0–2.5 / 1.0 | 亮度 |
| `starBand` | 0–1 / 0.55 | 银河带聚簇强度。带内占比 0.38 → 1.00（20° 带） |
| `starColorVariance` | 0–1 / 0.75 | 色温离散度（红矮星 ↔ 蓝巨星） |
| `starTwinkle` | 0–1 / 0 | 闪烁强度 |
| `background` | `#05070d` | 深空底色 |

**调试提示**：星空数量高时深空底色会被平均抬高，影响"盘面与背景可区分"这类测量。截图脚本把 starCount 压在 1 500–4 000。

---

## 8. 光照与相机

| 参数 | 默认 | 说明 |
|---|---|---|
| `sunAzimuth` | 0–360 / 38 | 太阳方位角（度）。驱动地表光照、大气散射、环带阴影 |
| `sunElevation` | −80–80 / 14 | 太阳高度角 |
| `sunIntensity` | 0–6 / 2.6 | |
| `sunColor` | `#fff5e6` | |
| `ambientIntensity` | 0–1.5 / 0.14 | 环境光强度，同时决定夜侧大气下限 |
| `ambientColor` | `#2a3a52` | |
| `autoRotate` | true | 行星自转 |
| `rotateSpeed` | 0–1 / 0.12 | 自转速度 |

相机由 OrbitControls 控制（不在参数表内）：拖拽旋转、滚轮缩放（1.22–22 倍半径）、右键平移；切换种子时保留当前视角。

---

## 9. URL 编码

- 只有**偏离默认值**的参数会写进 URL。
- 颜色省略 `#` 前缀：`colSnow=abcdef`。
- 布尔用 `true/false`，也接受 `1/0`。
- 数值越界会被**钳制**到合法范围，非法数值回退默认值。

示例：

```
?seed=amber-4821&detail=6&continentBias=0.24&cloudCoverage=0.7&sunAzimuth=115
```

这条链接打开即完全复现该星球与该视角光照。
