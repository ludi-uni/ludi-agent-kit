# routing/

`routing.json` maps **capabilities** (what a task needs) to **logical backends**
(what can serve it). It contains no provider or model ids.

```
capability  ──primary──▶ backend ──adapters/<x>/models.json──▶ provider/model
            └─fallback─▶ backend ─┘
```

Capabilities: `cheap-code`, `strong-code`, `vision-reasoning`, `deep-review`,
`browser`, `orchestration`.
Backends: `local`, `cheap`, `sol`, `astra`, `codex`, `qoder`, `devin`.
`qoder`/`devin` are provider slots like any other — the concrete model is bound in
`adapters/<x>/models*.json` (e.g. `qoder/Qwen3.8-Flash`, `devin/swe-2-high`).

Validation (`lib/routing.mjs`): version 1; lowercase names; every primary/fallback is a
defined backend; no duplicate/self fallback; `requires.vision` must hold for the primary
(fallbacks may be *degraded* and are flagged); escalation ladders reference known
capabilities. `routing.schema.json` is the equivalent JSON Schema for editors.

Swapping models never touches this file or any agent: edit the adapter model map.
Adding a backend (e.g. a second local model): add it under `backends`, reference it
from a capability, bind it in each adapter.
