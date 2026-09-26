# OSS and external dependencies

This repository contains its own source, documentation and scripts under the [MIT license](../LICENSE). Material reused from the predecessor `codex-setting` is enumerated in [the migration notes](migration-from-codex-setting.md); its `LICENSE` carries the same 2026 `ludi-uni` MIT notice. The repository does **not** bundle the executables, Python packages or npm packages below. Installing them separately does not change this repository's license; when redistributing their binaries, read the exact installed version's license, notices and bundled-component terms.

| Tool / project | Used for | Availability / license reference |
| --- | --- | --- |
| [pi coding agent](https://github.com/badlogic/pi-mono) and optionally [pi-subagents](https://www.npmjs.com/package/pi-subagents) | Live agent/model calls; subagent integration | Separately installed; verify the license of the **actual pi distribution or fork** in use. `pi-subagents` npm metadata declares MIT. Neither is needed for source validation. |
| [TypeBox](https://github.com/sinclairzx81/sinclair-typebox) | `Type` import in optional pi extensions (`adapters/pi/{shell-gate,orchestrator-ext}/index.js`) | Provided by the compatible pi extension environment; upstream license: MIT. Not a dependency of core CLI scripts. |
| [agent-browser](https://github.com/vercel-labs/agent-browser) | Optional browser capability and opt-in browser E2E | Separately installed CLI; upstream license: Apache-2.0. |
| [Playwright](https://github.com/microsoft/playwright) | Browser UI verification guidance | External tool; upstream license: Apache-2.0. No bundled browser binaries. |
| [Microsoft WinApp CLI](https://github.com/microsoft/winappCli) | Optional Windows desktop inspection/capture | Separately installed preview CLI; upstream license: MIT. |
| [FFmpeg](https://ffmpeg.org/legal.html) / `ffprobe` | Optional media capture, frame/audio processing | Separately installed. FFmpeg's licensing is build-dependent (LGPL or GPL options); inspect the actual build before redistribution. |
| [WhisperX](https://github.com/m-bain/WhisperX) | Optional speech analysis via the local Python adapter | Separately installed Python environment/models; upstream license: BSD-2-Clause. Downloaded models and transitive dependencies may have separate terms. |

Core CLI validation uses Node.js built-ins (including `node:sqlite` for orchestration). The npm manifest declares `typebox` as a peer dependency for the Pi extensions, not a bundled runtime dependency. Provider/model API usage can incur charges and is subject to provider terms; the JSON model catalog is not a statement of licensing, entitlement or present availability. `scripts/check-environment.ps1` probes optional tools but does not install them. The precise licenses of an installed version should be checked at its upstream package/repository before including it in a release archive.
