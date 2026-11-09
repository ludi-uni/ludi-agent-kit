# Distribution checklist

[README](../README.md) · [Getting started](getting-started.md)

Before committing or publishing (publishing is a separate, explicitly authorized operation):

0. After editing common `agents/*.md`, run `node adapters/pi/build-profiles.mjs`, then
   `node adapters/pi/build-profiles.mjs --check`. Commit/review the generated
   `adapters/pi/generated/agent-profiles/` together with its sources. It contains
   only portable role definitions and relative provider imports; installation and
   startup never run a generator. The manifest's `pi.subagents.agents` is the
   pi-subagents-supported registration mechanism, not a Pi-core resource type.

1. Inspect `git status --short` and the exact staged files. For an npm release, inspect `npm pack --dry-run --json` too. Do not ship machine-local model bindings, authentication, sessions/goal state, generated `adapters/pi/out/` traces, or captured media. `.gitignore` is not a substitute for inspecting the actual file list.
2. Run `node scripts/validate.mjs`, the Node tests, and the Windows PowerShell fixture test:

   ```powershell
   node scripts/validate.mjs
   node --test (Get-ChildItem tests -Filter '*.test.mjs' | ForEach-Object FullName)
   pwsh -NoProfile -File tests/test-sync-pi.ps1
   ```

3. Test the **real npm artifact**, not just a dry-run file list. With separately
   installed Pi and pi-subagents at the validated versions (Pi 1.4.0,
   pi-subagents 0.83.1, Node 24.22.1/native Windows), explicitly set `$piEntry`
   to Pi's actual JS CLI entry and `$subagentsDir` to the pi-subagents package
   root, then run:

   ```powershell
   node tests/e2e-package.mjs "--pi-entry=$piEntry" "--subagents-dir=$subagentsDir"
   ```

   This packs into OS temp, installs with scripts/peer installation disabled,
   moves the package to a Japanese/space path, and starts installed Pi in offline
   RPC with a redirected `PI_CODING_AGENT_DIR` and no inherited auth. It checks
   package-role discovery through the public preflight API, exactly one kit
   command/skill registration, zero messages/tokens/cost, coder/tester actual
   provider allowed/blocked commands, missing dependency startup, a simulated
   pre-manifest 0.3.0 fixture -> current tarball npm upgrade, preserved model
   overrides, and selected legacy-link backup/restore. It hashes installed content
   to reject runtime writes and checks packed paths/text for local state and
   build-machine paths. The synthetic legacy fixture is not evidence about an
   older published tarball. The npm CLI must be next to Node, or supplied via
   `npm_execpath`. No network/model/publish operation is needed. Installed runtime
   files are read-only inputs; all test writes are temporary and cleaned up.
   An ordinary `npm pack --dry-run` alone does not establish any of these behaviors.

4. Report skipped or failing checks rather than claiming a clean release. Keep [LICENSE](../LICENSE) and review [third-party dependencies](third-party.md) before bundling external tools or their output.

Pi package installation and update instructions are in [Getting started](getting-started.md#install-for-pi). A Git push and an npm publish are separate operations.
