/* global browser, describe, before, it */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  invokeE2E,
  unwrap,
  waitForApp,
} from "../../support/core/agentOrgUiDriver.mjs";

const RUN_ID = Date.now();
const TASK_ID = "e2e_docker_task";
const RUN_TIMEOUT_MS = 240_000;

function createDockerBenchmarkSource() {
  const dir = mkdtempSync(join(tmpdir(), `orgii-e2e-benchmark-docker-${RUN_ID}-`));
  const sourcePath = join(dir, "sweap_eval_full_v2.jsonl");
  const row = {
    instance_id: TASK_ID,
    repo: "e2e/docker-fixture",
    problem_statement: "Run the Docker-backed benchmark evaluator fixture.",
    requirements: "The evaluator must start a Docker container and report pass.",
    interface: "",
    base_commit: "0000000000000000000000000000000000000000",
    selected_test_files_to_run: ["docker_fixture.test"],
    FAIL_TO_PASS: ["docker fixture should pass"],
    PASS_TO_PASS: [],
  };
  writeFileSync(sourcePath, `${JSON.stringify(row)}\n`, "utf8");
  return sourcePath;
}

describe("Benchmark Docker execution", () => {
  before(async () => {
    await waitForApp();
    unwrap(
      await invokeE2E("navigateTo", "/orgii/workstation/code"),
      "navigate to workstation"
    );
  });

  it("runs a local Docker benchmark evaluator and records a passing result", async () => {
    const sourcePath = createDockerBenchmarkSource();
    const initial = unwrap(
      await invokeE2E("startLocalDockerBenchmarkRun", {
        sourcePath,
        taskId: TASK_ID,
        patch: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-e2e\n+e2e docker\n",
      }),
      "start local Docker benchmark run"
    ).status;
    const runId = initial.runId;
    if (!runId) {
      throw new Error(`Docker benchmark run did not return runId: ${JSON.stringify(initial)}`);
    }

    let finalStatus = initial;
    await browser.waitUntil(
      async () => {
        const polled = unwrap(
          await invokeE2E("getBenchmarkRunStatus", runId),
          "get benchmark run status"
        ).status;
        finalStatus = polled;
        return polled.status !== "running";
      },
      {
        timeout: RUN_TIMEOUT_MS,
        interval: 1_000,
        timeoutMsg: "Docker benchmark run did not finish in time",
      }
    );

    if (finalStatus.status !== "passed") {
      throw new Error(`Expected Docker benchmark to pass, got ${JSON.stringify(finalStatus)}`);
    }
    const logText = (finalStatus.logs ?? []).join("\n");
    if (!logText.includes("orgii-docker-benchmark-e2e")) {
      throw new Error(`Expected Docker evaluator sentinel in logs, got ${JSON.stringify(finalStatus)}`);
    }
    if (finalStatus.result !== true) {
      throw new Error(`Expected eval result true, got ${JSON.stringify(finalStatus)}`);
    }
  });
});
