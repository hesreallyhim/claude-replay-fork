/**
 * Capture a rendered replay as a fixed-profile animated GIF.
 *
 * Playwright and ffmpeg are optional user-provided runtimes. This module loads
 * them only when GIF export is requested so ordinary rendering keeps its zero-
 * dependency runtime contract.
 */

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  accessSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

export const GIF_EXPORT_PROFILE = Object.freeze({
  width: 800,
  height: 500,
  fps: 10,
  colors: 128,
  splashFrames: 8,
  finalFrames: 8,
  maxDurationMs: 120_000,
});

const FRAME_INTERVAL_MS = 1000 / GIF_EXPORT_PROFILE.fps;
const MAX_STDERR_BYTES = 64 * 1024;

/** An actionable failure at a named GIF-export phase. */
export class GifExportError extends Error {
  /**
   * @param {string} code Stable machine-readable error code.
   * @param {string} message User-facing diagnostic message.
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "GifExportError";
    this.code = code;
  }
}

function abortError(reason) {
  const error = reason instanceof Error ? reason : new Error("GIF export was cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal.reason);
}

function wait(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolveWait, rejectWait) => {
    const timer = setTimeout(finish, Math.max(0, ms));
    function finish() {
      signal?.removeEventListener("abort", cancel);
      resolveWait();
    }
    function cancel() {
      clearTimeout(timer);
      rejectWait(abortError(signal.reason));
    }
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

function isExecutable(path) {
  try {
    accessSync(path, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a command without invoking a shell. */
export function findExecutable(command, env = process.env) {
  if (command.includes(sep) || (process.platform === "win32" && /^[A-Za-z]:/.test(command))) {
    return isExecutable(command) ? command : null;
  }

  const pathEntries = (env.PATH || "").split(delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = join(entry, process.platform === "win32" ? command + extension : command);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** Resolve Playwright from the project where claude-replay was invoked. */
export function resolvePlaywrightEntry(cwd = process.cwd()) {
  try {
    const anchor = join(resolve(cwd), "__claude_replay_playwright__.cjs");
    return createRequire(anchor).resolve("playwright");
  } catch (cause) {
    throw new GifExportError(
      "playwright_missing",
      "GIF export requires Playwright in the current project. claude-replay does not install it automatically. Install it with `npm install --save-dev playwright`, then try again.",
      { cause },
    );
  }
}

async function loadPlaywright(cwd) {
  const entry = resolvePlaywrightEntry(cwd);
  try {
    const module = await import(pathToFileURL(entry).href);
    const chromium = module.chromium || module.default?.chromium;
    if (!chromium) throw new Error("The installed package does not expose chromium");
    return { chromium, entry };
  } catch (cause) {
    if (cause instanceof GifExportError) throw cause;
    throw new GifExportError(
      "playwright_load_failed",
      `Playwright was found at ${entry}, but its browser API could not be loaded. claude-replay does not reinstall optional runtimes automatically; reinstall Playwright in the current project and try again.`,
      { cause },
    );
  }
}

function systemBrowserCandidates(env = process.env) {
  if (process.platform === "darwin") {
    return [
      ["Google Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
      ["Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
      ["Microsoft Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    ];
  }
  if (process.platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean);
    const relativeCandidates = [
      ["Google Chrome", join("Google", "Chrome", "Application", "chrome.exe")],
      ["Chromium", join("Chromium", "Application", "chrome.exe")],
      ["Microsoft Edge", join("Microsoft", "Edge", "Application", "msedge.exe")],
    ];
    return roots.flatMap((root) => relativeCandidates.map(([name, relative]) => [name, join(root, relative)]));
  }
  return [
    ["Google Chrome", findExecutable("google-chrome", env)],
    ["Google Chrome", findExecutable("google-chrome-stable", env)],
    ["Chromium", findExecutable("chromium", env)],
    ["Chromium", findExecutable("chromium-browser", env)],
    ["Microsoft Edge", findExecutable("microsoft-edge", env)],
    ["Microsoft Edge", findExecutable("microsoft-edge-stable", env)],
  ];
}

async function launchBrowser(chromium, env = process.env, signal) {
  const candidates = [];
  let managedPath;
  try {
    managedPath = chromium.executablePath?.();
  } catch {
    managedPath = null;
  }
  if (managedPath && isExecutable(managedPath)) {
    candidates.push({ name: "Playwright Chromium", options: { executablePath: managedPath } });
  }

  candidates.push(...systemBrowserCandidates(env)
    .filter(([, executablePath]) => executablePath && isExecutable(executablePath))
    .map(([name, executablePath]) => ({ name, options: { executablePath } })));

  const failures = [];
  for (const candidate of candidates) {
    throwIfAborted(signal);
    const launchPromise = chromium.launch({ headless: true, timeout: 10_000, ...candidate.options });
    let cancelLaunch;
    const aborted = new Promise((_, rejectLaunch) => {
      cancelLaunch = () => rejectLaunch(abortError(signal.reason));
      signal?.addEventListener("abort", cancelLaunch, { once: true });
    });
    try {
      const browser = await Promise.race([launchPromise, aborted]);
      signal?.removeEventListener("abort", cancelLaunch);
      if (signal?.aborted) {
        await browser.close().catch(() => {});
        throw abortError(signal.reason);
      }
      return { browser, browserName: candidate.name };
    } catch (error) {
      signal?.removeEventListener("abort", cancelLaunch);
      if (signal?.aborted) {
        const lateBrowser = await launchPromise.catch(() => null);
        if (lateBrowser) await lateBrowser.close().catch(() => {});
        throw abortError(signal.reason);
      }
      failures.push(`${candidate.name}: ${error.message}`);
    }
  }

  const detail = failures.length > 0 ? ` Attempts failed: ${failures.join(" | ")}` : "";
  throw new GifExportError(
    "browser_missing",
    "GIF export requires an installed Chrome, Chromium, Edge, or Playwright Chromium browser. claude-replay does not install browser binaries automatically. Install a supported system browser or run `npx playwright install chromium`, then try again." + detail,
  );
}

function terminateChild(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return null;
  try {
    child.kill("SIGTERM");
  } catch {
    // The force timer below still attempts to terminate the process.
  }
  const forceTimer = setTimeout(() => {
    if (child.exitCode == null && child.signalCode == null) {
      try { child.kill("SIGKILL"); } catch { /* close remains authoritative */ }
    }
  }, 2_000);
  forceTimer.unref?.();
  return forceTimer;
}

function runProcess(command, args, { signal, failureCode, failureMessage }) {
  throwIfAborted(signal);
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    let settled = false;
    let cancellation = null;
    let forceTimer = null;

    function cleanup() {
      signal?.removeEventListener("abort", cancel);
      if (forceTimer) clearTimeout(forceTimer);
    }
    function finish(fn, value) {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    }
    function cancel() {
      cancellation = abortError(signal.reason);
      forceTimer = terminateChild(child);
    }

    signal?.addEventListener("abort", cancel, { once: true });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString();
    });
    child.on("error", (cause) => {
      if (cancellation) return;
      const message = cause.code === "ENOENT"
        ? failureMessage
        : `${failureMessage} (${cause.message})`;
      finish(rejectRun, new GifExportError(failureCode, message, { cause }));
    });
    child.on("close", (code, processSignal) => {
      if (settled) return;
      if (cancellation) return finish(rejectRun, cancellation);
      if (code === 0) return finish(resolveRun, { stderr });
      const suffix = stderr.trim() || `process exited with ${processSignal || code}`;
      finish(rejectRun, new GifExportError(failureCode, `${failureMessage} ${suffix}`));
    });
  });
}

function framePath(framesDir, index) {
  return join(framesDir, `frame-${String(index).padStart(6, "0")}.png`);
}

function throwIfPageFailed(getPageFailure) {
  const pageFailure = getPageFailure?.();
  if (pageFailure) {
    throw new GifExportError("player_failed", `The replay player failed during capture: ${pageFailure.message}`, { cause: pageFailure });
  }
}

async function captureHold(page, framesDir, startIndex, frameCount, signal, getPageFailure) {
  const endIndex = startIndex + frameCount;
  let frameIndex = startIndex;
  let nextDeadline = performance.now();
  let lastPath = null;

  while (frameIndex < endIndex) {
    throwIfAborted(signal);
    throwIfPageFailed(getPageFailure);
    const remaining = nextDeadline - performance.now();
    if (remaining > 0) await wait(remaining, signal);

    lastPath = framePath(framesDir, frameIndex++);
    await page.screenshot({ path: lastPath });
    throwIfPageFailed(getPageFailure);
    nextDeadline += FRAME_INTERVAL_MS;
    while (nextDeadline <= performance.now() && frameIndex < endIndex) {
      copyFileSync(lastPath, framePath(framesDir, frameIndex++));
      nextDeadline += FRAME_INTERVAL_MS;
    }
  }
  return frameIndex;
}

async function capturePlayback(page, framesDir, startIndex, signal, getPageFailure) {
  const startedAt = performance.now();
  let nextDeadline = startedAt;
  let frameIndex = startIndex;
  let lastPath = null;

  while (true) {
    throwIfAborted(signal);
    throwIfPageFailed(getPageFailure);
    if (performance.now() - startedAt > GIF_EXPORT_PROFILE.maxDurationMs) {
      throw new GifExportError(
        "capture_timeout",
        "GIF capture exceeded 120 seconds. Exclude more turns or increase playback speed and try again.",
      );
    }

    const remaining = nextDeadline - performance.now();
    if (remaining > 0) await wait(remaining, signal);

    const currentPath = framePath(framesDir, frameIndex++);
    await page.screenshot({ path: currentPath });
    throwIfPageFailed(getPageFailure);
    lastPath = currentPath;

    nextDeadline += FRAME_INTERVAL_MS;
    while (nextDeadline <= performance.now()) {
      throwIfAborted(signal);
      copyFileSync(lastPath, framePath(framesDir, frameIndex++));
      nextDeadline += FRAME_INTERVAL_MS;
    }

    const complete = await page.locator('body[data-playback-complete="1"]').count() > 0;
    if (complete) return frameIndex;
  }
}

function ffmpegArgs(framesDir, outputPath) {
  const inputPattern = join(framesDir, "frame-%06d.png");
  const filter = `fps=${GIF_EXPORT_PROFILE.fps},scale=${GIF_EXPORT_PROFILE.width}:${GIF_EXPORT_PROFILE.height}:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=${GIF_EXPORT_PROFILE.colors}:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3`;
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-framerate", String(GIF_EXPORT_PROFILE.fps),
    "-i", inputPattern,
    "-filter_complex", filter,
    "-loop", "0",
    outputPath,
  ];
}

/**
 * Export already-rendered replay HTML as an animated GIF.
 *
 * @param {{ html: string, signal?: AbortSignal, cwd?: string }} options
 * @returns {Promise<Buffer>} Encoded GIF bytes.
 * @throws {GifExportError|Error} For missing runtimes, capture failures, encoding failures, or cancellation.
 */
export async function exportGif({ html, signal, cwd = process.cwd() }) {
  if (typeof html !== "string" || html.length === 0) {
    throw new GifExportError("invalid_html", "GIF export requires rendered replay HTML.");
  }
  throwIfAborted(signal);

  const ffmpegPath = findExecutable("ffmpeg");
  if (!ffmpegPath) {
    throw new GifExportError(
      "ffmpeg_missing",
      "GIF export requires ffmpeg on PATH. claude-replay does not install it automatically. Install ffmpeg and try again.",
    );
  }
  const { chromium } = await loadPlaywright(cwd);

  const tempRoot = mkdtempSync(join(tmpdir(), "claude-replay-gif-"));
  const framesDir = join(tempRoot, "frames");
  const htmlPath = join(tempRoot, "capture.html");
  const outputPath = join(tempRoot, "replay.gif");

  let browser;
  let removeAbortListener = () => {};
  try {
    chmodSync(tempRoot, 0o700);
    mkdirSync(framesDir, { mode: 0o700 });
    writeFileSync(htmlPath, html, { mode: 0o600 });
    await runProcess(ffmpegPath, ["-version"], {
      signal,
      failureCode: "ffmpeg_missing",
      failureMessage: "ffmpeg could not be executed. Ensure it is installed and available on PATH.",
    });

    const launched = await launchBrowser(chromium, process.env, signal);
    browser = launched.browser;
    const closeOnAbort = () => { void browser.close().catch(() => {}); };
    signal?.addEventListener("abort", closeOnAbort, { once: true });
    removeAbortListener = () => signal?.removeEventListener("abort", closeOnAbort);

    const page = await browser.newPage({
      viewport: { width: GIF_EXPORT_PROFILE.width, height: GIF_EXPORT_PROFILE.height },
      deviceScaleFactor: 1,
    });
    let pageFailure = null;
    page.on("pageerror", (error) => { pageFailure = error; });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load", timeout: 10_000 });
    await page.waitForSelector('body[data-ready="1"]', { timeout: 10_000 });
    await page.evaluate(async () => {
      if (document.fonts?.ready) await document.fonts.ready;
      const style = document.createElement("style");
      style.dataset.captureStyle = "gif";
      style.textContent = "html[data-capture='gif'], html[data-capture='gif'] body { user-select: none; } html[data-capture='gif'] body { pointer-events: none; }";
      document.head.appendChild(style);
      document.documentElement.dataset.capture = "gif";
    });
    if (pageFailure) throw pageFailure;

    let frameIndex = 0;
    const getPageFailure = () => pageFailure;
    frameIndex = await captureHold(page, framesDir, frameIndex, GIF_EXPORT_PROFILE.splashFrames, signal, getPageFailure);
    const playbackStarted = await page.evaluate(() => {
      const button = document.querySelector("#splash-play");
      if (!button) return false;
      button.click();
      return true;
    });
    if (!playbackStarted) {
      throw new GifExportError("capture_failed", "The replay player did not expose its playback control.");
    }
    frameIndex = await capturePlayback(page, framesDir, frameIndex, signal, getPageFailure);
    frameIndex = await captureHold(page, framesDir, frameIndex, GIF_EXPORT_PROFILE.finalFrames, signal, getPageFailure);
    if (frameIndex <= GIF_EXPORT_PROFILE.splashFrames + GIF_EXPORT_PROFILE.finalFrames) {
      throw new GifExportError("capture_failed", "The replay completed without producing playback frames.");
    }
    if (pageFailure) throw pageFailure;

    await browser.close();
    browser = null;
    removeAbortListener();
    removeAbortListener = () => {};

    await runProcess(ffmpegPath, ffmpegArgs(framesDir, outputPath), {
      signal,
      failureCode: "ffmpeg_failed",
      failureMessage: "ffmpeg could not encode the captured replay.",
    });
    const gif = readFileSync(outputPath);
    if (gif.length < 6 || !["GIF87a", "GIF89a"].includes(gif.subarray(0, 6).toString("ascii"))) {
      throw new GifExportError("ffmpeg_failed", "ffmpeg did not produce a valid GIF file.");
    }
    return gif;
  } catch (error) {
    if (signal?.aborted) throw abortError(signal.reason);
    if (error instanceof GifExportError) throw error;
    throw new GifExportError("capture_failed", `Browser capture failed: ${error.message}`, { cause: error });
  } finally {
    removeAbortListener();
    if (browser) await browser.close().catch(() => {});
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export const __test = Object.freeze({ captureHold, capturePlayback, ffmpegArgs, launchBrowser, runProcess, systemBrowserCandidates });
