# Migration from codex-setting

`codex-setting` is frozen: no new features; it continues to work as the Codex installer
and as the current provider of the `~/.pi/agent` Junctions on this machine.

## Classification of codex-setting files

### Reused (copied into this kit)
| codex-setting | ludi-agent-kit |
| --- | --- |
| `skills/visual-verification/**` (minus `agents/openai.yaml`) | `skills/visual-verification/` (SKILL.md path examples de-Codexed) |
| `skills/project-management/**` | `skills/project-management/` |
| `pi/harness/skills/pi-workflow/**` | `skills/pi-workflow/` |
| `pi/harness/AGENTS.md` | `rules/common.md` (plus a Context-Pack sentence) |
| `shared/loop-prevention.md` | `rules/loop-prevention.md` |
| `pi/extensions/index.js` | `adapters/pi/loop-guard/index.js` (policy path updated) |
| `tests/test-swe-loop-guard.mjs` | `tests/loop-guard.test.mjs` (fixture provider names neutralized) |
| `skills/visual-verification/agents/openai.yaml` | `adapters/codex/skill-metadata/...` |
| `LICENSE`, `.gitattributes` | same |

### Left in codex-setting (Codex-specific)
`scripts/install.ps1`, `update.ps1`, `check.ps1`, `common.ps1`, `tests/test-installation.ps1`,
`skills/subagent-management/`, `codex/README.md`, `shared/resources.json`
(`commonPolicyEndHeading`, `~/.codex/AGENTS.md` projection).

### Re-implemented rather than copied
| codex-setting | reason | kit replacement |
| --- | --- | --- |
| `scripts/install-pi.ps1`, `migrate-pi-harness.ps1`, `activate-pi-harness.ps1` | coupled to codex-setting layout, Codex AGENTS projection, PATH/pi-web edits | `adapters/pi/sync-pi.ps1` (dry-run default, no settings/PATH writes) |
| `scripts/check-pi.ps1/.mjs`, `tests/test-pi-*.{ps1,mjs}` | read `codex-settings/pi.json` state | `tests/test-sync-pi.ps1`; RPC startup check deferred |
| `pi/agents/{main,coder,vision,reviewer}.md` | hardcoded `model: swe-2-high` | `agents/{scout,coder,visual,reviewer}.md` with `capability` |
| `pi/README.md`, `HARNESS-DESIGN.md`, `VALIDATION.md` | historical | `docs/` |

## Cut-over on this machine (not performed)

1. `pwsh adapters/pi/sync-pi.ps1` — review `adapters/pi/out/plan.json`.
2. `pwsh adapters/pi/sync-pi.ps1 -Apply -BackupConflicts` — re-points skill Junctions,
   writes generated AGENTS.md (old one backed up), adds `agents/ludi-agent-kit` and
   `extensions/ludi-agent-kit`.
3. Manually remove the old `agents` and `extensions/codex-settings` Junctions (link only)
   to avoid a duplicate loop guard.
4. Restart pi; `pi` → `/reload`; confirm skills appear and the loop guard loads once.
5. Rollback: restore `ludi-agent-kit/backup-*/AGENTS.md`, recreate the old Junctions from
   codex-setting (`scripts/install-pi.ps1 -Compact`).
