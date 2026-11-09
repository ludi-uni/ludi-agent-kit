# skills/

Backend-neutral Skills (Agent Skills format: `SKILL.md` with `name`/`description`
frontmatter). Copied from codex-setting; paths that assumed `~/.codex` were replaced by
"the discovered skill directory" (`$skillRoot`).

Notes describe the state at copy time; check `git log` / current content for changes made in this repo since.

| Skill | Origin | Notes |
| --- | --- | --- |
| visual-verification | codex-setting `skills/visual-verification` | `agents/openai.yaml` moved to `adapters/codex/skill-metadata`; scripts updated in this repo since the copy |
| project-management | codex-setting `skills/project-management` | unchanged at copy time |
| pi-workflow | codex-setting `pi/harness/skills/pi-workflow` | unchanged at copy time |

Adding a skill:

1. Create `skills/<name>/SKILL.md`; `scripts/validate.mjs` checks the frontmatter.
2. Register `./skills/<name>` in the `pi.skills` array in `package.json`.
3. Update the expected `pkg.pi.skills` list in `tests/package.test.mjs`.
4. `adapters/pi/sync-pi.ps1` links it automatically into the Pi agent dir.
