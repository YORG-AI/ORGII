import { ArrowRightLeft, Check } from "lucide-react";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useSelectorKernel } from "@src/scaffold/GlobalSpotlight/palettes/core";
import {
  PaletteBody,
  SpotlightShell,
} from "@src/scaffold/GlobalSpotlight/shell";
import type { SpotlightItem } from "@src/scaffold/GlobalSpotlight/types";

interface SwitchWorkspaceSelectorProps {
  isOpen: boolean;
  onClose: () => void;
  onSwitch: () => void;
  onSkip: () => void;
  repoName: string;
}

const SwitchWorkspaceSelector: React.FC<SwitchWorkspaceSelectorProps> = ({
  isOpen,
  onClose,
  onSwitch,
  onSkip,
  repoName,
}) => {
  const { t } = useTranslation();

  const items = useMemo((): SpotlightItem[] => {
    return [
      {
        id: "yes",
        label: t("selectors.sessionInfo.switchYes", { name: repoName }),
        icon: ArrowRightLeft,
        type: "action" as const,
        data: { isSelector: true },
        action: () => {
          onSwitch();
          onClose();
        },
      },
      {
        id: "no",
        label: t("selectors.sessionInfo.switchNo"),
        icon: Check,
        type: "action" as const,
        data: { isSelector: true },
        action: () => {
          onSkip();
          onClose();
        },
      },
    ];
  }, [t, repoName, onSwitch, onSkip, onClose]);

  const kernel = useSelectorKernel({
    isOpen,
    onClose,
    items,
  });

  const path = useMemo(
    () => [
      {
        type: "action" as const,
        id: "switch-workspace",
        label: t("selectors.sessionInfo.switchWorkspaceLabel"),
        icon: ArrowRightLeft,
        color: "",
        data: {
          template: t("selectors.sessionInfo.switchWorkspaceTemplate"),
          requiredParams: ["answer"],
        },
      },
    ],
    [t]
  );

  return (
    <SpotlightShell isOpen={isOpen} onClose={onClose} hasActiveAction>
      <PaletteBody
        kernel={kernel}
        items={items}
        path={path}
        placeholder={t("selectors.sessionInfo.switchWorkspacePlaceholder")}
      />
    </SpotlightShell>
  );
};

export default SwitchWorkspaceSelector;
