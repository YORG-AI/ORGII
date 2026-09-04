import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import Tooltip from "@src/components/Tooltip";
import { Download01Icon, HugeiconsIcon } from "@src/icons";
import {
  installAvailableAppUpdate,
  useAvailableAppUpdate,
  useIsAppUpdateInstalling,
} from "@src/scaffold/AppUpdater";

const SidebarUpdateButton: React.FC = React.memo(() => {
  const { t } = useTranslation("navigation");
  const update = useAvailableAppUpdate();
  const installing = useIsAppUpdateInstalling();

  const handleInstallUpdate = useCallback(() => {
    void installAvailableAppUpdate();
  }, []);

  if (!update?.available) return null;

  const label = t("sidebar.bottomBar.updateAvailable", {
    version: update.version,
  });

  return (
    <Tooltip
      content={<KeyboardShortcutTooltipContent label={label} />}
      position="top"
      mouseEnterDelay={200}
      framedPanel
    >
      <Button
        aria-label={label}
        variant="primary"
        appearance="solid"
        size="small"
        shape="circle"
        iconOnly
        icon={
          <HugeiconsIcon icon={Download01Icon} data-icon="download" size={14} />
        }
        loading={installing}
        onClick={handleInstallUpdate}
      />
    </Tooltip>
  );
});

SidebarUpdateButton.displayName = "SidebarUpdateButton";

export default SidebarUpdateButton;
