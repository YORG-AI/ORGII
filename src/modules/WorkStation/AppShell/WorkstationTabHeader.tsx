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
 * When a regular app has nothing to publish, the strip still renders so the
 * row height is stable across tab switches. The Launchpad omits the unused
 * strip entirely. A split surface can explicitly move this chrome into its
 * left column and hide the shell-wide strip.
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
  const isBrowserTab = activeApp === "browser";
  // The Browser URL toolbar owns its leading controls and divider (see
  // WebUrlBar), so it starts flush with the shell edge rather than behind a
  // redundant leading gutter.
  const joinsSidebarGroup = isSourceControlTab || isBrowserTab;
  const publishedHeaderPaddingLeftClassName = joinsSidebarGroup
    ? "pl-0"
    : "pl-2";

  if (headerSlots?.hidden) return null;

  // The Launchpad has no header controls, so it should not reserve an empty
  // 36px row below the tab bar.
  if (activeTab?.type === "start") return null;

  return (
    <div
      className={`flex h-9 shrink-0 items-center ${
        isBrowserTab ? "gap-px" : "gap-2"
      } pr-2 ${shellLeadingChromeHidden ? "pl-0" : "pl-1.5"} ${
        headerSlots?.joinWithFollowingRow ? "" : "border-b border-border-2"
      }`}
      data-tauri-drag-region={windowsHost ? undefined : true}
    >
      {!shellLeadingChromeHidden && !isBrowserTab && (
        <>
          <NoDragRegion className="flex shrink-0 items-center gap-px">
            <WorkStationSidebarToggleButton
              iconSize={14}
              disabled={headerSlots?.sidebarToggleDisabled ?? false}
            />
            <CodeSidebarHeaderActions />
            <SourceControlHeaderActions />
          </NoDragRegion>
          {!joinsSidebarGroup && <HeaderSectionSeparator />}
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
