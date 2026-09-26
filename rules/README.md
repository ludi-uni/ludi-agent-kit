# rules/

Model- and backend-independent operating rules. These are the single editable source;
adapters compose them into whatever their runtime loads (pi: `~/.pi/agent/AGENTS.md`,
Codex: `~/.codex/AGENTS.md` prefix).

- `common.md` — core operating policy (scope, safety, Windows-native, orchestration).
- `loop-prevention.md` — progress rule for all models; also injected by the pi loop-guard extension.

Never edit generated output files; edit here and re-run the adapter sync.
