import {
  clickRenderedSelector,
  waitForRenderedSelectorAbsent,
} from "./externalReplayUiDriver.mjs";
import {
  expandSidebarSection,
  waitForSidebarRowPresence,
} from "./sidebarSessionDiscoveryDriver.mjs";

const GROUP_BY_TRIGGER = '[data-testid="sidebar-session-filter-button"]';
const INCLUDE_EXTERNAL_OPTION =
  '[data-testid="sidebar-include-external-toggle"]';

async function toggleIncludeExternalViaRenderedMenu() {
  await clickRenderedSelector(GROUP_BY_TRIGGER, {
    label: "sidebar Group by trigger",
  });
  await clickRenderedSelector(INCLUDE_EXTERNAL_OPTION, {
    timeout: 10_000,
    label: "Include external option",
  });
  // This toggle intentionally keeps the filter menu open so users can change
  // more than one option. Close it through the same rendered trigger before
  // continuing with sidebar assertions.
  await clickRenderedSelector(GROUP_BY_TRIGGER, {
    label: "sidebar Group by trigger after Include external toggle",
  });
  await waitForRenderedSelectorAbsent(INCLUDE_EXTERNAL_OPTION, {
    label: "Include external option",
  });
}

export async function verifyRenderedIncludeExternalControl({
  externalSessionId,
  externalSectionId,
  nativeSessionId,
  nativeSectionId,
}) {
  await expandSidebarSection(externalSectionId);
  await expandSidebarSection(nativeSectionId);
  await waitForSidebarRowPresence(
    externalSessionId,
    true,
    "external row before Include external toggle"
  );
  await waitForSidebarRowPresence(
    nativeSessionId,
    true,
    "native row before Include external toggle"
  );

  await toggleIncludeExternalViaRenderedMenu();
  await waitForSidebarRowPresence(
    externalSessionId,
    false,
    "external row after Include external off"
  );
  await waitForSidebarRowPresence(
    nativeSessionId,
    true,
    "native row after Include external off"
  );

  await toggleIncludeExternalViaRenderedMenu();
  await expandSidebarSection(externalSectionId);
  await waitForSidebarRowPresence(
    externalSessionId,
    true,
    "external row after Include external on"
  );
  await waitForSidebarRowPresence(
    nativeSessionId,
    true,
    "native row after Include external on"
  );
}
