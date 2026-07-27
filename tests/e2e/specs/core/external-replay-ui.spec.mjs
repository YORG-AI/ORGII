/**
 * Rendered acceptance for Issue #443 bounded external replay.
 *
 * Critical user actions live in `externalReplayUiDriver`: the spec discovers
 * sessions through production rescan/roster paths, clicks the real sidebar
 * row, and drives pagination/history with rendered controls.
 */
import { assertFixtureCodexSessionUsesBoundedReplay } from "../../support/core/externalReplayFixtureScenario.mjs";
import { assertIssue443RealCodexSessionStaysBounded } from "../../support/core/externalReplayRealSessionScenario.mjs";
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

function shouldRunScenario(name) {
  return SCENARIO_FILTER.length === 0 || SCENARIO_FILTER.includes(name);
}

function scenarioWasExplicitlyRequested(name) {
  return SCENARIO_FILTER.includes(name);
}

describe("External replay rendered UI", () => {
  before(async () => {
    // Start from the same user-visible external-session policy as the sidebar
    // acceptance suite. The actual open, pagination, scrolling, and payload
    // reads still go through rendered controls and production commands.
    await prepareSidebarDiscoveryRenderedUi(E2E_REPO_PATH);
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

  it("opens and releases the real #443 Codex session without full hydration or staircase growth", async function () {
    if (!shouldRunScenario("issue-443-real-codex")) {
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

    await assertIssue443RealCodexSessionStaysBounded(
      ISSUE_443_REAL_CODEX_SESSION_ID
    );
  });
});
