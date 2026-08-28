/**
 * Orgii Editor Settings Page
 *
 * Editor appearance settings (typography, features).
 */
import React, { Suspense, lazy } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import { HugeiconsIcon, Settings01Icon } from "@src/icons";
import { FileHeader } from "@src/modules/WorkStation/shared";
import { WORK_STATION_PLACEHOLDER_PAGE_BG_CLASS } from "@src/modules/WorkStation/shared/tokens";
import { SUBPAGE_CONTENT_WRAPPER_CLASSES } from "@src/modules/shared/layouts/SubpageLayout/tokens";

const TypographySection = lazy(() =>
  import("@src/modules/MainApp/Settings/subpages/EditorAppearancePage").then(
    (mod) => ({ default: mod.TypographySection })
  )
);

const FeaturesSection = lazy(() =>
  import("@src/modules/MainApp/Settings/subpages/EditorAppearancePage").then(
    (mod) => ({ default: mod.FeaturesSection })
  )
);

const EditorSettings: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <FileHeader
        filePath={t("navigation:labels.settings")}
        headerIcon={
          <HugeiconsIcon
            icon={Settings01Icon}
            data-icon="settings"
            size={14}
            strokeWidth={1.75}
          />
        }
        useFileTypeIcon={false}
        disableNavigation
        plainTitle
        publishToHost="code"
      />
      <div className="h-full min-h-0 overflow-y-auto px-4 scrollbar-hide">
        <div className={SUBPAGE_CONTENT_WRAPPER_CLASSES}>
          <Suspense
            fallback={
              <Placeholder
                variant="loading"
                placement="detail-panel"
                fillParentHeight
                className={WORK_STATION_PLACEHOLDER_PAGE_BG_CLASS}
              />
            }
          >
            <TypographySection />
            <FeaturesSection />
          </Suspense>
        </div>
      </div>
    </div>
  );
};

export default EditorSettings;
