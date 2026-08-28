import { createElement, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { getToolIcon } from "@src/config/toolIcons";
import { HugeiconsIcon, ViewIcon } from "@src/icons";

import type { ReplayTab } from "../../shared";
import type { MessageViewMode } from "./types";

interface UseReplayTabsOptions {
  viewMode: MessageViewMode;
  setViewMode: (mode: MessageViewMode) => void;
}

interface UseReplayTabsReturn {
  replayTabs: ReplayTab[];
  activeTabId: string | null;
  tabKindByEventId: Map<string, string>;
  handleTabClick: (eventId: string) => void;
}

const TAB_ICON_SIZE = 14;
const CHAT_TAB_ID = "communication-chat-tab";
const TODO_TAB_ID = "communication-todo-tab";
const INTERACTION_TAB_ID = "communication-interaction-tab";
const PREVIEW_TAB_ID = "communication-preview-tab";
const TAB_ICON_CLASS = "shrink-0";

const VIEW_MODE_BY_TAB_ID: ReadonlyMap<string, MessageViewMode> = new Map([
  [CHAT_TAB_ID, "chat"],
  [TODO_TAB_ID, "todo"],
  [INTERACTION_TAB_ID, "interaction"],
  [PREVIEW_TAB_ID, "preview"],
]);

export function useReplayTabs({
  viewMode,
  setViewMode,
}: UseReplayTabsOptions): UseReplayTabsReturn {
  const { t } = useTranslation(["sessions", "common"]);

  const activeTabId = useMemo(() => {
    if (viewMode === "todo") return TODO_TAB_ID;
    if (viewMode === "interaction") return INTERACTION_TAB_ID;
    if (viewMode === "preview") return PREVIEW_TAB_ID;
    return CHAT_TAB_ID;
  }, [viewMode]);

  const replayTabs = useMemo<ReplayTab[]>(() => {
    const messagesLabel = t("simulator.replay.channelsSidebar.messages");
    const kanbanLabel = t("simulator.replay.channelsSidebar.kanban");
    const interactionLabel = t("simulator.replay.channelsSidebar.interactions");
    const previewLabel = t("common:common.preview");

    return [
      {
        eventId: CHAT_TAB_ID,
        kind: "chat",
        label: messagesLabel,
        title: messagesLabel,
        icon: getToolIcon("", {
          iconId: "messages-square",
          size: TAB_ICON_SIZE,
          className: TAB_ICON_CLASS,
        }),
      },
      {
        eventId: TODO_TAB_ID,
        kind: "todo",
        label: kanbanLabel,
        title: kanbanLabel,
        icon: getToolIcon("", {
          iconId: "list-todo",
          size: TAB_ICON_SIZE,
          className: TAB_ICON_CLASS,
        }),
      },
      {
        eventId: INTERACTION_TAB_ID,
        kind: "interaction",
        label: interactionLabel,
        title: interactionLabel,
        icon: getToolIcon("", {
          iconId: "message-circle-question-mark",
          size: TAB_ICON_SIZE,
          className: TAB_ICON_CLASS,
        }),
      },
      {
        eventId: PREVIEW_TAB_ID,
        kind: "preview",
        label: previewLabel,
        title: previewLabel,
        icon: createElement(HugeiconsIcon, {
          icon: ViewIcon,
          size: TAB_ICON_SIZE,
          className: TAB_ICON_CLASS,
        }),
      },
    ];
  }, [t]);

  const tabKindByEventId = useMemo(() => {
    const map = new Map<string, string>();
    for (const tab of replayTabs) map.set(tab.eventId, tab.kind);
    return map;
  }, [replayTabs]);

  const handleTabClick = useCallback(
    (eventId: string) => {
      const nextViewMode = VIEW_MODE_BY_TAB_ID.get(eventId);
      if (!nextViewMode) return;
      if (nextViewMode !== viewMode) {
        setViewMode(nextViewMode);
      }
    },
    [viewMode, setViewMode]
  );

  return { replayTabs, activeTabId, tabKindByEventId, handleTabClick };
}
