# The Armory — Personal Taste Collection

The Armory (`sephirxth/theseus-armory`, private for now) is the owner's curated skill library: ~131 skills distilled from real working practice. It is the **taste layer** of TheseusV2 — how the system prefers to think, express, verify, and communicate.

> A taste collection: these skills are not a pile of tools, but preferences about *how to do certain kinds of things*, distilled from long practice.

## Selected (v0 draft, pending final review)

### Thinking & Argument
| skill | one-liner |
|---|---|
| first-principles / -derivation / -grounding | first-principles trio: argue, derive, ground |
| jury-panel / multi-persona-jury | Condorcet-style ten-persona orthogonal-cognition deliberation panel |
| grill-me / grilling / grill-with-docs | adversarial grilling — roast the plan until it stops smoking |
| precedent-first-design | name the mature human precedent before inventing |
| concept-diagram | concept extraction & causal-tension diagrams (anti-container-fallacy: baseline S0 / barrier walls / SVP) |
| domain-modeling / ubiquitous-language | domain modeling & ubiquitous language |
| verbal-algorithm | speak the algorithm before coding it |
| loop-me | looped self-examination |
| wayfinder | path-finding |

### Verification & Engineering Discipline
| skill | one-liner |
|---|---|
| test-ratchet | test ratchet — tests only tighten, never loosen |
| requesting-code-review / code-review | pre-commit review & code review |
| diagnosing-bugs | four-phase hard-bug diagnosis |
| systematic-debugging | root-cause debugging |
| setup-pre-commit | pre-commit gates |
| git-guardrails-claude-code | git safety guardrails |
| resolving-merge-conflicts | neutral merge-conflict arbitration |
| qa | issue-writing discipline |

### Expression & Visuals (by weight tier)
| skill | one-liner |
|---|---|
| show-me | tier 0: text trees / call stacks / diff syntax — the smallest view that makes the point (sourced from HumanLayer) |
| scientific-html | tier 2: academic-grade HTML (the weekly letter / technical report form) |
| eli5 | plain-language explainers for dense concepts |
| excalidraw-diagram | hand-drawn-style real diagrams |
| concept-figure | concept figuration |
| writing-great-skills | the meta-skill of writing good skills |
| deliver-pdf | PDF delivery |

### Writing & Research
| skill | one-liner |
|---|---|
| lit-review | literature review workflow |
| paper-essence | paper distillation |
| wos-bibliometric | Web-of-Science bibliometrics |
| proposal-writer / proposal-style | grant-proposal writing & style |
| report-48h | the 48-hour report method |
| notebooklm | NotebookLM workflows |
| obsidian-vault | Obsidian vault operation |

### Information Intake
| skill | one-liner |
|---|---|
| x-ingest / wechat-article-ingest / xiaohongshu-ingest | three-platform content ingestion |
| bili2text | Bilibili video to text |
| asr | speech transcription service |
| web-access | web access |

### Office & Collaboration (Feishu ecosystem)
lark-* / feishu-cli-* series (~40): doc / sheets / base / im / mail / calendar / minutes / okr / slides / whiteboard / workflow — the Feishu suite, CLI-operated. Listed here as one line by design: ecosystem tools, not taste statements.

### Games & Assets
| skill | one-liner |
|---|---|
| gameui / gameui-score | game UI & scoring |
| godot-android-export-packaging | Godot APK export & signing |
| game-unpack / game-reverse | game unpacking & reverse engineering |
| codex-imagegen | image-generation chain orchestration |
| numeric-forge / numeric-systems | numerical design & modeling |

### Operations & Self-Management
| skill | one-liner |
|---|---|
| skill-management / skillspector / find-skills | skill curation & inspection |
| handoff / implement / executor-guide / triage | task handoff & execution discipline |
| migrate-to-shoehorn / scaffold-exercises | migration & exercise scaffolding |
| improve-codebase-architecture | architecture-improvement flow |

## Excluded (private layers, never in the collection)

- **youyuan-voice** — the owner's Chinese writing-style distillation (personal corpus, never public)
- info-ingest / research-knowledge internal vendor & crawler config — private infrastructure
- var/ archive/ synthesis/ — runtime state & event ledgers
- environment-bound caches (claude-cache, windows-cache, etc.)

## Operating Principles

1. **The armory is the source of truth**; each agent (claude/codex/hermes) activates by symlink. No orphan copies.
2. **Ask the tier before writing**: for expression, pick the lightest sufficient weight.
3. New skills: sediment into the armory first, then link, then use — order matters.

---
*This list is draft v0, assembled by the agent from memory and usage frequency; **pending owner review**. After final review it will sync to the armory README and be published.*