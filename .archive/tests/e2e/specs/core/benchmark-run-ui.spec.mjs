/* global browser, describe, before, it */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  execJS,
  invokeE2E,
  unwrap,
  waitForApp,
} from "../../support/core/agentOrgUiDriver.mjs";

const RENDER_TIMEOUT_MS = 30_000;
const RUN_ID = Date.now();

function createBenchmarkSource() {
  const dir = mkdtempSync(join(tmpdir(), `orgii-e2e-benchmark-${RUN_ID}-`));
  const sourcePath = join(dir, "sweap_eval_full_v2.jsonl");
  const rows = [
    {
      instance_id: `e2e_repo__task-alpha-${RUN_ID}`,
      repo: "e2e/repo-alpha",
      problem_statement: "Fix the alpha benchmark regression.\nThe detail pane should render this instruction.",
      requirements: "Keep the UI deterministic for E2E.",
      interface: "",
      base_commit: "0000000000000000000000000000000000000000",
      selected_test_files_to_run: ["alpha.test.ts"],
      FAIL_TO_PASS: ["alpha should pass"],
      PASS_TO_PASS: [],
    },
    {
      instance_id: `e2e_repo__task-beta-${RUN_ID}`,
      repo: "e2e/repo-beta",
      problem_statement: "Fix the beta benchmark regression.",
      requirements: "Keep the task visible in the run list.",
      interface: "",
      base_commit: "1111111111111111111111111111111111111111",
      selected_test_files_to_run: ["beta.test.ts"],
      FAIL_TO_PASS: ["beta should pass"],
      PASS_TO_PASS: [],
    },
  ];
  writeFileSync(sourcePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  return { sourcePath, taskIds: rows.map((row) => row.instance_id) };
}

async function renderedBenchmarkState() {
  return execJS(`
    const page = document.querySelector('[data-testid="benchmark-run-page"]');
    const header = document.querySelector('[data-testid="benchmark-run-header"]');
    const rows = Array.from(document.querySelectorAll('[data-testid="benchmark-run-task-row"]'));
    const detail = page?.querySelector('[data-testid="benchmark-run-task-detail"]');
    return {
      hasPage: Boolean(page),
      batchId: page?.getAttribute('data-benchmark-batch-id') ?? null,
      status: page?.getAttribute('data-benchmark-status') ?? null,
      headerText: header?.innerText ?? '',
      rowCount: rows.length,
      rowTaskIds: rows.map((row) => row.getAttribute('data-benchmark-task-id')),
      rowStatuses: rows.map((row) => row.getAttribute('data-benchmark-task-status')),
      detailText: detail?.innerText ?? '',
      bodyText: document.body.innerText || '',
    };
  `);
}

describe("Benchmark run rendered UI", () => {
  before(async () => {
    await waitForApp();
    unwrap(
      await invokeE2E("navigateTo", "/orgii/workstation/code"),
      "navigate to workstation"
    );
  });

  it("renders a seeded benchmark run page with tasks and detail", async () => {
    const fixture = createBenchmarkSource();
    const batchId = `e2e-benchmark-batch-${RUN_ID}`;
    const seed = unwrap(
      await invokeE2E("seedBenchmarkRun", {
        batchId,
        sourcePath: fixture.sourcePath,
        taskIds: fixture.taskIds,
        activeTaskId: fixture.taskIds[0],
      }),
      "seed benchmark run"
    );
    if (seed.batchId !== batchId) {
      throw new Error(`Seeded batch mismatch: ${JSON.stringify(seed)}`);
    }

    let state = null;
    try {
      await browser.waitUntil(
        async () => {
          state = await renderedBenchmarkState();
          return (
            state.hasPage &&
            state.batchId === batchId &&
            state.rowCount === fixture.taskIds.length &&
            state.rowTaskIds.includes(fixture.taskIds[0]) &&
            state.detailText === ""
          );
        },
        {
          timeout: RENDER_TIMEOUT_MS,
          interval: 500,
          timeoutMsg: "benchmark run page did not render seeded run state",
        }
      );
    } catch (error) {
      const helperState = await invokeE2E("inspectBenchmarkRun");
      throw new Error(
        `benchmark run page did not render seeded run state: rendered=${JSON.stringify(state)} helper=${JSON.stringify(helperState)} original=${String(error?.message ?? error)}`
      );
    }

    if (state.status !== "running" || !state.headerText.includes("2")) {
      throw new Error(`Expected running progress header, got ${JSON.stringify(state)}`);
    }
    if (!state.rowStatuses.includes("running") || !state.rowStatuses.includes("queued")) {
      throw new Error(`Expected running and queued task statuses, got ${JSON.stringify(state)}`);
    }
  });
});
