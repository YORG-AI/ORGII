import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../cli.mjs"
);

async function waitForFile(filePath, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`等待文件超时：${filePath}`);
}

async function waitForNonEmptyFile(filePath, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const contents = await readFile(filePath, "utf8");
      if (contents.trim()) return contents;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待非空文件超时：${filePath}`);
}

test(
  "record → mark → stop finalizes one owned session and reports the marker",
  { skip: process.platform === "win32", timeout: 15_000 },
  async () => {
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "orgii-diag-lifecycle-")
    );
    const stateRoot = path.join(temporaryRoot, "state");
    const outputRoot = path.join(temporaryRoot, "output");
    const recorder = spawn(
      process.execPath,
      [
        cliPath,
        "memory",
        "record",
        "--pid",
        String(process.pid),
        "--interval",
        "60",
        "--max-samples",
        "10",
        "--state-root",
        stateRoot,
        "--output",
        outputRoot,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    recorder.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    recorder.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const active = await waitForFile(
      path.join(stateRoot, "active-session.json")
    );
    await waitForNonEmptyFile(path.join(active.sessionDir, "samples.ndjson"));
    await execFileAsync(process.execPath, [
      cliPath,
      "memory",
      "mark",
      "完成一轮操作",
      "--state-root",
      stateRoot,
    ]);
    await execFileAsync(process.execPath, [
      cliPath,
      "memory",
      "stop",
      "--state-root",
      stateRoot,
    ]);

    const exit = await new Promise((resolve, reject) => {
      recorder.once("error", reject);
      recorder.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(exit, { code: 0, signal: null }, `${stdout}\n${stderr}`);
    const report = JSON.parse(
      await readFile(path.join(active.sessionDir, "report.json"), "utf8")
    );
    assert.equal(report.session.stopReason, "external_stop");
    assert.equal(report.markers[0].label, "完成一轮操作");
    assert.ok(report.summary.usableSampleCount >= 1);
  }
);
