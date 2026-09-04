/**
 * CanvasTabHeader — content published into the Simulator workstation tab
 * header for the canvas app: title, streaming pulse, Canvas/Source/Compare
 * switcher, and the Design / Reload / Share controls.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { HeaderSectionSeparator } from "@src/components/HeaderSectionSeparator";
import IconButton from "@src/components/IconButton";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import TabPill from "@src/components/TabPill";
import { NoDragRegion } from "@src/components/WindowChrome";
import {
  HugeiconsIcon,
  Layout01Icon,
  PenTool01Icon,
  Refresh04Icon,
  Share02Icon,
} from "@src/icons";

import type { CanvasViewTab } from "./canvasInteractionState";

interface CanvasTabHeaderProps {
  tab: CanvasViewTab;
  onSetTab: (tab: CanvasViewTab) => void;
  title: string;
  isStreaming: boolean;
  onReload: () => void;
  showCompare: boolean;
  designAvailable: boolean;
  designEnabled: boolean;
  onToggleDesign: () => void;
  shareEnabled: boolean;
  shareHint: string;
  onShare: () => void;
}

const CanvasTabHeader: React.FC<CanvasTabHeaderProps> = ({
  tab,
  onSetTab,
  title,
  isStreaming,
  onReload,
  showCompare,
  designAvailable,
  designEnabled,
  onToggleDesign,
  shareEnabled,
  shareHint,
  onShare,
}) => {
  const { t } = useTranslation("sessions");

  const tabs: CanvasViewTab[] = showCompare
    ? ["canvas", "source", "compare"]
    : ["canvas", "source"];

  return (
    <NoDragRegion className="flex min-w-0 flex-1 items-center gap-2">
      <HugeiconsIcon
        icon={Layout01Icon}
        data-icon="panels-top-left"
        size={13}
        className="shrink-0 text-primary-6"
      />
      <span className="min-w-0 truncate text-xs font-medium text-text-2">
        {title}
      </span>
      {isStreaming && (
        <span
          aria-hidden
          className="ml-0.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary-6"
        />
      )}

      <div className="ml-auto flex items-center gap-1">
        {tab === "canvas" && (
          <ToolbarTooltip
            label={
              designAvailable
                ? t("canvasApp.designHint", "Select an element to change")
                : t("canvasApp.designUnavailable", "Design is unavailable")
            }
          >
            <Button
              htmlType="button"
              variant="tertiary"
              size="mini"
              icon={
                <HugeiconsIcon
                  icon={PenTool01Icon}
                  data-icon="pen-tool"
                  size={12}
                />
              }
              onClick={onToggleDesign}
              disabled={!designAvailable}
              aria-pressed={designEnabled}
              className={designEnabled ? "bg-primary-2! text-primary-6!" : ""}
            >
              {t("canvasApp.design", "Design")}
            </Button>
          </ToolbarTooltip>
        )}
        <TabPill
          variant="pill"
          size="mini"
          fillWidth={false}
          tabs={tabs}
          activeTab={tab}
          onChange={(key) => onSetTab(key as CanvasViewTab)}
        />
        <HeaderSectionSeparator className="mx-0.5" />
        {tab === "canvas" && !isStreaming && (
          <IconButton
            onClick={onReload}
            className="text-text-4 hover:bg-fill-3 hover:text-text-2"
            title={t("canvasCard.reload", "Reload")}
          >
            <HugeiconsIcon
              icon={Refresh04Icon}
              data-icon="refresh-cw"
              size={12}
            />
          </IconButton>
        )}
        <ToolbarTooltip label={shareHint}>
          <Button
            htmlType="button"
            variant="tertiary"
            size="mini"
            icon={
              <HugeiconsIcon icon={Share02Icon} data-icon="share-2" size={12} />
            }
            onClick={onShare}
            disabled={!shareEnabled}
          >
            {t("canvasApp.share", "Share")}
          </Button>
        </ToolbarTooltip>
      </div>
    </NoDragRegion>
  );
};

CanvasTabHeader.displayName = "CanvasTabHeader";
export default CanvasTabHeader;
