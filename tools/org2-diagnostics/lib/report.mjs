import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { writeJsonAtomic } from "./session-store.mjs";

function parseJsonLines(text) {
  const values = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line));
    } catch (error) {
      values.push({
        status: "invalid_sample",
        sequence: index + 1,
        error: `Cannot parse sample line: ${error.message}`,
      });
    }
  }
  return values;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}

async function readSamples(sessionDir) {
  try {
    return parseJsonLines(
      await readFile(path.join(sessionDir, "samples.ndjson"), "utf8")
    );
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function readMarkers(sessionDir) {
  const markersDir = path.join(sessionDir, "markers");
  let entries;
  try {
    entries = await readdir(markersDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const markers = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJson(path.join(markersDir, entry.name)))
  );
  return markers.sort((left, right) =>
    left.capturedAt.localeCompare(right.capturedAt)
  );
}

function linearSlope(samples) {
  const usable = samples.filter(
    (sample) => sample.status === "ok" && Number.isFinite(sample.totalRssBytes)
  );
  if (usable.length < 2) return undefined;
  const origin = Date.parse(usable[0].capturedAt);
  const points = usable.map((sample) => ({
    x: (Date.parse(sample.capturedAt) - origin) / 1000,
    y: sample.totalRssBytes,
  }));
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const numerator = points.reduce(
    (sum, point) => sum + (point.x - meanX) * (point.y - meanY),
    0
  );
  const denominator = points.reduce(
    (sum, point) => sum + (point.x - meanX) ** 2,
    0
  );
  return denominator === 0 ? 0 : numerator / denominator;
}

export function summarizeSamples(samples) {
  const usable = samples.filter(
    (sample) => sample.status === "ok" && Number.isFinite(sample.totalRssBytes)
  );
  const first = usable[0];
  const last = usable.at(-1);
  const peak = usable.reduce(
    (current, sample) =>
      !current || sample.totalRssBytes > current.totalRssBytes
        ? sample
        : current,
    undefined
  );
  const rolePeaks = {};
  let zombieSampleCount = 0;
  for (const sample of usable) {
    const roleTotals =
      sample.roleRssBytes ??
      sample.processes.reduce((totals, item) => {
        totals[item.role] = (totals[item.role] ?? 0) + item.rssBytes;
        return totals;
      }, {});
    if (
      (sample.zombieProcessCount ??
        sample.processes.filter((item) => item.state.includes("Z")).length) > 0
    ) {
      zombieSampleCount += 1;
    }
    for (const [role, total] of Object.entries(roleTotals)) {
      rolePeaks[role] = Math.max(rolePeaks[role] ?? 0, total);
    }
  }
  const slopeBytesPerSecond = linearSlope(usable);
  const deltaBytes =
    first && last ? last.totalRssBytes - first.totalRssBytes : undefined;
  const possibleGrowth =
    usable.length >= 3 &&
    deltaBytes > 50 * 1024 * 1024 &&
    slopeBytesPerSecond > (1024 * 1024) / 60;
  return {
    sampleCount: samples.length,
    usableSampleCount: usable.length,
    firstRssBytes: first?.totalRssBytes,
    lastRssBytes: last?.totalRssBytes,
    deltaRssBytes: deltaBytes,
    peakRssBytes: peak?.totalRssBytes,
    peakCapturedAt: peak?.capturedAt,
    slopeBytesPerSecond,
    rolePeakRssBytes: rolePeaks,
    zombieSampleCount,
    verdict: possibleGrowth
      ? "possible_growth"
      : usable.length >= 2
        ? "no_clear_growth"
        : "insufficient_data",
  };
}

function csvCell(value) {
  if (value === undefined || value === null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function buildCsv(samples) {
  const headings = [
    "sequence",
    "captured_at",
    "sample_status",
    "attribution",
    "total_rss_bytes",
    "pid",
    "process_instance_id",
    "role",
    "relation",
    "state",
    "rss_bytes",
    "virtual_bytes",
    "cpu_percent",
    "command",
  ];
  const rows = [headings];
  for (const sample of samples) {
    if (!sample.processes?.length) {
      rows.push([
        sample.sequence,
        sample.capturedAt,
        sample.status,
        sample.attribution,
        sample.totalRssBytes,
      ]);
      continue;
    }
    for (const item of sample.processes) {
      rows.push([
        sample.sequence,
        sample.capturedAt,
        sample.status,
        sample.attribution,
        sample.totalRssBytes,
        item.pid,
        item.processInstanceId,
        item.role,
        item.relation,
        item.state,
        item.rssBytes,
        item.virtualBytes,
        item.cpuPercent,
        item.command,
      ]);
    }
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "unavailable";
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  if (absolute >= 1024 ** 3)
    return `${sign}${(absolute / 1024 ** 3).toFixed(2)} GiB`;
  if (absolute >= 1024 ** 2)
    return `${sign}${(absolute / 1024 ** 2).toFixed(1)} MiB`;
  return `${sign}${(absolute / 1024).toFixed(1)} KiB`;
}

function buildMarkdown(session, summary, markers) {
  const verdict =
    summary.verdict === "possible_growth"
      ? "Signs of sustained growth were detected. Review the workflow markers and repeat the measurement over a longer period."
      : summary.verdict === "no_clear_growth"
        ? "This RSS series shows no clear signs of sustained growth."
        : "There are not enough usable samples to assess the growth trend.";
  const markerRows = markers.length
    ? markers
        .map(
          (marker) =>
            `| ${marker.capturedAt} | ${marker.label.replaceAll(/[\r\n]+/g, " ").replaceAll("|", "\\|")} |`
        )
        .join("\n")
    : "| — | None |";
  const roleRows = Object.entries(summary.rolePeakRssBytes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([role, bytes]) => `| ${role} | ${formatBytes(bytes)} |`)
    .join("\n");
  return `# ORG2 standalone memory diagnostics report

> This report uses external system sampling and does not modify the app. Summed RSS may double-count shared pages. Use the trend to guide investigation; it cannot prove a memory leak on its own.

## Session

| Field | Value |
| --- | --- |
| Session ID | ${session.sessionId} |
| Root process | PID ${session.rootProcess.pid} |
| Started at | ${session.startedAt} |
| Ended at | ${session.endedAt ?? "Not finalized"} |
| Stop reason | ${session.stopReason ?? "Unknown"} |
| Sampling interval | ${session.config.intervalSeconds} seconds |
| Attribution | Backend process tree${session.platform === "darwin" ? " + host-owned WebKit services from launchctl" : ""} |

## Findings

${verdict}

- Usable samples: ${summary.usableSampleCount} / ${summary.sampleCount}
- Change from first to last sample: ${formatBytes(summary.deltaRssBytes)}
- Peak RSS: ${formatBytes(summary.peakRssBytes)}
- Linear trend: ${Number.isFinite(summary.slopeBytesPerSecond) ? `${formatBytes(summary.slopeBytesPerSecond * 60)}/minute` : "unavailable"}
- Samples containing zombie processes: ${summary.zombieSampleCount}

## Peak RSS by role

| Role | Peak RSS |
| --- | ---: |
${roleRows || "| — | unavailable |"}

## Workflow markers

| Time | Action |
| --- | --- |
${markerRows}
`;
}

export async function generateReports(sessionDir) {
  const session = await readJson(path.join(sessionDir, "session.json"));
  const samples = await readSamples(sessionDir);
  const markers = await readMarkers(sessionDir);
  const summary = summarizeSamples(samples);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    measurementNote:
      "RSS sum is an external trend signal and may double-count shared pages.",
    session,
    summary,
    markers,
    samples,
  };
  await writeJsonAtomic(path.join(sessionDir, "report.json"), report);
  await writeFile(
    path.join(sessionDir, "samples.csv"),
    buildCsv(samples),
    "utf8"
  );
  await writeFile(
    path.join(sessionDir, "summary.md"),
    buildMarkdown(session, summary, markers),
    "utf8"
  );
  return {
    sessionDir,
    summary,
    files: {
      json: path.join(sessionDir, "report.json"),
      csv: path.join(sessionDir, "samples.csv"),
      markdown: path.join(sessionDir, "summary.md"),
    },
  };
}
