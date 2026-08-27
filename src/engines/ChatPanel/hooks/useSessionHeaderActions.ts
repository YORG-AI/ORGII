import { useAtom, useAtomValue, useStore } from "jotai";
import { useCallback, useRef, useState } from "react";

import {
  eventCountAtom,
  eventsAtom,
} from "@src/engines/SessionCore/core/atoms";
import { useDropdownEngine } from "@src/hooks/dropdown";
import {
  chatHistoryDisplayModeAtom,
  chatTokenUsageVisibleAtom,
  chatTurnMetadataVisibleAtom,
  chatTurnPaginationEnabledAtom,
} from "@src/store/ui/chatPanelAtom";

interface UseSessionHeaderActionsOptions {
  handleReloadSession: () => void;
}

/** Shared session-menu state used by Chat Panel and My Station. */
export function useSessionHeaderActions({
  handleReloadSession,
}: UseSessionHeaderActionsOptions) {
  const openSearchRef = useRef<(() => void) | null>(null);
  const {
    isOpen: isHeaderActionsOpen,
    isPositioned: isHeaderActionsPositioned,
    toggle: toggleHeaderActionsMenu,
    close: closeHeaderActionsMenu,
    triggerRef: headerActionsTriggerRef,
    panelRef: headerActionsDropdownRef,
    panelPosition: headerActionsPosition,
  } = useDropdownEngine<HTMLButtonElement>({
    gap: 4,
    align: "right",
    placement: "bottom",
  });

  const [paginationEnabled, setPaginationEnabled] = useAtom(
    chatTurnPaginationEnabledAtom
  );
  const [displayMode, setDisplayMode] = useAtom(chatHistoryDisplayModeAtom);
  const [tokenUsageVisible, setTokenUsageVisible] = useAtom(
    chatTokenUsageVisibleAtom
  );
  const [turnMetadataVisible, setTurnMetadataVisible] = useAtom(
    chatTurnMetadataVisibleAtom
  );
  const eventCount = useAtomValue(eventCountAtom);
  const store = useStore();
  const [copyEventJsonLabel, setCopyEventJsonLabel] = useState<
    "idle" | "copied" | "failed"
  >("idle");

  const handleRegisterSearchOpen = useCallback(
    (handler: (() => void) | null) => {
      openSearchRef.current = handler;
    },
    []
  );

  const handleOpenSearch = useCallback(() => {
    openSearchRef.current?.();
    closeHeaderActionsMenu();
  }, [closeHeaderActionsMenu]);

  const handleReloadFromMenu = useCallback(() => {
    handleReloadSession();
    closeHeaderActionsMenu();
  }, [closeHeaderActionsMenu, handleReloadSession]);

  const handlePaginationToggle = useCallback(
    (checked: boolean) => setPaginationEnabled(checked),
    [setPaginationEnabled]
  );
  const handleCompactDisplayModeToggle = useCallback(
    (checked: boolean) => setDisplayMode(checked ? "compact" : "full"),
    [setDisplayMode]
  );
  const handleTokenUsageVisibleToggle = useCallback(
    (checked: boolean) => setTokenUsageVisible(checked),
    [setTokenUsageVisible]
  );
  const handleTurnMetadataVisibleToggle = useCallback(
    (checked: boolean) => setTurnMetadataVisible(checked),
    [setTurnMetadataVisible]
  );

  const handleCopyEventJson = useCallback(() => {
    const json = JSON.stringify(store.get(eventsAtom), null, 2);
    navigator.clipboard
      .writeText(json)
      .then(() => {
        setCopyEventJsonLabel("copied");
        setTimeout(() => setCopyEventJsonLabel("idle"), 2000);
      })
      .catch(() => {
        setCopyEventJsonLabel("failed");
        setTimeout(() => setCopyEventJsonLabel("idle"), 2000);
      });
    closeHeaderActionsMenu();
  }, [closeHeaderActionsMenu, store]);

  return {
    closeHeaderActionsMenu,
    copyEventJsonLabel,
    displayMode,
    eventCount,
    handleCompactDisplayModeToggle,
    handleCopyEventJson,
    handleOpenSearch,
    handlePaginationToggle,
    handleRegisterSearchOpen,
    handleReloadFromMenu,
    handleTokenUsageVisibleToggle,
    handleTurnMetadataVisibleToggle,
    headerActionsDropdownRef,
    headerActionsPosition,
    headerActionsTriggerRef,
    isHeaderActionsOpen,
    isHeaderActionsPositioned,
    paginationEnabled,
    tokenUsageVisible,
    turnMetadataVisible,
    toggleHeaderActionsMenu,
  };
}
