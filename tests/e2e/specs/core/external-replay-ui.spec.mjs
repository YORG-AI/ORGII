/**
 * Rendered acceptance for Issue #443 bounded external replay.
 *
 * Critical user actions live in `externalReplayUiDriver`: the spec discovers
 * sessions through production rescan/roster paths, clicks the real sidebar
 * row, and drives pagination/history with rendered controls.
 */
import { assertFixtureCodexSessionUsesBoundedReplay } from "../../support/core/externalReplayFixtureScenario.mjs";
import {
  assertIssue443RealCodexBoundedMemoryRelease,
  assertIssue443RealCodexCompactCatalog,
  assertIssue443RealCodexContinuousScroll,
  assertIssue443RealCodexEpisodeAndReopen,
  assertIssue443RealCodexInitialOpen,
  assertIssue443RealCodexNavigatorCatalog,
  assertIssue443RealCodexNavigatorFirstRoundRecovery,
  assertIssue443RealCodexNavigatorRandomAccess,
  assertIssue443RealCodexPaginationOn,
  assertIssue443RealCodexPaginationRound100,
  logIssue443RealCodexDiagnostics,
  prepareIssue443RealCodexMatrix,
} from "../../support/core/externalReplayRealSessionScenario.mjs";
import { prepareSidebarDiscoveryRenderedUi } from "../../support/core/sidebarSessionDiscoveryDriver.mjs";

const E2E_REPO_PATH =
  process.env.E2E_REPO_PATH ?? "/tmp/orgii-e2e-workspace-repo";
const ISSUE_443_REAL_CODEX_SESSION_ID =
  process.env.E2E_ISSUE_443_REAL_CODEX_SESSION_ID ?? "";
const ISSUE_443_FIXTURE_CODEX_SESSION_ID =
  process.env.E2E_ISSUE_443_FIXTURE_CODEX_SESSION_ID ?? "";
const ISSUE_443_FIXTURE_LARGE_PAYLOAD_BYTES = Number(
  process.env.E2E_ISSUE_443_FIXTURE_LARGE_PAYLOAD_BYTES ?? 0
);
const ISSUE_443_FIXTURE_LARGE_PAYLOAD_SHA256 =
  process.env.E2E_ISSUE_443_FIXTURE_LARGE_PAYLOAD_SHA256 ?? "";
const ISSUE_443_FIXTURE_JSONL_BYTES = Number(
  process.env.E2E_ISSUE_443_FIXTURE_JSONL_BYTES ?? 0
);
const SCENARIO_FILTER = (process.env.E2E_CHAT_RENDERING_SCENARIOS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const REAL_CODEX_SCENARIO_FILTER = (
  process.env.E2E_ISSUE_443_REAL_SCENARIOS ?? ""
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

function shouldRunScenario(name) {
  return SCENARIO_FILTER.length === 0 || SCENARIO_FILTER.includes(name);
}

function scenarioWasExplicitlyRequested(name) {
  return SCENARIO_FILTER.includes(name);
}

function shouldRunRealCodexScenario(name) {
  return (
    shouldRunScenario("issue-443-real-codex") &&
    (REAL_CODEX_SCENARIO_FILTER.length === 0 ||
      REAL_CODEX_SCENARIO_FILTER.includes(name))
  );
}

const REAL_CODEX_SCENARIOS = [
  {
    name: "initial-open",
    title: "opens the real Codex session with the latest bounded Round visible",
    run: assertIssue443RealCodexInitialOpen,
  },
  {
    name: "compact-catalog",
    title: "lists compact real Codex Round summaries before body hydration",
    run: assertIssue443RealCodexCompactCatalog,
  },
  {
    name: "pagination-on",
    title: "navigates real Codex Previous and Latest Rounds with pagination on",
    run: assertIssue443RealCodexPaginationOn,
  },
  {
    name: "pagination-round-100",
    title: "renders the real Codex Round 100 body without a corrective scroll",
    run: assertIssue443RealCodexPaginationRound100,
  },
  {
    name: "pagination-off-continuous-scroll",
    title: "loads a real Codex history burst while preserving the viewport",
    run: assertIssue443RealCodexContinuousScroll,
  },
  {
    name: "navigator-random-access",
    title: "opens an unloaded real Codex Round from the conversation navigator",
    run: assertIssue443RealCodexNavigatorRandomAccess,
  },
  {
    name: "navigator-first-round-recovery",
    title: "scrolls forward after jumping to the first real Codex Round",
    run: assertIssue443RealCodexNavigatorFirstRoundRecovery,
  },
  {
    name: "navigator-catalog",
    title: "browses first, middle, and latest real Codex navigator previews",
    run: assertIssue443RealCodexNavigatorCatalog,
  },
  {
    name: "episode-and-reopen",
    title: "keeps real Codex state isolated across A to B to A episodes",
    run: assertIssue443RealCodexEpisodeAndReopen,
  },
  {
    name: "bounded-memory-release",
    title: "releases real Codex bounded replay memory without staircase growth",
    run: assertIssue443RealCodexBoundedMemoryRelease,
  },
];

describe("External replay rendered UI", () => {
  before(async () => {
    // Start from the same user-visible external-session policy as the sidebar
    // acceptance suite. The actual open, pagination, scrolling, and payload
    // reads still go through rendered controls and production commands.
    await prepareSidebarDiscoveryRenderedUi(E2E_REPO_PATH);
    if (
      shouldRunScenario("issue-443-real-codex") &&
      ISSUE_443_REAL_CODEX_SESSION_ID
    ) {
      await prepareIssue443RealCodexMatrix(ISSUE_443_REAL_CODEX_SESSION_ID);
    }
  });

  afterEach(async function () {
    if (
      !ISSUE_443_REAL_CODEX_SESSION_ID ||
      !this.currentTest?.title?.startsWith("real Codex:")
    ) {
      return;
    }
    await logIssue443RealCodexDiagnostics(
      `${this.currentTest.title} status=${this.currentTest.state ?? "unknown"}`
    ).catch((error) => {
      console.error(
        `[issue-443-real-codex] diagnostic collection failed: ${String(error)}`
      );
    });
  });

  it("opens the isolated Codex fixture through bounded external replay", async function () {
    if (!shouldRunScenario("issue-443-fixture-codex")) {
      this.skip();
      return;
    }
    if (!ISSUE_443_FIXTURE_CODEX_SESSION_ID) {
      if (scenarioWasExplicitlyRequested("issue-443-fixture-codex")) {
        throw new Error(
          "issue-443-fixture-codex was explicitly requested without the isolated fixture"
        );
      }
      this.skip();
      return;
    }

    await assertFixtureCodexSessionUsesBoundedReplay({
      sessionId: ISSUE_443_FIXTURE_CODEX_SESSION_ID,
      expectedLargePayloadBytes: ISSUE_443_FIXTURE_LARGE_PAYLOAD_BYTES,
      expectedLargePayloadSha256: ISSUE_443_FIXTURE_LARGE_PAYLOAD_SHA256,
      fixtureJsonlBytes: ISSUE_443_FIXTURE_JSONL_BYTES,
    });
  });

  for (const scenario of REAL_CODEX_SCENARIOS) {
    it(`real Codex: ${scenario.title}`, async function () {
      if (!shouldRunRealCodexScenario(scenario.name)) {
        this.skip();
        return;
      }
      if (!ISSUE_443_REAL_CODEX_SESSION_ID) {
        if (scenarioWasExplicitlyRequested("issue-443-real-codex")) {
          throw new Error(
            "E2E_ISSUE_443_REAL_CODEX_SESSION_ID is required when issue-443-real-codex is explicitly requested"
          );
        }
        this.skip();
        return;
      }
      await scenario.run(ISSUE_443_REAL_CODEX_SESSION_ID);
    });
  }
});
