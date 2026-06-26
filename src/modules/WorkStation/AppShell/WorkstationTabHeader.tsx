/**
 * WorkstationTabHeader
 *
 * Shared 40px global tab-header strip rendered immediately below the
 * {@link WorkstationTabBar} and spanning the full width of the My Station
 * shell. Replaces the per-tab 40px headers (file breadcrumb, URL bar,
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
 * the strip still renders so the row height is stable across tab switches
 * and so the sidebar toggle stays in a fixed position.
 */
import { useAtomValue } from "jotai";
import React, { memo } from "react";

import { activeStatusBarAppAtom } from "@src/store/ui/workStationLayout/statusBarAtoms";
import { activeWorkstationTabHeaderAtom } from "@src/store/workstation";
import { activeWorkStationTabAtom } from "@src/store/workstation/tabs";
import { isWindows } from "@src/util/platform/tauri";

import {
  NoDragRegion,
  WorkStationSidebarToggleButton,
  WorkstationHeaderSectionSeparator,
  WorkstationTabHeaderSlotsView,
} from "../shared";
import { CodeSidebarHeaderActions } from "./CodeSidebarHeaderActions";
import { SourceControlHeaderActions } from "./SourceControlHeaderActions";

const WorkstationTabHeader: React.FC = memo(() => {
  const headerSlots = useAtomValue(activeWorkstationTabHeaderAtom);
  const activeApp = useAtomValue(activeStatusBarAppAtom);
  const activeTab = useAtomValue(activeWorkStationTabAtom);
  const windowsHost = isWindows();
  const isSourceControlTab =
    activeApp === "code" && activeTab?.type === "source-control";

  return (
    <div
      className="flex h-10 shrink-0 items-center gap-2 border-b border-border-2 pl-1.5 pr-2"
      data-tauri-drag-region={windowsHost ? undefined : true}
    >
      <NoDragRegion className="flex shrink-0 items-center gap-px">
        <WorkStationSidebarToggleButton
          iconSize={14}
          disabled={headerSlots?.sidebarToggleDisabled ?? false}
        />
        <CodeSidebarHeaderActions />
        <SourceControlHeaderActions />
      </NoDragRegion>
      {!isSourceControlTab && <WorkstationHeaderSectionSeparator />}
      <WorkstationTabHeaderSlotsView slots={headerSlots} />
    </div>
  );
});

WorkstationTabHeader.displayName = "WorkstationTabHeader";

export default WorkstationTabHeader;
