## Working in this repository

- Common knowledge lives in `rules/`, `skills/`, `agents/`, `routing/`, `context-pack/`, `lib/`.
- Anything that names a concrete provider, model, CLI, config-file format or install path belongs under `adapters/<backend>/`.
- Never write to `~/.pi`, `~/.codex` or other user locations from tests; adapters default to dry-run.
- Run `node --test tests/` before reporting.
