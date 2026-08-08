import { useAtomValue } from "jotai";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import React, { type FC, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { DropdownItem, DropdownPanel } from "@src/components/Dropdown/exports";
import {
  DROPDOWN_ITEM,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import IconButton from "@src/components/IconButton";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import type { DropdownEnginePosition } from "@src/hooks/dropdown";
import {
  SETUP_GUIDE_DEV_SCENARIO,
  setupGuideDevScenarioAtom,
} from "@src/store/ui/setupGuideDevScenarioAtom";

import {
  DEVELOPER_TEST_MODULES,
  type DeveloperTestModuleDefinition,
} from "./moduleRegistry";

export function isDeveloperTestPanelEnabled(
  environment = process.env.NODE_ENV
): boolean {
  return environment === "development";
}

const DeveloperTestModuleSection: FC<{
  module: DeveloperTestModuleDefinition;
}> = ({ module }) => {
  const { t } = useTranslation("navigation");
  const [expanded, setExpanded] = useState(module.defaultExpanded ?? false);
  const ModuleIcon = module.icon;
  const ModuleComponent = module.Component;

  return (
    <section data-testid={`developer-test-module-${module.id}`}>
      <DropdownItem
        icon={<ModuleIcon size={DROPDOWN_ITEM.iconSize} />}
        suffix={
          expanded ? (
            <ChevronDown size={DROPDOWN_ITEM.iconSize} />
          ) : (
            <ChevronRight size={DROPDOWN_ITEM.iconSize} />
          )
        }
        role="button"
        tabIndex={0}
        ariaExpanded={expanded}
        fullWidth
        dataTestId={`developer-test-module-toggle-${module.id}`}
        onClick={() => setExpanded((value) => !value)}
      >
        {t(module.titleKey)}
      </DropdownItem>
      {expanded ? <ModuleComponent /> : null}
    </section>
  );
};

interface DeveloperTestPanelProps {
  panelRef: React.RefObject<HTMLDivElement | null>;
  panelPosition: DropdownEnginePosition;
  onClose: () => void;
}

const DeveloperTestPanelContent: FC<DeveloperTestPanelProps> = ({
  panelRef,
  panelPosition,
  onClose,
}) => {
  const { t } = useTranslation("navigation");
  const setupGuideDevScenario = useAtomValue(setupGuideDevScenarioAtom);
  const simulationActive =
    setupGuideDevScenario !== SETUP_GUIDE_DEV_SCENARIO.LIVE;
  const panelTitle = t("sidebar.developerTestPanel.title");

  useEffect(() => {
    const panelElement = panelRef.current;
    if (!panelElement) return;
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      panelElement.contains(activeElement)
    ) {
      return;
    }
    panelElement.tabIndex = -1;
    panelElement.focus({ preventScroll: true });
  }, [panelRef]);

  return createPortal(
    <DropdownPanel
      ref={panelRef}
      className={`${DROPDOWN_WIDTHS.fileTreeClass} fixed flex flex-col overflow-hidden !p-0`}
      maxHeight={panelPosition.maxHeight}
      role="dialog"
      aria-label={panelTitle}
      data-testid="developer-test-panel"
      style={{
        top: panelPosition.top,
        bottom: panelPosition.bottom,
        left: panelPosition.left,
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-0 border-b border-solid border-border-2 px-3 py-2.5">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-1">
          {panelTitle}
        </span>
        {simulationActive ? (
          <span className="rounded-full bg-primary-1 px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary-6">
            DEV
          </span>
        ) : null}
        <IconButton
          aria-label={t("sidebar.guide.close")}
          size="sm"
          variant="default"
          onClick={onClose}
        >
          <X size={HEADER_ICON_SIZE.sm} />
        </IconButton>
      </div>
      <div className="min-h-0 overflow-y-auto py-1">
        {DEVELOPER_TEST_MODULES.map((module) => (
          <DeveloperTestModuleSection key={module.id} module={module} />
        ))}
      </div>
    </DropdownPanel>,
    document.body
  );
};

/**
 * Panel-only development surface. The Settings menu owns its launcher and
 * positioning so the flask no longer occupies permanent sidebar chrome.
 */
export const DeveloperTestPanel: FC<DeveloperTestPanelProps> = (props) =>
  isDeveloperTestPanelEnabled() ? (
    <DeveloperTestPanelContent {...props} />
  ) : null;

export default DeveloperTestPanel;
