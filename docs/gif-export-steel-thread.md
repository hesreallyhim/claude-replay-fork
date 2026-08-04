# GIF export steel thread

This document defines the first reviewable implementation milestone for the draft [ADR-0001: GIF export architecture](adr/0001-deterministic-gif-export.md). The ADR is exploratory rather than authoritative: this steel thread is intended to produce evidence about whether wall-clock capture is sufficient before the project considers a deterministic-timeline refactor.

## Milestone outcome

After configuring and editing a session in the localhost editor, a user clicks **Export GIF** and downloads a valid animated GIF of the replay.

The milestone is semantically repeatable: a fresh player rendered from the same editor state yields the same content, ordering, theme, collapsed disclosure policy, playback flow, and explicit completion boundary. It is not frame-, timing-, pixel-, or byte-deterministic because it records the existing wall-clock player.

Absolute-time rendering is a contingent replacement backend, not an assumed next phase. It will be considered only if repeated steel-thread exports reveal material drift, unreliable boundaries, divergent semantic state, or another user-visible shortcoming that cannot be addressed locally.

## Fixed assumptions

- Local editor only; no CLI or static hosted-editor export yet.
- GIF only; no MP4, WebM, audio, or format selection.
- Fixed 800×500 viewport, 10 FPS, 128 colors, silent infinite loop.
- Whole-section playback only. Paced wording is forced off; the selected timing source and playback speed remain honored.
- One disclosure policy: collapsed.
  - Existing Show Thinking and Show Tool Calls settings still determine whether those blocks appear.
  - Thinking bodies, tool bodies, grouped tools, and long-text expansions are never opened during capture.
- Exactly 800 ms of splash footage and exactly 800 ms of exporter-owned final-state footage.
- The player completion marker is emitted when the final turn's content finishes, before the ordinary interactive-player final dwell. The exporter does not record that dwell in addition to its own hold.
- Maximum capture time of 120 seconds.
- One active export per editor server.
- No settings dialog, job queue, polling, progress percentage, resumability, or cancellation button.

These constraints keep the first contribution reviewable. Configurable output, player-owned auto-expansion, asynchronous jobs, CLI integration, and a possible absolute-time backend remain separate decisions informed by the shipped slice.

## Existing seams to reuse

The editor server already has canonical helpers that filter, clone, re-index, time, redact, and render the current working session. GIF export must call the same preparation and render-option paths as preview and HTML export rather than capture the currently interacted preview iframe.

The editor client already gathers every current option and has a fetch-to-Blob download pattern. The steel thread adds a sibling button and handler rather than a new configuration model.

The player already exposes `body[data-ready="1"]`. Its initial markup also provides the required disclosure policy: long prose starts collapsed, and thinking, tool, and tool-group bodies have no `open` class.

The PNG-frame and palette-optimized ffmpeg pipeline in [`scripts/record-demo.mjs`](../scripts/record-demo.mjs) is the primary implementation precedent.

## Player behavior and artifact boundaries

The player owns playback state and disclosure transitions. The editor supplies a render-time playback configuration; the capture runner observes the configured player rather than clicking controls or implementing a second state machine.

That ownership is distinct from artifact interactivity. A rendered HTML player retains its normal controls and disclosure affordances. During capture, a fresh player runs with frozen options and input suppressed. The resulting GIF contains only encoded pixels and cannot expose or preserve interactive affordances.

The steel thread does not add an auto-expansion mode. Its fixed player configuration leaves every included disclosure collapsed. A future `active` policy should be implemented in the player engine so normal playback and export can share the same transitions. Exposing that policy as a viewer-facing control in interactive HTML is a separate product choice.

## Minimal player change

Add an explicit final-content marker rather than coupling export to the play button's presentation classes:

- Clear `body.dataset.playbackComplete` whenever playback starts.
- Set `body.dataset.playbackComplete = "1"` when the final turn's content has finished revealing naturally, before the player's ordinary final-turn dwell.
- Let normal interactive playback continue through its existing dwell and terminal behavior after setting the marker.
- Do not set the marker when the user pauses, navigates, expands content, or an error stops playback.

The capture runner waits for `body[data-playback-complete="1"]`, then appends exactly eight final-state frames at 10 FPS. It does not wait for the player's later terminal branch. No timeline, time-seek API, `postMessage` protocol, or capture controller is added in this milestone.

## Capture runner

Add a small shipped `src/gif-exporter.mjs` behind this provisional interface:

```js
await exportGif({ html, signal });
```

The exporter will:

1. Create a private temporary HTML file and frame directory.
2. Resolve Playwright from the invoking project's local dependency tree. It never invokes `npm exec`, `npx`, or another transient installer.
3. Launch a compatible user-installed Playwright browser or supported system Chrome/Chromium browser and fail with installation guidance rather than download one.
4. Open the temporary replay at 800×500 and wait for readiness.
5. Capture exactly eight splash frames, start playback, and capture on a monotonic 100 ms schedule until the final-content marker appears.
6. Duplicate the previous PNG for any missed schedule slot so a slow screenshot does not shorten the captured playback.
7. Append exactly eight final-state frames without waiting for the player's ordinary final dwell.
8. Invoke system ffmpeg with argument arrays and the existing 10 FPS, 800-pixel, Lanczos, palette-generation, and palette-use recipe.
9. Close the browser and remove all temporary files on every exit path.

The first supported Playwright contract is a project-local installation in the project invoking claude-replay:

```sh
npm install --save-dev playwright
```

The capture runner owns Playwright resolution and diagnostics; no other module should know where the optional package was found. The runner does not initially search arbitrary global package-manager layouts. Playwright, a compatible browser, and ffmpeg are all user-provided opt-in prerequisites and are preflighted before capture begins.

## Editor server and UI

Add provisional synchronous `POST /api/export-gif` with the existing request shape:

```json
{
  "sessionId": "s1",
  "options": {}
}
```

The route prepares and renders the session with current editor options, overrides paced wording off, freezes the collapsed disclosure configuration, and passes the capture HTML to the exporter. It returns `image/gif` with a sanitized attachment filename.

An in-memory guard rejects a concurrent export with `409`. A 120-second timeout aborts the browser and encoder processes. Request closure is connected to an `AbortController`, so navigating away or abandoning the fetch cancels capture and cleanup.

The editor adds one **Export GIF** button beside HTML export. During the request it is disabled and reads **Exporting…**. Success downloads the returned Blob; failure displays the server's actionable error. There is no modal or additional setting.

## Error behavior

Errors must distinguish:

- Empty transcript after filtering
- ffmpeg missing from `PATH`
- Playwright absent from the invoking project's dependency tree
- Playwright import or launch failure
- Compatible browser unavailable
- Capture timeout
- Browser or player failure before completion
- ffmpeg conversion failure
- Aborted request

Every error clears the single-export guard and removes private transcript and frame artifacts. Missing-prerequisite messages must say that the exporter does not install packages or browsers automatically and provide an appropriate installation command or remediation path.

## Tests and acceptance

### Player

- The completion marker is absent or cleared at playback start.
- It is set at natural final-content completion before the ordinary interactive final dwell.
- Normal HTML playback still completes its existing dwell and terminal behavior.
- Pause, navigation, and disclosure clicks do not mark completion.

### Exporter and server

- Runtime commands use argument arrays and validated private paths.
- Playwright is resolved from a fixture consumer project's local installation, with no transient installation or browser download.
- Missing-tool, timeout, and abort paths kill children and clean temporary files.
- A concurrent request receives `409`.
- A tiny fixture produces an `image/gif` attachment with a sanitized filename.
- The GIF is 800×500 at 10 FPS, loops, contains multiple frames, and has exactly eight splash frames and eight exporter-owned final-state frames.
- Capture stops at the final-content marker rather than including the player's ordinary final dwell.
- Theme, exclusions, redaction, visibility toggles, timing, and speed are reflected in the result.
- Thinking, tool, group, and long-text details remain collapsed.

### Editor

- The button is disabled until a session is loaded.
- Export shows and clears the busy state.
- A successful response downloads `.gif`.
- A server failure produces an intelligible error.

### Packaging

- Unit and editor/player end-to-end suites remain green on supported Node versions.
- A packed tarball includes the exporter and can complete a smoke export when its consumer project provides Playwright and the host provides a compatible browser and ffmpeg.
- `package.json` gains no runtime dependency.

## Suggested commits

1. `docs(adr): clarify draft GIF export direction`
2. `feat(player): expose final-content completion state`
3. `feat(editor): add fixed-profile GIF exporter`
4. `feat(editor): add export GIF action`

The first commit contains this document and the ADR only. Each later commit should be independently testable and should avoid unrelated refactoring.

## Prior-art research and fallback spikes

### Scry browser recording

The investigated [Scry browser-recording skill](https://github.com/athola/claude-night-market/blob/2e4e47daade39318d5d597da5f2345839719f909/plugins/scry/skills/browser-recording/SKILL.md) is an MIT-licensed set of instructions, not an importable pipeline. It recommends a Playwright spec with video enabled, retrieves WebM, and invokes a separate ffmpeg GIF recipe. It corroborates this project's Playwright-plus-ffmpeg approach but cannot be plugged in directly.

### Fallback 1: Playwright `recordVideo`

If the monotonic PNG loop proves too costly, the first fallback spike uses the user-installed Playwright package and [`recordVideo`](https://playwright.dev/docs/videos) to create WebM, followed by the same system-ffmpeg GIF conversion.

Run the spike only if the packed-package smoke test fails or repeated PNG captures differ from expected wall-clock duration by more than five percent. Accept setup and teardown footage only if it can be trimmed reliably without session-specific heuristics.

### Fallback 2: Playwright `screencast`

If `recordVideo` works but capture boundaries are unacceptable, test [`page.screencast.start()` and `stop()`](https://playwright.dev/docs/api/class-screencast) with a compatible user-installed Playwright version. This gives precise recording boundaries and optional JPEG frame callbacks, but remains wall-clock capture.

Do not adopt the young `@playwright/cli` 0.x interface merely to access screencast. Do not adopt Pagecast or recorder wrapper packages: they add MCP/application dependencies, browser downloads, newer Node requirements, or young supply-chain surfaces without solving replay-specific state.

## Evaluation and graduation path

1. Ship the fixed-profile wall-clock steel thread and exercise it on representative sessions.
2. Measure repeated exports for natural-completion reliability, semantic state, missed frame slots, and duration drift.
3. Keep wall-clock capture if it satisfies the use case. Implement the draft ADR's absolute-time controller only if observed failures justify the refactor.
4. Add player-owned disclosure policies and decide separately whether interactive HTML exposes viewer-facing policy controls. Export continues to record a frozen, noninteractive execution of those policies.
5. Add dimensions and FPS controls, then replace the synchronous endpoint with start, status, download, and cancel job routes if export duration warrants it.
6. Reuse the shared exporter from the CLI, selecting GIF mode from `-o demo.gif` rather than a `--gif` flag.
7. Evaluate additional formats and browser surfaces after the initial workflow is stable.

Each phase is subject to evidence and review. The exporter seam and player-owned behavior preserve the option to change capture backends without treating any unshipped architecture as authoritative.
