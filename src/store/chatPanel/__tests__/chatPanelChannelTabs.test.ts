import { beforeEach, describe, expect, it } from "vitest";

import {
  createInstrumentedStore,
  resetInstrumentedStore,
} from "@src/util/core/state/instrumentedStore";

import {
  buildChannelTabKey,
  chatPanelTabsAtom,
  closeChatPanelTabAtom,
  normalizePersistedChatPanelTabsState,
  openChannelInChatPanelTabAtom,
  reconcileDiscussionChannelTabsAtom,
} from "../chatPanelTabsAtom";

function loadChannelTabAtoms() {
  return {
    buildChannelTabKey,
    chatPanelTabsAtom,
    closeChatPanelTabAtom,
    normalizePersistedChatPanelTabsState,
    openChannelInChatPanelTabAtom,
    reconcileDiscussionChannelTabsAtom,
    store: createInstrumentedStore(),
  };
}

type ChannelTabAtoms = ReturnType<typeof loadChannelTabAtoms>;

const LOCAL_CHANNEL = {
  scope: "local" as const,
  channelId: "chan-1",
  name: "code-review",
};

const CLOUD_CHANNEL = {
  scope: "cloud" as const,
  orgId: "org-1",
  channelId: "chan-1",
  name: "release-notes",
  visibility: "org" as const,
};

describe("openChannelInChatPanelTabAtom", () => {
  let atoms: ChannelTabAtoms;

  beforeEach(() => {
    // Atom values live in the store, so a fresh store (plus clean persisted
    // state) is all an empty tab strip needs -- no module-registry teardown.
    resetInstrumentedStore();
    localStorage.clear();
    atoms = loadChannelTabAtoms();
  });

  function channelTabs() {
    return atoms.store
      .get(atoms.chatPanelTabsAtom)
      .tabs.filter((tab) => tab.type === "channel");
  }

  it("opens a channel tab titled #name and activates it", () => {
    const tabId = atoms.store.set(
      atoms.openChannelInChatPanelTabAtom,
      LOCAL_CHANNEL
    );

    const tabs = channelTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      id: tabId,
      title: "code-review",
      channel: LOCAL_CHANNEL,
    });
    expect(atoms.store.get(atoms.chatPanelTabsAtom).activeTabId).toBe(tabId);
  });

  it("focuses the existing tab instead of stacking a duplicate", () => {
    const first = atoms.store.set(
      atoms.openChannelInChatPanelTabAtom,
      LOCAL_CHANNEL
    );
    atoms.store.set(atoms.openChannelInChatPanelTabAtom, LOCAL_CHANNEL);

    expect(channelTabs()).toHaveLength(1);
    expect(atoms.store.get(atoms.chatPanelTabsAtom).activeTabId).toBe(first);
  });

  it("refreshes a stale payload on re-open", () => {
    atoms.store.set(atoms.openChannelInChatPanelTabAtom, LOCAL_CHANNEL);
    atoms.store.set(atoms.openChannelInChatPanelTabAtom, {
      ...LOCAL_CHANNEL,
      name: "hotfix-branch",
    });

    const tabs = channelTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].title).toBe("hotfix-branch");
    expect(tabs[0].channel).toMatchObject({ name: "hotfix-branch" });
  });

  it("keeps local and cloud channels that share an id on separate tabs", () => {
    atoms.store.set(atoms.openChannelInChatPanelTabAtom, LOCAL_CHANNEL);
    atoms.store.set(atoms.openChannelInChatPanelTabAtom, CLOUD_CHANNEL);

    expect(channelTabs()).toHaveLength(2);
    expect(atoms.buildChannelTabKey(LOCAL_CHANNEL)).not.toBe(
      atoms.buildChannelTabKey(CLOUD_CHANNEL)
    );
  });

  it("gives two channels in the same org their own tabs", () => {
    atoms.store.set(atoms.openChannelInChatPanelTabAtom, CLOUD_CHANNEL);
    atoms.store.set(atoms.openChannelInChatPanelTabAtom, {
      ...CLOUD_CHANNEL,
      channelId: "chan-2",
      name: "hotfix-branch",
    });

    expect(channelTabs().map((tab) => tab.title)).toEqual([
      "release-notes",
      "hotfix-branch",
    ]);
  });

  it("re-opens after the tab was closed", () => {
    const first = atoms.store.set(
      atoms.openChannelInChatPanelTabAtom,
      LOCAL_CHANNEL
    );
    atoms.store.set(atoms.closeChatPanelTabAtom, first);
    expect(channelTabs()).toHaveLength(0);

    atoms.store.set(atoms.openChannelInChatPanelTabAtom, LOCAL_CHANNEL);
    expect(channelTabs()).toHaveLength(1);
  });

  it("survives persistence normalization", () => {
    const tabId = atoms.store.set(
      atoms.openChannelInChatPanelTabAtom,
      CLOUD_CHANNEL
    );
    const normalized = atoms.normalizePersistedChatPanelTabsState(
      atoms.store.get(atoms.chatPanelTabsAtom)
    );

    expect(normalized?.tabs.find((tab) => tab.id === tabId)).toMatchObject({
      type: "channel",
      channel: CLOUD_CHANNEL,
    });
  });

  it("closes inaccessible channel tabs without touching other scopes or orgs", () => {
    atoms.store.set(atoms.openChannelInChatPanelTabAtom, LOCAL_CHANNEL);
    const revokedOrg1Tab = atoms.store.set(
      atoms.openChannelInChatPanelTabAtom,
      CLOUD_CHANNEL
    );
    atoms.store.set(atoms.openChannelInChatPanelTabAtom, {
      ...CLOUD_CHANNEL,
      channelId: "chan-2",
      name: "still-visible",
    });
    atoms.store.set(atoms.openChannelInChatPanelTabAtom, {
      ...CLOUD_CHANNEL,
      orgId: "org-2",
      channelId: "chan-3",
      name: "other-org",
    });

    const closedCloudTabs = atoms.store.set(
      atoms.reconcileDiscussionChannelTabsAtom,
      {
        scope: "cloud",
        orgId: "org-1",
        channels: [
          {
            ...CLOUD_CHANNEL,
            channelId: "chan-2",
            name: "renamed-visible",
            visibility: "private",
          },
        ],
      }
    );

    expect(closedCloudTabs).toEqual([revokedOrg1Tab]);
    expect(channelTabs().map((tab) => tab.title)).toEqual([
      "code-review",
      "renamed-visible",
      "other-org",
    ]);
    expect(channelTabs()[1]?.channel).toMatchObject({
      name: "renamed-visible",
      visibility: "private",
    });

    const closedLocalTabs = atoms.store.set(
      atoms.reconcileDiscussionChannelTabsAtom,
      {
        scope: "local",
        channels: [],
      }
    );
    expect(closedLocalTabs).toHaveLength(1);
    expect(channelTabs().map((tab) => tab.title)).toEqual([
      "renamed-visible",
      "other-org",
    ]);
  });
});
