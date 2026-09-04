import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateReports, summarizeSamples } from "../lib/report.mjs";

function sample(sequence, capturedAt, totalRssBytes, role = "backend") {
  return {
    schemaVersion: 1,
    sequence,
    capturedAt,
    status: "ok",
    attribution: "complete",
    totalRssBytes,
    processes: [
      {
        pid: 42,
        processInstanceId: "42:start",
        role,
        relation: "root",
        state: "S",
        rssBytes: totalRssBytes,
        virtualBytes: totalRssBytes * 2,
        cpuPercent: 1,
        command: "/tmp/org2",
      },
    ],
  };
}

test("summary flags sustained material growth without claiming a leak", () => {
  const samples = [
    sample(1, "2026-08-13T00:00:00.000Z", 100 * 1024 ** 2),
    sample(2, "2026-08-13T00:01:00.000Z", 140 * 1024 ** 2),
    sample(3, "2026-08-13T00:02:00.000Z", 180 * 1024 ** 2),
  ];
  const summary = summarizeSamples(samples);
  assert.equal(summary.verdict, "possible_growth");
  assert.equal(summary.deltaRssBytes, 80 * 1024 ** 2);
  assert.equal(summary.rolePeakRssBytes.backend, 180 * 1024 ** 2);
});

test("report writes English Markdown and preserves Unicode markers", async () => {
  const sessionDir = await mkdtemp(path.join(os.tmpdir(), "org2-diag-report-"));
  const markersDir = path.join(sessionDir, "markers");
  await mkdir(markersDir);
  await writeFile(
    path.join(sessionDir, "session.json"),
    JSON.stringify({
      schemaVersion: 1,
      sessionId: "fixture",
      platform: "darwin",
      startedAt: "2026-08-13T00:00:00.000Z",
      endedAt: "2026-08-13T00:01:00.000Z",
      stopReason: "external_stop",
      rootProcess: { pid: 42 },
      config: { intervalSeconds: 60 },
    })
  );
  await writeFile(
    path.join(sessionDir, "samples.ndjson"),
    `${JSON.stringify(sample(1, "2026-08-13T00:00:00.000Z", 100 * 1024 ** 2))}\n${JSON.stringify(sample(2, "2026-08-13T00:01:00.000Z", 110 * 1024 ** 2))}\n`
  );
  await writeFile(
    path.join(markersDir, "marker.json"),
    JSON.stringify({
      capturedAt: "2026-08-13T00:00:30.000Z",
      label: "打开 20 个会话",
    })
  );

  const result = await generateReports(sessionDir);
  const report = JSON.parse(await readFile(result.files.json, "utf8"));
  const markdown = await readFile(result.files.markdown, "utf8");
  const csv = await readFile(result.files.csv, "utf8");
  assert.equal(report.summary.verdict, "no_clear_growth");
  assert.equal(report.markers[0].label, "打开 20 个会话");
  assert.match(markdown, /^# ORG2 standalone memory diagnostics report/m);
  assert.match(markdown, /## Workflow markers/);
  assert.ok(markdown.includes(report.markers[0].label));
  assert.match(markdown, /cannot prove a memory leak on its own/);
  assert.match(csv, /process_instance_id/);
});
