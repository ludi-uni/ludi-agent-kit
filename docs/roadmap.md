# Roadmap — minimal next items

Phase 1 (structure/schema) and Phase 2 (executable path, see `phase2-report.md`) are done.
The original backlog below is now implemented by the orchestrator; see
[orchestrator.md](orchestrator.md) for the modules. Kept only as orientation:

- **Tool-enabled agents** — `adapters/pi/lib/subagent.mjs` runs `pi --mode json -p` with an
  `access`-derived tool allowlist and the `shell-gate` extension. One-shot
  `pi -p --no-tools` (`createPiInvoker`) remains the no-launcher fallback.
- **Reviewer step** — `reviewer` runs as a subagent task. Findings follow the strict
  severity/classification schema in `lib/orchestrator/review-policy.mjs`, drive bounded
  repair/replan decisions, and gate run completion (`completionGate`).
- **Rule-based classifier** — implemented differently: the `rules` planner
  (`classifyRequest` in `lib/orchestrator/planner.mjs`) derives task kinds from keywords
  and stage gating. There is no `routing/classify.json` and still no LLM classifier.
- **Usage-limit awareness** — `lib/orchestrator/health.mjs` classifies limit failures and
  skips the backend for the rest of the run and until
  `backend_health.usage_exhausted_ttl_hours` in SQLite.

## Current sequence

1. **pi CLI discovery fix + tests — implemented.**
   `adapters/pi/lib/invoke.mjs` resolves `LUDI_PI_ENTRY`, npm layout, and managed
   installs; hermetic fixtures live in `tests/pi-entry.test.mjs`. The dirty-workspace
   CLI regression also forbids Pi discovery before refusal, regardless of the host install.
2. **Roadmap refresh — completed.** This document distinguishes implemented behavior
   from the remaining integration and verification work.
3. **User-authorized real-provider E2E — smoke test passed.**
   [Live evidence](reports/real-provider-e2e.md) records four completed Devin SWE-2
   tasks (investigation, implementation, tests, review), a focused expected-failure
   evaluation correction, and the earlier incomplete Qoder/Devin attempts.
   This does not establish free entitlement, general reliability, or rollout readiness.
   The [Phase 8 evidence](reports/phase8-e2e.md) remains a controlled lifecycle fixture,
   not a live-provider run. Confirm authorization and cost conditions before further live runs.
4. **Apply settings proposal safely — implemented.** `sync-pi.ps1 -ApplySettings`
   (explicit opt-in; `-Apply` still touches only links/AGENTS.md) backs up
   `settings.json` byte-for-byte to `<AgentDir>/ludi-agent-kit/backup-*/`, merges only
   `subagents.agentOverrides.{scout,coder,visual,reviewer}.{model,thinking}` preserving
   all other fields/roles/keys, verifies a JSON round-trip, and refuses on concurrent
   change via a pre-resolution SHA256 snapshot + `.ludi-apply.lock` sidecar
   (`adapters/pi/lib/settings-apply.mjs`, tests in `tests/settings-apply.test.mjs`).
   The concurrency guard detects changes and serializes cooperating applies but is not
   a kernel compare-and-swap against arbitrary external editors. Manual merge from
   `out/settings.proposal.json` remains an alternative.
5. **pi startup check — implemented; live offline check passed.**
   `scripts/check-pi.mjs` (runtime in `adapters/pi/lib/startup-check.mjs`) populates a
   temp agent dir via `sync-pi.ps1 -Apply`, starts installed Pi in offline RPC mode, and
   asserts the `orchestrate` extension command, the three `skill:*` registrations with
   physical kit targets, zero activity/usage, expected link set and one loop-guard entry.
   Agent definitions are verified structurally — RPC `get_commands` exposes no agent
   registry, and pi-subagents registration stays out of scope (separate package).
   Unit coverage (`tests/pi-startup.test.mjs`) is fully mocked. The installed Pi also
   passed all 37 live checks, with zero model usage and confirmed temporary cleanup;
   see [startup evidence](reports/pi-startup-check.md). Run `node scripts/check-pi.mjs --json`
   for a new opt-in local check.
6. **Direct pi-subagents launcher — implemented (Pi-hosted orchestrator only).**
   `adapters/pi/lib/native-subagent.mjs` registers a per-invocation runtime agent over
   `pi-subagents:runtime-agent-register:v1` and dispatches a foreground structured
   delegation (`prompt-template:subagent:*`) with the pinned model, fresh context, an
   allowlist including the hidden `ludi_guard` sentinel, a generated guard extension
   enforcing the initial turn/tool caps (stricter: no adapter-local progress
   extension), `intercomBridge:{mode:'off'}`, and a hard tool budget. The subprocess
   launcher is selected only when the owner is absent before dispatch; unconfirmed
   stops return a blocker and retain the writer lease until both the matching
   terminal and child-guard quiescence. The lease is quarantined before native
   writer dispatch: a dead host alone cannot prove orphan shells stopped and does
   not permit automatic recovery (operator verification/manual recovery required). The CLI (`scripts/orchestrate.mjs`) still uses
   `pi --mode json -p`; `createPiInvoker` stays the one-shot and
   model-planning fallback (now lazily created inside the extension so missing CLI
   discovery cannot block native dispatch). Verified against pi-subagents 0.76.1
   contracts with hermetic unit tests and an installed-owner integration run using
   a local deterministic provider: read/write/gated shell, turn-cap stop, caller
   cancellation, live shell-tree cancellation and missing-guard refusal all verified
   without hosted-model calls. See [native evidence](reports/native-launcher.md).
7. **One-shot parallelism — implemented.** `createPiInvoker` now uses asynchronous
   `spawn`, so existing bounded read-only scheduling can overlap one-shot calls
   without blocking the host event loop. Isolated prompt files, per-stream byte
   limits, timeout escalation and optional AbortSignal handling are regression-tested
   with local child processes; cancellation does not advance model candidates.
   Only confirmed close/spawn failure permits prompt cleanup or a returned result.
   An unresponsive process remains pending after owned-PID SIGTERM/SIGKILL requests;
   elapsed grace is not termination proof. See [evidence](reports/oneshot-async.md).
8. **Asana intake + `ExternalProjectStore`.** See [orchestrator.md](orchestrator.md), Phase 4 gaps.
9. **`sync-codex.ps1`.** Render `rules/` and skills (+ metadata overlay) for Codex,
   dry-run first; see [Codex adapter](../adapters/codex/README.md).
10. **`adapters/local/`.** Document an OpenAI-compatible endpoint and bind it to `local`.

Explicit non-goals until the above exist: unbounded autonomous loops, agent-to-agent chat, cost optimization, GUI, pi-web changes.
