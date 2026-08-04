import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import {
  GIF_EXPORT_PROFILE,
  GifExportError,
  __test,
  findExecutable,
  resolvePlaywrightEntry,
} from "../src/gif-exporter.mjs";

describe("GIF exporter", () => {
  it("keeps the steel-thread output profile fixed", () => {
    assert.deepEqual(GIF_EXPORT_PROFILE, {
      width: 800,
      height: 500,
      fps: 10,
      colors: 128,
      splashFrames: 8,
      finalFrames: 8,
      maxDurationMs: 120_000,
    });
    assert.ok(Object.isFrozen(GIF_EXPORT_PROFILE));
  });

  it("resolves executables from PATH without invoking a shell", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-replay-path-test-"));
    const executable = join(dir, process.platform === "win32" ? "gif-tool.CMD" : "gif-tool");
    try {
      writeFileSync(executable, "");
      chmodSync(executable, 0o755);
      const env = process.platform === "win32"
        ? { PATH: [dir, "/does/not/exist"].join(delimiter), PATHEXT: ".CMD;.EXE" }
        : { PATH: [dir, "/does/not/exist"].join(delimiter) };
      assert.equal(findExecutable("gif-tool", env), executable);
      assert.equal(findExecutable("missing-tool", env), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an actionable project-local Playwright preflight error", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-replay-no-playwright-"));
    try {
      assert.throws(
        () => resolvePlaywrightEntry(dir),
        (error) => error instanceof GifExportError
          && error.code === "playwright_missing"
          && error.message.includes("npm install --save-dev playwright"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves Playwright from a consumer project's local dependency tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-replay-consumer-"));
    const packageDir = join(dir, "node_modules", "playwright");
    try {
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(join(packageDir, "package.json"), JSON.stringify({
        name: "playwright",
        version: "0.0.0-test",
        main: "index.js",
      }));
      writeFileSync(join(packageDir, "index.js"), "module.exports = {};\n");
      assert.equal(resolvePlaywrightEntry(dir), realpathSync(join(packageDir, "index.js")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an actionable ffmpeg preflight error", () => {
    const script = [
      'import { exportGif } from "./src/gif-exporter.mjs";',
      'try { await exportGif({ html: "<!doctype html>" }); }',
      'catch (error) { console.log(error.code); console.log(error.message); }',
    ].join(" ");
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, PATH: "" },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^ffmpeg_missing/m);
    assert.match(result.stdout, /requires ffmpeg on PATH/);
  });

  it("honors an already-aborted request before runtime preflight", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled by test"));
    await assert.rejects(
      () => import("../src/gif-exporter.mjs").then(({ exportGif }) => exportGif({
        html: "<!doctype html>",
        signal: controller.signal,
      })),
      (error) => error.name === "AbortError" && error.message === "cancelled by test",
    );
  });

  it("builds an argument-array ffmpeg pipeline with palette optimization and looping", () => {
    const args = __test.ffmpegArgs("/private/frames with spaces", "/private/out with spaces.gif");
    assert.equal(args.at(-1), "/private/out with spaces.gif");
    assert.equal(args[args.indexOf("-framerate") + 1], "10");
    assert.equal(args[args.indexOf("-loop") + 1], "0");
    const filter = args[args.indexOf("-filter_complex") + 1];
    assert.match(filter, /scale=800:500/);
    assert.match(filter, /palettegen=max_colors=128/);
    assert.match(filter, /paletteuse/);
    assert.ok(args.includes(join("/private/frames with spaces", "frame-%06d.png")));
  });

  it("prefers a compatible Playwright-managed Chromium browser", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-replay-browser-test-"));
    const executable = join(dir, process.platform === "win32" ? "chromium.exe" : "chromium");
    const launches = [];
    const browser = { close: async () => {} };
    try {
      writeFileSync(executable, "");
      chmodSync(executable, 0o755);
      const chromium = {
        executablePath: () => executable,
        launch: async (options) => {
          launches.push(options);
          return browser;
        },
      };
      const launched = await __test.launchBrowser(chromium, { PATH: "" });
      assert.equal(launched.browser, browser);
      assert.equal(launched.browserName, "Playwright Chromium");
      assert.equal(launches.length, 1);
      assert.equal(launches[0].executablePath, executable);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closes a browser that finishes launching after cancellation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-replay-browser-abort-"));
    const executable = join(dir, process.platform === "win32" ? "chromium.exe" : "chromium");
    const controller = new AbortController();
    let closed = false;
    try {
      writeFileSync(executable, "");
      chmodSync(executable, 0o755);
      const chromium = {
        executablePath: () => executable,
        launch: () => new Promise((resolveLaunch) => {
          setTimeout(() => resolveLaunch({ close: async () => { closed = true; } }), 20);
        }),
      };
      const launch = __test.launchBrowser(chromium, { PATH: "" }, controller.signal);
      controller.abort(new Error("cancel launch"));
      await assert.rejects(launch, (error) => error.name === "AbortError");
      assert.equal(closed, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("captures exactly eight scheduled frames for each fixed hold", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-replay-hold-test-"));
    let screenshots = 0;
    const page = {
      screenshot: async ({ path }) => {
        screenshots++;
        writeFileSync(path, String(screenshots));
      },
    };
    try {
      const nextIndex = await __test.captureHold(page, dir, 4, 8);
      assert.equal(nextIndex, 12);
      assert.equal(screenshots, 8);
      assert.deepEqual(
        readdirSync(dir).sort(),
        Array.from({ length: 8 }, (_, offset) => `frame-${String(offset + 4).padStart(6, "0")}.png`),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("waits for a SIGTERM-resistant child to close before reporting cancellation", { skip: process.platform === "win32" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-replay-child-test-"));
    const executable = join(dir, "ignore-term");
    const ready = join(dir, "ready");
    const marker = join(dir, "term-received");
    const controller = new AbortController();
    try {
      writeFileSync(executable, [
        `#!${process.execPath}`,
        'const { writeFileSync } = require("node:fs");',
        'writeFileSync(process.argv[2], "READY");',
        'process.on("SIGTERM", () => writeFileSync(process.argv[3], "SIGTERM"));',
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"));
      chmodSync(executable, 0o755);

      const processRun = __test.runProcess(executable, [ready, marker], {
        signal: controller.signal,
        failureCode: "test_process_failed",
        failureMessage: "test process failed",
      });
      for (let attempt = 0; attempt < 250 && !existsSync(ready); attempt++) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
      assert.equal(existsSync(ready), true, "child did not become ready");
      const startedAt = Date.now();
      controller.abort(new Error("cancel child"));

      await assert.rejects(processRun, (error) => error.name === "AbortError");
      assert.ok(Date.now() - startedAt >= 1_900, "cancellation settled before forced child termination");
      assert.equal(existsSync(marker), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
