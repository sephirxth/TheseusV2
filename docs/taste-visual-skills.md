# 个人品味合集 — Visual & Communication Skills

TheseusV2 的表达层不靠单一工具，而是一组按"重量"分档的视觉/沟通 skills——从零成本文本树到完整 HTML 产物，按当前交流场景选最小够用的那档。这套合集本身是所有者的**表达品味**：反对文字墙，反对为轻问题动用重武器，反对一图塞进所有信息。

## 重量分级（从最轻到最重，优先选轻的）

### 第 0 档：文本结构（零生成成本，聊天/终端里三秒扫完）
**show-me**（源自 HumanLayer，MIT 生态）— 用最小说明白一件事：
- 伪代码讲逻辑/算法
- 调用树讲控制流（`submitForm → createSession → …`）
- 组件树讲 UI 结构（只留 state 与模块边界）
- 浅文件树讲职责归属与重构范围（每行一句职责）
- **diff 语法讲变化**（`+`/`-`，不贴整个新文件）
- 状态图/时序图用 Mermaid
- 密集概念才升级为单个 HTML 文件
- 核心纪律：*Pick the smallest view that makes the key point clear.*

### 第 1 档：结构化图（需要真图形但保持轻）
**concept-diagram** — 概念提取与因果张力图（反对容器谬误：基线 S0/势垒墙/SVP）
**excalidraw-diagram** — 手绘风架构/流程/时序 JSON 真图形
决策树统一走 Mermaid。

### 第 2 档：单文件 HTML 产物（重型，概念太密或要留存时才用）
**scientific-html** — 学术排版风（编辑模式+CSS 盒图库），周刊与技术报告主形态
**eli5** — 知识点做成人话 explainer（复杂概念的降维解释，不是简化版报告）
**concept-figure** — 概念图形提取与图示化
**architecture-diagram** — 深色 SVG 架构图（基建/云架构）
**baoyu-infographic** — 信息图（21 布局 × 21 风格，面向传播）
**sketch / claude-design** — 一次性 HTML 草稿/设计稿（2-3 变体对比）
**pretext** — DOM-free 文本排版创作

### 第 3 档：专项媒介
**ascii-art / ascii-video** — 字符艺术/彩色 ASCII 视频
**manim-video** — 3B1B 风数学动画
**p5js** — 生成艺术/着色器/交互

## 元原则

1. **先问档位再动笔**：聊天里能用缩进树说清的，不生成 HTML；
   要留档的（报告/周刊/对外物料）直接上第 2 档。
2. **每张图只回答一个问题**：保留回答当前问题所需的调用、文件、状态与边界，
   其余全删。一图塞所有信息 = 没有信息。
3. **diff 优先于全量**：讲"改了什么"永远用 diff 形状，全量展示只在
   "大部分是新的"或"用户需要可复制目标形状"时用。
4. **品味来自选择而非堆砌**：这套合集的价值在于不滥用——
   对话层轻、交付层重、传播层美，三层不混淆。
5. **正源在 armory**（`~/Theseus/armory/skills/`），各 agent 激活面软链；新 skill
   先沉淀 armory 再链接，不留单机孤儿。