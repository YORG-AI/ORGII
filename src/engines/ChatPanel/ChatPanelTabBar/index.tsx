/**
 * ChatPanelTabBar
 *
 * Inline tab-pill strip rendered inside the existing ChatPanelHeader row,
 * replacing the title/drag-spacer area for the unified chat-pane tabs. Uses
 * the exact same
 * primitives as the Workstation tab bar:
 *   - TabPillSurface  (active/inactive pill surface)
 *   - TabPillCloseButton         (14px X close control)
 *   - TabLabelRowScrim           (gradient scrim behind close button)
 *   - TabBarTrailingIconButton   (+ button)
 *   - TAB_PAIR_SEPARATOR_SLOT_CLASS between pills
 *
 * Keyboard shortcuts live in useChatPanelTabShortcuts (mounted by ChatPanel
 * itself, not this strip, so they keep working while the strip is hidden):
 *   Cmd+W  — close active tab
 *   Cmd+]  — next tab    Cmd+[  — prev tab
 *   Cmd+N  — new session tab
 *   Cmd+T  — new terminal tab (via global "create-chat-tab" event)
 */
import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useAtomValue, useSetAtom } from "jotai";
import { MessageSquarePlus } from "lucide-react";
import React, { Fragment, useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { TAB_PILL_DRAG_OVERLAY_CLASS } from "@src/components/TabPill/TabPillSurface";
import { TAB_PAIR_SEPARATOR_SLOT_CLASS } from "@src/components/TabPill/config";
import { requestTeamInboxSessionHandoffAtom } from "@src/modules/MainApp/TeamInbox/store";
import {
  SESSION_TAB_DROP_TARGET_HIGHLIGHT_CLASS,
  type SessionReferenceOpen,
  type SessionTabTransfer,
  dispatchSessionTabDragCancel,
  dispatchSessionTabDragEnd,
  dispatchSessionTabDragStart,
} from "@src/shared/dnd/sessionTabDrag";
import { useSessionTabDropTarget } from "@src/shared/dnd/useSessionTabDropTarget";
import { openTeamInboxInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabOpenAtoms";
import {
  activateChatPanelTabAtom,
  canMoveChatPanelTabToWorkstation,
  chatPanelTabsAtom,
  closeAndDestroyChatPanelTabAtom,
  closeOtherChatPanelTabsAtom,
  moveChatPanelTabToWorkstationAtom,
  reorderChatPanelTabsAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { moveSessionTabAtom } from "@src/store/session/sessionTabPlacementAtom";
import { openSideChatAtom } from "@src/store/ui/sideChatAtom";

import ChatPanelTabContextMenu from "../ChatPanelTabContextMenu";
import { CHAT_PANEL_HEADER_DRAG_STYLE } from "../header";
import { TabPill } from "./TabPill";

export { useChatPanelTabShortcuts } from "../hooks/useChatPanelTabShortcuts";
export { ChatPanelPlusMenu, PlusMenuContent } from "./ChatPanelPlusMenu";
export type { ChatPanelPlusMenuProps } from "./ChatPanelPlusMenu";

// ─── Main component ────────────────────────────────────────────────────────────

export function ChatPanelTabBar(): React.ReactNode {
  const { t } = useTranslation();
  const state = useAtomValue(chatPanelTabsAtom);
  const activateTab = useSetAtom(activateChatPanelTabAtom);
  const closeTab = useSetAtom(closeAndDestroyChatPanelTabAtom);
  const closeOtherTabs = useSetAtom(closeOtherChatPanelTabsAtom);
  const reorderTabs = useSetAtom(reorderChatPanelTabsAtom);
  const moveTabToWorkstation = useSetAtom(moveChatPanelTabToWorkstationAtom);
  const moveSessionTab = useSetAtom(moveSessionTabAtom);
  const openTeamInbox = useSetAtom(openTeamInboxInChatPanelTabAtom);
  const requestSessionHandoff = useSetAtom(requestTeamInboxSessionHandoffAtom);
  const barRef = useRef<HTMLDivElement>(null);
  const pointerPositionRef = useRef<{ x: number; y: number } | null>(null);
  const pointerTrackerRef = useRef<((event: PointerEvent) => void) | null>(
    null
  );
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [contextMenuTabId, setContextMenuTabId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );
  const tabIds = state.tabs.map((tab) => tab.id);
  const draggingTab = state.tabs.find((tab) => tab.id === draggingTabId);
  const contextMenuTab = state.tabs.find((tab) => tab.id === contextMenuTabId);

  const handleSessionTabDrop = useCallback(
    (transfer: SessionTabTransfer) => moveSessionTab(transfer),
    [moveSessionTab]
  );
  const isSessionDragOver = useSessionTabDropTarget({
    target: "chat-panel",
    containerRef: barRef,
    onDrop: handleSessionTabDrop,
  });

  const removePointerTracker = useCallback(() => {
    if (!pointerTrackerRef.current) return;
    window.removeEventListener("pointermove", pointerTrackerRef.current);
    pointerTrackerRef.current = null;
  }, []);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const tabId = String(event.active.id);
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      if (tab?.type !== "session" || !tab.sessionId) return;
      setDraggingTabId(tabId);

      const activatorEvent = event.activatorEvent;
      if (
        "clientX" in activatorEvent &&
        "clientY" in activatorEvent &&
        typeof activatorEvent.clientX === "number" &&
        typeof activatorEvent.clientY === "number"
      ) {
        pointerPositionRef.current = {
          x: activatorEvent.clientX,
          y: activatorEvent.clientY,
        };
      }
      const trackPointer = (pointerEvent: PointerEvent) => {
        pointerPositionRef.current = {
          x: pointerEvent.clientX,
          y: pointerEvent.clientY,
        };
      };
      pointerTrackerRef.current = trackPointer;
      window.addEventListener("pointermove", trackPointer, { passive: true });
      dispatchSessionTabDragStart({
        source: "chat-panel",
        sourceTabId: tab.id,
        sessionId: tab.sessionId,
        title: tab.title,
      });
    },
    [state.tabs]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const tabId = String(event.active.id);
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      const pointer = pointerPositionRef.current;
      removePointerTracker();
      pointerPositionRef.current = null;
      setDraggingTabId(null);

      let movedToWorkstation = false;
      if (tab?.type === "session" && tab.sessionId && pointer) {
        movedToWorkstation = dispatchSessionTabDragEnd(
          {
            source: "chat-panel",
            sourceTabId: tab.id,
            sessionId: tab.sessionId,
            title: tab.title,
          },
          pointer.x,
          pointer.y
        );
      } else {
        dispatchSessionTabDragCancel();
      }

      if (
        !movedToWorkstation &&
        event.over &&
        event.over.id !== event.active.id
      ) {
        const startIndex = state.tabs.findIndex(
          (candidate) => candidate.id === event.active.id
        );
        const endIndex = state.tabs.findIndex(
          (candidate) => candidate.id === event.over?.id
        );
        reorderTabs({ startIndex, endIndex });
      }
    },
    [removePointerTracker, reorderTabs, state.tabs]
  );

  const handleDragCancel = useCallback(() => {
    removePointerTracker();
    pointerPositionRef.current = null;
    setDraggingTabId(null);
    dispatchSessionTabDragCancel();
  }, [removePointerTracker]);

  const handleContextMenu = useCallback(
    (event: React.MouseEvent, tabId: string) => {
      event.preventDefault();
      event.stopPropagation();
      setContextMenuTabId(tabId);
    },
    []
  );
  const handleDismissContextMenu = useCallback(
    () => setContextMenuTabId(null),
    []
  );
  const handleMoveToWorkstation = useCallback(
    (tabId: string) => {
      moveTabToWorkstation(tabId);
    },
    [moveTabToWorkstation]
  );
  const handleCreateWorkItem = useCallback(
    (reference: SessionReferenceOpen) => {
      requestSessionHandoff(reference);
      openTeamInbox(t("navigation:labels.inbox"));
    },
    [openTeamInbox, requestSessionHandoff, t]
  );
  const openSideChat = useSetAtom(openSideChatAtom);
  const handleOpenInSideChat = useCallback(
    (reference: SessionReferenceOpen) => {
      openSideChat(reference.sessionId);
    },
    [openSideChat]
  );

  // Inline strip — no outer wrapper, fills the flex row in the header
  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext
          items={tabIds}
          strategy={horizontalListSortingStrategy}
        >
          <div
            ref={barRef}
            className="relative flex min-w-0 flex-1 items-center overflow-x-auto overflow-y-hidden scrollbar-hide"
            data-session-tab-drop-target="chat-panel"
            data-tauri-drag-region
            style={CHAT_PANEL_HEADER_DRAG_STYLE}
          >
            {isSessionDragOver ? (
              <div
                className={`${SESSION_TAB_DROP_TARGET_HIGHLIGHT_CLASS} inset-0`}
                aria-hidden
              />
            ) : null}
            <span
              className={`${TAB_PAIR_SEPARATOR_SLOT_CLASS} bg-transparent`}
              aria-hidden
              data-tauri-drag-region
              style={CHAT_PANEL_HEADER_DRAG_STYLE}
            />

            {state.tabs.map((tab, i) => {
              const next = state.tabs[i + 1];
              const isActive = tab.id === state.activeTabId;
              const nextIsActive = next?.id === state.activeTabId;
              const separatorVisible = !!next && !isActive && !nextIsActive;

              return (
                <Fragment key={tab.id}>
                  <TabPill
                    tab={tab}
                    isActive={isActive}
                    onActivate={activateTab}
                    onClose={closeTab}
                    onContextMenu={handleContextMenu}
                  />
                  {next && (
                    <span
                      className={`${TAB_PAIR_SEPARATOR_SLOT_CLASS} ${
                        separatorVisible ? "bg-border-2" : "bg-transparent"
                      }`}
                      aria-hidden
                      data-tauri-drag-region
                      style={CHAT_PANEL_HEADER_DRAG_STYLE}
                    />
                  )}
                </Fragment>
              );
            })}
          </div>
        </SortableContext>
        {typeof document !== "undefined"
          ? createPortal(
              <DragOverlay dropAnimation={null}>
                {draggingTab ? (
                  <div className={TAB_PILL_DRAG_OVERLAY_CLASS}>
                    <MessageSquarePlus size={16} strokeWidth={1.75} />
                    <span className="truncate">{draggingTab.title}</span>
                  </div>
                ) : null}
              </DragOverlay>,
              document.body
            )
          : null}
      </DndContext>
      {contextMenuTabId ? (
        <ChatPanelTabContextMenu
          key={contextMenuTabId}
          tabId={contextMenuTabId}
          sessionReference={
            contextMenuTab?.type === "session" && contextMenuTab.sessionId
              ? {
                  sessionId: contextMenuTab.sessionId,
                  title: contextMenuTab.title,
                }
              : undefined
          }
          onCreateWorkItem={handleCreateWorkItem}
          onOpenInSideChat={handleOpenInSideChat}
          onMoveToWorkstation={
            canMoveChatPanelTabToWorkstation(contextMenuTab)
              ? handleMoveToWorkstation
              : undefined
          }
          onCloseTab={closeTab}
          onCloseOtherTabs={closeOtherTabs}
          onDismiss={handleDismissContextMenu}
        />
      ) : null}
    </>
  );
}
