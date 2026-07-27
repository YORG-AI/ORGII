/* global after, before, describe, it */
import { SidebarSessionFixtureScenario } from "../../support/core/sidebarSessionFixtureScenario.mjs";

const repoPath = process.env.E2E_REPO_PATH;
const fixtureReady = process.env.E2E_SIDEBAR_DISCOVERY_FIXTURE_READY === "1";
const explicitlySelected =
  process.env.E2E_SIDEBAR_DISCOVERY_EXPLICIT === "1" ||
  [...process.argv, process.env.WDIO_SPEC, process.env.E2E_SPEC]
    .filter(Boolean)
    .some((value) =>
      String(value).includes("sidebar-session-discovery-ui.spec.mjs")
    );
const suite = fixtureReady || explicitlySelected ? describe : describe.skip;

suite("Sidebar session discovery normal-user behavior", () => {
  const scenario = new SidebarSessionFixtureScenario(repoPath);

  before(async () => {
    if (!fixtureReady) {
      throw new Error(
        "Explicit sidebar discovery E2E requires its isolated fixture; refusing a silent skip"
      );
    }
    if (!repoPath) {
      throw new Error("E2E_REPO_PATH is required for sidebar discovery E2E");
    }
    await scenario.setup();
  });

  after(async () => {
    await scenario.cleanup();
  });

  it("keeps search text and native rows correct through both external-session controls", async () => {
    await scenario.verifySearchAndMasterPolicy();
  });

  it("pages SDE, managed CLI, Codex, and OpenCode 10 → 20 → 21 and removes exhausted pagers", async () => {
    await scenario.verifyCatalogPagination();
  });

  it("keeps By Time and By Workspace pagination scoped through rendered grouping controls", async () => {
    await scenario.verifyRenderedGroupingPagination();
  });

  it("opens every session family through its rendered sidebar row without crossing the native SDE boundary", async () => {
    await scenario.verifyRenderedSessionOpening();
  });
});
