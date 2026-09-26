# codex adapter

Codex is one backend among others. Its logical name in `routing/routing.json` is `codex`.

What lives here now:

- `skill-metadata/visual-verification/agents/openai.yaml` — Codex Skill UI metadata that
  the neutral skill directory no longer carries. A Codex install step would overlay it.

What intentionally stays in the frozen `codex-setting` repository (not copied):

- `scripts/install.ps1`, `update.ps1`, `check.ps1`, `common.ps1`, `tests/test-installation.ps1`
  — the hash-verified `~/.codex/skills` installer with backups/rollback/lock.
- `skills/subagent-management/` — depends on Codex collaboration tools.
- `~/.codex/AGENTS.md` common-prefix projection (`commonPolicyEndHeading`).

Future work (not this phase): a `sync-codex.ps1` that (a) renders `rules/` into the
common prefix of `~/.codex/AGENTS.md`, (b) installs `skills/` plus the metadata overlay,
(c) renders `mcp/servers.json` into `config.toml [mcp_servers]`. Until then, keep using
the frozen codex-setting installer for Codex.

Model binding: when Codex is invoked through pi-subagents' `codex-exec` adapter no pi
model id is needed; when it is used as a pi provider (`openai-codex/...`), bind it in
`adapters/pi/models.json` under backend `codex`.
