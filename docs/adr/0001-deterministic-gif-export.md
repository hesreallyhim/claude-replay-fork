# ADR-0001: Deterministic GIF export

- Status: Proposed — authoritative for this fork, pending upstream review
- Date: 2026-07-23
- Decision owners: claude-replay maintainers
- Companion delivery plan: [GIF export steel thread](../gif-export-steel-thread.md)

## Context

claude-replay renders edited AI-session transcripts as self-contained interactive HTML. Users also want a compact rendered artifact that can appear directly in a GitHub README. An optimized animated GIF is the most broadly embeddable first format.

The local editor already gathers the complete render configuration: edited and excluded turns, bookmarks, theme, labels, font size, redaction, timing, pacing, and playback speed. The player, however, is ordinary DOM and CSS driven by closure-local timers, animation frames, and interaction state. Browsers cannot directly encode arbitrary DOM as a clean GIF, and recording the existing wall-clock playback does not guarantee repeatable frame state.

The project must not add package dependencies to the transcript renderer, editor library, or browser page. Runtime tools may be invoked separately; in particular, a pinned Playwright invocation and a user-installed ffmpeg are acceptable.

## Decision

We will add optimized GIF export to the server-backed local editor and CLI. The target implementation will render every output frame from an absolute logical playback time rather than record incidental wall-clock execution.

The same transcript and render configuration must produce the same semantic frame state: visible turn, revealed block and word, progress, timer, disclosure state, and scroll position. Exact pixels may still vary across operating systems because the player deliberately uses the system font stack.

The public static editor is not part of the first implementation because it cannot invoke Playwright or ffmpeg. This is a deferred browser-runtime problem, not a permanent product exclusion.

## Player capture contract

The player will expose a versioned `window.__claudeReplayCapture` controller after `body[data-ready="1"]`:

```js
window.__claudeReplayCapture = {
  getMetadata(),
  configure(detailPolicies),
  renderAt(logicalTimeMs),
};
```

The controller will use a single playback timeline derived from prepared turns, timestamps or paced timing, paced-wording configuration, reading rate, visibility filters, and bookmarks. Live playback and export must consume the same stage durations.

`renderAt()` will be idempotent and order-independent. It will apply the exact DOM state for the requested time without accumulating timer or animation state. Capture mode will disable CSS transitions, animations, smooth scrolling, and user interaction, and will instantaneously anchor the active content above the controls.

Capture disclosure is configured independently for three content types:

- Thinking blocks
- Tool-call bodies, including grouped tools and their nested calls
- Long user, assistant, and tool-result content

Each policy supports `collapsed` or `active`. `active` opens content only while its playback stage is current and closes the previous detail before advancing. Turn bodies remain open; file sidebars, menus, and popovers remain closed. All policies default to `collapsed`.

The exported sequence includes a 750 ms splash hold and a 1,000 ms final-state hold. Configured playback speed scales content time but not those holds.

## Shared GIF exporter

A shipped Node module will accept already-rendered HTML, an output path, viewport, frame rate, disclosure policies, an abort signal, and a progress callback.

The exporter will:

1. Create a private temporary directory and unminified, uncompressed capture HTML.
2. Invoke an exact pinned Playwright version through `npm exec` or `npx` without adding it as a runtime package dependency.
3. Prefer an installed Playwright browser, then a system Chrome, Chromium, or Edge. It will never download a browser without an explicit user command.
4. Render each frame at an absolute logical time in a fixed viewport and device scale.
5. Use system ffmpeg to create a lossless intermediate and encode an optimized, infinitely looping, 128-color GIF with palette generation and palette use.
6. Kill child processes and remove temporary artifacts on success, failure, cancellation, or editor shutdown.

Process execution will use argument arrays rather than interpolated shell commands. Temporary HTML can contain sensitive transcript data, so its directory and files must be private and short-lived.

Initial capture validation will allow widths from 480 to 1600 pixels, heights from 300 to 1000 pixels, and frame rates from 5 to 20 FPS. Exports are limited to 120 seconds and 1,800 frames. Errors will instruct users to trim turns, increase playback speed, or reduce frame rate.

## Editor interface

The editor will add an **Export GIF** action and a capture-settings dialog. Defaults are 800×500 at 10 FPS with all disclosure policies collapsed.

Long-running export uses a local job API:

- `POST /api/gif-exports` starts an export and returns `202 { jobId }`.
- `GET /api/gif-exports/:id` returns phase, progress, duration, frame metadata, and any error.
- `GET /api/gif-exports/:id/download` returns the completed `image/gif` attachment.
- `DELETE /api/gif-exports/:id` cancels the export and cleans up.

Only one export runs per editor server. Completed downloads expire after ten minutes. Existing origin checks apply to the new routes, and download filenames are sanitized.

## CLI interface

CLI export will reuse the same transcript preparation, render options, capture controller, validation, and encoder:

```sh
claude-replay session.jsonl --gif -o demo.gif
```

The CLI will add:

- `--gif`
- `--gif-width`
- `--gif-height`
- `--gif-fps`
- `--gif-open-thinking`
- `--gif-open-tools`
- `--gif-expand-long`

GIF mode requires an output filename ending in `.gif`, writes progress to stderr, and supports Ctrl+C cancellation with exit code 130. It is incompatible with stdout, `--serve`, and `--watch`. Existing `--open` behavior applies to the completed artifact.

## Runtime requirements

ffmpeg and a compatible installed browser are user-provided. Playwright's JavaScript tooling may be fetched through an exact pinned npx invocation, but browser binaries are not installed automatically. Missing tools produce actionable preflight errors.

The current Docker image does not include ffmpeg or a browser. GIF export remains unavailable there unless those runtimes are installed or supplied separately.

## Consequences

### Positive

- Export reflects the same edited and redacted data as HTML preview and export.
- Absolute-time rendering makes state repeatable and testable without simulating user clicks.
- Browser and renderer packages retain zero runtime dependencies.
- One exporter serves the editor and CLI.
- The capture controller creates a stable seam for later MP4, WebM, or static-browser work.

### Negative

- A deterministic timeline and state applicator require meaningful player refactoring.
- GIF encoding is CPU and disk intensive, and GIF remains larger than modern video formats.
- npx execution introduces a supply-chain boundary that must be exact-pinned and documented.
- Cross-platform font rendering prevents byte-identical output across operating systems.

## Alternatives considered

### Record the existing player in real time

Playwright can record a browser context to WebM, and ffmpeg can convert it to GIF. This is already demonstrated by the repository's recording scripts and by the [Scry browser-recording recipe](https://github.com/athola/claude-night-market/blob/2e4e47daade39318d5d597da5f2345839719f909/plugins/scry/skills/browser-recording/SKILL.md). It is suitable for the initial steel thread, but wall-clock scheduling and interaction state do not meet the target determinism requirement.

### Use Playwright screencast

Playwright 1.59 introduced precise [`screencast.start()` and `screencast.stop()`](https://playwright.dev/docs/api/class-screencast). This can improve capture boundaries and emit JPEG frames, but those frames still follow wall-clock browser presentation rather than the replay's logical timeline.

### Use an external recording package

The investigated packages either add runtime dependencies, download browser or ffmpeg binaries, require a newer Node baseline, expose an MCP rather than one-shot CLI interface, or remain wall-clock recorders. None removes the claude-replay-specific work of defining playback completion and disclosure behavior.

### Capture entirely in the static browser page

`getDisplayMedia()` and `MediaRecorder` require user-mediated tab or screen selection, cannot reliably isolate the player DOM, and do not produce GIF. Canvas capture cannot render the existing DOM player without adding a DOM-to-canvas dependency. This path is deferred.

## Delivery strategy

This ADR defines the destination, not a single large implementation change. Delivery proceeds through independently reviewable milestones documented in the [steel-thread plan](../gif-export-steel-thread.md):

1. Fixed-profile editor GIF export using existing whole-section playback and collapsed disclosure.
2. Absolute-time deterministic capture behind the same exporter boundary.
3. Capture configuration and asynchronous job lifecycle.
4. CLI integration and subsequent format or browser-surface work.

Temporary steel-thread limitations are deliberate technical debt with named replacement seams. They do not narrow or supersede this decision.

## Acceptance criteria

- Editor and CLI GIFs use the canonical prepared and redacted render state.
- Repeated `renderAt()` calls at the same time produce identical DOM state and same-run screenshot bytes.
- Rendering times out of order produces the same result as rendering them sequentially.
- Thinking, tool, and long-content policies behave independently and only affect the active stage.
- Cancellation terminates every subprocess and removes temporary transcript data.
- GIF output has the requested dimensions and frame rate, loops, contains multiple frames, and respects duration and frame limits.
- Existing player, editor, renderer, CLI, packaging, and Node-version tests remain green.
- `npm pack --dry-run` confirms no new runtime dependency and includes every required exporter helper.
