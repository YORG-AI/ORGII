/**
 * RunningLocationPill Component
 *
 * Compact location selector pill for choosing where a session runs.
 * Dropdown order: This Mac → New Worktree → Cloud
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import RunningLocationDropdownPanel from "@src/components/RunningLocationDropdownPanel";
import SelectorPill from "@src/components/SelectorPill";
import {
  RUNNING_LOCATIONS,
  type RunningLocation,
} from "@src/config/sessionCreatorConfig";
import { useSessionId } from "@src/engines/SessionCore/hooks/session";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { runningLocationAtom } from "@src/store/session/runningLocationAtom";
import { sessionByIdAtom } from "@src/store/session/sessionAtom";
import { isCliSession } from "@src/util/session/sessionDispatch";

export interface RunningLocationPillProps {
  /** Show pill regardless of active session (for session creator) */
  forceVisible?: boolean;
  /** Called after location changes */
  onLocationChange?: (location: RunningLocation) => void;
  /** Controlled value — when provided, bypasses global atom */
  value?: RunningLocation;
  /** Dropdown placement direction */
  placement?: "top" | "bottom";
}

type LocationRow = { id: RunningLocation; disabled: boolean };

const RunningLocationPill: React.FC<RunningLocationPillProps> = memo(
  ({ forceVisible = false, onLocationChange, value, placement = "top" }) => {
    const { t } = useTranslation("sessions");
    const { sessionId } = useSessionId();

    const isControlled = value !== undefined;
    const atomLocation = useAtomValue(runningLocationAtom);
    const setAtomLocation = useSetAtom(runningLocationAtom);
    // Once a session has a `worktreePath` persisted on the row, isolation
    // is already in effect at the agent-core layer and the runner CANNOT
    // be flipped back without abandoning the worktree. Lock the pill to
    // the row's actual state so the user can't pretend to switch.
    const session = useAtomValue(sessionByIdAtom(sessionId ?? ""));
    const isLockedToWorktree = !!session?.worktreePath;
    const effectiveLocation = isLockedToWorktree
      ? "worktree"
      : isControlled
        ? value
        : atomLocation;
    const location = effectiveLocation;

    const currentOption =
      RUNNING_LOCATIONS.find((opt) => opt.id === location) ??
      RUNNING_LOCATIONS[0];
    const CurrentIcon = currentOption.icon;
    const currentLabel = t(currentOption.i18nKey);

    const locationRows = useMemo<LocationRow[]>(
      () =>
        RUNNING_LOCATIONS.map((entry) => ({
          id: entry.id,
          disabled: entry.disabled === true,
        })),
      []
    );

    const closeRef = useRef<() => void>(() => undefined);

    const handleRowSelect = useCallback(
      (row: LocationRow) => {
        if (!isControlled) {
          setAtomLocation(row.id);
        }
        onLocationChange?.(row.id);
        closeRef.current();
      },
      [isControlled, setAtomLocation, onLocationChange]
    );

    const {
      isOpen,
      isPositioned,
      toggle,
      close,
      triggerRef,
      panelRef,
      panelPosition,
      keyboard,
    } = useDropdownEngine<HTMLButtonElement, LocationRow>({
      gap: 6,
      align: "left",
      placement,
      listNavigation: {
        items: locationRows,
        onSelect: handleRowSelect,
        isItemSelectable: (row) => !row.disabled,
      },
    });
    useEffect(() => {
      closeRef.current = close;
    }, [close]);

    const handleSelect = useCallback(
      (selected: RunningLocation) => {
        if (!isControlled) {
          setAtomLocation(selected);
        }
        onLocationChange?.(selected);
        close();
      },
      [isControlled, setAtomLocation, onLocationChange, close]
    );

    const handleTriggerClick = useCallback(() => {
      if (isLockedToWorktree) return;
      toggle();
    }, [isLockedToWorktree, toggle]);

    // In the session creator, this pill selects launch-time location for both
    // CLI and Rust-native agents. In an active chat, only show it when the
    // active runner can report a real persisted worktree state.
    const isVisible =
      forceVisible ||
      isLockedToWorktree ||
      (sessionId && isCliSession(sessionId));
    if (!isVisible) return null;

    return (
      <>
        <SelectorPill
          ref={triggerRef}
          icon={
            <CurrentIcon size={14} strokeWidth={1.75} className="text-text-1" />
          }
          label={currentLabel}
          tooltip={
            isLockedToWorktree
              ? t("creator.runnerLockedToWorktree")
              : t("creator.switchRunner")
          }
          tooltipPosition="top"
          active={isOpen}
          onClick={handleTriggerClick}
          className="h-[28px] text-[13px]"
          size="sm"
        />

        {!isLockedToWorktree &&
          isOpen &&
          isPositioned &&
          createPortal(
            <RunningLocationDropdownPanel
              panelRef={panelRef}
              style={{
                position: "fixed",
                top: panelPosition.top,
                bottom: panelPosition.bottom,
                left: panelPosition.left,
              }}
              selected={location}
              getItemProps={keyboard.getItemProps}
              onSelect={handleSelect}
            />,
            document.body
          )}
      </>
    );
  }
);

RunningLocationPill.displayName = "RunningLocationPill";

export default RunningLocationPill;
