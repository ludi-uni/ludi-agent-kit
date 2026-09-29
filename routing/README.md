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

Phase 6 adaptive tasks use these same ordered candidate chains and `escalation.ladders`,
not a second router. Backends declare `capability_class` (`basic` → `standard` →
`strong` → `expert`), `cost_class` (`free`, `included`, `low`, `paid`, `high`),
and allowed `roles`. A concrete adapter binding may override these values when a
slot's actual model or contract differs. Its `availability_class` must be
explicitly `available` for autonomous escalation; missing/unknown, disabled,
quota-exhausted, or temporarily unavailable routes are never auto-selected.
Free/included → free/included stronger routes are automatic when otherwise
eligible; additional-cost routes create an `approval_required` task state and
are **not** invoked. Do not label campaign pricing as `free` without verifying
that the specific local binding is covered by your contract.
