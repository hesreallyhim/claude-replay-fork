# ADR-0001: GIF export architecture

- Status: Draft — exploratory direction pending steel-thread evidence and upstream review
- Date: 2026-07-23
- Decision owners: claude-replay maintainers
- Companion delivery plan: [GIF export steel thread](../gif-export-steel-thread.md)

## Context

claude-replay renders edited AI-session transcripts as self-contained interactive HTML. Users also want a compact rendered artifact that can appear directly in a GitHub README. An optimized animated GIF is the most broadly embeddable first format.

The local editor already gathers the complete render configuration: edited and excluded turns, bookmarks, theme, labels, font size, redaction, timing, pacing, and playback speed. The player is ordinary DOM and CSS driven by closure-local timers, animation frames, and interaction state. Browsers cannot directly encode arbitrary DOM as a clean GIF, so export requires a browser capture layer and an encoder.

The first question is whether repeatability must mean identical state at every absolute logical time, or whether a fresh player executing the same configuration is sufficiently repeatable for the practical use case. The latter is substantially smaller and can be evaluated before committing the project to a deterministic-timeline refactor.

The project must not add package dependencies to the transcript renderer, editor library, or browser page for this opt-in feature. Playwright and ffmpeg can instead be explicit user-installed prerequisites with actionable preflight errors.

## Draft direction

The proposed first implementation adds optimized GIF export to the server-backed local editor by capturing the existing player in wall-clock time. It targets **semantic repeatability**: the same prepared transcript and frozen render configuration produce the same content, ordering, theme, playback flow, disclosure policy, and completion boundary. It does not promise frame-, timing-, pixel-, or byte-identical output between runs.

Every export renders a fresh player from canonical prepared editor state. It does not record the currently interacted preview. Paced wording is disabled for the fixed steel-thread profile, while the selected timing source and playback speed remain in effect.

An absolute-time `renderAt()` controller remains a candidate architecture, not a ratified next phase. It should be introduced only if evidence from the steel thread shows that wall-clock capture causes material drift, unreliable boundaries, irreproducible semantic state, or other user-visible failures that cannot be corrected locally.

The public static editor is not part of the first implementation because it cannot invoke Playwright or ffmpeg. This is a deferred browser-runtime problem, not a permanent product exclusion.

## Player and artifact contracts

Playback behavior belongs to the player engine. The editor or future CLI chooses and serializes a playback configuration, and the player applies that configuration while rendering the transcript. Export automation must not reproduce player state by clicking disclosure controls or maintaining a parallel model of the active block.

The shared engine does not imply that HTML and video have the same interaction contract:

- A rendered HTML player remains interactive. Its viewer can pause, navigate, and use the disclosure affordances that the HTML artifact exposes.
- An export runner loads a fresh player with a frozen configuration, suppresses input during capture, and records its configured execution.
- A GIF or video contains only the resulting pixels. Disclosure and timing choices have already been resolved and provide no post-export affordances.

The steel thread uses the player's existing collapsed state. Thinking bodies, tool bodies, grouped tools, and long-content expansions remain closed throughout capture. A future `active` auto-expansion policy, if adopted, should be a player configuration usable by ordinary playback and capture rather than export-only DOM automation. Whether an HTML artifact also exposes a runtime control for that policy is a separate product decision.

For wall-clock capture, the player exposes explicit readiness and completion boundaries in its DOM. `body[data-ready="1"]` means the page can be captured. `body[data-playback-complete="1"]` means the final turn's content has finished revealing naturally. The completion marker is set before the ordinary interactive player's final dwell so the exporter can append exactly its own 800 ms final-state hold without also recording that dwell. Pauses, navigation, disclosure interaction, and errors do not mark playback complete.

## Shared GIF exporter

The steel-thread Node module accepts already-rendered HTML and an abort signal behind a deliberately narrow interface:

```js
await exportGif({ html, signal });
```

The exporter will:

1. Create private temporary HTML and frame storage.
2. Resolve a user-installed Playwright package from the invoking project's dependency tree.
3. Launch a compatible user-installed browser without downloading one.
4. Capture the existing player on a monotonic wall-clock schedule in a fixed viewport and device scale.
5. Use system ffmpeg to encode an optimized, infinitely looping GIF with palette generation and palette use.
6. Kill child processes and remove temporary artifacts on success, failure, cancellation, or editor shutdown.

The first supported Playwright contract is a project-local installation in the project invoking claude-replay, for example:

```sh
npm install --save-dev playwright
```

The exporter will not use `npm exec`, `npx`, or any other transient-install mechanism, and it will not search arbitrary global package-manager layouts in the initial implementation. A compatible Playwright-managed browser or supported system Chrome/Chromium installation must also be available. Missing Playwright, browser, or ffmpeg capabilities produce distinct preflight errors with installation guidance.

Process execution uses argument arrays rather than interpolated shell commands. Temporary HTML can contain sensitive transcript data, so its directory and files must be private and short-lived.

The fixed steel-thread profile is 800×500 pixels at 10 FPS, 128 colors, a silent infinite loop, an exact 800 ms splash hold, and an exact 800 ms exporter-owned final-state hold. Capture is limited to 120 seconds. Configurable dimensions, frame rates, policies, and duration limits are follow-on interface work rather than requirements of the first slice.

## Editor interface

The steel thread adds an **Export GIF** action to the local editor and a provisional synchronous `POST /api/export-gif` route. Only one export runs per editor server. Closing the request, reaching the timeout, or shutting down the editor aborts capture and cleanup.

A later iteration may replace the synchronous route with a local job API for progress, download expiry, and cancellation. A likely shape is:

- `POST /api/gif-exports` starts an export and returns a job identifier.
- `GET /api/gif-exports/:id` returns phase, progress, duration, frame metadata, and any error.
- `GET /api/gif-exports/:id/download` returns the completed artifact.
- `DELETE /api/gif-exports/:id` cancels the export and cleans up.

This job interface and a capture-settings dialog are not part of the steel thread and remain subject to evidence and review.

## CLI interface

Future CLI export should infer the format from the output extension rather than require a redundant mode flag:

```sh
claude-replay session.jsonl -o demo.gif
```

An output name ending in `.gif` activates GIF export; there is no `--gif` flag. Other output extensions retain their existing behavior. GIF-specific settings may be added later, but they are valid only for GIF output.

Extension-based selection means GIF export cannot initially write to stdout, where there is no filename from which to infer the format. If binary stdout becomes a real requirement, a general `--format gif` option can be considered separately. GIF mode is also incompatible with `--serve` and `--watch`, writes progress and errors to stderr, supports Ctrl+C cancellation with exit code 130, and applies existing `--open` behavior to the completed artifact.

The CLI reuses the same transcript preparation, render options, player behavior, capture boundary, and encoder as the editor. CLI integration is not part of the first steel-thread implementation.

## Runtime requirements

Playwright, a compatible browser, and ffmpeg are user-provided prerequisites. The initial Playwright resolution contract is a project-local package installed in the invoking project. The exporter never installs packages or browser binaries automatically.

The current Docker image does not include these tools. GIF export remains unavailable there unless the runtimes are installed or supplied separately.

## Consequences

### Positive

- Export reflects the same edited and redacted data as HTML preview and export.
- The steel thread is small enough to test the actual value and reliability of GIF export before a large player refactor.
- Browser and renderer packages retain zero runtime dependencies.
- One exporter boundary can serve the editor and future CLI.
- Player-owned playback and disclosure behavior prevents export automation from diverging from rendered HTML behavior.
- Explicit user-installed prerequisites avoid transient package-install and supply-chain behavior during export.

### Negative

- Wall-clock capture cannot promise frame- or byte-deterministic results and may expose scheduler-dependent duration drift.
- Users must install and maintain Playwright, a browser, and ffmpeg for an opt-in feature.
- GIF encoding is CPU and disk intensive, and GIF remains larger than modern video formats.
- Cross-platform font rendering prevents byte-identical output across operating systems even if logical-time rendering is later adopted.
- A future deterministic timeline remains a meaningful player refactor if evidence shows it is necessary.

## Candidate deterministic backend

If steel-thread evidence demonstrates that semantic repeatability is insufficient, a replacement capture backend may expose a versioned controller after `body[data-ready="1"]`:

```js
window.__claudeReplayCapture = {
  getMetadata(),
  configure(detailPolicies),
  renderAt(logicalTimeMs),
};
```

In that candidate design, live playback and export consume one timeline derived from prepared turns, timestamps or paced timing, reading rate, visibility filters, and bookmarks. `renderAt()` applies exact DOM state for an absolute time without accumulating timer or animation state, and capture mode disables transitions, animations, smooth scrolling, and input.

Any future disclosure policies remain player-owned. Independent thinking, tool, and long-content policies could support `collapsed` or `active`, where `active` opens content only while its playback stage is current and closes the previous detail before advancing.

This controller is intentionally not an acceptance criterion for the steel thread. Before adopting it, the project should document failures observed in repeated wall-clock exports and show why a narrower correction cannot meet the use case.

## Alternatives considered

### Implement absolute-time rendering before shipping

An idempotent, order-independent `renderAt()` controller could make state directly testable and avoid wall-clock browser scheduling. It also requires a significant player timeline and state-applicator refactor before users can evaluate the feature. This draft defers that cost until capture evidence demonstrates a need.

### Use Playwright video recording

Playwright can record a browser context to WebM, and ffmpeg can convert it to GIF. This is demonstrated by the repository's recording scripts and by the [Scry browser-recording recipe](https://github.com/athola/claude-night-market/blob/2e4e47daade39318d5d597da5f2345839719f909/plugins/scry/skills/browser-recording/SKILL.md). It remains a viable fallback if scheduled PNG capture proves too costly, but its frame cadence and setup boundaries are browser-controlled.

### Use Playwright screencast

Playwright 1.59 introduced precise [`screencast.start()` and `screencast.stop()`](https://playwright.dev/docs/api/class-screencast). This can improve capture boundaries and emit JPEG frames, but those frames still follow wall-clock browser presentation. It is a wall-clock implementation option rather than a deterministic-timeline substitute.

### Use an external recording package

The investigated packages either add runtime dependencies, download browser or ffmpeg binaries, require a newer Node baseline, expose an MCP rather than a one-shot CLI interface, or remain wall-clock recorders. None removes the claude-replay-specific work of defining playback completion and disclosure behavior.

### Capture entirely in the static browser page

`getDisplayMedia()` and `MediaRecorder` require user-mediated tab or screen selection, cannot reliably isolate the player DOM, and do not produce GIF. Canvas capture cannot render the existing DOM player without adding a DOM-to-canvas dependency. This path is deferred.

## Delivery and evaluation strategy

This draft records a direction and replacement seams rather than a ratified destination. Delivery proceeds through independently reviewable milestones documented in the [steel-thread plan](../gif-export-steel-thread.md):

1. Ship fixed-profile editor GIF export using existing whole-section, wall-clock playback and collapsed disclosure.
2. Measure repeated exports for completion reliability, semantic state, missed capture slots, and duration drift.
3. Retain wall-clock capture if it is sufficient; introduce an absolute-time backend only if the evidence justifies its complexity.
4. Add player-owned disclosure policies, capture configuration, asynchronous jobs, and extension-selected CLI export as separately reviewable capabilities.
5. Evaluate additional formats and browser surfaces after the initial workflow is stable.

The narrow exporter boundary and explicit player completion marker keep these choices reversible without precommitting the project to the candidate deterministic controller.

## Steel-thread acceptance criteria

- Editor GIFs use the canonical prepared and redacted render state rather than the interacted preview.
- Repeated exports preserve the same semantic content, ordering, disclosure policy, and playback boundaries; frame and byte identity are not required.
- The player marks final-content completion before its ordinary interactive final dwell, and the exporter appends exactly 800 ms of final-state footage.
- Thinking, tool, grouped-tool, and long-content details remain collapsed in the fixed profile.
- Playwright is resolved from the invoking project's local installation; no package or browser is installed during export.
- Missing Playwright, browser, and ffmpeg capabilities produce distinct actionable errors.
- Abort and failure paths terminate spawned processes and remove temporary transcript data.
- GIF output is 800×500 at 10 FPS, loops, contains multiple frames, and respects the 120-second limit.
- Existing player, editor, renderer, CLI, packaging, and supported-Node tests remain green.
- `npm pack --dry-run` confirms no new runtime dependency and includes every required exporter helper.
