# 架构

## 1. 分层与依赖方向

```
┌──────────────────────────────────────────────────────────────┐
│ main.js          渲染循环 / URL 同步 / DOM 事件 / 自动 LOD 检查  │
├──────────────────────────────────────────────────────────────┤
│ ui.js / io.js    参数面板、GLB/JSON 导出                        │
├──────────────────────────────────────────────────────────────┤
│ planet.js        场景编排：generateAsync / buildMeshes / LOD    │
├──────────────────┬───────────────────┬───────────────────────┤
│ surface          │ ocean / clouds /  │ atmosphere-pass        │
│ (内联材质)        │ rings / stars     │ (屏幕空间合成 pass)      │
├──────────────────┴───────────────────┴───────────────────────┤
│ heightfield.js   plates.js   icosphere.js   hydrology.js       │  ← 无 three 依赖
│ noise3d.js       seed.js    terrain-worker.js                 │
└──────────────────────────────────────────────────────────────┘
```

**关键约束：底部两层不 import three.js。** 这不是风格洁癖，而是有实际回报：

- 确定性与拓扑可以在 Node 里零依赖验证（`npm test` 不需要 WebGL 上下文或 DOM）。
- 整条生成管线可以原样搬进 Web Worker —— v2 的异步生成正是直接复用了这些模块（`terrain-worker.js` 同时被 worker 和主线程 import）。
- 测试跑得比浏览器端到端快一个数量级（单元测试 < 2 s，e2e ≈ 2 min）。

上游 `THREE.Terrain` 的 `src/` 17 个模块同样保持无 three 依赖，本项目沿用了这个惯例。

---

## 2. 数据流：从参数到屏幕

```
params (单一真相源)
   │
   ├─ shape 参数 ──► regenerateAsync()
   │                    │
   │                    ├─ [Worker] generateTerrain(shape)
   │                    │     ├─ createIcosphere(detail)      → 单位球顶点 + 索引 + CSR 邻接
   │                    │     ├─ buildHeightField(geo, shape) → elevation[] / riverFlow[]
   │                    │     ├─ applyRadii                   → 位移后的 position
   │                    │     └─ computeDisplacedNormals      → 解析法线
   │                    │     （8 个 ArrayBuffer 以 transferable 回传）
   │                    │
   │                    ├─ [主线程] buildMeshes(terrain)      → BufferGeometry + 属性
   │                    └─ 重建 ocean / clouds / rings / stars
   │
   ├─ 外观参数 ───► applyLive()      （只写 uniform / 半径 / visible）
   │
   └─ 相机距离 ───► updateLod()      （距离跨过阈值才触发一次重建，10% 迟滞）
```

### 为什么分三条路径

| 路径 | 触发 | 成本 | 延迟策略 |
|---|---|---|---|
| `regenerateAsync()` | seed、detail、14 个构造参数 | L5 ≈ 60 ms，L6 ≈ 282 ms（在 Worker 里） | 滑块 `input` 防抖 90 ms，`change` 立即提交 |
| `applyLive()` | 颜色、开关、太阳方位、云厚、大气参数 | < 1 ms | 每个 `input` 立即执行 |
| `updateLod()` | 相机距离跨阈值 | 同一次重建 | 每 0.6 s 最多检查一次，迟滞带防抖 |

分错的后果很具体：把颜色放进取重建路径 → 拖动色板卡成幻灯片；把板块数放进 live 路径 → 滑块看起来"没反应"。

**异步重建的过期结果必须丢弃。** 拖动滑块会排队多次请求，只有最后一个描述了用户此刻看到的东西。实现用单调递增的 token：

```js
async regenerateAsync() {
  const token = ++this.regenToken;
  const terrain = await this.generateAsync();
  if (token !== this.regenToken) return false;   // 被更新的一次取代了
  this.buildMeshes(terrain);
  return true;
}
```

同时 `planetForge.ready` 必须在重建**开始前**置 `false`（不是结束后才置 `true`），否则外部观察者会在旧场景上读数据 —— 这个坑在 v1 的 e2e 里造成过一次稳定复现的假失败，详见 `docs/TESTING.md`。

---

## 3. 高度场合成顺序（顺序本身是设计）

```
1. 板块生长            plateOf[] + plateSizes[]
2. 板块高度            plateHeight * 相对质心方向
3. 边界构造            汇聚→山脊、离散→裂谷、转换→轻微抬升
4. 域扭曲 fBm 细节     低频先偏移坐标，避免海岸线贴板块边界
5. 首次海平面重锚      按 continentBias 分位数定 0 点
6. 归一化             把最大起伏缩放到 (plateHeight+mountainHeight+detail) 预算
7. 热力侵蚀           削平陡坡（碎石坡、平谷底）
8. 洼地填充            priority-flood，让每个陆地点都能流向海
9. 水力侵蚀            流量×坡度下切河道
10. 二次海平面重锚      侵蚀改变了分布，重新按分位数定 0 点
```

三个顺序决策值得单独说明：

**7 在 9 之前**：热力侵蚀先产生缓坡，水系才有地方安定下来。反过来会让河道横穿新鲜噪声，形成不自然的直角渠。

**8 是 9 的前提，不是可选项**：没有洼地填充时，排水网是碎的。实测 L4 网格：239 个汇点、146 个已在海平面、最大集水区仅 42/2562 顶点。填充后陆地汇点 = 0，最大集水区 = 110，主河道才出现。

**10 必须在最后**：细节噪声与两级侵蚀都在移动高度分布。把重锚放在第 5 步时，`continentBias=0.52` 实测得到 0.511、`0.20` 得到 0.166 —— 偏差来自后续步骤。放到第 10 步后误差 < 0.01%（等于顶点量化精度）。

---

## 4. 二十面体细分的性能陷阱

原实现每插入一个中点就 `new Float64Array(len+3)` 并整体复制 —— O(n²)。

```js
// 错：每次插入中点都复制整个数组
const grown = new Float64Array(positions.length + 3);
grown.set(positions);

// 对：预分配 10·4^L + 2 个顶点，一次填充
const totalVerts = 10 * (4 ** lvl) + 2;
```

实测 L5 562 ms → 21 ms，L6 3 657 ms → 112 ms（15–32×）。

### 邻接表的空洞

按"每个三角形给每个顶点 2 个槽位"分配再去重，会留下 `6V−12` 个 `-1` 空洞（L5 = 61 440 个），侵蚀循环会读到无效邻居。正确做法是先去重无向边、再建 CSR：

```
保证：sum(degree) == 2E，无 -1，无重复，平均度 = 6（正二十面体球的标准值）
```

这条断言在 `test/geometry.test.js` 里对 L0–L6 逐级校验。

---

## 5. 种子体系

```
"my planet" ──FNV-1a──► master(uint32)
                          │
        ┌─────────────────┼──────────────────┐
   tectonics        detail      erosion    … (9 条)
```

- 同一 master 派生出的子系统流**互不干扰**：改云层参数不会改变地形，因为地形用的是 `tectonics`/`detail`/`erosion` 三支。
- 数字种子按数值使用，字符串走哈希 —— 因此 `12345` 与 `'12345'` **不相等**。这是刻意的：数字来自程序化循环，字符串来自用户输入，让它们撞在一起只会让复现变得含糊。
- 3D Simplex 在格点处恒为 0（Gustavson 实现的已知性质），球面采样若落在格点上会出现细小"零值斑"。修法是给采样空间加一段随种子变化的无理数偏移。修复前后对比：20 000 个球面样本中精确零值 有 → 0 个。

---

## 6. 着色器注入策略

地表材质是 `MeshStandardMaterial` + `onBeforeCompile` 注入，不是自己写整套 PBR：

```js
material.onBeforeCompile = (shader) => {
  shader.uniforms.uDetailStrength = uniforms.uDetailStrength;
  shader.vertexShader = shader.vertexShader
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${BIOME_VERTEX_BODY}`);
  shader.fragmentShader = shader.fragmentShader
    .replace('void main() {', `${BIOME_FRAGMENT_HEAD}\nvoid main() {`)
    .replace('vec3 outgoingLight =', `vec3 outgoingLight = ${BIOME_FRAGMENT_BODY}`);
};
```

两条硬规则：

1. **注入块用 `in` 而不是 `attribute`。** three.js 只对自己处理的源码做 `attribute → in` 重写；字符串拼接进去的块会原样到达驱动，而 `attribute` 在 GLSL ES 3.00 里是保留字。踩过一次，报错指向的是使用处而不是声明处。
2. **模板字符串内不能出现裸反引号**，注释里引用变量名也不行。这个坑在本项目里踩了 5 次，每次都表现为下游几百行的 `Unexpected identifier`。现在由 `test/template-guard.test.js` 静态拦截。

---

## 7. 大气：为什么必须是两遍渲染

v1 用加性混合的球壳网格，结构上就做不到"透射"和"入射光"分离：加法只加不减，因此面朝视线的分量必须硬压到 0.012 级，否则整片盘面被染成蓝白（实测 arid 预设被染成 RGB [213,216,233]）。

v2 改为：

```
pass 1  renderer.setRenderTarget(target); renderer.render(scene, camera)
pass 2  全屏 quad：解析求解射线与球壳/行星的交点 → τ(λ) → 合成
```

合成公式（对命中行星的射线）：

```
T      = exp(-τ_total)          // 透射率，按波长不同
colour = sceneColor * T + scattered
```

对未命中行星的射线（纯天空）：

```
colour = sceneColor + scattered   // 背景只接收散射光，不乘透射率
```

四个实现要点，每个都对应一次真实故障：

| 要点 | 故障症状 |
|---|---|
| 渲染目标尺寸必须跟随绘制缓冲 | 停在 1×1 时，整个屏幕是同一个 texel 的均色，盘面与天空不可区分 |
| 天空射线不能乘透射率 | 否则整帧被灰雾覆盖，角落从 [5,7,13] 跳到 [49,86,104] |
| 视线方向必须用相机逆投影矩阵重建 | 用硬编码 60° 视锥时，实际 fov 是 38°，晨昏带相对受光地面错位 |
| 散射亮度不能乘积分步数以外的项 | 否则 4/14/28 步得到 13/109/110 的亮度（步长缩放了求和） |

多次散射用各向同性的衰减回波代替，且**故意不乘太阳可见性** —— 这正是夜侧边缘在现实中仍然可见的原因（光从受光侧跨过晨昏线散射过来）。

---

## 8. 可测性设计

1. **测量回环**：`planet.measure()` 的每个数值都取自真实数据 —— 顶点半径算 `relief`、星点坐标算银河带占比、噪声场分位数算云量。回显输入参数会让"参数生效"这件事无法被测试。
2. **参数 schema 单一真相**：UI、URL 编码、JSON 导出、测试的默认值全部读 `params.js`。新增一个参数不需要改四处。
3. **静态守卫**：JS 声明的每个 uniform 必须在 GLSL 里有对应声明（反之亦然）；GLSL 内不得用保留字做变量名；模板字符串内不得有裸反引号。这三条都对应过真实故障，且**都在浏览器里表现为"画面缺一块"而不是报错**。
4. **像素级验收**：见 `docs/TESTING.md`。盘面半径从拍摄元数据（投影公式）读取，不做图像边缘检测。
