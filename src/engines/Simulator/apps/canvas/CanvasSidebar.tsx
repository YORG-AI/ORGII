/**
 * CanvasSidebar — primary-sidebar content for the canvas app.
 *
 * Lists every render_inline_canvas event with its title and timestamp, and
 * carries the per-row compare toggle that drives the side-by-side diff view.
 */
import { Layout } from "lucide-react";
import React, { useCallback, useMemo } from "react";

import { Placeholder } from "@src/components/Placeholder";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { PrimarySidebarLayoutWithSections } from "@src/modules/WorkStation/shared";
import type { PrimarySidebarTab } from "@src/modules/WorkStation/shared/PrimarySidebarLayout/PrimarySidebarLayoutWithSections";

import {
  extractPayload,
  formatEventTime,
  getDefaultTitle,
} from "./canvasPayload";

// ─── sidebar item ──────────────────────────────────────────────────────────────

interface SidebarItemProps {
  event: SessionEvent;
  isSelected: boolean;
  isCompareSelected: boolean;
  onSelect: () => void;
  onCompareToggle: () => void;
  t: (key: string, fallback: string) => string;
}

const SidebarItem: React.FC<SidebarItemProps> = ({
  event,
  isSelected,
  isCompareSelected,
  onSelect,
  onCompareToggle,
  t,
}) => {
  const payload = extractPayload(event);
  const title = payload ? getDefaultTitle(payload, t) : event.functionName;
  const timestamp = formatEventTime(event);

  return (
    <div
      className={[
        "group flex w-full items-center gap-1.5 rounded px-2 py-1.5 transition-colors",
        isSelected
          ? "bg-fill-3 text-text-1"
          : "text-text-2 hover:bg-fill-2 hover:text-text-1",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-start gap-1.5 text-left"
      >
        <Layout
          size={12}
          className={[
            "mt-0.5 shrink-0",
            isSelected ? "text-primary-6" : "text-text-4",
          ].join(" ")}
        />
        <div className="min-w-0 flex-1">
          <span className="block truncate text-xs">{title}</span>
          {timestamp && (
            <span className="block text-[10px] text-text-4">{timestamp}</span>
          )}
        </div>
      </button>
      {/* Compare checkbox — visible on hover or when active */}
      <button
        type="button"
        onClick={onCompareToggle}
        title={t("canvasApp.compareToggle", "Compare")}
        className={[
          "shrink-0 rounded px-1 py-0.5 text-[10px] font-medium transition-colors",
          isCompareSelected
            ? "bg-primary-6/20 text-primary-6"
            : "text-text-4 opacity-0 hover:text-text-2 focus-visible:opacity-100 group-hover:opacity-100",
        ].join(" ")}
      >
        {t("canvasApp.compareMark", "vs")}
      </button>
    </div>
  );
};

// ─── canvas sidebar content ────────────────────────────────────────────────────

interface CanvasSidebarProps {
  appEvents: SessionEvent[];
  selectedEventId: string | null;
  compareEventIds: string[];
  onSelect: (id: string) => void;
  onCompareToggle: (id: string) => void;
  t: (key: string, fallback: string) => string;
}

const CanvasSidebar: React.FC<CanvasSidebarProps> = ({
  appEvents,
  selectedEventId,
  compareEventIds,
  onSelect,
  onCompareToggle,
  t,
}) => {
  const sidebarTab = useMemo<PrimarySidebarTab>(
    () => ({
      key: "canvas-sidebar",
      label: t("canvasApp.sidebarTitle", "Canvases"),
      sections: [
        {
          key: "canvas-list",
          title: t("canvasApp.sidebarTitle", "Canvases"),
          content: (
            <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
              {appEvents.length === 0 ? (
                <Placeholder
                  variant="empty"
                  title={t("canvasApp.noCanvases", "No canvases yet")}
                />
              ) : (
                appEvents.map((event) => (
                  <SidebarItem
                    key={event.id}
                    event={event}
                    isSelected={event.id === selectedEventId}
                    isCompareSelected={compareEventIds.includes(event.id)}
                    onSelect={() => onSelect(event.id)}
                    onCompareToggle={() => onCompareToggle(event.id)}
                    t={t}
                  />
                ))
              )}
            </div>
          ),
          defaultFlexGrow: 1,
          collapsible: true,
          resizable: false,
        },
      ],
    }),
    [appEvents, selectedEventId, compareEventIds, onSelect, onCompareToggle, t]
  );

  const handleTabChange = useCallback(() => {}, []);

  return (
    <>
      <PrimarySidebarLayoutWithSections
        tabs={[sidebarTab]}
        activeTab={sidebarTab.key}
        onTabChange={handleTabChange}
        hideTabs
      />
      {compareEventIds.length === 2 && (
        <div className="shrink-0 border-t border-border-1 px-3 py-2">
          <span className="text-[10px] text-primary-6">
            {t("canvasApp.compareHint", "2 selected — showing diff")}
          </span>
        </div>
      )}
    </>
  );
};

CanvasSidebar.displayName = "CanvasSidebar";
export default CanvasSidebar;
