# Canvas (v0.1)

The second entrance. Iterated directly, skipping the use-case pipeline (decided 2026-08-20) — but the compass remains U30–U34 of [`docs/requirements/canvas.md`](../docs/requirements/canvas.md).

## Architecture (selection criterion: survives continuous change)

- **Frontend**: React + [`@xyflow/react`](https://reactflow.dev) (MIT) + Vite.
  Nodes are components: the component table in `nodes.tsx` is the type registry — adding a new
  object kind (agent card, review item, operator brief) is one more line, no skeleton surgery.
  Drag, box-select, zoom, minimap out of the box; build artifacts fully local, zero CDN.
- **Server**: `server.ts`, Node built-in http, zero frameworks, directly reusing `src/trace.ts` /
  `src/intent.ts` / `src/doors.ts`. **The tree is always folded on demand, never stored twice.**
- **Two ontologies, two storage paths:**
  - Mirrors (intent tree, status): truth lives in the trace store; the canvas only reads;
  - Natives (positions, notes, viewport): stored in `canvas-layout.json`.
  **The layout gate recursively validates fields — no runtime-truth field can enter** (the dimension-lens lesson).
- **The panel is a human gate** (design/intent.md 2.3): a button click is an utterance, recorded
  as `canvas.said` (`user:human:canvas`); intent traces attach via `tool:canvas` through the agent gate.
  Criteria apply as-is; no second gate invented on the canvas.

## Run

```sh
pnpm install               # repo root (pnpm workspace)
pnpm -C canvas build       # frontend -> canvas/dist
node canvas/server.ts      # 127.0.0.1:8811, serves API + dist
pnpm -C canvas dev         # dev: vite HMR, /api proxied to 8811
```

Environment variables: `THESEUS_TRACE_DB` (default `~/.local/state/theseus/trace.db`),
`THESEUS_CANVAS_LAYOUT` (default `canvas-layout.json` in the same directory), `THESEUS_CANVAS_PORT` (default 8811).

## What v0.1 has

Claim (child of current), resume here, mark done, drop (requires a reason); birth edges solid,
merge edges dashed; current-node highlight; drag archives position; double-click empty space
pins a note; the right-side detail reveals the birth utterance; SSE: when the ledger changes,
every open canvas follows.

## Extension points (where to change next)

- New object type -> add a component in `nodes.tsx` + register in `App.tsx` `nodeTypes`.
- New action -> one more branch in `act()` in `server.ts` (the human-gate + intent-trace
  combination never changes).
- Dangling list / who-is-waiting-on-me (desktop form of bridge U27/U29) -> server already has
  `intent.dangling()`.
- Faceting / focus (U33) -> frontend filter + fade-out; facet definitions can live in layout
  (new fields must pass the layout gate's validation too).