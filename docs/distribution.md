# Distribution checklist

[README](../README.md) · [Getting started](getting-started.md)

Before committing or publishing:

1. Inspect `git status --short` and the exact staged files. For an npm release, inspect `npm pack --dry-run --json` too. Do not ship machine-local model bindings, authentication, sessions/goal state, generated `adapters/pi/out/` traces, or captured media. `.gitignore` is not a substitute for inspecting the actual file list.
2. Run `node scripts/validate.mjs`, the Node tests, and the Windows PowerShell fixture test:

   ```powershell
   node scripts/validate.mjs
   node --test (Get-ChildItem tests -Filter '*.test.mjs' | ForEach-Object FullName)
   pwsh -NoProfile -File tests/test-sync-pi.ps1
   ```

3. Report skipped or failing checks rather than claiming a clean release. Keep [LICENSE](../LICENSE) and review [third-party dependencies](third-party.md) before bundling external tools or their output.

Pi package installation and update instructions are in [Getting started](getting-started.md#install-for-pi). A Git push and an npm publish are separate operations.
