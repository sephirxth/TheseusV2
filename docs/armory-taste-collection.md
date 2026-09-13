# The Armory — Personal Taste Collection

The Armory (`sephirxth/theseus-armory`) is the owner's curated skill library: ~131 skills distilled from real working practice, organized by category. It is the **taste layer** of TheseusV2 — how the system prefers to think, express, verify, and communicate.

> 品味合集：这些 skill 不是工具堆砌，是长期工作中沉淀下来的"怎么做某类事"的偏好。

## 入选合集（初选清单，待终审）

### 思维与论证
| skill | 一句话 |
|---|---|
| first-principles / first-principles-derivation / first-principles-grounding | 第一性原理三件套：论证、推导、接地 |
| jury-panel / multi-persona-jury | 孔多塞陪审团定理的十人正交认知轴审议 |
| grill-me / grilling / grill-with-docs | 拷问式审查——把方案烤到冒烟为止 |
| precedent-first-design | 新需求先找人类成熟先例，再谈 AI 增量 |
| concept-diagram | 概念提取与因果张力图（反容器谬误：基线 S0/势垒墙/SVP） |
| domain-modeling / ubiquitous-language | 领域建模与统一语言 |
| verbal-algorithm | 口头算法——先说清算法再写码 |
| loop-me | 循环式自我审视 |
| wayfinder | 路径探寻 |

### 验证与工程纪律
| skill | 一句话 |
|---|---|
| test-ratchet | 测试棘轮——只进不退的测试纪律 |
| requesting-code-review / code-review | 提交前审查与代码评审 |
| diagnosing-bugs | 难症四阶段诊断 |
| systematic-debugging | 根因调试 |
| setup-pre-commit | 预提交门禁 |
| git-guardrails-claude-code | git 安全护栏 |
| resolving-merge-conflicts | 冲突中立仲裁 |
| qa | 问题书写的纪律 |

### 表达与视觉（重量分级）
| skill | 一句话 |
|---|---|
| show-me | 第0档：文本树/调用栈/diff——最小说明白一件事（源自 HumanLayer） |
| scientific-html | 第2档：学术排版 HTML（周刊与技术报告主形态） |
| eli5 | 复杂概念的人话解释器 |
| excalidraw-diagram | 手绘风真图形 |
| concept-figure | 概念图形化 |
| writing-great-skills | 写好 skill 本身的元技能 |
| deliver-pdf | PDF 交付 |

### 写作与研究
| skill | 一句话 |
|---|---|
| lit-review | 文献综述流程 |
| paper-essence | 论文本质提炼 |
| wos-bibliometric | WOS 文献计量 |
| proposal-writer / proposal-style | 本子（申报书）写作与文风 |
| report-48h | 48 小时报告法 |
| notebooklm | NotebookLM 工作流 |
| obsidian-vault | Obsidian 知识库操作 |

### 信息摄入
| skill | 一句话 |
|---|---|
| x-ingest / wechat-article-ingest / xiaohongshu-ingest | 三平台内容摄入 |
| bili2text | B 站视频转文字 |
| asr | 语音转写服务 |
| web-access | 网页访问 |

### 办公与协作（飞书生态）
lark-* / feishu-cli-* 系列（doc/sheets/base/im/mail/calendar/minutes/okr/slides/whiteboard/workflow 等约 40 个）——飞书全家桶的 CLI 化操作。

### 游戏与资产
| skill | 一句话 |
|---|---|
| gameui / gameui-score | 游戏 UI 与评分 |
| godot-android-export-packaging | Godot APK 导出与签名 |
| game-unpack / game-reverse | 游戏解包与逆向 |
| codex-imagegen | 生图链编排 |
| numeric-forge / numeric-systems / game-numerical-design | 数值设计与建模 |

### 运维与自我管理
| skill | 一句话 |
|---|---|
| skill-management / skillspector / find-skills | skill 的管理与巡检 |
| handoff / implement / executor-guide / triage | 任务交接与执行纪律 |
| migrate-to-shoehorn / scaffold-exercises | 迁移与练习脚手架 |
| improve-codebase-architecture | 架构改进流程 |

## 未入选（私有层，不进合集）

- **youyuan-voice** — 用户本人的中文文风蒸馏（个人语料，永不公开）
- info-ingest / research-knowledge 内部 vendor 与爬虫配置 — 私有基础设施
- var/ archive/ synthesis/ — 运行状态与事件账本
- 纯环境绑定类（claude-cache、windows-cache 等）

## 使用原则

1. **正源在 armory**，各 agent（claude/codex/hermes）通过软链激活；不留单机孤儿
2. **先问档位再动笔**：表达类按重量分级选最轻够用的
3. 新 skill 先沉淀 armory、再链接、再使用——顺序不可反

---
*此清单为初选（v0），由 agent 按记忆与使用频率起草，**待所有者终审**；终审后同步至 armory README 并公开。*