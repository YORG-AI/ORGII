import React, { useEffect } from "react";
import { useNavigate } from "react-router-dom";

import { EditorProvider } from "@src/contexts/workstation";
import { WorkStationShellFallback } from "@src/modules/WorkStation/WorkStationShellFallback";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { TabWindowData } from "@src/util/ui/window/windowManager";

const Settings = React.lazy(() => import("@/src/modules/MainApp/Settings"));
const Editor = React.lazy(() => import("@src/modules/WorkStation"));

interface TabWindowContentProps {
  tabData: TabWindowData;
}

const TabWindowContent: React.FC<TabWindowContentProps> = ({ tabData }) => {
  const navigate = useNavigate();

  // Navigate to the appropriate route based on tab data
  useEffect(() => {
    if (tabData.routePath) {
      // Extract just the path without the /codebase prefix for local routing
      const localPath = tabData.routePath.replace("/codebase", "");
      navigate(localPath || "/");
    }
  }, [tabData, navigate]);

  const { type, routePath } = tabData;
  const isEditorContent =
    routePath?.includes("/workstation") ||
    routePath?.includes("/editor") ||
    type === "main" ||
    type === "editor";

  // Render content based on tab type, wrapped with appropriate provider
  // This mirrors the provider wrapping pattern in src/page/Orgii/index.tsx
  const renderContent = () => {
    if (isEditorContent) {
      return (
        <EditorProvider>
          <Editor />
        </EditorProvider>
      );
    }

    // Routes that don't require special providers
    if (routePath) {
      if (routePath.includes("/settings")) {
        return <Settings />;
      }
    }

    // Fallback based on tab type (for types without special providers)
    switch (type) {
      case "settings":
        return <Settings />;
      default:
        return (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <h2 className="mb-2 text-xl font-bold text-text-1">
                {tabData.title}
              </h2>
              <p className="text-sm text-text-2">Tab type: {type}</p>
            </div>
          </div>
        );
    }
  };

  const fallback = isEditorContent ? (
    <WorkStationShellFallback />
  ) : (
    <Placeholder variant="loading" />
  );

  return (
    <div className="h-full w-full overflow-hidden bg-bg-1">
      <React.Suspense fallback={fallback}>{renderContent()}</React.Suspense>
    </div>
  );
};

export default TabWindowContent;
