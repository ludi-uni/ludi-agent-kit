# Offline Pi startup check evidence

## Invocation and result

```powershell
node scripts/check-pi.mjs --json
```

The installed managed Pi 1.1.0 passed **37/37 checks**, exit 0, on native Windows.
The JSON report was saved locally as `%TEMP%/ludi-pi-startup-live.json`; stderr was
empty. Temporary state was removed (`cleanup.tempRootRemoved: true`, `kept: false`).
OS cleanup may later remove that local report.

## Isolation and operations

- A fresh temporary `agent/`, `work/` and `tmp/` were created.
- `sync-pi.ps1 -AgentDir <temporary-agent> -Apply` populated the fixture. Neither
  `-ApplySettings` nor `-BackupConflicts` was used.
- Pi ran with `--mode rpc --offline --no-mcp --no-session --no-tools --no-approve`
  and no project context, prompt templates or themes.
- Only `get_commands`, `get_state` and `get_session_stats` were sent. No prompt,
  steering, shell execution, compaction, authentication or model request was sent.
- The child received only allowlisted OS environment values plus temporary home,
  configuration, cache and temp paths. Parent credentials, proxy settings and Pi
  session/model environment were not forwarded.
- The sync refreshed the kit's gitignored `adapters/pi/out/` previews. Real user
  configuration and credentials were not changed.

Offline mode suppresses Pi's automatic network activity; it is not an OS network
sandbox. Only the known kit links were admitted by structural validation before
Pi was allowed to load their resources.

## Observed registrations and structure

Public RPC verified exactly one `orchestrate` extension command and one each of:

- `skill:pi-workflow`
- `skill:project-management`
- `skill:visual-verification`

Their registration sources and physical paths matched the kit. Pi also listed its
unrelated builtin `llama` command; that is allowed.

Structural checks verified the generated `AGENTS.md`, the expected skill/agent/
extension links, one loop-guard extension entry, and eight matching agent definitions:
`browser`, `coder`, `design-planner`, `orchestrator`, `reviewer`, `scout`, `tester`,
`visual`.

The child was idle with no messages or persisted session file. Reported user and
assistant messages, tool calls/results, all token counters, and cost were **zero**.
It exited cleanly after stdin was closed.

## Proof boundary

RPC does not expose the agent registry or extension hook counts. Agent definitions
and loop-guard uniqueness are **structural evidence**, not proof of pi-subagents
runtime registration or a measured hook registration count. The separate
pi-subagents package is not installed or exercised by this check. Model quality,
provider authentication and quota are outside its scope.

`tests/pi-startup.test.mjs` uses mocked processes and temporary files only. Its
negative cases cover missing/duplicate/wrong-source registrations, malformed or
truncated JSONL, response correlation, unexpected activity, nonzero or missing usage,
process errors, deadlines, byte limits, refusal of unowned roots, and cleanup failure.
Those mocks supplement, rather than replace, the real offline result above.
