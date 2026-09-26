# Roadmap — minimal next items

Phase 1 (structure/schema) and Phase 2 (executable path, see `phase2-report.md`) are done.
Ordered by dependency; each is small and independently testable.

1. **Apply settings proposal safely.** `sync-pi.ps1 -ApplySettings`: back up `settings.json`,
   merge only `subagents.agentOverrides.{scout,coder,visual,reviewer}`, verify JSON round-trip,
   refuse on concurrent change. Then `subagent({agent:"coder"})` in pi uses routed models.
2. **Tool-enabled agents.** Replace one-shot `pi -p --no-tools` for coder with a pi-subagents launch
   (child gets `read/edit/powershell`), keeping the kit runner as escalation wrapper. Keep the
   FILE-block path as fallback for tool-less/local models.
3. **Reviewer step.** After coder success, run `reviewer` (deep-review) read-only on the diff + pack;
   block "success" on severity-high findings. Same escalation wrapper.
4. **Rule-based classifier.** `routing/classify.json` (keywords / file globs / has-image -> capability);
   `--task` only entry; still no LLM classifier.
5. **Usage-limit awareness.** Recognise provider limit errors in the invoker and mark the backend
   cooling for the run so both scout and coder skip it (currently each step discovers it separately).
6. **pi startup check.** Port `check-pi.mjs` (offline RPC `get_commands`) against a temp agent dir
   populated by `sync-pi.ps1 -Apply`, asserting kit skills, agents and single loop guard.
7. **codex adapter sync.** `sync-codex.ps1` rendering `rules/` and skills (+ metadata overlay), dry-run first.
8. **local backend adapter.** `adapters/local/` documenting an OpenAI-compatible endpoint and binding it to `local`.

Orchestrator Phase 1 adds the plan/delegate/evaluate loop. Phase 2 (`docs/orchestrator.md`)
persists that loop in SQLite so a later process can resume it, including user decisions and
short-lived backend health. Phase 3 gaps (Asana) are listed there.

Explicit non-goals until the above exist: unbounded autonomous loops, agent-to-agent chat, cost optimization, GUI, pi-web changes.
