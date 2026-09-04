/**
 * WorkstationTabHeader
 *
 * Shared 36px global tab-header strip rendered immediately below the
 * {@link WorkstationTabBar} and spanning the full width of the My Station
 * shell. Replaces the per-tab headers (file breadcrumb, URL bar,
 * commit-info bar, etc.) that each pane used to render inline above its
 * own content.
 *
 * Layout:
 *   [ sidebar toggle ] [ leading ] [ content ] [ trailing ]
 *
 * The right-side chrome is supplied by whichever app is active via
 * {@link activeWorkstationTabHeaderAtom}. Apps can declaratively publish typed
 * slots; older pane-level publishers are normalized into the content slot.
 *
 * When the active app has nothing to publish (e.g. a tab with no header),
 * the strip still renders so the row height is stable across tab switches.
 * A split surface can explicitly move this chrome into its left column and
 * hide the shell-wide strip.
 */
import { useAtomValue } from "jotai";
import React, { memo } from "react";

import { HeaderSectionSeparator } from "@src/components/HeaderSectionSeparator";
import {
  NoDragRegion,
  PublishedHeaderSlotsView,
} from "@src/components/WindowChrome";
import { activeStatusBarAppAtom } from "@src/store/ui/workStationLayout/statusBarAtoms";
import { activeWorkstationTabHeaderAtom } from "@src/store/workstation";
import { activeWorkStationTabAtom } from "@src/store/workstation/tabs";
import { isWindows } from "@src/util/platform/tauri";

import { WorkStationSidebarToggleButton } from "../shared";
import { CodeSidebarHeaderActions } from "./CodeSidebarHeaderActions";
import { SourceControlHeaderActions } from "./SourceControlHeaderActions";

const WorkstationTabHeader: React.FC = memo(() => {
  const headerSlots = useAtomValue(activeWorkstationTabHeaderAtom);
  const activeApp = useAtomValue(activeStatusBarAppAtom);
  const activeTab = useAtomValue(activeWorkStationTabAtom);
  const windowsHost = isWindows();
  const shellLeadingChromeHidden =
    headerSlots?.shellLeadingChromeHidden ?? false;
  const isSourceControlTab =
    activeApp === "code" && activeTab?.type === "source-control";
  const publishedHeaderPaddingLeftClassName = isSourceControlTab
    ? "pl-0"
    : "pl-2";

  if (headerSlots?.hidden) return null;

  // Launchpad: keep the strip for stable row height but render it empty —
  // no sidebar toggle, no search/lab actions, nothing to publish.
  if (activeTab?.type === "start") {
    return (
      <div
        className="flex h-9 shrink-0 items-center border-b border-border-2"
        data-tauri-drag-region={windowsHost ? undefined : true}
      />
    );
  }

  return (
    <div
      className={`flex h-9 shrink-0 items-center gap-2 pr-2 ${
        shellLeadingChromeHidden ? "pl-0" : "pl-1.5"
      } ${headerSlots?.joinWithFollowingRow ? "" : "border-b border-border-2"}`}
      data-tauri-drag-region={windowsHost ? undefined : true}
    >
      {!shellLeadingChromeHidden && (
        <>
          <NoDragRegion className="flex shrink-0 items-center gap-px">
            <WorkStationSidebarToggleButton
              iconSize={14}
              disabled={headerSlots?.sidebarToggleDisabled ?? false}
            />
            <CodeSidebarHeaderActions />
            <SourceControlHeaderActions />
          </NoDragRegion>
          {!isSourceControlTab && <HeaderSectionSeparator />}
        </>
      )}
      <PublishedHeaderSlotsView
        slots={headerSlots}
        paddingLeftClassName={publishedHeaderPaddingLeftClassName}
      />
    </div>
  );
});

WorkstationTabHeader.displayName = "WorkstationTabHeader";

export default WorkstationTabHeader;
