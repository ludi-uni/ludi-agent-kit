# Model maintenance — periodic subagent re-evaluation

Provider conditions change: free campaigns end, quotas and rate limits move, models are
deprecated or removed, prices change, new models appear. `scripts/reevaluate-models.mjs`
is the periodic maintenance task that re-checks whether each capability's current model
binding is still rational — and produces a **proposal only**. Nothing is applied
automatically.

## What it reads

| Input | Path | Role |
| --- | --- | --- |
| routing | `routing/routing.json` | capabilities, backend tiers, `requires.vision` |
| agents | `agents/*.md` | capability → agent names (for `affected.agents`) |
| model bindings | `adapters/pi/models.json` < legacy `adapters/pi/models.local.json` < `~/.pi/agent/ludi-agent-kit/models.local.json` (`PI_CODING_AGENT_DIR` respected) | current provider/model per backend; user-level overrides survive npm upgrades |
| catalog | `adapters/<x>/model-catalog.json` | model facts: status, cost, contextK, vision, toolUse, quality scores, `location`/`local` power metadata |
| exec policy | `adapters/<x>/maintenance-policy.json` | Phase 2: requiredQuality per tier, capabilityRequirements (coding/reasoning floors), cost weights, electricity price, escalation thresholds |
| events | `--events <file>` | what changed (see event types below) |
| availability | `--check-availability` or `--availability-file` | optional `pi --list-models` probe |

## Free-capacity planning

Each maintenance run includes `freeCapacityPlan` even if no provider event arrived.
For each capability it lists free cloud candidates that meet configured coding/reasoning
floors, required vision, tool-use and known availability. It reports the suggested
candidate, campaign cutoff, current primary and existing fallback backends; this is
**advisory**, not a routing or live settings change. Catalog scores are heuristic:
validate task success before a binding change. A missing quality requirement produces
no automatic recommendation. If no free model qualifies, retain the existing route
or review a paid fallback rather than weakening the capability requirement.

`freeUntil` is an exclusive UTC timestamp. At/after the cutoff the catalog's effective
view uses `postCampaignCost` (or unknown cost), and a maintenance run detects the
expiry even without an explicit event. Check the provider's actual entitlement and
billing: catalog dates, especially user-reported campaign dates, are not a guarantee.
For Devin SWE-2-high, "through 10/10" is interpreted as through 2026-10-10 JST,
with the exclusive cutoff 2026-10-11 00:00 JST. Confirm year/timezone with Devin
before relying on that boundary. Qoder's campaign end remains unknown, so verify
its live free entitlement before using it at scale.

## Event types

`free-campaign-ended`, `free-quota-changed`, `rate-limits-changed`, `price-changed`,
`deprecated`, `removed`, `model-added`. One event file:

```json
{"version":1,"events":[{"type":"free-campaign-ended","provider":"qoder","model":"Qwen3.8-Flash","asOf":"2026-03-01"}]}
```

## What it does

For every backend that is the **primary** of at least one capability:

1. Apply events to the catalog entry (`free-campaign-ended` re-prices to
   `postCampaignCost`; `deprecated`/`removed` change status).
2. Score current and candidate models with tier-weighted dimensions — cost, coding,
   reasoning, speed, context, tool use (`lib/maintenance.mjs` `TIER_WEIGHTS`: `free`/`low`
   tiers weight cost, `mid`/`high` weight quality). Capability `requires.vision` and
   `toolUse:none` filter the candidate pool.
3. Decide:
   - **keep** — best candidate advantage is below the margin (default 8, `--margin`), or
     the candidate data is low-confidence. *A free campaign ending is not by itself a
     reason to switch*: the current model is re-scored with its post-event cost and only
     loses on merit.
   - **propose** — advantage ≥ margin, or a forced migration (`removed` / `deprecated` /
     absent from a provider listing that was successfully probed).
   - **insufficient-data** — no eligible candidate or the current model can't be scored.
   - **skip** — backend unbound or placeholder. Fallback-only backends are reported as
     `not-primary`, not evaluated.

## Information sources and fallback

| Source | How | Fallback when unavailable |
| --- | --- | --- |
| Model facts (price, context, scores) | `model-catalog.json`, maintained by hand from provider pricing pages / model docs / market snapshots | `scores: null` dims are excluded from scoring; a fully-unknown current model yields `insufficient-data`, never a speculative switch |
| Provider events | `--events` file written by the operator (or a future fetcher) | no events → availability + catalog status still catch `removed`/`deprecated` |
| Live availability | `--check-availability` runs `pi --list-models` (read-only) | probe failure → catalog status only; `infoStatus.availability` records which path ran. A provider missing from the listing means *unknown*, never *gone* |

## What a proposal contains

Each `changes[]` entry: `changeReason`, `affected` (backend, capabilities, agents),
`currentModel`, `proposedModel`, `expectedCostImpact`, `expectedQualityImpact`,
`scores` (current/proposed/delta/margin), `confidence`, and `rollback` — the previous
binding embedded plus the manual steps to restore it.

## Applying and rolling back

The task writes only `adapters/<x>/out/model-maintenance.proposal.json`. To apply:
edit the user-level `ludi-agent-kit/models.local.json` per `proposedModel`, re-run
`scripts/resolve-capabilities.mjs`, then merge `out/settings.proposal.json` into
`~/.pi/agent/settings.json` yourself. Rollback is the same flow using
`rollback.previousBinding`. It never writes `settings.json`, `models.json`,
`models.local.json`, `routing.json`, or anything under `~/.pi`.

## Phase 2 — execution tiers (monitor / evaluate / reconfigure)

The maintenance run itself has a cost hierarchy: the AI that watches and judges model
config is chosen under a **free -> cheapest-sufficient -> local fallback** policy, and
only escalates to a premium tier when the decision warrants it. The run is a dry-run
decision layer: `runMaintenancePlan` (`lib/maintenance-exec.mjs`) selects which model
each tier *would* run on and records why — no model is invoked, no config is written.

```
monitor      cheapest watcher: diffs events/catalog/availability ->
             { changed, reasons, affectedModels, severity, escalationRequired }
   | changed
evaluate     cheapest-sufficient judgement: interprets evaluateMaintenance() ->
             keep-inside-margin | proposal
   | complex / low-confidence / large blast radius
reconfigure  premium tier (a strong coding model at that point in time — never a
             hardcoded name): multi-capability or structural re-optimisation
   |
proposal     still only out/model-maintenance.proposal.json
```

### cheapest-sufficient selection

Per tier, `selectTierModel` computes for every catalog model:

```
quality   = tier-weighted 0-100 score (coding/reasoning/speed/context/toolUse)
eligible  = usable status AND toolUse != none AND availability != 'unavailable'
            AND quality >= requiredQuality[tier]
effectiveCostUsd/run = api($/1M blended) + electricity + speedPenalty
selected  = free cloud eligible? -> cheapest of those
            else cheapest eligible cloud
            else cheapest eligible local   (local fallback)
```

Free is preferred **only when it meets the quality bar** — a free model below
`requiredQuality` is rejected and selection proceeds to cheapest-sufficient.
Unknown cost components fall back to the cheapest *known* value in the pool, so an
unpriced model is never treated as free. `availability: unknown` (probe absent or
provider unseen) stays eligible; only `unavailable` (absent from a successful listing)
is excluded.

### Escalation conditions (evaluate -> reconfigure)

Any one of: proposed changes span >= `minCapabilities` (2) capabilities or >=
`minAgents` (3) agents; largest quality swing >= `minQualitySwing` (15 points); a
winning margin below `maxScoreDelta` (4 — a hard call); low-confidence or
insufficient-data decisions; a structural event (`removed`/`deprecated`); or monitor
severity `high`. The escalation is recorded on the run and on every proposed change as
`escalationReason`, `sourceTier`, `targetTier`, `affectedCapabilities`,
`estimatedDecisionCostUsd`.

### Local fallback and electricity cost

Catalog entries with `location: "local"` may carry `local: { powerWatts, taskMinutes }`.
Estimated run cost: `(powerWatts/1000) * (taskMinutes/60) * electricityPricePerKwh`
(`maintenance-policy.json`, default $0.30/kWh). Local entries join the same scoring —
if a cloud API run is cheaper than the electricity estimate, the cloud model wins
(Case E in `tests/maintenance-exec.test.mjs`).

### Run report

Every run writes `adapters/<x>/out/model-maintenance.run.json` (gitignored): per-tier
`selected` model, `selectionPath` (`free-cloud` / `cheapest-sufficient-cloud` /
`local-fallback`), `selectionReason`, full `candidates` list with `rejectedReasons`,
`estimatedDecisionCostUsd`, `fallbackOccurred`, the monitor output, the escalation
record, and the Phase 1 proposal when produced. No credentials are ever stored.

Policy defaults live in `lib/maintenance-exec.mjs` (`DEFAULT_POLICY`); the adapter
overrides them in `adapters/<x>/maintenance-policy.json` (`--policy` to point elsewhere).

## Phase 3 — real invocation (`--live`)

`node scripts/reevaluate-models.mjs --live` runs the same tiered pipeline but actually
calls the selected models through the pi adapter invoker (`adapters/pi/lib/invoke.mjs`:
`pi -p --model <provider/id[:thinking]> --no-tools --no-session --no-approve`). No new
execution substrate — model ids come from the same catalog/selection path.

### Deterministic authority boundary

The engine decides: eligible models, `requiredQuality`, cost, availability, escalation
conditions, and the keep/propose outcome. The LLM only interprets and annotates
(`reasoningSummary`, `proposalNotes`, `recommendedActions`). `recommendedModels`
outside the catalog are stripped and recorded as `rejectedRecommendations`. If a tier's
output fails schema validation twice (one retry), the run continues on the
deterministic result alone (`degradedToDeterministic`).

### Tier prompts and schemas

Each tier gets a fixed prompt (`buildTierPrompt`) embedding the deterministic facts and
a required JSON shape (`TIER_SCHEMAS`):

- **monitor** — organise diffs; `decision: changed|no-change`, `severity`,
  `evaluateNeeded`. Cannot propose routing changes.
- **evaluate** — judge the deterministic result; `decision: keep|propose|insufficient-data`,
  `confidence`, `proposalNotes`. Confidence below `escalation.minEvaluateConfidence`
  (0.5) escalates.
- **reconfigure** — re-review the whole picture for structural/multi-capability
  changes; adds `routingNotes`. Output is advisory only.

### Cost per run

`estimatedCostPerRun` normalises cloud and local to USD/run:
`api = (inTokens x $/1M-in + outTokens x $/1M-out)` from `taskProfiles[tier]`
(`estimatedInputTokens`/`estimatedOutputTokens`/`estimatedTaskMinutes`); local uses
`powerWatts x taskMinutes x electricityPricePerKwh`. Plus a small speed penalty.

### Failure and fallback

On invoke failure / quota / timeout / two bad outputs, the runner walks the
deterministic `ordered` candidate chain (free-cloud, then sufficient pool by cost).
Premium models (`premium: true` in the catalog) only enter the chain at the
reconfigure tier. Audit lands in `out/model-maintenance.run.json` under `invocations[]`:
model, ok/failureClass, schemaValid, latencyMs, tokens/actualCost when reported,
estimatedCostUsd, fallback chain. Prompts and credentials are never stored.

## Phase 4 — observation layer (`scripts/observe-models.mjs`)

External provider conditions are collected as **normalized observations**, stored,
deduped, diffed against the catalog, and turned into a *proposal* — never applied.
The layer is separate from the core engine (`lib/observe/`); the maintenance logic
stays free of provider/web specifics.

```
external sources (manual / pi --list-models / fixture announcements)
  -> source adapters (lib/observe/sources.mjs)
  -> normalized observations (validate + hash)
  -> out/model-observations.jsonl  (dedupe: same hash = duplicate; older = stale)
  -> resolve conflicts (newer > trust > confidence; equal-trust major diff = conflict)
  -> out/catalog-diff.json + out/model-catalog.proposal.json
  -> --preview-maintenance: hypothetical catalog -> Phase 1-3 dry-run
```

### Observation schema

`{ provider, model, observedAt, source:{type:manual|api|web|cli, trust, url, label},
changes:{availability,status,free,freeUntil,inputPricePer1M,outputPricePer1M,
contextK,toolUse,vision}, confidence:0-1, evidence:[] }`. `null` = not observed —
distinct from `false`/`0`.

### Trust order

`manual_verified > provider_api > provider_web > pi_cli > third_party > unknown`.
Conflicts resolve by newer timestamp, then trust, then confidence; an equal-trust
disagreement on a major field (status/free/prices) is recorded as `conflict`, never
auto-resolved.

### Catalog proposal rules

`additions` (new model observed active), `updates` (field changes), `deprecations`
(status removed/deprecated — requires >=2 independent sources or one high-trust;
a listing absence alone is never removal), `conflicts`, `ignored`, `freshness`.
`applyProposalToCatalog` builds an in-memory hypothetical catalog for the preview.

### CLI

```powershell
node scripts/observe-models.mjs --source manual --input obs.json
node scripts/observe-models.mjs --source fixture --input announcements.json
node scripts/observe-models.mjs --check-pi
node scripts/observe-models.mjs --check-qoder          # qoder-models-cache.json priceFactor -> free observations
node scripts/observe-models.mjs --check pi-cli,qoder-cache  # generic observer list (same ids)
node scripts/observe-models.mjs --preview-maintenance
```

### Observer registry

Live probes are **observers** in `lib/observe/observers.mjs` — a common
`async run(context) -> { observations, probeFailed, metadata }` interface behind a
registry (`OBSERVERS`). `--check-pi`/`--check-qoder` map to `pi-cli`/`qoder-cache`;
`--check <csv>` accepts any ids. `resolveRequestedObservers` produces a stable,
deduped id list (unknown ids are an explicit error, never silently skipped);
`runObservers` executes each once, in order, isolating failures (one observer's
`probeFailed` never blocks the others; per-source results are audited on the run
record). Adding a provider = one registry entry — no CLI/job branching.

### Fixture / test boundary

Observations carry `environment: 'production' | 'test'` and `sourceFixture`. The
`fixture` source (`--source fixture`, `tests/fixtures/**` replays) tags its output
`test`. `productionObservations()` filters the store before `diffCatalog`/
`buildCatalogProposal` in both `observe-models.mjs` and `job.mjs`, so a fixture
replay is stored for audit but **never** drives a real catalog/routing proposal.
Anything without a marker counts as production (back-compat).

### Qoder provider-metadata observer (`--check-qoder`)

Reads `~/.pi/agent/qoder-models-cache.json` (schema v2: `{version, updatedAt,
models:[{id, priceFactor, ...}]}`) — the pi-maintained, provider-derived local cache —
**read-only**. `priceFactor` is the provider's subscription cost multiplier:
`0` = currently free, `>0` = paid. A missing file, unparseable JSON, absent entry,
or absent/invalid `priceFactor` yields *no observation* (unknown) — never a guessed
"not free". Trust tier `provider_local_cache`.

Transition detection compares against `out/qoder-observer-state.json` (gitignored
snapshot the job owns): `0 -> non-zero` emits `free:false` (campaign ended),
`non-zero -> 0` emits `free:true` (campaign started), same value emits nothing.
The emitted `free` field flows through the normal pipeline — catalog diff ->
proposal -> hypothetical catalog -> `free-campaign-ended|started` events ->
maintenance re-evaluation. A free end alone never forces a routing change;
`postCampaignCost: null` becomes `costUnknown` (not $0, not free) and is surfaced
in the proposal for human review. `--qoder-cache <path>` overrides the cache
location (tests/fixtures).

## Phase 5 — scheduled job + notifications (`scripts/model-maintenance-job.mjs`)

`model-maintenance-job.mjs` wraps observe -> dedupe -> diff -> meaningful-change gate
-> proposal -> preview -> optional `--live` tiers -> notification. Quiet by default:
only human-worthy changes notify. Exit code `0` quiet, `2` meaningful change pending
review, `1` error.

### Meaningful change & severity (deterministic, never LLM)

Quiet when: no observations / duplicates-only / stale-only / catalog unchanged /
no routing impact / probe-failed-only / unknown-only. Otherwise:

- **info** — new model, context/capability additions, no routing impact
- **action** — free-model end, cheapest-sufficient shift, preview binding change,
  all-tier-candidates-failed
- **urgent** — current model removed/deprecated/unavailable, fallback to local,
  no eligible candidate for an *unusable* backend, multi-capability impact

### Notification

Canonical payload (`severity,title,summary,changes,routingImpact,recommendedNextStep,
requiresApproval:true,proposalPath,previewPath,runId,observedAt`). Sinks: stdout,
`out/model-maintenance.notification.json`, and an opt-in `--notify-command` that
receives the JSON on stdin (audited; only runs when explicitly given). Dedupe:
`out/model-maintenance.state.json` stores `lastNotificationHash`/`lastSeverity`;
identical content is not resent, a severity rise re-notifies.

### Concurrency & budget

Single-run lock (`out/model-maintenance.lock`, stale after 30 min, auto-recovered),
atomic artifact writes (tmp+rename), `runId`/`startedAt`/`completedAt` in
`out/model-maintenance.lastrun.json`. Budget (`maintenance-policy.json` `budget`):
`maxEstimatedCostPerRunUsd`, `maxPremiumInvocationsPerRun`, `maxTotalInvocationsPerRun`
— over-budget skips invocations, continues deterministically, sets `budgetLimited`.

## Phase 6 — shadow mode + calibration (`scripts/report-model-maintenance.mjs`)

`--shadow` runs the normal pipeline but suppresses the external `--notify-command`
(stdout + file sinks still fire; `--shadow --shadow-notify` opts the command back in).
Every run appends a compact record to `out/telemetry-runs.jsonl` and folds into
`out/telemetry.json` via `lib/telemetry.mjs`.

### Telemetry

Aggregates: run/quiet/meaningful/notification/dedupe counts, severity distribution,
per-tier invocations, fallbacks (incl. local), premium invocations, budget-limited,
degraded-to-deterministic, observer failures, conflicts, duplicate/stale
observations, and cost totals (api / local-electricity / total, per-run, per
meaningful event, per notification). Per-decision records keep selected model,
tier, estimatedCostPerRun, quality vs requiredQuality margin, alternatives and
rejection reasons — no prompts or credentials.

### Report

`node scripts/report-model-maintenance.mjs [--days N] [--json] [--compact]` prints
Activity / Cost / Routing / Quality / Noise / Escalation sections, deterministic
warnings (too-noisy, too-expensive, too-many-premium-escalations,
too-many-fallbacks, quality-margin-too-small), counterfactual comparisons of the
selected model vs the runners-up it beat, and a policy calibration proposal.

### Calibration proposal + guards

`out/maintenance-policy.calibration.proposal.json` — each entry has
currentValue/proposedValue/evidence/expectedEffect/confidence. Emitted only when
`calibration.minRuns` (20) and `calibration.minMeaningfulEvents` (3) are met;
otherwise `insufficient-observation-data`. Never applied automatically.

### Retention

`--compact --days 30` folds raw run lines older than the window into a
`_compactedSummary` record; recent lines are kept, corrupt lines are never dropped,
and the rewrite is atomic (tmp+rename) so a failure preserves the original file.

## Scheduling

Run it when a provider announcement lands, or periodically:

Recommended cadence: every 6-12 hours (price/model conditions don't move per-minute;
avoid over-polling). One run at startup is reasonable. Overlap is prevented by the
lock file.

```powershell
node scripts/model-maintenance-job.mjs --check-pi --check-qoder --shadow   # recommended: availability + Qoder priceFactor, observe-only
# tests/fixtures/** replays write test-tagged observations; they never reach the production diff
node scripts/model-maintenance-job.mjs --check-pi                    # availability only
node scripts/model-maintenance-job.mjs --check-qoder                 # Qoder priceFactor only
node scripts/model-maintenance-job.mjs --check-pi --live             # + real tier invocations when needed
node scripts/model-maintenance-job.mjs --notify-command "node send.js"  # explicit external sink
# Windows Task Scheduler example (NOT registered by the kit):
#   schtasks /create /tn ludi-model-maintenance /sc hourly /mo 6 ^
#     /tr "node <kit>\scripts\model-maintenance-job.mjs --check-pi"
# exit code 2 = a notification is waiting for human review.

# Recommended initial rollout (Phase 6): shadow mode, no external notify,
# review the calibration report after 7 days.
#   schtasks /create /tn ludi-model-maintenance /sc hourly /mo 6 ^
#     /tr "node <kit>\scripts\model-maintenance-job.mjs --check-pi --shadow"
#   node <kit>\scripts\report-model-maintenance.mjs --days 7
```

The output file is gitignored (`adapters/pi/out/`); copy `changes[]` into an issue or
notes if you want history. Fixture for the Qoder/Qwen3.8-Flash free-campaign-end
scenario: `tests/fixtures/maintenance/`, exercised by `tests/maintenance.test.mjs`.
