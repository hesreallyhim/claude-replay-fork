# Export an animated GIF

The localhost editor can render a configured replay as an animated GIF suitable for a README, issue, or other document that cannot embed the interactive HTML player. GIF export is an optional feature: ordinary editing, previewing, and HTML export do not require Playwright, a browser, or ffmpeg.

> **Current scope:** This is the first, deliberately narrow implementation. GIF export is available from the localhost editor only. It uses one fixed output profile and one disclosure policy. The [draft architecture decision record](adr/0001-deterministic-gif-export.md) describes possible later phases; the [steel-thread plan](gif-export-steel-thread.md) records the constraints of this milestone.

## Quick start

Install Playwright in the project or workspace from which you will launch `claude-replay`:

```bash
npm install --save-dev playwright
```

Make sure either a supported system Chrome, Chromium, or Edge browser is installed, or install Playwright's Chromium browser:

```bash
npx playwright install chromium
```

Install ffmpeg using your operating system's package manager, then confirm that it is on `PATH`:

```bash
ffmpeg -version
```

Launch the editor from the directory that provides Playwright, optionally opening a session immediately:

```bash
claude-replay editor [file-or-session-id]
```

In the editor:

1. Load and edit the session.
2. Configure the replay's theme, speed, timing, visible content, redaction, labels, and other options.
3. Select **Export GIF**.
4. Keep the editor server running while the button reads **Exporting…**. The browser downloads the completed GIF when rendering finishes.

When the download begins, the editor derives the filename from the current title field. Characters other than ASCII letters, numbers, underscores, and hyphens are replaced with underscores.

## Where Playwright must be installed

The exporter resolves the `playwright` package through the Node module tree of the directory where `claude-replay` was launched. This works when `claude-replay` itself is installed globally but Playwright is installed in the current project:

```bash
cd /path/to/my-project
npm install --save-dev playwright
claude-replay editor
```

Playwright does not have to become a dependency of the application whose session is being replayed. To keep it separate, install Playwright in a dedicated tooling workspace and launch the editor there, passing the session path or ID to `claude-replay editor`.

The exporter does not currently search standalone global package-manager installation directories. A globally installed Playwright package will therefore not be found merely because its command is available on `PATH`. From the intended launch directory, this command checks the same basic Node resolution requirement:

```bash
node -e "console.log(require.resolve('playwright'))"
```

This resolution rule is a limitation of the steel-thread implementation, not a requirement of the broader design. The exporter never runs `npm install`, `npm exec`, or `npx` on the user's behalf.

## Browser and ffmpeg prerequisites

Playwright is the browser automation library; Chromium is a separate browser executable. Installing the Playwright package supplies the JavaScript API but does not guarantee that a compatible browser executable is present.

The exporter first asks Playwright to launch its managed Chromium browser. If that executable is unavailable, it tries common system installations of Chrome, Chromium, and Edge. On macOS, this includes both `/Applications` and the current user's `~/Applications` directory. Installing a Playwright-managed browser with `npx playwright install chromium` is the most portable fallback.

ffmpeg is a separate executable used to turn the captured PNG frames into a palette-optimized animated GIF. It must be executable through the editor server's `PATH`; it is not supplied by Playwright or `claude-replay`.

All three capabilities are checked only when GIF export is requested:

- the `playwright` Node package;
- a compatible browser executable; and
- the `ffmpeg` executable.

Missing capabilities produce distinct error messages with the relevant installation guidance. No package or browser installation occurs during export.

## What the GIF captures

Each export renders a fresh, self-contained replay from the editor's current server-side session state. It honors completed edits and exclusions as well as the applicable theme, font size, playback speed, timing selection, thinking and tool-call visibility, redaction, labels, title, and bookmarks. If you have just finished typing an edited user prompt, pause briefly for the editor's short synchronization delay before selecting **Export GIF**.

The exporter does not screen-record the editor UI or reuse the currently interacted-with preview. Expanding a thinking block or tool call in the live HTML preview therefore does not carry that transient interaction into the GIF. The fresh capture starts disclosure controls in the player's default collapsed state and disables pointer interaction while recording. This makes the exported sequence semantically repeatable and avoids an accidental click or hover changing the result.

Ordinary self-contained HTML exports remain interactive. The GIF is a sequence of pixels and cannot preserve controls, links, expandable sections, selectable text, or other HTML affordances.

The current capture applies two deliberate overrides:

- paced word-by-word revealing is disabled, even when paced timing is selected; and
- disclosures use the single default-collapsed policy described above.

The **Show Thinking** and **Show Tool Calls** choices determine whether those blocks are visible in the captured pixels. Hiding a block is not redaction: its data remains in the temporary rendered HTML during capture. Use turn exclusions, text edits, and redaction rules when content must be removed before rendering.

Description and Open Graph image fields are HTML metadata and do not affect captured pixels. The HTML serialization choices used internally for capture—minification and transcript compression—are also fixed by the exporter and do not affect the GIF. Reading WPM has no effect because paced word-by-word revealing is disabled.

## Fixed output profile

The steel-thread exporter uses a fixed profile with no additional settings:

| Property | Value |
|---|---:|
| Canvas | 800 × 500 pixels |
| Frame rate | 10 frames per second |
| Palette | Up to 128 colors |
| Looping | Infinite |
| Audio | None |
| Opening splash hold | 800 ms |
| Final-state hold | 800 ms |
| Server-side exporter timeout | 120 seconds |

Capture follows wall-clock playback. The fixed capture policy provides semantic repeatability, but the implementation does not promise byte-for-byte identical GIFs across machines or runs. Browser rendering speed and screenshot scheduling can change where duplicate frames are inserted without changing the intended replay sequence.

GIF size grows with duration and visual change. For a smaller README asset, exclude unneeded turns, hide verbose content, or increase playback speed before exporting.

## Current limitations

- GIF export is available only in the server-backed localhost editor. The hosted static editor has no process in which to invoke Playwright and ffmpeg.
- Direct CLI GIF output is not implemented yet. Do not run `claude-replay session.jsonl -o demo.gif`: the current CLI does not inspect that extension and will write HTML bytes to the misleading `.gif` filename. Using `.gif` as the CLI format selector is proposed for a later phase.
- The standard Docker image does not bundle the optional Playwright, browser, and ffmpeg runtimes.
- Only one GIF export can run per editor server at a time.
- Once session preparation and HTML rendering finish, the server gives the exporter 120 seconds for runtime preflight, browser launch, capture, and encoding. Long sessions may require excluding turns or increasing playback speed.
- The output profile and disclosure policy are not configurable in this milestone.
- Manual interactions with the live preview are not capture inputs.

## Troubleshooting

### “GIF export requires Playwright in the current project”

Run `npm install --save-dev playwright` in the directory from which you launch `claude-replay`, then confirm that `node -e "console.log(require.resolve('playwright'))"` succeeds in that same directory. A standalone global Playwright installation is not currently discovered.

### “GIF export requires an installed Chrome, Chromium, Edge, or Playwright Chromium browser”

Install a supported system browser or run `npx playwright install chromium` from the workspace that provides Playwright. The Playwright package and its managed browser are separate pieces.

### “GIF export requires ffmpeg on PATH”

Install ffmpeg with the operating system's package manager. Run `ffmpeg -version` in the same shell environment used to start the editor. If it works in one terminal but not from the editor, compare their `PATH` values.

### “GIF export exceeded 120 seconds”

Exclude more turns or increase playback speed. The server timer begins after request parsing, session preparation, and HTML rendering; it then covers runtime preflight, browser launch, capture, and encoding. A replay whose playback approaches two minutes can therefore exceed the limit before processing finishes.

### “Another GIF export is already running”

Wait for the active export to finish or fail before starting another. Closing the request, stopping the editor, or reaching the timeout cancels capture and releases the export slot after cleanup; terminating a child process can make that cleanup take a few additional seconds.

### “Cannot export an empty replay”

Include at least one turn. This error commonly occurs when every turn has been excluded in the editor.

## Local processing and cleanup

GIF export is implemented in a separate optional module. The module is loaded by the editor server, and Playwright is dynamically loaded only after the user requests a GIF. The ordinary parser, renderer, browser page, and generated HTML player do not import Playwright or ffmpeg.

The exporter writes the freshly rendered HTML, captured PNG frames, and encoded GIF to a private temporary directory. It opens the local HTML in a temporary headless browser session, reads the completed GIF into memory, and sends the GIF to the editor for download. The temporary directory is removed after normal success, handled failure, or cancellation. The export path does not intentionally upload the transcript or frames to a remote service, and it does not modify the source transcript.

## Design context

This guide documents behavior that exists in the steel-thread milestone. For rationale, alternatives, and possible follow-on work, see:

- [ADR-0001: Deterministic GIF export architecture](adr/0001-deterministic-gif-export.md), which remains a draft direction rather than a ratified requirement; and
- [GIF export steel thread](gif-export-steel-thread.md), which defines the first upstream-reviewable implementation slice.
