# 上游对比与许可证核实

## 1. 候选调研过程

需求是"程序化 3D 星球生成器"。核实候选时用的命令都是实查（`gh api repos/<owner>/<repo>`），没有凭印象填 star 数或许可证。

| 候选 | ★ | 许可证 | 最后推送 | 结论 |
|---|---|---|---|---|
| **IceCreamYou/THREE.Terrain** | 914 | MIT | 2026-10-15 | **选中**。地形生成引擎，有明确的"行星生成" TODO 未实现；2D-only 噪声是硬缺口 |
| ZyFou/ProceduralTerrains | 641 | MIT | 2026-10-22 | 未选。已自带 planet mode + 体积云 + 水面 + GLB 导出，与需求重叠过多，无缺口可补 |
| SebLague/Procedural-Planets | 653 | MIT | — | 未选。Unity/C#，无法在浏览器交付 |
| simeonradivoev/GPU-Planetary-Rendering | 200 | Apache-2.0 | — | 未选。Unity，且 GPU 端 LOD 与本项目的 CPU 生成路线不同 |
| cuberact/godot-cuberact-planet-chunked-lod | 149 | MIT | — | 未选。Godot |
| Allakazan/threejs-planet-terrain | 4 | 无 | — | 未选。无许可证 = 不可复用 |

排除 `ZyFou/ProceduralTerrains` 是关键判断：它不是"不好"，而是**太完整**。二次开发的前提是上游存在可验证的缺口，否则只是换皮。

---

## 2. 缺口证据（不是主观判断）

### 证据 A：上游 roadmap 明确列出但未实现

`roadmap.md` 的 `## 3.1` 节原文：

```
- Try simulating techtonic plates as a procedural generation method as described at
  https://webcache.googleusercontent.com/search?q=cache:http://experilous.com/1/blog/post/procedural-planet-generation
```

（`techtonic` 是上游原文拼写。）该项目条目指向 procedural planet generation，且到 v3.1.1 仍未实现——`src/` 中没有板块、没有球面采样、没有行星相关代码。

### 证据 B：噪声只有 2D

```bash
grep -n "noise\.simplex\|noise\.perlin" src/noise.js
#  88:noise.simplex = function(xin, yin) {
# 160:noise.perlin = function(x, y) {
```

只有 `simplex(x, y)` 与 `perlin(x, y)`。球面高度场必须在**三维**采样，否则用经纬度做 (u,v) 会在两极挤压、在经线处出现接缝。这是本项目 `src/noise3d.js` 存在的直接原因（3D Simplex + fBm + ridged multifractal + 域扭曲）。

---

## 3. 差异清单

| 能力 | 上游 v3.1.1 | Planet Forge |
|---|---|---|
| 几何 | 平面网格（xSize × ySize） | 二十面体细分球，`V = 10·4^L + 2` |
| 高度生成 | 2D 噪声 / 菱形方块 / 高斯 | 3D 噪声 + 板块构造（Voronoi 生长 + 边界三分） |
| 噪声维度 | 2D | **3D**（新增 `noise3d.js`） |
| 侵蚀 | 无 | **热力侵蚀**（质量守恒，坡度阈值随网格推导） |
| 法线 | `computeVertexNormals()` | **解析法线**（由高程梯度推导，跨细分一致） |
| 海平面 | 无概念 | **二次重锚**，陆地占比精确等于参数 |
| 渲染 | 地形 + 草 + 散布网格 | 地表分带 / 海洋 / 云 / 大气散射 / 环带 / 星空 |
| 确定性 | `createSeededRandom`（xorshift32） | 同名机制的 `mulberry32` + **9 条命名子流**的分层派生 |
| 导出 | 无 | GLB（烘焙顶点色）/ 场景 JSON / PNG |
| 参数系统 | 构造时传 options | **schema 驱动**：UI / URL / 导出 / 测试同源 |
| 测试 | `test/` 浏览器 + 库测试 | 79 项单元（Node）+ 26 项 e2e（浏览器）+ 34 项像素断言 |

### 保留了什么

- `src/` 的 **17 个模块原样保留**（`core.js`、`generators.js`、`filters.js`、`influences.js`、`scatter.js`、`grass.js`、`materials.js`、`worley.js`、`gaussian.js`、`brownian.js`、`analysis.js`、`tint.js`、`images.js` 等）。它们是平面地形工具链，与本项目的球面管线并列存在，没有被删改。
- `LICENSE.txt` **原文未改动**（GitHub 才能正确识别为 MIT）。
- **全部 180 个上游提交历史**（`git rev-list --count HEAD` 从 180 起算），本项目提交叠在其上，`git log` 可追溯。

### 替换了什么

- 入口（`index.html`、`main.js`、`vite.config.js`）与演示层（`demo/`、`dist/`、上游截图脚本）。上游演示是平面地形编辑，与本项目演示不共存。
- `package.json`：从 `three.terrain.js` 改为 `planet-forge`，依赖收敛到 `three@0.186.1` + `vite` + `playwright`。

---

## 4. 许可证核实

| 组件 | 许可证 | 核实方式 |
|---|---|---|
| IceCreamYou/THREE.Terrain v3.1.1 | MIT | `gh api repos/IceCreamYou/THREE.Terrain --jq .license.spdx_id` → `MIT`；仓库内 `LICENSE.txt` 原文保留 |
| 3D Simplex 噪声算法 | Public domain | 上游 `src/noise.js` 文件头注明 "Copied with small edits from github.com/josephg/noisejs which is public domain. Originally by Stefan Gustavson"；本项目 `noise3d.js` 沿同一算法谱系并保留署名 |
| three.js 0.186.1 | MIT | npm 包元数据 |
| Vite 8.3.4 | MIT | npm |
| Playwright 1.62 | Apache-2.0 | npm，仅开发依赖 |

本项目自身：**MIT**。`NOTICE` 文件记录衍生关系与第三方组件，与 `LICENSE.txt` 分开——这是为了让 GitHub 仍能把仓库识别为 MIT（在 `LICENSE` 里追加文字会使其降级为 "Other"）。

---

## 5. 上游可复用的设计

不是所有借鉴都要写成代码。以下三点在实现中被沿用：

1. **生成层不依赖渲染层**。上游 `src/` 全部无 three 依赖，本项目底部四层同样如此，使 Node 端测试成为可能。
2. **确定性随机以"传入的函数"形式存在**（上游 `options.random`），而不是改写全局 `Math.random`。本项目用 `deriveSeed` 派生显式子种子，思想一致、粒度更细。
3. **兼容性由上游测试守护**。上游有回归测试套件；本项目虽然替换了演示层，但保留了"新增能力一律 opt-in、不改默认行为"的纪律——例如地形生成默认参数与上游无冲突（上游代码未被调用链侵入）。
