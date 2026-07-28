import { getCurrentWindow } from "@tauri-apps/api/window";
import React, { useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import { createLogger } from "@src/hooks/logger";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { TabWindowData } from "@src/util/ui/window/windowManager";

const log = createLogger("TabWindow");

// Lazy load the content components based on tab type
const TabContent = React.lazy(() => import("./TabWindowContent"));

interface TabWindowProps {}

const TabWindow: React.FC<TabWindowProps> = () => {
  const [searchParams] = useSearchParams();

  // Parse tab data from URL - derived state, no effect needed
  const tabData = useMemo<TabWindowData | null>(() => {
    const dataParam = searchParams.get("data");
    if (!dataParam) return null;

    try {
      const parsed = JSON.parse(decodeURIComponent(dataParam));
      return parsed;
    } catch (error) {
      log.error("[TabWindow] Failed to parse tab data:", error);
      return null;
    }
  }, [searchParams]);

  // Initialize window settings
  useEffect(() => {
    let cancelled = false;

    const initWindow = async () => {
      try {
        const appWindow = getCurrentWindow();
        if (!cancelled) {
          await appWindow.setBackgroundColor("rgba(0, 0, 0, 0)");
        }
      } catch (error) {
        if (!cancelled) {
          log.error("Failed to initialize window:", error);
        }
      }
    };

    initWindow();

    return () => {
      cancelled = true;
    };
  }, []);

  if (!tabData) {
    return (
      <div className="h-screen w-screen bg-bg-1">
        <Placeholder variant="loading" placement="detail-panel" />
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden rounded-lg bg-bg-1 shadow-lg">
      {/* Custom title bar */}
      <div
        data-tauri-drag-region
        className="flex h-10 flex-shrink-0 items-center justify-between bg-bg-2 px-4"
        style={{ cursor: "move" }}
      >
        <div className="flex items-center gap-3 pl-[78px]">
          {/* Native traffic lights via macOS decorations */}
          <span
            data-tauri-drag-region
            className="text-sm font-medium text-text-1"
          >
            {tabData.title}
          </span>
        </div>
      </div>

      {/* Tab content - Single tab only, no TabProvider needed */}
      <div className="flex-1 overflow-hidden">
        <React.Suspense
          fallback={<Placeholder variant="loading" placement="detail-panel" />}
        >
          <TabContent tabData={tabData} />
        </React.Suspense>
      </div>
    </div>
  );
};

export default TabWindow;
