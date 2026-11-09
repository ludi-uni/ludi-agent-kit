# Pi package installation and migration

[日本語](pi-package.ja.md) · [Getting started](getting-started.md)

## Supported boundary

Validated with Pi **1.4.0**, pi-subagents **0.83.1**, Node **24.22.1**, native Windows and PowerShell 7. Node must satisfy Pi/the kit's `>=22.19.0` requirement. Older Pi/pi-subagents versions are not certified by this check; update to the validated baseline before relying on package-agent discovery. macOS/Linux and standalone Pi are not validated here. Windows shell/media tools need PowerShell and their own optional dependencies.

The installed Pi README, `docs/packages.md`, `docs/extensions.md`, `docs/configuration.md`, `docs/settings.md` and `docs/cli.md`, and pi-subagents' `docs/agents.md`, `docs/extension-api.md`, and public `pi-subagents/agents` declarations are the integration references. Pi discovers skills/extensions through `pi`; pi-subagents discovers roles through **`pi.subagents.agents`**. There is no Pi-core roles API assumed here. Independent runtime registration is a different, process-local API used only by the existing orchestrator launcher; named package roles do not use it.

## Fresh install and update

```powershell
pi install npm:@ludi-uni/ludi-agent-kit
pi install npm:pi-subagents  # separate dependency; opt in explicitly
pi list
# Restart Pi, then:
# /ludi-doctor
# /subagents-doctor
```

One kit source is sufficient: npm, git, or a local checkout, not all three. Installing the kit itself does not install pi-subagents or mutate credentials, role overrides, global instructions or model settings. There are no npm lifecycle scripts. `sync-pi.ps1 -Apply` and manual Junctions are **not** package-install steps. Package roles inherit the Pi/subagents model unless the operator overrides it; an unconfigured model is diagnosed without a model call. `/ludi-doctor` passively pings the loaded pi-subagents owner, reports whether a model is selected, and reads local installation diagnostics; it changes nothing. An on-disk dependency alone is not proof that it loaded. Filtered package resources and extra scan/exclude roots need inspection with `pi config` and `/subagents-doctor`.

For unpinned installs: `pi update npm:@ludi-uni/ludi-agent-kit`, then restart Pi. `pi update` alone updates Pi itself on the validated runtime. Version-pinned sources stay pinned: explicitly install the desired version. Confirm the source/version with `pi list`. User/project agent files take priority over package roles; `subagents.agentOverrides` remain untouched and can deliberately change model/tool selection. A role shadow warning is not permission to delete a custom definition.

`coder` and `tester` alone receive `ludi_exec` plus a child-only provider with fixed policy. Their allowlists never contain raw `bash`/`powershell`. Other roles retain their authored tools and receive no new provider/permission. The shell gate is a command-policy check, **not an OS sandbox**: allowed tests/builds execute repository code with the process permissions. Trust the workspace and review commands. No restriction here confines malicious repository code or operator-provided overrides.

Pi-hosted orchestration stores state under `<agent-dir>/ludi-agent-kit/state.db` and activity under `activity/clients/`, never in the installed package. `<agent-dir>` honors `PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`. Explicit `store` / `LUDI_ORCHESTRATION_STORE` remains supported but package-contained paths (including existing junction aliases) are refused. Source-only CLI previews/legacy sync still create checkout-local `out/`; run those from a writable source checkout, not an npm installation.

## Read-only diagnostics

Set `$kit` to the installed package directory shown by `pi list`, or the checkout root. Paths may contain spaces or Japanese characters.

```powershell
node "$kit/adapters/pi/package.mjs" doctor
node "$kit/adapters/pi/package.mjs" doctor "--agent-dir=$agentDir" "--project-dir=$projectDir"
```

The default agent directory honors `PI_CODING_AGENT_DIR`. This reports old local/npm declarations, unresolved references, dangling links, legacy links, colliding/custom role names and model/dependency uncertainty. It never reads auth files or prints settings contents. JSON output may contain local paths; do not publish it without review. It is a filesystem diagnosis, not a complete host inventory: git/local dependency resolution, filtered resources, ancestor project config, and arbitrary custom scan roots must also be checked in Pi. A clean report is not authentication/quota proof.

## Explicit legacy migration and restore

1. Run diagnostics and `pi list`. Choose one kit source. Remove only an unwanted exact package declaration with Pi's `pi remove <source>` (use `--local` for project declarations); then install the chosen source if needed. The helper intentionally does **not** rewrite settings or remove source trees. Unresolved/broken sources require manual review.
2. Old `agents/ludi-agent-kit` links to raw `agents/` shadow the safe package profiles. Legacy skill/extension links can duplicate package resources. Preview retirement of **one explicitly selected link**:

   ```powershell
   node "$kit/adapters/pi/package.mjs" migrate --entry=agents/ludi-agent-kit "--expect-target=$oldTarget"
   # Only after reviewing that exact entry and target:
   node "$kit/adapters/pi/package.mjs" migrate --entry=agents/ludi-agent-kit "--expect-target=$oldTarget" --apply
   ```

   Allowed slots: `agents/ludi-agent-kit`, `extensions/ludi-agent-kit`, `extensions/ludi-orchestrator`, `skills/pi-workflow`, `skills/project-management`, `skills/visual-verification`. The target must match and an intact enclosing kit `package.json` must verify ownership. Custom files/directories, relative links, linked parent directories and unverified dangling targets are refused. No recursive deletion or link-target modification occurs. If an entire `agents` parent is an old Junction, stop and review it manually; do not force the helper through it.
3. The selected link is renamed intact into `<agent-dir>/ludi-agent-kit/migrations/<backup-id>/link`, with a recovery manifest. Keep the returned ID. Backups are never scanned as agents and never pruned automatically. Restore is preview-only until `--apply`, and refuses if anything now occupies the original destination:

   ```powershell
   node "$kit/adapters/pi/package.mjs" restore --backup-id=<backup-id>
   node "$kit/adapters/pi/package.mjs" restore --backup-id=<backup-id> --apply
   ```

4. Restart Pi, rerun `/ludi-doctor` and `/subagents-doctor`, and inspect role/model selection. Restore deliberately reinstates the old link (and any old shadowing); it does not roll back npm versions or model settings. Stop Pi/other configuration editors while migrating; filesystem operations are bounded, not a cross-process configuration transaction. Generated legacy `AGENTS.md` and unrelated codex-setting links are outside this helper's write scope.

## Building and verifying distribution

Edit common `agents/*.md`, then explicitly run `node adapters/pi/build-profiles.mjs`. The tracked `adapters/pi/generated/agent-profiles/` output is included in npm/git installs. `--check` detects stale/extra generated files without writing. No generation happens at installation/startup. Relative provider imports survive relocating the whole package; generated/legacy output must remain at `adapters/pi/{generated,out}/agent-profiles/` inside the kit, not copied alone.

See [Distribution checklist](distribution.md) for the real `npm pack` isolated install/update/migration test, including public preflight discovery, actual provider allow/deny execution, absent dependency/unconfigured model startup, Unicode/space paths, zero model usage, and unchanged installed-package content.
