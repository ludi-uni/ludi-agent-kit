# Architecture

## Layers

```
┌─────────────────────────────────────────────────────────────┐
│ common (backend-neutral)                                     │
│  rules/   skills/   agents/   routing/   context-pack/  lib/ │
│  mcp/servers.json                                            │
├─────────────────────────────────────────────────────────────┤
│ adapters/<backend-runtime>/   (pi, codex, later: local, …)   │
│  models.json  templates  sync script  runtime-specific glue  │
├─────────────────────────────────────────────────────────────┤
│ user environment  (~/.pi/agent, ~/.codex)  — never owned     │
└─────────────────────────────────────────────────────────────┘
```

- **rules/** — text policy every agent gets. Two files: `common.md`, `loop-prevention.md`.
- **skills/** — knowledge + scripts that any runtime with Agent-Skills support can load.
- **agents/** — role contracts. Frontmatter is pi-subagents compatible; the only kit-specific
  key is `capability`.
- **routing/** — capability → backend, with fallback and escalation ladders.
- **context-pack/** — the interchange format between cheap and expensive agents.
- **lib/** — validators/loaders; plain Node ESM, no dependencies, used by scripts and tests.
- **adapters/** — everything concrete. pi is the first-class runtime; Codex is just a backend.

## Data flow (target state)

1. User task → parent (pi main session).
2. Parent classifies the task into a capability (manual today; a classifier later).
3. `scout` (cheap-code) explores and emits a **Context Pack**.
4. Parent validates the pack (`lib/context-pack.mjs`) and hands it to `coder` / `visual` /
   `reviewer`, whose capability resolves through routing → adapter model map.
5. On failure, escalation ladder moves to the next capability (e.g. cheap-code → strong-code).

The orchestrator (`lib/orchestrator/`, `docs/orchestrator.md`) runs steps 2 to 5 as a bounded loop.
It uses the same agents, routing and adapter invoker. Sub-agent decision requests go through
`orchestration/decision-policy.json` before the user is involved. A run can be stored in SQLite
and resumed from a later process; see `docs/orchestrator.md`.

Separately, `scripts/reevaluate-models.mjs` is a periodic maintenance task: when provider
conditions change (free-campaign end, quota/rate-limit change, deprecation, price change,
new model), it re-scores each capability's binding against `adapters/<x>/model-catalog.json`
and writes a proposal to `adapters/<x>/out/model-maintenance.proposal.json`. Phase 2 wraps it
in execution tiers — monitor / evaluate / reconfigure — each selecting a model under a
free -> cheapest-sufficient -> local-fallback policy (`lib/maintenance-exec.mjs`,
`adapters/<x>/maintenance-policy.json`), audited in `out/model-maintenance.run.json`.
Proposals only — applying is a manual `models.local.json` edit + re-resolve.
See `docs/model-maintenance.md`.

## Windows-native constraints

- PowerShell 7 scripts; Junctions (no symlink privilege needed); no WSL.
- Paths derive from `$env:USERPROFILE`, `$env:PI_CODING_AGENT_DIR`, `$PSScriptRoot`; never a
  fixed user name (enforced by `tests/kit.test.mjs`).
