# Visual & Communication Skills — Taste Collection

TheseusV2's expression layer is not a single tool but a set of visual/communication skills ordered by **weight** — from zero-cost text trees to full HTML artifacts. Pick the smallest tier that suffices for the current context. The collection itself is the owner's expression taste: no walls of prose, no heavy weapons for light problems, no diagram trying to hold all information at once.

## Weight tiers (lightest first — prefer lighter)

### Tier 0: Text structures (zero generation cost, scanned in seconds in chat/terminal)
**show-me** (sourced from HumanLayer) — say it with the minimum:
- pseudocode for logic/algorithms
- call trees for control flow (`submitForm → createSession → …`)
- component trees for UI structure (keep only state and module boundaries)
- shallow file trees for responsibility & refactor scope (one responsibility per line)
- **diff syntax for changes** (`+`/`-`, never paste the whole new file)
- state / sequence diagrams in Mermaid
- escalate to a single focused HTML file only when a concept is too dense for the above
- core discipline: *Pick the smallest view that makes the key point clear.*

### Tier 1: Structured diagrams (real graphics but still light)
**concept-diagram** — concept extraction & causal-tension diagrams (anti-container-fallacy: baseline S0 / barrier walls / SVP)
**excalidraw-diagram** — hand-drawn-style architecture/flow/sequence diagrams
Decision trees: Mermaid, always.

### Tier 2: Single-file HTML artifacts (heavy; only when the concept is dense or the result is meant to persist)
**scientific-html** — academic-grade layout (editorial mode + CSS-box diagram library); the weekly letter & technical report form
**eli5** — plain-language explainers (dimension-reduced explanation, not a simplified report)
**concept-figure** — concept figuration
**architecture-diagram** — dark SVG infrastructure/cloud diagrams
**baoyu-infographic** — infographics (21 layouts × 21 styles, for dissemination)
**sketch / claude-design** — throwaway HTML mockups (2-3 design variants to compare)
**pretext** — DOM-free text-layout experiments

### Tier 3: Specialized media
**ascii-art / ascii-video** — character art / colored ASCII video
**manim-video** — 3Blue1Brown-style math animation
**p5js** — generative art / shaders / interactive

## Meta-principles

1. **Ask the tier before writing**: what a chat could say with an indented tree, never gets an HTML file; what must persist (reports/weekly letters/public material) goes straight to tier 2.
2. **Each diagram answers exactly one question**: keep only the calls, files, props, states and boundaries needed to answer the current question. A diagram holding everything holds nothing.
3. **Diff over full listing**: always use diff shape to explain "what changed"; full listing only when most content is new or a copyable target shape is needed.
4. **Taste is selection, not accumulation**: the value of this collection is restraint — light in conversation, heavy in delivery, beautiful in dissemination. Three layers, never confused.
5. **Source of truth lives in the armory** (`~/Theseus/armory/skills/`); agents activate by symlink. New skills: sediment into the armory first, then link. No orphans.