# skills/

Backend-neutral Skills (Agent Skills format: `SKILL.md` with `name`/`description`
frontmatter). Copied from codex-setting; paths that assumed `~/.codex` were replaced by
"the discovered skill directory" (`$skillRoot`).

| Skill | Origin | Notes |
| --- | --- | --- |
| visual-verification | codex-setting `skills/visual-verification` | scripts unchanged; `agents/openai.yaml` moved to `adapters/codex/skill-metadata` |
| project-management | codex-setting `skills/project-management` | unchanged |
| pi-workflow | codex-setting `pi/harness/skills/pi-workflow` | unchanged |

Adding a skill: create `skills/<name>/SKILL.md`; `scripts/validate.mjs` checks the
frontmatter and `sync-pi.ps1` links it automatically.
