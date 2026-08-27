import assert from "node:assert/strict";
import test from "node:test";

import {
  auditProcessTable,
  collectOwnedProcessSnapshot,
  descendantDepth,
  parseLaunchctlWebKitServices,
  parsePsOutput,
  redactProcessCommand,
  resolveRootProcess,
} from "../lib/process-snapshot.mjs";

const psFixture = `
  100     1   100  501 Ss   Thu Aug 13 10:00:00 2026      10240 400000000   1.5 /repo/src-tauri/target/debug/org2
  101   100   101  501 S    Thu Aug 13 10:00:01 2026       2048 200000000   0.1 /bin/zsh
  102   101   101  501 Z    Thu Aug 13 10:00:02 2026          0         0   0.0 <defunct>
  103     1   103  501 S    Thu Aug 13 10:00:03 2026       4096 200000000   0.0 /repo/scripts/dev/stale-worker
`;

test("ps parser preserves process identity and byte units", () => {
  const rows = parsePsOutput(psFixture);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].startToken, "Thu Aug 13 10:00:00 2026");
  assert.equal(rows[0].rssBytes, 10 * 1024 * 1024);
  assert.equal(rows[2].state, "Z");
});

test("root resolution and descendant traversal stay inside one process instance tree", () => {
  const rows = parsePsOutput(psFixture);
  const root = resolveRootProcess(rows, "auto", "/repo");
  assert.equal(root.pid, 100);
  assert.equal(descendantDepth(102, 100, rows), 2);
  assert.equal(descendantDepth(103, 100, rows), undefined);
});

test("audit distinguishes a zombie child from an adopted workspace process", () => {
  const rows = parsePsOutput(psFixture);
  const root = rows[0];
  const audit = auditProcessTable(rows, root, "/repo");
  assert.deepEqual(
    audit.findings.map((finding) => [finding.kind, finding.pid]),
    [
      ["zombie", 102],
      ["adopted_workspace_process", 103],
    ]
  );
});

test("launchctl parser accepts active WebKit roles only", () => {
  const roles = parseLaunchctlWebKitServices(`
      0 - com.apple.WebKit.WebContent
  88149 - com.apple.WebKit.Networking.ABC
  88193 - com.apple.WebKit.WebContent.DEF
  88148 - com.apple.WebKit.GPU.GHI
  99999 - com.apple.SafariPlatformSupport.Helper
  `);
  assert.deepEqual(
    [...roles.entries()],
    [
      [88149, "network"],
      [88193, "renderer"],
      [88148, "gpu"],
    ]
  );
});

test("snapshot refuses to continue after root PID identity changes", async () => {
  const rows = parsePsOutput(psFixture);
  const snapshot = await collectOwnedProcessSnapshot(
    { pid: 100, startToken: "Thu Aug 13 09:59:59 2026" },
    { rows }
  );
  assert.equal(snapshot.status, "root_exited");
  assert.equal(snapshot.processes.length, 0);
});

test("reported commands redact common secrets and URL credentials", () => {
  assert.equal(
    redactProcessCommand(
      "agent --api-key example-api-key --token=abc https://user:password@example.com/path"
    ),
    "agent --api-key [REDACTED] --token=[REDACTED] https://user:[REDACTED]@example.com/path"
  );
});
