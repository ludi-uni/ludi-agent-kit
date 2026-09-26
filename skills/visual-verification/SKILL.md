---
name: visual-verification
description: Capture and inspect native Windows, 3D, animation, or video evidence; route browser UI verification to Playwright.
---

# Visual Verification

Use this Skill for visual verification of native Windows apps, 3D scenes, animations, video, and same-session A/V evidence. For Web UI or browser interaction, use Playwright instead; do not use screen capture as a substitute for browser-level verification.

Store evidence in a temporary run directory, normally under `%TEMP%\agent-verification-lab`. Do not automatically upload, commit, or delete evidence. Treat captures as potentially sensitive: confirm that visible windows, notifications, personal data, credentials, and third-party content are appropriate to record before capture.

## Backend selection

- Web UI or browser surface: use Playwright.
- A visible or occluded Windows desktop window: use the WinApp CLI desktop scripts below.
- Explicit desktop/region evidence or legacy visible-window bounds capture: use the FFmpeg scripts under Static and Motion evidence.

Do not silently fall back from WinApp CLI to Playwright, FFmpeg `gdigrab`, or full-desktop capture. Those backends have different targeting, occlusion, and privacy contracts. Report the WinApp failure instead.

## Windows desktop windows

The experimental Windows desktop backend uses Microsoft WinApp CLI. Its tested contract is version `0.6.1` (`Microsoft.WinAppCli`), which is a Public Preview/pre-release. Each operation records the installed version as one of `SUPPORTED_TESTED`, `UNTESTED_NEWER`, `UNSUPPORTED_OLDER`, or `NOT_INSTALLED`. A newer untested version runs with `WINAPP_VERSION_UNTESTED`; an older version or missing CLI fails before capture.

Resolve the target on every run. Supply an application/process identity and narrow with an exact title, class, PID, HWND, or size when needed. PID and HWND are run-specific hints, not persistent identities. Multiple remaining candidates fail as `WINDOW_TARGET_AMBIGUOUS`; never select the first match implicitly.

```powershell
# $skillRoot is the directory containing this SKILL.md as discovered by the running agent (pi, Codex, ...).
$skill = Join-Path $skillRoot 'scripts'

pwsh -NoProfile -File "$skill\desktop-discover.ps1" -App 'VTube Studio'
pwsh -NoProfile -File "$skill\desktop-screenshot.ps1" -App 'VTube Studio'
pwsh -NoProfile -File "$skill\desktop-record.ps1" -App 'VTube Studio' -Duration 5 -Fps 5 -Frames -MaxEdge 1280
pwsh -NoProfile -File "$skill\desktop-inspect.ps1" -App 'VTube Studio' -Depth 6
```

`desktop-screenshot.ps1` and `desktop-record.ps1` always use WinApp's default window capture; they never add `--capture-screen`. This preserves the accepted visible/occluded-window behavior without foregrounding the target or expanding capture to unrelated screen pixels. Do not move, resize, foreground, minimize, or restore the source window merely to capture it. Visible and occluded windows are supported; minimized windows are `UNVERIFIED`.

Desktop screenshot success means the command succeeded, the target was recorded, and a non-zero valid PNG was created. It does not mean the UI content is correct. Inspect the PNG with `view_image` before semantic acceptance.

Desktop recording defaults to 5 seconds at 5 FPS. Use `-Frames` for WinApp's JPEG, `frames.ndjson`, and `manifest.json` evidence. The adapter validates a complete manifest and writes `representative-frames.json` selecting the first, middle, and last samples without duplicating deduplicated JPEG data. Inspect those JPEGs, or a bounded contact sheet when motion continuity matters; do not pass a long MP4 to vision by default.

UI inspection is optional and classified as `UIA_RICH`, `UIA_LIMITED`, or `UIA_UNAVAILABLE`. A limited tree is not a visual-capture failure: WinUI commonly exposes rich UIA data, while Unity and other GPU-rendered apps may expose only one Pane. The desktop backend does not automatically call `invoke`, `click`, `set-value`, or `send-keys`. Interaction is best effort, may foreground the target, and is never implied by a request to observe, verify, screenshot, or record.

Associated dialogs or popups discovered by WinApp are retained in metadata. This does not guarantee completeness for tooltips, unrelated overlays, or every separate top-level window. `--capture-screen` is an explicit, privacy-sensitive foreground operation and is not an automatic fallback.

The adapter normalizes preview CLI failures to `WINAPP_NOT_INSTALLED`, `WINAPP_VERSION_UNTESTED`, `WINDOW_NOT_FOUND`, `WINDOW_TARGET_AMBIGUOUS`, `CAPTURE_FAILED`, `RECORD_FAILED`, `UIA_LIMITED`, or `WINAPP_COMMAND_FAILED`. It considers exit code, upstream type, message, and structured fields because upstream error codes alone are not stable in the preview.

## Static evidence

Capture the required desktop, region, or exact visible window, then inspect the actual PNG with `view_image`. A successful command or file existence is not visual verification.

```powershell
# $skillRoot is the directory containing this SKILL.md as discovered by the running agent (pi, Codex, ...).
$skill = Join-Path $skillRoot 'scripts'
pwsh -NoProfile -File "$skill\screenshot.ps1" -Mode region -X 100 -Y 100 -Width 1280 -Height 720
```

The FFmpeg `window` mode requires exactly one exact window title or HWND. It captures that window's screen bounds, not an isolated compositor surface, so occlusion, overlays, and minimized windows can invalidate the evidence. It is not a fallback for a failed WinApp desktop-window operation.

## Motion evidence

Record a short run, extract a bounded ordered frame sequence, generate a labeled contact sheet, and inspect the contact-sheet PNG with `view_image`. Combine the visual result with relevant test output, logs, and state; each source supports a different claim.

H.264 `yuv420p` recordings preserve even captured dimensions; an odd captured width or height receives one black pixel of padding on the right or bottom respectively, without cropping.

```powershell
# $skillRoot is the directory containing this SKILL.md as discovered by the running agent (pi, Codex, ...).
$skill = Join-Path $skillRoot 'scripts'
$recordOutput = & pwsh -NoProfile -File "$skill\record.ps1" -Duration 5 -Fps 20 -Mode region -X 100 -Y 100 -Width 1280 -Height 720
if ($LASTEXITCODE -ne 0) { throw 'Recording failed.' }
$runDirectory = ($recordOutput | Where-Object { $_ -like 'RUN_DIRECTORY=*' } | Select-Object -Last 1).Substring('RUN_DIRECTORY='.Length)
pwsh -NoProfile -File "$skill\extract-frames.ps1" -InputVideo (Join-Path $runDirectory 'recording.mp4') -RunDirectory $runDirectory -Interval 0.5 -MaxFrames 20
pwsh -NoProfile -File "$skill\contact-sheet.ps1" -InputDirectory (Join-Path $runDirectory 'frames') -RunDirectory $runDirectory -Columns 4 -Interval 0.5 -CellWidth 640
```

The contact sheet defaults to `contact-sheet.png` in the parent run directory. It only accepts `frame-*.png` inputs, orders them numerically, normalizes each source into a centered black 16:9 cell derived from `CellWidth`, labels timestamps, and refuses to replace an existing output unless `-Overwrite` is supplied.

Fail closed: stop and report a clear error if FFmpeg is unavailable, the requested capture target is ambiguous or invalid, the frame input is empty, output already exists without `-Overwrite`, or the resulting image cannot be inspected. Do not infer visual success from logs alone.

## A/V evidence

For synchronized A/V, select a DirectShow audio source from the current machine and call `record-av.ps1`; it opens audio and video in one FFmpeg session. Inspect the capture with `inspect-media.ps1`, then render a waveform and generic onset, peak, silence-start, and silence-end events with `waveform.ps1`. Compare timestamps with `evaluate-sync.ps1`, whose offset is audio minus visual: positive is audio-late and negative is audio-early.

Each successful visual operation emits absolute `RUN_DIRECTORY`, `OUTPUT_PATH`, `KIND`, and `RESULT_JSON` records. Reuse the emitted run directory for related work and inspect `result.json`; do not invent a run path or overwrite an existing output without `-Overwrite`.

## Speech evidence

`analyze-speech.ps1` uses the isolated WhisperX environment when it is available and emits normalized language, segment, word, backend, and alignment provenance. `REQUIRES_BACKEND` is a conditional unavailable-backend state, not a successful transcript. Use forced alignment only when the transcript is already known.
