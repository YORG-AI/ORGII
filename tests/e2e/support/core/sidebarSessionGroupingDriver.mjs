import {
  clickRenderedSelector,
  waitForRenderedSelectorAbsent,
} from "./externalReplayUiDriver.mjs";
import {
  assertNoDuplicateSessionRows,
  expandSidebarSection,
  sidebarSectionSnapshot,
} from "./sidebarSessionDiscoveryDriver.mjs";

const GROUP_BY_TRIGGER = '[data-testid="sidebar-session-filter-button"]';

function cssAttributeString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export async function selectRenderedSidebarGrouping(mode) {
  const optionSelector = `[data-testid="sidebar-group-by-${mode}"]`;
  await clickRenderedSelector(GROUP_BY_TRIGGER, {
    label: "sidebar Group by trigger",
  });
  await clickRenderedSelector(optionSelector, {
    timeout: 10_000,
    label: `sidebar ${mode} grouping option`,
  });
  await waitForRenderedSelectorAbsent(optionSelector, {
    label: `sidebar ${mode} grouping option`,
  });
}

function matchingFixtureRows(snapshot, expectedIds) {
  const expected = new Set(expectedIds);
  return (snapshot?.sessionRows ?? []).filter((row) => expected.has(row.id));
}

export async function waitForIsolatedGroupedSection({
  sectionId,
  expectedIds,
  expectedCount,
  label,
}) {
  await expandSidebarSection(sectionId);
  let snapshot = null;
  await browser.waitUntil(
    async () => {
      snapshot = await sidebarSectionSnapshot(sectionId);
      return (
        snapshot?.sessionRows?.length === expectedCount &&
        matchingFixtureRows(snapshot, expectedIds).length === expectedCount
      );
    },
    {
      timeout: 90_000,
      interval: 200,
      timeoutMsg: `${label} did not render exactly ${expectedCount} expected rows`,
    }
  );
  assertNoDuplicateSessionRows(snapshot, label);
  return snapshot;
}

export async function clickGroupedLoadMoreAndWait({
  sectionId,
  expectedIds,
  previousCount,
  expectedCount,
  label,
}) {
  const section = await $(
    `[data-sidebar-section-id="${cssAttributeString(sectionId)}"]`
  );
  const pagers = await section.$$(
    '[data-testid^="sidebar-local-group-load-more-"]'
  );
  if (pagers.length !== 1) {
    throw new Error(
      `${label} expected one local grouped pager, got ${pagers.length}`
    );
  }
  await clickRenderedSelector(
    `[data-sidebar-section-id="${cssAttributeString(
      sectionId
    )}"] [data-testid^="sidebar-local-group-load-more-"]`,
    { label: `${label} grouped Load more` }
  );

  const snapshot = await waitForIsolatedGroupedSection({
    sectionId,
    expectedIds,
    expectedCount,
    label,
  });
  if (expectedCount - previousCount !== 10) {
    throw new Error(
      `${label} test contract expected a +10 page, got ${previousCount} -> ${expectedCount}`
    );
  }
  return snapshot;
}
