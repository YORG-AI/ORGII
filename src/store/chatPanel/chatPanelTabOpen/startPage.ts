/**
 * Start-page (Launchpad) and Explore tab open atoms.
 */
import { atom } from "jotai";

import {
  type ChatPanelCreateProjectContext,
  type ChatPanelCreateTarget,
  chatPanelCreateProjectContextAtom,
  chatPanelCreateTargetAtom,
  chatPanelStartPageOpenAtom,
} from "@src/store/ui/chatPanelAtom";

import { createExploreTab, createLaunchpadTab } from "../chatPanelTabFactories";
import {
  activateChatPanelTabAtom,
  appendAndActivateChatPanelTabAtom,
} from "../chatPanelTabPresentationAtoms";
import { chatPanelTabsAtom } from "../chatPanelTabsState";

/** Add a standalone Launchpad tab and show its Work page. */
export const addChatPanelLaunchpadTabAtom = atom(
  null,
  (_get, set, title: string = "Launchpad") => {
    const tab = createLaunchpadTab({ title });
    set(appendAndActivateChatPanelTabAtom, { tab });
    return tab.id;
  }
);
addChatPanelLaunchpadTabAtom.debugLabel = "addChatPanelLaunchpadTab";

interface OpenOrFocusStartPageTabOptions {
  title?: string;
}

/**
 * Focus the singleton Launchpad start-page tab, or create it when none is
 * open. This is the one entry point new-session and
 * launchpad triggers should use so they reuse the existing tab instead of
 * stacking duplicates.
 */
export const openOrFocusChatPanelStartPageTabAtom = atom(
  null,
  (get, set, options: OpenOrFocusStartPageTabOptions = {}) => {
    const { title = "Launchpad" } = options;
    const existingTab = get(chatPanelTabsAtom).tabs.find(
      (tab) => tab.type === "start-page"
    );
    if (existingTab) {
      set(activateChatPanelTabAtom, existingTab.id);
      return existingTab.id;
    }
    return set(addChatPanelLaunchpadTabAtom, title);
  }
);
openOrFocusChatPanelStartPageTabAtom.debugLabel =
  "openOrFocusChatPanelStartPageTab";

interface OpenCreateTargetInStartPageOptions {
  target: ChatPanelCreateTarget;
  title?: string;
  createProjectContext?: ChatPanelCreateProjectContext | null;
}

/** Focus Launchpad and show a creator inside its pinned inner navigation. */
export const openCreateTargetInChatPanelStartPageAtom = atom(
  null,
  (_get, set, options: OpenCreateTargetInStartPageOptions) => {
    const tabId = set(openOrFocusChatPanelStartPageTabAtom, {
      title: options.title,
    });
    set(chatPanelCreateTargetAtom, options.target);
    set(
      chatPanelCreateProjectContextAtom,
      options.createProjectContext ?? null
    );
    set(chatPanelStartPageOpenAtom, true);
    return tabId;
  }
);
openCreateTargetInChatPanelStartPageAtom.debugLabel =
  "openCreateTargetInChatPanelStartPage";

/** Open or focus the singleton Explore tab. */
export const openExploreInChatPanelTabAtom = atom(null, (get, set) => {
  const existingTab = get(chatPanelTabsAtom).tabs.find(
    (tab) => tab.type === "explore"
  );
  if (existingTab) {
    set(activateChatPanelTabAtom, existingTab.id);
    return existingTab.id;
  }
  const tab = createExploreTab();
  set(appendAndActivateChatPanelTabAtom, { tab });
  return tab.id;
});
openExploreInChatPanelTabAtom.debugLabel = "openExploreInChatPanelTab";
