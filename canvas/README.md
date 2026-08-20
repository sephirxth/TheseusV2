# 画布（canvas）v0.1

第二入口。直接迭代，不走用例流水线（2026-08-20 游渊定）——但罗盘仍是
[`docs/requirements/canvas.md`](../docs/requirements/canvas.md) 的 U30–U34。

## 架构（选型标准：经得起持续改）

- **前端**：React + [`@xyflow/react`](https://reactflow.dev)（MIT）+ Vite。
  节点即组件：`nodes.tsx` 里的组件表就是类型注册表——每加一类对象
  （agent 卡、审阅项、Operator Brief）只是加一行，不动骨架。
  拖拽、框选、缩放、小地图开箱即有；构建产物全本地，零 CDN。
- **服务端**：`server.ts`，Node 内建 http，零框架，直接复用 `src/trace.ts` /
  `src/intent.ts` / `src/doors.ts`。**树永远现场折叠，不另存**。
- **两种本体，两条存放路**：
  - 镜像（意图树、状态）：真相在痕迹库里，画布只读；
  - 原生（位置、便签、视口）：存 `canvas-layout.json`。
    **布局这道门递归核对字段，运行真相一个都进不来**（维度透镜的教训）。
- **面板是人的门**（design/intent.md 2.3）：点按钮=开口，落一条
  `canvas.said`（`user:human:canvas`），意图痕迹由 `tool:canvas` 走 agent 的门挂上去。
  判据原样生效，画布上不再造一道。

## 跑

```bash
pnpm install               # 仓库根目录（pnpm workspace）
pnpm -C canvas build       # 前端 → canvas/dist
node canvas/server.ts      # 127.0.0.1:8811，服务 API + dist
pnpm -C canvas dev         # 开发：vite 热更，/api 代理到 8811
```

环境变量：`THESEUS_TRACE_DB`（默认 `~/.local/state/theseus/trace.db`）、
`THESEUS_CANVAS_LAYOUT`（默认同目录 `canvas-layout.json`）、`THESEUS_CANVAS_PORT`（默认 8811）。

## v0.1 已有的

认领（挂在当前之下）、回到这儿、做完了、不做了（要理由）；出生边实线、融合边虚线；
"当前"高亮；位置拖动即归档；双击空白贴便签；右侧详情露出"出生的那句话"；
SSE：账一变，所有打开的画布跟着变。

## 迭代挂点（往哪儿改）

- 新对象类型 → `nodes.tsx` 加组件 + `App.tsx` 的 `nodeTypes` 注册。
- 新动作 → `server.ts` 的 `act()` 加一个分支（人的门 + 意图痕迹的组合不变）。
- 悬着的名单 / 谁在等我（桥 U27/U29 的桌面形态）→ 服务端已有 `intent.dangling()` 可用。
- 构面 / 聚焦（U33）→ 前端过滤 + 淡出，布局里可存构面定义（新增字段同样要过布局那道门的核对）。
