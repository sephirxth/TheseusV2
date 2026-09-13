# TheseusV2

> **Systems that improve how they improve** — a human-in-the-loop, process-level self-evolving workspace.

TheseusV2 (忒修斯之船二号) is a personal cognitive-infrastructure system: an infinite canvas bound to a real intent DAG, where **state is never stored — it can only be *folded* from append-only traces**, and where every mutation of "what the system believes" passes a human gate.

**Key design tenets:**

- **Fold, don't store.** Current state is a deterministic function of an append-only trace log — like a bank balance derived from transactions, never recorded separately. The history is the only truth; stored state cannot contradict it.
- **HumanDoor.** Claims about the owner's intent are only valid if folded from the owner's own recorded words. Agent-written "beliefs" never enter the owner's state. This is a structural defense against agent hallucination — not a prompting defense.
- **Intent DAG, not chat history.** Intentions form a directed-acyclic graph with multiple predecessors converging (no tree-shaped lie), driven forward causally. The canvas is a projection of that DAG, not a document.
- **Process-level RSI, human-in-the-loop.** The system's purpose since inception is *self-evolution with its owner* — improving its own briefs, gates, metrics and procedures (external traces, not model weights), with the human as the acceptance gate and the bottleneck-to-amplify. It is deliberately not autonomous RSI.
- **Six-layer verification lineage.** Positive cases / negative cases / mutation self-checks / metamorphic tests / perturbation robustness / epistemic anti-forgery (proposals lock, machines may never mark their own work as aligned).

---

## Evolution History

### Prologue — "Loop" and moon (2026-02)

The lineage begins before the name. On **2026-02-25**, a repo called *Loop* was initialized — "人机协作系统" (a human-AI collaboration system), with a Telegram bot as the mobile capture surface for fleeting thoughts. It was renamed **moon** within weeks (`feat(月)`, then `feat(moon): direct channel core and c0 self-repair`, 2026-03-14 — already doing self-repair). In April 2026, the pre-restructure moon was archived intact (`.archive/moon-pre-restructure-20260418/`), preserving the origin point of the entire lineage.

### Origins — Theseus V1 ("keel", 2026-03)

V1 started 2026-03-21 as a monorepo named *keel* (龙骨 — the ship's keel; moon and bridge entered as submodules, and moon itself had been running since February — see Prologue). Its **second commit, on day one**, was already about self-improvement:

```
2026-03-21  init: keel monorepo with moon + bridge submodules
2026-03-21  feat: keel advancement cron — system self-monitoring + organizational leverage
2026-04-12  docs: 忒修斯重构 spec — 隐喻映射 + 目录结构 + 验收标准   (Theseus refactor spec)
2026-04-20  bootstrap(stage-1): spawn/judge/runner/scheduler + architecture + 5 stories
2026-04-28  feat(P12.5): self-build handoff MVP — 每日自省/提议、approved-proposal 穿透
            (daily self-reflection & proposals, approved-proposal passthrough)
2026-05-06  feat(bridgeV2): self_projection 真实数据驱动 + directory_self_image 重生
2026-07-20  feat(memory): expose unique append CLI                    (append-only memory primitive)
2026-07-20  feat(intent): persist canonical revisions and claims     (intent domain: canonical revisions)
2026-07-20  feat(intent): add local shadow data flywheel + run local student in shadow
2026-07-23  perf(watchers): fix O(N^2) full-ledger reads starving the dispatcher
2026-08-07  chore(memory): 把 L2 手写判据纳入版本控制                (L2 hand-written criteria into VCS)
```

107 commits over ~5 months. The **忒修斯 (Theseus) refactor spec** landed 2026-04-12, renaming and reorganizing keel into the ship metaphor. V1 already carried the core ideas in embryo: append-only memory (`unique append CLI`), intent canonization, a shadow student/teacher learning loop, and daily self-reflection proposing its own improvements.

### TheseusV2 — the re-launch (2026-08)

V2 was initialized on **2026-08-16** (this repository) as a clean re-build around the trace-folding discipline:

```
2026-08-16  init: 启停与痕迹两块完工，意图树与环的设计就位
            (start/stop + traces complete; intent tree & loop designed)
2026-08-17  feat(trace): 谁干的必须三段；每条用例补反面场景；量出 U13 的第一组真数字
            (provenance must be 3-part; negative scenarios per use-case; first real numbers)
2026-08-19  feat(intent): 意图树完工——树是痕迹上的一次折叠，节点只认挂在人话上的
            (intent tree done — the tree is a fold over traces; nodes only trust human utterances)
2026-08-19  docs: PolyForm Noncommercial 许可 + README 英文主入口
2026-08-19  docs(bridge): 桥的用例 U25–U29——把系统接到我说话的地方
            (the bridge connects the system to where I speak)
2026-08-20  feat(canvas): 画布 v0.1 — 直接迭代，不走用例流水线
2026-08-20  feat(canvas): 幽灵树接入现有意图 + 缩放尺度语义 (v0.2)
            (ghost tree + zoom-scale semantics)
2026-08-20  feat(canvas): 缩放三刀 (v0.2.1) → 布局即信息 (v0.2.2) → 连线与时间轴投影 (v0.3)
2026-08-20  feat(canvas): 真·时间轴——年月日刻度 + 多意图泳道 (v0.3.1)
            (true timeline — date ticks + multi-intent swimlanes)
```

### After the initial 14 commits

The repo's committed core stopped at the canvas v0.3.1 milestone while daily development moved to working-tree flow (requirements/checks//graphs as on-disk artifacts — the IADD structure below). Milestones since (in working tree, progressively committed):

- **U25–U29** — bridge use-cases: connect the system to the owner's messaging surfaces (Hermes gateway bridge).
- **U30–U34** — canvas use-cases: claims inherited from a 2021 requirements document, not invented fresh.
- **U37** — procedural process-graph runtime: YAML process graphs + assertion gates + rollback edges. Machine pays the cost once; the second graph is nearly free.
- **U38** — canvas engine migration: React Flow → **tldraw** (^5.4.2), semantic zoom, three-level LOD.
- **U39** — knowledge pipeline: ingest → annotate → structure → publish (second process graph on the U37 runtime), with the annotation reader as the human-door bandwidth amplifier.

### Roadmap (next)

- **U40** — service governance: register the 9 systemd units into the declared-parts manifest, `Restart=on-failure`, start/stop events written as traces (the system records its own life).
- **U41** — evolution metrics: fold one-pass rate / rework rate / human-machine cycle time from traces (never persisted — metrics are folded views), feeding process-graph revisions through a backtest gate. Grounded in the GEPA line of work (language-mediated reflection over scalar rewards), with the human annotation gate as the piece GEPA lacks.

---

## Why "Theseus"?

The ship of Theseus: every plank replaced, yet the ship remains the same ship. This system replaces its own planks — prompts, procedures, graphs, metrics — continuously; identity is preserved not by any stored state but by the **continuity of the trace**. (The name predates the unrelated academic "Theseus Lab" that appeared publicly in Sept 2026; this repo was created 2026-08-16, and its predecessor V1 began 2026-03-21.)

## License

MIT (see LICENSE).