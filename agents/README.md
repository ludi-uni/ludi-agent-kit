# Agents

Thin role definitions. Each file is Markdown with YAML frontmatter compatible with
pi-subagents agent discovery (`~/.pi/agent/agents/**/*.md`), plus kit-specific keys:

- `capability` — a routing capability from `routing/routing.json`. The kit resolves it
  to a concrete provider/model through the active adapter's model map; **agents never
  name a provider or model**.
- `execution` — `oneshot`, `subagent`, or `pipeline`. This is not a model capability.
- `access` — filesystem, shell, git, and network rights. The `tools` list stays the pi tool names.

pi-subagents treats `tools` as a strict allowlist and never interprets `access`,
so `adapters/pi/lib/agent-profiles.mjs` derives installed profiles through an
explicit release build (`node adapters/pi/build-profiles.mjs`) into
`adapters/pi/generated/agent-profiles/`. The `pi.subagents.agents` package
manifest registers them without user-directory links. User/project definitions
and model overrides retain precedence. Legacy source sync also renders
`adapters/pi/out/agent-profiles/`; do not combine both install methods. Only the approved subagent worker roles
(`coder`, `tester`) are adapted: they gain `ludi_exec` in the allowlist plus
`subagentOnlyExtensions` pointing at a generated policy-explicit shell-gate
provider. Every other role keeps its `tools`/frontmatter verbatim (browser and
visual keep their authored `powershell` entry) and gains no provider. Raw
`powershell`/`bash` is never granted through `ludi_exec`. Edit the common
definitions here; never hand-edit the derived output.

Roles:

| Agent | Capability | Writes files | Purpose |
| --- | --- | --- | --- |
| scout | cheap-code | no (output pack only) | exploration, grep/search, context reduction → Context Pack |
| coder | strong-code | yes | implementation, tests, debugging |
| visual | vision-reasoning | no | screenshot/video/image verification |
| reviewer | deep-review | no | diff, architecture, regression/risk review |
| tester | cheap-code | no | runs tests and reports command output |
| browser | browser | no (page state only) | local Web UI automation via `agent-browser` CLI (snapshot → ref → action) |
| design-planner | cheap-code | no | read-only goal decomposition → structured planning report |
| orchestrator | orchestration | no | plans, delegates, decides by policy, evaluates and integrates; never implements |

Agents never talk to each other directly. The orchestrator loop (`lib/orchestrator/`,
`scripts/orchestrate.mjs`) delegates to the other agents and resolves their decision
requests through `orchestration/decision-policy.json`; see `docs/orchestrator.md`.
