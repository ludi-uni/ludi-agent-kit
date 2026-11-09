## Working in this repository

- Common knowledge lives in `rules/`, `skills/`, `agents/`, `routing/`, `context-pack/`, `lib/`.
- Anything that names a concrete provider, model, CLI, config-file format or install path belongs under `adapters/<backend>/`.
- Never write to `~/.pi`, `~/.codex` or other user locations from tests; adapters default to dry-run.
- Run the test suite before reporting with explicit file enumeration (directory args fail with MODULE_NOT_FOUND on Windows Node 24).
  - In a raw PowerShell session (parent/orchestrator), enumerate and expand in one command:
    `node --test (Get-ChildItem tests -Filter '*.test.mjs' | ForEach-Object FullName)`
  - Gated `ludi_exec` workers cannot pass PowerShell pipelines or substitutions through the shell
    gate. Do not rely on glob expansion or directory arguments for the test runner. Enumerate
    `tests/*.test.mjs` with an available read-only listing tool, then pass a single literal command
    expanding real file names separated by spaces or quotes,
    e.g. `node --test tests/orchestrator-cleanup.test.mjs tests/orchestrator-command.test.mjs`.
  - A focused check such as `node --test tests/orchestrator-cleanup.test.mjs` is valid for a focused
    fix but is not a substitute for the full enumerated suite before final reporting.
