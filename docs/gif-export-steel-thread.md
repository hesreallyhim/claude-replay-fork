# GIF export steel thread

This document defines the first reviewable implementation milestone for [ADR-0001: Deterministic GIF export](adr/0001-deterministic-gif-export.md). The ADR remains the authoritative architecture. This steel thread deliberately fixes several choices so the upstream maintainer can review a small vertical slice that proves the editor can render a replay to GIF.

## Milestone outcome

After configuring and editing a session in the localhost editor, a user clicks **Export GIF** and downloads a valid animated GIF of the replay.

The milestone is semantically repeatable: the same editor state yields the same content, ordering, theme, disclosure policy, and playback flow. It is not yet frame- or byte-deterministic because it records the existing wall-clock player. Absolute-time rendering replaces this capture backend in the next phase without changing the editor/exporter seam.

## Fixed assumptions

- Local editor only; no CLI or static hosted-editor export yet.
- GIF only; no MP4, WebM, audio, or format selection.
- Fixed 800×500 viewport, 10 FPS, 128 colors, silent infinite loop.
- Whole-section playback only. Paced-wording is forced off; the selected timing source and playback speed remain honored.
- One disclosure policy: collapsed.
  - Existing Show Thinking and Show Tool Calls settings still determine whether those blocks appear.
  - Thinking bodies, tool bodies, grouped tools, and long-text expansions are never opened during capture.
- Fixed 800 ms splash and final-state holds.
- Maximum capture time of 120 seconds.
- One active export per editor server.
- No settings dialog, job queue, polling, progress percentage, resumability, or cancellation button.

These are milestone constraints, not product-scope decisions. The ADR's deterministic capture, disclosure policies, configurable output, asynchronous jobs, and CLI remain planned follow-on work.

## Existing seams to reuse

The editor server already has canonical helpers that filter, clone, re-index, time, redact, and render the current working session. GIF export must call the same preparation and render-option paths as preview and HTML export rather than capture the currently interacted preview iframe.

The editor client already gathers every current option and has a fetch-to-Blob download pattern. The steel thread adds a sibling button and handler rather than a new configuration model.

The player already exposes `body[data-ready="1"]`. Its initial markup also provides the required disclosure policy: long prose starts collapsed, and thinking, tool, and tool-group bodies have no `open` class.

The PNG-frame and palette-optimized ffmpeg pipeline in [`scripts/record-demo.mjs`](../scripts/record-demo.mjs) is the primary implementation precedent.

## Minimal player change

Add an explicit terminal playback marker rather than coupling export to the play button's presentation classes:

- Clear `body.dataset.playbackComplete` whenever playback starts.
- Set `body.dataset.playbackComplete = "1"` only in the natural end-of-replay branch.
- Do not set it when the user pauses, navigates, expands content, or an error stops playback.

The capture runner waits for `body[data-playback-complete="1"]`. No timeline, time-seek API, postMessage protocol, or capture controller is added in this milestone.

## Capture runner

Add a small shipped `src/gif-exporter.mjs` behind this provisional interface:

```js
await exportGif({ html, signal });
```

The exporter will:

1. Create a private temporary HTML file and frame directory.
2. Invoke an exact pinned Playwright version through `npm exec` without adding a package dependency.
3. Prefer system Chrome and fail with installation guidance rather than downloading a browser.
4. Open the temporary replay at 800×500 and wait for readiness.
5. Capture eight splash frames, start playback, and capture on a monotonic 100 ms schedule until the completion marker appears.
6. Duplicate the previous PNG for any missed schedule slot so a slow screenshot does not shorten the final GIF.
7. Capture eight final-state frames.
8. Invoke system ffmpeg with argument arrays and the existing 10 FPS, 800-pixel, Lanczos, palette-generation, and palette-use recipe.
9. Close the browser and remove all temporary files on every exit path.

The runtime Playwright bootstrap must be isolated in the capture runner and covered by an `npm pack` smoke test. Plain package-name imports are insufficient when Playwright was supplied only through `npm exec`; the helper must resolve the transient package deliberately. No other module should know about that packaging detail.

## Editor server and UI

Add provisional synchronous `POST /api/export-gif` with the existing request shape:

```json
{
  "sessionId": "s1",
  "options": {}
}
```

The route will prepare and render the session with current editor options, override paced-wording off, and pass the capture HTML to the exporter. It returns `image/gif` with a sanitized attachment filename.

An in-memory guard rejects a concurrent export with `409`. A 120-second timeout aborts the subprocess tree. Request closure is connected to an `AbortController`, so navigating away or abandoning the fetch cancels capture and cleanup.

The editor adds one **Export GIF** button beside HTML export. During the request it is disabled and reads **Exporting…**. Success downloads the returned Blob; failure displays the server's actionable error. There is no modal or additional setting.

## Error behavior

Errors must distinguish:

- Empty transcript after filtering
- ffmpeg missing from `PATH`
- npm/npx unavailable
- Playwright runtime invocation failure
- Compatible browser unavailable
- Capture timeout
- Browser or player failure before completion
- ffmpeg conversion failure
- Aborted request

Every error clears the single-export guard and removes private transcript and frame artifacts.

## Tests and acceptance

### Player

- The completion marker is absent or cleared at playback start.
- It is set only on natural completion.
- Pause, navigation, and disclosure clicks do not mark completion.

### Exporter and server

- Runtime commands use argument arrays and validated private paths.
- Missing-tool, timeout, and abort paths kill children and clean temporary files.
- A concurrent request receives `409`.
- A tiny fixture produces an `image/gif` attachment with a sanitized filename.
- The GIF is 800×500, loops, and contains multiple frames.
- Theme, exclusions, redaction, visibility toggles, timing, and speed are visible in the result.
- Thinking, tool, group, and long-text details remain collapsed.

### Editor

- The button is disabled until a session is loaded.
- Export shows and clears the busy state.
- A successful response downloads `.gif`.
- A server failure produces an intelligible error.

### Packaging

- Unit and editor/player E2E suites remain green on supported Node versions.
- A packed tarball includes the exporter and can complete a smoke export without package-local development dependencies.
- `package.json` gains no runtime dependency.

## Suggested commits

1. `docs(adr): record deterministic GIF export architecture`
2. `feat(player): expose playback completion state`
3. `feat(editor): add fixed-profile GIF exporter`
4. `feat(editor): add export GIF action`

The first commit contains this document and the ADR only. Each later commit should be independently testable and should avoid unrelated refactoring.

## Prior-art research and fallback spikes

### Scry browser recording

The investigated [Scry browser-recording skill](https://github.com/athola/claude-night-market/blob/2e4e47daade39318d5d597da5f2345839719f909/plugins/scry/skills/browser-recording/SKILL.md) is an MIT-licensed set of instructions, not an importable pipeline. It recommends a Playwright spec with video enabled, retrieves WebM, and invokes a separate ffmpeg GIF recipe. It corroborates this project's Playwright-plus-ffmpeg approach but cannot be plugged in directly.

### Fallback 1: Playwright `recordVideo`

If the monotonic PNG loop or transient Playwright bootstrap proves too costly, the first fallback spike uses the project's existing Playwright version and [`recordVideo`](https://playwright.dev/docs/videos) to create WebM, followed by the same system-ffmpeg GIF conversion.

Run the spike only if the packed-package smoke test fails or three repeated PNG captures differ from expected wall-clock duration by more than five percent. Accept setup and teardown footage only if it can be trimmed reliably without session-specific heuristics.

### Fallback 2: Playwright `screencast`

If `recordVideo` works but capture boundaries are unacceptable, update the existing Playwright development/runtime pin to a stable version at or above 1.59 and test [`page.screencast.start()` and `stop()`](https://playwright.dev/docs/api/class-screencast). This gives precise recording boundaries and optional JPEG frame callbacks, but remains wall-clock capture and therefore does not replace the ADR's logical-time renderer.

Do not adopt the young `@playwright/cli` 0.x interface as the production contract merely to access screencast. Do not adopt Pagecast or recorder wrapper packages: they add MCP/application dependencies, browser downloads, newer Node requirements, or young supply-chain surfaces without solving deterministic replay state.

## Graduation path

1. Replace wall-clock capture with the ADR's absolute-time timeline and `renderAt()` controller while retaining fixed output settings.
2. Add independent `collapsed|active` policies for thinking, tools, and long content plus dimensions and FPS controls.
3. Replace the synchronous endpoint with start, status, download, and cancel job routes.
4. Reuse the shared exporter from the CLI.
5. Evaluate additional formats and browser surfaces after deterministic GIF export is stable.

Each phase adds capability; none changes the authoritative decision or treats steel-thread constraints as permanent scope reductions.
