# 架构

## 1. 分层与依赖方向

```
┌─────────────────────────────────────────────────────────┐
│ main.js          渲染循环 / URL 同步 / DOM 事件            │
├─────────────────────────────────────────────────────────┤
│ ui.js / io.js    参数面板、GLB/JSON 导出                   │
├─────────────────────────────────────────────────────────┤
│ planet.js        场景编排：regenerate() / applyLive()      │
├───────────────┬─────────────────┬───────────────────────┤
│ surface       │ ocean/clouds/    │ atmosphere/rings/      │
│ (planet.js    │ (three.js 网格)  │ stars (three.js 网格)   │
│  内联材质)     │                 │                        │
├───────────────┴─────────────────┴───────────────────────┤
│ heightfield.js   plates.js   icosphere.js                │  ← 无 three 依赖
│ noise3d.js       seed.js                                 │
└─────────────────────────────────────────────────────────┘
```

**关键约束：底部四层不 import three.js。** 这不是风格洁癖，而是有实际回报：

- 确定性与拓扑可以在 Node 里零依赖验证（`npm test` 不需要 WebGL 上下文或 DOM）。
- 生成逻辑可以在未来搬到 Worker 或服务端而不改动。
- 测试跑得比浏览器端到端快一个数量级（单元测试 < 1 s，e2e ≈ 2 min）。

上游 `THREE.Terrain` 的 `src/` 17 个模块同样保持无 three 依赖，本项目沿用了这个惯例。

---

## 2. 数据流：从参数到屏幕

```
params (单一真相源)
   │
   ├─ shape 参数 ──► regenerate()
   │                    │
   │                    ├─ createIcosphere(detail)          → 单位球顶点 + 索引 + CSR 邻接
   │                    ├─ buildHeightField(geo, shape)     → elevation[] / oceanMask[]
   │                    ├─ applyRadii + BufferGeometry      → 位移后的 position
   │                    ├─ computeDisplacedNormals          → 解析法线
   │                    └─ 重建 ocean / clouds / atmosphere / rings / stars
   │
   └─ 外观参数 ───► applyLive()   （只写 uniform / scale / visible）
```

### 为什么分两条路径

| 路径 | 触发 | 成本 | 延迟策略 |
|---|---|---|---|
| `regenerate()` | seed、detail、11 个构造参数 | L5 ≈ 71 ms，L6 ≈ 326 ms | 滑块 `input` 防抖 90 ms，`change` 立即提交 |
| `applyLive()` | 颜色、开关、太阳方位、多数外观数值 | < 1 ms | 每个 `input` 立即执行 |

分错的后果很具体：把颜色放进取重建路径 → 拖动色板卡成幻灯片；把板块数放进 live 路径 → 滑块看起来"没反应"。

重建时用两层 `requestAnimationFrame` 包裹，保证加载遮罩先绘制出来，否则 L6 重建会让页面无反馈卡住约 0.3 s。

---

## 3. 高度场合成顺序（顺序本身是设计）

```
1. 板块生长          多源 BFS，保证连通
2. 板块基线          海陆 + 每板块随机抖动 + 域扭曲 fBm 宏形
3. 边界构造          汇聚→脊带，离散→裂谷，转换→微抬升
4. 细节 fBm          高频，独立振幅
5. 首次海平面定位     按分位数求出陆地占比目标
6. 归一化            把构造项压到 amplitude 预算，使参数可比
7. 热力侵蚀          碎石坡、平谷底
8. **二次海平面重锚**  侵蚀改变分布后重新定位，使陆地占比精确
9. 海洋掩码 + 半径缩放
```

第 7 步之后必须再做第 8 步。实测：只做一次定位时，`continentBias = 0.52` 实际得到 0.511，`0.20` 得到 0.166。差异来自侵蚀把质量重新分布。二次重锚后误差降到 < 0.01%（只剩顶点量子化误差，1/10242 ≈ 0.01%）。

---

## 4. 二十面体细分的性能陷阱

原实现（沿用常见写法）在插入每个中点时：

```js
const grown = new Float64Array(positions.length + 3);
grown.set(positions);           // 复制全部已有点
```

每级有 E 个中点，总成本 O(V²)。实测 L5 = 562 ms，L6 = 3 657 ms，占整条管线 80% 以上。

改为预分配 `10·4^L + 2` 个顶点后一次填充，L5 = 31 ms，L6 = 129 ms。拓扑校验（欧拉示性数、邻接表长度 = 2E）在测试中保持通过。

邻接表也重写过一次：最初按"每三角形 2 个槽位"分配再去重，留下大量 `-1` 空洞（残留 = 6V−12），侵蚀循环会读到无效邻居。改成**先去重无向边，再建 CSR**，`adjacency.length` 严格等于 2E。

---

## 5. 种子体系

```
master seed (字符串)
   │ FNV-1a
   ▼
32-bit master ──┬─ ^0x9e3779b1 → mix → tectonics
                ├─ ^0x85ebca6b → mix → detail
                ├─ ^0xc2b2ae35 → mix → erosion
                ├─ ...            ├─ ocean / clouds / atmosphere / rings / stars / scatter
```

9 条独立流。意义：改云层参数不会重排地形，反之亦然。用 XOR + 乘法混合而不是简单加法，避免 `"a"+"b"` 与 `"ab"` 在低位碰撞。

数字 seed 直接用其 32 位值，字符串 seed 先哈希——所以 `"12345"` 与 `12345` 是**两颗不同的星球**（测试中显式断言，避免"以为等价"的误解）。

---

## 6. 着色器注入策略

三处注入点，各有原因：

| 位置 | 注入内容 | 为什么不用原生 ShaderMaterial |
|---|---|---|
| 地表 `MeshStandardMaterial` | 分带着色（`color_fragment`）、坡度（`dFdx/dFdy`） | 保留 three 的 PBR 光照、色调映射，太阳颜色/强度滑块自动生效 |
| 云层 `MeshStandardMaterial` | 3D 噪声覆盖率（`map_fragment`） | 需要受光照影响（云影随太阳方位变化） |
| 大气 / 环带 | 完整 `ShaderMaterial` | 需要自定义散射积分与混合模式，无可复用 PBR 语义 |

地表分带在片元里做而不是烘焙纹理：任意缩放不模糊、参数改动即时、显存与分辨率解耦。

**坡度**用世界位置的屏幕空间导数（`dFdx`/`dFdy`）计算，而不是逐顶点属性——顶点密度变化（L3→L6）不会改变坡度的视觉定义。

---

## 7. 大气的关键实现决策

1. **加法混合 + 关闭深度测试**。散射只增加光，不遮挡后方，这是发射壳层的正确模式。代价是着色器必须把密度折进颜色（没有独立 opacity 阶段）。
2. **射线与球体解析求交**，不用插值片元位置。BackSide 渲染时片元在壳层远壁，掠射时插值位置不可靠，视觉上表现为辉光被切掉。
3. **积分区间是整条壳弦**，行星体内采样用 `step()` 把密度置零，而不是缩短积分区间。缩短会让夜侧边缘完全消失（实测边缘 12,9,7，与背景 5,7,13 无法区分）。
4. **`limb` 归一化用最大弦长**（`2 × 壳厚`），并混入 `impact` 参数几何量。早期归一化到 `0.9 × rAtmo` 时，掠射句柄最多只到 0.3，边缘永远不够亮。
5. **积分步数无关性**：累加器是 `密度 × 步长`，输出再乘 `uSteps`。否则 4/14/28 步会得到 13/109/110 的亮度（实测），滑块会变成亮度调节器。

---

## 8. 可测性设计

`PlanetScene.measure()` 返回的值全部来自真实数据：

| 字段 | 来源 |
|---|---|
| `minRadius` / `maxRadius` / `relief` | 遍历 `surface.geometry.attributes.position` |
| `landFraction` | `heightField.oceanMask` 计数 |
| `cloudCoverage` | `measureCloudCoverage()` 在 Fibonacci 格点上重新采样噪声场 |
| `starBandFraction` | 遍历星点位置，按实际银河面法线统计 |

这是"参数真的改变了结果"能被自动化证明的前提。如果 `measure()` 只是把输入参数回显，所有敏感性测试都会变成同义反复。
